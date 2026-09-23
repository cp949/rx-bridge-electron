import { z } from "zod";
import type { Schema } from "@cp949/rx-bridge-electron/contract";

import { rateValues, samplingValues } from "./device-options.js";

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

const connectionStateObject = z.object({
  connected: z.boolean(),
  phase: z.enum(["connecting", "connected", "disconnected"]),
  reason: z.literal("cable-disconnected").optional(),
});
export type ConnectionState = Readonly<z.infer<typeof connectionStateObject>>;
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
export type DeviceMetrics = Readonly<z.infer<typeof deviceMetricsObject>>;
export const deviceMetrics: Schema<DeviceMetrics> = deviceMetricsObject;

const serialLineObject = z.object({
  kind: z.enum(["rx", "tx", "system"]),
  text: z.string().refine((value) => value.length <= 256, {
    error: "Expected bounded serial line text.",
  }),
  at: numberValueSchema,
});
export type SerialLine = Readonly<z.infer<typeof serialLineObject>>;
export const serialLine: Schema<SerialLine> = serialLineObject;

const deviceErrorObject = z.object({
  code: z.literal("DEVICE_TIMEOUT"),
  message: z.literal("Device response timeout"),
});
export type DeviceError = Readonly<z.infer<typeof deviceErrorObject>>;
export const deviceError: Schema<DeviceError> = deviceErrorObject;

const sendCommandInputObject = z.object({
  command: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[\x20-\x7e]+$/),
});
export type SendCommandInput = Readonly<z.infer<typeof sendCommandInputObject>>;
export const sendCommandInput: Schema<SendCommandInput> =
  sendCommandInputObject;

const sendResultObject = z.object({
  accepted: z.literal(true),
});
export type SendResult = Readonly<z.infer<typeof sendResultObject>>;
export const sendResult: Schema<SendResult> = sendResultObject;

const setRateInputObject = z.object({
  messagesPerSecond: rate,
});
export type SetRateInput = Readonly<z.infer<typeof setRateInputObject>>;
export const setRateInput: Schema<SetRateInput> = setRateInputObject;

const setSourceSamplingInputObject = z.object({
  milliseconds: sampling,
});
export type SetSourceSamplingInput = Readonly<
  z.infer<typeof setSourceSamplingInputObject>
>;
export const setSourceSamplingInput: Schema<SetSourceSamplingInput> =
  setSourceSamplingInputObject;
