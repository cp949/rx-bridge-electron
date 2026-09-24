# Renderer 공개 호출은 평면 경로를 유지하고 `dispose`를 루트에 둔다

> 호출 형태(평면 `api.<domain path>.<operation>`) 결정은 [ADR 0007](0007-hierarchical-renderer-api.md)이 대체한다. `dispose` 결정과 `$` 접미사 미채택은 유효하다.

Renderer 공개 호출 형태는 평면 `api.<domain path>.<operation>`을 유지한다. 요구사항 초안이 제시한 계층형 `api.<domain>.rpc|state|event.<operation>`은 채택하지 않는다. 같은 도메인 안에서 종류(RPC/State/Event)가 이름을 공유하는 충돌은 `defineDomain`이 이미 `Duplicate operation path`로 거부하므로 계층형이 추가로 풀어줄 충돌이 없다. 종류 구분은 호출부에서 값의 타입(RPC 함수, `RemoteState`, `Observable`)으로 이미 드러난다. 계층형을 도입하면 `rpc`, `state`, `event`를 모든 도메인에 예약 segment로 추가해야 하고, 이는 `device/rpc`처럼 실제로 쓰일 수 있는 중첩 도메인 이름과 충돌한다. 또한 Proxy 구현과 `InferBridge` 타입 추론을 계층 인식형으로 다시 짜야 하고, 모든 호출에 segment 하나가 늘어난다. 와이어 키(`rpc:device/connect`, `state:device/connection`)는 이미 종류를 포함하므로 계층형이 프로토콜 차원에서 얻는 것도 없다. 이전 비용도 낮다 — 이 패키지는 npm 배포 이력이 없고, 소비자는 저장소 내부의 `apps/demo`, Electron fixture, README뿐이며 이미 평면 형태를 쓰고 있어 호환 별칭을 둘 필요가 없다.

Renderer 루트에는 문자열 `api.dispose()`를 추가하고 `api[Symbol.dispose]`는 같은 함수 참조로 둔다. 이는 Main 쪽 `server.dispose()`(`create-bridge-server.ts`)와 bind 결과의 `dispose()`(`electron-adapter.ts`)에 대칭을 맞춘 것이다. 이름 충돌을 막기 위해 첫 segment가 `dispose`인 도메인 이름은 Main `buildRegistrationTableFromImpl`(`src/main/registration.ts`)이 거부하고, Renderer의 manifest 파서(`createRendererApi`)도 루트 segment `dispose`를 독립적으로 거부한다(Main 검증에만 기대지 않는 방어). _(개정: [ADR 0007](0007-hierarchical-renderer-api.md) "개정: wire key 문법의 단일 소유 (RD-017)" 절 — 두 거부 주체 모두 `src/protocol/operation-key.ts` 코어를 호출한다.)_ 하위 segment나 operation 이름으로 쓰이는 `dispose`(예: `api.device.dispose`)는 이 예약과 무관하므로 계속 허용한다. `dispose()`가 실행하는 종료 동작은 현재 구현(`streams[Symbol.dispose]()`)을 그대로 쓰며, 진행 중 RPC 확정·취소, 반복 호출, 종료 후 호출 결과 같은 종료 의미의 확장은 RD-003에서 다룬다. 이 문서는 이름과 존재만 결정하고 그 의미를 넓히지 않는다.

스트림 이름에 `$` 접미사를 자동으로 붙이는 규칙은 채택하지 않는다. `RemoteState`는 `.snapshot`을 가진 확장 `Observable`이라 스트림 여부로 접미사를 결정할 기준이 모호하고, 접미사를 자동으로 붙이면 계약 키·manifest 키(`state:device/connection`)와 Renderer에 노출되는 이름이 서로 달라진다. Proxy 기반 구현을 동결된 일반 객체 트리로 교체하는 안은 호출 형태 결정과 독립적이므로 이번 범위 밖으로 두고 별도로 검토한다.

이 결정과 근거는 이 문서와 `docs/architecture.md`, 패키지 README에 반영한다. 비교 과정에서 외부 요구사항 초안(계층형 호출 예시, 별도 `dispose()` 표기, Proxy 의존 최소화 요청)을 참고했지만 의견으로만 인용했을 뿐 구속력은 없다.
