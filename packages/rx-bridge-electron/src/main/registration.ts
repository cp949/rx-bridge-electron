import { Observable } from "rxjs";

import type {
  ComposedContract,
  DomainContract,
  OverflowPolicy,
  PublicManifest,
  Schema,
} from "../contract/index.js";
import {
  addPath,
  assertDomainName,
  assertOperationName,
  assertOwnDataRecord,
  assertPathSegments,
  createPathTree,
  type PathNode,
} from "../contract/define-domain.js";
import type { BridgeValue } from "../protocol/index.js";
import type {
  BroadcastEventSource,
  CurrentValueSource,
  EventSource,
  ScopedEventSource,
} from "./sources.js";
import type { DomainImplementation, RpcHandler } from "./types.js";

type ImplementationCandidate = {
  readonly rpc?: unknown;
  readonly state?: unknown;
  readonly event?: unknown;
};

type Category = "rpc" | "state" | "event";

function asCategoryRecord(
  domainName: string,
  category: Category,
  value: unknown,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object")
    throw new TypeError(
      `${category} implementations for '${domainName}' must be an object.`,
    );
  return value as Record<string, unknown>;
}

/**
 * 도메인 하나의 구현 후보(candidate)를 계약(domain)과 대조 검증하고,
 * 참조를 복사한 새 DomainImplementation으로 정규화한다.
 * 검증 순서는 rpc → state → event, 각 카테고리 내부는 "선언 안 된 항목" →
 * "형태 오류" → "누락 항목" 순서를 유지한다.
 */
export function normalizeImplementation(
  domain: DomainContract,
  candidate: ImplementationCandidate,
): DomainImplementation {
  const rpcCandidate = asCategoryRecord(domain.name, "rpc", candidate.rpc);
  const declaredRpc = domain.definitions.rpc ?? {};
  const rpc: Record<string, RpcHandler> = Object.create(null);
  for (const key of Object.keys(rpcCandidate)) {
    if (!Object.hasOwn(declaredRpc, key))
      throw new TypeError(`Undeclared RPC handler '${domain.name}/${key}'.`);
    const handler = rpcCandidate[key];
    if (typeof handler !== "function")
      throw new TypeError(
        `RPC handler '${domain.name}/${key}' must be a function.`,
      );
    rpc[key] = handler as RpcHandler;
  }
  for (const key of Object.keys(declaredRpc))
    if (!Object.hasOwn(rpc, key))
      throw new TypeError(`Missing RPC handler '${domain.name}/${key}'.`);

  const stateCandidate = asCategoryRecord(
    domain.name,
    "state",
    candidate.state,
  );
  const declaredState = domain.definitions.state ?? {};
  const state: Record<string, CurrentValueSource<BridgeValue>> = Object.create(
    null,
  );
  for (const key of Object.keys(stateCandidate)) {
    if (!Object.hasOwn(declaredState, key))
      throw new TypeError(`Undeclared State source '${domain.name}/${key}'.`);
    const source = stateCandidate[key];
    if (
      !(source instanceof Observable) ||
      typeof (source as { getValue?: unknown }).getValue !== "function"
    )
      throw new TypeError(
        `State source '${domain.name}/${key}' must have a current value.`,
      );
    state[key] = source as CurrentValueSource<BridgeValue>;
  }
  for (const key of Object.keys(declaredState))
    if (!Object.hasOwn(state, key))
      throw new TypeError(`Missing State source '${domain.name}/${key}'.`);

  const eventCandidate = asCategoryRecord(
    domain.name,
    "event",
    candidate.event,
  );
  const declaredEvent = domain.definitions.event ?? {};
  const event: Record<string, EventSource> = Object.create(null);
  for (const key of Object.keys(eventCandidate)) {
    if (!Object.hasOwn(declaredEvent, key))
      throw new TypeError(`Undeclared Event source '${domain.name}/${key}'.`);
    const source = eventCandidate[key] as EventSource | null | undefined;
    if (
      source === undefined ||
      source === null ||
      !(
        source instanceof Observable ||
        (source.mode === "broadcast" && source.source instanceof Observable) ||
        (source.mode === "scoped" && typeof source.factory === "function")
      )
    )
      throw new TypeError(
        `Event source '${domain.name}/${key}' must be an Observable or source adapter.`,
      );
    event[key] = source;
  }
  for (const key of Object.keys(declaredEvent))
    if (!Object.hasOwn(event, key))
      throw new TypeError(`Missing Event source '${domain.name}/${key}'.`);

  return Object.freeze({
    domainName: domain.name,
    rpc: Object.freeze(rpc),
    state: Object.freeze(state),
    event: Object.freeze(event),
  });
}

/**
 * 합성된 계약(contract) 전체를 기준으로 구현 목록을 대조 검증한다.
 * 계약에 선언된 모든 도메인이 정확히 한 번씩, 알려진 이름으로 등록되어
 * 있어야 하며 각 도메인은 normalizeImplementation으로 재검증한다.
 * 반환된 Map만이 findRpc/StreamHub의 조회 대상이 되므로, 검증을 통과한
 * 등록만으로 manifest에 광고된 모든 operation이 구현을 갖게 된다.
 */
export function registerImplementations(
  contract: ComposedContract,
  implementations: readonly DomainImplementation[],
): ReadonlyMap<string, DomainImplementation> {
  const registered = new Map<string, DomainImplementation>();
  for (const implementation of implementations) {
    if (
      implementation === null ||
      typeof implementation !== "object" ||
      typeof (implementation as { domainName?: unknown }).domainName !==
        "string"
    )
      throw new TypeError(
        "Domain implementation must be an object with a string domainName.",
      );
    const name = (implementation as { domainName: string }).domainName;
    if (!Object.hasOwn(contract.domains, name))
      throw new TypeError(`Unknown domain implementation '${name}'.`);
    if (registered.has(name))
      throw new TypeError(`Duplicate domain implementation '${name}'.`);
    const domain = contract.domains[name] as DomainContract;
    registered.set(
      name,
      normalizeImplementation(
        domain,
        implementation as unknown as ImplementationCandidate,
      ),
    );
  }
  for (const name of Object.keys(contract.domains))
    if (!registered.has(name))
      throw new TypeError(`Missing domain implementation '${name}'.`);
  return registered;
}

/**
 * 경로("도메인/operation") → 등록 항목으로 정규화된 서버 내부 테이블.
 * dispatcher/stream-hub는 descriptor 트리 대신 이 테이블만 읽는다. 이렇게
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
  | RpcRegistrationEntry
  | StateRegistrationEntry
  | EventRegistrationEntry;

export interface RegistrationTable {
  readonly rpc: ReadonlyMap<string, RpcRegistrationEntry>;
  readonly state: ReadonlyMap<string, StateRegistrationEntry>;
  readonly event: ReadonlyMap<string, EventRegistrationEntry>;
}

/**
 * 기존 descriptor 계약(`contract`)과 검증된 구현 Map(`registerImplementations`
 * 결과)으로부터 정규화된 등록 테이블을 만드는 어댑터. 계약에 선언된
 * operation만 순회하므로, `registerImplementations`가 이미 강제한 "선언과
 * 구현이 정확히 일치" 불변식을 그대로 물려받는다 — 여기서는 존재 여부를
 * 다시 검증하지 않는다.
 */
export function buildRegistrationTableFromContract(
  contract: ComposedContract,
  implementations: ReadonlyMap<string, DomainImplementation>,
): RegistrationTable {
  const rpcTable = new Map<string, RpcRegistrationEntry>();
  const stateTable = new Map<string, StateRegistrationEntry>();
  const eventTable = new Map<string, EventRegistrationEntry>();
  for (const domain of Object.values(contract.domains) as DomainContract[]) {
    const implementation = implementations.get(domain.name);
    for (const [operation, descriptor] of Object.entries(
      domain.definitions.rpc ?? {},
    )) {
      const handler = implementation?.rpc[operation];
      if (handler === undefined) continue;
      rpcTable.set(`${domain.name}/${operation}`, {
        kind: "rpc",
        domainName: domain.name,
        operation,
        path: [domain.name, operation],
        handler,
        input: descriptor.input,
        output: descriptor.output,
        errors: descriptor.errors,
      });
    }
    for (const [operation, descriptor] of Object.entries(
      domain.definitions.state ?? {},
    )) {
      const source = implementation?.state[operation];
      if (source === undefined) continue;
      stateTable.set(`${domain.name}/${operation}`, {
        kind: "state",
        domainName: domain.name,
        operation,
        path: [domain.name, operation],
        source,
        output: descriptor.output,
      });
    }
    for (const [operation, descriptor] of Object.entries(
      domain.definitions.event ?? {},
    )) {
      const source = implementation?.event[operation];
      if (source === undefined) continue;
      eventTable.set(`${domain.name}/${operation}`, {
        kind: "event",
        domainName: domain.name,
        operation,
        path: [domain.name, operation],
        source,
        output: descriptor.output,
        buffer: descriptor.buffer,
      });
    }
  }
  return {
    rpc: rpcTable,
    state: stateTable,
    event: eventTable,
  };
}

/**
 * 등록 테이블 한 카테고리의 항목들을 `contract/manifest.ts`의
 * `publicManifest`와 동일한 순서(도메인명 정렬 → 도메인 내부 operation명
 * 정렬)로 나열한다. 테이블은 Map이라 삽입 순서를 보존하지만 여기서는
 * 순서를 다시 정렬해 `publicManifest`와 완전히 같은 결과를 보장한다 —
 * 테이블 생성 순서(계약 순회 순서)에 기대지 않는다.
 */
function manifestCategoryList(
  category: "rpc" | "state" | "event",
  entries: ReadonlyMap<string, { readonly domainName: string; readonly operation: string }>,
): readonly string[] {
  const byDomain = new Map<string, string[]>();
  for (const entry of entries.values()) {
    const operations = byDomain.get(entry.domainName);
    if (operations === undefined) byDomain.set(entry.domainName, [entry.operation]);
    else operations.push(entry.operation);
  }
  const list: string[] = [];
  for (const domainName of [...byDomain.keys()].sort())
    for (const operation of byDomain.get(domainName)!.slice().sort())
      list.push(`${category}:${domainName}/${operation}`);
  return list;
}

/**
 * 등록 테이블로부터 공개 manifest를 만든다. 기존 `publicManifest(contract)`와
 * 같은 입력(같은 계약+구현)에 대해 완전히 같은 형식·값을 내야 한다
 * (DELTA-03 완료 기준). 동등성은
 * `test/main/registration-table.test.ts`에서 검증한다.
 */
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
// 기존 경로(`buildRegistrationTableFromContract`)는 `defineDomain`/
// `composeContracts`가 이미 검증한 계약 트리와, 그 계약을 기준으로 검증된
// `DomainImplementation` Map을 입력으로 받는다. 여기서는 descriptor 자체가
// 없으므로 - impl 트리(rpc/state/event 카테고리와 중첩 도메인이 섞인 순수
// 객체 트리)를 직접 순회하며 이름 규칙·형태·leaf/namespace 충돌을 한 번에
// 검증하고 같은 모양의 `RegistrationTable`을 만든다. `options.schemas`/
// `options.errors`도 impl 트리와 같은 모양으로 병렬 순회한다.
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
): { readonly input?: Schema<BridgeValue>; readonly output?: Schema<BridgeValue> } {
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
 * "선언된 각 operation의 이름·형태" → 나머지 키를 중첩 도메인으로 재귀.
 * 이 순서는 `main/registration.ts`의 `normalizeImplementation`과 같은 정신
 * (선언 안 된 항목 → 형태 오류 → 누락 항목)을 유지하되, impl 트리에는
 * "선언 안 된 항목"이라는 개념이 없다(계약이 없으므로) — 대신 "형태 오류"만
 * 검사한다.
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
        const schemaEntry = readRpcSchemaEntry(categorySchemas?.[operation], path);
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
          ...(schemaEntry.input === undefined ? {} : { input: schemaEntry.input }),
          ...(schemaEntry.output === undefined
            ? {}
            : { output: schemaEntry.output }),
          errors: Object.freeze([...(declaredErrors ?? [])]) as readonly string[],
        });
      } else if (category === "state") {
        if (
          !(value instanceof Observable) ||
          typeof (value as { getValue?: unknown }).getValue !== "function"
        ) {
          throw new TypeError(`State source '${path}' must have a current value.`);
        }
        const stateOutput = categorySchemas?.[operation] as
          | Schema<BridgeValue>
          | undefined;
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
          | Schema<BridgeValue>
          | undefined;
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
    assertNoExtraOptionPaths(record[key], [...domainSegments, key], label, hasPath);
  }
}

/**
 * 경량 계약 impl 트리(rpc/state/event 카테고리와 중첩 도메인이 섞인 순수
 * 객체)와 선택적 `schemas`/`errors` map으로부터 `RegistrationTable`을 직접
 * 만든다. `buildRegistrationTableFromContract`와 달리 descriptor 계약을
 * 거치지 않는다 — impl 트리 자신이 유일한 진실 소스다.
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
