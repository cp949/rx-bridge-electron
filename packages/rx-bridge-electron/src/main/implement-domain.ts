import type { DomainContract } from "../contract/index.js";
import type { BridgeValue } from "../protocol/index.js";
import type { CurrentValueSource, EventSource } from "./sources.js";
import { normalizeImplementation } from "./registration.js";
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
  return normalizeImplementation(domain, handlers);
}
