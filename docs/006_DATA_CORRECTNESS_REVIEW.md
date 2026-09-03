# 006 — 데이터 정확성·업무 로직 적대적 검수

- 검수일: 2026-09-03
- 대상: CSV/Excel 지점·본사 흐름, snapshot, SCM 대사
- 판정: **출시 차단 — 정상 테스트를 통과하지만 운영 데이터가 조용히 소실·잔존·중복 통지될 수 있음**
- 상태: **RESOLVED(T33, 2026-09-03)** — DATA-001~008 전부 해결. 전체 재검수는 T37에서 진행. tombstone/일일 다이제스트 정책은 `docs/SPEC.md` §18, `docs/DESIGN.md` §12.2~12.3에, nullable clear/SCM insufficient_data/scm_status/입고 합산은 `docs/DESIGN.md` §12.7에 반영됨.

## DATA-001 — snapshot export가 `포장수량`을 소실함

- 심각도: **치명적**
- 영역: `src/core/snapshotExport.ts`
- 재현: `packSize: "24"`인 ProductRow를 export하면 헤더와 행 어디에도 `포장수량`이 없다.
- 영향: 지점 모드에서는 팩 단위로 올림한 뒤 알림하지만, 지점 snapshot을 읽는 본사 통합 모드에서는 pack size가 null로 바뀐다. T19의 round-trip 보장과 T24/T25의 팩 단위 기능이 결합되지 않았다.
- 수정 기준: snapshot schema/header/row에 `포장수량`을 포함하고 `parse → export → parse` 후 packSize가 동일한 회귀 테스트를 추가한다.
- **해결(T31)**: `core/snapshotExport.ts`의 `COLUMNS`/행 매핑에 `포장수량` 추가. 왕복 테스트에 `포장수량`이 섞인 원시 행을 포함시켜 재확인.

## DATA-002 — 파일에서 사라진 SKU/매장이 DB에 영구 잔존함

- 심각도: **치명적**
- 영역: `runFolderScan`, `runConsolidatedScan`, Warehouse upsert 모델
- 근거: 각 스캔은 현재 파일 행을 upsert만 하며 이전 스캔에 있었지만 새 파일에 없는 `inventory_levels`와 `sales_period_agg`를 제거/비활성화하지 않는다.
- 영향: 파일 기반 현재 상태와 MCP 조회 DB가 달라진다. 판매 중단·폐기·지점 철수 품목이 stale 재고/판매량으로 계속 노출되고 재주문 제안에 섞일 수 있다.
- 수정 기준: source/branch별 authoritative snapshot 경계를 저장하고 같은 트랜잭션에서 누락 행을 tombstone 또는 삭제한다. “누락=삭제”가 아닌 입력이라면 명시적 활성 상태 컬럼을 요구한다.
- **해결(T31)**: `inventory_levels`/`sales_period_agg`에 `active` 컬럼(migrations/006) + `Warehouse.deactivateMissingCsvRows()` — `runFolderScan`/`runConsolidatedScan` 양쪽이 업서트와 같은 트랜잭션 안에서 이번 스캔에 없는 (매장,SKU)를 비활성화한다. 물리 삭제 없음(이력 보존), 재등장 시 자동 재활성화. 상세는 DESIGN §12.2.

## DATA-003 — 동일한 최신 파일을 cron마다 재처리·재발송함

- 심각도: **치명적**
- 영역: 지점 `runFolderScan`
- 근거: latest file의 경로/mtime/hash watermark를 조회하거나 비교하지 않고 매 실행 random `runId`를 생성한다. 같은 파일이어도 새로운 발송 예약이 가능하다.
- 영향: 사용자가 파일을 갱신하지 않아도 cron 주기마다 동일 저재고 이메일이 반복 발송된다. 기존 runId 멱등성은 같은 runId 재시도만 막고 이 문제는 막지 않는다.
- 수정 기준: source identity + content hash/mtime watermark를 원자적으로 기록해 변경 없는 입력은 `unchanged`로 종료한다. 알림 정책이 반복 reminder라면 별도 cadence와 명시적 opt-in으로 정의한다.
- **해결(T31)**: `sync_state`에 `csv_branch_digest:<watchDir>` 키로 `{contentHash, lastSentAt}` 저장, 실제 발송 시도 경로에서만 24시간 상한 확인(`shouldSkipAsUnchanged`) — `no_suggestions`/`dry_run`은 이 정책과 무관하게 항상 처리(사람의 반복 수동 확인을 억제하지 않기 위한 의도적 범위 축소, 근거는 DESIGN §12.3). 발송 실패는 워터마크를 갱신하지 않아 즉시 재시도 가능.

## DATA-004 — snapshot 파일 쓰기가 원자적이지 않음

- 심각도: **높음**
- 영역: `folderScan.ts`
- 근거: 고정 파일명 `snapshot.csv`에 `writeFile`로 직접 덮어쓴다. 본사 수집/동기화 프로세스와 snapshot directory용 lock이 없다.
- 영향: 쓰는 도중 프로세스가 죽거나 본사 프로세스가 동시에 읽으면 잘린 CSV를 볼 수 있다. 이전 정상 snapshot도 덮어써 복구가 어렵다.
- 수정 기준: 같은 디렉터리의 임시 파일에 쓰고 flush 후 atomic rename한다. 본사 전달 과정도 `.partial` 제외 또는 ready marker 규약을 둔다.
- **해결(T31)**: `src/adapters/atomicFile.ts`(신규) `writeFileAtomic()` — 임시 파일→fsync→rename. 임시 파일명이 `.csv`/`.xlsx`로 안 끝나 기존 파일 탐색 필터가 자연히 무시한다(별도 ready marker 불필요).

## DATA-005 — product nullable 속성을 제거할 수 없어 오래된 값이 남음

- 심각도: **높음**
- 영역: `pgWarehouse.upsertProductsOn`
- 근거: `low_stock_threshold`와 `pack_size`가 `coalesce(excluded, existing)`로 갱신된다. 새 authoritative CSV에서 셀을 비워도 기존 값은 지워지지 않는다.
- 영향: 팩 단위 구매를 중단하거나 임계치를 기본값으로 되돌려도 과거 설정이 계속 적용돼 잘못된 발주 수량/경고가 생성된다.
- 수정 기준: “필드 미제공”과 “명시적 null로 제거”를 타입에서 구분하거나 source별 우선순위/소유권을 정의한다. clear 동작을 회귀 테스트한다.
- **해결(T33, 2026-09-03)**: `ProductRow.lowStockThreshold`/`packSize`(이미 `?: Numeric | null`이던 타입)의 `undefined`(정보 없음)/`null`(명시적으로 지움)/값 세 상태를 실제로 구분해 반영한다(`core/types.ts` 문서 갱신). `csvExcelParser.ts`의 `mapRowsToDomain`이 raw 행에 그 컬럼 키가 있었는지(csv-parse는 헤더 있으면 빈 셀도 키를 만듦)로 판정 — XLSX는 `parseExcelFile`이 헤더의 모든 컬럼을 행마다 미리 `undefined`로 시드해둔 뒤 실제 셀 값으로 덮어써 같은 성질을 갖게 했다(착수 중 발견 — `eachCell({includeEmpty:false})`이 빈 셀을 건너뛰어 그 전엔 "컬럼 없음"과 "빈 셀"을 구분할 수 없었다). `pgWarehouse.ts`의 `upsertProductsOn`은 배치(한 파일) 전체에 "이 필드에 조금이라도 정보가 있는 행이 하나라도 있는가"만 판정해 SET절 자체를 고른다 — 있으면 `excluded.x`(null도 그대로 반영, clear), 없으면 `products.x`(기존 값 보존). 컬럼 존재 여부가 파일 헤더 단위 속성이라 한 배치 안에서 행마다 갈리지 않는다는 성질을 이용한 설계다. 테스트: `tests/csvExcelParser.test.ts`(신규 describe, CSV/XLSX 둘 다 컬럼없음/빈셀/값 3가지 + SKU 간 불일치 거부), `tests/pgWarehouse.test.ts`(신규 describe 4 tests, clear/배치 혼합 케이스).

## DATA-006 — SCM 대사가 기초재고 0과 기간 불일치를 정상 입력처럼 사용함

- 심각도: **높음**
- 영역: `ingestScmReceipts`, `computeStockReconciliation` 호출
- 근거: 기초재고를 제공하지 않아 기본 0을 사용하고, SCM 파일 기간과 판매기간이 같은지 검증하지 않는다. SPEC §16도 이를 알려진 한계로 적었지만 결과는 실제 이메일 경고에 포함된다.
- 영향: 운영 시작 전부터 존재한 재고와 서로 다른 기간의 입고/판매를 비교해 대량의 거짓 “도난·파손·실사오차” 경고를 보낼 수 있다.
- 수정 기준: opening snapshot과 공통 대사 기간이 없으면 reconciliation을 계산하지 않고 `insufficient_data`로 표시한다. 기간이 겹치는지 검증하고 경고 문구도 확정 원인이 아닌 불일치 사실만 표현한다.
- **해결(T33, 2026-09-03)**: `core/metrics.ts`의 `StockReconciliationRow`에 `insufficientData: boolean` + `insufficientDataReasons: string[]` 신설. 기초재고는 `openingStock`에 그 (store,variant) 키가 없으면(온보딩 실사값 입력 흐름은 여전히 이후 태스크라 지금은 항상 없음) `insufficientData: true`, 기간은 새 `periodsOverlap` 옵션(호출자가 SCM 입고 기간과 판매 기간을 직접 비교해 넘김, 순수 함수 `periodsOverlap()`)이 `false`면 마찬가지다. `discrepancy` 숫자 자체는 참고용으로 여전히 계산해두지만(완전히 숨기지 않음), `insufficientData`면 "도난·파손·실사오차 확인 필요" 같은 확정 원인을 단정하는 문구를 `warnings`에 넣지 않는다. `agent/folderScan.ts`는 확정 불일치(`hasDiscrepancy && !insufficientData`)만 `FolderScanResult.reconciliation`에 남기고, insufficientData 여부는 SKU별 노이즈 없이 `scmStatus`(DATA-007과 통합, 아래) 한 줄 요약으로만 알린다. 오늘 시점에는 opening stock을 실제로 채워 넘기는 호출자가 없어 **모든 SCM 대사가 insufficientData가 되는 게 정상**이다 — 온보딩 실사값 입력 태스크가 생기면 그때부터 확정 불일치가 나온다. 테스트: `tests/metrics.test.ts`(신규 describe 2개, `insufficientData`/`periodsOverlap` 각각), `tests/folderScan.test.ts`(insufficientData e2e, 확정 불일치 발송 이메일에 확정 문구 없음 확인).

## DATA-007 — SCM 실패가 구조화된 결과에서 사라짐

- 심각도: **높음**
- 영역: `ingestScmReceipts`
- 근거: 폴더 접근·파싱·DB 적재 오류를 모두 console warning 후 빈 배열로 바꾼다. `FolderScanResult`에는 skipped/error 상태가 없다.
- 영향: 자동 실행 환경에서 사용자는 저재고 이메일을 정상 결과로 받으면서 SCM 대사가 실패했다는 사실을 놓칠 수 있다. “데이터 없음”과 “처리 실패”가 구분되지 않는다.
- 수정 기준: 부가 기능 실패 격리는 유지하더라도 result/email/운영 로그에 `scm_status`, 오류 코드, 사용 파일, 데이터 신선도를 포함한다.
- **해결(T33, 2026-09-03)**: `agent/folderScan.ts`에 `ScmStatus` 타입 신설(`not_configured`/`no_file`/`failed`(오류 메시지 포함)/`ok`(사용 파일·입고 건수·DATA-006 `insufficientData` 포함)) — `ingestScmReceipts`가 `console.warn` 후 빈 배열로 삼키던 실패를 이제 구조화된 값으로도 반환한다(콘솔 경고는 그대로 유지 — 실시간 로그도 계속 남는다). `FolderScanResult.scmStatus`로 모든 반환 경로(no_suggestions/dry_run/unchanged/sent)에 노출하고, 실제 report가 발송될 때는 `renderAlertText`가 SKU별 목록이 아니라 한 줄 요약(`[SCM 처리 실패]`/`[SCM 재고 정합성 참고]`)으로 이메일 본문에도 넣는다 — "정상 결과처럼 보이는 이메일에 SCM 실패가 묻힌다"는 지적을 실제로 막는다. DATA-006의 `insufficientData`와 자연스럽게 통합됐다(같은 `scmStatus.ok` 케이스의 한 필드). 테스트: `tests/folderScan.test.ts`(not_configured/no_file/failed/ok 각 케이스, 발송 이메일 본문에 요약 문구 포함 확인).

## DATA-008 — 같은 날짜의 복수 입고가 덮어써짐

- 심각도: **높음**
- 영역: `purchase_receipts` PK
- 근거: PK가 `(store_id, variant_id, received_at)`이고 event id가 없어 같은 날 같은 SKU의 두 입고를 합산하지 않고 마지막 값으로 upsert한다.
- 영향: 실제 입고 합계가 축소되어 예상재고와 정합성 계산이 틀린다. 문서화된 한계지만 npm 일반 배포에서 조용한 데이터 손실로 이어진다.
- 수정 기준: 원본 행 번호/문서 번호/content hash 같은 안정적 event key를 도입하거나 import 전에 동일 날짜 행을 명시적으로 합산하고 중복 파일 idempotency를 별도로 보장한다.
- **해결(T33, 2026-09-03)**: 안정적 event key 도입 대신(원본 SCM 시트에 그 정보 자체가 없다) "import 전 합산" 쪽을 채택했다 — `core/scmSchema.ts`의 `mapScmRowsToPurchaseReceipts`가 반환 직전에 `aggregateSameDayReceipts()`로 (매장,SKU,입고일) 단위 수량을 합산한다. 단가·통화·거래처(감사 추적용, 재고 정합성 계산엔 안 쓰임)는 합산할 수 없는 값이라 마지막 행 것을 남긴다. `pgWarehouse.ts`의 `upsertPurchaseReceiptsOn`에 이 계약을 문서화(다른 호출자를 추가할 땐 같은 방식으로 미리 합산해야 함을 명시). 같은 파일을 반복 스캔해도(idempotency) 매번 같은 합산 결과를 그대로 대입(assignment)하므로 중복 누적되지 않는다. 테스트: `tests/scmSchema.test.ts`(신규 describe 5 tests — 2건/3건 이상 합산, 감사 필드 마지막 값, 매장 분리, SKU 분리).

## 데이터 재검수 기준

- [x] pack size snapshot round-trip 보존(T31)
- [x] authoritative snapshot의 누락 행 처리 정책 구현(T31)
- [x] unchanged 파일 재발송 0건(T31 — 실제 발송 시도 경로 한정)
- [x] snapshot atomic write/reader handoff(T31)
- [x] nullable 설정 clear 지원(T33)
- [x] SCM 대사에 opening stock·기간·실패 상태 포함(T33)
- [x] 복수 입고와 재import 모두 정확한 합계(T33)

