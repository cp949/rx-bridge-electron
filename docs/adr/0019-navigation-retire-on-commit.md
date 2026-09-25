# navigation 세션 retire 시점을 main-frame `did-start-navigation`에서 문서 commit으로 옮긴다

- 관련: ROADMAP.md#RD-025

## 상황

Electron adapter(`electron-adapter.ts`)의 `targetFor().onLifecycle`은 main frame `did-start-navigation`마다 문서 세션을 retire했다. 이 이벤트는 navigation _시작_ 시점에 발생하며, 문서가 그대로 살아 있는 이동에서도 온다: `history.pushState`·`location.hash`(`isInPlace: true`), HTTP 204, 다운로드 취소, `will-navigate` `preventDefault()`로 차단된 이동, beforeunload로 취소된 `ERR_ABORTED`. retire된 `clientId`는 같은 문서에서 재사용할 수 없으므로(`document-sessions.ts:95`), 이런 이동을 한 번만 해도 bridge 전체가 reload 전까지 멈췄다(RPC는 `FORBIDDEN "Bridge sender is not authorized."`, subscribe는 진단만 남고 무응답).

RD-025 작업 중 실험이 Electron 44.4.5에서 15개 case(문서 교체 9건, 문서 생존 6건)를 실행해 어떤 이벤트가 "main frame이 실제로 새 문서로 commit됐다"를 신뢰성 있게 알리는지 확인했다.

### 실험 결과 요약

문서가 교체된 case(일반 cross-document 이동, `webContents.reload()`, 같은 URL `loadURL`, `history.back()`을 통한 cross-document 복귀, `location.replace`, 본문 있는 HTTP 4xx/5xx, renderer crash 뒤 reload)에서는 `did-navigate`가 정확히 1회 발생하고 `routingId`가 바뀌었다. 문서가 생존한 case(pushState, hash 변경, HTTP 204, 다운로드 취소, `will-navigate` 차단, beforeunload로 인한 `ERR_ABORTED`)에서는 `did-navigate`가 0회이고 `routingId`가 바뀌지 않았다.

예외가 하나 있었다: 연결 거부(`ERR_CONNECTION_REFUSED`) 같은 오류 페이지 commit은 `routingId`가 바뀌는데도(문서가 `chrome-error://chromewebdata/`로 실제 교체됨) `did-navigate`·`did-frame-navigate`가 전혀 발생하지 않았다. 이 case는 `did-fail-load`만 발생한다. `did-fail-load`는 문서 교체가 없는 취소(`ERR_ABORTED`, beforeunload case)에서도 발생하므로 단독으로는 오탐(문서가 안 바뀐 case에서 1회 발생)이 난다. 그러나 `did-fail-load` 콜백 실행 시점에 동기로 읽은 `contents.mainFrame.routingId`가 콜백 인자 `frameRoutingId`와 일치하는지로 실제 커밋 여부를 판별할 수 있었다 — 연결 거부 case는 둘이 일치했고(콜백 시점엔 이미 새 문서가 커밋돼 있다), beforeunload `ERR_ABORTED` case는 `frameRoutingId`가 `undefined`이거나 옛 `routingId`였다.

새 문서의 첫 IPC(preload가 `document-start`에서 즉시 전송)가 선택한 커밋 신호보다 먼저 도착한 case는 없었다(case 1·2·4·6에서 확인) — "새 문서 요청이 commit 신호보다 먼저 온다" 멈추는 지점은 발동하지 않았다.

## 결정: `did-navigate`를 주 신호로, `did-fail-load`(routingId 일치)를 보조 신호로 쓴다

`electron-adapter.ts`의 `targetFor().onLifecycle`이 main frame 문서 세션을 retire하는 신호를 다음 두 이벤트 조합으로 바꾼다(구현 커밋 `babade6`):

1. **주 신호: `contents.on("did-navigate", ...)`** — 발생하면 무조건 retire한다. `did-navigate`는 정의상 main frame 전용 이벤트라 `isMainFrame` 인자가 없고, 성공적으로 새 문서가 커밋될 때만(위 case들) 1회 발생한다.
2. **보조 신호: `contents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId, frameRoutingId) => ...)`** — `isMainFrame === true`이고, 콜백 실행 시점에 `contents.mainFrame.routingId === frameRoutingId`일 때만 retire한다. 이 routingId 비교가 없으면 문서가 안 바뀐 취소(`ERR_ABORTED`)에서도 오탐이 난다.

진단 사유 이름 `"main-frame-navigation"`은 유지한다 — 바뀐 것은 발생 _시점_(navigation 시작 → 문서 commit)이지 이름이 아니다(사용자 결정 2026-09-25).

기존 `did-start-navigation` 리스너는 제거한다. `render-process-gone`·`destroyed` 리스너는 바뀌지 않는다.

### 근거

- 문서가 교체된 모든 실험 case에서 이 조합이 정확히 1회 발생했다(6번 case만 보조 신호 경유).
- 문서가 생존한 모든 실험 case에서 0회 발생했다.
- 두 이벤트 모두 main frame 판별이 가능하다(`did-navigate`는 정의상 main-frame 전용, `did-fail-load`는 `isMainFrame` 인자로 판별).
- 새 문서의 첫 IPC보다 항상 먼저 도착한다(위 "실험 결과 요약" 참고) — 순서 문제가 없다.
- `did-navigate`는 인자가 가장 단순하다(`isMainFrame` 판별이 애초에 불필요, deprecated 인자에 기대지 않는다).

## 고려한 대안과 기각 사유

- **대안 A — 같은 문서 이동만 제외**: `did-start-navigation`의 `isInPlace`(또는 `isSameDocument`)가 `true`인 경우만 retire에서 뺀다. 기각: HTTP 204, 다운로드 취소, `will-navigate` `preventDefault()`처럼 `isInPlace === false`인데 문서가 교체되지 않는 case가 그대로 남는다 — 여전히 문서 생존 이동에서 bridge가 멈춘다.
- **대안 C — navigation 감지 자체를 없앰**: main frame navigation을 아예 retire 사유에서 제외한다. 기각: bridge가 없는 페이지로 이동하면 옛 문서 세션의 RPC·구독이 창이 파괴될 때까지 계속 돈다 — 문서 교체 자체가 감지되지 않으면 정리 시점이 없어진다.

## 보존

- admission(`DocumentSessions`의 private `#admit`)의 `isCurrentMainFrame`(`contents.mainFrame.routingId === sender.frameId`) 판정 로직 자체는 바뀌지 않는다. 이 ADR은 retire *신호*만 바꾼다.
- 새 `clientId`로 인한 retire 경로(`document-sessions.ts`의 `establish`)는 바뀌지 않는다.
- `render-process-gone`·`destroyed` retire 경로는 바뀌지 않는다.
- 와이어 프로토콜, 오류 코드, 진단 이벤트 종류는 바뀌지 않는다.

## 동작

**수용한 변화**: navigation이 *시작*된 뒤 실제로 *commit*되기까지는 옛 문서가 아직 살아 있으므로, 그 사이 도착한 옛 문서발 RPC·구독 요청은 계속 정상 처리된다. 이전에는 이동이 시작되는 즉시 세션이 retire돼 이런 요청이 거부됐다. 이는 버그가 아니라 의도한 동작이다 — 문서가 바뀌지 않았으면 세션이 계속 유효해야 맞다.

## 관련 ADR

- [ADR 0015](0015-rpc-request-lifecycle.md) — "근거 가설"과 "틀렸을 때의 대가" 절이 `did-start-navigation` 기준으로 세션 현재성과 `session.signal` abort의 동치를 서술했다. 이 ADR이 선택한 조합 신호로 그 가설 문구를 개정한다(해당 절에 인라인 개정 표시를 남겼다). 새 가설 문구: "main frame `routingId`는 `did-navigate` 또는 (`did-fail-load`이면서 그 시점의 `contents.mainFrame.routingId`가 이벤트의 `frameRoutingId`와 일치하는 경우) 없이는 바뀌지 않는다."
- [ADR 0016](0016-sender-admission.md) — sender admission 판정(`#admit`, `isCurrentMainFrame`)의 현재 구조. 이 ADR은 그 판정 로직을 바꾸지 않는다.
