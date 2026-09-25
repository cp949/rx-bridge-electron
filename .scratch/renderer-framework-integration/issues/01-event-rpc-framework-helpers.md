# Event·RPC 프레임워크 연동 helper 필요성 검토

- Status: closed — helper 추가 안 함. README "Event·RPC 직접 사용" 절과 demo 보정으로 대체
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

- 2026-09-26: 검토 결론 — Event·RPC helper를 추가하지 않는다.
  - "사실" 1번 정정: Event 직접 구독에도 틀리기 쉬운 지점이 있다. `next`만 넘기면 원격 종료가 rxjs 미처리 오류로 보고되고 구독이 닫힌 채 멈춘다(RD-043 함정 (1)과 같다). loopback 실측: `server.dispose()` → `CANCELLED: Bridge session ended.`, `authorize` 거부 → `FORBIDDEN`, 기본 buffer 초과 → `STREAM_OVERFLOW`, source error(`code` 포함)·`authorize` 예외 → `INTERNAL`. demo Event 구독 5곳과 `sampleTime` State 구독 1곳이 모두 `next`만 넘겼다.
  - Event helper 불필요: Event는 현재값이 없어(ADR 0003) 중립 store로 만들려면 누적 정책(reducer)을 받아야 하고, 그 정책은 화면마다 다르다(demo만 해도 목록 추가·개수·마지막 값). helper는 `scan`+`subscribe` 포장에 그치고 종료 원인은 여전히 호출자가 받아야 한다. 함정은 `error` 누락 하나이므로 문서로 막는다.
  - RPC helper 불필요: `Promise`+`CallOptions.signal`이고, 호출 상태·취소·재시도는 TanStack Query 예제(이슈 02)가 다룬다.
  - 반영: 패키지 README에 "Event·RPC 직접 사용" 절 추가(종료 원인 목록, 재구독 없음, `api.dispose()`는 `complete`, React Event 예제, 호출별 `AbortController`와 unmount abort RPC 예제). Hello world `subscribe`에 `error` 추가. demo `App.tsx`·`RelayPanel.tsx`의 직접 구독에 `error` 핸들러 추가, RPC `invoke`를 호출별 `AbortController` 집합으로 바꿔 unmount 때 모두 abort하고 모든 RPC에 `signal`을 전달("Cancel Pending"은 진행 중 호출 전부 취소).
  - 검증: demo `test/stream-termination.test.tsx`(Main·Monitor 2건, server dispose 뒤 미처리 오류 0·종료 원인 표시) 수정 전 RED(Main 미처리 4건) → GREEN. mutation(`sampleTime` error 제거 2 failed, relay fault error 제거 2 failed, Main data error 제거 1 failed) 확인 후 원복. demo `check-types`·`test:unit` 11 files/26 tests·`xvfb-run -a pnpm test:electron` 4 tests, 루트 `pnpm lint`·`pnpm format:check` 통과. README 예제는 demo 계약 타입으로 옮겨 `tsc --noEmit` 통과.
