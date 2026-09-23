import { Observable, type Subscriber, type TeardownLogic } from "rxjs";

import type { RemoteState, RemoteStateSnapshot } from "../contract/index.js";
import { LocalGeneration } from "./local-generation.js";
import type { StreamMultiplexer } from "./stream-multiplexer.js";

export class RemoteStateClient<T>
  extends Observable<T>
  implements RemoteState<T>
{
  readonly #local: LocalGeneration<T>;
  #snapshot: RemoteStateSnapshot<T> = {
    status: "uninitialized",
    active: false,
  };

  public constructor(multiplexer: StreamMultiplexer, key: string) {
    let subscribeLocal!: (subscriber: Subscriber<T>) => TeardownLogic;
    super((subscriber) => subscribeLocal(subscriber));
    this.#local = new LocalGeneration(multiplexer, key, {
      onOpen: () => {
        this.#snapshot = { status: "connecting", active: true };
      },
      beforeNext: (value) => {
        this.#snapshot = { status: "current", active: true, value };
      },
      onClose: () => this.#markInactive(),
    });
    subscribeLocal = (subscriber) => this.#local.subscribe(subscriber);
  }

  public get snapshot(): RemoteStateSnapshot<T> {
    return this.#snapshot;
  }

  #markInactive(): void {
    const snapshot = this.#snapshot;
    this.#snapshot =
      snapshot.status === "current" || snapshot.status === "stale"
        ? { status: "stale", active: false, value: snapshot.value }
        : { status: "uninitialized", active: false };
  }
}

export type { RemoteState, RemoteStateSnapshot } from "../contract/index.js";
