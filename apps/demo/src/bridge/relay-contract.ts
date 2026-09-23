import {
  defineDomain,
  event,
  rpc,
  state,
} from "@cp949/rx-bridge-electron/contract";
import type { Schema } from "@cp949/rx-bridge-electron/contract";
import type { BridgeValue } from "@cp949/rx-bridge-electron/protocol";
import { z } from "zod";
import { noInput } from "./schemas.js";

export interface RelayStatus extends Record<string, BridgeValue> {
  readonly energized: boolean;
  readonly faulted: boolean;
}
export interface RelayFault extends Record<string, BridgeValue> {
  readonly code: "RELAY_TRIPPED";
  readonly message: "Relay overload simulated.";
}

export const relayStatus: Schema<RelayStatus> = z
  .object({ energized: z.boolean(), faulted: z.boolean() })
  .refine(({ energized, faulted }) => !(energized && faulted), {
    error: "Expected a valid relay status.",
  });

export const relayFault: Schema<RelayFault> = z.object({
  code: z.literal("RELAY_TRIPPED"),
  message: z.literal("Relay overload simulated."),
});

export const relayContract = defineDomain("relay", {
  rpc: {
    turnOn: rpc({ input: noInput, output: relayStatus }),
    turnOff: rpc({ input: noInput, output: relayStatus }),
    simulateFault: rpc({ input: noInput, output: relayStatus }),
    reset: rpc({ input: noInput, output: relayStatus }),
  },
  state: { status: state(relayStatus) },
  event: {
    fault: event(relayFault, {
      buffer: { capacity: 20, overflow: "drop-oldest" },
    }),
  },
});
