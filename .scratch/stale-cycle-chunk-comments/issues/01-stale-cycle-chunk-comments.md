Status: 후보

# 순환 chunk 경고 우회 주석의 전제가 재현되지 않는다

`src/main/index.ts:3-5`, `src/main/create-bridge-server.ts:1-4`, `src/renderer/create-renderer-api.ts:1-4`는 barrel `../contract/index.js`를 거치면 tsup dts 번들러가 순환 chunk 경고를 낸다는 이유로 `../contract/bridge-types.js`를 직접 import한다.

사실:

- 2026-09-25, `contract→main` 타입 역의존을 없애기 전 코드(`c33c963`)에서 세 곳을 barrel import로 바꾸고 `pnpm build`(tsup v8.5.1)를 실행했다. exit 0, 경고 출력 없음.

선택지:

- 세 곳을 barrel import로 바꾸고 주석을 삭제한다.
- direct import는 유지하고 주석만 사실대로 고친다.

## Comments

- 2026-09-25: contract-main-type-dependency 작업 중 발견. 그 작업 범위 밖이라 등록만 했다.
