// 등록 테이블 기반 manifest(`manifestFromTable`)가 descriptor 기반
// `publicManifest`와 완전히 같은 입력에 대해 같은 형식·값을 내는지 검증한다
// (DELTA-03 완료 기준). 두 경로 모두 같은 계약+구현으로 만든 뒤 결과를
// deep-equal 비교한다.
import { BehaviorSubject, Subject } from "rxjs";
import { describe, expect, test } from "vitest";

import {
  composeContracts,
  defineDomain,
  event,
  publicManifest,
  rpc,
  state,
  type Schema,
} from "../../src/contract/index.js";
import { implementDomain } from "../../src/main/implement-domain.js";
import {
  buildRegistrationTableFromContract,
  manifestFromTable,
  registerImplementations,
} from "../../src/main/registration.js";
import { broadcastEvent, currentValueSource } from "../../src/main/sources.js";

const stringSchema: Schema<string> = { parse: (value) => String(value) };
const numberSchema: Schema<number> = {
  parse(value) {
    if (typeof value !== "number") throw new TypeError("number required");
    return value;
  },
};

/** 도메인명 정렬·operation명 정렬이 서로 엇갈릴 수 있는 다도메인·다연산 계약. */
function buildMultiDomainContract() {
  const hardware = defineDomain("hardware", {
    rpc: {
      connect: rpc({
        input: numberSchema,
        output: stringSchema,
        errors: ["DEVICE_NOT_FOUND"] as const,
      }),
      zzzLast: rpc({ input: numberSchema, output: numberSchema }),
    },
    state: { connection: state(stringSchema), zzzState: state(stringSchema) },
    event: { error: event(stringSchema), zzzEvent: event(stringSchema) },
  });
  const alpha = defineDomain("alpha", {
    rpc: { op: rpc({ input: numberSchema, output: numberSchema }) },
  });
  // "a"와 "a/b"처럼 접두 관계인 도메인명이 있으면 "도메인명 정렬 후
  // operation명 정렬"과 "결합 문자열 통짜 정렬"의 결과가 달라질 수 있다.
  // manifestFromTable이 전자와 같음을 이 케이스로 확인한다.
  const a = defineDomain("a", {
    rpc: { z: rpc({ input: numberSchema, output: numberSchema }) },
  });
  const aB = defineDomain("a/b", {
    rpc: { m: rpc({ input: numberSchema, output: numberSchema }) },
  });
  const contract = composeContracts(hardware, alpha, a, aB);

  const hardwareImplementation = implementDomain(hardware, {
    rpc: {
      connect: async (input: number) => String(input),
      zzzLast: async (input: number) => input,
    },
    state: {
      connection: currentValueSource(new BehaviorSubject("idle")),
      zzzState: currentValueSource(new BehaviorSubject("idle")),
    },
    event: {
      error: broadcastEvent(new Subject<string>()),
      zzzEvent: broadcastEvent(new Subject<string>()),
    },
  });
  const alphaImplementation = implementDomain(alpha, {
    rpc: { op: async (input: number) => input },
  });
  const aImplementation = implementDomain(a, {
    rpc: { z: async (input: number) => input },
  });
  const aBImplementation = implementDomain(aB, {
    rpc: { m: async (input: number) => input },
  });

  return {
    contract,
    implementations: [
      hardwareImplementation,
      alphaImplementation,
      aImplementation,
      aBImplementation,
    ],
  };
}

describe("registration table manifest parity", () => {
  test("manifestFromTable equals publicManifest for the same contract and implementations", () => {
    const { contract, implementations } = buildMultiDomainContract();

    const expected = publicManifest(contract);

    const registrations = registerImplementations(contract, implementations);
    const table = buildRegistrationTableFromContract(contract, registrations);
    const actual = manifestFromTable(table);

    expect(actual).toEqual(expected);
  });

  test("manifestFromTable orders entries by domain name then operation name, not by joined path", () => {
    const { contract, implementations } = buildMultiDomainContract();
    const registrations = registerImplementations(contract, implementations);
    const table = buildRegistrationTableFromContract(contract, registrations);
    const manifest = manifestFromTable(table);

    // 도메인명 정렬: "a" < "a/b" < "alpha" < "hardware".
    // "a" 도메인의 "z"가 "a/b" 도메인의 "m"보다 앞에 온다 — 결합 문자열
    // ("a/b/m" vs "a/z")로 정렬했다면 순서가 뒤집혔을 것이다.
    expect(manifest.rpc).toEqual([
      "rpc:a/z",
      "rpc:a/b/m",
      "rpc:alpha/op",
      "rpc:hardware/connect",
      "rpc:hardware/zzzLast",
    ]);
    expect(manifest.state).toEqual([
      "state:hardware/connection",
      "state:hardware/zzzState",
    ]);
    expect(manifest.event).toEqual([
      "event:hardware/error",
      "event:hardware/zzzEvent",
    ]);
  });
});
