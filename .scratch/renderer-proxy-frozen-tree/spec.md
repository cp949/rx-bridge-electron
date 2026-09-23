# Renderer API의 Proxy 의존을 동결 객체 트리로 교체 검토

- Status: open
- 출처: `_works/20260923-01-renderer-api-naming/pending-issues/01.md`(RD-001 작업 중 발견, 범위 밖으로 분리).

## 배경

외부 요구사항 초안 55절이 "동적인 JavaScript `Proxy`에 지나치게 의존하지 않는다"를 제안했다. RD-001(Renderer 공개 인터페이스 네이밍)은 호출 형태와 `dispose` 이름 정책만 결정했고, Proxy 구현 자체를 바꾸는 것은 그 범위 밖이라 별도 항목으로 분리한다.

## 범위

`packages/rx-bridge-electron/src/renderer/create-renderer-api.ts`의 `createProxy`(현재 manifest tree 기반 Proxy로 선언 경로만 노출하고 leaf를 lazy 생성·캐시)를, handshake 직후 manifest로 만든 `Object.freeze`된 일반 객체 트리로 교체할지 검토한다. lazy 생성 이점은 getter로 유지할 수 있다.

호출 형태(`api.<domain path>.<operation>`)와 `dispose` 루트 예약은 RD-001에서 이미 확정됐고 이 교체와 독립적이다 — 그대로 유지한다.

## 다음 단계

착수 여부와 우선순위는 아직 정하지 않았다. 착수하기로 결정하면 이 스펙을 다듬고 새 ROADMAP 항목으로 승격할지, 이 `.scratch/` 항목으로 계속 진행할지 그때 판단한다.
