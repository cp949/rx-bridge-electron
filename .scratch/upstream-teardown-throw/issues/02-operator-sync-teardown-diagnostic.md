# operator를 거친 source의 동기 방출 teardown 예외가 진단 없이 버려진다

- Status: open — 한계로 문서화됨. 해결 여부 미결정.
- 출처: RD-045 리뷰(2026-09-26, `dev` @ `42d3144`). ADR 0025 "한계" 첫 항목.

## 사실

- RD-045 결정 3: `Upstreams.#subscribe`(`src/main/upstreams.ts`)는 `source.subscribe(upstream)`가
  던졌고 upstream이 이미 `closed`면, 그 예외를 teardown 예외로 보고 `onTeardownError(key)`를 부른다.
  source의 subscribe 함수가 돌려준 teardown을 rxjs가 그 자리에서 실행하는 경우다(`Subscription.add`가
  닫힌 구독에 붙는 teardown을 즉시 실행한다).
- operator를 거친 source(`inner.pipe(map(...))`)에서는 예외가 `#subscribe`까지 오지 않는다. 안쪽 source가
  구독 중 동기로 complete하고 teardown이 throw하면, rxjs `operate`(`internal/util/lift.js:16-17`)의
  catch가 `this.error(err)`로 넘긴다. `this`는 이미 stop된 upstream `Subscriber`다.
  `Subscriber.error`는 `isStopped`이면 `handleStoppedNotification`으로 보내고(`internal/Subscriber.js:55-56`),
  기본 `config.onStoppedNotification`은 `null`이라 알림이 버려진다.
- 결과: 예외는 밖으로 새지 않지만 `upstream-teardown-failed` 진단이 0건이다. 값과 terminal 전달은
  정상이다(`subscribed → batch → complete`).
- 해지 경로(RD-045 결정 1)는 영향이 없다. operator 체인도 해지 예외가 `UnsubscriptionError`로
  올라와 `#release`가 기록한다(실측).
- 고정 test: `packages/rx-bridge-electron/test/main/upstream-teardown-throw.test.ts` "operator를 거친
  scoped Event가 구독 중 동기로 끝나고 teardown이 throw하면 예외 없이 끝나지만 진단은 남지 않는다"
  (`teardownFailures()`가 `[]`임을 단언).

## 해결 후보 (미검증)

1. `config.onStoppedNotification` 전역 hook: rxjs 전역 설정이라 앱 전체의 stopped 알림을 가로챈다.
   라이브러리가 전역 설정을 바꾸는 것은 부적절하다. 비추천.
2. upstream을 `Subscriber` 하위 클래스로 만들고 `error`를 override해 `isStopped`일 때 도착한 error를
   잡는다. `#subscribe` 호출 중에만 teardown 예외로 간주하는 flag를 둔다. 문제: 구독 중 stop 뒤 도착한
   error가 teardown 예외인지, 규약을 어긴 source의 늦은 `error`인지 구분할 수 없다.
3. 한계로 유지한다(현 상태). 발생 조건이 좁다: operator 경유, 구독 중 동기 terminal, throw하는 teardown이
   모두 겹쳐야 한다.

## 범위

- 결정 대상: 후보 2를 채택할지, 후보 3으로 닫을지.
- 채택하면 위 고정 test의 기대를 진단 1건으로 바꾸고, ADR 0025 한계 항목을 개정한다.

## Comments
