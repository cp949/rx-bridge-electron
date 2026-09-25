# 10. 종료

## 1. 목적과 범위

소유자가 명시적으로 브리지를 끝내는 세 지점 — Renderer `api.dispose()`, Main `server.dispose()`, bind `dispose()` — 이 무엇을 확정하고, 종료 뒤 호출이 어떤 결과를 받고, 종료 도중 사용자 코드가 재진입하면 어떻게 되는지 정한다.

다루지 않는 것:

- 수명 사건(navigation commit, renderer 종료, `webContents` 파괴, detach)으로 인한 세션 retire의 사유·시점: [04. 문서 세션](04-document-session.md)
- retire 시 활성 구독에 보내는 stream terminal 통지 판정: [06. Main 스트림 전달](06-stream-delivery.md)
- retire 시 진행 중 RPC 취소와 `CANCELLED` 우선 guard: [05. RPC](05-rpc.md)
- 루트 `dispose` 이름 예약과 manifest 거부: [02. Renderer API](02-renderer-api.md)
- loopback test transport의 `dispose()`(detach만 하고 server는 끝내지 않는다): [03. Transport와 배선](03-transport-and-wiring.md)

## 2. 모델

용어는 [CONTEXT.md](../../CONTEXT.md)를 따른다.

- **종료(dispose)**: 소유자가 명시적으로 내리는 되돌릴 수 없는 종료다. Renderer API, Main 서버, Electron bind에 적용된다.
- **은퇴(retire)**: 렌더러 문서 세션이 수명 사건으로 끝나는 것이다. `server.dispose()`와 detach는 retire 원인 중 하나다. Renderer `api.dispose()`는 세션을 retire하지 않는다.

| 종료 지점          | 소유자                                                          | 종료 플래그                                    | 끝내는 대상                                        |
| ------------------ | --------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `api.dispose()`    | `ApiLifetime` (`src/renderer/api-lifetime.ts`)                  | `#terminated`                                  | Renderer API 인스턴스 하나(RPC 확정, stream 정리)  |
| `server.dispose()` | `buildBridgeServer` 반환 객체, `DocumentSessions`               | 서버의 `disposed`, `DocumentSessions#disposed` | 모든 attach, 모든 문서 세션(retire 사유 `dispose`) |
| bind `dispose()`   | `bindElectronBridge` 반환 객체 (`src/main/electron-adapter.ts`) | bind의 `disposed`                              | 자기 attach, 자기 IPC handler·listener, 서버       |

`api.dispose`와 `api[Symbol.dispose]`는 같은 함수 참조다. `RendererApi<B>` 타입은 `Disposable`을 포함한다.

## 3. 불변식

1. 종료 플래그는 한 번 `true`가 되면 되돌아가지 않는다. "종료 중"과 "종료됨"을 구분하지 않는다.
2. 종료 플래그는 종료 부작용(RPC 확정, stream 정리, 세션 retire, listener 제거)보다 먼저 확정된다. 부작용 도중 재진입한 호출은 이미 종료 뒤 규칙을 따른다.
3. 반복 `dispose()`는 no-op이다. cancel·unsubscribe 전송, 진단 기록, 서버 dispose를 추가로 하지 않는다.
4. 종료 뒤 새 작업은 전송 없이 기존 오류 코드로 끝난다. 종료 전용 오류 코드는 없다.
5. Renderer는 종료 뒤 control 메시지를 새로 시작하지 않는다. 예외는 종료 절차의 일부인 unsubscribe뿐이다(4.1).
6. 종료된 Renderer API 인스턴스의 RPC 결과와 stream 메시지는 호출자·구독자에게 전달되지 않는다.
7. `server.dispose()`는 retired client ID 기록을 지우지 않는다.
8. bind `dispose()`는 자기가 등록한 IPC listener만 제거한다.

## 4. 흐름

### 4.1 Renderer `api.dispose()`

`ApiLifetime.dispose()`가 절차를 소유한다. 단계는 범용 콜백 목록이 아니라 고정 슬롯 2개(`settleRpcs`, `closeStreams`)로 받아 순서를 타입으로 고정한다.

1. 이미 종료됐으면 반환한다.
2. 종료 플래그를 `true`로 확정한다.
3. **RPC 확정** (`RpcClient.settleAllAsDisposed`): pending 목록을 스냅샷하고 비운 뒤 요청마다
   1. 확정을 선점한다(이미 다른 원인으로 확정됐으면 건너뛴다).
   2. `rpc-settled`(`disposed`) 진단을 기록한다.
   3. `transport.invoke`까지 간 요청이면 `transport.cancel(requestId)`을 1회 best-effort로 보낸다. throw는 삼키고 `transport-failed`(`cancel`)만 기록한다.
   4. Promise를 `RemoteError("CANCELLED", "Renderer API is disposed.")`로 reject한다. 로컬 확정은 cancel 전송 성공과 무관하다.
4. **stream 정리** (`StreamMultiplexer.closeAll`):
   1. `transport.onStreamMessage` listener를 제거한다.
   2. 남은 generation마다 표에서 삭제 → `subscription-closed`(`disposed`) 진단 → `unsubscribe` 1회 전송 → `complete()` 통지. `error`가 아니다.
   3. `RemoteState` snapshot은 `current`면 `stale`, `connecting`이면 `uninitialized`로 전이한다([07. Renderer 스트림과 State](07-renderer-streams.md)).

RPC 확정이 stream 정리보다 먼저다. `rpc-settled` sink가 재진입해도 stream은 아직 정리 전이고 종료 플래그는 이미 확정돼 있다.

종료 뒤 전송 규칙:

| 메시지                                                                                                           | 종료 뒤                    |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `closeAll`이 남은 generation마다 보내는 `unsubscribe`                                                            | 보낸다                     |
| dispose보다 먼저 시작된 구독 해제가 `subscription-closed` sink 재진입으로 dispose된 뒤 마저 보내는 `unsubscribe` | 보낸다                     |
| batch 전달 중 `next` 콜백에서 dispose된 경우 그 batch의 `acknowledge`                                            | 보내지 않는다(진단도 없음) |
| 새 `subscribe`, RPC `invoke`, 새 `cancel`                                                                        | 보내지 않는다              |

두 unsubscribe는 종료 뒤 새로 시작하는 부작용이 아니라 Main 구독을 해제하는 종료 절차의 일부다.

### 4.2 Renderer 종료 뒤 호출 결과

| 호출                                       | 결과                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| RPC                                        | 전송 없이 `RemoteError("CANCELLED", "Renderer API is disposed.")`로 reject된 Promise. 동기 throw 없음. `rpc-settled`(`disposed`) 기록            |
| State/Event `subscribe()`                  | 전송 없이 동기 `error(RemoteError("CANCELLED", "Renderer API is disposed."))`. 활성 generation이 남아 있어도 합류하지 않는다. snapshot 변화 없음 |
| `snapshotStore(state).subscribe(onChange)` | `onChange` 동기 1회. 미처리 오류로 보고하지 않는다                                                                                               |
| `dispose()` / `[Symbol.dispose]()`         | no-op                                                                                                                                            |
| dispose 전 요청에 늦게 도착한 RPC 응답     | 이미 확정된 요청이라 버린다                                                                                                                      |
| dispose 뒤 도착한 stream 메시지            | listener가 제거됐고, 제거 전에 잡힌 listener로 와도 `#dispatch`가 버린다. 진단 없음                                                              |

`createDisposedError()`는 호출마다 새 `RemoteError`를 만든다. 호출자끼리 오류 객체를 공유하지 않는다.

### 4.3 Renderer 재진입

종료 절차 도중 사용자 코드가 동기로 실행되는 지점은 셋이다: `rpc-settled` 진단 sink(3단계), `subscription-closed` 진단 sink(4단계), `complete()` 콜백(4단계). 세 지점 어디서 무엇을 호출해도 결과는 같다.

| 재진입 동작   | 결과                                                 |
| ------------- | ---------------------------------------------------- |
| `dispose()`   | no-op. cancel·unsubscribe 추가 전송 없음             |
| RPC 호출      | 전송 없이 `CANCELLED` reject                         |
| `subscribe()` | 전송 없이 동기 `CANCELLED` error. snapshot 변화 없음 |

경계 사례:

- `rpc-settled` sink에서 마지막 로컬 구독자를 해제하면 개별 `close`는 no-op이고, stream 정리 단계가 그 generation을 `disposed`로 한 번 닫는다. unsubscribe 1회, `subscription-closed` 1회. 해제한 구독자는 `complete`를 받지 않는다.
- 로컬 해제로 시작된 generation 종료의 `subscription-closed`(`unsubscribed`) sink에서 dispose하면, 그 generation은 이미 표에서 빠졌으므로 `closeAll`이 다시 닫지 않고 원래 해제가 unsubscribe를 1회 보낸다.
- `next` 콜백에서 dispose하면 남은 batch 값은 전달하지 않고, 구독자는 `complete`를 받으며, acknowledge는 보내지 않는다.
- `subscription-opened` sink에서 dispose하면 generation은 이미 닫혔으므로 subscribe를 보내지 않는다.

Promise 콜백(RPC reject 반응)은 microtask라 종료 절차가 끝난 뒤 실행된다.

### 4.4 Main `server.dispose()`

1. 서버의 `disposed`가 이미 `true`면 반환한다. 아니면 `true`로 둔다.
2. `DocumentSessions.dispose()`: `#disposed = true`를 확정한 뒤 모든 attachment를 사유 `dispose`로 detach한다. 각 attachment의 lifecycle listener를 제거하고 현재 세션을 retire한다.
3. retire가 세션 listener를 거쳐 진행 중 RPC를 취소하고([05. RPC](05-rpc.md)), 활성·`authorize` 대기 구독에 `error CANCELLED "Bridge session ended."`를 보낸다([06. Main 스트림 전달](06-stream-delivery.md)).
4. `Subscriptions.dispose()`: 남아 있는 pending·consumer를 전송 없이 닫고 slot을 반환한다.

종료 뒤 요청 결과:

| 요청                           | 결과                                                                        |
| ------------------------------ | --------------------------------------------------------------------------- |
| `attach()`                     | 동기 throw `BridgeProtocolError("FORBIDDEN", "Bridge server is disposed.")` |
| handshake                      | `INVALID_ARGUMENT "Invalid bridge request."` 응답                           |
| RPC                            | `FORBIDDEN "Bridge sender is not authorized."` 응답                         |
| subscribe                      | `subscribed`(0) 뒤 `error FORBIDDEN "Bridge sender is not authorized."`     |
| cancel·unsubscribe·acknowledge | 응답 없음                                                                   |

handshake·RPC·subscribe·cancel·control 모두 sender admission이 `sender-unauthorized`로 거부하는 기존 경로다([04. 문서 세션](04-document-session.md)). 새 오류 경로를 추가하지 않는다. 거부마다 `rejected`(`sender-unauthorized`) 진단이 남는다([11. 진단](11-diagnostics.md)).

재진입: `#disposed`가 detach 루프보다 먼저 확정되므로, retire 콜백(handler의 `abort` listener 등) 안에서 호출한 `attach()`는 같은 메시지로 throw하고 RPC는 `FORBIDDEN`을 받고 `server.dispose()`는 no-op이다.

retired client ID 기록은 dispose 뒤에도 남는다. `destroyed` 수명 사건만 해당 `webContentsId`의 기록을 지운다. 보관량 한도는 [09. 세션 자원 한도](09-resource-limits.md).

### 4.5 bind `dispose()`

1. bind의 `disposed`가 이미 `true`면 반환한다. 아니면 `true`로 둔다.
2. bind가 attach한 `webContents`마다 server detach를 호출한다(retire 사유 `detach`). lifecycle listener가 제거되고 활성 구독은 `error CANCELLED`를 받는다.
3. attach 표를 비운다.
4. handshake·rpc 채널은 `ipcMain.removeHandler`로, cancel·control 채널은 자기가 등록한 `onCancel`·`onControl` 참조만 `ipcMain.removeListener`로 제거한다.
5. `server.dispose()`를 호출한다. bind를 거치지 않고 `server.attach`로 붙은 세션은 여기서 사유 `dispose`로 retire된다.

종료 뒤 bind의 `attach()`는 server를 부르기 전에 동기 throw `BridgeProtocolError("FORBIDDEN", "Electron bridge is disposed.")`한다. 채널 handler가 제거됐으므로 이후 IPC 요청은 server에 도달하지 않는다.

### 4.6 dispose가 필요 없는 경우

| 상황                                      | 누가 정리하는가                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| 창 닫힘, reload, main-frame navigation    | Main이 문서 세션을 retire한다([04. 문서 세션](04-document-session.md)) |
| renderer process 종료, `webContents` 파괴 | Main이 문서 세션을 retire한다                                          |
| 문서가 살아 있는 채 SPA 화면 teardown     | Renderer `api.dispose()`                                               |
| Main 앱 종료                              | bind `dispose()`(서버까지 끝낸다)                                      |

`api.dispose()`는 문서가 살아 있는 동안 Renderer가 스스로 정리를 끝낼 때 쓴다. 창·문서가 사라지는 경로의 Main 자원 회수는 dispose 호출 여부와 무관하다([ADR 0013](../adr/0013-wiring-defaults.md)).

## 5. 설계 이유와 기각한 대안

설계 이유:

- **`CANCELLED` 재사용**: 호출자가 `AbortSignal` 취소와 dispose 취소를 구분해 얻을 실익이 없다. 새 코드는 모든 소비자의 판별 분기를 늘린다. 원인이 필요하면 `rpc-settled`의 `cause`로 구분한다.
- **RPC와 stream이 같은 코드·문구**: "이 API 인스턴스는 종료됐다"는 사실 하나를 오류 하나로 표현한다.
- **활성 stream은 `complete`**: 소유자가 의도한 정상 종료다. 비자발적 끊김(Main 세션 종료의 `error CANCELLED`)과 구분된다.
- **종료 뒤 `subscribe()`는 오류**: 빈 `complete`는 "종료된 API를 계속 쓴다"는 프로그래밍 오류를 조용히 묻는다.
- **종료 뒤 RPC는 reject된 Promise**: RPC 호출 계약은 항상 Promise를 반환한다.
- **플래그 먼저, 부작용 나중**: 진단 sink·`complete` 콜백 재진입이 절반쯤 정리된 상태를 보지 않는다.
- **retired 기록 유지**: 서버 dispose는 세션이 다시 살아날 수 없게 만드는 사건이라 기록을 지울 이유가 없다. 지우는 경로를 두면 "retire된 client ID는 재사용하지 않는다" 규칙이 종료 경로에 따라 약해진다.
- **bind가 자기 listener만 제거**: 같은 IPC 채널에 다른 코드가 등록한 listener를 건드리지 않는다. invoke 채널은 채널당 handler가 하나뿐이라 `removeHandler`로 충분하다.

기각한 대안:

- **새 오류 코드(`DISPOSED` 등)**: 오류 코드 union과 소비자 분기가 늘어난다.
- **루트 `AbortController`를 모든 RPC `signal`에 합성**: 개별 호출의 signal과 루트 종료를 구분할 수 없고, 종료 경로가 간접적인 abort 전파가 된다. pending 레지스트리를 직접 순회한다.
- **종료 뒤 `subscribe()`를 빈 `complete`로 처리**: 프로그래밍 오류가 로그 없이 묻힌다.
- **종료 중 활성 generation 합류 허용**: 현재값 재생과 늦은 `complete`를 받아 종료 뒤 규칙이 깨진다.
- **`finally`에서 풀리는 재진입 가드(`disposing`)**: 종료 후 상태를 표현하지 못해 종료 뒤 `attach()`·요청을 막지 못한다.
- **`ipcMain.removeAllListeners`**: 같은 채널의 다른 listener까지 지운다.
- **dispose 때 retired 기록 삭제**: 재사용 방지가 조용히 무력화될 수 있다.
- **hello-world에서 `pagehide`마다 `api.dispose()` 자동 호출**: Main이 이미 retire로 회수하므로 불필요한 코드다.
- **종료 절차를 범용 콜백 목록으로 구성**: RPC 먼저·stream 나중 순서가 등록 순서에 의존한다.

## 6. 한계

- `api.dispose()`는 Main 문서 세션을 retire하지 않는다. Main은 cancel·unsubscribe를 받을 뿐이고 세션은 수명 사건까지 남는다.
- cancel은 best-effort다. 전송이 실패하거나 handler가 `signal`을 무시하면 Main handler는 끝날 때까지(또는 `maxRpcDurationMs`까지) RPC slot을 점유한다([09. 세션 자원 한도](09-resource-limits.md)).
- API 전체 차원의 끊김 신호(`api.closed`, `onDisconnect`)는 없다. Main 쪽 종료는 개별 stream terminal과 RPC 오류로만 드러난다.
- bind `dispose()`는 서버도 끝낸다. 서버를 bind보다 오래 살리거나 다른 bind에 다시 연결할 수 없다. 다시 연결하려면 새 `createBridgeServer`와 `bindElectronBridge`를 만든다.
- 서버 dispose 뒤 retired 기록은 서버 객체가 수거될 때까지 메모리에 남는다. dispose 뒤 admission은 모두 거부되므로 기록이 판정에 쓰이지는 않는다.

## 7. 관련 문서

- ADR: [0005 Renderer API 모양(`dispose` 이름)](../adr/0005-renderer-api-shape.md), [0006 종료 계약](../adr/0006-shutdown-contract.md), [0013 배선 기본값(`pagehide` dispose 제거)](../adr/0013-wiring-defaults.md), [0020 retire 시 stream 종료 통지](../adr/0020-stream-terminal-on-retire.md), [0022 Renderer 진단](../adr/0022-renderer-diagnostics.md)
- 설계 문서: [02. Renderer API](02-renderer-api.md), [04. 문서 세션](04-document-session.md), [05. RPC](05-rpc.md), [06. Main 스트림 전달](06-stream-delivery.md), [07. Renderer 스트림과 State](07-renderer-streams.md), [09. 세션 자원 한도](09-resource-limits.md), [11. 진단](11-diagnostics.md)
