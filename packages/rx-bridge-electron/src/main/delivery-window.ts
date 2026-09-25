import type { BridgeValue, RpcErrorPayload } from "../protocol/index.js";
import type { LibraryErrorPayload } from "../protocol/messages.js";
import { BoundedQueue } from "./bounded-queue.js";
import type { OverflowPolicy } from "./sources.js";

/**
 * consumer 1건의 전달 창(RD-034, ADR 0020 결정 3)이 반환하는 wire 메시지.
 * envelope와 `subscriptionId`는 붙어 있지 않다 — 호출자(`Subscriptions`)가
 * `withEnvelope`로 조립한다.
 */
export type WindowMessage =
  | { readonly type: "subscribed"; readonly sequence: 0 }
  | {
      readonly type: "batch";
      readonly sequence: number;
      readonly values: readonly [BridgeValue];
    }
  | { readonly type: "complete"; readonly sequence: number }
  | {
      readonly type: "error";
      readonly sequence: number;
      readonly error: RpcErrorPayload;
    };

/** `end()`에 넘기는 terminal 기록. sequence는 없다 — 창이 반환 시점에 매긴다. */
export type WindowTerminal =
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly error: RpcErrorPayload };

/**
 * `accept()` 반환. `overflowed`는 이 호출이 `STREAM_OVERFLOW` terminal을 새로
 * 기록했는지다 — 호출자는 이 값으로 terminal 기록 직후 source를 분리한다.
 */
export interface AcceptResult {
  readonly message: WindowMessage | undefined;
  readonly overflowed: boolean;
}

/**
 * `end()` 반환. `recorded`가 `false`면 이미 종결·닫힘이거나 terminal이 이미
 * 기록돼 있어 "무시됨"이라는 뜻이다. `true`면 호출자는 source를 분리한 뒤
 * `message`(있으면)를 보낸다.
 */
export interface EndResult {
  readonly recorded: boolean;
  readonly message: WindowMessage | undefined;
}

/**
 * 창 진단 callback. 발생 지점에서 동기로 호출되고, 창은 callback이 돌아온 뒤
 * 자기 상태를 다시 확인한다. State 버퍼에서는 호출되지 않는다.
 */
export interface DeliveryWindowCallbacks {
  readonly onDropped?: (count: number) => void;
  readonly onQueueDepth?: (depth: number) => void;
}

interface PushOutcome {
  readonly dropped: number;
  readonly overflow: boolean;
  /** `undefined`면 이 push는 진단 대상이 아니다(State). */
  readonly depth: number | undefined;
}

interface ShiftOutcome {
  readonly hasValue: boolean;
  readonly value: BridgeValue | undefined;
  /** `undefined`면 이 shift는 진단 대상이 아니다(State). */
  readonly depth: number | undefined;
}

/**
 * State·Event 버퍼 차이를 감추는 공용 인터페이스. `depth`가 `undefined`인지
 * 여부만으로 창이 진단 callback 호출을 결정하므로, `DeliveryWindow` 안에는
 * kind 분기가 없다.
 */
interface DeliveryBuffer {
  push(value: BridgeValue): PushOutcome;
  shift(): ShiftOutcome;
  /** `preempt()`에서 대기 값을 모두 버릴 때 쓴다. */
  discardAll(): void;
  /** 대기 값 수. */
  readonly pendingCount: number;
}

/**
 * State buffer 정책: 최신값 1칸 덮어쓰기. push는 이전 값을 버리고 drop·진단이
 * 없다. `queuedValueCount()`에는 항상 0으로 잡힌다 — 내부에 값이 있어도
 * 대기 "큐"로 취급하지 않는다(`queuedEvents` 진단 값 보존).
 */
function createStateBuffer(): DeliveryBuffer {
  let hasValue = false;
  let value: BridgeValue | undefined;
  return {
    push(next) {
      hasValue = true;
      value = next;
      return { dropped: 0, overflow: false, depth: undefined };
    },
    shift() {
      if (!hasValue) {
        return { hasValue: false, value: undefined, depth: undefined };
      }
      const current = value;
      hasValue = false;
      value = undefined;
      return { hasValue: true, value: current, depth: undefined };
    },
    discardAll() {
      hasValue = false;
      value = undefined;
    },
    get pendingCount() {
      return 0;
    },
  };
}

/**
 * Event buffer 정책: `BoundedQueue` 래핑. push·shift 뒤 depth를 창에 알려
 * `stream-queue` 진단 callback을 유도하고, push의 `dropped`·`overflow`를
 * 그대로 전달한다.
 */
function createEventBuffer(
  capacity: number,
  overflow: OverflowPolicy,
): DeliveryBuffer {
  const queue = new BoundedQueue<BridgeValue>(capacity, overflow);
  return {
    push(value) {
      const result = queue.push(value);
      return {
        dropped: result.dropped,
        overflow: result.overflow,
        depth: queue.length,
      };
    },
    shift() {
      if (queue.length === 0) {
        return { hasValue: false, value: undefined, depth: undefined };
      }
      const value = queue.shift();
      return { hasValue: true, value, depth: queue.length };
    },
    discardAll() {
      while (queue.length > 0) queue.shift();
    },
    get pendingCount() {
      return queue.length;
    },
  };
}

const overflowError: LibraryErrorPayload = {
  code: "STREAM_OVERFLOW",
  message: "Event buffer capacity exceeded.",
};

/**
 * consumer 1건의 전달 창. "수락 → ack 대기 → 다음 값 | terminal"과 선점 종료
 * (ADR 0020 결정 3)를 소유한다. 순수 반환형이다 — 전송·envelope 조립·source
 * 분리는 호출자(`Subscriptions`)가 맡는다. State/Event 차이는 생성 시 주입한
 * `DeliveryBuffer` 하나로만 표현되고, 이 클래스 안에는 `kind` 분기가 없다.
 *
 * 시작 전 거부(`createRejectionDeliveryWindow`)도 이 창이 sequence를 매긴다
 * — `open()`으로 0, 뒤이은 `preempt()`로 1을 받는다. `accept`·`ack`·`end`는
 * 거부 경로에서 쓰이지 않는다.
 *
 * 상태는 두 단계다. "종결"은 terminal 메시지를 반환했거나 `preempt`한
 * 뒤이고, "닫힘"은 `close()` 뒤다. 종결 뒤에도 `close()` 전까지는 `closed`가
 * `false`다 — 수명 정리 멱등성은 `close()`의 반환값에 달려 있기 때문이다.
 */
export class DeliveryWindow {
  readonly #buffer: DeliveryBuffer;
  readonly #onDropped: (count: number) => void;
  readonly #onQueueDepth: (depth: number) => void;
  #sequence = 0;
  #inFlight: number | undefined;
  #pendingTerminal: WindowTerminal | undefined;
  /** terminal 메시지를 반환했거나 `preempt`한 뒤("종결"). */
  #concluded = false;
  /** `close()` 호출 여부("닫힘"). */
  #closed = false;

  public constructor(
    buffer: DeliveryBuffer,
    callbacks: DeliveryWindowCallbacks = {},
  ) {
    this.#buffer = buffer;
    this.#onDropped = callbacks.onDropped ?? ((): void => {});
    this.#onQueueDepth = callbacks.onQueueDepth ?? ((): void => {});
  }

  /**
   * 창을 연다. sequence 0의 `subscribed`를 반환한다. 이후 sequence도 모두
   * 창이 매긴다 — 시작 전 거부 창의 `preempt()`(sequence 1)도 포함이다.
   */
  public open(): WindowMessage {
    return { type: "subscribed", sequence: 0 };
  }

  /** 대기 값 수. Event는 buffer depth, State는 항상 0이다. */
  public queuedValueCount(): number {
    return this.#buffer.pendingCount;
  }

  /**
   * `close()` 호출 여부. 종결(terminal 반환·`preempt`) 상태는 포함하지 않는다 —
   * 호출자는 이 값으로 "그 사이 `close()`가 동기로 불렸는가"만 확인한다.
   */
  public get closed(): boolean {
    return this.#closed;
  }

  /**
   * 새 값을 받는지 여부. 종결·닫힘이거나 terminal이 기록돼 있으면 `false`다 —
   * terminal 기록 뒤 도착한 값은 ack 대기 중이어도 버린다. 호출자는 값을
   * 검증(`parseOutput`)하기 전에 이 값을 확인한다.
   */
  public get accepting(): boolean {
    return (
      !this.#closed && !this.#concluded && this.#pendingTerminal === undefined
    );
  }

  /**
   * 값 하나를 수락한다. `accepting`이 아니면 무시한다. buffer에 push하고,
   * Event면 `onDropped`(dropped > 0) → `onQueueDepth`(push 뒤 depth) 순으로
   * 부른다. 각 callback 직후 상태를 다시 확인하고, 종결·닫힘이면 남은
   * callback 없이 무출력으로 반환한다(닫힌 구독의 진단 꼬리 방지). 그 뒤
   * overflow면 `STREAM_OVERFLOW` terminal을 기록하고 flush 규칙을 적용한다.
   */
  public accept(value: BridgeValue): AcceptResult {
    if (!this.accepting) {
      return { message: undefined, overflowed: false };
    }
    const result = this.#buffer.push(value);
    if (result.dropped > 0) {
      this.#onDropped(result.dropped);
      if (this.#closed || this.#concluded) {
        return { message: undefined, overflowed: false };
      }
    }
    if (result.depth !== undefined) this.#onQueueDepth(result.depth);
    if (this.#closed || this.#concluded) {
      return { message: undefined, overflowed: false };
    }
    let overflowed = false;
    if (result.overflow && this.#pendingTerminal === undefined) {
      this.#pendingTerminal = { type: "error", error: overflowError };
      overflowed = true;
    }
    return { message: this.#flush(), overflowed };
  }

  /** 대기 중인 batch를 ack한다. 종결·닫힘이거나 `sequence`가 다르면 무시한다. */
  public ack(sequence: number): WindowMessage | undefined {
    if (this.#closed || this.#concluded) return undefined;
    if (sequence !== this.#inFlight) return undefined;
    this.#inFlight = undefined;
    return this.#flush();
  }

  /**
   * terminal을 기록한다. 이미 종결·닫힘이거나 terminal이 기록돼 있으면
   * `recorded: false`(무시됨)를 돌려준다. 아니면 기록하고 flush를 적용한 뒤
   * `recorded: true`와 flush 결과(있으면)를 돌려준다.
   */
  public end(terminal: WindowTerminal): EndResult {
    if (
      this.#closed ||
      this.#concluded ||
      this.#pendingTerminal !== undefined
    ) {
      return { recorded: false, message: undefined };
    }
    this.#pendingTerminal = terminal;
    return { recorded: true, message: this.#flush() };
  }

  /**
   * 선점 종료(ADR 0020 결정 3). 종결·닫힘이면 무시한다. 아니면 대기 값·
   * ack 대기 중이던 sequence·기록된 terminal을 모두 버리고, 다음 sequence로
   * `error`를 반환한 뒤 종결 상태가 된다.
   */
  public preempt(error: RpcErrorPayload): WindowMessage | undefined {
    if (this.#closed || this.#concluded) return undefined;
    this.#buffer.discardAll();
    this.#inFlight = undefined;
    this.#pendingTerminal = undefined;
    this.#concluded = true;
    const sequence = ++this.#sequence;
    return { type: "error", sequence, error };
  }

  /** 창을 닫는다. 처음 호출에서만 `true`를 돌려준다 — 호출자의 수명 정리 멱등성이 이 값에 달려 있다. 이후 모든 입력은 무출력이다. */
  public close(): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    return true;
  }

  /**
   * flush 규칙: `inFlight`가 없고 대기 값이 있으면 shift한다(Event면
   * `onQueueDepth`를 부르고, 그 재진입으로 종결·닫히면 꺼낸 값을 버리고
   * 아무것도 반환하지 않는다 — terminal 뒤 batch 방지). 아니면 sequence를
   * 올려 `inFlight`로 기록한 뒤 `batch`를 반환한다. 송신 전에 기록하므로
   * 동기 `send` 안에서 재진입한 `ack`이 곧바로 다음 값을 꺼낸다. 대기 값이 없고 terminal이 기록돼
   * 있으면 terminal 메시지를 반환하고 종결 상태가 된다.
   */
  #flush(): WindowMessage | undefined {
    if (this.#closed || this.#concluded || this.#inFlight !== undefined) {
      return undefined;
    }
    const shifted = this.#buffer.shift();
    if (shifted.hasValue) {
      if (shifted.depth !== undefined) this.#onQueueDepth(shifted.depth);
      if (this.#closed || this.#concluded) return undefined;
      const sequence = ++this.#sequence;
      this.#inFlight = sequence;
      return {
        type: "batch",
        sequence,
        values: [shifted.value as BridgeValue],
      };
    }
    if (this.#pendingTerminal !== undefined) {
      const terminal = this.#pendingTerminal;
      const sequence = ++this.#sequence;
      this.#concluded = true;
      return terminal.type === "complete"
        ? { type: "complete", sequence }
        : { type: "error", sequence, error: terminal.error };
    }
    return undefined;
  }
}

/** State consumer용 창을 만든다. */
export function createStateDeliveryWindow(
  callbacks?: DeliveryWindowCallbacks,
): DeliveryWindow {
  return new DeliveryWindow(createStateBuffer(), callbacks);
}

/**
 * Event consumer용 창을 만든다. `capacity`·`overflow`는 registration이 이미
 * 검증·동결한 값을 그대로 받는다 — 여기서는 다시 검증하지 않는다.
 */
export function createEventDeliveryWindow(
  capacity: number,
  overflow: OverflowPolicy,
  callbacks?: DeliveryWindowCallbacks,
): DeliveryWindow {
  return new DeliveryWindow(createEventBuffer(capacity, overflow), callbacks);
}

/**
 * 시작하지 못한 구독(admission 거부, 시작 전 거부, 대기 중 retire) 통지 전용
 * 창을 만든다. 호출자는 `open()`과 `preempt(error)`만 쓴다 —
 * `subscribed`(0)에 이어 `error`(1)를 매긴다. `accept`·`ack`·`end`로 이어질
 * 값이 없으므로 버퍼는 채워지지 않고, 진단 callback도 없다.
 */
export function createRejectionDeliveryWindow(): DeliveryWindow {
  return new DeliveryWindow(createStateBuffer());
}
