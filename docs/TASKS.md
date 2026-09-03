# TASKS — retail-mcp v0.1 백로그

## 사용법

- 한 에이전트 세션 = 한 태스크. 프롬프트 템플릿:
  > `docs/SPEC.md`, `docs/DESIGN.md`, `docs/TESTING.md`를 읽고 **T5**를 수행해. 완료 기준을 전부 충족하고 `npm run check`가 통과할 때까지 스스로 수정해. 끝나면 변경 파일과 검증 결과를 요약해.
- 완료 기준은 전부 기계 판정 가능해야 한다. 완료 시 상태 `DONE(날짜)` 갱신 + 커밋(`T{n}: 요약`).
- 병렬 레인: T1 완료 후 **A(T2→T3), B(T4), C(T5), D(T6)** 는 서로 다른 worktree 에이전트로 동시 진행 가능.

의존 그래프: `T0 → T1 → {A: T2→T3, B: T4, C: T5, D: T6} → T7(T2,T4) → T8(T4,T5,T6) → T9(T7,T8, T6) → T10(T9) → T11`

---

### T0 — 프로젝트 스캐폴딩 · 상태: TODO
- 목표: TS strict + ESLint + Prettier + Vitest + 스크립트 일체 (`check/test/typecheck/lint/dev/migrate/agent:reorder/smoke`), `.env.example`, `.gitignore`.
- 완료 기준: [ ] `npm run check` 통과 [ ] 더미 테스트 1개 실행 [ ] git init + 첫 커밋

### T1 — 마이그레이션 + 도메인 타입 · 상태: TODO · 의존: T0
- 목표: `migrations/001_init.sql` (DESIGN §2 전체), 최소 마이그레이션 러너(`scripts/migrate.ts` — 적용 이력 테이블 포함), `core/types.ts` (DESIGN §4 인터페이스 전체).
- 완료 기준: [ ] PGlite에 001 적용 → 전 테이블 존재 검증 테스트 [ ] 러너 2회 실행 멱등 [ ] check 통과

### T2 (레인 A) — FixtureLoyverseClient + 픽스처 · 상태: TODO · 의존: T1
- 목표: TESTING §2 시나리오(매장2×품목8×35일, 환불·신규·재고0·유니코드 포함) 픽스처 제작 + 페이지네이션 재현 목 클라이언트.
- 완료 기준: [ ] 픽스처가 실제 Loyverse 응답 스키마(zod)로 파싱됨 [ ] 커서 페이지 2개 이상 재현 테스트 [ ] check 통과

### T3 (레인 A) — Loyverse 실어댑터 · 상태: TODO · 의존: T2
- 목표: fetch 기반 `loyverseClient` — 토큰 헤더, 커서 페이지네이션, 429 지수 백오프. 테스트는 주입된 목 fetch로 요청 형태만 검증 (실호출 없음).
- 완료 기준: [ ] LoyverseClient 계약 충족 [ ] 백오프 로직 fake timer 테스트 [ ] 시크릿 하드코딩 없음 [ ] check 통과

### T4 (레인 B) — 웨어하우스 어댑터 · 상태: TODO · 의존: T1
- 목표: `pgWarehouse` (pg/PGlite 겸용 — 커넥션 주입) — upsert 전부, 커서, 스냅샷, 고정 집계 쿼리(`querySalesAgg`, `queryStock`), `agent_send_log`.
- 완료 기준: [ ] PGlite로 upsert 멱등 테스트 [ ] 집계 쿼리가 골든 픽스처 합계와 일치 [ ] SQL 전부 파라미터라이즈드 [ ] check 통과

### T5 (레인 C) — 지표 코어 · 상태: TODO · 의존: T1
- 목표: `core/metrics.ts` 순수 함수 5종 (DESIGN §3 수식 그대로).
- 완료 기준: [ ] **TESTING §3 골든 케이스 전부** 하드코딩 값으로 통과 [ ] ∞/null 경계 처리 [ ] Clock 주입 확인 [ ] check 통과

### T6 (레인 D) — 알림 + 요약 어댑터 · 상태: TODO · 의존: T1
- 목표: sheet_mcp에서 `NotificationProvider`/`ResendEmailProvider` 이식(+출처 주석), `MockNotificationProvider`, `Summarizer` 인터페이스 + Claude API 구현 + `MockSummarizer`.
- 완료 기준: [ ] 목 fetch로 Resend·Claude 요청 형태 테스트 [ ] Summarizer 프롬프트에 "수치 생성 금지, 제공된 표의 사실만" 명시 [ ] check 통과

### T7 — ETL 동기화 · 상태: TODO · 의존: T2, T4
- 목표: `etl/sync.ts` — DESIGN §5 순서·커서·멱등·부분 실패 재개.
- 완료 기준: [ ] **TESTING §4 ETL 4항목 전부** 통과 [ ] check 통과

### T8 — 재주문 에이전트 · 상태: DONE(2026-09-02) · 의존: T4, T5, T6
- 목표: `agent/reorder.ts` — DESIGN §7 흐름, 이중 게이트(`SEND_MODE` + `--confirm`), LLM 실패 시 표만 발송.
- 완료 기준: [ ] **TESTING §4 에이전트 5항목 전부** 통과 [ ] check 통과

### T9 — MCP 서버 · 상태: DONE(2026-09-02) · 의존: T7, T8(코어 재사용 확인용), T6
- 목표: 도구 6종(DESIGN §6, zod 스키마), server.ts는 조립만, `.mcp.json` 커밋.
- 완료 기준: [ ] **TESTING §4 MCP 4항목 전부** 통과 (도구=에이전트 수치 일치 포함) [ ] `npm run dev` 기동 [ ] check 통과

### T10 — e2e-mock + 커버리지 + 성능 가드 · 상태: DONE(2026-09-02) · 의존: T9
- 목표: MCP SDK 클라이언트로 stdio 서버 도구 호출 e2e, 50k행 성능 테스트, 커버리지 리포트.
- 완료 기준: [ ] sync → sell_through → reorder_suggestions 시나리오 통과 [ ] 50k행 < 5초 [ ] core ≥ 90% 리포트 [ ] check 통과

### T11 — 스모크 + 문서 갱신 · 상태: DONE(2026-09-02) · 의존: T10
- 목표: `scripts/smoke.ts`(TESTING §5), README 퀵스타트 실명령 갱신, cron 등록 예시(macOS launchd/crontab 한 줄).
- 완료 기준: [ ] smoke dry-run 정상 출력 [ ] 사람 실행 절차 README 5줄 이내 [ ] check 통과

---

## v0.2 대기열 — CSV/Excel 이후로 미룬 항목

CSV/Excel 채널(T12~T22)과 무관한 항목들이다 — `explore_sql`(읽기 전용 롤)은 여전히 착수 금지(트리거 없음 — 시트/데이터와 무관한 보안 설계 항목). SCM 시트 연동 / 정통 셀스루 / 팩 단위 반올림은 사용자가 실제 샘플 시트를 제공해(2026-09-03) T23·T24로 착수했다(아래). T23/T24가 미룬 "MCP 도구·에이전트 배선"은 T25로, "실 Google Sheets API 연동"은 다음 태스크로 순서를 정해 진행 중이다(2026-09-03, 한 태스크씩 완료→머지→확인 후 다음 진행). (이전 버전에 있던 "StoreHub CSV 폴백 파서"는 SPEC §11 재검토로 폐기 — CSV/Excel은 폴백이 아니라 T12~T22의 주 데이터소스로 승격됐다.)

### T23 — SCM 입고 실적 스키마 + 재고 정합성 검증 · 상태: DONE(2026-09-03) · 의존: 없음(v0.1/T12~T22와 독립)
- 목표: 사용자가 제공한 실제 샘플 구글시트("발주, 입고 데이터" — 상품목록/입출고내역/재고현황/판매요약/대시보드 5탭)를 근거로, SCM 입고 실적을 적재하는 스키마·웨어하우스 계층과 그걸로 계산하는 "정통 셀스루"·"재고 정합성 검증"을 구현한다. 실제 Google Sheets API 연동(자격증명·의존성 결정)은 이번 스코프 밖 — 시트 스냅샷을 테스트 픽스처로만 쓴다(사용자 확인, "지금은 픽스처로만" 선택).
- 완료 기준: [x] `purchase_receipts` 스키마 + upsert 멱등·FK 테스트 [x] `queryPurchaseAgg`가 `querySalesAgg`와 대칭 형태로 기간·매장 필터 동작 [x] SCM 시트 원시 행 zod 스키마 + "구분=입고만 반영, 출고는 스킵" 도메인 변환 함수 [x] 재고 정합성 검증(원장 예상재고 vs 실사재고 discrepancy) + 정통 셀스루 계산, 실제 샘플 시트 숫자로 골든 케이스 [x] check 통과
- **완료**: `migrations/004_purchase_receipts.sql`(PK `store_id,variant_id,received_at`), `core/types.ts`(`PurchaseReceiptRow`/`PurchaseAgg`/`Warehouse.upsertPurchaseReceipts`·`queryPurchaseAgg`), `adapters/pgWarehouse.ts` 구현, `core/scmSchema.ts`(원시 행 zod 스키마 + `mapScmRowsToPurchaseReceipts` — 구분=출고는 의도적으로 건너뜀, retail-mcp의 판매 원천은 Loyverse/CSV라 이중 계산 방지), `core/metrics.ts`의 `computeStockReconciliation`. **발견**: 정통 셀스루(판매÷(기초재고+입고))는 재고가 보존되는 한 §2 근사식(판매÷(판매+기말재고))과 대수적으로 항상 같은 값 — 진짜 가치는 "더 정확한 숫자"가 아니라 입고 원장 기준 예상 재고와 POS/CSV 실사 재고를 대사해 도난·파손·실사오차를 잡아내는 재고 정합성 검증. 샘플 시트에 "발주"(미입고) 상태 컬럼이 없어 원래 SCM 연동이 노렸던 "미입고 주문을 재주문 제안에서 빼는" 기능은 시트에 그 컬럼이 추가돼야 후속 가능(범위 밖으로 명시). MCP 도구·에이전트 배선, 실 Google Sheets 어댑터는 실 연동 방식(서비스 계정 vs 공개 링크 CSV export)이 결정된 뒤 별도 태스크. 상세는 `docs/SPEC.md` §13. check 통과(304 테스트 = 기존 278 + 신규 26).

### T24 — 팩 단위 반올림 · 상태: DONE(2026-09-03) · 의존: 없음(v0.1/T12~T23과 독립)
- 목표: 사용자가 §13 샘플 시트에 `포장수량(팩사이즈)` 컬럼과 검증용 계산 결과(계산 제안량/최종 발주량/발주 팩수)를 채워 새로 업로드한 시트를 근거로, `reorderQty()`가 계산한 개수 단위 재주문 제안량을 포장수량(팩/박스 단위)의 배수로 올리는 후처리 계산을 구현한다.
- 완료 기준: [x] `products.pack_size` 스키마 + upsert 멱등·coalesce 테스트(다른 채널이 값을 안 줘도 지우지 않음) [x] `reorderQty()` 자체는 변경 없이, 그 결과를 감싸는 순수 함수로 팩 단위 반올림 구현 [x] 시트가 미리 계산해둔 8개 품목(계산 제안량→최종 발주량/발주 팩수) 전부 golden case로 검증 [x] packSize 없음(낱개 매입)·제안량 0(팩도 0개)·packSize 0 이하(에러) 경계 케이스 [x] check 통과
- **완료**: `migrations/005_product_pack_size.sql`(`products.pack_size`, nullable, `>0` 체크), `core/types.ts`의 `ProductRow.packSize`(소스 중립적 — `lowStockThreshold`와 달리 CSV 전용이 아니다), `adapters/pgWarehouse.ts`(`low_stock_threshold`와 같은 coalesce 패턴). `core/metrics.ts`에 두 함수 추가 — `roundToPackMultiple(reorderQtyValue, packSize)`(§2 5개 순수 수식과 나란한 스칼라 함수, `reorderQty()` 자체는 무변경) + `applyPackRounding(rows, products)`(TASKS T17이 `computeCsvReorderMetrics`로 `computeReorderMetrics`를 감싼 것과 같은 패턴으로 배열에 적용). **CSV/Excel 템플릿에도 선택 컬럼으로 추가**하기로 결정(사용자가 "우선 optional 컬럼으로" 선택) — `core/csvSchema.ts`에 `포장수량`(optional, 0 초과) 추가, `adapters/csvExcelParser.ts`가 `저재고임계치`와 같은 방식으로 같은 SKU 값 일관성을 검증해 `ProductRow.packSize`로 변환. 기존 템플릿(컬럼 없음)은 그대로 통과(하위 호환). **MCP 도구·에이전트 배선은 이번 스코프 밖**(T23과 동일한 결정) — T18 폴더 스캔의 알림 로직에 `applyPackRounding`을 실제로 연결하는 건 후속 태스크, 지금은 파싱 결과가 packSize를 담아 나른다는 것까지만 보장한다(→ T25로 이어짐). golden case 8개(제안량→최종발주량/발주팩수) 전부 시트가 자체 계산해둔 값과 정확히 일치 확인. 상세는 `docs/SPEC.md` §14. check 통과(324 테스트 = 기존 304 + 신규 20).

### T25 — MCP 도구·에이전트 배선(팩 단위 반올림) · 상태: DONE(2026-09-03) · 의존: T24
- 목표: T23/T24가 미룬 "MCP 도구·에이전트 배선" 중 **팩 단위 반올림(T24)** 부분을 실제 재주문 리포트(Loyverse 경로)·CSV 저재고 알림(CSV 경로) 양쪽에 연결한다. 재고 정합성 검증(T23)은 실 Google Sheets 연동 전까지 의도적으로 미룬다(아래 "이번에 안 한 것").
- 완료 기준: [x] `agent/reorder.ts`의 `buildReorderReport()`가 packSize를 반영해 `reorder_suggestions` MCP 도구에도 코드 변경 없이 자동 반영(도구=에이전트 회귀 가드 유지) [x] `agent/folderScan.ts`의 CSV 채널 저재고 알림에 최종 발주량·발주 팩수 표시 [x] 새 `Warehouse.queryProducts()` 읽기 전용 조회 + 테스트 [x] 기존 `mcpTools.test.ts`/`e2e.test.ts`의 "도구=에이전트 완전 동일" 회귀 가드가 코드 변경 없이 그대로 통과 [x] check 통과
- **완료**: 착수 중 발견 — Loyverse 경로(`agent/reorder.ts`)는 판매·재고 조회에 `name`/`category`만 select해 products를 다시 읽어올 방법이 아예 없었다(CSV 경로는 파싱 결과에 products가 메모리로 남아 있어 문제 없었음). `core/types.ts`에 `Warehouse.queryProducts(variantIds?)`(읽기 전용, 가드레일 4 저촉 없음) 추가, `adapters/pgWarehouse.ts` 구현. `ReorderLineItem`에 `packSize`/`finalOrderQty`/`packCount` 필드 추가(항상 채워지므로 필수 필드 — optional 아님). `buildReorderReport()`가 `queryProducts`+`applyPackRounding`을 호출하고, `renderReportText`/`renderReportHtml`은 `formatOrderQty()` 헬퍼로 "42 → 최종 발주량 48(2팩, 팩당 24개)"를 표시한다. `reorder_suggestions` MCP 도구는 `buildReorderReport()`를 그대로 재사용하므로(T9 결정) 도구 쪽 코드는 한 줄도 안 건드렸는데 자동으로 배선됐다. `agent/folderScan.ts`의 `alertsFrom()`이 `products: ProductRow[]`를 추가로 받아 history 모드 행에만 `applyPackRounding`을 적용(no_history는 reorderQty 자체가 없다, T17), `FolderScanAlertItem`에 선택 필드로 `reorderQty`/`finalOrderQty`/`packCount` 추가. **이번에 안 한 것**: 재고 정합성 검증(T23 `computeStockReconciliation`)은 MCP·에이전트 어디에도 연결하지 않았다 — 실 Google Sheets 연동이 없는 지금은 `purchase_receipts`가 항상 비어 있어, 계산을 돌리면 "입고 0건"을 실제 이력으로 오인해 모든 품목에 거짓 `discrepancy`가 잡힌다(의미 없는 경고를 노출하는 게 되레 해로움) — 실 연동과 함께 노출하기로 명시적으로 미뤘다. 상세는 `docs/SPEC.md` §15. check 통과(325 테스트 = 기존 324 + 신규 8, 회귀 가드 재사용 테스트는 코드 변경 없이 자동 통과).

## v0.2 백로그 — CSV/Excel 채널 (SPEC §12, 2026-09-03 설계)

`docs/DESIGN.md`는 아직 v0.2 절이 없다 — v0.1 태스크와 달리 사전에 완성된 설계 문서가 없으므로, 아래 각 태스크는 `docs/SPEC.md` §12를 진실의 원천으로 삼아 구현하면서 필요한 인터페이스·스키마를 `docs/DESIGN.md`에 새 절로 추가한다(T15 스키마, T14 웨어하우스 팩토리, T13 락 순서로 먼저 문서화되는 게 자연스럽다).

의존 그래프: `T12 → {T13→T14, T15→{T16, T17, T19}} → T18(T14,T16,T17,T19,T6) → T20(T18,T16) → T21(T14,T20) → T22(T21)`

T12는 완료(DONE)됐다 — 착수 중 스코프가 "리네임"에서 "데이터소스 경계 정리 + `sales_period_agg` 스키마"로 재정의됐고, T16/T17이 그 신규 타입(`SalesPeriodAggRow`)에 의존하게 되면서 T12가 두 레인의 공통 전제가 됐다(원래는 T13이 T12와 무관한 독립 유틸리티였으나, T12의 산출물 자체가 달라져 계보상 앞에 둔다 — T13 자체 작업 내용은 T12와 여전히 무관).

병렬 레인: **B(T13→T14), C(T15→{T16,T17,T19})**는 서로 다른 worktree 에이전트로 동시 진행 가능. B·C 전부 완료(2026-09-03) — 다음은 T18부터 순차.

---

### T12 (레인 A) — 데이터소스 경계 정리 + 기간합계 판매 스키마 · 상태: DONE(2026-09-03)
- 목표(착수 중 재정의): 당초 "`LoyverseClient`를 소스 중립 이름으로 리네임"으로 적었으나, 착수해보니 이 인터페이스는 이름만이 아니라 **반환 타입 자체**가 Loyverse 고유 구조였다(`LvReceipt`의 `receipt_number`/`cancelled_at`/`receipt_type` 등) — CSV 파일에는 영수증이 없어 리네임만으로는 CSV가 이 인터페이스를 구현할 수 없다. `sales_lines`(영수증 라인 단위, `receipt_id`+`line_no` PK)도 CSV의 "기간 합계 판매수량" 하나뿐인 데이터를 담기에 맞지 않았다. 그래서 리네임 대신: (1) `LoyverseClient`/`etl/sync.ts`는 **Loyverse 전용 경로로 문서화만 하고 리네임하지 않는다**(정직한 이름이 오히려 명확함), (2) CSV의 기간합계 판매를 위한 **신규 테이블 `sales_period_agg`**(마이그레이션 002) + 신규 행 타입 `SalesPeriodAggRow` + `Warehouse.upsertSalesPeriodAgg`/`querySalesPeriodAgg` 추가. `querySalesPeriodAgg`는 `querySalesAgg`와 동일한 `SalesAgg[]` 형태를 반환하므로 `core/metrics.ts`의 `computeSellThrough`/`computeReorderMetrics`는 **변경 없이** 그대로 소비한다.
- 완료 기준: [x] `sales_period_agg` 마이그레이션(002) + upsert 멱등·query 필터(매장/기간 겹침) 테스트, 기존 182개 회귀 없이 총 186개 통과 [x] `LoyverseClient`/`etl/sync.ts`에 "Loyverse 전용 경로, CSV는 구현하지 않음"을 명시하는 문서 주석 [x] check 통과
- **후속 영향(T15~T18 완료 기준에 반영)**: T16(파서)은 "T12에서 리네임한 인터페이스 구현" 대신 도메인 행 타입(`StoreRow`/`ProductRow`/`InventoryRow`/`SalesPeriodAggRow`)으로 직접 변환하는 함수를 만든다. T17(셀스루/임계치 분기)은 `querySalesPeriodAgg` 각 행의 실제 기간 길이(`period_start`~`period_end`)를 `computeReorderMetrics`의 `windowDays`에 반영해야 한다 — CSV 기간 길이가 v0.1 기본값(28일)과 다를 수 있다는 걸 T12에서 발견했다.

### T13 (레인 B) — 파일 락 유틸리티 · 상태: DONE(2026-09-03)
- 목표: `src/adapters/fileLock.ts` — PID+타임스탬프 락 파일로 디렉터리 단위 배타 접근을 보장하는 acquire/release. 살아있는 프로세스 감지(예: signal 0 kill 시도)로 죽은 프로세스가 남긴 stale lock을 자동 회수. 실패 시 원인+조치 포함 에러(CLAUDE.md 컨벤션).
- 완료 기준: [x] 같은 경로에 대한 동시 acquire 시도 중 하나만 성공하는 테스트(SPEC §12 스파이크 재현) [x] 존재하지 않는 PID가 남긴 stale lock 자동 회수 테스트 [x] 락 보유 중 재시도 시 에러 메시지에 보유 PID·조치 포함 [x] check 통과
- **완료**: 락 파일은 보호 대상 경로 밖(`{targetPath}.lock`)에 두어 PGlite 데이터 디렉터리를 오염시키지 않는다. 배타 생성은 `fs.writeFile(path, ..., {flag:"wx"})`(단일 syscall, TOCTOU 경합 없음)로 하고, 두 프로세스가 동시에 시도해도 하나만 성공한다. `isAlive`/`pid`/`nowFn`을 주입 가능하게 해(rateLimiter.ts와 같은 테스트 가능성 패턴) 실제 프로세스를 죽이지 않고도 stale lock 시나리오를 결정론적으로 테스트한다. `FileLockBusyError`(advisoryLock.ts의 `AdvisoryLockBusyError`와 같은 패턴)와 `withFileLock(path, fn)` 편의 함수(`withAdvisoryLock`과 같은 acquire→fn→release 패턴)도 함께 제공. `release()`는 락 파일의 현재 pid가 자신과 다르면(다른 프로세스가 stale로 회수해 새로 잡은 경우) 삭제하지 않는다.

### T14 (레인 B) — 임베디드 PGlite 웨어하우스 기본값 · 상태: DONE(2026-09-03) · 의존: T13
- 목표: `pgWarehouse.ts`에 파일 영속 PGlite용 `DbConnectionProvider` 구현 추가(T13 락으로 디렉터리 열기를 감싸고, 최초 실행 시 `scripts/migrate.ts` 러너로 자동 마이그레이션). `server.ts`/`agent/reorder.ts`가 각자 하드코딩한 "`DATABASE_URL` 없으면 에러" 로직을 공용 팩토리로 추출 — `DATABASE_URL` 있으면 기존 pg.Pool 경로 그대로, 없으면 임베디드 PGlite(기본 경로 `.retail-mcp/data/`)로 대체. 이 로컬 자동 마이그레이션은 CLAUDE.md 가드레일 5("프로덕션 `DATABASE_URL` 마이그레이션은 사람만")의 대상이 아니다 — 원격 프로덕션 DB가 아니라 로컬 임베디드 DB 초기화다.
- 완료 기준: [x] `DATABASE_URL` 미설정 시 임베디드 PGlite로 기동 + 첫 실행 자동 마이그레이션 [x] `DATABASE_URL` 설정 시 기존 pg.Pool 경로 회귀 없음 [x] 임베디드 경로가 이미 열려 있으면(T13 락 보유 중) 명확한 에러로 거부 [x] server.ts/agent/reorder.ts 중복 로직 제거 [x] check 통과
- **완료**: 신설 `src/adapters/warehouseFactory.ts`의 `createWarehouseFromEnv()`가 공용 팩토리다. 곁들여 `scripts/migrate.ts`의 러너 핵심 로직(`loadMigrations`/`runMigrations`/executor)을 `src/adapters/migrationRunner.ts`로 옮겼다 — advisoryLock.ts와 같은 이유(src가 scripts에 의존하는 잘못된 방향 회피)로, `src/mocks/pglite.ts`도 이제 여기서 가져온다(`scripts/migrate.ts`는 CLI 껍데기로 재export). `ServerConfig`에서 쓰이지 않던 `databaseUrl` 필드는 제거— 실제로 쓰는 곳이 pg.Pool 생성 한 줄뿐이었고 그 로직이 팩토리로 옮겨가며 무의미해졌다. `SYNC_TOOL_ENABLED=true`인데 `DATABASE_URL`이 없으면 `resolveServerConfig`가 명확한 에러로 시작을 거부한다(`sync_now`의 advisory lock은 pg 전용, DESIGN §11.4) — 임베디드 PGlite 경로에서는 `sync_now`를 못 쓴다. `.env.example`에 `RETAIL_MCP_DATA_DIR`, `.gitignore`에 `.retail-mcp/` 추가.

### T15 (레인 C) — CSV/Excel 컬럼 스키마 · 상태: DONE(2026-09-03)
- 목표: SPEC §12 "컬럼 구성" 고정 템플릿을 `core/`에 zod 스키마로 정의(필수: 매장명/상품명/SKU/재고수량, 선택: 판매수량+기간/단가+통화/저재고임계치). 판매이력 있음/없음 모드를 판정하는 순수 함수 포함.
- 완료 기준: [x] 필수 컬럼 누락 시 zod 파싱 실패 + 원인 명시 [x] 판매수량은 있는데 기간이 없는 등 불일치 케이스 거부 [x] 판매이력 모드 판정 골든 케이스 테스트 [x] check 통과
- **완료**: `src/core/csvSchema.ts` — `csvRowSchema`(zod), `parseCsvRow()`(실패 시 원인을 모두 모은 에러), `salesHistoryModeOf()`. 컬럼명은 SPEC §12 표의 한글 그대로 키로 써서 어댑터(T16) 매핑 실수를 줄인다. 빈 셀("")을 `blankToUndefined`로 먼저 걸러내는 게 핵심 — 이게 없으면 `z.coerce.number()`가 빈 재고수량/판매수량 칸을 조용히 0으로 바꿔버려 "칸을 비웠다"와 "0을 채웠다"를 구분 못 하고, 판매이력 모드 판정(T17이 쓸 예정)이 깨진다. 판매수량↔기간 상호 필수, 단가↔통화 상호 필수(SPEC §9)도 `superRefine`으로 검증. (매장명, SKU) 유일성처럼 행 하나로 판단 못 하는 검증은 T16(여러 행 순회) 몫으로 남겨뒀다.

### T16 (레인 C) — CSV/Excel 파서 어댑터 · 상태: DONE(2026-09-03) · 의존: T12, T15
- 목표: `src/adapters/csvExcelParser.ts` — CSV/XLSX 파일을 읽어 인코딩 자동감지(UTF-8/CP949/EUC-KR 등, 신뢰도 낮으면 무음 처리 대신 명시적 에러/경고 반환), T15 스키마로 검증, 도메인 행 타입(`StoreRow`/`ProductRow`/`InventoryRow`/`SalesPeriodAggRow`, T12)으로 변환하는 함수 생성. `LoyverseClient`는 구현하지 않는다(T12 결정 — CSV에는 영수증 단위 데이터가 없다). 네트워크 호출 없음.
- 완료 기준: [x] UTF-8/CP949/EUC-KR 픽스처 파일 각각 정상 파싱 [x] 신뢰도 낮은 인코딩은 명시적 에러/경고로 표시(무음 mojibake 금지) [x] CSV·XLSX 양쪽 픽스처 테스트 [x] 변환 결과가 `Warehouse.upsertStores`/`upsertProducts`/`upsertInventory`/`upsertSalesPeriodAgg`에 바로 넘길 수 있는 타입과 일치 [x] check 통과
- **완료**: 인코딩 자동감지는 별도 라이브러리 없이 Node 내장 `TextDecoder`로 처리한다 — WHATWG "euc-kr" 라벨이 Node에서 CP949(EUC-KR 상위호환) 코드페이지로 구현돼 있어 하나로 다룰 수 있고, `fatal: true`(엄격 모드)로 UTF-8→EUC-KR 순서로 시도하면 서로 다른 인코딩의 바이트가 섞여도 대부분 디코딩 자체가 실패해 안전하다(실제 바이트로 양방향 검증함). CSV는 `csv-parse`, XLSX는 `exceljs`를 새 의존성으로 추가했다 — SheetJS `xlsx`도 검토했으나 공개 npm에 배포된 최신 버전(0.18.5)에 패치 안 된 HIGH 심각도 취약점(프로토타입 오염, ReDoS)이 있어 제외, `exceljs`는 쓰기 경로에서만 쓰이는 uuid 관련 MODERATE 취약점(우리는 읽기만 함)만 있어 채택.
  - **착수 중 발견한 스키마 공백**: `저재고임계치`(T15가 이미 파싱)를 담을 웨어하우스 컬럼이 없었다 — `migrations/003_product_low_stock_threshold.sql`로 `products.low_stock_threshold`(nullable numeric) 추가, `ProductRow.lowStockThreshold`(optional)·`upsertProductsOn`도 함께 갱신(T12와 같은 패턴: 발견 즉시 스키마를 고치고 문서화). Loyverse 동기화가 이 값을 조용히 null로 덮어쓰지 않도록 `coalesce(excluded.low_stock_threshold, products.low_stock_threshold)`로 upsert.
  - **의도적으로 미룬 것**: 단가/통화(SPEC §12 "매출액 표시용")는 T15가 검증만 하고 여기서는 저장하지 않는다 — 어떤 v0.1/v0.2 핵심 지표도 단가를 입력으로 쓰지 않고, 저장할 컬럼도 없다. 실제로 필요해지면 별도 태스크.
  - (매장명, SKU) 유일성, SKU별 상품명·임계치 일관성처럼 파일 전체를 훑어야 아는 검증(T15가 명시적으로 넘긴 것)을 `mapRowsToDomain`이 수행 — 위반 시 부분 처리 없이 명확한 에러.
  - 픽스처는 `tests/fixtures/csvExcel/`(UTF-8·EUC-KR CSV는 `iconv`로 실제 바이트 생성해 상호 검증, XLSX는 `exceljs`로 생성해 네이티브 숫자/날짜 셀 타입까지 검증).

### T17 (레인 C) — 셀스루/임계치 분기 로직 · 상태: DONE(2026-09-03) · 의존: T15, T12
- 목표: 판매이력 없는 품목(해당 store/variant의 `querySalesPeriodAgg` 결과 없음)은 셀스루 계산을 건너뛰고 "판매 이력 없음"으로 표시 + `재고수량 < 임계치`(품목별 override 우선, 없으면 전역 기본값) 단순 판정으로 대체(SPEC §12). 판매이력 있는 품목은 `querySalesPeriodAgg` 결과를 `computeReorderMetrics`에 넘기되, **`windowDays`를 CSV가 보고한 실제 기간 길이(`period_end`-`period_start`)로 계산**한다 — v0.1 기본값 28일을 그대로 쓰면 CSV 기간 길이가 다를 때 `avgDailySales`가 왜곡된다(T12에서 발견). 한 결과 집합 안에 두 모드가 섞일 수 있음을 반영. `core/metrics.ts`의 `computeSellThrough`/`computeReorderMetrics` 자체는 이미 소스 중립적(`SalesAgg[]` 입력)이라 변경하지 않는다.
- 완료 기준: [x] 판매이력 있는 품목은 기존 §2 근사식 그대로(기존 골든 케이스 회귀 없음) [x] 판매이력 없는 품목은 셀스루가 null/모드 플래그로 표시되고 조용히 0 처리되지 않음 [x] 임계치 판정 골든 케이스(품목별 override·전역 기본값 각각) [x] CSV 기간 길이가 28일이 아닌 골든 케이스(예: 35일)에서 avgDailySales가 실제 기간으로 정확히 나뉘는지 테스트 [x] check 통과
- **착수 중 발견한 설계 정정**: 목표에 적힌 "`querySalesPeriodAgg` 결과를 넘긴다"는 실제로는 불가능했다 — `querySalesPeriodAgg`는 T12에서 의도적으로 `querySalesAgg`와 같은 `SalesAgg[]` 형태로 설계했는데, 그 타입엔 애초에 `periodStart`/`periodEnd`가 없다(그래서 `computeReorderMetrics`가 변경 없이 재사용 가능했던 것). 기간 길이가 꼭 필요한 이 태스크는 그 대신 T16이 막 파싱한 원본 행(`SalesPeriodAggRow`, 기간 보존)을 **DB 재조회 없이 직접** 받는다 — T18(폴더 스캔)이 파싱 직후·적재 전에 호출하는 걸 전제한다. `Warehouse.querySalesPeriodAgg`는 그대로 유지(다른 용도로는 여전히 유효), 이 함수는 그걸 쓰지 않는다는 차이만 문서화.
- **완료**: `core/metrics.ts`에 `computeCsvReorderMetrics(inventory, salesPeriodAgg, products, opts)` 추가 — `computeReorderMetrics`는 손대지 않고, 판매이력 있는 (매장,SKU)를 실제 기간 길이(일)별로 묶어 그룹마다 맞는 `windowDays`로 그 함수를 재사용한다(한 파일에 기간 길이가 다른 품목이 섞여 있어도 안전). 결과는 판별 유니온(`CsvHistoryMetricRow | CsvThresholdMetricRow`, `mode` 필드로 구분) — history 쪽은 §2 5개 수식 전부(셀스루 포함) 그대로, no_history 쪽은 `avgDailySales` 등 관련 없는 필드 자체가 타입에 없어 "조용한 0 처리"가 구조적으로 불가능하다. 임계치는 `ProductRow.lowStockThreshold`(T16이 저장) 우선, 없으면 `opts.defaultLowStockThreshold`.

### T18 — 폴더 스캔 스크립트 (지점 모드) · 상태: DONE(2026-09-03) · 의존: T14, T16, T17, T19, T6
- 목표: `src/agent/folderScan.ts` — cron 1회 실행 진입점. 감시 폴더의 최신 파일을 T16으로 파싱 → T16이 변환한 행을 `Warehouse.upsertStores`/`upsertProducts`/`upsertInventory`/`upsertSalesPeriodAgg`(T12)로 직접 upsert(`LoyverseClient`/`syncAll()`을 거치지 않는다, T12 결정) → T17 판정 결과로 저재고 알림(기존 `NotificationProvider` 재사용) → T19로 스냅샷 파일 갱신까지 한 스크립트가 순서대로 수행. `agent/reorder.ts`와 같은 "얇은 오케스트레이션만" 원칙.
- 완료 기준: [x] 픽스처 CSV/XLSX 1회 스캔 → 적재 → 저재고 알림 발송 여부까지 e2e(발송은 Mock) [x] 파싱 실패 시 부분 적재 없이 명확한 에러로 중단 [x] 두 번 연속 실행해도 upsert 멱등 [x] check 통과
- **완료**: `runFolderScan(deps, opts)`가 파싱→적재(트랜잭션)→T17 알림 판정→(필요시)발송→T19 스냅샷 갱신→`agent_send_log` 기록까지 전부 수행. `agent/reorder.ts`와 동일하게 LLM 요약 없음(저재고 알림은 결정론 목록으로 충분, DESIGN §7의 재주문 리포트와 달리 LLM 경계가 필요 없다고 판단), 발송은 `SEND_MODE=live && --confirm` 이중 게이트(가드레일 1) 그대로 재사용. 감시 폴더에 파일이 여러 개면 최근 수정 파일만 쓰고 나머지는 경고 로그만 남기고 건너뜀. `watchDir`과 `snapshotDir`이 같으면 시작을 거부한다(스냅샷을 원본으로 오인해 다음 스캔이 자기 자신을 재입력하는 사고 방지). 새 env: `CSV_WATCH_DIR`(필수)·`CSV_SNAPSHOT_DIR`(필수, watchDir과 달라야 함)·`CSV_DEFAULT_LOW_STOCK_THRESHOLD`(기본 5). `npm run agent:folder-scan` 스크립트 추가. T13 파일 락은 별도로 안 건드림 — T14의 `createWarehouseFromEnv()`가 임베디드 경로에서 이미 내부적으로 처리한다.

### T19 (레인 C) — 스냅샷 export · 상태: DONE(2026-09-03) · 의존: T15
- 목표: `core/snapshotExport.ts` — 처리된 재고 데이터를 T15와 동일한 고정 템플릿 CSV로 직렬화하는 순수 함수. 지점 인스턴스의 산출물이자 본사 인스턴스의 입력이 되는 왕복 가능한 포맷(SPEC §12 "다지점 헤드오피스 통합 조회").
- 완료 기준: [x] export한 파일을 T15 스키마로 다시 파싱하면 원 데이터와 일치(왕복 테스트) [x] 매장명 포함 확인 [x] check 통과
- **완료**: `exportSnapshotCsv(source)` — `csv-stringify`(T16의 `csv-parse`와 같은 라이브러리군) 사용, T15 `csvRowSchema`가 기대하는 헤더·열 순서 그대로(매장명,상품명,SKU,재고수량,판매수량,판매기간시작일,판매기간종료일,저재고임계치) 직렬화. 단가/통화는 T16이 애초에 저장하지 않는 필드라 내보내지 않는다(이미 문서화된 스코프 경계, 왕복 대상 아님). 판매이력 없는 품목은 판매 관련 컬럼을 빈칸으로 두어(조용히 0을 쓰지 않음) T15가 "판매이력 없음"으로 다시 판정하게 한다. 왕복 테스트는 raw rows → T15 파싱 → T16 도메인 변환 → T19 export → csv-parse 재파싱 → T16 재변환 전 과정을 거쳐 원본과 완전히 동일한 결과가 나오는지 확인(`toEqual`).

### T20 — 본사 통합 모드 · 상태: DONE(2026-09-03) · 의존: T18, T16
- 목표: `folderScan.ts`에 "통합 조회" 모드 추가 — 여러 지점 스냅샷이 모이는 수집 폴더를 스캔하고, 지점별로 그 지점 파일이 끝까지 성공 파싱된 뒤에만 해당 지점의 watermark를 커밋(부분 실패 시 그 지점만 재시도 대상, 다른 지점 영향 없음).
- 완료 기준: [x] 지점 2개 스냅샷을 한 수집 폴더에 넣고 매장명으로 필터링해 통합 조회하는 테스트(§5 "본점만" 예시와 동일 동작) [x] 한 지점 스냅샷이 파싱 중간에 실패해도 다른 지점 데이터·watermark에 영향 없음 [x] check 통과
- **완료**: `runConsolidatedScan(deps, {collectDir})` — 지점 모드의 "최신 파일 1개"와 달리 수집 폴더의 파일 전부를 각자 독립 시도한다. 파일별로 upsert 4종 + `setCursor("csv_branch:<파일명>", ...)`를 **같은 트랜잭션**으로 묶어, 그 파일이 끝까지 성공했을 때만 적재·watermark가 함께 커밋되고 실패하면 둘 다 롤백된다 — 다른 파일의 처리는 try/catch로 격리해 계속 진행. `sync_state.resource`가 자유 문자열이라(스키마 변경 없음) 새 키(`csv_branch:*`)를 그냥 씀. 매장 필터링은 새로 만들 것 없이 기존 `queryStock({storeId})`가 스키마 변경 없이 그대로 동작함을 테스트로 확인(SPEC §12가 예견한 그대로). `CSV_MODE=branch|consolidated`(기본 branch)로 지점/본사 모드를 선택, 본사 모드는 `CSV_COLLECT_DIR` 사용. 본사 모드는 알림 발송을 하지 않는다 — 이미 지점 단계에서 알림이 나갔고, 본사 인스턴스의 역할은 기존 MCP 도구가 다지점 조회할 수 있게 적재하는 것뿐(SPEC §12), 재알림은 스코프 밖.

### T21 — 온보딩 CLI · 상태: DONE(2026-09-03) · 의존: T14, T20
- 목표: 대화형 CLI(`npm run onboard`) — 모드 선택(지점/본사), 감시 폴더 경로, 템플릿 파일 생성 안내, 저재고 임계치·수신자 이메일, 웨어하우스 선택(임베디드 기본/`DATABASE_URL` 옵션) 입력받아 설정 파일(`retail-mcp.config.json` 또는 `.env`) 저장. npm 패키지 `bin` 등록·게시 자체는 범위 밖(후속 태스크).
- 완료 기준: [x] 비대화식(플래그 또는 스크립트 입력) 실행으로 설정 파일 생성 테스트 [x] 필수 값 누락 시 재질문/명확한 에러 [x] 생성된 설정으로 T18 스크립트가 그대로 기동 [x] check 통과
- **완료**: `src/cli/onboard.ts` — 설정 파일은 `.env`로 정했다(JSON이 아님) — 나머지 전체(T14/T18/T20)가 이미 `process.env`만 읽으므로, 새 파일 형식·파서를 추가로 만들지 않고 기존 config 경로에 바로 얹을 수 있어서다. `collectOnboardAnswers(ask)`(질문·검증 로직)와 `mergeEnvFile(existing, updates)`(기존 `.env`의 다른 줄은 보존하고 관리하는 키만 갱신/추가)를 `ask()`만 주입받는 순수 함수로 분리해, 실제 터미널 없이 스크립트 입력으로 완전 비대화식 테스트가 가능하다(`node:readline/promises`는 `main()`에만 있음). 필수 값은 최대 3회까지 재질문 후 명확한 에러, watchDir=snapshotDir 같은 잘못된 조합·이메일 형식 오류도 재질문 루프. 템플릿 예시 파일은 새로 만들지 않고 T19 `exportSnapshotCsv`를 예시 1행으로 호출해 재사용(SPEC §12 헤더와 항상 일치 보장). "생성된 설정으로 T18이 그대로 기동" 검증은 실제 `process.env`를 건드리지 않고, `.env`로 왕복 파싱한 값을 `runFolderScan()`에 직접 넘겨 확인.

### T22 — e2e + 문서 갱신 · 상태: DONE(2026-09-03) · 의존: T21
- 목표: 지점 단독 시나리오(파일→파싱→적재→알림)와 본사 통합 시나리오(지점 2곳 스냅샷→통합 조회) e2e, README/SPEC §12에 실제 사용 절차 반영.
- 완료 기준: [x] 두 e2e 시나리오 통과 [x] README에 CSV/Excel 채널 퀵스타트 추가 [x] check 통과
- **완료**: `tests/e2eCsvChannel.test.ts`(신규) — 기존 `tests/folderScan.test.ts`(T18/T20)가 이미 유닛 수준 동작을 촘촘히 덮고 있어, 여기서는 두 시나리오를 실제 운영 절차 그대로 이어 붙이는 데 집중했다. (1) 지점 단독: `SEND_MODE=live && confirm`을 실제로 통과시켜(더미 dry_run이 아님) Mock provider가 진짜 수신한 이메일 본문까지 확인하고, 파싱 실패 시 알림·스냅샷 둘 다 없는 것도 재확인. (2) 본사 통합: 기존 테스트는 손으로 쓴 스냅샷 픽스처를 수집 폴더에 바로 넣었지만, 여기서는 **서로 독립된 PGlite 웨어하우스 두 개**(지점 A/B)가 `runFolderScan`으로 실제로 만들어낸 스냅샷 파일을 파일 복사(SPEC §12가 규정하지 않는 "이미 쓰는 전송 수단"의 대역)로 **세 번째 독립 웨어하우스**(본사)의 수집 폴더에 옮기고 `runConsolidatedScan`으로 취합 — T19 export 산출물이 T20 import를 실제로 그대로 통과하는지까지 검증한다(단위 테스트로는 안 잡히는 "두 조각이 실제로 맞물리는가" 질문). README에 "CSV/Excel 채널 퀵스타트" 절 신설(지점/본사 모드별 실제 명령 시퀀스 + cron 등록 예시) + 상단 v0.1/v0.2 배너 정정. `docs/SPEC.md` §12에 "실제 사용 절차" 절 추가 — 새 결정이 아니라 각 설계 절이 어떤 파일/명령으로 구현됐는지 연결하는 참조. check 통과(278 테스트 = 기존 275 + 신규 3).

## 문서 점검 후 태스크 반영사항 (2026-09-02)

아래 항목은 별도 범위 확장이 아니라 위 태스크의 완료 기준에 포함한다.

| 태스크 | 추가 필수 항목 |
|---|---|
| T0 | `BUSINESS_TIMEZONE=Asia/Manila`, `SYNC_TOOL_ENABLED=false`, 외부 요청 timeout/retry 환경값을 `.env.example`에 문서화 |
| T1 | `sync_state`의 watermark 의미 명시, 스냅샷 `run_id` 충돌 방지 + FK, 실행 상태(`no_suggestions/dry_run/sending/sent/failed`)와 멱등 `run_id`를 표현하는 마이그레이션 반영, migration checksum, advisory lock 기반 동시 실행 직렬화 (docs/002 적대적 검수로 확정) |
| T3 | 429 `Retry-After`, 요청 타임아웃, 재시도 상한 및 민감정보 없는 오류 테스트. Loyverse 공식 필드(`updated_at`/`created_at`/`cancelled_at`/`receipt_type`/`refund_for`) 보존 (docs/003 적대적 검수) |
| T4 | `Warehouse.transaction(fn)`을 실제 BEGIN/COMMIT/ROLLBACK으로 구현 — 리소스 단위 트랜잭션, watermark 원자 커밋, decimal 처리 및 읽기/쓰기 역할 분리 테스트 |
| T5 | 음수 순판매·음수 재고 정규화와 경고, 사업장 타임존의 반개방 기간 경계 테스트 |
| T7 | 페이지 토큰과 watermark 분리, 동률 경계 재조회, 빈 inventory 응답 거부, 리소스별 결과 반환. `updated_at_min` 기준 watermark 사용, `cancelled_at` 있는 영수증 제외, REFUND 라인의 부호 반전을 ETL에서 명시적으로 수행 (docs/003 적대적 검수) |
| T8 | `provider.send()` 호출 **전에** `status='sending'` 행을 먼저 커밋하는 예약 패턴으로 중복 발송 방지(스키마는 T1에서 확정), 실행 상태별 로그 테스트, `sending`에 멈춘 오래된 행의 회수 정책 — **완료**: `pgWarehouse.logAgentSend`가 `sending`은 항상 새 INSERT(유니크 위반 시 재발송 거부 에러)로, `sent`/`failed`는 그 `sending` 행만 UPDATE하도록 정정(DESIGN §11.5 구현 정정 참조 — 기존 select-then-upsert는 이미 `sent`인 run_id도 재발송을 허용하는 결함이 있었음). 오래된 `sending` 회수는 자동화하지 않고 운영자 수동 확인으로 정책 확정(Warehouse에 조회 메서드가 없어 에이전트가 스스로 판단 불가). `Warehouse.queryStores(storeId?)` 추가(매장명 조회, `reorder_suggestions`/MCP 필터 검증과 공용) — `buildReorderReport()`를 `src/agent/reorder.ts`에 T9 재사용용으로 분리 export |
| T9 | 운영 기본값에서 `sync_now` 비활성, 공통 응답 메타데이터와 stale 경고, 조회 전용 역할 테스트. `sync_now`는 `etl/sync.ts`의 `syncAll()`을 advisory lock으로 감싸 동시 호출 시 하나만 실행되게 한다(DESIGN §11.4) — T7의 `syncAll()` 자체는 동시 호출 가드가 없다(단일 호출의 리소스별 원자성·재개만 보장) — **완료**: 논블로킹 `pg_try_advisory_lock`(`withTryAdvisoryLock`)으로 구현, 실행 중이면 즉시 `AdvisoryLockBusyError`. stale 판정은 `core/freshness.ts`(공유, 기본 24시간·`STALE_THRESHOLD_HOURS`)로 리포트·조회 도구가 공용. `Warehouse.getSyncState()`/`StockQuery.category` 추가(각각 `sync_status`, `sell_through`의 카테고리 필터 새는 결함 수정). `reorder_suggestions`는 `agent/reorder.ts`의 `buildReorderReport()`를 그대로 호출해 도구=에이전트 값 일치를 구조적으로 보장. 로직은 `src/mcp/tools.ts`에 두고 `server.ts`는 `McpServer.registerTool()` 조립만. `sell_through`의 `order` 기본값은 문서에 명시가 없어 desc(높은 순)로 확정 |
| T10 | `TESTING.md` §7 전체 회귀 가드와 core 커버리지 90% 리포트 — **완료**: e2e는 실제 프로세스를 띄우지 않고 `InMemoryTransport.createLinkedPair()`로 같은 프로세스 안에서 실제 MCP `Client`↔`registerTools()` 서버를 연결해 프로토콜 계층(zod 입력 검증·`CallToolResult` 포장)까지 통과시킨다(`tests/e2e.test.ts`). 50k행 성능 가드는 합성 `LoyverseClient`로 생성(`tests/performance.test.ts`, fixtures/loyverse는 규모가 작아 부적합). 커버리지는 `vitest.config.ts`에 `thresholds`(lines/statements/functions 90, branches 85)로 강제하고 `npm run coverage`로 리포트(`text`+`html`+`json-summary`) 생성 — 현재 core 100/97/100/100. `vitest.config.ts`의 `testTimeout`을 5000→20000ms로 늘려 PGlite 기반 테스트의 환경별 플레이키(coverage 계측 오버헤드 등)를 해소. TESTING §7 나머지 항목(음수 정규화·DST/월말 경계·Retry-After/재시도상한·시크릿 미노출·이중발송 0건)은 T3/T5/T8에서 이미 커버돼 있어 T10에서는 남은 항목만 보강: 소수·큰 numeric ceil 정밀도(`tests/metrics.test.ts`), Summarizer 요청 본문에 시크릿·이메일·원시 영수증 필드 없음(`tests/claudeSummarizer.test.ts`), stale 경고가 도구·에이전트 리포트 양쪽에 실제로 붙는지(`tests/mcpTools.test.ts`) |
| T11 | README에 타임존·권한 분리·stale 확인 및 최초 live 발송 전 체크 절차 반영 — **완료**: `scripts/smoke.ts`는 ①`syncAll()` ②조회 도구 3종(sell_through/inventory_status/stockout_risk — reorder_suggestions는 ③단계 에이전트 dry-run과 같은 `buildReorderReport()`를 쓰므로 중복 호출하지 않음) ③에이전트 dry-run 순서로 실행하고, `.env`의 `SEND_MODE`와 무관하게 `sendMode:"dry_run", confirm:false`를 코드로 강제해 실수로 실발송되지 않게 한다(사람 전용, 실 Loyverse+DB 대상이라 자동 테스트 대상 아님 — TESTING §5). README에 "운영 배포 절차"(5단계) + "최초 live 발송 전 사람 체크리스트" + cron/launchd 한 줄 등록 예시 추가 |

T1 구현 시 DESIGN §2의 초기 DDL을 그대로 복사하지 말고 DESIGN §11의 스키마 명확화까지 같은 `001_init.sql`에 반영한다(아직 배포 전이므로 후속 보정 마이그레이션을 만들 필요 없음).

## v0.1 완료 후 보강 로그

T0~T11 전부 완료된 뒤, 새 태스크 번호 없이 진행한 보강.

- 2026-09-03: **Loyverse 클라이언트 속도 제한 추가**. Loyverse 공식 문서(developer.loyverse.com/docs "API rate limits") 확인 결과 계정당 한도가 "300 requests per 300 sec"로 명시돼 있어(무료/유료 플랜 공통, 브라우저로 실제 렌더링된 문서를 확인함), `src/adapters/rateLimiter.ts`(슬라이딩 윈도우, 순수 로직)를 신설해 `loyverseClient.ts`의 매 fetch 시도 직전에 자기 자신을 능동적으로 늦추도록 했다(기존 429/Retry-After 반응적 백오프는 그대로 유지). 기본값은 여유를 두어 250요청/300초(env `LOYVERSE_RATE_LIMIT_MAX_REQUESTS`/`LOYVERSE_RATE_LIMIT_WINDOW_MS`로 조정). SPEC §10에 근거 반영.
- 2026-09-03: **사용처·데이터소스 재검토** (코드 변경 없음, 문서만). "MCP+에이전트를 실제로 어디에 연결해 쓰는가"를 점검한 결과, 확정된 파일럿 후보가 없고 실제 타겟은 Loyverse류 API형 POS보다 Excel/자체 ERP/수기 재고 관리를 쓸 가능성이 더 높다는 신호가 있어, 데이터소스(Loyverse 유지 vs CSV/Excel 어댑터 우선 개발) 결정을 고객 확인 이후로 보류하기로 했다. `LoyverseClient` 인터페이스가 POS 종속 로직을 어댑터 뒤에 격리하고 있어 T0~T11 구현(core/ETL/MCP/에이전트)은 데이터소스와 무관하게 재사용 가능 — 이번 재검토로 기존 구현이 무효화되지는 않는다. 상세는 `docs/SPEC.md` §8(미결 사항 최우선 항목)·§11 참고.
- 2026-09-03: **데이터소스 우선순위 결정** (코드 변경 없음, 문서만). 위 재검토를 이어, 파일럿 확인을 기다리지 않고 **CSV/Excel 업로드 데이터소스를 먼저 개발하고 Loyverse는 버전업 때 추가**하기로 정했다(SPEC §7 로드맵을 v0.2=CSV/Excel, v0.3=Loyverse 재활성화로 재정렬, §8·§11 갱신). 다음 실제 태스크는 CSV/Excel 데이터소스용 새 백로그(레이아웃 확정 → 파서/업로드 어댑터 → ETL 연결)이며, 아직 설계되지 않았다 — SPEC §8의 "지원할 CSV/Excel 레이아웃 확정" 항목이 그 착수 전제.
- 2026-09-03: **v0.2 CSV/Excel 채널 설계** (코드 변경 없음, 문서만). 온보딩 구상을 구체화하며 네 가지를 정했다: (1) 채널은 **폴더 감시만**(ERP는 폴더 채널로 흡수, 로컬 엑셀 원본 수정·구글드라이브 연동은 미룸), (2) 컬럼 구성은 **고정 템플릿**(자유 매핑 아님), (3) 판매 이력이 없는 파일은 셀스루 대신 **재고 임계치 알림으로 폴백**, (4) 웨어하우스는 **임베디드 PGlite를 기본값**으로 하고 Neon은 옵션(비개발자 사용자에게 Neon 계정·연결 문자열 설정은 진입장벽이 크다는 이유 — 기존 "DB는 Neon" 결정은 Loyverse 채택을 전제로 한 것이었음을 재확인). 실행 모델(cron 주기 스캔 vs 상시 워처), 다지점 헤드오피스 통합 조회 방법, PGlite 다중 프로세스 동시 접근 검증은 아직 미정 — SPEC §8·§12 참고. 다음 실제 태스크(새 백로그 설계)는 이 세 가지가 정리된 뒤 시작한다.
- 2026-09-03: **다지점 헤드오피스 통합 조회 설계 추가** (코드 변경 없음, 문서만). 위에서 미정으로 남겼던 항목 중 하나를 정했다 — 지점에 공용 Neon 업로드를 요구하지 않고, **지점별 산출물을 §12 컬럼 구성과 동일한 고정 템플릿 스냅샷 파일로 내보내 본사 인스턴스가 취합**하는 방식. 본사는 같은 retail-mcp를 "통합 조회" 모드로 별도 설치해 지점 스냅샷이 모이는 폴더를 동일한 폴더 감시 채널로 관찰하고, 매장명이 이미 구분자라 기존 MCP 도구·에이전트의 지점 필터링이 스키마 변경 없이 그대로 다지점 조회에 쓰인다. 상세는 SPEC §12 "다지점 헤드오피스 통합 조회". 실행 모델·PGlite 동시 접근 검증(§8)은 여전히 미정.
- 2026-09-03: **실행 모델 결정** (코드 변경 없음, 문서만). §8에 남은 두 미결 항목 중 하나를 정리했다 — 폴더 감시는 **`agent:reorder`와 같은 주기 스캔(cron)**으로 하고, 상시 워처(데몬)는 채택하지 않는다. 비개발자 운영자에게 크래시 복구·재시작 등록 같은 새 운영 부담을 지우는 데 비해 재고 변동을 실시간 반영해야 할 이유가 없다는 판단(재주문 의사결정은 이미 §5에서 주간 주기로 설계돼 있음). 스캔 1회가 파싱→적재→알림→(지점이면) 스냅샷 갱신까지 전부 수행하므로, 다지점 절에서 미해결로 남겼던 "지점 스냅샷 전송 주기"도 이 결정으로 자동 해소됨(스캔 주기와 동일). 상세는 SPEC §12 "실행 모델". §8에는 이제 PGlite 다중 프로세스 동시 접근 검증 하나만 남았고, 이는 문서로 정할 사안이 아니라 구현 착수 시 스파이크로 확인해야 하는 기술 검증 항목이다.
- 2026-09-03: **PGlite 다중 프로세스 동시 접근 스파이크** (코드 변경 없음, 검증 스크립트는 세션 스크래치패드에서 실행 후 정리함). 같은 파일 영속 PGlite 데이터 디렉터리를 서로 다른 Node 프로세스 두 개가 겹쳐 열도록 재현(A가 먼저 열어 6초 유지, 1.5초 뒤 B가 열어 각자 insert, 이후 세 번째 프로세스로 최종 상태 확인) — 2회 반복해 재현성 확인. **결과: 에러 없이 나중에 연 프로세스(B)의 쓰기가 조용히 유실됐다** — 락 거부가 아니라 silent data loss(PGlite README도 "single user/connection" 명시). 이에 따라 retail-mcp가 **자체 파일 락(PID+타임스탬프)으로 동시 접근을 막는 것**을 v0.2 구현 요구사항으로 확정했다. 이걸로 SPEC §8의 v0.2 관련 미결 항목이 전부 정리됐다(남은 3개는 Loyverse/v0.1 재검토용). 상세는 SPEC §12 "PGlite 다중 프로세스 동시 접근". 다음은 CSV/Excel 데이터소스 실제 백로그(TASKS.md 새 태스크) 설계.
