# TRP-001 `apps/demo` electron e2e 테스트의 간헐적 "Controller window missing" 실패

- 상태: ACTIVE
- 적용 조건: 저장소 루트 또는 `apps/demo`에서 `pnpm test`(또는 vitest)로 `test/demo.electron.test.ts`를
  실행할 때, 특히 다른 패키지 테스트와 같은 실행에서 순차/병렬로 함께 돌 때.

## 오해하기 쉬운 신호

`test/demo.electron.test.ts > operates the relay in the controller and keeps the monitor read-only`가
`Controller window missing` 메시지로 실패한다. 실패가 방금 만든 코드 변경 때문처럼 보이기 쉽다 — 실제로는
`apps/demo` 소스를 건드리지 않은 커밋에서도 재현됐다(RD-007 운영 진단 작업의 DELTA-03, DELTA-05에서 각각
1회 관측).

## 원인

미확인. Electron 앱 창 생성 타이밍과 e2e 하니스의 창 탐색 사이의 경쟁 조건으로 추정되나, 이 트랩 등록
시점에는 근본 원인을 조사하지 않았다.

가설: `apps/demo/test/demo.electron.test.ts`의 `windowFor`는 `app.windows()`를 한 번 훑어 창 텍스트를 읽고
대기하지 않는다. [TRP-003](TRP-003-electron-renderer-global-race.md)과 같은 계열의 경쟁이다(재현으로
확인하지 않음).

## 탐지/회피

같은 테스트 파일만 단독으로 재실행(`npx vitest run test/demo.electron.test.ts`, `apps/demo` 기준)하거나
저장소 루트 `pnpm test`를 다시 실행하면 통과한다. 실패가 이 테스트 1건뿐이고 재실행으로 통과하면 방금
변경과 무관한 기존 flake로 판단하고 재실행 결과를 근거로 남긴다. 여러 테스트가 함께 실패하거나 재실행해도
같은 테스트가 계속 실패하면 이 트랩과 다른 원인이므로 별도로 조사한다.
