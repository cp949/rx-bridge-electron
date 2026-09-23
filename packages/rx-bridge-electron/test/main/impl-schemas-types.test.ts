// DELTA-05(RD-012): ADR 0012가 문서화한 "파일 분리" 패턴 — `schemas`/`errors`
// map을 `satisfies SchemasFor<B>`/`satisfies ErrorsFor<B>`로 별도 파일에 두고
// `createBridgeServer`에 그대로 넘긴다 — 이 실제로 컴파일되는지 확인한다.
// 값 자체는 `impl-schemas-fixture.ts`에 있다. 런타임 동작 검증은
// `impl-schemas.test.ts`에 있다.
import { expectTypeOf, test } from "vitest";

import type { ErrorsFor, SchemasFor } from "../../src/contract/index.js";
import { createBridgeServer } from "../../src/main/index.js";
import {
  buildAppBridgeImpl,
  errors,
  schemas,
  type AppBridge,
} from "./impl-schemas-fixture.js";

test("분리 파일의 schemas/errors map이 SchemasFor<AppBridge>/ErrorsFor<AppBridge>를 만족한다", () => {
  expectTypeOf(schemas).toExtend<SchemasFor<AppBridge>>();
  expectTypeOf(errors).toExtend<ErrorsFor<AppBridge>>();

  // `satisfies`로 검사한 리터럴 타입이 명시적 타입 위치에도 그대로
  // 대입되는지(구조적 호환) 확인한다 — 실제 사용처(createBridgeServer의
  // options)와 같은 대입이다.
  const asSchemas: SchemasFor<AppBridge> = schemas;
  const asErrors: ErrorsFor<AppBridge> = errors;
  void asSchemas;
  void asErrors;
});

test("분리 파일의 schemas/errors map을 createBridgeServer(impl, options)에 그대로 넘길 수 있다", () => {
  const { impl } = buildAppBridgeImpl();
  // 컴파일만 확인한다 — 런타임 왕복은 impl-schemas.test.ts가 검증한다.
  createBridgeServer(impl, { schemas, errors });
});
