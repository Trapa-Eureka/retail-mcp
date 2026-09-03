# 008 — 테스트·출시 게이트 적대적 검수

- 검수일: 2026-09-03
- 현재 결과: `npm run check` 통과, 33 files/376 tests 통과
- coverage: statements 99.66%, branches 94.66%, functions 100%, lines 100% (`src/core`)
- 판정: **수치상 우수하지만 npm 설치·운영 경계와 공격 시나리오가 게이트 밖에 있음**
- 상태: **RESOLVED(T29 PR #40 — QA-001, T35 PR #47 — QA-002~006, 2026-09-03)** — QA-001~006 전부 해결. 남은 건 T37(008 8단계 release gate 최종 통과 + `prepublishOnly` 연결)뿐이다. 게이트 목록은 `docs/TESTING.md` §8, finding별 테스트 대조는 `docs/010_FINDING_TEST_CROSSREF.md`에 반영됨.

## QA-001 — 테스트는 source tree만 검증하고 실제 tarball을 검증하지 않음

- 심각도: **치명적**
- 근거: 모든 테스트가 저장소의 TS 소스와 devDependency가 설치된 환경에서 실행된다. `npm pack → fresh directory → npm install --omit=dev → bin/MCP 실행` 테스트가 없다.
- 영향: 376개 테스트가 전부 통과해도 게시된 패키지는 실행 불가능하다.
- 수정 기준: tarball 설치 smoke test를 release 필수 게이트로 추가한다.

## QA-002 — `npm run check`에 coverage threshold가 포함되지 않음

- 심각도: **중간**
- 근거: `coverage`는 별도 script다. 현재 coverage는 통과하지만 일반 PR/배포 게이트인 `check`만으로는 하락을 탐지하지 못한다.
- 영향: 이후 변경에서 core coverage가 90% 아래로 내려가도 필수 게이트가 통과할 수 있다.
- 수정 기준: CI/release gate에 `npm run coverage`를 포함한다. 매 로컬 check에 포함할지는 실행시간을 고려해 선택할 수 있다.
- **해결(T35, 2026-09-03)**: CI `coverage` job이 매 PR에서 `npm run coverage`를 실행한다(`.github/workflows/ci.yml`). 로컬 `npm run check`엔 의도적으로 안 넣었다(제안대로 실행시간 고려 — TESTING.md §8에 근거 기록).

## QA-003 — coverage 범위가 core에만 한정됨

- 심각도: **높음**
- 근거: threshold include는 `src/core/**/*.ts`뿐이다. publish/보안상 중요한 `exploreSqlExecutor`, `folderScan`, `warehouseFactory`, provider와 CLI에는 강제 기준이 없다.
- 영향: 핵심 비즈니스 순수 함수의 품질은 높지만 실제 장애가 발생하는 IO·보안 경계의 미실행 분기가 누적될 수 있다.
- 수정 기준: 전체 프로젝트 기준을 별도로 추가하거나 위험 모듈별 threshold를 둔다. 단순 전체 백분율보다 critical branch 목록을 명시한다.
- **해결(T35, 2026-09-03)**: `vitest.config.ts`의 `coverage.include`를 `src/{core,adapters,agent,mcp,cli}`로 확장하고, `coverage.thresholds`에 glob 키로 위험 모듈별 기준을 추가했다 — `exploreSqlExecutor.ts`/`warehouseFactory.ts`/`resendProvider.ts`는 개별 기준(각각 SEC-001/002·OPS-001·OPS-004와 직결), `agent`/`mcp`/`cli`는 그룹 기준, core는 기존 90/90/90/85 유지. 숫자는 2026-09-03 실측치(core 99.69/95.19/100/100, adapters 89.39/81.45/88.46/91.45, agent 74.63/60.3/74.35/74.27, cli 69/67.74/70.58/66.29, mcp 83.33/67.07/90/93.44)에서 소폭 여유만 둔 회귀 방지용 바닥선이다(이상적 목표치 아님).

## QA-004 — 실 Postgres 계약 검증이 부족함

- 심각도: **높음**
- 근거: 대부분 PGlite 또는 mock connection 기반이다. 프로젝트 자체가 PGlite의 timeout 차이를 이미 확인했고, session lock 같은 차이/공통점도 존재한다.
- 영향: migration lock, READ ONLY, pg pool session, numeric/date parsing이 운영 Postgres에서만 다르게 실패할 수 있다.
- 수정 기준: CI service Postgres에서 migration, transaction rollback, read-only role, advisory lock cleanup, explore_sql timeout을 component test한다.
- **해결(T35, 2026-09-03)**: `tests/component/postgres.component.test.ts`(+ `vitest.component.config.ts`, `npm run test:pg-component`) — migration 멱등성/checksum 불일치, 실패한 마이그레이션의 트랜잭션 롤백, advisory lock cleanup, `BEGIN READ ONLY` 쓰기 거부, 그리고 PGlite로는 확인 불가능했던 `statement_timeout` 실제 취소까지 6개 describe로 커버한다. CI `postgres-component` job(`postgres:16` 서비스 컨테이너)에서만 돈다 — 기본 게이트(가드레일 2)는 `vitest.config.ts`의 exclude로 이 디렉터리를 안 본다. 로컬 `postgresql@16`(brew)으로 8/8 실측 통과 확인.

## QA-005 — 알려진 공격·정확성 회귀 케이스가 없음

- 심각도: **높음**
- 누락 케이스:
  - snapshot packSize round-trip
  - unchanged file 중복 발송 방지
  - 새 snapshot에서 사라진 SKU 정리
  - partial snapshot 동시 read
  - `pg_advisory_lock`, `set_config`를 이용한 explore_sql 우회
  - CSV formula injection과 대형 XLSX/CSV 한도
  - SCM 기간 불일치/기초재고 없음/실패 상태
- 수정 기준: 005~007 문서의 재검수 항목을 모두 자동 테스트로 연결한다.
- **해결(T35, 2026-09-03)**: `docs/010_FINDING_TEST_CROSSREF.md`(신규)가 004~008의 33개 finding 전부를 담당 테스트와 대조했다. 위 누락 케이스 7개 중 6개는 이미 자동화돼 있었고(005~007 각 finding 해결 시 함께 추가), 실제로 비어 있던 건 "partial snapshot 동시 read" 하나뿐이었다 — `tests/atomicFile.test.ts`에 진짜 동시 write-중-반복-read 레이스 테스트를 신규 추가했다(기존 테스트는 "쓰기 전에 읽어둔 핸들"만 확인해 진짜 동시성이 아니었다).

## QA-006 — dependency audit와 tarball 내용 검사가 자동화되지 않음

- 심각도: **높음**
- 근거: 수동 audit에서 moderate 2건이 발견됐고 pack dry-run은 불필요한 파일 97개를 보여줬지만 둘 다 `check`/CI에 없다.
- 수정 기준: lockfile audit 정책, allowlist assertion, secret scan/SBOM을 release workflow에 추가한다. audit 서비스 장애 시 fail-open/fail-closed 정책도 정한다.
- **해결(T35, 2026-09-03)**: CI `audit` job이 매 PR에서 셋 다 실행한다. ① lockfile audit(`src/adapters/auditLockfile.ts` + `npm run audit:lockfile`) — audit 실행 자체가 실패하면 fail-open(경고, 통과), 성공했는데 승인 목록(`src/core/auditAllowlist.ts`) 밖 advisory가 나오면 fail-closed. tarball 기준 audit(SEC-006, `scripts/verifyPack.ts`)과는 검사 대상이 달라 유지 — 실측으로 dev lockfile은 0건, tarball은 승인된 uuid 예외 1건으로 서로 다르게 나오는 걸 재확인했다(T32가 이미 실증한 `overrides` 비전파 문제). ② secret scan(`src/core/secretScan.ts` + `npm run secret-scan`) — AWS 키/PEM/Anthropic·Resend 키 접두사/자격증명 포함 Postgres URL 패턴, `git ls-files` 기준 추적 파일 전체. ③ SBOM(`npm sbom --sbom-format cyclonedx`, 아티팩트로 업로드 90일 보관). allowlist assertion(tarball 내용 검수)은 이미 T29의 `verify:pack` 1단계가 하고 있고 T35부터 CI `test` job에서도 매 OS/Node 조합에 돈다.

## 권장 release gate

1. clean checkout 및 지원 Node/OS matrix 설치
2. typecheck + lint + format check + unit/component/e2e
3. core 및 위험 모듈 coverage threshold
4. 운영 dependency audit + secret/license scan
5. clean build
6. `npm pack` allowlist 검증
7. tarball `--omit=dev` fresh install + CLI/MCP smoke
8. 버전·changelog·git tag·provenance 확인 후 사람 승인

