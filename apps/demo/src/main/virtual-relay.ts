import { BehaviorSubject, Subject } from "rxjs";
import type { RelayFault, RelayStatus } from "../bridge/relay-contract.js";

export class VirtualRelay {
  readonly status$ = new BehaviorSubject<RelayStatus>({
    energized: false,
    faulted: false,
  });
  readonly fault$ = new Subject<RelayFault>();

  turnOn(): RelayStatus {
    if (this.status$.value.faulted)
      throw new Error("Relay fault requires reset.");
    const status = { energized: true, faulted: false };
    this.status$.next(status);
    return status;
  }
  turnOff(): RelayStatus {
    const status = { ...this.status$.value, energized: false };
    this.status$.next(status);
    return status;
  }
  simulateFault(): RelayStatus {
    const status = { energized: false, faulted: true };
    this.status$.next(status);
    this.fault$.next({
      code: "RELAY_TRIPPED",
      message: "Relay overload simulated.",
    });
    return status;
  }
  reset(): RelayStatus {
    const status = { energized: false, faulted: false };
    this.status$.next(status);
    return status;
  }
  dispose(): void {
    this.status$.complete();
    this.fault$.complete();
  }
}

export function createVirtualRelay(): VirtualRelay {
  return new VirtualRelay();
}
