# sender admission 판정을 `DocumentSessions`의 `#admit` 하나로 모으고 envelope parse를 server가 소유한다

- 관련: ROADMAP.md#RD-018

> **개정 (RD-019, `ROADMAP.md#RD-019`)**: 결정 2가 정의한 envelope parse 한도(`maxDepth`·`maxEntries`·`maxStringBytes` = `Number.MAX_SAFE_INTEGER`, `maxTotalBytes` 없음)는 이제 `src/protocol/messages.ts`의 모듈 내부 상수 `ENVELOPE_LIMITS` 하나이고, 이 상수를 쓰던 호출자 5곳(옛 preload·`rpc-client.ts`·`stream-multiplexer.ts`·`create-renderer-api.ts`의 각자 상수, `create-bridge-server.ts`의 `envelopeLimits`)이 이 하나를 공유한다 — 값 자체는 바뀌지 않았다. `:54`가 `protocol-error.ts`를 별도 파일에 둔 근거로 든 "preload가 `ELECTRON_BRIDGE_CHANNELS` 때문에 `electron-adapter.ts`를 번들한다"는 전제는 RD-019가 채널 상수 정의를 `src/protocol/electron-channels.ts`로 옮기며 사라졌다 — `:54`에 개정 표시를 남겼다(파일 분리 자체는 유지). `:79`가 범위 밖으로 미룬 "채널 상수·envelope builder·opaque ID를 protocol 모듈로 옮기는 것"은 RD-019가 처리했다. 이 문서의 판정 순서·사유 매핑·wire 응답 모양 결정은 그대로 유효하다.

## 상황

요청을 보낸 frame·origin·clientId가 현재 렌더러 문서 세션에 속하는지 판정하는 로직("sender admission")이 세 군데 흩어져 있었다. `DocumentSessions.establish`와 `current`가 같은 4조건(attachment 존재, `isMainFrame`, `isCurrentMainFrame`, `isAllowedOrigin`)을 각자 따로 검사했고, Electron 어댑터의 handshake 핸들러(`electron-adapter.ts`)가 `identity.isMainFrame`과 `options.allowedOrigins.includes`로 세 번째 검사를 더 했다(origin 목록은 `targetFor`가 만드는 `isAllowedOrigin`과 같은 소스지만 handshake만 직접 다시 읽었다).

같은 실패 사실이 채널마다 다른 사유가 됐다: subframe이 보낸 handshake는 `frame-not-main`이었지만 RPC·subscribe·unsubscribe/acknowledge로 보내면 `sender-unauthorized`였다. `sender-unauthorized` 하나가 frame 불일치·origin 불일치·미attach·retired clientId·disposed·establish 경합을 모두 가리키게 되어, 진단을 보는 쪽이 사유만으로 원인을 좁힐 수 없었다. cancel 채널은 거부를 아예 기록하지 않았다(`create-bridge-server.ts:212` 옛 코드).

숫자 `protocolVersion` 불일치는 adapter의 `parseHandshakeRequest`·`parseWireRpcRequest`·`parseWireCancelRequest`·`parseWireStreamCommand`가 `BridgeProtocolError("VERSION_MISMATCH")`로 던지고 adapter가 그 예외를 잡아 `malformed-envelope` + `INVALID_ARGUMENT`로 뭉뚱그렸다. server 안에 있던 `protocolVersion !== 1` 분기(`create-bridge-server.ts:191,222` 옛 코드)는 그래서 운영 경로에서 절대 실행되지 않고 `protocolVersion: 2 as 1` 타입 캐스트를 쓴 test에서만 실행됐다 — ADR 0010이 정의한 `version-mismatch` 사유가 실제로는 한 번도 기록되지 않았다.

adapter가 판정한 `frame-not-main`·`origin-not-allowed`를 같은 진단 sink에 보내려고 `src/main/diagnostics.ts`에 모듈 내부 Symbol `recordAdapterRejection`을 두고 `StreamBridgeServer`에 그 Symbol 키의 선택적 메서드를 붙이는 통로(ADR 0010 §14)가 생겼다. 판정을 server 하나로 모으면 adapter가 sink에 닿을 일 자체가 없어져 이 통로가 필요 없어진다.

test 하니스의 `FakeTarget.isCurrentMainFrame`(`test/main/fake-ipc.ts`)이 `webContentsId`·`isMainFrame`만 보고 frameId를 무시해, server seam test가 frame 교체 뒤 거부를 관측할 수 없었다(`.scratch/sender-admission-unification/issues/01-fake-target-frame-id.md`). 실제 adapter(`electron-adapter.ts`)는 `contents.mainFrame.routingId === sender.frameId`까지 비교한다.

## 결정 1: `DocumentSessions`의 private `#admit(sender)` 하나가 모든 채널의 sender admission을 판정한다

`establish`(handshake·RPC·subscribe)와 `current`(cancel·unsubscribe·acknowledge·비-subscribe control)가 공유하는 `#admit`을 두고, 다음 순서로 판정한다:

1. `#disposed` → `sender-unauthorized`
2. `webContentsId`에 해당하는 attachment 없음(미attach) → `sender-unauthorized`
3. `!sender.isMainFrame || !attachment.target.isCurrentMainFrame(sender)`(subframe이거나 현재 main frame이 아님) → `frame-not-main`
4. `!attachment.target.isAllowedOrigin(sender.origin)` → `origin-not-allowed`

`establish`는 `#admit`이 attachment를 돌려주면 이어서 client 판정을 한다: 현재 세션과 `clientId`가 같으면 그 세션 재사용, retired clientId면 `sender-unauthorized`, retire 뒤 다른 요청과 경합해 attachment가 바뀌었거나 이미 current가 채워졌으면 `sender-unauthorized`. `current`는 `#admit` 통과 뒤 현재 세션의 `clientId` 불일치나 `signal.aborted`를 `sender-unauthorized`로 판정한다.

두 메서드 모두 `Admission = { readonly session: DocumentSession } | { readonly reason: SenderRejectReason }`(`SenderRejectReason = Extract<RejectReason, "frame-not-main" | "origin-not-allowed" | "sender-unauthorized">`)를 반환한다. 이 타입은 `document-sessions.ts`에서 export하지만 `src/main/index.ts`의 공개 export가 아니다(패키지 내부 전용).

### 사유 매핑 표

| 조건                                                                                      | `RejectReason`        | RPC wire 응답                                      | handshake wire 응답                                  | cancel/control 응답 |
| ----------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------- | ---------------------------------------------------- | ------------------- |
| envelope parse 실패(version 아님)                                                         | `malformed-envelope`  | `INVALID_ARGUMENT "Invalid bridge request."`       | `INVALID_ARGUMENT "Invalid bridge request."`         | 없음(무시)          |
| envelope parse 실패(protocolVersion 불일치)                                               | `version-mismatch`    | `VERSION_MISMATCH "Unsupported protocol version."` | `INVALID_ARGUMENT "Invalid bridge request."`(결정 3) | 없음(무시)          |
| disposed / 미attach / retired clientId / establish 경합 / current clientId 불일치·aborted | `sender-unauthorized` | `FORBIDDEN "Bridge sender is not authorized."`     | `INVALID_ARGUMENT "Invalid bridge request."`         | 없음(무시)          |
| subframe 또는 현재 main frame 아님                                                        | `frame-not-main`      | `FORBIDDEN "Bridge sender is not authorized."`     | `INVALID_ARGUMENT "Invalid bridge request."`         | 없음(무시)          |
| 허용 목록 밖 origin                                                                       | `origin-not-allowed`  | `FORBIDDEN "Bridge sender is not authorized."`     | `INVALID_ARGUMENT "Invalid bridge request."`         | 없음(무시)          |

_(개정: ADR 0020 — 위 표의 "cancel/control 응답" 열은 cancel·unsubscribe/acknowledge에만 유효하다. subscribe는 더 이상 "없음(무시)"이 아니다: `sender-unauthorized`·`frame-not-main`·`origin-not-allowed`로 거부되면 `subscribed` 뒤 `error FORBIDDEN "Bridge sender is not authorized."`를 보낸다(RPC와 같은 코드·문구). `malformed-envelope`·`version-mismatch` subscribe는 여전히 응답하지 않는다 — `subscriptionId`를 신뢰할 수 없다.)_

판정 순서는 parse(version 포함) → admission이다(결정 2). `AttachedTarget`의 `isCurrentMainFrame`·`isAllowedOrigin` port는 그대로 두고, 실제 값은 여전히 adapter의 `targetFor`(`electron-adapter.ts`)가 `attach` 시점에 채운다 — 판정 호출 위치만 `#admit` 하나로 모았다.

## 결정 2: envelope parse(version 포함)를 server로 옮기고 adapter는 번역만 한다

`StreamBridgeServer`의 `handshake`·`controlStream`, 부모 `BridgeServer`의 `dispatchRpc`·`cancel`이 모두 `unknown` 값을 받는다. 각 메서드는 채널에 맞는 `parseHandshakeRequest`·`parseWireRpcRequest`·`parseWireCancelRequest`·`parseWireStreamCommand`를 가장 먼저 호출한다. 한도는 옛 adapter가 쓰던 값(`maxDepth`·`maxEntries`·`maxStringBytes` = `Number.MAX_SAFE_INTEGER`, `maxTotalBytes` 없음)을 그대로 쓴다 — `options.payloadLimits`(contract 단계 한도)는 이 envelope 단계에 적용하지 않는다. 적용하면 `payload-too-large`가 `malformed-envelope`로 흡수돼 두 사유가 구분되지 않기 때문이다.

_(개정: RD-039 — 부모 interface `BridgeServer`는 삭제됐다. `dispatchRpc`·`cancel`은 이제 `StreamBridgeServer`에 직접 선언돼 있다. 결정 내용은 그대로다.)_

parse 실패는 `classifyParseFailure` 하나로 분류한다: `BridgeProtocolError`이고 `code === "VERSION_MISMATCH"`면 `version-mismatch`, 그 외 모든 throw는 `malformed-envelope`. 기록은 요청당 1회다. `protocolVersion !== 1`을 직접 비교하던 server 안 옛 분기(도달 불가였던 코드) 2곳은 삭제한다 — parse가 이제 그 판정을 대신한다.

Electron 어댑터(`electron-adapter.ts`)에서 삭제한 것: `parseHandshakeRequest`/`parseWireRpcRequest`/`parseWireCancelRequest`/`parseWireStreamCommand` import와 채널별 parse try/catch, handshake의 `identity.isMainFrame`·`options.allowedOrigins.includes` 검사, envelope 한도 상수, `recordRejection`과 `recordAdapterRejection` import(이유는 위 "상황"의 Symbol 통로 문단). 남긴 것: `senderIdentity`(Electron event → `SenderIdentity` 번역), `targetFor`(attach 시점의 `isCurrentMainFrame`/`isAllowedOrigin`/`onLifecycle` 조립), 채널 등록·해제, `streamSender`. 각 handler는 `server.<method>(senderIdentity(event), value)`를 그대로 호출하고, server가 던지면(구현이 항상 응답을 반환하는 계약이므로 정상 경로에서는 도달하지 않는 방어용 fallback) invoke 채널(handshake·rpc)은 `protocolError(value, "INVALID_ARGUMENT", "Invalid bridge request.")`를 반환하고 send 채널(cancel·control)은 조용히 무시한다.

## 결정 3: wire 응답 모양은 채널별로 고정하고, 사유는 진단에만 싣는다

RPC 거부는 사유와 무관하게 `FORBIDDEN "Bridge sender is not authorized."`(버전 불일치만 예외로 `VERSION_MISMATCH "Unsupported protocol version."`)다. handshake 거부는 malformed·version-mismatch·admission 거부 모두 `INVALID_ARGUMENT "Invalid bridge request."` 하나의 모양이다 — 이전 adapter가 이미 이렇게 응답했으므로 handshake 쪽은 관측 가능한 변화가 없다. `protocolError(value, code, message)` helper(신규 `src/main/protocol-error.ts`)가 이 응답들을 만든다. `value`에서 문자열 `clientId`·`requestId`를 최대한 복구하고 없으면 `"invalid-client"`/`"invalid-request"`를 쓴다(옛 adapter의 같은 규칙을 그대로 옮겼다).

이 helper를 별도 파일에 둔 이유는 preload 번들 제약 때문이다: preload는 `ELECTRON_BRIDGE_CHANNELS` 때문에 `electron-adapter.ts`를 번들하고, adapter의 fallback도 이 helper를 쓴다. `create-bridge-server.ts`(값으로 `rxjs`와 서버 구현을 가져온다)에 두면 preload 번들에 server와 `rxjs`가 끌려온다(ADR 0010 §14가 기록한 것과 같은 제약, TRP-002). `protocol-error.ts`는 `RpcResponse` 타입 전용 import 하나만 가지며 런타임 import가 없다.

_(개정: RD-019 — 채널 상수(`ELECTRON_BRIDGE_CHANNELS` 등)의 정의가 `src/protocol/electron-channels.ts`로 옮겨져 `electron-adapter.ts`는 그 상수를 재수출만 한다. preload도 이제 `src/protocol/electron-channels.ts`에서 직접 import하므로, 이 문단이 근거로 든 "preload가 `ELECTRON_BRIDGE_CHANNELS` 때문에 `electron-adapter.ts`를 번들한다"는 전제는 더 이상 성립하지 않는다. `protocol-error.ts`는 이제 envelope 조립을 위해 `../protocol/index.js`에서 `withEnvelope`를 값으로 import한다 — "런타임 import가 없다"는 위 서술도 더 이상 사실이 아니다. preload·protocol·Renderer 어느 쪽도 이 파일을 import하지 않으므로 preload 번들에는 영향이 없다. 파일 분리는 그대로 둔다 — adapter fallback이 이 helper를 쓰려고 `create-bridge-server.ts`를 값으로 import할 필요가 없게 한다.)_

cancel·control(비-subscribe)은 거부해도 응답을 만들지 않는다(void, 기존과 동일) — 대신 진단에 기록한다(결정 4).

## 결정 4: cancel도 다른 채널과 같은 verdict로 거부를 기록한다

옛 `cancel`은 `sessions.current()`가 거부해도 조용히 무시했다(`create-bridge-server.ts:212` 옛 코드). 이제 `handshake`·`dispatchRpc`·`controlStream`과 같은 `reject(reason)` helper를 호출해 `{ type: "rejected", reason }`을 기록한다. retire된 문서가 뒤늦게 보내는 cancel이 소음이 되는 것은 수용한다 — ack(`cancel`은 원래 응답이 없다)는 지금도 같다.

## 대안과 기각 사유

- **parse는 adapter에 두고 `VERSION_MISMATCH`만 server로 구분**: server의 `protocolVersion !== 1` 분기를 살리고 adapter가 version 불일치만 별도로 넘기는 안. Symbol 통로가 그대로 남고, 구조 오류와 version 오류가 다시 두 곳에서 판정돼 사유 불일치 문제의 일부만 해결한다. 기각.
- **`bindElectronBridge`가 sink를 직접 받는다**: adapter가 자체 판정(`frame-not-main`/`origin-not-allowed`)을 유지한 채 sink를 직접 받아 기록하는 안. sink 설정 지점이 `createBridgeServer`와 `bindElectronBridge` 두 곳으로 늘어나고, 두 지점이 같은 요청에 각자 `rejected`를 기록하지 않도록 조율하는 부담이 남는다(ADR 0010 §15 "중복 방지"가 이미 이 문제를 다뤘다). 판정을 server 하나로 모으면 이 조율 자체가 필요 없어진다. 기각.
- **사유 통합(`sender-unauthorized` 하나로 유지)**: 채널 무관 통일은 하되 세분화는 하지 않는 안. frame 불일치와 origin 불일치를 구분하지 못해 진단이 지금과 같은 정보 손실을 유지한다. 기각.
- **사유 세분화(`RejectReason` enum 확장)**: `frame-not-main`/`origin-not-allowed`보다 더 세분화된 사유(예: subframe과 stale main frame을 구분)를 추가하는 안. `RejectReason`을 다루는 기존 망라 switch(sink 구현체)가 모두 새 케이스를 처리해야 하는 breaking 변경이 되고, 이번 작업의 목표(채널 무관 통일)를 넘어선다. 기각.
- **`AttachedTarget`에 `admit(sender)` port를 추가**: frame·origin·client 판정 자체를 adapter가 구현하는 port로 내리는 안. `FakeTarget` 같은 test 구현이 순서·사유 매핑까지 재구현해야 하고, adapter마다(향후 loopback adapter 포함, [ADR 0017](0017-loopback-test-transport.md)) 판정 순서가 어긋날 위험이 생긴다. 판정을 `DocumentSessions` 안에 두고 `isCurrentMainFrame`/`isAllowedOrigin`만 port로 남기는 편이 순서를 한 곳에 고정한다. 기각.
- **wire 응답에 거부 사유를 싣는다**: RPC·handshake 거부 응답에 `RejectReason`을 포함해 Renderer가 원인을 알 수 있게 하는 안. Renderer는 신뢰 경계 밖이라 판정 근거(frame·origin·client 상태)를 제공하면 공격자가 admission 로직을 탐색하는 데 쓸 수 있다. 사유는 서버 운영자만 보는 진단 채널에만 싣는다(기존 결정 유지). 기각.

## 한계

- retire된 문서가 뒤늦게 보내는 cancel·acknowledge는 거부 진단을 남긴다(결정 4). main frame이 그대로면 `sender-unauthorized`, main frame이 교체된 뒤 도착하면(옛 frame의 `routingId`가 현재 main frame과 다르거나 `senderFrame`이 `null`) `frame-not-main`이다 — 이 사유만으로는 "정상적인 지연 도착"과 "실제 오탐 시도"를 구분할 수 없다.
- 미attach `webContents`가 보낸 handshake는 origin을 판정하지 않는다(`#admit`이 attachment 없음에서 먼저 `sender-unauthorized`로 반환하므로 3·4번 검사에 도달하지 않는다). 관측 가능한 변화: 이전에는 미attach + disallowed origin인 handshake가 `origin-not-allowed`였지만(adapter가 attach 여부와 무관하게 origin부터 봤다), 이제는 `sender-unauthorized`다.
- `#admit`이 판정하는 "현재 main frame"은 `AttachedTarget.isCurrentMainFrame`의 구현(adapter의 `targetFor`)에 전적으로 의존한다. 이 ADR은 판정 호출 위치만 통일했을 뿐, [ADR 0015](0015-rpc-request-lifecycle.md)가 이미 기록한 "`did-start-navigation` 없이 라우팅이 바뀌는 미확인 엣지 케이스" 가설은 그대로 남는다.

## 범위 밖

- 후보 05: 채널 상수·envelope builder·opaque ID를 protocol 모듈로 옮기는 것(TRP-002). preload는 계속 `electron-adapter.ts`에서 `ELECTRON_BRIDGE_CHANNELS`를 import한다. — RD-019에서 처리(위 개정 표시, [ADR 0013](0013-wiring-defaults.md)).
- 후보 06: loopback adapter. 이 ADR의 새 시그니처(`unknown` 인자, server가 판정 전부 소유)는 그 adapter를 만들 수 있는 전제만 마련한다 — adapter 자체는 이 작업의 범위가 아니다. — RD-020에서 처리([ADR 0017](0017-loopback-test-transport.md)).
- `DocumentSessions.retiredClientCount`(test 전용 인터페이스), `RejectReason` enum 값 추가·삭제, wire 응답에 거부 사유 싣기.

## 관련 ADR

- [ADR 0010](0010-operational-diagnostics.md) — 진단 이벤트·`RejectReason`·Symbol 통로(§14)·중복 방지(§15)의 원본 결정. 이 ADR이 §5·§7·§14·§15에 개정 표시를 남겼다.
- [ADR 0013](0013-wiring-defaults.md) — 채널 이름·기본 namespace의 원 결정과 `ELECTRON_BRIDGE_CHANNELS` 공유 이유(TRP-002의 원본 근거). RD-019 개정 절이 정의 위치를 `src/protocol/electron-channels.ts`로 옮긴 사실을 기록한다(`/main`은 재수출만).
- [ADR 0014](0014-stream-lookup-before-authorize.md) — 구독 수명주기를 `Subscriptions` 모듈 하나로 모은 선례(이 ADR이 admission을 `DocumentSessions` 하나로 모은 것과 같은 모양).
- [ADR 0015](0015-rpc-request-lifecycle.md) — `dispatchRpc`의 판정 순서 서술(:15)에 이 ADR로의 개정 표시를 남겼다.
