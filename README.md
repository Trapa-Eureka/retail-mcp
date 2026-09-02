# retail-mcp

리테일 다지점 매장을 위한 **셀스루·재고 BI MCP 서버 + 재주문 제안 에이전트**.

- POS(v0.1은 Loyverse) 판매·재고 데이터를 웨어하우스(Postgres)에 적재하고,
- **MCP 도구**로 셀스루·재고 커버리지·품절 위험·재주문 제안을 자연어로 조회하게 하며 (호출당하는 쪽),
- **에이전트**가 주기적으로 품절 위험을 계산해 재주문 제안 메일을 자동 발송한다 (스스로 도는 쪽).

역할 구분 원칙: **조회 = MCP, 예측·발송 = 에이전트.** 에이전트는 MCP와 같은 코어 함수를 소비하는 얇은 스케줄러이며, 숫자 계산은 전부 결정론 코드가 하고 LLM은 요약 문구 작성만 맡는다.

> ⚠️ **데이터소스 전환 결정(2026-09-03)**: 아래 문서·코드는 v0.1(Loyverse POS 연동)을 그대로 설명한다 — 코드는 완성돼 있지만 확정된 파일럿이 없어 실배포는 보류 중이다. 다음 실제 출시는 **CSV/Excel 업로드 기반 데이터소스**를 우선 개발하는 쪽으로 결정했고(Loyverse는 파일럿이 API형 POS 사용을 확인해줄 때 버전업으로 추가), 조회 채널(Claude Code)도 오너가 아니라 개발자/운영자용으로 재정의했다 — 오너 접점은 에이전트의 이메일 리포트뿐이다. 상세는 `docs/SPEC.md` §7·§11 참고.

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
- **권한 분리**: 조회 도구(sell_through 등 5종)는 읽기 전용 DB 역할로 돌리고, `sync_now`는 기본 비활성(`SYNC_TOOL_ENABLED=false`)으로 둔다 — 활성화할 땐 별도 쓰기 자격 증명/프로세스로 라우팅한다(DESIGN §11.4).
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

## 상태

- 2026-09-02: T0~T11(v0.1 전체) 완료. `npm run dev`/`agent:reorder`/`smoke`/`migrate` 모두 실구현이다.

## 구현 전 확인사항

- v0.1은 **단일 사업자(tenant) 배포**를 전제로 한다. 여러 사업자의 데이터를 한 DB에 섞는 멀티테넌시는 비목표다.
- 운영 시각의 기준은 UTC 저장(`timestamptz`)이며, 조회 기간 경계와 이메일 표시는 설정된 사업장 타임존(기본 `Asia/Manila`)으로 계산한다.
- `sync_now`는 데이터를 쓰는 운영 도구이므로 일반 조회 도구와 권한이 다르다. 운영 배포에서는 조회 전용 MCP와 동기화 실행 주체를 분리하거나 명시적 쓰기 자격 증명을 사용한다.
- 근사 셀스루와 재주문 제안은 의사결정 보조 정보다. 실제 발주 전 미입고 주문·팩 단위·공급자 리드타임을 사람이 확인한다.
