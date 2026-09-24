# TRP-006 같은 webContentsId·clientId로 loopback을 dispose 후 재생성하면 재접속이 거부된다

- 상태: ACTIVE
- 적용 조건: `createLoopbackTransport`를 `dispose()`한 뒤, 같은 `server`에 같은 `sender.webContentsId`·같은 `clientId`(옵션을 안 주면 기본값 `"loopback-client"`로 고정)로 새 loopback을 만들 때.

`dispose()`는 server를 건드리지 않고 detach만 한다. 같은 `(webContentsId, clientId)` 쌍으로 재접속하면 `DocumentSessions#establish`가 이전 clientId를 retired 목록에서 찾아 `sender-unauthorized`로 거부한다(`document-sessions.ts`) — 서버가 재접속을 영구히 막는 설계이지 loopback 버그가 아니다.

## 오해하기 쉬운 신호

- `connect()`가 `BridgeProtocolError`로 reject되고 `createRendererApi`가 `INTERNAL`("Bridge handshake failed.")로 실패한다(server의 handshake 거부 응답을 loopback이 preload처럼 `parseHandshakeResponse`에서 거부한다). 이미 연결된 transport의 RPC라면 `type: "error"` 응답으로 돌아온다. loopback이나 server가 고장난 것처럼 보이지만 실제로는 재접속 방지 설계가 의도대로 동작한 것이다.

## 원인

`DocumentSessions`는 retire된 `(webContentsId, clientId)` 쌍을 세션 종료 이후에도 `maxRetiredClientsPerWebContents` 한도까지 기억해, 같은 clientId의 재접속을 거부한다(세션 연속성/재생 방지 규칙).

## 탐지/회피

dispose 후 "새 문서/새 세션"을 표현하고 싶으면 `clientId` 옵션을 다르게 준다(또는 `sender.webContentsId`를 바꾼다). 같은 clientId로 진짜 재접속을 검증하려는 test라면 이 거부 자체가 기대 동작이다.
