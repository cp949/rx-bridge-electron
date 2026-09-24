# Main은 진단 이벤트와 스냅샷 조회로 세션·RPC·구독 수명주기와 거부 사유를 관측 가능하게 한다

> [ADR 0014](0014-stream-lookup-before-authorize.md)가 stream 등록 조회 판정 시점을 `authorize` 앞으로 옮겼다. 아래 §6의 "등록 조회를 통과한 경우만 `key`를 넣는다" 규칙 자체는 바뀌지 않았지만, `subscription-limit`이 이제 그 규칙을 통과해 `key`를 포함한다(이전에는 등록 조회 전에 판정돼 `key`가 없었다). §9의 `StreamHub`는 `Subscriptions`로 이름이 바뀌었다. 이 문서의 다른 결정은 그대로 유효하다.

## 상황

Main에는 `DiagnosticsSink` hook이 이미 있었지만 이벤트가 5종(`rpc-finished`, `rpc-cancelled`, `validation-failed`, `stream-queue`, `stream-dropped`)뿐이었다. 보안 거부(`sender-unauthorized` 등)·입력 거부(`invalid-input`, `payload-too-large`)·자원 한도 거부(`rpc-limit`, `subscription-limit`)의 사유, Main deadline 만료, RPC 성공·실패 구분, 세션·구독의 생성과 해제는 기록하지 않았다. 활성 세션·RPC·구독 수, 대기 중 이벤트 수를 조회할 방법도 없었다. 7개 호출 지점 모두 `diagnostics?.record(...)`를 try로 감싸지 않아 sink가 throw하면 dispatch·stream 경로로 예외가 전파됐다. ROADMAP RD-007.

## 결정

1. **관측 모델**: 기존 `DiagnosticsSink` 이벤트형 hook을 유지하고 새 이벤트 종류를 추가한다. 게이지(현재 활성 수)는 이벤트가 아니라 `server.getDiagnosticsSnapshot()` 조회 API로 제공한다 — 이벤트 스트림에서 게이지를 재구성하게 만들지 않는다.
2. **범위**: Main만. Renderer 쪽 진단은 이 ADR의 범위가 아니다(아래 "범위 밖").
3. **기록 금지 강제**: 이벤트는 닫힌 판별 유니온(`BridgeDiagnostic`)이다. 사유는 enum 코드(`RejectReason`), 식별자는 등록 조회를 통과한 와이어 키(`key`)만, 수치는 크기·개수·시간만 싣는다. `Error` 객체, `message`, `stack`, 원문 payload, `origin` 문자열, `clientId`, `webContentsId`, `requestId`, `subscriptionId`는 어떤 이벤트에도 넣지 않는다.
4. **이벤트 종류**: 기존 5종에 `rpc-finished.outcome`을 추가하고, 다음 6종을 새로 추가한다.

   ```ts
   export type RejectReason =
     | "frame-not-main"
     | "origin-not-allowed"
     | "sender-unauthorized"
     | "authorize-denied"
     | "version-mismatch"
     | "malformed-envelope"
     | "unknown-operation"
     | "invalid-input"
     | "payload-too-large"
     | "rpc-limit"
     | "subscription-limit";

   export type BridgeDiagnostic =
     | {
         type: "rpc-finished";
         key: string;
         durationMs: number;
         outcome: "ok" | "error";
       }
     | { type: "rpc-cancelled"; key: string }
     | { type: "rpc-timed-out"; key: string }
     | { type: "validation-failed"; key: string }
     | { type: "stream-queue"; key: string; depth: number }
     | { type: "stream-dropped"; key: string; count: number }
     | { type: "rejected"; reason: RejectReason; key?: string }
     | { type: "session-opened" }
     | { type: "session-closed" }
     | { type: "subscription-opened"; key: string }
     | { type: "subscription-closed"; key: string };
   ```

   세션 이벤트에는 식별자를 넣지 않는다 — 생성·해제 쌍은 개수로만 맞춘다. RPC 시작 이벤트는 추가하지 않는다.

5. **`RejectReason` 11개와 판정 지점**: 모두 `{ type: "rejected", reason, key? }` 하나의 이벤트 모양을 공유한다.
   - `frame-not-main` / `origin-not-allowed`: adapter handshake(`electron-adapter.ts`)에서 main frame·origin 검사 실패.
   - `sender-unauthorized`: server `handshake`/`dispatchRpc`/`controlStream`의 `establish`/`current` 실패(frame·origin 불일치, retired clientId 등). adapter handshake에서 `server.handshake`가 `undefined`인 경우도 server 쪽에서 기록한다(아래 "중복 방지").
   - `authorize-denied`: `authorize`가 false.
   - `version-mismatch`: RPC·stream의 protocolVersion 불일치.
   - `malformed-envelope`: adapter의 handshake·rpc·cancel·control 4채널 `parse*` 실패만. `dispatchRpc`가 던진 예외는 기록하지 않는다. `authorize` 예외는 [ADR 0011](0011-authorize-exception-internal.md) 이후 `dispatchRpc`가 직접 `INTERNAL`로 응답하며 `rejected` 대상이 아니다.
   - `unknown-operation`: 미등록 RPC·stream key.
   - `invalid-input`: 입력 스키마 검증 실패, subscriptionId 형식 오류.
   - `payload-too-large`: 입력의 `PayloadLimits` 초과(`invalid-input`과 별개 코드).
   - `rpc-limit`: `maxConcurrentRpc` 초과.
   - `subscription-limit`: `maxSubscriptions` 초과.
   - 워터마크 이하 subscriptionId·중복 구독의 조용한 무시는 이벤트를 남기지 않는다(범위 밖).

6. **`key` 포함 규칙**: 등록 조회(RPC·stream key 존재 확인)를 통과한 경우만 `key`를 넣는다. `authorize-denied`, `invalid-input`(RPC 입력 스키마 검증 실패), `payload-too-large`, `rpc-limit`, `subscription-limit`은 key 있음([ADR 0014](0014-stream-lookup-before-authorize.md) 이후 stream 등록 조회가 slot 판정보다 먼저 실행되므로 `subscription-limit`도 이 규칙을 통과한다). subscriptionId 형식 오류의 `invalid-input`은 등록 조회 전에(ID 파싱 단계에서) 판정되므로 key 없음. `unknown-operation`, `version-mismatch`, `sender-unauthorized`, `frame-not-main`, `origin-not-allowed`, `malformed-envelope`은 key 없음.

7. **`payload-too-large` / `invalid-input` 구분**: 메시지 문자열 매칭으로 판정하지 않는다. `src/protocol/bridge-value.ts`에 `PayloadLimitError extends BridgeProtocolError`를 추가해 `maxTotalBytes`·`maxStringBytes`·`maxDepth`·`maxEntries` 초과 지점만 이 서브클래스를 던지고, `rpc-dispatcher.ts`가 `instanceof PayloadLimitError`로 분기한다. 구조 오류(허용되지 않는 값 타입·symbol 키 등)는 기존 `BridgeProtocolError`를 그대로 던져 `invalid-input`으로 분류된다. 공개 `BridgeProtocolError`의 `name`·`code`(`INVALID_ARGUMENT`)·`message` 계약은 바뀌지 않는다 — `PayloadLimitError`는 내부 판정 표식일 뿐이며 `./protocol` 공개 entry에서 export하지 않는다. 요청이 이미 취소된 상태(aborted)면 기존대로 `CANCELLED`를 응답하고 이벤트는 기록하지 않는다.

8. **`rpc-timed-out`과 `outcome`**: Main deadline 만료는 `{ type: "rpc-timed-out", key }` 1회만 기록하고 `rpc-cancelled`는 기록하지 않는다(기존 동작 유지). 순서는 `rpc-timed-out` → (handler가 실제로 끝날 때) `rpc-finished`. `rpc-finished.outcome`은 handler work의 실제 응답이 성공(`RpcResponse`의 성공 타입)이면 `"ok"`, 그 외(도메인 에러, 출력 검증 실패, `authorize` false, 취소, `authorize` 예외 — [ADR 0011](0011-authorize-exception-internal.md) 이후 work가 `INTERNAL`로 응답)는 `"error"`다. deadline이 먼저 응답했어도 outcome은 handler 쪽 work의 실제 결과로 판정한다(deadline 응답 시점이 아니다).

9. **수명주기 이벤트**: `session-opened`는 `DocumentSessions.establish`가 새 `DocumentSession`을 만들어 attachment의 현재 세션으로 등록한 직후, `session-closed`는 `#retire`에서 세션이 존재할 때 1회(detach, lifecycle 사건, 같은 webContents의 새 clientId, dispose 모두 이 단일 지점을 거친다 — dispose 반복 호출은 추가 이벤트를 내지 않는다). `subscription-opened`는 `Subscriptions`가 `authorize` 승인 뒤 consumer를 등록한 직후(`subscribed` 전송 전, key 포함), `subscription-closed`는 그 consumer가 처음 닫힐 때(key 포함). `authorize` 대기 중인 구독(등록 전 pending 상태)은 opened/closed 이벤트 대상이 아니다 — 승인·거부·세션 retire로 최종 확정될 때만 해당 경로의 이벤트가 발생한다.

10. **스냅샷**: `server.getDiagnosticsSnapshot(): DiagnosticsSnapshot` 공개 메서드, `{ sessions, rpcInFlight, subscriptions, queuedEvents }`.
    - `sessions`: 현재 활성 attachment(현재 세션이 있는 attachment) 수.
    - `rpcInFlight`: 서버 전역 카운터(`tryAcquireRpc` 성공 시 증가, `releaseRpc` 시 감소)로 계산한다 — handler가 실제로 끝날 때까지 센다. retire된 세션의 handler가 아직 끝나지 않았어도 계속 포함된다(세션별 상태 순회가 아니라 전역 카운터를 쓰는 이유다).
    - `subscriptions`: 한도 계산 기준과 같은 값(대기 + 활성)의 모든 세션 합. `subscription-opened`/`closed` 이벤트 쌍(활성만 센다)과 값이 다를 수 있다 — authorize 대기 중인 구독은 스냅샷에는 포함되지만 아직 `subscription-opened`를 내지 않는다.
    - `queuedEvents`: 모든 consumer의 대기열(`pendingEvents`) 현재 길이 합.
    - 반환은 매 호출 새 객체다. 누적 카운터는 두지 않는다(아래 "대안과 기각 사유"). 서버 dispose 후에는 `rpcInFlight`를 제외한 세 값이 0이고, 끝나지 않은 handler가 있으면 `rpcInFlight`는 실제 값을 반환한다.

11. **sink 예외 격리**: 7개 기존 호출 지점과 모든 새 호출 지점을 공통 함수 `recordDiagnostic(sink, event)` 하나로 모은다. sink가 없으면 no-op이고, `record`가 동기로 throw해도 삼켜서 dispatch·stream 경로로 전파되지 않는다. `record`가 Promise를 반환해도 await하지 않는다(계약상 반환 타입이 `void`라 기대하지 않는다).
12. **기본 무출력**: 어떤 진단 경로도 `console.*`이나 `process.stdout/stderr`를 쓰지 않는다. sink를 지정하지 않으면 완전히 조용하다.
13. **`stream-queue` 빈도**: 기존 빈도(push·shift마다 기록)를 유지한다. 고빈도 관측이 필요하면 소비자가 sink 안에서 직접 샘플링(예: N번째 이벤트만 반영)한다 — 라이브러리가 빈도를 낮추지 않는다.
14. **adapter → sink 경로**: `electron-adapter.ts`는 `DiagnosticsSink`에 직접 접근하지 않는다(`bindElectronBridge`는 `StreamBridgeServer`만 받는다). `src/main/diagnostics.ts`에 모듈 내부 Symbol `recordAdapterRejection`을 두고 `StreamBridgeServer`에 그 Symbol 키의 선택(`?`) 메서드를 붙인다. Symbol은 런타임 import가 없는 `diagnostics.ts`에 둔다 — preload가 `ELECTRON_BRIDGE_CHANNELS` 때문에 `electron-adapter.ts`를 번들하므로, adapter가 `create-bridge-server.ts`를 값으로 import하면 preload 번들에 server와 `rxjs`가 끌려와 sandbox preload가 로드되지 않는다. `src/main/index.ts`는 이 Symbol을 export하지 않는다 — 라이브러리 사용자·테스트 fake가 작성하는 `StreamBridgeServer` 구현은 이 메서드가 없어도 `bindElectronBridge`와 계속 호환된다(메서드가 없으면 adapter는 기록을 건너뛴다). sink 설정 지점은 여전히 `createBridgeServer` 하나뿐이다.
15. **중복 방지**: 한 요청에서 `rejected`는 최대 1회만 기록한다. adapter handshake에서 `server.handshake`가 `undefined`를 반환하면 이미 server가 `sender-unauthorized`를 기록했으므로 adapter는 추가로 기록하지 않는다. adapter는 자체 검사(`frame-not-main`, `origin-not-allowed`)와 파싱 실패(`malformed-envelope`)만 기록한다.

## 대안과 기각 사유

- **누적 카운터를 스냅샷에 포함**: 총 처리 RPC 수, 총 거부 수 같은 누적값은 서버 인스턴스 수명 동안 상태를 유지해야 하고 "언제부터의 누적인가"가 관측자마다 다르게 해석될 수 있다. 이벤트 스트림을 그대로 집계하면 관측자가 원하는 윈도우(1분, 세션 수명 등)로 직접 계산할 수 있으므로 라이브러리가 대신 누적하지 않는다.
- **거부 이벤트를 사유별로 나눈 여러 타입**: `RejectReason`마다 별도 이벤트 타입을 두면 `BridgeDiagnostic` union이 11개 늘어나 소비자의 switch 분기 부담이 커진다. 사유를 enum 필드로 두는 하나의 `rejected` 타입이 판별 유니온을 유지하면서도 확장 비용이 낮다.
- **`console` 기본 출력**: sink 미지정 시 기본으로 `console.error` 등에 찍는 방식도 검토했으나, 라이브러리가 호스트 애플리케이션의 로그 정책(포맷, 수준, 목적지)을 임의로 정하게 된다. 기본 무출력으로 두고 관측이 필요하면 sink를 명시적으로 연결하게 한다.
- **Renderer까지 이 ADR 범위에 포함**: Renderer 쪽 관측(로컬 timeout, dispose로 인한 취소 등)은 신뢰 경계가 다르고 Main처럼 여러 세션이 자원을 공유하지도 않는다. 별도 이슈(`.scratch/renderer-diagnostics/issues/`)로 분리해 이 ADR의 범위를 Main으로 한정했다.

## 한계

- `subscriptions` 스냅샷 값과 `subscription-opened`/`closed` 이벤트 쌍의 개수가 항상 일치하지는 않는다 — 전자는 대기(authorize 중) + 활성, 후자는 활성만 센다.
- `rpcInFlight`는 서버 전역 카운터이므로 세션별로 얼마나 점유하고 있는지는 스냅샷만으로 알 수 없다(세션별 `maxConcurrentRpc` 판정 자체는 세션별 상태로 별도 수행한다).
- `stream-queue`는 push·shift마다 기록되므로 고빈도 스트림에서는 이벤트 수가 많다. 라이브러리가 빈도를 낮추지 않으므로 필요하면 sink에서 직접 샘플링해야 한다.
- 진단 이벤트만으로는 어떤 세션·요청이 원인인지 특정할 수 없다(기록 금지 항목이 의도적으로 막는 부분이다). 상관관계 분석이 필요하면 호스트 애플리케이션이 자체 요청 경계에서 별도로 로깅해야 한다.

## 범위 밖

Renderer 진단(후속: `.scratch/renderer-diagnostics/issues/`), `authorize` 예외의 응답 코드 불일치(RPC는 `INVALID_ARGUMENT`, stream은 `INTERNAL`) 수정(후속으로 [ADR 0011](0011-authorize-exception-internal.md)에서 둘 다 `INTERNAL`로 통일), 누적 카운터, `stream-queue` 기록 빈도 변경, 워터마크 이하 subscriptionId·중복 구독의 조용한 무시에 이벤트 추가, RPC 시작 이벤트.

## 이전(migration)

README "호환성 변경" 절([packages/rx-bridge-electron/README.md](../../packages/rx-bridge-electron/README.md))에 `rpc-finished.outcome` 필드 추가를 적는다 — `BridgeDiagnostic`을 망라해 분기하던 기존 sink 구현은 이 필드와 새 이벤트 6종을 처리하도록 확인해야 한다.
