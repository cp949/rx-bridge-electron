Status: open

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
