import type { Observable } from "rxjs";
import { describe, expect, test } from "vitest";

import type { RemoteState } from "../../src/contract/index.js";
import {
  createRendererApi,
  RemoteError,
  type RendererApi,
} from "../../src/renderer/index.js";
import type {
  RendererStreamCommand,
  StreamMessage,
} from "../../src/protocol/index.js";
import { FakeTransport } from "./fake-transport.js";

interface AppBridge {
  readonly hardware: {
    readonly rpc: {
      connect(): Promise<{ readonly connected: boolean }>;
    };
    readonly state: {
      readonly status$: RemoteState<string | undefined>;
    };
    readonly event: {
      readonly log$: Observable<string>;
    };
  };
}

type StreamMessageBody = StreamMessage extends infer Message
  ? Message extends StreamMessage
    ? Omit<Message, "protocolVersion" | "clientId" | "subscriptionId">
    : never
  : never;

type SubscribeCommand = Extract<
  RendererStreamCommand,
  { readonly type: "subscribe" }
>;

function bridgeTransport(): FakeTransport {
  const transport = new FakeTransport();
  transport.handshake = Promise.resolve({
    protocolVersion: 1,
    clientId: "client-1",
    manifest: {
      rpc: ["rpc:hardware/connect"],
      state: ["state:hardware/status$"],
      event: ["event:hardware/log$"],
    },
  });
  return transport;
}

function message(
  subscriptionId: string,
  value: StreamMessageBody,
): StreamMessage {
  return {
    protocolVersion: 1,
    clientId: "client-1",
    subscriptionId,
    ...value,
  } as StreamMessage;
}

function subscribeCommands(transport: FakeTransport): SubscribeCommand[] {
  return transport.controls.filter(
    (command): command is SubscribeCommand => command.type === "subscribe",
  );
}

function subscriptionIdFor(transport: FakeTransport, key: string): string {
  const command = subscribeCommands(transport).find(
    (candidate) => candidate.key === key,
  );
  if (command === undefined) {
    throw new Error(`Missing subscribe command for ${key}.`);
  }
  return command.subscriptionId;
}

async function setup(): Promise<{
  readonly transport: FakeTransport;
  readonly api: RendererApi<AppBridge>;
}> {
  const transport = bridgeTransport();
  const api = await createRendererApi<AppBridge>(transport);
  return { transport, api };
}

describe("api.dispose() root shutdown", () => {
  test("진행 중 RPC를 CANCELLED로 확정하고 활성 State·Event 구독을 complete한다", async () => {
    const { transport, api } = await setup();

    const rpcPromise = api.hardware.rpc.connect();
    const invocation = transport.invocations[0]!;

    let stateErrored: unknown;
    let stateCompleted = 0;
    const stateValues: Array<string | undefined> = [];
    api.hardware.state.status$.subscribe({
      next: (value) => stateValues.push(value),
      error: (error) => {
        stateErrored = error;
      },
      complete: () => {
        stateCompleted += 1;
      },
    });
    const stateId = subscriptionIdFor(transport, "state:hardware/status$");
    transport.emitStream(message(stateId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      message(stateId, { type: "batch", sequence: 1, values: ["connected"] }),
    );

    let eventErrored: unknown;
    let eventCompleted = 0;
    const eventValues: string[] = [];
    api.hardware.event.log$.subscribe({
      next: (value) => eventValues.push(value),
      error: (error) => {
        eventErrored = error;
      },
      complete: () => {
        eventCompleted += 1;
      },
    });
    const eventId = subscriptionIdFor(transport, "event:hardware/log$");
    transport.emitStream(message(eventId, { type: "subscribed", sequence: 0 }));

    api.dispose();

    await expect(rpcPromise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(transport.cancellations).toEqual([invocation.requestId]);

    const unsubscribes = transport.controls.filter(
      (command) => command.type === "unsubscribe",
    );
    expect(unsubscribes).toHaveLength(2);
    expect(
      unsubscribes.filter(
        (command) =>
          command.type === "unsubscribe" && command.subscriptionId === stateId,
      ),
    ).toHaveLength(1);
    expect(
      unsubscribes.filter(
        (command) =>
          command.type === "unsubscribe" && command.subscriptionId === eventId,
      ),
    ).toHaveLength(1);

    expect(stateCompleted).toBe(1);
    expect(eventCompleted).toBe(1);
    expect(stateErrored).toBeUndefined();
    expect(eventErrored).toBeUndefined();

    expect(api.hardware.state.status$.snapshot).toEqual({
      status: "stale",
      active: false,
      value: "connected",
    });

    expect(transport.streamListeners.size).toBe(0);
  });

  test("반복 dispose는 no-op이다", async () => {
    const { transport, api } = await setup();

    api.hardware.rpc.connect().catch(() => {});
    api.hardware.state.status$.subscribe({ error: () => {} });
    api.hardware.event.log$.subscribe({ error: () => {} });

    api.dispose();
    const controlsAfterFirst = transport.controls.length;
    const cancellationsAfterFirst = transport.cancellations.length;

    expect(() => {
      api.dispose();
      api.dispose();
      api[Symbol.dispose]();
    }).not.toThrow();

    expect(transport.controls).toHaveLength(controlsAfterFirst);
    expect(transport.cancellations).toHaveLength(cancellationsAfterFirst);
  });

  test("재진입: complete 콜백 안에서 dispose·RPC·subscribe를 호출해도 안전하다", async () => {
    const { transport, api } = await setup();

    const rpcPromise = api.hardware.rpc.connect();
    const invocation = transport.invocations[0]!;
    const invocationCountBeforeDispose = transport.invocations.length;

    let reentrantRpcPromise: Promise<unknown> | undefined;
    let reentrantStateError: unknown;
    let reentrantEventError: unknown;
    let reentrantSubscribeControlSent = false;
    let innerDisposeAddedControls: boolean | undefined;
    let innerDisposeAddedCancellations: boolean | undefined;

    api.hardware.state.status$.subscribe({
      error: () => {},
      complete: () => {
        const controlsBefore = transport.controls.length;
        const cancellationsBefore = transport.cancellations.length;
        expect(() => api.dispose()).not.toThrow();
        innerDisposeAddedControls =
          transport.controls.length !== controlsBefore;
        innerDisposeAddedCancellations =
          transport.cancellations.length !== cancellationsBefore;

        reentrantRpcPromise = api.hardware.rpc.connect();

        const controlsBeforeReentrantSubscribe = transport.controls.length;
        api.hardware.state.status$.subscribe({
          error: (error) => {
            reentrantStateError = error;
          },
        });
        api.hardware.event.log$.subscribe({
          error: (error) => {
            reentrantEventError = error;
          },
        });
        reentrantSubscribeControlSent =
          transport.controls.length !== controlsBeforeReentrantSubscribe;
      },
    });

    api.dispose();

    expect(innerDisposeAddedControls).toBe(false);
    expect(innerDisposeAddedCancellations).toBe(false);

    expect(reentrantStateError).toMatchObject({ code: "CANCELLED" });
    expect(reentrantEventError).toMatchObject({ code: "CANCELLED" });
    expect(reentrantSubscribeControlSent).toBe(false);

    await expect(rpcPromise).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(reentrantRpcPromise).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(transport.invocations).toHaveLength(invocationCountBeforeDispose);
    expect(transport.cancellations).toEqual([invocation.requestId]);
  });

  test("재진입: 아직 complete되지 않은 활성 generation에 합류하는 subscribe도 동기 CANCELLED다", async () => {
    const { transport, api } = await setup();

    api.hardware.event.log$.subscribe({ error: () => {} });
    const eventId = subscriptionIdFor(transport, "event:hardware/log$");
    transport.emitStream(message(eventId, { type: "subscribed", sequence: 0 }));

    api.hardware.state.status$.subscribe({ error: () => {} });
    const stateId = subscriptionIdFor(transport, "state:hardware/status$");
    transport.emitStream(message(stateId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      message(stateId, { type: "batch", sequence: 1, values: ["connected"] }),
    );

    const joinedStateValues: Array<string | undefined> = [];
    let joinedStateError: unknown;
    let joinedStateCompleted = false;
    let joinedEventError: unknown;
    let joinedEventCompleted = false;
    let controlsBeforeJoin = 0;
    let controlsAfterJoin = 0;

    // Event generation이 먼저 열렸으므로 dispose 루프에서 먼저 complete된다.
    // 그 시점에 State generation과 늦게 합류할 Event 구독은 아직 루프가 처리하지 않았다.
    api.hardware.event.log$.subscribe({
      error: () => {},
      complete: () => {
        controlsBeforeJoin = transport.controls.length;
        api.hardware.state.status$.subscribe({
          next: (value) => joinedStateValues.push(value),
          error: (error) => {
            joinedStateError = error;
          },
          complete: () => {
            joinedStateCompleted = true;
          },
        });
        api.hardware.event.log$.subscribe({
          error: (error) => {
            joinedEventError = error;
          },
          complete: () => {
            joinedEventCompleted = true;
          },
        });
        controlsAfterJoin = transport.controls.length;
      },
    });

    api.dispose();

    expect(joinedStateValues).toEqual([]);
    expect(joinedStateError).toMatchObject({ code: "CANCELLED" });
    expect(joinedStateCompleted).toBe(false);
    expect(joinedEventError).toMatchObject({ code: "CANCELLED" });
    expect(joinedEventCompleted).toBe(false);
    expect(controlsAfterJoin).toBe(controlsBeforeJoin);
    expect(api.hardware.state.status$.snapshot).toEqual({
      status: "stale",
      active: false,
      value: "connected",
    });
  });

  test("종료 후 subscribe는 이전에 받은 State 값을 stale로 유지한다", async () => {
    const { transport, api } = await setup();

    const subscription = api.hardware.state.status$.subscribe({
      error: () => {},
    });
    const stateId = subscriptionIdFor(transport, "state:hardware/status$");
    transport.emitStream(message(stateId, { type: "subscribed", sequence: 0 }));
    transport.emitStream(
      message(stateId, { type: "batch", sequence: 1, values: ["connected"] }),
    );
    subscription.unsubscribe();

    api.dispose();

    let stateError: unknown;
    api.hardware.state.status$.subscribe({
      error: (error) => {
        stateError = error;
      },
    });
    expect(stateError).toMatchObject({ code: "CANCELLED" });
    expect(api.hardware.state.status$.snapshot).toEqual({
      status: "stale",
      active: false,
      value: "connected",
    });
  });

  test("종료 후 호출: RPC와 subscribe는 전송 없이 동기 CANCELLED다", async () => {
    const { transport, api } = await setup();

    api.dispose();

    const controlsAfterDispose = transport.controls.length;
    const invocationsAfterDispose = transport.invocations.length;

    await expect(api.hardware.rpc.connect()).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(transport.invocations).toHaveLength(invocationsAfterDispose);

    let stateError: RemoteError | undefined;
    api.hardware.state.status$.subscribe({
      error: (error) => {
        stateError = error as RemoteError;
      },
    });
    expect(stateError).toBeInstanceOf(RemoteError);
    expect(stateError).toMatchObject({ code: "CANCELLED" });
    expect(api.hardware.state.status$.snapshot).toEqual({
      status: "uninitialized",
      active: false,
    });

    let eventError: RemoteError | undefined;
    api.hardware.event.log$.subscribe({
      error: (error) => {
        eventError = error as RemoteError;
      },
    });
    expect(eventError).toMatchObject({ code: "CANCELLED" });

    expect(transport.controls).toHaveLength(controlsAfterDispose);
  });

  test("늦은 응답: dispose 뒤 도착한 RPC 응답과 스트림 메시지는 구독자에게 전달되지 않는다", async () => {
    const { transport, api } = await setup();

    const rpcPromise = api.hardware.rpc.connect();
    const invocation = transport.invocations[0]!;

    let stateNextCalled = false;
    api.hardware.state.status$.subscribe({
      next: () => {
        stateNextCalled = true;
      },
      error: () => {},
    });
    const stateId = subscriptionIdFor(transport, "state:hardware/status$");
    transport.emitStream(message(stateId, { type: "subscribed", sequence: 0 }));

    const lateListener = [...transport.streamListeners][0]!;

    api.dispose();

    transport.resolveInvocation(0, {
      protocolVersion: 1,
      clientId: "client-1",
      type: "success",
      requestId: invocation.requestId,
      result: { connected: true },
    });
    await expect(rpcPromise).rejects.toMatchObject({ code: "CANCELLED" });

    lateListener(
      message(stateId, { type: "batch", sequence: 1, values: ["late"] }),
    );
    expect(stateNextCalled).toBe(false);
  });
});
