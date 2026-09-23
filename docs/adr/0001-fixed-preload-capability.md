# Renderer에는 고정 preload transport만 노출한다

Renderer는 contract에 선언된 작업을 고정된 `BridgeTransport`로 요청한다. raw `ipcRenderer`, 임의 채널, Electron event를 Renderer API로 제공하지 않는다. Main/preload/renderer 진입점을 분리하고 payload와 권한을 Main에서 다시 확인해 Renderer의 IPC 권한을 계약 범위로 제한한다. 이 기록은 현재 코드와 공개 README에서 확인한 운영상 근거이며, 과거 논의의 세부 내용은 재구성하지 않는다.
