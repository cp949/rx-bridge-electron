import { useEffect, useState } from "react";
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
  const [operationError, setOperationError] = useState("");

  useEffect(() => {
    const subscription = api.relay.event.fault.subscribe((value) =>
      setFault(`${value.code}: ${value.message}`),
    );
    return () => subscription.unsubscribe();
  }, [api]);

  const invoke = async (operation: () => Promise<unknown>) => {
    try {
      setOperationError("");
      await operation();
    } catch (error) {
      setOperationError(errorText(error));
    }
  };

  return (
    <section aria-label="virtual relay" className="card">
      <p className="eyebrow">Virtual relay · RLY-01</p>
      <h2>Relay: {label(status, snapshot.status)}</h2>
      {snapshot.status === "stale" && <p>Relay subscription stale</p>}
      {readOnly ? (
        <button onClick={() => void invoke(() => api.relay.rpc.turnOff())}>
          Try Relay Off
        </button>
      ) : (
        <div className="button-row">
          <button onClick={() => void invoke(() => api.relay.rpc.turnOn())}>
            Relay On
          </button>
          <button onClick={() => void invoke(() => api.relay.rpc.turnOff())}>
            Relay Off
          </button>
          <button
            onClick={() => void invoke(() => api.relay.rpc.simulateFault())}
          >
            Simulate Relay Fault
          </button>
          <button onClick={() => void invoke(() => api.relay.rpc.reset())}>
            Reset Relay
          </button>
        </div>
      )}
      {fault && <p>Latest relay fault: {fault}</p>}
      {operationError && <p role="alert">{operationError}</p>}
    </section>
  );
}
