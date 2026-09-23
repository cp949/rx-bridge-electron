# rx-bridge-electron 아키텍처

이 문서는 현재 코드와 공개 README에서 확인되는 동작을 기록한다. 과거 설계 토론의 전체 이력은 포함하지 않으며, 구현이 바뀌면 코드와 함께 갱신한다.

## 목적과 범위

`@cp949/rx-bridge-electron`은 신뢰하는 로컬 Electron UI의 Main과 Renderer 사이에 타입 및 스키마 검증을 거치는 RPC, State, Event 통신을 제공한다. 원격 콘텐츠, 플러그인 권한, 범용 `webContents` 스트림 범위, 지속적인 고속 Event, 바이너리 전송은 현재 계약 범위가 아니다.

## 패키지 경계

| 진입점                               | 실행 위치     | 책임                                                  |
| ------------------------------------ | ------------- | ----------------------------------------------------- |
| `@cp949/rx-bridge-electron/contract` | 모든 프로세스 | 도메인 정의, 스키마, 계약 조합, Renderer 타입 추론    |
| `@cp949/rx-bridge-electron/main`     | Electron Main | 핸들러 등록, 권한 확인, 검증, 세션 및 스트림 관리     |
| `@cp949/rx-bridge-electron/preload`  | preload       | 고정 IPC 채널 어댑터와 `contextBridge` 노출           |
| `@cp949/rx-bridge-electron/renderer` | Renderer      | 비동기 API, RPC 클라이언트, `RemoteState`, RxJS Event |

Contract는 프로세스 중립 선언이다. handler, Electron 객체, 자격증명, Node API, 함수, Observable/Subject는 preload 경계를 건너지 않는다. Renderer에는 고정된 `BridgeTransport`만 노출하며 `ipcRenderer`, 임의 채널, raw Electron event를 공개하지 않는다.

## 요청 경로와 신뢰 경계

1. Renderer는 preload가 제공한 transport로 handshake를 시작하고 Main에서 공개 manifest를 받는다.
2. Electron 어댑터는 고정 namespace 채널에서 요청을 받고 sender의 `webContents`, frame, 현재 main frame 여부, origin을 확인한다.
3. Main은 연결된 문서 세션과 도메인 계약을 확인하고 권한 함수를 적용한다.
4. RPC 입력과 출력, handshake 및 stream envelope는 프로토콜 파서와 payload 한도를 통과해야 한다. RPC handler와 stream source가 만든 값은 원시 값 검사 → 출력 스키마 변환 → 변환 결과 재검사 → 복제 → 복제본 검사 순서를 모두 통과해야 전송된다. 이 순서는 `src/main/output-boundary.ts`의 `parseOutput` 하나로 구현되어 RPC 출력과 stream 값(State/Event)이 공유하며, 두 번째 검사(복제 전)는 accessor·함수 값이 `structuredClone` 단계로 새는 것을 막고 복제는 검증 이후 handler·스키마가 쥔 참조로 값을 바꾸는 TOCTOU를 막는다.
5. 오류 응답은 안전한 프로토콜 오류 코드로 직렬화한다. 내부 예외나 원문 payload를 진단 정보에 기록하지 않는다.
6. 실패는 원인별로 분류된 코드로 응답한다: 입력 검증 실패는 `INVALID_ARGUMENT`다. handler가 선언되지 않은 예외를 던지거나 출력 검증이 실패하면(출력 스키마가 던진 예외 포함, 선언된 오류 코드를 가진 예외라도) `INTERNAL "Internal bridge error."`다. 선언된 도메인 에러라도 `message` 또는 `details`가 payload 한도(byte·깊이·항목 수·전체 byte)를 넘으면 같은 `INTERNAL`로 대체된다. 선언된 도메인 에러의 `details`도 검사 → 복제 → 복제본 검사를 거치며, `code`·`message`·`details`는 한 번만 읽어 검사한 값을 그대로 전송한다. 이 필드를 읽다 예외가 나도 `INTERNAL`이다. 출력 검증 실패 시 진단 정보에 `{ type: "validation-failed", key }`를 기록한다. 검증 실패 시점에 요청이 이미 취소된 상태(`context.signal.aborted`)면 `CANCELLED`가 이 분류보다 우선한다. 세션별 자원 한도(동시 RPC·구독 수) 초과는 `RESOURCE_EXHAUSTED`, Main이 스스로 설정한 RPC 실행 시간 상한 초과는 `DEADLINE_EXCEEDED`다 — 아래 "세션 자원 한도" 참고. 이 모든 거부와 완료 결과는 진단 이벤트로도 관측할 수 있다 — 아래 "운영 진단" 참고.

Electron 어댑터는 `allowedOrigins`를 받고 현재 main frame과 허용 origin을 검사한다. 데모 앱의 authorization은 `main` 역할에 전체 공개 계약을 허용하고 `monitor` 역할에는 State/Event만 허용한다. 알 수 없는 역할은 허용되지 않는다. 앱은 별도로 navigation 및 window 생성 정책, sandbox, context isolation, preload 설정을 유지해야 한다.

## 문서 세션과 정리

Main은 연결된 `webContents`별로 현재 main-frame 문서와 client ID를 묶은 세션을 유지한다. handshake에서 sender가 현재 main frame이고 허용 origin인지 확인한다. main-frame navigation, renderer process 종료, `webContents` 파괴, detach 또는 서버 dispose가 세션을 retire하고 해당 세션의 RPC와 stream 구독을 중단한다. retire된 client ID는 같은 `webContents`의 새 문서 세션에서 재사용하지 않는다.

이 소유 단위는 창이 아니라 렌더러 문서다. 한 창에서 reload/navigation이 발생하면 이전 문서에서 시작한 비동기 작업이 새 문서로 넘어가지 않아야 한다.

`server.dispose()`는 되돌릴 수 없다. 이후 `attach()`는 `BridgeProtocolError("FORBIDDEN", "Bridge server is disposed.")`를 동기로 throw하고, handshake·RPC·stream subscribe는 세션이 없을 때 쓰는 기존 거부 경로(handshake `undefined`, RPC `FORBIDDEN`, subscribe 무시)로 응답한다. 반복 dispose는 no-op이다. retire된 client ID 기록은 서버 dispose 후에도 지우지 않는다 — 위 "재사용하지 않는다" 규칙이 종료 후에도 흔들리지 않아야 하기 때문이다. `destroyed` 수명 사건이 오면 해당 `webContentsId`의 retired 기록 전체를 지운다(그 `webContents`는 다시 살아나지 않는다). 살아 있는 `webContents`의 retired 기록은 최근 `maxRetiredClientsPerWebContents`개(기본 32)만 보관하고, 그보다 오래된 clientId는 기록에서 빠진다 — 그 시점 이후 재사용 방지는 `establish()`의 frame·origin 검사가 대신한다. 근거는 [ADR 0009](adr/0009-session-resource-limits.md)에 있다. `bindElectronBridge(...).dispose()`도 자신의 종료 플래그를 가지며, 반복 호출은 no-op이고 종료 후 `attach()`는 `BridgeProtocolError("FORBIDDEN", "Electron bridge is disposed.")`를 throw한다. 이 bind dispose는 자신이 등록한 cancel/control listener만 `removeListener`로 제거한다(`removeAllListeners`를 쓰지 않는다) — 같은 IPC 채널에 다른 코드가 등록한 listener를 건드리지 않기 위해서다. 근거는 [ADR 0006](adr/0006-shutdown-contract.md)에 있다.

## RPC와 스트림 계약

- **RPC**: 하나의 clone-safe 입력과 결과를 주고받는다. `AbortSignal`과 `timeoutMs`는 입력값과 분리된 호출 옵션이며 취소·timeout·응답 중 하나만 최종 결과가 된다.
- **State**: 현재값을 나타낸다. Renderer의 `RemoteState`는 `uninitialized`, `connecting`, `current`, `stale` snapshot을 제공한다. 마지막 로컬 구독자가 해제된 뒤 값이 있었으면 snapshot은 `stale`가 되며, 새 구독 generation에 예전 값을 현재값처럼 재생하지 않는다. `undefined`도 유효한 값이다. 같은 generation이 활성인 동안 늦게 합류한 로컬 구독자는 `subscribe()` 호출 안에서 현재값을 동기로 받는다. 아직 값을 받지 못한 `connecting` 상태에서는 첫 값을 기다린다.
- **Event**: 과거 값을 재생하지 않는 발생 스트림이다. 명시적인 buffer capacity와 `error`, `drop-oldest`, `drop-newest` 중 overflow 정책을 계약에 둔다. 구독 확인 이후 sequence와 acknowledgement로 전송을 제어한다.
- 같은 Renderer 문서의 여러 로컬 구독자는 하나의 local generation을 공유한다. Main의 non-scoped State/Event source는 operation key별로 활성 consumer 사이에서 공유한다. 문서별 Event source는 각 구독 context로 생성한다. 마지막 consumer가 나가면 더는 쓰지 않는 upstream을 정리한다.
- `createBridgeServer(contract, implementations)`는 생성 시 `implementations` 전체를 합성된 계약과 이름 집합 기준으로 재검증한다: 도메인 누락·중복·미지, 도메인별 rpc·state·event 각각의 누락·초과 키, rpc handler가 함수인지·state 소스가 `getValue`를 갖는지·event 소스가 Observable/source adapter 형태인지. `implementDomain`을 거친 값도 다시 검사한다(직접 만든 구현 객체를 신뢰하지 않고, 같은 이름이지만 다른 정의의 도메인을 잡기 위해서다). 첫 불일치에서 `TypeError`를 던지며 검증을 통과한 정규화 사본만 등록되어 이후 원본 객체를 변경해도 영향이 없다. 근거는 [ADR 0008](adr/0008-contract-registration-match.md)에 있다.
- Renderer 공개 호출은 계층형 `api.<domain path>.rpc|state|event.<operation>`이다(`api.device.rpc.connect()`, `api.device.state.connection`). operation 이름은 `/` 없는 단일 segment이고, manifest 키의 마지막 segment가 operation이다. 도메인 경로의 모든 segment에서 `rpc`·`state`·`event`를 예약하며 계약 단계와 Renderer manifest 파서가 각각 거부한다. 도메인에 없는 종류는 노출하지 않는다. 근거는 [ADR 0007](adr/0007-hierarchical-renderer-api.md)에 있다. 루트 API는 `dispose`를 예약 도메인 이름으로 두고 `api.dispose()`를 `api[Symbol.dispose]`와 같은 함수로 노출한다([ADR 0005](adr/0005-renderer-api-shape.md)). `api.dispose()`는 되돌릴 수 없는 종료다: 진행 중인 RPC는 로컬에서 즉시 `CANCELLED`로 확정되고(Main에는 best-effort cancel을 보낸다), 활성 State/Event 구독은 `unsubscribe` 전송 후 `complete()`된다. 종료 후 호출한 RPC·subscribe는 전송 없이 같은 `CANCELLED` 오류로 끝난다. 의미와 근거는 [ADR 0006](adr/0006-shutdown-contract.md)에 있다.

## Payload 및 제한

v1 payload는 `undefined`, `null`, boolean, number, bigint, string, 배열, 일반 객체로 제한한다. 함수, symbol, 순환 참조, 사용자 정의 prototype, accessor/non-enumerable property, symbol key는 거부한다. 기본 한도는 깊이 32, 전체 항목 10,000개, 문자열 및 key UTF-8 길이 1,000,000 byte, 전체 크기 16 MiB(16,777,216 byte, `maxTotalBytes`)다. 계약별 payload 한도(`payloadLimits`)를 지정하면 해당 필드만 기본값을 덮어쓴다(병합).

전체 크기는 순회 중 근사 byte를 누적해 계산한다: 노드마다(원시값·배열·객체·`null`·`undefined` 모두) 8 byte, 문자열은 추가로 UTF-8 byte 길이, object key는 UTF-8 byte 길이(배열 `length`는 제외하지만 배열 원소의 index 문자열 키는 포함), bigint는 추가로 `ceil(abs(value).toString(16).length / 2)` byte. 실제 V8 structured clone 크기와는 다를 수 있는 근사값이다. 누적값이 `maxTotalBytes`를 넘으면 다른 payload 규칙과 같은 실패 분류를 따른다: RPC 입력은 `INVALID_ARGUMENT`, RPC 출력·stream 값·도메인 에러 `details`는 `INTERNAL`.

payload 한도는 서버(`createBridgeServer`)가 계약 기준으로만 적용한다. Electron 어댑터와 preload는 envelope 구조(순환 참조·함수·prototype 등 값 프로필)만 검사하고 크기 한도는 강제하지 않는다(근거: [ADR 0004](adr/0004-validated-bounded-payloads.md)).

## 세션 자원 한도

Main은 연결된 `webContents`의 현재 문서 세션 단위로 진행 중 RPC 수, 구독(대기+활성) 수, RPC 실행 시간, retired client ID 보관량을 제한한다. `createBridgeServer(contract, implementations, { resourceLimits })` 옵션으로 설정하며 모두 세션별이다 — 서버 전역(모든 세션 합계) 상한은 없다. 한 세션이 한도를 모두 소진해도 다른 세션의 RPC·구독은 영향받지 않는다.

| 옵션                              | 기본값  | 초과 시                                                                                     |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------- |
| `maxConcurrentRpc`                | 64      | 다음 RPC는 `authorize`·handler 호출 없이 `RESOURCE_EXHAUSTED`                               |
| `maxSubscriptions`                | 256     | 다음 subscribe는 `subscribed` 다음 `RESOURCE_EXHAUSTED` `error`                             |
| `maxRpcDurationMs`                | 300,000 | handler `signal` abort 후 `DEADLINE_EXCEEDED`(`Infinity`면 없음, 유한값 최대 2,147,483,647) |
| `maxRetiredClientsPerWebContents` | 32      | 가장 오래된 retired clientId부터 기록에서 제거                                              |

RPC 슬롯은 취소나 deadline으로 응답을 먼저 보내도 handler Promise가 실제로 끝날 때 반환한다 — `AbortSignal`을 무시하는 handler는 자기 세션의 슬롯만 계속 점유한다. 구독 슬롯은 unsubscribe·완료·오류·overflow·거부·세션 retire 각 경로 뒤 즉시 반환한다.

stream `subscriptionId`의 재사용·늦은 도착은 ID별 저장소 대신 세션별 워터마크(마지막으로 수락한 sequence)로 판정한다. `subscriptionId`는 `<nonce>:<scope>:<seq base36>` 형식(`createOpaqueId` 산출 형식)이어야 하며, 형식 오류는 `INVALID_ARGUMENT`, 워터마크 이하는 메시지 없이 무시한다. RPC `requestId`는 워터마크 대상이 아니다.

근거와 대안 비교는 [ADR 0009](adr/0009-session-resource-limits.md)에 있다.

## 운영 진단

Main은 `createBridgeServer(contract, implementations, { diagnostics })`로 넘긴 `DiagnosticsSink`에 닫힌 타입의 이벤트(`BridgeDiagnostic`)를 기록한다. `sink`가 없거나 `record`가 예외를 던져도 bridge 동작은 동일하다(호출을 삼키는 공통 함수 하나로 모든 기록 지점을 통과시킨다) — sink 실패가 RPC 응답이나 stream 전달에 영향을 주지 않는다. sink를 지정하지 않으면 기본 동작에서 어떤 콘솔 출력도 없다.

이벤트는 RPC 완료(`rpc-finished`, 성공·실패를 나타내는 `outcome` 포함)·취소(`rpc-cancelled`)·Main deadline 만료(`rpc-timed-out`)·출력 검증 실패(`validation-failed`)·Event 큐 깊이(`stream-queue`)와 드롭(`stream-dropped`)·거부(`rejected`, 11개 `RejectReason` 중 하나)·세션과 구독의 생성·해제(`session-opened`/`session-closed`, `subscription-opened`/`subscription-closed`)로 구성된다. 사유는 enum 코드, 식별자는 등록 조회를 통과한 와이어 key만 싣는다 — `Error` 객체, message, stack, 원문 payload, origin, clientId, webContentsId, requestId, subscriptionId는 어떤 이벤트에도 넣지 않는다. Electron 어댑터가 판정하는 거부(`frame-not-main`, `origin-not-allowed`, `malformed-envelope`)는 export하지 않는 내부 Symbol 통로로 같은 sink에 기록되며, 한 요청에서 `rejected`는 최대 1회만 기록된다(server가 이미 기록한 경우 adapter가 중복 기록하지 않는다).

`server.getDiagnosticsSnapshot()`은 현재 활성 세션 수, in-flight RPC 수, 구독(대기+활성) 수, 대기 중 Event 수를 조회한다 — 이벤트 스트림과 달리 누적하지 않는 현재 스냅샷이며, 누적 카운터는 제공하지 않는다.

근거와 판정 지점 전체 목록, `RejectReason` 11개 각각의 판정 위치는 [ADR 0010](adr/0010-operational-diagnostics.md)에 있다.

## 데모와 증거 범위

`apps/demo`는 실제 장치 드라이버가 아니라 가상 장치와 relay를 통해 라이브러리의 계약, 역할 권한, State/Event, 다중 창 동작을 보여준다. 장치 연결 지원으로 해석하지 않는다.

검증 명령은 각 패키지의 `verify`와 CI workflow에 정의되어 있다. CI는 단위·타입·빌드 검사, 개발용 Electron acceptance, Linux packaged 실행 검사를 분리한다. package manifest의 Electron peer 범위(`>=29`)는 모든 Electron 버전에서 동일한 런타임 증명이 있다는 뜻이 아니다. 저장소 개발/CI 의존성은 `^44.4.5`이므로 다른 버전에서의 동작은 별도로 확인해야 한다. 실제 Electron 다중 창·반복 실행 검증의 환경과 결과는 [RD-008 검증 결과](verification/rd-008.md)에 있다.
