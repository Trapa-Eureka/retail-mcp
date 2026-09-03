# 007 — 런타임·운영 신뢰성 적대적 검수

- 검수일: 2026-09-03
- 대상: 로컬 PGlite, 파일 처리, 이메일/에이전트 실행, 운영 관측성
- 판정: **보완 필수 — 오류 복구와 운영 상태 판별이 npm 사용자 환경에 충분하지 않음**
- 상태: **부분 RESOLVED(T34, 2026-09-03)** — OPS-001~005 해결. OPS-006(CI matrix)은 T35로 이관(아래 참고). 전체 재검수는 T37에서 진행. 상세는 `docs/DESIGN.md` §12.8.

## OPS-001 — PGlite close 실패 시 lock이 해제되지 않음

- 심각도: **높음**
- 영역: `warehouseFactory.ts`
- 근거: `close()`가 `await db.close(); await lock.release();` 순서다. `db.close()`가 reject하면 release는 실행되지 않는다.
- 영향: 프로세스가 계속 살아 있는 동안 lock file의 PID도 살아 있다고 판단돼 이후 실행이 계속 차단될 수 있다.
- 수정 기준: lock release를 `finally`에서 실행하고 두 cleanup 오류가 모두 관측되도록 aggregate error 정책을 정한다.
- **해결(T34, 2026-09-03)**: `warehouseFactory.ts`의 `close()`가 `db.close()`/`lock.release()`를 각각 독립된 try/catch로 감싸 release가 항상 시도되게 했다 — 둘 다 실패하면 `AggregateError`로 둘 다 보존, 하나만 실패하면 그 원인만 던진다. 초기화(마이그레이션) 실패 시의 catch 블록도 같은 원칙으로 보강(release 실패가 원래 원인을 가리지 않게 AggregateError). 테스트: `tests/warehouseFactory.test.ts`(`PGlite.prototype.close`를 스파이로 실패시켜 lock이 여전히 해제되는지, 둘 다 실패 시 AggregateError로 두 원인이 보존되는지).

## OPS-002 — PID 재사용 시 stale lock을 살아 있는 lock으로 오판

- 심각도: **중간**
- 영역: `fileLock.ts`
- 근거: 소유자 판정이 PID 생존 여부에만 의존한다. OS가 죽은 프로세스의 PID를 다른 프로세스에 재할당하면 오래된 lock도 active로 보인다.
- 영향: 수동 lock 삭제 전까지 서비스 기동이 막힐 수 있다.
- 수정 기준: hostname, process start identity, nonce를 저장하고 가능한 플랫폼에서 실제 프로세스 시작 시각을 비교한다. 충분히 오래된 lock의 안전한 운영 복구 절차도 문서화한다.
- **해결(T34, 2026-09-03)**: 락 파일에 `hostname`/`nonce`/`pidStartedAt`(POSIX에서 `ps -o lstart= -p <pid>`로 구함, Windows는 항상 null — OPS-006과 연결) 추가. ①다른 호스트가 쓴 락은 이 프로세스가 생사를 확인할 수 없으므로 **자동 회수하지 않고** 항상 busy로 취급(수동 확인 필요) — 구버전 락(hostname 필드 없음)은 하위 호환으로 "같은 호스트"로 간주. ②같은 pid가 살아있어도 그 pid의 *현재* 시작 시각이 락 기록과 다르면 그 사이 OS가 pid를 재사용한 것으로 보고 stale 취급해 회수한다(둘 중 하나라도 못 구했으면 이 신호 없이 기존 판정으로 안전하게 폴백). release()도 nonce까지 맞아야 지운다. 안전한 운영 복구 절차는 README "운영 신뢰성" 절에 문서화(사람이 직접 지워야 하는 경우는 cross-host뿐). 테스트: `tests/fileLock.test.ts`(신규 describe 6 tests — pid 재사용/재사용 아님/시작시각 못 구함/cross-host/구버전 하위호환/락 파일 필드 확인).

## OPS-003 — latest file 선택의 동률 순서가 결정론적이지 않음

- 심각도: **중간**
- 영역: inventory/SCM 파일 선택
- 근거: `mtimeMs`만으로 내림차순 정렬하며 동률일 때 filename tie-breaker가 없다.
- 영향: 파일 복사/압축 해제 과정에서 같은 mtime을 가진 파일이 여러 개면 OS readdir 순서에 따라 다른 데이터를 선택할 수 있다.
- 수정 기준: mtime 동률 시 명확히 오류를 내거나 filename/content marker 같은 안정적 tie-breaker를 정의한다.
- **해결(T34, 2026-09-03)**: 오류로 거부하는 대신 **결정론적 tie-breaker**를 채택했다 — mtime 내림차순, 동률이면 전체 경로 내림차순(`sortByMtimeThenPathDesc`, `agent/folderScan.ts`). 여러 파일이 정상적으로 같은 초에 복사되는 흔한 상황을 에러로 막지 않으면서도, 같은 파일 집합이면 OS `readdir` 순서와 무관하게 항상 같은 파일을 고른다. 동률이 실제로 감지되면 경고 로그에 "수정 시각이 동일해 파일명 역순으로 결정론적으로 골랐습니다"를 남겨 사용자가 원인을 알 수 있게 했다. inventory 파일·SCM 파일 선택 둘 다 같은 헬퍼를 공유. 테스트: `tests/folderScan.test.ts`(mtime을 `utimes`로 강제로 동일하게 맞춘 뒤 반복 스캔해도 항상 같은 파일이 선택되는지 확인).

## OPS-004 — 이메일 발송 성공 여부가 불확실한 실패의 자동 복구 계약이 없음

- 심각도: **높음**
- 영역: Resend timeout + `sending` reservation
- 근거: timeout 오류는 “이미 발송됐을 수 있음”을 알리지만 `sending → failed`로 바뀌어 같은 runId 재예약이 가능하다. provider idempotency key도 전달하지 않는다.
- 영향: 네트워크 응답 유실 후 재시도하면 이메일이 중복 발송될 수 있다. DB 예약은 동시 호출을 막지만 원격 side effect의 exactly-once를 보장하지 않는다.
- 수정 기준: Resend idempotency 지원 여부를 확인해 안정적 키를 사용하거나 `unknown` 상태를 별도로 두고 사람 확인 없이 자동 재시도하지 않는다.
- **해결(T34, 2026-09-03)**: 둘 다 채택했다. **Resend가 실제로 `Idempotency-Key` 헤더를 지원함을 문서로 확인**(resend.com API 문서, 2026-09-03 — 요청당 고유, 24시간 만료, 최대 256자) — `OutboundMessage.idempotencyKey`(신규)에 `runId`를 그대로 담아 넘긴다(`agent/folderScan.ts`/`agent/reorder.ts`), `resendProvider.ts`가 헤더로 전달. 같은 runId로 사람이 수동 재시도해도(예: `unknown` 확인 후) 실제로는 한 통만 나간다. **`AgentSendStatus`에 `"unknown"` 신설**(migration 008) — `resendProvider.ts`는 타임아웃일 때만(연결 자체 실패나 HTTP 오류 응답은 "요청이 도달은 했다/안 했다"가 확실해 대상 아님) 에러의 `.name`을 `AmbiguousSendError`로 표시하고, `agent/folderScan.ts`·`agent/reorder.ts`가 이를 보고 `failed` 대신 `unknown`으로 기록한다. `pgWarehouse.ts`의 `logAgentSendOn`도 `unknown`을 `sent`/`failed`와 같은 "sending 예약 행을 갱신하는" 대상에 포함시켜야 했다(빠뜨리면 별도 insert 행이 생겨 같은 run_id에 행이 두 개 남는 버그 — 테스트로 실제 재현·확인). 자동 재시도 로직 자체가 이 프로젝트에 없으므로 "사람 확인 없이 자동 재시도하지 않는다"는 그 자체로 이미 성립. 테스트: `tests/resendProvider.test.ts`(Idempotency-Key 헤더 전달/생략, 타임아웃만 AmbiguousSendError), `tests/pgWarehouse.test.ts`(unknown이 같은 행을 갱신), `tests/folderScan.test.ts`(AmbiguousSendError 주입 → agent_send_log에 unknown 하나만 기록 확인).

## OPS-005 — 장기 실행 관측성과 보존 정책이 없음

- 심각도: **중간**
- 영역: console 출력, DB 로그, snapshot/history
- 근거: 구조화 로그 형식, log level, correlation id 전파, agent_send_log/inventory_snapshots 보존 기간 및 정리 작업이 없다.
- 영향: 장애 원인 추적과 저장 공간 예측이 어렵고 장기 운영 시 테이블이 무제한 증가한다.
- 수정 기준: runId를 포함한 구조화 로그, 종료 코드 계약, 보존 기간/정리 명령, 백업·복구 절차를 정의한다.
- **해결(T34, 2026-09-03)**: **구조화 로그** — `src/adapters/structuredLog.ts`(신규) `logStructured()`가 사람이 읽는 기존 완료 로그 줄과 별개로 `{event, runId, status, ...}` JSON 한 줄을 stdout에 남긴다(`agent/folderScan.ts`의 지점/본사 모드, `agent/reorder.ts` 각각). MCP 서버(`server.ts`)는 stdout이 프로토콜 전용이라 대상에서 제외. **종료 코드 계약** — 기존 동작(성공 0, 처리 안 된 예외 1)을 README "운영 신뢰성"에 명문화(코드 변경 없음, 문서화만). **보존 기간/정리** — `Warehouse.deleteOldInventorySnapshots`/`deleteOldAgentSendLog`(신규, `pgWarehouse.ts`) + `scripts/cleanup.ts`(`npm run cleanup`, 사람 전용) — `npm run migrate`와 같은 이중 게이트(기본 dry-run, `--confirm`으로만 실제 삭제), `CLEANUP_RETENTION_DAYS`(기본 90일). **백업/복구** — README에 문서화만(임베디드 PGlite는 데이터 디렉터리 파일 복사, `DATABASE_URL`은 호스팅 서비스의 관리형 백업에 위임 — 이 프로젝트가 별도 구현하지 않음). 테스트: `tests/structuredLog.test.ts`(JSON 파싱 가능 확인), `tests/pgWarehouse.test.ts`(신규 describe 4 tests — 삭제/dry-run 각 테이블).

## OPS-006 — 설치 환경 호환성 검증 범위가 불명확함

- 심각도: **중간**
- 근거: `engines.node >=20`만 있고 OS/Node 버전 matrix CI와 clean install 검증 기록이 없다. PGlite·ExcelJS·TextDecoder(euc-kr)·파일 락은 플랫폼 차이에 민감하다.
- 영향: 개발 머신에서는 통과하지만 Windows/Linux 또는 다른 Node LTS에서 설치/인코딩/경로 동작이 깨질 수 있다.
- 수정 기준: 최소 지원 OS와 Node LTS를 정하고 clean tarball install + 핵심 e2e를 CI matrix에서 실행한다.
- **해결(T34 부분 + T35 완료)**: T34가 지원 범위를 README "운영 신뢰성"에 문서화(Node 20+, Windows 명시적 미검증)한 데 이어, T35가 `.github/workflows/ci.yml`의 `test` job으로 실제 CI matrix(`os: [ubuntu-latest, macos-latest] × node: [20, 22]`, 매 조합에서 typecheck/lint/format/test + `npm run verify:pack`)를 구성해 "지원한다고 문서화한 범위가 실제로 매 PR에서 검증됨"을 완성했다. CI가 Linux 러너에서 도는 것 자체로 "Linux 미검증"도 함께 해소됐다. Windows는 여전히 매트릭스에 없다 — `ps` 기반 OPS-002 보조 신호의 알려진 제약을 그대로 유지하는 의도적 선택(README에 이미 문서화).

## 운영 재검수 기준

- [x] 모든 close 경로에서 lock 해제(T34)
- [x] stale lock 복구 정책과 PID 재사용 대응(T34)
- [x] latest input 결정론(T34)
- [x] 원격 발송의 unknown/idempotency 정책(T34)
- [x] 구조화 로그·보존·백업 계약(T34)
- [x] 지원 OS/Node matrix 통과(T35, CI 최초 구성과 함께) — `.github/workflows/ci.yml` `test` job

