/**
 * `DocumentSession`의 retire interface(`retireReason`·`onRetire`, ADR 0023)를
 * `DocumentSessions`(attach·establish·detach·dispose·lifecycle)를 통해
 * 직접 검증한다. 이 파일은 "구독 모듈은 직접 test하지 않는다" 원칙의
 * 예외다 — `DeliveryWindow`·`Upstreams`와 같은 근거로,
 * 세션도 session·authorize·창·진단·envelope을 모르는 순수 module이다.
 *
 * 구현 class(`SessionImpl`)는 export되지 않는다 — 아래 test는 항상
 * `DocumentSessions.establish`가 돌려주는 interface로만 세션을 다룬다.
 */
import { describe, expect, test, vi } from "vitest";

import type {
  Admission,
  DocumentSession,
  RetireReason,
} from "../../src/main/document-sessions.js";
import { DocumentSessions } from "../../src/main/document-sessions.js";
import { resolveResourceLimits } from "../../src/main/resource-limits.js";
import { FakeTarget, sender } from "./fake-ipc.js";

// --- test helper --------------------------------------------------------

/** `Admission`을 세션으로 좁힌다. 사유가 오면 test 실패로 취급한다. */
function expectSession(admission: Admission): DocumentSession {
  if (!("session" in admission))
    throw new Error(`expected a session, got reason "${admission.reason}"`);
  return admission.session;
}

/** `sessions.attach(target)` + `establish(sender(), "c1")`로 세션 하나를 얻는다. */
function establishSession(
  sessions: DocumentSessions,
  target: FakeTarget,
): { readonly session: DocumentSession; readonly detach: () => void } {
  const detach = sessions.attach(target);
  const session = expectSession(sessions.establish(sender(), "c1"));
  return { session, detach };
}

// --- test ----------------------------------------------------------------

describe("살아 있는 세션", () => {
  test("retireReason은 undefined이고 등록한 listener는 호출되지 않는다", () => {
    const sessions = new DocumentSessions(resolveResourceLimits());
    const { session } = establishSession(sessions, new FakeTarget());
    const listener = vi.fn();

    session.onRetire(listener);

    expect(session.retireReason).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("retire 원인별 사유", () => {
  type RetireCtx = {
    readonly sessions: DocumentSessions;
    readonly target: FakeTarget;
    readonly detach: () => void;
  };

  test.each([
    ["detach", "detach" as const, (ctx: RetireCtx) => ctx.detach()],
    ["dispose", "dispose" as const, (ctx: RetireCtx) => ctx.sessions.dispose()],
    [
      "replaced",
      "replaced" as const,
      (ctx: RetireCtx) => {
        ctx.sessions.establish(sender(), "c2");
      },
    ],
    [
      "main-frame-navigation",
      "main-frame-navigation" as const,
      (ctx: RetireCtx) => ctx.target.fireLifecycle("main-frame-navigation"),
    ],
    [
      "render-process-gone",
      "render-process-gone" as const,
      (ctx: RetireCtx) => ctx.target.fireLifecycle("render-process-gone"),
    ],
    [
      "destroyed",
      "destroyed" as const,
      (ctx: RetireCtx) => ctx.target.fireLifecycle("destroyed"),
    ],
  ])(
    "%s는 retireReason을 %s로 만들고 listener를 1회 호출한다",
    (_label, reason, retire) => {
      const sessions = new DocumentSessions(resolveResourceLimits());
      const target = new FakeTarget();
      const { session, detach } = establishSession(sessions, target);
      const listener = vi.fn();
      session.onRetire(listener);

      retire({ sessions, target, detach });

      expect(session.retireReason).toBe(reason);
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );
});

describe("listener 안에서 본 사유", () => {
  test("session.retireReason이 이미 그 사유로 설정돼 있다", () => {
    const sessions = new DocumentSessions(resolveResourceLimits());
    const { session, detach } = establishSession(sessions, new FakeTarget());
    let seenInsideListener: RetireReason | undefined;
    session.onRetire(() => {
      seenInsideListener = session.retireReason;
    });

    detach();

    expect(seenInsideListener).toBe("detach");
  });
});

describe("해제 handle", () => {
  test("부른 뒤 retire하면 listener가 호출되지 않고, 2회 호출은 예외가 없다", () => {
    const sessions = new DocumentSessions(resolveResourceLimits());
    const { session, detach } = establishSession(sessions, new FakeTarget());
    const listener = vi.fn();
    const off = session.onRetire(listener);

    off();
    detach();

    expect(listener).not.toHaveBeenCalled();
    expect(() => off()).not.toThrow();
  });
});

describe("이미 retire된 세션에 onRetire", () => {
  test("반환 전에 listener를 동기 1회 호출하고, 반환 handle은 예외 없이 no-op이다", () => {
    const sessions = new DocumentSessions(resolveResourceLimits());
    const { session, detach } = establishSession(sessions, new FakeTarget());
    detach();

    let calledBeforeReturn = false;
    const listener = vi.fn(() => {
      calledBeforeReturn = true;
    });
    const off = session.onRetire(listener);

    expect(calledBeforeReturn).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => off()).not.toThrow();
  });
});

describe("listener 등록 순서", () => {
  test("등록한 순서로 호출된다", () => {
    const sessions = new DocumentSessions(resolveResourceLimits());
    const { session, detach } = establishSession(sessions, new FakeTarget());
    const calls: string[] = [];
    session.onRetire(() => calls.push("a"));
    session.onRetire(() => calls.push("b"));
    session.onRetire(() => calls.push("c"));

    detach();

    expect(calls).toEqual(["a", "b", "c"]);
  });
});

describe("같은 함수를 두 번 등록", () => {
  test("2회 호출된다", () => {
    const sessions = new DocumentSessions(resolveResourceLimits());
    const { session, detach } = establishSession(sessions, new FakeTarget());
    const listener = vi.fn();
    session.onRetire(listener);
    session.onRetire(listener);

    detach();

    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("handle 하나만 해제하면 남은 1회만 호출된다", () => {
    const sessions = new DocumentSessions(resolveResourceLimits());
    const { session, detach } = establishSession(sessions, new FakeTarget());
    const listener = vi.fn();
    session.onRetire(listener);
    const offSecond = session.onRetire(listener);

    offSecond();
    detach();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("current()", () => {
  test("retire된 세션은 sender-unauthorized로 거부한다", () => {
    const sessions = new DocumentSessions(resolveResourceLimits());
    const { detach } = establishSession(sessions, new FakeTarget());

    detach();

    expect(sessions.current(sender(), "c1")).toEqual({
      reason: "sender-unauthorized",
    });
  });
});

describe("retire는 세션당 한 번만 관측된다", () => {
  test("detach 뒤 dispose해도 listener는 총 1회이고 사유는 detach로 유지된다", () => {
    const sessions = new DocumentSessions(resolveResourceLimits());
    const { session, detach } = establishSession(sessions, new FakeTarget());
    const listener = vi.fn();
    session.onRetire(listener);

    detach();
    sessions.dispose();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(session.retireReason).toBe("detach");
  });
});
