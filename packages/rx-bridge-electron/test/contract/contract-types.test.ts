import { expectTypeOf, test } from "vitest";
import type { Observable } from "rxjs";

import {
  composeContracts,
  defineDomain,
  event,
  rpc,
  state,
  type InferBridge,
  type RemoteState,
  type RemoteStateSnapshot,
  type Schema,
} from "../../src/contract/index.js";

const input: Schema<{ readonly deviceId: string }> = {
  parse: (value) => value as { readonly deviceId: string },
};
const output: Schema<{ readonly connected: boolean }> = {
  parse: (value) => value as { readonly connected: boolean },
};
const noInput: Schema<undefined> = { parse: () => undefined };

const app = composeContracts(
  defineDomain("hardware", {
    rpc: {
      connect: rpc({ input, output, errors: ["NOT_FOUND", "BUSY"] as const }),
      disconnect: rpc({ input: noInput, output, errors: [] as const }),
    },
    state: { connection: state(output) },
    event: { fault: event(output) },
  }),
);

type AppBridge = InferBridge<typeof app>;

test("infers renderer bridge contract types", () => {
  expectTypeOf<AppBridge["hardware"]["connect"]>().toEqualTypeOf<
    (input: {
      readonly deviceId: string;
    }) => Promise<{ readonly connected: boolean }>
  >();
  expectTypeOf<AppBridge["hardware"]["disconnect"]>().toEqualTypeOf<
    () => Promise<{ readonly connected: boolean }>
  >();
  expectTypeOf<AppBridge["hardware"]["connection"]>().toEqualTypeOf<
    RemoteState<{ readonly connected: boolean }>
  >();
  expectTypeOf<AppBridge["hardware"]["fault"]>().toEqualTypeOf<
    Observable<{ readonly connected: boolean }>
  >();
  expectTypeOf<RemoteStateSnapshot<string>>().toMatchTypeOf<{
    readonly status: "uninitialized" | "connecting" | "current" | "stale";
  }>();
  expectTypeOf<
    (typeof app.domains.hardware.definitions.rpc.connect.errors)[number]
  >().toEqualTypeOf<"NOT_FOUND" | "BUSY">();
});

if (false) {
  const api = null as unknown as AppBridge;
  class NonBridgeClass {}
  // @ts-expect-error Date is not a v1 bridge payload.
  const dateSchema: Schema<Date> = { parse: () => new Date() };
  // @ts-expect-error Functions are not a v1 bridge payload.
  const functionSchema: Schema<() => void> = { parse: () => () => undefined };
  // @ts-expect-error Class instances are not a v1 bridge payload.
  const classSchema: Schema<NonBridgeClass> = {
    parse: () => new NonBridgeClass(),
  };
  void [dateSchema, functionSchema, classSchema];
  // @ts-expect-error RPC input must match its schema type.
  void api.hardware.connect({ deviceId: 1 });
  // @ts-expect-error No-input RPCs do not accept an input argument.
  void api.hardware.disconnect(undefined);
}
