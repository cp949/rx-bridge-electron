# TRP-005 loopback transport로 broadcast event를 구독하면 미묘한 경합이 생긴다

- 상태: ACTIVE
- 적용 조건: `@cp949/rx-bridge-electron/testing`의 `createLoopbackTransport`로 만든 transport에서 broadcast event(state가 아닌, replay 없는 event)를 구독한 직후 곧바로 값을 emit할 때.

`createLoopbackTransport`의 `control()`은 `queueMicrotask`로 실제 server 호출(`controlStream`)을 미룬다. broadcast event source는 state와 달리 현재 값을 재전송하지 않으므로, 구독 직후 곧바로 `Subject.next(...)` 등으로 값을 밀어 넣으면 실제 server 측 upstream 구독이 아직 microtask queue에 대기 중이라 그 값을 놓친다. state 구독은 `currentValueSource`가 현재 값을 다시 보내주므로 이 경합이 드러나지 않는다 — event만 걸린다.

## 오해하기 쉬운 신호

- 구독 직후 emit한 event 값이 항상 빠진다. microtask 순서는 결정적이라 flaky하지 않고 매번 같은 결과가 난다 — "간헐 실패"로 보이면 이 trap이 아니라 다른 원인을 찾는다.
- loopback 고유 결함처럼 보이지만 아니다. preload 경로도 `control`이 IPC로 비동기 전달되므로 replay 없는 event를 구독 확정 전에 emit하면 같은 값을 놓친다. loopback은 이 비동기성을 microtask로 재현할 뿐이다.

## 원인

`control()`이 microtask 하나를 미루고, 그 안에서 다시 `server.controlStream`을 `void`로 fire-and-forget 호출한다. 실제 upstream 구독은 그 호출 체인 안쪽에서 일어나므로 최소 1 microtask tick 뒤에야 확정된다.

## 탐지/회피

event 구독 뒤 값을 emit하기 전에 macrotask 경계까지 한 번 진행한다(예: `await new Promise((r) => setTimeout(r, 0))`, transport를 직접 다루는 test라면 "subscribed" 메시지 도착 확인). 같은 이유로 구독 여부·횟수를 server 쪽에서 세는 단언도 이 경계 뒤에 둔다 — `control()` 직후 동기로 세면 재구독이 있어도 항상 통과한다. state 구독은 현재 값을 재전송하므로 이 문제가 없다.
