# authorize 예외의 응답 코드 불일치 (RPC INVALID_ARGUMENT vs stream INTERNAL)

- Status: closed (RD-009)
- 출처: RD-007 운영 진단 작업 중 범위 밖으로 확인(checklist "범위(제외)" 및 "확정된 설계 결정" 17).

## 배경

`createBridgeServer`(`packages/rx-bridge-electron/src/main/create-bridge-server.ts`)에서 `authorize`
콜백이 예외를 던졌을 때 RPC 경로와 stream 경로의 응답 코드가 다르다.

- RPC(`dispatchRpc`): `authorize` 예외 → `INVALID_ARGUMENT`로 응답.
- stream(`controlStream`): `authorize` 예외 → `INTERNAL`로 응답.

RD-007 작업(DELTA-02, DELTA-03)에서 이 두 경로의 거부 사유를 진단 이벤트로 기록하는 과정에 이 불일치를
확인했지만, 응답 코드 변경은 RD-007 범위 밖이라 그대로 뒀다(진단 이벤트도 이 경로는 기록하지 않음 —
`authorize` 예외 자체는 `rejected` 이벤트 대상이 아니라는 게 RD-007의 결정이다).

## 범위

두 경로의 응답 코드를 하나로 통일할지, 각 경로의 의미(RPC 입력 검증 vs 서버 내부 오류)에 맞게 의도된
차이인지 판단한다. 통일하기로 하면 어느 쪽 코드로 맞출지, 기존 클라이언트의 응답 코드 의존 여부를
확인해야 한다.

## 다음 단계

착수 여부와 우선순위는 아직 정하지 않았다. 착수하기로 결정하면 새 ROADMAP 항목으로 승격할지, 이
`.scratch/` 항목으로 계속 진행할지 그때 판단한다.

## Comments

- 2026-09-24: RD-009에서 처리. RPC 경로는 예외를 adapter까지 다시 던져 `protocolError`의 `INVALID_ARGUMENT "Invalid bridge request."`가 되고 있었다. 두 경로 모두 `INTERNAL "Internal bridge error."`로 통일했다(취소된 요청은 `CANCELLED` 우선). 근거: [ADR 0011](../../../docs/adr/0011-authorize-exception-internal.md).
