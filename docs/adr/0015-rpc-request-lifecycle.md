# RPC 요청 수명주기를 `RpcRequests` 모듈 하나로 모으고 `authorize` 뒤 `current()` 재검사를 제거한다

- 관련: ROADMAP.md#RD-016

> [ADR 0016](0016-sender-admission.md)이 sender admission 판정을 옮겼다. 아래 "결정: `RpcRequests` 모듈" 절의 "`create-bridge-server.ts`의 `dispatchRpc`는 protocolVersion 검사·`sessions.establish`·`sender-unauthorized` 판정과 `rpcRequests.dispatch(session, sender, envelope)` 위임만 남는다"(:15) 서술은 이제 정확하지 않다 — protocolVersion 검사는 `dispatchRpc` 앞이 아니라 envelope parse(`parseWireRpcRequest`) 안에서 판정되고, `sessions.establish`의 거부는 `sender-unauthorized` 하나가 아니라 `frame-not-main`·`origin-not-allowed`·`sender-unauthorized` 중 하나(`Admission` verdict)다. `RpcRequests`가 세션 해석 방법을 몰라도 된다는 이 문서의 핵심 결정(§"`authorize` 뒤 `current()` 재검사를 제거") 자체는 바뀌지 않았다.

## 상황

RPC 요청 1건의 상태(slot 점유, 취소용 `AbortController`, retire 연동)는 `DocumentSessions`가 `tryAcquireRpc`·`beginRpc`·`finishRpc`·`releaseRpc`·`cancelRpc`·`rpcInFlightCount` 6개 메서드와 `SessionState`의 `active`·`runningRpc`, 전역 `#globalRunningRpc`로 나눠 들고 있었다. `create-bridge-server.ts`의 `dispatchRpc`가 이 메서드들과 `rpc-dispatcher.ts`의 `findRpc`·`dispatchRegistered`를 순서대로 손으로 이어 붙였다(등록 조회 → slot → `authorize` → `aborted || current() !== session` 재검사 → deny → `dispatchRegistered` → finally에서 slot 반환·`rpc-finished`). `#retire`도 별도로 `active` Map을 순회하며 진행 중 RPC를 취소하는 루프를 가지고 있었다.

"요청이 취소됐으면 다른 분류보다 `CANCELLED`가 우선한다"(ADR 0011) 규칙은 `rpc-dispatcher.ts`의 `dispatchRegistered` 안 5개 지점(`authorize` 뒤, `parseBridgeValue` 실패, input schema 실패, handler 뒤, output schema 실패)과 `create-bridge-server.ts`의 `authorize` 뒤 재검사 지점에서 각자 따로 판정했다. 이 재검사(`current() !== session`)는 세션이 `authorize` 대기 중에 더 이상 현재가 아니게 됐는지를 `dispatchRpc`가 `DocumentSessions.current()`를 다시 호출해 확인하는 것으로, `RpcRequests`가 세션 해석 방법을 알아야만 할 수 있는 검사였다.

이 상태와 순서 연결은 [ADR 0014](0014-stream-lookup-before-authorize.md)가 구독(stream) 쪽에 적용한 것과 같은 모양의 문제였다(ROADMAP RD-015). RD-015 완료 시점에 ADR 0014는 "`DocumentSessions`는 이제 구독 개념을 모른다: RPC 수명주기만 남는다"고 적었고(범위 밖으로 명시), 이 ADR이 그 후속(RD-016)이다.

## 결정: `RpcRequests` 모듈 하나가 RPC 요청 수명주기 전체를 소유한다

`src/main/rpc-dispatcher.ts`를 `src/main/rpc-requests.ts`로 옮기고 `RpcRequests` 클래스가 등록 조회(`#lookupRegistration`)·slot(`#tryAcquire`/`#release`)·요청 등록과 취소(`#begin`/`#finish`/`#cancelActive`)·`authorize`·validation pipeline(`#runRegistered`)·deadline·진단 기록·slot 반환까지 전부 소유한다. _(개정: RD-041 — slot(`#tryAcquire`/`#release`)과 전역 in-flight 카운터(`#inFlight`, 아래 문단)는 내부 module `SessionSlots` lease로 옮겨졌다. `RpcRequests`는 여전히 slot을 소유하지만 판정·반납·집계는 `SessionSlots`에 위임한다.)_ `create-bridge-server.ts`의 `dispatchRpc`는 protocolVersion 검사·`sessions.establish`·`sender-unauthorized` 판정과 `rpcRequests.dispatch(session, sender, envelope)` 위임만 남는다(131줄 → 30줄). `cancel`도 `sessions.current()` → `rpcRequests.cancel(session, requestId)` 위임만 한다.

세션별 상태는 `WeakMap<DocumentSession, SessionState>`(`{ running: number, active: Map<requestId, ActiveRequest> }`)이다. `requestId`는 세션 스코프 안에서만 유일하면 되므로 이전의 전역 `keyOf(sender, clientId, requestId)` 합성 key를 없앴다 — `DocumentSession`이 이미 `webContentsId`·`clientId` 단위로 유일하고, 세션 수명 동안 main frame이 바뀌지 않는다(근거는 [ADR 0014](0014-stream-lookup-before-authorize.md)의 `subscriptionId` 식별과 같다: 모든 요청은 `establish`/`current`가 `isCurrentMainFrame`(`routingId === frameId`)·origin·clientId를 확인해야 세션을 얻고, main frame 재탐색은 그 세션을 retire한다). 전역 in-flight 카운터(`#inFlight`)는 세션 상태 순회가 아니라 slot 획득·반환 시점에 직접 증감한다 — retire된 세션의 미종료 handler도 계속 세어야 하기 때문이다(ADR 0010 §10 보존). _(개정: RD-041 — 이 카운터는 `SessionSlots.count()`로 옮겨졌다. 증감 시점과 의미는 그대로다.)_

retire는 요청 등록 시 `session.signal`에 `{ once: true }` abort listener를 달아 스스로를 취소하는 방식으로 받는다([RD-015](0014-stream-lookup-before-authorize.md)의 `Subscriptions`와 같은 패턴). _(개정: [ADR 0023](0023-session-retire-interface.md) — 호출자는 `onRetire`로 구독한다. abort 메커니즘은 implementation으로 유지한다.)_ `DocumentSessions.#retire`가 갖고 있던 "진행 중 RPC를 순회하며 취소하는 루프"는 삭제했다. `DocumentSessions`는 이제 RPC 개념을 전혀 모른다(`RpcRequests`는 `DocumentSession` 타입만 import한다) — `attach`·`establish`·`current`·`retire`·retired-client 기록만 남는다.

## 결정: `CANCELLED` 우선 규칙을 guard 함수 하나로 정의하고 단계 경계 5곳에 적용한다

`cancelledIfAborted(signal, envelope): RpcResponse | undefined`를 `rpc-requests.ts` 최상단의 module-level 순수 함수로 둔다(클래스 상태를 참조하지 않는다). `signal.aborted`가 아니면 `undefined`를 돌려줘 호출부가 원래 분기(성공 처리, 다른 오류 분류, 진단 기록)를 잇는다. `"Request cancelled."` 응답 문자열은 이 함수 1곳에서만 만든다.

적용 지점은 5곳이다: `authorize` 뒤(throw·정상 반환 모두), `parseBridgeValue` 실패, input schema 실패, handler 뒤(throw·정상 반환 모두), output schema 실패. **삭제한 분기는 없다.** 각 지점의 진단 기록 대비 순서는 그대로 보존한다 — `parseBridgeValue`·input schema 실패는 guard가 먼저이므로 aborted면 진단을 기록하지 않은 채 반환하고, output schema 실패는 `validation-failed`를 먼저 기록한 뒤 guard를 본다. `authorize` 뒤는 guard가 `authorize-denied` 진단보다 먼저 판정한다.

이 결정은 계획 단계의 가정을 보정한 결과다. 그릴링 초안과 `ROADMAP.md` RD-016은 `rpc-dispatcher.ts`의 세 지점(`parseBridgeValue`·input schema·output schema 실패)을 "직전 aborted 검사와 동기 parse 사이에 `await`가 없으므로 도달 불가"로 보고 삭제 대상으로 적었다. 이는 틀렸다: `await`가 없어도 동기 단계 안에서 사용자 코드(스키마의 `parse`)가 실행되면 그 코드가 `signal`을 abort시키는 콜백(예: 동기 `server.cancel` 호출)을 가질 수 있다.

- output schema 실패 지점은 `rpc-requests.test.ts`의 "prefers CANCELLED when the request is aborted before the output schema throws"가 output schema의 `parse` 안에서 `server.cancel`을 동기 호출해 이 분기를 실제로 실행하고 고정한다.
- input schema `parse`도 사용자 코드라 같은 방식으로 도달한다.
- `parseBridgeValue` 실패 지점은 `Reflect.ownKeys`·`Object.getOwnPropertyDescriptor`가 Proxy trap을 실행하므로, in-process 호출자(`server.dispatchRpc` 직접 호출)에서 Proxy 입력을 넘기면 도달한다. IPC 경유 입력(structured clone)에는 Proxy가 올 수 없어 이 경로 자체는 아니지만, "도달 불가"를 근거로 분기를 지우는 것은 in-process 호출자를 배제하는 잘못된 전제였다.

따라서 규칙 정의는 1곳(guard 함수)으로 통합하되, 적용 지점 5곳은 모두 유지한다. `ROADMAP.md` RD-016의 해당 서술은 이 작업 중 정정했다.

## 결정: `authorize` 뒤 `current()` 재검사를 제거하고 요청 signal 판정만 본다

`dispatch`에서 `authorize` 뒤 `aborted || current() !== session`으로 세션을 다시 해석해 확인하던 재검사를 없애고, 요청 signal(`controller.signal`, retire listener가 abort한다)만 guard로 본다. 그래서 `RpcRequests`는 세션 해석 방법(`DocumentSessions`)을 몰라도 된다.

### 근거 가설

세션이 현재가 아니게 되는 모든 경로(main-frame navigation, render-process-gone, destroyed, detach, dispose, 같은 `webContents`의 새 `clientId`)는 예외 없이 `DocumentSessions.#retire`를 거치고, `#retire`는 그 세션의 `session.signal`을 abort한다. _(개정: [ADR 0023](0023-session-retire-interface.md) — 호출자는 `onRetire`로 구독한다. abort 메커니즘은 implementation으로 유지한다.)_ Electron에서 main frame `routingId`가 `did-start-navigation` 없이 바뀌는 경로는 없다. _(개정: [ADR 0019](0019-navigation-retire-on-commit.md) — 이 문장은 더 이상 정확하지 않다. `routingId`는 `did-start-navigation` 없이도 바뀐다(예: 오류 페이지 commit은 `did-start-navigation` 뒤 `did-fail-load`만 오고 `did-navigate`가 없다). RD-025 실험(DELTA-02) 이후 새 가설 문구: "main frame `routingId`는 `did-navigate` 또는 (`did-fail-load`이면서 그 시점의 `contents.mainFrame.routingId`가 이벤트의 `frameRoutingId`와 일치하는 경우) 없이는 바뀌지 않는다." 이 문서 시점(RD-016)의 서술은 당시 retire 신호(`did-start-navigation`) 기준이었다는 점은 그대로 남긴다.)_ 이 가설이 성립하면 "세션이 더 이상 현재가 아니다"와 "이 요청의 signal이 abort됐다"는 항상 같은 사실을 가리키므로, signal 판정 하나로 재검사를 대체해도 관측 가능한 동작은 바뀌지 않는다.

이 가설은 새로 만든 것이 아니다. [ADR 0014](0014-stream-lookup-before-authorize.md)의 `Subscriptions`(`#finishPending`)가 구독 쪽에서 이미 같은 가설에 기대고 있고, 이 ADR의 "`RpcRequests` 모듈" 결정이 RPC의 retire 전달 경로를 구독과 동일한 `session.signal` abort listener 패턴으로 맞췄기 때문에 두 경로가 같은 가설을 공유하게 됐다.

### 틀렸을 때의 대가

가설이 실제로 깨지는 Electron 경로가 있다면(예: `did-start-navigation` 없이 라우팅이 바뀌는 미확인 엣지 케이스), `authorize`가 오래 걸리는 요청이 이미 retire된 옛 세션을 향해 `FORBIDDEN`이나 성공 응답을 잘못 돌려줄 수 있다. 이 가설을 직접 검증하는 자동 test는 없다. 단위 test의 `FakeTarget.isCurrentMainFrame`은 `frameId`를 비교하지 않아 frame 교체를 관측하지 못하고(`.scratch/sender-admission-unification/issues/01-fake-target-frame-id.md`), Electron acceptance(multi-window reload·창 닫기)는 retire 경로만 거치며 `authorize` 대기 중 navigation 시나리오를 갖지 않는다. 가설이 깨졌다는 의심이 들면 Electron acceptance에 navigation 중 `authorize`가 지연되는 시나리오를 추가해 재현을 시도한다. _(개정: [ADR 0019](0019-navigation-retire-on-commit.md) — RD-025가 이 문단이 예로 든 "`did-start-navigation` 없이 라우팅이 바뀌는 엣지 케이스"를 실제로 실행 실험(DELTA-02, Electron 44.4.5)으로 찾아냈다: 오류 페이지 commit(`ERR_CONNECTION_REFUSED`)이 `did-navigate` 없이 `did-fail-load`만 내며 `routingId`를 바꾼다. retire 신호를 `did-navigate` + `did-fail-load`(routingId 일치) 조합으로 바꿔 이 case를 포함하도록 고쳤다 — "틀렸을 때의 대가"가 우려한 시나리오가 실제로 존재했고, 대응은 이 ADR이 기록한다.)_

_(개정: RD-049 — "`FakeTarget.isCurrentMainFrame`은 `frameId`를 비교하지 않는다"는 RD-018 이후 맞지 않다. `FakeTarget`(`test/main/fake-ipc.ts`)은 현재 main frame id를 들고 `frameId`까지 비교한다. 단위 test가 frame 교체 뒤 거부를 관측할 수 있다.)_

## 동작

**불변**: 와이어 프로토콜, 오류 코드, 진단 이벤트 종류·개수·판정 순서, ADR 0009 §10(handler 실제 종료 시 slot 반환), ADR 0011의 `authorize` 예외 → `INTERNAL` 분류, `CANCELLED` 우선 순위. 중복 `requestId`가 앞선 요청을 취소하는 기존 동작도 유지한다(`rpc-requests.test.ts` "Duplicate requestId handling"이 고정한다).

**수용한 변화**: retire 시 `rpc-cancelled` 진단과 구독 종료 진단이 도착 순서대로 섞인다. 이전에는 `DocumentSessions.#retire`가 RPC 취소 루프를 먼저 실행한 뒤 pending stream을 취소해 순서가 고정돼 있었다(ADR 0014 "수용한 동작 변화"가 이미 구독-대-구독 순서 변화를 기록했다). 이번 변화는 그 연장으로, RPC와 구독 모두 각자의 `session.signal` abort listener 등록 순서(= 요청/구독 도착 순서)로 실행되므로 둘 사이의 상대 순서가 실행 시점의 등록 순서에 좌우된다. `rpc-cancelled`는 요청당 정확히 1회를 보존하고, 어느 쪽 순서에도 의존하는 계약은 없다.

## 고려한 대안과 기각 사유

- **도달 불가로 보이는 분기 삭제**: 계획 초안이 검토했던 안. `parseBridgeValue`·input/output schema 실패 지점의 `CANCELLED` 분기를 "동기 코드 사이엔 `await`가 없어 도달 못 한다"는 근거로 지우려 했다. 위 "`CANCELLED` 우선 규칙" 결정에서 확인했듯 사용자 코드(스키마 `parse`, Proxy trap)가 동기 abort를 유발할 수 있어 전제가 틀렸다. `rpc-requests.test.ts`의 output schema 동기 cancel test가 이 분기를 실제로 실행하므로 삭제하면 test가 깨진다. 기각.
- **`DocumentSessions`가 retire 시 RPC 모듈을 직접 호출**: `#retire`가 `RpcRequests`의 취소 메서드를 직접 부르는 콜백을 유지하는 안. 취소 순서를 세션 쪽에서 계속 통제할 수 있지만 `DocumentSessions` → `RpcRequests` 의존이 새로 생겨 "DocumentSessions는 RPC를 모른다"는 이번 결정의 목표(ADR 0014가 구독에서 이미 달성한 것과 같은 분리)와 정면으로 어긋난다. 기각.
- **세션당 listener 1개(요청마다 등록하지 않고 세션 attach 시 1회 등록)**: abort 시 세션의 `active` Map을 순회해 일괄 취소하는 안. listener 수는 줄지만 취소 순서가 "첫 요청이 언제 등록됐는가"가 아니라 "세션이 언제 attach됐는가"에 좌우되게 되어, `rpc-cancelled` 개수·발생 자체는 같아도 진단 도착 순서를 더 예측하기 어렵게 만든다. 요청별 listener(등록 순서 = 실행 순서, `EventTarget`이 추가된 순서로 리스너를 호출한다)가 기존 `for (const id of state.active.keys())` 순회 순서(Map 삽입 순서)와 동등해 관측 결과가 그대로 재현된다. 기각.

## 범위 밖

- ROADMAP RD-016 후보 03(wire key 문법 — `startsWith("rpc:")`·`slice(4)`를 protocol 모듈로 옮기는 것. 이 ADR은 조회 위치만 `RpcRequests` 안으로 옮겼을 뿐 문법 자체는 손대지 않았다)과 후보 04(server version 분기 — 운영 경로 도달 불가, `recordAdapterRejection` Symbol, `FakeTarget` frameId).
- deadline 만료 뒤 Renderer `cancel`이 `rpc-cancelled`를 추가로 기록하는 기존 동작(이중 계산 가능성). 이 작업이 characterization test로 고정만 했다 — 후속 이슈(`.scratch/rpc-deadline-cancel-diagnostic/issues/01-deadline-cancel-diagnostic.md`)에서 "먼저 확정된 원인 하나만 기록"으로 해결했다([ADR 0010](0010-operational-diagnostics.md) §8).
- wire 형식·채널·handshake·공개 export 변경. `RpcRequests`는 `src/main/index.ts`의 공개 export가 아니다 — `Subscriptions`와 같은 내부 구현이다.

## 관련 ADR

- [ADR 0009](0009-session-resource-limits.md) — 세션별 RPC 슬롯 한도와 §10 slot 반환 시점(이 ADR이 그대로 보존한다).
- [ADR 0010](0010-operational-diagnostics.md) — 진단 이벤트·스냅샷 계약(§7·§10에 이 ADR로의 개정 표시를 남겼다).
- [ADR 0011](0011-authorize-exception-internal.md) — `CANCELLED` 우선순위와 `authorize` 예외의 `INTERNAL` 분류(이 ADR이 구현을 옮긴 규칙의 원본 결정).
- [ADR 0014](0014-stream-lookup-before-authorize.md) — 같은 모양의 문제를 구독 쪽에서 먼저 해결한 선례이자, `current()` 재검사 제거 가설을 공유하는 문서.
