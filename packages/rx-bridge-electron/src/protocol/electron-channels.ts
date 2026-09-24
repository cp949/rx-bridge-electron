/**
 * Electron IPC 채널 이름과 기본 namespace. Main(`src/main/electron-adapter.ts`)과
 * preload(`src/preload/expose-bridge.ts`)가 모두 이 파일에서 가져온다. 런타임 import가
 * 없는 leaf로 유지한다 — preload 번들에 Main 코드가 끌려오지 않게 한다(TRP-002).
 * Electron 전용이라 `./protocol` 공개 export에는 넣지 않는다.
 */
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
 * 공유한다(ADR 0013).
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
