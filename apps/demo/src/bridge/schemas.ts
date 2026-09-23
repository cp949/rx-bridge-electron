import { z } from "zod";
import type { Schema } from "@cp949/rx-bridge-electron/contract";
import type { BridgeValue } from "@cp949/rx-bridge-electron/protocol";

import { rateValues, samplingValues } from "./device-options.js";

export interface ConnectionState extends Record<string, BridgeValue> {
  readonly connected: boolean;
  readonly phase: "connecting" | "connected" | "disconnected";
  readonly reason?: "cable-disconnected";
}
export interface DeviceMetrics extends Record<string, BridgeValue> {
  readonly targetPerSecond: number;
  readonly sourceSamplingMs: number;
  readonly generatedPerSecond: number;
  readonly forwardedPerSecond: number;
  readonly generatedTotal: number;
  readonly forwardedTotal: number;
}
export interface SerialLine extends Record<string, BridgeValue> {
  readonly kind: "rx" | "tx" | "system";
  readonly text: string;
  readonly at: number;
}
export interface DeviceError extends Record<string, BridgeValue> {
  readonly code: "DEVICE_TIMEOUT";
  readonly message: "Device response timeout";
}
export interface SendCommandInput extends Record<string, BridgeValue> {
  readonly command: string;
}
export interface SendResult extends Record<string, BridgeValue> {
  readonly accepted: true;
}
export interface SetRateInput extends Record<string, BridgeValue> {
  readonly messagesPerSecond: (typeof rateValues)[number];
}
export interface SetSourceSamplingInput extends Record<string, BridgeValue> {
  readonly milliseconds: (typeof samplingValues)[number];
}

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

export const noInput: Schema<undefined> = z.undefined();
export const numberValue: Schema<number> = numberValueSchema;
export const nonNegativeInteger: Schema<number> = nonNegativeIntegerSchema;

export const connectionState: Schema<ConnectionState> = z
  .object({
    connected: z.boolean(),
    phase: z.enum(["connecting", "connected", "disconnected"]),
    reason: z.literal("cable-disconnected").optional(),
  })
  .refine(
    ({ connected, phase, reason }) =>
      connected === (phase === "connected") &&
      (reason === undefined || phase === "disconnected"),
    { error: "Expected a valid connection state." },
  )
  .transform(({ connected, phase, reason }) =>
    reason === undefined ? { connected, phase } : { connected, phase, reason },
  );

export const deviceMetrics: Schema<DeviceMetrics> = z.object({
  targetPerSecond: nonNegativeIntegerSchema,
  sourceSamplingMs: nonNegativeIntegerSchema,
  generatedPerSecond: numberValueSchema,
  forwardedPerSecond: numberValueSchema,
  generatedTotal: nonNegativeIntegerSchema,
  forwardedTotal: nonNegativeIntegerSchema,
});

export const serialLine: Schema<SerialLine> = z.object({
  kind: z.enum(["rx", "tx", "system"]),
  text: z.string().refine((value) => value.length <= 256, {
    error: "Expected bounded serial line text.",
  }),
  at: numberValueSchema,
});

export const deviceError: Schema<DeviceError> = z.object({
  code: z.literal("DEVICE_TIMEOUT"),
  message: z.literal("Device response timeout"),
});

export const sendCommandInput: Schema<SendCommandInput> = z.object({
  command: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[\x20-\x7e]+$/),
});

export const sendResult: Schema<SendResult> = z.object({
  accepted: z.literal(true),
});

export const setRateInput: Schema<SetRateInput> = z.object({
  messagesPerSecond: rate,
});

export const setSourceSamplingInput: Schema<SetSourceSamplingInput> = z.object({
  milliseconds: sampling,
});
