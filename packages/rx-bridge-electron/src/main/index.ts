export { createBridgeServer } from "./create-bridge-server.js";
export type { ImplServerOptions } from "./create-bridge-server.js";
// bridge-types.ts에서 직접 재수출한다(barrel을 거치면 tsup dts 번들러가
// contract/main 두 entry 간 순환 chunk 경고를 낸다 — create-bridge-server.ts
// 참고).
export type {
  BridgeApi,
  BridgeImpl,
  ErrorsFor,
  SchemasFor,
} from "../contract/bridge-types.js";
export {
  bindElectronBridge,
  DEFAULT_ELECTRON_BRIDGE_NAMESPACE,
  ELECTRON_BRIDGE_CHANNELS,
} from "./electron-adapter.js";
export type {
  BindElectronBridgeOptions,
  ElectronBridgeChannels,
} from "./electron-adapter.js";
export type { StreamBridgeServer } from "./create-bridge-server.js";
export { DEFAULT_RESOURCE_LIMITS } from "./resource-limits.js";
export type { ResourceLimits } from "./resource-limits.js";
export { broadcastEvent, currentValueSource, scopedEvent } from "./sources.js";
export type { CurrentValueSource } from "./sources.js";
export type {
  AttachedTarget,
  Authorize,
  BridgeContext,
  BridgeDiagnostic,
  BridgeServer,
  DiagnosticsSink,
  DiagnosticsSnapshot,
  RejectReason,
  SenderIdentity,
} from "./types.js";
export type { WireCancelRequest, WireRpcRequest } from "../protocol/index.js";
