import { BehaviorSubject, Subject, of } from "rxjs";
import type { Observable } from "rxjs";
import { expectTypeOf, test } from "vitest";

import type {
  BridgeApi,
  BridgeImpl,
  ErrorsFor,
  RemoteState,
  RemoteStateSnapshot,
  Schema,
  SchemasFor,
} from "../../src/contract/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";
import type { BridgeContext } from "../../src/main/index.js";
import type { BridgeValue } from "../../src/protocol/index.js";

// 경량 계약(DELTA-02): 런타임 descriptor 없이 계약 타입 하나에서
// BridgeApi/BridgeImpl/SchemasFor/ErrorsFor를 파생할 수 있는지 검증한다.
// `.scratch/lightweight-contract/spec.md`의 확정 결정 1, 3 참고.

type Connection = { readonly ok: boolean };
type SendResult = { readonly bytesWritten: number };
type SerialLine = { readonly text: string };

/** 확정 결정 1의 예시를 확장한 계약: RPC(입력 있음/없음), state, event. */
type AppBridge = {
  device: {
    rpc: {
      connect(): Connection;
      send(input: { readonly command: string }): SendResult;
    };
    state: { connection: Connection };
    event: { data: SerialLine };
  };
  // 중첩 도메인: 네임스페이스만 있는 노드(자기 카테고리 없음).
  nested: {
    inner: {
      rpc: { ping(): { readonly ok: true } };
    };
  };
};

/** 도메인 자신이 rpc/state를 갖는 동시에 형제로 중첩 도메인도 갖는 혼합 노드. */
type MixedBridge = {
  hardware: {
    rpc: { connect(): Connection };
    state: { connection: Connection };
    serial: {
      rpc: { open(): Connection };
    };
  };
};

/** 비 BridgeValue 값 타입을 쓴 계약(Date는 BridgeValue가 아니다). */
type BadValueBridge = {
  device: {
    state: { bad: Date };
  };
};

/** 카테고리는 있지만 key가 없는(빈) 도메인 — DELTA-07: 옛 descriptor API가
 * 요구하던 "빈 카테고리는 `{}`만 허용" 규칙이 impl 기반 API에도 그대로 있는지
 * 확인한다(옛 test/main/implement-domain-types.test.ts에서 옮김). */
type EmptyRpcBridge = {
  emptyRpc: { rpc: Record<string, never> };
};

const sendSchema: Schema<{ readonly command: string }> = {
  parse: (value) => value as { readonly command: string },
};
const connectionSchema: Schema<Connection> = {
  parse: (value) => value as Connection,
};

test("BridgeApi: 입력 있는/없는 RPC, state, event를 올바르게 추론한다", () => {
  type Api = BridgeApi<AppBridge>;

  expectTypeOf<Api["device"]["rpc"]["connect"]>().toEqualTypeOf<
    () => Promise<Connection>
  >();
  expectTypeOf<Api["device"]["rpc"]["send"]>().toEqualTypeOf<
    (input: { readonly command: string }) => Promise<SendResult>
  >();
  expectTypeOf<Api["device"]["state"]["connection"]>().toEqualTypeOf<
    RemoteState<Connection>
  >();
  expectTypeOf<Api["device"]["event"]["data"]>().toEqualTypeOf<
    Observable<SerialLine>
  >();

  // ADR 0007: 노드에 있는 카테고리만 필드로 생긴다.
  expectTypeOf<keyof Api["device"]>().toEqualTypeOf<
    "rpc" | "state" | "event"
  >();
});

test("BridgeApi: 중첩 도메인(네임스페이스만 있는 노드)을 재귀적으로 추론한다", () => {
  type Api = BridgeApi<AppBridge>;

  expectTypeOf<Api["nested"]["inner"]["rpc"]["ping"]>().toEqualTypeOf<
    () => Promise<{ readonly ok: true }>
  >();
  // 중첩 네임스페이스 노드 자신은 rpc/state/event를 갖지 않는다.
  expectTypeOf<keyof Api["nested"]>().toEqualTypeOf<"inner">();
  expectTypeOf<keyof Api["nested"]["inner"]>().toEqualTypeOf<"rpc">();
});

test("BridgeApi: 도메인이 카테고리와 중첩 도메인을 동시에 가질 수 있다(혼합 노드)", () => {
  type Api = BridgeApi<MixedBridge>;

  expectTypeOf<Api["hardware"]["rpc"]["connect"]>().toEqualTypeOf<
    () => Promise<Connection>
  >();
  expectTypeOf<Api["hardware"]["state"]["connection"]>().toEqualTypeOf<
    RemoteState<Connection>
  >();
  expectTypeOf<Api["hardware"]["serial"]["rpc"]["open"]>().toEqualTypeOf<
    () => Promise<Connection>
  >();
  expectTypeOf<keyof Api["hardware"]>().toEqualTypeOf<
    "rpc" | "state" | "serial"
  >();
});

test("BridgeImpl: 올바른 구현은 그대로 대입된다(정상 케이스)", () => {
  const implementation: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: (input, context) => {
          expectTypeOf(input).toEqualTypeOf<undefined>();
          expectTypeOf(context).toEqualTypeOf<BridgeContext>();
          return { ok: true };
        },
        send: (input, context) => {
          expectTypeOf(input).toEqualTypeOf<{ readonly command: string }>();
          expectTypeOf(context).toEqualTypeOf<BridgeContext>();
          return { bytesWritten: input.command.length };
        },
      },
      state: { connection: currentValueSource(new BehaviorSubject({ ok: true })) },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: {
      inner: {
        rpc: { ping: () => ({ ok: true }) },
      },
    },
  };
  expectTypeOf(implementation).toEqualTypeOf<BridgeImpl<AppBridge>>();
});

test("BridgeImpl: BridgeValue로 넓게 선언한 handler도 반환 타입만 맞으면 허용된다(매개변수 반공변성, DELTA-07: implement-domain-types.test.ts에서 옮김)", () => {
  const wideSendHandler: (
    input: BridgeValue,
    context: BridgeContext,
  ) => SendResult = () => ({ bytesWritten: 0 });
  const implementation: BridgeImpl<AppBridge> = {
    device: {
      rpc: { connect: () => ({ ok: true }), send: wideSendHandler },
      state: { connection: currentValueSource(new BehaviorSubject({ ok: true })) },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: { inner: { rpc: { ping: () => ({ ok: true }) } } },
  };
  void implementation;
});

test("BridgeImpl: 카테고리는 있지만 key가 없는 도메인은 빈 객체만 허용한다(DELTA-07: implement-domain-types.test.ts에서 옮김)", () => {
  const emptyImpl: BridgeImpl<EmptyRpcBridge> = { emptyRpc: { rpc: {} } };
  void emptyImpl;
});

test("SchemasFor/ErrorsFor: 일부 operation에만 적용해도 대입된다(부분 적용)", () => {
  const schemas: SchemasFor<AppBridge> = {
    device: {
      rpc: {
        send: { input: sendSchema },
      },
      state: { connection: connectionSchema },
    },
  };
  const errors: ErrorsFor<AppBridge> = {
    device: { rpc: { send: ["DEVICE_TIMEOUT"] } },
  };
  expectTypeOf(schemas).toEqualTypeOf<SchemasFor<AppBridge>>();
  expectTypeOf(errors).toEqualTypeOf<ErrorsFor<AppBridge>>();
});

test("RemoteStateSnapshot: status는 uninitialized/connecting/current/stale 리터럴 합집합이다(DELTA-07: contract-types.test.ts에서 옮김 — 계약 스타일과 무관한 공용 타입)", () => {
  expectTypeOf<RemoteStateSnapshot<string>>().toMatchTypeOf<{
    readonly status: "uninitialized" | "connecting" | "current" | "stale";
  }>();
});

// 아래 블록은 타입 검사(pnpm check-types) 전용이다. 런타임 실행을 막기 위해
// if (false)로 감싼다. 각 @ts-expect-error 줄은 지우면 check-types가 그
// 줄에서 실패하는지(RED) 확인한 뒤 복원했다 — DELTA-02 결과에 근거 기록.
if (false) {
  // Schema<T extends BridgeValue> 제약 자체(계약 스타일과 무관, DELTA-07:
  // contract-types.test.ts에서 옮김) — Date/함수/클래스 인스턴스는 v1 bridge
  // payload가 아니라 Schema<T>의 T 자리에 쓸 수 없다.
  class NonBridgeClass {}
  // @ts-expect-error Date는 v1 bridge payload가 아니다.
  const dateSchema: Schema<Date> = { parse: () => new Date() };
  // @ts-expect-error 함수는 v1 bridge payload가 아니다.
  const functionSchema: Schema<() => void> = { parse: () => () => undefined };
  // @ts-expect-error 클래스 인스턴스는 v1 bridge payload가 아니다.
  const classSchema: Schema<NonBridgeClass> = {
    parse: () => new NonBridgeClass(),
  };
  void [dateSchema, functionSchema, classSchema];

  const okImpl: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        send: (input) => ({ bytesWritten: input.command.length }),
      },
      state: {
        connection: currentValueSource(new BehaviorSubject({ ok: true })),
      },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: { inner: { rpc: { ping: () => ({ ok: true }) } } },
  };
  void okImpl;

  // 누락 키: device 노드에 state가 빠졌다.
  const missingState: BridgeImpl<AppBridge> = {
    // @ts-expect-error device는 state 카테고리가 필수인데 빠졌다.
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        send: (input) => ({ bytesWritten: input.command.length }),
      },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: { inner: { rpc: { ping: () => ({ ok: true }) } } },
  };
  void missingState;

  // 누락 키: 최상위 도메인 nested 자체가 빠졌다.
  // @ts-expect-error nested 도메인이 계약에 있는데 빠졌다.
  const missingDomain: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        send: (input) => ({ bytesWritten: input.command.length }),
      },
      state: {
        connection: currentValueSource(new BehaviorSubject({ ok: true })),
      },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
  };
  void missingDomain;

  // 초과 키: rpc에 계약에 없는 operation을 추가했다.
  const excessOperation: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        send: (input) => ({ bytesWritten: input.command.length }),
        // @ts-expect-error contract에 없는 operation은 초과 속성 검사에서 걸린다.
        disconnect: () => ({ ok: true }),
      },
      state: {
        connection: currentValueSource(new BehaviorSubject({ ok: true })),
      },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: { inner: { rpc: { ping: () => ({ ok: true }) } } },
  };
  void excessOperation;

  // 초과 키: 계약에 없는 도메인을 최상위에 추가했다.
  const excessDomain: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        send: (input) => ({ bytesWritten: input.command.length }),
      },
      state: {
        connection: currentValueSource(new BehaviorSubject({ ok: true })),
      },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: { inner: { rpc: { ping: () => ({ ok: true }) } } },
    // @ts-expect-error extra는 계약에 없는 도메인이다.
    extra: { rpc: { ping: () => ({ ok: true }) } },
  };
  void excessDomain;

  // handler 반환 타입 불일치(DELTA-07: implement-domain-types.test.ts에서 옮김).
  const wrongReturnType: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        // @ts-expect-error connect handler는 Connection을 반환해야 한다.
        connect: () => "nope",
        send: (input) => ({ bytesWritten: input.command.length }),
      },
      state: {
        connection: currentValueSource(new BehaviorSubject({ ok: true })),
      },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: { inner: { rpc: { ping: () => ({ ok: true }) } } },
  };
  void wrongReturnType;

  // handler 입력 매개변수 타입 불일치(DELTA-07: implement-domain-types.test.ts에서
  // 옮김) — 반공변성은 "더 넓은 타입을 받는 handler"만 허용하고, 구조적으로
  // 다른 타입(command: number)까지 허용하지는 않는다.
  const wrongInputParamType: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        // @ts-expect-error send handler의 input은 { command: string }이어야 한다.
        send: (input: { readonly command: number }) => ({
          bytesWritten: input.command,
        }),
      },
      state: {
        connection: currentValueSource(new BehaviorSubject({ ok: true })),
      },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: { inner: { rpc: { ping: () => ({ ok: true }) } } },
  };
  void wrongInputParamType;

  // 누락 키: 카테고리 자체는 있지만 그 안의 operation 하나가 빠졌다(DELTA-07:
  // implement-domain-types.test.ts에서 옮김) — device.rpc는 connect와 send를
  // 모두 요구한다.
  const missingOperationWithinCategory: BridgeImpl<AppBridge> = {
    device: {
      // @ts-expect-error device.rpc는 send도 필수인데 빠졌다.
      rpc: { connect: () => ({ ok: true }) },
      state: {
        connection: currentValueSource(new BehaviorSubject({ ok: true })),
      },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: { inner: { rpc: { ping: () => ({ ok: true }) } } },
  };
  void missingOperationWithinCategory;

  // 카테고리 자체가 없는 노드에 그 카테고리를 추가했다(DELTA-07:
  // implement-domain-types.test.ts에서 옮김) — nested.inner는 rpc만 있고
  // state 카테고리가 없다.
  const extraCategoryOnRpcOnlyNode: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        send: (input) => ({ bytesWritten: input.command.length }),
      },
      state: {
        connection: currentValueSource(new BehaviorSubject({ ok: true })),
      },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: {
      inner: {
        rpc: { ping: () => ({ ok: true }) },
        // @ts-expect-error inner 도메인은 state 카테고리를 갖지 않는다.
        state: {},
      },
    },
  };
  void extraCategoryOnRpcOnlyNode;

  // 빈 카테고리(key 없음)는 빈 객체만 허용한다(DELTA-07:
  // implement-domain-types.test.ts에서 옮김) — EmptyRpcBridge.emptyRpc.rpc에
  // 없는 operation을 추가하면 초과 속성 검사에서 걸린다.
  const extraKeyOnEmptyCategory: BridgeImpl<EmptyRpcBridge> = {
    emptyRpc: {
      // @ts-expect-error key가 없는 rpc 카테고리는 빈 객체만 허용한다.
      rpc: { extra: () => 1 },
    },
  };
  void extraKeyOnEmptyCategory;

  // State source 값 타입 불일치(BridgeValue이긴 하나 선언과 다른 타입,
  // DELTA-07: implement-domain-types.test.ts에서 옮김) — connection은
  // Connection이어야 하는데 string을 흘려보낸다.
  const wrongStateValueType: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        send: (input) => ({ bytesWritten: input.command.length }),
      },
      // @ts-expect-error connection은 CurrentValueSource<Connection>이어야 한다.
      state: { connection: currentValueSource(new BehaviorSubject("nope")) },
      event: { data: broadcastEvent(new Subject<SerialLine>()) },
    },
    nested: { inner: { rpc: { ping: () => ({ ok: true }) } } },
  };
  void wrongStateValueType;

  // 경로 오타: schemas map의 operation 이름.
  const typoOperationSchema: SchemasFor<AppBridge> = {
    device: {
      rpc: {
        // @ts-expect-error 'sedn'은 존재하지 않는 operation 이름이다(오타).
        sedn: { input: sendSchema },
      },
    },
  };
  void typoOperationSchema;

  // 경로 오타: schemas map의 도메인 이름.
  const typoDomainSchema: SchemasFor<AppBridge> = {
    // @ts-expect-error 'devicee'는 존재하지 않는 도메인 이름이다(오타).
    devicee: { rpc: { send: { input: sendSchema } } },
  };
  void typoDomainSchema;

  // 경로 오타: errors map의 operation 이름.
  const typoOperationErrors: ErrorsFor<AppBridge> = {
    device: {
      rpc: {
        // @ts-expect-error 'sedn'은 존재하지 않는 operation 이름이다(오타).
        sedn: ["DEVICE_TIMEOUT"],
      },
    },
  };
  void typoOperationErrors;

  // 스키마 출력 타입 불일치: send의 output은 SendResult여야 한다.
  const wrongOutputSchema: Schema<{ readonly wrong: true }> = {
    parse: (value) => value as { readonly wrong: true },
  };
  const mismatchedOutput: SchemasFor<AppBridge> = {
    device: {
      rpc: {
        // @ts-expect-error output 스키마가 SendResult와 맞지 않는다.
        send: { output: wrongOutputSchema },
      },
    },
  };
  void mismatchedOutput;

  // 스키마 입력 타입 불일치: send의 input은 { command: string }이어야 한다.
  const wrongInputSchema: Schema<{ readonly wrong: true }> = {
    parse: (value) => value as { readonly wrong: true },
  };
  const mismatchedInput: SchemasFor<AppBridge> = {
    device: {
      rpc: {
        // @ts-expect-error input 스키마가 { command: string }과 맞지 않는다.
        send: { input: wrongInputSchema },
      },
    },
  };
  void mismatchedInput;

  // 입력 없는 RPC는 input 인자를 받지 않는다(Renderer 쪽).
  const api = null as unknown as BridgeApi<AppBridge>;
  // @ts-expect-error 입력 없는 RPC(connect)는 인자를 받지 않는다.
  void api.device.rpc.connect({ deviceId: 1 });

  // 입력 있는 RPC(Renderer 쪽)는 값 타입이 계약과 맞아야 한다(DELTA-07:
  // contract-types.test.ts의 "RPC input must match its schema type"에서 옮김).
  // @ts-expect-error send의 command는 string이어야 하는데 number를 넘겼다.
  void api.device.rpc.send({ command: 123 });

  // 입력 없는 RPC는 schemas map에 input 필드 자체가 없다.
  const noInputSchemaField: SchemasFor<AppBridge> = {
    device: {
      rpc: {
        // @ts-expect-error connect는 입력이 없어 input 스키마를 둘 수 없다.
        connect: { input: connectionSchema },
      },
    },
  };
  void noInputSchemaField;

  // 비 BridgeValue 값: Date는 BridgeValue가 아니므로 이 필드는 never가 되어
  // 실제 값을 대입할 수 없다. currentValueSource(BridgeValue로 제약된 도우미)를
  // 거치지 않고 CurrentValueSource 모양만 구조적으로 맞춘 값을 만들어, 대입
  // 시점의 에러(never 위반)만 드러나게 한다.
  const badSource = Object.assign(new BehaviorSubject(new Date()), {
    getValue: () => new Date(),
  });
  const badImpl: BridgeImpl<BadValueBridge> = {
    device: {
      state: {
        // @ts-expect-error Date는 BridgeValue가 아니라 이 필드는 never가 된다.
        bad: badSource,
      },
    },
  };
  void badImpl;

  // event 소스 타입 불일치: EventSource<SerialLine>이어야 하는데 다른 타입.
  const wrongEventType: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        send: (input) => ({ bytesWritten: input.command.length }),
      },
      state: {
        connection: currentValueSource(new BehaviorSubject({ ok: true })),
      },
      // @ts-expect-error event 소스는 EventSource<SerialLine>이어야 한다.
      event: { data: broadcastEvent(of(1)) },
    },
    nested: { inner: { rpc: { ping: () => ({ ok: true }) } } },
  };
  void wrongEventType;
}
