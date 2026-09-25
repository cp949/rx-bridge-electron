# 04. 문서 세션

## 1. 목적과 범위

답하는 질문:

- Main의 RPC·stream 자원은 누구의 소유인가.
- 요청을 보낸 sender가 현재 문서 세션에 속하는지 어떤 순서로 판정하는가.
- `clientId`는 언제 새 세션을 열고, 언제 거부되는가.
- 세션은 어떤 사건으로 언제 retire되는가. retire 통지는 호출자에게 어떻게 전달되는가.

다루지 않는 것:

- 채널·envelope parse·Electron adapter 연결: [03. Transport와 연결 설정](03-transport-and-wiring.md)
- retire 시 RPC 취소와 응답: [05. RPC](05-rpc.md)
- retire 시 구독 terminal 통지 규칙(detach·dispose는 `error CANCELLED`, 나머지는 무출력): [06. Main 스트림 전달](06-stream-delivery.md)
- retired 기록 보관량 `maxRetiredClientsPerWebContents`와 slot 회계: [09. 세션 자원 한도](09-resource-limits.md)
- `server.dispose()`·bind `dispose()`의 종료 판정: [10. 종료](10-shutdown.md)
- `rejected`·`session-opened`·`session-closed` 진단: [11. 진단](11-diagnostics.md)

## 2. 모델

소유 단위는 BrowserWindow가 아니라 렌더러 문서 세션이다. 한 창에서 reload·navigation이 일어나면 이전 문서가 시작한 RPC·구독이 새 문서로 넘어가지 않아야 한다. 창을 단위로 삼으면 같은 창의 다음 문서가 이전 문서의 비동기 작업과 구독을 이어받는다([ADR 0002](../adr/0002-renderer-document-session-ownership.md)).

| 개념              | 정의                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| attachment        | `server.attach(target)`로 등록한 `webContents` 하나. `webContentsId`당 하나. `AttachedTarget`(frame·origin 판정 port, 수명 사건 구독, `role`)과 현재 세션 슬롯 하나를 가진다 |
| 문서 세션         | attachment의 현재 main frame 문서 + `clientId`. `webContents`·main frame 문서·`clientId` 셋이 한 세션을 이룬다. attachment당 현재 세션은 최대 하나다                         |
| `clientId`        | preload가 `exposeBridgeInMainWorld` 호출마다 만드는 값(`client-${crypto.randomUUID()}`). preload는 문서마다 다시 실행되므로 새 문서는 새 `clientId`를 가진다                 |
| retired 기록      | `webContentsId` → retire된 `clientId` 집합(삽입 순서). 재사용을 막는다                                                                                                       |
| `DocumentSession` | 호출자(`RpcRequests`·`Subscriptions`)가 보는 interface: `target`, `clientId`, `retireReason`, `onRetire(listener)`                                                           |

소유 모듈은 `src/main/document-sessions.ts`의 `DocumentSessions`다. sender admission(`#admit`), 세션 생성(`establish`)·조회(`current`), retire(`#retire`), retired 기록을 모두 가진다. 구현 class `SessionImpl`은 export하지 않는다. `DocumentSession`·`Admission`·`RetireReason`도 패키지 내부 타입이고 `./main` 공개 export가 아니다.

`AttachedTarget`의 판정 port는 adapter가 채운다. Electron adapter의 `isCurrentMainFrame`은 `sender.webContentsId === contents.id && sender.isMainFrame && contents.mainFrame.routingId === sender.frameId`이고, `isAllowedOrigin`은 `allowedOrigins.includes(origin)`이다([03](03-transport-and-wiring.md)). 판정 순서와 사유는 `DocumentSessions`가 정한다.

## 3. 불변식

1. attachment당 현재 세션은 최대 하나다.
2. 모든 채널의 sender admission은 `#admit` 하나를 거친다. 같은 sender 상태는 채널과 무관하게 같은 사유를 낸다.
3. 세션을 만들거나 교체하는 것은 `establish`뿐이다. `current`는 세션을 만들지도 retire하지도 않는다.
4. retire는 세션당 한 번이고 되돌릴 수 없다. 첫 사유가 유지된다.
5. retire된 `clientId`는 같은 `webContentsId`에서 retired 기록에 남아 있는 동안 다시 세션을 열지 못한다.
6. 거부된 요청(admission 실패, retired `clientId`)은 현재 세션을 retire하지 않는다. retired 판정이 교체보다 먼저다.
7. `retireReason`은 retire listener가 호출되기 전에 설정된다.
8. retired 기록은 `server.dispose()` 뒤에도 지우지 않는다. `destroyed`만 그 `webContentsId`의 기록 전체를 지운다.

## 4. 흐름

### sender admission 순서

`#admit(sender)`는 다음 순서로 판정하고 첫 실패 사유를 돌려준다.

| 순서 | 조건                                                            | 사유                  |
| ---- | --------------------------------------------------------------- | --------------------- |
| 1    | `DocumentSessions`가 disposed                                   | `sender-unauthorized` |
| 2    | `webContentsId`에 attachment 없음(미attach)                     | `sender-unauthorized` |
| 3    | `!sender.isMainFrame` 또는 `!target.isCurrentMainFrame(sender)` | `frame-not-main`      |
| 4    | `!target.isAllowedOrigin(sender.origin)`                        | `origin-not-allowed`  |

미attach를 frame·origin보다 먼저 본다. 미attach `webContents`는 origin이 허용 목록 밖이어도 `sender-unauthorized`다.

envelope parse(version 포함)는 admission보다 먼저다. parse 실패는 admission에 도달하지 않는다([03](03-transport-and-wiring.md)).

### `establish`와 `current`

| 메서드      | 쓰는 요청                        | 세션 생성 | 판정                                                                   |
| ----------- | -------------------------------- | --------- | ---------------------------------------------------------------------- |
| `establish` | handshake, RPC, subscribe        | 한다      | `#admit` 뒤 client 판정. 새 `clientId`면 현재 세션을 `replaced`로 교체 |
| `current`   | cancel, unsubscribe, acknowledge | 안 한다   | `#admit` 뒤 현재 세션의 `clientId`가 같고 retire되지 않았을 때만 통과  |

`establish(sender, clientId)`의 client 판정 순서:

1. 현재 세션의 `clientId`가 같으면 그 세션을 돌려준다.
2. retired 기록에 `clientId`가 있으면 `sender-unauthorized`.
3. 현재 세션을 `replaced`로 retire한다(현재 세션이 없으면 no-op).
4. 3의 retire listener가 동기로 재진입해 attachment를 교체했거나 다른 `clientId`로 이미 새 세션을 열었으면 `sender-unauthorized`. 먼저 열린 세션을 덮어쓰지 않는다.
5. 새 세션을 만들어 현재 세션으로 둔다.

`current(sender, clientId)`는 `#admit` 통과 뒤 현재 세션이 없거나, `clientId`가 다르거나, retire됐으면 `sender-unauthorized`다.

결과: 새 문서의 첫 `establish` 요청(보통 handshake, RPC·subscribe도 해당)이 이전 세션을 교체한다. cancel·unsubscribe·acknowledge는 세션을 만들 수 없으므로 현재 세션을 교체하지 못한다.

두 메서드 모두 `Admission = { session } | { reason }`을 반환한다. `reason`은 `SenderRejectReason`(`frame-not-main` | `origin-not-allowed` | `sender-unauthorized`)이다.

### 거부 사유의 wire 응답

사유는 진단에만 싣는다. wire 응답은 채널별로 고정된 모양이다.

| 채널                           | admission 거부 응답                                                  |
| ------------------------------ | -------------------------------------------------------------------- |
| handshake                      | `INVALID_ARGUMENT "Invalid bridge request."`                         |
| RPC                            | `FORBIDDEN "Bridge sender is not authorized."`                       |
| subscribe                      | `subscribed` 뒤 `error FORBIDDEN "Bridge sender is not authorized."` |
| cancel·unsubscribe·acknowledge | 응답 없음(fire-and-forget)                                           |

세 사유 모두 같은 응답이다. Renderer는 신뢰 경계 밖이므로 frame·origin·client 상태를 응답으로 알려주지 않는다.

### retire 사유와 시점

`RetireReason`은 6개다.

| 사유                    | 발생 시점                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main-frame-navigation` | main frame이 새 문서로 commit될 때. Electron `did-navigate`, 또는 `did-fail-load` 중 `isMainFrame`이고 콜백 시점 `contents.mainFrame.routingId === frameRoutingId`인 경우 |
| `render-process-gone`   | `render-process-gone` 이벤트                                                                                                                                              |
| `destroyed`             | `destroyed` 이벤트(1회). 그 `webContentsId`의 retired 기록 전체도 지운다                                                                                                  |
| `detach`                | `attach()`가 반환한 detach 함수 호출, 또는 같은 `webContentsId`를 다시 attach할 때 이전 attachment                                                                        |
| `dispose`               | `server.dispose()`가 남은 attachment를 모두 detach할 때                                                                                                                   |
| `replaced`              | `establish`가 새 `clientId`로 현재 세션을 교체할 때                                                                                                                       |

bind `dispose()`는 자신이 attach한 `webContents`를 먼저 detach한 뒤 `server.dispose()`를 호출한다. 그래서 bind로 attach한 세션의 사유는 `detach`다. 두 사유 모두 문서가 살아 있는 채 세션이 끝나는 경우라 구독 통지 결과는 같다([06](06-stream-delivery.md)).

앞의 세 사유는 `AttachedTarget.onLifecycle`이 알린다. 수명 사건은 attachment의 현재 세션이 무엇이든 그 세션을 retire한다.

#### navigation은 commit 시점에 retire한다

navigation 시작(`did-start-navigation`)은 문서가 그대로 남는 이동에서도 온다: `history.pushState`·hash 변경, HTTP 204, 다운로드 취소, `will-navigate` `preventDefault()`로 막힌 이동, beforeunload로 취소된 `ERR_ABORTED`. retire된 `clientId`는 같은 문서에서 다시 쓸 수 없으므로, 시작 시점에 retire하면 이런 이동 한 번에 그 문서의 브리지가 reload 전까지 멈춘다. 그래서 문서가 실제로 교체되는 commit에만 retire한다([ADR 0019](../adr/0019-navigation-retire-on-commit.md)).

신호 선택 근거(Electron 44.4.5 실측, ADR 0019):

- 문서가 교체된 case(일반 이동, reload, 같은 URL `loadURL`, `history.back()` cross-document, `location.replace`, 본문 있는 4xx/5xx, crash 뒤 reload)는 `did-navigate`가 정확히 1회 오고 `routingId`가 바뀐다.
- 문서가 남은 case는 `did-navigate`가 0회다.
- 오류 페이지 commit(`ERR_CONNECTION_REFUSED` 등)은 `did-navigate` 없이 `did-fail-load`만 온다. `did-fail-load`는 문서가 남는 `ERR_ABORTED`에서도 오므로 routingId 일치 조건으로 거른다.
- 새 문서의 첫 IPC가 commit 신호보다 먼저 도착한 case는 없었다.

navigation 시작부터 commit까지 옛 문서는 살아 있다. 그 사이 도착한 옛 문서의 요청은 정상 처리된다.

`did-navigate-in-page`(같은 문서 이동)는 구독하지 않는다.

### retire 처리 순서

`#retire(attachment, reason)`:

1. `attachment.current`를 비운다.
2. `session-closed`를 기록한다.
3. `clientId`를 retired 기록에 추가하고, 한도를 넘으면 가장 오래된 항목부터 지운다.
4. `session.retire(reason)`: 사유를 설정한 뒤 내부 `AbortController`를 abort해 listener를 호출한다.
5. 사유가 `destroyed`면 그 `webContentsId`의 retired 기록 전체를 지운다.

현재 세션이 없으면 1–4를 건너뛴다. 1이 4보다 먼저이므로 listener 안에서 재진입한 `establish`는 새 세션을 열 수 있다. 바깥 `establish`는 이 경우를 client 판정 4단계에서 거부한다.

detach는 attachment를 map에서 먼저 지우고 lifecycle 구독을 해제한 뒤 retire한다. listener 안에서 같은 `webContentsId`를 재진입 attach하면 그 attachment가 남고, 바깥 `attach`는 no-op 해제 함수를 돌려준다. 교체된 뒤의 옛 detach 함수는 새 attachment를 지우지 않는다.

### retired 기록

- `webContentsId`별 삽입 순서 집합이다. 세션이 retire될 때마다 그 `clientId`를 추가한다.
- 보관량은 `webContents`당 최근 `maxRetiredClientsPerWebContents`개다(기본 32, [09](09-resource-limits.md)). 초과하면 가장 오래된 것부터 지운다.
- `destroyed`는 그 `webContentsId`의 기록 전체를 지운다. 그 `webContents`는 다시 살아나지 않는다.
- `main-frame-navigation`·`render-process-gone`·`server.dispose()`는 기록을 지우지 않는다. dispose 뒤에도 재사용 금지가 흔들리지 않아야 한다.

재사용을 막는 이유: retired 기록이 없으면 옛 문서의 늦은 요청이 `establish`에서 새 `clientId`로 취급된다. 그 요청이 현재 세션을 `replaced`로 retire하고 옛 `clientId` 세션을 다시 연다. 기록에서 밀려난 오래된 `clientId`는 frame 검사가 막는다. 오래된 문서는 이미 현재 main frame이 아니므로 `frame-not-main`이 먼저 난다.

### retire interface

```ts
interface DocumentSession {
  readonly target: AttachedTarget;
  readonly clientId: string;
  readonly retireReason: RetireReason | undefined;
  onRetire(listener: () => void): () => void;
}
```

- `retireReason`: 살아 있는 세션은 `undefined`다. 사유 비교는 `RetireReason` literal 타입으로 한다.
- `onRetire(listener)`, 살아 있는 세션: 호출마다 독립 등록이다. 같은 함수를 두 번 등록하면 두 번 호출된다. 반환된 해제 함수는 자기 등록만 지우고 멱등이다.
- `onRetire(listener)`, 이미 retire된 세션: listener를 반환 전에 동기로 호출하고 no-op 해제 함수를 돌려준다. 이 즉시 호출의 예외는 `onRetire` 호출자에게 전파된다.
- 등록 뒤 retire: 내부 `AbortSignal` dispatch로 등록 순서대로 호출한다. listener 예외는 `EventTarget`이 dispatch 밖으로 보고하고 나머지 listener는 계속 호출된다.
- listener는 인자를 받지 않는다. 호출 시점에 `retireReason`이 이미 설정돼 있다.
- `retire(reason)`은 `SessionImpl`에만 있고 `DocumentSessions`만 호출한다. 두 번째 호출은 no-op이다.

즉시 동기 호출 덕분에 등록 지점(RPC 요청, 구독 pending, 구독 consumer)은 "등록 전 retire"와 "등록 후 retire"를 같은 경로로 처리한다. 호출자는 등록 뒤 `aborted`를 다시 검사하지 않는다. 호출자는 `SessionSlots` lease를 거쳐 이 계약을 쓴다([09](09-resource-limits.md)).

## 5. 설계 이유와 기각한 대안

- 판정을 `DocumentSessions#admit` 하나에 둔다: 판정이 흩어져 있으면 같은 실패가 채널마다 다른 사유가 된다. port(`isCurrentMainFrame`·`isAllowedOrigin`)만 adapter에 두면 순서가 한 곳에 고정된다([ADR 0016](../adr/0016-sender-admission.md)).
- retire 통지를 세션 interface로 노출한다: raw `AbortSignal`을 쓰면 호출자마다 `{ once: true }` 등록, 등록 직후 `aborted` 재검사, 해제, `signal.reason`(`any`) 문자열 비교를 각자 구현해야 한다([ADR 0023](../adr/0023-session-retire-interface.md)).

기각한 대안:

- BrowserWindow를 소유 단위로 삼음: 다음 문서가 이전 문서의 작업과 구독을 이어받는다.
- `did-start-navigation` 시점 retire: 문서가 남는 이동에서도 세션이 retire되어 브리지가 멈춘다.
- `isInPlace`(같은 문서) 이동만 제외: HTTP 204, 다운로드 취소, `will-navigate` 차단처럼 `isInPlace === false`인데 문서가 남는 case가 남는다.
- navigation 감지 제거: 브리지 없는 페이지로 이동하면 옛 세션의 RPC·구독이 창 파괴까지 돈다.
- `did-fail-load` 단독 사용: 문서가 남는 `ERR_ABORTED`에서 오탐한다.
- `AttachedTarget.admit(sender)` port: adapter마다 판정 순서가 어긋날 수 있다.
- 사유를 `sender-unauthorized` 하나로 통합: frame 불일치와 origin 불일치를 진단에서 구분하지 못한다.
- 사유를 더 세분화(`RejectReason` 확장): 기존 망라 switch를 깨는 breaking 변경이다.
- 거부 사유를 wire 응답에 실음: Renderer가 admission 로직을 탐색하는 데 쓸 수 있다.
- raw `AbortSignal` 노출 유지: 호출자별 규약 4개와 `any` 사유 비교가 남는다.
- listener가 사유를 인자로 받음: 사유를 읽는 경로가 인자와 getter 둘로 갈라진다.
- 이미 retire된 세션에서 `onRetire`가 `undefined` 반환: 호출자가 반환값으로 분기해야 한다.
- 자체 listener `Set`: `EventTarget`의 예외 격리와 등록 순서 실행을 다시 구현해야 한다.
- `server.dispose()` 때 retired 기록 삭제: 재사용 방지가 조용히 무력화된다.
- retired 기록 무제한 보관: 살아 있는 `webContents`에서 무한히 쌓인다([ADR 0009](../adr/0009-session-resource-limits.md)).

## 6. 한계

- navigation retire는 "새 문서의 첫 IPC가 commit 신호보다 늦게 온다"는 실측에 기댄다. 수명 사건은 그 시점의 현재 세션을 retire하므로, 새 문서의 요청이 먼저 세션을 열었다면 그 새 세션이 retire된다. 이 순서는 Electron 44.4.5 실측에서 관측되지 않았다.
- "현재 main frame" 판정은 `contents.mainFrame.routingId`에 의존한다. `did-navigate`나 조건부 `did-fail-load` 없이 routingId가 바뀌는 경로가 있으면 retire 없이 frame 검사만 옛 문서를 막는다([ADR 0015](../adr/0015-rpc-request-lifecycle.md)).
- retire된 문서가 뒤늦게 보낸 cancel·unsubscribe·acknowledge도 `rejected` 진단을 남긴다. main frame이 그대로면 `sender-unauthorized`, 교체 뒤면 `frame-not-main`이다. 정상 지연 도착과 오용을 사유만으로 구분할 수 없다.
- 한 문서·한 server에는 `clientId` 하나만 살아 있다. 같은 attach 아래의 두 transport가 서로 다른 `clientId`로 `establish`하면 나중 요청이 앞 세션을 `replaced`로 retire한다. 같은 `webContents`에 `attach`를 다시 부르면 그 전에 앞 attachment가 `detach`로 retire된다.
- `destroyed`는 세션과 retired 기록을 정리하지만 attachment 항목은 map에 남는다. detach·dispose 때 지워진다.
- loopback transport는 수명 사건을 내지 않는다. `dispose()`는 `detach`이므로 같은 `clientId`로 재접속하면 retired 기록 때문에 거부된다([TRP-006](../traps/TRP-006-loopback-retired-clientid-reconnect.md)).
- 실제 Electron 다중 창·reload 정리 검증은 Linux, Electron 44.4.5에서만 했다([실제 Electron 검증 결과](../verification/rd-008.md)).

## 7. 관련 문서

- ADR: [0002](../adr/0002-renderer-document-session-ownership.md), [0006](../adr/0006-shutdown-contract.md), [0009](../adr/0009-session-resource-limits.md), [0015](../adr/0015-rpc-request-lifecycle.md), [0016](../adr/0016-sender-admission.md), [0019](../adr/0019-navigation-retire-on-commit.md), [0020](../adr/0020-stream-terminal-on-retire.md), [0023](../adr/0023-session-retire-interface.md)
- 설계: [03. Transport와 연결 설정](03-transport-and-wiring.md), [05. RPC](05-rpc.md), [06. Main 스트림 전달](06-stream-delivery.md), [09. 세션 자원 한도](09-resource-limits.md), [10. 종료](10-shutdown.md), [11. 진단](11-diagnostics.md)
