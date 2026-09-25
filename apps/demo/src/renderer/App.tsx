import { useEffect, useRef, useState } from "react";
import { sampleTime } from "rxjs";
import type { AppBridge } from "../bridge/contract.js";
import { rateOptions, samplingOptions } from "../bridge/device-options.js";
import type {
  ConnectionState,
  DeviceMetrics,
  SerialLine,
} from "../bridge/device-contract.js";
import {
  RemoteError,
  type RemoteStateSnapshot,
  type RendererApi,
} from "@cp949/rx-bridge-electron/renderer";
import { appendTerminalLine } from "./terminal.js";
import { RelayPanel } from "./RelayPanel.js";
import { useRemoteState } from "./use-remote-state.js";

interface Props {
  readonly api: RendererApi<AppBridge>;
}
function valueOf<T>(snapshot: RemoteStateSnapshot<T>): T | undefined {
  return snapshot.status === "current" || snapshot.status === "stale"
    ? snapshot.value
    : undefined;
}
function SnapshotLabel<T>({
  label,
  snapshot,
  render,
}: {
  label: string;
  snapshot: RemoteStateSnapshot<T>;
  render: (value: T) => string;
}) {
  const value = valueOf(snapshot);
  return (
    <p>
      {label}:{" "}
      <strong>{value === undefined ? snapshot.status : render(value)}</strong>
      {snapshot.status === "stale" ? " (stale)" : ""}
    </p>
  );
}
function useDeviceView(api: RendererApi<AppBridge>) {
  const connection = useRemoteState(api.device.state.connection);
  const temperature = useRemoteState(api.device.state.temperature);
  const signal = useRemoteState(api.device.state.signalStrength);
  const packets = useRemoteState(api.device.state.packetCount);
  const metrics = useRemoteState(api.device.state.metrics);
  const [displayTemperature, setDisplayTemperature] = useState<number>();
  const [renderedCount, setRenderedCount] = useState(0);
  useEffect(() => {
    const subscription = api.device.state.temperature
      .pipe(sampleTime(100))
      .subscribe({
        next: (value) => setDisplayTemperature(value),
        // 종료 표시는 같은 State의 useRemoteState(stale)가 맡는다.
        error: () => {},
      });
    return () => subscription.unsubscribe();
  }, [api]);
  useEffect(() => {
    if (displayTemperature === undefined) return;
    const frame = requestAnimationFrame(() =>
      setRenderedCount((count) => count + 1),
    );
    return () => cancelAnimationFrame(frame);
  }, [displayTemperature]);
  return {
    connection,
    temperature,
    signal,
    packets,
    metrics,
    displayTemperature,
    renderedCount,
  };
}
function SensorReadout({ view }: { view: ReturnType<typeof useDeviceView> }) {
  return (
    <section aria-label="sensor readout" className="card">
      <h2>Sensors</h2>
      <SnapshotLabel
        label="Temperature State"
        snapshot={view.temperature}
        render={(value) => `${value.toFixed(1)} °C`}
      />
      <p>
        Temperature display (renderer sample 100 ms):{" "}
        <strong>{view.displayTemperature?.toFixed(1) ?? "waiting"} °C</strong>
      </p>
      <SnapshotLabel
        label="Signal"
        snapshot={view.signal}
        render={(value) => `${value}%`}
      />
      <SnapshotLabel
        label="Packets generated"
        snapshot={view.packets}
        render={String}
      />
      <p>
        UI rendered samples: <strong>{view.renderedCount}</strong>
      </p>
    </section>
  );
}
function ConnectionReadout({
  snapshot,
}: {
  snapshot: RemoteStateSnapshot<ConnectionState>;
}) {
  const connection = valueOf(snapshot);
  return (
    <section aria-label="device connection" className="card">
      <p className="eyebrow">Virtual serial device · VDM-01</p>
      <h2>
        Connection:{" "}
        <span className={connection?.connected ? "connected" : "disconnected"}>
          {connection?.phase ?? snapshot.status}
        </span>
      </h2>
      {connection?.reason && <p>Reason: {connection.reason}</p>}
      {snapshot.status === "stale" && <p>State subscription stale</p>}
    </section>
  );
}
function MetricsReadout({
  snapshot,
  renderedCount,
}: {
  snapshot: RemoteStateSnapshot<DeviceMetrics>;
  renderedCount: number;
}) {
  const metrics = valueOf(snapshot);
  return (
    <section aria-label="measured rates" className="card">
      <h2>Measured rates</h2>
      <p>
        Target source: {metrics?.targetPerSecond ?? "—"} messages/s{" "}
        {metrics?.targetPerSecond === 10000 && (
          <span>(stress sampling demo; delivery is not guaranteed)</span>
        )}
      </p>
      <p>
        Main source sampling: {metrics?.sourceSamplingMs ?? "—"} ms, before IPC
      </p>
      <p>
        Main generated: {metrics?.generatedPerSecond ?? "—"} messages/s ·{" "}
        {metrics?.generatedTotal ?? "—"} total
      </p>
      <p>
        Main forwarded to bridge (pre-IPC): {metrics?.forwardedPerSecond ?? "—"}{" "}
        messages/s · {metrics?.forwardedTotal ?? "—"} total
      </p>
      <p>Bounded IPC queues can deliver fewer events than this source count.</p>
      <p>Renderer display samples: {renderedCount} (100 ms after IPC)</p>
    </section>
  );
}
function errorText(error: unknown): string {
  return error instanceof RemoteError
    ? `${error.code}: ${error.message}`
    : String(error);
}

export function MainMonitorApp({ api }: Props) {
  const view = useDeviceView(api);
  const [command, setCommand] = useState("AT+STATUS");
  const [terminal, setTerminal] = useState<readonly SerialLine[]>([]);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const pending = useRef(new Set<AbortController>());
  const report = (error: unknown) =>
    setErrors((current) => [...current.slice(-19), errorText(error)]);
  useEffect(() => {
    const reportStream = (name: string) => (error: unknown) =>
      setErrors((current) => [
        ...current.slice(-19),
        `${name} ended: ${errorText(error)}`,
      ]);
    const data = api.device.event.data.subscribe({
      next: (line) => setTerminal((lines) => appendTerminalLine(lines, line)),
      error: reportStream("device.event.data"),
    });
    const error = api.device.event.error.subscribe({
      next: (value) =>
        setErrors((current) => [
          ...current.slice(-19),
          `${value.code}: ${value.message}`,
        ]),
      error: reportStream("device.event.error"),
    });
    const controllers = pending.current;
    return () => {
      data.unsubscribe();
      error.unsubscribe();
      controllers.forEach((controller) => controller.abort());
    };
  }, [api]);
  const invoke = async (call: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController();
    pending.current.add(controller);
    try {
      await call(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) report(error);
    } finally {
      pending.current.delete(controller);
    }
  };
  return (
    <main>
      <header>
        <p className="eyebrow">Controller</p>
        <h1>Virtual Device Monitor</h1>
        <p>Two Main-owned virtual devices, two independent windows.</p>
      </header>
      <ConnectionReadout snapshot={view.connection} />
      <RelayPanel api={api} />
      <section aria-label="device controls" className="card controls">
        <h2>Controls</h2>
        <div className="button-row">
          <button
            onClick={() =>
              void invoke((signal) =>
                api.device.rpc.connect(undefined, { signal }),
              )
            }
          >
            Connect
          </button>
          <button
            onClick={() =>
              void invoke((signal) =>
                api.device.rpc.disconnect(undefined, { signal }),
              )
            }
          >
            Disconnect
          </button>
          <button
            onClick={() =>
              void invoke((signal) =>
                api.device.rpc.simulateCableDisconnect(undefined, { signal }),
              )
            }
          >
            Simulate Cable Disconnect
          </button>
          <button
            onClick={() =>
              void invoke((signal) =>
                api.device.rpc.triggerError(undefined, { signal }),
              )
            }
          >
            Trigger Error
          </button>
          <button
            onClick={() =>
              pending.current.forEach((controller) => controller.abort())
            }
          >
            Cancel Pending
          </button>
        </div>
        <div className="field-row">
          <label>
            Command{" "}
            <input
              value={command}
              maxLength={80}
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <button
            onClick={() =>
              void invoke((signal) =>
                api.device.rpc.send({ command }, { signal }),
              )
            }
          >
            Send
          </button>
        </div>
        <div className="field-row">
          <label>
            Source rate{" "}
            <select
              aria-label="Source rate"
              defaultValue="10"
              onChange={(event) => {
                const selected = rateOptions.find(
                  ({ value }) => String(value) === event.target.value,
                );
                if (selected === undefined) return;
                void invoke((signal) =>
                  api.device.rpc.setRate(
                    { messagesPerSecond: selected.value },
                    { signal },
                  ),
                );
              }}
            >
              {rateOptions.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Main sampling{" "}
            <select
              aria-label="Main sampling"
              defaultValue="100"
              onChange={(event) => {
                const selected = samplingOptions.find(
                  ({ value }) => String(value) === event.target.value,
                );
                if (selected === undefined) return;
                void invoke((signal) =>
                  api.device.rpc.setSourceSampling(
                    { milliseconds: selected.value },
                    { signal },
                  ),
                );
              }}
            >
              {samplingOptions.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <div className="grid">
        <SensorReadout view={view} />
        <MetricsReadout
          snapshot={view.metrics}
          renderedCount={view.renderedCount}
        />
      </div>
      <section aria-label="terminal" className="card">
        <h2>
          Serial terminal <small>latest {terminal.length}/500</small>
        </h2>
        <ol className="terminal">
          {terminal.map((line, index) => (
            <li key={`${line.at}-${index}`}>
              <span>{line.kind.toUpperCase()}</span> {line.text}
            </li>
          ))}
        </ol>
      </section>
      <section aria-label="error log" className="card">
        <h2>Operational errors</h2>
        {errors.length === 0 ? (
          <p>None</p>
        ) : (
          <ul>
            {errors.map((error, index) => (
              <li key={index}>{error}</li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
export function SensorMonitorApp({ api }: Props) {
  const view = useDeviceView(api);
  const [policy, setPolicy] = useState("");
  const [rxCount, setRxCount] = useState(0);
  const [lastError, setLastError] = useState("");
  useEffect(() => {
    const reportStream = (name: string) => (error: unknown) =>
      setLastError(`${name} ended: ${errorText(error)}`);
    const data = api.device.event.data.subscribe({
      next: (line) => {
        if (line.kind === "rx") setRxCount((count) => count + 1);
      },
      error: reportStream("device.event.data"),
    });
    const errors = api.device.event.error.subscribe({
      next: (error) => setLastError(`${error.code}: ${error.message}`),
      error: reportStream("device.event.error"),
    });
    return () => {
      data.unsubscribe();
      errors.unsubscribe();
    };
  }, [api]);
  return (
    <main className="monitor">
      <header>
        <p className="eyebrow">Read-only monitor</p>
        <h1>Device Monitor</h1>
      </header>
      <ConnectionReadout snapshot={view.connection} />
      <RelayPanel api={api} readOnly />
      <SensorReadout view={view} />
      <MetricsReadout
        snapshot={view.metrics}
        renderedCount={view.renderedCount}
      />
      <section aria-label="monitor events" className="card">
        <h2>Shared Events</h2>
        <p>RX events received: {rxCount}</p>
        <p>Latest error: {lastError || "None"}</p>
      </section>
      <section aria-label="role policy" className="card">
        <h2>Role policy</h2>
        <p>State and Event streams are readable. Control RPCs are denied.</p>
        <button
          onClick={() =>
            void api.device.rpc
              .disconnect()
              .catch((error) => setPolicy(errorText(error)))
          }
        >
          Try Disconnect
        </button>
        {policy && <p role="alert">{policy}</p>}
      </section>
    </main>
  );
}
