# Issue tracker: GitHub

이슈와 작업 명세는 GitHub issue(`cp949/rx-bridge-electron`)로 관리한다. 모든 작업은 `gh` CLI로 한다.

## 규칙

- **생성**: `gh issue create --title "..." --body "..."`. 여러 줄 본문은 heredoc을 쓴다.
- **조회**: `gh issue view <number> --comments`. 라벨도 함께 가져오고 댓글은 `jq`로 거른다.
- **목록**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`. 필요하면 `--label`·`--state`로 거른다.
- **댓글**: `gh issue comment <number> --body "..."`
- **라벨 추가·제거**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **닫기**: `gh issue close <number> --comment "..."`

저장소는 `git remote -v`로 정해진다. clone 안에서 `gh`를 실행하면 자동으로 잡는다.

이슈 제목·본문·댓글은 한글로 쓴다. 저장소가 PUBLIC이므로 `_works/` 경로, 로컬 절대 경로, credential을 적지 않는다.

## PR을 triage 대상으로 다루는지

**PRs as a request surface: no.** _(외부 PR을 기능 요청으로 다루려면 `yes`로 바꾼다. `/triage`가 이 값을 읽는다.)_

`yes`이면 PR도 이슈와 같은 라벨·상태를 거치며 `gh pr` 명령을 쓴다.

- **조회**: `gh pr view <number> --comments`, diff는 `gh pr diff <number>`.
- **triage 대상 외부 PR 목록**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` 뒤 `authorAssociation`이 `CONTRIBUTOR`·`FIRST_TIME_CONTRIBUTOR`·`NONE`인 것만 남긴다(`OWNER`/`MEMBER`/`COLLABORATOR` 제외).
- **댓글·라벨·닫기**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub은 이슈와 PR이 번호 공간을 공유한다. `#42`는 `gh pr view 42`로 먼저 확인하고 실패하면 `gh issue view 42`를 쓴다.

## 스킬이 "이슈 트래커에 등록"하라고 할 때

GitHub issue를 만든다.

## 스킬이 "관련 티켓을 가져오라"고 할 때

`gh issue view <number> --comments`를 실행한다.

## Wayfinding 작업

`/wayfinder`가 쓴다. **map**은 이슈 하나이고 **child** 이슈가 티켓이다.

- **Map**: `wayfinder:map` 라벨을 단 이슈 하나. 본문에 Notes / Decisions-so-far / Fog를 둔다. `gh issue create --label wayfinder:map`.
- **Child 티켓**: map의 GitHub sub-issue로 연결한 이슈(`gh api` sub-issues endpoint). sub-issue를 쓸 수 없으면 map 본문 task list에 추가하고 child 본문 맨 위에 `Part of #<map>`을 적는다. 라벨: `wayfinder:<type>`(`research`/`prototype`/`grilling`/`task`). claim하면 작업하는 개발자에게 assign한다.
- **Blocking**: GitHub **native issue dependencies**를 쓴다. `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`로 edge를 추가한다. `<blocker-db-id>`는 blocker의 숫자 **database id**다(`gh api repos/<owner>/<repo>/issues/<n> --jq .id`. `#number`나 `node_id`가 아니다). GitHub은 `issue_dependencies_summary.blocked_by`에 열린 blocker만 센다. dependencies를 쓸 수 없으면 child 본문 맨 위에 `Blocked by: #<n>, #<n>`을 적는다. blocker가 모두 닫히면 unblocked다.
- **Frontier 조회**: map의 열린 child를 나열하고(`gh issue list --state open`, map의 sub-issue / task list 범위), 열린 blocker(`issue_dependencies_summary.blocked_by > 0` 또는 `Blocked by` 줄의 열린 이슈)나 assignee가 있는 것을 뺀다. map 순서상 첫 번째를 고른다.
- **Claim**: `gh issue edit <n> --add-assignee @me`. 세션의 첫 쓰기 작업이다.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, `gh issue close <n>`, 그다음 map의 Decisions-so-far에 요지와 링크를 추가한다.
