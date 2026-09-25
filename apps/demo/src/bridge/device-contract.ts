// 경량 계약(ADR 0012): device 도메인은 런타임 descriptor 없이 순수 TS
// 타입으로만 선언한다. 검증은 `src/main/schemas.ts`의 `schemas`/`errors` map이
// 맡는다(`.scratch/lightweight-contract/spec.md` 확정 결정 1·3).
//
// 값 타입은 `interface`가 아니라 `type` 별칭으로 선언한다 — `BridgeValue`의
// object 분기(`{ readonly [key: string]: BridgeValue }`)에 대입하려면 문자열
// 인덱스 시그니처가 필요한데, TS는 object literal 타입 별칭에는 이 시그니처를
// 암묵적으로 추론하지만 `interface`에는 추론하지 않는다(선언 합침 가능성
// 때문). `interface`로 선언하면 `Schema<T>`(`T extends BridgeValue`)와
// `BridgeImpl<AppBridge>`의 handler 반환 타입 양쪽에서 대입 실패로 컴파일
// 에러가 난다.
import type { RateValue, SamplingValue } from "./device-options.js";

export type ConnectionState = {
  readonly connected: boolean;
  readonly phase: "connecting" | "connected" | "disconnected";
  readonly reason?: "cable-disconnected";
};

export type DeviceMetrics = {
  readonly targetPerSecond: number;
  readonly sourceSamplingMs: number;
  readonly generatedPerSecond: number;
  readonly forwardedPerSecond: number;
  readonly generatedTotal: number;
  readonly forwardedTotal: number;
};

export type SerialLine = {
  readonly kind: "rx" | "tx" | "system";
  readonly text: string;
  readonly at: number;
};

export type DeviceError = {
  readonly code: "DEVICE_TIMEOUT";
  readonly message: "Device response timeout";
};

export type SendCommandInput = {
  readonly command: string;
};

export type SendResult = {
  readonly accepted: true;
};

export type SetRateInput = {
  readonly messagesPerSecond: RateValue;
};

export type SetSourceSamplingInput = {
  readonly milliseconds: SamplingValue;
};

export type DeviceBridge = {
  device: {
    rpc: {
      connect(): ConnectionState;
      disconnect(): ConnectionState;
      send(input: SendCommandInput): SendResult;
      setRate(input: SetRateInput): DeviceMetrics;
      setSourceSampling(input: SetSourceSamplingInput): DeviceMetrics;
      triggerError(): undefined;
      simulateCableDisconnect(): ConnectionState;
    };
    state: {
      connection: ConnectionState;
      temperature: number;
      signalStrength: number;
      packetCount: number;
      metrics: DeviceMetrics;
    };
    event: {
      data: SerialLine;
      error: DeviceError;
    };
  };
};
