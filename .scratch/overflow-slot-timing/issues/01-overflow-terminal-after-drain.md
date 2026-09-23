# `error` overflow 종료 통지와 구독 슬롯 반환 시점의 문서 공백

- Status: closed (RD-009, 문서 보정)
- 출처: RD-008 다중 Renderer 검증([결과 문서](../../../docs/verification/rd-008.md) "발견과 처리").

## 배경

`error` 정책 Event 구독이 overflow하면 `StreamHub`는 source를 즉시 분리한다. 하지만 `STREAM_OVERFLOW`
error는 대기 큐 값을 ack 순서대로 모두 보낸 뒤에야 보내고, 그다음 구독을 닫고 슬롯을 반환한다
(`packages/rx-bridge-electron/src/main/stream-hub.ts` `#flush`). 단위 테스트
`test/main/subscription-limits.test.ts` "Event overflow error 정책 종료 뒤 슬롯이 반환된다"가 이 순서를
고정한다. 실제 Electron에서도 같은 동작을 확인했다.

ack를 영영 보내지 않는 소비자는 retire·unsubscribe 전까지 구독 슬롯 1개와 capacity만큼의 대기 값을
점유한다.

## 공백

`docs/architecture.md` "세션 자원 한도"의 "구독 슬롯은 … overflow … 각 경로 뒤 즉시 반환"과
[ADR 0009](../../../docs/adr/0009-session-resource-limits.md) 11항은 overflow 순간 즉시 반환으로 읽힌다.

## 다음 단계

- 최소: 문서에 "overflow 종료 통지는 대기 값 전달 후, 슬롯은 종료 통지 후 반환"을 명시한다.
- 선택: 대기 값을 버리고 즉시 종료하도록 바꿀지 결정한다. 전달 의미가 바뀌므로 ADR이 필요하다.

## Comments

- 2026-09-24: RD-009에서 "최소" 선택지로 처리. `docs/architecture.md` "세션 자원 한도"·Event 설명과 ADR 0009 11항에 source 쪽 종료(완료·오류·overflow)는 대기 값 전달 → terminal → 슬롯 반환 순서임을 명시했다. 동작은 바꾸지 않았다. "대기 값을 버리고 즉시 종료" 선택지는 전달 의미를 바꾸므로 채택하지 않았다 — 필요하면 새 이슈와 ADR로 다룬다.
