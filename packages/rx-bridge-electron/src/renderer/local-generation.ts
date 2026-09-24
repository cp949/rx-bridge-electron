import { Observable, Subject, type Subscriber, type TeardownLogic } from "rxjs";

import type { RemoteState, RemoteStateSnapshot } from "../contract/index.js";
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

type LocalGenerationKind = "state" | "event";

/**
 * generation(open→next*→close) 수명과 snapshot 상태기계를 한 곳에 둔다.
 * `kind`가 `"state"`일 때만 snapshot을 유지·전이하고 늦은 구독자에게 현재값을
 * replay한다. `"event"`는 generation 수명 관리만 공유하고 snapshot을 읽지
 * 않는다.
 */
class LocalGeneration<T> {
  readonly #multiplexer: StreamMultiplexer;
  readonly #key: string;
  readonly #kind: LocalGenerationKind;
  #generation: Generation<T> | undefined;
  #snapshot: RemoteStateSnapshot<T> = {
    status: "uninitialized",
    active: false,
  };

  public constructor(
    multiplexer: StreamMultiplexer,
    key: string,
    kind: LocalGenerationKind,
  ) {
    this.#multiplexer = multiplexer;
    this.#key = key;
    this.#kind = kind;
  }

  /** state 전용 값이다. event에서는 읽지 않는다. */
  public get snapshot(): RemoteStateSnapshot<T> {
    return this.#snapshot;
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
      if (this.#kind === "state") {
        this.#snapshot = { status: "connecting", active: true };
      }
    }

    generation.subscribers += 1;
    const innerSubscription = generation.subject.subscribe(subscriber);

    if (
      !opensGeneration &&
      this.#kind === "state" &&
      generation.hasValue &&
      this.#generation === generation &&
      !generation.closed
    ) {
      // 새 구독자에게만 현재값을 동기로 재생한다. subject.next로 재생하면
      // 기존 구독자가 값을 중복 수신하므로 subscriber에 직접 전달한다. 값의
      // 수명은 generation의 수명과 같다 — generation이 폐기되면(마지막 구독
      // 해제, error, complete) 값도 함께 버려지고 다음 generation에는
      // 재생되지 않는다.
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
        if (this.#kind === "state") {
          this.#markInactive();
        }
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
            if (this.#kind === "state") {
              this.#snapshot = {
                status: "current",
                active: true,
                value: typedValue,
              };
            }
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
    if (this.#kind === "state") {
      this.#markInactive();
    }
    if (error === undefined) {
      generation.subject.complete();
    } else {
      generation.subject.error(error);
    }
  }

  #markInactive(): void {
    const snapshot = this.#snapshot;
    this.#snapshot =
      snapshot.status === "current" || snapshot.status === "stale"
        ? { status: "stale", active: false, value: snapshot.value }
        : { status: "uninitialized", active: false };
  }
}

class RemoteStateClient<T> extends Observable<T> implements RemoteState<T> {
  readonly #local: LocalGeneration<T>;

  public constructor(multiplexer: StreamMultiplexer, key: string) {
    const local = new LocalGeneration<T>(multiplexer, key, "state");
    super((subscriber) => local.subscribe(subscriber));
    this.#local = local;
  }

  public get snapshot(): RemoteStateSnapshot<T> {
    return this.#local.snapshot;
  }
}

export function createRemoteState<T>(
  multiplexer: StreamMultiplexer,
  key: string,
): RemoteState<T> {
  return new RemoteStateClient<T>(multiplexer, key);
}

export function createRemoteEvent<T>(
  multiplexer: StreamMultiplexer,
  key: string,
): Observable<T> {
  const local = new LocalGeneration<T>(multiplexer, key, "event");
  return new Observable<T>((subscriber) => local.subscribe(subscriber));
}
