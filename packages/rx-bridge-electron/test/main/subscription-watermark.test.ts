/**
 * 세션별 subscriptionId 워터마크 규칙을 server seam에서 확인한다.
 * 같은 ID·더 낮은 ID·unsubscribe 뒤 재사용·한도 거부 뒤 재전송은 무응답이고,
 * 형식 오류 ID는 거부되며, 새 문서 세션은 워터마크를 다시 시작한다.
 */
import { BehaviorSubject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import type { BridgeImpl } from "../../src/contract/index.js";
import { createBridgeServer } from "../../src/main/index.js";
import { currentValueSource } from "../../src/main/sources.js";
import type { ResourceLimits } from "../../src/main/index.js";
import type { StreamMessage } from "../../src/protocol/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { rendererDocument } from "./renderer-document.js";

type AppBridge = {
  hardware: {
    state: { current$: number };
  };
};

const KEY = "state:hardware/current$";

/**
 * State 1개짜리 server와 attach된 target을 만든다. `subscribe` spy로 소스
 * 구독 여부를, `target`으로 문서 종료를 test가 제어한다.
 */
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

describe("subscriptionId 워터마크", () => {
  test("같은 subscriptionId 재전송은 어떤 stream 메시지도 보내지 않는다", async () => {
    const { server } = setup();
    const doc = rendererDocument(server);
    const first = await doc.subscribe(KEY);
    expect(first.types()).toEqual(["subscribed", "batch"]);
    const second = await doc.subscribe(KEY, { id: 1 });
    expect(second.frames).toEqual([]);
  });

  test("워터마크보다 작은 sequence의 새 ID는 무시된다", async () => {
    const { server } = setup();
    const doc = rendererDocument(server);
    await doc.subscribe(KEY, { id: 5 });
    const lower = await doc.subscribe(KEY, { id: 3 });
    expect(lower.frames).toEqual([]);
  });

  test("unsubscribe 뒤 같은 ID로 재구독하면 무시된다", async () => {
    const { server } = setup();
    const doc = rendererDocument(server);
    const sub = await doc.subscribe(KEY);
    await sub.unsubscribe();
    const again = await doc.subscribe(KEY, { id: 1 });
    expect(again.frames).toEqual([]);
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
        key: KEY,
      },
      (message) => messages.push(message),
    );
    expect(messages.map((message) => message.type)).toEqual([
      "subscribed",
      "error",
    ]);
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
    const doc = rendererDocument(server);
    await doc.subscribe(KEY);
    const rejected = await doc.subscribe(KEY);
    expect(rejected.frames[1]).toMatchObject({
      error: { code: "RESOURCE_EXHAUSTED" },
    });
    const retried = await doc.subscribe(KEY, { id: 2 });
    expect(retried.frames).toEqual([]);
  });

  test("새 문서 세션에서는 워터마크가 0부터 시작한다", async () => {
    const { server, target } = setup();
    await rendererDocument(server).subscribe(KEY, { id: 5 });
    target.endDocument();
    const next = await rendererDocument(server, {
      clientId: "client-2",
    }).subscribe(KEY, { id: 1 });
    expect(next.types()).toEqual(["subscribed", "batch"]);
  });

  test("1,000회 subscribe/unsubscribe 반복 뒤에도 정상 동작한다", async () => {
    const { server } = setup();
    const doc = rendererDocument(server);
    for (let sequence = 1; sequence <= 1000; sequence += 1) {
      const sub = await doc.subscribe(KEY);
      await sub.unsubscribe();
    }
    const last = await doc.subscribe(KEY);
    expect(last.types()).toEqual(["subscribed", "batch"]);
  });
});
