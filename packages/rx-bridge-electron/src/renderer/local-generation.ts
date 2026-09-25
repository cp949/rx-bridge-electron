import {
  config,
  Observable,
  Subject,
  type Subscriber,
  type TeardownLogic,
} from "rxjs";

import type { RemoteState, RemoteStateSnapshot } from "../contract/index.js";
import type { ApiLifetime } from "./api-lifetime.js";
import { createDisposedError, type RemoteError } from "./remote-error.js";
import type { StreamMultiplexer } from "./stream-multiplexer.js";

/**
 * rxjs 7의 미처리 오류 보고와 같은 규칙이다(rxjs가 `reportUnhandledError`를
 * export하지 않으므로 여기서 재현한다). `config.onUnhandledError`가 있으면
 * 호출하고, 없으면 다음 tick에서 던져 콘솔·전역 handler로 보낸다.
 */
function reportUnhandledError(error: unknown): void {
  if (config.onUnhandledError) {
    config.onUnhandledError(error);
  } else {
    setTimeout(() => {
      throw error;
    });
  }
}

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
  readonly #lifetime: ApiLifetime;
  readonly #key: string;
  readonly #kind: LocalGenerationKind;
  #generation: Generation<T> | undefined;
  #snapshot: RemoteStateSnapshot<T> = {
    status: "uninitialized",
    active: false,
  };
  // "generation이 열렸다" 내부 신호. `kind === "state"`일 때만 쓴다(event
  // generation은 아무도 등록하지 않으므로 자연히 비어 있다). `snapshotStore`가
  // 남이 연 generation에 합류하기 위한 유일한 통로다 — `RemoteState` 공개
  // 인터페이스에는 노출하지 않는다.
  readonly #openedListeners = new Set<() => void>();

  public constructor(
    multiplexer: StreamMultiplexer,
    lifetime: ApiLifetime,
    key: string,
    kind: LocalGenerationKind,
  ) {
    this.#multiplexer = multiplexer;
    this.#lifetime = lifetime;
    this.#key = key;
    this.#kind = kind;
  }

  /** state 전용 값이다. event에서는 읽지 않는다. */
  public get snapshot(): RemoteStateSnapshot<T> {
    return this.#snapshot;
  }

  /**
   * "generation이 열렸다" 신호를 구독한다. `onGenerationOpened`(모듈 export)
   * 를 통해서만 등록되며 `snapshotStore` 전용이다. 반환값은 해제 함수다.
   */
  public addOpenedListener(listener: () => void): () => void {
    this.#openedListeners.add(listener);
    let removed = false;
    return () => {
      if (removed) {
        return;
      }
      removed = true;
      this.#openedListeners.delete(listener);
    };
  }

  /**
   * `#openedListeners`를 순회하며 신호를 쏜다. 순회 중 해제된 listener는
   * 건너뛴다(store `notify`와 같은 규칙). listener별로 예외를 잡아 격리
   * 보고한다 — 하나가 던져도 나머지와 `subscribe()` 자체는 영향받지 않는다.
   */
  #notifyOpened(): void {
    for (const listener of [...this.#openedListeners]) {
      if (!this.#openedListeners.has(listener)) {
        continue;
      }
      try {
        listener();
      } catch (error) {
        reportUnhandledError(error);
      }
    }
  }

  public subscribe(subscriber: Subscriber<T>): TeardownLogic {
    // 종료 뒤에는 dispose 루프가 아직 complete하지 않은 활성 generation에도
    // 합류하지 않는다. 합류하면 현재값 재생과 늦은 complete를 받게 된다.
    // generation을 건드리지 않으므로 snapshot도 바뀌지 않는다.
    // 이 검사가 종료 뒤 subscribe의 유일한 차단 지점이다.
    if (this.#lifetime.disposed) {
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

    // 활성 generation일 때만 쏜다. `multiplexer.open`이 동기로 실패하면
    // generation이 이미 끝나 있을 수 있다 — 그 상태에서 신호를 쏘면
    // `snapshotStore`가 `open === false`로 보고 합류를 시도해 다시 실패하는
    // 재구독 루프가 된다(N8).
    if (
      opensGeneration &&
      this.#kind === "state" &&
      this.#generation === generation &&
      !generation.closed
    ) {
      this.#notifyOpened();
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

// `RemoteStateClient` → 자신의 `LocalGeneration`. `onGenerationOpened`가
// class 밖에서 `#local`(private 필드)에 접근할 수 없으므로 대신 쓴다.
// `RemoteStateClient` 인스턴스만 등록하며, 이 모듈 밖에는 노출하지 않는다.
const localGenerations = new WeakMap<
  RemoteState<unknown>,
  LocalGeneration<unknown>
>();

class RemoteStateClient<T> extends Observable<T> implements RemoteState<T> {
  readonly #local: LocalGeneration<T>;

  public constructor(
    multiplexer: StreamMultiplexer,
    lifetime: ApiLifetime,
    key: string,
  ) {
    const local = new LocalGeneration<T>(multiplexer, lifetime, key, "state");
    super((subscriber) => local.subscribe(subscriber));
    this.#local = local;
    localGenerations.set(
      this as RemoteState<unknown>,
      local as LocalGeneration<unknown>,
    );
  }

  public get snapshot(): RemoteStateSnapshot<T> {
    return this.#local.snapshot;
  }
}

export function createRemoteState<T>(
  multiplexer: StreamMultiplexer,
  lifetime: ApiLifetime,
  key: string,
): RemoteState<T> {
  return new RemoteStateClient<T>(multiplexer, lifetime, key);
}

/**
 * 내부 전용 — `renderer/index.ts`에서 재export하지 않는다, `snapshotStore`만
 * 쓴다. `state`가 이 모듈이 만든 `RemoteStateClient`가 아니면(사용자 fake
 * 등) `undefined`를 돌려준다 — 그 경우 `snapshotStore`는 RD-043 그대로
 * 이벤트 기반으로 동작한다.
 */
export function onGenerationOpened<T>(
  state: RemoteState<T>,
  listener: () => void,
): (() => void) | undefined {
  const local = localGenerations.get(state as RemoteState<unknown>) as
    LocalGeneration<T> | undefined;
  return local?.addOpenedListener(listener);
}

export function createRemoteEvent<T>(
  multiplexer: StreamMultiplexer,
  lifetime: ApiLifetime,
  key: string,
): Observable<T> {
  const local = new LocalGeneration<T>(multiplexer, lifetime, key, "event");
  return new Observable<T>((subscriber) => local.subscribe(subscriber));
}
