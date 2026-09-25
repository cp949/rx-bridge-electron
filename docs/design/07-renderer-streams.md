# 07. Renderer 스트림과 State

## 1. 목적과 범위

Renderer 문서 안에서 State/Event 로컬 구독자가 원격 구독을 어떻게 공유하고 끝내는지, `RemoteState` snapshot이 언제 무엇으로 바뀌는지, `snapshotStore`가 그 변화를 외부 store 계약으로 어떻게 옮기는지 정한다.

다루지 않는 것:

- Main 쪽 구독 수명주기, ack 게이트, sequence 부여, upstream 공유, State 현재값 재생: [06. Main 스트림 전달](06-stream-delivery.md)
- `subscriptionId` 형식과 Main 워터마크 판정: [06. Main 스트림 전달](06-stream-delivery.md)
- `api.dispose()`의 전체 절차와 재진입: [10. 종료](10-shutdown.md). 이 문서는 generation이 dispose를 만났을 때의 전이만 다룬다.
- 진단 이벤트 타입·기록 금지 항목: [11. 진단](11-diagnostics.md)
- stream 오류 코드 전체 표: [08. Payload와 오류 모델](08-payload-and-errors.md)

## 2. 모델

| 개념                  | 소유자(모듈)                                  | 역할                                                                                                                   |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| local generation      | `LocalGeneration` (`local-generation.ts`)     | operation key 하나의 로컬 구독자 집합과 원격 구독 하나를 묶는다. State면 snapshot 상태기계도 소유한다                  |
| `RemoteState<T>`      | `RemoteStateClient` (`local-generation.ts`)   | `Observable<T>` + `snapshot`. `kind: "state"` `LocalGeneration`을 감싼다                                               |
| Event `Observable<T>` | `createRemoteEvent` (`local-generation.ts`)   | `kind: "event"` `LocalGeneration`을 감싼다. snapshot·재생이 없다                                                       |
| 원격 구독 다중화      | `StreamMultiplexer` (`stream-multiplexer.ts`) | API 인스턴스당 하나. `subscriptionId`별 generation 표, stream 메시지 판정·전달, subscribe·unsubscribe·acknowledge 전송 |
| 외부 store adapter    | `snapshotStore` (`snapshot-store.ts`)         | `RemoteState<T>` → `{ subscribe(onChange), getSnapshot() }`                                                            |
| 종료 플래그           | `ApiLifetime` (`api-lifetime.ts`)             | `disposed` 하나. generation·multiplexer가 읽는다([10. 종료](10-shutdown.md))                                           |

**generation**: 한 문서 안에서 같은 operation key의 로컬 구독자들이 공유하는 원격 구독 하나다. `subscriptionId` 하나, Main 구독 하나, `subscription-opened`/`subscription-closed` 진단 한 쌍에 대응한다. 로컬 구독자 수와 무관하게 원격 subscribe는 generation당 1회다.

generation 경계:

| 경계 | 사건                                                                                         |
| ---- | -------------------------------------------------------------------------------------------- |
| 열림 | 활성 generation이 없을 때 로컬 `subscribe()`                                                 |
| 끝남 | 마지막 로컬 구독자 해제, 원격 `complete`, 원격 `error`, subscribe 전송 실패, `api.dispose()` |

끝난 generation은 다시 열리지 않는다. 다음 로컬 `subscribe()`는 새 `subscriptionId`로 새 generation을 연다.

`RemoteStateSnapshot<T>`(`contract/remote-state.ts`)는 4상태 판별 유니온이다.

| status          | active  | value |
| --------------- | ------- | ----- |
| `uninitialized` | `false` | 없음  |
| `connecting`    | `true`  | 없음  |
| `current`       | `true`  | 있음  |
| `stale`         | `false` | 있음  |

## 3. 불변식

1. operation key당 활성 generation은 최대 1개다. 같은 key의 로컬 구독자는 모두 그 generation의 `Subject` 하나를 구독한다.
2. 값의 수명은 generation의 수명과 같다. 끝난 generation의 값은 다음 generation의 Observable 구독자에게 재생하지 않는다.
3. snapshot 반영이 구독자 통지보다 먼저다. `next`·`complete`·`error` 콜백 안에서 읽은 `snapshot`은 이미 그 사건을 반영한다.
4. `undefined`는 유효한 값이다. "값 있음"은 값이 아니라 generation의 `hasValue` 플래그로 판정한다. `undefined` 값도 `current`로 반영하고 늦은 합류자에게 재생한다.
5. `connecting`은 값을 갖지 않는다. 새 generation이 열리면 이전 `stale` 값을 버린다.
6. snapshot 객체는 전이나 값 도착 때만 새로 만든다. 그 사이의 읽기는 같은 참조를 돌려준다.
7. generation당 `error`·`complete` 중 하나만 최대 1회 통지한다. generation이 닫힌 뒤(`unsubscribed` 포함)에는 `next`를 포함해 어떤 handler도 호출하지 않는다.
8. `subscriptionId`는 문서 안에서 재사용하지 않는다. `createOpaqueId`가 문서당 nonce와 단조 증가 sequence로 만든다. API 인스턴스를 새로 만들어도 sequence는 이어진다.
9. `api.dispose()` 뒤 `subscribe()`는 활성 generation이 남아 있어도 합류하지 않고 동기 `RemoteError("CANCELLED", "Renderer API is disposed.")`로 끝난다. snapshot은 바뀌지 않는다. 이 검사는 `LocalGeneration.subscribe` 한 곳에만 있다.
10. `snapshotStore`는 스스로 새 generation을 열지 않는다. 예외는 새 listener 진입 시점뿐이다.
11. `snapshotStore`는 `getSnapshot()` 값이 바뀌면 반드시 알린다. 여분 알림은 허용한다.

## 4. 흐름

### 4.1 generation 열기 (`LocalGeneration.subscribe`)

1. `lifetime.disposed`면 subscriber에 동기 `CANCELLED` error를 주고 끝낸다. generation·snapshot·전송 모두 건드리지 않는다.
2. 활성 generation이 없으면 새 generation(`Subject`, `hasValue: false`)을 만든다. State면 snapshot을 `connecting`으로 바꾼다.
3. 구독자 수를 늘리고 `Subject`를 구독한다.
4. 기존 generation에 합류했고, State이고, `hasValue`이고, generation이 여전히 활성이면 현재값을 이 subscriber에게만 동기로 1회 전달한다.
5. 새 generation이면 `multiplexer.open(key, handlers, registered)`를 호출한다.
6. 새 generation이 여전히 활성이면(State 한정) 내부 "generation 열림" 신호를 발사한다(4.6).
7. 해제 함수를 돌려준다.

늦은 합류자 규칙:

| 합류 시점                                   | 합류 직후 받는 값 |
| ------------------------------------------- | ----------------- |
| `connecting` (`subscribed` 전)              | 없음. 첫 값 대기  |
| `connecting` (`subscribed` 뒤, 첫 batch 전) | 없음. 첫 값 대기  |
| `current`                                   | 현재값 1회, 동기  |
| 다른 구독자의 `next` 콜백 안(재진입)        | 진행 중인 값 1회  |
| Event generation                            | 없음. 재생 없음   |

재진입 합류자가 진행 중인 값을 정확히 1회 받는 이유: 값 대입(`latest`, snapshot)이 `Subject.next`보다 먼저라 합류 시 재생이 그 값을 주고, 이미 시작된 `Subject.next` 순회는 새 구독자를 포함하지 않는다.

### 4.2 값 도착과 generation 종료 (`LocalGeneration`)

값(`next`): generation이 현재이고 닫히지 않았을 때만 처리한다. `hasValue`·`latest` 대입 → State면 snapshot `current` → `Subject.next` 순서다.

종료 경로:

| 사건                    | 처리 순서                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| 마지막 로컬 구독자 해제 | generation 닫힘 표시 → 현재 generation 비움 → snapshot 비활성 전이 → `multiplexer.close(subscriptionId)` |
| 원격 `complete`·`error` | generation 닫힘 표시 → 현재 generation 비움 → snapshot 비활성 전이 → `Subject.complete()`/`error()`      |
| subscribe 전송 실패     | 원격 `error`와 같다. 오류는 `RemoteError("INTERNAL", "Stream transport failed.")`                        |
| `api.dispose()`         | multiplexer가 `complete` handler를 호출한다 → 원격 `complete`와 같다                                     |

현재 generation을 비우는 단계가 통지보다 먼저이므로, `complete`·`error` 콜백 안의 `subscribe()`는 끝난 generation에 합류하지 않고 새 generation을 연다.

### 4.3 snapshot 전이

| 현재                      | 사건                                                   | 다음                        |
| ------------------------- | ------------------------------------------------------ | --------------------------- |
| `uninitialized` / `stale` | generation 열림                                        | `connecting` (이전 값 버림) |
| `connecting` / `current`  | 값 도착                                                | `current` (새 값)           |
| `connecting`              | generation 끝남(해제·complete·error·전송 실패·dispose) | `uninitialized`             |
| `current`                 | generation 끝남                                        | `stale` (마지막 값 유지)    |
| 모든 상태                 | dispose 뒤 `subscribe()`                               | 변화 없음                   |

비활성 전이 규칙은 하나다: 직전이 `current`·`stale`이면 그 값을 가진 `stale`, 아니면 `uninitialized`.

Main이 세션 종료로 보내는 `error CANCELLED`([06. Main 스트림 전달](06-stream-delivery.md))도 원격 `error`라 같은 표를 따른다.

### 4.4 `StreamMultiplexer`

API 인스턴스 하나는 `transport.onStreamMessage` listener 하나와 `subscriptionId → generation` 표 하나를 가진다.

`open(key, handlers, registered)`:

1. `createOpaqueId("subscription")`로 새 `subscriptionId`를 만든다.
2. generation(`active: false`, `lastSequence: -1`)을 표에 등록한다.
3. `registered(subscriptionId)`로 `LocalGeneration`에 ID를 넘긴다.
4. `subscription-opened` 진단을 기록한다.
5. 진단 sink가 재진입으로 `api.dispose()`를 불러 generation이 이미 닫혔으면 subscribe를 보내지 않는다.
6. `transport.control({ type: "subscribe", subscriptionId, key })`를 보낸다. throw하면 `transport-failed`로 generation을 끝낸다.

등록(2·3)이 전송(6)보다 먼저다. transport가 `control()` 안에서 `subscribed`·`batch`를 동기로 돌려줘도 표에서 generation을 찾는다.

메시지 판정 순서(`#dispatch`):

| 순서 | 조건                                                          | 처리                                             |
| ---- | ------------------------------------------------------------- | ------------------------------------------------ |
| 1    | `lifetime.disposed`                                           | 폐기. 진단 없음                                  |
| 2    | `parseStreamMessage` 실패                                     | 폐기. `message-dropped`(`malformed`)             |
| 3    | `protocolVersion` 또는 `clientId`가 handshake 값과 다름       | 폐기. `message-dropped`(`envelope-mismatch`)     |
| 4    | 표에 없는 `subscriptionId`                                    | 폐기. 진단 없음(unsubscribe 뒤 도착은 정상 경합) |
| 5    | `subscribed`인데 이미 active이거나 `sequence <= lastSequence` | 폐기. `message-dropped`(`out-of-order`)          |
| 6    | `subscribed`                                                  | `lastSequence` 갱신, active로 전환               |
| 7    | 그 외 종류인데 active가 아니거나 `sequence <= lastSequence`   | 폐기. `message-dropped`(`out-of-order`)          |
| 8    | `batch`                                                       | 값 전달 후 acknowledge                           |
| 9    | `error`                                                       | `remote-error`로 종료                            |
| 10   | `complete`                                                    | `completed`로 종료                               |

sequence는 단조 증가만 요구한다. 연속성은 요구하지 않는다. `subscribed` 전의 `batch`·`error`·`complete`는 모두 버린다.

`batch` 처리:

1. `values`를 순서대로 `handlers.next`에 동기 전달한다. 전달 도중 generation이 표에서 빠지면(마지막 구독자 해제, dispose) 남은 값은 버린다.
2. `lifetime.disposed`면 acknowledge를 보내지 않는다.
3. 아니면 `{ type: "acknowledge", subscriptionId, sequence }`를 보낸다. batch 전달 중 마지막 로컬 구독자가 해제돼 generation이 이미 닫혔어도 보낸다 — 받아들인 batch에 대한 확인이다.

acknowledge는 batch 전달이 끝난 뒤 batch당 1회다. Main은 이 ack를 받아야 다음 batch를 보낸다([06. Main 스트림 전달](06-stream-delivery.md)).

generation 종료(`#terminate`) 순서는 고정이다: identity guard(1회 보장) → 표에서 삭제 → `subscription-closed` 진단 → cause별 unsubscribe 전송 → cause별 handler 통지.

| cause              | unsubscribe 전송 | handler 통지                                                 |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `unsubscribed`     | 보낸다           | 없음                                                         |
| `disposed`         | 보낸다           | `complete`                                                   |
| `completed`        | 없음             | `complete`                                                   |
| `remote-error`     | 없음             | `error(RemoteError(code, message, details))`                 |
| `transport-failed` | 없음             | `error(RemoteError("INTERNAL", "Stream transport failed."))` |

unsubscribe·acknowledge 전송의 throw는 삼키고 `transport-failed`(`control`) 진단만 남긴다. subscribe 전송 실패는 `subscription-closed`(`transport-failed`)만 기록한다(이중 기록 방지).

`close(subscriptionId)`는 `lifetime.disposed`면 no-op이다. dispose 절차가 진행 중일 때 sink 재진입으로 들어온 개별 해제는 `closeAll()`이 `disposed`로 한 번 닫게 둔다.

### 4.5 `snapshotStore`

상태: listener 집합, 공유 `state` 구독 하나(`upstream`), 합류 여부 플래그 `open`, "generation 열림" 신호 등록 handle.

| 동작                              | 처리                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `snapshotStore(state)`            | `WeakMap` 캐시. 같은 `state` 객체에는 같은 store(같은 `subscribe`·`getSnapshot` 참조)를 돌려준다. store는 `Object.freeze`, 함수는 `this`를 쓰지 않는 closure |
| `subscribe(onChange)`             | listener 항목을 새로 추가한다(같은 `onChange` 두 번이면 항목 두 개). 첫 listener면 신호 handler를 먼저 등록한다. `open`이 아니면 합류한다                    |
| 합류(`join`)                      | `open = true` 후 `state.subscribe({ next: notify, error: finish, complete: finish })`                                                                        |
| 해제 함수                         | 그 항목만 지운다. 마지막 listener면 `open = false`, `upstream` 해제, 신호 등록 해제                                                                          |
| `next`                            | 모든 listener의 `onChange()`를 인자 없이 호출                                                                                                                |
| `error`·`complete`                | `open = false`. 신호 등록이 있고 `state.snapshot.active`면 합류. 그다음 알림. `error`는 삼킨다                                                               |
| 신호(다른 구독이 generation을 엶) | `open`이 아니면 합류, 그다음 알림                                                                                                                            |
| `getSnapshot()`                   | 캐시 없이 `state.snapshot`을 그대로 돌려준다                                                                                                                 |

규칙:

- listener들은 `state` 구독 하나를 공유한다. listener마다 따로 구독하지 않는다.
- 원격 `complete`·`error` 뒤 스스로 재구독하지 않는다. snapshot은 `stale`/`uninitialized`에서 멈춘다. 새 listener 진입이 generation을 다시 연다.
- listener가 하나 이상 있는 동안에는 다른 구독(직접 `state.subscribe` 등)이 연 generation에도 합류해 listener가 모두 나갈 때까지 유지한다. 합류는 활성 generation에만 붙으므로 새 generation을 열지 않는다.
- 첫 listener는 신호 handler를 `state.subscribe`보다 먼저 등록한다. 그래서 자기 합류가 연 generation의 `connecting` 전환도 알림으로 받는다.
- 신호 handler는 합류를 먼저 하고 알림을 나중에 한다. 순서를 뒤집으면 listener가 알림 안에서 동기로 generation을 닫았을 때, 그 뒤의 합류가 새 generation을 여는 자동 재구독이 된다.
- 종료 처리에서의 합류: 종료를 store보다 먼저 받은 구독자(`repeat`·`retry` 등)가 그 콜백 안에서 동기로 새 generation을 열면, 신호는 store가 아직 `open`일 때 와서 합류 없이 지나간다. 종료 처리가 활성 generation을 확인해 합류한다.
- 합류 경합: transport가 값을 동기로 보내면 합류 도중 replay 알림 안에서 마지막 listener가 떠나거나 다른 합류가 끼어든다. 합류 번호가 바뀌었거나 listener가 없으면 방금 만든 구독을 바로 해제한다.
- 알림 순회는 복사본으로 돈다. 알림 중 추가된 listener는 이번 알림에서 빠지고, 해제된 listener는 호출하지 않는다.
- dispose된 API의 state를 구독하면 `state.subscribe`가 동기 `CANCELLED` error로 끝나고 `onChange`가 1회 불린다. 미처리 오류로 보고하지 않는다.

`RemoteStateClient`가 아닌 입력(사용자 fake 등)은 신호가 없다(`onGenerationOpened`가 `undefined`). 이 경우 합류 없이 `next`·`error`·`complete` 이벤트만으로 동작한다.

### 4.6 "generation 열림" 내부 신호

- `LocalGeneration`이 소유하는 listener 집합이다. 모듈 내부 함수 `onGenerationOpened(state, listener)`로만 등록하고 `renderer/index.ts`에서 재export하지 않는다. 공개 타입 `RemoteState`·`RemoteStateSnapshot`에는 노출하지 않는다.
- State generation에서만 쓴다.
- 발사 조건: `multiplexer.open` 뒤, 그 generation이 여전히 현재이고 닫히지 않았을 때. `open`이 동기로 실패해 generation이 이미 끝났으면 발사하지 않는다 — 발사하면 store가 합류를 시도해 다시 실패하는 재구독 루프가 된다.
- 순회는 복사본으로 돌고 순회 중 해제된 listener는 건너뛴다. listener 예외는 listener별로 잡아 rxjs 미처리 오류 규칙(`config.onUnhandledError`, 없으면 다음 tick throw)으로 보고한다. `subscribe()` 호출자에게 전파하지 않는다.

### 4.7 Main State source 평탄화 권고

Main State source의 `complete`·`error`는 Renderer에서 원격 `complete`·`error`가 되어 현재 generation을 끝낸다. 구독자는 `stale`/`uninitialized`에서 멈추고 store는 재구독하지 않는다. 따라서 장치 재연결처럼 source를 바꿔야 하면 source 자체를 교체하지 말고, complete하지 않는 오래 사는 `BehaviorSubject`에 `switchMap`으로 평탄화해 `next`만 흘리고 안쪽 error는 `catchError`로 값으로 바꾼다. 코드 예제는 패키지 README "State source 교체" 절에 있다.

평탄화는 source 교체만 해결한다. 출력 검증 실패, `authorize` 거부, 자원 한도, 세션 종료로 끝나는 generation은 막지 못한다. 이 경로는 Renderer 쪽 store 합류(4.5)가 listener에게 알린다.

## 5. 설계 이유와 기각한 대안

설계 이유:

- **generation 공유**: 로컬 구독자 수만큼 Main 구독·slot([09. 세션 자원 한도](09-resource-limits.md))·전송을 쓰지 않는다.
- **stale 값을 새 generation에 재생하지 않음**: State는 현재값이다([ADR 0003](../adr/0003-state-and-event-delivery.md)). 끝난 generation의 값은 현재라는 보장이 없다. 새 generation의 현재값은 Main이 새 구독에 보낸다. `stale` 값은 `active: false`와 함께 snapshot에만 남아 "마지막으로 알던 값"으로 읽힌다.
- **`connecting`이 이전 값을 버림**: 한 snapshot이 서로 다른 generation의 값을 섞지 않는다. 새 generation이 첫 값 전에 끝나면 `uninitialized`로 돌아가며, 옛 값이 새 generation의 결과처럼 보이지 않는다.
- **snapshot 반영 먼저**: 구독자 콜백과 React 렌더가 같은 값을 본다. 콜백 안에서 `snapshot`을 읽는 코드가 한 박자 늦은 값을 보지 않는다.
- **늦은 합류자 재생을 subscriber에 직접 전달**: `Subject.next`로 재생하면 기존 구독자가 값을 중복 수신한다.
- **generation 등록이 subscribe 전송보다 먼저**: 동기 transport(embedder·test)의 즉시 응답을 잃지 않는다.
- **terminal 경로 하나(`#terminate`)**: 진단 1쌍, unsubscribe 최대 1회, handler 통지 최대 1회를 cause 표 하나로 보장한다.
- **로컬 해제 뒤 ack 유지**: 받아들인 batch의 확인이다. dispose 뒤 ack 억제와 구분한다([10. 종료](10-shutdown.md)).
- **store 공유 구독**: listener마다 `state`를 따로 구독하면 원격 종료 뒤 새 listener가 연 generation을 기존 listener가 모른다. React에서 같은 state를 읽는 컴포넌트가 다른 값을 렌더한다(tearing) ([ADR 0024](../adr/0024-remote-state-snapshot-store.md)).

기각한 대안:

- **`shareReplay({ bufferSize: 1, refCount: true })`**: `resetOnComplete: false`라 원격 complete 뒤 구독자에게 옛 값과 complete를 재생하고 재구독하지 않는다. "stale 값은 재생하지 않고 새 generation을 연다" 계약과 맞지 않는다.
- **`share({ connector: () => new ReplaySubject(1) })`(현재 미채택)**: 공유·refCount 해제·늦은 합류 재생·종료 뒤 새 연결은 대응한다. 그러나 snapshot 상태기계, dispose 뒤 subscribe 차단, "generation 열림" 신호를 `defer`·`tap`·reset 콜백·`finalize`로 흩어 구현해야 하고, snapshot 반영 순서와 재진입 안전성을 같은 수준으로 지키는지 입증되지 않았다.
- **`Subject.next`로 늦은 합류자 재생**: 기존 구독자 중복 수신.
- **dispose 뒤에도 활성 generation 합류 허용**: 현재값 재생과 늦은 `complete`를 받아 "종료 뒤 subscribe는 오류" 규칙이 깨진다.
- **store 자동 재구독**: 원격 종료는 최종 상태다([ADR 0020](../adr/0020-stream-terminal-on-retire.md)). 원격이 계속 종료하면 재구독이 반복된다.
- **snapshot에 error 추가**: `RemoteStateSnapshot`은 공개 계약이다. 모든 소비자에 판별 분기가 늘어난다.
- **`RemoteState`에 메서드 추가(`state.toStore()`)**: 사용자 fake·mock도 새 메서드를 구현해야 한다.
- **캐시 없는 `snapshotStore`**: React 호출부가 `useMemo`/`useCallback`으로 참조를 직접 안정시켜야 한다.
- **snapshot 전이 신호를 `next`·`error`·`complete` 세 발사 지점에 두기**: 발사 지점이 늘고 기존 `onChange` 경로와 중복된다.
- **Main 평탄화 지침만으로 해결**: 검증 실패·거부·한도·세션 종료로 끝나는 generation을 막지 못한다.
- **`RemoteState`를 generation을 넘어 잇기**: `complete`·`error`의 의미가 바뀌어 ADR 0003·0020 계약에 영향을 준다.

## 6. 한계

- store로는 종료 원인을 알 수 없다. `RemoteError`가 필요하면 `state.subscribe({ error })`로 직접 구독한다.
- 원격 종료 뒤 자동 복구가 없다. 새 listener(컴포넌트 remount)나 직접 구독이 새 generation을 열어야 한다.
- Event는 재생이 없다. generation이 열리기 전이나 합류 전의 발생은 받지 못한다.
- Renderer는 `subscribed` 대기에 timeout을 두지 않는다. Main이 응답하지 않으면 generation은 `connecting`에 머문다.
- API 전체 차원의 끊김 신호는 없다. navigation·renderer 종료로 인한 retire는 통지가 없다(옛 문서가 함께 사라진다).
- 표에 없는 `subscriptionId`의 메시지는 진단 없이 버린다. 잘못된 ID와 정상 경합을 구분하지 않는다.

## 7. 관련 문서

- ADR: [0003 State와 Event 전달 의미](../adr/0003-state-and-event-delivery.md), [0006 종료 계약](../adr/0006-shutdown-contract.md), [0020 retire 시 stream 종료 통지](../adr/0020-stream-terminal-on-retire.md), [0022 Renderer 진단](../adr/0022-renderer-diagnostics.md), [0024 `snapshotStore`](../adr/0024-remote-state-snapshot-store.md)
- 설계 문서: [02. Renderer API](02-renderer-api.md), [06. Main 스트림 전달](06-stream-delivery.md), [08. Payload와 오류 모델](08-payload-and-errors.md), [10. 종료](10-shutdown.md), [11. 진단](11-diagnostics.md)
