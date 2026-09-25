import { useEffect, useRef, useState } from "react";
import type { AppBridge } from "../bridge/contract.js";
import type { RelayStatus } from "../bridge/relay-contract.js";
import {
  RemoteError,
  type RendererApi,
} from "@cp949/rx-bridge-electron/renderer";
import { useRemoteState } from "./use-remote-state.js";

interface Props {
  readonly api: RendererApi<AppBridge>;
  readonly readOnly?: boolean;
}

function label(status: RelayStatus | undefined, fallback: string): string {
  if (status === undefined) return fallback;
  if (status.faulted) return "faulted";
  return status.energized ? "on" : "off";
}

function errorText(error: unknown): string {
  return error instanceof RemoteError
    ? `${error.code}: ${error.message}`
    : String(error);
}

export function RelayPanel({ api, readOnly = false }: Props) {
  const snapshot = useRemoteState(api.relay.state.status);
  const status =
    snapshot.status === "current" || snapshot.status === "stale"
      ? snapshot.value
      : undefined;
  const [fault, setFault] = useState("");
  const [faultStreamError, setFaultStreamError] = useState("");
  const [operationError, setOperationError] = useState("");
  const pending = useRef(new Set<AbortController>());

  useEffect(() => {
    const subscription = api.relay.event.fault.subscribe({
      next: (value) => setFault(`${value.code}: ${value.message}`),
      error: (error: unknown) => setFaultStreamError(errorText(error)),
    });
    const controllers = pending.current;
    return () => {
      subscription.unsubscribe();
      controllers.forEach((controller) => controller.abort());
    };
  }, [api]);

  const invoke = async (call: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController();
    pending.current.add(controller);
    try {
      setOperationError("");
      await call(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setOperationError(errorText(error));
    } finally {
      pending.current.delete(controller);
    }
  };

  return (
    <section aria-label="virtual relay" className="card">
      <p className="eyebrow">Virtual relay · RLY-01</p>
      <h2>Relay: {label(status, snapshot.status)}</h2>
      {snapshot.status === "stale" && <p>Relay subscription stale</p>}
      {readOnly ? (
        <button
          onClick={() =>
            void invoke((signal) =>
              api.relay.rpc.turnOff(undefined, { signal }),
            )
          }
        >
          Try Relay Off
        </button>
      ) : (
        <div className="button-row">
          <button
            onClick={() =>
              void invoke((signal) =>
                api.relay.rpc.turnOn(undefined, { signal }),
              )
            }
          >
            Relay On
          </button>
          <button
            onClick={() =>
              void invoke((signal) =>
                api.relay.rpc.turnOff(undefined, { signal }),
              )
            }
          >
            Relay Off
          </button>
          <button
            onClick={() =>
              void invoke((signal) =>
                api.relay.rpc.simulateFault(undefined, { signal }),
              )
            }
          >
            Simulate Relay Fault
          </button>
          <button
            onClick={() =>
              void invoke((signal) =>
                api.relay.rpc.reset(undefined, { signal }),
              )
            }
          >
            Reset Relay
          </button>
        </div>
      )}
      {fault && <p>Latest relay fault: {fault}</p>}
      {faultStreamError && <p>Relay fault stream ended: {faultStreamError}</p>}
      {operationError && <p role="alert">{operationError}</p>}
    </section>
  );
}
