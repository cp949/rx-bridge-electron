# `EventSource` 구성 타입이 공개 export되지 않는다

- Status: closed — `/main`에서 type export 추가
- 출처: 2026-09-26 `docs/design/` 작성 중 코드 대조(`dev` @ `f261fce` 기준).

- 사실: `EventSource`·`BroadcastEventSource`·`ScopedEventSource`·`EventSourceBuffer`·`OverflowPolicy`는 `/main`·`/contract` 어디서도 export되지 않는다. `CurrentValueSource`는 `/main`에서 export된다.
- 영향: 앱이 Event source 변수·함수 반환 타입을 명시하려면 `BridgeImpl<B>`에서 indexed access로 꺼내야 한다. buffer 옵션 객체를 따로 선언할 때 `OverflowPolicy`를 쓸 수 없다.
- architecture.md는 "EventSource와 구성 타입은 공개 export하지 않는다"로 코드 기준 서술이다.
- 후보: `/main`에서 type export 추가, 또는 현 상태 유지(helper 반환 타입 추론으로 충분)를 결정.

## Comments

- 2026-09-26: `/main`에서 type export를 추가했다. `src/main/sources.ts`는 이미 5개 타입을 re-export하고 있었고 `src/main/index.ts`가 `CurrentValueSource`만 골라 내보냈다. `index.ts`에 `BroadcastEventSource`·`EventSource`·`EventSourceBuffer`·`OverflowPolicy`·`ScopedEventSource`를 추가했다. `/contract`는 그대로 export하지 않는다(`BridgeImpl` 구현 측 타입은 Main 진입점 소유). test: `test/main/event-source-types.test.ts`(buffer 객체를 공개 타입으로 선언해 helper에 전달, `EventSource<T>`와 `BridgeImpl<B>` event 자리 타입 동일). 문서: `docs/architecture.md`(export 서술), `docs/design/01-contract.md`, 패키지 README "Event buffer 옵션" 절.
