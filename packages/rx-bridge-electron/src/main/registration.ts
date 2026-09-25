import { Observable } from "rxjs";

import type { Schema } from "../contract/index.js";
import type { BridgeValue, HandshakeManifest } from "../protocol/index.js";
import {
  checkDomainSegments,
  checkOperationName,
  checkSegment,
  formatWireKey,
  isOperationCategory,
  OPERATION_CATEGORIES,
  OperationPathTrie,
  type OperationCategory,
  type OperationKeyReject,
} from "../protocol/operation-key.js";
import type {
  BroadcastEventSource,
  CurrentValueSource,
  EventSource,
  EventSourceBuffer,
  OverflowPolicy,
  ScopedEventSource,
} from "./sources.js";
import type { BridgeContext, BridgeOperation, RpcHandler } from "./types.js";

/**
 * value가 plain object이고 열거 가능한 data property만 갖는지 검증한다.
 * 경량 계약 impl 트리 검증(`buildRegistrationTableFromImpl`)이 "사용자가 만든
 * 중첩 객체가 안전한 plain object인가"를 판단할 때 쓴다.
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

/** 코어 verdict를 Main의 `TypeError` 메시지로 번역한다. `name`은 nested 메시지에만 쓴다. */
function throwNameError(
  label: string,
  name: string,
  verdict: OperationKeyReject,
): never {
  switch (verdict.reason) {
    case "empty-segment":
      throw new TypeError(`${label} cannot contain an empty segment.`);
    case "dotted-segment":
      throw new TypeError(`${label} cannot contain dotted segments.`);
    case "reserved-segment":
      throw new TypeError(
        `${label} contains reserved segment '${verdict.segment}'.`,
      );
    case "nested-operation":
      throw new TypeError(`${label} '${name}' cannot be a nested path.`);
    case "unknown-category":
      throw new TypeError(`${label} '${name}' has an unknown category.`);
  }
}

/**
 * impl namespace key(`"a/b"` 형태 가능)를 `/`로 나눠 조각마다 위치 무관
 * 규칙만 검사한다. root `dispose`·카테고리 이름 규칙은 도메인 전체 경로
 * 기준이라 `assertDomainName`이 따로 적용한다.
 */
function assertPathSegments(path: string, label: string): void {
  for (const segment of path.split("/")) {
    const verdict = checkSegment(segment);
    if (!verdict.ok) throwNameError(label, path, verdict);
  }
}

/** 도메인 이름의 segment 규칙(예약어 금지)에 더해 루트 `dispose`·`rpc`/`state`/`event`를 거부한다. */
function assertDomainName(name: string): void {
  const verdict = checkDomainSegments(name.split("/"));
  if (!verdict.ok) throwNameError("Domain name", name, verdict);
}

/** operation 이름은 단일 segment여야 한다(중첩 경로 금지). */
function assertOperationName(name: string, label: string): void {
  const verdict = checkOperationName(name);
  if (!verdict.ok) throwNameError(label, name, verdict);
}

/** 경로를 trie에 추가하고, 충돌 reason을 Main의 `TypeError` 메시지로 번역한다. */
function assertNoPathCollision(
  trie: OperationPathTrie,
  segments: readonly string[],
  path: string,
): void {
  const verdict = trie.add(segments);
  if (verdict.ok) return;
  if (verdict.reason === "leaf-namespace-collision") {
    throw new TypeError(`Leaf/namespace collision at '${path}'.`);
  }
  throw new TypeError(
    `Duplicate path or leaf/namespace collision at '${path}'.`,
  );
}

/**
 * 경로("도메인/operation") → 등록 항목으로 정규화된 서버 내부 테이블.
 * `RpcRequests`·`Subscriptions`는 impl 트리가 아니라 이 테이블만 읽는다.
 * `input`/`output` 스키마는 선택이며 없으면 조회자가 `parseBridgeValue`
 * 결과를 그대로 쓴다.
 */
export interface RpcRegistrationEntry {
  readonly kind: "rpc";
  readonly bridgeOperation: BridgeOperation;
  readonly handler: RpcHandler;
  readonly input?: Schema<BridgeValue>;
  readonly output?: Schema<BridgeValue>;
  readonly errors: readonly string[];
}

export interface StateRegistrationEntry {
  readonly kind: "state";
  readonly bridgeOperation: BridgeOperation;
  readonly source: CurrentValueSource<BridgeValue>;
  readonly output?: Schema<BridgeValue>;
}

/**
 * 등록 시점에 정규화한 event 전달 방식(확정 결정 4). `broadcast`는 key당
 * 공유할 `Observable` 하나를, `scoped`는 구독마다 새 upstream을 만드는
 * factory를 가진다. `Subscriptions`는 raw `EventSource`(plain `Observable` |
 * `BroadcastEventSource` | `ScopedEventSource`)를 더는 판별하지 않고 이
 * 두 갈래만 읽는다.
 */
export type EventDelivery =
  | { readonly mode: "broadcast"; readonly source: Observable<BridgeValue> }
  | {
      readonly mode: "scoped";
      readonly factory: (context: BridgeContext) => Observable<BridgeValue>;
    };

export interface EventRegistrationEntry {
  readonly kind: "event";
  readonly bridgeOperation: BridgeOperation;
  readonly delivery: EventDelivery;
  readonly output?: Schema<BridgeValue>;
  readonly buffer: {
    readonly capacity: number;
    readonly overflow: OverflowPolicy;
  };
}

export interface RegistrationTable {
  readonly rpc: ReadonlyMap<string, RpcRegistrationEntry>;
  readonly state: ReadonlyMap<string, StateRegistrationEntry>;
  readonly event: ReadonlyMap<string, EventRegistrationEntry>;
}

/**
 * 등록 테이블 한 카테고리의 항목들을 도메인명 정렬 → 도메인 내부 operation명
 * 정렬 순서로 나열한다. 테이블은 Map이라 삽입 순서를 보존하지만 여기서는
 * 순서를 다시 정렬해 항상 같은 manifest 형식·값을 보장한다 — 테이블 생성
 * 순서(impl 트리 순회 순서)에 기대지 않는다. 이 정렬은 wire key 정렬과 다르다.
 * 한 도메인 안의 key는 `<category>:<domain>/` 접두어가 같으므로 key 정렬이
 * 곧 operation명 정렬이다.
 */
function manifestCategoryList(
  entries: ReadonlyMap<string, { readonly bridgeOperation: BridgeOperation }>,
): readonly string[] {
  const byDomain = new Map<string, string[]>();
  for (const entry of entries.values()) {
    const { domain, key } = entry.bridgeOperation;
    const domainName = domain.join("/");
    const keys = byDomain.get(domainName);
    if (keys === undefined) byDomain.set(domainName, [key]);
    else keys.push(key);
  }
  const list: string[] = [];
  for (const domainName of [...byDomain.keys()].sort())
    list.push(...byDomain.get(domainName)!.sort());
  return list;
}

/** 등록 테이블로부터 공개 manifest를 만든다. */
export function manifestFromTable(table: RegistrationTable): HandshakeManifest {
  return Object.freeze({
    rpc: Object.freeze(manifestCategoryList(table.rpc)),
    state: Object.freeze(manifestCategoryList(table.state)),
    event: Object.freeze(manifestCategoryList(table.event)),
  });
}

// ---------------------------------------------------------------------------
// 경량 계약(impl 기반) 등록 테이블 빌더.
//
// impl 트리(rpc/state/event 카테고리와 중첩 도메인이 섞인 순수 객체 트리)를
// 직접 순회하며 이름 규칙·형태·leaf/namespace 충돌을 한 번에 검증하고
// `RegistrationTable`을 만든다. impl 트리 자신이 유일한 진실 소스다.
// `options.schemas`/`options.errors`도 impl 트리와 같은 모양으로 병렬
// 순회한다.
// ---------------------------------------------------------------------------

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

/** event source가 요청별 scoped factory인지 판별한다(등록 시점 정규화 전용). */
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

const VALID_OVERFLOW_POLICIES: ReadonlySet<OverflowPolicy> = new Set([
  "error",
  "drop-oldest",
  "drop-newest",
]);

/**
 * event source의 `buffer.capacity`·`buffer.overflow`를 검증하고 동결 복사본을
 * 돌려준다(확정 결정 2, 3, 10). `buffer`가 없으면 기본값을 쓴다. helper
 * (`broadcastEvent`/`scopedEvent`)는 더 이상 이 검증을 하지 않는다 — 직접
 * 작성한 source 객체 리터럴도 여기를 거쳐야 같은 보호를 받는다.
 */
function normalizeEventBuffer(
  buffer: EventSourceBuffer | undefined,
  path: string,
): { readonly capacity: number; readonly overflow: OverflowPolicy } {
  if (buffer === undefined) return DEFAULT_EVENT_BUFFER;
  // 타입을 우회한 `null`·원시값도 경로 포함 메시지로 거부하고, getter가
  // 검사와 복사 사이에 다른 값을 돌려주지 못하게 각 필드를 한 번만 읽는다.
  const { capacity, overflow } = (
    typeof buffer === "object" && buffer !== null ? buffer : {}
  ) as Partial<EventSourceBuffer>;
  if (!Number.isSafeInteger(capacity) || (capacity as number) < 1) {
    throw new TypeError(
      `Event source '${path}' buffer capacity must be a positive safe integer.`,
    );
  }
  if (!VALID_OVERFLOW_POLICIES.has(overflow as OverflowPolicy)) {
    throw new TypeError(
      `Event source '${path}' buffer overflow must be "error", "drop-oldest", or "drop-newest".`,
    );
  }
  return Object.freeze({
    capacity: capacity as number,
    overflow: overflow as OverflowPolicy,
  });
}

/**
 * impl 트리 leaf 하나와 같은 경로의 옵션 값. `schema`·`errors`는
 * `options.schemas`/`options.errors`의 해당 leaf이며 없으면 `undefined`다.
 * category별 `read*Entry`가 이것을 등록 항목으로 읽는다.
 */
interface ImplLeaf {
  readonly value: unknown;
  readonly schema: unknown;
  readonly errors: unknown;
  readonly bridgeOperation: BridgeOperation;
  readonly path: string;
}

/** rpc leaf를 읽는다. `schema`는 `{ input?, output? }`, `errors`는 에러 코드 배열이다. */
function readRpcEntry({
  value,
  schema,
  errors,
  bridgeOperation,
  path,
}: ImplLeaf): RpcRegistrationEntry {
  if (typeof value !== "function") {
    throw new TypeError(`RPC handler '${path}' must be a function.`);
  }
  if (schema !== undefined && (schema === null || typeof schema !== "object")) {
    throw new TypeError(`Schema entry for 'rpc:${path}' must be an object.`);
  }
  if (errors !== undefined && !Array.isArray(errors)) {
    throw new TypeError(
      `Declared errors for 'rpc:${path}' must be an array of error codes.`,
    );
  }
  const { input, output } = (schema ?? {}) as {
    readonly input?: Schema<BridgeValue>;
    readonly output?: Schema<BridgeValue>;
  };
  return {
    kind: "rpc",
    bridgeOperation,
    handler: value as RpcHandler,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    errors: Object.freeze([...(errors ?? [])]) as readonly string[],
  };
}

/** state leaf를 읽는다. `schema`는 출력 스키마다. */
function readStateEntry({
  value,
  schema,
  bridgeOperation,
  path,
}: ImplLeaf): StateRegistrationEntry {
  if (
    !(value instanceof Observable) ||
    typeof (value as { getValue?: unknown }).getValue !== "function"
  ) {
    throw new TypeError(`State source '${path}' must have a current value.`);
  }
  const output = schema as Schema<BridgeValue> | undefined;
  return {
    kind: "state",
    bridgeOperation,
    source: value as CurrentValueSource<BridgeValue>,
    ...(output === undefined ? {} : { output }),
  };
}

/**
 * event leaf를 읽는다. source 3형태(plain `Observable`·broadcast·scoped)를
 * `EventDelivery` 두 갈래로 정규화하고 buffer를 검증한다. `schema`는 출력 스키마다.
 */
function readEventEntry({
  value,
  schema,
  bridgeOperation,
  path,
}: ImplLeaf): EventRegistrationEntry {
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
  let delivery: EventDelivery;
  let rawBuffer: EventSourceBuffer | undefined;
  if (source instanceof Observable) {
    delivery = { mode: "broadcast", source };
  } else if (isBroadcastSource(source)) {
    if (!(source.source instanceof Observable)) {
      throw new TypeError(
        `Event source '${path}' source must be an Observable.`,
      );
    }
    delivery = { mode: "broadcast", source: source.source };
    rawBuffer = source.buffer;
  } else {
    if (typeof source.factory !== "function") {
      throw new TypeError(`Event source '${path}' factory must be a function.`);
    }
    delivery = { mode: "scoped", factory: source.factory };
    rawBuffer = source.buffer;
  }
  const buffer = normalizeEventBuffer(rawBuffer, path);
  const output = schema as Schema<BridgeValue> | undefined;
  return {
    kind: "event",
    bridgeOperation,
    delivery,
    ...(output === undefined ? {} : { output }),
    buffer,
  };
}

/** impl 트리 순회가 채워 가는 누적 상태. `table`은 완성 뒤 그대로 반환된다. */
interface ImplWalkAccumulator {
  readonly pathTrie: OperationPathTrie;
  readonly table: {
    readonly rpc: Map<string, RpcRegistrationEntry>;
    readonly state: Map<string, StateRegistrationEntry>;
    readonly event: Map<string, EventRegistrationEntry>;
  };
}

/**
 * impl 트리 한 노드(도메인 자신 또는 중첩 네임스페이스)를 재귀 순회하며
 * rpc/state/event 카테고리는 등록하고, 그 외 키는 중첩 도메인으로 보고
 * 재귀한다. `schemasNode`/`errorsNode`는 impl과 같은 경로를 나란히 따라가는
 * `options.schemas`/`options.errors`의 해당 서브트리(없으면 `undefined`)다.
 * 이 함수는 이름 규칙·경로 충돌·재귀만 맡고, leaf 하나의 형태 검사와 등록
 * 항목 구성은 category별 `read*Entry`가 맡는다.
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
  acc: ImplWalkAccumulator,
): void {
  const nodeLabel =
    domainSegments.length === 0
      ? "Bridge implementation"
      : `Domain '${domainSegments.join("/")}' implementation`;
  assertOwnDataRecord(node, nodeLabel);
  const record = node as Record<string, unknown>;
  const schemasRecord = asOptionalRecord(schemasNode, "Schema entry");
  const errorsRecord = asOptionalRecord(errorsNode, "Errors entry");

  for (const category of OPERATION_CATEGORIES) {
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
      assertNoPathCollision(acc.pathTrie, path.split("/"), path);
      const key = formatWireKey(category, domainSegments, operation);
      const bridgeOperation: BridgeOperation = Object.freeze({
        key,
        category,
        domain: Object.freeze([...domainSegments]),
        operation,
      });
      const leaf: ImplLeaf = {
        value: categoryRecord[operation],
        schema: categorySchemas?.[operation],
        errors: categoryErrors?.[operation],
        bridgeOperation,
        path,
      };
      switch (category) {
        case "rpc":
          acc.table.rpc.set(key, readRpcEntry(leaf));
          break;
        case "state":
          acc.table.state.set(key, readStateEntry(leaf));
          break;
        case "event":
          acc.table.event.set(key, readEventEntry(leaf));
          break;
      }
    }
  }

  for (const key of Object.keys(record)) {
    if (isOperationCategory(key)) continue;
    assertPathSegments(key, "Domain name segment");
    walkImplNode(
      record[key],
      [...domainSegments, key],
      schemasRecord?.[key],
      errorsRecord?.[key],
      acc,
    );
  }
}

/**
 * `options.schemas`/`options.errors`에 impl에 없는 경로가 있으면 생성 시
 * `TypeError`로 거부한다(계획 항목 4의 마지막 요구사항). impl 트리 순회
 * (`walkImplNode`)는 impl에 실제로 있는 경로만 옵션에서 읽으므로, 옵션 쪽에만
 * 있는 여분의 경로(오타 포함)는 이 별도 순회로만 걸러진다. table이 wire
 * key로 keyed되어 있으므로 `hasPath`도 wire key로 조회한다.
 */
function assertNoExtraOptionPaths(
  node: unknown,
  domainSegments: readonly string[],
  label: string,
  hasPath: (category: OperationCategory, key: string) => boolean,
): void {
  const record = asOptionalRecord(node, `${label} entry`);
  if (record === undefined) return;
  for (const key of Object.keys(record)) {
    if (isOperationCategory(key)) {
      const categoryRecord = asOptionalRecord(
        record[key],
        `${label} category entries`,
      );
      if (categoryRecord === undefined) continue;
      for (const operation of Object.keys(categoryRecord)) {
        const wireKey = formatWireKey(key, domainSegments, operation);
        if (!hasPath(key, wireKey)) {
          throw new TypeError(
            `${label} path '${wireKey}' has no matching implementation.`,
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
 * 만든다. impl 트리 자신이 유일한 진실 소스다.
 */
export function buildRegistrationTableFromImpl(
  impl: unknown,
  schemas: unknown,
  errors: unknown,
): RegistrationTable {
  const acc: ImplWalkAccumulator = {
    pathTrie: new OperationPathTrie(),
    table: { rpc: new Map(), state: new Map(), event: new Map() },
  };
  walkImplNode(impl, [], schemas, errors, acc);
  const { table } = acc;
  const hasPath = (category: OperationCategory, key: string): boolean =>
    table[category].has(key);
  assertNoExtraOptionPaths(schemas, [], "options.schemas", hasPath);
  assertNoExtraOptionPaths(errors, [], "options.errors", hasPath);
  return table;
}
