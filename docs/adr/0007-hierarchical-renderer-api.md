# Renderer 공개 호출은 도메인 아래에 `rpc`·`state`·`event` 계층을 둔다

[ADR 0005](0005-renderer-api-shape.md)의 평면 호출 형태(`api.<domain path>.<operation>`) 결정을 이 문서가 대체한다. Renderer 공개 호출은 `api.<domain path>.rpc|state|event.<operation>`이다(`api.device.rpc.connect()`, `api.device.state.connection`, `api.device.event.data`). ADR 0005의 평면 근거 — 종류 간 이름 충돌이 없고 종류는 값의 타입으로 드러난다 — 는 사실이지만, 호출부 텍스트와 자동 완성 목록에서 RPC·State·Event가 섞여 종류를 읽으려면 타입을 봐야 한다. 계층형은 경로 자체가 종류를 말하고, 계약 선언(`defineDomain(name, { rpc, state, event })`)과 모양이 같다. 계약 선언 API, 와이어 키(`rpc:device/connect`), handshake 형식은 바꾸지 않는다.

계층형은 manifest 키에서 도메인과 operation의 경계를 알아야 한다. `rpc:device/serial/open`은 도메인 `device`의 operation `serial/open`(→ `api.device.rpc.serial.open`)과 도메인 `device/serial`의 operation `open`(→ `api.device.serial.rpc.open`) 두 가지로 읽힌다. 평면 형태에서는 둘의 결과가 같아 문제가 없었다. handshake에 경계를 따로 싣는 대신 operation 이름을 단일 segment로 제한한다(`/` 금지). 그러면 키의 마지막 segment가 항상 operation이다. 묶음은 도메인 경로로 표현한다. 결정 시점에 operation 이름에 `/`를 쓴 소비자는 없었다.

`rpc`·`state`·`event`는 도메인 경로의 모든 segment에서 예약한다. 도메인 `device/rpc`가 있으면 `api.device.rpc`가 도메인 `device`의 RPC 묶음과 충돌하기 때문이다. 계약 단계(`defineDomain`, `composeContracts`)가 거부하고, Renderer manifest 파서도 Main 검증에 기대지 않고 따로 거부한다. operation 이름은 종류 아래에 놓이므로 `rpc`·`state`·`event`를 operation 이름으로 쓸 수 있다. _(개정: 아래 "개정: wire key 문법의 단일 소유 (RD-017)" 절 — 거부 주체 정정, JS 예약어 4개 추가.)_

같은 도메인에서 종류가 달라도 같은 이름을 금지하는 규칙(`Duplicate operation path`)과, 도메인 `a`의 operation `b`와 도메인 `a/b`가 공존하지 못하게 하는 와이어 경로 충돌 검사는 유지한다. 계층형에서는 둘 다 Renderer 경로가 분리되지만, 와이어 키(`rpc:a/b`와 `state:a/b`, `rpc:a/b`와 `rpc:a/b/x`)가 진단과 로그에서 혼동된다. 나중에 완화하는 것은 호환되지만 허용한 뒤 다시 막는 것은 호환되지 않는다.

도메인에 정의가 없거나 비어 있는 종류는 노출하지 않는다. 런타임 값은 `undefined`이고 `InferBridge` 타입에도 키가 없다. 지금 Proxy가 manifest에 있는 경로만 노출하는 규칙과 같다.

ADR 0005의 나머지 결정은 유효하다: 루트 `api.dispose()`와 `api[Symbol.dispose]`는 같은 함수이고 첫 segment가 `dispose`인 도메인 이름은 예약한다. 스트림 이름에 `$` 접미사를 자동으로 붙이지 않는다 — 계층의 `state`·`event`가 종류를 드러내므로 접미사가 할 일도 없다. 호환 별칭은 두지 않는다. npm 배포 이력이 없고 저장소 내부 소비자(`apps/demo`, Electron fixture, README)는 이 결정과 함께 옮겼다. 외부 소비자는 `api.<domain>.<op>`를 op의 종류에 따라 `api.<domain>.rpc.<op>`, `.state.<op>`, `.event.<op>`로 바꾸고, operation 이름에 `/`를 썼다면 그 앞부분을 도메인 경로로 옮긴다.

## 개정: wire key 문법의 단일 소유 (RD-017)

규칙 코드는 `src/protocol/operation-key.ts`가 소유한다. Main 등록(`buildRegistrationTableFromImpl`, `src/main/registration.ts`)과 Renderer manifest 파서(`createRendererApi`, `src/renderer/create-renderer-api.ts`)가 각각 이 모듈을 호출한다. 본문의 "Renderer manifest 파서도 Main 검증에 기대지 않고 따로 거부한다"는 이 코드 공유와 충돌하지 않는다 — 공유하는 것은 코드이고, 신뢰는 공유하지 않는다는 뜻이다. Renderer는 수신한 manifest를 같은 함수로 handshake 시점에 다시, 독립적으로 검증한다. 두 구현이 조용히 어긋나는 위험이 N-version 독립성의 이득보다 크다고 판단해 규칙 코드는 하나로 모으고, 신뢰 경계(Main이 만든 값을 그대로 믿지 않는다)는 그대로 유지했다.

본문의 거부 주체 "계약 단계(`defineDomain`, `composeContracts`)"는 [ADR 0012](0012-lightweight-type-contract.md)/RD-013에서 `defineDomain`·`composeContracts`가 제거되며 대체됐다. 지금 거부 주체는 Main 쪽 `buildRegistrationTableFromImpl`이다 — impl 트리를 순회하며 코어 verdict를 `TypeError`로 번역한다. Renderer manifest 파서는 본문 그대로 `createRendererApi`다.

JS 예약어 4개 — `__proto__`·`prototype`·`constructor`·`then` — 는 도메인과 operation의 모든 segment에서 예약한다. 도메인 경로에서만 예약하는 본문의 `rpc`·`state`·`event`와 달리 operation 이름으로도 쓸 수 없다. `__proto__`는 object literal 대입 시 prototype setter로 취급되고, `prototype`·`constructor`는 함수/클래스 내장 속성과 충돌하며, `then`은 Promise 판별(thenable 검사)과 충돌한다. 넷 다 지금까지 구현 코드와 `docs/architecture.md`에만 있던 결정이며, 이 개정에서 처음 ADR에 남긴다.
