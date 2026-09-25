// 경량 계약(ADR 0012): 도메인 스키마는 Main에만 두고 Renderer 번들에는
// 포함하지 않는다.
// `schemas`/`errors`는 각각 `satisfies SchemasFor<AppBridge>`/
// `satisfies ErrorsFor<AppBridge>`로 선언해 경로 오타와 스키마 출력 타입
// 불일치를 컴파일 에러로 잡는다(ADR 0012 "파일 분리" 패턴,
// `packages/rx-bridge-electron/test/main/impl-schemas-fixture.ts` 참고).
import { z } from "zod";
import type {
  ErrorsFor,
  Schema,
  SchemasFor,
} from "@cp949/rx-bridge-electron/contract";

import type { AppBridge } from "../bridge/contract.js";
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
import { rateValues, samplingValues } from "../bridge/device-options.js";
import type { RelayFault, RelayStatus } from "../bridge/relay-contract.js";

const nonNegativeIntegerSchema = z.int().nonnegative();
const numberValueSchema = z.number();
const rate = z.literal(
  rateValues,
  "Rate must be 10, 100, 1000, or 10000 messages per second.",
);
const sampling = z.literal(
  samplingValues,
  "Sampling must be 0, 10, or 100 milliseconds.",
);

const connectionStateObject = z.object({
  connected: z.boolean(),
  phase: z.enum(["connecting", "connected", "disconnected"]),
  reason: z.literal("cable-disconnected").optional(),
});
export const connectionState: Schema<ConnectionState> = connectionStateObject
  .refine(
    ({ connected, phase, reason }) =>
      connected === (phase === "connected") &&
      (reason === undefined || phase === "disconnected"),
    { error: "Expected a valid connection state." },
  )
  .transform(({ connected, phase, reason }) =>
    reason === undefined ? { connected, phase } : { connected, phase, reason },
  );

const deviceMetricsObject = z.object({
  targetPerSecond: nonNegativeIntegerSchema,
  sourceSamplingMs: nonNegativeIntegerSchema,
  generatedPerSecond: numberValueSchema,
  forwardedPerSecond: numberValueSchema,
  generatedTotal: nonNegativeIntegerSchema,
  forwardedTotal: nonNegativeIntegerSchema,
});
export const deviceMetrics: Schema<DeviceMetrics> = deviceMetricsObject;

const serialLineObject = z.object({
  kind: z.enum(["rx", "tx", "system"]),
  text: z.string().refine((value) => value.length <= 256, {
    error: "Expected bounded serial line text.",
  }),
  at: numberValueSchema,
});
export const serialLine: Schema<SerialLine> = serialLineObject;

const deviceErrorObject = z.object({
  code: z.literal("DEVICE_TIMEOUT"),
  message: z.literal("Device response timeout"),
});
export const deviceError: Schema<DeviceError> = deviceErrorObject;

const sendCommandInputObject = z.object({
  command: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[\x20-\x7e]+$/),
});
export const sendCommandInput: Schema<SendCommandInput> =
  sendCommandInputObject;

const sendResultObject = z.object({
  accepted: z.literal(true),
});
export const sendResult: Schema<SendResult> = sendResultObject;

const setRateInputObject = z.object({
  messagesPerSecond: rate,
});
export const setRateInput: Schema<SetRateInput> = setRateInputObject;

const setSourceSamplingInputObject = z.object({
  milliseconds: sampling,
});
export const setSourceSamplingInput: Schema<SetSourceSamplingInput> =
  setSourceSamplingInputObject;

export const relayStatus: Schema<RelayStatus> = z
  .object({ energized: z.boolean(), faulted: z.boolean() })
  .refine(({ energized, faulted }) => !(energized && faulted), {
    error: "Expected a valid relay status.",
  });

export const relayFault: Schema<RelayFault> = z.object({
  code: z.literal("RELAY_TRIPPED"),
  message: z.literal("Relay overload simulated."),
});

export const schemas = {
  device: {
    rpc: {
      connect: { output: connectionState },
      disconnect: { output: connectionState },
      send: { input: sendCommandInput, output: sendResult },
      setRate: { input: setRateInput, output: deviceMetrics },
      setSourceSampling: {
        input: setSourceSamplingInput,
        output: deviceMetrics,
      },
      simulateCableDisconnect: { output: connectionState },
    },
    state: {
      connection: connectionState,
      temperature: numberValueSchema,
      signalStrength: numberValueSchema,
      packetCount: nonNegativeIntegerSchema,
      metrics: deviceMetrics,
    },
    event: {
      data: serialLine,
      error: deviceError,
    },
  },
  relay: {
    rpc: {
      turnOn: { output: relayStatus },
      turnOff: { output: relayStatus },
      simulateFault: { output: relayStatus },
      reset: { output: relayStatus },
    },
    state: { status: relayStatus },
    event: { fault: relayFault },
  },
} satisfies SchemasFor<AppBridge>;

/** 이 데모는 RPC가 던지는 값을 그대로 노출하는 도메인 에러 코드를 쓰지 않는다 — 전부 안전한 오류로 바뀐다. */
export const errors = {} satisfies ErrorsFor<AppBridge>;
