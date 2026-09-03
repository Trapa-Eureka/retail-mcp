# 003 — T2 적대적 검수 기록

- 검수일: 2026-09-02
- 대상 커밋: `a456fb7` (`T2: FixtureLoyverseClient + fixtures (#2)`)
- 판정(검수 당시): **실패 — 로컬 자체 스키마에는 통과하지만 실제 Loyverse 원시 응답 계약과 증분 동기화 요구를 충족하지 못함**
- 현재 상태(2026-09-03 재확인, docs/009 DOC-005 대응): **RESOLVED** — 아래 "재검수 완료 기준" 전 항목 [x](마지막 `npm run check` 체크박스는 당시 표기 누락이었을 뿐 실제로는 `fix-t2` 병합 시점부터 통과 상태였다 — TASKS.md T2 이후 전 태스크가 그 위에서 계속 통과해온 것이 증거), `fix-t2` 브랜치(2026-09-02)로 병합.
- 공식 확인 기준: [Loyverse API Reference](https://developer.loyverse.com/docs/)
- 범위: fixtures, Zod schemas, `FixtureLoyverseClient`, 관련 테스트

## 통과한 항목

- 매장 2개, 상품 8개, inventory 16행
- 2026-07-28~2026-08-31의 35개 달력일에 걸친 receipt 84건
- 두 매장과 8개 variant가 판매 데이터에 등장
- item/receipt/inventory가 각각 2페이지 이상으로 재생됨
- 재고 0과 한글·타갈로그 이름이 포함됨

## 발견 003-01 — 실제 inventory 응답의 `updated_at`을 스키마와 타입에서 버림

- 심각도: **치명적**
- 영역: `LvInventoryLevelSchema`, `LvInventoryLevel`, fixture mapping
- 증거:
  - fixture JSON에는 `updated_at`이 존재한다.
  - 공식 inventory 응답도 각 level에 `updated_at`을 제공한다.
  - Zod schema는 `.passthrough()`로 이를 받아들이지만 반환 타입과 mapping에서 제거한다.
  - Warehouse의 `InventoryRow`는 `updatedAt: Date`를 필수로 요구한다.
- 영향: T7은 원시 최신 시각을 전달받지 못해 값을 임의 생성해야 한다. stale 판정과 최신성 비교가 잘못될 수 있다.
- 요구 조치: ISO datetime으로 검증하여 `LvInventoryLevel.updated_at`에 보존하고 invalid date 테스트를 추가한다.

## 발견 003-02 — receipt 증분 watermark에 필요한 `updated_at`이 없음

- 심각도: **치명적**
- 영역: `LvReceiptSchema`, `LvReceipt`, `listReceipts`
- 증거:
  - DESIGN §11.1은 receipt watermark를 `(updated_at, receipt_id)`처럼 다루도록 요구한다.
  - 공식 receipt에는 `created_at`, `updated_at`, `receipt_date`가 별도로 존재한다.
  - 현재 타입은 `receipt_date`만 보존하고 `sinceISO` 필터도 `receipt_date`에 적용한다.
- 영향: 과거 날짜의 영수증이 나중에 수정·환불·취소되어도 다음 동기화가 이를 다시 가져오지 않아 판매량이 영구적으로 틀릴 수 있다. T3/T7이 문서 계약대로 구현될 수 없다.
- 요구 조치: `updated_at`을 필수 보존하고 API 필터 의미를 `updated_at_min` watermark로 명시한다. 동일 updated_at 경계와 과거 receipt 수정 fixture를 추가한다.

## 발견 003-03 — 취소 영수증 정보를 버려 매출에 포함될 위험

- 심각도: **높음**
- 영역: receipt schema/type/fixture
- 증거: 공식 receipt의 `cancelled_at`이 타입에 없으며 fixture에도 취소 시나리오가 없다.
- 영향: 취소 영수증을 일반 판매로 적재하면 셀스루, 평균판매, 재주문량이 부풀려진다.
- 요구 조치: nullable `cancelled_at`을 보존하고 ETL 정책(제외 또는 음수 보정)을 SPEC/DESIGN에 확정한 뒤 취소 fixture/test를 추가한다.

## 발견 003-04 — 환불 원시 응답을 내부 변환값으로 위장함

- 심각도: **높음**
- 영역: receipts fixture, `LvReceiptSchema`, `LvReceipt`
- 증거:
  - fixture에는 `receipt_type: "REFUND"`가 있지만 schema의 passthrough 후 mapping에서 제거된다.
  - fixture의 refund line `quantity`와 금액은 이미 음수로 작성되어 있다.
  - 공식 계약은 receipt에 `receipt_type`과 `refund_for`를 제공하므로 원시 fixture는 이를 보존하고 부호 변환은 ETL에서 명시적으로 수행해야 한다.
- 영향: 테스트는 “실제 응답 파싱”이 아니라 “ETL 변환이 끝난 가상 응답 파싱”을 검증한다. 실 API가 양수 환불 수량을 반환할 경우 환불이 판매로 더해질 수 있으며, T7의 환불 변환 책임도 사라진다.
- 요구 조치: 실제 API 샘플과 같은 원시 부호·필드를 사용하고 `receipt_type`, `refund_for`를 타입에 포함한다. ETL 테스트에서 REFUND를 정확히 한 번만 음수화한다.

## 발견 003-05 — 날짜 스키마가 ISO 8601을 검증하지 않음

- 심각도: **높음**
- 영역: `LvReceiptSchema.receipt_date`
- 증거: `z.string().min(1)`이므로 `not-a-date`도 통과한다. 타입 별칭 이름만 `IsoDateTimeString`이고 런타임 보장은 없다.
- 영향: 정렬과 `sinceISO` 비교가 문자열 사전식 비교에 의존하여 잘못된 순서·누락을 만들고, 이후 `Date` 변환에서 invalid date가 전파된다.
- 요구 조치: timezone이 포함된 ISO datetime schema를 사용하고 invalid/offset datetime 경계 테스트를 추가한다.

## 발견 003-06 — cursor가 동일한 조회 조건에 묶이지 않음

- 심각도: **중간**
- 영역: fixture pagination
- 증거: cursor는 숫자 offset뿐이고 `sinceISO`를 인코딩하거나 검증하지 않는다. 첫 페이지 이후 다른 `sinceISO`와 같은 cursor를 넘겨도 별도 목록의 offset으로 정상 처리된다.
- 영향: 호출자가 실수로 조건을 바꿔도 테스트가 이를 탐지하지 못하고 누락/중복 페이지를 만든다. 실 API cursor의 opaque 성격도 재현하지 못한다.
- 요구 조치: cursor를 opaque token으로 발급하고 원 쿼리 조건과 연결하거나, 적어도 조건 변경 시 reject하는 상태ful fixture를 제공한다.

## 발견 003-07 — 페이지 크기 입력값 검증이 없음

- 심각도: **중간**
- 영역: `FixtureLoyverseClientOptions`, `paginate`
- 증거: `itemsPageSize: 0`, 음수, `NaN`, 소수도 생성 시 허용된다.
- 영향: page size 0은 빈 페이지와 동일 cursor를 계속 반환해 소비자의 pagination loop를 무한 반복시킬 수 있다.
- 요구 조치: 생성 경계에서 양의 정수로 검증하고 0/음수/소수/NaN 거부 테스트를 추가한다.

## 발견 003-08 — 실제 응답 적합성 테스트가 자기참조적임

- 심각도: **높음**
- 영역: `loyverseSchemas.test.ts`
- 증거: 팀이 직접 만든 fixture를 팀이 직접 만든 축소 Zod schema로 파싱하는 것만 확인한다. 공식 샘플 또는 캡처된 익명화 payload와 비교하는 contract test가 없다. `.passthrough()` 때문에 필수로 보존해야 할 필드가 누락돼도 테스트가 통과한다.
- 영향: 현재처럼 원시 필드가 소실된 상태에서도 “실제 Loyverse 응답 스키마로 파싱됨” 완료 기준이 거짓 양성으로 통과한다.
- 요구 조치: 공식 응답 샘플 기반 contract fixture를 별도 고정하고, ETL에 필요한 필드는 strict required로 검증한다. passthrough 허용과 필드 보존 여부를 별개로 테스트한다.

## 발견 003-09 — 신규 품목 5일 시나리오 검증이 불충분함

- 심각도: **중간**
- 영역: `fixtureLoyverseClient.test.ts`
- 증거: bearbrand 영수증이 마지막 5일 이후라는 것만 검사하며, 정확히 5개 달력일을 포함하는지와 이전 기간에 0건인지를 집계로 고정하지 않는다.
- 영향: fixture가 1일 또는 일부 매장에만 존재하도록 퇴행해도 테스트가 통과하여 T5의 신규 품목 분모 정책 검증력이 약해진다.
- 요구 조치: 품목·매장별 판매일 집합과 창 밖 0건을 정확한 기대값으로 고정한다.

## 재검수 완료 기준

- [x] 공식 응답 필수 필드 `updated_at`, `receipt_type`, `refund_for`, `cancelled_at`, inventory `updated_at` 보존 — 스키마/타입/픽스처 매핑 전부에 추가
- [x] ISO datetime 런타임 검증 — `z.iso.datetime()`로 `created_at`/`updated_at`/`receipt_date`/`cancelled_at`(nullable) 검증, invalid-date 거부 테스트 포함
- [x] 수정·취소·환불 receipt contract fixture 및 정확한 ETL 부호 정책 — 픽스처에 취소 영수증 1건, "생성 후 사후 수정"(updated_at≠receipt_date) 영수증 1건 추가. 환불 line_items는 실제 API처럼 양수 quantity로 재생성(부호 반전은 T7에서 수행하도록 SPEC §9/DESIGN §11.3에 취소 영수증 제외 정책 명시)
- [x] cursor 조건 불변성과 page size 입력 검증 — cursor를 조회조건(sinceISO 등) 포함 opaque 토큰으로 인코딩, 조건 불일치 시 거부. page size 0/음수/소수/NaN 생성 시점에 거부
- [x] 공식 샘플 기반 독립 contract test — `tests/loyverseContractSample.test.ts`에 Loyverse 공식 문서(2026-09-02 확인) SALE/REFUND 영수증 예시, inventory 웹훅 payload 예시를 원문 그대로 옮겨 검증. 필수 필드 누락 시 여전히 거부됨도 별도 확인(passthrough와 필드 보존을 분리 테스트)
- [x] 신규 품목 5일 시나리오를 정확한 기대값으로 검증 — bearbrand 영수증 정확히 10건(5일×2매장), 매장별 날짜 집합을 정확한 배열로 고정, 창 밖 0건 확인

- [x] `npm run check` 통과

해결 커밋: `fix-t2` 브랜치 (2026-09-02). 필드 값 자체는 Loyverse 공식 문서를 브라우저로 직접 확인해 반영했다(WebFetch로는 SPA라 렌더링된 내용을 못 읽어 `mcp__claude-in-chrome__javascript_tool`로 `document.body.innerText`를 읽어 확인).
