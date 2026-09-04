# retail-mcp

여러 매장을 운영하는 소매점을 위한 **재고 알림 도구**입니다. 매장에서 내보낸 재고 파일(CSV/Excel)을 폴더에 넣어 두면, 어떤 상품이 곧 떨어질지 계산해서 **이메일로 알려 줍니다.** 개발자는 같은 데이터를 Claude Code 같은 MCP 클라이언트에서 자연어로 조회할 수도 있습니다.

- 숫자 계산(셀스루, 재고 커버 일수, 재주문 수량)은 전부 결정론적인 코드가 합니다. LLM은 요약 문장만 씁니다.
- 데이터는 기본적으로 내 컴퓨터 안(임베디드 DB)에만 저장됩니다. 계정을 만들 필요가 없습니다.
- 실제 이메일은 사람이 명시적으로 켜기 전까지 절대 나가지 않습니다(기본은 미리보기).

> 🚫 **npm에 아직 게시되지 않았습니다(2026-09-04 기준)**: 출시 전 검수(1차 40건 + 2차 19건)와 release gate를 모두 통과했고, 게시 설정(npm 토큰, GitHub 승인 환경)도 끝났습니다. 남은 것은 게시 승인뿐입니다 — `docs/TASKS.md` T37 참고. 이 배너는 실제 게시 직후 제거합니다. 게시 전에 써 보려면 아래 "개발자용 → 저장소에서 실행"을 따르세요.

---

## 일반 사용자 — 5분 시작

지점 한 곳의 재고 파일을 감시해 저재고 알림 이메일을 받는 가장 단순한 경로입니다. 프로그래밍 지식은 필요 없고, 터미널(macOS의 "터미널" 앱 등)에 아래 명령을 그대로 입력하면 됩니다.

### 준비물

- **Node.js 20 이상** — https://nodejs.org 에서 LTS 버전 설치. 설치 확인: 터미널에 `node -v`.
- **macOS 또는 Linux**. Windows는 아직 검증하지 않았습니다(동작할 수는 있으나 지원 대상 아님).
- 매장 재고를 담은 **CSV 또는 Excel 파일**(형식은 3단계에서 예시 파일을 줍니다).
- (이메일을 실제로 받고 싶을 때만) **Resend 계정** — https://resend.com, 무료 플랜으로 충분합니다. 5단계에서 설명합니다.

### 1. 설치

```bash
npm install -g @shiz_son/retail-mcp
```

설치되는 명령은 다섯 개입니다. 이 절에서는 앞의 두 개만 씁니다.

| 명령 | 하는 일 |
|---|---|
| `retail-mcp-onboard` | 질문에 답하면 설정 파일(`.env`)과 예시 재고 파일을 만들어 줍니다 |
| `retail-mcp-scan` | 재고 파일을 읽어 저재고를 판정하고, 설정에 따라 이메일을 보냅니다 |
| `retail-mcp` | MCP 서버(개발자용 — 아래 "Claude Code에서 조회") |
| `retail-mcp-reorder` | Loyverse POS 연동 재주문 제안(현재 보류 중인 경로 — 개발자용 절 참고) |
| `retail-mcp-migrate` | 외부 Postgres를 쓸 때만 필요한 DB 준비 명령(개발자용 절 참고) |

### 2. 설정(온보딩)

**이 도구의 데이터와 설정은 "명령을 실행한 폴더" 기준으로 만들어집니다.** 그래서 먼저 전용 폴더를 하나 만들고 그 안에서 실행합니다. 이후 모든 명령(자동 실행 포함)도 같은 폴더에서 실행해야 같은 데이터를 봅니다.

```bash
mkdir -p ~/retail-mcp && cd ~/retail-mcp
retail-mcp-onboard
```

질문은 이 순서로 나옵니다.

1. **모드** — `branch` 입력(지점 한 곳). 여러 지점을 합쳐 보는 `consolidated`는 아래 "여러 지점 통합" 참고.
2. **DB 연결 문자열** — 그냥 Enter(비움). 그러면 내 컴퓨터 안의 임베디드 DB를 씁니다.
3. **감시할 폴더** — 재고 파일을 넣어 둘 폴더. 예: `~/retail-mcp/watch`. 없으면 만들어 줍니다.
4. **스냅샷 폴더** — 도구가 결과 파일을 쓸 폴더. 감시 폴더와 **다른** 폴더여야 합니다. 예: `~/retail-mcp/snapshot`.
5. **기본 저재고 임계치** — 판매 이력이 없는 상품은 재고가 이 수량 이하면 알림 대상. 모르면 Enter(기본 5).
6. **알림 받을 이메일** — 본인 주소.
7. **Resend API 키(선택)** — 지금은 Enter로 건너뛰어도 됩니다(미리보기만 됨). 5단계에서 채웁니다.

끝나면 현재 폴더에 `.env`(설정, 본인만 읽을 수 있는 권한)와 감시 폴더에 `template-example.csv`(예시 재고 파일)가 생깁니다.

### 3. 재고 파일 채우기

감시 폴더의 `template-example.csv`를 열어 보면 컬럼이 이렇습니다.

| 컬럼 | 필수 | 뜻 |
|---|---|---|
| 매장명 | 필수 | 예: `본점` |
| 상품명 | 필수 | 사람이 읽는 이름 |
| SKU | 필수 | 상품 고유 코드(같은 상품은 항상 같은 값) |
| 재고수량 | 필수 | 현재 재고 |
| 판매수량 · 판매기간시작일 · 판매기간종료일 | 선택 | 셋을 같이 주면 "하루 평균 판매량"을 계산해 **며칠 버티는지**로 판정합니다 |
| 저재고임계치 | 선택 | 상품별 임계치(없으면 2단계의 기본값) |

이 형식대로 실제 재고를 채우거나(Excel에서 열어 편집 후 CSV/XLSX로 저장), POS나 ERP에서 내보낸 파일을 같은 컬럼명으로 맞춰 감시 폴더에 넣습니다. 폴더에 파일이 여러 개면 **가장 최근에 수정된 파일**을 읽습니다.

### 4. 미리보기 실행

```bash
cd ~/retail-mcp
retail-mcp-scan
```

파일을 읽어 저재고 상품 목록과 이유(예: "재고커버 2.5일, 제안수량 40")를 화면에 보여 줍니다. **이 단계에서는 이메일이 나가지 않습니다**(기본 `SEND_MODE=dry_run`). 파일 형식이 틀리면 어느 컬럼이 문제인지 알려 주니 고친 뒤 다시 실행하세요.

### 5. 이메일 발송 켜기

이메일은 Resend라는 발송 서비스를 통해 나갑니다. 순서:

1. https://resend.com 가입 → **API Keys**에서 키 발급(`re_`로 시작). 이 키는 비밀번호처럼 다루세요.
2. **발신 주소** 결정. Resend는 본인이 소유한 도메인을 인증(DNS 레코드 추가)해야 그 도메인 주소로 아무에게나 보낼 수 있습니다. 도메인이 없으면 Resend가 제공하는 테스트 발신 주소로 **가입한 본인 이메일에게만** 보낼 수 있습니다(Resend 문서의 "Send test emails" 참고). 지점 한 곳에서 본인이 받는 용도면 이것으로 충분합니다.
3. 설정에 넣기 — 둘 중 하나:
   - `retail-mcp-onboard`를 다시 실행해 7번 질문에 키를 입력하고, 이어서 발신 주소를 입력한다(기존 설정은 보존됨). 또는
   - `.env`를 텍스트 편집기로 열어 `RESEND_API_KEY=` 와 `MAIL_FROM=` 줄에 값을 채운다.
4. `.env`의 `SEND_MODE=dry_run`을 **`SEND_MODE=live`** 로 바꿉니다.
5. **처음 한 번은 직접** 실행해 메일이 실제로 도착하는지 확인합니다:

```bash
retail-mcp-scan --confirm
```

`--confirm`이 없으면 `SEND_MODE=live`여도 발송하지 않습니다(실수 방지 이중 잠금). 메일이 도착했으면 6단계로.

### 6. 매일 자동 실행

macOS/Linux의 cron에 한 줄 등록합니다(`crontab -e`로 편집기가 열립니다). 매일 아침 7시에 실행하는 예:

```bash
0 7 * * * cd ~/retail-mcp && retail-mcp-scan --confirm >> ~/retail-mcp/scan.log 2>&1
```

- `cd ~/retail-mcp`가 중요합니다 — 2단계에서 설정한 폴더에서 실행해야 같은 설정과 데이터를 씁니다.
- 파일이 바뀌지 않았으면 같은 알림을 또 보내지 않습니다. 단, 파일이 그대로여도 **하루에 한 번**은 알림을 보장해 "조용히 멈춘" 상태를 알 수 있게 합니다.
- 더 자주 돌려도(예: 매시간) 위 규칙 때문에 메일이 늘어나지 않습니다.
- 실행이 끝나면 종료 코드 `0`, 처리되지 않은 오류로 멈추면 `1`을 돌려줍니다. 로그 파일(`scan.log`)에는 사람이 읽는 줄과 함께 JSON 한 줄(`{"event":"folder_scan_completed", ...}`)이 남아 다른 도구가 읽을 수 있습니다.

### 데이터와 설정은 어디에 있나

- 설정: 실행 폴더의 `.env`(권한 0600, 본인만 읽기). 이메일 API 키가 들어 있으니 다른 사람과 공유하거나 커밋하지 마세요.
- 데이터: 실행 폴더의 `.retail-mcp/data/`(임베디드 DB). **백업**은 도구를 실행하지 않는 동안 이 폴더를 통째로 복사하면 됩니다. 복구는 반대로 복사.
- 스냅샷: 2단계에서 정한 스냅샷 폴더에 스캔마다 최신 재고 스냅샷 CSV가 갱신됩니다(여러 지점 통합에 씁니다).
- 삭제된 상품: 재고 파일에서 사라진 상품·매장은 DB에서 지우지 않고 "비활성"으로만 표시합니다. 다시 파일에 나타나면 자동으로 되살아납니다.

### 문제가 생겼을 때

- **"이미 사용 중입니다 … .lock"** — 같은 폴더에서 도구가 두 개 동시에 돌고 있습니다. 하나가 끝나길 기다리세요. 프로세스가 분명히 죽었는데도 계속 뜨면, 어느 컴퓨터에서도 retail-mcp가 실행 중이지 않음을 확인한 뒤 메시지에 나온 `.lock` 파일을 **삭제만** 하세요(내용 편집·교체 금지).
- **"재고 파일이 없습니다"** — 감시 폴더에 `.csv`/`.xlsx` 파일이 있는지, 폴더 경로가 `.env`의 `CSV_WATCH_DIR`과 같은지 확인하세요.
- **메일이 "발송됐는지 알 수 없음(unknown)"으로 끝남** — 네트워크가 응답 도중 끊긴 경우입니다. Resend 대시보드에서 실제로 나갔는지 확인한 뒤, 안 나갔으면 로그의 `run_id` 값을 그대로 붙여 다시 실행하세요: `retail-mcp-scan --confirm --run-id=<그 값>`. 같은 run_id는 Resend가 중복 발송을 막아 주지만 **23시간 안**에서만 유효합니다. 그 뒤에는 도구가 거부하고 새로 실행하라고 안내합니다.
- **업그레이드**: `npm install -g @shiz_son/retail-mcp@latest`. 데이터는 그대로 유지됩니다.
- **제거**: `npm uninstall -g @shiz_son/retail-mcp`. 설정(`.env`)과 데이터(`.retail-mcp/`)는 남으니 필요 없으면 폴더를 직접 지우세요.

### (선택) 여러 지점 통합 — 본사 모드

각 지점이 위 절차대로 돌면 스냅샷 폴더에 표준 형식의 재고 스냅샷이 생깁니다. 그 파일들을 한 폴더에 모으면(공유 드라이브 동기화, 이메일 첨부 저장 등 이미 쓰는 방법 아무거나) 본사에서 통합 조회할 수 있습니다.

```bash
mkdir -p ~/retail-mcp-hq && cd ~/retail-mcp-hq
retail-mcp-onboard        # 모드에 consolidated, 수집 폴더 경로 입력
retail-mcp-scan           # 수집 폴더의 지점 스냅샷을 지점별로 적재(한 지점 파일 오류가 다른 지점에 영향 없음)
```

본사 모드는 알림 메일을 보내지 않고 데이터만 모읍니다. 조회는 아래 "Claude Code에서 조회"로 합니다.

### (선택) 입고 실적과 대사

발주·입고를 구글시트 등으로 관리한다면 그 시트를 CSV로 내려받아 `.env`의 `SCM_RECEIPTS_DIR` 폴더에 두세요. 다음 스캔이 "입고 원장 기준 예상 재고"와 실제 재고를 비교해 차이가 있으면 같은 알림 메일에 포함합니다. 상세 형식은 `docs/SPEC.md` §16.

---

## Claude Code에서 자연어로 조회 (MCP)

설치한 `retail-mcp` 명령이 MCP 서버입니다. 설정 폴더에서 Claude Code에 연결하면 "본점에서 이번 주 품절 위험 상품은?" 같은 질문에 `sell_through`, `inventory_status`, `stockout_risk`, `reorder_suggestions`, `sync_status` 다섯 도구로 답합니다.

```bash
cd ~/retail-mcp
claude mcp add retail-mcp --scope project -- retail-mcp
```

조회 도구는 읽기 전용입니다. 데이터를 쓰는 `sync_now`와 임의 SQL을 실행하는 `explore_sql`은 기본 비활성이며, 켜는 조건과 위험은 아래 "운영 상세"와 `docs/DESIGN.md` §12.4에 있습니다.

---

## 개발자용

### 저장소에서 실행

```bash
git clone https://github.com/Trapa-Eureka/retail-mcp.git && cd retail-mcp
npm install
cp .env.example .env       # 값 채우기
npm run check              # typecheck + lint + format + test — 모든 변경의 필수 게이트
npm run onboard            # = retail-mcp-onboard
npm run agent:folder-scan  # = retail-mcp-scan (기본 dry_run; 실발송은 SEND_MODE=live + --confirm)
npm run dev                # = retail-mcp (MCP 서버 stdio)
npm run agent:reorder      # = retail-mcp-reorder (Loyverse 경로)
npm run migrate            # 외부 DATABASE_URL에 스키마 적용(사람만 실행)
npm run cleanup            # 보존 기간 지난 로그/스냅샷 정리(기본 dry-run, --confirm으로 실행)
npm run smoke              # 실 Loyverse + 실 DB 수동 스모크(사람 전용)
npm run verify:pack        # 게시 tarball fresh-install + bin 5종 실행 + audit (release gate)
```

`claude mcp add retail-mcp --scope project -- npx tsx src/server.ts`로 저장소 버전을 직접 연결할 수 있습니다(`.mcp.json` 커밋됨).

### 문서 맵

| 문서 | 내용 | 읽는 시점 |
|---|---|---|
| `CLAUDE.md` | 에이전트 스티어링 — 스택, 명령어, 규칙, 가드레일 | 모든 에이전트 세션 시작 시(자동 로드) |
| `docs/SPEC.md` | 제품 스펙 — 배경, 지표 정의, 목표/비목표, 로드맵, npm 배포 정책(§18) | 기능 논의·범위 판단 전 |
| `docs/DESIGN.md` | 기술 설계 — 스키마, 지표 수식(§3이 진실의 원천), ETL, MCP 도구, 에이전트, 운영 신뢰성(§12) | 구현 전 필독 |
| `docs/TESTING.md` | 테스트 전략 — PGlite 결정론, 골든 케이스, release gate(§8) | 테스트 작성 전 |
| `docs/TASKS.md` | 태스크 백로그 — 실행 단위, 완료 기준, 출시 전 검수 대응(T28~T37) | 작업 배정 시 |
| `docs/WORKFLOW.md` | AI-native 개발 규칙 | 최초 1회 + 운영 중 참조 |
| `docs/004~010` | 출시 전 적대적 검수 결과와 finding별 해결·테스트 대조 | 보안·품질 근거 확인 시 |
| `SECURITY.md` | 취약점 비공개 신고 절차, 알려진 설계 경계, CI/게시 보안 게이트 | 취약점 발견 시 |
| `CHANGELOG.md` | 릴리스별 변경 이력 | 버전 업그레이드 전 |

### 설계 원칙

- **조회 = MCP, 예측·발송 = 에이전트.** 에이전트는 MCP와 같은 코어 함수를 소비하는 얇은 스케줄러다.
- 모든 외부 IO(POS, DB, 발송, 시계, LLM)는 인터페이스 뒤에 있고 `src/core/`는 순수 계산만 한다. 테스트는 네트워크 0건(PGlite 인프로세스, 픽스처, 목).
- 실발송은 `SEND_MODE=live` **그리고** `--confirm` 둘 다 있어야 한다. 웨어하우스 쓰기는 ETL 경로만, MCP 도구는 읽기 전용.
- 개발 방식은 문서 → 에이전트 구현 → 검증(`docs/WORKFLOW.md`). 사람(Jin)은 스펙·설계·리뷰·실발송/프로덕션 DB 승인을 맡는다.

### 외부 Postgres(Neon/Supabase 등) 사용

기본은 임베디드 PGlite지만, 여러 지점을 한 DB로 모으거나 관리형 백업을 쓰려면 온보딩 2번 질문(또는 `.env`의 `DATABASE_URL`)에 연결 문자열을 넣습니다. 이때 스키마는 사람이 직접 적용합니다:

```bash
retail-mcp-migrate            # dry-run(기본): 대상 host/db명과 대기 중인 마이그레이션만 표시(자격증명은 안 보임)
retail-mcp-migrate --confirm  # 실제 적용
```

스키마가 없거나 일부만 적용된 채로 다른 명령을 실행하면 raw Postgres 에러 대신 이 명령을 안내하는 에러로 즉시 멈춥니다. 조회 도구는 읽기 전용 DB role로 돌리고, `sync_now`/`explore_sql`을 켤 때는 위험 함수 실행 권한이 없는 전용 role을 쓰세요(`docs/DESIGN.md` §11.4·§12.4).

### Loyverse POS 경로 (v0.1 — 구현 완료, 파일럿 확정 전까지 실배포 보류)

POS API에서 판매·재고를 동기화해 재주문 제안 메일을 보내는 경로입니다. `.env`에 `LOYVERSE_API_TOKEN`, `BUSINESS_TIMEZONE`, `RESEND_API_KEY`/`MAIL_FROM`/`REPORT_RECIPIENT`, (요약 문장용) `ANTHROPIC_API_KEY`가 필요합니다. CSV 경로는 Anthropic 키가 필요 없습니다.

1. `.env` 채우기 → (외부 DB면) `retail-mcp-migrate --confirm` → `npm run smoke`(항상 dry-run)로 sync·조회·에이전트가 붙는지 확인.
2. 최초 실발송은 `SEND_MODE=live`로 바꾼 뒤 `retail-mcp-reorder --sync --confirm`(저장소: `npm run agent:reorder -- --sync --confirm`)을 **사람이 직접** 1회 실행해 도착을 확인한 뒤에만 스케줄러에 등록합니다.
3. 발송 전 확인: `BUSINESS_TIMEZONE`이 실제 매장 타임존인지(모든 기간 계산 기준, DB 저장은 UTC), `sync_status`의 `data_last_synced_at`이 최근인지(기본 stale 임계 24시간, `STALE_THRESHOLD_HOURS`).

```bash
# crontab -e — 매주 월요일 07:00 동기화 + 재주문 제안
0 7 * * 1 cd ~/retail-mcp && retail-mcp-reorder --sync --confirm >> ~/retail-mcp/reorder.log 2>&1
```

macOS `launchd`를 쓰면 `~/Library/LaunchAgents/com.retail-mcp.reorder.plist`의 `ProgramArguments`에 같은 명령을 넣고 `launchctl load`로 등록합니다.

---

## 운영 상세

**지원 환경**: Node.js 20 이상. CI가 `ubuntu-latest`·`macos-latest` × Node 20·22에서 typecheck/lint/format/test와 게시 tarball fresh-install(`verify:pack`)까지 매 PR 검증합니다. **Windows는 검증하지 않았습니다** — 파일 락의 PID 재사용 완화가 쓰는 `ps -o lstart=`가 POSIX 전용이라 Windows에서는 그 보조 신호 없이 PID-only 판정으로 폴백합니다(에러는 아님).

**파일 락 복구**: 같은 임베디드 데이터 디렉터리를 다른 프로세스가 열고 있으면 `FileLockBusyError`로 시작을 거부합니다(원인 PID와 조치가 메시지에 포함). 그 프로세스가 죽었으면 다음 시작이 stale lock을 자동 회수합니다. 사람이 개입해야 하는 경우는 두 가지 — **다른 호스트가 만든 락**(네트워크 공유 디렉터리 등, 이 머신에서 생사 확인 불가)과 **소유 호스트 정보가 없는 락**(다른 도구가 만든 파일 등). 둘 다 자동 회수하지 않으며, 어느 호스트에도 실행 중인 retail-mcp가 없음을 확인한 뒤 `{데이터 디렉터리}.lock`을 **삭제만** 합니다(편집·교체 금지). 살아 있는 프로세스의 락을 지우면 그 프로세스가 종료하며 새 소유자의 락을 지울 수 있는 짧은 창이 있습니다 — POSIX에 "내용이 일치할 때만 삭제"가 없어 코드로 완전히 막을 수 없는 잔여 위험이며(`docs/DESIGN.md` §12.8), 규약을 지키면 성립하지 않습니다.

**이메일 발송 재시도**: Resend 요청이 HTTP 응답을 받기 전에 실패하면(타임아웃, 연결 후 소켓 끊김 등) "발송됐는지 알 수 없음"으로 `agent_send_log.status='unknown'`에 남기고 자동 재시도하지 않습니다. DNS 실패·연결 거부처럼 서버에 닿지 않은 게 확실한 경우만 `failed`입니다. 사람이 Resend 대시보드로 확인한 뒤 같은 `run_id`로 재실행하면 Resend `Idempotency-Key`가 중복 발송을 막습니다 — 단 **첫 시도로부터 23시간(24시간 − 안전 여유 1시간) 안에서만** 허용되고, 그 뒤에는 `SendRetryRefusedError`로 거부하며 새 run_id로 실행하라고 안내합니다. 23시간 안의 재시도에서 이전 실행이 `sending`으로 멈춰 있었다면 그 행을 `unknown(stale_sending)`으로 마감하고 진행합니다. `failed` 뒤의 재시도는 시간 제한이 없습니다. `--run-id`를 생략하면 매번 새 run_id입니다.

**보존 정책**: `agent_send_log`(실행 1회당 1행)와 `inventory_snapshots`(Loyverse 동기화마다 전체 재고)는 계속 늘어납니다. `npm run cleanup`(사람 전용, `CLEANUP_RETENTION_DAYS` 기본 90일)이 오래된 행을 지웁니다 — 기본 dry-run, 실제 삭제는 `--confirm`.

**백업/복구**: 임베디드 PGlite는 `RETAIL_MCP_DATA_DIR`(기본 `.retail-mcp/data/`) 아래 일반 파일입니다. 프로세스를 멈춘 뒤 디렉터리를 통째로 복사하면 백업, 새 위치에 복원해 같은 환경변수로 가리키면 복구입니다. 외부 DB는 그 서비스의 관리형 백업을 씁니다.

**구조화 로그·종료 코드**: `retail-mcp-scan`/`retail-mcp-reorder`는 사람이 읽는 완료 줄과 별개로 실행마다 JSON 한 줄(`{event, runId, status, ...}`)을 stdout에 남깁니다. 끝까지 완료되면 `0`, 처리되지 않은 예외로 중단되면 `1`. MCP 서버는 stdout이 프로토콜 전용이라 이 로그를 쓰지 않습니다.

**권한 분리**: 조회 도구 5종은 읽기 전용, `sync_now`(`SYNC_TOOL_ENABLED`)와 `explore_sql`(`EXPLORE_SQL_ENABLED`)은 기본 비활성. `explore_sql`은 함수 블록리스트 + `BEGIN READ ONLY`로 막지만 advisory lock류 부수효과까지 막으려면 전용 DB role이 필요하고, 임베디드 PGlite에서는 role 분리가 불가능해 `EXPLORE_SQL_ALLOW_PGLITE=true`를 명시해야만 켜집니다.

**보안·공급망**: `SECURITY.md`에 취약점 신고 절차와 CI 게이트(lockfile/tarball audit, 시크릿 스캔, SBOM, SHA 고정 Action, main 브랜치 ruleset, provenance 게시)가 정리돼 있습니다.

## 상태

- 2026-09-02: v0.1(Loyverse 경로) 구현 완료 — 실배포는 파일럿 확정 전까지 보류.
- 2026-09-03: v0.2(CSV/Excel 채널) 구현 완료 — 지점·본사 모드, 온보딩 CLI, SCM 대사, 팩 단위 반올림.
- 2026-09-03~04: npm 출시 전 적대적 검수 2회(59건) 전부 처리, release gate 통과, 게시 워크플로(provenance) 준비. 게시 승인 대기.

## 알아 둘 것

- 단일 사업자(tenant) 배포를 전제로 합니다. 여러 사업자의 데이터를 한 DB에 섞는 멀티테넌시는 비목표입니다.
- 시각은 UTC로 저장하고, 기간 경계와 이메일 표시는 설정한 사업장 타임존(`BUSINESS_TIMEZONE`)으로 계산합니다.
- 셀스루와 재주문 제안은 의사결정 보조 정보입니다. 실제 발주 전 미입고 주문·팩 단위·공급자 리드타임을 사람이 확인하세요.
