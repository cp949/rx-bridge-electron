# Renderer 진단 훅 추가

- Status: 승격 (ROADMAP.md#RD-028)
- 출처: `_works/20260924-05-operational-diagnostics/`(RD-007 운영 진단 작업, checklist.md "범위(제외)" 및
  "확정된 설계 결정" 2, 17).

## 배경

RD-007([ADR 0010](../../docs/adr/0010-operational-diagnostics.md))은 Main 프로세스의 `DiagnosticsSink`
확장만 다뤘다. `RejectReason`, 수명주기 이벤트(`session-opened`/`closed`, `subscription-opened`/`closed`),
`getDiagnosticsSnapshot()`은 모두 Main 쪽 `createBridgeServer`에만 있다.

Renderer 쪽(`packages/rx-bridge-electron/src/renderer`)에는 대응하는 진단 훅이 없다 — 예를 들어
`RemoteState`/`RemoteEvent`/RPC 호출 클라이언트가 겪는 재연결, 타임아웃, 구독 실패 등을 관측할 방법이
없다.

## 범위

Renderer 쪽에 어떤 이벤트·게이지가 필요한지(Main과 대칭적인 sink 훅인지, 다른 모델인지), 기록 금지
항목(ADR 0010과 동일한 제약을 따를지)을 먼저 정의해야 한다.

## 다음 단계

착수 여부와 우선순위는 아직 정하지 않았다. 착수하기로 결정하면 새 ROADMAP 항목으로 승격할지, 이
`.scratch/` 항목으로 계속 진행할지 그때 판단한다.
