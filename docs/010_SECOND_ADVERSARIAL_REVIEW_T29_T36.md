# 010 — 2차 적대적 검수 (T29~T36)

- 검수일: 2026-09-03
- 대상 커밋: `92ad7d0`(T29) ~ `0064f01`(T36)
- 집중 범위: GitHub Actions CI, 자체 secret/audit 도구, `fileLock`, Resend 멱등성, npm 패키지의 migration CLI 간극
- 제외: 변경되지 않은 T0~T27 전체 재검수, 실제 `npm publish`
- 판정: **T37 진행 전 수정 필요 — P0 6건, P1 10건, P2 3건(총 19건)**
- 처리 진행 상황: **P0 6/6 전부 RESOLVED**(SR2-SEC-001, SR2-AUD-001, SR2-AUD-002, SR2-MAIL-001, SR2-LOCK-001, SR2-REL-001). P1 2/10 RESOLVED(SR2-CI-001 — 순서상 앞당겨 처리, SR2-MAIL-002). 나머지는 각 항목 아래 상태 참고 — 없으면 아직 OPEN. 다음 단계: 남은 P1 9건(MAIL-002/003, SEC-002~005, AUD-003, CI-002~004, LOCK-002) → 회귀 테스트 정리 → P2 3건(LOCK-003, SEC-005 중복 표기 확인, 나머지) → T37.
- **부수 조치(finding 아님, 사용자 지시로 처리)**: SR2-MAIL-001 PR의 CI에서 `tests/performance.test.ts`의 5초 예산이 `--coverage` 없는 plain `test` job에서도 반복 실패(5015/5165/5300/5392ms, 한 워크플로에서 job 2개 동시 실패)하는 걸 확인 — T36에서 coverage job은 이미 제외했지만 예산 값 자체가 CI 공유 러너 기준으로 너무 빡빡했다. 5초→10초(`BUDGET_MS`)로 올렸다. `docs/TESTING.md` §4에 근거 기록.

## 실행 검증

| 검증 | 결과 |
|---|---|
| `npm run check` | 통과 |
| Vitest | 42 files, 522 tests 통과 |
| `npm run secret-scan` | 통과(추적 파일 136개, 발견 0건) |
| `npm run audit:lockfile` | 통과(현재 lockfile 취약점 0건) |

`secret-scan`과 `audit:lockfile`은 기본 sandbox에서 `tsx` IPC 권한 오류가 발생해 승인된 외부 실행으로 재검증했다. 이는 애플리케이션 결함 판정에는 포함하지 않는다.

---

## A. CI·공급망

### SR2-CI-001 — workflow token 권한을 최소값으로 고정하지 않음

- 우선순위: **P1**
- 파일: `.github/workflows/ci.yml`
- 근거: workflow 또는 job 수준 `permissions:` 선언이 없다. 실제 `GITHUB_TOKEN` 권한은 repository/organization 기본 설정에 의존한다.
- 공격/실패 시나리오: fork PR의 코드는 `npm ci` lifecycle, 테스트, package script로 실행된다. 기본 권한이 나중에 넓어지면 PR 코드가 그 권한을 상속한다.
- 수정 기준: workflow 최상단에 최소 `permissions: { contents: read }`를 명시하고 artifact job에 추가 권한이 필요한 경우 해당 job에만 부여한다. fork PR에서 secrets 미주입과 token 권한을 repository 설정/branch protection까지 확인한다.
- **RESOLVED**: `ci.yml` 워크플로 최상단에 `permissions: { contents: read }`를 명시했다. 네 job 모두 checkout 후 로컬 커맨드(npm ci/test/lint/audit 등)만 실행하고 아무것도 쓰지 않는다는 걸 확인했다 — SBOM `actions/upload-artifact@v4`도 `GITHUB_TOKEN`이 아니라 Actions 런타임 토큰으로 인증해 별도 권한이 필요 없다. 그래서 job별 추가 권한 없이 워크플로 전역 `contents: read` 하나로 충분하다. `SECURITY.md`에 반영. (참고: 이 finding의 실제 우선순위는 doc 본문상 **P1**이다 — 사용자 지시로 P0 항목보다 먼저 이 순서로 처리했다.)

### SR2-CI-002 — 외부 Action과 Postgres image가 immutable digest로 고정되지 않음

- 우선순위: **P1**
- 파일: `.github/workflows/ci.yml`
- 근거: `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `postgres:16`처럼 이동 가능한 tag를 사용한다.
- 공격/실패 시나리오: upstream tag 또는 image가 변하면 동일 commit의 CI가 다른 코드를 실행한다. 공급망 침해 시 repo token/소스에 접근하는 코드가 바뀔 수 있다.
- 수정 기준: Actions는 검증한 full commit SHA에 고정하고 사람이 읽을 tag를 주석으로 남긴다. service image도 가능하면 digest를 고정하고 정기 갱신 절차를 둔다.

### SR2-CI-003 — job timeout이 없어 악성/교착 PR이 runner를 장시간 점유 가능

- 우선순위: **P2**
- 파일: `.github/workflows/ci.yml`
- 근거: 네 job 모두 `timeout-minutes`가 없다. 개별 Vitest timeout은 전체 process, `npm ci`, pack install, audit network hang을 제한하지 않는다.
- 수정 기준: 관측된 정상 시간에 여유를 둔 job별 timeout을 설정한다.

### SR2-CI-004 — branch protection과 required checks가 코드로 검증되지 않음

- 우선순위: **P1**
- 근거: T35는 CI를 만들었지만 main 직접 push 차단, required job, approval, stale approval dismissal은 workflow 파일만으로 보장되지 않는다.
- 영향: 모든 gate가 있어도 관리자가 실패/미실행 상태로 merge 또는 직접 push하면 우회된다.
- 수정 기준: GitHub ruleset에서 네 job을 required로 지정하고 main 보호 설정을 T37 체크리스트의 사람 확인 항목으로 증거화한다.

---

## B. 자체 secret scanner

### SR2-SEC-001 — placeholder 단어 하나로 실제 시크릿을 우회 가능

- 우선순위: **P0**
- 파일: `src/core/secretScan.ts`
- 근거: 매치된 같은 줄에 `fake|example|placeholder|dummy|...` 중 하나만 있으면 실제 매치값의 형태와 무관하게 무조건 제외한다.
- 우회 예:

```ts
const productionKey = "sk-ant-실제키값"; // example
```

- 영향: 악의적 PR뿐 아니라 “example로 쓰려던 실제 키” 같은 사람 실수를 정확히 놓친다.
- 수정 기준: line marker 기반 자동 제외를 제거한다. 필요한 fixture는 실제 provider 형식과 일치하지 않는 명백한 test token을 생성하거나 파일/라인 단위 allowlist에 사유·소유자·만료일을 명시한다.
- **RESOLVED**: 흔한 영단어 목록(`fake|example|placeholder|...`)을 전부 제거하고, 우연히 나올 일이 없는 전용 마커 `secretscan-allow`(정확한 문자열 일치) 하나로 좁혔다 — `src/core/secretScan.ts`의 `EXPLICIT_ALLOW_MARKER`. 이 finding이 지적한 정확한 우회(`// example`)가 더 이상 안 통하는 걸 `tests/secretScan.test.ts`에 5가지 흔한 단어 케이스로 직접 회귀 테스트로 고정했다. 기존에 이 느슨한 마커에 의존하던 실제 픽스처 2곳(`tests/claudeSummarizer.test.ts`, `tests/secretScan.test.ts` 자체)을 새 마커로 갱신.

### SR2-SEC-002 — `tests/secretScan.test.ts` 전체 제외가 영구 blind spot임

- 우선순위: **P1**
- 파일: `scripts/secretScan.ts`
- 근거: `SELF_EXCLUDE`가 해당 파일 전체를 검사하지 않는다.
- 공격/실패 시나리오: 실제 credential이 이 파일에 들어가도 CI는 구조적으로 발견하지 못한다. 테스트용 가짜 값과 새로 추가된 다른 문자열을 구분하지 않는다.
- 수정 기준: 파일 전체 제외를 없애고 fixture literal만 좁게 허용하거나 test가 런타임에 문자열을 조합하도록 바꾼다.

### SR2-SEC-003 — git history를 검사한다는 CI 설명과 실제 구현이 다름

- 우선순위: **P1**
- 파일: `.github/workflows/ci.yml`, `scripts/secretScan.ts`
- 근거: checkout은 `fetch-depth: 0`이지만 scanner는 `git ls-files`의 현재 tree만 읽는다. commit history/diff object는 검사하지 않는다.
- 영향: PR의 이전 commit에 secret을 넣었다가 마지막 commit에서 지우면 scanner는 통과하지만 secret은 Git history에 남아 원격에서 열람 가능하다.
- 수정 기준: PR base~head commit/diff와 새 blob을 검사하거나 검증된 history-aware scanner를 병행한다. 설명도 실제 범위와 일치시킨다.

### SR2-SEC-004 — 파일 읽기 실패를 조용히 무시하는 fail-open

- 우선순위: **P1**
- 파일: `scripts/secretScan.ts`
- 근거: `readFile(...).catch(() => null)` 후 아무 오류 없이 continue한다.
- 영향: 권한·인코딩·race·비정상 파일 때문에 검사하지 못한 tracked file이 있어도 “발견 0건”으로 성공한다.
- 수정 기준: 검사 대상 tracked file을 읽지 못하면 non-zero로 실패하고 파일명을 보고한다. 의도적으로 제외하는 binary는 allowlist에서만 제외한다.

### SR2-SEC-005 — 프로젝트가 실제 사용하는 credential 종류를 충분히 다루지 않음

- 우선순위: **P2**
- 근거: AWS/PEM/Anthropic/Resend/Postgres만 검사한다. npm token, GitHub token, Google credential JSON, 일반 bearer token과 `LOYVERSE_API_TOKEN`의 값은 탐지 계약에 없다.
- 수정 기준: 이 프로젝트의 `.env.example`, CI/publish 흐름에서 실제 취급하는 credential 목록을 기준으로 pattern/entropy scanner 범위를 정한다. 경량 자체 scanner의 한계를 SECURITY에 명확히 표시한다.

---

## C. dependency audit gate

### SR2-AUD-001 — 네트워크/실행/JSON 오류가 CI 성공으로 처리되는 fail-open

- 우선순위: **P0**
- 파일: `src/adapters/auditLockfile.ts`
- 근거: stdout 없음과 JSON parse 실패가 모두 `null` 성공으로 반환된다. 보안 job의 목적이 release gate인데 외부 audit 서비스 장애 시 green이 된다.
- 영향: 공격자가 장애를 직접 만들지 않더라도 registry 장애 시 취약점 검증 없이 merge/release가 가능하다. T37이 이 job의 green만 신뢰하면 출시 보장이 무너진다.
- 수정 기준: PR 편의 gate와 release gate를 분리한다. release/T37에서는 audit 불능을 실패로 처리하고, 사람이 승인한 재시도 외에는 우회하지 않는다.
- **RESOLVED**: 실은 `scripts/verifyPack.ts`(release gate)는 이미 진짜 실행 실패(stdout 자체가 없음)에는 fail-closed였다(catch에서 `stdout`이 없으면 원본 에러를 그대로 rethrow) — 이번에 새로 발견한 건 SR2-AUD-002와 같은 뿌리(무효 리포트 형식 검증 없음)였다. `isValidAuditReport()`(아래 AUD-002)를 `verifyPack.ts`에도 연결해 **무효 리포트(레지스트리 오류 등)도 이제 fail-closed로 막는다** — `auditLockfile.ts`(PR 편의 gate)는 여전히 fail-open이지만 메시지가 "0건"이라고 절대 말하지 않는다(AUD-002 참고). 정책 자체(PR gate=fail-open, release gate=fail-closed)를 명시적으로 분리해 문서화했다.

### SR2-AUD-002 — 오류 JSON을 “취약점 0건”으로 오인함

- 우선순위: **P0**
- 파일: `auditLockfile.ts`, `auditAllowlist.ts`
- 근거: `npm audit`가 non-zero와 함께 `{"error": ...}` 형태 stdout을 내면 JSON parse는 성공한다. `vulnerabilities`가 없으므로 빈 객체로 처리되어 `noneFound=true`로 통과한다.
- 수정 기준: report schema에서 `auditReportVersion`, `metadata.vulnerabilities`, `vulnerabilities`를 검증하고 `error` 필드 또는 필수 필드 누락은 실행 실패로 판정한다. 실제 registry error JSON fixture를 추가한다.
- **RESOLVED**: `src/core/auditAllowlist.ts`에 `isValidAuditReport()` 신설 — `error` 필드가 있거나 `vulnerabilities`가 객체가 아니면 무효로 판정한다(npm 11.6.2 실제 성공 응답을 실측해 `vulnerabilities`가 항상 객체로 존재함을 확인). `auditLockfile.ts`(fail-open이지만 "0건"이라 말하지 않음)와 `verifyPack.ts`(fail-closed, throw) 둘 다 이 검증을 거친다. `evaluateLockfileAudit(JSON.stringify({error:{...}}))`가 더 이상 "0건" 로그를 남기지 않는 걸 회귀 테스트로 고정(`tests/auditLockfile.test.ts`).

### SR2-AUD-003 — 승인 예외 만료일이 주석일 뿐 기계적으로 집행되지 않음

- 우선순위: **P1**
- 파일: `src/core/auditAllowlist.ts`
- 근거: `2027-03-03` 재검토 기한은 주석에만 있고 allowlist 데이터에는 만료일이 없다.
- 영향: 기한이 지나도 CI는 계속 같은 advisory를 자동 승인한다.
- 수정 기준: allowlist를 `{url, expiresAt, rationale}` 구조로 만들고 기준 시계가 만료일 이상이면 실패시킨다.

---

## D. file lock PID/cross-host 판정

### SR2-LOCK-001 — hostname 충돌 시 다른 호스트의 active lock을 stale로 삭제 가능

- 우선순위: **P0**
- 파일: `src/adapters/fileLock.ts`
- 근거: host identity가 `os.hostname()` 문자열 하나다. 서로 다른 머신/container가 같은 hostname을 쓰면 same-host로 판정한다. 그 PID가 로컬에서 죽어 있거나 시작 시각이 다르면 다른 호스트가 실제 사용 중인 lock을 삭제한다.
- 영향: 공유/network filesystem에서 두 PGlite 프로세스가 같은 data directory를 동시에 열어 데이터가 유실될 수 있다. 이 lock의 존재 목적을 직접 무너뜨린다.
- 수정 기준: PGlite data directory를 network/shared filesystem에서 지원하지 않는다고 강제하거나, 설치 시 영속적으로 만든 machine UUID까지 host identity에 포함한다. cross-host 안전성을 보장할 수 없다면 자동 stale 회수를 금지한다.
- **RESOLVED**: `FileLockOptions.machineId`(기본값 `defaultGetMachineId()` — loopback이 아닌 첫 네트워크 인터페이스의 MAC 주소, 못 구하면 undefined)를 락 파일에 함께 기록하고, cross-host 판정에서 양쪽 다 machineId를 구할 수 있으면 hostname 문자열 비교보다 이 값을 우선하도록 바꿨다(hostname이 같아도 machineId가 다르면 다른 호스트로 판정, hostname이 달라도 machineId가 같으면 같은 호스트로 판정). 설치 시 UUID를 파일로 영속화하는 방식은 채택하지 않았다 — lock 대상 디렉터리 자체가 공유/network filesystem이면 그 파일도 같이 공유돼 목적을 못 이루고, home directory에 쓰면 테스트마다 실제 디스크 IO 부수효과가 생긴다. MAC 주소는 OS가 이미 들고 있는 값이라 디스크에 아무것도 안 쓰고, 동기 호출이라 테스트 부수효과가 없다. machineId를 한쪽이라도 못 구하면(구버전 락, 네트워크 인터페이스 없는 샌드박스 등) 기존 hostname 판정으로 안전하게 폴백한다(LOCK-002는 그 폴백 경로 자체의 안전성 강화 — 별도 트래킹, 아직 미해결). `tests/fileLock.test.ts`에 5개 회귀 테스트 추가, 기존 "다른 호스트가 쓴 락은..." 테스트는 두 acquireFileLock 호출 모두 hostname과 함께 서로 다른 machineId를 명시하도록 갱신했다(실제 테스트 실행 머신의 진짜 MAC에 좌우되지 않고 "다른 호스트" 시나리오를 결정적으로 재현하기 위해).

### SR2-LOCK-002 — 구버전 lock은 공유 filesystem에서 안전하지 않음

- 우선순위: **P1**
- 근거: hostname이 없는 이전 lock을 항상 same-host로 취급한다. 업그레이드 직후 공유 디렉터리에서 다른 호스트의 구버전 active lock을 로컬 PID 검사만으로 회수할 수 있다.
- 수정 기준: hostname 없는 lock은 보수적으로 busy 처리하거나, 명시적 migration/사람 확인을 거쳐서만 회수한다.

### SR2-LOCK-003 — release의 확인 후 삭제가 하나의 원자 연산이 아님

- 우선순위: **P2**
- 근거: release가 파일을 읽어 nonce를 확인한 뒤 별도 `rm`을 한다. 그 사이 운영자/복구 도구가 파일을 교체하면 새 소유자의 lock을 지울 수 있다.
- 영향: 일반 정상 경로에서는 낮은 확률이지만 수동 stale 복구와 겹치면 보호가 깨질 수 있다.
- 수정 기준: 수동 복구 규약에서 실행 중 release와 경합하지 않게 하거나 OS 수준 lock/원자 rename 기반 소유권 검증을 검토한다.

---

## E. Resend idempotency·상태 판정

### SR2-MAIL-001 — 새 실행마다 random runId라 재실행 시 idempotency key가 달라짐

- 우선순위: **P0**
- 파일: `agent/reorder.ts`, `agent/folderScan.ts`, `resendProvider.ts`
- 근거: provider에는 runId를 idempotency key로 넘기지만 CLI 실행마다 random UUID를 만든다. timeout/unknown 후 다음 cron 또는 일반 CLI 재실행은 같은 보고서에도 새 key를 사용한다. 사용자가 CLI에서 이전 runId를 지정하는 인터페이스도 없다.
- 영향: Resend의 동일-key dedupe가 적용되지 않아 “발송됐지만 응답을 못 받은” 실행 뒤 동일 이메일이 다시 전송될 수 있다.
- 수정 기준: 보고서 identity(수신자+보고기간+내용 hash 등)에서 안정적인 delivery key를 만들거나 unknown 상태를 다음 실행이 조회해 사람 확인 전 같은 digest 발송을 막는다. 실제 CLI 재실행 경로로 검증한다.
- **RESOLVED**: `--run-id=<값>` CLI 플래그를 `agent/reorder.ts`/`agent/folderScan.ts`(지점 모드) 둘 다에 추가했다(`src/core/cliArgs.ts`의 `parseNamedArg`, 순수 함수라 단위 테스트 가능 — `runReorderAgent`/`runFolderScan` 자체의 `opts.runId` 전달은 이미 T34에서 테스트돼 있었다, 빠진 건 CLI 진입점의 argv 파싱뿐이었다). 지정 안 하면 기존처럼 `randomUUID()`로 폴백한다. 실제 `npx tsx src/agent/folderScan.ts --run-id=smoke-test-run-42`로 완료 로그의 `run_id`가 정확히 그 값으로 나오는 걸 직접 재현·확인, 플래그 생략 시 랜덤 UUID로 폴백하는 것도 재확인. README "이메일 발송 재시도" 절에 실제 명령 예시를 반영.

### SR2-MAIL-002 — timeout 이외 네트워크 오류도 결과가 불확실할 수 있음

- 우선순위: **P1**
- 근거: `AmbiguousSendError`는 Error name이 `TimeoutError`일 때만 설정된다. 연결 reset/socket close는 요청 본문이 서버에 도달한 뒤 응답만 유실된 상황일 수 있는데 `failed`로 기록된다.
- 영향: 다음 실행이 확실한 미발송으로 오인하고 재시도할 수 있다.
- 수정 기준: HTTP response를 받기 전 발생한 네트워크 오류는 원칙적으로 ambiguous로 분류하고 provider idempotency로 안전하게 재시도한다. 명백한 DNS/connection-refused를 별도로 구분할지는 보수적으로 결정한다.
- **RESOLVED**: `resendProvider.ts`의 분류 기준을 뒤집었다 — 예전엔 `TimeoutError`만 `AmbiguousSendError`(→ `unknown`)였고 나머지 응답-이전 오류는 전부 `failed`였는데, 이제 **연결이 성립조차 안 된 게 확실한 코드**(`ENOTFOUND`/`EAI_AGAIN`/`ECONNREFUSED`, `DEFINITELY_NOT_SENT_CODES`)만 `failed`이고 그 외 모든 응답-이전 오류(타임아웃, `ECONNRESET`, undici `UND_ERR_SOCKET`, 코드 없는 알 수 없는 오류)는 `AmbiguousSendError`다. 오분류 비용이 비대칭이라(실제 나간 메일을 failed로 기록 → 다음 실행이 새 run_id로 중복 발송 / 실제 안 나간 메일을 unknown으로 기록 → 사람이 대시보드 한 번 확인) 기본값을 ambiguous 쪽으로 뒀다. 실제 undici 오류 형태(`TypeError("fetch failed")` + `cause.code`)는 Node 24에서 닫힌 포트(`ECONNREFUSED`)·없는 호스트(`ENOTFOUND`)·연결 후 응답 없이 끊는 서버(`UND_ERR_SOCKET`)로 직접 재현해 확인했고, cause 체인을 따라가 code를 찾는다(최대 5단계). `tests/resendProvider.test.ts`에 6개 회귀 테스트(재현한 실제 형태를 픽스처로), `core/types.ts` `unknown` 주석과 README "이메일 발송 재시도" 절 갱신. MAIL-003(dedupe 보존시간 이후 정책)은 별도 트래킹.

### SR2-MAIL-003 — provider의 dedupe 보존시간 이후 재시도 정책이 없음

- 우선순위: **P1**
- 근거: 코드 주석은 Resend 동일-key dedupe가 24시간이라고 명시하지만 unknown/sending 상태의 만료·사람 확인·24시간 이후 처리 규칙이 연결되어 있지 않다.
- 수정 기준: provider dedupe TTL 안에서만 자동 재시도를 허용하고, TTL 이후에는 새 발송 승인 또는 원격 message 조회가 필요하도록 상태 머신을 정의한다.

---

## F. npm 설치 후 migration CLI 간극

### SR2-REL-001 — network Postgres 사용자는 게시 패키지만으로 migration을 실행할 수 없음

- 우선순위: **P0**
- 파일: `package.json`, `scripts/migrate.ts`, `warehouseFactory.ts`
- 근거:
  - tarball `files`에는 `migrations`는 포함하지만 `scripts/migrate.ts`와 컴파일된 migration CLI는 포함하지 않는다.
  - 등록된 bin은 server/onboard뿐이다.
  - `DATABASE_URL`이 있으면 `createNetworkWarehouse()`는 자동 migration을 실행하지 않는다.
- 영향: npm 소비자가 Neon/Supabase를 선택하면 빈 DB에 필요한 schema를 만들 공식 명령이 없다. README의 repository용 `npm run migrate`는 설치된 dependency에서 사용할 수 없다.
- 판정: 사용자 제안대로 제품 결정을 먼저 해야 하지만, 결정 전에는 publish를 차단해야 한다.
- 선택지:
  1. `retail-mcp-migrate` bin을 제공하고 사람 확인 가드·dry-run/target 표시를 둔다.
  2. server/agent startup 자동 migration을 채택하되 기존 “프로덕션 migration은 사람만” 가드레일을 공식 변경한다.
  3. npm 배포판은 embedded PGlite만 지원하고 network Postgres 기능을 비공개/고급 설치 범위로 분리한다.
- **제품 결정(사용자, 2026-09-04)**: 선택지 1 채택. 근거 — DATABASE_URL을 설정하는 사용자는 이미 Neon/Supabase 계정 생성·연결 문자열 발급을 거친, 어느 정도 기술적인 선택을 한 사람들이다(embedded PGlite가 진짜 비개발자 기본 경로이고 이미 자동 마이그레이션이라 이 문제와 무관). 그 단계까지 거친 사람에게 명시적 CLI 명령 한 번 더 요구하는 건 Prisma/Django/Rails 등 업계 표준 마이그레이션 도구와 같은 패턴이라 부담이 작다. 선택지 2(자동 migration)는 여러 라운드의 적대적 검수로 확정한 가드레일 5("프로덕션 마이그레이션은 사람만")를 직접 뒤집고 다중 인스턴스 동시 기동 시 새 위험을 만든다. 선택지 3(embedded 전용 제한)은 이미 구현·테스트된 기능을 통째로 제거하는 과한 대응이다.
- **RESOLVED**: `retail-mcp-migrate` bin(`src/cli/migrate.ts`) 추가 — 기본 dry-run(대상 host/db명·대기 중인 마이그레이션 목록만 표시, 자격증명은 절대 출력하지 않음), 실제 적용은 `--confirm`(가드레일 1의 dry_run+--confirm 이중 게이트와 같은 패턴). 실제 적용/점검 로직(advisory lock 포함)은 `scripts/migrate.ts`(저장소 전용)와 `src/adapters/migratePg.ts`를 공유해 lock key 등이 두 파일에 따로 하드코딩되는 걸 막았다. 선택지 1에 더해, 사용자가 지적한 "실제로 마찰의 원인은 명령어 한 번이 아니라 confusing raw 에러"라는 관찰을 반영해 읽기 전용 사전 점검(`checkPendingMigrations`, `migrationRunner.ts`)도 추가했다 — `server.ts`/`agent/reorder.ts`/`agent/folderScan.ts`가 `DATABASE_URL` 경로 기동 시 `ensureNetworkMigrationsApplied()`(`warehouseFactory.ts`)를 호출해 스키마 누락을 raw Postgres 에러("relation ... does not exist") 대신 `retail-mcp-migrate`를 안내하는 에러로 즉시 알린다. 이 사전 점검은 `createWarehouseFromEnv()` 자체에는 넣지 않았다 — 그 함수가 DATABASE_URL이 있어도 실제 네트워크 연결을 시도하지 않는다는 기존 테스트 계약(warehouseFactory.test.ts)을 지키기 위해서다. `scripts/verifyPack.ts`(release gate)에 bin 실행·에러 경로 확인을 추가하고, `tests/component/postgres.component.test.ts`(real Postgres)·`tests/warehouseFactory.test.ts`·`tests/migrateRunner.test.ts`·`tests/cliMigrate.test.ts`에 회귀 테스트를 추가했다. `retail-mcp-migrate` 전체 흐름(dry-run/--confirm/멱등성/DATABASE_URL 누락 에러)을 로컬 Postgres 16(Homebrew)에 대해 직접 재현·확인했다. `docs/004` REL-006도 완전 해소로 갱신.

---

## T37 전 권장 처리 순서

1. **P0 결정/수정**: SR2-SEC-001, AUD-001/002, LOCK-001, MAIL-001, REL-001
2. **P1 보강**: CI 권한·pin/ruleset, history secret scan, audit expiry, legacy lock, ambiguous network/TTL
3. 실패 회귀 테스트와 실 Postgres/pack 재검증
4. 이 문서 각 항목에 `OPEN/RESOLVED/ACCEPTED` 및 해결 commit 기록
5. 그 다음 T37의 8단계 기계적 release gate 실행

## 최종 판정

T29~T36은 1차 검수의 많은 결함을 실질적으로 개선했고 기존 522개 테스트도 모두 통과한다. 그러나 새로 만든 보안 게이트와 멱등성/락 보강 자체에 독립적인 우회 경로가 남아 있다. 특히 audit의 오류 JSON 통과, stable하지 않은 email idempotency key, hostname 충돌 lock 회수, network Postgres migration 부재는 npm 공개 전 반드시 닫아야 한다.
