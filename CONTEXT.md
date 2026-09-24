# Electron Rx Bridge

Main과 렌더러 사이의 요청과 스트림이 어떤 문서에 속하는지 구분하는 언어.

## Language

**렌더러 문서 세션 (renderer document session)**:
하나의 렌더러 문서가 브리지를 사용하는 동안 유지되는 소유 단위. 같은 창에서 문서가 교체되면 이전 세션과 구별된다.
_Avoid_: 창 세션, 클라이언트 세션

**종료 (dispose)**:
소유자가 명시적으로 내리는 되돌릴 수 없는 종료다. Renderer API, Main 서버, Electron bind에 적용된다.
_Avoid_: close, shutdown(구분 없이 섞어 쓰기)

**은퇴 (retire)**:
렌더러 문서 세션이 수명 사건으로 끝나는 것이다. 수명 사건은 main-frame navigation, renderer 종료, webContents 파괴, detach, 서버 종료다. retire된 client ID는 재사용하지 않는다.

**sender admission**:
요청을 보낸 frame·origin·clientId가 현재 렌더러 문서 세션에 속하는지 판정하는 것이다. `DocumentSessions`의 private `#admit`이 disposed·미attach → `sender-unauthorized`, subframe이거나 현재 main frame이 아님 → `frame-not-main`, 허용 목록 밖 origin → `origin-not-allowed` 순으로 판정하고, `establish`(handshake·RPC·subscribe)와 `current`(cancel·unsubscribe·acknowledge)가 이어서 client 판정(retired clientId, 경합)까지 마쳐 세션 또는 사유를 돌려준다. 채널과 무관하게 같은 사유를 낸다. 아래 "구독(subscription)"의 admission(ID 형식·watermark·등록 조회·slot·`authorize`)과는 다른 개념이다 — 그 admission은 sender admission을 통과해 세션을 얻은 뒤의 다음 단계다.
_Avoid_: sender 검증, origin check(단독)

**구독 (subscription)**:
렌더러 문서 세션이 소유하는 State/Event 전달 단위. `subscriptionId`로 식별하며, 수명은 admission(ID 형식·watermark·등록 조회·slot·`authorize`)부터 terminal 전송과 slot 반환까지다. 세션이 retire되면 함께 끝난다. Main에서는 `Subscriptions` 모듈이 소유한다.
_Avoid_: stream consumer, 스트림 세션

**RPC 요청 (rpc request)**:
렌더러 문서 세션이 소유하는 요청-응답 단위. `requestId`로 식별하며, 수명은 등록 조회·slot 획득부터 handler 종료와 slot 반환까지다. 응답이 취소·deadline으로 먼저 나가도 slot은 handler가 끝날 때 반환한다. 세션이 retire되면 취소된다. Main에서는 `RpcRequests` 모듈이 소유한다.
_Avoid_: RPC 호출(call), dispatch

**operation key (wire key)**:
`category:domain/op` 형식의 식별자다(예: `rpc:device/connect`). 등록 table의 key, handshake manifest의 key, `authorize(context, operation)`가 받는 `BridgeOperation`의 `key`, 진단 이벤트의 `key`가 모두 이 형식을 쓴다. `BridgeOperation`은 같은 key를 `category`·`domain`(segment 배열)·`operation`으로 분해해 함께 담은 동결 객체이고, Main 등록이 operation마다 한 번 만든다 — `authorize`를 쓰는 앱 코드가 wire key 문자열을 파싱하지 않게 하려는 것이다([ADR 0018](docs/adr/0018-authorize-structured-operation.md)). 문법(생성·분해, segment·예약어 검증, 경로 충돌 검사)은 `src/protocol/operation-key.ts` 하나가 소유하고, Main 등록(`buildRegistrationTableFromImpl`)과 Renderer manifest 파서(`createRendererApi`)가 각각 호출한다.
_Avoid_: table key(`domain/op`, category 없는 조회 전용 표기 — 더는 쓰지 않는다)

**계약 (contract)**:
런타임 값이 아니라 순수 TS 타입 `B`다. 도메인들의 중첩 객체 타입이며, 각 도메인 노드는 `rpc`·`state`·`event` 중 있는 카테고리만 키로 갖고 그 외 키는 하위 namespace로 재귀 처리한다(ADR 0007 계층). 값을 갖지 않으므로 런타임 계약 조합·등록 함수가 없다.
_Avoid_: 계약을 런타임 descriptor 트리로 조합하던 옛 함수들(제거됨, 근거·이전 방법은 ADR 0012)

**`BridgeApi<B>` / `BridgeImpl<B>`**:
계약 타입 `B`에서 파생하는 타입. `BridgeApi<B>`는 Renderer 호출 트리의 기본 모양(RPC→`Promise`, State→`RemoteState`, Event→`Observable`)이고, `BridgeImpl<B>`는 Main이 `createBridgeServer<B>(impl, options)`에 넘기는 구현 타입(RPC handler, `CurrentValueSource`, `EventSource`)이다. 계약과 구현의 일치는 이 두 타입이 같은 `B`에서 파생한다는 사실 자체로 컴파일 타임에 보장된다.
Renderer 소비자가 `createRendererApi<B>()`로 받는 공개 타입은 `RendererApi<B>`다 — `BridgeApi<B>`의 RPC마다 `CallOptions`(취소·타임아웃) 인자를 더하고 루트에 `dispose()`를 붙인 것이다.
_Avoid_: 계약에서 Renderer 타입을 추론하던 옛 타입, 도메인 조합 함수가 반환하던 구현 객체(모두 제거됨, 근거·이전 방법은 ADR 0012)

**`SchemasFor<B>` / `ErrorsFor<B>`**:
계약과 같은 모양의 선택적 중첩 map 타입. `SchemasFor<B>`는 `createBridgeServer`의 `options.schemas`에 두는 operation 단위 선택 검증 스키마(없으면 도메인 스키마 없이 통과, 구조·크기 검사는 항상 유지)이고, `ErrorsFor<B>`는 `options.errors`에 두는 RPC별 허용 도메인 에러 코드 목록이다.
_Avoid_: descriptor(`rpc()`/`state()`/`event()`)에 스키마를 항상 붙여야 했던 옛 모델(제거됨)
