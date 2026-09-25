# 사용자 source의 teardown 예외를 `Upstreams`가 격리하고 `upstream-teardown-failed` 진단으로 기록한다

- 관련: ROADMAP.md#RD-045

## 상황

Main의 State·Event 구독은 내부 module `Upstreams`가 사용자 source(`currentValueSource`·`broadcastEvent`·`scopedEvent`)에 연결한다. 구독이 끝나면 `Upstreams.disconnect`가 upstream `Subscriber`를 `unsubscribe()`한다. rxjs 7은 teardown이 throw하면 모든 finalizer를 실행한 뒤 `UnsubscriptionError`를 다시 던진다. 수정 전 `disconnect`는 이 호출을 catch 없이 불렀다.

2026-09-26 재현(`test/main/upstream-teardown-throw.test.ts`, teardown이 해지 뒤 throw하는 source. 같은 test에서 throw만 빼면 전부 통과)으로 다음 결함을 확인했다.

- **Main `uncaughtException`.** 세션 retire(`main-frame-navigation`·`render-process-gone`·`destroyed`·`replaced`)와 `server.dispose()`는 세션의 `AbortSignal` listener 안에서 consumer를 닫는다. listener 예외는 호출자에게 가지 않고 Node `EventTarget`이 `uncaughtException`으로 보낸다.
- **공유 entry 잔존.** 공유 갈래(State·broadcast Event)는 `unsubscribe()` 뒤에 key map에서 entry를 지웠다. 해지가 던지면 해지된 entry가 남는다. 같은 key의 다음 구독은 upstream을 다시 구독하지 않고 그 entry에 붙는다. broadcast Event는 이후 값을 하나도 받지 못하고, State는 늦은 합류 `getValue()` 1건 뒤 변경을 받지 못했다. unsubscribe 경로에서는 `controlStream`의 최종 catch가 예외를 조용히 삼켜 이 잔존이 드러나지 않았다.
- **사용자 producer로 동기 전파.** 전송 실패 뒤 close에서 난 예외가 upstream observer를 거슬러 사용자 코드의 `subject.next(...)` 호출로 던져졌다. `Upstreams`가 `new Subscriber(observer)`로 upstream을 만들어 rxjs `SafeSubscriber`의 예외 격리가 없기 때문이다. 같은 `Subject`의 뒤 구독자(앱 코드)는 그 값을 받지 못했다.
- `server.dispose()` 자체는 던지지 않았다. `DocumentSessions.dispose()`의 retire가 abort listener 안에서 consumer를 먼저 닫아 `Subscriptions.dispose()` 순회에 남는 consumer가 없기 때문이다. 예외는 위 첫 항목의 `uncaughtException`으로 나타났다.

조사 중 teardown throw와 무관한 순서 결함도 드러났다. 옛 순서(해지 → map 삭제)에서 teardown이 같은 key를 동기로 다시 구독하면, 새 구독이 해지 중인 entry에 붙은 뒤 그 entry가 map에서 지워져 고아가 됐다.

## 결정

1. **격리 위치는 `Upstreams` 하나.** upstream 해지는 private 함수 `#release(upstream, key)` 한 곳을 거친다(scoped 갈래, 공유 갈래 마지막 member, 첫 member가 subscribe 중 빠진 경우). `unsubscribe()` 예외를 잡아 밖으로 내보내지 않는다. 호출자(`Subscriptions`)의 `disconnect` 호출 지점은 바꾸지 않는다.
2. **공유 entry는 해지 전에 map에서 지운다.** 순서는 `members.delete` → (비었고 map의 현재 entry가 이 entry이면) map 삭제 → 해지다. 해지 중 teardown이 같은 key로 연결해도 새 entry와 새 upstream을 만든다.
3. **동기 방출 중 이미 닫힌 upstream.** source가 구독 중 동기로 complete·error를 내거나 sink가 동기로 끊으면, rxjs는 subscribe 함수가 나중에 돌려준 teardown을 그 자리에서 실행한다. 그 예외는 `source.subscribe(...)` 호출 밖으로 나온다. `Upstreams`는 이 호출이 던졌을 때 upstream이 이미 `closed`면 teardown 예외로 보고 1번과 같이 처리한다. `closed`가 아니면 기존대로 다시 던지고 `connect`가 정리한다.
4. **진단 이벤트 `upstream-teardown-failed`.** `BridgeDiagnostic`에 `{ type: "upstream-teardown-failed"; key: string }`를 추가한다. `key`는 등록 조회를 통과한 와이어 key다. `Error`·message·stack은 싣지 않는다([ADR 0010](0010-operational-diagnostics.md) §3). 실패한 해지 1회에 1건이다. 공유 upstream은 마지막 member가 빠질 때 1건, scoped upstream은 구독마다 1건이다.
5. **`Upstreams`는 sink를 모른다.** 생성자 인자 `onTeardownError(key)` 콜백으로만 알린다(생략하면 조용히 삼킨다). `Subscriptions`가 이 콜백을 `recordDiagnostic`에 잇는다. sink 예외 격리([ADR 0010](0010-operational-diagnostics.md) §11)는 그대로 적용된다.
6. **진단 순서.** `Subscriptions`의 close 순서(`subscription-closed` 기록 → slot 반납 → consumer `AbortSignal` abort → `disconnect`)는 바꾸지 않는다. 그래서 `upstream-teardown-failed`는 그 구독의 `subscription-closed` 뒤에 올 수 있다. "한 구독의 진단은 `subscription-closed` 뒤에 나오지 않는다"([ADR 0010](0010-operational-diagnostics.md) §13 개정)는 구독 단위 진단(`stream-queue`·`stream-dropped`)에 대한 규칙이다. 이 이벤트는 upstream 단위라 그 규칙의 대상이 아니다.

## 대안과 기각 사유

- **진단 없이 삼키기만.** 사용자 source의 결함이 조용히 사라진다. 기각. 운영자가 key 단위로 관측할 수 있어야 한다.
- **upstream을 `SafeSubscriber`(plain observer를 넘긴 `subscribe`)로 만들어 observer 예외 전체를 rxjs 미처리 오류 보고로 넘기기.** producer 전파(세 번째 결함)는 막지만, 예외가 `config.onUnhandledError`(기본 `setTimeout` throw)로 가서 Main `uncaughtException`이 된다. 앞의 두 결함도 해결하지 못한다. 기각. 수정 뒤 observer 경로의 동기 예외 지점(출력 검증, 창 콜백, 진단 기록, `send`, `disconnect`)은 모두 catch된다.
- **`#close`에서 `disconnect`를 `subscription-closed` 기록 앞으로 옮기기.** 진단 순서 규칙을 그대로 지킬 수 있다. 대신 사용자 teardown이 consumer `AbortSignal` abort보다 먼저 실행되는 관측 가능한 순서 변경이 생긴다. 기각.

## 한계

- 사용자가 `BridgeContext.signal`에 붙인 abort listener의 예외는 여전히 Node `EventTarget`이 `uncaughtException`으로 보낸다. 사용자 코드 자체의 예외이며 이 결정의 범위 밖이다.
- 진단은 key만 싣는다. 어떤 구독·세션의 해지였는지는 알 수 없다([ADR 0010](0010-operational-diagnostics.md) 한계와 같다).

## 범위 밖

source의 `complete`/`error` 처리 변경, RPC 경로, upstream observer 전체의 예외 격리.

## 관련 ADR

- [ADR 0010](0010-operational-diagnostics.md) — 진단 이벤트 목록과 기록 금지 규칙. 이 ADR이 이벤트 1종을 추가했다(§4 개정 표시).
- [ADR 0020](0020-stream-terminal-on-retire.md) — retire 때 구독 종료 통지. 통지 뒤 close가 이 격리를 거친다.
