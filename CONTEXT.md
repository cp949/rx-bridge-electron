# Electron Rx Bridge

Main과 렌더러 사이의 요청과 스트림이 어떤 문서에 속하는지 구분하는 언어.

## Language

**렌더러 문서 세션 (renderer document session)**:
하나의 렌더러 문서가 브리지를 사용하는 동안 유지되는 소유 단위. 같은 창에서 문서가 교체되면 이전 세션과 구별된다.
_Avoid_: 창 세션, 클라이언트 세션

**종료 (dispose)**:
소유자가 명시적으로 내리는 되돌릴 수 없는 종료다. Renderer API, Main 서버, Electron bind에 적용된다.
_Avoid_: close, shutdown(구분 없이 섞어 쓰기)

**은퇴 (retire)**:
렌더러 문서 세션이 수명 사건으로 끝나는 것이다. 수명 사건은 main-frame navigation, renderer 종료, webContents 파괴, detach, 서버 종료다. retire된 client ID는 재사용하지 않는다.
