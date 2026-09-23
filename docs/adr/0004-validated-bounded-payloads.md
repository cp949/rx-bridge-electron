# IPC 경계를 제한된 payload 프로필로 검증한다

> [ADR 0012](0012-lightweight-type-contract.md)가 한도 병합 기준을 `contract.payloadLimits`에서 서버 옵션(`createBridgeServer(impl, { payloadLimits })`)으로 바꾸고, 도메인 스키마를 선택으로 만들었다. 구조·크기 검사가 모든 operation에 스키마 유무와 무관하게 유지된다는 이 문서의 나머지 결정은 유효하다.

IPC 입력, 출력, stream 값은 프로토콜별 파서와 깊이·항목 수·문자열 byte·전체 byte 제한을 통과해야 한다. v1은 plain data tree만 허용하고 함수, symbol, cycle, 사용자 정의 prototype 등을 거부한다. 이 경계는 Electron 직렬화의 우연한 동작에 계약을 맡기지 않고, 모든 operation에 일관된 크기와 값 제한을 적용한다. 이 구조·크기 검사는 도메인 스키마(`options.schemas`)가 있든 없든 항상 적용된다 — 도메인 스키마는 선택이지만 이 경계는 선택이 아니다. 구체 한도와 타입은 [아키텍처 개요](../architecture.md)에 기록한다.

payload 한도는 서버(`createBridgeServer(impl, options)`)가 `options.payloadLimits`와 기본값을 병합한 기준으로만 적용한다. Electron 어댑터(`electron-adapter.ts`)와 preload(`preload/expose-bridge.ts`)는 envelope 구조(순환 참조, 함수, prototype 등 값 프로필)만 검사하고 크기 한도는 강제하지 않는다 — 강제 지점을 서버 하나로 모아, 옵션이 기본값보다 큰 한도를 선언하면 그 한도가 adapter를 거쳐 handler까지 실제로 적용되게 한다. 전체 크기 한도(`PayloadLimits.maxTotalBytes`)는 [ADR 0009](0009-session-resource-limits.md)에서 추가했다.

출력 검사 순서와 실패 분류는 [아키텍처 개요](../architecture.md)의 "요청 경로와 신뢰 경계"에 있다.
