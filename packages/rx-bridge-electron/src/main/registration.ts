import { Observable } from "rxjs";

import type { ComposedContract, DomainContract } from "../contract/index.js";
import type { BridgeValue } from "../protocol/index.js";
import type { CurrentValueSource, EventSource } from "./sources.js";
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
