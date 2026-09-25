import type { DocumentSession } from "./document-sessions.js";

/**
 * `SessionSlots.acquire()`가 돌려주는 lease 1개. slot 1개를 쥔 채 살아
 * 있다가 `release()`로 반납한다. retire 통지는 `onRetire`로 이 lease에
 * 등록·해제한다 — slot 반납과 통지 등록은 독립이다(ADR 0009 §10·§11:
 * handler·구독이 실제로 끝날 때 slot을 반납하는 경로와, retire 즉시 slot을
 * 반납하는 경로가 둘 다 있다).
 */
export interface SlotLease {
  /**
   * slot을 반납하고 등록된 listener(있으면)를 해제한다. 멱등 — 두 번째
   * 호출부터는 아무 일도 하지 않는다.
   */
  release(): void;
  /** `release()` 호출 여부. */
  readonly released: boolean;
  /**
   * retire 통지를 등록한다. release된 lease면 등록은 남기지 않는다 —
   * 호출 시점에 세션이 이미 retire 상태면 listener를 동기 1회 호출하고,
   * 아직 살아 있으면 아무 일도 하지 않는다(no-op, 이후 그 세션이 retire돼도
   * 호출되지 않는다). _(개정: DELTA-04 — 옛 `session.onRetire`는 "release"
   * 개념이 없어 세션이 이미 retire됐으면 등록 즉시 항상 호출했다. release된
   * lease를 완전히 무시하면 이 동작이 달라진다. 사용자 확인 2026-09-25.)_
   * release되지 않은 lease는: 이미 등록된 listener가 있으면 `Error`를
   * 던진다 — 등록은 한 번에 하나뿐이다(호출자는 `offRetire()`로 먼저
   * 해제한 뒤 다시 등록한다). 세션이 이미 retire됐으면 반환 전에 listener를
   * 동기 호출하고, 호출 뒤에는 등록이 남지 않는다(다시 `onRetire`를 부르면
   * 즉시 다시 호출된다). 살아 있는 세션이면 `session.onRetire`에 위임해
   * 등록하고, retire 시 등록 상태를 먼저 비운 뒤 listener를 1회 호출한다 —
   * listener 안에서 `release()`·`offRetire()`를 불러도 안전하다.
   */
  onRetire(listener: () => void): void;
  /**
   * 등록된 listener만 해제한다. slot은 유지한다. 등록이 없으면 no-op.
   * 해제 뒤 `onRetire`로 다시 등록할 수 있다.
   */
  offRetire(): void;
}

/** `SlotLease` 구현. `SessionSlots`가 lease를 반납할 때 부를 콜백만 받는다 — 자기 세션별·전역 집계는 모른다. */
class LeaseImpl implements SlotLease {
  readonly #session: DocumentSession;
  readonly #releaseSlot: () => void;
  #released = false;
  #unregister: (() => void) | undefined;

  public constructor(session: DocumentSession, releaseSlot: () => void) {
    this.#session = session;
    this.#releaseSlot = releaseSlot;
  }

  public get released(): boolean {
    return this.#released;
  }

  public release(): void {
    if (this.#released) return;
    this.#released = true;
    const unregister = this.#unregister;
    this.#unregister = undefined;
    unregister?.();
    this.#releaseSlot();
  }

  public onRetire(listener: () => void): void {
    if (this.#released) {
      // 등록 상태(#unregister)는 release() 뒤 항상 undefined다 — 여기서는
      // 아무것도 등록하지 않는다. 세션이 이미 retire 상태면 옛
      // `session.onRetire`와 같은 관측 결과를 위해 즉시 1회만 호출한다.
      if (this.#session.retireReason !== undefined) listener();
      return;
    }
    if (this.#unregister !== undefined) {
      throw new Error("SlotLease.onRetire: a listener is already registered.");
    }
    let firedDuringRegister = false;
    const unregister = this.#session.onRetire(() => {
      firedDuringRegister = true;
      this.#unregister = undefined;
      listener();
    });
    // 이미 retire된 세션이면 위 등록 호출 안에서 listener가 동기 호출되고
    // `#unregister`가 비워진다 — 그 경우 방금 받은 해제 handle을 저장하지
    // 않는다(저장하면 이미 호출된 listener가 "등록돼 있다"는 상태로
    // 남는다).
    if (!firedDuringRegister) this.#unregister = unregister;
  }

  public offRetire(): void {
    const unregister = this.#unregister;
    if (unregister === undefined) return;
    this.#unregister = undefined;
    unregister();
  }
}

/**
 * 세션 소유 자원 1건(RPC 요청 1건, 구독 1건)의 slot 한도 판정·반납·전역
 * 집계와 retire listener 연동을 소유하는 module(RD-041). `RpcRequests`가
 * `maxConcurrentRpc`용, `Subscriptions`가 `maxSubscriptions`용으로 각자
 * 인스턴스 하나씩 생성자 안에서 만든다.
 *
 * `count()`는 release 전 lease 수다 — retire된 세션의 미반납 lease도
 * release 전까지 계속 센다(ADR 0010 §10 `rpcInFlight`, ADR 0009 §11
 * 구독 계산과 같은 의미). slot이 줄어드는 시점(=`release()` 호출 시점)은
 * 호출자가 정한다 — RPC는 handler가 실제로 끝날 때, 구독은 경로별로
 * 즉시이거나 늦다(ADR 0009 §10·§11). id → entry map, 중복 요청 선취소,
 * watermark, wire 진단은 이 module이 모른다 — `type DocumentSession`만
 * import한다.
 */
export class SessionSlots {
  readonly #limitPerSession: number;
  readonly #counts = new WeakMap<DocumentSession, number>();
  #global = 0;

  public constructor(limitPerSession: number) {
    this.#limitPerSession = limitPerSession;
  }

  /**
   * 그 세션의 미반납 lease 수가 한도 이상이면 `undefined`. 아니면 새
   * lease를 돌려주고 세션별 수·전역 수를 1 올린다. retire된 세션에서도
   * 한도 안이면 얻을 수 있다.
   */
  public acquire(session: DocumentSession): SlotLease | undefined {
    const current = this.#counts.get(session) ?? 0;
    if (current >= this.#limitPerSession) return undefined;
    this.#counts.set(session, current + 1);
    this.#global += 1;
    return new LeaseImpl(session, () => this.#release(session));
  }

  /** 전역 미반납 lease 수. 순회는 제공하지 않는다. */
  public count(): number {
    return this.#global;
  }

  #release(session: DocumentSession): void {
    const current = this.#counts.get(session) ?? 0;
    if (current <= 1) this.#counts.delete(session);
    else this.#counts.set(session, current - 1);
    this.#global -= 1;
  }
}
