import type { BridgeApi } from "../contract/index.js";
import type { Observable } from "rxjs";
import {
  BridgeProtocolError,
  parseHandshakeResponse,
  type BridgeValue,
  type HandshakeResponse,
  type ProtocolEnvelope,
} from "../protocol/index.js";
// 비공개 모듈이라 `../protocol/index.js`가 아니라 파일 경로로 import한다.
import {
  OPERATION_CATEGORIES,
  OperationPathTrie,
  parseWireKey,
  type OperationCategory,
  type OperationKeyReject,
} from "../protocol/operation-key.js";
import { ApiLifetime } from "./api-lifetime.js";
import {
  recordRendererDiagnostic,
  type HandshakeFailureReason,
  type RendererDiagnosticsSink,
} from "./diagnostics.js";
import { createRemoteEvent, createRemoteState } from "./local-generation.js";
import { localError } from "./remote-error.js";
import type { RemoteError } from "./remote-error.js";
import { RpcClient } from "./rpc-client.js";
import { StreamMultiplexer } from "./stream-multiplexer.js";
import {
  DEFAULT_BRIDGE_GLOBAL_NAME,
  type BridgeTransport,
  type CallOptions,
} from "./transport.js";

declare global {
  interface Window {
    readonly rxBridge: BridgeTransport;
  }
}

type AddCallOptions<Value> =
  Value extends Observable<unknown>
    ? Value
    : Value extends (...arguments_: infer Arguments) => Promise<infer Result>
      ? Arguments extends []
        ? (input?: undefined, options?: CallOptions) => Promise<Result>
        : Arguments extends [infer Input]
          ? (input: Input, options?: CallOptions) => Promise<Result>
          : Value
      : Value extends object
        ? { readonly [Key in keyof Value]: AddCallOptions<Value[Key]> }
        : Value;

/**
 * Renderer가 계약 타입 `B`로부터 얻는 공개 API 타입. `BridgeApi<B>`(RPC는
 * `Promise`, State는 `RemoteState`, Event는 `Observable`)에 RPC 호출마다
 * `CallOptions`(취소·타임아웃)를 더하고, 루트에 `dispose()`를 추가한다.
 */
export type RendererApi<B> = AddCallOptions<BridgeApi<B>> &
  Disposable & { readonly dispose: () => void };

interface ManifestLeaf {
  readonly category: OperationCategory;
  readonly key: string;
}

interface PathNode<Leaf> {
  leaf?: Leaf;
  readonly children: Map<string, PathNode<Leaf>>;
}

type ManifestNode = PathNode<ManifestLeaf>;

/**
 * wire key 파싱 실패 verdict를 `RemoteError("INTERNAL")`로 번역한다. 문구는
 * Main `TypeError`와 같은 표현이고 대상은 manifest entry 전체다. 문구는
 * 계약이 아니다 — 계약은 code `INTERNAL`이다.
 */
function rejectManifestEntry(
  key: string,
  verdict: OperationKeyReject,
): RemoteError {
  switch (verdict.reason) {
    case "empty-segment":
      return localError(
        "INTERNAL",
        `Manifest entry '${key}' cannot contain an empty segment.`,
      );
    case "dotted-segment":
      return localError(
        "INTERNAL",
        `Manifest entry '${key}' cannot contain dotted segments.`,
      );
    case "reserved-segment":
      return localError(
        "INTERNAL",
        `Manifest entry '${key}' contains reserved segment '${verdict.segment}'.`,
      );
    case "nested-operation":
      return localError(
        "INTERNAL",
        `Manifest entry '${key}' cannot be a nested path.`,
      );
    case "unknown-category":
      return localError(
        "INTERNAL",
        "Manifest entry has an unsupported category.",
      );
  }
}

// 삽입만 한다. `addManifestPath`가 먼저 `OperationPathTrie`로 카테고리 제외
// 경로의 leaf/namespace 충돌과 중복을 거부했다. 여기서 끼우는 카테고리
// segment는 도메인에 올 수 없는 예약어라 새 충돌을 만들지 않는다.
function addPath<Leaf>(
  root: PathNode<Leaf>,
  segments: readonly string[],
  leaf: Leaf,
): void {
  let node = root;
  for (const segment of segments) {
    let child = node.children.get(segment);
    if (child === undefined) {
      child = { children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
  }
  node.leaf = leaf;
}

function addManifestPath(
  paths: OperationPathTrie,
  root: ManifestNode,
  category: OperationCategory,
  key: string,
): void {
  const verdict = parseWireKey(key);
  if (!verdict.ok) {
    throw rejectManifestEntry(key, verdict);
  }
  if (verdict.category !== category) {
    throw localError("INTERNAL", "Manifest entry has an unsupported category.");
  }
  const segments = [...verdict.domain, verdict.operation];
  const pathVerdict = paths.add(segments);
  if (!pathVerdict.ok) {
    const path = segments.join("/");
    throw pathVerdict.reason === "leaf-namespace-collision"
      ? localError("INTERNAL", `Leaf/namespace collision at '${path}'.`)
      : localError(
          "INTERNAL",
          `Duplicate path or leaf/namespace collision at '${path}'.`,
        );
  }
  addPath(root, [...verdict.domain, category, verdict.operation], {
    category,
    key,
  });
}

// `onFailure`는 reject 직전(throw 지점)에 정확히 1회 호출된다(ADR 0022
// 결정 9). reject 값 자체는 바꾸지 않는다 — 분류만 곁가지로 보고한다.
function parseHandshake(
  value: unknown,
  onFailure: (reason: HandshakeFailureReason) => void,
): {
  readonly session: ProtocolEnvelope;
  readonly tree: ManifestNode;
} {
  // 버전 불일치만 별도 문구로 구분한다(Main·preload 버전이 어긋난 배포를
  // 알아보게). 문구는 계약이 아니다 — 계약은 code `INTERNAL`이다.
  let response: HandshakeResponse;
  try {
    response = parseHandshakeResponse(value);
  } catch (cause) {
    const versionMismatch =
      cause instanceof BridgeProtocolError && cause.code === "VERSION_MISMATCH";
    onFailure(versionMismatch ? "version-mismatch" : "malformed");
    throw localError(
      "INTERNAL",
      versionMismatch
        ? "Unsupported bridge handshake."
        : "Malformed bridge handshake.",
    );
  }
  const session: ProtocolEnvelope = {
    protocolVersion: response.protocolVersion,
    clientId: response.clientId,
  };

  const tree: ManifestNode = { children: new Map() };
  const paths = new OperationPathTrie();

  for (const category of OPERATION_CATEGORIES) {
    for (const entry of response.manifest[category]) {
      try {
        addManifestPath(paths, tree, category, entry);
      } catch (error) {
        onFailure("invalid-manifest");
        throw error;
      }
    }
  }

  return { session, tree };
}

interface RendererServices {
  readonly rpcClient: RpcClient;
  readonly streams: StreamMultiplexer;
  readonly lifetime: ApiLifetime;
}

/**
 * manifest 노드를 null-prototype 객체로 만든다. 하위 노드는 동결하고, 루트는
 * 호출자가 `dispose`를 붙인 뒤 동결한다. leaf(RPC 함수·
 * `RemoteState`·Event `Observable`)는 생성 부작용이 없어 즉시 만들고, 구독은
 * 사용자가 `subscribe`할 때 시작된다. manifest에 없는 경로는 속성이 없어
 * `undefined`다. `then`은 예약어라 manifest에 올 수 없다 — `await api`가 안전하다.
 */
function buildApiNode(
  manifestNode: ManifestNode,
  services: RendererServices,
): Record<string, unknown> {
  const node = Object.create(null) as Record<string, unknown>;
  for (const [segment, child] of manifestNode.children) {
    const leaf = child.leaf;
    const value =
      leaf === undefined
        ? Object.freeze(buildApiNode(child, services))
        : leaf.category === "rpc"
          ? (input: BridgeValue = undefined, options?: CallOptions) =>
              services.rpcClient.call(leaf.key, input, options)
          : leaf.category === "state"
            ? createRemoteState(services.streams, services.lifetime, leaf.key)
            : createRemoteEvent(services.streams, services.lifetime, leaf.key);
    Object.defineProperty(node, segment, { value, enumerable: true });
  }
  return node;
}

function isBridgeTransport(value: unknown): value is BridgeTransport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<BridgeTransport>;
  return (
    typeof candidate.connect === "function" &&
    typeof candidate.invoke === "function" &&
    typeof candidate.cancel === "function" &&
    typeof candidate.control === "function" &&
    typeof candidate.onStreamMessage === "function"
  );
}

// `options.transport` 생략 시 preload가 `exposeBridgeInMainWorld`로 채운
// `globalThis.rxBridge`를 읽는다. 없거나 transport 모양이 아니면 preload 설정 누락을
// 바로 알아차릴 수 있게 `rxBridge`·`exposeBridgeInMainWorld`를 언급하는 에러를 던진다.
function resolveGlobalTransport(): BridgeTransport {
  const candidate = (globalThis as { rxBridge?: unknown })[
    DEFAULT_BRIDGE_GLOBAL_NAME
  ];
  if (!isBridgeTransport(candidate)) {
    throw new TypeError(
      "createRendererApi requires a transport: no 'transport' option was " +
        `given and 'globalThis.${DEFAULT_BRIDGE_GLOBAL_NAME}' is not a bridge ` +
        "transport. Call exposeBridgeInMainWorld() in your preload script " +
        `(it exposes 'window.${DEFAULT_BRIDGE_GLOBAL_NAME}'), or pass ` +
        "{ transport } explicitly.",
    );
  }
  return candidate;
}

/**
 * {@link createRendererApi} 옵션. `transport`를 생략하면 preload가 채운
 * `globalThis.rxBridge`를 사용한다. `diagnostics`는 반환하는 API 인스턴스
 * 하나에 묶인다(ADR 0022 결정 1).
 */
export interface CreateRendererApiOptions {
  readonly transport?: BridgeTransport;
  readonly diagnostics?: RendererDiagnosticsSink;
}

export async function createRendererApi<B>(
  options?: CreateRendererApiOptions,
): Promise<RendererApi<B>> {
  // `transport` 생략 시 전역 transport가 없어 던지는 `TypeError`는 배선
  // 오류라 기록하지 않는다(ADR 0022 결정 9) — sink 조회보다 먼저 던진다.
  const resolvedTransport = options?.transport ?? resolveGlobalTransport();
  const diagnosticsSink = options?.diagnostics;
  let response: unknown;
  try {
    response = await resolvedTransport.connect();
  } catch {
    recordRendererDiagnostic(diagnosticsSink, {
      type: "handshake-failed",
      reason: "transport",
    });
    throw localError("INTERNAL", "Bridge handshake failed.");
  }
  const handshake = parseHandshake(response, (reason) => {
    recordRendererDiagnostic(diagnosticsSink, {
      type: "handshake-failed",
      reason,
    });
  });
  // 슬롯 closure는 `lifetime.dispose()` 시점에만 실행되므로, 아래에서 선언되는
  // `rpcClient`·`streams`를 앞서 참조해도 TDZ 문제가 없다.
  const lifetime = new ApiLifetime({
    settleRpcs: () => rpcClient.settleAllAsDisposed(),
    closeStreams: () => streams.closeAll(),
  });
  const rpcClient = new RpcClient(
    resolvedTransport,
    handshake.session,
    lifetime,
    diagnosticsSink,
  );
  const streams = new StreamMultiplexer(
    resolvedTransport,
    handshake.session,
    lifetime,
    diagnosticsSink,
  );
  const api = buildApiNode(handshake.tree, { rpcClient, streams, lifetime });
  const dispose = (): void => {
    lifetime.dispose();
  };
  // 루트 `dispose`는 도메인 이름으로 예약돼 manifest 경로와 겹치지 않는다.
  Object.defineProperty(api, "dispose", { value: dispose });
  Object.defineProperty(api, Symbol.dispose, { value: dispose });
  return Object.freeze(api) as unknown as RendererApi<B>;
}
