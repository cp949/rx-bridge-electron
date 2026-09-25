# 09. 세션 자원 한도

## 1. 목적과 범위

한 렌더러 문서 세션이 Main 자원을 얼마나 쥘 수 있는지, 한도를 넘으면 무엇이 일어나는지, slot을 언제 돌려받는지 정한다.

다루는 것:

- `resourceLimits` 네 항목의 기본값·검증·초과 결과
- 세션별 한도와 전역 상한이 없는 이유
- `SessionSlots` slot 회계, RPC·구독 인스턴스 분리
- slot 반환 시점(RPC, 구독)과 점유가 길어지는 경우
- 판정 순서에서 slot의 위치
- retired client ID 보관량

다루지 않는 것:

- RPC 처리 순서, 취소·deadline 흐름: [05. RPC](05-rpc.md)
- 구독 판정 순서 전체, 전달 창, Event buffer: [06. Main 스트림 전달](06-stream-delivery.md)
- `payloadLimits`(`maxTotalBytes` 포함): [08. Payload와 오류 모델](08-payload-and-errors.md)
- retire 사유와 retired clientId 재사용 금지 판정: [04. 문서 세션](04-document-session.md)
- 스냅샷·진단 이벤트: [11. 진단](11-diagnostics.md)

## 2. 모델

| 개념                  | 소유자                        | 역할                                                                                |
| --------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `ResourceLimits`      | `src/main/resource-limits.ts` | 네 항목. `DEFAULT_RESOURCE_LIMITS`(동결)와 `resolveResourceLimits`가 해석한다       |
| `SessionSlots`        | `src/main/session-slots.ts`   | 세션별 slot 한도 판정, 반납, 전역 집계, retire listener 연동                        |
| `SlotLease`           | `SessionSlots.acquire()` 반환 | slot 1개. `release()`로 반납, `onRetire`/`offRetire`로 retire 통지 등록             |
| RPC slot 인스턴스     | `RpcRequests` 생성자          | `new SessionSlots(maxConcurrentRpc)`                                                |
| 구독 slot 인스턴스    | `Subscriptions` 생성자        | `new SessionSlots(maxSubscriptions)`                                                |
| retired clientId 기록 | `DocumentSessions`            | `webContentsId`별 retired clientId 집합. `maxRetiredClientsPerWebContents`로 자른다 |

설정은 `createBridgeServer(impl, { resourceLimits })` 서버 옵션이다. 계약에는 두지 않는다. Main만 강제하고 Renderer는 사전 차단하지 않는다. Renderer는 받은 오류 코드를 `RemoteError`로 그대로 전달한다.

### 한도 4종

| 옵션                              | 기본값  | 세는 대상                                                          | 초과 시 결과                                                                                                                                                | 검증 규칙                                         |
| --------------------------------- | ------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `maxConcurrentRpc`                | 64      | 세션당 slot을 쥔 RPC 요청(`authorize` 대기 포함, 작업 종료 전까지) | `RESOURCE_EXHAUSTED "Too many concurrent bridge requests."`. `authorize`·handler 미호출. 진단 `rejected`/`rpc-limit`(key 포함)                              | 1 이상 safe integer. `Infinity` 불가              |
| `maxSubscriptions`                | 256     | 세션당 구독(`authorize` 대기 + 활성)                               | `subscribed`(0) 다음 `error RESOURCE_EXHAUSTED "Too many bridge subscriptions."`. `authorize`·source 미호출. 진단 `rejected`/`subscription-limit`(key 포함) | 1 이상 safe integer. `Infinity` 불가              |
| `maxRpcDurationMs`                | 300,000 | RPC 1건의 작업 시간(`authorize` 대기 + pipeline + handler)         | handler `signal` abort, `DEADLINE_EXCEEDED "Request exceeded the server deadline."` 즉시 응답, 진단 `rpc-timed-out`. slot은 반환하지 않는다                 | 1~2,147,483,647 정수 또는 `Infinity`(타이머 없음) |
| `maxRetiredClientsPerWebContents` | 32      | `webContents`별 retired clientId 기록 수                           | 가장 오래된 기록부터 제거. 오류 없음                                                                                                                        | 1 이상 safe integer. `Infinity` 불가              |

공통 검증(`resolveResourceLimits`):

- 옵션 생략은 기본값 전체다. 지정한 필드만 덮어쓴다(병합). 결과는 동결한다.
- 알 수 없는 key는 `TypeError("Unknown resource limit '<key>'.")`.
- 명시적 `undefined`는 생략과 다르다. 값 검증에 걸려 `TypeError`다.
- 정수 한도 위반은 `TypeError("Resource limit '<key>' must be a positive safe integer.")`, deadline 위반은 `TypeError("Resource limit 'maxRpcDurationMs' must be an integer from 1 to 2147483647 or Infinity.")`.
- 검증은 서버 생성 시점이다. 실패하면 서버를 만들지 않고 source를 구독하지 않는다.

`maxRpcDurationMs` 상한 2,147,483,647은 `setTimeout` 한계다. 그보다 큰 지연은 1ms로 바뀌어 즉시 deadline이 된다.

### `SessionSlots` 회계

- `acquire(session)`: 그 세션의 미반납 lease 수가 한도 이상이면 `undefined`. 아니면 세션별 수와 전역 수를 1씩 올리고 lease를 돌려준다.
- 세션별 수는 `WeakMap<DocumentSession, number>`다. 새 세션은 0에서 시작한다.
- `release()`는 멱등이다. 두 번째 호출부터 아무 일도 하지 않는다. 반납 때 등록된 retire listener도 해제한다.
- `count()`는 전역 미반납 lease 수다. retire된 세션의 미반납 lease도 release 전까지 센다. 순회 API는 없다.
- `onRetire(listener)`는 lease당 한 번에 하나다. 이미 등록됐으면 `Error`를 던진다. 세션이 이미 retire됐으면 반환 전에 동기 1회 호출하고 등록을 남기지 않는다. release된 lease는 등록하지 않고, 세션이 이미 retire 상태일 때만 1회 호출한다.
- `offRetire()`는 listener만 해제하고 slot은 유지한다.
- `SessionSlots`는 id → entry map, 중복 요청 선취소, watermark, wire 진단을 모른다. slot을 언제 반납할지는 호출자가 정한다.

slot 반납과 retire 통지 등록을 lease 안에서 분리한 이유: RPC는 retire 때 요청을 취소하되 slot을 유지하고, 구독은 retire 때 slot을 즉시 반납한다. 한 lease가 두 정책을 모두 받쳐야 한다.

RPC와 구독은 서로 다른 인스턴스를 쓴다. 한도와 세는 값이 따로다. RPC가 구독 slot을 쓰거나 그 반대인 경우는 없다.

## 3. 불변식

1. 모든 한도는 세션별이다. 서버 전역(모든 세션 합) 상한은 없다. 한 세션이 한도를 소진해도 다른 세션의 RPC·구독은 영향받지 않는다.
2. slot 한도 판정은 등록 조회 뒤, `authorize` 앞이다. 미등록 key와 형식 오류는 slot을 쓰지 않는다. 한도 초과 거부도 slot을 쓰지 않는다.
3. RPC slot은 작업(`authorize`·pipeline·handler)이 실제로 끝날 때 반환한다. 취소·deadline·retire 응답이 먼저 나가도 같다.
4. 구독 slot은 대기부터 terminal까지 1개다. source 쪽 종료는 terminal 전송 뒤에, 그 외 종료는 즉시 반환한다.
5. 전역 집계(`count()`)는 retire된 세션의 미반납 lease를 포함한다.
6. 전역 집계는 `getDiagnosticsSnapshot()`의 `rpcInFlight`(RPC 인스턴스)와 `subscriptions`(구독 인스턴스)다. 의미는 [11. 진단](11-diagnostics.md)이 소유한다.

## 4. 흐름

### 판정 순서에서 slot 위치

| 경로 | 순서                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| RPC  | envelope parse → sender admission → 등록 조회 → **RPC slot** → `authorize` → pipeline([05](05-rpc.md))                                |
| 구독 | envelope parse → sender admission → ID 형식 → watermark → 등록 조회 → **구독 slot** → `authorize` → 시작([06](06-stream-delivery.md)) |

등록 조회가 먼저라서 한도 거부 진단(`rpc-limit`, `subscription-limit`)에 key가 실린다. slot이 `authorize` 앞이라서 `authorize`(호스트 코드) 대기 수도 한도에 묶인다.

### RPC slot 반환

| 사건                                                  | 응답                                | slot                  |
| ----------------------------------------------------- | ----------------------------------- | --------------------- |
| handler 정상·예외 종료                                | 결과 또는 오류                      | 작업 종료 때 반환     |
| `authorize` 거부·예외                                 | `FORBIDDEN`·`INTERNAL`              | 작업 종료 때 반환     |
| Renderer cancel, 세션 retire, 같은 `requestId` 재요청 | 작업 종료나 deadline 때 `CANCELLED` | handler 종료까지 유지 |
| Main deadline                                         | 즉시 `DEADLINE_EXCEEDED`            | handler 종료까지 유지 |

이유: slot은 실제로 실행 중인 작업 수다. 응답 시점에 반환하면 `signal`을 무시하는 handler가 한도 밖에서 계속 쌓인다.

결과:

- `signal`을 무시하는 handler는 자기 세션의 slot을 끝날 때까지 쥔다. 다른 세션에는 영향이 없다.
- Renderer `timeoutMs` 만료는 cancel을 보내 handler `signal`을 abort할 뿐이다. slot은 handler가 끝날 때 빈다. `maxConcurrentRpc: 1`에서 `signal`을 무시하는 handler 뒤로 곧바로 재시도하면 `DEADLINE_EXCEEDED`가 아니라 `RESOURCE_EXHAUSTED`로 끝난다. 재시도에는 간격이 필요하다.
- 같은 `requestId` 재요청은 새 slot을 먼저 얻는다. 한도에 걸리면 앞 요청은 취소되지 않는다. 얻으면 앞 요청은 취소되지만 그 slot은 앞 handler가 끝날 때까지 남는다.

### 구독 slot 반환

| 사건                                                               | 통지                                                                | slot                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------- |
| ID 형식 오류·watermark 이하·미등록 key·한도 초과                   | 형식 오류·`NOT_FOUND`·`RESOURCE_EXHAUSTED`(watermark 이하는 무출력) | 획득하지 않음                                         |
| `authorize` 대기 중 unsubscribe                                    | 없음                                                                | 즉시 반환                                             |
| `authorize` 대기 중 retire                                         | detach·dispose면 `error CANCELLED`                                  | 즉시 반환                                             |
| `authorize` 거부·예외                                              | `FORBIDDEN`·`INTERNAL`                                              | `authorize-denied` 진단(거부일 때) 뒤, 통지 전에 반환 |
| `authorize` 승인                                                   | `subscribed`                                                        | 반환 없음. 같은 lease를 consumer가 이어받는다         |
| 활성 unsubscribe                                                   | 없음. 대기 값은 버린다                                              | 즉시 반환                                             |
| 활성 중 retire                                                     | detach·dispose면 `error CANCELLED`                                  | 즉시 반환                                             |
| 전송 실패                                                          | —                                                                   | 즉시 반환                                             |
| source 완료·오류·`error` 정책 overflow·출력 검증 실패·시작 중 예외 | 대기 값을 ack 순서대로 보낸 뒤 terminal                             | terminal 전송 뒤 반환                                 |

승인 이음 구간(pending → consumer)에는 진단·`send`·`authorize`·source 호출이 없다. 외부 코드가 관측하는 모든 지점에서 slot 수는 pending + consumer 수와 같다.

### ack하지 않는 소비자

ack를 보내지 않는 소비자는 unsubscribe·세션 retire 전까지 다음을 쥔다.

- 구독 slot 1개
- 대기 값: Event는 최대 buffer capacity개, State는 최신값 1개
- source가 끝나도 terminal이 대기 값 뒤에 있으므로 slot은 돌아오지 않는다

영향은 그 세션의 `maxSubscriptions` 안에 머문다.

### retired clientId 보관

`webContentsId`별 retired clientId 집합이 `maxRetiredClientsPerWebContents`를 넘으면 가장 오래된 항목부터 지운다. 오류는 없다. 기록 추가·삭제 시점과 재사용 금지 판정은 [04. 문서 세션](04-document-session.md)이 소유한다. 기록에서 밀려난 옛 clientId는 sender admission의 frame 검사(`frame-not-main`)가 막는다. 옛 문서는 이미 현재 main frame이 아니다.

## 5. 설계 이유와 기각한 대안

- 한도를 세션 단위로 둔다: Main 자원은 프로세스가 공유하지만 소유는 문서 세션이다. 과부하를 그 세션 안에 가둔다.
- 구독 대기와 활성을 한 한도로 센다: `authorize` 대기 중인 구독도 controller와 pending entry를 쥔다.
- 전역 in-flight를 lease 획득·반환 때 직접 증감한다: retire된 세션의 미종료 handler도 세야 한다. 세션 상태는 `WeakMap`이라 순회할 수도 없다.

기각한 대안:

- Renderer 사전 차단: 여러 Renderer가 Main 자원을 공유한다. 강제 지점은 자원을 쥔 Main이어야 하고 Renderer 차단은 우회 가능한 힌트다([ADR 0009](../adr/0009-session-resource-limits.md)).
- 계약에 한도를 둔다: 동시성·시간 상한은 배포 환경의 운영 판단이다. 도메인 작성자가 정할 값이 아니다([ADR 0009](../adr/0009-session-resource-limits.md)).
- 서버 전역 상한: 한 세션의 정상 사용이 다른 세션 때문에 거부된다. "한 세션의 과부하가 다른 세션을 막지 않는다"와 충돌한다([ADR 0009](../adr/0009-session-resource-limits.md)).
- RPC slot을 취소·deadline 응답 때 반환: `signal`을 무시하는 handler가 한도 밖에서 누적된다([ADR 0009](../adr/0009-session-resource-limits.md) 결정 10).
- 전역 in-flight를 세션 상태 순회로 계산: retire된 세션의 미종료 handler가 빠진다([ADR 0015](../adr/0015-rpc-request-lifecycle.md)).
- retired clientId를 dispose 때 지운다: 재사용 금지가 종료 뒤 조용히 무력화된다([ADR 0006](../adr/0006-shutdown-contract.md)).

## 6. 한계

- 끝나지 않는 handler나 `authorize`는 RPC slot을 영구히 쥔다. retire와 deadline 모두 slot을 풀지 않는다.
- 새 세션은 slot 0에서 시작한다. reload를 반복하면 retire된 세션의 미종료 handler가 한도 밖에서 누적된다. 전역 상한이 없으므로 이 누적은 `rpcInFlight`로 관측만 한다.
- ack하지 않는 소비자는 retire 전까지 slot과 대기 값을 쥔다.
- detach·`server.dispose()` 뒤에는 수명 사건 구독이 해제된다. 그 뒤 `destroyed`가 와도 해당 `webContentsId`의 retired 기록(최대 `maxRetiredClientsPerWebContents`개)은 지워지지 않는다.
- 기록에서 밀려난 clientId는 기록이 아니라 frame 검사로만 재사용을 막는다.
- `maxTotalBytes`는 IPC 역직렬화 뒤에 적용되므로 수신 메모리 자체는 막지 못한다([08](08-payload-and-errors.md)).

## 7. 관련 문서

- ADR: [0009](../adr/0009-session-resource-limits.md), [0015](../adr/0015-rpc-request-lifecycle.md), [0014](../adr/0014-stream-lookup-before-authorize.md), [0011](../adr/0011-authorize-exception-internal.md), [0006](../adr/0006-shutdown-contract.md), [0010](../adr/0010-operational-diagnostics.md)
- 설계 문서: [04. 문서 세션](04-document-session.md), [05. RPC](05-rpc.md), [06. Main 스트림 전달](06-stream-delivery.md), [08. Payload와 오류 모델](08-payload-and-errors.md), [10. 종료](10-shutdown.md), [11. 진단](11-diagnostics.md)
