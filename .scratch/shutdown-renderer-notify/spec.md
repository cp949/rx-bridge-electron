# Main이 스트림을 닫을 때 Renderer에 종료 통지

- Status: 승격 (ROADMAP.md#RD-026)
- 출처: `_works/20260923-03-shutdown-contract/pending-issues/01.md`(RD-003 작업 중 발견, 범위 밖으로
  분리).

## 배경

Main `StreamHub.#close`(`packages/rx-bridge-electron/src/main/stream-hub.ts`)는 consumer를 닫을 때
Renderer에 terminal 메시지를 보내지 않는다. `server.dispose()`나 세션 retire(navigation, renderer
종료, webContents 파괴, detach) 뒤 Renderer 구독자는 아무 신호도 받지 않는다.

RD-003(종료 계약, [ADR 0006](../../docs/adr/0006-shutdown-contract.md))은 이 통지를 명시적으로 범위
밖에 뒀다 — Renderer가 스스로 `api.dispose()`를 호출하는 경로는 결정됐지만, Main이 먼저 세션을 끝내는
경우 Renderer에 알리려면 스트림 terminal 메시지라는 프로토콜 확장이 필요하기 때문이다.

## 범위

Main이 세션을 retire하거나 서버를 dispose할 때, 해당 세션이 가진 활성 State/Event 구독에 대해
Renderer 쪽 `RemoteState`/`RemoteEvent`가 `complete()`(또는 별도 신호)를 받을 수 있게 하는 프로토콜
확장을 검토한다. 대부분의 경우 Renderer 문서 자체도 같은 수명 사건으로 함께 사라지므로, 통지가 실제로
관찰 가능한 시나리오(예: `monitor` 역할처럼 다른 문서의 세션 종료를 지켜보는 경우)를 먼저 특정해야
한다.

## 다음 단계

착수 여부와 우선순위는 아직 정하지 않았다. 착수하기로 결정하면 이 스펙을 다듬고 새 ROADMAP 항목으로
승격할지, 이 `.scratch/` 항목으로 계속 진행할지 그때 판단한다.

## Comments

- 2026-09-25: 설계 인터뷰에서 결정하고 ROADMAP.md#RD-026으로 승격. 배경의 `StreamHub.#close`는 현재 `Subscriptions.#close`다. `monitor` 예시는 성립하지 않는다 — 세션은 문서별이라 다른 창의 retire가 monitor 구독에 닿지 않는다. 통지가 관찰되는 경우는 살아 있는 창의 detach·`server.dispose()`·bind `dispose()`다. 새 메시지 종류는 필요 없다(`error`·`complete`가 이미 있다). 결정: RPC와 같은 코드(`CANCELLED`·`FORBIDDEN`), 활성·`authorize` 대기·admission 거부 구독 모두 통지, 쌓인 값 폐기, 전송 실패 무시, API 전체 신호는 범위 밖. 조사 중 main-frame `did-start-navigation`이 살아 있는 문서도 retire하는 결함을 확인해 ROADMAP.md#RD-025로 분리했다(RD-026보다 먼저).
