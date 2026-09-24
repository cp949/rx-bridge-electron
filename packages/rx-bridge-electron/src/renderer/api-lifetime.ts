/**
 * Renderer API 인스턴스 하나의 종료 상태·종료 절차를 소유한다. 종료 플래그는
 * `dispose()` 절차의 부작용(RPC 확정, stream 정리)보다 먼저 확정된다 — 그
 * 부작용 도중 sink가 동기로 재진입시킨 `subscribe()`·RPC 호출·`dispose()`가
 * 이미 `true`인 `disposed`를 보고 종료 뒤 호출과 동일하게 처리되게 하기
 * 위해서다(ADR 0006).
 *
 * 절차 단계는 범용 콜백 목록이 아니라 고정 슬롯 2개(RPC, stream)로 받는다 —
 * 순서(RPC 먼저, stream 나중)를 타입으로 고정한다.
 */
export interface ApiLifetimeSteps {
  readonly settleRpcs: () => void;
  readonly closeStreams: () => void;
}

export class ApiLifetime {
  readonly #steps: ApiLifetimeSteps;
  #terminated = false;

  public constructor(steps: ApiLifetimeSteps) {
    this.#steps = steps;
  }

  public get disposed(): boolean {
    return this.#terminated;
  }

  /**
   * 멱등 guard는 이 클래스가 유일하게 소유한다. `RpcClient.settleAllAsDisposed()`와
   * `StreamMultiplexer.closeAll()` 자체는 멱등이 아니다.
   */
  public dispose(): void {
    if (this.#terminated) {
      return;
    }
    this.#terminated = true;
    this.#steps.settleRpcs();
    this.#steps.closeStreams();
  }
}
