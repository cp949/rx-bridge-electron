/**
 * test 전용 드라이버 `renderer-document.ts`의 규칙을 고정한다.
 * subscriptionId 발급(server 단위 증가, 명시 번호 뒤 전진), 구독별 frame
 * 기록, `ack` 기본 sequence, `unsubscribe`, `onFrame` 재진입, `begin`의 대기
 * handle을 실제 server 위에서 확인한다.
 */
import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test } from "vitest";

import {
  createBridgeServer,
  type Authorize,
  type StreamBridgeServer,
} from "../../src/main/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { rendererDocument } from "./renderer-document.js";
import { testSubscriptionId } from "./subscription-ids.js";

/**
 * State 1개·Event 1개를 가진 server와 webContents 1·2 target을 만든다.
 * `authorize`를 주면 구독 판정을 test가 제어한다.
 */
function setup(authorize?: Authorize) {
  const state = new BehaviorSubject(1);
  const events = new Subject<number>();
  const server: StreamBridgeServer = createBridgeServer(
    {
      hardware: {
        state: { current$: currentValueSource(state) },
        event: {
          change$: broadcastEvent(events, {
            buffer: { capacity: 4, overflow: "error" },
          }),
        },
      },
    },
    authorize === undefined ? {} : { authorize },
  );
  server.attach(new FakeTarget(1));
  server.attach(new FakeTarget(2));
  return { server, state, events };
}

describe("renderer-document 드라이버", () => {
  test("기본 문서는 sender()와 client-1을 쓴다", () => {
    const { server } = setup();
    const doc = rendererDocument(server);
    expect(doc.sender).toEqual(sender());
    expect(doc.clientId).toBe("client-1");
    const other = rendererDocument(server, {
      webContentsId: 2,
      clientId: "client-2",
    });
    expect(other.sender).toEqual(sender({ webContentsId: 2 }));
  });

  test("subscriptionId는 server 단위로 1부터 증가하고 문서가 달라도 이어진다", async () => {
    const { server } = setup();
    const first = await rendererDocument(server).subscribe(
      "state:hardware/current$",
    );
    const second = await rendererDocument(server, {
      webContentsId: 2,
      clientId: "client-2",
    }).subscribe("state:hardware/current$");
    expect([first.id, second.id]).toEqual([
      testSubscriptionId(1),
      testSubscriptionId(2),
    ]);
    const fresh = await rendererDocument(setup().server).subscribe(
      "state:hardware/current$",
    );
    expect(fresh.id).toBe(testSubscriptionId(1));
  });

  test("명시 번호는 그대로 쓰고 카운터를 그 뒤로 전진시킨다", async () => {
    const { server } = setup();
    const doc = rendererDocument(server);
    const explicit = await doc.subscribe("state:hardware/current$", { id: 5 });
    const again = await doc.subscribe("state:hardware/current$", { id: 5 });
    const next = await doc.subscribe("state:hardware/current$");
    expect([explicit.id, again.id, next.id]).toEqual([
      testSubscriptionId(5),
      testSubscriptionId(5),
      testSubscriptionId(6),
    ]);
    expect(again.frames).toEqual([]);
  });

  test("구독마다 받은 frame을 따로 기록한다", async () => {
    const { server, events } = setup();
    const doc = rendererDocument(server);
    const state = await doc.subscribe("state:hardware/current$");
    const event = await doc.subscribe("event:hardware/change$");
    events.next(7);
    expect(state.types()).toEqual(["subscribed", "batch"]);
    expect(event.types()).toEqual(["subscribed", "batch"]);
    expect(event.frames[1]).toMatchObject({ values: [7] });
  });

  test("ack는 sequence를 생략하면 마지막 frame의 sequence를 쓴다", async () => {
    const { server, events } = setup();
    const sub = await rendererDocument(server).subscribe(
      "event:hardware/change$",
    );
    events.next(1);
    events.next(2);
    events.next(3);
    expect(sub.types()).toEqual(["subscribed", "batch"]);
    await sub.ack(1);
    expect(sub.frames.at(-1)).toMatchObject({ sequence: 2, values: [2] });
    await sub.ack();
    expect(sub.frames.at(-1)).toMatchObject({ sequence: 3, values: [3] });
  });

  test("frame이 없으면 sequence 없는 ack는 throw한다", async () => {
    const { server } = setup(() => new Promise<boolean>(() => {}));
    const sub = rendererDocument(server).begin("state:hardware/current$");
    expect(() => sub.ack()).toThrow("ack할 frame이 없다");
  });

  test("unsubscribe 뒤에는 새 frame을 받지 않는다", async () => {
    const { server, events } = setup();
    const sub = await rendererDocument(server).subscribe(
      "event:hardware/change$",
    );
    await sub.unsubscribe();
    events.next(1);
    expect(sub.types()).toEqual(["subscribed"]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("onFrame 안의 ack는 재진입 command가 된다", async () => {
    const { server, events } = setup();
    const sub = await rendererDocument(server).subscribe(
      "event:hardware/change$",
      {
        onFrame: (frame, subscription) => {
          if (frame.type === "batch") void subscription.ack(frame.sequence);
        },
      },
    );
    events.next(1);
    events.next(2);
    expect(sub.frames.map((frame) => frame.sequence)).toEqual([0, 1, 2]);
  });

  test("onFrame이 throw하면 server의 send가 throw한 것과 같다", async () => {
    const { server } = setup();
    const sub = await rendererDocument(server).subscribe(
      "state:hardware/current$",
      {
        onFrame: (frame) => {
          if (frame.type === "batch") throw new Error("closed frame");
        },
      },
    );
    expect(sub.types()).toEqual(["subscribed", "batch"]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
  });

  test("begin은 authorize 대기 중인 handle을 즉시 돌려주고 ready가 판정 뒤 끝난다", async () => {
    let allow!: (value: boolean) => void;
    const { server } = setup(
      () =>
        new Promise<boolean>((resolve) => {
          allow = resolve;
        }),
    );
    const sub = rendererDocument(server).begin("state:hardware/current$");
    expect(sub.frames).toEqual([]);
    allow(true);
    await sub.ready;
    expect(sub.types()).toEqual(["subscribed", "batch"]);
  });
});
