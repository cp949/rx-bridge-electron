// RD-017 DELTA-02: operation key(wire key `category:domain/op`) 문법의 단일
// 정의. Main(`src/main/registration.ts`)과 Renderer(`src/renderer/create-renderer-api.ts`)가
// 각자 복제해 온 이름 규칙·경로 충돌 검사를 이 모듈 하나로 모은다. 이
// DELTA에서는 호출자를 바꾸지 않는다 — 두 구현은 여전히 자체 로직을 쓴다
// (DELTA-03·04에서 이 모듈로 교체된다). 코어는 throw하지 않는다 — 모든
// 함수가 verdict(`{ ok: true, … } | { ok: false, reason, … }`)를 반환하고,
// 상세 에러 메시지 조립(Main `TypeError` 문구, Renderer `RemoteError`
// 문구)은 호출자 책임이다(checklist 결정 6).
//
// `./index.ts`는 이 모듈을 re-export하지 않는다 — 공개 API를 늘리지 않고
// Main·Renderer가 파일 경로로 직접 import한다(checklist 결정 2).

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

/** segment 하나의 기본 검사(빈 문자열·dotted·예약어). 실패 이유만 돌려준다. */
function checkBasicSegment(
  segment: string,
): "empty-segment" | "dotted-segment" | "reserved-segment" | undefined {
  if (segment.length === 0) return "empty-segment";
  if (segment.includes(".")) return "dotted-segment";
  if (RESERVED_WORD_SEGMENTS.has(segment)) return "reserved-segment";
  return undefined;
}

/**
 * 도메인 segment 배열을 검증한다. Main `assertDomainName`(`registration.ts:76-88`)·
 * Renderer `parseSegments`의 도메인 부분(`create-renderer-api.ts:113-127`)과
 * 같은 규칙을 같은 순서로 적용한다: (1) 각 segment의 빈 문자열·dotted·예약어를
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
    const reason = checkBasicSegment(segment);
    if (reason !== undefined) return { ok: false, reason, segment };
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
 * operation 이름을 검증한다. Main `assertOperationName`(`registration.ts:91-95`)과
 * 같은 규칙: `/`로 나눈 각 조각에 도메인과 같은 기본 검사를 적용한 뒤, 조각이
 * 둘 이상이면(중첩 경로) 거부한다. wire key 파싱(`parseWireKey`)은 이미
 * `/`로 나눈 마지막 조각 하나만 넘기므로 `nested-operation`에 보통 도달하지
 * 않지만, 이 함수는 아직 나누지 않은 원시 이름(Main의 impl namespace key
 * 등)을 직접 받는 호출에도 안전하도록 그 검사를 유지한다.
 */
export function checkOperationName(operation: string): OperationKeyVerdict {
  const segments = operation.split("/");
  for (const segment of segments) {
    const reason = checkBasicSegment(segment);
    if (reason !== undefined) return { ok: false, reason, segment };
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
 * 중복 경로를 검출한다. Main `addPath`(`registration.ts:111-131`)·Renderer
 * `addPath`(`create-renderer-api.ts:131-152`)와 같은 알고리즘이다 — 두
 * 구현 모두 카테고리 전체에 걸쳐 trie 하나를 공유하므로(`walkImplNode`의
 * `pathTree`, `parseHandshake`의 `paths`), 카테고리가 달라도 경로가 겹치면
 * 충돌로 본다. `add`를 호출하는 쪽이 인스턴스를 만들어 매니페스트/impl 전체에
 * 걸쳐 재사용한다.
 */
export class OperationPathTrie {
  private readonly root: TrieNode = { leaf: false, children: new Map() };

  add(segments: readonly string[]): OperationPathVerdict {
    let node = this.root;
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
