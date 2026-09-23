# TRP-003 Electron e2e에서 창을 찾은 직후 Renderer 전역을 읽는 경쟁

- 상태: ACTIVE
- 적용 조건: Playwright `_electron`으로 띄운 앱에서 `app.windows()`·`firstWindow()`로 창을 찾은 직후
  `page.evaluate`로 Renderer 번들이 만든 전역(예: `fixtureRenderer`)이나 렌더링된 DOM을 읽을 때.

## 오해하기 쉬운 신호

대부분 통과하고 간헐적으로 `TypeError: Cannot read properties of undefined (reading '<name>')` 또는 창/요소를
찾지 못했다는 오류로 실패한다. 재실행하면 통과해 flake로 넘기기 쉽다. 여러 테스트 중 무작위 1~2건만
실패한다.

## 원인

창 URL은 navigation commit 시점에 보이지만 `<script>` 실행과 비동기 초기화(handshake 등)는 그 뒤에 끝난다.
URL 확인과 전역 준비 사이에 대기가 없으면 경쟁한다. `packages/rx-bridge-electron/test/electron/multi-window/`
하니스에서 8회 중 2회 재현했고, 대기를 추가한 뒤 12회 연속 통과했다.

## 탐지/회피

창을 찾은 뒤 `page.waitForFunction(() => globalThis.<전역> !== undefined)`로 준비를 기다리고, 비동기 초기화가
있으면 그 완료(예: `ready()` Promise)를 await한 뒤 evaluate한다. 한 번만 훑고 없으면 실패하는 창 탐색은
poll로 바꾼다. [TRP-001](TRP-001-demo-electron-e2e-flake.md)의 `apps/demo` `windowFor`도 대기 없이 창 텍스트를
읽는다.
