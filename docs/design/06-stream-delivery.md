# 06. Main 스트림 전달

## 1. 목적과 범위

Main이 State·Event 구독 1건을 어떻게 받아들이고, 값을 어떤 순서·속도로 보내고, 언제 끝내는지 정한다. 답하는 질문:

- 구독 요청을 어떤 순서로 판정하고, 거부를 어떤 frame으로 알리는가
- 같은 `subscriptionId`의 재전송·늦은 도착을 어떻게 막는가
- 느린 소비자에게 값을 얼마나 쌓고, 넘치면 무엇을 하는가
- 여러 구독이 사용자 source 하나를 어떻게 공유하고, 언제 해지하는가
- 세션이 끝날 때 구독에 무엇을 보내는가

다루지 않는 것:

- Event source 모양 검사와 `broadcast`/`scoped` 정규화 규칙: [01. 계약과 등록](01-contract.md)
- sender admission, retire 사유와 시점: [04. 문서 세션](04-document-session.md)
- Renderer multiplexer, local generation, `RemoteState` snapshot: [07. Renderer 스트림과 State](07-renderer-streams.md)
- 출력 경계(`parseOutput`)와 오류 코드 전체 표: [08. Payload와 오류 모델](08-payload-and-errors.md)
- `maxSubscriptions` 기본값과 slot 회계: [09. 세션 자원 한도](09-resource-limits.md)
- `server.dispose()` 판정: [10. 종료](10-shutdown.md)
- 진단 이벤트 필드와 기록 순서 규칙: [11. 진단](11-diagnostics.md)

## 2. 모델

### 전달 의미

| 구분              | State                                                     | Event                                                               |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| 의미              | 현재값                                                    | 발생 순서를 가진 개별 항목                                          |
| 새 구독의 첫 값   | 현재값(첫 구독은 upstream 방출, 늦은 합류는 `getValue()`) | 없음. 과거 값을 재생하지 않는다                                     |
| ack 대기 중 새 값 | 대기 칸 1개를 최신값으로 덮어쓴다                         | 유한 buffer에 쌓는다                                                |
| 넘침              | 없음(덮어쓰기)                                            | overflow 정책(`error`·`drop-oldest`·`drop-newest`)                  |
| 전달 보장         | 마지막 값 수렴. 중간 값은 버려질 수 있다                  | 최대 한 번. 재전송 없음. `subscribed` 뒤 순서 보장                  |
| upstream 공유     | key별 공유                                                | `broadcast`는 key별 공유, `scoped`는 구독마다 factory로 새로 만든다 |

근거: [ADR 0003](../adr/0003-state-and-event-delivery.md).

### 모듈과 소유

| 모듈                                    | 소유                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Subscriptions` (`subscriptions.ts`)    | 구독 1건의 수명주기: ID 파싱·watermark·등록 조회·slot·`authorize` 대기·시작·terminal·close·retire 통지 |
| `DeliveryWindow` (`delivery-window.ts`) | consumer 1건의 전달 창: sequence 번호, ack 게이트, terminal drain, 선점 종료. 순수 반환형              |
| `BoundedQueue` (`bounded-queue.ts`)     | Event buffer. 고정 용량 ring과 overflow 정책                                                           |
| `Upstreams` (`upstreams.ts`)            | 사용자 source 연결: key별 공유, scoped 개별, State 늦은 합류 현재값, 해지와 teardown 예외 격리         |
| `SessionSlots` (`session-slots.ts`)     | 구독 slot lease와 retire listener 연동([09](09-resource-limits.md))                                    |

`DeliveryWindow`는 envelope·`subscriptionId`·전송을 모른다. 반환한 `WindowMessage`를 `Subscriptions`가 `withEnvelope`로 감싸 보낸다. `Upstreams`는 `DocumentSession`·`authorize`·창·진단 sink를 모른다. teardown 예외는 생성자 콜백 `onTeardownError(key)`로만 알린다.

세션별 상태(`watermark`, pending map, consumer map)는 `WeakMap<DocumentSession, …>`에 둔다. 세션 안에서는 `subscriptionId`만으로 구독을 식별한다. 다른 문서·새 clientId는 다른 `DocumentSession` 객체라 상태가 섞이지 않는다.

### wire frame

Renderer → Main 명령(`control` 채널): `subscribe { subscriptionId, key }`, `unsubscribe { subscriptionId }`, `acknowledge { subscriptionId, sequence }`.

Main → Renderer 메시지: 모두 `subscriptionId`와 `sequence`를 가진다.

| 메시지       | sequence       | 내용                                  |
| ------------ | -------------- | ------------------------------------- |
| `subscribed` | 항상 0         | 구독 확인                             |
| `batch`      | 1부터 1씩 증가 | `values`. Main은 항상 값 1개만 싣는다 |
| `complete`   | 다음 번호      | 정상 종료                             |
| `error`      | 다음 번호      | `RpcErrorPayload`로 종료              |

Renderer는 `subscribed` 전에 온 메시지와 sequence가 증가하지 않은 메시지를 버리고, 받은 `batch`마다 그 sequence로 `acknowledge`를 보낸다([07](07-renderer-streams.md)).

## 3. 불변식

1. 구독 1건의 모든 메시지는 `subscribed`(0)로 시작하고 sequence가 엄격히 증가한다. 시작 전 거부도 `subscribed`(0) 뒤 `error`(1)다.
2. consumer당 ack 대기 `batch`는 최대 1개다. 다음 `batch`는 그 sequence와 정확히 같은 `acknowledge`를 받은 뒤에만 나간다. 다른 sequence의 ack는 무시한다.
3. consumer 1건의 미확인 값은 in-flight `batch` 1개 + 대기분이다. Main이 보관하는 것은 대기분뿐이며 State 1칸, Event 최대 `capacity`개다.
4. buffer에는 `parseOutput`을 통과한 복제본만 들어간다. ack를 기다리는 동안 source 쪽 참조로 값을 바꿀 수 없다.
5. source 쪽 terminal(`complete`·`error`·overflow)은 기록 즉시 upstream을 분리하고, 대기 값을 모두 보낸 뒤에 나간다. slot은 terminal 전송 뒤 반환한다.
6. terminal을 기록했거나 창이 닫힌 뒤 도착한 값은 검증 전에 버린다. `validation-failed`도 기록하지 않는다.
7. 한 `DocumentSession` 안에서 `subscriptionId` sequence는 watermark보다 커야 받는다. 같은 ID는 두 번 구독되지 않는다.
8. upstream은 State·`broadcast` Event는 key당 최대 1개, `scoped` Event는 구독당 1개다. 마지막 consumer가 빠지면 해지한다.
9. 사용자 teardown 예외는 `Upstreams` 밖으로 나가지 않는다.
10. 전송 실패는 삼키고 그 구독을 닫는다. 전송 실패가 slot 반환·upstream 해지를 막지 않는다.
11. 통지 여부는 `Subscriptions`의 `endNotice` 한 곳이 원인과 retire 사유로 판정한다.

## 4. 흐름

### 4.1 구독 판정 순서

server의 `controlStream`이 envelope parse와 sender admission(`establish`)을 먼저 한다. parse 실패는 응답하지 않는다(`subscriptionId`를 신뢰할 수 없다). admission 거부는 `Subscriptions.rejectAdmission`이 `subscribed`(0) + `error FORBIDDEN "Bridge sender is not authorized."`(1)로 응답한다([04](04-document-session.md)). 통과하면 `Subscriptions.subscribe`가 다음 순서로 판정한다.

| 순서 | 단계        | 실패 시                                                                                 |
| ---- | ----------- | --------------------------------------------------------------------------------------- |
| 1    | ID 형식     | `INVALID_ARGUMENT "Invalid bridge subscription ID."`                                    |
| 2    | watermark   | 무출력·무진단. sequence ≤ watermark면 버린다. 통과하면 watermark를 이 sequence로 올린다 |
| 3    | 등록 조회   | `NOT_FOUND "Unknown bridge stream."`                                                    |
| 4    | slot 획득   | `RESOURCE_EXHAUSTED "Too many bridge subscriptions."`                                   |
| 5    | `authorize` | 거부 `FORBIDDEN`, 예외 `INTERNAL`([08](08-payload-and-errors.md))                       |

순서의 이유:

- 1 → 2: watermark는 ID에서 파싱한 sequence로만 판정한다. 형식이 틀리면 비교할 값이 없다.
- 2가 3·4보다 앞: 재전송·늦은 도착은 key·한도와 무관하게 조용히 버려야 한다. watermark를 판정 직후 올리므로 `NOT_FOUND`·`RESOURCE_EXHAUSTED`로 끝난 ID를 다시 보내도 무시된다.
- 3이 5보다 앞: 미등록 key는 `authorize` 결과와 무관하게 항상 `NOT_FOUND`다. RPC와 같은 입력에 같은 코드를 낸다. manifest는 모든 Renderer에 공개되므로 key 존재는 비밀이 아니다([ADR 0014](../adr/0014-stream-lookup-before-authorize.md)).
- 3이 4보다 앞: 미등록 key는 slot을 쓰지 않는다. slot 초과 진단(`subscription-limit`)에 등록된 key를 실을 수 있다.
- 4가 5보다 앞: `authorize` 대기 구독도 slot 1개를 쓴다. 비동기 `authorize`가 끝나지 않아도 대기 구독 수가 한도에 묶인다. 한도 초과 요청은 `authorize`를 호출하지 않는다.

`authorize` 거부·예외 응답을 보내기 직전(진단 sink의 동기 호출)이나 `subscribed` 전송 도중 detach·dispose retire가 끼면, 원래 거부 대신 `error CANCELLED "Bridge session ended."`로 끝난다. pending의 retire 통지가 먼저 등록돼 있기 때문이다. RPC는 같은 재진입에서 원래 응답(`FORBIDDEN` 등)을 유지한다([05](05-rpc.md)).

`authorize`를 생략하면 판정은 동기로 끝나고 `subscribed`도 `subscribe` 호출 안에서 동기로 나간다. `authorize` 대기 중에는 pending entry가 slot lease와 `AbortController`를 쥔다. 대기 중 `unsubscribe`는 lease 반환과 abort만 하고 아무것도 보내지 않는다. 늦게 도착한 판정은 pending entry가 이미 없으면 버린다.

### 4.2 `subscriptionId`와 watermark

형식은 `<nonce>:<scope>:<seq base36>`다. Renderer `createOpaqueId`가 문서당 하나인 counter로 만들고, 조립은 `formatOpaqueId`, 파싱은 `parseOpaqueIdSequence`(`src/protocol/opaque-id.ts`)가 한다. 파싱 실패 조건: segment 수가 3이 아님, 빈 segment, sequence의 선행 0 또는 base36 밖 문자, safe integer를 넘는 sequence. Main은 sequence만 쓰고 nonce·scope는 검사하지 않는다.

watermark는 세션별 "마지막으로 수락한 sequence" 숫자 하나다. 새 `DocumentSession`은 0에서 시작한다. sequence는 연속일 필요가 없고 이전 값보다 크기만 하면 된다. RPC `requestId`는 watermark 대상이 아니다.

ID별 저장소 대신 watermark를 쓰는 이유: 한 채널 안에서 도착 순서가 생성 순서와 같으므로 숫자 하나로 재사용을 완전히 막는다. 메모리는 세션당 O(1)이다. used-ID 집합은 세션 수명 동안 커지고, 유한 FIFO는 밀려난 ID가 다시 유효해진다([ADR 0009](../adr/0009-session-resource-limits.md)).

### 4.3 시작 전 거부 frame

시작하지 못한 구독(admission 거부, 4.1의 1·3·4·5단계 거부, `authorize` 대기 중 retire, `subscribed` 송신 전 retire된 consumer)은 `#endUnstarted`가 거부 전용 창(`createRejectionDeliveryWindow`)으로 `subscribed`(0) → `error`(1)를 보낸다.

`subscribed`를 먼저 보내는 이유: Renderer는 `subscribed` 전에 온 메시지를 out-of-order로 버린다. 활성 구독과 같은 상태기계로 거부를 terminal `error` 하나로 받게 한다.

`endNotice`는 `subscribed` 송신 전과 후에 두 번 평가한다. 진단 sink 기록이나 동기 `send` 안에서 retire가 끼어들 수 있기 때문이다.

1. 송신 전 평가가 "보내지 않음"이면 아무것도 보내지 않는다(세션이 통지하지 않는 사유로 이미 retire됨).
2. `subscribed`(0)를 보낸다.
3. 다시 평가한다. 그사이 detach·dispose retire가 일어났으면 원래 거부 대신 `CANCELLED "Bridge session ended."`를 보낸다. 통지하지 않는 사유로 retire됐으면 `error`를 보내지 않는다.
4. 전송 예외는 삼킨다.

### 4.4 구독 시작

`authorize`가 허용하면 pending entry의 lease를 `offRetire()`로 이어받아 consumer를 만든다. 이음 구간에는 외부 호출(진단·`send`·`authorize`·source)이 없다. 시작 순서:

1. 창 생성: Event는 등록된 `capacity`·`overflow`로 `createEventDeliveryWindow`, State는 `createStateDeliveryWindow`.
2. consumer map 등록 → `subscription-opened` 진단 → `lease.onRetire(onSessionAbort)` 등록. 진단 중 이미 retire됐으면 등록 호출 안에서 즉시 open 전 통지 경로(4.3)를 탄다.
3. `subscribed`(0) 송신.
4. `Upstreams.connect`로 사용자 source 연결. scoped factory는 여기서 처음 호출된다.

upstream 연결이 `subscribed` 송신 뒤라서 source가 구독 중 동기로 낸 값·terminal도 `subscribed` 뒤에 간다. 2단계 뒤나 3단계 송신 중에 창이 닫혔으면(동기 retire·unsubscribe, 전송 실패) 이후 단계를 건너뛴다. `connect`가 던지면(scoped factory 예외·non-Observable 반환, 늦은 합류 `getValue()` 예외) `error INTERNAL`로 종료하고, slot은 terminal 뒤 반환한다.

### 4.5 `DeliveryWindow`

상태: `sequence`, `inFlight`(ack 대기 sequence), `pendingTerminal`, 종결(terminal 반환 또는 `preempt` 뒤), 닫힘(`close()` 뒤).

| 입력             | 동작                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `open()`         | `subscribed`(0) 반환                                                                                                        |
| `accept(value)`  | `accepting`이 아니면 무시. buffer에 push → Event면 `onDropped` → `onQueueDepth` → overflow면 `STREAM_OVERFLOW` 기록 → flush |
| `ack(sequence)`  | `inFlight`와 같을 때만 비우고 flush                                                                                         |
| `end(terminal)`  | terminal이 없을 때만 기록하고 flush. `recorded`로 기록 여부를 돌려준다                                                      |
| `preempt(error)` | 대기 값·`inFlight`·기록된 terminal을 모두 버리고 다음 sequence로 `error` 반환. 종결                                         |
| `close()`        | 처음 호출에서만 `true`. 이후 모든 입력 무출력                                                                               |

flush 규칙:

1. `inFlight`가 있으면 아무것도 내지 않는다.
2. 대기 값이 있으면 하나 꺼내 sequence를 올리고 `inFlight`로 기록한 뒤 `batch`를 반환한다. `inFlight`를 송신 전에 기록하므로 동기 `send` 안에서 재진입한 `ack`이 곧바로 다음 값을 꺼낸다.
3. 대기 값이 없고 terminal이 기록돼 있으면 terminal을 반환하고 종결한다.

결과적으로 terminal은 대기 값이 모두 ack된 뒤에 나간다(terminal drain). `Subscriptions`는 terminal 기록 시점에 upstream을 분리하고(`#terminate`, overflow는 `accept`의 `overflowed`), terminal 메시지 송신 뒤 `#close`로 slot을 반환한다.

진단 콜백(`onDropped`·`onQueueDepth`)은 동기로 불리고, 창은 각 콜백 직후 종결·닫힘을 다시 확인한다. 콜백 안에서 구독이 닫히면 남은 콜백과 출력을 생략한다. 한 구독의 큐 진단은 `subscription-closed` 뒤에 나오지 않는다([11](11-diagnostics.md)).

### 4.6 Event buffer와 overflow

buffer는 source 생성 옵션 `{ capacity, overflow }`다(`broadcastEvent`/`scopedEvent`의 `buffer`, plain `Observable`은 기본값). 기본값은 `capacity: 100`, `overflow: "error"`다. 값 검증은 등록 단계가 한다([01](01-contract.md)). `capacity`는 in-flight batch를 제외한 대기 값 수다. capacity `N`이면 in-flight 1개와 대기 `N`개가 찬 뒤, 즉 `N + 2`번째 미확인 값부터 넘친다.

| 정책          | 넘칠 때                                                                                  | 구독                           |
| ------------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| `error`       | 새 값을 버리고 `STREAM_OVERFLOW "Event buffer capacity exceeded."`를 기록, upstream 분리 | 대기 값 전달 뒤 `error`로 종료 |
| `drop-oldest` | 가장 오래된 대기 값을 버리고 새 값을 넣는다                                              | 유지                           |
| `drop-newest` | 새 값을 버린다                                                                           | 유지                           |

세 정책 모두 넘칠 때마다 `stream-dropped`(count 1)를 기록한다. `stream-queue`는 push·shift마다 기록한다. overflow는 consumer 단위다. 같은 공유 upstream의 다른 consumer는 영향을 받지 않는다. 실제 Electron에서 느린 소비자만 overflow로 끝나고 terminal이 대기 값 뒤에 오는 순서를 확인했다([실제 Electron 다중 창 검증](../verification/rd-008.md)).

### 4.7 `Upstreams`

| 갈래              | 연결                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| State             | key별 공유 entry. 첫 member가 upstream을 구독하고 현재값은 그 구독의 방출로 받는다. 늦은 합류 member는 upstream을 다시 구독하지 않고 `getValue()`를 1회 읽어 자기 sink에만 동기로 전달한다 |
| `broadcast` Event | key별 공유 entry. 늦은 합류 값은 없다                                                                                                                                                      |
| `scoped` Event    | 토큰마다 factory(`BridgeContext`)가 만든 upstream을 혼자 쓴다                                                                                                                              |

State 첫 값은 source가 구독 시 현재값을 방출한다는 전제에 기댄다. `currentValueSource` helper는 `getValue()`를 먼저 방출하고, 이어진 첫 upstream 방출이 같은 값(`Object.is`)이면 건너뛴다.

scoped `BridgeContext.signal`은 consumer의 `AbortController`이며 구독 close 때 abort된다.

연결 규칙:

- 사용자 코드(scoped factory, 늦은 합류 `getValue()`)를 부르기 전에 토큰을 등록하고, 부른 뒤 토큰이 아직 연결 중인지 다시 확인한다. 사용자 코드가 동기로 그 구독을 끊었으면 더 진행하지 않는다.
- upstream `Subscriber`는 subscribe 전에 저장한다. 동기 방출 중 `disconnect`가 그 `Subscriber`를 끊을 수 있어야 한다.
- 공유 fan-out은 member 스냅샷을 순회하고, 각 member 직전에 아직 이 entry에 연결돼 있는지 확인한다. 앞 member의 sink가 뒤 member를 끊었으면 건너뛴다.
- upstream `error`의 원래 값은 전달하지 않는다. `Subscriptions`가 `error INTERNAL "Internal bridge error."`로 바꾼다. 출력 검증 실패도 같은 `INTERNAL`이다.

해지 규칙:

- `disconnect(token)`은 토큰 identity로 식별하고 멱등이다.
- 공유 entry 순서: `members.delete` → 비었고 map의 현재 entry가 이 entry면 map에서 삭제 → upstream 해지. 해지 전에 지우므로 해지가 던지거나 teardown이 같은 key를 동기로 다시 구독해도 새 entry와 새 upstream이 생긴다.
- map 삭제는 identity가 같을 때만 한다. 옛 consumer의 뒤늦은 terminal ack·해제가 같은 key로 새로 만든 공유를 해지하지 못한다.
- upstream terminal 뒤 공유 entry 정리는 `Upstreams`가 하지 않는다. 각 member가 terminal을 기록하며 자기 토큰으로 `disconnect`한다.

teardown 예외 격리([ADR 0025](../adr/0025-upstream-teardown-isolation.md)):

- 모든 해지는 `#release` 하나를 거치고, `unsubscribe()` 예외를 잡아 `onTeardownError(key)`로 알린다. `Subscriptions`는 이를 `upstream-teardown-failed` 진단으로 잇는다. 공유 upstream은 마지막 member 이탈 때 1건, scoped는 구독마다 1건이다.
- source가 구독 중 동기로 끝나 rxjs가 teardown을 그 자리에서 실행하다 던지면 `source.subscribe(...)`가 던진다. upstream이 이미 `closed`면 teardown 예외로 보고 같은 콜백으로 알린다. 아니면 다시 던져 `connect`가 정리한다.
- upstream은 `new Subscriber(observer)`로 만든다(rxjs `SafeSubscriber` 아님). observer 경로의 동기 예외 지점(출력 검증, 창 콜백, 진단 기록, `send`, `disconnect`)은 모두 `Subscriptions`·`Upstreams`가 잡으므로 사용자 producer의 `next(...)` 호출로 예외가 거슬러 올라가지 않는다.

### 4.8 구독 종료 경로

`#close` 순서: `window.close()`(처음만 진행) → `subscription-closed` 진단 → slot lease 반환 → consumer map 삭제 → consumer `AbortController` abort → `Upstreams.disconnect`. 그래서 `upstream-teardown-failed`는 그 구독의 `subscription-closed` 뒤에 올 수 있다.

| 경로                                      | 전송                               | upstream 분리 | slot 반환        |
| ----------------------------------------- | ---------------------------------- | ------------- | ---------------- |
| Renderer `unsubscribe`(활성)              | 없음                               | close 때      | 즉시             |
| Renderer `unsubscribe`(`authorize` 대기)  | 없음                               | 연결 전       | 즉시             |
| source `complete`                         | 대기 값 뒤 `complete`              | 기록 즉시     | terminal 송신 뒤 |
| source `error`, 출력 검증 실패, 연결 실패 | 대기 값 뒤 `error INTERNAL`        | 기록 즉시     | terminal 송신 뒤 |
| `error` 정책 overflow                     | 대기 값 뒤 `error STREAM_OVERFLOW` | 기록 즉시     | terminal 송신 뒤 |
| 전송 실패                                 | 없음(예외 삼킴)                    | close 때      | 즉시             |
| 세션 retire                               | 4.9 표                             | close 때      | 즉시             |

slot 회계 자체는 [09](09-resource-limits.md)가 소유한다.

### 4.9 retire 시 terminal 통지

retire 통지는 `SlotLease.onRetire`(내부적으로 `DocumentSession.onRetire`)로 받는다. 이미 retire된 세션에 등록하면 즉시 동기 호출된다.

| retire 사유                    | 활성·`authorize` 대기·open 전 구독        |
| ------------------------------ | ----------------------------------------- |
| `detach`                       | `error CANCELLED "Bridge session ended."` |
| `dispose` (`server.dispose()`) | `error CANCELLED "Bridge session ended."` |
| `main-frame-navigation`        | 없음                                      |
| `render-process-gone`          | 없음                                      |
| `destroyed`                    | 없음                                      |
| `replaced` (새 `clientId`)     | 없음                                      |

- bind `dispose()`는 자기가 attach한 세션을 먼저 `detach` 사유로 retire한 뒤 `server.dispose()`를 부른다. 통지 결과는 같다.
- 통지하는 두 사유는 문서가 살아 있는 채 브리지만 끊긴 경우다. 통지가 없으면 `RemoteState`가 마지막 값을 현재값처럼 계속 보여 준다.
- navigation·`render-process-gone`·`destroyed`는 받을 문서가 이미 없다. `replaced`는 같은 문서가 새 `clientId`로 다시 연결하는 흐름이다(한계 참고).
- 활성 구독은 `preempt`로 대기 값·ack 대기·기록된 terminal을 모두 버리고 다음 sequence로 `CANCELLED`를 보낸다. 세션이 끝나면 `acknowledge`를 받을 경로가 없으므로 drain하지 않는다.
- `authorize` 대기와 `subscribed` 송신 전 consumer는 4.3 경로로 `subscribed`(0) + `CANCELLED`(1)를 보낸다. 대기 구독은 `authorize`에 넘긴 `context.signal`도 abort한다.
- 통지 전송 실패는 삼키고 close를 끝까지 진행한다.

`server.dispose()`는 세션을 먼저 `dispose` 사유로 retire해(위 규칙대로 통지) 구독을 닫고, 그다음 `Subscriptions.dispose()`가 남은 pending·consumer를 통지 없이 닫는다([10](10-shutdown.md)).

근거: [ADR 0020](../adr/0020-stream-terminal-on-retire.md), [ADR 0023](../adr/0023-session-retire-interface.md).

## 5. 설계 이유와 기각한 대안

설계 이유:

- ack 게이트(in-flight 1개): Main이 consumer당 쥐는 값에 상한을 두고, 느린 소비자의 지연을 그 consumer 안에 가둔다. 공유 upstream은 consumer별 창에 값을 넣을 뿐 느린 consumer를 기다리지 않는다.
- terminal drain: source 쪽 종료는 소비자가 이미 수락된 값을 잃을 이유가 아니다. 대기 값을 순서대로 보낸 뒤 terminal을 보내 "받은 값 = 수락된 값"을 유지한다.
- retire의 선점 종료: 세션이 끝나면 ack 경로가 없어 drain이 끝나지 않는다.
- 창을 순수 반환형으로 분리: 전송·envelope·source 분리를 호출자 한 곳에 두고, 창은 입력별 반환만 test한다. State·Event 차이는 주입한 buffer 하나로만 표현하고 창에는 kind 분기가 없다.

기각한 대안:

- State도 모든 중간 snapshot을 쌓는다: State는 현재값이라 중간 값을 보존할 이유가 없다. 느린 소비자 메모리만 늘어난다.
- Event 무제한 buffer: 느린 소비자 하나가 Main 메모리를 무한히 쓴다.
- buffer를 계약에 선언: 계약은 타입이라 값을 담을 수 없다. source 생성 옵션이다([ADR 0012](../adr/0012-lightweight-type-contract.md)).
- 사용한 `subscriptionId` 집합 보관: 세션 수명 동안 커진다.
- 유한 FIFO used-ID 목록: 밀려난 ID가 다시 유효해진다.
- `JSON.stringify([webContentsId, frameId, clientId, subscriptionId])` 합성 키 전역 Map: 세션을 얻은 뒤라 세션별 map과 `subscriptionId`로 충분하다.
- `authorize`를 등록 조회보다 먼저: 같은 미등록 key가 `authorize` 결과에 따라 `FORBIDDEN`/`NOT_FOUND`로 갈렸다.
- retire 통지를 `complete`로: 정상 종료와 비자발적 끊김을 구분할 수 없다.
- 새 오류 코드(`SESSION_ENDED` 등): 소비자 판별 분기만 늘어난다. RPC와 같은 `CANCELLED`/`FORBIDDEN`을 쓴다.
- 모든 retire 사유에 통지: 받을 문서가 없는 사유에서 무의미하다.
- teardown 예외를 진단 없이 삼킴: 사용자 source 결함이 조용히 사라진다.
- upstream을 `SafeSubscriber`로 만들기: 예외가 rxjs 미처리 오류 보고로 가서 Main `uncaughtException`이 된다. 공유 entry 잔존도 풀지 못한다.
- `#close`에서 `disconnect`를 `subscription-closed` 앞으로: 사용자 teardown이 consumer `AbortSignal` abort보다 먼저 실행되는 관측 가능한 순서 변경이 생긴다.

## 6. 한계

- 같은 문서에서 같은 server에 붙은 두 transport가 서로 다른 `clientId`로 연결하면 앞 세션은 `replaced`로 retire되고 통지를 받지 않는다. 앞 transport의 `RemoteState`는 마지막 값을 현재값처럼 유지한다. 같은 attach 아래에서 다른 `clientId`로 연결할 때만 생긴다(예: 한 문서에서 같은 namespace로 `exposeBridgeInMainWorld`를 두 번 호출). loopback transport는 만들 때마다 `server.attach`를 부르므로, 같은 `webContentsId`로 새로 만들면 앞 세션은 `detach`로 retire되어 `CANCELLED` 통지를 받는다.
- ack를 보내지 않는 소비자는 `unsubscribe`·retire 전까지 slot 1개와 대기 값(Event 최대 `capacity`, State 1)을 점유한다. `error` 정책 overflow도 대기 값 drain 뒤에만 terminal을 보내므로 slot을 풀지 못한다. 영향은 그 세션의 `maxSubscriptions` 안에 머문다.
- operator를 거친 source(`inner.pipe(map(...))`)에서 안쪽 source가 구독 중 동기로 끝나고 teardown이 던지면, rxjs `operate`가 예외를 이미 닫힌 upstream의 `error`로 보내고 rxjs가 그 알림을 버린다. 예외는 새지 않지만 `upstream-teardown-failed`가 남지 않는다. 해지 경로는 operator 체인도 `UnsubscriptionError`로 올라와 기록된다. `Subscriber.error` override로 잡는 안은 규약을 어긴 source의 늦은 `error`와 구분하지 못하고, rxjs 전역 `config.onStoppedNotification`은 앱 전체 설정을 바꾸므로 채택하지 않았다.
- 사용자가 `BridgeContext.signal`에 붙인 abort listener의 예외는 Node `EventTarget`이 `uncaughtException`으로 보낸다.
- `upstream-teardown-failed`는 key만 싣는다. 어느 구독·세션의 해지였는지 알 수 없다.
- State 첫 구독의 현재값은 source가 구독 시 방출해야 온다. `getValue()`만 있고 구독 시 방출하지 않는 source는 첫 변경까지 `batch`가 없다(`currentValueSource`로 감싸면 보장된다).
- `stream-queue`는 push·shift마다 기록한다. 고빈도 Event에서는 sink가 직접 샘플링해야 한다.
- watermark는 `control` 채널의 도착 순서가 생성 순서와 같다는 전제에 기댄다. 순서를 바꾸는 transport는 정상 구독을 늦은 도착으로 버린다.
- `subscribed` 송신 중 통지하지 않는 사유로 retire되면 `subscribed`만 나가고 `error`는 나가지 않는다. 받을 문서가 없는 사유라 관찰되지 않는다.
- 지속적인 고속 Event는 범위 밖이다. batch당 값 1개, in-flight 1개라 처리량은 IPC 왕복에 묶인다.

## 7. 관련 문서

ADR:

- [ADR 0003](../adr/0003-state-and-event-delivery.md) State·Event 전달 의미
- [ADR 0009](../adr/0009-session-resource-limits.md) watermark, 구독 slot 반환 시점
- [ADR 0010](../adr/0010-operational-diagnostics.md) `stream-queue`·`stream-dropped`
- [ADR 0012](../adr/0012-lightweight-type-contract.md) Event buffer를 source 옵션으로
- [ADR 0014](../adr/0014-stream-lookup-before-authorize.md) 판정 순서, `Subscriptions` 단일 소유
- [ADR 0020](../adr/0020-stream-terminal-on-retire.md) retire 시 stream terminal 통지
- [ADR 0023](../adr/0023-session-retire-interface.md) 세션 retire interface
- [ADR 0025](../adr/0025-upstream-teardown-isolation.md) teardown 예외 격리

설계 문서:

- [01. 계약과 등록](01-contract.md) Event source 정규화, buffer 검증
- [04. 문서 세션](04-document-session.md) sender admission, retire 사유
- [07. Renderer 스트림과 State](07-renderer-streams.md) 수신 측 sequence 검사와 ack
- [08. Payload와 오류 모델](08-payload-and-errors.md) 출력 경계, 오류 코드
- [09. 세션 자원 한도](09-resource-limits.md) slot 회계
- [10. 종료](10-shutdown.md) `server.dispose()`
- [11. 진단](11-diagnostics.md) 진단 이벤트와 순서
