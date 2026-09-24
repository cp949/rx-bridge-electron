import {
  createOpaqueId,
  createRendererApi,
  RemoteError,
  type BridgeTransport,
  type RemoteState,
} from "../../../src/renderer/index.js";
import type { LabBridge } from "./contract.js";

declare global {
  interface Window {
    readonly rxBridge: BridgeTransport;
  }
}

export type CallResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: string };

const api = createRendererApi<LabBridge>(window.rxBridge);

function settle(promise: Promise<string>): Promise<CallResult> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({
      ok: false,
      code: error instanceof RemoteError ? error.code : String(error),
    }),
  );
}

export async function ready(): Promise<string> {
  await api;
  return new URLSearchParams(location.search).get("role") ?? "";
}

export async function call(
  name: "ping" | "secure" | "hold",
  input: string,
): Promise<CallResult> {
  return settle((await api).lab.rpc[name](input));
}

const calls = new Map<string, CallResult[]>();

/** hold RPC를 `count`개 동시에 보내고 결과를 `tag`에 모은다. */
export async function startCalls(
  tag: string,
  name: "ping" | "secure" | "hold",
  count: number,
): Promise<void> {
  const bridge = await api;
  const results: CallResult[] = [];
  calls.set(tag, results);
  for (let index = 0; index < count; index += 1) {
    void settle(bridge.lab.rpc[name](`${tag}-${index}`)).then((result) =>
      results.push(result),
    );
  }
}

export function callResults(tag: string): readonly CallResult[] {
  return [...(calls.get(tag) ?? [])];
}

interface Received {
  readonly values: string[];
  error?: string;
  readonly subscription: { unsubscribe(): void };
  readonly source: RemoteState<string> | undefined;
}
const streams = new Map<string, Received>();

export async function subscribe(
  tag: string,
  kind: "state" | "event",
  name: string,
): Promise<void> {
  const bridge = await api;
  const source =
    kind === "state"
      ? bridge.lab.state.status
      : bridge.lab.event[name as "notice" | "strict" | "lossy"];
  const values: string[] = [];
  const entry: { values: string[]; error?: string } = { values };
  const subscription = source.subscribe({
    next: (value) => values.push(value),
    error: (error: unknown) => {
      entry.error = error instanceof RemoteError ? error.code : String(error);
    },
  });
  streams.set(
    tag,
    Object.assign(entry, {
      subscription,
      source: kind === "state" ? (source as RemoteState<string>) : undefined,
    }),
  );
}

/** `RemoteState`의 현재 snapshot 상태(`"uninitialized"|"connecting"|"current"|"stale"`)만 읽는다. */
export function snapshotStatus(tag: string): string | undefined {
  return streams.get(tag)?.source?.snapshot.status;
}

export function received(tag: string): {
  readonly values: readonly string[];
  readonly error?: string;
} {
  const entry = streams.get(tag);
  if (entry === undefined) return { values: [] };
  return entry.error === undefined
    ? { values: [...entry.values] }
    : { values: [...entry.values], error: entry.error };
}

export function unsubscribe(tag: string): void {
  streams.get(tag)?.subscription.unsubscribe();
  streams.delete(tag);
}

interface RawStream {
  readonly subscriptionId: string;
  readonly values: string[];
  subscribed: boolean;
  lastSequence: number;
  error?: string;
}
const raw = new Map<string, RawStream>();

/** ack를 자동으로 보내지 않는 느린 소비자. `rawAck`를 호출할 때만 ack한다. */
export async function rawSubscribe(tag: string, key: string): Promise<void> {
  await api;
  const entry: RawStream = {
    subscriptionId: createOpaqueId("subscription"),
    values: [],
    subscribed: false,
    lastSequence: 0,
  };
  raw.set(tag, entry);
  window.rxBridge.onStreamMessage((message) => {
    if (message.subscriptionId !== entry.subscriptionId) return;
    entry.lastSequence = message.sequence;
    if (message.type === "subscribed") entry.subscribed = true;
    if (message.type === "batch") {
      entry.values.push(...(message.values as string[]));
    }
    if (message.type === "error") entry.error = message.error.code;
  });
  window.rxBridge.control({
    type: "subscribe",
    subscriptionId: entry.subscriptionId,
    key,
  });
}

export function rawReceived(tag: string): {
  readonly subscribed: boolean;
  readonly values: readonly string[];
  readonly error?: string;
} {
  const entry = raw.get(tag);
  if (entry === undefined) return { subscribed: false, values: [] };
  const result = { subscribed: entry.subscribed, values: [...entry.values] };
  return entry.error === undefined ? result : { ...result, error: entry.error };
}

export function rawAck(tag: string): void {
  const entry = raw.get(tag);
  if (entry === undefined) return;
  window.rxBridge.control({
    type: "acknowledge",
    subscriptionId: entry.subscriptionId,
    sequence: entry.lastSequence,
  });
}

export function rawUnsubscribe(tag: string): void {
  const entry = raw.get(tag);
  if (entry === undefined) return;
  window.rxBridge.control({
    type: "unsubscribe",
    subscriptionId: entry.subscriptionId,
  });
  raw.delete(tag);
}
