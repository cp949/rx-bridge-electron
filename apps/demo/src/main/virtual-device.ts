import {
  BehaviorSubject,
  EMPTY,
  merge,
  Subject,
  distinctUntilChanged,
  sampleTime,
  share,
  switchMap,
  tap,
  type Observable,
} from "rxjs";
import type {
  ConnectionState,
  DeviceError,
  DeviceMetrics,
  SendCommandInput,
  SendResult,
  SerialLine,
  SetRateInput,
  SetSourceSamplingInput,
} from "../bridge/device-contract.js";

const disconnected: ConnectionState = {
  connected: false,
  phase: "disconnected",
};
function abortError(): DOMException {
  return new DOMException("Operation cancelled.", "AbortError");
}
function waitFor(
  signal: AbortSignal,
  lifetime: AbortSignal,
  milliseconds: number,
): Promise<void> {
  if (signal.aborted || lifetime.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", cancel);
      lifetime.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", cancel, { once: true });
    lifetime.addEventListener("abort", cancel, { once: true });
  });
}
export interface Device {
  readonly connection$: BehaviorSubject<ConnectionState>;
  readonly temperature$: BehaviorSubject<number>;
  readonly signalStrength$: BehaviorSubject<number>;
  readonly packetCount$: BehaviorSubject<number>;
  readonly metrics$: BehaviorSubject<DeviceMetrics>;
  readonly data$: Observable<SerialLine>;
  readonly error$: Observable<DeviceError>;
  connect(signal: AbortSignal): Promise<ConnectionState>;
  disconnect(signal: AbortSignal): Promise<ConnectionState>;
  send(input: SendCommandInput, signal: AbortSignal): Promise<SendResult>;
  setRate(input: SetRateInput): Promise<DeviceMetrics>;
  setSourceSampling(input: SetSourceSamplingInput): Promise<DeviceMetrics>;
  triggerError(): void;
  simulateCableDisconnect(): Promise<ConnectionState>;
  dispose(): void;
}
export class VirtualDevice implements Device {
  readonly connection$ = new BehaviorSubject<ConnectionState>(disconnected);
  readonly temperature$ = new BehaviorSubject(20);
  readonly signalStrength$ = new BehaviorSubject(80);
  readonly packetCount$ = new BehaviorSubject(0);
  readonly metrics$ = new BehaviorSubject<DeviceMetrics>({
    targetPerSecond: 10,
    sourceSamplingMs: 100,
    generatedPerSecond: 0,
    forwardedPerSecond: 0,
    generatedTotal: 0,
    forwardedTotal: 0,
  });
  readonly #rawRx$ = new Subject<SerialLine>();
  readonly #directLines$ = new Subject<SerialLine>();
  readonly #errors$ = new Subject<DeviceError>();
  readonly #sampling$ = new BehaviorSubject(100);
  readonly error$ = this.#errors$.asObservable();
  readonly data$ = merge(
    this.connection$.pipe(
      switchMap((connection) =>
        connection.connected
          ? this.#sampling$.pipe(
              distinctUntilChanged(),
              switchMap((milliseconds) =>
                milliseconds === 0
                  ? this.#rawRx$
                  : this.#rawRx$.pipe(sampleTime(milliseconds)),
              ),
              tap(() => this.#recordForwarded()),
            )
          : EMPTY,
      ),
    ),
    this.#directLines$,
  ).pipe(share());
  #timer: ReturnType<typeof setInterval> | undefined;
  #transition = 0;
  #startedAt = 0;
  #generated = 0;
  #forwarded = 0;
  #fractionalPackets = 0;
  #connectionGenerated = 0;
  #connectionForwarded = 0;
  #disposed = false;
  readonly #lifetime = new AbortController();

  async connect(signal: AbortSignal): Promise<ConnectionState> {
    if (signal.aborted || this.#disposed) throw abortError();
    if (this.connection$.value.connected) return this.connection$.value;
    const transition = ++this.#transition;
    this.connection$.next({ connected: false, phase: "connecting" });
    try {
      await waitFor(signal, this.#lifetime.signal, 100);
    } catch (error) {
      if (transition === this.#transition) this.connection$.next(disconnected);
      throw error;
    }
    if (transition !== this.#transition) return this.connection$.value;
    if (signal.aborted || this.#disposed) {
      this.connection$.next(disconnected);
      throw abortError();
    }
    this.#startedAt = Date.now();
    this.#connectionGenerated = this.#generated;
    this.#connectionForwarded = this.#forwarded;
    const connected: ConnectionState = { connected: true, phase: "connected" };
    this.connection$.next(connected);
    this.#start();
    return connected;
  }
  async disconnect(signal: AbortSignal): Promise<ConnectionState> {
    if (signal.aborted) throw abortError();
    ++this.#transition;
    this.#stop();
    this.connection$.next(disconnected);
    this.#publishMetrics();
    return disconnected;
  }
  async simulateCableDisconnect(): Promise<ConnectionState> {
    ++this.#transition;
    this.#stop();
    const state: ConnectionState = {
      connected: false,
      phase: "disconnected",
      reason: "cable-disconnected",
    };
    this.connection$.next(state);
    this.#publishMetrics();
    return state;
  }
  async send(
    input: SendCommandInput,
    signal: AbortSignal,
  ): Promise<SendResult> {
    if (signal.aborted) throw abortError();
    if (!this.connection$.value.connected)
      throw new Error("Device is disconnected.");
    this.#directLines$.next({
      kind: "tx",
      text: input.command,
      at: Date.now(),
    });
    this.#directLines$.next({
      kind: "system",
      text: `OK ${input.command}`,
      at: Date.now(),
    });
    return { accepted: true };
  }
  async setRate(input: SetRateInput): Promise<DeviceMetrics> {
    this.#resetMeasurement();
    this.metrics$.next({
      ...this.metrics$.value,
      targetPerSecond: input.messagesPerSecond,
    });
    return this.metrics$.value;
  }
  async setSourceSampling(
    input: SetSourceSamplingInput,
  ): Promise<DeviceMetrics> {
    this.#resetMeasurement();
    this.metrics$.next({
      ...this.metrics$.value,
      sourceSamplingMs: input.milliseconds,
    });
    this.#sampling$.next(input.milliseconds);
    return this.metrics$.value;
  }
  triggerError(): void {
    this.#errors$.next({
      code: "DEVICE_TIMEOUT",
      message: "Device response timeout",
    });
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    ++this.#transition;
    this.#lifetime.abort();
    this.#stop();
    this.connection$.complete();
    this.temperature$.complete();
    this.signalStrength$.complete();
    this.packetCount$.complete();
    this.metrics$.complete();
    this.#rawRx$.complete();
    this.#directLines$.complete();
    this.#errors$.complete();
    this.#sampling$.complete();
  }
  #start(): void {
    this.#stop();
    this.#timer = setInterval(() => {
      if (!this.connection$.value.connected) return;
      this.#fractionalPackets += this.metrics$.value.targetPerSecond / 100;
      const count = Math.floor(this.#fractionalPackets + 1e-9);
      this.#fractionalPackets -= count;
      for (let index = 0; index < count; index++) {
        const packet = ++this.#generated;
        this.#rawRx$.next({ kind: "rx", text: `RX:${packet}`, at: Date.now() });
      }
      this.packetCount$.next(this.#generated);
      this.temperature$.next(20 + (this.#generated % 100) / 10);
      this.signalStrength$.next(60 + (this.#generated % 40));
      this.#publishMetrics();
    }, 10);
  }
  #stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#publishMetrics();
  }
  #recordForwarded(): void {
    ++this.#forwarded;
    this.#publishMetrics();
  }
  #resetMeasurement(): void {
    this.#startedAt = Date.now();
    this.#connectionGenerated = this.#generated;
    this.#connectionForwarded = this.#forwarded;
    this.#publishMetrics();
  }
  #publishMetrics(): void {
    const elapsed = Math.max(1, Date.now() - this.#startedAt);
    const active = this.connection$.value.connected;
    this.metrics$.next({
      ...this.metrics$.value,
      generatedTotal: this.#generated,
      forwardedTotal: this.#forwarded,
      generatedPerSecond: active
        ? Math.round(
            ((this.#generated - this.#connectionGenerated) * 1000) / elapsed,
          )
        : 0,
      forwardedPerSecond: active
        ? Math.round(
            ((this.#forwarded - this.#connectionForwarded) * 1000) / elapsed,
          )
        : 0,
    });
  }
}
export function createVirtualDevice(): VirtualDevice {
  return new VirtualDevice();
}
