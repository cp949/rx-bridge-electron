# 브리지 자원은 렌더러 문서 세션이 소유한다

RPC와 stream 자원의 소유 단위는 BrowserWindow가 아니라 연결된 `webContents`의 현재 main-frame 문서 세션이다. navigation, reload, renderer 종료, detach 때 세션을 retire하고 진행 중 작업을 중단한다. 이렇게 해야 같은 창의 다음 문서가 이전 문서의 비동기 작업이나 구독을 이어받지 않는다. 용어는 루트 `CONTEXT.md`의 “렌더러 문서 세션”을 따른다.
