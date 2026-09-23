import type { DomainContract } from "../contract/index.js";
import type { BridgeValue } from "../protocol/index.js";
import { Observable } from "rxjs";
import type { CurrentValueSource, EventSource } from "./sources.js";
import type { BridgeContext, DomainImplementation } from "./types.js";

export function implementDomain(
  domain: DomainContract,
  handlers: {
    readonly rpc?: Readonly<
      Record<
        string,
        (
          input: BridgeValue,
          context: BridgeContext,
        ) => Promise<BridgeValue> | BridgeValue
      >
    >;
    readonly state?: Readonly<Record<string, CurrentValueSource<BridgeValue>>>;
    readonly event?: Readonly<Record<string, EventSource>>;
  },
): DomainImplementation {
  const declared = domain.definitions.rpc ?? {};
  const rpc: Record<
    string,
    (
      input: BridgeValue,
      context: BridgeContext,
    ) => Promise<BridgeValue> | BridgeValue
  > = Object.create(null);
  for (const key of Object.keys(handlers.rpc ?? {})) {
    if (!Object.hasOwn(declared, key))
      throw new TypeError(`Undeclared RPC handler '${domain.name}/${key}'.`);
    const handler = handlers.rpc?.[key];
    if (handler !== undefined) rpc[key] = handler;
  }
  for (const key of Object.keys(declared))
    if (!Object.hasOwn(rpc, key))
      throw new TypeError(`Missing RPC handler '${domain.name}/${key}'.`);
  const state: Record<string, CurrentValueSource<BridgeValue>> = Object.create(
    null,
  );
  const event: Record<string, EventSource> = Object.create(null);
  for (const key of Object.keys(handlers.state ?? {})) {
    if (!Object.hasOwn(domain.definitions.state ?? {}, key))
      throw new TypeError(`Undeclared State source '${domain.name}/${key}'.`);
    const source = handlers.state?.[key];
    if (
      !(source instanceof Observable) ||
      typeof source.getValue !== "function"
    )
      throw new TypeError(
        `State source '${domain.name}/${key}' must have a current value.`,
      );
    state[key] = source;
  }
  for (const key of Object.keys(domain.definitions.state ?? {}))
    if (!Object.hasOwn(state, key))
      throw new TypeError(`Missing State source '${domain.name}/${key}'.`);
  for (const key of Object.keys(handlers.event ?? {})) {
    if (!Object.hasOwn(domain.definitions.event ?? {}, key))
      throw new TypeError(`Undeclared Event source '${domain.name}/${key}'.`);
    const source = handlers.event?.[key];
    if (
      source === undefined ||
      !(
        source instanceof Observable ||
        (source.mode === "broadcast" && source.source instanceof Observable) ||
        (source.mode === "scoped" && typeof source.factory === "function")
      )
    )
      throw new TypeError(
        `Event source '${domain.name}/${key}' must be an Observable or source adapter.`,
      );
    event[key] = source;
  }
  for (const key of Object.keys(domain.definitions.event ?? {}))
    if (!Object.hasOwn(event, key))
      throw new TypeError(`Missing Event source '${domain.name}/${key}'.`);
  return Object.freeze({
    domainName: domain.name,
    rpc: Object.freeze(rpc),
    state: Object.freeze(state),
    event: Object.freeze(event),
  });
}
