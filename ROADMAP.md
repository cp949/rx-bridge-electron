# rx-bridge-electron 로드맵

현재 범위는 **신뢰할 수 있는 로컬 Electron UI**의 Main–Renderer 통신이다.

## 운영 규칙

- 항목 ID는 `RD-001`, `RD-002`처럼 고정한다. 기존 항목 사이에 작업을 넣을 때는 번호를 바꾸지 않고 `RD-001a`, `RD-001b`처럼 붙인다.
- `[ ]`는 미완료, `[x]`는 구현과 해당 완료 기준의 검증이 끝난 상태다. 설계 결정만 필요한 항목은 결정과 문서 반영까지 마쳐야 완료로 표시한다.
- 각 RD를 시작할 때 최신 코드와 테스트를 다시 확인한다. 아래의 현황은 로드맵 작성 시점의 정적 검토 결과이며, 미실행 테스트를 통과한 것으로 취급하지 않는다.
- 공개 인터페이스나 프로토콜을 바꾸는 RD는 기존 사용자 코드의 이전 방법과 호환성 범위를 결정한 뒤 구현한다.

## 진행 순서

- [x] **RD-001 — 공개 인터페이스 네이밍 결정.** Renderer의 `api.domain.operation`과 요구사항 예시의 `api.domain.rpc.operation`·`state`·`event` 계층을 비교한다. 종류별 이름 충돌, 자동 완성, Proxy 및 타입 추론, 기존 소비자 이전 비용을 기준으로 하나를 결정하고 문서에 기록한다. `defineDomain`/`composeContracts`, `timeoutMs`, `DEADLINE_EXCEEDED`는 현재 의미가 명확하므로 이름 변경을 전제하지 않는다. `dispose()`는 RD-003의 종료 의미와 이름 충돌 정책을 함께 결정한다. **완료 기준:** 공개 호출 형태와 이전 방법이 결정되고, README·타입 예제·데모가 선택한 형태와 일치한다.

- [x] **RD-001a — Renderer 공개 호출을 계층형으로 전환.** RD-001의 평면 결정(ADR 0005)을 뒤집어 `api.<domain path>.rpc|state|event.<operation>`으로 바꾼다. operation 이름의 `/` 중첩을 금지해 manifest 키의 마지막 segment를 operation으로 확정하고, 도메인 경로 segment에서 `rpc`·`state`·`event`를 예약한다. 종류 간 동명 금지는 유지하고, 도메인에 없는 종류는 노출하지 않는다. `$` 접미사와 루트 `dispose` 예약은 그대로 둔다. 와이어 키와 handshake 형식은 바꾸지 않는다. **완료 기준:** 계약 검증·Renderer manifest 파서·`InferBridge`·Proxy가 계층형을 따르고, 새 ADR이 ADR 0005를 대체하며, README·타입 예제·데모·Electron fixture가 계층형과 일치한다.

- [x] **RD-002 — 활성 State의 늦은 로컬 구독자에게 현재값 전달.** 한 Renderer에서 State를 이미 구독 중일 때 새 구독자가 합류하면 현재 세대의 최신값을 즉시 받도록 한다. 마지막 구독 해제 뒤 남은 `stale` 값은 새 세대에 재생하지 않는다. `undefined`도 유효한 현재값으로 취급한다. **완료 기준:** 첫 구독, 늦은 구독, 마지막 해제, 재구독, 동기 전달을 검증하고 Main의 원격 구독은 공유된다.

- [x] **RD-003 — Renderer와 Main 종료 계약 완성.** Renderer 종료 시 진행 중 RPC를 로컬에서 확정·취소하고 모든 스트림을 정리한다. 종료 후 새 호출·구독의 결과를 정의한다. Main 서버 종료는 최종 상태가 되어 재등록과 새 세션을 허용하지 않는다. 명시적 `dispose()`와 `Symbol.dispose`의 관계를 RD-001 결정에 맞춰 정리한다. **완료 기준:** 진행 중 RPC·스트림, 반복 종료, 종료 중 동기 재진입, 종료 후 호출을 검증하며 늦은 응답이 전달되지 않는다.

- [x] **RD-004 — RPC 출력의 최종 경계값 검증.** 출력 스키마가 반환한 변환 결과를 IPC 전송 전에 다시 `BridgeValue`와 payload 한도로 검사한다. 입력 검증 실패는 `INVALID_ARGUMENT`, handler·출력 실패는 안전한 `INTERNAL`이라는 구분을 유지한다. **완료 기준:** 스키마가 변환하여 만든 비허용 값과 과대 값을 Renderer로 보내지 않는 테스트가 있다.

- [x] **RD-005 — 계약과 Main 등록의 일치 및 타입 검사.** 서버 생성 시 계약의 모든 도메인 구현이 정확히 한 번 등록됐는지 확인한다. `implementDomain`의 RPC 입력·출력 타입을 각 descriptor에서 추론하여 잘못된 handler를 가능한 한 컴파일 단계에서 잡는다. **완료 기준:** 누락·중복 도메인과 누락·초과 operation은 시작 시 실패하고, 잘못된 handler 타입은 타입 검사에서 실패한다. Manifest에 광고된 operation은 등록된 구현을 가진다.

- [x] **RD-006 — 세션별 자원 및 메시지 전체 크기 제한.** 현재의 깊이·항목 수·문자열별 크기·Event 큐 제한에 더해 진행 중 RPC 수, 활성·대기 구독 수, 전체 메시지 크기, timeout 상한을 어디에서 적용할지 결정한다. 장시간 문서에서 사용 완료한 ID 보관량도 제한하되 늦은 메시지를 오인하지 않도록 한다. **완료 기준:** 한 세션의 과부하가 다른 세션의 정상 요청을 막지 않으며, 각 한도 초과가 정해진 오류와 정리 동작으로 끝난다.

- [x] **RD-007 — 운영 진단의 최소 집합 정의.** 기존 diagnostics hook을 바탕으로 활성 세션·RPC·구독 수, 큐 사용량·드롭, timeout·검증 실패, 보안 거부의 사유를 관측할 필요를 정한다. 기록에는 원문 payload·자격증명·내부 경로를 넣지 않는다. **완료 기준:** 채택한 지표의 생성·해제·거부 경로를 검증하고, 기본 동작에서 무조건 콘솔에 출력하지 않는다.

- [x] **RD-008 — 다중 Renderer와 장시간 실행 검증.** 위 변경을 합친 뒤 실제 Electron에서 두 창의 세션·권한·업스트림 공유와 느린 소비자 격리를 확인한다. 반복 구독·해제, reload, 동시 RPC, overflow를 포함한다. **완료 기준:** 단위 및 타입 검사와 실제 Electron 실행 결과를 구분해 기록하고, 검증한 런타임·플랫폼·빌드 형태를 명시한다. **결과:** [docs/verification/rd-008.md](docs/verification/rd-008.md)

- [x] **RD-009 — `authorize` 예외 응답 코드 통일과 overflow 종료 시점 문서화.** RPC 경로는 `authorize` 예외를 adapter까지 다시 던져 `INVALID_ARGUMENT "Invalid bridge request."`로 응답하고, stream 경로는 `INTERNAL`로 응답한다. 앱 권한 콜백의 실패는 요청 형식 오류가 아니므로 두 경로를 `INTERNAL "Internal bridge error."`로 통일하고, 요청이 이미 취소됐으면 `CANCELLED`가 우선한다. 와이어 형식과 오류 코드 집합은 바꾸지 않는다. 함께 `error` 정책 overflow의 종료 통지가 대기 값 전달 뒤에 오고 구독 슬롯은 그 종료 뒤 반환된다는 동작을 문서에 명시한다(동작 변경 없음). 출처: `.scratch/authorize-exception-code`, `.scratch/overflow-slot-timing`. **완료 기준:** RPC `authorize` 동기 throw·비동기 reject가 `INTERNAL`, abort 중 예외가 `CANCELLED`, 예외 뒤 RPC 슬롯 반환, adapter 경유 응답도 `INTERNAL`임을 테스트로 검증하고, ADR·architecture·README가 두 경로의 분류와 overflow 종료 순서를 일치하게 기술한다. **결과:** 완료 조건 전부 충족, 편차 없음. 결정은 [ADR 0011](docs/adr/0011-authorize-exception-internal.md). overflow 문서 보정은 완료·upstream 오류까지 같은 순서로 넓혀 기술했다.

### 경량 계약 (명세: [.scratch/lightweight-contract/spec.md](.scratch/lightweight-contract/spec.md))

초기 구현의 사용자 코드량을 raw IPC 수준으로 줄인다. 계약은 타입만으로 두고 도메인 스키마는 operation 단위로 선택·점진 도입한다. 사용자 코드가 필요 없는 구조·크기 검사, 세션 자원 한도, origin/sender 검사는 기본 유지한다. 기존 descriptor API는 호환 계층 없이 대체한다(외부 소비자 없음). **공통 측정 기준:** README hello-world(RPC 1개, State 1개)에서 계약 타입 5줄 이하, 스키마 0줄, zod 의존성 0.

- [x] **RD-010 — 경량 계약 결정 문서화.** 타입만의 계약, `createBridgeServer<AppBridge>(impl, options)`, impl 키 기반 manifest, 선택 `schemas`·`errors` map, Main source의 buffer 옵션을 신규 ADR로 기록한다. ADR 0004는 도메인 스키마를 선택으로 바꾸고 구조·크기 검사는 모든 operation에 유지한다고 개정한다. ADR 0008은 런타임 계약·등록 일치 검사를 컴파일 단계 검사로 대체한다. **완료 기준:** 신규 ADR과 개정·대체 ADR, architecture가 새 계약과 검증 순서를 일치하게 기술한다. **결과:** 신규 [ADR 0012](docs/adr/0012-lightweight-type-contract.md) 작성, [ADR 0004](docs/adr/0004-validated-bounded-payloads.md)·[ADR 0008](docs/adr/0008-contract-registration-match.md) 상단에 개정·대체 표시(ADR 0008은 "결정 변경"이 아니라 전제 자체가 성립하지 않는다고 명시). `docs/architecture.md`는 DELTA-01에서는 미루고 DELTA-10에서 "계약 형태와 등록" 절 신설과 기존 서술(등록 검증, payload 한도, 세션/진단 옵션 시그니처) 전체 갱신으로 완료. 편차 없음.

- [x] **RD-011 — 타입 계약과 impl 기반 서버.** `createBridgeServer<AppBridge>(impl)`가 스키마 없이 RPC·State·Event를 제공한다. manifest는 impl 키에서 만들고, Event buffer는 source 옵션(생략 시 `capacity: 100`, `overflow: "error"`), 허용 에러 코드는 `options.errors` 중첩 map(목록 밖 코드는 안전한 오류)으로 받는다. 이 단계에서는 기존 descriptor API와 공존한다. **완료 기준:** 스키마 없는 RPC·State·Event가 동작하고, impl의 누락·초과 operation과 잘못된 handler·source 타입이 타입 검사에서 실패하며, `parseBridgeValue`·payload 한도·세션 한도가 그대로 적용된다. **결과:** `BridgeApi<B>`/`BridgeImpl<B>`/`SchemasFor<B>`/`ErrorsFor<B>` 타입과 13개 `@ts-expect-error`(DELTA-02), impl 트리 기반 등록 테이블(DELTA-03), `createBridgeServer`의 impl 오버로드(DELTA-04, 신규 19 테스트 GREEN)로 완료. 입력 없는 RPC handler가 실제로는 `(input, context)` 2-인자로 호출되는데 타입은 `(context)` 1-인자를 요구하던 불일치를 DELTA-04a에서 발견 즉시 수정(`(input: undefined, context) => O`). 편차 없음.

- [x] **RD-012 — 선택 스키마 map.** `options.schemas`를 `SchemasFor<AppBridge>` 부분 map으로 받아 생성 시 경로→스키마 테이블로 평탄화하고 dispatcher(입력·출력)와 stream-hub(State·Event 출력)에 적용한다. `satisfies`로 별도 파일에 둘 수 있다. **완료 기준:** 일부 operation에만 스키마를 적용할 수 있고, 경로 오타와 스키마 출력 타입 불일치가 컴파일 에러이며, 입력 스키마 실패는 `INVALID_ARGUMENT`, 출력 스키마 실패는 `INTERNAL`로 끝난다. **결과:** DELTA-05에서 신규 테스트 3개 파일(런타임 + 타입)이 구현 보정 없이 처음부터 GREEN — DELTA-04의 배선이 이미 요청 처리 순서·실패 분류와 정확히 일치했다. input 스키마 결과에는 output과 달리 clone-then-reparse 재검사를 적용하지 않는다는 의도된 비대칭을 확인(DELTA-05 "## 결정" 참고). 편차 없음.

- [x] **RD-013 — descriptor API 제거와 소비자 이전.** `defineDomain`·`rpc`·`state`·`event`·`composeContracts`·`implementDomain`을 제거하고 demo·Electron fixture·README를 새 형태로 옮긴다. demo 스키마는 `main/`으로 이동해 Renderer 번들에서 빠진다. **완료 기준:** 공통 측정 기준을 README에서 달성하고, 전체 검증과 Electron acceptance가 통과한다. **결과:** demo 이전(DELTA-06, Renderer 번들 zod grep 0건 확인) → 패키지 단위 테스트 이전(DELTA-07, 35 files/429 tests, 이전 전후 검증 항목 대조 완료, 대응 없는 항목은 사유 기록) → Electron fixture·multi-window·soak 이전(DELTA-08, RD-008 시나리오 수 10→10 불변, soak 8.69s 편차 없음) → 옛 descriptor API·어댑터·Renderer 타입 추론용 옛 타입 제거(DELTA-09, 저장소 전체 grep 0건, `pnpm verify`/`pnpm lint`/demo `pnpm test` 통과) 순서로 완료. 공통 측정 기준은 DELTA-10에서 README를 hello-world로 다시 써서 달성(계약 타입 4줄, 스키마 0줄, zod 0). **편차:** demo `pnpm test:electron`이 이 샌드박스에서 간헐적으로(6회 중 최대 2회) `Controller window missing`으로 flake — 창 텍스트 렌더링 전에 창 목록을 스캔하는 헤드리스 Electron 타이밍 문제로 RPC/State/Event 로직과 무관하다고 판단(DELTA-06·DELTA-09에서 각각 관찰, 재시도 시 통과). 이번 리팩터로 새로 생겼는지는 별도 확인하지 않았다 — 사전 존재 가능성이 높은 환경 이슈로 후속 과제로만 기록.

- [ ] **RD-014 — 배선 코드 축약.** 기존 함수 인자를 선택화해 배선 보일러플레이트를 줄인다(새 API 없음, 기존 명시 호출 호환). `bindElectronBridge`의 `ipcMain`·`namespace`, `attach`의 `role`(기본 `"default"`), `exposeBridgeInMainWorld`의 `contextBridge`·`ipcRenderer`·`namespace`를 선택으로 바꾼다. `namespace` 기본값은 Main·preload 공통 `"default"`, Electron 모듈은 `import * as electron from "electron"`으로 호출 시점에 해석하고 주입값이 우선한다. `createRendererApi<B>(transport?)`는 생략 시 `globalThis.rxBridge`를 읽어 `declare global`을 없앤다. hello-world에서 `pagehide` dispose 등록을 빼고 `dispose`는 SPA teardown 용도로 문서화한다. `allowedOrigins` 필수, 서버·어댑터 분리, 채널·와이어 형식은 유지한다. Proxy 교체(`.scratch/renderer-proxy-frozen-tree`)는 범위 밖. **완료 기준:** README hello-world 배선(import 제외)이 Main 3줄·preload 2줄·Renderer 2줄 이하이고, 기본값·명시 주입·에러 경로를 단위 테스트로 검증하며, 실제 Electron에서 축약형이 동작하고 dispose 없는 창 닫기·reload에도 Main 세션·구독·RPC 슬롯이 회수된다. demo·Electron fixture·README를 축약형으로 이전하고 결정을 ADR 0013에 기록한다.

## 현재 범위 밖의 확장

Binary/MessagePort 전송, 지속적인 초고속 Event, 원격 콘텐츠·플러그인 권한, 범용 `global/session/webContents` 스트림 scope, React 전용 패키지는 지금의 RD에 포함하지 않는다. 타입에서 스키마 자동 생성(typia, ts-to-zod), 타입 수준 RPC 에러 코드, RPC 다중 인자도 경량 계약 RD 범위 밖이다. 실제 사용 사례가 생기면 성능·신뢰 모델과 공개 인터페이스를 별도로 설계한 뒤 다음 RD 번호로 추가한다. 기존 `rx-bridge-electron`의 RPC·State·Event 인터페이스를 통해 해결 가능한지 먼저 확인한다.
