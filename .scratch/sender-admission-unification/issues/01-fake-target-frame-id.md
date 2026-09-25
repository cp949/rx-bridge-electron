# `FakeTarget.isCurrentMainFrame`이 frameId를 무시한다

- Status: closed — RD-018 DELTA-01(`45ba8c0`)에서 해결. `FakeTarget`에 현재 main frame id 필드와
  `replaceMainFrame(newFrameId)`를 추가하고 `isCurrentMainFrame`이 frameId까지 검사하도록 고쳤다.
- 출처: RD-015 구독 수명주기 심화 작업(checklist "범위(제외)" 및 "확정된 설계 결정" 14), 아키텍처 리뷰 01 후보 04, RD-015
  그릴링 Q5.

## 배경

`packages/rx-bridge-electron/test/main/fake-ipc.ts:27-28`의 `isCurrentMainFrame`은 `webContentsId`와
`isMainFrame`만 비교한다. 실제 Electron adapter(`src/main/electron-adapter.ts:127-130`)는
`contents.mainFrame.routingId === sender.frameId`까지 요구한다.

## 영향

server seam 단위 test(`FakeTarget` 기반)는 같은 `webContents`에서 main frame이 교체된 뒤 옛 frameId로
온 요청의 거부를 관측하지 못한다. 이 경로는 Electron acceptance test(`test/electron/*.electron.test.ts`)
만 덮는다.

## 범위

RD-015 밖이다. sender admission 단일 판정 통합("후보 04" — `recordAdapterRejection` Symbol 정리,
version-mismatch 도달 불가 분기 정리와 같은 묶음)을 다루는 후속 작업에서 `FakeTarget`을 실제 adapter
검사와 맞추거나, frameId를 검증하는 별도 테스트 하니스를 추가한다.

## 다음 단계

착수 여부와 우선순위는 아직 정하지 않았다. 착수하기로 결정하면 새 ROADMAP 항목으로 승격할지, 이
`.scratch/` 항목으로 계속 진행할지 그때 판단한다.
