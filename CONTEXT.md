# Electron Rx Bridge

Main과 렌더러 사이의 요청과 스트림이 어떤 문서에 속하는지 구분하는 언어.

## Language

**렌더러 문서 세션 (renderer document session)**:
하나의 렌더러 문서가 브리지를 사용하는 동안 유지되는 소유 단위. 같은 창에서 문서가 교체되면 이전 세션과 구별된다.
_Avoid_: 창 세션, 클라이언트 세션
