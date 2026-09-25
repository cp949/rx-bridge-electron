# rx-bridge-electron

신뢰하는 로컬 Electron UI를 위한 타입 기반 IPC 라이브러리 `@cp949/rx-bridge-electron`의 모노레포입니다. Main과 Renderer 사이에 RPC, State, Event 세 가지 통신을 제공하고, 스트림 API는 RxJS만 씁니다.

라이브러리 설치와 사용법은 [패키지 README](packages/rx-bridge-electron/README.md)를 봅니다. 이 문서는 저장소 개발 방법만 다룹니다.

## 저장소 구조

| 경로                           | 내용                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `packages/rx-bridge-electron/` | 배포 패키지 `@cp949/rx-bridge-electron`. `tsdown`으로 `dist/` 빌드 |
| `apps/demo/`                   | 라이브러리를 쓰는 Electron + React 데모 앱(`electron-vite`)        |
| `docs/`                        | 아키텍처, 설계 문서, ADR, 검증 결과, 함정 기록, 로드맵 이력(동결)  |
| `CONTEXT.md`                   | 도메인 용어집                                                      |

pnpm workspace와 Turborepo로 관리합니다. 작업 목록과 다음 요구사항은 [GitHub issue](https://github.com/cp949/rx-bridge-electron/issues)에서 관리합니다.

## 요구 사항

- Node.js `>=24`
- pnpm `11.25.0` (`packageManager` 필드 기준)
- Linux에서 Electron test를 돌리려면 display가 필요합니다. 화면이 없는 환경에서는 `xvfb-run -a`로 감쌉니다.

## 개발

```sh
pnpm install
pnpm build          # 라이브러리 dist와 데모 out 빌드
pnpm test           # 라이브러리 test, 데모 unit test와 Electron test
pnpm lint
pnpm check-types
pnpm format         # prettier --write
pnpm verify         # format:check → lint → check-types → test → build
```

CI(`.github/workflows/ci.yml`)는 `xvfb-run -a pnpm verify`를 실행한 뒤 데모를 Linux용으로 패키징하고 패키징된 실행 파일로 Electron test를 다시 돌립니다.

### 데모 실행

데모는 workspace의 라이브러리 `dist/`를 import하므로 먼저 빌드합니다.

```sh
pnpm --filter @cp949/rx-bridge-electron build
pnpm --filter demo dev
```

### 패키지별 명령

```sh
pnpm --filter @cp949/rx-bridge-electron test:soak   # 장시간 soak test
pnpm --filter demo package                          # electron-builder 패키징
```

### 정리

```sh
./clean.sh --dry-run   # 삭제 대상만 출력
./clean.sh             # node_modules, dist, out, .turbo, coverage 등 삭제
```

## 릴리스

루트에서 [release-it](https://github.com/release-it/release-it)을 실행해 `@cp949/rx-bridge-electron`을 npm에 배포합니다. 설정은 `packages/rx-bridge-electron/.release-it.json`에 있습니다.

```sh
npm login
pnpm release-it --dry-run   # 실제 변경 없이 흐름 확인
pnpm release-it             # verify → 버전 선택 → npm publish → commit·tag·push
```

- 시작 전에 `before:init` hook이 패키지의 `pnpm run verify`(build, check-types, test)를 실행합니다.
- git 사전 검사(작업 트리, upstream, branch, 새 커밋 유무)는 하지 않습니다.
- publish 뒤 버전 커밋(`chore: v${version}을 배포한다`), tag(`v${version}`), push를 차례로 묻습니다. 커밋은 `packages/rx-bridge-electron/`에서 `git add . --update`로 만들므로 이 디렉터리 안의 추적 중인 다른 변경도 함께 들어갑니다. 작업 트리를 비운 뒤 실행합니다.
- GitHub Release는 만들지 않습니다.
- tarball에는 `dist/`, `LICENSE`, `README.md`, `package.json`만 들어갑니다(`files: ["dist"]`).

## 문서

- [문서 안내](docs/README.md)
- [아키텍처 개요](docs/architecture.md)
- [설계 문서](docs/design/README.md)
- [ADR](docs/adr/)
- [함정](docs/traps/INDEX.md)

## 라이선스

[MIT](LICENSE)
