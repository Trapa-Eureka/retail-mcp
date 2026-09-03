# TESTING — retail-mcp

목적: 에이전트가 라이브 클라우드(POS·DB·이메일·LLM) 없이 로컬에서 결정론적으로 검증하게 한다. 특히 **지표 수식이 이 제품의 심장**이므로, 손계산 골든 케이스로 수식을 못박는다.

## 1. 원칙

- 테스트 네트워크 호출 0건. DB는 **PGlite**(인프로세스 Postgres — 운영과 같은 SQL 방언, 파일/메모리 모드), POS는 픽스처, 발송·LLM은 목.
- 결정론: `FixedClock`, 랜덤 없음. 모든 날짜 계산은 주입된 시계 기준.
- `npm run check` = typecheck + lint + test. 전체 수 초 내.

## 2. 목·픽스처 구성

| 구성요소 | 내용 |
|---|---|
| `FixtureLoyverseClient` | `fixtures/loyverse/*.json` (stores/items/receipts/inventory — 실제 API 응답 형태) 재생. 페이지네이션·커서 재현 |
| PGlite 헬퍼 | 테스트마다 새 인스턴스에 `migrations/*.sql` 적용 → 운영과 동일 스키마 보장 |
| `MockNotificationProvider` | 발송 기록 + `failFor` 실패 주입 (sheet_mcp와 동일 패턴) |
| `MockSummarizer` | 고정 문자열 반환 / `fail: true`로 LLM 장애 재현 |
| `FixedClock` | 기준일 고정 (예: 2026-09-01T00:00Z) |

픽스처 시나리오: 매장 2곳 × 품목 8종 × 최근 35일 판매 — 잘 팔리는 것, 안 팔리는 것, 환불 포함, 신규 품목(이력 5일), 재고 0, 유니코드 품목명(타갈로그·한글) 포함.

## 3. 골든 케이스 (unit — core/metrics)

수기 계산값을 테스트에 하드코딩한다. 예:

- 30일 판매 60개, 기말재고 40 → 셀스루 = 60/(60+40) = **0.60**
- 28일 판매 56개 → 일평균 2.0 / 재고 15 → 커버 **7.5일** → 리드7+안전3=10 기준 **위험**
- 목표커버 21일 → 제안량 = ceil(21×2.0 − 15) = **27**
- 판매 0 + 재고 20 → 일평균 0 → 커버 ∞ 표기, 위험 아님, 제안 0
- 판매 0 + 재고 0 → 셀스루 null (신규/무재고 구분 표기)
- 환불 포함(판매 10, 환불 −2) → soldQty 8로 집계

## 4. 필수 엣지 케이스 체크리스트 (component)

**ETL**
- [ ] 동일 픽스처 2회 동기화 → 행 수 불변 (멱등 upsert)
- [ ] receipts 커서 저장·재개: 2페이지 중 1페이지 후 실패 → 커서 미갱신 → 재실행 시 이어받기
- [ ] 환불 영수증 → 음수 qty 적재
- [ ] 스냅샷: 동기화 2회 → `inventory_snapshots` 2개 시점 존재

**MCP 도구**
- [ ] `sell_through` 기본 호출 = 골든 케이스 값과 일치, 근사식 각주 포함
- [ ] `reorder_suggestions` 결과 = 에이전트 리포트 표와 **완전 동일** (같은 core 경유 회귀 가드)
- [ ] store_id·category 필터 정확성 / 존재하지 않는 store_id → 수정 방법 담긴 에러
- [ ] `sync_status` — 커서·시각 반환

**에이전트**
- [ ] 제안 0건 → 발송 0건, 로그만
- [ ] `SEND_MODE=dry_run` → provider 호출 0건, dry-run 출력에 표 포함
- [ ] `SEND_MODE=live` + `--confirm` 둘 다일 때만 목 provider 호출됨 (한쪽만으로는 불가)
- [ ] `MockSummarizer` 실패 → 요약 없이 표만으로 발송 진행
- [ ] 발송 후 `agent_send_log`에 기록 (dry_run 여부 포함)

**성능 가드**
- [x] 판매 라인 50,000행 픽스처: ETL 적재 + `reorder_suggestions` 계산 합계 < 5초 (PGlite 기준) — `tests/performance.test.ts`. **`npm run coverage`(v8 계측)에서는 이 테스트를 제외한다**(`vitest.config.ts`, TASKS T36) — CI에서 6567ms/5463ms/5042ms 등으로 반복 실패하는 걸 실측했다. wall-clock 예산을 계측된 실행에서 재는 것 자체가 잘못된 측정이라 가드를 없앤 게 아니라 계측 없는 도구로 옮긴 것 — 이 가드는 계측 없는 `test` job(plain `vitest run`, 매 PR/OS/Node 조합)이 여전히 강제한다.

## 5. 수동 스모크 (사람 전용 — scripts/smoke.ts)

`npm run smoke`: 실 Loyverse 토큰 + 실 DB로 ① sync ② 도구 3종 호출 출력 ③ 에이전트 dry-run. **live 발송은 스모크에 포함하지 않는다** — 최초 실발송은 사람이 `--confirm`으로 직접 1회.

## 6. 커버리지

- `src/core/` 90% 이상 (vitest --coverage, T9에서 리포트). 어댑터는 스모크로 보완.

## 7. 추가 회귀 가드

**동기화·동시성**

- [ ] 페이지 중간 실패 시 해당 리소스 데이터와 watermark가 모두 이전 상태로 롤백되고, 재실행은 이전 watermark부터 안전하게 중복 처리
- [ ] 동일 `updated_at`의 영수증 여러 건이 페이지 경계에 있어도 누락 0건
- [ ] 동일 시각을 반환하는 `FixedClock`으로 2회 동기화해도 스냅샷 PK 충돌이 없고 실행별 스냅샷 구분 가능
- [ ] 동시 `sync_now` 2건 중 하나만 실행되고 다른 호출은 실행 중 오류/상태를 반환

**수치·날짜·품질**

- [ ] 환불이 판매보다 많은 기간과 음수 현재고에서 계산 결과가 음수가 되지 않고 품질 경고 포함
- [ ] 사업장 자정·월말·DST 경계에서도 최근 N일 창이 명세와 일치하고 머신 로컬 타임존에 독립적
- [ ] 소수 수량 및 큰 `numeric` 값에서 중간 반올림 없이 재주문 `ceil` 정책 일치
- [ ] stale 동기화 결과와 근사 셀스루에 필수 경고·마지막 성공 시각 포함

**보안·장애**

- [ ] 조회 전용 DB 역할로 5개 조회 도구는 성공하고 쓰기 및 `sync_now`는 실패/미등록
- [ ] API 타임아웃·429 `Retry-After`·재시도 상한 검증, 오류/로그 스냅샷에 시크릿 미포함
- [ ] 동일 `run_id`의 live 재시도에서 이메일 중복 발송 0건
- [ ] Summarizer 입력에 토큰·이메일 주소·불필요한 원시 영수증 데이터가 없음

커버리지 리포트와 50k행 성능 가드는 `TASKS.md`의 **T10**에서 완료한다(T9는 MCP 기능 회귀 테스트까지 담당).

## 8. 출시 게이트 및 공격 회귀 테스트 (2026-09-03, docs/004~008 적대적 검수 대응 — TASKS T28)

npm publish 전 적대적 검수(`docs/004_NPM_RELEASE_PACKAGING_REVIEW.md`~`docs/008_TEST_AND_RELEASE_GATE_REVIEW.md`)가 지적한 대로, 지금까지의 게이트(`npm run check` + 위 §1~§7)는 저장소 소스 트리와 devDependency가 설치된 환경만 검증하고 실제 npm 설치·운영 경계·공격 시나리오는 검증하지 않는다(008 QA-001~006). 아래를 **release gate**(npm publish 전 필수, 매 로컬 `npm run check`와는 별도)로 추가한다 — 각 항목의 실제 구현은 담당 TASKS 번호에서 진행한다.

**패키징 게이트 (TASKS T29 — 구현 완료, `npm run verify:pack`)**

- [x] `npm pack --dry-run`의 파일 목록이 `files` allowlist와 일치(`dist`/`migrations`/`README`/`LICENSE`/`.env.example`만) — 97개→63개로 확인
- [x] tarball을 임시 디렉터리에 `npm install --omit=dev`로 설치 후 `bin` 실행 또는 MCP initialize까지 성공(QA-001) — `scripts/verifyPack.ts`가 `retail-mcp`(MCP `tools/list`)와 `retail-mcp-onboard`(`.env`+템플릿 생성)를 둘 다 실제 spawn으로 검증. 아직 `npm run check`/CI에는 자동 연결하지 않음(빌드+pack+install까지 하는 무거운 절차라 release gate 전용 별도 스크립트로 둠, TESTING §1 원칙과 별개) — CI 연결은 T37.

**보안 게이트 (TASKS T30/T32 — 완료)**

- [x] `pg_advisory_lock`류 volatile 함수, `set_config` 재정의를 이용한 explore_sql 우회 시도가 회귀 테스트로 고정됨(SEC-001/002) — `tests/sqlValidator.test.ts`(함수 블록리스트), `tests/exploreSqlExecutor.test.ts`(실행 전 거부 + "검증기를 우회했다면 READ ONLY 혼자로는 못 막았을 것"을 실증하는 문서화 테스트), `tests/server.test.ts`(`EXPLORE_SQL_ALLOW_PGLITE` 게이팅)
- [x] snapshot CSV formula injection(`=`/`+`/`-`/`@` 시작 값) escape 및 round-trip 테스트(SEC-004) — `tests/csvSafety.test.ts`, `tests/snapshotExport.test.ts`
- [x] 대형/압축폭탄 XLSX·대량 CSV에 대한 파일 크기·행·셀 길이 상한 테스트(SEC-003) — `tests/fileLimits.test.ts`, `tests/csvExcelParser.test.ts`(잔여 위험은 `src/adapters/fileLimits.ts`/`csvExcelParser.ts` 문서 참고 — XLSX는 buffered 판정)
- [x] `.env` 0600 + 원자 쓰기 테스트(SEC-005) — `tests/onboard.test.ts`
- [x] `npm audit --omit=dev` 0건 또는 근거·만료일이 기록된 승인된 예외(SEC-006) — 0건은 아님, uuid(exceljs 경유) 승인된 예외 1건(재검토 2027-03-03, `docs/005` 상세) + `scripts/verifyPack.ts`가 **실제 게시 tarball 설치 기준**으로 이 예외 하나뿐인지 매번 확인(release gate 5단계, dev 체크아웃의 `overrides`는 published 소비자에게 적용 안 됨을 착수 중 발견)

**데이터 정확성 게이트 (TASKS T31/T33 — 완료)**

- [x] snapshot export → import 왕복 시 `포장수량` 보존(DATA-001) — `tests/snapshotExport.test.ts`
- [x] authoritative 스캔에서 사라진 SKU/매장이 tombstone 처리되고 재주문·저재고 계산에서 제외됨(DATA-002) — `tests/pgWarehouse.test.ts`(`deactivateMissingCsvRows`), `tests/folderScan.test.ts`(tombstone e2e)
- [x] 동일 파일로 cron을 반복 실행해도 재발송이 없고, 마지막 발송으로부터 하루가 지나면 변경 없이도 다이제스트 1회가 발송됨(DATA-003) — `tests/folderScan.test.ts`(일일 다이제스트 5 tests, 적용 범위는 실제 발송 시도로 한정 — DESIGN §12.3)
- [x] snapshot 파일 쓰기 도중 프로세스가 죽어도 이전 정상 snapshot이 손상되지 않음(atomic write, DATA-004) — `tests/atomicFile.test.ts`
- [x] 컬럼 없음(undefined)/명시적 clear(null)/값 세 상태가 nullable 필드에서 정확히 구분되고 반영됨(DATA-005) — `tests/csvExcelParser.test.ts`(CSV/XLSX 파싱 단계), `tests/pgWarehouse.test.ts`(upsert 단계)
- [x] SCM 기초재고·기간 불일치 시 `insufficientData`로 표시되고 거짓 discrepancy(확정 원인 단정 경고)가 발생하지 않음(DATA-006) — `tests/metrics.test.ts`
- [x] SCM 처리 실패가 결과/이메일에 `scmStatus`로 노출됨(DATA-007) — `tests/folderScan.test.ts`
- [x] 같은 날짜 복수 입고가 축소 없이 합산됨(DATA-008) — `tests/scmSchema.test.ts`

**운영 신뢰성 게이트 (TASKS T34 — 완료)**

- [x] `db.close()` 실패 시에도 파일 락이 해제됨(OPS-001) — `tests/warehouseFactory.test.ts`(db.close() 실패 시 release 확인, 둘 다 실패 시 AggregateError)
- [x] PID 재사용이 stale lock으로 정확히 판별되고, 다른 호스트가 쓴 락은 자동 회수되지 않음(OPS-002) — `tests/fileLock.test.ts`(신규 describe 6 tests)
- [x] latest file 동률(mtime 동일) 시 결정론적으로 처리됨(OPS-003) — `tests/folderScan.test.ts`(`utimes`로 mtime을 강제로 맞춘 뒤 반복 스캔해도 항상 같은 파일 선택 확인)
- [x] 이메일 발송 timeout이 `unknown` 상태로 남고 사람 확인 없이 자동 재시도하지 않음, Idempotency-Key 전달(OPS-004) — `tests/resendProvider.test.ts`, `tests/pgWarehouse.test.ts`, `tests/folderScan.test.ts`
- [x] 구조화 로그가 JSON으로 파싱 가능하고, 보존 기간 지난 `agent_send_log`/`inventory_snapshots` 행이 `npm run cleanup`으로 정리됨(OPS-005) — `tests/structuredLog.test.ts`, `tests/pgWarehouse.test.ts`(신규 describe 4 tests)

**Postgres 계약 게이트 (TASKS T35 — 완료, CI 전용)**

- [x] CI service Postgres에서 migration, transaction rollback, READ ONLY role, advisory lock cleanup, explore_sql timeout을 component test(QA-004) — `tests/component/postgres.component.test.ts`(`vitest.component.config.ts`, `npm run test:pg-component`), CI `postgres-component` job(`postgres:16` 서비스 컨테이너). PGlite와 실 Postgres의 이미 알려진 차이(§17 statement_timeout 미집행)가 실 Postgres에서는 재현되지 않음을 직접 확인했다(로컬 `postgresql@16`으로 8/8 통과 실측, TASKS T35).
- [x] CI matrix에 최소 지원 OS/Node LTS로 `npm run verify:pack`(clean tarball install) 포함(007 OPS-006, T34에서 이관) — `.github/workflows/ci.yml`의 `test` job, `os: [ubuntu-latest, macos-latest] × node: [20, 22]`.

**테스트 게이트/공급망 게이트 (TASKS T35 — 완료)**

- [x] coverage threshold를 CI 필수 게이트로 승격(QA-002) — CI `coverage` job(`npm run coverage`). 로컬 `npm run check`엔 의도적으로 미포함(무거움).
- [x] coverage 범위를 core 밖(explore_sql/warehouseFactory/agent/mcp/cli)까지 확장 + 위험 모듈별 threshold(QA-003) — `vitest.config.ts`의 `coverage.include`/`thresholds`.
- [x] 005~007의 공격/정확성 회귀 케이스가 전부 자동 테스트로 연결됨(QA-005) — `docs/010_FINDING_TEST_CROSSREF.md`가 finding별 대조표. 이번에 새로 채운 유일한 빈 칸은 "partial snapshot 동시 read"(`tests/atomicFile.test.ts`).
- [x] dependency audit(lockfile 기준) + tarball allowlist assertion + secret scan + SBOM을 release 워크플로에 연결(QA-006) — CI `audit` job(`npm run audit:lockfile`, `npm run secret-scan`, `npm sbom` → 아티팩트). fail-open/fail-closed 정책은 `src/adapters/auditLockfile.ts` 문서 주석 참고.

이 절의 각 항목은 007/008이 지적한 "376개 테스트가 통과해도 게시된 패키지가 실행 불가능하거나 공격에 취약할 수 있다"는 간극을 메우기 위한 것이다 — §1~§7의 기존 게이트를 대체하지 않고 추가한다. finding별 상세 대조는 `docs/010_FINDING_TEST_CROSSREF.md` 참고.
