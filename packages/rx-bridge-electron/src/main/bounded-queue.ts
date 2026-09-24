import type { OverflowPolicy } from "./sources.js";

export interface QueuePushResult {
  readonly dropped: number;
  readonly overflow: boolean;
}

/** A fixed-capacity pending queue; the acknowledged batch is held separately. */
export class BoundedQueue<T> {
  readonly #items: (T | undefined)[];
  readonly #policy: OverflowPolicy;
  #head = 0;
  #length = 0;

  public constructor(capacity: number, policy: OverflowPolicy) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new TypeError("Queue capacity must be a positive safe integer.");
    }
    this.#items = new Array<T | undefined>(capacity);
    this.#policy = policy;
  }

  public get length(): number {
    return this.#length;
  }

  public push(value: T): QueuePushResult {
    if (this.#length === this.#items.length) {
      if (this.#policy === "error") return { dropped: 1, overflow: true };
      if (this.#policy === "drop-newest")
        return { dropped: 1, overflow: false };
      this.#items[this.#head] = value;
      this.#head = (this.#head + 1) % this.#items.length;
      return { dropped: 1, overflow: false };
    }
    this.#items[(this.#head + this.#length) % this.#items.length] = value;
    this.#length += 1;
    return { dropped: 0, overflow: false };
  }

  public shift(): T | undefined {
    if (this.#length === 0) return undefined;
    const value = this.#items[this.#head];
    this.#items[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#items.length;
    this.#length -= 1;
    return value;
  }
}
