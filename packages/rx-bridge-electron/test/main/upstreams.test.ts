/**
 * upstream 연결(`Upstreams`, RD-036)을 `Subscriptions`를 거치지 않고 직접
 * 검증한다. State·broadcast Event의 key별 공유, scoped Event의 구독별
 * upstream, 늦은 합류, 동기 재진입 해제, fan-out 스냅샷, terminal 전파를
 * 다룬다. 이 파일은 RD-015 결정 5("구독 모듈 직접 test 없음")의 예외다 —
 * `Upstreams`는 `DeliveryWindow`(RD-034)와 같은 등급의, session·authorize·
 * 창·진단·envelope을 모르는 순수 연결 module이라 직접 검증한다.
 *
 * upstream 상태는 rxjs `Subject.observed`와 `subscribe` 호출 횟수(spy)로
 * 본다. sink는 호출 기록 배열이다. 공유 upstream이 terminal(`error`·
 * `complete`)을 낸 뒤의 정리는 이 module이 하지 않는다 — 각 member가 받은
 * terminal에 이어 자기 토큰으로 `disconnect`를 불러야 정리된다(실제
 * `Subscriptions`가 하는 것과 같다). 그래서 아래
 * terminal 관련 test의 sink는 필요한 곳에서 자기 disconnect를 함께 흉내
 * 낸다.
 */
import { BehaviorSubject, Observable, Subject } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import type {
  EventRegistrationEntry,
  StateRegistrationEntry,
} from "../../src/main/registration.js";
import type { BridgeContext } from "../../src/main/types.js";
import { Upstreams, type UpstreamSink } from "../../src/main/upstreams.js";
import type { BridgeValue } from "../../src/protocol/index.js";

// --- test helper --------------------------------------------------------

function fakeContext(clientId = "client-1"): BridgeContext {
  return {
    requestId: "req-1",
    clientId,
    windowRole: "main",
    sender: {
      webContentsId: 1,
      frameId: 0,
      isMainFrame: true,
      origin: "app://x",
    },
    signal: new AbortController().signal,
  };
}

type SinkCall =
  | { readonly type: "next"; readonly value: unknown }
  | { readonly type: "error"; readonly value: unknown }
  | { readonly type: "complete" };

/** 호출 기록만 남기는 sink. `onCall`로 각 호출 안에서 추가 동작(자기 disconnect 등)을 끼워 넣는다. */
function recordingSink(onCall?: (call: SinkCall) => void): UpstreamSink & {
  readonly calls: SinkCall[];
} {
  const calls: SinkCall[] = [];
  const push = (call: SinkCall): void => {
    calls.push(call);
    onCall?.(call);
  };
  return {
    calls,
    next: (value) => push({ type: "next", value }),
    error: (value) => push({ type: "error", value }),
    complete: () => push({ type: "complete" }),
  };
}

function stateRegistration(
  key: string,
  source: StateRegistrationEntry["source"],
): StateRegistrationEntry {
  return {
    kind: "state",
    bridgeOperation: { key, category: "state", domain: ["d"], operation: "op" },
    source,
  };
}

function broadcastRegistration(
  key: string,
  source: Observable<BridgeValue>,
): EventRegistrationEntry {
  return {
    kind: "event",
    bridgeOperation: { key, category: "event", domain: ["d"], operation: "op" },
    delivery: { mode: "broadcast", source },
    buffer: { capacity: 100, overflow: "error" },
  };
}

function scopedRegistration(
  key: string,
  factory: (context: BridgeContext) => Observable<BridgeValue>,
): EventRegistrationEntry {
  return {
    kind: "event",
    bridgeOperation: { key, category: "event", domain: ["d"], operation: "op" },
    delivery: { mode: "scoped", factory },
    buffer: { capacity: 100, overflow: "error" },
  };
}

/** `BehaviorSubject`를 감싸 `getValue()`만 선택적으로 실패시키는 State source. */
function stateSource(initial: BridgeValue): {
  readonly source: StateRegistrationEntry["source"];
  readonly subject: BehaviorSubject<BridgeValue>;
  failGetValue(error: unknown): void;
} {
  const subject = new BehaviorSubject<BridgeValue>(initial);
  const realGetValue = subject.getValue.bind(subject);
  let failure: { readonly error: unknown } | undefined;
  const source = Object.assign(subject, {
    getValue: (): BridgeValue => {
      if (failure !== undefined) throw failure.error;
      return realGetValue();
    },
  }) as StateRegistrationEntry["source"];
  return {
    source,
    subject,
    failGetValue: (error: unknown) => {
      failure = { error };
    },
  };
}

// --- test ----------------------------------------------------------------

describe("공유 갈래: 첫 연결과 후속 연결", () => {
  test("State: 같은 key의 두 토큰은 upstream을 1회만 구독하고 둘 다 같은 값을 받는다", () => {
    const upstreams = new Upstreams();
    const key = "state:d/op";
    const subject = new BehaviorSubject<BridgeValue>(1);
    const subscribeSpy = vi.spyOn(subject, "subscribe");
    const registration = stateRegistration(
      key,
      subject as StateRegistrationEntry["source"],
    );

    const tokenA = {};
    const tokenB = {};
    const sinkA = recordingSink();
    const sinkB = recordingSink();
    upstreams.connect(tokenA, registration, fakeContext(), sinkA);
    upstreams.connect(tokenB, registration, fakeContext(), sinkB);

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    subject.next(2);
    const expected = [
      { type: "next", value: 1 },
      { type: "next", value: 2 },
    ];
    expect(sinkA.calls).toEqual(expected);
    expect(sinkB.calls).toEqual(expected);
  });

  test("broadcast Event: 같은 key의 두 토큰은 upstream을 1회만 구독하고 둘 다 같은 값을 받는다", () => {
    const upstreams = new Upstreams();
    const key = "event:d/op";
    const subject = new Subject<BridgeValue>();
    const subscribeSpy = vi.spyOn(subject, "subscribe");
    const registration = broadcastRegistration(key, subject);

    const tokenA = {};
    const tokenB = {};
    const sinkA = recordingSink();
    const sinkB = recordingSink();
    upstreams.connect(tokenA, registration, fakeContext(), sinkA);
    upstreams.connect(tokenB, registration, fakeContext(), sinkB);

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    subject.next(2);
    const expected = [{ type: "next", value: 2 }];
    expect(sinkA.calls).toEqual(expected);
    expect(sinkB.calls).toEqual(expected);
  });
});

describe("공유 갈래: 일부 해제·마지막 해제·재연결", () => {
  test("일부 해제는 upstream을 유지하고, 마지막 해제는 upstream을 해지하고, 재연결은 새 subscribe를 만든다", () => {
    const upstreams = new Upstreams();
    const key = "event:d/op";
    const subject = new Subject<BridgeValue>();
    const subscribeSpy = vi.spyOn(subject, "subscribe");
    const registration = broadcastRegistration(key, subject);

    const tokenA = {};
    const tokenB = {};
    const sinkA = recordingSink();
    const sinkB = recordingSink();
    upstreams.connect(tokenA, registration, fakeContext(), sinkA);
    upstreams.connect(tokenB, registration, fakeContext(), sinkB);

    upstreams.disconnect(tokenA);
    expect(subject.observed).toBe(true);
    subject.next(1);
    expect(sinkA.calls).toEqual([]);
    expect(sinkB.calls).toEqual([{ type: "next", value: 1 }]);

    upstreams.disconnect(tokenB);
    expect(subject.observed).toBe(false);

    const tokenC = {};
    const sinkC = recordingSink();
    upstreams.connect(tokenC, registration, fakeContext(), sinkC);
    expect(subscribeSpy).toHaveBeenCalledTimes(2);
    expect(subject.observed).toBe(true);
  });
});

describe("늦은 합류", () => {
  test("State는 connect 안에서 getValue()를 1회 동기 전달하고 기존 토큰은 중복 수신하지 않는다", () => {
    const upstreams = new Upstreams();
    const key = "state:d/op";
    const { source, subject } = stateSource(1);
    const registration = stateRegistration(key, source);

    const tokenA = {};
    const sinkA = recordingSink();
    upstreams.connect(tokenA, registration, fakeContext(), sinkA);
    subject.next(2);
    expect(sinkA.calls).toEqual([
      { type: "next", value: 1 },
      { type: "next", value: 2 },
    ]);

    const tokenB = {};
    const sinkB = recordingSink();
    upstreams.connect(tokenB, registration, fakeContext(), sinkB);

    expect(sinkB.calls).toEqual([{ type: "next", value: 2 }]);
    expect(sinkA.calls).toEqual([
      { type: "next", value: 1 },
      { type: "next", value: 2 },
    ]);
  });

  test("broadcast Event는 늦은 합류 값이 없다", () => {
    const upstreams = new Upstreams();
    const key = "event:d/op";
    const subject = new Subject<BridgeValue>();
    const registration = broadcastRegistration(key, subject);

    const tokenA = {};
    upstreams.connect(tokenA, registration, fakeContext(), recordingSink());

    const tokenB = {};
    const sinkB = recordingSink();
    upstreams.connect(tokenB, registration, fakeContext(), sinkB);

    expect(sinkB.calls).toEqual([]);
  });
});

describe("scoped 갈래", () => {
  test("토큰마다 factory를 호출하고 넘긴 context를 그대로 전달하며 각자 subscribe한다", () => {
    const upstreams = new Upstreams();
    const key = "event:d/scoped";
    const subjects: Subject<BridgeValue>[] = [];
    const factory = vi.fn((_context: BridgeContext) => {
      const subject = new Subject<BridgeValue>();
      subjects.push(subject);
      return subject;
    });
    const registration = scopedRegistration(key, factory);

    const tokenA = {};
    const tokenB = {};
    const contextA = fakeContext("client-a");
    const contextB = fakeContext("client-b");
    const sinkA = recordingSink();
    const sinkB = recordingSink();
    upstreams.connect(tokenA, registration, contextA, sinkA);
    upstreams.connect(tokenB, registration, contextB, sinkB);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenNthCalledWith(1, contextA);
    expect(factory).toHaveBeenNthCalledWith(2, contextB);
    expect(subjects[0]).not.toBe(subjects[1]);
    expect(subjects[0]!.observed).toBe(true);
    expect(subjects[1]!.observed).toBe(true);
  });

  test("해제는 자기 upstream만 끊는다", () => {
    const upstreams = new Upstreams();
    const key = "event:d/scoped";
    const subjects: Subject<BridgeValue>[] = [];
    const factory = vi.fn(() => {
      const subject = new Subject<BridgeValue>();
      subjects.push(subject);
      return subject;
    });
    const registration = scopedRegistration(key, factory);

    const tokenA = {};
    const tokenB = {};
    upstreams.connect(tokenA, registration, fakeContext(), recordingSink());
    upstreams.connect(tokenB, registration, fakeContext(), recordingSink());

    upstreams.disconnect(tokenA);
    expect(subjects[0]!.observed).toBe(false);
    expect(subjects[1]!.observed).toBe(true);
  });
});

describe("scoped factory 예외·non-Observable 반환", () => {
  test.each([
    [
      "throw",
      (): Observable<BridgeValue> => {
        throw new Error("factory boom");
      },
      "factory boom",
    ],
    [
      "non-Observable 반환",
      () => 42 as unknown as Observable<BridgeValue>,
      "Scoped factory must return an Observable.",
    ],
  ])(
    "%s이면 connect가 동기로 throw하고 토큰은 연결되지 않는다",
    (_label, factory, message) => {
      const upstreams = new Upstreams();
      const registration = scopedRegistration("event:d/scoped", factory);
      const token = {};
      const sink = recordingSink();

      expect(() =>
        upstreams.connect(token, registration, fakeContext(), sink),
      ).toThrow(message);
      expect(sink.calls).toEqual([]);
      expect(() => upstreams.disconnect(token)).not.toThrow();
    },
  );
});

describe("factory 실행 중 동기 해제", () => {
  test.each([
    [
      "non-Observable을 반환해도",
      () => 42 as unknown as Observable<BridgeValue>,
    ],
    ["Observable을 반환해도", () => new Subject<BridgeValue>()],
  ])("%s subscribe 없이 조용히 끝난다(throw 없음)", (_label, makeReturn) => {
    const upstreams = new Upstreams();
    const token = {};
    let created: Observable<BridgeValue> | undefined;
    const factory = (): Observable<BridgeValue> => {
      upstreams.disconnect(token);
      const value = makeReturn();
      created = value;
      return value;
    };
    const registration = scopedRegistration("event:d/scoped", factory);
    const sink = recordingSink();

    expect(() =>
      upstreams.connect(token, registration, fakeContext(), sink),
    ).not.toThrow();
    expect(sink.calls).toEqual([]);
    if (created instanceof Subject) expect(created.observed).toBe(false);
  });
});

describe("동기 방출 중 해제", () => {
  test("공유 첫 member가 sink next 안에서 해제하면 upstream이 해지되고 이후 값이 없다", () => {
    const upstreams = new Upstreams();
    const key = "state:d/op";
    const subject = new BehaviorSubject<BridgeValue>(1);
    const registration = stateRegistration(
      key,
      subject as StateRegistrationEntry["source"],
    );
    const token = {};
    const sink = recordingSink((call) => {
      if (call.type === "next") upstreams.disconnect(token);
    });

    upstreams.connect(token, registration, fakeContext(), sink);
    expect(sink.calls).toEqual([{ type: "next", value: 1 }]);
    expect(subject.observed).toBe(false);

    subject.next(2);
    expect(sink.calls).toEqual([{ type: "next", value: 1 }]);
  });

  test("scoped 토큰이 sink next 안에서 해제하면 같은 동기 방출의 다음 값이 오지 않는다", () => {
    const upstreams = new Upstreams();
    const token = {};
    const source = new Observable<BridgeValue>((subscriber) => {
      subscriber.next(1);
      subscriber.next(2);
    });
    const registration = scopedRegistration("event:d/scoped", () => source);
    const sink = recordingSink((call) => {
      if (call.type === "next") upstreams.disconnect(token);
    });

    upstreams.connect(token, registration, fakeContext(), sink);
    expect(sink.calls).toEqual([{ type: "next", value: 1 }]);
  });
});

describe("fan-out 중 앞 토큰이 뒤 토큰을 해제", () => {
  test.each([
    [
      "next",
      (subject: Subject<BridgeValue>) => subject.next(1),
      { type: "next", value: 1 } as const,
    ],
    [
      "error",
      (subject: Subject<BridgeValue>) => subject.error("boom"),
      { type: "error", value: "boom" } as const,
    ],
    [
      "complete",
      (subject: Subject<BridgeValue>) => subject.complete(),
      { type: "complete" } as const,
    ],
  ])("%s에서 뒤 토큰에는 전달되지 않는다", (_label, emit, expectedA) => {
    const upstreams = new Upstreams();
    const key = "event:d/op";
    const subject = new Subject<BridgeValue>();
    const registration = broadcastRegistration(key, subject);
    const tokenB = {};

    const sinkA = recordingSink(() => upstreams.disconnect(tokenB));
    const sinkB = recordingSink();
    upstreams.connect({}, registration, fakeContext(), sinkA);
    upstreams.connect(tokenB, registration, fakeContext(), sinkB);

    emit(subject);
    expect(sinkA.calls).toEqual([expectedA]);
    expect(sinkB.calls).toEqual([]);
  });
});

describe("upstream terminal 전파와 정리", () => {
  test.each([
    ["error" as const, "원래 error 객체"],
    ["complete" as const, "complete"],
  ])(
    "%s는 각 토큰 sink에 1회 전달되고 이후 재연결은 새 subscribe다(%s)",
    (terminal, _label) => {
      const upstreams = new Upstreams();
      const key = "event:d/op";
      const subject = new Subject<BridgeValue>();
      const registration = broadcastRegistration(key, subject);
      const originalError = new Error("upstream failed");

      const tokenA = {};
      const tokenB = {};
      // 실제 Subscriptions와 같은 방식: terminal을 받으면 자기 disconnect를 부른다.
      const sinkA = recordingSink((call) => {
        if (call.type === "error" || call.type === "complete")
          upstreams.disconnect(tokenA);
      });
      const sinkB = recordingSink((call) => {
        if (call.type === "error" || call.type === "complete")
          upstreams.disconnect(tokenB);
      });
      upstreams.connect(tokenA, registration, fakeContext(), sinkA);
      upstreams.connect(tokenB, registration, fakeContext(), sinkB);

      if (terminal === "error") subject.error(originalError);
      else subject.complete();

      if (terminal === "error") {
        expect(sinkA.calls).toEqual([{ type: "error", value: originalError }]);
        expect(sinkB.calls).toEqual([{ type: "error", value: originalError }]);
        const first = sinkA.calls[0];
        if (first === undefined || first.type !== "error")
          throw new Error("expected an error call");
        expect(first.value).toBe(originalError);
      } else {
        expect(sinkA.calls).toEqual([{ type: "complete" }]);
        expect(sinkB.calls).toEqual([{ type: "complete" }]);
      }

      const nextSubject = new Subject<BridgeValue>();
      const nextSubscribeSpy = vi.spyOn(nextSubject, "subscribe");
      const nextRegistration = broadcastRegistration(key, nextSubject);
      const tokenC = {};
      upstreams.connect(
        tokenC,
        nextRegistration,
        fakeContext(),
        recordingSink(),
      );
      expect(nextSubscribeSpy).toHaveBeenCalledTimes(1);
      expect(nextSubject.observed).toBe(true);
    },
  );
});

describe("동기 complete와 뒤늦은 해제", () => {
  test("첫 subscribe 안에서 complete되면 다음 토큰은 새 upstream을 받고, 옛 토큰의 뒤늦은 해제가 그 새 공유를 건드리지 않는다", () => {
    const upstreams = new Upstreams();
    const key = "event:d/op";
    const syncCompleteSource = new Observable<BridgeValue>((subscriber) => {
      subscriber.complete();
    });
    const oldRegistration = broadcastRegistration(key, syncCompleteSource);
    const tokenOld = {};
    const sinkOld = recordingSink();
    upstreams.connect(tokenOld, oldRegistration, fakeContext(), sinkOld);
    expect(sinkOld.calls).toEqual([{ type: "complete" }]);
    // 실제 사용 패턴대로, terminal을 받은 뒤 자기 disconnect를 부른다.
    upstreams.disconnect(tokenOld);

    const newSubject = new Subject<BridgeValue>();
    const newSubscribeSpy = vi.spyOn(newSubject, "subscribe");
    const newRegistration = broadcastRegistration(key, newSubject);
    const tokenNew = {};
    const sinkNew = recordingSink();
    upstreams.connect(tokenNew, newRegistration, fakeContext(), sinkNew);
    expect(newSubscribeSpy).toHaveBeenCalledTimes(1);
    expect(newSubject.observed).toBe(true);

    // 옛 토큰의 뒤늦은(중복) 해제는 no-op이고 새 공유를 건드리지 않는다.
    expect(() => upstreams.disconnect(tokenOld)).not.toThrow();
    expect(newSubject.observed).toBe(true);
    newSubject.next(1);
    expect(sinkNew.calls).toEqual([{ type: "next", value: 1 }]);
  });
});

describe("해제 멱등", () => {
  test("연결된 토큰의 중복 해제와 미연결 토큰의 해제는 모두 no-op이다", () => {
    const upstreams = new Upstreams();
    const key = "event:d/op";
    const subject = new Subject<BridgeValue>();
    const registration = broadcastRegistration(key, subject);
    const token = {};
    upstreams.connect(token, registration, fakeContext(), recordingSink());

    upstreams.disconnect(token);
    expect(subject.observed).toBe(false);
    expect(() => upstreams.disconnect(token)).not.toThrow();

    const neverConnected = {};
    expect(() => upstreams.disconnect(neverConnected)).not.toThrow();
  });
});

describe("늦은 합류 getValue() throw", () => {
  test("connect가 throw하고 기존 토큰 수신과 upstream은 유지되며 실패한 토큰의 해제는 no-op이다", () => {
    const upstreams = new Upstreams();
    const key = "state:d/op";
    const { source, subject, failGetValue } = stateSource(1);
    const registration = stateRegistration(key, source);

    const tokenA = {};
    const sinkA = recordingSink();
    upstreams.connect(tokenA, registration, fakeContext(), sinkA);

    const boom = new Error("getValue boom");
    failGetValue(boom);
    const tokenB = {};
    const sinkB = recordingSink();
    expect(() =>
      upstreams.connect(tokenB, registration, fakeContext(), sinkB),
    ).toThrow(boom);
    expect(sinkB.calls).toEqual([]);

    expect(subject.observed).toBe(true);
    subject.next(2);
    expect(sinkA.calls).toEqual([
      { type: "next", value: 1 },
      { type: "next", value: 2 },
    ]);
    expect(sinkB.calls).toEqual([]);

    expect(() => upstreams.disconnect(tokenB)).not.toThrow();
    subject.next(3);
    expect(sinkA.calls).toEqual([
      { type: "next", value: 1 },
      { type: "next", value: 2 },
      { type: "next", value: 3 },
    ]);
  });

  test("getValue()가 기존 토큰을 모두 해제한 뒤 throw하면 upstream을 해지하고 다음 연결은 새 subscribe를 만든다", () => {
    const upstreams = new Upstreams();
    const key = "state:d/op";
    const subject = new BehaviorSubject<BridgeValue>(1);
    const subscribeSpy = vi.spyOn(subject, "subscribe");
    const tokenA = {};
    let reentrant = false;
    const source = Object.assign(subject, {
      getValue: (): BridgeValue => {
        if (!reentrant) return 1;
        upstreams.disconnect(tokenA);
        throw new Error("getValue boom");
      },
    }) as StateRegistrationEntry["source"];
    const registration = stateRegistration(key, source);

    upstreams.connect(tokenA, registration, fakeContext(), recordingSink());
    reentrant = true;
    expect(() =>
      upstreams.connect({}, registration, fakeContext(), recordingSink()),
    ).toThrow("getValue boom");
    expect(subject.observed).toBe(false);

    reentrant = false;
    const sinkC = recordingSink();
    upstreams.connect({}, registration, fakeContext(), sinkC);
    expect(subscribeSpy).toHaveBeenCalledTimes(2);
    expect(sinkC.calls).toEqual([{ type: "next", value: 1 }]);
  });
});
