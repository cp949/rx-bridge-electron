// DELTA-05(RD-012) 테스트 공용 픽스처. `impl-schemas.test.ts`(런타임 동작)와
// `impl-schemas-types.test.ts`(컴파일 검증) 양쪽이 같은 도메인을 공유한다.
// 한 도메인 안에서 operation별로 스키마 적용 여부를 다르게 둬서 부분·점진
// 적용을 확인한다.
// - connect: 입력·출력 스키마 모두 없음(완전 통과).
// - send: 입력 스키마만 적용.
// - echo: 출력 스키마만 적용하고, 스키마가 값을 변환한다(zod `.transform()`과
//   동등한 상황을 재현해 RD-004 "출력 재검사" 동작을 확인한다).
// - cyclic: 출력 스키마가 BridgeValue 경계를 어기는 값(순환 참조)으로
//   변환해 출력 검증 실패 경로를 확인한다.
// - boom: 스키마 없음. `options.errors`로 선언한 코드만 그대로 전달되고
//   나머지는 안전한 오류로 바뀌는지 확인한다.
// - state.count / event.alerts: 출력 스키마를 적용해 State·Event 양쪽에서도
//   같은 검증·실패 분류가 적용되는지 확인한다.
// - state.connection / event.data: 출력 스키마 없이 통과한다(대조군).
//
// `schemas`/`errors`는 `satisfies SchemasFor<AppBridge>`/`satisfies
// ErrorsFor<AppBridge>`로 선언한다 — ADR 0012가 문서화한 "파일 분리" 패턴
// 자체가 이 픽스처 파일이다.
import { BehaviorSubject, Subject } from "rxjs";

import type {
  BridgeImpl,
  ErrorsFor,
  Schema,
  SchemasFor,
} from "../../src/contract/index.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";

export type Connection = { readonly ok: boolean };
export type SendResult = { readonly bytesWritten: number };
export type EchoResult = { readonly value: number };
export type SerialLine = { readonly text: string };
export type Alert = {
  readonly level: "info" | "warn" | "error";
  readonly text: string;
};

export type AppBridge = {
  device: {
    rpc: {
      connect(): Connection;
      send(input: { readonly command: string }): SendResult;
      echo(input: { readonly value: number }): EchoResult;
      cyclic(): { readonly ok: true };
      boom(input: { readonly code: string }): { readonly ok: true };
    };
    state: {
      connection: Connection;
      count: number;
    };
    event: {
      data: SerialLine;
      alerts: Alert;
    };
  };
};

const sendInputSchema: Schema<{ readonly command: string }> = {
  parse(value) {
    if (
      value === null ||
      typeof value !== "object" ||
      typeof (value as { command?: unknown }).command !== "string" ||
      (value as { command: string }).command.length === 0
    )
      throw new Error("command must be a non-empty string");
    return value as { readonly command: string };
  },
};

/** zod의 `.transform()`처럼 입력과 다른 값을 반환하는 출력 스키마. */
const echoOutputSchema: Schema<EchoResult> = {
  parse(value) {
    const raw = value as { readonly value?: unknown };
    if (typeof raw.value !== "number")
      throw new Error("value must be a number");
    return { value: raw.value * 2 };
  },
};

/** 변환 결과가 BridgeValue 경계를 어기는(순환 참조) 출력 스키마. */
const cyclicOutputSchema: Schema<{ readonly ok: true }> = {
  parse() {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    return circular as unknown as { readonly ok: true };
  },
};

const countOutputSchema: Schema<number> = {
  parse(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error("count must be a finite number");
    return value;
  },
};

const alertOutputSchema: Schema<Alert> = {
  parse(value) {
    const raw = value as {
      readonly level?: unknown;
      readonly text?: unknown;
    };
    if (
      (raw.level !== "info" && raw.level !== "warn" && raw.level !== "error") ||
      typeof raw.text !== "string"
    )
      throw new Error("invalid alert shape");
    return raw as Alert;
  },
};

export const schemas = {
  device: {
    rpc: {
      send: { input: sendInputSchema },
      echo: { output: echoOutputSchema },
      cyclic: { output: cyclicOutputSchema },
    },
    state: { count: countOutputSchema },
    event: { alerts: alertOutputSchema },
  },
} satisfies SchemasFor<AppBridge>;

export const errors = {
  device: { rpc: { boom: ["DEVICE_BUSY"] } },
} satisfies ErrorsFor<AppBridge>;

/**
 * 매 테스트마다 독립된 impl과 그 내부 subject들을 만든다. `initialCount`로
 * state.count의 시작값을 바꿀 수 있게 해, 구독 시점부터 출력 스키마 검증이
 * 실패하는 경우(예: `NaN`)를 별도 subject 없이 재현한다.
 */
export function buildAppBridgeImpl(
  options: { readonly initialCount?: number } = {},
): {
  readonly impl: BridgeImpl<AppBridge>;
  readonly connectionSource: BehaviorSubject<Connection>;
  readonly countSource: BehaviorSubject<number>;
  readonly dataEvents: Subject<SerialLine>;
  readonly alertEvents: Subject<Alert>;
} {
  const connectionSource = new BehaviorSubject<Connection>({ ok: true });
  const countSource = new BehaviorSubject<number>(options.initialCount ?? 0);
  const dataEvents = new Subject<SerialLine>();
  const alertEvents = new Subject<Alert>();
  const impl: BridgeImpl<AppBridge> = {
    device: {
      rpc: {
        connect: () => ({ ok: true }),
        send: (input) => ({ bytesWritten: input.command.length }),
        echo: (input) => ({ value: input.value }),
        cyclic: () => ({ ok: true }),
        boom: (input) => {
          throw Object.assign(new Error("device busy"), { code: input.code });
        },
      },
      state: {
        connection: currentValueSource(connectionSource),
        count: currentValueSource(countSource),
      },
      event: {
        data: broadcastEvent(dataEvents),
        alerts: broadcastEvent(alertEvents),
      },
    },
  };
  return { impl, connectionSource, countSource, dataEvents, alertEvents };
}
