import type { PublicManifest } from "../contract/index.js";
// bridge-types.ts에서 직접 import한다(barrel `../contract/index.js`를 거치면
// tsup의 dts 번들러가 `contract`/`renderer` 두 entry가 같은 파일을 서로 다른
// chunk에서 참조한다고 보고 순환 chunk 경고를 낸다 — `main/create-bridge-server.ts`와
// 같은 이유).
import type { BridgeApi } from "../contract/bridge-types.js";
import type { Observable } from "rxjs";
import {
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
import { RemoteError } from "./remote-error.js";
import { RemoteEvent } from "./remote-event.js";
import { RemoteStateClient } from "./remote-state.js";
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

function internal(message: string): RemoteError {
  return new RemoteError("INTERNAL", message);
}

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
      return internal(
        `Manifest entry '${key}' cannot contain an empty segment.`,
      );
    case "dotted-segment":
      return internal(
        `Manifest entry '${key}' cannot contain dotted segments.`,
      );
    case "reserved-segment":
      return internal(
        `Manifest entry '${key}' contains reserved segment '${verdict.segment}'.`,
      );
    case "nested-operation":
      return internal(`Manifest entry '${key}' cannot be a nested path.`);
    case "unknown-category":
      return internal("Manifest entry has an unsupported category.");
  }
}

function addPath<Leaf>(
  root: PathNode<Leaf>,
  segments: readonly string[],
  leaf: Leaf,
): void {
  let node = root;
  for (const segment of segments) {
    if (node.leaf !== undefined) {
      throw internal("Manifest contains a leaf/namespace collision.");
    }
    let child = node.children.get(segment);
    if (child === undefined) {
      child = { children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
  }
  if (node.leaf !== undefined || node.children.size > 0) {
    throw internal("Manifest contains duplicate or colliding paths.");
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
    throw internal("Manifest entry has an unsupported category.");
  }
  const segments = [...verdict.domain, verdict.operation];
  const pathVerdict = paths.add(segments);
  if (!pathVerdict.ok) {
    const path = segments.join("/");
    throw pathVerdict.reason === "leaf-namespace-collision"
      ? internal(`Leaf/namespace collision at '${path}'.`)
      : internal(`Duplicate path or leaf/namespace collision at '${path}'.`);
  }
  addPath(root, [...verdict.domain, category, verdict.operation], {
    category,
    key,
  });
}

function parseHandshake(value: unknown): {
  readonly session: ProtocolEnvelope;
  readonly manifest: PublicManifest;
  readonly tree: ManifestNode;
} {
  // envelope 파싱 한도는 protocol 내부 `ENVELOPE_LIMITS`가 결정한다(DELTA-03).
  // 여기서는 더 이상 별도 한도를 넘기지 않으므로, 예전에 있던 얕은 구조 사전
  // 검사(정확히 3개 키)와 `parseHandshakeResponse`의 검사가 완전히 중복이었다
  // — 하나로 합친다. 실패 사유(malformed·unsupported version 등)는 하나의
  // 메시지로 합쳐진다: 문구는 계약이 아니다 — 계약은 code `INTERNAL`이다
  // (`rejectManifestEntry` 주석과 같은 원칙).
  let response: HandshakeResponse;
  try {
    response = parseHandshakeResponse(value);
  } catch {
    throw internal("Malformed bridge handshake.");
  }
  const session: ProtocolEnvelope = {
    protocolVersion: response.protocolVersion,
    clientId: response.clientId,
  };

  const manifest = {} as Record<OperationCategory, readonly string[]>;
  const tree: ManifestNode = { children: new Map() };
  const paths = new OperationPathTrie();

  for (const category of OPERATION_CATEGORIES) {
    const copied: string[] = [];
    for (const entry of response.manifest[category]) {
      addManifestPath(paths, tree, category, entry);
      copied.push(entry);
    }
    manifest[category] = Object.freeze(copied);
  }

  return {
    session,
    manifest: Object.freeze(manifest) as unknown as PublicManifest,
    tree,
  };
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
            ? new RemoteStateClient(services.streams, child.leaf.key)
            : child.leaf?.category === "event"
              ? new RemoteEvent(services.streams, child.leaf.key)
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
    throw internal("Bridge handshake failed.");
  }
  const handshake = parseHandshake(response);
  const rpcClient = new RpcClient(resolvedTransport, handshake.session);
  const streams = new StreamMultiplexer(resolvedTransport, handshake.session);
  return createProxy(handshake.tree, { rpcClient, streams }, () => {
    rpcClient.dispose();
    streams[Symbol.dispose]();
  }) as RendererApi<B>;
}
