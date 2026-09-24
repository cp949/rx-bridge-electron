import { Subject, type Subscriber, type TeardownLogic } from "rxjs";

import { createDisposedError, type RemoteError } from "./remote-error.js";
import type { StreamMultiplexer } from "./stream-multiplexer.js";

interface Generation<T> {
  readonly subject: Subject<T>;
  subscriptionId?: string;
  subscribers: number;
  closed: boolean;
  hasValue: boolean;
  latest: T | undefined;
}

export interface LocalGenerationPolicy<T> {
  onOpen?(): void;
  beforeNext?(value: T): void;
  onClose?(): void;
  /**
   * true면 이미 값을 받은 활성 generation에 늦게 합류하는 구독자에게 현재값을
   * `subscribe()` 호출 안에서 동기로 1회 재생한다. 값의 수명은 generation의
   * 수명과 같다 — generation이 폐기되면(마지막 구독 해제, error, complete) 값도
   * 함께 버려지고 다음 generation에는 재생되지 않는다.
   */
  replayLatest?: boolean;
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
    // 종료 뒤에는 dispose 루프가 아직 complete하지 않은 활성 generation에도
    // 합류하지 않는다. 합류하면 현재값 재생과 늦은 complete를 받게 된다.
    // generation을 건드리지 않으므로 snapshot도 바뀌지 않는다.
    // 이 검사가 종료 뒤 subscribe의 유일한 차단 지점이다.
    if (this.#multiplexer.disposed) {
      subscriber.error(createDisposedError());
      return;
    }

    let generation = this.#generation;
    const opensGeneration = generation === undefined;
    if (generation === undefined) {
      generation = {
        subject: new Subject<T>(),
        subscribers: 0,
        closed: false,
        hasValue: false,
        latest: undefined,
      };
      this.#generation = generation;
      this.#policy.onOpen?.();
    }

    generation.subscribers += 1;
    const innerSubscription = generation.subject.subscribe(subscriber);

    if (
      !opensGeneration &&
      this.#policy.replayLatest === true &&
      generation.hasValue &&
      this.#generation === generation &&
      !generation.closed
    ) {
      // 새 구독자에게만 현재값을 동기로 재생한다. subject.next로 재생하면
      // 기존 구독자가 값을 중복 수신하므로 subscriber에 직접 전달한다.
      subscriber.next(generation.latest as T);
    }

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
            generation.hasValue = true;
            generation.latest = typedValue;
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
