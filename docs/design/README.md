# 설계 문서

기능(주제)별 설계 문서다. 한 주제의 모델, 불변식, 흐름, 설계 이유, 기각한 대안, 알려진 한계를 한 곳에 모은다.

## 문서 역할

| 문서                                                         | 단위          | 담는 것                                                          |
| ------------------------------------------------------------ | ------------- | ---------------------------------------------------------------- |
| [architecture.md](../architecture.md)                        | 저장소 전체   | 패키지 경계와 현재 계약의 개요                                   |
| `docs/design/*.md`                                           | 기능·주제     | 주제별 모델·불변식·흐름·설계 이유. 여러 ADR을 현재 기준으로 종합 |
| [ADR](../adr/)                                               | 결정 1건      | 결정 당시의 상황·결정·기각한 대안. 시간순이며 대체될 수 있다     |
| 패키지 [README](../../packages/rx-bridge-electron/README.md) | 사용자 사용법 | 설치·사용 예제·옵션                                              |
| [CONTEXT.md](../../CONTEXT.md)                               | 용어          | 도메인 용어와 피할 동의어                                        |

설계 문서와 ADR이 다르면 대체되지 않은 최신 ADR과 코드를 확인하고 설계 문서를 고친다. 설계 문서와 코드가 다르면 코드가 현재 동작이다. 설계 문서를 고치거나 결함으로 등록한다.

## 주제

| 문서                                                    | 주제                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [01. 계약과 등록](01-contract.md)                       | 타입 계약, `BridgeImpl`, 등록 table, operation key, 선택 스키마·에러 map     |
| [02. Renderer API](02-renderer-api.md)                  | handshake manifest 해석, 계층형 호출 트리, 동결 객체, 예약 이름              |
| [03. Transport와 연결 설정](03-transport-and-wiring.md) | 신뢰 경계, 고정 preload transport, 채널·envelope, 연결 설정 기본값, loopback |
| [04. 문서 세션](04-document-session.md)                 | 렌더러 문서 세션, sender admission, client ID, retire 사유와 시점            |
| [05. RPC](05-rpc.md)                                    | RPC 요청 수명주기(Main·Renderer), 처리 순서, 취소·deadline, 최종 결과 하나   |
| [06. Main 스트림 전달](06-stream-delivery.md)           | 구독 수명주기, 전달 창(ack·sequence·terminal), upstream 공유, Event buffer   |
| [07. Renderer 스트림과 State](07-renderer-streams.md)   | multiplexer, local generation, `RemoteState` snapshot, `snapshotStore`       |
| [08. Payload와 오류 모델](08-payload-and-errors.md)     | 값 프로필, 한도, 출력 경계, 오류 코드 체계                                   |
| [09. 세션 자원 한도](09-resource-limits.md)             | 동시 RPC·구독 slot, RPC deadline, retired client ID 보관량                   |
| [10. 종료](10-shutdown.md)                              | Renderer `dispose()`, `server.dispose()`, bind `dispose()`, 재진입           |
| [11. 진단](11-diagnostics.md)                           | Main·Renderer 진단 이벤트, 기록 금지 항목, sink 격리                         |

## 작성 규칙

- 소스 라인번호를 쓰지 않는다(`file.ts:12`, `12행`, `L12` 모두 금지). 코드 위치가 필요하면 모듈·class·함수 이름으로 가리킨다. 파일 경로는 규칙의 유일한 소유 지점을 알려야 할 때만 쓴다.
- 작업 이력을 쓰지 않는다: RD 번호, DELTA, 커밋 해시, `_works/` 경로, 이슈 번호, "이번에 바꿨다" 같은 서술. 결정의 출처는 ADR 링크로 남긴다.
- 현재 동작을 현재형으로 쓴다. 대체된 설계는 "기각한 대안"에 이유와 함께 한 줄로 남긴다.
- 문단 하나에 규칙 1~2개. 순서·분기는 번호 목록이나 표로 쓴다.
- 용어는 [CONTEXT.md](../../CONTEXT.md)를 따른다.
- 사용 예제는 README에 둔다. 설계 문서의 코드는 모델을 설명하는 최소 조각만 둔다.

문서 구조:

1. 목적과 범위: 이 주제가 답하는 질문, 다루지 않는 것
2. 모델: 핵심 개념과 소유자(모듈)
3. 불변식: 항상 참이어야 하는 규칙
4. 흐름: 순서가 의미를 갖는 처리 단계
5. 설계 이유와 기각한 대안
6. 한계: 알려진 제약, 의도적으로 풀지 않은 문제
7. 관련 문서: ADR, 다른 설계 문서
