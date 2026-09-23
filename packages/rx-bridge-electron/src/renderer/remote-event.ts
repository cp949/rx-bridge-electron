import { Observable, type Subscriber, type TeardownLogic } from "rxjs";

import { LocalGeneration } from "./local-generation.js";
import type { StreamMultiplexer } from "./stream-multiplexer.js";

export class RemoteEvent<T> extends Observable<T> {
  readonly #local: LocalGeneration<T>;

  public constructor(multiplexer: StreamMultiplexer, key: string) {
    let subscribeLocal!: (subscriber: Subscriber<T>) => TeardownLogic;
    super((subscriber) => subscribeLocal(subscriber));
    this.#local = new LocalGeneration(multiplexer, key);
    subscribeLocal = (subscriber) => this.#local.subscribe(subscriber);
  }
}
