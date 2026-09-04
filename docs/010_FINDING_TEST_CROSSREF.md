# 010 — 검수 finding ↔ 자동 테스트 대조표

- 작성일: 2026-09-03 (TASKS T35, QA-005 "005~007의 재검수 항목이 전부 자동 테스트로 연결됐는지 대조표 작성" 대응)
- 범위: `docs/004`~`008`이 지적한 전체 finding(REL/SEC/DATA/OPS/QA, 33건) + `docs/009`의 DOC-\* 5건 + **2차 적대적 검수 `docs/010_SECOND_ADVERSARIAL_REVIEW_T29_T36.md`의 SR2-\* 19건**(2026-09-04 추가, 아래 "SR2" 절).
- 갱신 규칙: finding을 다루는 코드/테스트가 바뀌면 이 표도 같은 PR에서 함께 갱신한다. 이 표 자체는
  진실의 원천이 아니다 — 각 finding의 "해결 근거"는 여전히 `docs/004`~`009` 본문에 있고, 여기는
  "그 해결이 지금 어떤 자동 테스트로 지켜지고 있는가"만 빠르게 찾기 위한 색인이다.

## 범례

- **상태**: `자동화됨` = 아래 테스트가 회귀를 막는다 / `CI 전용` = 로컬 `npm run test`/`check`가
  아니라 CI job에서만 돈다(가드레일 2 예외 또는 무거운 release gate) / `수동/사람` = 자동 테스트로
  표현할 수 없는 항목(예: `npm whoami` 소유권 확인) / `예정` = 아직 담당 태스크 전
- **테스트**: 파일명만 적었고, 필요하면 파일 안의 describe 블록 이름으로 더 좁혀 찾을 수 있다
  (대부분 finding ID를 describe/it 이름에 그대로 인용해뒀다).

각 표의 "담당" 열이 가리키는 태스크(Txx)의 실제 해결 커밋/PR은 `docs/TASKS.md`의 해당 Txx 절 머리글에
`PR #NN`으로 달려 있다(T28→#39, T29→#40, T30→#41, T31→#42, T32→#43, T33→#44, T34→#45, T35→#47) —
33개 finding 각 행에 중복해서 적지 않고 여기서 한 번만 매핑한다.

## REL — npm 배포 패키징 (`docs/004`, 담당 T29/T37)

| ID | 요약 | 상태 | 근거/테스트 |
|---|---|---|---|
| REL-001 | `private:true`가 publish를 막음 | 자동화됨 | `package.json`(private 제거, scope/access 확정) — 회귀는 `npm pack`이 즉시 드러냄 |
| REL-002 | 설치자가 실행할 bin/main이 없음 | 자동화됨 | `scripts/verifyPack.ts`(bin 5종 실제 spawn 확인 — T37 게시 전 점검(2026-09-04)에서 핵심 기능용 `retail-mcp-scan`/`retail-mcp-reorder`가 빠져 있던 간극을 발견해 추가, 6·7단계) |
| REL-003 | 배포물이 TS인데 tsx가 devDependency | 자동화됨 | `scripts/verifyPack.ts`(`--omit=dev` 설치 후 bin 실행 성공이 곧 회귀 증거) |
| REL-004 | 배포 allowlist 없이 97개 파일 게시 | 자동화됨 | `scripts/verifyPack.ts` 1단계(`npm pack --dry-run` 파일 목록) |
| REL-005 | 라이선스/메타데이터 없음 | 수동/사람 | `package.json`/`LICENSE` — 값 자체는 사람이 확정, 자동 회귀 대상 아님 |
| REL-006 | 설치/업그레이드/제거 문서 없음 + 외부 DATABASE_URL migration CLI 부재(SR2-REL-001) | 해소(T36 문서화 → 2026-09-04 `retail-mcp-migrate` bin으로 코드까지 완전 해결) | README 문서 작업 + `scripts/verifyPack.ts`(bin 실행·에러 경로) + `tests/component/postgres.component.test.ts`(real Postgres 적용·멱등성) + `tests/warehouseFactory.test.ts`/`tests/migrateRunner.test.ts`(PGlite 단위) |
| REL-007 | publish 전 자동 게이트 없음 | 자동화됨(T29 → T37 완결, 2026-09-04) | `prepack`이 `build` 자동 호출. `verify:pack`은 T35의 `test` job(OS/Node matrix)에서 매 PR 실행. T37에서 `prepublishOnly: npm run check && npm run verify:pack` 연결 — `npm publish`가 어디서 실행돼도 게이트를 건너뛸 수 없다(회귀는 publish 시도 자체가 드러냄) |
| REL-008 | 패키지명/소유권 미검증 | 수동/사람(T37 완료) | scope 채택으로 위험 완화. T37(2026-09-04): `npm whoami`=`shiz_son`, `@trapa-eureka` 조직 없음 → 패키지명 `@shiz_son/retail-mcp`로 변경(사용자 결정), `npm view` 404로 가용 확인 |

## SEC — 보안/의존성 (`docs/005`, 담당 T30/T32/T35)

| ID | 요약 | 상태 | 테스트 |
|---|---|---|---|
| SEC-001 | READ ONLY가 advisory lock류 부수효과를 못 막음 | 자동화됨 | `tests/sqlValidator.test.ts`, `tests/exploreSqlExecutor.test.ts` |
| SEC-002 | `set_config` 재정의로 timeout 무력화 가능 | 자동화됨 | `tests/sqlValidator.test.ts`, `tests/exploreSqlExecutor.test.ts` |
| SEC-003 | 대형/압축폭탄 CSV·XLSX 한도 없음 | 자동화됨 | `tests/fileLimits.test.ts`, `tests/csvExcelParser.test.ts` |
| SEC-004 | CSV formula injection | 자동화됨 | `tests/csvSafety.test.ts`, `tests/snapshotExport.test.ts` |
| SEC-005 | `.env` 권한/원자성 없음 | 자동화됨 | `tests/onboard.test.ts` |
| SEC-006 | 미검토 의존성 취약점(uuid via exceljs) | 자동화됨(이중) | 게시 tarball 기준: `scripts/verifyPack.ts` 5단계. lockfile 기준(조기 경보, T35 신규): `tests/auditLockfile.test.ts` + CI `audit` job의 `npm run audit:lockfile` |
| SEC-007 | 보안 정책/신고 채널 없음 | 자동화됨(존재 확인) | `SECURITY.md` 존재 자체가 산출물 — 내용 정확성은 사람 검토 |

## DATA — 데이터 정확성 (`docs/006`, 담당 T31/T33)

| ID | 요약 | 상태 | 테스트 |
|---|---|---|---|
| DATA-001 | packSize export→import 왕복 손실 | 자동화됨 | `tests/snapshotExport.test.ts` |
| DATA-002 | 사라진 SKU/매장이 tombstone 안 됨 | 자동화됨 | `tests/pgWarehouse.test.ts`, `tests/folderScan.test.ts` |
| DATA-003 | 동일 파일 반복 실행 시 중복 발송/무음 위험 | 자동화됨 | `tests/folderScan.test.ts`(일일 다이제스트 describe) |
| DATA-004 | snapshot 쓰기 도중 죽으면 손상 위험 | 자동화됨 | `tests/atomicFile.test.ts`(부분 read race 포함, T35에서 강화) |
| DATA-005 | undefined/null/값 3상태 구분 안 됨 | 자동화됨 | `tests/csvExcelParser.test.ts`, `tests/pgWarehouse.test.ts` |
| DATA-006 | 기초재고 없이 확정 discrepancy 경고 | 자동화됨 | `tests/metrics.test.ts`(insufficientData describe) |
| DATA-007 | SCM 처리 실패가 결과에 안 보임 | 자동화됨 | `tests/folderScan.test.ts`(scmStatus 관련 케이스) |
| DATA-008 | 동일 날짜 복수 입고 축소 | 자동화됨 | `tests/scmSchema.test.ts` |

## OPS — 운영 신뢰성 (`docs/007`, 담당 T34/T35)

| ID | 요약 | 상태 | 테스트 |
|---|---|---|---|
| OPS-001 | db.close() 실패 시 lock 안 풀림 | 자동화됨 | `tests/warehouseFactory.test.ts` |
| OPS-002 | PID 재사용/타 호스트 락 오판 | 자동화됨 | `tests/fileLock.test.ts`(PID 재사용·cross-host describe) |
| OPS-003 | latest file 동률 시 비결정적 선택 | 자동화됨 | `tests/folderScan.test.ts`(mtime tie-break 케이스) |
| OPS-004 | 발송 timeout이 실패로 오분류·재시도 위험 | 자동화됨 | `tests/resendProvider.test.ts`, `tests/pgWarehouse.test.ts`, `tests/folderScan.test.ts` |
| OPS-005 | 구조화 로그/보존 정책 없음 | 자동화됨 | `tests/structuredLog.test.ts`, `tests/pgWarehouse.test.ts`(retention describe) |
| OPS-006 | 지원 OS/Node matrix 미검증 | **CI 전용(T35에서 신규)** | `.github/workflows/ci.yml`의 `test` job — `os: [ubuntu-latest, macos-latest] × node: [20, 22]`, 각 조합에서 `npm run verify:pack`까지 실행. Windows는 여전히 명시적 미검증(README/DESIGN §12.8에 이미 문서화된 정책 그대로) |

## QA — 테스트/릴리스 게이트 (`docs/008`, 담당 T29/T35)

| ID | 요약 | 상태 | 테스트/구성 |
|---|---|---|---|
| QA-001 | 테스트가 tarball을 안 검증 | 자동화됨(로컬) + CI 전용(T35) | `scripts/verifyPack.ts` — T35부터 CI `test` job의 매 OS/Node 조합에서도 실행 |
| QA-002 | coverage threshold가 `check`에 없음 | **CI 전용(T35 신규)** | `vitest.config.ts`의 `coverage.thresholds` + CI `coverage` job(`npm run coverage`). 로컬 `check`엔 의도적으로 미포함(무거움, TESTING.md §8) |
| QA-003 | coverage 범위가 core 한정 | 자동화됨(T35 신규) | `vitest.config.ts`의 `coverage.include`를 `src/{core,adapters,agent,mcp,cli}`로 확장 + explore_sql/warehouseFactory/resendProvider/agent/mcp/cli 위험 모듈별 glob threshold |
| QA-004 | 실 Postgres 계약 검증 부족 | **CI 전용(T35 신규)** | `tests/component/postgres.component.test.ts`(migration 멱등성·checksum, transaction rollback, READ ONLY, advisory lock cleanup, explore_sql statement_timeout) — CI `postgres-component` job의 `postgres:16` 서비스 컨테이너 대상. 로컬은 `TEST_DATABASE_URL` 없으면 스킵 |
| QA-005 | 공격/정확성 회귀 케이스 없음 | 자동화됨 | 아래 "QA-005 세부 항목" 참고 — 005~007 항목은 위 SEC/DATA/OPS 표로 이미 전부 연결됨 |
| QA-006 | audit/tarball 검사 자동화 안 됨 | **CI 전용(T35 신규)** | lockfile audit: `tests/auditLockfile.test.ts` + CI `audit` job의 `npm run audit:lockfile`(fail-open/closed 정책은 `src/adapters/auditLockfile.ts`). secret scan: `tests/secretScan.test.ts` + `npm run secret-scan`. SBOM: CI `audit` job이 CycloneDX SBOM을 아티팩트로 생성 |

### QA-005 세부 항목(008이 나열한 누락 케이스)

| 케이스 | 테스트 |
|---|---|
| snapshot packSize round-trip | `tests/snapshotExport.test.ts` |
| unchanged file 중복 발송 방지 | `tests/folderScan.test.ts`(일일 다이제스트 describe) |
| 새 snapshot에서 사라진 SKU 정리 | `tests/pgWarehouse.test.ts`, `tests/folderScan.test.ts`(tombstone) |
| **partial snapshot 동시 read** | `tests/atomicFile.test.ts`("쓰기 도중에 반복해서 읽어도..." 케이스, T35에서 신규 추가 — 이전엔 "쓰기 전 읽기"만 있었고 진짜 동시 레이스는 없었다) |
| `pg_advisory_lock`/`set_config`를 이용한 explore_sql 우회 | `tests/sqlValidator.test.ts`, `tests/exploreSqlExecutor.test.ts` |
| CSV formula injection과 대형 XLSX/CSV 한도 | `tests/csvSafety.test.ts`, `tests/snapshotExport.test.ts`, `tests/fileLimits.test.ts`, `tests/csvExcelParser.test.ts` |
| SCM 기간 불일치/기초재고 없음/실패 상태 | `tests/metrics.test.ts`, `tests/folderScan.test.ts` |

## DOC — 문서 정합성 (`docs/009`, 담당 T28/T36)

| ID | 요약 | 상태 |
|---|---|---|
| DOC-001 | TASKS T0~T7 상태 오표기 | 해소(T28) — 표기 정정, 자동 테스트 대상 아님 |
| DOC-002 | CLAUDE/DESIGN이 v0.1 규칙만 반영 | 해소(T28, T29~T34가 이어서 DESIGN에 각 절 추가) |
| DOC-003 | MCP 도구 수 설명이 문서마다 다름 | 해소(T28) — `tests/server.test.ts`/`tests/mcpTools.test.ts`가 실제 노출 도구 목록을 회귀로 고정하므로 문서-코드 불일치는 여기서 드러난다 |
| DOC-004 | npm 배포 사용법 문서 없음 | 해소(T36) — README "설치(npm 게시 후)" 절 신설 |
| DOC-005 | 001~003 문서의 lifecycle 표기 없음 | 해소(T28) — `docs/001~003`에 상태 라벨 추가 |

> T35 시점에 이 대조표는 `docs/009` 6번째 줄의 "DOC-002~004는 T36에서"라는 요약과 위 표(DOC-002/003은
> T28에서 이미 실질적으로 해소) 사이의 불일치를 지적해뒀었다 — T36에서 `docs/009`의 그 줄 자체를
> 정정했다(009 참고).

## SR2 — 2차 적대적 검수 (`docs/010_SECOND_ADVERSARIAL_REVIEW_T29_T36.md`, 2026-09-03 검수 → 2026-09-04 처리)

1차 검수 대응(T29~T36) 자체를 다시 검수한 결과 19건(P0 6·P1 10·P2 3). 각 finding은 **PR 1개**로 처리했고(태스크 번호 없음 — 아래 PR 열이 곧 해결 커밋), 해결 근거 전문은 원본 문서의 각 항목 아래 `RESOLVED` 줄에 있다. 대조 방법(2026-09-04): 아래 테스트 파일이 실제로 존재하고 finding ID가 `describe`/`it` 이름에 그대로 들어 있는지 `grep`으로 확인했다 — 코드로 해결한 13건 전부 ID가 이름에 들어 있어 이름 정리가 필요한 테스트는 없었고, `tests/component/**` 1건을 제외한 전부가 기본 게이트(`vitest.config.ts`, `npm run check`)에서 돈다.

| ID | 우선순위 | 요약 | 상태 | 근거/테스트 | PR |
|---|---|---|---|---|---|
| SR2-SEC-001 | P0 | placeholder 단어 하나로 secret-scan 우회 | 자동화됨 | `tests/secretScan.test.ts`(흔한 단어 5종이 더 이상 제외되지 않음, 전용 마커 `secretscan-allow`만 허용) | #49 |
| SR2-AUD-001 | P0 | audit 실행/JSON 오류가 CI 성공 처리(fail-open) | 자동화됨 | `tests/auditAllowlist.test.ts`(`isValidAuditReport`), `scripts/verifyPack.ts`(release gate에서 무효 리포트 fail-closed — `test` job에서 매 PR 실행) | #50 |
| SR2-AUD-002 | P0 | 오류 JSON을 "취약점 0건"으로 오인 | 자동화됨 | `tests/auditLockfile.test.ts`(`{error:{…}}` 리포트가 "0건" 로그를 남기지 않음) | #50 |
| SR2-MAIL-001 | P0 | 실행마다 random runId라 재시도 idempotency 무효 | 자동화됨(부분) + 수동 | `tests/cliArgs.test.ts`(`parseNamedArg` — `--run-id` 파싱). `main()`의 argv → `opts.runId` 배선 자체는 단위 테스트 밖 — 실제 CLI 실행으로 재현·확인(원본 문서 RESOLVED 참고). `opts.runId` 전달은 T34 테스트가 이미 고정 | #51 |
| SR2-LOCK-001 | P0 | hostname 충돌 시 타 호스트 active lock 삭제 | 자동화됨 | `tests/fileLock.test.ts`("machineId 기반 cross-host 판정" describe 5 tests) | #53 |
| SR2-REL-001 | P0 | network Postgres 사용자용 migration CLI 부재 | 자동화됨 + CI 전용 | `tests/cliMigrate.test.ts`, `tests/migrateRunner.test.ts`, `tests/warehouseFactory.test.ts`(`ensureNetworkMigrationsApplied`), `scripts/verifyPack.ts`(bin 실행·에러 경로); real Postgres 적용·멱등성은 `tests/component/postgres.component.test.ts`(CI `postgres-component` job 전용) | #55 |
| SR2-CI-001 | P1 | workflow token 권한 미고정 | CI 전용(구성) | `.github/workflows/ci.yml` 최상단 `permissions: contents: read` — 테스트로 표현 불가, 워크플로 파일 자체가 산출물. `SECURITY.md` 명시 | #54 |
| SR2-MAIL-002 | P1 | timeout 외 네트워크 오류가 `failed`로 오분류 | 자동화됨 | `tests/resendProvider.test.ts`(실제 undici 오류 형태 픽스처 6 tests — `ECONNREFUSED`/`ENOTFOUND`만 failed, `ECONNRESET`/`UND_ERR_SOCKET`/코드 없음은 ambiguous) | #56 |
| SR2-SEC-002 | P1 | `tests/secretScan.test.ts` 전체 제외 blind spot | 자동화됨(자기 검증) | `tests/secretScan.test.ts`(픽스처 런타임 조합 + 자기 소스를 스캔해 0건 assert), `scripts/secretScan.ts`의 `SELF_EXCLUDE` 삭제 | #58 |
| SR2-SEC-003 | P1 | git history 스캔 설명과 구현 불일치 | 자동화됨 + CI 전용 | `tests/secretScanGit.test.ts`(`scanGitRange` — "넣은 커밋 → 지운 커밋" 임시 저장소 6 tests); CI `audit` job이 `--range=$SCAN_BASE..$SCAN_HEAD`로 실제 실행 | #59 |
| SR2-SEC-004 | P1 | 파일 읽기 실패를 조용히 무시(fail-open) | 자동화됨 | `tests/secretScanGit.test.ts`(`scanTrackedFiles` — EACCES/ENOENT/심볼릭 링크/binary allowlist 5 tests), `scripts/secretScan.ts`가 `unreadable`을 non-zero로 | #60 |
| SR2-AUD-003 | P1 | 승인 예외 만료일이 주석일 뿐 | 자동화됨 | `tests/auditAllowlist.test.ts`(만료 경계·형식 오류·실제 데이터 검증), `tests/auditLockfile.test.ts`(기한 당일 실패 문자열), `scripts/verifyPack.ts`(release gate throw) | #61 |
| SR2-CI-002 | P1 | Action/Postgres image가 이동 가능한 태그 | CI 전용(구성) + 수동 갱신 | `ci.yml`의 `uses:` 9줄 full SHA + `postgres:16@sha256:…`; 검증은 이 워크플로 자체가 고정값으로 매 PR 실행(job 로그의 `Download action repository … (SHA:…)`/`docker pull …@sha256:…`). 갱신은 `.github/dependabot.yml`(Action) + TESTING.md §8 수동 절차(digest) | #63 |
| SR2-LOCK-002 | P1 | hostname 없는 구버전 lock을 same-host로 회수 | 자동화됨 | `tests/fileLock.test.ts`("hostname 없는 구버전 락은 소유 호스트 불명 → busy" describe 5 tests) | #65 |
| SR2-MAIL-003 | P1 | dedupe 보존시간 이후 재시도 정책 없음 | 자동화됨 | `tests/sendRetryPolicy.test.ts`(순수 판정 11), `tests/reorderAgent.test.ts`(6), `tests/folderScan.test.ts`(2), `tests/pgWarehouse.test.ts`(`listAgentSendAttempts`/`markStaleSendingUnknown` 2) | #66 |
| SR2-CI-004 | P1 | branch protection/required checks 미검증 | **수동/사람**(저장소 설정) | GitHub ruleset `22244613`(main, PR 필수·required checks 7·bypass 0) — 저장소 밖 설정이라 테스트 불가. `docs/TASKS.md` T37 사람 확인 항목 + 확인 명령(`gh api repos/…/rules/branches/main`). 매 PR 머지가 ruleset을 통과하는 것이 상시 검증(#67이 첫 사례) | #67 |
| SR2-CI-003 | P2 | job `timeout-minutes` 없음 | CI 전용(구성) | `ci.yml` 네 job의 `timeout-minutes`(test 50 / audit 30 / coverage 25 / postgres-component 15, 관측 최대치 약 2배 — 근거 주석 포함). 재조정 규칙은 TESTING.md §8. 검증은 매 PR의 CI가 상한 안에서 통과하는 것 | #69 |
| SR2-LOCK-003 | P2 | release의 확인 후 삭제가 비원자적 | **ACCEPTED · 수동/사람** | 코드 변경 없음 — POSIX/Node 표준으로 원자적 "내용 일치 시 삭제"가 불가, 대안 3종(flock/rename/inode 재확인) 기각 근거는 `DESIGN.md` §12.8. 완화는 README "PGlite 락 복구"의 수동 복구 규약(삭제만, 실행 중 프로세스 있으면 금지). 경합은 결정적 재현 불가라 자동 테스트 없음; 기존 `tests/fileLock.test.ts`의 "release 시점에 다른 pid 소유면 지우지 않는다"가 비경합 경로의 소유권 검증을 고정 | #70 |
| SR2-SEC-005 | P2 | 실제 사용 credential 종류 커버 부족(npm/GitHub token, `LOYVERSE_API_TOKEN` 값 등) | 자동화됨 | `tests/secretScan.test.ts`("credential 커버리지 확장" describe 7 tests — LOYVERSE 대입식·GitHub·npm·Google·Bearer 탐지 + 오탐 방어 + 마커/preview 규칙, 자기 검증 유지). 한계는 `SECURITY.md` "자체 시크릿 스캐너의 한계" 항목 | #71 |

**부수 조치(finding 아님)**: 위 PR들의 CI에서 관측된 환경 문제 3건 — `tests/performance.test.ts` 예산 5s→10s(#52), `vitest.config.ts` `hookTimeout` 20s(#57), `npm audit` 무효 리포트 제한 재시도 `src/adapters/npmAudit.ts` + `tests/npmAudit.test.ts`(#62). 원본 문서 머리의 "부수 조치" 줄 참고.

## 이 표가 커버하지 못하는 것

- finding 하나가 "완전히 막혔다"는 뜻이 아니다 — 예를 들어 SEC-001/002는 `FORBIDDEN_FUNCTION_CALLS`
  블록리스트가 알려진 함수만 막는다는 한계가 각 원본 문서에 그대로 남아 있다. 이 표는 "회귀가 생기면
  테스트가 잡아준다"는 뜻이지 "공격이 이론적으로 불가능하다"는 뜻이 아니다.
- REL-005/006/008, SEC-007 일부, DOC-\*는 성격상 "값이 사람 의도와 일치하는가"를 묻는 항목이라
  자동 테스트로 표현할 수 없다 — 표에 `수동/사람`으로 명시했다.
- SR2-CI-001/002/004는 워크플로 파일·저장소 설정이라 단위 테스트가 없다 — "CI가 그 구성으로 실제로
  돈다"(job 로그, ruleset 아래 머지)가 검증이고, CI-004는 T37에서 사람이 한 번 더 확인한다.
