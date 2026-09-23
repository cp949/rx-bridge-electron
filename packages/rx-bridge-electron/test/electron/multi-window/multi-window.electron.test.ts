import type { Page } from "@playwright/test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  bundleMultiWindowFixture,
  launch,
  windowFor,
  type ElectronApp,
} from "./harness.js";

describe("Electron multi-window bridge", () => {
  let fixture: ReturnType<typeof bundleMultiWindowFixture>;
  let app: ElectronApp | undefined;

  beforeAll(() => {
    fixture = bundleMultiWindowFixture();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  test("gives each attached window its own session", async () => {
    app = await launch(fixture);
    const editor = await windowFor(app, "editor");
    const viewer = await windowFor(app, "viewer");

    await expect(
      editor.evaluate(() => globalThis.fixtureRenderer.call("ping", "e")),
    ).resolves.toEqual({ ok: true, value: "pong:e" });
    await expect(
      viewer.evaluate(() => globalThis.fixtureRenderer.call("ping", "v")),
    ).resolves.toEqual({ ok: true, value: "pong:v" });
    await expect(
      app.evaluate(() => globalThis.__rxBridgeProbe.snapshot()),
    ).resolves.toMatchObject({ sessions: 2, rpcInFlight: 0 });
    const opened = await app.evaluate(
      () =>
        globalThis.__rxBridgeProbe
          .diagnostics()
          .filter((event) => event.type === "session-opened").length,
    );
    expect(opened).toBe(2);
  });

  test("denies role-restricted RPC only in the viewer window", async () => {
    app = await launch(fixture);
    const editor = await windowFor(app, "editor");
    const viewer = await windowFor(app, "viewer");

    await expect(
      viewer.evaluate(() => globalThis.fixtureRenderer.call("secure", "v")),
    ).resolves.toEqual({ ok: false, code: "FORBIDDEN" });
    await expect(
      editor.evaluate(() => globalThis.fixtureRenderer.call("secure", "e")),
    ).resolves.toEqual({ ok: true, value: "secure:e" });
    await expect(
      viewer.evaluate(() => globalThis.fixtureRenderer.call("ping", "v")),
    ).resolves.toEqual({ ok: true, value: "pong:v" });
    await viewer.evaluate(() =>
      globalThis.fixtureRenderer.subscribe("status", "state", "status"),
    );
    await expect
      .poll(() =>
        viewer.evaluate(() => globalThis.fixtureRenderer.received("status")),
      )
      .toEqual({ values: ["ready"] });

    const denied = await app.evaluate(() =>
      globalThis.__rxBridgeProbe
        .diagnostics()
        .filter(
          (event) =>
            event.type === "rejected" && event.reason === "authorize-denied",
        ),
    );
    expect(denied).toEqual([
      { type: "rejected", reason: "authorize-denied", key: "rpc:lab/secure" },
    ]);
  });

  test("shares one upstream subscription across windows until the last consumer leaves", async () => {
    app = await launch(fixture);
    const editor = await windowFor(app, "editor");
    const viewer = await windowFor(app, "viewer");

    for (const page of [editor, viewer]) {
      await page.evaluate(async () => {
        await globalThis.fixtureRenderer.subscribe("status", "state", "status");
        await globalThis.fixtureRenderer.subscribe("notice", "event", "notice");
      });
    }
    await expect
      .poll(() => app!.evaluate(() => globalThis.__rxBridgeProbe.snapshot()))
      .toMatchObject({ subscriptions: 4 });
    await app.evaluate(() => {
      globalThis.__rxBridgeProbe.setStatus("busy");
      globalThis.__rxBridgeProbe.emit("notice", ["n1", "n2"]);
    });
    for (const page of [editor, viewer]) {
      await expect
        .poll(() =>
          page.evaluate(() => [
            globalThis.fixtureRenderer.received("status"),
            globalThis.fixtureRenderer.received("notice"),
          ]),
        )
        .toEqual([{ values: ["ready", "busy"] }, { values: ["n1", "n2"] }]);
    }
    const upstream = () =>
      app!.evaluate(() => {
        const counts = globalThis.__rxBridgeProbe.upstream();
        return { status: counts.status, notice: counts.notice };
      });
    await expect(upstream()).resolves.toEqual({
      status: { subscribe: 1, unsubscribe: 0 },
      notice: { subscribe: 1, unsubscribe: 0 },
    });

    await editor.evaluate(() => {
      globalThis.fixtureRenderer.unsubscribe("status");
      globalThis.fixtureRenderer.unsubscribe("notice");
    });
    await expect
      .poll(() => app!.evaluate(() => globalThis.__rxBridgeProbe.snapshot()))
      .toMatchObject({ subscriptions: 2 });
    await expect(upstream()).resolves.toEqual({
      status: { subscribe: 1, unsubscribe: 0 },
      notice: { subscribe: 1, unsubscribe: 0 },
    });

    await viewer.evaluate(() => {
      globalThis.fixtureRenderer.unsubscribe("status");
      globalThis.fixtureRenderer.unsubscribe("notice");
    });
    await expect.poll(upstream).toEqual({
      status: { subscribe: 1, unsubscribe: 1 },
      notice: { subscribe: 1, unsubscribe: 1 },
    });
    await expect(
      app.evaluate(() => globalThis.__rxBridgeProbe.snapshot()),
    ).resolves.toMatchObject({ subscriptions: 0, queuedEvents: 0 });
  });

  test("ends only the slow consumer's subscription on error overflow", async () => {
    app = await launch(fixture);
    const editor = await windowFor(app, "editor");
    const viewer = await windowFor(app, "viewer");

    await editor.evaluate(() =>
      globalThis.fixtureRenderer.subscribe("strict", "event", "strict"),
    );
    await viewer.evaluate(async () => {
      await globalThis.fixtureRenderer.subscribe("status", "state", "status");
      await globalThis.fixtureRenderer.rawSubscribe("slow", "event:lab/strict");
    });
    await expect
      .poll(() =>
        viewer.evaluate(() => globalThis.fixtureRenderer.rawReceived("slow")),
      )
      .toMatchObject({ subscribed: true });
    await expect
      .poll(() => app!.evaluate(() => globalThis.__rxBridgeProbe.snapshot()))
      .toMatchObject({ subscriptions: 3 });

    const sent = await emitPaced(app, editor, "strict", 10);

    // overflow 뒤 느린 소비자의 source는 분리되지만, 종료 통지는 대기 값을 ack 순서대로 전달한 뒤에 간다.
    await expect(
      viewer.evaluate(() => globalThis.fixtureRenderer.rawReceived("slow")),
    ).resolves.toEqual({ subscribed: true, values: ["strict-0"] });
    await expect(
      editor.evaluate(() => globalThis.fixtureRenderer.received("strict")),
    ).resolves.toEqual({ values: sent });
    await expect(
      app.evaluate(() => globalThis.__rxBridgeProbe.snapshot()),
    ).resolves.toMatchObject({ subscriptions: 3 });
    await expect(
      app.evaluate(() => globalThis.__rxBridgeProbe.upstream().strict),
    ).resolves.toEqual({ subscribe: 1, unsubscribe: 0 });

    await expect
      .poll(async () => {
        await viewer.evaluate(() => globalThis.fixtureRenderer.rawAck("slow"));
        return viewer.evaluate(() =>
          globalThis.fixtureRenderer.rawReceived("slow"),
        );
      })
      .toEqual({
        subscribed: true,
        values: ["strict-0", "strict-1", "strict-2", "strict-3", "strict-4"],
        error: "STREAM_OVERFLOW",
      });
    await app.evaluate(() => globalThis.__rxBridgeProbe.setStatus("after"));
    await expect
      .poll(() =>
        viewer.evaluate(() => globalThis.fixtureRenderer.received("status")),
      )
      .toEqual({ values: ["ready", "after"] });
    await expect(
      app.evaluate(() => globalThis.__rxBridgeProbe.snapshot()),
    ).resolves.toMatchObject({ subscriptions: 2 });
  });

  test("keeps the slow consumer subscribed and records drops on drop-oldest overflow", async () => {
    app = await launch(fixture);
    const editor = await windowFor(app, "editor");
    const viewer = await windowFor(app, "viewer");

    await editor.evaluate(() =>
      globalThis.fixtureRenderer.subscribe("lossy", "event", "lossy"),
    );
    await viewer.evaluate(() =>
      globalThis.fixtureRenderer.rawSubscribe("slow", "event:lab/lossy"),
    );
    await expect
      .poll(() =>
        viewer.evaluate(() => globalThis.fixtureRenderer.rawReceived("slow")),
      )
      .toMatchObject({ subscribed: true });

    const sent = await emitPaced(app, editor, "lossy", 10);

    await expect(
      editor.evaluate(() => globalThis.fixtureRenderer.received("lossy")),
    ).resolves.toEqual({ values: sent });
    const dropped = await app.evaluate(() =>
      globalThis.__rxBridgeProbe
        .diagnostics()
        .filter((event) => event.type === "stream-dropped")
        .reduce((total, event) => total + event.count, 0),
    );
    expect(dropped).toBe(5);

    // ack를 재개하면 남아 있던 최신 값 4개가 순서대로 도착한다.
    await expect
      .poll(async () => {
        await viewer.evaluate(() => globalThis.fixtureRenderer.rawAck("slow"));
        return viewer.evaluate(() =>
          globalThis.fixtureRenderer.rawReceived("slow"),
        );
      })
      .toEqual({
        subscribed: true,
        values: ["lossy-0", "lossy-6", "lossy-7", "lossy-8", "lossy-9"],
      });
    await expect(
      app.evaluate(() => globalThis.__rxBridgeProbe.snapshot()),
    ).resolves.toMatchObject({ subscriptions: 2 });
  });

  test("isolates a session at its RPC limit from the other window", async () => {
    app = await launch(fixture);
    const editor = await windowFor(app, "editor");
    const viewer = await windowFor(app, "viewer");

    await editor.evaluate(() =>
      globalThis.fixtureRenderer.startCalls("held", "hold", 64),
    );
    await expect
      .poll(() => app!.evaluate(() => globalThis.__rxBridgeProbe.holds()))
      .toBe(64);
    await expect(
      app.evaluate(() => globalThis.__rxBridgeProbe.snapshot()),
    ).resolves.toMatchObject({ rpcInFlight: 64 });

    await expect(
      editor.evaluate(() => globalThis.fixtureRenderer.call("ping", "over")),
    ).resolves.toEqual({ ok: false, code: "RESOURCE_EXHAUSTED" });
    await expect(
      viewer.evaluate(() => globalThis.fixtureRenderer.call("ping", "free")),
    ).resolves.toEqual({ ok: true, value: "pong:free" });

    await app.evaluate(() => globalThis.__rxBridgeProbe.releaseHolds());
    await expect
      .poll(() =>
        editor.evaluate(
          () =>
            globalThis.fixtureRenderer
              .callResults("held")
              .filter((result) => result.ok).length,
        ),
      )
      .toBe(64);
    await expect(
      app.evaluate(() => globalThis.__rxBridgeProbe.snapshot()),
    ).resolves.toMatchObject({ rpcInFlight: 0 });
    const limited = await app.evaluate(
      () =>
        globalThis.__rxBridgeProbe
          .diagnostics()
          .filter(
            (event) =>
              event.type === "rejected" && event.reason === "rpc-limit",
          ).length,
    );
    expect(limited).toBe(1);
  });

  test("cleans up the reloaded window's session while the other window keeps streaming", async () => {
    app = await launch(fixture);
    const editor = await windowFor(app, "editor");
    const viewer = await windowFor(app, "viewer");

    for (const page of [editor, viewer]) {
      await page.evaluate(async () => {
        await globalThis.fixtureRenderer.subscribe("status", "state", "status");
        await globalThis.fixtureRenderer.subscribe("notice", "event", "notice");
      });
    }
    await editor.evaluate(() =>
      globalThis.fixtureRenderer.startCalls("held", "hold", 3),
    );
    await expect
      .poll(() => app!.evaluate(() => globalThis.__rxBridgeProbe.snapshot()))
      .toMatchObject({ sessions: 2, rpcInFlight: 3, subscriptions: 4 });

    await editor.reload();
    const reloaded = await windowFor(app, "editor");

    await expect
      .poll(() => app!.evaluate(() => globalThis.__rxBridgeProbe.snapshot()))
      .toMatchObject({ sessions: 2, rpcInFlight: 0, subscriptions: 2 });
    const diagnostics = await app.evaluate(() =>
      globalThis.__rxBridgeProbe.diagnostics(),
    );
    expect(
      diagnostics.filter((event) => event.type === "rpc-cancelled"),
    ).toHaveLength(3);
    expect(
      diagnostics.filter((event) => event.type === "subscription-closed"),
    ).toHaveLength(2);
    await expect(
      app.evaluate(() => {
        const counts = globalThis.__rxBridgeProbe.upstream();
        return { status: counts.status, notice: counts.notice };
      }),
    ).resolves.toEqual({
      status: { subscribe: 1, unsubscribe: 0 },
      notice: { subscribe: 1, unsubscribe: 0 },
    });

    await app.evaluate(() => {
      globalThis.__rxBridgeProbe.setStatus("after-reload");
      globalThis.__rxBridgeProbe.emit("notice", ["after-reload"]);
    });
    await expect
      .poll(() =>
        viewer.evaluate(() => [
          globalThis.fixtureRenderer.received("status").values.at(-1),
          globalThis.fixtureRenderer.received("notice").values,
        ]),
      )
      .toEqual(["after-reload", ["after-reload"]]);
    await expect(
      reloaded.evaluate(() => globalThis.fixtureRenderer.call("ping", "new")),
    ).resolves.toEqual({ ok: true, value: "pong:new" });

    await viewer.evaluate(() => {
      globalThis.fixtureRenderer.unsubscribe("status");
      globalThis.fixtureRenderer.unsubscribe("notice");
    });
    await expect
      .poll(() =>
        app!.evaluate(() => {
          const counts = globalThis.__rxBridgeProbe.upstream();
          return [counts.status.unsubscribe, counts.notice.unsubscribe];
        }),
      )
      .toEqual([1, 1]);
  });
});

/**
 * 정상 소비자(editor)가 매 값을 받은 뒤 다음 값을 보낸다.
 * 한 번에 몰아 보내면 정상 소비자의 큐도 넘치므로 느린 소비자만 밀리게 한다.
 */
async function emitPaced(
  app: ElectronApp,
  consumer: Page,
  name: "strict" | "lossy",
  count: number,
): Promise<string[]> {
  const sent: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = `${name}-${index}`;
    sent.push(value);
    await app.evaluate(
      (_electron, [target, next]) =>
        globalThis.__rxBridgeProbe.emit(target, [next]),
      [name, value] as const,
    );
    await expect
      .poll(() =>
        consumer.evaluate(
          (tag) => globalThis.fixtureRenderer.received(tag).values.length,
          name,
        ),
      )
      .toBe(sent.length);
  }
  return sent;
}
