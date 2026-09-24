// bridge-types.ts에서 직접 import한다(barrel `../contract/index.js`를 거치면
// tsup의 dts 번들러가 `contract`/`renderer` 두 entry가 같은 파일을 서로 다른
// chunk에서 참조한다고 보고 순환 chunk 경고를 낸다 — `main/create-bridge-server.ts`와
// 같은 이유).
import type { BridgeApi } from "../contract/bridge-types.js";
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

function parseHandshake(value: unknown): {
  readonly session: ProtocolEnvelope;
  readonly tree: ManifestNode;
} {
  // 버전 불일치만 별도 문구로 구분한다(Main·preload 버전이 어긋난 배포를
  // 알아보게). 문구는 계약이 아니다 — 계약은 code `INTERNAL`이다.
  let response: HandshakeResponse;
  try {
    response = parseHandshakeResponse(value);
  } catch (cause) {
    throw localError(
      "INTERNAL",
      cause instanceof BridgeProtocolError && cause.code === "VERSION_MISMATCH"
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
      addManifestPath(paths, tree, category, entry);
    }
  }

  return { session, tree };
}

interface RendererServices {
  readonly rpcClient: RpcClient;
  readonly streams: StreamMultiplexer;
}

function createProxy(
  manifestNode: ManifestNode,
  services: RendererServices,
  dispose?: () => void,
): object {
  const nested = new Map<string, unknown>();

  return new Proxy(Object.create(null) as object, {
    get: (_target, property) => {
      if (
        dispose !== undefined &&
        (property === Symbol.dispose || property === "dispose")
      ) {
        return dispose;
      }
      if (property === "then") {
        return undefined;
      }
      if (typeof property !== "string") {
        return undefined;
      }
      const child = manifestNode.children.get(property);
      if (child === undefined) {
        return undefined;
      }
      const cached = nested.get(property);
      if (cached !== undefined) {
        return cached;
      }
      const value =
        child.leaf?.category === "rpc"
          ? (input: BridgeValue = undefined, options?: CallOptions) =>
              services.rpcClient.call(child.leaf!.key, input, options)
          : child.leaf?.category === "state"
            ? createRemoteState(services.streams, child.leaf.key)
            : child.leaf?.category === "event"
              ? createRemoteEvent(services.streams, child.leaf.key)
              : child.leaf === undefined
                ? createProxy(child, services)
                : undefined;
      if (value !== undefined) {
        nested.set(property, value);
      }
      return value;
    },
    has: (_target, property) =>
      (dispose !== undefined && property === "dispose") ||
      (typeof property === "string" && manifestNode.children.has(property)),
    ownKeys: () => [...manifestNode.children.keys()],
    getOwnPropertyDescriptor: (_target, property) =>
      dispose !== undefined && property === "dispose"
        ? { configurable: true, enumerable: false }
        : typeof property === "string" && manifestNode.children.has(property)
          ? { configurable: true, enumerable: true }
          : undefined,
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
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

// `transport` 생략(또는 명시 `undefined`) 시 preload가 `exposeBridgeInMainWorld`로 채운
// `globalThis.rxBridge`를 읽는다. 없거나 transport 모양이 아니면 preload 설정 누락을
// 바로 알아차릴 수 있게 `rxBridge`·`exposeBridgeInMainWorld`를 언급하는 에러를 던진다.
function resolveGlobalTransport(): BridgeTransport {
  const candidate = (globalThis as { rxBridge?: unknown })[
    DEFAULT_BRIDGE_GLOBAL_NAME
  ];
  if (!isBridgeTransport(candidate)) {
    throw new TypeError(
      "createRendererApi requires a transport: no 'transport' argument was " +
        `given and 'globalThis.${DEFAULT_BRIDGE_GLOBAL_NAME}' is not a bridge ` +
        "transport. Call exposeBridgeInMainWorld() in your preload script " +
        `(it exposes 'window.${DEFAULT_BRIDGE_GLOBAL_NAME}'), or pass a transport ` +
        "explicitly.",
    );
  }
  return candidate;
}

export async function createRendererApi<B>(
  transport?: BridgeTransport,
): Promise<RendererApi<B>> {
  const resolvedTransport =
    transport === undefined ? resolveGlobalTransport() : transport;
  let response: unknown;
  try {
    response = await resolvedTransport.connect();
  } catch {
    throw localError("INTERNAL", "Bridge handshake failed.");
  }
  const handshake = parseHandshake(response);
  const rpcClient = new RpcClient(resolvedTransport, handshake.session);
  const streams = new StreamMultiplexer(resolvedTransport, handshake.session);
  return createProxy(handshake.tree, { rpcClient, streams }, () => {
    rpcClient.dispose();
    streams[Symbol.dispose]();
  }) as RendererApi<B>;
}
