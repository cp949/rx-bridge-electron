export interface ElectronBridgeChannels {
  readonly handshake: string;
  readonly rpc: string;
  readonly cancel: string;
  readonly control: string;
  readonly stream: string;
}

/**
 * Main과 preload가 `namespace`를 생략했을 때 함께 쓰는 기본값. 두 지점이 각자 다른
 * 기본값을 두면 한쪽만 생략했을 때 채널이 어긋나는 조용한 실패가 생기므로, 이 상수 하나를
 * 공유한다(ADR 0013). preload(`src/preload/expose-bridge.ts`)는 이 파일에서
 * `ELECTRON_BRIDGE_CHANNELS`를 이미 import하고 있으므로 같은 경로에서 이 상수도 가져온다.
 */
export const DEFAULT_ELECTRON_BRIDGE_NAMESPACE = "default";

export function ELECTRON_BRIDGE_CHANNELS(
  namespace: string = DEFAULT_ELECTRON_BRIDGE_NAMESPACE,
): ElectronBridgeChannels {
  const prefix = `rx-bridge-electron:v1:${namespace}`;
  return {
    handshake: `${prefix}:handshake`,
    rpc: `${prefix}:rpc`,
    cancel: `${prefix}:cancel`,
    control: `${prefix}:control`,
    stream: `${prefix}:stream`,
  };
}
