// operation key(wire key `category:domain/op`) 문법의 단일 정의. Main 등록
// (`buildRegistrationTableFromImpl`)과 Renderer manifest 파서
// (`createRendererApi`)가 모두 이 모듈을 호출한다 — 코드는 공유하고 신뢰는
// 공유하지 않는다(ADR 0007 개정 절). 코어는 throw하지 않고 verdict를
// 반환하며, 에러 타입·메시지 조립(Main `TypeError`, Renderer `RemoteError`)은
// 호출자 책임이다.
//
// `./index.ts`는 이 모듈을 re-export하지 않는다 — 공개 API가 아니다.

/** wire key의 3가지 카테고리 prefix. */
export const OPERATION_CATEGORIES = ["rpc", "state", "event"] as const;

export type OperationCategory = (typeof OPERATION_CATEGORIES)[number];

export function isOperationCategory(value: string): value is OperationCategory {
  return (OPERATION_CATEGORIES as readonly string[]).includes(value);
}

/**
 * segment 이름으로 쓸 수 없는 예약어. `__proto__`는 object literal 대입 시
 * prototype setter로 취급되고, `prototype`·`constructor`는 함수/클래스의
 * 내장 속성과 충돌하며, `then`은 Promise 판별(thenable 검사)과 충돌한다 —
 * 넷 다 도메인·operation 어느 위치든 segment 이름으로 쓰일 수 없다.
 */
const RESERVED_WORD_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "then",
]);

/** 도메인의 첫 segment로 쓸 수 없는 예약어. Renderer API의 `dispose()`와 충돌한다. */
const ROOT_RESERVED_SEGMENT = "dispose";

export type OperationKeyReason =
  | "empty-segment"
  | "dotted-segment"
  | "reserved-segment"
  | "nested-operation"
  | "unknown-category";

export interface OperationKeyOk {
  readonly ok: true;
}

export interface OperationKeyReject {
  readonly ok: false;
  readonly reason: OperationKeyReason;
  /** `reserved-segment`처럼 어느 segment가 실패했는지가 메시지에 필요한 경우만 채운다. */
  readonly segment?: string;
}

export type OperationKeyVerdict = OperationKeyOk | OperationKeyReject;

/**
 * segment 하나의 위치 무관 검사(빈 문자열·dotted·JS 예약어). 도메인 전체
 * 경로 기준 규칙(root `dispose`, 카테고리 이름)은 적용하지 않는다 — Main이
 * impl namespace key(`"a/b"`)를 조각별로 검사할 때 이 함수를 쓴다.
 */
export function checkSegment(segment: string): OperationKeyVerdict {
  if (segment.length === 0) {
    return { ok: false, reason: "empty-segment", segment };
  }
  if (segment.includes(".")) {
    return { ok: false, reason: "dotted-segment", segment };
  }
  if (RESERVED_WORD_SEGMENTS.has(segment)) {
    return { ok: false, reason: "reserved-segment", segment };
  }
  return { ok: true };
}

/**
 * 도메인 segment 배열을 검증한다. 규칙을 이 순서로 적용한다: (1) 각 segment의 빈 문자열·dotted·예약어를
 * segment 순서대로 검사해 처음 걸린 곳에서 멈춘다 (2) 첫 segment가
 * `dispose`면 거부한다(중첩 위치의 `dispose`는 허용) (3) 어느 위치든
 * 카테고리 이름(`rpc`/`state`/`event`) segment는 거부한다. 도메인 자체가
 * 없는 wire key(빈 배열)는 빈 segment 하나로 취급한다.
 */
export function checkDomainSegments(
  domain: readonly string[],
): OperationKeyVerdict {
  const segments = domain.length === 0 ? [""] : domain;
  for (const segment of segments) {
    const verdict = checkSegment(segment);
    if (!verdict.ok) return verdict;
  }
  if (segments[0] === ROOT_RESERVED_SEGMENT) {
    return { ok: false, reason: "reserved-segment", segment: segments[0] };
  }
  for (const segment of segments) {
    if (isOperationCategory(segment)) {
      return { ok: false, reason: "reserved-segment", segment };
    }
  }
  return { ok: true };
}

/**
 * operation 이름을 검증한다. `/`로 나눈 각 조각에 `checkSegment`를 적용한 뒤,
 * 조각이 둘 이상이면(중첩 경로) 거부한다. `parseWireKey`는 이미 나눈 마지막
 * 조각만 넘기므로 `nested-operation`은 Main이 impl의 operation key(원시
 * 문자열)를 넘길 때만 나온다.
 */
export function checkOperationName(operation: string): OperationKeyVerdict {
  const segments = operation.split("/");
  for (const segment of segments) {
    const verdict = checkSegment(segment);
    if (!verdict.ok) return verdict;
  }
  if (segments.length !== 1) {
    return { ok: false, reason: "nested-operation" };
  }
  return { ok: true };
}

/**
 * 검증 없이 wire key 문자열을 조립하는 순수 함수. 호출자가 이미 유효성을
 * 확인한 `category`·`domain`·`operation`에만 쓴다.
 */
export function formatWireKey(
  category: OperationCategory,
  domain: readonly string[],
  operation: string,
): string {
  return `${category}:${domain.join("/")}/${operation}`;
}

export interface ParsedWireKeyOk {
  readonly ok: true;
  readonly category: OperationCategory;
  readonly domain: readonly string[];
  readonly operation: string;
}

export type ParseWireKeyVerdict = ParsedWireKeyOk | OperationKeyReject;

/**
 * wire key 문자열(`category:domain/op`)을 분해하고 검증한다. 첫 `:` 앞을
 * `OPERATION_CATEGORIES`와 대조하고(콜론이 없거나 알 수 없는 prefix면
 * `unknown-category`), 나머지를 `/`로 나눠 마지막 조각을 operation, 그 앞
 * 전부를 도메인으로 삼아 `checkDomainSegments`·`checkOperationName`을
 * 차례로 적용한다. 이 함수는 "이 키가 속한 카테고리 배열"을 모른다 — 배열
 * prefix와 카테고리가 일치하는지(Renderer 전용 검사)는 호출자 책임이다.
 */
export function parseWireKey(key: string): ParseWireKeyVerdict {
  const colonIndex = key.indexOf(":");
  if (colonIndex === -1) {
    return { ok: false, reason: "unknown-category" };
  }
  const prefix = key.slice(0, colonIndex);
  if (!isOperationCategory(prefix)) {
    return { ok: false, reason: "unknown-category" };
  }
  const path = key.slice(colonIndex + 1);
  const segments = path.split("/");
  const domain = segments.slice(0, -1);
  const operation = segments[segments.length - 1] ?? "";

  const domainVerdict = checkDomainSegments(domain);
  if (!domainVerdict.ok) return domainVerdict;
  const operationVerdict = checkOperationName(operation);
  if (!operationVerdict.ok) return operationVerdict;

  return { ok: true, category: prefix, domain, operation };
}

export type OperationPathReason =
  "leaf-namespace-collision" | "duplicate-or-collision";

export type OperationPathVerdict =
  OperationKeyOk | { readonly ok: false; readonly reason: OperationPathReason };

interface TrieNode {
  leaf: boolean;
  readonly children: Map<string, TrieNode>;
}

/**
 * 도메인+operation 전체 경로(카테고리 제외)를 누적하며 leaf/namespace 충돌과
 * 중복 경로를 검출한다. 호출자는 인스턴스 하나를 impl·manifest의 세 카테고리
 * 전체에 걸쳐 쓴다 — 카테고리가 달라도 경로가 겹치면 충돌이다(ADR 0007).
 */
export class OperationPathTrie {
  readonly #root: TrieNode = { leaf: false, children: new Map() };

  public add(segments: readonly string[]): OperationPathVerdict {
    let node = this.#root;
    for (const segment of segments) {
      if (node.leaf) {
        return { ok: false, reason: "leaf-namespace-collision" };
      }
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { leaf: false, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    if (node.leaf || node.children.size > 0) {
      return { ok: false, reason: "duplicate-or-collision" };
    }
    node.leaf = true;
    return { ok: true };
  }
}
