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

## 개발 방식

sheet_mcp와 동일: **문서 → 에이전트 구현 → 검증** (`docs/WORKFLOW.md`). 사람(Jin)은 스펙·설계·리뷰·실발송/프로덕션 DB 승인을 맡고, 구현은 Claude Code 에이전트가 `docs/TASKS.md` 단위로 수행한다. 공통 게이트는 `npm run check`.

## 퀵스타트

```bash
npm install
cp .env.example .env  # 값 채우기 — 아래 "운영 배포 절차" 참고
npm run check          # typecheck + lint + test — 공통 게이트
npm run migrate         # (최초 1회, 사람 실행) DATABASE_URL에 스키마 적용
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

## 상태

- 2026-09-02: T0~T11(v0.1 전체) 완료. `npm run dev`/`agent:reorder`/`smoke`/`migrate` 모두 실구현이다.
- 2026-09-03: T12~T22(v0.2 CSV/Excel 채널 전체) 완료. `npm run onboard`/`agent:folder-scan` 실구현, 지점·본사 e2e 시나리오 통과(`tests/e2eCsvChannel.test.ts`).

## 구현 전 확인사항

- v0.1은 **단일 사업자(tenant) 배포**를 전제로 한다. 여러 사업자의 데이터를 한 DB에 섞는 멀티테넌시는 비목표다.
- 운영 시각의 기준은 UTC 저장(`timestamptz`)이며, 조회 기간 경계와 이메일 표시는 설정된 사업장 타임존(기본 `Asia/Manila`)으로 계산한다.
- `sync_now`는 데이터를 쓰는 운영 도구이므로 일반 조회 도구와 권한이 다르다. 운영 배포에서는 조회 전용 MCP와 동기화 실행 주체를 분리하거나 명시적 쓰기 자격 증명을 사용한다.
- 근사 셀스루와 재주문 제안은 의사결정 보조 정보다. 실제 발주 전 미입고 주문·팩 단위·공급자 리드타임을 사람이 확인한다.
