# 구독 등록 조회를 `authorize` 앞으로 옮기고, 구독 수명주기를 `Subscriptions` 모듈 하나로 모은다

- 관련: ROADMAP.md#RD-015

> [ADR 0015](0015-rpc-request-lifecycle.md)가 RPC 쪽에 같은 이동을 적용했다. 아래 "결정: 구독 수명주기 전체를 `Subscriptions` 모듈 하나가 소유한다"의 "`DocumentSessions`는 이제 구독 개념을 모른다: RPC 수명주기(`tryAcquireRpc`·`beginRpc`·`finishRpc`·`releaseRpc`·`cancelRpc`)만 남는다" 서술은 더 이상 맞지 않다 — 그 RPC 수명주기 메서드들도 `RpcRequests` 모듈로 옮겨져 `DocumentSessions`에서 전부 제거됐다(`DocumentSessions`는 이제 RPC도 모른다). 아래 "수용한 동작 변화"의 "`#retire`의 RPC 취소 루프보다 먼저 실행된다" 서술도 이력이다 — 그 루프 자체가 삭제되고 RPC retire도 구독과 같은 `session.signal` abort listener 패턴으로 바뀌었다(순서 변화의 성격은 ADR 0015가 이어서 기록한다). 이 문서의 다른 결정은 그대로 유효하다.

## 상황

미등록 stream key로 구독을 요청하면 `authorize`까지 도달했다. `authorize`가 deny하면 `FORBIDDEN`으로 끝나 RPC(미등록 key는 `authorize` 호출 여부와 무관하게 항상 `NOT_FOUND`)와 다르게 동작했다. `authorize`가 allow하면 그제서야 `StreamHub.subscribe`가 등록을 조회해 `NOT_FOUND`로 끝났다 — 같은 미등록 key가 `authorize` 결과에 따라 다른 오류 코드로 끝났다는 뜻이다. 구독 1건의 상태도 두 곳(`DocumentSessions`의 watermark·slot, `StreamHub`의 consumer)에 나뉘어 있어 `create-bridge-server.ts`의 `controlStream`이 `beginStream → authorize → finishStream → current → subscribe → onClose → releaseStream` 호출 순서를 손으로 배선했다.

## 결정: stream 처리 순서를 ID 형식 → watermark → 등록 조회 → slot → `authorize`로 바꾼다

미등록 key는 `authorize` 호출 여부와 무관하게 항상 `NOT_FOUND`로 끝난다(RPC와 동일한 취급). `authorize`는 등록된 key만 받는다.

근거: manifest는 모든 Renderer에 동일하게 공개되므로 key 존재는 비밀이 아니다 — 등록 조회를 `authorize` 앞으로 옮겨도 `authorize`가 판단할 새로운 정보를 노출하지 않는다. RPC가 이미 이 순서(등록 조회 → `authorize`)이므로 stream도 맞춰 같은 입력 조건에 같은 오류 코드를 낸다.

## 결정: `subscription-limit` 진단에 `key`를 포함한다

등록 조회가 slot 획득보다 먼저 판정되므로, slot 한도 초과 시점엔 이미 key가 등록돼 있다는 것을 안다. [ADR 0010](0010-operational-diagnostics.md) §6의 "등록 조회를 통과한 경우만 `key`를 넣는다" 규칙은 그대로다 — 판정 순서가 바뀌면서 그 규칙이 적용되는 대상이 늘었을 뿐이다.

## 결정: 구독 수명주기 전체를 `Subscriptions` 모듈 하나가 소유한다

`StreamHub`를 `Subscriptions`로 바꿔 subscriptionId 파싱·watermark·등록 조회·slot·`authorize` 대기와 호출·reject·consumer·교차 세션 fan-out·terminal·slot 반환을 모두 소유하게 한다. 세션별 상태는 모듈 안 `WeakMap<DocumentSession, …>`에 두고, retire는 `session.signal` abort 이벤트 하나로 받는다 — `DocumentSessions`가 대기·활성 목록을 따로 순회해 취소하지 않는다. `DocumentSessions`는 이제 구독 개념을 모른다: RPC 수명주기(`tryAcquireRpc`·`beginRpc`·`finishRpc`·`releaseRpc`·`cancelRpc`)만 남는다. `create-bridge-server.ts`의 `controlStream`은 protocolVersion 검사·세션 해석(`establish`/`current`)·`sender-unauthorized` 판정·위임만 한다. _(개정: [ADR 0015](0015-rpc-request-lifecycle.md) — 이 RPC 수명주기 메서드들도 이후 `RpcRequests` 모듈로 옮겨져 `DocumentSessions`에서 전부 제거됐다. "만 남는다"는 이 결정 시점(RD-015)의 서술이다.)_

## 결정: 세션 안에서는 `subscriptionId`만으로 구독을 식별한다

이전에는 `JSON.stringify([webContentsId, frameId, clientId, subscriptionId])` 합성 키로 전역 Map을 썼다. 모든 stream 요청은 이미 `DocumentSessions.establish`/`current`가 `isCurrentMainFrame`(`routingId === frameId`)·origin·clientId를 확인해야 세션을 얻고, main frame 재탐색(`did-start-navigation`)은 그 세션을 retire한다. 따라서 같은 세션 안에서는 `subscriptionId`만 유일하면 충분하다 — 다른 세션(재사용된 clientId, 새 문서 등)은 애초에 다른 `DocumentSession` 객체라 별도 상태를 갖는다. 세션별 watermark가 같은 세션 안 재사용(늦은 도착·재전송)을 막는다.

## 수용한 동작 변화

retire 시 대기 중인 stream `authorize`의 `AbortSignal`이 이제 RPC `AbortSignal`보다 먼저 abort된다. 이전엔 `DocumentSessions.#retire`가 RPC를 먼저 취소(`rpc-cancelled` 기록)하고 그다음 pending stream을 취소했다. 이제 pending stream은 `session.signal` abort listener로 취소되고, 이 abort가 `#retire`의 RPC 취소 루프보다 먼저 실행된다. 둘 다 같은 동기 호출 안에서 끝나지만, 두 signal의 abort listener 실행 순서와 `rpc-cancelled` 진단 대비 stream 취소 시점은 바뀐다. 어느 쪽 순서에도 의존하는 계약은 없다. _(개정: [ADR 0015](0015-rpc-request-lifecycle.md) — `#retire`의 RPC 취소 루프 자체가 삭제되고 RPC retire도 이 문단이 설명하는 것과 같은 `session.signal` abort listener 패턴으로 바뀌었다. RPC-구독 두 진단의 상대 순서가 등록 순서에 좌우된다는 성격은 그대로다.)_

## 보존

wire 메시지 순서, [ADR 0009](0009-session-resource-limits.md) §11의 slot 반환 시점(대기+활성 합산, unsubscribe·거부·retire는 즉시 반환, 완료·오류·overflow는 대기 값을 ack 순서대로 드레인한 뒤 반환), [ADR 0010](0010-operational-diagnostics.md)의 진단 이벤트 종류와 순서(§6의 `key` 규칙 적용 범위가 넓어진 것 제외), `getDiagnosticsSnapshot().subscriptions` 값(대기+활성, 모든 세션 합). [ADR 0011](0011-authorize-exception-internal.md)의 `authorize` 예외 → `INTERNAL` 처리도 그대로다 — 등록 조회가 앞으로 옮겨왔을 뿐 `authorize`가 실제로 호출되는 지점(등록된 key에 한해) 이후의 예외 처리는 바뀌지 않았다.

## 범위 밖

RPC 수명주기(`tryAcquireRpc`·`beginRpc`·`finishRpc`·`releaseRpc`·`cancelRpc`, RPC `keyOf`) — 후속 ROADMAP.md#RD-016(완료, [ADR 0015](0015-rpc-request-lifecycle.md)). sender admission 통합, `recordAdapterRejection` Symbol, version-mismatch 도달 불가 분기 — 후속 ROADMAP.md#RD-018(완료, [ADR 0016](0016-sender-admission.md)). 와이어 형식·채널·handshake·공개 export 변경(`Subscriptions`는 공개 export가 아니다 — `StreamHub`와 마찬가지로 내부 구현이다).

## 이전(migration)

미등록 stream key에 `authorize` deny 시 `FORBIDDEN`을 기대하던 소비자는 이제 `authorize` 호출 여부와 무관하게 `NOT_FOUND`를 받는다. `authorize` 콜백은 미등록 key를 더 이상 받지 않는다 — 모든 key를 무조건 허용하던 구현이라도 동작에 영향은 없다(미등록 key는 등록 조회에서 먼저 걸러진다). 와이어 형식과 오류 코드 집합은 바뀌지 않는다. README "호환성 변경" 절에 이 이전을 적는다.
