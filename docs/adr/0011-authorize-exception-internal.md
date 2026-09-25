# `authorize` 예외는 RPC·stream 모두 `INTERNAL`로 응답한다

## 상황

`createBridgeServer`의 `authorize` 콜백이 throw하거나 reject할 때 두 경로의 응답이 달랐다.

- RPC(`dispatchRpc`): 요청이 취소되지 않았으면 예외를 다시 던졌다. 예외는 `bindElectronBridge`의 rpc 핸들러 catch까지 올라가 `protocolError` 폴백인 `INVALID_ARGUMENT "Invalid bridge request."`가 됐다. Main deadline이 걸려 있어도 `Promise.race`가 즉시 reject되어 같은 폴백으로 갔다.
- stream(`controlStream`): `subscribed` 다음 `INTERNAL "Internal bridge error."` `error`를 보내고 슬롯을 반환했다.

`INVALID_ARGUMENT`는 요청 envelope나 입력이 규칙을 어겼다는 뜻이다. `authorize`는 호스트 애플리케이션 코드이고, 그 실패는 Renderer가 보낸 요청의 형식과 무관하다. RPC 경로는 Renderer에 원인을 잘못 알렸다. RD-007([ADR 0010](0010-operational-diagnostics.md)) 작업 중 이 불일치를 확인하고 범위 밖으로 남겼다. ROADMAP RD-009.

## 결정

1. **응답 코드**: `authorize` 예외는 RPC·stream 모두 `INTERNAL "Internal bridge error."`로 응답한다. handler가 선언되지 않은 예외를 던질 때와 같은 분류다.
2. **취소 우선**: 예외 시점에 요청이 이미 abort됐으면(Renderer cancel, 세션 retire, Main deadline) RPC는 `CANCELLED`로 응답한다(기존 동작 유지). deadline이 먼저 확정했으면 `DEADLINE_EXCEEDED` 응답이 이긴다.
3. **처리 위치**: `dispatchRpc`가 직접 응답을 만든다. 예외를 adapter로 전파하지 않는다. adapter의 `protocolError` 폴백은 `dispatchRpc`의 예상하지 못한 예외에만 남는다.
4. **진단**: `authorize` 예외는 `rejected` 이벤트를 기록하지 않는다(ADR 0010 결정 유지). RPC는 `rpc-finished`를 `outcome: "error"`로 1회 기록한다. `Error` 객체와 message는 어떤 이벤트에도 싣지 않는다.
5. **자원**: 예외 응답 뒤 RPC 슬롯과 구독 슬롯을 반환한다.

_(개정: RD-033 — 결정 1·2·4의 규칙(예외 → `INTERNAL`, 취소 우선, 예외는 `rejected` 미기록)과 `authorize-denied` 진단이 RPC·stream 공유 authorize 단계(`src/main/authorization.ts`) 한 곳에 모였다. 두 경로(`RpcRequests`·`Subscriptions`)는 이 단계가 돌려준 판정(`allowed`/`rejected(error)`/`cancelled`)을 RPC 응답이나 stream 프레임으로 번역만 한다.
`authorize`를 생략하면 판정은 동기다 — 요청은 같은 tick 안에서 진행한다(이전 두 경로 각각의 동작을 그대로 보존). `authorize`가 있으면 판정은 `authorize` settle 뒤 microtask 한 단계 늦게 도착한다(공유 단계의 Promise를 한 번 더 거친다). IPC cancel·deadline timer·webContents 수명 이벤트 같은 macrotask 경계와의 순서는 바뀌지 않는다.
stream 거부 진단(`authorize-denied`)은 이제 slot 반환 전에 기록된다(RPC와 같은 순서). sink가 이 진단을 받는 중에 동기로 detach·dispose하면, 이전에는 재평가된 `#endUnstarted(rejected)`가 통지를 냈지만 지금은 아직 등록된 pending `onAbort`가 `#endUnstarted(retired)`로 같은 통지를 낸다([ADR 0020](0020-stream-terminal-on-retire.md) 결정 2의 RD-032 note가 서술하는 창과 같다 — wire 출력(`subscribed`(0)+`CANCELLED`(1))은 바뀌지 않는다). 유일하게 달라지는 것은 sink 안에서 `getDiagnosticsSnapshot().subscriptions`를 읽으면 이 구독이 아직 pending으로 남아 있어 값이 1 더 크다는 점이다.)_

## 대안과 기각 사유

- **둘 다 `INVALID_ARGUMENT`**: 호스트 코드 실패를 요청 오류로 보고한다. Renderer가 입력을 고쳐 재시도해도 결과가 바뀌지 않는다.
- **둘 다 `FORBIDDEN`**: 권한 판정을 끝내지 못한 것과 거부한 것을 구분하지 못한다. `authorize-denied` 진단과도 어긋난다.
- **현 상태 유지(경로별 차이 허용)**: 같은 콜백의 같은 실패가 호출 종류에 따라 다른 코드가 될 근거가 없다.

## 한계

- Renderer는 `authorize` 예외와 handler의 비선언 예외를 구분하지 못한다. 둘 다 `INTERNAL`이다. 호스트가 원인을 알아야 하면 `authorize` 안에서 직접 기록한다.
