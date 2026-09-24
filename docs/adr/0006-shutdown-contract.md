# 종료(dispose)는 되돌릴 수 없는 최종 상태이고, Renderer와 Main 양쪽에서 진행 중 작업을 로컬로 확정한다

`docs/adr/0005-renderer-api-shape.md`는 Renderer 루트에 `api.dispose()`(및 같은 참조인 `api[Symbol.dispose]`)를 두기로 이름과 존재만 결정하고, 종료가 실제로 무엇을 하는지는 의도적으로 비워 두었다. 이 문서는 그 의미를 Renderer `api.dispose()`, Main `server.dispose()`, bind `dispose()` 세 지점에 대해 고정한다. 호환성은 유지하지 않는다 — breaking을 허용하고, 이전 방법은 마지막 절에 적는다.

## Renderer: `api.dispose()`

진행 중인 RPC(아직 확정되지 않은 promise)는 `dispose()` 호출 시점에 로컬에서 즉시 `RemoteError("CANCELLED", "Renderer API is disposed.")`로 reject한다. 이미 존재하는 `CANCELLED` 코드를 재사용하고 새 코드를 추가하지 않는다 — 호출자 입장에서 `AbortSignal`에 의한 취소와 `dispose()`에 의한 취소를 구분해서 얻을 실익이 없고, 오류 코드 union을 넓히면 모든 소비자의 판별 로직이 늘어난다. 이미 `transport.invoke`로 전송된 RPC에는 기존 cancel 메시지를 1회 best-effort로 보낸다 — Main이 실제로 취소를 인지하면 좋지만, transport 예외는 삼키고 로컬 확정은 전송 성공 여부에 의존하지 않는다. `dispose()` 이후에 호출된 RPC는 `transport.invoke`를 아예 호출하지 않고, 이미 확정된 것과 같은 오류로 reject된 Promise를 반환한다. 동기 throw는 하지 않는다 — 기존 RPC 호출 계약이 항상 Promise를 반환하는 것과 맞춘다.

`dispose()` 이후의 `subscribe()`는 control 메시지를 Main에 보내지 않고, 현행처럼 오류를 동기로 전달한다. 다만 코드·메시지를 `INTERNAL "Renderer stream client is disposed."`(현재 `StreamMultiplexer`의 구현, `packages/rx-bridge-electron/src/renderer/stream-multiplexer.ts`)에서 `CANCELLED "Renderer API is disposed."`로 바꾼다 — RPC와 stream이 같은 코드·같은 문구를 쓰게 해서 "이 API 인스턴스는 종료됐다"는 하나의 사실을 하나의 오류로 표현한다.

`dispose()` 시점에 이미 활성 상태인 스트림(구독 중인 `RemoteState`/`RemoteEvent`)은 현행 동작을 유지한다: generation마다 `unsubscribe`를 1회 전송한 뒤 `error`가 아니라 `complete()`한다. `RemoteState`의 snapshot 전이(`stale`/`uninitialized`)도 현행을 유지한다. `complete()`를 선택한 이유는 이것이 소유자가 의도한 정상 종료이기 때문이다 — 구독자 입장에서 스트림이 끊긴 게 아니라 다 쓴 것이다. 반면 종료 후 `subscribe()`를 시도하는 것은 오류다 — 조용히 빈 `complete()`를 주면 "종료된 API를 계속 쓰고 있다"는 프로그래밍 오류가 로그 없이 묻힌다.

### 구현 구조

`RpcClient`(`packages/rx-bridge-electron/src/renderer/rpc-client.ts`)에 pending 요청 레지스트리와 `dispose()`를 추가한다. 루트 dispose 함수는 `rpcClient.dispose()`를 호출한 다음 `streams[Symbol.dispose]()`(현재 `create-renderer-api.ts`가 이미 호출하는 `StreamMultiplexer`의 dispose)를 호출한다. `api.dispose`와 `api[Symbol.dispose]`는 계속 같은 함수 참조를 가리킨다(0005의 결정 유지). 루트 `AbortController`를 모든 개별 call의 `signal`에 합성하는 방식은 채택하지 않는다 — 그러면 개별 RPC가 스스로 넘긴 signal과 루트 종료 signal을 구분할 수 없게 되고, `dispose()`가 하는 일이 "합성된 abort"라는 간접적인 경로를 타게 된다. pending 레지스트리를 직접 순회해 reject하는 편이 종료 경로를 명시적으로 유지한다.

### 종료 순서와 재진입

`dispose()`는 다음 순서로 실행한다.

1. 종료 플래그를 설정한다.
2. pending RPC 목록을 스냅샷한다.
3. 스냅샷한 RPC마다 cancel을 전송한 뒤 로컬에서 reject한다.
4. 스트림을 정리한다: `StreamMultiplexer`에 dispose 플래그를 설정하고, IPC listener를 제거하고, generation마다 `unsubscribe` 전송 후 `complete()`를 호출한다.

이 순서에서 사용자 코드가 동기로 실행되는 지점은 4번의 `complete()` 콜백 하나뿐이다. RPC reject에 대한 사용자 반응은 Promise 콜백이라 microtask로 밀리며, 그 시점에는 이미 RPC(3번 결과)와 스트림(4번 결과) 양쪽이 종료 상태다. 따라서 `complete()` 콜백 안에서 사용자 코드가 `dispose()`를 다시 호출해도, 순서상 이미 지나간 3번·4번을 다시 실행하지 않는 no-op이 된다. 반복 `dispose()` 호출은 일반적으로도 no-op이다: cancel이나 unsubscribe를 추가로 전송하지 않는다. 같은 콜백 안의 `subscribe()`는 루프가 아직 `complete()`하지 않은 활성 generation이 있어도 그 generation에 합류하지 않는다. 합류하면 현재값 재생과 늦은 `complete()`를 받아 종료 후 subscribe 규칙이 깨진다. 따라서 종료 플래그를 generation 합류보다 먼저 검사해 동기 `CANCELLED` error로 끝내고, `RemoteState` snapshot은 바꾸지 않는다.

로컬에서 이미 확정된(reject된) RPC에 뒤늦게 Main 응답이 도착해도 caller에게 전달하지 않는다 — 기존 `settled` 가드(`rpc-client.ts`)를 그대로 쓴다. `dispose()` 이후 도착한 stream 메시지도 이미 listener를 제거했으므로 구독자에게 전달되지 않는다.

_(개정: RD-030 — 종료 플래그는 수명 객체(`src/renderer/api-lifetime.ts`) 하나가 소유하고, 모든 부작용(RPC 확정, stream 정리) 전에 한 번 확정한다. 위 "사용자 코드가 동기로 실행되는 지점은 4번의 `complete()` 콜백 하나뿐이다"라는 서술은 ADR 0022가 `rpc-settled`·`subscription-closed` 진단 sink를 추가하면서 깨졌다 — 두 sink도 부작용 도중 동기로 호출되는 사용자 코드 지점이다. 세 지점(`rpc-settled` sink, `subscription-closed` sink, `complete()` 콜백) 중 어디서 재진입해도 종료 뒤 규칙(RPC·subscribe는 전송 없이 동기 `CANCELLED`, `dispose()`는 no-op)을 따른다. "루트 dispose가 `rpcClient.dispose()` 다음 `streams[Symbol.dispose]()`를 호출한다"는 서술은 수명 객체가 ② RPC 확정 → ③ stream 정리를 실행하는 것으로 대체됐다 — 순서 자체는 같다.)_

_(개정: RD-031 — `dispose()` 뒤에는 해당 인스턴스가 그 어떤 control 메시지도 보내지 않는다. `closeAll`이 generation마다 보내는 unsubscribe 1회는 이 규칙의 예외다 — 이것은 종료 뒤에 벌어지는 부작용이 아니라 종료 절차 자체가 하는 일이다. `next` 콜백 안에서 `api.dispose()`가 호출되어 batch 전달이 아직 진행 중이던 경우의 acknowledge 전송도 이 금지 대상에 포함된다. 반면 로컬에서 마지막 구독자가 해제된 뒤 보내는 acknowledge는 그대로 유지한다 — 이것은 받아들인 batch에 대한 확인이지 종료 계약이 아니다. 억제한 acknowledge는 진단으로 기록하지 않는다. 근거는 ROADMAP.md#RD-031에 있다.)_

## Main: `server.dispose()`와 bind `dispose()`

`DocumentSessions`(`packages/rx-bridge-electron/src/main/document-sessions.ts`)의 `#disposing`은 현재 `dispose()`의 `finally`에서 `false`로 되돌아가는 재진입 가드일 뿐, 종료 후 상태를 표현하지 않는다. 이를 되돌아가지 않는 `#disposed`로 바꾼다. 이 이후:

- `attach()`는 `BridgeProtocolError("FORBIDDEN", "Bridge server is disposed.")`를 동기로 throw한다. 종료가 진행되는 도중(dispose 처리 자체가 아직 끝나지 않은 시점)에 재진입한 `attach()` 호출도 같다 — "종료 중"과 "종료됨"을 호출자 입장에서 구분할 이유가 없다.
- `establish()`와 `current()`는 예외를 던지지 않고 `undefined`를 반환한다. 이 두 함수는 종료 전에도 세션이 없을 때 `undefined`를 반환하는 함수이므로, 종료 후 상태를 같은 반환값으로 흡수한다.
- 반복 `dispose()` 호출은 no-op이다.
- `#retiredClients.clear()` 호출은 제거한다. `docs/architecture.md`는 "retire된 client ID는 같은 `webContents`의 새 문서 세션에서 재사용하지 않는다"고 규정하며, 서버 dispose 자체가 이 세션들이 다시 살아날 수 없게 만드는 사건이므로 retired 기록을 지울 이유가 없다. 지우면 (이론상 재사용이 없다는 전제가 깨졌을 때) 재사용 방지가 조용히 무력화된다. `destroyed` 수명 사건(해당 `webContents`가 실제로 파괴됨)이 오면 그 `webContentsId`의 기록은 지운다 — 재사용될 `webContents`가 더는 없기 때문이다. 살아 있는 `webContents`의 retired 기록은 무한히 쌓이지 않도록 `webContents`별 최근 N개(`maxRetiredClientsPerWebContents`, 기본 32)만 보관한다. 그보다 오래된 clientId는 기록에서 빠지지만, 그 시점 이후 재사용 방지는 `establish()`의 frame·origin 검사가 대신한다(오래된 문서는 이미 현재 main frame이 아니다). 세부 근거는 [ADR 0009](0009-session-resource-limits.md)에 있다.

종료 후 도착하는 요청은 새 오류 경로를 추가하지 않고 기존 거부 경로를 재사용한다. handshake는 `establish()`가 `undefined`를 반환하는 기존 분기를 타므로 `bindElectronBridge`의 handshake 핸들러가 이를 `protocolError` 폴백으로 잡아 `INVALID_ARGUMENT`(`BridgeProtocolError`)로 응답한다(`electron-adapter.ts`의 현행 handshake 오류 처리 경로, 변경 없음). RPC는 `establish()`가 `undefined`를 반환하므로 `dispatchRpc`가 이미 쓰는 `FORBIDDEN "Bridge sender is not authorized."` 응답으로 귀결된다. stream subscribe는 `controlStream`이 `establish()`/`current()`의 `undefined`를 만나 무시하는 기존 흐름을 그대로 탄다.

bind `dispose()`(`electron-adapter.ts`의 `bindElectronBridge` 반환값)는 자신의 종료 플래그를 둔다. 반복 호출은 no-op이다. 종료 후 `attach()`는 `BridgeProtocolError("FORBIDDEN", "Electron bridge is disposed.")`를 동기로 throw한다. listener 제거 방식을 바꾼다: 현재 `dispose()`는 `ipcMain.removeAllListeners(channels.cancel)`/`removeAllListeners(channels.control)`를 쓰는데, 이는 같은 채널에 다른 코드가 등록한 listener까지 지운다. bind가 직접 등록한 cancel/control listener의 참조만 `removeListener`로 제거하도록 바꾼다. invoke 채널(handshake, rpc)은 현행대로 `removeHandler`를 쓴다 — 채널당 handler는 하나뿐이라 다른 listener를 오염시킬 여지가 없다.

## 범위 밖

Main이 스트림을 닫을 때 Renderer에 terminal 메시지를 통지하는 프로토콜 확장은 이 문서의 범위 밖이다. 현재 Main 쪽 종료·retire는 Renderer에 능동적으로 알리지 않으며, 이는 별도 후속 과제로 남긴다. 이 문서는 새 오류 코드를 도입하지 않는다 — Renderer는 `CANCELLED`, Main은 `FORBIDDEN`/`INVALID_ARGUMENT` 기존 코드만 쓴다.

_(개정: ADR 0020 — 문서가 살아있는 채로 세션이 끝나는 경우(detach·`server.dispose()`·bind `dispose()`)에 한해 이 과제를 처리했다. 활성·`authorize` 대기 구독은 `error CANCELLED`, retire 뒤 새 subscribe는 `error FORBIDDEN`을 받는다 — 새 오류 코드는 추가하지 않았다. navigation·`render-process-gone`·`destroyed`처럼 문서 자신이 함께 사라지는 retire와 API 전체 차원의 끊김 신호는 여전히 범위 밖이다.)_

## 이전(migration)

- `dispose()` 호출 뒤에도 진행 중이던 RPC의 결과를 기다리던 코드는, `dispose()` 전에 해당 RPC를 `await`하도록 순서를 바꾼다. `dispose()` 이후에는 그 RPC가 `CANCELLED`로 확정된다.
- 종료 후 `subscribe()` 오류를 `INTERNAL` 코드로 판별하던 코드는 `CANCELLED`로 바꾼다.
- Main에서 `server.dispose()` 또는 `bindElectronBridge(...).dispose()` 호출 뒤 같은 인스턴스를 다시 `attach()`해 재사용하던 코드는 없어야 한다 — 종료는 되돌릴 수 없으므로, 다시 연결하려면 새 `createBridgeServer`와 새 `bindElectronBridge`를 만든다.

이 결정과 근거는 이 문서와 README의 dispose 절에 반영한다. `docs/adr/0005-renderer-api-shape.md`는 수정하지 않는다 — 그 문서가 결정한 "이름과 존재"는 이 문서가 다루는 "의미"와 층이 다르다.

`dispose()`를 호출하지 않아도 navigation·창 파괴 시 Main이 세션을 이미 retire하므로, hello-world 배선에서 `dispose()`를 자동 호출하는 `pagehide` 등록은 불필요하다 — `dispose()`는 브리지 생존 중 SPA teardown 용도로 쓴다. 근거는 [ADR 0013](0013-wiring-defaults.md)에 있다.
