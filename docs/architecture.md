# rx-bridge-electron 아키텍처

이 문서는 현재 코드와 공개 README에서 확인되는 동작을 기록한다. 과거 설계 토론의 전체 이력은 포함하지 않으며, 구현이 바뀌면 코드와 함께 갱신한다.

## 목적과 범위

`@cp949/rx-bridge-electron`은 신뢰하는 로컬 Electron UI의 Main과 Renderer 사이에 타입 및 스키마 검증을 거치는 RPC, State, Event 통신을 제공한다. 원격 콘텐츠, 플러그인 권한, 범용 `webContents` 스트림 범위, 지속적인 고속 Event, 바이너리 전송은 현재 계약 범위가 아니다.

## 패키지 경계

| 진입점                               | 실행 위치     | 책임                                                  |
| ------------------------------------ | ------------- | ----------------------------------------------------- |
| `@cp949/rx-bridge-electron/contract` | 모든 프로세스 | 도메인 정의, 스키마, 계약 조합, Renderer 타입 추론    |
| `@cp949/rx-bridge-electron/main`     | Electron Main | 핸들러 등록, 권한 확인, 검증, 세션 및 스트림 관리     |
| `@cp949/rx-bridge-electron/preload`  | preload       | 고정 IPC 채널 어댑터와 `contextBridge` 노출           |
| `@cp949/rx-bridge-electron/renderer` | Renderer      | 비동기 API, RPC 클라이언트, `RemoteState`, RxJS Event |

Contract는 프로세스 중립 선언이다. handler, Electron 객체, 자격증명, Node API, 함수, Observable/Subject는 preload 경계를 건너지 않는다. Renderer에는 고정된 `BridgeTransport`만 노출하며 `ipcRenderer`, 임의 채널, raw Electron event를 공개하지 않는다.

## 요청 경로와 신뢰 경계

1. Renderer는 preload가 제공한 transport로 handshake를 시작하고 Main에서 공개 manifest를 받는다.
2. Electron 어댑터는 고정 namespace 채널에서 요청을 받고 sender의 `webContents`, frame, 현재 main frame 여부, origin을 확인한다.
3. Main은 연결된 문서 세션과 도메인 계약을 확인하고 권한 함수를 적용한다.
4. RPC 입력과 출력, handshake 및 stream envelope는 프로토콜 파서와 payload 한도를 통과해야 한다.
5. 오류 응답은 안전한 프로토콜 오류 코드로 직렬화한다. 내부 예외나 원문 payload를 진단 정보에 기록하지 않는다.

Electron 어댑터는 `allowedOrigins`를 받고 현재 main frame과 허용 origin을 검사한다. 데모 앱의 authorization은 `main` 역할에 전체 공개 계약을 허용하고 `monitor` 역할에는 State/Event만 허용한다. 알 수 없는 역할은 허용되지 않는다. 앱은 별도로 navigation 및 window 생성 정책, sandbox, context isolation, preload 설정을 유지해야 한다.

## 문서 세션과 정리

Main은 연결된 `webContents`별로 현재 main-frame 문서와 client ID를 묶은 세션을 유지한다. handshake에서 sender가 현재 main frame이고 허용 origin인지 확인한다. main-frame navigation, renderer process 종료, `webContents` 파괴, detach 또는 서버 dispose가 세션을 retire하고 해당 세션의 RPC와 stream 구독을 중단한다. retire된 client ID는 같은 `webContents`의 새 문서 세션에서 재사용하지 않는다.

이 소유 단위는 창이 아니라 렌더러 문서다. 한 창에서 reload/navigation이 발생하면 이전 문서에서 시작한 비동기 작업이 새 문서로 넘어가지 않아야 한다.

## RPC와 스트림 계약

- **RPC**: 하나의 clone-safe 입력과 결과를 주고받는다. `AbortSignal`과 `timeoutMs`는 입력값과 분리된 호출 옵션이며 취소·timeout·응답 중 하나만 최종 결과가 된다.
- **State**: 현재값을 나타낸다. Renderer의 `RemoteState`는 `uninitialized`, `connecting`, `current`, `stale` snapshot을 제공한다. 마지막 로컬 구독자가 해제된 뒤 값이 있었으면 snapshot은 `stale`가 되며, 새 구독 generation에 예전 값을 현재값처럼 재생하지 않는다. `undefined`도 유효한 값이다.
- **Event**: 과거 값을 재생하지 않는 발생 스트림이다. 명시적인 buffer capacity와 `error`, `drop-oldest`, `drop-newest` 중 overflow 정책을 계약에 둔다. 구독 확인 이후 sequence와 acknowledgement로 전송을 제어한다.
- 같은 Renderer 문서의 여러 로컬 구독자는 하나의 local generation을 공유한다. Main의 non-scoped State/Event source는 operation key별로 활성 consumer 사이에서 공유한다. 문서별 Event source는 각 구독 context로 생성한다. 마지막 consumer가 나가면 더는 쓰지 않는 upstream을 정리한다.

## Payload 및 제한

v1 payload는 `undefined`, `null`, boolean, number, bigint, string, 배열, 일반 객체로 제한한다. 함수, symbol, 순환 참조, 사용자 정의 prototype, accessor/non-enumerable property, symbol key는 거부한다. 기본 한도는 깊이 32, 전체 항목 10,000개, 문자열 및 key UTF-8 길이 1,000,000 byte다. 계약별 payload 한도를 지정하면 기본값 대신 그 설정을 사용한다.

## 데모와 증거 범위

`apps/demo`는 실제 장치 드라이버가 아니라 가상 장치와 relay를 통해 라이브러리의 계약, 역할 권한, State/Event, 다중 창 동작을 보여준다. 장치 연결 지원으로 해석하지 않는다.

검증 명령은 각 패키지의 `verify`와 CI workflow에 정의되어 있다. CI는 단위·타입·빌드 검사, 개발용 Electron acceptance, Linux packaged 실행 검사를 분리한다. package manifest의 Electron peer 범위(`>=29`)는 모든 Electron 버전에서 동일한 런타임 증명이 있다는 뜻이 아니다. 저장소 개발/CI 의존성은 `^39.8.10`이므로 다른 버전에서의 동작은 별도로 확인해야 한다. 이 문서를 추가하면서 검증 명령은 실행하지 않았다.
