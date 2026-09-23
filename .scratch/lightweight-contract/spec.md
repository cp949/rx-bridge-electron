# 경량 계약: 타입만으로 시작하고 스키마를 점진 도입

- Status: planned (ROADMAP RD-010~RD-014)
- 출처: 2026-09-24 설계 그릴링. 참고 프로젝트 `/work/cp949/iframecall`.

## 문제

초기 구현에서 작성할 코드가 너무 많다. README 최소 예제(RPC 1개, State 1개)의 계약 파일만 약 33줄이며 그중 약 20줄이 손으로 쓴 스키마다. `defineDomain`·`rpc`·`state`·`event`·`composeContracts`·`implementDomain` 선언도 필요하다. raw `ipcMain.handle`/`ipcRenderer.invoke`보다 코드가 많아 초기 단계에서 채택할 이유가 약하다.

iframecall은 계약을 TS 타입 하나로 두고 payload를 structured clone에 맡겨 신뢰한다. 검증은 origin/source와 envelope 파싱뿐이다.

## 목표

- 사용자 작성 코드량을 raw IPC 수준으로 줄인다.
- 도메인 스키마는 선택이며 operation 단위로 부분·점진 도입한다.
- 사용자 코드가 필요 없는 검사(구조·크기 `parseBridgeValue`와 payload 한도, 세션 자원 한도, origin/sender 검사, envelope 파싱)는 기본 유지한다. 줄이는 대상은 사용자 코드량이지 라이브러리 내부 검사가 아니다.

측정 기준: README hello-world(RPC 1개, State 1개)에서 계약 타입 5줄 이하, 스키마 0줄, zod 의존성 0.

## 확정 결정

1. **타입만의 계약.** 런타임 descriptor 없이 타입으로 선언한다. 계층은 ADR 0007 Renderer API 모양(`rpc|state|event`)과 같다. RPC 인자는 0개 또는 1개(와이어가 단일 `input`)이고 반환은 값 타입이며 Renderer에서 `Promise`가 된다.

   ```ts
   type AppBridge = {
     device: {
       rpc: {
         connect(): Connection;
         send(input: { command: string }): SendResult;
       };
       state: { connection: Connection };
       event: { data: SerialLine };
     };
   };
   ```

2. **Main 구현.** `createBridgeServer<AppBridge>(impl, options)`. manifest는 `impl` 키에서 생성한다. 계약·구현 일치는 컴파일 단계 검사만 한다(ADR 0008 대체). 타입을 우회해 빠진 operation은 manifest에 없으므로 Renderer에서 노출되지 않는다.

3. **선택 스키마 map.** `options.schemas`에 계약과 같은 중첩 모양의 부분 map을 둔다. 타입은 `SchemasFor<AppBridge>`에서 도출하여 경로 오타와 스키마 출력 타입 불일치를 컴파일 에러로 잡는다. 없는 항목은 도메인 스키마 없이 통과한다. 생성 시 경로→스키마 테이블로 평탄화한다. 스키마는 `Schema<T>`(`parse(value: unknown): T`) 구조면 되고 zod에 의존하지 않는다. 스키마는 Main에만 두며 Renderer 번들에 포함되지 않는다. 파일 분리는 `satisfies SchemasFor<AppBridge>`로 한다.

   ```ts
   createBridgeServer<AppBridge>(impl, {
     schemas: { device: { rpc: { send: { input: sendSchema } } } },
   });
   ```

   요청 처리 순서: `parseBridgeValue(input)` → 입력 스키마(있으면, 실패 시 `INVALID_ARGUMENT`) → handler → 출력 스키마(있으면) → `parseBridgeValue` + clone.

4. **Event buffer.** Main source 옵션(예: `eventSource(data$, { buffer })`)에 두고 생략 시 기본값(`capacity: 100`, `overflow: "error"`)을 쓴다.

5. **허용 에러 코드.** `options.errors`에 같은 중첩 모양으로 둔다(`errors: { device: { rpc: { send: ["DEVICE_TIMEOUT"] } } }`). 목록에 없는 코드는 현재처럼 안전한 오류로 바꾼다. Renderer 에러 코드 타입 추론은 하지 않는다.

6. **기존 API 대체.** `defineDomain`·`rpc`·`state`·`event`·`composeContracts`·`implementDomain`을 제거한다. npm 배포 이력이 없고 소비자는 저장소 내부(demo, Electron fixture, README)뿐이므로 호환 계층을 두지 않는다.

## 기각한 대안

- **identity/brand 스키마 helper(`trusted<T>()`)**: 스키마 자리는 줄지 않고 descriptor 구조가 남는다.
- **스키마 인자 optional화(`rpc<I, O>()`)**: descriptor 선언 비용이 남는다.
- **계약 전역 `validate: false`**: 부분 적용이 불가능하다.
- **Main handler wrapper(`validated(schema, handler)`)**: 검증 정책이 구현 곳곳에 흩어진다.
- **문자열 키 스키마 map(`"device/send"`)**: 오타를 컴파일 단계에서 잡지 못한다.
- **Proxy로 스키마 자동 부착**: TS 타입은 런타임에 없으므로 Proxy가 스키마를 만들 정보가 없다.
- **구조·크기 검사까지 생략**: 사용자 코드 비용이 0인 검사를 선택으로 빼면 보안을 올릴 때 오히려 코드가 늘어난다.
- **전 계층(preload, Renderer) operation별 신뢰 분기**: 프로토콜·manifest·preload 변경이 필요하다.

## RD 분할

| RD | 내용 | 의존 |
|---|---|---|
| RD-010 | 결정 문서화: 신규 ADR(타입 계약, 선택 스키마 map), ADR 0004 개정, ADR 0008 대체 | - |
| RD-011 | 타입 계약과 `createBridgeServer<AppBridge>(impl)`, impl 기반 manifest, source buffer 옵션, `errors` 옵션 | RD-010 |
| RD-012 | `schemas` map: `SchemasFor`, 평탄화 조회, dispatcher·stream-hub 적용 | RD-011 |
| RD-013 | 기존 descriptor API 제거, demo·fixture·README 이전, 스키마 `main/` 이동, 코드량 목표 확인 | RD-011, RD-012 |
| RD-014 | 배선 코드 축약(bind, attach, preload, Renderer 초기화). 착수 전 별도 그릴링 | RD-013 |

RD-012를 RD-013보다 먼저 둔다. 스키마 계층 없이 기존 API를 제거하면 demo가 검증을 잃는다.

## 범위 밖

- 타입에서 스키마 자동 생성(typia, ts-to-zod). 빌드 도구 의존이 생긴다. `schemas` map을 생성기가 채우는 구조라 이후 추가해도 공개 API는 바뀌지 않는다.
- 타입 수준 RPC 에러 코드.
- RPC 다중 인자(와이어 형식 변경 필요).

## 미검증 가설

- 중첩 도메인 경로에서 `SchemasFor`를 재귀로 정의할 수 있고 에러 메시지 품질이 쓸 만하다.
- `impl` 키만으로 기존 manifest와 같은 형식을 만들 수 있다.

## Comments
