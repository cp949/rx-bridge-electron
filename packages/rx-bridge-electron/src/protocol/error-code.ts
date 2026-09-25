/**
 * 라이브러리가 스스로 만드는 오류 code의 유일한 정의. 선언 오류
 * (`options.errors`)가 실어 보내는 임의 문자열 code는 여기에 없다.
 */
export type TransportErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "RESOURCE_EXHAUSTED"
  | "VERSION_MISMATCH"
  | "INTERNAL"
  | "STREAM_OVERFLOW";
