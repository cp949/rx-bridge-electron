# 함정 인덱스

| ID                                                  | 제목                                                                      | 상태     |
| --------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| [TRP-001](TRP-001-demo-electron-e2e-flake.md)       | `apps/demo` electron e2e 테스트의 간헐적 "Controller window missing" 실패 | ACTIVE   |
| [TRP-002](TRP-002-preload-bundle-server-import.md)  | preload 번들이 server 모듈과 `rxjs`를 끌어오는 값 import                  | RESOLVED |
| [TRP-003](TRP-003-electron-renderer-global-race.md) | Electron e2e에서 창을 찾은 직후 Renderer 전역을 읽는 경쟁                 | ACTIVE   |
| [TRP-004](TRP-004-stale-dist-electron-tests.md)     | `test/electron/*.electron.test.ts`가 stale `dist/`를 조용히 재사용        | ACTIVE   |
| [TRP-005](TRP-005-loopback-event-subscribe-race.md) | loopback transport의 broadcast event 구독 직후 emit 경합                  | ACTIVE   |
| [TRP-006](TRP-006-loopback-retired-clientid-reconnect.md) | 같은 webContentsId·clientId로 loopback 재접속 시 거부                 | ACTIVE   |
