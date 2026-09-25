# State와 Event에 서로 다른 전달 의미를 둔다

State는 최신 현재값을 표현하고 Event는 발생 순서를 가진 개별 항목을 표현한다. 따라서 State는 느린 소비자에게 중간 snapshot을 누적하지 않고, Event는 계약에 선언된 유한 버퍼와 overflow 정책을 사용한다. Event는 구독 확인 후 순서 있는 acknowledgement로 전송을 진행한다. 소비자별 흐름 제어를 통해 최신값 전달과 이벤트 보존 요구를 구분한다.

_(개정: RD-049 — "계약에 선언된 유한 버퍼"는 [ADR 0012](0012-lightweight-type-contract.md) 이후 맞지 않다. 계약은 타입이라 buffer를 담지 못한다. capacity·overflow는 Main에서 Event source를 만들 때 주는 옵션이다(`broadcastEvent(source, { buffer })`·`scopedEvent(factory, { buffer })`, 생략 시 `capacity: 100`·`overflow: "error"`). Event가 유한 버퍼와 overflow 정책을 쓴다는 결정은 그대로다.)_
