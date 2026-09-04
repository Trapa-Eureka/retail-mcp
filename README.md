# retail-mcp

리테일 다지점 매장을 위한 **셀스루·재고 BI MCP 서버 + 재주문 제안 에이전트**.

- POS(v0.1은 Loyverse) 판매·재고 데이터를 웨어하우스(Postgres)에 적재하고,
- **MCP 도구**로 셀스루·재고 커버리지·품절 위험·재주문 제안을 자연어로 조회하게 하며 (호출당하는 쪽),
- **에이전트**가 주기적으로 품절 위험을 계산해 재주문 제안 메일을 자동 발송한다 (스스로 도는 쪽).

역할 구분 원칙: **조회 = MCP, 예측·발송 = 에이전트.** 에이전트는 MCP와 같은 코어 함수를 소비하는 얇은 스케줄러이며, 숫자 계산은 전부 결정론 코드가 하고 LLM은 요약 문구 작성만 맡는다.

> ⚠️ **데이터소스 전환 결정(2026-09-03)**: 아래 "퀵스타트"~"운영 배포 절차"는 v0.1(Loyverse POS 연동)을 설명한다 — 코드는 완성돼 있지만 확정된 파일럿이 없어 실배포는 보류 중이다. 다음 실제 출시는 **CSV/Excel 업로드 기반 데이터소스**를 우선 개발하는 쪽으로 결정했고(Loyverse는 파일럿이 API형 POS 사용을 확인해줄 때 버전업으로 추가), 조회 채널(Claude Code)도 오너가 아니라 개발자/운영자용으로 재정의했다 — 오너 접점은 에이전트의 이메일 리포트뿐이다. **CSV/Excel 채널(v0.2)은 T12~T22로 구현이 끝났다** — 아래 "CSV/Excel 채널 퀵스타트" 참고, 실배포 여부만 파일럿 확인 대기 중인 건 v0.1과 동일하다. 상세는 `docs/SPEC.md` §7·§11·§12 참고.

> 🚫 **npm publish 출시 차단(2026-09-03)**: npm 배포 전 적대적 검수(`docs/004~008`, 40건) 결과 현재 상태로는 `npm publish`가 불가능하고(패키지가 `private`, 공개 진입점 없음) 실행 가능하더라도 데이터·보안 결함이 남아 있다. 해결 진행 상황은 `docs/TASKS.md` T28~T37, 정책 결정은 `docs/SPEC.md` §18 참고 — 이 배너는 T37(최종 재검수) 통과 후 제거한다.

## 자매 프로젝트와의 관계

- **sheet_mcp**: 알림 발송 계층(`NotificationProvider` + Resend 어댑터)을 이 프로젝트로 이식한다. 두 레포에서 안정화되면 공용 패키지로 추출 (v0.4 로드맵).
- **bi_mcp 구상**: retail-mcp는 POS→BI 구상의 리테일 버티컬 첫 수직 절단이다. 검증되면 공통 코어(bi_mcp)로 일반화하고 F&B·물류 버티컬을 얹는다.

## 문서 맵

| 문서 | 내용 | 읽는 시점 |
|---|---|---|
| `CLAUDE.md` | 에이전트 스티어링 — 스택, 명령어, 규칙, 가드레일 | 모든 에이전트 세션 시작 시 (자동 로드) |
| `docs/SPEC.md` | 제품 스펙 — 배경, 지표 정의, 목표/비목표, 로드맵 | 기능 논의·범위 판단 전 |
| `docs/DESIGN.md` | 기술 설계 — 스키마, 지표 수식, ETL, MCP 도구, 에이전트 | 구현 전 필독 |
| `docs/TESTING.md` | 테스트 전략 — PGlite 결정론, 골든 케이스, 엣지 | 테스트 작성 전 |
| `docs/TASKS.md` | 태스크 백로그 — 에이전트 실행 단위, 완료 기준 | 작업 배정 시 |
| `docs/WORKFLOW.md` | AI-native 개발 규칙 (sheet_mcp와 공통 + 이 레포 특이사항) | 최초 1회 + 운영 중 참조 |
| `SECURITY.md` | 보안 취약점 비공개 신고 절차, 지원 버전, 알려진 보안 설계 경계 | 취약점 발견 시 |
| `CHANGELOG.md` | 릴리스별 변경 이력 (Keep a Changelog 형식) | 버전 업그레이드 전 |

## 설치 (npm 게시 후 — 004 REL-006/009 DOC-004, TASKS T36)

> 아직 `npm publish`가 나가지 않았다(위 배너 참고) — 이 절은 게시 이후의 설치 계약을 미리 확정해둔 것이다. 지금 이 저장소로 실행하려면 아래 "퀵스타트"(저장소 clone 기준)를 따른다.

게시되면 패키지명은 scoped `@trapa-eureka/retail-mcp`(MIT, `publishConfig.access=public`)다.

```bash
npm install -g @trapa-eureka/retail-mcp   # 전역 설치 — 또는 프로젝트별로 npm install --save-dev
retail-mcp-onboard                         # 대화형 설정 — .env + 예시 템플릿 CSV 생성(위 "CSV/Excel 채널 퀵스타트"와 같은 대화)
retail-mcp                                 # MCP 서버 stdio 실행 — claude mcp add에 이 명령을 그대로 연결
```

**데이터 위치**: `DATABASE_URL`을 안 정하면 임베디드 PGlite가 기본값이고, 데이터는 **`retail-mcp`를 실행하는 현재 작업 디렉터리 기준** `.retail-mcp/data/`(또는 `RETAIL_MCP_DATA_DIR`로 override)에 생긴다 — 전역 설치라도 이 경로는 실행 시점의 CWD에 종속된다. 서로 다른 디렉터리에서 실행하면 서로 다른(독립된) 로컬 DB가 생긴다는 뜻이다 — 지점별로 폴더를 분리해 쓰는 CSV/Excel 채널에는 의도된 동작이지만, cron/launchd 등록 시 반드시 같은 작업 디렉터리(`cd`)를 고정해야 한다(위 "cron/launchd 등록 예시" 참고).

**마이그레이션**: 임베디드 PGlite는 첫 실행에 자동 적용된다(사람 개입 불필요, `warehouseFactory.ts`). **외부 `DATABASE_URL`(Neon/Supabase 등)을 쓰면 `retail-mcp-migrate` bin으로 직접 적용한다**(SR2-REL-001, 2차 적대적 검수 — `docs/004_NPM_RELEASE_PACKAGING_REVIEW.md` REL-006이 지적한 간극을 해소):

```bash
retail-mcp-migrate            # dry-run(기본) — 대상 DB(host/db명만, 자격증명은 안 보임)와 대기 중인 마이그레이션 목록만 보여준다
retail-mcp-migrate --confirm  # 실제로 적용한다
```

`DATABASE_URL`을 설정한 채로 `retail-mcp`/`retail-mcp-onboard`의 에이전트 명령을 실행했는데 스키마가 없거나 일부만 적용돼 있으면, raw Postgres 에러 대신 위 명령을 안내하는 에러로 즉시 멈춘다. `scripts/migrate.ts`(저장소 전용, `npm run migrate`)는 여전히 존재하지만 이 저장소를 clone한 개발자 전용이다 — 게시된 패키지에는 포함되지 않는다.

**업그레이드**: `npm install -g @trapa-eureka/retail-mcp@latest`로 새 버전을 받는다. 마이그레이션 파일은 순번이 매겨져 있고 이미 적용된 건 건너뛰므로(체크섬까지 같으면) 버전을 올려도 임베디드 PGlite 데이터는 안전하다 — 외부 DB는 새 버전이 마이그레이션을 추가했다면 위와 같이 `retail-mcp-migrate --confirm`을 한 번 실행하면 된다.

**제거**: `npm uninstall -g @trapa-eureka/retail-mcp`는 패키지 코드만 지운다 — 데이터(`.retail-mcp/data/`)와 `.env`는 그대로 남는다(재설치 시 데이터 보존을 위한 의도된 동작). 데이터까지 지우려면 그 디렉터리를 직접 삭제한다.

## 개발 방식

sheet_mcp와 동일: **문서 → 에이전트 구현 → 검증** (`docs/WORKFLOW.md`). 사람(Jin)은 스펙·설계·리뷰·실발송/프로덕션 DB 승인을 맡고, 구현은 Claude Code 에이전트가 `docs/TASKS.md` 단위로 수행한다. 공통 게이트는 `npm run check`.

## 퀵스타트

```bash
npm install
cp .env.example .env  # 값 채우기 — 아래 "운영 배포 절차" 참고
npm run check          # typecheck + lint + test — 공통 게이트
npm run migrate         # (최초 1회, 사람 실행) DATABASE_URL에 스키마 적용
npm run cleanup         # (사람 실행, 기본 dry-run) 보존 기간 지난 로그/스냅샷 정리 — 아래 "운영 신뢰성"
npm run smoke           # (사람 실행) 실 Loyverse+DB로 sync→조회 3종→에이전트 dry-run 확인
npm run dev             # MCP 서버 stdio 실행 (Claude Code: claude mcp add, DESIGN §9)
npm run agent:reorder   # 재주문 에이전트 1회 실행 (기본 SEND_MODE=dry_run)
```

## 운영 배포 절차 (사람이 직접 — 5단계)

1. `.env` 채우기 — `DATABASE_URL`, `LOYVERSE_API_TOKEN`, `BUSINESS_TIMEZONE`, `RESEND_API_KEY`/`MAIL_FROM`/`REPORT_RECIPIENT`, `ANTHROPIC_API_KEY`.
2. `npm run migrate` — 프로덕션 DB에 스키마 적용(사람만 실행, CLAUDE.md 가드레일 5).
3. `npm run smoke` — dry-run으로 sync·조회 도구·에이전트가 실제로 붙는지 확인(항상 dry-run, 발송 없음).
4. `claude mcp add retail-mcp --scope project -- npx tsx src/server.ts` — Claude Code에 연결(`.mcp.json` 커밋됨), `/mcp`로 확인.
5. 최초 실발송은 `.env`의 `SEND_MODE=live`로 바꾼 뒤 `npm run agent:reorder -- --sync --confirm`을 사람이 직접 1회 실행 — 그 이후에만 cron/launchd에 `--sync`만 등록해 자동화한다(아래 예시).

## 최초 live 발송 전 사람 체크리스트

- **타임존**: `.env`의 `BUSINESS_TIMEZONE`이 실제 매장 타임존인지 확인한다 — 판매 창·재주문 계산·이메일 표시가 전부 이 값 기준이다(DB 저장은 항상 UTC).
- **권한 분리**: 조회 도구(sell_through 등 5종)는 읽기 전용 DB 역할로 돌리고, `sync_now`는 기본 비활성(`SYNC_TOOL_ENABLED=false`)으로 둔다 — 활성화할 땐 별도 쓰기 자격 증명/프로세스로 라우팅한다(DESIGN §11.4). `explore_sql`(임의 SELECT 조회, TASKS T27)도 기본 비활성(`EXPLORE_SQL_ENABLED=false`) — 켤 때는 **위험 함수(advisory lock, `set_config` 등) 실행 권한이 없는 전용 DB role을 필수로 권장**한다(`BEGIN READ ONLY`는 테이블/시퀀스 쓰기만 막고 이런 세션 부수효과까지는 못 막는다, TASKS T30). `DATABASE_URL` 없이(임베디드 PGlite) `explore_sql`을 켜려는 시도는 role 분리·timeout 집행이 둘 다 불가능해 기본적으로 거부되며, 위험을 이해했다면 `EXPLORE_SQL_ALLOW_PGLITE=true`로만 켤 수 있다.
- **stale 확인**: `sync_status` 도구나 스모크 출력에서 `data_last_synced_at`이 최근인지, `warnings`에 stale 경고가 없는지 확인한다(기본 임계값 24시간, `STALE_THRESHOLD_HOURS`).
- **최초 발송**: `npm run agent:reorder -- --sync --confirm`을 **사람이 직접** 1회 실행해 실제 수신자에게 정상 도착하는지 확인한 뒤에만 스케줄러에 등록한다(스모크는 이 단계를 포함하지 않는다).

## cron / launchd 등록 예시

매주 월요일 07:00(SPEC §5 대표 시나리오)에 동기화 + 재주문 제안을 실행하는 한 줄 등록 예시(둘 다 `SEND_MODE=live`로 바꾼 뒤 등록 — `--confirm` 없이는 절대 발송하지 않는다):

```bash
# crontab -e
0 7 * * 1 cd /path/to/retail-mcp && npm run agent:reorder -- --sync --confirm >> logs/reorder.log 2>&1
```

macOS `launchd`는 plist가 필요하다 — `~/Library/LaunchAgents/com.retail-mcp.reorder.plist`의 `ProgramArguments`에 아래 한 줄만 바꿔 넣고 `launchctl load ~/Library/LaunchAgents/com.retail-mcp.reorder.plist`로 등록한다:

```bash
npm --prefix /path/to/retail-mcp run agent:reorder -- --sync --confirm
```

## CSV/Excel 채널 퀵스타트 (v0.2, 다음 실제 출시 대상)

Loyverse 없이 CSV/Excel 재고 파일만으로 셀스루/저재고 알림을 쓰는 경로다(`docs/SPEC.md` §12). 비개발자 운영자를 전제로 하며 웨어하우스 기본값은 계정 가입이 필요 없는 **임베디드 PGlite**(`.retail-mcp/data/`)다 — Neon 등 네트워크 Postgres를 쓰려면 온보딩에서 연결 문자열(`DATABASE_URL`)을 입력하면 된다. 지점(단일 매장) 모드와 본사(다지점 통합) 모드가 있다.

### 지점 모드 — 재고 파일 감시 + 저재고 알림

```bash
npm install
npm run onboard            # 모드(branch) 선택 → 감시/스냅샷 폴더·임계치·수신 이메일 입력
                            # → .env 저장 + 감시 폴더에 예시 템플릿 CSV(template-example.csv) 생성
# template-example.csv를 열어 §12 고정 템플릿 컬럼(매장명/상품명/SKU/재고수량 필수,
# 판매수량+기간/저재고임계치 선택)에 맞춰 실제 재고로 채우거나 같은 형식 파일로 교체한다.
npm run agent:folder-scan  # 1회 스캔: 파싱 → 적재 → 저재고 판정(기본 SEND_MODE=dry_run) → 스냅샷 갱신
```

실발송은 다른 스크립트와 동일한 이중 게이트(CLAUDE.md 가드레일 1)다 — `.env`의 `SEND_MODE=live`로 바꾸고 `npm run agent:folder-scan -- --confirm`을 **사람이 직접** 1회 실행해 정상 도착을 확인한 뒤에만 cron에 등록한다:

```bash
# crontab -e — 매일 07:00 스캔(간격은 사업장 사정에 맞게 조정, SPEC §12 "실행 모델")
0 7 * * * cd /path/to/retail-mcp && npm run agent:folder-scan -- --confirm >> logs/folder-scan.log 2>&1
```

재고 파일에서 사라진 SKU/매장은 DB에서 삭제되지 않고 비활성화만 된다(tombstone) — 재주문·저재고 판정에서는 빠지지만 이력은 남고, 다시 파일에 나타나면 자동으로 되살아난다(TASKS T31). cron이 더 자주 돌아도(예: 매시간) 파일 내용이 그대로면 재발송하지 않되, 같은 내용이라도 마지막 발송에서 하루가 지나면 다이제스트 1회는 보장한다.

#### (선택) SCM 입고 실적 — 재고 정합성 검증

발주·입고를 구글시트 등으로 관리한다면, 실 API 연동 없이 **"파일 > 다운로드 > CSV"로 내보낸 파일**을 `.env`의 `SCM_RECEIPTS_DIR` 폴더에 두면 된다(`docs/SPEC.md` §16 — 서비스 계정 설정 같은 진입장벽 없이, 기존 ERP-CSV 폴백과 같은 방식). 다음 스캔이 그 파일을 읽어 `실사 재고 vs 입고 원장 기준 예상재고`를 대사하고, 불일치가 있으면 저재고 알림과 같은 이메일에 포함한다.

### 본사 모드 — 지점 스냅샷 통합 조회

지점 인스턴스는 스캔마다 `CSV_SNAPSHOT_DIR`에 §12 고정 템플릿 그대로의 스냅샷 파일을 갱신한다(사람이 보는 요약이 아니라 다시 읽을 수 있는 산출물). 본사는 그 스냅샷들이 모이는 폴더 — 사내 공유드라이브 동기화, 이메일 첨부 수동 저장, USB 등 이미 쓰는 전송 수단(retail-mcp가 새로 규정하지 않음) — 를 별도 인스턴스로 관찰한다:

```bash
npm run onboard            # 모드(consolidated) 선택 → 수집 폴더(CSV_COLLECT_DIR) 입력
npm run agent:folder-scan  # 수집 폴더의 지점 스냅샷 파일 전부를 지점별로 독립 적재
                            # (한 지점 파싱 실패가 다른 지점에 영향 없음, 본사 모드는 재알림 없음)
npm run dev                # MCP 서버 연결 후 Claude Code에서 "본점만" 등 매장명으로 자연어 조회
```

매장명이 이미 필수 컬럼이라 기존 MCP 조회 도구의 지점 필터링이 스키마 변경 없이 그대로 다지점 통합 조회에 쓰인다.

## 운영 신뢰성 (007 검수 OPS-001~006, TASKS T34/T35)

**지원 환경**: Node.js 20 이상(`engines.node`). CI(`.github/workflows/ci.yml`, TASKS T35)가 `os: [ubuntu-latest, macos-latest] × node: [20, 22]` 매트릭스로 매 push/PR에서 typecheck/lint/format/test + `npm run verify:pack`(clean tarball install)까지 실제로 검증한다. **Windows는 여전히 검증하지 않았고 알려진 제약이 있다** — 파일 락의 PID 재사용 완화(`fileLock.ts`)가 쓰는 `ps -o lstart=`는 POSIX 전용이라 Windows에서는 이 보조 신호 없이 기존 PID-only 판정으로 자동 폴백한다(에러는 아니다).

**PGlite 락 복구**: 같은 임베디드 데이터 디렉터리를 다른 프로세스가 이미 열고 있으면 `FileLockBusyError`로 시작을 거부한다(원인이 된 PID와 조치가 메시지에 포함됨). 그 프로세스가 정말 죽었다면 다음 시작이 자동으로 stale lock을 회수한다 — 사람이 개입해야 하는 경우는 두 가지다 — **다른 호스트가 쓴 락**(네트워크 공유 데이터 디렉터리 등 — 이 머신에서 그 프로세스의 생사를 확인할 방법이 없어 자동 회수하지 않는다)과 **소유 호스트 정보(hostname)가 없는 락**(retail-mcp가 아닌 도구가 만든 파일이나 아주 오래된 형식 — 어느 호스트의 것인지 알 수 없어 마찬가지로 자동 회수하지 않는다, 2차 적대적 검수 SR2-LOCK-002). 두 경우 모두 에러 메시지가 안내하는 대로 `{데이터 디렉터리}.lock` 파일을 수동으로 지운다(다른 호스트를 포함해 그 디렉터리를 쓰는 프로세스가 실제로 없는지 먼저 확인할 것).

**이메일 발송 재시도**: Resend 요청이 HTTP 응답을 받기 전에 실패하면(타임아웃, 연결 후 소켓 끊김 등 — 네트워크 응답 유실) "발송됐는지 알 수 없음"으로 `agent_send_log.status='unknown'`에 남는다(확실한 실패인 `failed`와 구분 — HTTP 오류 응답이나 DNS 실패/연결 거부처럼 요청이 서버에 닿지 않은 게 확실한 경우만 `failed`, 2차 적대적 검수 SR2-MAIL-002) — 자동으로 재시도하지 않는다. 사람이 Resend 대시보드에서 실제 발송 여부를 확인한 뒤, 재시도가 필요하면 실행 완료 로그(`run_id=...`)에 찍힌 **같은 run_id**를 `--run-id=<값>`으로 지정해 다시 실행한다(예: `npm run agent:reorder -- --sync --confirm --run-id=<이전 run_id>`, `npm run agent:folder-scan -- --confirm --run-id=<이전 run_id>`) — Resend에 `Idempotency-Key`로 그 run_id를 그대로 전달하므로 재시도해도 실제로는 중복 발송되지 않는다. `--run-id`를 생략하면 매번 새 run_id가 생성돼 idempotency가 적용되지 않는다(2차 적대적 검수 SR2-MAIL-001 대응 — 이전엔 이 플래그 자체가 없었다).

**같은 run_id 재시도의 시간 제한(2차 적대적 검수 SR2-MAIL-003)**: Resend의 Idempotency-Key 중복 방지는 **24시간**만 유효하다. 그래서 에이전트는 `unknown`(또는 예약만 남은 `sending`) 시도의 첫 시각으로부터 **23시간**(24시간 − 안전 여유 1시간) 안에서만 같은 run_id 재시도를 받아들이고, 그 뒤에는 `SendRetryRefusedError`로 거부한다 — 같은 키라도 Resend가 새 발송으로 취급해 두 번째 메일이 나가기 때문이다. 거부되면 에러가 안내하는 대로 Resend 대시보드에서 그 시각 전후에 수신자에게 메일이 나갔는지 확인하고, 안 나갔으면 `--run-id` **없이**(새 run_id) 다시 실행한다. 이미 나갔으면 재시도할 필요가 없다. 이 확인은 자동화되지 않는다 — 응답을 못 받은 시도는 message_id가 없고 Resend API에 Idempotency-Key로 메일을 조회하는 기능이 없다. 23시간 안의 재시도에서 이전 실행이 결과를 기록하지 못하고 `sending`으로 멈춰 있었다면 그 행은 `unknown`(`error_code=stale_sending`)으로 마감되고 재시도가 진행된다(cron이 새 run_id로 도는 정상 운영에서는 이 마감이 일어나지 않는다). `failed`(요청이 Resend에 닿지 않은 확실한 실패) 뒤의 같은 run_id 재시도는 시간 제한이 없다.

**보존 정책**: `agent_send_log`(실행 1회당 1행)와 `inventory_snapshots`(Loyverse 동기화마다 전체 재고 스냅샷)는 장기 운영 시 무제한으로 늘어난다. `npm run cleanup`(사람 전용, `CLEANUP_RETENTION_DAYS` 기본 90일)이 보존 기간보다 오래된 행을 지운다 — `npm run migrate`와 같은 이중 게이트: 기본은 dry-run(대상 행 수만 출력), 실제로 지우려면 `npm run cleanup -- --confirm`. 자동 실행 스케줄(cron 등)은 이 프로젝트가 대신 등록하지 않는다 — 위 "cron / launchd 등록 예시"와 같은 패턴으로 직접 추가한다.

**백업/복구**: 임베디드 PGlite는 데이터가 `RETAIL_MCP_DATA_DIR`(기본 `.retail-mcp/data/`) 아래 일반 파일이다 — 프로세스를 멈춘 뒤 그 디렉터리를 통째로 복사하면 백업이고, 새 위치에 복원해 같은 환경변수로 가리키면 복구다(진행 중 쓰기와 겹치지 않도록 반드시 프로세스를 멈춘 뒤 복사할 것 — 파일 락이 있어도 파일시스템 레벨 복사 중 충돌까지는 막지 않는다). `DATABASE_URL`(Neon/Supabase 등)을 쓰면 백업/복구는 그 서비스의 관리형 백업 기능을 그대로 쓴다(이 프로젝트가 별도로 구현하지 않는다).

**구조화 로그**: `agent:folder-scan`/`agent:reorder`는 사람이 읽는 완료 로그 줄과 별개로, 실행마다 파싱 가능한 JSON 한 줄(`{event, runId, status, ...}`)을 stdout에 추가로 남긴다(`src/adapters/structuredLog.ts`) — 로그 수집기나 알림 스크립트가 정규식 없이 이 줄만 골라 읽을 수 있다. MCP 서버(`server.ts`)는 stdout이 프로토콜 전용이라 이 로그를 쓰지 않는다.

**종료 코드 계약**: 두 CLI(`agent:folder-scan`, `agent:reorder`)는 실행이 끝까지 완료되면(발견된 이슈·발송 여부와 무관) `0`, 처리되지 않은 예외로 중단되면 `1`을 반환한다 — cron/launchd가 실패를 알림으로 연결할 때 이 계약을 기준으로 삼는다.

## 상태

- 2026-09-02: T0~T11(v0.1 전체) 완료. `npm run dev`/`agent:reorder`/`smoke`/`migrate` 모두 실구현이다.
- 2026-09-03: T12~T22(v0.2 CSV/Excel 채널 전체) 완료. `npm run onboard`/`agent:folder-scan` 실구현, 지점·본사 e2e 시나리오 통과(`tests/e2eCsvChannel.test.ts`).

## 구현 전 확인사항

- v0.1은 **단일 사업자(tenant) 배포**를 전제로 한다. 여러 사업자의 데이터를 한 DB에 섞는 멀티테넌시는 비목표다.
- 운영 시각의 기준은 UTC 저장(`timestamptz`)이며, 조회 기간 경계와 이메일 표시는 설정된 사업장 타임존(기본 `Asia/Manila`)으로 계산한다.
- `sync_now`는 데이터를 쓰는 운영 도구이므로 일반 조회 도구와 권한이 다르다. 운영 배포에서는 조회 전용 MCP와 동기화 실행 주체를 분리하거나 명시적 쓰기 자격 증명을 사용한다.
- 근사 셀스루와 재주문 제안은 의사결정 보조 정보다. 실제 발주 전 미입고 주문·팩 단위·공급자 리드타임을 사람이 확인한다.
