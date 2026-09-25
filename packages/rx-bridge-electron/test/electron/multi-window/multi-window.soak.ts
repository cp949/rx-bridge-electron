import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  bundleMultiWindowFixture,
  launch,
  windowFor,
  type ElectronApp,
} from "./harness.js";

const SUBSCRIBE_CYCLES = 1000;
const RELOADS = 50;
const RPC_ROUNDS = 20;
const RPC_BURST = 64;

describe("Electron multi-window soak", () => {
  let app: ElectronApp;

  beforeAll(async () => {
    app = await launch(await bundleMultiWindowFixture());
  });

  afterAll(async () => {
    await app.close();
  });

  test("returns Main resources to baseline after repeated subscribe, reload, and RPC bursts", async () => {
    const timings: Record<string, number> = {};
    const timed = async (name: string, run: () => Promise<void>) => {
      const started = performance.now();
      await run();
      timings[name] = Math.round(performance.now() - started);
    };
    const snapshot = () =>
      app.evaluate(() => globalThis.__rxBridgeProbe.snapshot());
    let editor = await windowFor(app, "editor");
    const viewer = await windowFor(app, "viewer");

    await timed("subscribe", async () => {
      await Promise.all(
        [editor, viewer].map((page) =>
          page.evaluate(async (cycles) => {
            const renderer = globalThis.fixtureRenderer;
            for (let index = 0; index < cycles; index += 1) {
              await renderer.subscribe("status", "state", "status");
              await renderer.subscribe("notice", "event", "notice");
              renderer.unsubscribe("status");
              renderer.unsubscribe("notice");
              if (index % 50 === 0)
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
          }, SUBSCRIBE_CYCLES),
        ),
      );
      await expect.poll(snapshot).toMatchObject({ subscriptions: 0 });
    });

    await timed("reload", async () => {
      await viewer.evaluate(() =>
        globalThis.fixtureRenderer.subscribe("notice", "event", "notice"),
      );
      for (let index = 0; index < RELOADS; index += 1) {
        await editor.evaluate(async () => {
          await globalThis.fixtureRenderer.subscribe(
            "status",
            "state",
            "status",
          );
          await globalThis.fixtureRenderer.subscribe(
            "notice",
            "event",
            "notice",
          );
          await globalThis.fixtureRenderer.startCalls("held", "hold", 2);
        });
        await expect
          .poll(() => app.evaluate(() => globalThis.__rxBridgeProbe.holds()))
          .toBe(2);
        await editor.reload();
        editor = await windowFor(app, "editor");
        await app.evaluate(
          (_electron, value) =>
            globalThis.__rxBridgeProbe.emit("notice", [value]),
          `reload-${index}`,
        );
      }
      await expect
        .poll(() =>
          viewer.evaluate(
            () => globalThis.fixtureRenderer.received("notice").values.length,
          ),
        )
        .toBe(RELOADS);
      await viewer.evaluate(() =>
        globalThis.fixtureRenderer.unsubscribe("notice"),
      );
      await expect
        .poll(snapshot)
        .toMatchObject({ sessions: 2, rpcInFlight: 0, subscriptions: 0 });
    });

    await timed("rpc", async () => {
      for (let round = 0; round < RPC_ROUNDS; round += 1) {
        const tag = `burst-${round}`;
        await editor.evaluate(
          ([name, count]) =>
            globalThis.fixtureRenderer.startCalls(name, "hold", count),
          [tag, RPC_BURST] as const,
        );
        await expect
          .poll(() => app.evaluate(() => globalThis.__rxBridgeProbe.holds()))
          .toBe(RPC_BURST);
        await expect(
          viewer.evaluate(() => globalThis.fixtureRenderer.call("ping", "x")),
        ).resolves.toEqual({ ok: true, value: "pong:x" });
        await app.evaluate(() => globalThis.__rxBridgeProbe.releaseHolds());
        await expect
          .poll(() =>
            editor.evaluate(
              (name) =>
                globalThis.fixtureRenderer
                  .callResults(name)
                  .filter((result) => result.ok).length,
              tag,
            ),
          )
          .toBe(RPC_BURST);
      }
    });

    await expect.poll(snapshot).toEqual({
      sessions: 2,
      rpcInFlight: 0,
      subscriptions: 0,
      queuedEvents: 0,
    });
    const upstream = await app.evaluate(() =>
      globalThis.__rxBridgeProbe.upstream(),
    );
    for (const counts of Object.values(upstream)) {
      expect(counts.unsubscribe).toBe(counts.subscribe);
    }
    const counts = await app.evaluate(() => {
      const tally: Record<string, number> = {};
      for (const event of globalThis.__rxBridgeProbe.diagnostics())
        tally[event.type] = (tally[event.type] ?? 0) + 1;
      return tally;
    });
    expect(counts["session-opened"]! - (counts["session-closed"] ?? 0)).toBe(2);
    expect(counts["subscription-opened"]).toBe(counts["subscription-closed"]);

    console.info(
      JSON.stringify({
        cycles: {
          subscribe: SUBSCRIBE_CYCLES,
          reloads: RELOADS,
          rpcRounds: RPC_ROUNDS,
          rpcBurst: RPC_BURST,
        },
        timingsMs: timings,
        upstream,
        diagnostics: counts,
      }),
    );
  });
});
