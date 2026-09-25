# 사용자 source teardown throw가 `Upstreams.disconnect` 밖으로 샌다

- Status: 승격 (ROADMAP.md#RD-045)
- 출처: 아키텍처 리뷰 04 카드 05 그릴링(2026-09-25, `82cfbda` 기준) 곁가지 발견.

## 사실

- rxjs 7(`^7.8.x`)의 `Subscription.unsubscribe()`는 teardown이 throw하면 `UnsubscriptionError`를
  던진다(Node 실행 확인: `UnsubscriptionErrorImpl 1 errors occurred during unsubscription`).
- `Upstreams.disconnect`(`src/main/upstreams.ts:106`, `:112`)는 `unsubscribe()`를 catch 없이 부른다.
- 공유 갈래는 `members.delete` 뒤 `upstream.unsubscribe()`를 부르고, 그다음에 `#shared.delete`를 한다
  (`upstreams.ts:110-114`). 순서상 throw하면 `#shared.delete`가 실행되지 않는다.
- `Subscriptions.#close`(`src/main/subscriptions.ts:582-596`)는 lease 반납·map 정리 뒤 마지막 줄에서
  `disconnect`를 부른다.
- `AbortSignal` listener 안의 throw는 `abort()` 호출자에게 가지 않고 `uncaughtException`으로 간다
  (Node 실행 확인).

## 가설 (재현 대상)

1. retire 연쇄(navigation·destroyed·`"replaced"`)에서 consumer close가 abort listener 안에서 돌면
   teardown throw가 Main의 `uncaughtException`이 된다.
2. 공유(state·broadcast event) upstream teardown이 throw하면 `#shared`에 해지된 entry가 남는다. 같은 key의
   다음 구독이 그 entry에 붙어 값을 받지 못한다.
3. `Subscriptions.dispose()`의 consumer 순회가 첫 throw에서 멈춘다. 뒤 consumer가 닫히지 않고
   `server.dispose()`·`bindElectronBridge(...).dispose()`가 throw한다.
4. `#send`의 catch 안 `#close`에서 throw하면 fan-out(`Upstreams.#fanOut`)으로 전파된다.
5. `controlStream` unsubscribe 경로는 최종 catch(`create-bridge-server.ts:241`)가 조용히 삼킨다. 이 경로의
   상태 정리는 `disconnect` 전에 끝나므로 누수는 가설 2에 한정된다.

## 범위

- 재현: teardown이 throw하는 scoped·broadcast·state source로 가설 1~4를 test로 확인한다.
- 재현되면 팀 결정: teardown 예외를 삼킬지, 진단 이벤트로 남길지(`BridgeDiagnostic` 확장은 ADR 0016의
  sink breaking 제약 확인), 정리 순서를 바꿀지.

## Comments

- 2026-09-26 재현(`dev` @ `907c0e9`). test: `packages/rx-bridge-electron/test/main/upstream-teardown-throw.test.ts`(10건, 미커밋). teardown이 해제 뒤 throw하는 source로 10/10 RED, 같은 파일에서 throw만 뺀 대조 실행은 10/10 통과.
  - 가설 1 재현: `main-frame-navigation`·`render-process-gone`·`destroyed`·`replaced` retire 모두 `UnsubscriptionError`가 `uncaughtException`으로 간다. 경로: `AbortSignal.wrapper`(`document-sessions.ts:74`) → `session-slots.ts:82` → `onSessionAbort`(`subscriptions.ts:470`) → `#close`(`:595`) → `Upstreams.disconnect`(`upstreams.ts:106` scoped, `:112` shared). slot·구독 수 정리는 끝난다(`subscriptions` 0).
  - 가설 2 재현: `controlStream` unsubscribe로 해제하면 예외는 최종 catch가 삼키지만 `#shared` entry가 남는다. 재구독은 upstream을 다시 구독하지 않는다(source 구독 1회). broadcast Event는 이후 값 0건(`["subscribed"]`), State는 늦은 합류 `getValue()` 1건만 받고 이후 변경을 받지 못한다(`["subscribed","batch"]`). 전송 실패 close 경로(가설 4)에서도 같은 잔존이 생긴다.
  - 가설 3 기각(형태 변경): `server.dispose()`는 던지지 않고 두 구독 모두 닫힌다. `sessions.dispose()`의 retire가 abort listener 안에서 consumer를 먼저 닫아 `Subscriptions.dispose()` 순회에 남는 consumer가 없다. 대신 구독 수만큼 `uncaughtException`이 난다(가설 1과 같은 경로, 여기서는 `#send` → `#close` 경유).
  - 가설 4 재현, 예상보다 큼: 전송 실패 → `#send` catch → `#close` → `disconnect`의 `UnsubscriptionError`가 rxjs 미처리 오류 보고로 가지 않고 **사용자 producer 호출(`subject.next(1)`)로 동기 전파**된다. `Upstreams`가 `new Subscriber(observer)`로 upstream을 만들어 `SafeSubscriber`/`ConsumerObserver` 격리가 없기 때문이다. 같은 `Subject`의 뒤 구독자(앱 코드)는 그 값을 받지 못한다(`[]`).
  - 결정 필요: (a) `disconnect`에서 teardown 예외를 격리(정리 순서를 map 삭제 먼저로 바꾸고 예외는 삼키거나 rxjs `config.onUnhandledError`/`reportUnhandledError`로 보고), (b) 진단 이벤트 추가(ADR 0016 sink breaking 제약), (c) upstream observer 예외 격리(가설 4의 producer 전파) 범위 포함 여부.
- 2026-09-26: 사용자 결정 "진단 이벤트 추가"로 ROADMAP.md#RD-045로 승격. 결정 기록은 [ADR 0025](../../../docs/adr/0025-upstream-teardown-isolation.md).
