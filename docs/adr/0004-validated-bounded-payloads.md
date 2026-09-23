# IPC 경계를 제한된 payload 프로필로 검증한다

IPC 입력, 출력, stream 값은 프로토콜별 파서와 깊이·항목 수·문자열 byte 제한을 통과해야 한다. v1은 plain data tree만 허용하고 함수, symbol, cycle, 사용자 정의 prototype 등을 거부한다. 이 경계는 Electron 직렬화의 우연한 동작에 계약을 맡기지 않고, 모든 operation에 일관된 크기와 값 제한을 적용한다. 구체 한도와 타입은 [아키텍처 개요](../architecture.md)에 기록한다.
