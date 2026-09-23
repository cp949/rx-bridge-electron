import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import {
  composeContracts,
  defineDomain,
  event,
  publicManifest,
  rpc,
  state,
  type Schema,
} from "../../src/contract/index.js";
import { createBridgeServer, implementDomain } from "../../src/main/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";
import type {
  BridgeContext,
  DomainImplementation,
} from "../../src/main/index.js";
import { FakeTarget, sender } from "./fake-ipc.js";
import { testSubscriptionId } from "./subscription-ids.js";

type NumberHandler = (
  input: number,
  context: BridgeContext,
) => Promise<number> | number;
const echo: NumberHandler = async (input) => input;

const number: Schema<number> = {
  parse(value) {
    if (typeof value !== "number") throw new TypeError("number required");
    return value;
  },
};

const alpha = defineDomain("alpha", {
  rpc: { op1: rpc({ input: number, output: number, errors: [] as const }) },
  state: { current$: state(number) },
  event: { change$: event(number) },
});
const beta = defineDomain("beta", {
  rpc: { op2: rpc({ input: number, output: number, errors: [] as const }) },
});
const contract = composeContracts(alpha, beta);

function alphaSources() {
  const source = new BehaviorSubject(1);
  const events = new Subject<number>();
  return { source, events };
}

function validAlphaImplementation(handler: NumberHandler = echo) {
  const { source, events } = alphaSources();
  return implementDomain(alpha, {
    rpc: { op1: handler },
    state: { current$: currentValueSource(source) },
    event: { change$: broadcastEvent(events) },
  });
}

function validBetaImplementation(handler: NumberHandler = echo) {
  return implementDomain(beta, { rpc: { op2: handler } });
}

// Builds a raw (unvalidated) implementation object to exercise
// registerImplementations/normalizeImplementation runtime checks directly,
// bypassing the implementDomain() compile-time-shaped helper.
function rawImplementation<Name extends string>(
  domainName: Name,
  parts: {
    readonly rpc?: unknown;
    readonly state?: unknown;
    readonly event?: unknown;
  },
): DomainImplementation<Name> {
  return { domainName, ...parts } as unknown as DomainImplementation<Name>;
}

const rpcRequest = (
  key: string,
  input: number,
  clientId = "document-1",
  requestId = "request-1",
) => ({
  protocolVersion: 1 as const,
  clientId,
  requestId,
  key,
  input,
});

describe("Domain implementation registration", () => {
  test("throws when a declared domain implementation is missing", () => {
    expect(() =>
      createBridgeServer(contract, [validAlphaImplementation()]),
    ).toThrow(/Missing domain implementation 'beta'\./);
  });

  test("throws when the same domain is registered twice", () => {
    expect(() =>
      createBridgeServer(contract, [
        validAlphaImplementation(),
        validAlphaImplementation(),
        validBetaImplementation(),
      ]),
    ).toThrow(/Duplicate domain implementation 'alpha'\./);
  });

  test("throws when an implementation names a domain absent from the contract", () => {
    const gamma = defineDomain("gamma", {
      rpc: { op3: rpc({ input: number, output: number, errors: [] as const }) },
    });
    const gammaImplementation = implementDomain(gamma, {
      rpc: { op3: async (input) => input },
    });
    expect(() =>
      createBridgeServer(contract, [
        validAlphaImplementation(),
        validBetaImplementation(),
        gammaImplementation as unknown as DomainImplementation<
          "alpha" | "beta"
        >,
      ]),
    ).toThrow(/Unknown domain implementation 'gamma'\./);
  });

  test("throws when a raw implementation is missing a declared RPC handler", () => {
    const { source, events } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: {},
      state: { current$: currentValueSource(source) },
      event: { change$: broadcastEvent(events) },
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(/Missing RPC handler 'alpha\/op1'\./);
  });

  test("throws when a raw implementation declares an unknown RPC handler", () => {
    const { source, events } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: { op1: async (input: number) => input, extra: async () => 1 },
      state: { current$: currentValueSource(source) },
      event: { change$: broadcastEvent(events) },
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(/Undeclared RPC handler 'alpha\/extra'\./);
  });

  test("throws when a raw implementation is missing a declared State source", () => {
    const { events } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: { op1: async (input: number) => input },
      state: {},
      event: { change$: broadcastEvent(events) },
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(/Missing State source 'alpha\/current\$'\./);
  });

  test("throws when a raw implementation declares an unknown State source", () => {
    const { source, events } = alphaSources();
    const extraSource = currentValueSource(new BehaviorSubject(2));
    const raw = rawImplementation("alpha", {
      rpc: { op1: async (input: number) => input },
      state: { current$: currentValueSource(source), extra: extraSource },
      event: { change$: broadcastEvent(events) },
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(/Undeclared State source 'alpha\/extra'\./);
  });

  test("throws when a raw implementation is missing a declared Event source", () => {
    const { source } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: { op1: async (input: number) => input },
      state: { current$: currentValueSource(source) },
      event: {},
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(/Missing Event source 'alpha\/change\$'\./);
  });

  test("throws when a raw implementation declares an unknown Event source", () => {
    const { source, events } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: { op1: async (input: number) => input },
      state: { current$: currentValueSource(source) },
      event: { change$: broadcastEvent(events), extra: broadcastEvent(events) },
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(/Undeclared Event source 'alpha\/extra'\./);
  });

  test("throws when an RPC handler is not a function", () => {
    const { source, events } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: { op1: "not-a-function" },
      state: { current$: currentValueSource(source) },
      event: { change$: broadcastEvent(events) },
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(/RPC handler 'alpha\/op1' must be a function\./);
  });

  test("throws when a State source has no current value", () => {
    const { events } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: { op1: async (input: number) => input },
      state: { current$: new Subject<number>() },
      event: { change$: broadcastEvent(events) },
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(/State source 'alpha\/current\$' must have a current value\./);
  });

  test("throws when an Event source is not an Observable or source adapter", () => {
    const { source } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: { op1: async (input: number) => input },
      state: { current$: currentValueSource(source) },
      event: { change$: { mode: "broadcast", source: 1 } },
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(
      /Event source 'alpha\/change\$' must be an Observable or source adapter\./,
    );
  });

  test("throws the contract message when an Event source is null", () => {
    const { source } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: { op1: async (input: number) => input },
      state: { current$: currentValueSource(source) },
      event: { change$: null },
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(
      /Event source 'alpha\/change\$' must be an Observable or source adapter\./,
    );
  });

  test("throws when a same-named domain implementation declares a different operation set", () => {
    const alphaShadow = defineDomain("alpha", {
      rpc: {
        differentOp: rpc({
          input: number,
          output: number,
          errors: [] as const,
        }),
      },
    });
    const shadowImplementation = implementDomain(alphaShadow, {
      rpc: { differentOp: async (input) => input },
    });
    expect(() =>
      createBridgeServer(contract, [
        shadowImplementation,
        validBetaImplementation(),
      ]),
    ).toThrow(TypeError);
  });

  test("throws when a category value is null", () => {
    const { events } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: { op1: async (input: number) => input },
      state: null,
      event: { change$: broadcastEvent(events) },
    });
    expect(() =>
      createBridgeServer(contract, [raw, validBetaImplementation()]),
    ).toThrow(/state implementations for 'alpha' must be an object\./);
  });

  test("does not subscribe to any source when registration fails", () => {
    const { source, events } = alphaSources();
    const subscribeSpy = vi.spyOn(source, "subscribe");
    const alphaImplementation = implementDomain(alpha, {
      rpc: { op1: async (input) => input },
      state: { current$: currentValueSource(source) },
      event: { change$: broadcastEvent(events) },
    });
    expect(() => createBridgeServer(contract, [alphaImplementation])).toThrow(
      /Missing domain implementation 'beta'\./,
    );
    expect(subscribeSpy).not.toHaveBeenCalled();
  });

  test("registers every manifest operation for RPC dispatch and stream subscription", async () => {
    const server = createBridgeServer(contract, [
      validAlphaImplementation(),
      validBetaImplementation(),
    ]);
    server.attach(new FakeTarget());
    const manifest = publicManifest(contract);
    for (const key of manifest.rpc) {
      const response = await server.dispatchRpc(sender(), rpcRequest(key, 1));
      expect(response).not.toMatchObject({ error: { code: "NOT_FOUND" } });
    }
    let sequence = 0;
    for (const key of [...manifest.state, ...manifest.event]) {
      const messages: { type: string }[] = [];
      sequence += 1;
      await server.controlStream(
        sender(),
        {
          protocolVersion: 1,
          clientId: "document-1",
          type: "subscribe",
          subscriptionId: testSubscriptionId(sequence),
          key,
        },
        (message) => messages.push(message),
      );
      expect(
        messages.some(
          (message) =>
            message.type === "error" &&
            (message as { error?: { code?: string } }).error?.code ===
              "NOT_FOUND",
        ),
      ).toBe(false);
    }
  });

  test("ignores later mutation of the original implementation object", async () => {
    const original = vi.fn(async (input: number) => input);
    const replacement = vi.fn(async (input: number) => input * 2);
    const rpcRecord: Record<string, unknown> = { op1: original };
    const { source, events } = alphaSources();
    const raw = rawImplementation("alpha", {
      rpc: rpcRecord,
      state: { current$: currentValueSource(source) },
      event: { change$: broadcastEvent(events) },
    });
    const server = createBridgeServer(contract, [
      raw,
      validBetaImplementation(),
    ]);
    rpcRecord.op1 = replacement;
    server.attach(new FakeTarget());
    await server.dispatchRpc(sender(), rpcRequest("rpc:alpha/op1", 1));
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });
});
