# `stream-dropped` 도중 retire 시 `subscription-closed` 뒤 `stream-queue`가 1건 더 기록된다

- Status: closed (RD-040)
- 출처: RD-034 `_works/20260925-11-delivery-window/` DELTA-01 characterization test ①(실측 고정), 설계 판단은 같은 작업의 checklist 결정 13.

## 배경

Event consumer가 overflow로 값을 드롭하는 도중(`stream-dropped` 진단을 받는 중) 진단 sink가
동기로 detach(또는 session retire)를 일으키면, 진단 순서가 다음과 같다(`drop-oldest`/`error`
정책 모두 동일):

```
..., stream-dropped(count 1), session-closed, subscription-closed, stream-queue(depth 2)
```

`subscription-closed`가 기록된 뒤에 같은 consumer의 `stream-queue` 진단이 1건 더 나간다.
구독이 이미 닫힌 뒤에 그 구독에 대한 큐 깊이 진단이 기록되는 셈이라, 진단을 시간순으로
재구성해 소비하는 쪽에서는 "닫힌 구독에 대한 이벤트"로 보인다.

원인은 `DeliveryWindow.accept()`(`packages/rx-bridge-electron/src/main/delivery-window.ts`)의
callback 순서다: push 뒤 `onDropped`(dropped > 0일 때) → `onQueueDepth`(push 뒤 depth)를
**항상 순서대로 모두 호출한 다음에** 창 상태를 재확인한다. `onDropped` 콜백 안에서 sink가
동기로 detach를 호출하면 그 안에서 session retire → `session-closed` → `subscription-closed`까지
동기로 끝나 버리지만, 창은 이미 시작한 `accept()` 호출을 마저 진행해 `onQueueDepth`를 호출한다.
그 결과 `subscription-closed` 뒤에 `stream-queue`가 한 번 더 찍힌다.

## 왜 RD-034에서 고치지 않았나

RD-034 checklist "범위(제외)"에 이 항목을 명시적으로 pending-issue로 남기기로 이미 정해 뒀고,
"확정된 설계 결정" 13번이 "창은 push 뒤 `onDropped`·`onQueueDepth`를 모두 호출한 다음에
상태를 확인한다"를 그 RD의 보존 대상으로 명시했다. RD-034의 동작 변경은 결정 12(shift 뒤
재진입 batch 결함) 1건으로 한정했고, 이 순서를 바꾸는 것은 별도의 동작 변경 결정이라 범위에
포함하지 않았다.

## 재발 조건

Event consumer가 `drop-oldest`·`drop-newest`·`error` 어떤 overflow 정책이든, 진단 sink가
`stream-dropped` 진단을 받는 도중 동기로 그 구독(또는 세션)을 종료시킬 때.

## 다음 단계

`DeliveryWindow.accept()`에서 `onDropped` 콜백 실행 직후 창이 이미 닫힘/종결 상태가 됐는지
확인해, 그렇다면 이어지는 `onQueueDepth` 호출을 생략하는 방향을 검토한다. 다만 이는
RD-034 checklist 결정 6("효과 목록 반환형은 쓰지 않는다")과 결정 13이 함께 만든 현재 계약을
다시 여는 동작 변경이므로, 별도 RD/DELTA로 설계 논의부터 다시 시작해야 한다.

## Comments

- 2026-09-25: RD-034 DELTA-05 마무리 시점에 `_works/20260925-11-delivery-window/pending-issues/01.md`에서 이 이슈 트래커로 승격했다. RD-034 범위 밖 후속 작업으로 등록, 아직 착수하지 않았다.
- 2026-09-25: ROADMAP RD-040으로 승격했다. 계획은 `_works/20260925-17-dropped-queue-tail/`.
- 2026-09-25: RD-040에서 accept()의 onDropped 직후 guard로 해결.
