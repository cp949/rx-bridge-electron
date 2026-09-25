# 11. 진단

## 1. 목적과 범위

답하는 질문:

- 운영자는 bridge의 거부·완료·수명주기를 어떻게 관측하는가.
- 진단 이벤트에 무엇을 싣고 무엇을 싣지 않는가.
- sink가 실패하거나 재진입해도 bridge 동작이 같다는 것을 무엇이 보장하는가.
- Main과 Renderer의 진단은 어떻게 나뉘는가.

다루지 않는 것:

- 각 거부 사유의 판정 순서 자체: sender admission은 [04. 문서 세션](04-document-session.md), RPC 처리 순서는 [05. RPC](05-rpc.md), 구독 판정 순서와 전달 창은 [06. Main 스트림 전달](06-stream-delivery.md)
- 오류 코드와 wire 응답 문구: [08. Payload와 오류 모델](08-payload-and-errors.md)
- 자원 한도 값: [09. 세션 자원 한도](09-resource-limits.md)

## 2. 모델

| 개념                                                  | 소유                          | 설정 지점                                         |
| ----------------------------------------------------- | ----------------------------- | ------------------------------------------------- |
| `DiagnosticsSink`, `BridgeDiagnostic`, `RejectReason` | `src/main/types.ts`           | `createBridgeServer(impl, { diagnostics })`       |
| `recordDiagnostic(sink, event)`                       | `src/main/diagnostics.ts`     | Main의 모든 기록 지점이 이 함수 하나를 거친다     |
| `DiagnosticsSnapshot`                                 | `src/main/types.ts`           | `server.getDiagnosticsSnapshot()`                 |
| `RendererDiagnosticsSink`, `RendererDiagnostic`       | `src/renderer/diagnostics.ts` | `createRendererApi<B>({ diagnostics })`           |
| `recordRendererDiagnostic(sink, event)`               | `src/renderer/diagnostics.ts` | Renderer의 모든 기록 지점이 이 함수 하나를 거친다 |

관측 모델은 두 가지다. 이벤트(`record(event)`)는 일어난 일을 동기로 알린다. 스냅샷(`getDiagnosticsSnapshot()`)은 Main의 현재 게이지를 조회한다. Renderer에는 스냅샷이 없다.

### 2.1 원칙

- **닫힌 타입.** `BridgeDiagnostic`·`RendererDiagnostic`은 닫힌 판별 유니온이다. 싣는 필드가 타입으로 고정돼 기록 지점이 임의 필드를 추가할 수 없다.
- **사유는 enum.** 거부 사유는 `RejectReason`, Renderer 원인은 `RpcSettleCause`·`SubscriptionCloseCause`·`HandshakeFailureReason`·`DroppedMessageReason`이다. 자유 문자열을 싣지 않는다.
- **식별자는 등록된 wire key만.** `key`는 등록 조회를 통과한 operation key(`category:domain/op`)다. 미등록 key는 Renderer가 보낸 임의 문자열이라 싣지 않는다. 수치는 크기·개수·시간만 싣는다.
- **기록 금지.** 아래 항목은 어떤 이벤트에도 싣지 않는다.

| 기록 금지 항목                                             | 이유                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Error` 객체, `message`, `stack`                           | 자유 문자열이라 내용을 통제할 수 없다. 경로·자격증명이 섞일 수 있다                           |
| 원문 payload, 도메인 에러 `details`                        | 사용자 데이터다                                                                               |
| `origin`                                                   | 판정 근거다. 사유 enum(`origin-not-allowed`)으로 충분하다                                     |
| `clientId`, `webContentsId`, `requestId`, `subscriptionId` | 요청·세션 상관 분석을 가능하게 하는 식별자다. 상관이 필요하면 호스트가 자기 경계에서 로깅한다 |

Renderer의 예외는 `code` 하나다. `cause: "remote-error"`일 때만 `RemoteError.code`(프로토콜 코드 또는 선언된 도메인 코드)를 싣는다. 원인 분류에 필요하고, 자유 문자열이 아니라 서버가 정한 코드 집합에서 온다.

### 2.2 sink 격리와 기본 무출력

- `recordDiagnostic`·`recordRendererDiagnostic`은 sink가 없으면 아무것도 하지 않는다.
- `record`의 동기 throw는 삼킨다. RPC 응답, stream 전달, Renderer의 resolve·reject 값은 sink 유무·실패와 무관하게 같다.
- `record`가 Promise를 반환해도 await하지 않는다.
- 어떤 진단 경로도 `console.*`·`process.stdout`/`stderr`를 쓰지 않는다. sink를 주지 않으면 완전히 조용하다.
- sink는 동기 호출이다. sink 안에서 detach·dispose·unsubscribe 같은 재진입이 일어날 수 있고, 기록 지점은 그 뒤 상태를 다시 확인한다(3절 불변식).

### 2.3 Main 이벤트

| `type`                     | 필드                           | 기록 시점                                                                                                       | 기록 모듈                               |
| -------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `rpc-finished`             | `key`, `durationMs`, `outcome` | RPC slot을 얻은 요청의 handler work가 끝날 때 1회. slot 반환 뒤                                                 | `RpcRequests`                           |
| `rpc-cancelled`            | `key`                          | Renderer cancel, 같은 `requestId` 재요청, 세션 retire로 요청을 취소할 때. deadline이 먼저 확정했으면 없음       | `RpcRequests`                           |
| `rpc-timed-out`            | `key`                          | `maxRpcDurationMs` 만료. 취소가 먼저 확정했으면 없음                                                            | `RpcRequests`                           |
| `validation-failed`        | `key`                          | 출력 경계(`parseOutput`) 실패. RPC 출력과 State·Event 값                                                        | `RpcRequests`, `Subscriptions`          |
| `stream-queue`             | `key`, `depth`                 | Event 대기열 push·shift마다(State는 없음)                                                                       | `DeliveryWindow` 콜백 → `Subscriptions` |
| `stream-dropped`           | `key`, `count`                 | Event buffer가 가득 찬 push. `drop-oldest`·`drop-newest`·`error` 정책 모두                                      | `DeliveryWindow` 콜백 → `Subscriptions` |
| `rejected`                 | `reason`, `key?`               | 요청 거부. 2.4 표                                                                                               | 2.4 표                                  |
| `session-opened`           | 없음                           | `establish`가 새 세션을 현재 세션으로 등록한 직후                                                               | `DocumentSessions`                      |
| `session-closed`           | 없음                           | 현재 세션이 있는 attachment의 retire 1회(detach·수명 사건·새 clientId·dispose 공통 지점)                        | `DocumentSessions`                      |
| `subscription-opened`      | `key`                          | `authorize` 승인 뒤 consumer 등록 직후, `subscribed` 송신 전                                                    | `Subscriptions`                         |
| `subscription-closed`      | `key`                          | 그 consumer가 처음 닫힐 때                                                                                      | `Subscriptions`                         |
| `upstream-teardown-failed` | `key`                          | 사용자 source teardown이 upstream 해지 중 throw. 실패한 해지 1회에 1건(공유는 마지막 member, scoped는 구독마다) | `Upstreams` 콜백 → `Subscriptions`      |

`rpc-finished.outcome`은 handler work의 실제 응답이 성공이면 `"ok"`, 그 외(도메인 에러, 출력 검증 실패, `authorize` false·예외, 취소)는 `"error"`다. deadline이 먼저 응답했어도 work의 실제 결과로 정한다. `durationMs`는 slot 획득 뒤부터 work 종료까지다.

세션 이벤트에는 식별자가 없다. 열림·닫힘은 개수로만 맞춘다. RPC 시작 이벤트는 없다.

### 2.4 `RejectReason`

모두 `{ type: "rejected", reason, key? }` 하나의 모양이다. 기록은 판정한 모듈이 `recordDiagnostic`으로 한다(sender admission·envelope parse 사유는 server(`create-bridge-server.ts`)가 판정 결과를 받아 기록한다).

| `reason`              | `key`                 | 판정 지점(모듈)                                                                                                                          | 채널                         |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `frame-not-main`      | 없음                  | `DocumentSessions`의 sender admission: subframe이거나 현재 main frame이 아님                                                             | 모든 수신 요청               |
| `origin-not-allowed`  | 없음                  | `DocumentSessions`의 sender admission: 허용 목록 밖 origin                                                                               | 모든 수신 요청               |
| `sender-unauthorized` | 없음                  | `DocumentSessions`: disposed·미attach(admission), retired clientId·establish 경합(`establish`), clientId 불일치·retire된 세션(`current`) | 모든 수신 요청               |
| `version-mismatch`    | 없음                  | server envelope parse: `protocolVersion`이 1이 아닌 number                                                                               | handshake·rpc·cancel·control |
| `malformed-envelope`  | 없음                  | server envelope parse: 그 외 모든 parse 실패(구조 오류 input 포함)                                                                       | handshake·rpc·cancel·control |
| `unknown-operation`   | 없음                  | `RpcRequests`·`Subscriptions`의 등록 조회                                                                                                | rpc, subscribe               |
| `invalid-input`       | RPC 있음, stream 없음 | `RpcRequests`: 입력 스키마 실패(와 `parseBridgeValue` 구조 오류). `Subscriptions`: `subscriptionId` 형식 오류(등록 조회 전)              | rpc, subscribe               |
| `payload-too-large`   | 있음                  | `RpcRequests`: RPC 입력의 `PayloadLimitError`                                                                                            | rpc                          |
| `rpc-limit`           | 있음                  | `RpcRequests`: `maxConcurrentRpc` slot 획득 실패                                                                                         | rpc                          |
| `subscription-limit`  | 있음                  | `Subscriptions`: `maxSubscriptions` slot 획득 실패(등록 조회 뒤)                                                                         | subscribe                    |
| `authorize-denied`    | 있음                  | `authorization.ts`의 공유 authorize 단계: `authorize`가 `false`                                                                          | rpc, subscribe               |

"모든 수신 요청"은 handshake·rpc·cancel·control(subscribe·unsubscribe·acknowledge) 채널의 요청이다. sender admission 사유는 채널과 무관하게 같은 판정이 낸다.

`key` 유무는 타입이 강제한다. `rejected` 멤버는 세 갈래다: 등록 조회 뒤 사유 4개(`authorize-denied`·`payload-too-large`·`rpc-limit`·`subscription-limit`)는 `key` 필수, 조회 전 사유 6개는 `key?: never`, 두 경로에서 나오는 `invalid-input`만 `key` 선택이다. 그룹 타입은 공개하지 않는다.

기록하지 않는 거부: `authorize` 예외(응답은 `INTERNAL`, RPC는 `rpc-finished` `outcome: "error"`만), watermark 이하 `subscriptionId`의 조용한 무시, 입력 단계에서 이미 abort된 요청의 `CANCELLED`.

### 2.5 스냅샷

`server.getDiagnosticsSnapshot()`은 매 호출 새 객체를 반환한다.

| 필드            | 값                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------- |
| `sessions`      | 현재 세션이 있는 attachment 수                                                               |
| `rpcInFlight`   | RPC slot 전역 개수. handler가 실제로 끝날 때까지 센다. retire된 세션의 미종료 handler도 포함 |
| `subscriptions` | 구독 slot 전역 개수(`authorize` 대기 + 활성). 한도 계산과 같은 기준                          |
| `queuedEvents`  | 모든 consumer의 Event 대기 값 수 합                                                          |

누적 카운터(총 RPC 수, 총 거부 수)는 제공하지 않는다. 서버 dispose 뒤에는 `rpcInFlight`를 뺀 세 값이 0이다. 끝나지 않은 handler가 있으면 `rpcInFlight`는 실제 값이다.

### 2.6 Renderer 이벤트

| `type`                | 필드                                  | 기록 시점과 보장                                                                          | 기록 모듈                        |
| --------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------- |
| `rpc-settled`         | `key`, `durationMs`, `cause`, `code?` | RPC 호출 하나당 정확히 1회. 전송 전 거부 포함. 먼저 확정한 원인 하나                      | `RpcClient`                      |
| `subscription-opened` | `key`                                 | 원격 구독(generation) 등록 직후, subscribe control 전송 전. Main `subscribed` 수신과 무관 | `StreamMultiplexer`              |
| `subscription-closed` | `key`, `cause`, `code?`               | opened 1회당 정확히 1회. 로컬 구독자 수와 무관                                            | `StreamMultiplexer`              |
| `handshake-failed`    | `reason`                              | `createRendererApi`가 reject하기 직전 1회                                                 | `createRendererApi`              |
| `message-dropped`     | `reason`                              | 스트림 메시지를 버릴 때                                                                   | `StreamMultiplexer`              |
| `transport-failed`    | `channel`                             | 다른 이벤트로 드러나지 않는 삼킨 전송 실패만                                              | `RpcClient`, `StreamMultiplexer` |

원인 enum:

| enum                     | 값과 판정                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RpcSettleCause`         | `ok` 성공 응답. `remote-error` 원격 오류 응답(+`code`, Main의 `DEADLINE_EXCEEDED`·`CANCELLED`·`FORBIDDEN` 포함). `deadline` 로컬 timer. `aborted` `signal` abort(호출 전 포함). `disposed` dispose(호출 전 포함). `invalid-options` `timeoutMs` 검증 실패. `transport-failed` `invoke`의 동기 throw·reject. `malformed-response` 응답 parse 실패·`protocolVersion`/`clientId`/`requestId` 불일치 |
| `SubscriptionCloseCause` | `unsubscribed` 마지막 로컬 구독자 해제. `completed` `complete` 메시지. `remote-error` `error` 메시지(+`code`, retire 통지·`authorize` 거부·overflow 포함). `disposed` dispose. `transport-failed` subscribe control 전송 실패                                                                                                                                                                    |
| `HandshakeFailureReason` | `transport` `connect` throw·reject. `version-mismatch` `parseHandshakeResponse`의 `VERSION_MISMATCH`. `malformed` 그 외 parse 실패. `invalid-manifest` manifest entry 거부                                                                                                                                                                                                                       |
| `DroppedMessageReason`   | `malformed` `parseStreamMessage` 실패. `envelope-mismatch` `protocolVersion`·`clientId` 불일치. `out-of-order` 중복 `subscribed`, `sequence <= lastSequence`, `subscribed` 전 `batch`·`error`·`complete`                                                                                                                                                                                         |

`transport-failed`의 `channel`: `cancel`은 RPC 취소 중 `transport.cancel` throw(RPC 자체는 원래 원인으로 `rpc-settled`), `control`은 unsubscribe·acknowledge 전송 throw.

기록하지 않는 것: 모르는 `subscriptionId`의 메시지(unsubscribe와 Main 전송 사이의 정상 경합), dispose 뒤 도착한 메시지, dispose 뒤 억제한 acknowledge, `transport` 생략 시 전역 transport가 없어 던지는 `TypeError`(연결 설정 오류), 종료 뒤 subscribe(`LocalGeneration`이 multiplexer에 닿기 전에 거부한다).

## 3. 불변식

1. sink 유무·예외는 bridge 관측 결과(RPC 응답, stream 메시지, Renderer 확정 값)를 바꾸지 않는다.
2. sink가 없으면 어떤 콘솔·표준 출력도 없다.
3. 이벤트는 기록 금지 항목(2.1)을 싣지 않는다. 타입이 필드 추가를 막는다.
4. `key`는 등록 조회를 통과한 wire key만이다. 조회 전 거부는 `key`가 없다.
5. 한 요청에서 `rejected`는 최대 1회다. 각 거부 지점은 기록 직후 반환한다.
6. 한 RPC는 `rpc-timed-out`과 `rpc-cancelled` 중 먼저 확정된 하나만 남긴다. 순서는 `rpc-timed-out` → (handler 종료 시) `rpc-finished`다.
7. `rpc-finished`는 RPC slot을 얻은 요청마다 정확히 1회다. envelope·admission·등록 조회·`rpc-limit` 거부는 `rpc-finished`를 남기지 않는다.
8. `subscription-opened`/`subscription-closed`는 consumer마다 정확히 1쌍이다. `authorize` 대기 중이거나 시작 전 거부된 구독은 둘 다 남기지 않는다.
9. 한 구독의 구독 단위 진단(`stream-queue`·`stream-dropped`·`validation-failed`)은 `subscription-closed` 뒤에 나오지 않는다. sink가 재진입으로 구독을 닫으면 남은 진단을 생략한다.
10. 예외는 upstream 단위 이벤트 `upstream-teardown-failed`다. 구독을 닫은 뒤 해지하는 경로(unsubscribe·retire·전송 실패)에서는 그 구독의 `subscription-closed` 뒤에 온다.
11. `session-opened`/`session-closed`는 세션마다 1쌍이다. 반복 dispose는 추가 이벤트를 내지 않는다.
12. Electron adapter는 진단을 기록하지 않는다. sink에 접근하지 않는다. sink 설정 지점은 `createBridgeServer` 하나다.
13. Renderer `rpc-settled`는 호출당 정확히 1회, `subscription-opened`/`closed`는 generation당 정확히 1쌍, `handshake-failed`는 `createRendererApi`당 최대 1회다.
14. Renderer 전송 실패는 한 이벤트로만 드러난다. `invoke` 실패는 `rpc-settled(transport-failed)`만, subscribe 전송 실패는 `subscription-closed(transport-failed)`만 기록한다.
15. Renderer는 내부 상태를 갱신한 뒤, 사용자 통지(Promise resolve·reject, subscriber `next`·`error`·`complete`) 전에 동기로 기록한다. sink에서 API를 다시 호출해도 내부 상태는 이미 일관된다.

## 4. 흐름

### 4.1 Main RPC 요청의 진단 순서

1~7과 9는 처리 단계 순서다. 8(취소·deadline)은 5~7 어느 시점에도 끼어들 수 있다. 예: 출력 스키마 안에서 동기 cancel이 일어나면 `rpc-cancelled`가 `validation-failed`보다 먼저 기록된다. 고정된 순서는 `rpc-cancelled`·`rpc-timed-out`이 `rpc-finished`보다 앞선다는 것이다.

1. envelope parse 실패 → `rejected(malformed-envelope | version-mismatch)`. 끝.
2. sender admission: 새 세션이면 `session-opened`(같은 webContents의 이전 세션이 있으면 그 앞에 `session-closed`). 거부면 `rejected(frame-not-main | origin-not-allowed | sender-unauthorized)`. 끝.
3. 등록 조회 실패 → `rejected(unknown-operation)`. 끝.
4. slot 획득 실패 → `rejected(rpc-limit, key)`. 끝.
5. `authorize` `false` → `rejected(authorize-denied, key)`.
6. 입력 실패 → `rejected(payload-too-large | invalid-input, key)`. 이미 abort면 기록 없음.
7. 출력 경계 실패 → `validation-failed(key)`. 응답이 `CANCELLED`로 바뀌어도 기록한다.
8. 취소 → `rpc-cancelled(key)` 또는 deadline → `rpc-timed-out(key)`. 둘 중 하나.
9. handler work 종료, slot 반환 → `rpc-finished(key, durationMs, outcome)`.

sink 재진입 예: `session-opened` 안에서 detach하면 `session-opened` → `session-closed` → `rpc-cancelled` → `rpc-finished` 순서가 되고 handler는 호출되지 않는다.

### 4.2 Main 구독의 진단 순서

1. `subscriptionId` 형식 오류 → `rejected(invalid-input)`. 미등록 key → `rejected(unknown-operation)`. slot 부족 → `rejected(subscription-limit, key)`. `authorize` `false` → `rejected(authorize-denied, key)`, slot 반환보다 먼저 기록한다.
2. 승인 → consumer 등록 → `subscription-opened(key)` → `subscribed` 송신 → upstream 연결.
3. 전달 중: Event push마다 `stream-dropped`(가득 찬 경우) → `stream-queue`, shift마다 `stream-queue`. 출력 경계 실패는 `validation-failed` 뒤 `error INTERNAL`.
4. 닫힘 순서: `subscription-closed` 기록 → slot 반환 → consumer `AbortSignal` abort → upstream 해지.
5. 해지 중 사용자 teardown이 throw → `upstream-teardown-failed(key)`. 예외는 삼키고 정리는 끝난다.

### 4.3 Renderer의 기록 지점

- `RpcClient.call`: 확정 선점(`beginSettlement`)을 통과한 첫 원인만 `rpc-settled`를 기록한다. cancel 전송보다 확정 기록이 먼저다. `transport.cancel`이 동기로 abort·dispose를 재진입시켜도 1회다.
- `StreamMultiplexer.#terminate`: identity guard → generation 삭제 → `subscription-closed` → cause별 unsubscribe 전송 → cause별 handler 통지. guard가 1회를 보장한다.
- `StreamMultiplexer.open`: `subscription-opened` 기록 뒤 generation이 여전히 등록돼 있을 때만 subscribe를 보낸다. sink가 dispose를 재진입시켰으면 보내지 않는다.

## 5. 설계 이유와 기각한 대안

**게이지는 스냅샷, 사건은 이벤트.** 현재 활성 수를 이벤트에서 재구성하게 하지 않는다. 스냅샷은 한도 판정과 같은 카운터를 읽는다.

**거부는 이벤트 타입 하나에 enum 사유.** 소비자는 `type`으로 한 번, `reason`으로 한 번 분기한다. `key` 유무 규칙은 타입이 강제해 sink가 `reason`으로 좁히면 `key` 타입이 정해진다.

**판정은 server가 하고 기록도 server가 한다.** sender admission과 envelope parse를 server가 소유하므로 adapter가 sink에 닿을 이유가 없다. 같은 요청에 두 지점이 각자 `rejected`를 기록하지 않도록 조율할 필요도 없다.

**Main과 Renderer 타입을 분리한다.** 관측 지점과 식별자 규칙이 다르다. Renderer에는 `RejectReason`이 없고 로컬 확정 원인(`deadline`·`aborted`·`disposed`)이 있다. 한 유니온에 섞으면 양쪽 소비자의 분기가 늘어난다. Renderer 격리 함수를 `src/renderer`에 두어 Renderer 번들이 `src/main`을 import하지 않는다. `RpcClient`·`StreamMultiplexer`는 Renderer main world에서 실행되므로 sink 콜백은 `contextBridge`를 건너지 않는다.

**Renderer에는 스냅샷이 없다.** Renderer는 세션 하나이고 자원 한도가 없다. 활성 구독 수는 opened/closed 쌍으로 센다. 루트 API에 예약 이름을 늘리지 않는다.

기각한 대안:

- 스냅샷에 누적 카운터를 둔다: "언제부터의 누적인가"가 관측자마다 다르다. 이벤트를 원하는 창으로 직접 집계한다.
- `RejectReason`마다 별도 이벤트 타입을 둔다: 유니온이 11개 늘어 분기 부담이 커진다.
- sink 미지정 시 `console`에 출력한다: 라이브러리가 호스트의 로그 정책을 정하게 된다.
- `stream-queue` 빈도를 라이브러리가 낮춘다: 샘플링 기준은 소비자가 sink 안에서 정한다.
- adapter가 sink를 직접 받거나 내부 Symbol 통로로 기록한다: sink 설정 지점이 둘로 늘고 중복 기록 조율이 남는다.
- wire 거부 응답에 `RejectReason`을 싣는다: Renderer는 신뢰 경계 밖이라 admission 판정 근거를 탐색하는 데 쓸 수 있다. 사유는 운영자용 진단에만 싣는다.
- `sender-unauthorized` 하나로 frame·origin 불일치까지 묶는다: 사유만으로 원인을 좁힐 수 없다.
- teardown 예외를 진단 없이 삼킨다: 사용자 source 결함이 조용히 사라진다.
- `upstream-teardown-failed`를 `subscription-closed` 앞에 두려고 해지를 먼저 한다: 사용자 teardown이 consumer `AbortSignal` abort보다 먼저 실행되는 순서 변경이 생긴다.
- Renderer가 Main 타입을 재사용한다: 위 분리 이유와 같다.
- Renderer 스냅샷 API: 루트 예약어가 늘거나 `createRendererApi` 반환 모양이 바뀐다.
- Renderer 이벤트에서 `code`를 뺀다: 도메인 에러와 `INTERNAL`을 구분할 수 없다.
- 모르는 `subscriptionId` 메시지를 기록한다: 정상 경합마다 이벤트가 생긴다.

## 6. 한계

- 이벤트만으로 어떤 세션·요청·구독이 원인인지 특정할 수 없다. 기록 금지가 의도적으로 막는다.
- `stream-queue`는 push·shift마다 기록돼 고빈도 Event에서 이벤트가 많다.
- 스냅샷 `subscriptions`(대기+활성)와 opened/closed 쌍(활성만)의 개수는 다를 수 있다. `authorize-denied` 기록 중 sink가 스냅샷을 읽으면 그 구독이 아직 대기로 남아 1 크다.
- `rpcInFlight`는 전역 값이라 세션별 점유를 스냅샷으로 알 수 없다.
- RPC 출력 경계 실패는 응답이 `CANCELLED`로 바뀌어도 `validation-failed`를 기록한다. 입력 실패의 abort 처리(기록 없음)와 다르다.
- retire된 문서가 늦게 보낸 cancel·control도 `rejected(sender-unauthorized)`를 남긴다. 소음으로 수용한다.
- preload transport는 수신 parse 실패를 sink 없이 먼저 버린다. 그래서 preload 경로에서는 `message-dropped(malformed)`가 기록되지 않는다. handshake 응답 parse 실패와 Main의 handshake 거부는 `handshake-failed(transport)`로, RPC 응답 parse 실패는 `rpc-settled(transport-failed)`로 보인다. Renderer의 `malformed`·`malformed-response`는 사용자 정의 transport나 요청 불일치에서만 관측된다.
- operator를 거친 source(`inner.pipe(...)`)가 구독 중 동기로 끝나고 teardown이 throw하면 rxjs가 예외를 삼켜 `upstream-teardown-failed`가 남지 않는다.
- Renderer `durationMs`는 Renderer 벽시계 기준이며 IPC 왕복을 포함한다. Main `rpc-finished.durationMs`와 값이 다르다.

## 7. 관련 문서

- ADR: [0010 운영 진단](../adr/0010-operational-diagnostics.md), [0011 authorize 예외 INTERNAL](../adr/0011-authorize-exception-internal.md), [0016 sender admission](../adr/0016-sender-admission.md), [0022 Renderer 진단](../adr/0022-renderer-diagnostics.md), [0025 upstream teardown 격리](../adr/0025-upstream-teardown-isolation.md)
- 설계 문서: [04. 문서 세션](04-document-session.md), [05. RPC](05-rpc.md), [06. Main 스트림 전달](06-stream-delivery.md), [07. Renderer 스트림과 State](07-renderer-streams.md), [08. Payload와 오류 모델](08-payload-and-errors.md), [09. 세션 자원 한도](09-resource-limits.md), [10. 종료](10-shutdown.md)
