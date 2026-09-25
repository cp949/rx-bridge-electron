# 패키지 README를 사용자 가이드로 재구성

- Status: open
- 출처: 2026-09-26 사용자 피드백("README 파일을 읽기가 싫다"), 이슈 `renderer-framework-integration/01` 종료 직후 진단.

## 사실

2026-09-26 `dev` @ `5e2b3d2` 기준 `packages/rx-bridge-electron/README.md`.

- 580줄, 43,331 byte. 목차 없음.
- 코드 블록 밖 300자 초과 줄 35개. 최대 1,420자(512행 "검증, 한도"), 1,238자(297행 "런타임 동작" 첫 문단).
- "런타임 동작" 절은 16줄에 3,928자.
- 코드 스팬(백틱) 468개. ADR 링크 15개.
- 정의 없이 쓰는 내부 용어: `generation` 7회, `retire` 5회, `manifest`·`handshake`·`wire`·`slot`·`envelope` 각 4회(`CONTEXT.md` 용어).
- 절 순서: Hello world(88줄) 바로 뒤 배선 세부(배선 기본값 11줄, 명시 형태 78줄). Renderer 사용법(프레임워크 연동, Event·RPC 직접 사용, TanStack Query)은 297행 이후 "런타임 동작"의 하위 절.
- RD마다 절을 덧붙여 왔다(평탄화 RD-044, 진단 RD-045, TanStack 이슈 02, Event·RPC 직접 사용 `1bd9ce8`).

## 원인

1. 사용자 가이드와 계약 명세가 한 파일에 섞였다. 예: 334행 한 문단에 규칙 6개(세션 종료 `CANCELLED`, `stale`/`uninitialized` 전이, 쌓인 값 폐기, 종료 뒤 새 구독 `FORBIDDEN`, retire 사유 4종 무통지, 전송 실패 삼킴). 앱 개발자에게 필요한 것은 "세션이 끝나면 `CANCELLED`가 온다" 1줄이다.
2. 문단 하나에 규칙 여러 개, 괄호·줄표 삽입이 겹친다.
3. 내부 용어와 ADR 근거가 사용 설명과 같은 층에 있다.
4. 사용 흐름(설치 → 쓰기 → 에러 처리 → 테스트)과 절 순서가 다르다.

## README 안의 중복·불일치

- 설치 절: 한글 문장과 영어 문장(24행·26행)이 같은 내용을 반복한다.
- "`signal`을 넘기지 않으면 slot 점유": "Event·RPC 직접 사용"(405행)과 "TanStack Query 연동"(485행)에 반복.
- RPC·stream 오류 코드 설명이 3곳에 흩어졌다: "런타임 동작"(301행), "Event·RPC 직접 사용"(370-376행), "TanStack Query 연동" retry 판정(487행), "검증, 한도"(514행).
- 진입점 표에 `/testing` 행이 없다(`docs/architecture.md` 패키지 경계 표에는 있다).

## `docs/architecture.md`와 겹치는 README 내용

README에서 줄이거나 링크로 바꿀 후보. 오른쪽이 이미 같은 내용을 담은 위치.

| README                             | architecture.md                             |
| ---------------------------------- | ------------------------------------------- |
| 100행 impl 형태 검사·manifest 생성 | "계약 형태와 등록" 29행                     |
| 102-111행 `BridgeOperation` 표     | 33행                                        |
| 117-127행 배선 기본값 표           | "배선 기본값" 52-54행                       |
| 235행 요청 처리 순서               | 35행                                        |
| 297행 API 트리·경로 규칙           | "RPC와 스트림 계약" 87행                    |
| 299행 `api.dispose()` 의미         | 87행                                        |
| 332행 로컬 공유·소유 범위          | 84행, "문서 세션과 정리" 58행               |
| 334행 세션 종료 통지               | 62행 + retire 표                            |
| 362행 `snapshotStore` 동작 세부    | 82행, ADR 0024                              |
| 495행 Renderer 진단                | "운영 진단" 128행                           |
| 512-514행 payload 규칙·실패 분류   | "Payload 및 제한" 91-95행, "요청 경로" 46행 |
| 531행 Main 진단                    | 122행                                       |
| 578행 loopback 세부                | 23행                                        |

architecture.md에 없는 README 고유 내용(유지 대상): 보안 설정 권고(113행 `contextIsolation`·`sandbox` 등), 명시 형태 예제(다중 namespace, `globalName` 변경, 테스트 주입), 스키마·errors 예제, Event buffer 예제, 평탄화 예제, React 레시피, Event·RPC 직접 사용 예제, TanStack Query 예제와 검증 범위, `resourceLimits`·diagnostics 예제, loopback 옵션 표.

## 제안 구조

README는 사용자 가이드로 둔다. 문단당 규칙 1~2개, 목차를 두고, 내부 용어는 쓰지 않거나 첫 등장 때 1줄로 정의한다. 모든 경우의 동작은 `docs/architecture.md`·ADR 링크로 넘긴다.

1. 소개·진입점 표(`/testing` 포함)
2. 설치
3. Hello world
4. Renderer에서 쓰기: RPC(`CallOptions`·오류 코드 표 1개), State(snapshot 4상태), Event, 오류 처리(종료 원인 표 1개), `api.dispose()`
5. 프레임워크 연동: React 레시피, Event·RPC 직접 사용, TanStack Query
6. Main 구현: impl·`authorize`, 스키마, 허용 에러 코드, Event buffer, State source 평탄화
7. 배선: 보안 설정, 기본값 표, 명시 형태
8. 한도·진단: payload·resource limits 표, Main/Renderer 진단 예제
9. Testing(loopback)
10. 범위 밖

## 검토 질문

- 옮길 세부를 architecture.md에 합칠지, `docs/guide/*.md` 같은 별도 사용자 참조 문서를 둘지.
- README를 한글 단일로 둘지(현재 설치 절만 영어 병기).
- 오류 코드 표를 README 한 곳에 모을 때 RPC·stream 공통 표로 할지 분리할지.

## 제약

- 기술 정보를 잃지 않는다. README에서 빼는 내용은 architecture.md·ADR에 이미 있거나 옮긴 뒤에 뺀다.
- README 예제 코드는 재구성 뒤에도 타입 검사를 다시 통과해야 한다(TanStack 예제는 `@tanstack/react-query` 5.103.2 기준 검증 기록 유지).
- README 절 이름을 참조하는 문서를 함께 고친다: `docs/adr/0024-remote-state-snapshot-store.md:40`("README '런타임 동작'의 평탄화 문단"). ADR 0006·0013·0005·0012·0001의 README 언급은 절 이름을 특정하지 않는다.
- 규모가 README 한 파일을 넘으므로(architecture.md 중복 정리 포함) ROADMAP 항목으로 승격해 DELTA 단위로 진행한다.

## Comments

- 2026-09-26: 검토 질문 1·2 결정. (1) README에서 뺄 세부의 이관처는 `docs/design/` 기능별 설계 문서다(RD-046에서 11개 작성). architecture.md는 개요로 남기고 축약 여부는 재구성 때 판단한다. (2) README는 한글 단일이다(RD-046에서 설치 절 영어 병기와 `Hello world`·`Testing` 절 이름을 `시작하기`·`테스트`로 바꿨다). 질문 3(오류 코드 표)은 `docs/design/08-payload-and-errors.md`의 공통 표 1개(적용 경로 열 포함)를 기준으로 README 표를 만든다. README의 사실 오류 3건(adapter envelope 검사, stream의 CANCELLED 우선, signal 무시 handler의 slot 점유)은 RD-046에서 고쳤다.
