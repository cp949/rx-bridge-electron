# Renderer는 진단 이벤트로 RPC 확정 원인·구독 종료 원인·메시지 폐기·전송 실패를 관측 가능하게 한다

- 관련: ROADMAP.md#RD-028

## 상황

[ADR 0010](0010-operational-diagnostics.md)은 Main의 `DiagnosticsSink`만 다뤘고 Renderer 진단을 범위 밖(`.scratch/renderer-diagnostics`)으로 뒀다. Renderer(`src/renderer`)는 다음을 조용히 처리한다.

- RPC 확정 원인: 원격 응답(성공·에러), 로컬 deadline, `signal` abort, `dispose`, `timeoutMs` 검증 실패, transport 실패, 응답 파싱·요청 불일치. 호출자는 `RemoteError.code`만 본다 — 로컬 deadline(`DEADLINE_EXCEEDED`)과 signal abort·dispose(`CANCELLED`)는 code만으로 구분되지 않는 경우가 있다.
- 스트림 메시지 폐기: parse 실패, `protocolVersion`·`clientId` 불일치, sequence 역행·중복 `subscribed`·`subscribed` 전 데이터.
- `transport.cancel`·`transport.control`(unsubscribe·acknowledge) 전송 실패 삼킴.
- 원격 구독의 시작과 종료 원인(unsubscribe, complete, error, dispose, subscribe 전송 실패).
- handshake 실패(`createRendererApi`가 `INTERNAL`로 reject하며 원인 문구만 다르다).

`RpcClient`·`StreamMultiplexer`는 Renderer main world에서 실행된다. sink 콜백은 contextBridge를 건너지 않는다.

## 결정

1. **진입점**: `createRendererApi<B>(options?: CreateRendererApiOptions)`. 위치 인자 `transport`를 옵션 객체로 교체한다.

   ```ts
   export interface CreateRendererApiOptions {
     readonly transport?: BridgeTransport;
     readonly diagnostics?: RendererDiagnosticsSink;
   }
   ```

   `transport` 생략 시 `globalThis.rxBridge`를 읽는 규칙([ADR 0013](0013-wiring-defaults.md))은 그대로다. sink는 API 인스턴스 하나에 묶인다.

2. **관측 모델**: 이벤트만. `RendererDiagnosticsSink.record(event)`로 Main과 같은 모양이다. snapshot 조회는 두지 않는다 — Renderer는 세션 하나에 자원 한도가 없고, 활성 구독 수는 `subscription-opened`/`closed` 쌍으로 셀 수 있다. API 루트에 새 예약어를 만들지 않는다.

3. **이벤트 타입**: 닫힌 판별 유니온.

   ```ts
   export type RpcSettleCause =
     | "ok"
     | "remote-error"
     | "deadline"
     | "aborted"
     | "disposed"
     | "invalid-options"
     | "transport-failed"
     | "malformed-response";

   export type SubscriptionCloseCause =
     | "unsubscribed"
     | "completed"
     | "remote-error"
     | "disposed"
     | "transport-failed";

   export type HandshakeFailureReason =
     "transport" | "malformed" | "version-mismatch" | "invalid-manifest";

   export type DroppedMessageReason =
     "malformed" | "envelope-mismatch" | "out-of-order";

   export type RendererDiagnostic =
     | {
         type: "rpc-settled";
         key: string;
         durationMs: number;
         cause: RpcSettleCause;
         code?: string;
       }
     | { type: "subscription-opened"; key: string }
     | {
         type: "subscription-closed";
         key: string;
         cause: SubscriptionCloseCause;
         code?: string;
       }
     | { type: "handshake-failed"; reason: HandshakeFailureReason }
     | { type: "message-dropped"; reason: DroppedMessageReason }
     | { type: "transport-failed"; channel: "cancel" | "control" };

   export interface RendererDiagnosticsSink {
     record(event: RendererDiagnostic): void;
   }
   ```

4. **기록 금지**: ADR 0010 결정 3을 따른다. `Error` 객체, `message`, `stack`, `details`, 원문 payload, `requestId`, `subscriptionId`, `clientId`는 넣지 않는다. 예외: `code`는 넣는다 — 원격 에러의 `RemoteError.code`(프로토콜 코드 또는 앱이 `errors` map으로 선언한 도메인 에러 코드)다. 원인 분류에 필요하고 자유 문자열이 아니다. `code`는 `cause: "remote-error"`일 때만 있다. 로컬 원인은 `cause`로 code가 결정되므로 싣지 않는다.

5. **`rpc-settled`**: `api...rpc.op()` 호출 하나는 정확히 1회 기록한다(전송 전 거부 포함).
   - `durationMs`: `call` 진입부터 확정까지. 전송 전 거부는 0에 가깝다.
   - cause 판정: 성공 응답 `ok`. 원격 에러 응답 `remote-error`(+`code`, Main의 `DEADLINE_EXCEEDED`·`CANCELLED`·`FORBIDDEN` 포함). 로컬 timer 만료 `deadline`. `signal` abort(호출 전 이미 abort 포함) `aborted`. dispose(호출 전 이미 dispose 포함) `disposed`. `timeoutMs` 검증 실패 `invalid-options`. `transport.invoke`의 동기 throw·reject `transport-failed`. 응답 parse 실패·`protocolVersion`/`clientId`/`requestId` 불일치 `malformed-response`.
   - 먼저 확정된 원인 하나만 기록한다(기존 `beginSettlement` 선점 규칙과 같은 지점).

6. **`subscription-opened` / `subscription-closed`**: 원격 구독(generation) 단위다. 같은 State·Event를 공유하는 로컬 구독자 수와 무관하다.
   - opened: `StreamMultiplexer.open`이 generation을 등록한 직후, subscribe control 전송 전.
   - closed: opened 1회당 정확히 1회. cause 판정: 마지막 로컬 구독자 해제로 `close` `unsubscribed`. `complete` 메시지 `completed`. `error` 메시지 `remote-error`(+`code`, [ADR 0020](0020-stream-terminal-on-retire.md)의 retire 통지 `CANCELLED`·`FORBIDDEN`, `authorize` 거부, overflow 포함). `dispose` `disposed`. subscribe control 전송 실패 `transport-failed`.
   - Main `subscribed` 수신 여부와 무관하게 opened를 기록한다 — 쌍이 항상 맞는다.

7. **`message-dropped`**: `StreamMultiplexer.#dispatch`가 버리는 메시지.
   - `malformed`: `parseStreamMessage` 실패.
   - `envelope-mismatch`: `protocolVersion` 또는 `clientId` 불일치.
   - `out-of-order`: 중복 `subscribed`, `sequence <= lastSequence`, `subscribed` 전 `batch`·`error`·`complete`.
   - 기록하지 않음: 모르는 `subscriptionId`(unsubscribe 뒤 도착하는 메시지는 정상 경합이다), dispose 뒤 도착.

8. **`transport-failed`**: 다른 이벤트로 드러나지 않는 삼킨 전송 실패만 기록한다.
   - `cancel`: RPC 취소 시 `transport.cancel` throw. RPC 자체는 원래 원인으로 `rpc-settled`를 기록한다.
   - `control`: unsubscribe(`close`·`dispose`)·acknowledge 전송 throw. dispose 뒤 억제한 acknowledge는 전송 시도 자체가 아니므로 여기서 기록하지 않는다([ADR 0006](0006-shutdown-contract.md)의 RD-031 개정 note 참고).
   - 중복 방지: `transport.invoke` 실패는 `rpc-settled`(`transport-failed`)만, subscribe 전송 실패는 `subscription-closed`(`transport-failed`)만 기록한다.

9. **`handshake-failed`**: `createRendererApi`가 reject하기 직전에 1회 기록한다. `connect` throw·reject `transport`. `parseHandshakeResponse`의 `VERSION_MISMATCH` `version-mismatch`, 그 외 parse 실패 `malformed`. manifest entry 거부(wire key 문법·카테고리·경로 충돌) `invalid-manifest`. reject 값(`RemoteError("INTERNAL")`과 문구)은 바꾸지 않는다. `transport` 생략 시 전역 transport가 없어 던지는 `TypeError`는 연결 설정 오류라 기록하지 않는다.

10. **기록 시점**: 내부 상태를 갱신한 뒤, 사용자 통지(Promise reject/resolve, subscriber `next`·`error`·`complete`) 전에 동기로 기록한다. sink 안에서 API를 다시 호출해도 내부 상태는 이미 일관된다(종료 경로에서 이 "이미 일관된다"가 실제로 성립하는 근거는 [ADR 0006](0006-shutdown-contract.md)의 RD-030 개정 note를 본다 — `dispose()`의 `rpc-settled` sink 재진입 시점에는 종료 플래그가 수명 객체 하나에서 이미 확정돼 있다).

11. **sink 예외 격리와 기본 무출력**: ADR 0010 결정 11·12와 같다. `record`의 동기 throw는 삼키고, 반환된 Promise는 await하지 않는다. sink가 없으면 완전히 조용하다. 격리 함수는 `src/renderer`에 둔다 — Renderer 번들이 `src/main`을 import하지 않는다.

## 대안과 기각 사유

- **위치 인자 유지(`createRendererApi(transport?, options?)`)**: 기본 transport와 sink를 함께 쓰려면 `undefined`를 먼저 넘겨야 한다. 외부 사용자가 없어 이전 비용이 없으므로 옵션 객체로 바꾼다.
- **snapshot API**: 루트에 `getDiagnosticsSnapshot`을 두면 도메인 예약어가 늘고, 별도 handle을 반환하면 `createRendererApi` 반환 형태가 바뀐다. 이벤트 쌍으로 셀 수 있어 두지 않는다.
- **Main `DiagnosticsSink`·`BridgeDiagnostic` 재사용**: 관측 지점과 식별자 규칙이 다르다(Renderer에는 `RejectReason`이 없고 로컬 확정 원인이 있다). 한 유니온에 섞으면 양쪽 소비자의 분기가 늘어난다.
- **확정·종료만 기록(폐기·전송 실패 제외)**: 표면은 작지만 프로토콜 이상과 전송 실패가 계속 보이지 않는다.
- **`code` 제외**: 도메인 에러와 `INTERNAL`을 구분할 수 없다.
- **모르는 `subscriptionId` 메시지 기록**: unsubscribe와 Main 전송 사이의 정상 경합마다 이벤트가 생긴다.

## 한계

- Electron preload transport(`exposeBridgeInMainWorld`)는 `onStreamMessage`에서 parse 실패를 먼저 버린다. preload에는 sink가 없어 이 경로의 `message-dropped`(`malformed`)는 기록되지 않는다. Renderer 쪽 `malformed`는 사용자 정의 transport에서만 관측된다.
- 진단 이벤트만으로 어떤 요청·구독이 원인인지 특정할 수 없다(식별자 기록 금지). 필요하면 앱이 호출 경계에서 직접 로깅한다.
- `durationMs`는 Renderer 벽시계 기준이며 IPC 왕복을 포함한다. Main `rpc-finished.durationMs`와 값이 다르다.

## 범위 밖

snapshot 조회, 로컬 구독자 단위 이벤트, `RemoteState.snapshot` 전이 이벤트, preload 진단, API 전체 끊김 신호([ADR 0020](0020-stream-terminal-on-retire.md) 결정 4와 같음), 누적 카운터.
