# Event·RPC 프레임워크 연동 helper 필요성 검토

- Status: open
- 출처: 2026-09-25 그릴링 Q4, RD-043.

## 사실

- Event는 `useEffect` 안의 `subscribe` 한 줄로 쓸 수 있고, 직접 작성 시 틀리기 쉬운 지점이 확인되지 않았다.
- RPC는 `Promise`다.
- 현재 사용처는 demo뿐이다.

## 검토 질문

- Event용 helper가 필요한가.
- RPC 호출 상태 helper가 필요한가(기존 도구로 충분한지).
- 필요하면 RD-043처럼 프레임워크 중립 형태가 가능한가.

## 제약

- React 의존성 추가 금지(ADR 0024).
- ROADMAP "현재 범위 밖의 확장".

## Comments
