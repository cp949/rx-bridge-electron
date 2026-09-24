import { afterEach, describe, expect, expectTypeOf, test } from "vitest";

import {
  createRendererApi,
  type BridgeTransport,
  type RendererApi,
} from "../../src/renderer/index.js";
import { FakeTransport } from "./fake-transport.js";

interface AppBridge {
  readonly hardware: {
    readonly rpc: {
      connect(): { readonly connected: boolean };
    };
  };
}

/**
 * RD-014 배선 축약(ADR 0013): `createRendererApi`의 `transport` 생략 시
 * `globalThis.rxBridge` 사용 경로와 그 부재 시 에러 경로.
 */
describe("createRendererApi transport default (RD-014)", () => {
  afterEach(() => {
    delete (globalThis as { rxBridge?: unknown }).rxBridge;
  });

  test("omitting transport uses globalThis.rxBridge", async () => {
    const transport = new FakeTransport();
    (globalThis as { rxBridge?: unknown }).rxBridge = transport;

    const api = await createRendererApi<AppBridge>();

    expect(transport.connectCalls).toBe(1);
    expect(typeof api.hardware.rpc.connect).toBe("function");
  });

  test("passing undefined explicitly behaves the same as omitting transport", async () => {
    const transport = new FakeTransport();
    (globalThis as { rxBridge?: unknown }).rxBridge = transport;

    const api = await createRendererApi<AppBridge>(undefined);

    expect(transport.connectCalls).toBe(1);
    expect(typeof api.hardware.rpc.connect).toBe("function");
  });

  test("an explicit transport takes priority over globalThis.rxBridge", async () => {
    const globalTransport = new FakeTransport();
    const explicitTransport = new FakeTransport();
    (globalThis as { rxBridge?: unknown }).rxBridge = globalTransport;

    await createRendererApi<AppBridge>(explicitTransport);

    expect(explicitTransport.connectCalls).toBe(1);
    expect(globalTransport.connectCalls).toBe(0);
  });

  test("missing globalThis.rxBridge throws a clear error naming rxBridge and exposeBridgeInMainWorld", async () => {
    await expect(createRendererApi<AppBridge>()).rejects.toThrow(/rxBridge/);
    await expect(createRendererApi<AppBridge>()).rejects.toThrow(
      /exposeBridgeInMainWorld/,
    );
  });

  test("a malformed globalThis.rxBridge (not a transport shape) throws the same clear error", async () => {
    (globalThis as { rxBridge?: unknown }).rxBridge = { connect: "nope" };

    await expect(createRendererApi<AppBridge>()).rejects.toThrow(/rxBridge/);
  });

  test("createRendererApi<B>() compiles without a transport argument and returns the same type as the explicit call", () => {
    const transport = {} as BridgeTransport;

    expectTypeOf(createRendererApi<AppBridge>).toBeCallableWith();
    expectTypeOf(createRendererApi<AppBridge>).toBeCallableWith(transport);
    expectTypeOf(createRendererApi<AppBridge>).returns.toEqualTypeOf<
      Promise<RendererApi<AppBridge>>
    >();
  });
});
