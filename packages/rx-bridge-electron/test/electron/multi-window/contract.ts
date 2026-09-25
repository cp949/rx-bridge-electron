/**
 * Electron acceptance fixture(다중 창)의 계약 타입. 경량 계약(ADR 0012)은
 * descriptor 없이 순수 TS 타입으로 도메인을 선언한다 — 검증은 `main.ts`의
 * `schemas` map이, 버퍼 정책은 각 event source 생성 시점의 옵션이 맡는다.
 */
export type LabBridge = {
  readonly lab: {
    readonly rpc: {
      ping(input: string): string;
      secure(input: string): string;
      hold(input: string): string;
    };
    readonly state: {
      readonly status: string;
    };
    readonly event: {
      readonly notice: string;
      readonly strict: string;
      readonly lossy: string;
    };
  };
};
