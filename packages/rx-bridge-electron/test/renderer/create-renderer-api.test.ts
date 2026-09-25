import type { Observable } from "rxjs";
import { afterEach, describe, expect, expectTypeOf, test } from "vitest";

import {
  createRendererApi,
  type BridgeTransport,
  type CallOptions,
  type RendererApi,
} from "../../src/renderer/index.js";
import {
  operationKeyCases,
  type OperationKeyCase,
} from "../protocol/operation-key-cases.js";
import { FakeTransport, deferred, rpcSuccess } from "./fake-transport.js";

interface AppBridge {
  readonly hardware: {
    readonly rpc: {
      connect(input: { readonly deviceId: string }): {
        readonly connected: boolean;
      };
    };
  };
}

interface InferredBridgeShape {
  readonly hardware: {
    readonly rpc: {
      connect(input: { readonly deviceId: string }): boolean;
      disconnect(): boolean;
    };
    readonly event: {
      readonly fault: string;
    };
  };
}

/**
 * `test/protocol/operation-key-cases.ts` 공유 표에서 충돌(leaf/namespace ·
 * 중복) case만 고른다. Renderer manifest 충돌의 유일한 판정자가
 * `OperationPathTrie`임을 공개 seam에서 고정하는 test에 쓴다.
 */
function isTrieCollisionCase(caseEntry: OperationKeyCase): caseEntry is Extract<
  OperationKeyCase,
  { readonly verdict: "reject" }
> & {
  readonly reason: "leaf-namespace-collision" | "duplicate-or-collision";
} {
  return (
    caseEntry.verdict === "reject" &&
    (caseEntry.reason === "leaf-namespace-collision" ||
      caseEntry.reason === "duplicate-or-collision")
  );
}

describe("renderer handshake and API proxy", () => {
  test("adds CallOptions only to inferred RPC methods", () => {
    type Api = RendererApi<InferredBridgeShape>;

    expectTypeOf<Api["hardware"]["rpc"]["connect"]>().toEqualTypeOf<
      (
        input: { readonly deviceId: string },
        options?: CallOptions,
      ) => Promise<boolean>
    >();
    expectTypeOf<Api["hardware"]["rpc"]["disconnect"]>().toEqualTypeOf<
      (input?: undefined, options?: CallOptions) => Promise<boolean>
    >();
    expectTypeOf<Api["hardware"]["event"]["fault"]>().toEqualTypeOf<
      Observable<string>
    >();
  });

  test("waits for the handshake before exposing manifest paths", async () => {
    const transport = new FakeTransport();
    const handshake = deferred<unknown>();
    transport.handshake = handshake.promise;

    let settled = false;
    const apiPromise = createRendererApi<AppBridge>({ transport }).then(
      (api) => {
        settled = true;
        return api;
      },
    );

    await Promise.resolve();
    expect(transport.connectCalls).toBe(1);
    expect(settled).toBe(false);

    handshake.resolve({
      protocolVersion: 1,
      clientId: "client-1",
      manifest: { rpc: ["rpc:hardware/connect"], state: [], event: [] },
    });
    await expect(apiPromise).resolves.toHaveProperty("hardware.rpc.connect");
  });

  // 이름 규칙 자체는 `test/protocol/operation-key.test.ts`가 검증한다. 이름
  // 관련 2행(non-canonical entry, leaf namespace collision)은 Renderer가 코어를
  // 호출해 `INTERNAL`로 거부하는지만 본다.
  test.each([
    ["missing manifest", { protocolVersion: 1, clientId: "client-1" }],
    [
      "unsupported protocol",
      {
        protocolVersion: 2,
        clientId: "client-1",
        manifest: { rpc: [], state: [], event: [] },
      },
    ],
    [
      "unknown manifest field",
      {
        protocolVersion: 1,
        clientId: "client-1",
        manifest: { rpc: [], state: [], event: [], command: [] },
      },
    ],
    [
      "non-canonical entry",
      {
        protocolVersion: 1,
        clientId: "client-1",
        manifest: { rpc: ["hardware.connect"], state: [], event: [] },
      },
    ],
    [
      "leaf namespace collision",
      {
        protocolVersion: 1,
        clientId: "client-1",
        manifest: {
          rpc: ["rpc:hardware/status", "rpc:hardware/status/read"],
          state: [],
          event: [],
        },
      },
    ],
  ])(
    "rejects a malformed or unsupported handshake: %s",
    async (_label, value) => {
      const transport = new FakeTransport();
      transport.handshake = Promise.resolve(value);

      await expect(
        createRendererApi<AppBridge>({ transport }),
      ).rejects.toMatchObject({
        code: "INTERNAL",
      });
    },
  );

  // Renderer manifest tree(`addPath`)는 충돌을 검사하지 않고 삽입만 한다.
  // 충돌은 `OperationPathTrie` verdict가 번역된 문구(`Leaf/namespace
  // collision at '…'` · `Duplicate path or leaf/namespace collision at '…'`)로
  // 거부돼야 한다.
  test.each(operationKeyCases.filter(isTrieCollisionCase))(
    "rejects a colliding manifest with the path trie verdict: $label",
    async (caseEntry) => {
      const transport = new FakeTransport({ manifest: caseEntry.manifest });

      await expect(
        createRendererApi<AppBridge>({ transport }),
      ).rejects.toMatchObject({
        code: "INTERNAL",
        message:
          caseEntry.reason === "leaf-namespace-collision"
            ? /^Leaf\/namespace collision at '/
            : /^Duplicate path or leaf\/namespace collision at '/,
      });
    },
  );

  test.each([
    [
      "malformed",
      { protocolVersion: 1, clientId: "client-1" },
      "Malformed bridge handshake.",
    ],
    [
      "unsupported version",
      {
        protocolVersion: 2,
        clientId: "client-1",
        manifest: { rpc: [], state: [], event: [] },
      },
      "Unsupported bridge handshake.",
    ],
  ])(
    "names the handshake failure in the INTERNAL message: %s",
    async (_label, value, message) => {
      const transport = new FakeTransport();
      transport.handshake = Promise.resolve(value);

      await expect(
        createRendererApi<AppBridge>({ transport }),
      ).rejects.toMatchObject({ code: "INTERNAL", message });
    },
  );

  test("maps a handshake transport failure to a safe INTERNAL error", async () => {
    const transport = new FakeTransport();
    transport.handshake = Promise.reject(
      new Error("secret absolute path from preload"),
    );

    await expect(
      createRendererApi<AppBridge>({ transport }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "Bridge handshake failed.",
    });
  });

  test("exposes only manifest entries and dispatches their canonical RPC keys", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>({ transport });

    expect("connect" in api.hardware.rpc).toBe(true);
    expect("missing" in api.hardware.rpc).toBe(false);
    expect(
      (api.hardware.rpc as unknown as { readonly then?: unknown }).then,
    ).toBeUndefined();

    const resultPromise = api.hardware.rpc.connect({ deviceId: "demo" });
    const invocation = transport.invocations[0];
    expect(invocation).toMatchObject({
      key: "rpc:hardware/connect",
      input: { deviceId: "demo" },
    });
    transport.resolveInvocation(0, rpcSuccess(invocation!.requestId));
    await expect(resultPromise).resolves.toEqual({ connected: true });
  });

  test("groups manifest entries by category under each domain path", async () => {
    const transport = new FakeTransport({
      manifest: {
        rpc: ["rpc:hardware/connect", "rpc:hardware/serial/open"],
        state: ["state:hardware/status"],
      },
    });
    const api = await createRendererApi<{
      readonly hardware: {
        readonly rpc: { connect(): string };
        readonly state: { readonly status: string };
        readonly serial: { readonly rpc: { open(): string } };
      };
    }>({ transport });

    expect(Object.keys(api.hardware).sort()).toEqual([
      "rpc",
      "serial",
      "state",
    ]);
    expect(Object.keys(api.hardware.serial)).toEqual(["rpc"]);
    expect(
      (api.hardware as unknown as { readonly event?: unknown }).event,
    ).toBeUndefined();
    expect(
      (api.hardware as unknown as { readonly connect?: unknown }).connect,
    ).toBeUndefined();
    expect(typeof api.hardware.state.status.subscribe).toBe("function");

    void api.hardware.serial.rpc.open();
    expect(transport.invocations[0]).toMatchObject({
      key: "rpc:hardware/serial/open",
    });
  });

  test("exposes root dispose without listing it and keeps nested dispose operations", async () => {
    const transport = new FakeTransport({
      manifest: {
        rpc: ["rpc:hardware/connect", "rpc:hardware/dispose"],
      },
    });
    const api = await createRendererApi<{
      readonly hardware: { readonly rpc: { dispose(): string } };
    }>({ transport });

    expect("dispose" in api).toBe(true);
    expect(Object.keys(api)).toEqual(["hardware"]);
    expect(api.hardware.rpc.dispose).not.toBe(api.dispose);

    const resultPromise = api.hardware.rpc.dispose();
    const invocation = transport.invocations[0];
    expect(invocation).toMatchObject({ key: "rpc:hardware/dispose" });
    transport.resolveInvocation(0, {
      ...rpcSuccess(invocation!.requestId),
      result: "disposed",
    });
    await expect(resultPromise).resolves.toBe("disposed");

    expect(() => {
      api.dispose();
      api.dispose();
    }).not.toThrow();

    const invocationCountAfterDispose = transport.invocations.length;
    await expect(api.hardware.rpc.dispose()).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(transport.invocations).toHaveLength(invocationCountAfterDispose);
  });

  test("keeps CallOptions separate from the one serializable RPC input", async () => {
    const transport = new FakeTransport();
    const api = await createRendererApi<AppBridge>({ transport });
    const controller = new AbortController();

    const resultPromise = api.hardware.rpc.connect(
      { deviceId: "demo" },
      { signal: controller.signal, timeoutMs: Number.POSITIVE_INFINITY },
    );
    expect(transport.invocations[0]?.input).toEqual({ deviceId: "demo" });
    transport.resolveInvocation(
      0,
      rpcSuccess(transport.invocations[0]!.requestId),
    );
    await resultPromise;
  });
});

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

  test("passing an empty options object behaves the same as omitting transport", async () => {
    const transport = new FakeTransport();
    (globalThis as { rxBridge?: unknown }).rxBridge = transport;

    const api = await createRendererApi<AppBridge>({});

    expect(transport.connectCalls).toBe(1);
    expect(typeof api.hardware.rpc.connect).toBe("function");
  });

  test("an explicit transport takes priority over globalThis.rxBridge", async () => {
    const globalTransport = new FakeTransport();
    const explicitTransport = new FakeTransport();
    (globalThis as { rxBridge?: unknown }).rxBridge = globalTransport;

    await createRendererApi<AppBridge>({ transport: explicitTransport });

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
    expectTypeOf(createRendererApi<AppBridge>).toBeCallableWith({ transport });
    expectTypeOf(createRendererApi<AppBridge>).returns.toEqualTypeOf<
      Promise<RendererApi<AppBridge>>
    >();
  });
});

test("public runtime export surface is sealed to createRendererApi, createOpaqueId, RemoteError", async () => {
  const publicModule = await import("../../src/renderer/index.js");

  expect(Object.keys(publicModule).sort()).toEqual([
    "RemoteError",
    "createOpaqueId",
    "createRendererApi",
  ]);
});

describe("Renderer API object tree", () => {
  interface TreeBridge {
    readonly hardware: {
      readonly rpc: { connect(): string };
      readonly state: { readonly status: string };
      readonly event: { readonly change: number };
      readonly serial: { readonly rpc: { open(): string } };
    };
  }

  async function treeApi(): Promise<{
    readonly api: RendererApi<TreeBridge>;
    readonly transport: FakeTransport;
  }> {
    const transport = new FakeTransport({
      manifest: {
        rpc: ["rpc:hardware/connect", "rpc:hardware/serial/open"],
        state: ["state:hardware/status"],
        event: ["event:hardware/change"],
      },
    });
    return {
      api: await createRendererApi<TreeBridge>({ transport }),
      transport,
    };
  }

  test("returns the same reference for every access to the same path", async () => {
    const { api } = await treeApi();

    expect(api.hardware).toBe(api.hardware);
    expect(api.hardware.rpc).toBe(api.hardware.rpc);
    expect(api.hardware.rpc.connect).toBe(api.hardware.rpc.connect);
    expect(api.hardware.state.status).toBe(api.hardware.state.status);
    expect(api.hardware.event.change).toBe(api.hardware.event.change);
    expect(api.hardware.serial.rpc.open).toBe(api.hardware.serial.rpc.open);
  });

  test("is not thenable, so awaiting it resolves to the API itself", async () => {
    const { api } = await treeApi();

    expect(await Promise.resolve(api)).toBe(api);
    expect(await Promise.resolve(api.hardware)).toBe(api.hardware);
  });

  test("rejects assignment and deletion without changing any path", async () => {
    const { api } = await treeApi();
    const connect = api.hardware.rpc.connect;
    const writable = api as unknown as Record<string, unknown>;
    const rpc = api.hardware.rpc as unknown as Record<string, unknown>;

    expect(() => {
      writable.hardware = {};
    }).toThrow(TypeError);
    expect(() => {
      writable.extra = 1;
    }).toThrow(TypeError);
    expect(() => {
      delete rpc.connect;
    }).toThrow(TypeError);
    expect(() => {
      writable.dispose = () => {};
    }).toThrow(TypeError);
    expect(api.hardware.rpc.connect).toBe(connect);
    expect(writable.extra).toBeUndefined();
  });

  test("answers undefined for undeclared paths and Object.prototype members", async () => {
    const { api } = await treeApi();
    const loose = api.hardware as unknown as Record<string, unknown>;

    expect(loose.missing).toBeUndefined();
    expect(loose.toString).toBeUndefined();
    expect(loose.hasOwnProperty).toBeUndefined();
    expect((api as unknown as Record<string, unknown>).then).toBeUndefined();
  });

  test("freezes every node on a null prototype", async () => {
    const { api } = await treeApi();

    for (const node of [
      api,
      api.hardware,
      api.hardware.rpc,
      api.hardware.state,
      api.hardware.event,
      api.hardware.serial,
      api.hardware.serial.rpc,
    ]) {
      expect(Object.isFrozen(node)).toBe(true);
      expect(Object.getPrototypeOf(node)).toBeNull();
    }
  });

  test("reports Symbol.dispose through the in operator", async () => {
    const { api } = await treeApi();

    expect(Symbol.dispose in api).toBe(true);
    expect(Symbol.dispose in api.hardware).toBe(false);
  });

  test("describes each path with a data descriptor holding its value", async () => {
    const { api } = await treeApi();

    expect(
      Object.getOwnPropertyDescriptor(api.hardware.rpc, "connect"),
    ).toEqual({
      value: api.hardware.rpc.connect,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    expect(Object.getOwnPropertyDescriptor(api, "dispose")).toEqual({
      value: api.dispose,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(
      Object.getOwnPropertyDescriptor(api.hardware, "missing"),
    ).toBeUndefined();
  });
});
