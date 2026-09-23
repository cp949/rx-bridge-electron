import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import {
  composeContracts,
  defineDomain,
  event,
  rpc,
  state,
  type Schema,
} from "../../src/contract/index.js";
import { createBridgeServer, implementDomain } from "../../src/main/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";
import {
  DEFAULT_RESOURCE_LIMITS,
  resolveResourceLimits,
} from "../../src/main/resource-limits.js";

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
const contract = composeContracts(alpha);

function alphaSources() {
  const source = new BehaviorSubject(1);
  const events = new Subject<number>();
  return { source, events };
}

function validAlphaImplementation(
  source: BehaviorSubject<number>,
  events: Subject<number>,
) {
  return implementDomain(alpha, {
    rpc: { op1: async (input: number) => input },
    state: { current$: currentValueSource(source) },
    event: { change$: broadcastEvent(events) },
  });
}

describe("resolveResourceLimits", () => {
  test("returns defaults when no options given", () => {
    expect(resolveResourceLimits(undefined)).toEqual(DEFAULT_RESOURCE_LIMITS);
  });

  test("keeps defaults for fields not specified", () => {
    expect(resolveResourceLimits({ maxConcurrentRpc: 2 })).toEqual({
      ...DEFAULT_RESOURCE_LIMITS,
      maxConcurrentRpc: 2,
    });
  });

  test("allows maxRpcDurationMs: Infinity", () => {
    expect(
      resolveResourceLimits({ maxRpcDurationMs: Number.POSITIVE_INFINITY }),
    ).toEqual({
      ...DEFAULT_RESOURCE_LIMITS,
      maxRpcDurationMs: Number.POSITIVE_INFINITY,
    });
  });

  test("allows maxRpcDurationMs up to the setTimeout maximum", () => {
    expect(
      resolveResourceLimits({ maxRpcDurationMs: 2_147_483_647 })
        .maxRpcDurationMs,
    ).toBe(2_147_483_647);
  });

  test.each([
    ["maxConcurrentRpc", 0],
    ["maxConcurrentRpc", -1],
    ["maxConcurrentRpc", 1.5],
    ["maxConcurrentRpc", NaN],
    ["maxConcurrentRpc", "8"],
    ["maxConcurrentRpc", Number.POSITIVE_INFINITY],
    ["maxSubscriptions", 0],
    ["maxSubscriptions", -1],
    ["maxSubscriptions", 1.5],
    ["maxSubscriptions", NaN],
    ["maxSubscriptions", "8"],
    ["maxRpcDurationMs", 0],
    ["maxRpcDurationMs", -1],
    ["maxRpcDurationMs", 1.5],
    ["maxRpcDurationMs", NaN],
    ["maxRpcDurationMs", "8"],
    ["maxRpcDurationMs", 2_147_483_648],
    ["maxRetiredClientsPerWebContents", 0],
    ["maxRetiredClientsPerWebContents", -1],
    ["maxRetiredClientsPerWebContents", 1.5],
    ["maxRetiredClientsPerWebContents", NaN],
    ["maxRetiredClientsPerWebContents", "8"],
    ["maxRetiredClientsPerWebContents", Number.POSITIVE_INFINITY],
  ])("throws TypeError for %s = %p", (key, value) => {
    expect(() => resolveResourceLimits({ [key]: value } as never)).toThrow(
      TypeError,
    );
  });

  test("throws TypeError for unknown key", () => {
    expect(() => resolveResourceLimits({ maxWidgets: 1 } as never)).toThrow(
      /Unknown resource limit 'maxWidgets'\./,
    );
  });
});

describe("createBridgeServer resourceLimits option", () => {
  test("throws TypeError for invalid resourceLimits without side effects", () => {
    const { source, events } = alphaSources();
    const subscribeSpy = vi.spyOn(source, "subscribe");
    const alphaImplementation = validAlphaImplementation(source, events);
    expect(() =>
      createBridgeServer(contract, [alphaImplementation], {
        resourceLimits: { maxSubscriptions: 0 },
      }),
    ).toThrow(TypeError);
    expect(subscribeSpy).not.toHaveBeenCalled();
  });
});
