# 저장소 이력 재초기화 기준점

이 문서는 이전 Git 저장소의 작업 기준과 주요 커밋을 새 Git 이력이 시작된 뒤에도 추적할 수 있도록 남긴다. 코드 동작의 근거는 현재 코드와 [아키텍처 문서](../architecture.md), 미래 작업은 GitHub issue를 따른다. 아래 커밋 제목은 변경 의도를 찾기 위한 인덱스이며, diff나 테스트 로그를 대신하지 않는다.

## 기준 스냅샷

- 기록 날짜: 2026-09-23
- 기존 HEAD: `f3bd4b906b3158dc6dbaf46cb391be9ec533f532` (`main`)
- 기존 이력: 28 commits, 로컬 branch `main` 하나, tag 없음, Git remote 없음
- 기존 커밋 날짜: 2026-09-22
- 재초기화 직전 작업 트리에는 아래의 기존 변경이 있었다. 이 파일을 쓰는 동안 새로 추가한 문서는 별도로 보존해야 한다.
  - 수정: `.gitignore` — `docs/superpowers/` 제외 추가
  - 미추적: `ROADMAP.md`, `AGENTS.md`, `docs/agents/domain.md`, `docs/agents/issue-tracker.md`, `docs/agents/rubber-workflow.md`

## 이력 보존 시 주의

`rm -rf .git` 뒤 `git init`은 작업 파일을 남기지만 기존 commit, branch, tag, remote 설정과 연결을 제거한다. 이 문서의 커밋 목록은 전체 Git 객체의 대체물이 아니다. 기존 이력을 다시 조회할 가능성이 있으면 `.git` 전체를 저장소 밖에 복사하거나 `git bundle`로 ref를 보관하고, 별도로 작업 트리의 미추적·수정 파일을 백업한다. Git bundle에는 작업 트리 변경이 들어가지 않는다.

```txt
위험도: 높음
롤백: `.git` 전체 백업을 복원하면 기존 저장소 상태로 돌아갈 수 있다. 이력 bundle만 있으면 commit/ref는 복원할 수 있지만 설정과 미커밋 작업 트리는 별도 복원이 필요하다.
```

## 마일스톤 인덱스

| 커밋      | 변경 의도                                                |
| --------- | -------------------------------------------------------- |
| `ce4434d` | pnpm workspace 초기화                                    |
| `4bd8d80` | Electron Rx Bridge 아키텍처 문서                         |
| `c77296d` | 설계 및 구현 계획 확정                                   |
| `9e4a816` | 프로토콜 기초 구현                                       |
| `70fd355` | 프로토콜 입력 검증 강화                                  |
| `d1fa1de` | 조합 가능한 bridge contract                              |
| `9f92415` | contract payload schema 제한                             |
| `5bdafdc` | 취소 가능한 Renderer RPC                                 |
| `3dd54c4` | 같은 turn에서 RPC 경합 정착 검증                         |
| `1e722e1` | Renderer State/Event 클라이언트                          |
| `af5aeeb` | 권한 확인을 포함한 Main RPC 서버                         |
| `4e22c19` | bounded Main stream hub                                  |
| `5df83b7` | Virtual Device Monitor 계획                              |
| `7204901` | Main stream 경합 및 queued value snapshot 보정           |
| `901deb2` | Electron IPC 및 preload 연결                             |
| `b2afa25` | Electron 데모 연결                                       |
| `0919500` | Electron 데모 경계 강화                                  |
| `6a6102b` | 패키징된 Electron bridge 검증                            |
| `a17fcb1` | Electron acceptance 보완                                 |
| `629f6b8` | Virtual Device Monitor 구현                              |
| `69b4ed8` | Linux Electron CI gate                                   |
| `fed8055` | ignore 규칙 정리                                         |
| `a449add` | Renderer 문서 세션 소유권 중앙화                         |
| `94d76d1` | Renderer local generation 수명주기 공유                  |
| `36f9c91` | 데모 도메인 조합                                         |
| `1a7741e` | 로컬 아키텍처 검토 파일 추적 중단                        |
| `e008923` | 알 수 없는 데모 역할 거부                                |
| `f3bd4b9` | Virtual Device Monitor와 bridge 수명주기 강화; 기존 HEAD |

새 이력의 첫 commit은 위 기존 HEAD를 부모로 갖지 않는다. 이후 문서에는 새 commit ID만 사용하고, 필요하면 이 표의 축약 ID를 과거 기준점 식별에만 사용한다.
