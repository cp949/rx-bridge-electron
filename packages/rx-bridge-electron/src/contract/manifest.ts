/**
 * 등록 테이블 형식과 무관한, wire상의 공개 manifest 형식. `main/registration.ts`의
 * `manifestFromTable`이 실제 값을 만든다(descriptor API 제거 이후 유일한
 * 생성 경로, DELTA-09).
 */
export interface PublicManifest {
  readonly rpc: readonly string[];
  readonly state: readonly string[];
  readonly event: readonly string[];
}
