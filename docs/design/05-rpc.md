# 05. RPC

## 1. 목적과 범위

RPC 요청 1건이 Main과 Renderer에서 어떤 순서로 판정되고, 취소·timeout·deadline과 경합할 때 어떤 결과 하나로 끝나는지 정한다.

다루는 것:

- Main `RpcRequests`의 처리 순서와 각 순서의 이유
- `CANCELLED` 우선 guard와 적용 경계 다섯 곳
- `authorize` 뒤 세션 재검사를 하지 않는 가설
- handler가 받는 `BridgeContext`
- 취소 경로 세 가지(Renderer cancel, 세션 retire, Main deadline)와 같은 `requestId` 재요청
- Renderer `RpcClient`의 최종 결과 하나, `timeoutMs`, 늦은 응답 무시, `requestId`

다루지 않는 것:

- envelope·채널·preload 배선: [03. Transport와 배선](03-transport-and-wiring.md)
- sender admission과 retire 사유·시점: [04. 문서 세션](04-document-session.md)
- 값 프로필, payload 한도, 출력 경계(`parseOutput`) 내부 순서, 오류 코드 전체 표, `authorize` 예외 분류: [08. Payload와 오류 모델](08-payload-and-errors.md)
- slot 한도 수치, slot 회계, `maxRpcDurationMs` 설정 규칙: [09. 세션 자원 한도](09-resource-limits.md)
- `api.dispose()`·`server.dispose()`의 종료 판정과 재진입: [10. 종료](10-shutdown.md)
- 진단 이벤트 목록과 sink 격리: [11. 진단](11-diagnostics.md)

## 2. 모델

| 개념                                   | 소유자                                             | 역할                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| RPC 요청                               | Main `RpcRequests` (`src/main/rpc-requests.ts`)    | 렌더러 문서 세션이 소유하는 요청-응답 단위. 수명은 등록 조회·slot 획득부터 handler 종료와 slot 반환까지                                 |
| active 요청 map                        | `RpcRequests`                                      | 세션별 `WeakMap<DocumentSession, Map<requestId, ActiveRequest>>`. entry는 진단용 `key`, 취소용 `AbortController`, slot lease를 쥔다     |
| `cancelledIfAborted(signal, envelope)` | `rpc-requests.ts` module 함수                      | `CANCELLED` 우선 규칙의 단일 정의. aborted면 `CANCELLED "Request cancelled."` 응답, 아니면 `undefined`                                  |
| authorize 판정 단계                    | `authorizeOperation` (`src/main/authorization.ts`) | RPC·stream 공유. `authorize` 호출, 예외·거부 분류, `authorize-denied` 진단. 결과는 `AuthorizeVerdict`(`allowed`/`rejected`/`cancelled`) |
| slot lease                             | `SessionSlots` (`src/main/session-slots.ts`)       | 세션별 동시 RPC 한도 판정, retire listener 연동. 상세는 [09](09-resource-limits.md)                                                     |
| 세션 해석                              | `create-bridge-server.ts`의 `dispatchRpc`·`cancel` | envelope parse와 admission만 하고 `RpcRequests.dispatch`·`cancel`에 위임                                                                |
| `RpcClient`                            | Renderer (`src/renderer/rpc-client.ts`)            | 호출 1건의 로컬 확정(응답·취소·timeout·dispose 중 하나), cancel 전송                                                                    |
| `RemoteError`                          | Renderer (`src/renderer/remote-error.ts`)          | 확정된 실패의 유일한 형태. `code`·`message`·`details?`만 가진다                                                                         |

`RpcRequests`는 `DocumentSessions`를 모른다. `DocumentSession` 타입만 참조한다. `DocumentSessions`도 RPC를 모른다.

### handler context

`authorize`와 handler는 요청마다 한 번 만든 같은 `BridgeContext`를 받는다.

| 필드         | 값                                    |
| ------------ | ------------------------------------- |
| `requestId`  | envelope의 `requestId`                |
| `clientId`   | envelope의 `clientId`                 |
| `windowRole` | `attach(contents, role?)`로 정한 역할 |
| `sender`     | adapter가 번역한 `SenderIdentity`     |
| `signal`     | 요청 전용 `AbortController.signal`    |

`signal`을 abort하는 원인은 넷이다: Renderer cancel, 세션 retire, Main deadline, 같은 세션의 같은 `requestId` 재요청. handler는 `signal`로 취소를 관측한다. `signal`을 무시해도 응답 규칙은 같고, slot 점유만 길어진다.

## 3. 불변식

1. 미등록 key는 `authorize` 호출 없이 `NOT_FOUND "Unknown bridge operation."`이다. `authorize`는 등록된 operation만 받는다.
2. slot 한도 초과는 `authorize`·handler 호출 없이 `RESOURCE_EXHAUSTED "Too many concurrent bridge requests."`다. 이 거부는 같은 `requestId`의 진행 중 요청을 취소하지 않는다.
3. 다섯 경계(`authorize` 뒤, `parseBridgeValue` 실패, 입력 스키마 실패, handler 뒤, 출력 경계 실패)에서 signal이 aborted면 `CANCELLED`가 그 경계의 원래 분류보다 우선한다. `"Request cancelled."` 문자열은 `cancelledIfAborted` 한 곳에서만 만든다.
4. slot은 응답 시점이 아니라 authorize·pipeline·handler를 감싼 작업이 실제로 끝날 때 반환한다. 취소·deadline 응답이 먼저 나가도 같다.
5. 요청 1건의 Main 진단은 `rpc-timed-out`과 `rpc-cancelled` 중 먼저 확정된 원인 하나만 남긴다. `rpc-finished`는 작업이 끝날 때 1회다([11. 진단](11-diagnostics.md)).
6. `authorize` 뒤 세션이 여전히 현재인지 다시 해석하지 않는다. 요청 signal만 본다(아래 5절 가설).
7. Renderer 호출 1건은 응답·취소·timeout·dispose·전송 실패 중 먼저 일어난 하나로만 확정된다. 확정 뒤 도착한 응답은 버린다.
8. Renderer cancel은 호출당 최대 1회, 이미 `transport.invoke`를 호출한 요청에만 보낸다.

## 4. 흐름

### Main 처리 순서

| #   | 단계                                                | 실패 결과                                                                                            | 순서의 이유                                                                                                                                  |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | envelope parse(`parseWireRpcRequest`, version 포함) | `VERSION_MISMATCH "Unsupported protocol version."` 또는 `INVALID_ARGUMENT "Invalid bridge request."` | 형식이 틀린 값에서 세션·key를 읽지 않는다                                                                                                    |
| 2   | sender admission(`sessions.establish`)              | `FORBIDDEN "Bridge sender is not authorized."`                                                       | 세션이 있어야 slot·active map을 세션 단위로 잡는다([04](04-document-session.md))                                                             |
| 3   | 등록 조회(`table.rpc.get(key)`)                     | `NOT_FOUND "Unknown bridge operation."`                                                              | manifest가 모든 Renderer에 공개되므로 key 존재는 비밀이 아니다. `authorize` 결과와 무관하게 같은 입력에 같은 코드를 낸다. slot을 쓰지 않는다 |
| 4   | slot 획득(`SessionSlots.acquire`)                   | `RESOURCE_EXHAUSTED "Too many concurrent bridge requests."`                                          | 호스트 코드(`authorize`) 실행 전에 동시 수를 묶는다. 등록 조회 뒤라 진단 `rpc-limit`에 key가 실린다                                          |
| 5   | 요청 등록(`#begin`)                                 | —                                                                                                    | 같은 `requestId`의 active 요청을 먼저 취소하고, 새 controller를 등록하고, lease에 retire listener를 단다                                     |
| 6   | `authorize`(`authorizeOperation`)                   | `FORBIDDEN "Bridge operation is forbidden."`, 예외는 `INTERNAL "Internal bridge error."`             | `authorize`는 입력을 받지 않는다(context·operation만). 거부된 요청은 payload 순회·입력 스키마·handler에 닿지 않는다                          |
| 7   | `parseBridgeValue(input, payloadLimits)`            | `INVALID_ARGUMENT "Invalid bridge argument."`                                                        | 사용자 코드(스키마) 전에 구조·크기를 먼저 확인한다([08](08-payload-and-errors.md))                                                           |
| 8   | 입력 스키마(있으면)                                 | `INVALID_ARGUMENT "Invalid bridge argument."`                                                        | handler는 스키마 변환 결과를 받는다                                                                                                          |
| 9   | handler                                             | 선언 도메인 에러 또는 `INTERNAL`                                                                     | 분류는 [08](08-payload-and-errors.md)                                                                                                        |
| 10  | 출력 경계(`parseOutput`)                            | `INTERNAL "Internal bridge error."`                                                                  | 내부 순서는 [08](08-payload-and-errors.md)                                                                                                   |

3~10단계는 `RpcRequests` 하나가 소유한다. 6~10단계는 한 비동기 작업으로 돌고, `maxRpcDurationMs`가 유한하면 작업을 시작한 직후(작업의 첫 동기 구간 뒤) deadline 타이머를 건다. 측정 구간은 `authorize` 대기와 handler 실행을 포함하고 1~5단계는 포함하지 않는다. `authorize`를 생략하면 판정이 동기라서 요청 시작부터 handler 호출까지 같은 tick에서 진행한다. `authorize`가 있으면 판정은 settle 뒤 microtask 한 단계 늦게 온다.

### `CANCELLED` 우선 guard

| 경계                                 | guard 위치                                                                              | 진단과의 순서                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `authorize` 뒤(정상 반환·throw 모두) | 공유 단계가 aborted면 `cancelled` verdict를 내고, `RpcRequests`가 guard로 응답을 만든다 | aborted 판정이 `authorize-denied` 진단보다 먼저다 |
| `parseBridgeValue` 실패              | catch 첫 줄                                                                             | aborted면 `rejected` 진단 없이 반환               |
| 입력 스키마 실패                     | catch 첫 줄                                                                             | aborted면 `rejected` 진단 없이 반환               |
| handler 뒤(정상 반환·throw 모두)     | throw면 catch 첫 줄, 정상이면 출력 경계 직전                                            | 도메인 에러 직렬화보다 먼저                       |
| 출력 경계 실패                       | catch 안, `validation-failed` 기록 뒤                                                   | `validation-failed`를 먼저 기록한다               |

동기 단계에도 guard를 둔다. `await`가 없어도 스키마 `parse`(사용자 코드)나 Proxy 입력의 trap(in-process 호출자)이 같은 호출 안에서 `server.cancel`을 불러 signal을 abort할 수 있다. 출력 스키마 안에서 `server.cancel`을 동기 호출하는 경로는 test가 고정한다.

`authorize-denied` 진단 sink 안에서 detach가 일어나도 응답은 `FORBIDDEN`이다. aborted 판정이 진단 기록보다 먼저 끝났기 때문이다.

### 취소 경로

| 원인                           | Main 동작                                                                                                                       | Main 응답                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Renderer cancel(`cancel` 채널) | `sessions.current`로 세션 해석 → `RpcRequests.cancel` → entry 제거·retire listener 해제·abort·`rpc-cancelled`                   | 작업이 끝날 때 guard가 `CANCELLED`. deadline이 먼저 오면 그 시점에 `CANCELLED`(`rpc-timed-out` 없음) |
| 세션 retire                    | lease의 retire listener가 같은 `#cancelActive`를 부른다                                                                         | 위와 같다                                                                                            |
| Main deadline                  | 이미 aborted면 `CANCELLED`만 확정. 아니면 abort → `rpc-timed-out` → `DEADLINE_EXCEEDED "Request exceeded the server deadline."` | 타이머 시점에 즉시 확정                                                                              |
| 같은 `requestId` 재요청        | slot 획득 뒤 `#begin`이 앞 요청을 `#cancelActive`                                                                               | 앞 요청은 `CANCELLED`, 뒤 요청은 정상 진행                                                           |

- cancel은 fire-and-forget이다. parse·admission 실패는 진단만 남기고 응답하지 않는다. active에 없는 `requestId`는 무시한다.
- Renderer cancel은 Main 응답을 앞당기지 않는다. Main 응답은 작업 종료나 deadline 중 먼저 오는 쪽이다. Renderer는 이미 로컬에서 확정했으므로 이 응답을 버린다.
- deadline 뒤 도착한 cancel·retire·재요청은 entry를 정리만 하고 `rpc-cancelled`를 남기지 않는다(`#cancelActive`가 이미 aborted인 controller를 건너뛴다).
- deadline 응답 뒤 작업 결과는 버린다. `rpc-finished.outcome`은 작업의 실제 응답으로 판정한다.
- retire 시 `rpc-cancelled`와 구독 종료 진단의 상대 순서는 요청·구독의 retire listener 등록 순서를 따른다. 이 순서에 기대는 계약은 없다.

### Renderer `RpcClient.call`

1. API가 dispose됐으면 전송 없이 `CANCELLED "Renderer API is disposed."`.
2. `signal`이 이미 aborted면 전송 없이 `CANCELLED "RPC call was cancelled."`.
3. `timeoutMs` 검사. 생략하면 30,000ms. `Infinity`는 타이머 없음. 음수·`NaN`·그 밖의 비유한값은 전송 없이 `INVALID_ARGUMENT "RPC timeout must be a non-negative finite number or Infinity."`. 0은 허용한다.
4. `requestId = createOpaqueId("request")`.
5. dispose listener를 pending 집합에, abort listener를 `signal`에 등록한다. 등록 직후 aborted를 다시 확인한다.
6. 유한 timeout이면 타이머를 건다. 만료 시 `DEADLINE_EXCEEDED "RPC call exceeded its deadline."`.
7. `transport.invoke({ requestId, key, input })`. 동기 throw나 reject는 `INTERNAL "RPC transport failed."`(cancel 없음).
8. 응답이 오면 확정 여부를 먼저 본다. 확정됐으면 parse하지 않고 버린다. `parseRpcResponse` 실패, 또는 `protocolVersion`·`clientId`·`requestId`가 이 호출과 다르면 `INTERNAL "Malformed RPC response."`. 오류 응답은 `RemoteError(code, message, details)`로 그대로 옮긴다.

확정 규칙:

- `settled` 플래그 하나가 모든 경로를 선점한다. 먼저 플래그를 세운 원인만 결과가 된다.
- 취소형 확정(abort·timeout·dispose)은 플래그를 세운 뒤 cancel을 보내고 그다음 reject한다. `transport.cancel`이 같은 호출의 abort·dispose를 동기로 재진입시켜도 첫 원인이 남고 cancel은 1회다.
- `transport.cancel` 예외는 삼키고 진단 `transport-failed`를 남긴다. 로컬 확정은 전송 성공에 의존하지 않는다.
- 응답으로 확정된 호출에는 cancel을 보내지 않는다.
- 확정 뒤 타이머 해제, abort listener 제거, pending 집합 제거를 한다.

`requestId`는 `<nonce>:request:<seq base36>` 형식이다. nonce는 문서(JS realm)마다 하나, sequence는 `subscriptionId`와 공유하는 단조 증가 값이다. 문서 안에서 재사용하지 않는다. Main은 `requestId`에 watermark를 적용하지 않는다. 같은 세션의 중복 `requestId`는 앞 요청을 대체한다.

## 5. 설계 이유와 기각한 대안

### `authorize` 뒤 세션 재검사를 하지 않는다

가설: 세션이 현재가 아니게 되는 모든 경로(main-frame navigation commit, `render-process-gone`, `destroyed`, detach, dispose, 같은 `webContents`의 새 `clientId`)는 `DocumentSessions`의 retire를 거치고, retire는 그 세션의 `onRetire` listener를 부른다. 따라서 "세션이 더 이상 현재가 아니다"와 "요청 signal이 abort됐다"는 같은 사실이다. retire 신호의 정의는 [04](04-document-session.md)가 소유한다.

이 가설 덕분에 `RpcRequests`는 세션 해석(`DocumentSessions.current()`)을 몰라도 된다. 구독(`Subscriptions`)도 같은 가설에 기댄다.

깨질 때의 위험: retire 없이 main frame이 바뀌는 Electron 경로가 있으면, `authorize`가 오래 걸린 요청이 이미 교체된 옛 문서를 기준으로 `FORBIDDEN`이나 성공 응답을 내고 handler를 실행한다. 이 가설을 직접 검증하는 자동 test는 없다. 단위 test는 `FakeTarget`의 수명 사건으로 retire 경로만 거치고, Electron acceptance에는 `authorize` 대기 중 navigation 시나리오가 없다. 오류 페이지 commit이 `did-navigate` 없이 `routingId`를 바꾸는 경로는 실제로 존재했고, retire 신호에 `did-fail-load`(routingId 일치)를 더해 막았다([ADR 0019](../adr/0019-navigation-retire-on-commit.md)). 의심되면 navigation 중 `authorize`가 지연되는 acceptance 시나리오를 추가한다.

### RPC slot을 handler 종료 때 반환한다

slot은 실제로 실행 중인 작업 수를 센다. 응답 시점에 반환하면 `signal`을 무시하는 handler가 한도 밖에서 계속 쌓인다. 결과와 한계는 [09](09-resource-limits.md).

### Main deadline과 Renderer timeout은 독립이다

둘은 서로를 모른다. 먼저 확정되는 쪽이 이긴다. 기본값(Renderer 30,000ms, Main 300,000ms)에서는 Renderer timeout이 먼저 확정되고, Renderer는 cancel을 보낸다.

### 기각한 대안

- 동기 단계의 `CANCELLED` 분기를 "도달 불가"로 삭제: 스키마 `parse`·Proxy trap이 동기 abort를 일으킬 수 있어 전제가 틀렸다([ADR 0015](../adr/0015-rpc-request-lifecycle.md)).
- `authorize` 뒤 `current() !== session` 재검사 유지: `RpcRequests`가 세션 해석을 알아야 한다. signal 판정과 관측 결과가 같다([ADR 0015](../adr/0015-rpc-request-lifecycle.md)).
- `DocumentSessions`가 retire 때 `RpcRequests` 취소 메서드를 직접 호출: 세션 모듈이 RPC에 의존한다([ADR 0015](../adr/0015-rpc-request-lifecycle.md)).
- 세션당 retire listener 1개로 active map 일괄 취소: 취소 순서가 세션 attach 시점에 좌우돼 진단 순서 예측이 어렵다. 요청별 listener는 등록 순서 = 실행 순서다([ADR 0015](../adr/0015-rpc-request-lifecycle.md)).
- 등록 조회를 `authorize` 뒤에 둔다: 같은 미등록 key가 `authorize` 결과에 따라 `FORBIDDEN`/`NOT_FOUND`로 갈린다([ADR 0014](../adr/0014-stream-lookup-before-authorize.md)).
- 와이어에 `timeoutMs`를 싣는다: Main deadline은 독립으로 충분하고, 프로토콜 변경은 기존 transport 구현과 호환을 깬다([ADR 0009](../adr/0009-session-resource-limits.md)).
- dispose 취소에 새 오류 코드: `AbortSignal` 취소와 구분할 실익이 없고 코드 union만 넓힌다. `CANCELLED`를 재사용한다([ADR 0006](../adr/0006-shutdown-contract.md)).
- 루트 `AbortController`를 모든 호출 `signal`에 합성해 dispose 구현: 호출자 signal과 종료 signal을 구분하지 못한다. pending 집합을 직접 확정한다([ADR 0006](../adr/0006-shutdown-contract.md)).

## 6. 한계

- `signal`을 무시하는 handler는 취소·deadline 응답 뒤에도 끝날 때까지 slot을 쥔다. 끝나지 않으면 slot도 돌아오지 않는다.
- 끝나지 않는 `authorize`도 같다. deadline은 응답만 확정하고 slot은 `authorize` settle과 작업 종료를 기다린다.
- 성공 경로(`parseBridgeValue`·입력 스키마·출력 경계 성공)에는 guard가 없다. 입력 스키마 `parse`가 동기로 취소를 일으키면 handler는 이미 abort된 `signal`로 호출된다. 출력 스키마가 취소를 일으키고 성공하면 성공 응답이 나간다.
- Renderer는 `timeoutMs` 상한을 검사하지 않는다. `setTimeout`은 2,147,483,647ms를 넘는 지연을 즉시 실행으로 바꾸므로 그보다 큰 유한값은 곧바로 `DEADLINE_EXCEEDED`가 된다. Main `maxRpcDurationMs`만 이 상한을 생성 시점에 거부한다.
- Renderer는 `authorize` 예외와 handler의 비선언 예외를 구분하지 못한다. 둘 다 `INTERNAL`이다([ADR 0011](../adr/0011-authorize-exception-internal.md)).
- `authorize` 뒤 재검사 제거 가설은 자동 test로 직접 검증되지 않는다(5절).

## 7. 관련 문서

- ADR: [0009](../adr/0009-session-resource-limits.md), [0011](../adr/0011-authorize-exception-internal.md), [0014](../adr/0014-stream-lookup-before-authorize.md), [0015](../adr/0015-rpc-request-lifecycle.md), [0006](../adr/0006-shutdown-contract.md), [0019](../adr/0019-navigation-retire-on-commit.md), [0023](../adr/0023-session-retire-interface.md)
- 설계 문서: [01. 계약과 등록](01-contract.md), [03. Transport와 배선](03-transport-and-wiring.md), [04. 문서 세션](04-document-session.md), [06. Main 스트림 전달](06-stream-delivery.md), [08. Payload와 오류 모델](08-payload-and-errors.md), [09. 세션 자원 한도](09-resource-limits.md), [10. 종료](10-shutdown.md), [11. 진단](11-diagnostics.md)
