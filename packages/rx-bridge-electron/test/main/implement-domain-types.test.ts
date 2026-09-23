import { BehaviorSubject, Subject, of } from "rxjs";
import { expectTypeOf, test } from "vitest";

import {
  composeContracts,
  defineDomain,
  event,
  rpc,
  state,
  type Schema,
} from "../../src/contract/index.js";
import { createBridgeServer, implementDomain } from "../../src/main/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";
import type {
  BridgeContext,
  DomainImplementation,
} from "../../src/main/index.js";
import type { BridgeValue } from "../../src/protocol/index.js";

const pathInput: Schema<{ readonly path: string }> = {
  parse: (value) => value as { readonly path: string },
};
const boolOutput: Schema<boolean> = { parse: (value) => value as boolean };
const noInput: Schema<undefined> = { parse: () => undefined };
const numberOutput: Schema<number> = { parse: (value) => value as number };
const stringOutput: Schema<string> = { parse: (value) => value as string };

const domain = defineDomain("name", {
  rpc: {
    open: rpc({ input: pathInput, output: boolOutput }),
    ping: rpc({ input: noInput, output: numberOutput }),
  },
  state: { level: state(numberOutput) },
  event: { line: event(stringOutput) },
});

// rpc만 선언되어 state/event 카테고리가 아예 없는 도메인(테스트 9용).
const rpcOnlyDomain = defineDomain("rpc-only", {
  rpc: { ping: rpc({ input: noInput, output: numberOutput }) },
});

test("올바른 handler 구현은 DomainImplementation<Name>을 반환하고 input이 contextual typing된다", () => {
  const implementation = implementDomain(domain, {
    rpc: {
      open: (input) => {
        expectTypeOf(input).toEqualTypeOf<{ readonly path: string }>();
        return true;
      },
      ping: () => 1,
    },
    state: { level: currentValueSource(new BehaviorSubject(0)) },
    event: { line: broadcastEvent(new Subject<string>()) },
  });
  expectTypeOf(implementation).toEqualTypeOf<DomainImplementation<"name">>();
});

test("BridgeValue로 넓게 선언한 handler도 반환 타입만 맞으면 허용된다(매개변수 반공변성)", () => {
  const wideOpenHandler: (
    input: BridgeValue,
    context: BridgeContext,
  ) => boolean = () => true;
  implementDomain(domain, {
    rpc: { open: wideOpenHandler, ping: () => 1 },
    state: { level: currentValueSource(new BehaviorSubject(0)) },
    event: { line: broadcastEvent(new Subject<string>()) },
  });
});

// 아래 블록은 타입 검사(pnpm check-types) 전용이다. 런타임에서 예외를 던지는
// 잘못된 호출을 실행하지 않도록 if (false)로 감싼다. 각 @ts-expect-error 줄은
// 제거 시 해당 줄에서 check-types가 실패하는지 확인(RED)한 뒤 복원했다.
if (false) {
  implementDomain(domain, {
    rpc: {
      // @ts-expect-error open handler는 boolean을 반환해야 한다.
      open: () => "nope",
      ping: () => 1,
    },
    state: { level: currentValueSource(new BehaviorSubject(0)) },
    event: { line: broadcastEvent(new Subject<string>()) },
  });

  implementDomain(domain, {
    rpc: {
      // @ts-expect-error open handler의 input은 { path: string }이어야 한다.
      open: (input: { readonly path: number }) => true,
      ping: () => 1,
    },
    state: { level: currentValueSource(new BehaviorSubject(0)) },
    event: { line: broadcastEvent(new Subject<string>()) },
  });

  implementDomain(domain, {
    // @ts-expect-error rpc에서 선언된 ping이 누락되면 안 된다.
    rpc: {
      open: (input) => true,
    },
    state: { level: currentValueSource(new BehaviorSubject(0)) },
    event: { line: broadcastEvent(new Subject<string>()) },
  });

  implementDomain(domain, {
    rpc: {
      open: (input) => true,
      ping: () => 1,
      // @ts-expect-error rpc에 선언되지 않은 close는 초과 속성 검사에서 걸린다.
      close: () => true,
    },
    state: { level: currentValueSource(new BehaviorSubject(0)) },
    event: { line: broadcastEvent(new Subject<string>()) },
  });

  // @ts-expect-error 도메인에 rpc가 선언되어 있으면 rpc 필드 자체가 필수다.
  implementDomain(domain, {
    state: { level: currentValueSource(new BehaviorSubject(0)) },
    event: { line: broadcastEvent(new Subject<string>()) },
  });

  implementDomain(domain, {
    rpc: {
      open: (input) => true,
      ping: () => 1,
    },
    // @ts-expect-error state 소스는 CurrentValueSource<number>여야 한다.
    state: { level: currentValueSource(new BehaviorSubject("nope")) },
    event: { line: broadcastEvent(new Subject<string>()) },
  });

  implementDomain(domain, {
    rpc: {
      open: (input) => true,
      ping: () => 1,
    },
    state: { level: currentValueSource(new BehaviorSubject(0)) },
    // @ts-expect-error event 소스는 EventSource<string>이어야 한다(line은 number가 아니다).
    event: { line: broadcastEvent(of(1)) },
  });

  implementDomain(rpcOnlyDomain, {
    rpc: { ping: () => 1 },
    // @ts-expect-error rpc만 선언된 도메인은 state 카테고리를 갖지 않는다(?: never).
    state: {},
  });

  const a = defineDomain("a", {
    rpc: { ping: rpc({ input: noInput, output: numberOutput }) },
  });
  const b = defineDomain("b", {
    rpc: { pong: rpc({ input: noInput, output: numberOutput }) },
  });
  const composedA = composeContracts(a);
  const bImplementation = implementDomain(b, { rpc: { pong: () => 1 } });
  // @ts-expect-error b는 composedA 계약에 선언된 도메인이 아니다.
  createBridgeServer(composedA, [bImplementation]);
}
