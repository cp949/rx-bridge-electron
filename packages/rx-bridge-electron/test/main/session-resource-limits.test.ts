import { BehaviorSubject, Subject } from "rxjs";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  composeContracts,
  defineDomain,
  event,
  rpc,
  state,
  type Schema,
} from "../../src/contract/index.js";
import {
  createBridgeServer,
  implementDomain,
  type BridgeContext,
  type ResourceLimits,
  type StreamBridgeServer,
  type WireRpcRequest,
} from "../../src/main/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";
import type {
  StreamMessage,
  WireStreamCommand,
} from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

const voidSchema: Schema<undefined> = { parse: () => undefined };
const number: Schema<number> = {
  parse(value) {
    if (typeof value !== "number") throw new TypeError("number required");
    return value;
  },
};
const object: Schema<{ readonly id: string }> = {
  parse(value) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as { id?: unknown }).id !== "string"
    )
      throw new Error("id required");
    return value as { readonly id: string };
  },
};

const domain = defineDomain("resource", {
  rpc: {
    wait: rpc({ input: voidSchema, output: voidSchema }),
    echo: rpc({ input: object, output: object }),
  },
  state: {
    current$: state(number),
    other$: state(number),
    status$: state(number),
  },
  event: {
    change$: event(number, { buffer: { capacity: 1, overflow: "error" } }),
  },
});

const rpcRequest = (
  overrides: Partial<WireRpcRequest> = {},
): WireRpcRequest => ({
  protocolVersion: 1,
  clientId: "document-a",
  requestId: "request-1",
  key: "rpc:resource/wait",
  input: undefined,
  ...overrides,
});

function streamCommand(
  type: "subscribe",
  subscriptionId: string,
  clientId: string,
  key: string,
): Extract<WireStreamCommand, { type: "subscribe" }>;
function streamCommand(
  type: "unsubscribe",
  subscriptionId: string,
  clientId: string,
): Extract<WireStreamCommand, { type: "unsubscribe" }>;
function streamCommand(
  type: "subscribe" | "unsubscribe",
  subscriptionId: string,
  clientId: string,
  key?: string,
): WireStreamCommand {
  return type === "subscribe"
    ? {
        protocolVersion: 1,
        clientId,
        type,
        subscriptionId,
        key: key as string,
      }
    : { protocolVersion: 1, clientId, type, subscriptionId };
}

const messageTypes = (messages: readonly StreamMessage[]) =>
  messages.map((message) => message.type);

function setup() {
  const currentSource = new BehaviorSubject(1);
  const otherSource = new BehaviorSubject(2);
  const statusSource = new BehaviorSubject(3);
  const changeEvents = new Subject<number>();
  const controls: Array<(value: undefined) => void> = [];
  const contexts: BridgeContext[] = [];
  const waitHandler = vi.fn(
    (_input: undefined, context: BridgeContext) =>
      new Promise<undefined>((resolve) => {
        contexts.push(context);
        controls.push(resolve);
      }),
  );
  const echoHandler = vi.fn(async (input: { readonly id: string }) => input);
  const resourceLimits: Partial<ResourceLimits> = {
    maxConcurrentRpc: 2,
    maxSubscriptions: 2,
    maxRpcDurationMs: 1000,
  };
  const server: StreamBridgeServer = createBridgeServer(
    composeContracts(
      {
        payloadLimits: {
          maxDepth: 8,
          maxEntries: 100,
          maxStringBytes: 2048,
          maxTotalBytes: 1024,
        },
      },
      domain,
    ),
    [
      implementDomain(domain, {
        rpc: { wait: waitHandler, echo: echoHandler },
        state: {
          current$: currentValueSource(currentSource),
          other$: currentValueSource(otherSource),
          status$: currentValueSource(statusSource),
        },
        event: { change$: broadcastEvent(changeEvents) },
      }),
    ],
    { resourceLimits },
  );
  const targetA = new FakeTarget(1, "main");
  const targetB = new FakeTarget(2, "main");
  server.attach(targetA);
  server.attach(targetB);
  return {
    server,
    targetA,
    targetB,
    currentSource,
    otherSource,
    statusSource,
    controls,
    contexts,
    waitHandler,
    echoHandler,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("세션 자원 한도 통합", () => {
  test("한 세션의 과부하가 다른 세션을 막지 않고, 각 한도 초과가 정해진 오류와 정리 동작으로 끝난다", async () => {
    vi.useFakeTimers();
    const {
      server,
      targetA,
      currentSource,
      otherSource,
      statusSource,
      controls,
      contexts,
      waitHandler,
      echoHandler,
    } = setup();

    // A: RPC 2개 pending
    const a1 = server.dispatchRpc(
      sender(),
      rpcRequest({ requestId: "a1", clientId: "document-a" }),
    );
    const a2 = server.dispatchRpc(
      sender(),
      rpcRequest({ requestId: "a2", clientId: "document-a" }),
    );
    await vi.waitFor(() => expect(waitHandler).toHaveBeenCalledTimes(2));

    // A: 세 번째 RPC는 RESOURCE_EXHAUSTED
    await expect(
      server.dispatchRpc(
        sender(),
        rpcRequest({ requestId: "a3", clientId: "document-a" }),
      ),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    expect(waitHandler).toHaveBeenCalledTimes(2);

    // A: 구독 2개 활성
    const aSub1: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      streamCommand(
        "subscribe",
        testSubscriptionId(1),
        "document-a",
        "state:resource/current$",
      ),
      (message) => aSub1.push(message),
    );
    const aSub2: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      streamCommand(
        "subscribe",
        testSubscriptionId(2),
        "document-a",
        "state:resource/other$",
      ),
      (message) => aSub2.push(message),
    );
    expect(messageTypes(aSub1)).toEqual(["subscribed", "batch"]);
    expect(messageTypes(aSub2)).toEqual(["subscribed", "batch"]);

    // A: 세 번째 구독은 RESOURCE_EXHAUSTED
    const aSub3: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      streamCommand(
        "subscribe",
        testSubscriptionId(3),
        "document-a",
        "event:resource/change$",
      ),
      (message) => aSub3.push(message),
    );
    expect(messageTypes(aSub3)).toEqual(["subscribed", "error"]);
    expect(aSub3[1]).toMatchObject({
      error: { code: "RESOURCE_EXHAUSTED" },
    });

    // 같은 시점 B: RPC 정상 결과
    await expect(
      server.dispatchRpc(
        sender({ webContentsId: 2 }),
        rpcRequest({
          requestId: "b1",
          clientId: "document-b",
          key: "rpc:resource/echo",
          input: { id: "b-1" },
        }),
      ),
    ).resolves.toMatchObject({ type: "success", result: { id: "b-1" } });

    // 같은 시점 B: subscribe + 값 수신
    const bSub1: StreamMessage[] = [];
    await server.controlStream(
      sender({ webContentsId: 2 }),
      streamCommand(
        "subscribe",
        testSubscriptionId(1),
        "document-b",
        "state:resource/status$",
      ),
      (message) => bSub1.push(message),
    );
    expect(messageTypes(bSub1)).toEqual(["subscribed", "batch"]);
    expect(bSub1[1]).toMatchObject({ values: [3] });

    // A: 1000ms 경과 시 두 RPC가 DEADLINE_EXCEEDED
    await vi.advanceTimersByTimeAsync(1000);
    await expect(a1).resolves.toMatchObject({
      type: "error",
      error: { code: "DEADLINE_EXCEEDED" },
    });
    await expect(a2).resolves.toMatchObject({
      type: "error",
      error: { code: "DEADLINE_EXCEEDED" },
    });
    expect(contexts[0]?.signal.aborted).toBe(true);
    expect(contexts[1]?.signal.aborted).toBe(true);

    // A main-frame navigation(retire) → A consumer 정리, B 영향 없음
    targetA.endDocument();
    expect(currentSource.observed).toBe(false);
    expect(otherSource.observed).toBe(false);
    expect(statusSource.observed).toBe(true);

    // A 새 문서 세션은 RPC·구독 슬롯이 0부터 시작한다(A의 이전 handler가 아직 pending이어도)
    expect(controls).toHaveLength(2); // 이전 handler 둘 다 아직 미해결
    const a4 = server.dispatchRpc(
      sender(),
      rpcRequest({ requestId: "a4", clientId: "document-a2" }),
    );
    await vi.waitFor(() => expect(waitHandler).toHaveBeenCalledTimes(3));
    const a5: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      streamCommand(
        "subscribe",
        testSubscriptionId(1),
        "document-a2",
        "state:resource/current$",
      ),
      (message) => a5.push(message),
    );
    expect(messageTypes(a5)).toEqual(["subscribed", "batch"]);
    controls[2]?.(undefined);
    await expect(a4).resolves.toMatchObject({ type: "success" });

    // B에서 maxTotalBytes 초과 입력 → INVALID_ARGUMENT, 이후 B의 정상 RPC 계속 동작
    await expect(
      server.dispatchRpc(
        sender({ webContentsId: 2 }),
        rpcRequest({
          requestId: "b2",
          clientId: "document-b",
          key: "rpc:resource/echo",
          input: { id: "x".repeat(1200) },
        }),
      ),
    ).resolves.toMatchObject({
      type: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
    await expect(
      server.dispatchRpc(
        sender({ webContentsId: 2 }),
        rpcRequest({
          requestId: "b3",
          clientId: "document-b",
          key: "rpc:resource/echo",
          input: { id: "b-3" },
        }),
      ),
    ).resolves.toMatchObject({ type: "success", result: { id: "b-3" } });
    expect(echoHandler).toHaveBeenCalledTimes(2); // b1, b3 (b2는 handler 미호출)
  });
});
