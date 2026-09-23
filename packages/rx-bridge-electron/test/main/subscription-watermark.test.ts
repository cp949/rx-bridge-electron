import { BehaviorSubject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import type { BridgeImpl } from "../../src/contract/index.js";
import { createBridgeServer } from "../../src/main/index.js";
import { currentValueSource } from "../../src/main/sources.js";
import type { ResourceLimits } from "../../src/main/index.js";
import type { StreamMessage } from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

type AppBridge = {
  hardware: {
    state: { current$: number };
  };
};

function setup(resourceLimits?: Partial<ResourceLimits>) {
  const source = new BehaviorSubject(1);
  const subscribe = vi.spyOn(source, "subscribe");
  const impl: BridgeImpl<AppBridge> = {
    hardware: { state: { current$: currentValueSource(source) } },
  };
  const server = createBridgeServer(
    impl,
    resourceLimits === undefined ? {} : { resourceLimits },
  );
  const target = new FakeTarget();
  server.attach(target);
  return { server, source, subscribe, target };
}

const types = (messages: readonly StreamMessage[]) =>
  messages.map((message) => message.type);

describe("subscriptionId 워터마크", () => {
  test("같은 subscriptionId 재전송은 어떤 stream 메시지도 보내지 않는다", async () => {
    const { server } = setup();
    const first: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "state:hardware/current$",
      },
      (message) => first.push(message),
    );
    expect(types(first)).toEqual(["subscribed", "batch"]);
    const second: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "state:hardware/current$",
      },
      (message) => second.push(message),
    );
    expect(second).toEqual([]);
  });

  test("워터마크보다 작은 sequence의 새 ID는 무시된다", async () => {
    const { server } = setup();
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(5),
        key: "state:hardware/current$",
      },
      () => {},
    );
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(3),
        key: "state:hardware/current$",
      },
      (message) => messages.push(message),
    );
    expect(messages).toEqual([]);
  });

  test("unsubscribe 뒤 같은 ID로 재구독하면 무시된다", async () => {
    const { server } = setup();
    const id = testSubscriptionId(1);
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: id,
        key: "state:hardware/current$",
      },
      () => {},
    );
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "unsubscribe",
        subscriptionId: id,
      },
      () => {},
    );
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: id,
        key: "state:hardware/current$",
      },
      (message) => messages.push(message),
    );
    expect(messages).toEqual([]);
  });

  test("형식 오류 ID는 subscribed+error(INVALID_ARGUMENT)이고 소스 subscribe를 호출하지 않는다", async () => {
    const { server, subscribe } = setup();
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: "not-a-valid-id",
        key: "state:hardware/current$",
      },
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "error"]);
    expect(messages[1]).toMatchObject({
      error: {
        code: "INVALID_ARGUMENT",
        message: "Invalid bridge subscription ID.",
      },
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  test("한도 초과로 거부된 ID를 재전송하면 무시된다(워터마크가 먼저 갱신됨)", async () => {
    const { server } = setup({ maxSubscriptions: 1 });
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "state:hardware/current$",
      },
      () => {},
    );
    const rejectedId = testSubscriptionId(2);
    const rejected: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: rejectedId,
        key: "state:hardware/current$",
      },
      (message) => rejected.push(message),
    );
    expect(rejected[1]).toMatchObject({
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    const retried: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: rejectedId,
        key: "state:hardware/current$",
      },
      (message) => retried.push(message),
    );
    expect(retried).toEqual([]);
  });

  test("새 문서 세션에서는 워터마크가 0부터 시작한다", async () => {
    const { server, target } = setup();
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(5),
        key: "state:hardware/current$",
      },
      () => {},
    );
    target.endDocument();
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-2",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1),
        key: "state:hardware/current$",
      },
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "batch"]);
  });

  test("1,000회 subscribe/unsubscribe 반복 뒤에도 정상 동작한다", async () => {
    const { server } = setup();
    for (let sequence = 1; sequence <= 1000; sequence += 1) {
      const id = testSubscriptionId(sequence);
      await server.controlStream(
        sender(),
        {
          protocolVersion: 1,
          clientId: "client-1",
          type: "subscribe",
          subscriptionId: id,
          key: "state:hardware/current$",
        },
        () => {},
      );
      await server.controlStream(
        sender(),
        {
          protocolVersion: 1,
          clientId: "client-1",
          type: "unsubscribe",
          subscriptionId: id,
        },
        () => {},
      );
    }
    const messages: StreamMessage[] = [];
    await server.controlStream(
      sender(),
      {
        protocolVersion: 1,
        clientId: "client-1",
        type: "subscribe",
        subscriptionId: testSubscriptionId(1001),
        key: "state:hardware/current$",
      },
      (message) => messages.push(message),
    );
    expect(types(messages)).toEqual(["subscribed", "batch"]);
  });
});
