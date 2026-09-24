import { Observable } from "rxjs";

import type { PublicManifest, Schema } from "../contract/index.js";
import type { BridgeValue } from "../protocol/index.js";
import type {
  BroadcastEventSource,
  CurrentValueSource,
  EventSource,
  OverflowPolicy,
  ScopedEventSource,
} from "./sources.js";
import type { RpcHandler } from "./types.js";

const reservedSegments = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "then",
]);

/**
 * value가 plain object이고 열거 가능한 data property만 갖는지 검증한다.
 * 경량 계약 impl 트리 검증(`buildRegistrationTableFromImpl`)이 "사용자가 만든
 * 중첩 객체가 안전한 plain object인가"를 판단할 때 쓴다. 원래
 * `contract/define-domain.ts`(descriptor API)에 있었으나, descriptor API 제거
 * (DELTA-09)로 이 impl 검증 경로만 남아 이곳으로 옮겼다.
 */
function assertOwnDataRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} cannot contain symbol keys.`);
    }
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (
      property === undefined ||
      !("value" in property) ||
      !property.enumerable
    ) {
      throw new TypeError(
        `${label} must contain enumerable data properties only.`,
      );
    }
  }
}

/** "domain/operation" 경로를 `/`로 나누고 예약어·빈 segment·dotted segment를 거부한다. */
function assertPathSegments(path: string, label: string): readonly string[] {
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new TypeError(`${label} cannot contain an empty segment.`);
    }
    if (segment.includes(".")) {
      throw new TypeError(`${label} cannot contain dotted segments.`);
    }
    if (reservedSegments.has(segment)) {
      throw new TypeError(`${label} contains reserved segment '${segment}'.`);
    }
  }
  return segments;
}

const categorySegments = new Set(["rpc", "state", "event"]);

/** 도메인 이름의 segment 규칙(예약어 금지)에 더해 루트 `dispose`·`rpc`/`state`/`event`를 거부한다. */
function assertDomainName(name: string): void {
  const segments = assertPathSegments(name, "Domain name");
  if (segments[0] === "dispose") {
    throw new TypeError("Domain name contains reserved segment 'dispose'.");
  }
  for (const segment of segments) {
    if (categorySegments.has(segment)) {
      throw new TypeError(
        `Domain name contains reserved segment '${segment}'.`,
      );
    }
  }
}

/** operation 이름은 단일 segment여야 한다(중첩 경로 금지). */
function assertOperationName(name: string, label: string): void {
  if (assertPathSegments(name, label).length !== 1) {
    throw new TypeError(`${label} '${name}' cannot be a nested path.`);
  }
}

/**
 * "domain/operation" 전체 경로들을 하나의 trie에 누적하며 leaf/namespace
 * 충돌과 중복 경로를 검출한다. impl 트리 순회(`walkImplNode`)가 등록 경로를
 * 쌓을 때 쓴다.
 */
interface PathNode {
  leaf: boolean;
  readonly children: Map<string, PathNode>;
}

function createPathTree(): PathNode {
  return { leaf: false, children: new Map() };
}

function addPath(root: PathNode, path: string): void {
  const segments = assertPathSegments(path, "Operation path");
  let node = root;
  for (const segment of segments) {
    if (node.leaf) {
      throw new TypeError(`Leaf/namespace collision at '${path}'.`);
    }
    let child = node.children.get(segment);
    if (child === undefined) {
      child = { leaf: false, children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
  }
  if (node.leaf || node.children.size > 0) {
    throw new TypeError(
      `Duplicate path or leaf/namespace collision at '${path}'.`,
    );
  }
  node.leaf = true;
}

/**
 * 경로("도메인/operation") → 등록 항목으로 정규화된 서버 내부 테이블.
 * dispatcher/subscriptions는 descriptor 트리 대신 이 테이블만 읽는다. 이렇게
 * 하면 이후 추가될 impl 기반 공개 API도 같은 테이블 모양을 만들어 같은
 * 코어를 쓸 수 있다(DELTA-04). `input`/`output` 스키마는 선택이며 없으면
 * 조회자가 `parseBridgeValue` 결과를 그대로 쓴다.
 */
export interface RpcRegistrationEntry {
  readonly kind: "rpc";
  readonly domainName: string;
  readonly operation: string;
  readonly path: readonly [domainName: string, operation: string];
  readonly handler: RpcHandler;
  readonly input?: Schema<BridgeValue>;
  readonly output?: Schema<BridgeValue>;
  readonly errors: readonly string[];
}

export interface StateRegistrationEntry {
  readonly kind: "state";
  readonly domainName: string;
  readonly operation: string;
  readonly path: readonly [domainName: string, operation: string];
  readonly source: CurrentValueSource<BridgeValue>;
  readonly output?: Schema<BridgeValue>;
}

export interface EventRegistrationEntry {
  readonly kind: "event";
  readonly domainName: string;
  readonly operation: string;
  readonly path: readonly [domainName: string, operation: string];
  readonly source: EventSource;
  readonly output?: Schema<BridgeValue>;
  readonly buffer: {
    readonly capacity: number;
    readonly overflow: OverflowPolicy;
  };
}

export type RegistrationEntry =
  RpcRegistrationEntry | StateRegistrationEntry | EventRegistrationEntry;

export interface RegistrationTable {
  readonly rpc: ReadonlyMap<string, RpcRegistrationEntry>;
  readonly state: ReadonlyMap<string, StateRegistrationEntry>;
  readonly event: ReadonlyMap<string, EventRegistrationEntry>;
}

/**
 * 등록 테이블 한 카테고리의 항목들을 도메인명 정렬 → 도메인 내부 operation명
 * 정렬 순서로 나열한다. 테이블은 Map이라 삽입 순서를 보존하지만 여기서는
 * 순서를 다시 정렬해 항상 같은 manifest 형식·값을 보장한다 — 테이블 생성
 * 순서(impl 트리 순회 순서)에 기대지 않는다.
 */
function manifestCategoryList(
  category: "rpc" | "state" | "event",
  entries: ReadonlyMap<
    string,
    { readonly domainName: string; readonly operation: string }
  >,
): readonly string[] {
  const byDomain = new Map<string, string[]>();
  for (const entry of entries.values()) {
    const operations = byDomain.get(entry.domainName);
    if (operations === undefined)
      byDomain.set(entry.domainName, [entry.operation]);
    else operations.push(entry.operation);
  }
  const list: string[] = [];
  for (const domainName of [...byDomain.keys()].sort())
    for (const operation of byDomain.get(domainName)!.slice().sort())
      list.push(`${category}:${domainName}/${operation}`);
  return list;
}

/** 등록 테이블로부터 공개 manifest를 만든다. */
export function manifestFromTable(table: RegistrationTable): PublicManifest {
  return Object.freeze({
    rpc: Object.freeze(manifestCategoryList("rpc", table.rpc)),
    state: Object.freeze(manifestCategoryList("state", table.state)),
    event: Object.freeze(manifestCategoryList("event", table.event)),
  });
}

// ---------------------------------------------------------------------------
// 경량 계약(impl 기반) 등록 테이블 빌더 (DELTA-04, RD-011).
//
// impl 트리(rpc/state/event 카테고리와 중첩 도메인이 섞인 순수 객체 트리)를
// 직접 순회하며 이름 규칙·형태·leaf/namespace 충돌을 한 번에 검증하고
// `RegistrationTable`을 만든다. impl 트리 자신이 유일한 진실 소스다 —
// descriptor 계약을 거치지 않는다(DELTA-09에서 descriptor API 자체를
// 제거했다). `options.schemas`/`options.errors`도 impl 트리와 같은 모양으로
// 병렬 순회한다.
// ---------------------------------------------------------------------------

const CATEGORY_KEYS = ["rpc", "state", "event"] as const;
type CategoryKey = (typeof CATEGORY_KEYS)[number];

function isCategoryKey(key: string): key is CategoryKey {
  return (CATEGORY_KEYS as readonly string[]).includes(key);
}

/** 경량 계약 event source의 기본 버퍼(확정 결정 4: capacity 100, overflow "error"). */
const DEFAULT_EVENT_BUFFER = Object.freeze({
  capacity: 100,
  overflow: "error" as const,
});

/**
 * `options.schemas`/`options.errors` 서브트리를 읽을 때 쓰는 방어적 캐스트.
 * `undefined`는 "이 경로에 옵션 없음"으로 통과시키고, 그 외 non-object는
 * 명확한 TypeError로 거부한다.
 */
function asOptionalRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** rpc `options.schemas` leaf(`{ input?, output? }`)의 방어적 형태 검사. */
function readRpcSchemaEntry(
  value: unknown,
  path: string,
): {
  readonly input?: Schema<BridgeValue>;
  readonly output?: Schema<BridgeValue>;
} {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object") {
    throw new TypeError(`Schema entry for 'rpc:${path}' must be an object.`);
  }
  return value as {
    readonly input?: Schema<BridgeValue>;
    readonly output?: Schema<BridgeValue>;
  };
}

function isScopedSource(
  source: EventSource,
): source is ScopedEventSource<BridgeValue> {
  return !(source instanceof Observable) && source.mode === "scoped";
}

function isBroadcastSource(
  source: EventSource,
): source is BroadcastEventSource<BridgeValue> {
  return !(source instanceof Observable) && source.mode === "broadcast";
}

/**
 * impl 트리 한 노드(도메인 자신 또는 중첩 네임스페이스)를 재귀 순회하며
 * rpc/state/event 카테고리는 등록하고, 그 외 키는 중첩 도메인으로 보고
 * 재귀한다. `schemasNode`/`errorsNode`는 impl과 같은 경로를 나란히 따라가는
 * `options.schemas`/`options.errors`의 해당 서브트리(없으면 `undefined`)다.
 *
 * 검증 순서: 노드 자체가 plain object인지 → 카테고리(rpc→state→event) 순서로
 * "각 operation의 이름·형태" → 나머지 키를 중첩 도메인으로 재귀. impl
 * 트리에는 별도 "선언"이 없으므로(계약이 없으므로) "선언 안 된 항목"이라는
 * 구분 자체가 없다 — "형태 오류"만 검사한다.
 */
function walkImplNode(
  node: unknown,
  domainSegments: readonly string[],
  schemasNode: unknown,
  errorsNode: unknown,
  pathTree: PathNode,
  rpcTable: Map<string, RpcRegistrationEntry>,
  stateTable: Map<string, StateRegistrationEntry>,
  eventTable: Map<string, EventRegistrationEntry>,
): void {
  const nodeLabel =
    domainSegments.length === 0
      ? "Bridge implementation"
      : `Domain '${domainSegments.join("/")}' implementation`;
  assertOwnDataRecord(node, nodeLabel);
  const record = node as Record<string, unknown>;
  const schemasRecord = asOptionalRecord(schemasNode, "Schema entry");
  const errorsRecord = asOptionalRecord(errorsNode, "Errors entry");

  for (const category of CATEGORY_KEYS) {
    if (!Object.hasOwn(record, category)) continue;
    const domainName = domainSegments.join("/");
    assertDomainName(domainName);
    const categoryLabel = `${category} implementations for '${domainName}'`;
    assertOwnDataRecord(record[category], categoryLabel);
    const categoryRecord = record[category] as Record<string, unknown>;
    const categorySchemas = asOptionalRecord(
      schemasRecord?.[category],
      `Schema entries for '${category}:${domainName}'`,
    );
    const categoryErrors = asOptionalRecord(
      errorsRecord?.[category],
      `Errors entries for '${category}:${domainName}'`,
    );

    for (const operation of Object.keys(categoryRecord)) {
      assertOperationName(operation, `${category} operation`);
      const path = `${domainName}/${operation}`;
      addPath(pathTree, path);
      const value = categoryRecord[operation];

      if (category === "rpc") {
        if (typeof value !== "function") {
          throw new TypeError(`RPC handler '${path}' must be a function.`);
        }
        const schemaEntry = readRpcSchemaEntry(
          categorySchemas?.[operation],
          path,
        );
        const declaredErrors = categoryErrors?.[operation];
        if (declaredErrors !== undefined && !Array.isArray(declaredErrors)) {
          throw new TypeError(
            `Declared errors for 'rpc:${path}' must be an array of error codes.`,
          );
        }
        rpcTable.set(path, {
          kind: "rpc",
          domainName,
          operation,
          path: [domainName, operation],
          handler: value as RpcHandler,
          ...(schemaEntry.input === undefined
            ? {}
            : { input: schemaEntry.input }),
          ...(schemaEntry.output === undefined
            ? {}
            : { output: schemaEntry.output }),
          errors: Object.freeze([
            ...(declaredErrors ?? []),
          ]) as readonly string[],
        });
      } else if (category === "state") {
        if (
          !(value instanceof Observable) ||
          typeof (value as { getValue?: unknown }).getValue !== "function"
        ) {
          throw new TypeError(
            `State source '${path}' must have a current value.`,
          );
        }
        const stateOutput = categorySchemas?.[operation] as
          Schema<BridgeValue> | undefined;
        stateTable.set(path, {
          kind: "state",
          domainName,
          operation,
          path: [domainName, operation],
          source: value as CurrentValueSource<BridgeValue>,
          ...(stateOutput === undefined ? {} : { output: stateOutput }),
        });
      } else {
        const source = value as EventSource | null | undefined;
        if (
          source === undefined ||
          source === null ||
          !(
            source instanceof Observable ||
            isBroadcastSource(source) ||
            isScopedSource(source)
          )
        ) {
          throw new TypeError(
            `Event source '${path}' must be an Observable or source adapter.`,
          );
        }
        const buffer =
          source instanceof Observable
            ? DEFAULT_EVENT_BUFFER
            : (source.buffer ?? DEFAULT_EVENT_BUFFER);
        const eventOutput = categorySchemas?.[operation] as
          Schema<BridgeValue> | undefined;
        eventTable.set(path, {
          kind: "event",
          domainName,
          operation,
          path: [domainName, operation],
          source,
          ...(eventOutput === undefined ? {} : { output: eventOutput }),
          buffer,
        });
      }
    }
  }

  for (const key of Object.keys(record)) {
    if (isCategoryKey(key)) continue;
    assertPathSegments(key, "Domain name segment");
    walkImplNode(
      record[key],
      [...domainSegments, key],
      schemasRecord?.[key],
      errorsRecord?.[key],
      pathTree,
      rpcTable,
      stateTable,
      eventTable,
    );
  }
}

/**
 * `options.schemas`/`options.errors`에 impl에 없는 경로가 있으면 생성 시
 * `TypeError`로 거부한다(계획 항목 4의 마지막 요구사항). impl 트리 순회
 * (`walkImplNode`)는 impl에 실제로 있는 경로만 옵션에서 읽으므로, 옵션 쪽에만
 * 있는 여분의 경로(오타 포함)는 이 별도 순회로만 걸러진다.
 */
function assertNoExtraOptionPaths(
  node: unknown,
  domainSegments: readonly string[],
  label: string,
  hasPath: (category: CategoryKey, path: string) => boolean,
): void {
  const record = asOptionalRecord(node, `${label} entry`);
  if (record === undefined) return;
  for (const key of Object.keys(record)) {
    if (isCategoryKey(key)) {
      const domainName = domainSegments.join("/");
      const categoryRecord = asOptionalRecord(
        record[key],
        `${label} category entries`,
      );
      if (categoryRecord === undefined) continue;
      for (const operation of Object.keys(categoryRecord)) {
        const path = `${domainName}/${operation}`;
        if (!hasPath(key, path)) {
          throw new TypeError(
            `${label} path '${key}:${path}' has no matching implementation.`,
          );
        }
      }
      continue;
    }
    assertNoExtraOptionPaths(
      record[key],
      [...domainSegments, key],
      label,
      hasPath,
    );
  }
}

/**
 * 경량 계약 impl 트리(rpc/state/event 카테고리와 중첩 도메인이 섞인 순수
 * 객체)와 선택적 `schemas`/`errors` map으로부터 `RegistrationTable`을 직접
 * 만든다. impl 트리 자신이 유일한 진실 소스다 — descriptor 계약을 거치지
 * 않는다.
 */
export function buildRegistrationTableFromImpl(
  impl: unknown,
  schemas: unknown,
  errors: unknown,
): RegistrationTable {
  const pathTree = createPathTree();
  const rpcTable = new Map<string, RpcRegistrationEntry>();
  const stateTable = new Map<string, StateRegistrationEntry>();
  const eventTable = new Map<string, EventRegistrationEntry>();
  walkImplNode(
    impl,
    [],
    schemas,
    errors,
    pathTree,
    rpcTable,
    stateTable,
    eventTable,
  );
  const hasPath = (category: CategoryKey, path: string): boolean =>
    category === "rpc"
      ? rpcTable.has(path)
      : category === "state"
        ? stateTable.has(path)
        : eventTable.has(path);
  assertNoExtraOptionPaths(schemas, [], "options.schemas", hasPath);
  assertNoExtraOptionPaths(errors, [], "options.errors", hasPath);
  return {
    rpc: rpcTable,
    state: stateTable,
    event: eventTable,
  };
}
