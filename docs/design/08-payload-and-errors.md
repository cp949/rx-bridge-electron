# 08. Payload와 오류 모델

## 1. 목적과 범위

답하는 질문:

- 어떤 값이 Main↔Renderer 경계를 건너는가(v1 값 프로필).
- 얼마나 큰 값까지 허용하고, 그 한도를 누가 어디서 강제하는가.
- handler·스키마·source가 만든 값을 전송 전에 어떤 순서로 검사하는가(출력 경계).
- 실패를 어떤 코드와 메시지로 알리는가(오류 코드 체계, 도메인 에러 직렬화).

다루지 않는 것:

- RPC 처리 순서 전체와 `CANCELLED` 우선 guard의 적용 지점: [05. RPC](05-rpc.md)
- 세션 자원 한도(`RESOURCE_EXHAUSTED`·`DEADLINE_EXCEEDED`의 판정): [09. 세션 자원 한도](09-resource-limits.md)
- 채널·envelope 모양·protocol version: [03. Transport와 배선](03-transport-and-wiring.md)
- sender admission 판정 순서: [04. 문서 세션](04-document-session.md)
- 스트림 terminal 전달 순서·overflow 시점: [06. Main 스트림 전달](06-stream-delivery.md)
- 진단 이벤트 목록과 `RejectReason` 판정 지점: [11. 진단](11-diagnostics.md)

## 2. 모델

| 개념                                                       | 소유                                  | 역할                                                                             |
| ---------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `BridgeValue`, `parseBridgeValue(value, limits)`           | `src/protocol/bridge-value.ts`        | v1 값 프로필 검사. 값을 직렬화·변형하지 않고 순회만 한다                         |
| `PayloadLimits`                                            | `src/protocol/bridge-value.ts`        | `maxDepth`·`maxEntries`·`maxStringBytes`·`maxTotalBytes?`                        |
| `PayloadLimitError`                                        | `src/protocol/bridge-value.ts`        | 한도 초과 전용 `BridgeProtocolError` 서브클래스. 내부 판정 표식, 공개하지 않는다 |
| `DEFAULT_PAYLOAD_LIMITS`, `resolvePayloadLimits`           | `src/main/payload-limits.ts`          | 기본 한도(동결)와 서버 옵션 병합                                                 |
| `ENVELOPE_LIMITS`                                          | `src/protocol/messages.ts`(모듈 내부) | envelope parse 단계의 구조 한도                                                  |
| `parseOutput(schema, raw, limits)`                         | `src/main/output-boundary.ts`         | 출력 경계. RPC 출력과 State·Event 값이 공유한다                                  |
| `serializeError(error, declared, limits)`, `internalError` | `src/main/error-serializer.ts`        | 도메인 에러 직렬화와 `INTERNAL` payload 단일 정의                                |
| `authorizeOperation`                                       | `src/main/authorization.ts`           | `authorize` 호출과 예외·거부 분류. RPC·stream 공유                               |
| `protocolError`, `invalidRequest`                          | `src/main/protocol-error.ts`          | parse 실패·admission 거부 응답 조립                                              |
| `TransportErrorCode`                                       | `src/protocol/error-code.ts`          | 라이브러리가 만드는 오류 코드의 유일한 정의(9개)                                 |
| `RpcErrorPayload`                                          | `src/protocol/messages.ts`            | wire 오류 모양 `{ code: string; message: string; details?: BridgeValue }`        |
| `RemoteError`                                              | `src/renderer/remote-error.ts`        | Renderer가 받는 오류. `code: string`, `message`, `details?`                      |

오류 코드는 두 종류다. 라이브러리 코드는 `TransportErrorCode` 9개다. 도메인 코드는 앱이 `options.errors`에 RPC별로 선언한 임의 문자열이다. wire와 `RemoteError.code`는 둘을 같은 `string` 필드로 싣는다.

### 2.1 v1 값 프로필

`parseBridgeValue`가 정의한다. 도메인 스키마 유무와 무관하게 모든 operation에 적용된다.

| 허용                                                  | 거부(구조 오류, `BridgeProtocolError("INVALID_ARGUMENT")`)                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `undefined`, `null`, boolean                          | 함수, symbol                                                               |
| number(`NaN`·`Infinity` 포함), bigint, string         | 순환 참조(조상 경로에 같은 객체)                                           |
| 배열(prototype이 정확히 `Array.prototype`)            | prototype이 다른 배열(서브클래스, prototype 변경)                          |
| 일반 객체(prototype이 `Object.prototype` 또는 `null`) | 그 외 prototype 객체: class 인스턴스, `Date`, `Map`, `Set`, typed array 등 |
| 순환이 아닌 공유 참조                                 | symbol key                                                                 |
| enumerable data property                              | accessor(getter/setter) property, non-enumerable property                  |

accessor 판정은 property descriptor로 한다. getter를 호출하지 않는다.

### 2.2 한도

| 필드             | 기본값              | 의미                                                                               |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `maxDepth`       | 32                  | 루트 depth 0, 자식마다 +1. 원시값 leaf도 depth를 가진다. `depth > maxDepth`면 거부 |
| `maxEntries`     | 10,000              | 모든 객체·배열의 own key 수 누적. 배열 `length`는 제외                             |
| `maxStringBytes` | 1,000,000           | 문자열 하나와 object key 하나의 UTF-8 byte 길이                                    |
| `maxTotalBytes`  | 16,777,216 (16 MiB) | 근사 전체 크기. 아래 계산 규칙                                                     |

전체 크기 근사 계산(순회 중 누적, 초과 즉시 거부):

1. 노드마다 8 byte. 원시값·`null`·`undefined`·배열·객체 모두 노드다.
2. 문자열은 추가로 UTF-8 byte 길이(UTF-16 code unit 수가 아니다).
3. object key는 UTF-8 byte 길이. 배열은 `length`를 빼고 index 문자열 key를 센다.
4. bigint는 추가로 `ceil(abs(value).toString(16).length / 2)` byte.
5. 순환이 아닌 공유 참조는 방문할 때마다 다시 센다.

예: `["ab", "cd"]`는 배열 8 + key `"0"`·`"1"` 2 + 문자열 노드 (8+2)×2 = 30 byte다.

`PayloadLimits.maxTotalBytes`는 선택 필드다. `parseBridgeValue`는 `undefined`를 "전체 크기 검사 없음"으로 해석한다. 이 해석은 envelope parse만 쓴다(2.4). 서버 경로는 항상 해석된 값을 받는다.

한도 초과만 `PayloadLimitError`를 던진다. 공개 계약(`name: "BridgeProtocolError"`, `code: "INVALID_ARGUMENT"`)은 구조 오류와 같다. Main은 `instanceof PayloadLimitError`로 진단 사유만 가른다(`payload-too-large` vs `invalid-input`).

### 2.3 `payloadLimits` 해석

`createBridgeServer(impl, { payloadLimits })`의 `resolvePayloadLimits`가 서버 생성 시점에 한 번 해석한다.

1. 옵션이 없으면 `DEFAULT_PAYLOAD_LIMITS`를 그대로(참조 동일) 쓴다.
2. 모르는 key가 있으면 `TypeError("Unknown payload limit '<key>'.")`. 값 검사보다 먼저다.
3. own property로 있는 필드만 기본값을 덮어쓴다(병합). 없는 필드는 기본값이다.
4. 있는 필드의 값이 음이 아닌 safe integer가 아니면 `TypeError("Payload limit '<key>' must be a non-negative safe integer.")`. 명시적 `undefined`도 여기서 거부한다. `0`은 허용한다.
5. 결과는 동결한다.

명시적 `undefined`를 생략과 다르게 거부하는 이유: `maxTotalBytes: undefined`를 병합하면 2.2의 해석 때문에 전체 크기 검사가 조용히 꺼진다. 전체 크기를 사실상 풀려면 `Number.MAX_SAFE_INTEGER`를 명시한다.

### 2.4 envelope parse와 `ENVELOPE_LIMITS`

envelope parse(`parse*` 함수)도 `parseBridgeValue`로 envelope 전체를 순회한다. 값 프로필(2.1)은 여기서 이미 강제된다. 한도는 `payloadLimits`가 아니라 protocol 내부 상수 `ENVELOPE_LIMITS`다.

| 필드             | 값                        |
| ---------------- | ------------------------- |
| `maxDepth`       | `Number.MAX_SAFE_INTEGER` |
| `maxEntries`     | `Number.MAX_SAFE_INTEGER` |
| `maxStringBytes` | `Number.MAX_SAFE_INTEGER` |
| `maxTotalBytes`  | 없음(검사 안 함)          |

크기 한도로 기능하지 않는다. 크기는 서버가 `payloadLimits`로만 강제한다.

어느 위치가 어떤 `parse*`를 호출하는지(server·preload·Renderer, adapter는 없음)는 [03. Transport와 배선](03-transport-and-wiring.md)이 소유한다. Renderer는 preload가 이미 검사한 응답을 다시 parse한다. 코드는 공유하고 신뢰는 공유하지 않는다.

## 3. 불변식

1. 경계를 건너는 모든 값(RPC 입력·출력, State·Event 값, 도메인 에러 `details`, envelope)은 v1 값 프로필을 통과한다. 도메인 스키마 유무와 무관하다.
2. 크기 한도(`payloadLimits`)는 server 한 곳에서만 강제한다. preload·Renderer·adapter는 크기를 강제하지 않는다.
3. 입력 실패는 `INVALID_ARGUMENT`, 출력 실패는 `INTERNAL`이다. 같은 한도 초과라도 방향이 코드를 정한다.
4. Main이 보내는 값은 검사를 통과한 값의 복제본이고, 그 복제본도 검사를 통과한다. handler·스키마·source가 쥔 참조는 전송 값에 닿지 않는다.
5. 출력 경계는 accessor를 호출하지 않는다. 호출 가능성이 있는 `structuredClone`보다 검사가 먼저다.
6. 도메인 에러는 `options.errors`에 선언한 코드만 원래 코드로 나간다. `code`·`message`·`details`는 한 번만 읽고, 읽은 값을 검사해 그대로 보낸다.
7. 비선언 예외, 출력 경계 실패, 직렬화 실패, `authorize` 예외, stream source 오류는 모두 같은 payload `INTERNAL "Internal bridge error."`다. 원래 예외의 `message`·`stack`·`code`는 wire에 나가지 않는다.
8. 요청이 이미 취소된 상태면 `CANCELLED`가 그 단계의 원래 분류보다 우선한다(RPC). 적용 지점은 [05. RPC](05-rpc.md) 소유다.
9. 라이브러리 오류 코드는 `TransportErrorCode` 9개뿐이다. 새 코드는 `src/protocol/error-code.ts`에만 추가한다.

## 4. 흐름

### 4.1 RPC 입력 검사

전체 처리 순서는 [05. RPC](05-rpc.md)에 있다. 입력 검사 단계와 실패 분류만 적는다.

| 단계                                              | 실패                                | 응답                                               | `rejected` 진단                |
| ------------------------------------------------- | ----------------------------------- | -------------------------------------------------- | ------------------------------ |
| envelope parse(`ENVELOPE_LIMITS`, 값 프로필 포함) | 구조·필드·값 프로필                 | `INVALID_ARGUMENT "Invalid bridge request."`       | `malformed-envelope`(key 없음) |
| 같은 단계                                         | `protocolVersion`이 1이 아닌 number | `VERSION_MISMATCH "Unsupported protocol version."` | `version-mismatch`(key 없음)   |
| `parseBridgeValue(input, payloadLimits)`          | 한도 초과(`PayloadLimitError`)      | `INVALID_ARGUMENT "Invalid bridge argument."`      | `payload-too-large`(key)       |
| 같은 단계                                         | 구조 오류                           | `INVALID_ARGUMENT "Invalid bridge argument."`      | `invalid-input`(key)           |
| 입력 스키마(있으면)                               | `parse`가 throw                     | `INVALID_ARGUMENT "Invalid bridge argument."`      | `invalid-input`(key)           |

구조 오류 input은 envelope parse가 먼저 거부한다. 두 번째 단계의 구조 오류 분기는 방어 경로다. 두 번째·세 번째 단계에서 요청이 이미 abort됐으면 `CANCELLED "Request cancelled."`로 응답하고 `rejected`를 기록하지 않는다.

parse 오류 문구(`BridgeProtocolError.message`)는 wire에 나가지 않는다. 응답 문구는 위 고정 문구뿐이다.

### 4.2 출력 경계(`parseOutput`)

RPC handler 결과와 State·Event source가 방출한 값이 같은 함수를 지난다.

1. 원시 값 검사: `parseBridgeValue(raw, limits)`. accessor·함수·class 인스턴스를 여기서 거부한다. getter를 호출하지 않는다.
2. 출력 스키마(있으면): `schema.parse(parsedRaw)`. 없으면 1의 값을 그대로 쓴다.
3. 재검사: `parseBridgeValue(value, limits)`. 스키마가 만든 값도 프로필·한도를 다시 통과해야 한다. 스키마가 accessor나 함수를 만들었으면 clone 전에 여기서 막는다.
4. 복제: `structuredClone(value)`.
5. 복제본 검사: `parseBridgeValue(clone, limits)`. 이 복제본을 전송한다.

각 단계의 이유:

- 1·3이 4보다 먼저인 이유: `structuredClone`은 enumerable accessor를 읽는다. 검사 없이 clone하면 getter가 실행되고 그 반환값이 data property로 굳어 전송된다(accessor 유출).
- 4가 있는 이유(TOCTOU): 검사 뒤에도 handler·스키마·source는 원래 객체 참조를 쥔다. Event 값은 ack를 기다리며 대기열에 머문다. 복제하지 않으면 검사한 뒤 전송 전에 값이 바뀌어 프로필 밖 값이 나갈 수 있다.
- 5가 있는 이유: 전송하는 객체 자체가 검사를 통과했음을 보장한다.

실패 처리:

- RPC: `validation-failed` 진단을 기록한 뒤 `INTERNAL "Internal bridge error."`로 응답한다. 이미 abort됐으면 응답은 `CANCELLED`다. 출력 스키마가 선언된 도메인 코드를 가진 예외를 던져도 `INTERNAL`이다.
- stream: `validation-failed`를 기록하고 구독을 `error INTERNAL "Internal bridge error."`로 끝낸다. terminal 전달 순서는 [06. Main 스트림 전달](06-stream-delivery.md) 소유다.

### 4.3 도메인 에러 직렬화

handler가 throw하거나 reject하면 `RpcRequests`가 다음 순서로 분류한다.

1. 요청이 이미 abort됐으면 `CANCELLED "Request cancelled."`.
2. 던진 값이 `BridgeProtocolError`면 `INTERNAL`. 코드가 선언돼 있어도 같다.
3. 나머지는 `serializeError(error, declared, payloadLimits)`:
   1. 던진 값이 객체가 아니면(`null`, 문자열, 숫자 등) `INTERNAL`.
   2. `code`·`message`·`details`를 구조 분해로 한 번만 읽는다. getter가 있어도 두 번 호출하지 않는다.
   3. `code`가 string이 아니거나 선언 목록에 없거나 `message`가 string이 아니면 `INTERNAL`.
   4. `message`를 `parseBridgeValue(message, limits)`로 검사한다(`maxStringBytes`·`maxTotalBytes`).
   5. `details`가 있으면 검사 → `structuredClone` → 복제본 검사. 없으면 `details` 필드를 싣지 않는다.
   6. 2~5 어디서든 예외가 나면(필드 getter의 throw, 한도 초과, clone 실패) `INTERNAL`.
4. 결과 `{ code, message, details? }`를 응답한다.

선언된 도메인 에러의 한도 초과는 `validation-failed` 진단을 남기지 않는다. `validation-failed`는 출력 경계(4.2) 전용이다.

### 4.4 `authorize` 판정 분류

`authorizeOperation`이 RPC·stream 공통으로 판정하고, 각 경로는 결과를 응답이나 frame으로 번역만 한다.

| `authorize` 결과  | abort 상태 | 판정                                         | 진단                    |
| ----------------- | ---------- | -------------------------------------------- | ----------------------- |
| 생략              | 아님       | 허용(동기)                                   | 없음                    |
| `true`            | 아님       | 허용                                         | 없음                    |
| `false`           | 아님       | `FORBIDDEN "Bridge operation is forbidden."` | `authorize-denied`(key) |
| throw 또는 reject | 아님       | `INTERNAL "Internal bridge error."`          | 없음                    |
| 무엇이든          | aborted    | 취소                                         | 없음                    |

RPC의 취소는 `CANCELLED "Request cancelled."`다. stream의 취소는 retire 통지 규칙을 따른다([06. Main 스트림 전달](06-stream-delivery.md)). `authorize` 호출 시점은 [05. RPC](05-rpc.md)·[06. Main 스트림 전달](06-stream-delivery.md), 인자 모양(`BridgeOperation`)은 [01. 계약과 등록](01-contract.md)이 소유한다.

### 4.5 오류 코드

`TransportErrorCode` 전체다. 메시지는 정확한 문자열이다. "Renderer 로컬"은 원격 응답 없이 Renderer가 `RemoteError`를 만드는 경우다.

| 코드                 | 의미                                               | 발생 원인과 메시지                                                                                                                                                                                                                                                                                                                                                                                                                                             | RPC | stream     | 재시도 가치                                                                                                             |
| -------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`   | 요청 envelope·입력·호출 옵션이 규칙을 어겼다       | Main envelope parse 실패와 handshake 거부 전부(malformed·version 불일치·admission): `"Invalid bridge request."`. RPC 입력의 `payloadLimits` 초과·구조 오류·입력 스키마 실패: `"Invalid bridge argument."`. stream `subscriptionId` 형식 오류: `"Invalid bridge subscription ID."`. Renderer 로컬 `timeoutMs` 검증 실패: `"RPC timeout must be a non-negative finite number or Infinity."`. adapter invoke fallback: `"Invalid bridge request."`                | O   | O(ID 형식) | 없음. 같은 입력은 같은 결과다                                                                                           |
| `NOT_FOUND`          | 등록되지 않은 operation key                        | RPC: `"Unknown bridge operation."`. stream: `"Unknown bridge stream."`. `authorize` 호출 여부와 무관하다                                                                                                                                                                                                                                                                                                                                                       | O   | O          | 없음. manifest는 서버 수명 동안 고정이다                                                                                |
| `FORBIDDEN`          | 보낸 문서나 operation이 허용되지 않았다            | sender admission 거부(`sender-unauthorized`·`frame-not-main`·`origin-not-allowed`): `"Bridge sender is not authorized."`(RPC 응답, subscribe는 `subscribed` 뒤 `error`). `authorize`가 `false`: `"Bridge operation is forbidden."`. 종료 뒤 `attach()`의 동기 throw(`"Bridge server is disposed."`, `"Electron bridge is disposed."`)는 wire가 아니라 Main 앱 코드로 간다([10. 종료](10-shutdown.md))                                                          | O   | O          | 같은 문서에서는 없음. admission 상태나 `authorize` 판정이 바뀌어야 한다                                                 |
| `CANCELLED`          | 요청·구독이 결과 전에 끝났다                       | Main RPC: `"Request cancelled."`(Renderer cancel, 같은 `requestId` 재요청, 세션 retire, CANCELLED 우선 규칙). Main stream: detach·`server.dispose()` retire 시 `"Bridge session ended."`. Renderer 로컬: `signal` abort `"RPC call was cancelled."`, `api.dispose()`와 종료 뒤 RPC·subscribe `"Renderer API is disposed."`                                                                                                                                     | O   | O          | 호출자 abort·dispose면 없음. `"Bridge session ended."`는 그 문서의 세션이 끝났다는 뜻이라 같은 문서에서 복구되지 않는다 |
| `DEADLINE_EXCEEDED`  | 실행 시간 상한을 넘었다                            | Main `maxRpcDurationMs`: `"Request exceeded the server deadline."`. Renderer 로컬 `timeoutMs`: `"RPC call exceeded its deadline."`                                                                                                                                                                                                                                                                                                                             | O   | X          | 있음. 단 handler 부작용 여부를 알 수 없고 Main slot은 handler가 끝날 때까지 점유된다. 지연을 두고 멱등 작업만           |
| `RESOURCE_EXHAUSTED` | 세션별 동시 RPC·구독 한도 초과                     | RPC: `"Too many concurrent bridge requests."`. stream: `"Too many bridge subscriptions."`                                                                                                                                                                                                                                                                                                                                                                      | O   | O          | 있음. slot 반환 뒤                                                                                                      |
| `VERSION_MISMATCH`   | protocol version이 다르다                          | RPC envelope의 `protocolVersion`이 1이 아닌 number: `"Unsupported protocol version."`. handshake는 `INVALID_ARGUMENT`로, cancel·control은 무응답으로 번역한다. Renderer는 handshake 응답의 version 불일치를 `INTERNAL "Unsupported bridge handshake."`로 번역한다(preload transport에서는 preload parse가 먼저 실패해 `"Bridge handshake failed."`)                                                                                                            | O   | X          | 없음. 배포된 Main·preload·Renderer가 어긋났다                                                                           |
| `INTERNAL`           | Main 또는 transport 쪽 결함. 요청은 정상일 수 있다 | Main `"Internal bridge error."`: 비선언 handler 예외(`BridgeProtocolError` 포함), 도메인 에러 직렬화 실패, 출력 경계 실패, `authorize` 예외, stream source `error`·출력 경계 실패·upstream 연결 실패. Renderer 로컬: `"RPC transport failed."`, `"Malformed RPC response."`, `"Stream transport failed."`, handshake `"Bridge handshake failed."`·`"Malformed bridge handshake."`·`"Unsupported bridge handshake."`, manifest entry 거부(문구는 계약이 아니다) | O   | O          | Main 쪽 원인은 없음(같은 코드는 같은 결과). transport 실패는 원인에 따라                                                |
| `STREAM_OVERFLOW`    | Event buffer 용량 초과                             | overflow 정책 `"error"`의 Event buffer 초과: `"Event buffer capacity exceeded."`. 이미 대기 중인 값을 모두 전달한 뒤 온다                                                                                                                                                                                                                                                                                                                                      | X   | O(Event)   | 재구독 가능. 누락된 값은 복구되지 않는다                                                                                |

도메인 코드(`options.errors`)는 위 표 밖이다. 의미와 재시도 가치는 앱이 정한다.

## 5. 설계 이유와 기각한 대안

**한도는 계약이 아니라 서버 옵션이다.** 계약은 순수 TS 타입 `B`라 값을 가질 수 없다. 한도는 Main이 source·server를 만드는 시점의 값이다. 강제 지점을 server 하나로 모아, 옵션이 기본값보다 큰 한도를 선언하면 그 한도가 adapter·preload를 거쳐 handler까지 실제로 적용된다.

**envelope 단계는 크기를 보지 않는다.** envelope parse에 `payloadLimits`를 적용하면 크기 초과가 `malformed-envelope`(key 없음)로 흡수돼 `payload-too-large`(key 있음)와 구분되지 않는다. preload·Renderer는 server 옵션을 알지 못하므로 같은 한도를 쓸 수도 없다.

**입력 실패와 출력 실패는 다른 코드다.** 입력 실패는 Renderer가 보낸 값의 결함이라 `INVALID_ARGUMENT`다. 출력 실패는 Main 코드(handler·스키마·source)의 결함이다. Renderer가 입력을 고쳐도 결과가 바뀌지 않으므로 `INTERNAL`이다.

**`authorize` 예외는 `INTERNAL`이다.** `authorize`는 호스트 코드다. 그 실패는 요청 형식과 무관하다(`INVALID_ARGUMENT` 아님). 판정을 끝내지 못한 것과 거부한 것은 다르다(`FORBIDDEN` 아님). 같은 콜백의 같은 실패는 RPC·stream에서 같은 코드다.

**도메인 에러는 선언 코드만 통과한다.** 예외 객체의 `message`·`stack`에는 경로·자격증명 같은 내부 정보가 섞일 수 있다. 앱이 명시적으로 선언한 코드만 `message`·`details`와 함께 나가고, 나머지는 고정 payload로 바뀐다.

**`PayloadLimitError`는 서브클래스 표식이다.** 진단 사유를 가르려고 메시지 문자열을 매칭하지 않는다. 공개 모양은 구조 오류와 같아 호출자 관점의 계약이 늘지 않는다.

기각한 대안:

- `contract.payloadLimits`로 계약에 한도를 둔다: 계약이 타입이라 값을 담을 수 없다.
- adapter·preload도 크기를 강제한다: 서버 옵션으로 한도를 올려도 앞단 기본값이 먼저 막아 옵션이 무력해진다.
- Electron 직렬화(structured clone)에 값 제한을 맡긴다: 우연한 동작에 계약을 맡기게 되고 크기 제한이 없다.
- clone 뒤에만 검사한다: `structuredClone`이 accessor를 실행한다.
- clone을 생략한다: 검사 뒤 참조를 쥔 코드가 값을 바꿀 수 있다(TOCTOU).
- 출력 실패를 `INVALID_ARGUMENT`로 알린다: Renderer에 입력 결함으로 잘못 알린다.
- `authorize` 예외를 `INVALID_ARGUMENT`·`FORBIDDEN`으로 알리거나 경로마다 다르게 둔다: 4.4 이유와 같다.
- 한도 초과를 메시지 문자열로 구분한다: 문구 변경이 진단 분류를 깨뜨린다.

## 6. 한계

- 전체 크기는 근사값이다. 실제 V8 structured clone 크기와 다르다. 공유 참조는 방문마다 다시 세므로 DAG는 실제보다 크게 계산된다.
- envelope parse는 크기 제한 없이 envelope 전체를 순회한다. 거대한 입력은 IPC 역직렬화와 순회 비용을 치른 뒤 `payloadLimits`로 거부된다.
- `RpcClient`는 입력을 검사하지 않는다. 값 프로필을 어긴 RPC 입력은 preload의 `parseRendererRpcRequest`에서 거부되고, Renderer는 이를 `INTERNAL "RPC transport failed."`로 확정한다. `INVALID_ARGUMENT`가 아니다.
- `options.errors`는 라이브러리 코드와 같은 문자열(예: `"FORBIDDEN"`)의 선언을 막지 않는다. 그렇게 선언하면 Renderer는 코드만으로 출처를 구분할 수 없다.
- Renderer는 `authorize` 예외, handler 비선언 예외, 출력 검증 실패를 구분하지 못한다. 모두 `INTERNAL "Internal bridge error."`다. 원인은 Main 진단([11. 진단](11-diagnostics.md))이나 호스트 로그로 본다.
- stream source가 `error`로 보낸 값의 `code`는 전달되지 않는다. stream에는 도메인 에러 채널이 없다.
- 한도는 값 하나 단위다. 세션·시간 단위 처리량은 제한하지 않는다(동시 개수 한도는 [09. 세션 자원 한도](09-resource-limits.md)).

## 7. 관련 문서

- ADR: [0004 제한된 payload 프로필](../adr/0004-validated-bounded-payloads.md), [0011 authorize 예외 INTERNAL](../adr/0011-authorize-exception-internal.md), [0012 경량 타입 계약](../adr/0012-lightweight-type-contract.md)(`payloadLimits` 서버 옵션 개정), [0016 sender admission](../adr/0016-sender-admission.md)(envelope parse 소유, `ENVELOPE_LIMITS`), [0010 운영 진단](../adr/0010-operational-diagnostics.md)(`PayloadLimitError` 도입)
- 설계 문서: [01. 계약과 등록](01-contract.md), [03. Transport와 배선](03-transport-and-wiring.md), [05. RPC](05-rpc.md), [06. Main 스트림 전달](06-stream-delivery.md), [09. 세션 자원 한도](09-resource-limits.md), [11. 진단](11-diagnostics.md)
