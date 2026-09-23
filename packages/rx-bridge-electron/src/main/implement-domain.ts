import type {
  DomainContract,
  DomainDefinitions,
  EventDescriptor,
  RpcDescriptor,
  StateDescriptor,
} from "../contract/index.js";
import { normalizeImplementation } from "./registration.js";
import type { CurrentValueSource, EventSource } from "./sources.js";
import type { BridgeContext, DomainImplementation } from "./types.js";

/** rpc 정의 map을 descriptor의 I/O로부터 추론한 handler 함수 map으로 매핑한다. */
type RpcHandlers<Rpc> = {
  readonly [Key in keyof Rpc]: Rpc[Key] extends RpcDescriptor<
    infer I,
    infer O,
    string
  >
    ? (input: I, context: BridgeContext) => O | Promise<O>
    : never;
};

/** state 정의 map을 descriptor의 값 타입으로부터 추론한 CurrentValueSource map으로 매핑한다. */
type StateSources<State> = {
  readonly [Key in keyof State]: State[Key] extends StateDescriptor<infer T>
    ? CurrentValueSource<T>
    : never;
};

/** event 정의 map을 descriptor의 값 타입으로부터 추론한 EventSource map으로 매핑한다. */
type EventSources<Event> = {
  readonly [Key in keyof Event]: Event[Key] extends EventDescriptor<infer T>
    ? EventSource<T>
    : never;
};

/**
 * 도메인 정의에 카테고리(rpc/state/event)가 있는지에 따라 handlers 객체의
 * 해당 필드 요구 수준을 결정한다.
 * - 카테고리에 선언된 key가 있으면: 필드 필수, Mapped 타입으로 각 key 필수.
 * - 카테고리는 있지만 key가 없으면: 필드 optional, 빈 객체만 허용.
 *   `Record<never, never>`(= `{}`)는 excess property check 대상이 아니라서
 *   값이 never인 index signature로 모든 key를 막는다.
 * - 카테고리 자체가 없으면: 필드를 `?: never`로 막는다.
 */
type CategoryHandlers<
  Definitions extends DomainDefinitions,
  Category extends "rpc" | "state" | "event",
  Mapped,
> = Definitions extends { readonly [K in Category]: infer Entries }
  ? [keyof Entries] extends [never]
    ? { readonly [K in Category]?: { readonly [key: string]: never } }
    : { readonly [K in Category]: Mapped }
  : { readonly [K in Category]?: never };

/** 도메인 정의로부터 `implementDomain`이 요구하는 handlers 객체 타입을 추론한다. */
export type DomainHandlers<Definitions extends DomainDefinitions> =
  CategoryHandlers<Definitions, "rpc", RpcHandlers<Definitions["rpc"]>> &
    CategoryHandlers<Definitions, "state", StateSources<Definitions["state"]>> &
    CategoryHandlers<Definitions, "event", EventSources<Definitions["event"]>>;

/**
 * 도메인 계약(domain)에 대한 handler 구현을 타입 검사와 함께 등록 가능한
 * DomainImplementation으로 정규화한다. handlers의 형태는 domain의
 * DomainDefinitions로부터 추론되며, 선언되지 않은 카테고리·operation은
 * 타입 검사(excess property check)에서 걸러진다. 런타임 검증은
 * normalizeImplementation이 그대로 수행한다(DELTA-02).
 */
export function implementDomain<
  Name extends string,
  Definitions extends DomainDefinitions,
>(
  domain: DomainContract<Name, Definitions>,
  handlers: DomainHandlers<Definitions>,
): DomainImplementation<Name> {
  // handlers는 descriptor의 I(입력)로 좁혀진 handler를 담지만
  // normalizeImplementation은 BridgeValue를 받는 넓은 RpcHandler를 기대한다.
  // 매개변수 반공변성 때문에 구조적으로 대입 불가능하나, 런타임 입력은
  // descriptor의 input.parse를 거친 값이라 안전하다. 이 캐스팅은 이 호출
  // 경계 한 곳에만 둔다.
  return normalizeImplementation(
    domain,
    handlers as unknown as Parameters<typeof normalizeImplementation>[1],
  ) as unknown as DomainImplementation<Name>;
}
