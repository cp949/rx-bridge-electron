# bind `dispose()`는 IPC listener를 남겨 폐기된 server가 요청을 거부하게 하고, 같은 namespace의 새 bind가 그 listener를 인수한다

- 관련: ROADMAP.md#RD-048

## 상황

bind `dispose()`(`bindElectronBridge` 반환값)는 자기 attach를 detach하고, handshake·rpc handler를 `ipcMain.removeHandler`로, cancel·control listener를 `ipcMain.removeListener`로 제거한 뒤 `server.dispose()`를 불렀다([ADR 0006](0006-shutdown-contract.md)).

2026-09-26 Electron 실행으로 창을 남긴 채 bind를 dispose한 뒤의 동작을 확인했다.

- 기존 State·Event 구독은 `error CANCELLED "Bridge session ended."`를 받았다([ADR 0020](0020-stream-terminal-on-retire.md)).
- 새 State·Event 구독은 control listener가 없어 Main에 도달하지 않았다. 응답이 없어 `RemoteState.snapshot`이 `{ status: "connecting" }`에 머물렀다.
- 새 RPC는 handler 없는 `ipcRenderer.invoke` reject로 `INTERNAL "RPC transport failed."`, 재연결은 `INTERNAL "Bridge handshake failed."`가 됐다. Main stderr에는 `Error occurred in handler for 'rx-bridge-electron:v1:default:rpc': Error: No handler registered for 'rx-bridge-electron:v1:default:rpc'`가 찍혔다.
- `server.dispose()`만 부른 경우는 IPC가 살아 있어 새 구독이 `subscribed` 뒤 `error FORBIDDEN "Bridge sender is not authorized."`, RPC가 `FORBIDDEN`으로 끝났다.

같은 "Main이 브리지를 끝냈다"는 사건인데 종료 지점에 따라 Renderer가 받는 결과가 달랐고, 구독은 끝나지 않았다.

## 결정

1. **bind `dispose()`는 IPC handler·listener를 남긴다.** 절차는 종료 플래그 → 자기 attach detach → `server.dispose()`다. 남은 handler·listener는 폐기된 server로 요청을 넘기고, server는 기존 거부 경로로 응답한다. handshake는 `INVALID_ARGUMENT "Invalid bridge request."` 응답(Renderer에서 `INTERNAL "Bridge handshake failed."`), RPC는 `FORBIDDEN`, subscribe는 `subscribed` 뒤 `error FORBIDDEN`이다. `server.dispose()`만 부른 경우와 같다.
2. **같은 `ipcMain`·namespace의 새 bind가 인수한다.** `electron-adapter.ts`는 module 내부 `WeakMap<IpcMain, Map<handshake 채널, 해제 함수>>`에 dispose된 bind의 해제 함수를 둔다. handshake 채널 이름은 namespace마다 유일하다. `bindElectronBridge`는 `ipcMain.handle` 전에 같은 key의 해제 함수를 호출한다. 해제 함수는 entry를 지우고 그 bind가 등록한 handler 2개(`removeHandler`)와 listener 2개(`removeListener`, 자기 참조만)를 제거한다.
3. **활성 bind 중복은 그대로 실패한다.** dispose되지 않은 bind는 registry에 없다. 같은 namespace로 두 번째 bind를 만들면 지금처럼 `ipcMain.handle`이 `Attempted to register a second handler for '<channel>'`로 throw한다.
4. **공개 API는 바뀌지 않는다.** 옵션·반환 타입·오류 코드·문구가 그대로다. 새 wire 메시지도 없다.

## 대안과 기각 사유

- **한계로 문서화만.** 앱 종료(`before-quit`)에서만 부르는 권장 용법이면 영향이 작다. 그래도 창을 남긴 채 dispose하면 구독이 끝나지 않고 Renderer는 원인을 알 수 없다. `server.dispose()`와 결과가 다른 이유도 설명할 수 없다. 기각.
- **Renderer에 서버 종료를 알리는 wire 메시지.** API 전체의 끊김 신호가 새로 생긴다. 이것은 프로토콜 변경이고, 문서화된 한계("API 전체 차원의 끊김 신호는 없다")를 뒤집는다. 무응답을 없애는 데는 결정 1로 충분하다. 기각.
- **새 bind가 등록 전에 무조건 `removeHandler`.** registry 없이 재bind는 된다. 대신 활성 bind의 handler까지 조용히 빼앗는다. 그러면 cancel·control listener가 두 벌 남아 한 요청에 두 server가 응답한다. 기각.
- **listener를 남기고 재bind를 지원하지 않음.** 설계 문서는 종료 뒤 새 `createBridgeServer`·`bindElectronBridge`로 다시 연결하는 것을 허용한다. 같은 namespace 재bind가 `ipcMain.handle` 중복으로 throw하게 된다. 기각.

## 한계

- dispose된 bind의 handler·listener와 폐기된 server는 같은 `ipcMain`·namespace로 새 bind가 올 때까지 남는다. 다른 namespace만 쓰거나 재bind하지 않으면 process 종료까지 남는다.
- 해제 함수는 채널의 handler가 여전히 자기 것인지 확인하지 못한다. Electron `ipcMain`에 handler 조회 API가 없기 때문이다. 사용자가 dispose 뒤 같은 채널에 직접 `removeHandler`·`handle`을 했다면, 다음 재bind가 그 handler를 지운다.
- `ipcMain` 인스턴스별로 key를 둔다. test가 fake `ipcMain`을 바꾸면 registry는 공유되지 않는다.

## 관련 ADR

- [ADR 0006](0006-shutdown-contract.md) — bind `dispose()`의 listener 제거 결정을 이 ADR이 대체했다(개정 표시).
- [ADR 0020](0020-stream-terminal-on-retire.md) — 문서가 살아 있는 채 세션이 끝날 때의 통지. dispose 시점의 활성 구독 통지는 그대로다.
