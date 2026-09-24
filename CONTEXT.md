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

**구독 (subscription)**:
렌더러 문서 세션이 소유하는 State/Event 전달 단위. `subscriptionId`로 식별하며, 수명은 admission(ID 형식·watermark·등록 조회·slot·`authorize`)부터 terminal 전송과 slot 반환까지다. 세션이 retire되면 함께 끝난다. Main에서는 `Subscriptions` 모듈이 소유한다.
_Avoid_: stream consumer, 스트림 세션

**RPC 요청 (rpc request)**:
렌더러 문서 세션이 소유하는 요청-응답 단위. `requestId`로 식별하며, 수명은 등록 조회·slot 획득부터 handler 종료와 slot 반환까지다. 응답이 취소·deadline으로 먼저 나가도 slot은 handler가 끝날 때 반환한다. 세션이 retire되면 취소된다. Main에서는 `RpcRequests` 모듈이 소유한다.
_Avoid_: RPC 호출(call), dispatch

**계약 (contract)**:
런타임 값이 아니라 순수 TS 타입 `B`다. 도메인들의 중첩 객체 타입이며, 각 도메인 노드는 `rpc`·`state`·`event` 중 있는 카테고리만 키로 갖고 그 외 키는 하위 namespace로 재귀 처리한다(ADR 0007 계층). 값을 갖지 않으므로 런타임 계약 조합·등록 함수가 없다.
_Avoid_: 계약을 런타임 descriptor 트리로 조합하던 옛 함수들(제거됨, 근거·이전 방법은 ADR 0012)

**`BridgeApi<B>` / `BridgeImpl<B>`**:
계약 타입 `B`에서 파생하는 타입. `BridgeApi<B>`는 Renderer 공개 타입(RPC→`Promise`, State→`RemoteState`, Event→`Observable`)이고, `BridgeImpl<B>`는 Main이 `createBridgeServer<B>(impl, options)`에 넘기는 구현 타입(RPC handler, `CurrentValueSource`, `EventSource`)이다. 계약과 구현의 일치는 이 두 타입이 같은 `B`에서 파생한다는 사실 자체로 컴파일 타임에 보장된다.
_Avoid_: 계약에서 Renderer 타입을 추론하던 옛 타입, 도메인 조합 함수가 반환하던 구현 객체(모두 제거됨, 근거·이전 방법은 ADR 0012)

**`SchemasFor<B>` / `ErrorsFor<B>`**:
계약과 같은 모양의 선택적 중첩 map 타입. `SchemasFor<B>`는 `createBridgeServer`의 `options.schemas`에 두는 operation 단위 선택 검증 스키마(없으면 도메인 스키마 없이 통과, 구조·크기 검사는 항상 유지)이고, `ErrorsFor<B>`는 `options.errors`에 두는 RPC별 허용 도메인 에러 코드 목록이다.
_Avoid_: descriptor(`rpc()`/`state()`/`event()`)에 스키마를 항상 붙여야 했던 옛 모델(제거됨)
