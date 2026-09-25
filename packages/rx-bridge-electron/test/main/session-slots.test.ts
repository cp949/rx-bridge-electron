/**
 * 세션 slot 회계와 retire listener 연동(`SessionSlots`, RD-041)을
 * `RpcRequests`·`Subscriptions` 배선 없이 직접 검증한다. 이 파일은
 * RD-015 결정 5("구독 모듈 직접 test 없음")의 예외다 — `DeliveryWindow`
 * (RD-034)·`Upstreams`(RD-036)와 같은 근거로, `SessionSlots`도 session
 * 자체를 인터페이스로만 다루는 순수 module이라 직접 검증한다.
 *
 * 세션은 실제 `DocumentSessions` + `FakeTarget`으로 만들고 detach로
 * retire한다 — EventTarget 기반 예외 격리·등록 순서가 실제 `SessionImpl`과
 * 같아야 하기 때문이다(`session-slots.ts:L5` 이중 등록·즉시 호출 경로는
 * `DocumentSession.onRetire`의 실제 구현에 위임한다).
 */
import { describe, expect, test, vi } from "vitest";

import type { DocumentSession } from "../../src/main/document-sessions.js";
import { DocumentSessions } from "../../src/main/document-sessions.js";
import { resolveResourceLimits } from "../../src/main/resource-limits.js";
import { SessionSlots, type SlotLease } from "../../src/main/session-slots.js";
import { FakeTarget, sender } from "./fake-ipc.js";

// --- test helper --------------------------------------------------------

/** `webContentsId`별 독립 세션 하나를 만들어 세션과 detach 함수를 돌려준다. */
function createSession(webContentsId = 1): {
  readonly session: DocumentSession;
  readonly detach: () => void;
} {
  const sessions = new DocumentSessions(resolveResourceLimits());
  const target = new FakeTarget(webContentsId, "main");
  const detach = sessions.attach(target);
  const admission = sessions.establish(sender({ webContentsId }), "c1");
  if (!("session" in admission))
    throw new Error(`expected a session, got reason "${admission.reason}"`);
  return { session: admission.session, detach };
}

// --- test ----------------------------------------------------------------

describe("acquire 한도(L1)", () => {
  test("한도까지 성공하고 초과 시 undefined, release 뒤 다시 성공한다", () => {
    const slots = new SessionSlots(2);
    const { session } = createSession();

    const first = slots.acquire(session);
    const second = slots.acquire(session);
    const third = slots.acquire(session);

    expect(first).not.toBeUndefined();
    expect(second).not.toBeUndefined();
    expect(third).toBeUndefined();

    first?.release();
    expect(slots.acquire(session)).not.toBeUndefined();
  });

  test("세션 격리: A가 한도를 채워도 B는 성공한다", () => {
    const slots = new SessionSlots(1);
    const { session: sessionA } = createSession(1);
    const { session: sessionB } = createSession(2);

    expect(slots.acquire(sessionA)).not.toBeUndefined();
    expect(slots.acquire(sessionA)).toBeUndefined();
    expect(slots.acquire(sessionB)).not.toBeUndefined();
  });

  test("retire된 세션도 한도 안이면 acquire에 성공한다", () => {
    const slots = new SessionSlots(2);
    const { session, detach } = createSession();
    detach();

    expect(session.retireReason).toBe("detach");
    expect(slots.acquire(session)).not.toBeUndefined();
  });
});

describe("count 집계(L2)", () => {
  test("여러 세션 합이고, retire된 세션의 미반납 lease도 release 전까지 센다", () => {
    const slots = new SessionSlots(2);
    const { session: sessionA, detach: detachA } = createSession(1);
    const { session: sessionB } = createSession(2);

    const leaseA1 = slots.acquire(sessionA);
    slots.acquire(sessionA);
    const leaseB1 = slots.acquire(sessionB);
    expect(slots.count()).toBe(3);

    detachA();
    expect(slots.count()).toBe(3);

    leaseA1?.release();
    expect(slots.count()).toBe(2);

    leaseB1?.release();
    expect(slots.count()).toBe(1);
  });
});

describe("release 멱등성(L3·L4)", () => {
  test("release()를 두 번 불러도 count는 1만 줄고, released getter가 상태를 보고한다", () => {
    const slots = new SessionSlots(2);
    const { session } = createSession();
    const lease = slots.acquire(session);
    if (lease === undefined) throw new Error("expected a lease");

    expect(lease.released).toBe(false);

    lease.release();
    expect(lease.released).toBe(true);
    expect(slots.count()).toBe(0);

    lease.release();
    expect(slots.count()).toBe(0);
  });

  test("한 세션에서 하나만 release해도 나머지 lease는 세션별 수를 유지한다", () => {
    const slots = new SessionSlots(2);
    const { session } = createSession();
    const lease1 = slots.acquire(session);
    slots.acquire(session);
    lease1?.release();

    expect(slots.acquire(session)).not.toBeUndefined();
    expect(slots.acquire(session)).toBeUndefined();
  });
});

describe("onRetire(L5)", () => {
  test("살아 있는 세션: retire 시 listener를 1회 호출하고, listener 안에서 retireReason이 이미 보인다", () => {
    const slots = new SessionSlots(2);
    const { session, detach } = createSession();
    const lease = slots.acquire(session);
    if (lease === undefined) throw new Error("expected a lease");
    const listener = vi.fn(() => {
      expect(session.retireReason).toBe("detach");
    });

    lease.onRetire(listener);
    detach();

    expect(listener).toHaveBeenCalledTimes(1);
    detach();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("이미 retire된 세션: onRetire가 반환하기 전에 listener가 동기 호출된다", () => {
    const slots = new SessionSlots(2);
    const { session, detach } = createSession();
    detach();
    const lease = slots.acquire(session);
    if (lease === undefined) throw new Error("expected a lease");
    const listener = vi.fn();

    lease.onRetire(listener);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("이미 retire된 세션에서 동기 호출 뒤 offRetire는 no-op이고, 재등록은 즉시 다시 호출된다", () => {
    const slots = new SessionSlots(2);
    const { session, detach } = createSession();
    detach();
    const lease = slots.acquire(session);
    if (lease === undefined) throw new Error("expected a lease");
    const listener = vi.fn();
    lease.onRetire(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(() => lease.offRetire()).not.toThrow();

    const listener2 = vi.fn();
    lease.onRetire(listener2);
    expect(listener2).toHaveBeenCalledTimes(1);
  });

  test("release 뒤 onRetire는 등록·호출하지 않고, release 뒤 retire돼도 listener가 불리지 않는다", () => {
    const slots = new SessionSlots(2);
    const { session, detach } = createSession();
    const lease = slots.acquire(session);
    if (lease === undefined) throw new Error("expected a lease");
    lease.release();

    const listener = vi.fn();
    lease.onRetire(listener);
    expect(listener).not.toHaveBeenCalled();

    detach();
    expect(listener).not.toHaveBeenCalled();
  });

  test("release 뒤에도 세션이 이미 retire돼 있으면 onRetire가 즉시 호출된다(등록은 남지 않는다)", () => {
    const slots = new SessionSlots(2);
    const { session, detach } = createSession();
    const lease = slots.acquire(session);
    if (lease === undefined) throw new Error("expected a lease");
    lease.release();
    detach();

    const listener = vi.fn();
    lease.onRetire(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    // 즉시 호출 뒤 등록은 남지 않는다 — offRetire는 no-op이고 재등록해도
    // released 상태이므로 다시 즉시 호출된다(등록이 쌓이지 않는다).
    expect(() => lease.offRetire()).not.toThrow();
    const listener2 = vi.fn();
    lease.onRetire(listener2);
    expect(listener2).toHaveBeenCalledTimes(1);
  });

  test("listener가 이미 등록된 lease에 onRetire를 다시 부르면 throw하고, 기존 등록은 남는다", () => {
    const slots = new SessionSlots(2);
    const { session, detach } = createSession();
    const lease = slots.acquire(session);
    if (lease === undefined) throw new Error("expected a lease");
    const first = vi.fn();
    const second = vi.fn();
    lease.onRetire(first);

    expect(() => lease.onRetire(second)).toThrowError(/already registered/i);

    detach();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  test("offRetire(): count는 그대로고, 이후 retire에서 listener가 불리지 않으며 다시 onRetire할 수 있다", () => {
    const slots = new SessionSlots(2);
    const { session, detach } = createSession();
    const lease = slots.acquire(session);
    if (lease === undefined) throw new Error("expected a lease");
    const first = vi.fn();
    lease.onRetire(first);

    lease.offRetire();
    expect(slots.count()).toBe(1);

    const second = vi.fn();
    lease.onRetire(second);
    detach();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("listener 안에서 release()·offRetire() 호출이 안전하다 — 발화 경로", () => {
    const slots = new SessionSlots(2);
    const { session, detach } = createSession();
    const lease = slots.acquire(session);
    if (lease === undefined) throw new Error("expected a lease");
    lease.onRetire(() => {
      expect(() => lease.offRetire()).not.toThrow();
      expect(() => lease.release()).not.toThrow();
    });

    expect(() => detach()).not.toThrow();
    expect(lease.released).toBe(true);
    expect(slots.count()).toBe(0);
  });

  test("listener 안에서 release()·offRetire() 호출이 안전하다 — 이미 retire된 세션의 즉시 호출 경로", () => {
    const slots = new SessionSlots(2);
    const { session, detach } = createSession();
    detach();
    const lease = slots.acquire(session);
    if (lease === undefined) throw new Error("expected a lease");

    expect(() => {
      lease.onRetire(() => {
        expect(() => lease.offRetire()).not.toThrow();
        expect(() => lease.release()).not.toThrow();
      });
    }).not.toThrow();
    expect(lease.released).toBe(true);
    expect(slots.count()).toBe(0);
  });

  test("여러 lease의 listener 호출 순서는 onRetire 호출 순서다", () => {
    const slots = new SessionSlots(3);
    const { session, detach } = createSession();
    const leaseA = slots.acquire(session);
    const leaseB = slots.acquire(session);
    const leaseC = slots.acquire(session);
    if (leaseA === undefined || leaseB === undefined || leaseC === undefined)
      throw new Error("expected leases");
    const order: string[] = [];
    leaseB.onRetire(() => order.push("B"));
    leaseA.onRetire(() => order.push("A"));
    leaseC.onRetire(() => order.push("C"));

    detach();

    expect(order).toEqual(["B", "A", "C"]);
  });
});
