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

## v0.2 대기열 (착수 금지 — SPEC 로드맵 참조)

- StoreHub CSV 폴백 파서 / SCM 시트 연동(sheet_mcp 클라이언트) / `explore_sql`(읽기 전용 롤) / 팩 단위 반올림 / 정통 셀스루(입고 기반)

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
