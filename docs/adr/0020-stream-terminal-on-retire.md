# 문서가 살아있는 채로 세션이 끝나면 스트림 구독에 종료를 통지한다

- 관련: ROADMAP.md#RD-026

## 상황

세션이 retire되면 RPC는 이미 통지를 받는다 — 진행 중 RPC는 `CANCELLED "Request cancelled."`, retire 뒤 새 RPC는 `FORBIDDEN "Bridge sender is not authorized."`([ADR 0015](0015-rpc-request-lifecycle.md)). 그러나 stream(State/Event)은 세 경로 모두 조용히 멈췄다:

- **활성 구독**: `session.signal` abort → `consumer.onSessionAbort` → `#close`. 전송 없음. _(개정: [ADR 0023](0023-session-retire-interface.md) — 구독 경로는 `session.signal`이 아니라 `onRetire`로 이 통지를 받는다. abort 메커니즘은 implementation으로 유지된다.)_
- **`authorize` 대기 구독**: 대기 entry의 `onAbort`가 `controller.abort()`만 하고 끝난다. 기존 `#reject`는 `sessionSignal.aborted`면 아무것도 보내지 않는다 — retire 통지에 그대로 쓸 수 없다.

  _(개정: RD-032 — 시작 전 거부·admission 거부·대기 중 retire·활성 retire의 통지 판정이 `Subscriptions`의 원인 표 한 곳으로 합쳐졌다. `#reject`는 삭제됐다.)_

- **subscribe admission 거부**(`sender-unauthorized`·`frame-not-main`·`origin-not-allowed`): `controlStream`의 `sessions.establish` 실패는 진단만 남기고 응답이 없다([ADR 0016](0016-sender-admission.md) 결정 3의 "cancel/control 응답: 없음(무시)").

문서가 살아있는 채로 세션이 끝나는 경우(detach, `server.dispose()`, bind `dispose()`)는 Renderer 구독자가 자신의 구독이 끊겼다는 사실을 알 방법이 없다. `RemoteState`는 `stale`로 전이하지 않고 마지막 값을 계속 "현재값"처럼 보여주고, `RemoteEvent` 구독은 그냥 멈춘다.

`ADR 0006`(종료 계약)은 이 통지를 명시적으로 범위 밖에 뒀다 — Renderer `api.dispose()` 경로는 결정했지만, Main이 먼저 세션을 끝내는 경우의 프로토콜 확장은 후속 과제로 남겼다. 출처는 `.scratch/shutdown-renderer-notify`.

문서가 죽는 대부분의 retire 원인(navigation commit, `render-process-gone`, `webContents` 파괴)은 통지를 관찰할 대상(그 문서의 Renderer)도 함께 사라지므로 통지가 무의미하다. `monitor` 같은 "다른 문서의 세션을 지켜보는" 시나리오는 성립하지 않는다 — 세션은 `webContents`(문서)별이라 다른 창의 retire가 이 구독에 닿지 않는다. 통지가 실제로 관찰되는 경우는 문서 자신이 살아있는 채로 브리지 연결만 끊기는 detach·`server.dispose()`·bind `dispose()`뿐이다.

## 결정

### 1. 기존 `error` 메시지를 그대로 쓴다. 코드는 RPC와 같다

새 `StreamMessage` 종류를 추가하지 않는다 — `subscribed`·`batch`·`error`·`complete`가 이미 있고 Renderer `StreamMultiplexer`가 `error`를 이미 처리한다(`handlers.error(remoteError(...))`). 코드는 RPC와 대칭을 맞춘다:

- 세션 종료로 끊긴 활성·`authorize` 대기 구독: `CANCELLED`(진행 중 RPC와 같은 코드).
- 세션이 끝난 뒤의 새 구독: `FORBIDDEN "Bridge sender is not authorized."`(새 RPC와 같은 코드·문구).

**기각한 대안**:

- `complete`: 정상 종료(소유자가 의도한 teardown, `api.dispose()`가 쓰는 코드)와 비자발적 끊김을 같은 신호로 묶으면 구독자가 "다 받은 스트림"과 "끊긴 스트림"을 구분할 수 없다.
- 새 오류 코드(예: `SESSION_ENDED`): 소비자의 코드 판별 분기가 늘어난다. `ADR 0006`이 `dispose()` 설계에서 이미 피한 확장이다 — 기존 `CANCELLED`/`FORBIDDEN`을 재사용해 판별 로직을 늘리지 않는다.

### 2. 통지 대상 3종

활성 구독, `authorize` 대기 구독, admission 거부 구독(`sender-unauthorized`·`frame-not-main`·`origin-not-allowed`).

_(개정: RD-032 — 시작 전 거부 응답을 보내기 직전이나 `subscribed` 전송 도중 retire된 구독도 통지 대상이다. retire 사유가 `detach`·`dispose`면 원래 거부 대신 `subscribed`(0) 뒤 `CANCELLED "Bridge session ended."`로 마감한다(결정 3의 "이미 기록된 terminal을 대체한다"와 같은 규칙). 보내기 직전 창은 `diagnostics.record`가 `rejected` 진단을 받는 중 동기로 detach·dispose할 때 생기며 실제 adapter에서도 열린다 — 이전에는 `subscribed`조차 보내지 않았다. `subscribed` 전송 도중 창은 실제 adapter(`webContents.send`)와 loopback 전달이 비동기라 생기지 않고, 동기 `send`를 쓰는 embedder나 test에서만 관찰된다.)_

_(개정: RD-037 — `session-opened`·`subscription-opened` 진단 창에서 동기로 detach·dispose가 일어나 등록 시점에 이미 retire된 pending 구독·consumer(`subscribed` 송신 전)도 통지 대상이다. retire 사유가 `detach`·`dispose`면 `subscribed`(0) 뒤 `CANCELLED "Bridge session ended."`로 마감한다. 이전에는 이 두 경로가 무통지였다 — pending은 조용히 정리만 하고, consumer는 통지 없이 닫았다.)_

### 3. 쌓인 값은 버리고 종료 메시지를 바로 보낸다

ACK 대기 중이던 값, 아직 보내지 않은 `pendingState`/`pendingEvents`, 이미 기록된 terminal(overflow `error`·upstream `complete` 대기 등) 모두 전달하지 않는다. 세션이 끝나면 ACK를 받을 방법 자체가 없다(`current()`가 거부한다) — 정상 flush 경로(`#flush`)를 거치지 않고 다음 sequence 번호로 종료 메시지를 즉시 보낸다.

### 4. API 전체 차원의 끊김 신호는 범위 밖

`api.closed`·`onDisconnect` 같은 루트 레벨 신호는 다루지 않는다. 이 ADR은 개별 스트림 구독의 terminal 메시지만 다룬다.

### 5. 원인별 통지 여부

| retire 원인                                                                                              | 통지          |
| -------------------------------------------------------------------------------------------------------- | ------------- |
| detach(`attach()` 반환 함수, 같은 `webContents` 재attach 포함)                                           | 보낸다        |
| `server.dispose()`                                                                                       | 보낸다        |
| bind `dispose()`                                                                                         | 보낸다        |
| navigation(main frame이 새 문서로 commit되는 시점, [ADR 0019](0019-navigation-retire-on-commit.md) 이후) | 보내지 않는다 |
| `render-process-gone`                                                                                    | 보내지 않는다 |
| `destroyed`                                                                                              | 보내지 않는다 |
| 새 `clientId`로 인한 retire(`replaced`)                                                                  | 보내지 않는다 |

navigation·`render-process-gone`·`destroyed`는 옛 문서 자신이 이미 없다(통지할 대상이 없다). 새 `clientId` retire(결정 8)는 재연결 흐름의 일부다.

### 6. 전송 실패는 삼킨다

frame 소멸 등으로 전송이 실패해도 catch해서 무시한다(best-effort). 전송 실패가 세션·구독 슬롯 정리를 막으면 안 된다 — 정리는 전송 성공 여부와 무관하게 끝까지 진행한다.

### 7. 진단 사유·이벤트는 바꾸지 않는다

`session-closed`·`subscription-closed`·`rejected` 등 기존 진단 이벤트의 시점·사유·필드는 이 ADR로 바뀌지 않는다. 이 ADR은 wire 메시지 전송만 추가한다.

### 8. 새 `clientId`로 인한 retire는 통지하지 않는다

`establish`가 같은 `webContents`의 옛 세션을 새 `clientId`로 교체할 때(`document-sessions.ts`의 `establish`) 옛 세션은 통지 없이 retire된다. preload가 `clientId`를 문서당 1회 생성한다(`expose-bridge.ts`) — 새 `clientId`가 도착했다는 것은 새 문서가 그 `webContents`의 main frame을 차지했다는 뜻이고, 옛 문서는 이미 없다(있다면 그 자체가 preload 계약 밖 사용, 예: `options.clientId`를 문서 안에서 직접 바꾸는 경우). 그런 사용은 이 ADR이 보장하는 통지 대상이 아니다.

### 9. `CANCELLED` 문구는 `"Bridge session ended."`

활성·`authorize` 대기 구독의 `CANCELLED`는 RPC 취소 문구(`"Request cancelled."`)와 다른 `"Bridge session ended."`를 쓴다. 문구는 계약이 아니다(코드가 계약) — 다만 원인이 다르므로(사용자 명시적 취소 vs. 세션 자체의 종료) 문구를 구분해 로그·디버깅에서 원인을 알아볼 수 있게 한다.

## 보존

- 메시지 종류(`subscribed`·`batch`·`error`·`complete`), 오류 코드 집합, protocol version은 바뀌지 않는다.
- 진단 이벤트 종류·사유·필드는 바뀌지 않는다.
- `unsubscribe`·`acknowledge`·`cancel` 거부는 이 ADR 이후에도 응답하지 않는다(호출 자체가 fire-and-forget이라 응답 대상이 없다) — [ADR 0016](0016-sender-admission.md) 결정 3의 "cancel/control 응답: 없음(무시)"는 subscribe를 제외하고는 그대로 유효하다. 아래 "관련 ADR" 참고.
- parse 실패(`malformed-envelope`·`version-mismatch`) subscribe는 응답하지 않는다 — `subscriptionId`를 신뢰할 수 없어 어느 구독에 보낼지 판정할 수 없다.

## 이전(migration)

외부 사용 이력이 없다(버전 `0.0.0`, npm 배포 이력 없음). README "호환성 변경" 절에 항목을 추가하지 않는다.

## 관련 ADR

- [ADR 0006](0006-shutdown-contract.md) — "범위 밖" 절이 이 통지를 후속 과제로 남겼다. 이 ADR이 그 과제를 처리한다(해당 절에 개정 표시를 남겼다).
- [ADR 0015](0015-rpc-request-lifecycle.md) — RPC의 `CANCELLED`/`FORBIDDEN` 대칭 코드를 stream에도 그대로 적용한다.
- [ADR 0016](0016-sender-admission.md) — "사유 매핑 표"의 "cancel/control 응답" 열이 subscribe에는 더 이상 맞지 않는다(admission 거부 subscribe가 이제 응답한다) — 해당 절에 개정 표시를 남겼다.
- [ADR 0019](0019-navigation-retire-on-commit.md) — navigation retire 시점이 문서 commit으로 옮겨진 뒤에도(옛 문서가 이미 없으므로) 통지 대상에서 제외되는 것은 그대로다.
