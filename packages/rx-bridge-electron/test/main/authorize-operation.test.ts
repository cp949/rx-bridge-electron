// `authorize` 두 번째 인자(`BridgeOperation`)의 모양을 검증한다(ADR 0018).
// RPC·state·event 세 경로 모두 등록 entry에서 만든 동결 객체를 받고, 중첩
// 도메인은 segment 배열로 온다.
import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import {
  broadcastEvent,
  createBridgeServer,
  currentValueSource,
  type Authorize,
  type BridgeOperation,
} from "../../src/main/index.js";
import type { StreamMessage } from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

/** 모든 operation을 허용하면서 받은 `BridgeOperation`을 기록하는 서버를 만든다. */
function setup() {
  const authorize = vi.fn<Authorize>(() => true);
  const server = createBridgeServer(
    {
      device: {
        rpc: { connect: () => "connected" },
        state: { connection: currentValueSource(new BehaviorSubject(1)) },
        event: { changed: broadcastEvent(new Subject<number>()) },
      },
      admin: { users: { rpc: { remove: () => "removed" } } },
    },
    { authorize },
  );
  server.attach(new FakeTarget());
  const received = (): BridgeOperation => {
    const operation = authorize.mock.calls.at(-1)?.[1];
    if (operation === undefined) throw new Error("authorize was not called");
    return operation;
  };
  return { server, received };
}

async function dispatch(
  server: ReturnType<typeof setup>["server"],
  key: string,
) {
  return server.dispatchRpc(sender(), {
    protocolVersion: 1,
    clientId: "client-1",
    requestId: "request-1",
    key,
    input: null,
  });
}

async function subscribe(
  server: ReturnType<typeof setup>["server"],
  key: string,
) {
  const messages: StreamMessage[] = [];
  await server.controlStream(
    sender(),
    {
      protocolVersion: 1,
      clientId: "client-1",
      type: "subscribe",
      subscriptionId: testSubscriptionId(1),
      key,
    },
    (message) => messages.push(message),
  );
  return messages;
}

describe("authorize가 받는 BridgeOperation", () => {
  test("RPC는 카테고리·도메인·operation으로 분해된 객체를 받는다", async () => {
    const { server, received } = setup();
    await expect(dispatch(server, "rpc:device/connect")).resolves.toMatchObject(
      { type: "success", result: "connected" },
    );
    expect(received()).toEqual({
      key: "rpc:device/connect",
      category: "rpc",
      domain: ["device"],
      operation: "connect",
    });
  });

  test("state 구독은 category state 객체를 받는다", async () => {
    const { server, received } = setup();
    const messages = await subscribe(server, "state:device/connection");
    expect(messages[0]?.type).toBe("subscribed");
    expect(received()).toEqual({
      key: "state:device/connection",
      category: "state",
      domain: ["device"],
      operation: "connection",
    });
  });

  test("event 구독은 category event 객체를 받는다", async () => {
    const { server, received } = setup();
    const messages = await subscribe(server, "event:device/changed");
    expect(messages[0]?.type).toBe("subscribed");
    expect(received()).toEqual({
      key: "event:device/changed",
      category: "event",
      domain: ["device"],
      operation: "changed",
    });
  });

  test("중첩 도메인은 segment 배열로 온다", async () => {
    const { server, received } = setup();
    await dispatch(server, "rpc:admin/users/remove");
    expect(received()).toEqual({
      key: "rpc:admin/users/remove",
      category: "rpc",
      domain: ["admin", "users"],
      operation: "remove",
    });
  });

  test("객체와 domain 배열은 동결돼 있다", async () => {
    const { server, received } = setup();
    await dispatch(server, "rpc:admin/users/remove");
    const operation = received();
    expect(operation.domain).toEqual(["admin", "users"]);
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.domain)).toBe(true);
  });
});
