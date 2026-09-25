import { Observable, Subscriber, type Subscription } from "rxjs";

import type { BridgeContext } from "../contract/impl-types.js";
import type { BridgeValue } from "../protocol/index.js";
import type {
  EventRegistrationEntry,
  StateRegistrationEntry,
} from "./registration.js";

/**
 * `Subscriptions`(구독 1건의 창·envelope·진단)에서 upstream 연결 자체를 떼어낸
 * 내부 module. 소유 불변식:
 *
 * - State·broadcast Event는 key(`registration.bridgeOperation.key`)별로
 *   upstream 하나를 공유한다. scoped Event는 연결마다 factory가 만든
 *   upstream을 혼자 쓴다.
 * - 늦게 합류한 State 토큰은 upstream을 구독하는 대신 그 자리에서
 *   `getValue()`를 한 번 읽어 자기 sink에만 동기로 전달한다. 이미 연결된
 *   토큰은 다시 받지 않는다. broadcast Event는 늦은 합류 값이 없다.
 * - 연결 요청은 사용자 코드(scoped factory, 늦은 합류 `getValue()`)를 부르기
 *   전에 토큰을 등록하고, 부른 뒤 토큰이 여전히 연결 중인지 다시 확인한다.
 *   사용자 코드 안에서 동기 `disconnect`가 같은 토큰을 끊을 수 있기
 *   때문이다 — 그러면 이어서 진행하지 않는다.
 * - 연결 요청이 던지면 그 토큰은 연결되지 않은 상태로 남는다(공유 member에서도
 *   빠지고, 마지막 member였으면 upstream도 해지된다). `disconnect`는 이미
 *   없는 토큰에는 아무 일도 하지 않는다.
 * - 공유 upstream의 `next`·`error`·`complete`는 그 시점의 member 스냅샷을
 *   순회하고, 각 member를 부르기 직전에 그 토큰이 아직 이 공유에 연결돼
 *   있는지 확인한다. 앞선 member의 sink가 동기로 뒤 member를 `disconnect`하면
 *   그 값·terminal은 전달되지 않는다.
 * - 공유 entry를 map에서 지울 때는 그 key의 현재 값이 지우려는 entry와 같은
 *   객체일 때만 지운다. 옛 토큰의 뒤늦은 `disconnect`가 같은 key로 새로 생긴
 *   공유를 건드리지 않게 하기 위해서다.
 * - upstream terminal(`error`·`complete`) 뒤 공유 entry 정리는 이 module이
 *   하지 않는다. 각 member의 sink가 받은 뒤 자기 토큰으로 `disconnect`를
 *   불러야 정리된다 — `Subscriptions`는 terminal을 기록하면서 해제한다.
 * - `disconnect`는 호출자 identity(토큰 객체)로만 식별하고 멱등이다. 호출자는
 *   handle을 저장하지 않는다.
 * - 사용자 source의 teardown 예외는 이 module 밖으로 나가지 않는다(RD-045).
 *   upstream 해지는 `#release` 한 곳을 거치며, 예외를 잡아 생성자 콜백
 *   `onTeardownError(key)`로 알린다. 공유 entry는 해지 전에 map에서 지운다 —
 *   해지가 던져도 같은 key의 다음 연결은 새 upstream을 만든다. 동기 방출 중
 *   이미 닫힌 upstream에 teardown이 붙으며 던지면(rxjs가 그 자리에서 실행한다)
 *   `subscribe` 호출의 예외도 같은 콜백으로 알리고 삼킨다.
 *
 * 이 module이 모르는 것: `DocumentSession`, `authorize`, 전달 창
 * (`DeliveryWindow`), 진단(`DiagnosticsSink` — teardown 예외는 콜백으로만
 * 알린다), wire envelope. upstream
 * `error`는 원래 값을 그대로 sink로 넘긴다 — 내부 오류로 번역하는 것은
 * `Subscriptions`가 한다.
 */

/** upstream이 값·terminal을 전달하는 대상. observer 모양이다. */
export interface UpstreamSink {
  next(value: BridgeValue): void;
  error(error: unknown): void;
  complete(): void;
}

export type UpstreamRegistration =
  StateRegistrationEntry | EventRegistrationEntry;

/** key 하나를 공유하는 upstream 1개와 그 member(토큰→sink) 집합. */
interface SharedEntry {
  readonly key: string;
  readonly members: Map<object, UpstreamSink>;
  upstream?: Subscription;
}

/** 토큰 하나의 연결 기록. `connecting`은 사용자 코드를 부르는 동안의 자리표시다. */
type TokenEntry =
  | { readonly kind: "connecting" }
  | {
      readonly kind: "scoped";
      readonly key: string;
      readonly subscriber: Subscriber<BridgeValue>;
    }
  | { readonly kind: "shared"; readonly shared: SharedEntry };

export class Upstreams {
  readonly #shared = new Map<string, SharedEntry>();
  readonly #tokens = new WeakMap<object, TokenEntry>();
  readonly #onTeardownError: (key: string) => void;

  /** `onTeardownError`는 사용자 teardown이 던질 때 그 upstream의 key로 불린다. 생략하면 조용히 삼킨다. */
  public constructor(onTeardownError: (key: string) => void = () => {}) {
    this.#onTeardownError = onTeardownError;
  }

  /**
   * 토큰을 upstream에 연결한다. State·broadcast Event는 공유 갈래, scoped
   * Event는 개별 갈래를 탄다(`registration`이 어느 쪽인지 정한다).
   *
   * scoped factory 예외나 non-Observable 반환, 늦은 합류 `getValue()` 예외는
   * 이 호출이 동기로 던진다. 던지기 전에 `disconnect(token)`으로 정리하므로
   * 토큰은 연결되지 않은 상태로 남고, 그 토큰이 공유의 마지막 member였으면
   * upstream도 해지된다(사용자 코드가 다른 member를 동기로 끊었을 수 있다).
   */
  public connect(
    token: object,
    registration: UpstreamRegistration,
    context: BridgeContext,
    sink: UpstreamSink,
  ): void {
    try {
      this.#connect(token, registration, context, sink);
    } catch (error) {
      this.disconnect(token);
      throw error;
    }
  }

  /**
   * 토큰의 연결을 끊는다. 미연결 토큰이면 아무 일도 하지 않는다(멱등). 공유
   * member가 이 토큰을 마지막으로 빠지면 그 key의 현재 entry가 이 entry와 같을
   * 때만 map에서 지우고, 그다음 upstream을 해지한다. 해지 예외는 던지지 않는다.
   */
  public disconnect(token: object): void {
    const entry = this.#tokens.get(token);
    if (entry === undefined) return;
    this.#tokens.delete(token);
    if (entry.kind === "scoped") {
      this.#release(entry.subscriber, entry.key);
      return;
    }
    if (entry.kind === "shared") {
      const shared = entry.shared;
      shared.members.delete(token);
      if (shared.members.size === 0) {
        if (this.#shared.get(shared.key) === shared)
          this.#shared.delete(shared.key);
        if (shared.upstream !== undefined)
          this.#release(shared.upstream, shared.key);
      }
    }
    // kind === "connecting": 등록만 지우면 된다. connect() 쪽이 사용자 코드
    // 뒤 이 토큰이 사라졌는지 확인해 더 진행하지 않는다.
  }

  #connect(
    token: object,
    registration: UpstreamRegistration,
    context: BridgeContext,
    sink: UpstreamSink,
  ): void {
    if (registration.kind === "state") {
      this.#connectShared(
        token,
        registration.bridgeOperation.key,
        registration.source,
        sink,
        () => registration.source.getValue(),
      );
      return;
    }
    if (registration.delivery.mode === "broadcast") {
      this.#connectShared(
        token,
        registration.bridgeOperation.key,
        registration.delivery.source,
        sink,
        undefined,
      );
      return;
    }
    this.#connectScoped(
      token,
      registration.bridgeOperation.key,
      registration.delivery.factory,
      context,
      sink,
    );
  }

  /** upstream을 해지한다. 사용자 teardown 예외는 `onTeardownError(key)`로 알리고 삼킨다. */
  #release(upstream: Subscription, key: string): void {
    try {
      upstream.unsubscribe();
    } catch {
      this.#onTeardownError(key);
    }
  }

  /**
   * `source`를 `upstream`으로 구독한다. 던졌는데 `upstream`이 이미 닫혀
   * 있으면 동기 방출 중 해지된 구독에 붙은 teardown이 그 자리에서 던진
   * 것이다 — `onTeardownError(key)`로 알리고 삼킨다. 닫히지 않았으면 다시
   * 던진다(`connect`가 정리한다).
   */
  #subscribe(
    source: Observable<BridgeValue>,
    upstream: Subscriber<BridgeValue>,
    key: string,
  ): void {
    try {
      source.subscribe(upstream);
    } catch (error) {
      if (!upstream.closed) throw error;
      this.#onTeardownError(key);
    }
  }

  /**
   * scoped 갈래: 토큰마다 factory가 만든 upstream을 혼자 쓴다. 순서는
   * 토큰을 `connecting`으로 선등록 → factory 호출 → 재확인 → Observable 검사
   * → `Subscriber` 저장 → subscribe다. `Subscriber`를 subscribe 전에 저장해야
   * 동기 방출 중 `disconnect`가 그 `Subscriber`를 끊는다(rxjs가 이후 알림을
   * 막는다).
   */
  #connectScoped(
    token: object,
    key: string,
    factory: (context: BridgeContext) => Observable<BridgeValue>,
    context: BridgeContext,
    sink: UpstreamSink,
  ): void {
    this.#tokens.set(token, { kind: "connecting" });
    const source = factory(context);
    if (this.#tokens.get(token)?.kind !== "connecting") return;
    if (!(source instanceof Observable))
      throw new TypeError("Scoped factory must return an Observable.");
    const subscriber = new Subscriber<BridgeValue>({
      next: (value) => sink.next(value),
      error: (error: unknown) => sink.error(error),
      complete: () => sink.complete(),
    });
    this.#tokens.set(token, { kind: "scoped", key, subscriber });
    this.#subscribe(source, subscriber, key);
  }

  /**
   * State·broadcast Event 공용 공유 갈래. 순서는 entry 확보 → member 추가
   * → (첫 member면) `Subscriber` 저장 후 subscribe, (늦은 합류 State면) member
   * 추가 뒤 `getValue()`를 동기로 sink에 전달이다. 첫 member의 현재값은
   * `getValue()`가 아니라 upstream subscribe의 방출로 온다.
   *
   * `getValue`가 `undefined`면 늦은 합류 값이 없는 갈래(broadcast Event)다.
   */
  #connectShared(
    token: object,
    key: string,
    source: Observable<BridgeValue>,
    sink: UpstreamSink,
    getValue: (() => BridgeValue) | undefined,
  ): void {
    let shared = this.#shared.get(key);
    const isNew = shared === undefined;
    if (shared === undefined) {
      shared = { key, members: new Map<object, UpstreamSink>() };
      this.#shared.set(key, shared);
    }
    const entry = shared;
    entry.members.set(token, sink);
    this.#tokens.set(token, { kind: "shared", shared: entry });

    if (isNew) {
      const upstream = new Subscriber<BridgeValue>({
        next: (value) => this.#fanOut(entry, (member) => member.next(value)),
        error: (error: unknown) =>
          this.#fanOut(entry, (member) => member.error(error)),
        complete: () => this.#fanOut(entry, (member) => member.complete()),
      });
      entry.upstream = upstream;
      this.#subscribe(source, upstream, key);
      if (entry.members.size === 0) this.#release(upstream, key);
      return;
    }

    if (getValue === undefined) return;
    const value = getValue();
    const current = this.#tokens.get(token);
    if (
      current === undefined ||
      current.kind !== "shared" ||
      current.shared !== entry
    )
      return;
    sink.next(value);
  }

  /**
   * 공유 upstream의 `next`·`error`·`complete`를 member 스냅샷에 fan-out한다.
   * 각 member를 부르기 직전에 그 토큰이 아직 이 entry에 연결돼 있는지
   * 확인한다 — 앞 member의 sink가 동기로 뒤 member를 `disconnect`했으면
   * 건너뛴다.
   */
  #fanOut(entry: SharedEntry, deliver: (sink: UpstreamSink) => void): void {
    for (const [token, sink] of [...entry.members]) {
      const current = this.#tokens.get(token);
      if (
        current === undefined ||
        current.kind !== "shared" ||
        current.shared !== entry
      )
        continue;
      deliver(sink);
    }
  }
}
