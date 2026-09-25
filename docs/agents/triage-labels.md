# Triage Labels

스킬은 다섯 가지 triage 역할로 말한다. 이 파일은 각 역할을 이 저장소 GitHub issue의 실제 라벨 문자열에 대응시킨다.

| mattpocock/skills 라벨 | 이 저장소 라벨    | 의미                                  |
| ---------------------- | ----------------- | ------------------------------------- |
| `needs-triage`         | `needs-triage`    | maintainer가 평가해야 한다            |
| `needs-info`           | `needs-info`      | 보고자의 추가 정보를 기다린다         |
| `ready-for-agent`      | `ready-for-agent` | 명세 완료, AFK agent가 바로 작업 가능 |
| `ready-for-human`      | `ready-for-human` | 사람이 구현해야 한다                  |
| `wontfix`              | `wontfix`         | 처리하지 않는다                       |

스킬이 역할을 언급하면(예: "AFK-ready triage 라벨을 단다") 이 표의 오른쪽 라벨 문자열을 쓴다. `wontfix`는 GitHub 기본 라벨이 이미 있다. 나머지 라벨이 없으면 처음 쓸 때 `gh label create`로 만든다.

실제로 쓰는 어휘가 다르면 오른쪽 열을 고친다.
