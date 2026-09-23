import { Subject, type Subscriber, type TeardownLogic } from "rxjs";

import type { RemoteError } from "./remote-error.js";
import type { StreamMultiplexer } from "./stream-multiplexer.js";

interface Generation<T> {
  readonly subject: Subject<T>;
  subscriptionId?: string;
  subscribers: number;
  closed: boolean;
}

export interface LocalGenerationPolicy<T> {
  onOpen?(): void;
  beforeNext?(value: T): void;
  onClose?(): void;
}

export class LocalGeneration<T> {
  readonly #multiplexer: StreamMultiplexer;
  readonly #key: string;
  readonly #policy: LocalGenerationPolicy<T>;
  #generation: Generation<T> | undefined;

  public constructor(
    multiplexer: StreamMultiplexer,
    key: string,
    policy: LocalGenerationPolicy<T> = {},
  ) {
    this.#multiplexer = multiplexer;
    this.#key = key;
    this.#policy = policy;
  }

  public subscribe(subscriber: Subscriber<T>): TeardownLogic {
    let generation = this.#generation;
    const opensGeneration = generation === undefined;
    if (generation === undefined) {
      generation = {
        subject: new Subject<T>(),
        subscribers: 0,
        closed: false,
      };
      this.#generation = generation;
      this.#policy.onOpen?.();
    }

    generation.subscribers += 1;
    const innerSubscription = generation.subject.subscribe(subscriber);
    let removed = false;
    const removeLocalSubscriber = (): void => {
      if (removed) {
        return;
      }
      removed = true;
      innerSubscription.unsubscribe();
      generation.subscribers -= 1;
      if (
        generation.subscribers === 0 &&
        !generation.closed &&
        this.#generation === generation
      ) {
        generation.closed = true;
        this.#generation = undefined;
        this.#policy.onClose?.();
        if (generation.subscriptionId !== undefined) {
          this.#multiplexer.close(generation.subscriptionId);
        }
      }
    };

    if (opensGeneration) {
      this.#multiplexer.open(
        this.#key,
        {
          next: (value) => {
            if (this.#generation !== generation || generation.closed) {
              return;
            }
            const typedValue = value as T;
            this.#policy.beforeNext?.(typedValue);
            generation.subject.next(typedValue);
          },
          error: (error) => this.#finish(generation, error),
          complete: () => this.#finish(generation),
        },
        (subscriptionId) => {
          generation.subscriptionId = subscriptionId;
        },
      );
    }

    return removeLocalSubscriber;
  }

  #finish(generation: Generation<T>, error?: RemoteError): void {
    if (generation.closed || this.#generation !== generation) {
      return;
    }
    generation.closed = true;
    this.#generation = undefined;
    this.#policy.onClose?.();
    if (error === undefined) {
      generation.subject.complete();
    } else {
      generation.subject.error(error);
    }
  }
}
