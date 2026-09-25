/**
 * 사용자 source의 teardown이 throw할 때 Main 구독 정리가 격리되는지 확인한다
 * (ROADMAP RD-045). rxjs 7은 teardown throw를 `UnsubscriptionError`로 다시
 * 던진다. 세션 retire 연쇄(abort listener 안), 공유 upstream entry 정리,
 * `server.dispose()`, 전송 실패 뒤 close, 동기 방출 중 이미 닫힌 upstream에
 * teardown이 붙는 경로를 server seam에서 구독하며 검증한다. 각 경로는 예외를
 * 밖으로 내보내지 않고 `upstream-teardown-failed` 진단을 key와 함께 1건
 * 남겨야 한다. Main `uncaughtException`은 테스트 동안 vitest listener를 떼고
 * 직접 모아 본다.
 */
import { BehaviorSubject, Observable, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import {
  createBridgeServer,
  type BridgeDiagnostic,
} from "../../src/main/index.js";
import {
  broadcastEvent,
  currentValueSource,
  scopedEvent,
} from "../../src/main/sources.js";
import { FakeTarget } from "./fake-ipc.js";
import {
  rendererDocument,
  type TestSubscription,
} from "./renderer-document.js";

const STATE = "state:hardware/current$";
const EVENT = "event:hardware/change$";

/**
 * 구독마다 `subject`에 붙고, 해제 때 붙은 구독을 끊은 뒤 throw하는
 * Observable을 만든다. `subscriptions`는 upstream이 실제로 구독된 횟수다 —
 * 공유 entry가 새로 연결됐는지 판정하는 데 쓴다.
 */
function teardownThrowing<T>(subject: Subject<T>) {
  let subscriptions = 0;
  const source = new Observable<T>((subscriber) => {
    subscriptions += 1;
    const inner = subject.subscribe(subscriber);
    return () => {
      inner.unsubscribe();
      throw new Error("teardown boom");
    };
  });
  return { source, subscriptions: () => subscriptions };
}

/**
 * 구독 즉시 `value`를 내고 동기로 complete한 뒤 throw하는 teardown을
 * 돌려주는 Observable을 만든다. rxjs는 이미 닫힌 구독에 붙는 teardown을 그
 * 자리에서 실행하므로 예외가 `subscribe()` 호출 밖으로 나온다.
 */
function completesThenThrows<T>(value: T) {
  let subscriptions = 0;
  const source = new Observable<T>((subscriber) => {
    subscriptions += 1;
    subscriber.next(value);
    subscriber.complete();
    return () => {
      throw new Error("teardown boom");
    };
  });
  return { source, subscriptions: () => subscriptions };
}

/**
 * `run` 동안과 그 뒤 매크로태스크 한 번까지 발생한 `uncaughtException`을
 * 모은다. Node `EventTarget` listener 예외(`process.nextTick` throw)와 rxjs
 * 미처리 오류 보고(`setTimeout` throw)가 여기로 온다. vitest listener는 그동안
 * 떼어 두었다가 되돌린다.
 */
async function collectUncaught(
  run: () => void | Promise<void>,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  const saved = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  const capture = (error: unknown): void => {
    errors.push(error);
  };
  process.on("uncaughtException", capture);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("uncaughtException", capture);
    for (const listener of saved) process.on("uncaughtException", listener);
  }
  return errors;
}

/** 진단 spy. `teardownFailures()`는 기록된 `upstream-teardown-failed`만 순서대로 돌려준다. */
function diagnosticsSpy() {
  const sink = { record: vi.fn<(event: BridgeDiagnostic) => void>() };
  const teardownFailures = (): BridgeDiagnostic[] =>
    sink.record.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "upstream-teardown-failed");
  return { sink, teardownFailures };
}

/** teardown이 throw하는 State source 하나를 가진 server와 target 1을 만든다. */
function stateHarness() {
  const subject = new BehaviorSubject(1);
  const throwing = teardownThrowing(subject);
  const { sink, teardownFailures } = diagnosticsSpy();
  const server = createBridgeServer(
    {
      hardware: {
        state: {
          current$: currentValueSource(
            Object.assign(throwing.source, { getValue: () => subject.value }),
          ),
        },
      },
    },
    { diagnostics: sink },
  );
  const target = new FakeTarget(1);
  server.attach(target);
  return {
    server,
    target,
    subject,
    subscriptions: throwing.subscriptions,
    teardownFailures,
  };
}

/** teardown이 throw하는 broadcast Event source 하나를 가진 server와 target 1을 만든다. */
function broadcastHarness() {
  const subject = new Subject<number>();
  const throwing = teardownThrowing(subject);
  const { sink, teardownFailures } = diagnosticsSpy();
  const server = createBridgeServer(
    { hardware: { event: { change$: broadcastEvent(throwing.source) } } },
    { diagnostics: sink },
  );
  const target = new FakeTarget(1);
  server.attach(target);
  return {
    server,
    target,
    subject,
    subscriptions: throwing.subscriptions,
    teardownFailures,
  };
}

/** 구독마다 teardown이 throw하는 upstream을 만드는 scoped Event server와 target 1·2를 만든다. */
function scopedHarness() {
  const subject = new Subject<number>();
  const throwing = teardownThrowing(subject);
  const { sink, teardownFailures } = diagnosticsSpy();
  const server = createBridgeServer(
    { hardware: { event: { change$: scopedEvent(() => throwing.source) } } },
    { diagnostics: sink },
  );
  const target = new FakeTarget(1);
  server.attach(target);
  server.attach(new FakeTarget(2));
  return {
    server,
    target,
    subject,
    subscriptions: throwing.subscriptions,
    teardownFailures,
  };
}

const stateFailure = { type: "upstream-teardown-failed", key: STATE };
const eventFailure = { type: "upstream-teardown-failed", key: EVENT };

describe("세션 retire 연쇄의 teardown throw", () => {
  test.each([
    "main-frame-navigation",
    "render-process-gone",
    "destroyed",
  ] as const)(
    "%s retire로 State 구독이 닫혀도 uncaughtException 없이 진단을 남긴다",
    async (reason) => {
      const { server, target, teardownFailures } = stateHarness();
      const doc = rendererDocument(server);
      await doc.subscribe(STATE);
      const errors = await collectUncaught(() => target.fireLifecycle(reason));
      expect(errors).toEqual([]);
      expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
      expect(teardownFailures()).toEqual([stateFailure]);
    },
  );

  test("새 clientId로 세션이 교체(replaced)되면 새 문서의 구독은 새 upstream에 연결된다", async () => {
    const { server, subscriptions, teardownFailures } = stateHarness();
    await rendererDocument(server).subscribe(STATE);
    const errors = await collectUncaught(async () => {
      await rendererDocument(server, { clientId: "client-2" }).subscribe(STATE);
    });
    expect(errors).toEqual([]);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(1);
    expect(subscriptions()).toBe(2);
    expect(teardownFailures()).toEqual([stateFailure]);
  });

  test("scoped Event 구독도 retire 때 uncaughtException 없이 진단을 남긴다", async () => {
    const { server, target, subject, teardownFailures } = scopedHarness();
    await rendererDocument(server).subscribe(EVENT);
    const errors = await collectUncaught(() => target.endDocument());
    expect(errors).toEqual([]);
    expect(subject.observed).toBe(false);
    expect(teardownFailures()).toEqual([eventFailure]);
  });
});

describe("공유 upstream entry 정리", () => {
  test("broadcast Event를 해제한 뒤 다시 구독하면 새 upstream에서 값을 받는다", async () => {
    const { server, subject, subscriptions, teardownFailures } =
      broadcastHarness();
    const doc = rendererDocument(server);
    const first = await doc.subscribe(EVENT);
    await first.unsubscribe();
    expect(subject.observed).toBe(false);
    const second = await doc.subscribe(EVENT);
    await second.ack();
    subject.next(5);
    expect(second.types()).toEqual(["subscribed", "batch"]);
    expect(subscriptions()).toBe(2);
    expect(teardownFailures()).toEqual([eventFailure]);
  });

  test("State를 해제한 뒤 다시 구독하면 이후 값 변경을 받는다", async () => {
    const { server, subject, subscriptions, teardownFailures } = stateHarness();
    const doc = rendererDocument(server);
    const first = await doc.subscribe(STATE);
    await first.unsubscribe();
    const second = await doc.subscribe(STATE);
    await second.ack();
    await second.ack();
    subject.next(9);
    expect(second.types()).toEqual(["subscribed", "batch", "batch"]);
    expect(subscriptions()).toBe(2);
    expect(teardownFailures()).toEqual([stateFailure]);
  });
  test("teardown 안에서 같은 key를 동기로 다시 구독해도 새 upstream에 연결된다", async () => {
    const subject = new Subject<number>();
    let subscriptions = 0;
    let onTeardown: (() => void) | undefined;
    const source = new Observable<number>((subscriber) => {
      subscriptions += 1;
      const inner = subject.subscribe(subscriber);
      return () => {
        inner.unsubscribe();
        const hook = onTeardown;
        onTeardown = undefined;
        hook?.();
        throw new Error("teardown boom");
      };
    });
    const { sink, teardownFailures } = diagnosticsSpy();
    const server = createBridgeServer(
      { hardware: { event: { change$: broadcastEvent(source) } } },
      { diagnostics: sink },
    );
    server.attach(new FakeTarget(1));
    const doc = rendererDocument(server);
    const first = await doc.subscribe(EVENT);
    let second: TestSubscription | undefined;
    onTeardown = () => {
      second = doc.begin(EVENT);
    };
    await first.unsubscribe();
    if (second === undefined) throw new Error("teardown이 실행되지 않았다");
    await second.ready;
    await second.ack();
    subject.next(3);
    expect(second.types()).toEqual(["subscribed", "batch"]);
    expect(subscriptions).toBe(2);
    expect(teardownFailures()).toEqual([eventFailure]);
  });
});

describe("server.dispose() 순회", () => {
  test("teardown이 throw하는 구독 둘이 있어도 dispose는 던지지 않고 모두 닫는다", async () => {
    const { server, subject, teardownFailures } = scopedHarness();
    await rendererDocument(server).subscribe(EVENT);
    await rendererDocument(server, {
      webContentsId: 2,
      clientId: "client-2",
    }).subscribe(EVENT);
    let thrown: unknown;
    const errors = await collectUncaught(() => {
      try {
        server.dispose();
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeUndefined();
    expect(subject.observed).toBe(false);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    expect(errors).toEqual([]);
    expect(teardownFailures()).toEqual([eventFailure, eventFailure]);
  });
});

describe("전송 실패 뒤 close의 teardown throw", () => {
  test("scoped Event 값 전송이 실패해 닫혀도 사용자 source의 next 호출은 던지지 않는다", async () => {
    const { server, subject, teardownFailures } = scopedHarness();
    const first = await rendererDocument(server).subscribe(EVENT, {
      onFrame: (frame) => {
        if (frame.type === "batch") throw new Error("route closed");
      },
    });
    await first.ack();
    const appValues: number[] = [];
    subject.subscribe((value) => appValues.push(value));
    let thrown: unknown;
    const errors = await collectUncaught(() => {
      try {
        subject.next(1);
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeUndefined();
    expect(appValues).toEqual([1]);
    expect(errors).toEqual([]);
    expect(subject.observed).toBe(true);
    expect(server.getDiagnosticsSnapshot().subscriptions).toBe(0);
    expect(teardownFailures()).toEqual([eventFailure]);
  });

  test("broadcast Event 마지막 구독의 전송이 실패해 닫힌 뒤 재구독하면 값을 받는다", async () => {
    const { server, subject, subscriptions, teardownFailures } =
      broadcastHarness();
    const doc = rendererDocument(server);
    const first = await doc.subscribe(EVENT, {
      onFrame: (frame) => {
        if (frame.type === "batch") throw new Error("route closed");
      },
    });
    await first.ack();
    let thrown: unknown;
    const errors = await collectUncaught(() => {
      try {
        subject.next(1);
      } catch (error) {
        thrown = error;
      }
    });
    const second = await doc.subscribe(EVENT);
    await second.ack();
    subject.next(2);
    expect(thrown).toBeUndefined();
    expect(errors).toEqual([]);
    expect(second.types()).toEqual(["subscribed", "batch"]);
    expect(subscriptions()).toBe(2);
    expect(teardownFailures()).toEqual([eventFailure]);
  });
});

describe("동기 방출 중 이미 닫힌 upstream의 teardown throw", () => {
  test("scoped Event가 구독 중 동기로 끝나고 teardown이 throw해도 값과 complete를 전달하고 진단을 남긴다", async () => {
    const throwing = completesThenThrows(7);
    const { sink, teardownFailures } = diagnosticsSpy();
    const server = createBridgeServer(
      { hardware: { event: { change$: scopedEvent(() => throwing.source) } } },
      { diagnostics: sink },
    );
    server.attach(new FakeTarget(1));
    let subscription!: Awaited<
      ReturnType<ReturnType<typeof rendererDocument>["subscribe"]>
    >;
    const errors = await collectUncaught(async () => {
      subscription = await rendererDocument(server).subscribe(EVENT);
      await subscription.ack();
    });
    expect(errors).toEqual([]);
    expect(subscription.types()).toEqual(["subscribed", "batch", "complete"]);
    expect(teardownFailures()).toEqual([eventFailure]);
  });

  test("broadcast Event가 첫 구독 중 동기로 끝나고 teardown이 throw해도 다음 구독은 새 upstream에 연결된다", async () => {
    const throwing = completesThenThrows(7);
    const { sink, teardownFailures } = diagnosticsSpy();
    const server = createBridgeServer(
      { hardware: { event: { change$: broadcastEvent(throwing.source) } } },
      { diagnostics: sink },
    );
    server.attach(new FakeTarget(1));
    const doc = rendererDocument(server);
    const errors = await collectUncaught(async () => {
      const first = await doc.subscribe(EVENT);
      await first.ack();
      await first.ack();
      await doc.subscribe(EVENT);
    });
    expect(errors).toEqual([]);
    expect(throwing.subscriptions()).toBe(2);
    expect(teardownFailures()).toEqual([eventFailure, eventFailure]);
  });
});
