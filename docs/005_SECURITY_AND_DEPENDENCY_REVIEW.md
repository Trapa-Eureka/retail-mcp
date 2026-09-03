# 005 — 보안·의존성 적대적 검수

- 검수일: 2026-09-03
- 대상: 임의 SQL, 파일 입력/출력, 시크릿, 운영 의존성
- 판정: **출시 차단 — `explore_sql` 격리 주장이 성립하지 않고 알려진 의존성 취약점 존재**
- 상태: **부분 RESOLVED(T30, 2026-09-03)** — SEC-001/002 해결. SEC-003~007은 T32, 전체 재검수는 T37에서 진행. explore_sql 정책 강화는 `docs/SPEC.md` §18, `docs/DESIGN.md` §12.4에 반영됨.

## SEC-001 — READ ONLY 트랜잭션은 부수효과 SELECT를 막지 못함

- 심각도: **치명적**
- 영역: `src/core/sqlValidator.ts`, `src/adapters/exploreSqlExecutor.ts`
- 재현:

```sql
begin read only;
select pg_try_advisory_lock(727100104);
rollback;
select pg_try_advisory_lock(727100104);
```

PGlite 실증에서 두 호출 모두 `true`였고 rollback 뒤에도 session advisory lock이 남았다. 두 번 unlock해야 완전히 해제됐다.

- 원인: PostgreSQL의 READ ONLY는 테이블/시퀀스 쓰기를 제한하지만 모든 volatile 함수의 외부 부수효과를 금지하는 샌드박스가 아니다. 블록리스트의 `\block\b`도 `pg_advisory_lock`의 underscore 때문에 잡지 못한다.
- 영향: 사용자가 migration/sync용 advisory lock을 선점해 운영을 방해하거나 pooled session에 lock을 남길 수 있다. 설치된 extension과 DB 권한에 따라 다른 부수효과 함수도 호출할 수 있다.
- 수정 기준: 쓰기 권한뿐 아니라 위험 함수 실행 권한이 제한된 전용 DB role을 필수화한다. 임의 표현식이 아니라 허용 schema/table을 대상으로 한 제한된 query AST 또는 고정 analytics 도구를 우선 검토한다. 최소한 advisory lock/unlock, backend 제어, 파일/네트워크/설정 함수의 공격 테스트가 필요하다.
- **해결(T30)**: `core/sqlValidator.ts`에 `FORBIDDEN_FUNCTION_CALLS`(함수명 단위 블록리스트, `\b이름\s*\(` 매칭 — `\block\b`이 놓쳤던 언더스코어 우회를 닫는다) 추가 — advisory lock류·`set_config`·백엔드 제어류·파일/원격 접근류. 이 재현 시나리오(`begin read only; select pg_try_advisory_lock(...); rollback; select pg_try_advisory_lock(...)`)를 `tests/exploreSqlExecutor.test.ts`에 그대로 살아있는 회귀 테스트로 남겨 "READ ONLY 혼자로는 advisory lock을 못 막는다"는 사실 자체를 문서화했다. 전용 DB role 요구는 SPEC §18/DESIGN §12.4에 정책으로, README(T36에서) 체크리스트로 반영 — 코드가 role 권한을 강제 조회하지는 않는다(운영 role 구성은 배포자 책임, 가드레일 4 기존 원칙). 허용 schema/table 제한 쿼리 AST 방식은 채택하지 않음(explore_sql의 정의 자체가 고정 쿼리 형태가 없는 유일한 예외이기 때문) — 근거는 SPEC §18.

## SEC-002 — 사용자가 `statement_timeout`을 다시 바꿀 수 있음

- 심각도: **치명적**
- 영역: `explore_sql`
- 근거: executor가 먼저 `set_config('statement_timeout', ...)`를 호출하지만 사용자 SELECT도 `set_config`를 호출할 수 있다. validator는 이를 금지하지 않는다.
- 영향: 실 Postgres에서도 사용자가 timeout을 0 또는 큰 값으로 덮어써 비싼 쿼리를 장시간 실행할 수 있다. PGlite는 문서대로 timeout 자체를 집행하지 않아 더 직접적인 CPU/메모리 DoS가 가능하다.
- 수정 기준: `set_config` 같은 설정 함수 실행을 차단하는 것만으로 완전한 샌드박스가 되지는 않는다. 전용 role, 서버 측 `statement_timeout` 강제, 별도 제한 connection/pool, 동시성·비용 제한을 결합하고 bypass 회귀 테스트를 추가한다. PGlite에서는 `explore_sql` 비활성화를 기본이 아니라 강제로 검토한다.
- **해결(T30)**: `set_config(`를 `FORBIDDEN_FUNCTION_CALLS`로 막아 사용자 SQL이 executor 자신의 `statement_timeout` 설정을 재정의할 수 없게 했다(`tests/sqlValidator.test.ts`/`tests/exploreSqlExecutor.test.ts`에 회귀 테스트). "PGlite에서는 explore_sql 비활성화를 기본이 아니라 강제로 검토"는 **기본 차단 + 명시적 override**(`EXPLORE_SQL_ALLOW_PGLITE=true`, `SEND_MODE=live && --confirm`과 같은 패턴)로 확정 — `resolveServerConfig()`가 `DATABASE_URL` 없이 `EXPLORE_SQL_ENABLED=true`면 원인+조치 담긴 에러로 서버 기동을 거부한다(`tests/server.test.ts`). 서버 측 `statement_timeout` 강제·별도 connection pool·동시성 제한은 실 Postgres(pg 경로)에서는 표준 GUC라 이미 유효하고, PGlite 전용 한계는 위 차단으로 우회 경로 자체를 없앴다.

## SEC-003 — XLSX/CSV 입력에 파일 크기·행·셀 길이 한도가 없음

- 심각도: **높음**
- 영역: `csvExcelParser.ts`, `folderScan.ts`
- 근거: 파일 전체를 `readFile`/ExcelJS로 메모리에 올리고 모든 parse error도 문자열 배열에 누적한다. 압축 해제 크기, worksheet 행 수, 셀 문자열 길이 제한이 없다.
- 영향: 감시 폴더에 놓인 대형/압축폭탄 XLSX 또는 대량 CSV가 프로세스 메모리와 CPU를 고갈시킬 수 있다. cron 반복 실행이면 장애가 지속된다.
- 수정 기준: 읽기 전 파일 크기 제한, XLSX 압축 해제/worksheet 한도, 최대 행·열·셀 길이, 오류 개수 cap을 정의한다. 초과 시 원인과 허용값을 반환한다.

## SEC-004 — snapshot CSV의 spreadsheet formula injection 방어 없음

- 심각도: **높음**
- 영역: `snapshotExport.ts`
- 근거: 매장명·상품명·SKU가 `=`, `+`, `-`, `@`로 시작해도 그대로 CSV에 기록된다. CSV quoting은 구분자 escape일 뿐 spreadsheet 수식 실행 방어가 아니다.
- 영향: 사람이 Excel/Sheets로 snapshot을 열 때 공격성 수식이 실행되거나 외부 URL로 데이터가 유출될 수 있다.
- 수정 기준: 사람이 여는 CSV인지 기계 전용인지 계약을 정한다. 사람이 열 수 있다면 위험 접두사 값을 안전하게 escape하고 round-trip 정책을 테스트한다.

## SEC-005 — `.env`가 민감정보 파일 권한을 강제하지 않음

- 심각도: **높음**
- 영역: `src/cli/onboard.ts`
- 근거: `writeFile(".env", ...)`에 mode를 지정하지 않는다. 새 파일 권한은 프로세스 umask에 의존하고 기존 파일 권한도 검사하지 않는다. DATABASE_URL과 이메일 주소가 저장된다.
- 영향: 다중 사용자 머신에서 환경설정과 DB credential이 다른 계정에 읽힐 수 있다.
- 수정 기준: 새 파일은 `0o600`으로 원자 생성하고 기존 파일도 안전한 권한인지 검사/보정한다. 임시 파일→fsync→rename 방식으로 중간 손상도 막는다.

## SEC-006 — 운영 의존성에 알려진 moderate 취약점 2건

- 심각도: **높음**
- 검증: `npm audit --omit=dev --json`
- 결과: direct `exceljs`를 통해 `uuid < 11.1.1`의 `GHSA-w5hq-g745-h8pq`가 포함된다. npm 집계는 moderate 2건(`exceljs`, `uuid`)이다.
- 영향: advisory는 uuid v3/v5/v6에 buffer를 전달하는 경우의 bounds check 결함이다. 현재 애플리케이션에서 해당 경로가 직접 호출되는지는 확인되지 않았지만, 공개 배포 전에 위험 수용 또는 제거 근거가 필요하다.
- 수정 기준: ExcelJS 최신 의존성 트리에서 해결되는지 확인하고, 단순 자동 downgrade 제안은 따르지 않는다. 대체 라이브러리/override의 호환성과 XLSX 테스트를 검증한 뒤 audit 예외가 남으면 근거·만료일을 기록한다.

## SEC-007 — 보안 정책과 취약점 신고 경로가 없음

- 심각도: **중간**
- 근거: `SECURITY.md`와 지원 버전/비공개 신고 채널이 없다.
- 영향: 공개 패키지 사용자가 취약점을 공개 이슈로 노출하거나 신고 방법을 찾지 못한다.
- 수정 기준: 지원 버전, 응답 목표, 비공개 신고 주소를 SECURITY 문서와 package metadata에 연결한다.

## 보안 재검수 기준

- [x] `explore_sql`의 전용 role·함수 실행 권한·PGlite 정책 확정(T30 — role은 정책/문서, PGlite는 코드로 기본 차단)
- [x] advisory lock 및 timeout override 공격 테스트 통과(T30)
- [ ] 파일 resource limit과 CSV formula 방어 적용 — T32
- [ ] `.env` 0600 + 원자 쓰기 — T32
- [ ] 운영 dependency audit 0건 또는 승인된 예외 문서화 — T32

