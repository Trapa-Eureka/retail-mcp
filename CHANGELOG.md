# Changelog

이 프로젝트는 [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/) 형식을 따릅니다.

아직 `npm publish`가 나가지 않았습니다(`docs/TASKS.md` T28~T37, README 상단 "npm publish 출시 차단" 배너 참고) — 그래서 지금까지의 모든 변경은 `[Unreleased]`에 있습니다. **첫 게시 버전은 `0.1.0`으로 확정**(사용자 결정, 2026-09-04, T37 — `package.json.version`과 일치). 실제 게시 시점에 `v0.1.0` 태그를 달고 이 섹션을 `## [0.1.0] - <게시일>` 아래로 옮깁니다(게시 전에는 옮기지 않는다 — Keep a Changelog의 "릴리스된 것만 버전 헤더" 원칙). 각 항목의 구현/테스트 근거는 `docs/TASKS.md`의 해당 태스크(Txx) 절, finding별 해결 근거는 `docs/010_FINDING_TEST_CROSSREF.md`를 참고하세요.

## [Unreleased]

### Added

- MCP 조회 도구 5종(`sell_through`/`inventory_status`/`stockout_risk`/`reorder_suggestions`/`sync_status`) + 조건부 `sync_now`/`explore_sql`(운영 기본값 비활성).
- 재주문 제안 에이전트(`agent/reorder.ts`, Loyverse 경로) — dry-run 기본, `SEND_MODE=live && --confirm` 이중 게이트.
- CSV/Excel 폴더 감시 채널(v0.2, 다음 실제 출시 대상) — 지점 모드(저재고 알림 + 일일 다이제스트 보장)와 본사 모드(다지점 통합 조회), 대화형 온보딩 CLI(`npm run onboard`).
- SCM 입고 실적 대사(재고 정합성 검증, CSV 폴백), 팩 단위(포장수량) 반올림.
- 임베디드 PGlite를 웨어하우스 기본값으로 채택 — `DATABASE_URL` 없이도 동작(Neon 등 계정 생성 불필요).
- `explore_sql`(임의 read-only SQL 조회 도구) — 함수 블록리스트 + `BEGIN READ ONLY` 이중 방어, 운영 기본값 비활성.
- CI(`.github/workflows/ci.yml`) — OS/Node 지원 matrix, coverage threshold, 실 Postgres 컴포넌트 테스트, dependency audit/secret scan/SBOM.

### Changed

- 웨어하우스 보존 정책(`agent_send_log`/`inventory_snapshots`)을 `npm run cleanup`(dry-run 기본, `--confirm` 이중 게이트)으로 정리.
- `explore_sql`/`sync_now`의 권한·격리 정책을 전용 DB role 요구로 강화.

### Fixed

npm publish 준비를 위한 적대적 검수(`docs/004`~`008`, finding 33건)에서 발견된 문제를 해결했습니다 — 전체 목록과 finding별 해결 커밋/테스트 대조는 `docs/010_FINDING_TEST_CROSSREF.md` 참고:

- **패키징**: `private` 제거, `bin`/`main` 등록, allowlist 기반 tarball(97개→63개 파일), 라이선스/메타데이터, 게시 tarball fresh-install 검증.
- **보안**: `explore_sql` READ ONLY 우회(advisory lock류/`set_config`) 차단, CSV/XLSX 크기·행·셀 상한, CSV formula injection escape, `.env` 0600 원자 쓰기, 의존성 취약점 승인 예외 관리.
- **데이터 정확성**: snapshot export/import 팩 단위 왕복 보존, 사라진 SKU/매장 tombstone(물리 삭제 없음), 동일 파일 반복 실행 시 재발송 방지 + 하루 최소 1회 다이제스트 보장, 쓰기 도중 프로세스 종료에도 안전한 atomic snapshot write, nullable 필드의 미기재/명시적 삭제/값 3상태 정확한 구분, SCM 기초재고·기간 불일치 시 확정 경고 억제.
- **운영 신뢰성**: `db.close()` 실패 시에도 파일 락 해제 보장, PID 재사용/다른 호스트 락 오판 방지, 동일 mtime 파일 선택의 결정론화, 이메일 발송 timeout의 `unknown` 상태 분리 + idempotency key, 구조화 JSON 로그.
- **테스트/릴리스 게이트**: coverage threshold를 core 밖 위험 모듈(explore_sql/warehouseFactory/provider/CLI)까지 확장, CI에서 실 Postgres 서비스 컴포넌트 테스트, 지원 OS/Node matrix에서 clean tarball install 검증, dependency audit(fail-open/fail-closed 정책)·시크릿 스캔·SBOM 자동화.

### Security

- `explore_sql` 함수 블록리스트(advisory lock류/`set_config`/백엔드 제어/파일·원격 접근) — `BEGIN READ ONLY` 트랜잭션 혼자로는 못 막는 세션 부수효과 우회를 닫음.
- CSV/XLSX 대형·압축폭탄 파일에 크기·행·셀 길이 상한, formula injection escape.
- `.env`를 0600 권한으로 원자적으로 씀 — 시크릿을 커밋하거나 다른 사용자에게 노출하지 않음.
- 게시 tarball 대상 `npm audit`(release gate) + lockfile 기준 `npm audit`(CI 매 PR, fail-open/fail-closed 정책 명시) + 커밋된 시크릿 패턴 스캔 + SBOM(CycloneDX) 생성.
