# 사용자 source teardown throw가 `Upstreams.disconnect` 밖으로 샌다

- Status: open — 재현 전(가설). 재현 test(RED)부터 시작하고, 재현되지 않으면 닫는다.
- 출처: `_works/arch-review/04.html` 카드 05 그릴링(2026-09-25, `82cfbda` 기준) 곁가지 발견.

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
