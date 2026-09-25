/**
 * Electron acceptance fixture(단일 창)의 계약 타입. 경량 계약(ADR 0012)은
 * descriptor 없이 순수 TS 타입으로 도메인을 선언한다 — 검증은 `main.ts`의
 * `schemas` map이 맡는다.
 */
export type FixtureBridge = {
  readonly device: {
    readonly rpc: {
      ping(input: string): string;
    };
    readonly state: {
      readonly status: string;
    };
    readonly event: {
      readonly notice: string;
    };
  };
};
