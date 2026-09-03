# CLAUDE.md — retail-mcp 스티어링

리테일 다지점용 셀스루·재고 BI MCP 서버 + 재주문 제안 에이전트. v0.1 데이터 소스는 Loyverse 단일(구현 완료, 실배포는 파일럿 확정 전까지 보류) — 다음 실제 출시 대상은 **v0.2 CSV/Excel 업로드 채널**(폴더 감시, 임베디드 PGlite 기본값)이다. 배경·지표 정의는 `docs/SPEC.md`, 구현 설계는 `docs/DESIGN.md`. npm 공개 배포 대상은 `@trapa-eureka/retail-mcp`(MIT) — 출시 전 검수·정책은 `docs/SPEC.md` §18, `docs/004~009`.

## 스택

- Node.js 20+, TypeScript **strict** (`noUncheckedIndexedAccess` 포함)
- MCP: `@modelcontextprotocol/sdk` — stdio transport
- 웨어하우스: **임베디드 PGlite가 기본값**(`.retail-mcp/data/`, 자체 파일 락으로 다중 프로세스 보호) — `DATABASE_URL` 지정 시 Neon/Supabase 등 `pg` 드라이버 경로. 테스트는 항상 **PGlite**(인프로세스, 네트워크 0)
- 데이터 소스: CSV/Excel 폴더 감시(v0.2, 다음 실제 출시 대상, `csv-parse`/`exceljs`) — Loyverse REST API(`LOYVERSE_API_TOKEN`, v0.1, 구현 완료·파일럿 대기)는 어댑터 뒤에 격리돼 병존
- 알림: sheet_mcp에서 이식한 `NotificationProvider` + `ResendEmailProvider`
- LLM(에이전트 요약 전용): Claude API
- 검증: Vitest + ESLint + Prettier, 스키마 `zod`, 마이그레이션 = 순수 SQL 파일 + 자체 러너

## 명령어

```bash
npm run check          # typecheck + lint + test 일괄 — 태스크 완료의 필수 게이트
npm run test           # vitest run
npm run typecheck      # tsc --noEmit
npm run lint           # eslint .
npm run dev            # MCP 서버 stdio 실행
npm run migrate        # DATABASE_URL 대상 마이그레이션 (프로덕션 실행은 사람만)
npm run agent:reorder  # 재주문 에이전트 1회 실행 (기본 dry_run)
npm run smoke          # 실 Loyverse + 실 DB 수동 스모크 (사람 전용)
```

## 소스 레이아웃

```
src/
  core/        # 순수 로직: metrics(셀스루·커버일수·재주문량), csvSchema, scmSchema, sqlValidator, 타입 — 외부 IO 없음
  etl/         # Loyverse 동기화 오케스트레이션 (LoyverseClient + Warehouse 조립, 커서 관리)
  adapters/    # loyverseClient, pgWarehouse, csvExcelParser, resendProvider, exploreSqlExecutor, fileLock, warehouseFactory
  mocks/       # FixtureLoyverseClient, PGlite 웨어하우스 헬퍼, MockNotificationProvider, FixedClock
  agent/       # reorder.ts(Loyverse 경로) / folderScan.ts(CSV/Excel 경로, 지점·본사 모드) — 스케줄 실행 진입점, 얇은 오케스트레이션만
  cli/         # onboard.ts — 대화형 설정 CLI (`npm run onboard`)
  mcp/         # tools.ts — MCP 도구 로직(server.ts는 등록·조립만)
  server.ts    # MCP 서버 진입점 (도구 등록·조립만, 로직 없음)
migrations/    # 001_init.sql ... 순번 SQL 파일
tests/  fixtures/loyverse/  fixtures/csvExcel/  fixtures/scm/  scripts/
```

## 컨벤션

- **지표 수식의 진실의 원천은 `docs/DESIGN.md` §3.** 코드·테스트·문서가 다르면 문서 기준으로 맞춘다.
- 모든 외부 IO(POS, DB, 발송, 시계, LLM)는 인터페이스 뒤에. `core/`는 인터페이스와 순수 계산만.
- `any` 금지. 외부 입력(API 응답, 도구 인자)은 경계에서 `zod` 파싱.
- MCP 질의 도구의 SQL은 **파라미터라이즈드 고정 쿼리만**. `explore_sql`(임의 SELECT 조회, 운영 기본값 비활성)이 가드레일 4가 사전 승인한 유일한 예외 — `docs/SPEC.md` §17·§18, `docs/DESIGN.md` §12.4 참고. 새 질의 도구를 추가할 땐 이 예외를 넓히지 말고 고정 쿼리로 만든다.
- 에러 메시지는 원인 + 수정 방법까지 (예: `LOYVERSE_API_TOKEN이 없습니다. Loyverse 백오피스 > 액세스 토큰에서 발급해 .env에 추가하세요.`).
- 커밋 메시지: `T{n}: 요약` (영어로 작성. 2026-09-02 이후 컨벤션 — 그 이전 커밋은 한국어로 작성됐다가 사후 영어로 재작성됨).

## 가드레일 (위반 금지)

1. **실발송 이중 게이트**: 기본 `SEND_MODE=dry_run`. 실발송은 `SEND_MODE=live` **그리고** 에이전트 실행 인자 `--confirm`이 둘 다 있어야 한다. 테스트는 어떤 경우에도 live 경로 금지.
2. 테스트에서 **네트워크 호출 0건**: DB는 PGlite, POS는 픽스처, 발송은 목, LLM은 목 응답.
3. **LLM은 숫자를 만들지 않는다**: 품목·수량·금액은 결정론 계산 결과에서만 오고, LLM 출력은 요약 문구로만 쓰인다. LLM 출력의 수치를 파싱해 로직에 쓰는 코드 금지.
4. 웨어하우스 **쓰기는 ETL 경로만**. MCP 질의 도구는 읽기 전용 (운영 DB에는 읽기 전용 롤 사용). `explore_sql`을 켤 때는 위험 함수 실행 권한이 없는 전용 role을 필수로 요구한다 — `BEGIN READ ONLY`만으로는 advisory lock류 부수효과를 막지 못함(`docs/SPEC.md` §18, `docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md` SEC-001/002).
5. `npm run migrate`를 프로덕션 `DATABASE_URL`에 실행하는 것은 사람만. 에이전트는 마이그레이션 **파일 작성까지만**.
6. 시크릿(`LOYVERSE_API_TOKEN`, `DATABASE_URL`, `RESEND_API_KEY`, `ANTHROPIC_API_KEY`)은 `.env`만. 커밋 금지, `.env.example`만 커밋.

## 작업 방식

- 한 세션 = `docs/TASKS.md`의 한 태스크. 완료 기준 전부 충족 + `npm run check` 통과까지 자가 수정 루프. 스펙 모호로 진행 불가할 때만 멈추고 질문.
- 완료 시 변경 파일과 검증 결과 요약 후 종료.

## 프루닝 로그

격주 검토, 낡은 규칙 삭제 (`docs/WORKFLOW.md`).

- 2026-09-02: 최초 작성.
- 2026-09-03: v0.2(CSV/Excel 채널, SCM 대사, 팩단위 반올림, `explore_sql`) 완료 + npm 출시 전 적대적 검수(`docs/004~009`) 반영 — 스택/레이아웃/가드레일을 v0.2 실제 구조로 갱신, "v0.1 데이터 소스는 Loyverse 단일"만 남기지 않고 v0.2 전환 상태를 명시. 낡은 규칙 삭제는 없음(v0.1 규칙은 여전히 유효, v0.2가 추가된 것).

## 구현 해석 보충 (2026-09-02 문서 점검)

- `cursor`라는 이름을 한 의미로 섞지 않는다. API 페이지네이션 토큰은 메모리의 `pageCursor`, 완료된 증분 범위는 DB의 `watermark`로 구분한다. 리소스 전체 페이지가 성공한 뒤에만 watermark를 커밋한다.
- 날짜·기간 계산은 `Clock`과 명시적 사업장 타임존을 사용한다. DB에는 UTC를 저장하고 로컬 머신 타임존에 의존하지 않는다.
- 수량·금액은 JS 부동소수점으로 암묵 변환하지 않는다. DB `numeric`의 파싱/반올림 정책을 경계에서 명시하고, 금액은 통화 코드와 함께 다룬다.
- 로그·오류·dry-run 출력에 토큰, DB URL, 이메일 API 키 또는 전체 외부 응답을 남기지 않는다.
- 가드레일 4의 “웨어하우스 쓰기는 ETL 경로만”은 비즈니스 데이터(`stores/products/sales/inventory`)에 대한 규칙이다. 에이전트의 감사용 실행·발송 로그 쓰기는 허용하되, MCP 조회 도구가 비즈니스 데이터를 변경해서는 안 된다. `sync_now`는 MCP에서 ETL을 호출하는 명시적 예외이며 운영 기본값에서는 비활성이다.
- 문서 간 충돌 시 우선순위는 `SPEC(제품 범위·지표 정의) → DESIGN(구현 계약) → TESTING/TASKS(검증·작업 순서) → README`다. 충돌을 발견하면 구현으로 추측하지 말고 관련 문서를 먼저 함께 보정한다.

## 출시 전 검수 대응 (2026-09-03, `docs/TASKS.md` T28~T37)

- npm publish 준비 전 적대적 검수(`docs/004~009`, 40건 + 문서 정합성 5건)를 실행했고 판정은 **출시 차단**이다. T29~T37을 전부 완료하고 `docs/008` release gate를 통과하기 전에는 `npm publish`를 실행하지 않는다.
- 파일 기반 authoritative 스캔(CSV/Excel 폴더 채널)에서 사라진 SKU/매장은 **자동 tombstone**(비활성 상태, 물리 삭제 금지, 이력 보존) — `docs/SPEC.md` §18, `docs/DESIGN.md` §12.2.
- 지점 폴더 스캔의 저재고 알림은 **하루 최대 1회 다이제스트를 보장**한다 — 파일이 안 바뀌어도 완전 무음은 아니다(SCM 실패 등 "조용한 실패"를 놓치지 않기 위해). `docs/SPEC.md` §18, `docs/DESIGN.md` §12.3.
- npm 공개 배포 대상은 `@trapa-eureka/retail-mcp`(scoped, `publishConfig.access=public`, MIT) — unscoped `retail-mcp`는 이름 재사용 불확실성(2026-01-12 unpublish 이력)이 있어 채택하지 않는다.
