// 경량 계약(ADR 0012): relay 도메인도 순수 TS 타입으로만 선언한다. 검증은
// `src/main/schemas.ts`의 `schemas`/`errors` map이 맡는다. `interface`가
// 아니라 `type`으로 선언하는 이유는 `device-contract.ts` 상단 주석 참고.
export type RelayStatus = {
  readonly energized: boolean;
  readonly faulted: boolean;
};

export type RelayFault = {
  readonly code: "RELAY_TRIPPED";
  readonly message: "Relay overload simulated.";
};

export type RelayBridge = {
  relay: {
    rpc: {
      turnOn(): RelayStatus;
      turnOff(): RelayStatus;
      simulateFault(): RelayStatus;
      reset(): RelayStatus;
    };
    state: { status: RelayStatus };
    event: { fault: RelayFault };
  };
};
