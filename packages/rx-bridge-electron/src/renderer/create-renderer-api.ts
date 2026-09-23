import type { PublicManifest } from "../contract/index.js";
// bridge-types.ts에서 직접 import한다(barrel `../contract/index.js`를 거치면
// tsup의 dts 번들러가 `contract`/`renderer` 두 entry가 같은 파일을 서로 다른
// chunk에서 참조한다고 보고 순환 chunk 경고를 낸다 — `main/create-bridge-server.ts`와
// 같은 이유).
import type { BridgeApi } from "../contract/bridge-types.js";
import type { Observable } from "rxjs";
import {
  parseBridgeValue,
  parseHandshakeResponse,
  type BridgeValue,
  type PayloadLimits,
  type ProtocolEnvelope,
} from "../protocol/index.js";
import { RemoteError } from "./remote-error.js";
import { RemoteEvent } from "./remote-event.js";
import { RemoteStateClient } from "./remote-state.js";
import { RpcClient } from "./rpc-client.js";
import { StreamMultiplexer } from "./stream-multiplexer.js";
import type { BridgeTransport, CallOptions } from "./transport.js";

const handshakeLimits: PayloadLimits = {
  maxDepth: Number.MAX_SAFE_INTEGER,
  maxEntries: Number.MAX_SAFE_INTEGER,
  maxStringBytes: Number.MAX_SAFE_INTEGER,
};

const categories = ["rpc", "state", "event"] as const;
const reservedSegments = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "then",
]);

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
  readonly category: (typeof categories)[number];
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

function asRecord(value: BridgeValue): Record<string, BridgeValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw internal("Malformed bridge handshake.");
  }
  return value as Record<string, BridgeValue>;
}

function assertExactKeys(
  value: Record<string, BridgeValue>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw internal("Malformed bridge handshake.");
  }
}

function parseSegments(
  key: string,
  category: ManifestLeaf["category"],
): string[] {
  const prefix = `${category}:`;
  if (!key.startsWith(prefix)) {
    throw internal("Manifest entry has an unsupported category.");
  }
  const path = key.slice(prefix.length);
  const segments = path.split("/");
  if (
    segments.length < 2 ||
    segments[0] === "dispose" ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.includes(".") ||
        reservedSegments.has(segment),
    ) ||
    segments
      .slice(0, -1)
      .some((segment) => (categories as readonly string[]).includes(segment))
  ) {
    throw internal("Manifest entry has an invalid path.");
  }
  return segments;
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
  paths: PathNode<true>,
  root: ManifestNode,
  category: ManifestLeaf["category"],
  key: string,
): void {
  const segments = parseSegments(key, category);
  // 와이어 경로 기준 충돌 검사는 Main의 impl 트리 등록 규칙과 같다.
  addPath(paths, segments, true);
  const operation = segments[segments.length - 1]!;
  addPath(root, [...segments.slice(0, -1), category, operation], {
    category,
    key,
  });
}

function parseHandshake(value: unknown): {
  readonly session: ProtocolEnvelope;
  readonly manifest: PublicManifest;
  readonly tree: ManifestNode;
} {
  let record: Record<string, BridgeValue>;
  try {
    record = asRecord(parseBridgeValue(value, handshakeLimits));
  } catch {
    throw internal("Malformed bridge handshake.");
  }
  assertExactKeys(record, ["protocolVersion", "clientId", "manifest"]);

  let session: ProtocolEnvelope;
  try {
    const response = parseHandshakeResponse(value, handshakeLimits);
    session = {
      protocolVersion: response.protocolVersion,
      clientId: response.clientId,
    };
  } catch {
    throw internal("Unsupported bridge handshake.");
  }

  const manifestRecord = asRecord(record.manifest);
  assertExactKeys(manifestRecord, categories);
  const manifest = {} as Record<(typeof categories)[number], readonly string[]>;
  const tree: ManifestNode = { children: new Map() };
  const paths: PathNode<true> = { children: new Map() };

  for (const category of categories) {
    const entries = manifestRecord[category];
    if (!Array.isArray(entries)) {
      throw internal("Manifest categories must be arrays.");
    }
    const copied: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== "string") {
        throw internal("Manifest entries must be strings.");
      }
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

export async function createRendererApi<B>(
  transport: BridgeTransport,
): Promise<RendererApi<B>> {
  let response: unknown;
  try {
    response = await transport.connect();
  } catch {
    throw internal("Bridge handshake failed.");
  }
  const handshake = parseHandshake(response);
  const rpcClient = new RpcClient(transport, handshake.session);
  const streams = new StreamMultiplexer(transport, handshake.session);
  return createProxy(handshake.tree, { rpcClient, streams }, () => {
    rpcClient.dispose();
    streams[Symbol.dispose]();
  }) as RendererApi<B>;
}
