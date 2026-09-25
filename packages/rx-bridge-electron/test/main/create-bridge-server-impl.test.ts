// DELTA-04(RD-011): 경량 계약의 새 공개 API `createBridgeServer<B>(impl, options)`를
// 검증한다. 기존 `createBridgeServer(contract, implementations, options)` 오버로드는
// 그대로 두고(DELTA-09에서 제거 예정), 이 파일은 descriptor 없이 impl 트리만으로
// RPC·State·Event가 동작하는지, impl 형태 오류·이름 규칙 위반이 생성 시점에 명확한
// 에러로 실패하는지, `payloadLimits`·`resourceLimits`·event buffer 옵션이 impl 경로에도
// 그대로 적용되는지를 다룬다. `.scratch/lightweight-contract/spec.md`의 확정 결정
// 2(Main 구현)·4(event buffer)·5(errors) 참고.
import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test } from "vitest";

import type {
  BridgeImpl,
  ErrorsFor,
  Schema,
  SchemasFor,
} from "../../src/contract/index.js";
import {
  broadcastEvent,
  createBridgeServer,
  currentValueSource,
  scopedEvent,
  type BridgeDiagnostic,
} from "../../src/main/index.js";
import type { StreamMessage } from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

type Connection = { readonly ok: boolean };
type SendResult = { readonly bytesWritten: number };
type SerialLine = { readonly text: string };

/** DELTA-02 bridge-types.test.ts와 같은 형태의 예시 계약. */
type AppBridge = {
  device: {
    rpc: {
      connect(): Connection;
      send(input: { readonly command: string }): SendResult;
    };
    state: { connection: Connection };
    event: { data: SerialLine };
  };
};

/** 정상 impl 하나를 만든다. 호출자가 필요할 때만 event/state source를 참조할 수 있게 나눠 돌려준다. */
function buildImpl(): {
  readonly impl: BridgeImpl<AppBridge>;
  readonly connectionSource: BehaviorSubject<Connection>;
  readonly dataEvents: Subject<SerialLine>;
} {
  const connectionSource = new BehaviorSubject<Connection>({ ok: true });
  const dataEvents = new Subject<SerialLine>();
  const impl: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        send: async (input) => ({ bytesWritten: input.command.length }),
      },
      state: { connection: currentValueSource(connectionSource) },
      event: { data: broadcastEvent(dataEvents) },
    },
  };
  return { impl, connectionSource, dataEvents };
}

const messageTypes = (messages: readonly StreamMessage[]) =>
  messages.map((message) => message.type);

describe("createBridgeServer(impl, options): 스키마 없는 왕복", () => {
  test("스키마 없는 RPC를 왕복한다(입력 있음/없음)", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl);
    server.attach(new FakeTarget());

    const sendResponse = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-send",
      key: "rpc:device/send",
      input: { command: "abc" },
    });
    expect(sendResponse).toMatchObject({
      type: "success",
      result: { bytesWritten: 3 },
    });

    const connectResponse = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-connect",
      key: "rpc:device/connect",
      input: undefined,
    });
    expect(connectResponse).toMatchObject({
      type: "success",
      result: { ok: true },
    });
  });

  test("스키마 없는 State를 구독해 현재 값을 받는다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl);
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];

    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "state:device/connection",
      },
      (message) => messages.push(message),
    );

    expect(messageTypes(messages)).toEqual(["subscribed", "batch"]);
    expect(messages[1]).toMatchObject({ values: [{ ok: true }] });
  });

  test("스키마 없는 Event를 구독해 값을 받는다", async () => {
    const { impl, dataEvents } = buildImpl();
    const server = createBridgeServer(impl);
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];

    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "event:device/data",
      },
      (message) => messages.push(message),
    );
    dataEvents.next({ text: "hello" });

    expect(messageTypes(messages)).toEqual(["subscribed", "batch"]);
    expect(messages[1]).toMatchObject({ values: [{ text: "hello" }] });
  });
});

describe("createBridgeServer(impl, options): impl 형태 오류는 생성 시점에 실패한다", () => {
  test("RPC handler가 함수가 아니면 실패한다", () => {
    expect(() =>
      createBridgeServer({
        device: { rpc: { connect: "not-a-function" } },
      }),
    ).toThrow(/RPC handler 'device\/connect' must be a function\./);
  });

  test("State source에 getValue가 없으면 실패한다", () => {
    expect(() =>
      createBridgeServer({
        device: { state: { connection: { subscribe: () => undefined } } },
      }),
    ).toThrow(/State source 'device\/connection' must have a current value\./);
  });

  test("Event source가 Observable도 source adapter도 아니면 실패한다", () => {
    expect(() =>
      createBridgeServer({
        device: { event: { data: { not: "a source" } } },
      }),
    ).toThrow(
      /Event source 'device\/data' must be an Observable or source adapter\./,
    );
  });

  test("잘못된 registration과 잘못된 resourceLimits가 함께면 registration 오류가 먼저 난다", () => {
    expect(() =>
      createBridgeServer(
        { device: { rpc: { connect: "not-a-function" } } },
        { resourceLimits: { maxConcurrentRpc: 0 } },
      ),
    ).toThrow(/RPC handler 'device\/connect' must be a function\./);
  });
});

describe("createBridgeServer(impl, options): registration이 event source의 buffer·타입을 검증한다(RD-029)", () => {
  test.each([
    [0, "capacity 0"],
    [-1, "음수 capacity"],
    [1.5, "비정수 capacity"],
    [NaN, "NaN capacity"],
  ])("capacity가 %s(%s)이면 실패한다", (capacity) => {
    expect(() =>
      createBridgeServer({
        device: {
          event: {
            data: {
              mode: "broadcast",
              source: new Subject<SerialLine>(),
              buffer: { capacity, overflow: "error" },
            },
          },
        },
      }),
    ).toThrow(
      /Event source 'device\/data' buffer capacity must be a positive safe integer\./,
    );
  });

  test("buffer가 null이면 경로를 포함한 capacity 메시지로 실패한다", () => {
    expect(() =>
      createBridgeServer({
        device: {
          event: {
            data: {
              mode: "broadcast",
              source: new Subject<SerialLine>(),
              buffer: null,
            },
          },
        },
      }),
    ).toThrow(
      /Event source 'device\/data' buffer capacity must be a positive safe integer\./,
    );
  });

  test("overflow 값이 오타면 실패한다", () => {
    expect(() =>
      createBridgeServer({
        device: {
          event: {
            data: {
              mode: "broadcast",
              source: new Subject<SerialLine>(),
              buffer: { capacity: 10, overflow: "drop" },
            },
          },
        },
      }),
    ).toThrow(
      /Event source 'device\/data' buffer overflow must be "error", "drop-oldest", or "drop-newest"\./,
    );
  });

  test("scoped factory가 함수가 아니면 실패한다", () => {
    expect(() =>
      createBridgeServer({
        device: {
          event: {
            data: { mode: "scoped", factory: "not-a-function" },
          },
        },
      }),
    ).toThrow(/Event source 'device\/data' factory must be a function\./);
  });

  test("broadcast source가 Observable이 아니면 실패한다", () => {
    expect(() =>
      createBridgeServer({
        device: {
          event: {
            data: { mode: "broadcast", source: { not: "an observable" } },
          },
        },
      }),
    ).toThrow(/Event source 'device\/data' source must be an Observable\./);
  });

  test("직접 작성한 올바른 broadcast 리터럴은 helper로 만든 것과 같게 동작한다", async () => {
    const events = new Subject<SerialLine>();
    const server = createBridgeServer({
      device: {
        event: {
          data: {
            mode: "broadcast" as const,
            source: events,
            buffer: { capacity: 10, overflow: "error" as const },
          },
        },
      },
    });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "event:device/data",
      },
      (message) => messages.push(message),
    );
    events.next({ text: "a" });
    expect(messageTypes(messages)).toEqual(["subscribed", "batch"]);
  });

  test("직접 작성한 올바른 scoped 리터럴은 helper로 만든 것과 같게 동작한다", async () => {
    let perSubscriptionSubject: Subject<SerialLine> | undefined;
    const server = createBridgeServer({
      device: {
        event: {
          data: {
            mode: "scoped" as const,
            factory: () => {
              perSubscriptionSubject = new Subject<SerialLine>();
              return perSubscriptionSubject;
            },
          },
        },
      },
    });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "event:device/data",
      },
      (message) => messages.push(message),
    );
    perSubscriptionSubject?.next({ text: "a" });
    expect(messageTypes(messages)).toEqual(["subscribed", "batch"]);
  });
});

describe("createBridgeServer(impl, options): 이름 규칙 위반은 생성 시점에 실패한다", () => {
  // 규칙 자체는 `test/protocol/operation-key.test.ts`가 case table로 검증한다.
  // 여기는 Main이 코어를 호출해 `TypeError`로 거부하는지만 대표 건으로 본다.
  test("leaf(operation)와 namespace(중첩 도메인)가 충돌하면 실패한다", () => {
    expect(() =>
      createBridgeServer({
        device: {
          rpc: { connect: () => 1 },
          connect: { rpc: { ping: () => 1 } },
        },
      }),
    ).toThrow(TypeError);
  });

  test("같은 도메인 안에서 카테고리를 넘나드는 operation 이름 중복은 실패한다(DELTA-07: contract.test.ts의 'duplicate paths'에서 옮김)", () => {
    const source = new BehaviorSubject(1);
    expect(() =>
      createBridgeServer({
        device: {
          rpc: { duplicate: () => 1 },
          state: { duplicate: currentValueSource(source) },
        },
      }),
    ).toThrow(TypeError);
  });

  // namespace key split(`"sub/rpc"`)은 코어가 아니라 Main impl 순회의 책임이라
  // seam에서만 검증된다.
  test.each([
    [
      "reserved 'then' segment",
      { then: { rpc: { x: () => 1 } } },
      /reserved segment 'then'/,
    ],
    [
      "reserved 'rpc' segment nested (namespace key split)",
      { "sub/rpc": { rpc: { x: () => 1 } } },
      /reserved segment 'rpc'/,
    ],
  ] as const)(
    "%s는 실패한다(DELTA-07: contract.test.ts에서 옮김)",
    (_label, impl, pattern) => {
      expect(() => createBridgeServer(impl)).toThrow(pattern);
    },
  );

  test("카테고리 이름을 operation 이름으로 쓰는 것은 허용된다(DELTA-07: contract.test.ts의 'allows category names as operation names'에서 옮김)", () => {
    expect(() =>
      createBridgeServer({
        device: {
          rpc: { state: () => 1 },
          event: { rpc: broadcastEvent(new Subject<number>()) },
        },
      }),
    ).not.toThrow();
  });

  test("'dispose'라는 이름의 operation은 예약되지 않은 도메인 아래에서 허용된다(DELTA-07: contract.test.ts에서 옮김)", () => {
    expect(() =>
      createBridgeServer({
        device: { rpc: { dispose: () => 1 } },
      }),
    ).not.toThrow();
  });
});

describe("createBridgeServer(impl, options): schemas/errors 옵션 배선", () => {
  const sendSchema: Schema<{ readonly command: string }> = {
    parse(value) {
      if (
        value === null ||
        typeof value !== "object" ||
        typeof (value as { command?: unknown }).command !== "string"
      )
        throw new Error("command required");
      return value as { readonly command: string };
    },
  };

  test("options.schemas에 impl에 없는 경로가 있으면 실패한다(오타)", () => {
    const { impl } = buildImpl();
    expect(() =>
      createBridgeServer(impl, {
        schemas: {
          device: { rpc: { sedn: { input: sendSchema } } },
        } as unknown as SchemasFor<AppBridge>,
      }),
    ).toThrow(/has no matching implementation/);
  });

  test("options.errors에 impl에 없는 경로가 있으면 실패한다(오타)", () => {
    const { impl } = buildImpl();
    expect(() =>
      createBridgeServer(impl, {
        errors: {
          device: { rpc: { sedn: ["DEVICE_TIMEOUT"] } },
        } as unknown as ErrorsFor<AppBridge>,
      }),
    ).toThrow(/has no matching implementation/);
  });

  test("options.schemas를 지정하면 실제 입력 검증에 쓰인다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl, {
      schemas: { device: { rpc: { send: { input: sendSchema } } } },
    });
    server.attach(new FakeTarget());

    const response = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/send",
      input: { command: 123 },
    });
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  test("options.errors로 선언한 코드만 그대로 전달되고 나머지는 INTERNAL로 바뀐다", async () => {
    const throwing: BridgeImpl<AppBridge> = {
      device: {
        rpc: {
          connect: () => ({ ok: true }),
          send: () => {
            throw Object.assign(new Error("device unavailable"), {
              code: "DEVICE_TIMEOUT",
            });
          },
        },
        state: {
          connection: currentValueSource(new BehaviorSubject({ ok: true })),
        },
        event: { data: broadcastEvent(new Subject<SerialLine>()) },
      },
    };
    const declared = createBridgeServer(throwing, {
      errors: { device: { rpc: { send: ["DEVICE_TIMEOUT"] } } },
    });
    declared.attach(new FakeTarget());
    const declaredResponse = await declared.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/send",
      input: { command: "x" },
    });
    expect(declaredResponse).toMatchObject({
      type: "error",
      error: { code: "DEVICE_TIMEOUT" },
    });

    const undeclared = createBridgeServer(throwing);
    undeclared.attach(new FakeTarget());
    const undeclaredResponse = await undeclared.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-2",
      key: "rpc:device/send",
      input: { command: "x" },
    });
    expect(undeclaredResponse).toMatchObject({
      type: "error",
      error: { code: "INTERNAL" },
    });
  });
});

describe("createBridgeServer(impl, options): payloadLimits", () => {
  test("options.payloadLimits가 기본값과 병합되고, 스키마 없는 경로에도 구조·크기 검사가 적용된다", async () => {
    const { impl } = buildImpl();
    const server = createBridgeServer(impl, {
      payloadLimits: { maxTotalBytes: 64 },
    });
    server.attach(new FakeTarget());

    const response = await server.dispatchRpc(sender(), {
      protocolVersion: 1,
      clientId: "doc-1",
      requestId: "req-1",
      key: "rpc:device/send",
      input: { command: "x".repeat(1000) },
    });
    expect(response).toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  test("알 수 없는 payloadLimits 키는 생성 시점에 실패한다", () => {
    const { impl } = buildImpl();
    expect(() =>
      createBridgeServer(impl, {
        payloadLimits: { unknownLimit: 1 } as never,
      }),
    ).toThrow(/Unknown payload limit/);
  });

  test("정수가 아닌 maxTotalBytes는 생성 시점에 실패한다(DELTA-07: contract.test.ts의 'rejects a non-integer maxTotalBytes payload limit'에서 옮김)", () => {
    const { impl } = buildImpl();
    expect(() =>
      createBridgeServer(impl, {
        payloadLimits: { maxTotalBytes: 1.5 },
      }),
    ).toThrow(TypeError);
  });

  test.each([
    "maxDepth",
    "maxEntries",
    "maxStringBytes",
    "maxTotalBytes",
  ] as const)("명시적 undefined인 %s는 생성 시점에 실패한다", (key) => {
    const { impl } = buildImpl();
    expect(() =>
      createBridgeServer(impl, {
        payloadLimits: { [key]: undefined } as never,
      }),
    ).toThrow(
      new RegExp(
        `^Payload limit '${key}' must be a non-negative safe integer\\.$`,
      ),
    );
  });
});

describe("createBridgeServer(impl, options): 세션 자원 한도", () => {
  test("resourceLimits(maxConcurrentRpc)가 impl 기반 서버에도 적용된다", async () => {
    const resolvers: Array<(value: SendResult) => void> = [];
    const impl: BridgeImpl<AppBridge> = {
      device: {
        rpc: {
          connect: () => ({ ok: true }),
          send: () =>
            new Promise<SendResult>((resolve) => {
              resolvers.push(resolve);
            }),
        },
        state: {
          connection: currentValueSource(new BehaviorSubject({ ok: true })),
        },
        event: { data: broadcastEvent(new Subject<SerialLine>()) },
      },
    };
    const server = createBridgeServer(impl, {
      resourceLimits: { maxConcurrentRpc: 1 },
    });
    server.attach(new FakeTarget());

    const req = (requestId: string) =>
      server.dispatchRpc(sender(), {
        protocolVersion: 1,
        clientId: "doc-1",
        requestId,
        key: "rpc:device/send",
        input: { command: "a" },
      });
    const first = req("req-1");
    const second = await req("req-2");
    expect(second).toMatchObject({
      type: "error",
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    resolvers[0]!({ bytesWritten: 1 });
    await expect(first).resolves.toMatchObject({ type: "success" });
  });
});

describe("createBridgeServer(impl, options): event buffer 옵션", () => {
  test("buffer 옵션을 생략하면 기본값(capacity 100, overflow error)이 적용되어 적은 이벤트로는 overflow가 나지 않는다", () => {
    const events = new Subject<SerialLine>();
    const records: BridgeDiagnostic[] = [];
    const impl: BridgeImpl<AppBridge> = {
      device: {
        rpc: {
          connect: () => ({ ok: true }),
          send: async (input) => ({ bytesWritten: input.command.length }),
        },
        state: {
          connection: currentValueSource(new BehaviorSubject({ ok: true })),
        },
        event: { data: broadcastEvent(events) },
      },
    };
    const server = createBridgeServer(impl, {
      diagnostics: { record: (event) => records.push(event) },
    });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    void server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "event:device/data",
      },
      (message) => messages.push(message),
    );
    for (let index = 0; index < 5; index += 1)
      events.next({ text: `line-${index}` });

    expect(
      records.filter((record) => record.type === "stream-dropped"),
    ).toHaveLength(0);
  });

  test("buffer 옵션으로 낮춘 capacity는 ack 없이 이어지는 이벤트에서 곧바로 overflow를 기록한다", () => {
    const events = new Subject<SerialLine>();
    const records: BridgeDiagnostic[] = [];
    const impl: BridgeImpl<AppBridge> = {
      device: {
        rpc: {
          connect: () => ({ ok: true }),
          send: async (input) => ({ bytesWritten: input.command.length }),
        },
        state: {
          connection: currentValueSource(new BehaviorSubject({ ok: true })),
        },
        event: {
          data: broadcastEvent(events, {
            buffer: { capacity: 1, overflow: "error" },
          }),
        },
      },
    };
    const server = createBridgeServer(impl, {
      diagnostics: { record: (event) => records.push(event) },
    });
    server.attach(new FakeTarget());
    const messages: StreamMessage[] = [];
    void server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "doc-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "event:device/data",
      },
      (message) => messages.push(message),
    );
    // 1번째 값은 즉시 flush(batch)되어 ack 대기 상태(inFlight)가 된다. 2번째 값은 capacity 1
    // 큐에 들어가고, 3번째 값에서 큐가 가득 차 overflow가 기록된다.
    events.next({ text: "a" });
    events.next({ text: "b" });
    events.next({ text: "c" });

    expect(
      records.filter((record) => record.type === "stream-dropped"),
    ).toHaveLength(1);
  });

  test("broadcastEvent 자체는 capacity를 검증하지 않고, createBridgeServer가 등록 시점에 검증한다", () => {
    expect(() =>
      broadcastEvent(new Subject<SerialLine>(), {
        buffer: { capacity: 0, overflow: "error" },
      }),
    ).not.toThrow();
    expect(() =>
      createBridgeServer({
        device: {
          event: {
            data: broadcastEvent(new Subject<SerialLine>(), {
              buffer: { capacity: 0, overflow: "error" },
            }),
          },
        },
      }),
    ).toThrow(
      /Event source 'device\/data' buffer capacity must be a positive safe integer\./,
    );
  });
});
