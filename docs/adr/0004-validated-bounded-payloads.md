# IPC 경계를 제한된 payload 프로필로 검증한다

IPC 입력, 출력, stream 값은 프로토콜별 파서와 깊이·항목 수·문자열 byte·전체 byte 제한을 통과해야 한다. v1은 plain data tree만 허용하고 함수, symbol, cycle, 사용자 정의 prototype 등을 거부한다. 이 경계는 Electron 직렬화의 우연한 동작에 계약을 맡기지 않고, 모든 operation에 일관된 크기와 값 제한을 적용한다. 구체 한도와 타입은 [아키텍처 개요](../architecture.md)에 기록한다.

payload 한도는 서버(`createBridgeServer`)가 계약(`contract.payloadLimits`)과 기본값을 병합한 기준으로만 적용한다. Electron 어댑터(`electron-adapter.ts`)와 preload(`preload/expose-bridge.ts`)는 envelope 구조(순환 참조, 함수, prototype 등 값 프로필)만 검사하고 크기 한도는 강제하지 않는다 — 강제 지점을 서버 하나로 모아, 계약이 기본값보다 큰 한도를 선언하면 그 한도가 adapter를 거쳐 handler까지 실제로 적용되게 한다. 전체 크기 한도(`PayloadLimits.maxTotalBytes`)는 [ADR 0009](0009-session-resource-limits.md)에서 추가했다.

출력 검사 순서와 실패 분류는 [아키텍처 개요](../architecture.md)의 "요청 경로와 신뢰 경계"에 있다.
