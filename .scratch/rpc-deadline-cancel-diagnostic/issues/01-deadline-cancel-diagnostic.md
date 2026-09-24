Status: closed — 선택지 1(먼저 확정된 원인 하나만 기록) 적용, 역방향(cancel 뒤 deadline)도 함께 처리

# deadline 만료 뒤 Renderer cancel이 rpc-cancelled를 추가 기록한다

- 출처: RD-016 그릴링 결정 9·12(`_works/_completed/20260924-10-rpc-request-lifecycle/`)

## 현상

Main deadline이 만료되면 요청 controller를 abort하고 `rpc-timed-out`을 기록한 뒤 `DEADLINE_EXCEEDED`로 응답한다. active entry는 ADR 0009 §10에 따라 handler가 끝날 때까지 남는다. 그 사이 Renderer가 같은 `requestId`로 `cancel`을 보내면(Renderer 로컬 timeout 만료·사용자 abort) entry를 찾아 `rpc-cancelled`를 한 번 더 기록한다. 한 요청이 `rpc-timed-out`과 `rpc-cancelled`를 모두 남긴다.

## 영향

진단 소비자가 "취소된 요청 수"와 "deadline 만료 요청 수"를 합산하면 이중 계산한다. 응답·slot·`rpc-finished`에는 영향이 없다.

## 선택지(미결정)

- deadline 만료 시 entry를 "확정됨"으로 표시해 이후 cancel을 진단 없이 무시한다(slot은 handler 종료까지 유지).
- 현재 동작을 유지하고 ADR 0010에 "한 요청이 두 이벤트를 남길 수 있다"를 명시한다.

## 고정 test

RD-016 DELTA-01이 현재 동작을 `diagnostics-outcome.test.ts`의 characterization test로 고정했다. 동작을 바꾸면 그 test를 함께 바꾼다.

## Comments

- 2026-09-25: 선택지 1로 해결. ADR 0010 §8은 이미 "deadline 만료는 `rpc-cancelled`를 기록하지 않는다"고 정해 두었고, 현재 동작이 이 조항을 어기고 있었다. 같은 결함의 역방향(취소 뒤 signal을 무시한 handler가 deadline을 넘기면 `rpc-timed-out` 추가 기록)도 함께 고쳤다. deadline 타이머는 signal이 이미 aborted면 `cancelledIfAborted`로 `CANCELLED`를 응답하고 진단을 남기지 않는다. `#cancelActive`는 active에 남은 entry의 controller가 이미 aborted(=deadline 확정)면 정리만 한다. characterization test를 새 규칙으로 바꾸고 retire·역방향 test를 추가했다(`diagnostics-outcome.test.ts`). ADR 0010 §8, ADR 0015 범위 밖, 패키지 README 호환성 변경 11을 갱신했다.
