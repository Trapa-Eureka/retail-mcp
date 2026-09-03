# 007 — 런타임·운영 신뢰성 적대적 검수

- 검수일: 2026-09-03
- 대상: 로컬 PGlite, 파일 처리, 이메일/에이전트 실행, 운영 관측성
- 판정: **보완 필수 — 오류 복구와 운영 상태 판별이 npm 사용자 환경에 충분하지 않음**
- 상태: **OPEN** — 추적: `docs/TASKS.md` T34(OPS-001~006), T37(재검수).

## OPS-001 — PGlite close 실패 시 lock이 해제되지 않음

- 심각도: **높음**
- 영역: `warehouseFactory.ts`
- 근거: `close()`가 `await db.close(); await lock.release();` 순서다. `db.close()`가 reject하면 release는 실행되지 않는다.
- 영향: 프로세스가 계속 살아 있는 동안 lock file의 PID도 살아 있다고 판단돼 이후 실행이 계속 차단될 수 있다.
- 수정 기준: lock release를 `finally`에서 실행하고 두 cleanup 오류가 모두 관측되도록 aggregate error 정책을 정한다.

## OPS-002 — PID 재사용 시 stale lock을 살아 있는 lock으로 오판

- 심각도: **중간**
- 영역: `fileLock.ts`
- 근거: 소유자 판정이 PID 생존 여부에만 의존한다. OS가 죽은 프로세스의 PID를 다른 프로세스에 재할당하면 오래된 lock도 active로 보인다.
- 영향: 수동 lock 삭제 전까지 서비스 기동이 막힐 수 있다.
- 수정 기준: hostname, process start identity, nonce를 저장하고 가능한 플랫폼에서 실제 프로세스 시작 시각을 비교한다. 충분히 오래된 lock의 안전한 운영 복구 절차도 문서화한다.

## OPS-003 — latest file 선택의 동률 순서가 결정론적이지 않음

- 심각도: **중간**
- 영역: inventory/SCM 파일 선택
- 근거: `mtimeMs`만으로 내림차순 정렬하며 동률일 때 filename tie-breaker가 없다.
- 영향: 파일 복사/압축 해제 과정에서 같은 mtime을 가진 파일이 여러 개면 OS readdir 순서에 따라 다른 데이터를 선택할 수 있다.
- 수정 기준: mtime 동률 시 명확히 오류를 내거나 filename/content marker 같은 안정적 tie-breaker를 정의한다.

## OPS-004 — 이메일 발송 성공 여부가 불확실한 실패의 자동 복구 계약이 없음

- 심각도: **높음**
- 영역: Resend timeout + `sending` reservation
- 근거: timeout 오류는 “이미 발송됐을 수 있음”을 알리지만 `sending → failed`로 바뀌어 같은 runId 재예약이 가능하다. provider idempotency key도 전달하지 않는다.
- 영향: 네트워크 응답 유실 후 재시도하면 이메일이 중복 발송될 수 있다. DB 예약은 동시 호출을 막지만 원격 side effect의 exactly-once를 보장하지 않는다.
- 수정 기준: Resend idempotency 지원 여부를 확인해 안정적 키를 사용하거나 `unknown` 상태를 별도로 두고 사람 확인 없이 자동 재시도하지 않는다.

## OPS-005 — 장기 실행 관측성과 보존 정책이 없음

- 심각도: **중간**
- 영역: console 출력, DB 로그, snapshot/history
- 근거: 구조화 로그 형식, log level, correlation id 전파, agent_send_log/inventory_snapshots 보존 기간 및 정리 작업이 없다.
- 영향: 장애 원인 추적과 저장 공간 예측이 어렵고 장기 운영 시 테이블이 무제한 증가한다.
- 수정 기준: runId를 포함한 구조화 로그, 종료 코드 계약, 보존 기간/정리 명령, 백업·복구 절차를 정의한다.

## OPS-006 — 설치 환경 호환성 검증 범위가 불명확함

- 심각도: **중간**
- 근거: `engines.node >=20`만 있고 OS/Node 버전 matrix CI와 clean install 검증 기록이 없다. PGlite·ExcelJS·TextDecoder(euc-kr)·파일 락은 플랫폼 차이에 민감하다.
- 영향: 개발 머신에서는 통과하지만 Windows/Linux 또는 다른 Node LTS에서 설치/인코딩/경로 동작이 깨질 수 있다.
- 수정 기준: 최소 지원 OS와 Node LTS를 정하고 clean tarball install + 핵심 e2e를 CI matrix에서 실행한다.

## 운영 재검수 기준

- [ ] 모든 close 경로에서 lock 해제
- [ ] stale lock 복구 정책과 PID 재사용 대응
- [ ] latest input 결정론
- [ ] 원격 발송의 unknown/idempotency 정책
- [ ] 구조화 로그·보존·백업 계약
- [ ] 지원 OS/Node matrix 통과

