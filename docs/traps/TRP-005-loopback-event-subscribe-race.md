# TRP-005 loopback transport로 broadcast event를 구독하면 미묘한 경합이 생긴다

- 상태: ACTIVE
- 적용 조건: `@cp949/rx-bridge-electron/testing`의 `createLoopbackTransport`로 만든 transport에서 broadcast event(state가 아닌, replay 없는 event)를 구독한 직후 곧바로 값을 emit할 때.

`createLoopbackTransport`의 `control()`은 `queueMicrotask`로 실제 server 호출(`controlStream`)을 미룬다. broadcast event source는 state와 달리 현재 값을 재전송하지 않으므로, 구독 직후 곧바로 `Subject.next(...)` 등으로 값을 밀어 넣으면 실제 server 측 upstream 구독이 아직 microtask queue에 대기 중이라 그 값을 놓친다. state 구독은 `currentValueSource`가 현재 값을 다시 보내주므로 이 경합이 드러나지 않는다 — event만 걸린다.

## 오해하기 쉬운 신호

- 가끔씩만 실패하는 event test(구독 직후 emit하는 패턴에서). microtask 스케줄링 타이밍 차이로 환경에 따라 통과·실패가 뒤바뀔 수 있다.

## 원인

`control()`이 microtask 하나를 미루고, 그 안에서 다시 `server.controlStream`을 `void`로 fire-and-forget 호출한다. 실제 upstream 구독은 그 호출 체인 안쪽에서 일어나므로 최소 1 microtask tick 뒤에야 확정된다.

## 탐지/회피

event 구독 뒤 값을 emit하기 전에 microtask flush(예: `await new Promise((r) => setTimeout(r, 0))` 또는 "subscribed" 메시지 도착 확인)를 끼운다. state 구독은 현재 값을 재전송하므로 이 문제가 없다.
