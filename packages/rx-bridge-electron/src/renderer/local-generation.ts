import {
  config,
  defer,
  Observable,
  ReplaySubject,
  share,
  Subject,
  type Subscriber,
  type TeardownLogic,
} from "rxjs";

import type { RemoteState, RemoteStateSnapshot } from "../contract/index.js";
import type { ApiLifetime } from "./api-lifetime.js";
import { createDisposedError } from "./remote-error.js";
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

type LocalGenerationKind = "state" | "event";

/**
 * generation(open→next*→close) 수명과 snapshot 상태기계를 한 곳에 둔다.
 * `kind`가 `"state"`일 때만 snapshot을 유지·전이하고 늦은 구독자에게 현재값을
 * replay한다. `"event"`는 generation 수명 관리만 공유하고 snapshot을 읽지
 * 않는다.
 *
 * 로컬 구독자 공유·마지막 해제 시 연결 해제·늦은 합류 재생·종료 뒤 새 연결은
 * `share`가 한다(ADR 0027). connector는 State면 `ReplaySubject(1)`, Event면
 * `Subject`이고 reset 3종은 기본값(`true`)이다. 원격 구독 하나(= generation
 * 하나)는 `#connect`가 만드는 연결 하나다. 재진입 순서는 rxjs 7 `share`의
 * 구현 순서에 기댄다 — 구독자를 connector에 먼저 붙인 뒤 source를 연결하고,
 * complete·error 때 reset을 구독자 통지보다 먼저 하며, `Subject.next`는 순회
 * 전에 구독자 목록을 복사한다. `local-generation-reentrancy.test.ts`가 이
 * 순서를 고정한다.
 */
class LocalGeneration<T> {
  readonly #multiplexer: StreamMultiplexer;
  readonly #lifetime: ApiLifetime;
  readonly #key: string;
  readonly #kind: LocalGenerationKind;
  readonly #shared: Observable<T>;
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
    this.#shared = defer(
      () => new Observable<T>((subscriber) => this.#connect(subscriber)),
    ).pipe(
      share<T>({
        connector: () =>
          kind === "state" ? new ReplaySubject<T>(1) : new Subject<T>(),
      }),
    );
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
    return this.#shared.subscribe(subscriber);
  }

  /**
   * generation 하나를 연다. `share`가 활성 연결이 없을 때만 부르고, 첫 로컬
   * 구독자는 이미 connector에 붙어 있다. snapshot은 구독자 통지보다 먼저
   * 반영한다. 반환한 teardown은 마지막 로컬 구독자가 해제될 때 `share`가
   * 부른다 — 원격 terminal로 이미 끝난 뒤에는 아무것도 하지 않는다.
   */
  #connect(subscriber: Subscriber<T>): TeardownLogic {
    let subscriptionId: string | undefined;
    let ended = false;
    const end = (): void => {
      ended = true;
      if (this.#kind === "state") {
        this.#markInactive();
      }
    };
    if (this.#kind === "state") {
      this.#snapshot = { status: "connecting", active: true };
    }
    this.#multiplexer.open(
      this.#key,
      {
        next: (value) => {
          if (ended) {
            return;
          }
          const typedValue = value as T;
          if (this.#kind === "state") {
            this.#snapshot = {
              status: "current",
              active: true,
              value: typedValue,
            };
          }
          subscriber.next(typedValue);
        },
        error: (error) => {
          if (ended) {
            return;
          }
          end();
          subscriber.error(error);
        },
        complete: () => {
          if (ended) {
            return;
          }
          end();
          subscriber.complete();
        },
      },
      (id) => {
        subscriptionId = id;
      },
    );

    // 활성 generation일 때만 쏜다. `multiplexer.open`이 동기로 실패하면
    // generation이 이미 끝나 있을 수 있다 — 그 상태에서 신호를 쏘면
    // `snapshotStore`가 `open === false`로 보고 합류를 시도해 다시 실패하는
    // 재구독 루프가 된다(N8).
    if (this.#kind === "state" && !ended) {
      this.#notifyOpened();
    }

    return () => {
      if (ended) {
        return;
      }
      end();
      if (subscriptionId !== undefined) {
        this.#multiplexer.close(subscriptionId);
      }
    };
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
 * 등) `undefined`를 돌려준다 — 그 경우 `snapshotStore`는 generation 합류
 * 없이 이벤트 기반으로만 동작한다.
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
