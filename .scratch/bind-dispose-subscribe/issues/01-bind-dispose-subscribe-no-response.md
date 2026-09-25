# bind `dispose()` 뒤 새 구독이 응답 없이 `connecting`에 머문다

- Status: open
- 출처: 2026-09-26 RD-047 README 재구성 중 코드 대조 검토(`dev` @ `e7e2419` 기준 코드).

- 사실: bind `dispose()`는 `ipcMain.removeHandler`·`removeListener(channels.control)`로 IPC listener를 제거한다(`src/main/electron-adapter.ts`). 그 뒤 Renderer의 subscribe는 Main에 도달하지 않아 응답이 없고 `RemoteState`는 `connecting`에 머문다. `attach` 해제·`server.dispose()`만 한 경우는 IPC가 살아 있어 `FORBIDDEN`으로 끝난다.
- 가설(미검증): bind `dispose()` 뒤 RPC는 handler 없는 `ipcRenderer.invoke` reject로 `INTERNAL "RPC transport failed."`가 된다. Electron 실행으로 확인하지 않았다.
- 영향: 앱 종료 경로(`before-quit`)에서만 부르는 것이 권장 용법이라 실사용 영향은 작다. 창을 남긴 채 bind를 dispose하면 Renderer가 원인을 알 수 없다.
- 후보: (1) 한계로 문서화만 (2) 무응답 대신 Renderer에 종료를 알리는 경로 검토.

## Comments
