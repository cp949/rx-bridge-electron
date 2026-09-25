/**
 * Event source 구성 타입이 `/main` 진입점에서 공개되는지 확인한다. 앱이 buffer
 * 옵션 객체나 source 반환 타입을 `BridgeImpl<B>` indexed access 없이 선언할 수
 * 있어야 한다. 컴파일만 검증하고 등록 검증은 `create-bridge-server-impl.test.ts`가
 * 다룬다.
 */
import { Subject } from "rxjs";
import { expectTypeOf, test } from "vitest";

import {
  broadcastEvent,
  scopedEvent,
  type BridgeImpl,
  type BroadcastEventSource,
  type EventSource,
  type EventSourceBuffer,
  type OverflowPolicy,
  type ScopedEventSource,
} from "../../src/main/index.js";

test("buffer 옵션 객체를 공개 타입으로 따로 선언해 helper에 넘길 수 있다", () => {
  const overflow: OverflowPolicy = "drop-oldest";
  const buffer: EventSourceBuffer = { capacity: 64, overflow };
  const broadcast = broadcastEvent(new Subject<number>(), { buffer });
  const scoped = scopedEvent(() => new Subject<number>(), { buffer });

  expectTypeOf(broadcast).toEqualTypeOf<BroadcastEventSource<number>>();
  expectTypeOf(scoped).toEqualTypeOf<ScopedEventSource<number>>();
  // @ts-expect-error -- overflow 정책은 세 값 중 하나다.
  const invalid: OverflowPolicy = "drop-all";
  void invalid;
});

test("EventSource<T>는 BridgeImpl<B>의 event 자리 타입과 같다", () => {
  interface AppBridge {
    readonly device: { readonly event: { readonly data: number } };
  }
  expectTypeOf<
    BridgeImpl<AppBridge>["device"]["event"]["data"]
  >().toEqualTypeOf<EventSource<number>>();
});
