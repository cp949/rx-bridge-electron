import type { Observable } from "rxjs";

import type { CurrentValueSource, EventSource } from "../main/sources.js";
import type { BridgeContext } from "../main/types.js";
import type { BridgeValue } from "../protocol/index.js";
import type { RemoteState } from "./infer.js";
import type { Schema } from "./schema.js";

/**
 * 계약 타입 수준에서 `T extends BridgeValue` 제약을 검사한다. T가 BridgeValue를
 * 만족하면 T 그대로, 아니면 `never`로 치환한다. `never`로 치환된 leaf는 실제
 * handler·스키마·상태 소스를 대입하려는 시점에 항상 타입 에러가 나므로, 계약에
 * non-BridgeValue 값 타입을 쓴 지점을 "사용 시점"에 드러낸다.
 *
 * `T extends BridgeValue`로 타입 매개변수 자체를 제약하는 방식(예:
 * `type Assert<T extends BridgeValue> = T`) 대신 이 조건부 타입을 쓰는 이유:
 * 재귀 처리 중에는 값 타입이 아직 구체화되지 않은 채(예: 매핑 타입의
 * `State[Key]`) 여러 단계를 거치는데, 그 상태로 이미 제약이 걸린 다른 제네릭
 * (`Schema<T extends BridgeValue>`, `EventSource<T extends BridgeValue>`)에
 * 곧바로 넘기면 B가 구체 타입으로 대입되기 전에도(즉 라이브러리 코드 자체가)
 * 즉시 컴파일 에러가 난다. `[T] extends [BridgeValue] ? T : never` 형태는
 * T가 구체화되기 전까지 평가를 미루면서도, 제약이 걸린 다른 제네릭에 안전하게
 * 전달할 수 있다(`never`는 모든 제약을 만족한다).
 */
type BridgeValueOrNever<T> = [T] extends [BridgeValue] ? T : never;

/**
 * 계약 타입에서 예약된 카테고리 키. 노드의 키가 이 중 하나면 rpc/state/event로
 * 처리하고, 그 외 키는 전부 중첩 도메인(네임스페이스)으로 보고 재귀 처리한다.
 */
type CategoryKey = "rpc" | "state" | "event";

/**
 * RPC operation 시그니처(`() => O` 또는 `(input: I) => O`)에서 입력·출력을
 * 추출해 Renderer용 함수 타입으로 바꾼다. 인자가 없으면 `Args`가 `[]`, 하나면
 * `[I]`. 인자가 둘 이상인 다중 인자 RPC는 범위 밖이라 `never`가 된다.
 */
type RpcApiOperation<Method> = Method extends (
  ...args: infer Args
) => infer Output
  ? Args extends []
    ? () => Promise<BridgeValueOrNever<Output>>
    : Args extends [infer Input]
      ? (
          input: BridgeValueOrNever<Input>,
        ) => Promise<BridgeValueOrNever<Output>>
      : never
  : never;

/**
 * RPC operation 시그니처에서 Main이 구현해야 하는 handler 타입을 만든다.
 * dispatcher가 항상 `handler(input, context)` 2-인자로 호출하므로(입력 없는
 * RPC는 `input`이 항상 `undefined`), 입력이 없어도 매개변수 위치는 동일하게
 * 유지한다: `(input: undefined, context) => O | Promise<O>`. 함수 타입은
 * 선언한 매개변수 수가 적어도 대입 가능하므로, context가 필요 없는 구현은
 * `() => O`만 써도 된다.
 */
type RpcImplOperation<Method> = Method extends (
  ...args: infer Args
) => infer Output
  ? Args extends []
    ? (
        input: undefined,
        context: BridgeContext,
      ) => BridgeValueOrNever<Output> | Promise<BridgeValueOrNever<Output>>
    : Args extends [infer Input]
      ? (
          input: BridgeValueOrNever<Input>,
          context: BridgeContext,
        ) => BridgeValueOrNever<Output> | Promise<BridgeValueOrNever<Output>>
      : never
  : never;

/**
 * RPC operation 시그니처에서 `options.schemas`에 올 수 있는 부분 항목
 * (`{ input?, output? }`)을 만든다. 입력이 없는 RPC는 `input` 자체를 두지
 * 않는다.
 */
type SchemasForOperation<Method> = Method extends (
  ...args: infer Args
) => infer Output
  ? Args extends []
    ? { readonly output?: Schema<BridgeValueOrNever<Output>> }
    : Args extends [infer Input]
      ? {
          readonly input?: Schema<BridgeValueOrNever<Input>>;
          readonly output?: Schema<BridgeValueOrNever<Output>>;
        }
      : never
  : never;

/**
 * 계약 노드(도메인 또는 그 하위 네임스페이스)를 Renderer 공개 타입으로
 * 변환한다. `rpc`/`state`/`event` 중 노드에 실제로 있는 키만 대응 필드를
 * 만든다(ADR 0007) — 없는 카테고리는 필드 자체가 생기지 않는다. 나머지 키는
 * 중첩 도메인으로 보고 재귀한다. 한 노드가 카테고리와 중첩 도메인을 동시에
 * 가질 수도 있다(예: `{ rpc: {...}, serial: { rpc: {...} } }`).
 */
type BridgeApiNode<Node> = (Node extends { readonly rpc: infer Rpc }
  ? {
      readonly rpc: {
        readonly [Key in keyof Rpc]: RpcApiOperation<Rpc[Key]>;
      };
    }
  : unknown) &
  (Node extends { readonly state: infer State }
    ? {
        readonly state: {
          readonly [Key in keyof State]: RemoteState<
            BridgeValueOrNever<State[Key]>
          >;
        };
      }
    : unknown) &
  (Node extends { readonly event: infer Event }
    ? {
        readonly event: {
          readonly [Key in keyof Event]: Observable<
            BridgeValueOrNever<Event[Key]>
          >;
        };
      }
    : unknown) & {
    readonly [Key in Exclude<keyof Node, CategoryKey>]: BridgeApiNode<
      Node[Key]
    >;
  };

/** Renderer가 계약 타입 `B`로부터 얻는 공개 API 타입. */
export type BridgeApi<B> = BridgeApiNode<B>;

/**
 * 계약 노드를 Main 구현 타입으로 변환한다. `BridgeApiNode`와 같은 카테고리·
 * 재귀 규칙을 따르되, 각 카테고리 값이 `RpcImplOperation`·`CurrentValueSource`·
 * `EventSource`로 바뀐다. 모든 필드가 필수이므로 카테고리·operation·도메인
 * 키가 누락되면 "필수 프로퍼티 누락"으로, 계약에 없는 키를 추가하면 excess
 * property check로 타입 에러가 난다.
 */
type BridgeImplNode<Node> = (Node extends { readonly rpc: infer Rpc }
  ? {
      readonly rpc: {
        readonly [Key in keyof Rpc]: RpcImplOperation<Rpc[Key]>;
      };
    }
  : unknown) &
  (Node extends { readonly state: infer State }
    ? {
        readonly state: {
          readonly [Key in keyof State]: CurrentValueSource<
            BridgeValueOrNever<State[Key]>
          >;
        };
      }
    : unknown) &
  (Node extends { readonly event: infer Event }
    ? {
        readonly event: {
          readonly [Key in keyof Event]: EventSource<
            BridgeValueOrNever<Event[Key]>
          >;
        };
      }
    : unknown) & {
    readonly [Key in Exclude<keyof Node, CategoryKey>]: BridgeImplNode<
      Node[Key]
    >;
  };

/** Main에서 계약 타입 `B`를 구현하기 위해 `createBridgeServer`에 넘길 타입. */
export type BridgeImpl<B> = BridgeImplNode<B>;

/**
 * 계약 노드로부터 `options.schemas`에 둘 수 있는 부분 중첩 map을 만든다.
 * 모든 필드가 optional이라 일부 operation에만 스키마를 적용할 수 있다.
 * 경로 오타(존재하지 않는 도메인·카테고리·operation 이름)는 excess property
 * check로 걸러지고, 스키마 출력 타입 불일치는 `Schema<T>` 자체의 제약된 타입
 * 매개변수 덕에 대입 시점에 걸러진다.
 */
type SchemasForNode<Node> = (Node extends { readonly rpc: infer Rpc }
  ? {
      readonly rpc?: {
        readonly [Key in keyof Rpc]?: SchemasForOperation<Rpc[Key]>;
      };
    }
  : unknown) &
  (Node extends { readonly state: infer State }
    ? {
        readonly state?: {
          readonly [Key in keyof State]?: Schema<
            BridgeValueOrNever<State[Key]>
          >;
        };
      }
    : unknown) &
  (Node extends { readonly event: infer Event }
    ? {
        readonly event?: {
          readonly [Key in keyof Event]?: Schema<
            BridgeValueOrNever<Event[Key]>
          >;
        };
      }
    : unknown) & {
    readonly [Key in Exclude<keyof Node, CategoryKey>]?: SchemasForNode<
      Node[Key]
    >;
  };

/** `createBridgeServer`의 `options.schemas` 타입. */
export type SchemasFor<B> = SchemasForNode<B>;

/**
 * 계약 노드로부터 `options.errors`에 둘 수 있는 부분 중첩 map을 만든다.
 * RPC operation에만 허용 에러 코드 목록(`readonly string[]`)을 둘 수 있다 —
 * state·event는 에러 코드 개념이 없어 필드 자체가 생기지 않는다.
 */
type ErrorsForNode<Node> = (Node extends { readonly rpc: infer Rpc }
  ? {
      readonly rpc?: {
        readonly [Key in keyof Rpc]?: readonly string[];
      };
    }
  : unknown) & {
  readonly [Key in Exclude<keyof Node, CategoryKey>]?: ErrorsForNode<Node[Key]>;
};

/** `createBridgeServer`의 `options.errors` 타입. */
export type ErrorsFor<B> = ErrorsForNode<B>;
