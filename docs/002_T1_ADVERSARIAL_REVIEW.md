# 002 — T1 적대적 검수 기록

- 검수일: 2026-09-02
- 대상 커밋: `585ca4d` (`T1: Migrations + domain types (#1)`)
- 판정: **실패 — 기본 테스트는 통과하지만 무결성·원자성·멱등 보장에 구조적 결함 존재**
- 범위: `migrations/001_init.sql`, `scripts/migrate.ts`, `src/core/types.ts`, PGlite 테스트

## 발견 002-01 — `inventory_snapshots`의 참조 무결성이 제거됨

- 심각도: **높음**
- 영역: DB 스키마
- 증거:
  - DESIGN §2의 원래 스키마는 snapshot의 `store_id`, `variant_id`가 각각 `stores`, `products`를 참조한다.
  - 실제 `001_init.sql`의 `inventory_snapshots`에는 두 외래키가 없다.
- 영향: 존재하지 않는 매장·상품의 스냅샷이 적재되어 시계열 집계가 현재고/상품 마스터와 불일치할 수 있다.
- 요구 조치: 두 외래키를 복원하고 orphan insert가 실패하는 마이그레이션 테스트를 추가한다.

## 발견 002-02 — Warehouse 계약으로는 DESIGN §11.1의 원자적 ETL을 표현할 수 없음

- 심각도: **치명적**
- 영역: `src/core/types.ts`의 `Warehouse`
- 증거:
  - DESIGN은 한 리소스의 data upsert와 watermark 갱신을 같은 트랜잭션에서 커밋하도록 요구한다.
  - 인터페이스는 `upsert*()`와 `setCursor()`를 독립 호출로만 제공한다.
  - 트랜잭션 callback, unit-of-work 또는 리소스 단위 atomic 메서드가 없다.
- 영향: T7이 현재 계약만 사용하면 “데이터 적재 성공 후 cursor 저장 실패” 또는 그 반대 상태를 막을 수 없다. 부분 실패 재개와 정확한 증분 동기화가 구조적으로 보장되지 않는다.
- 요구 조치: 예를 들어 `warehouse.transaction(fn)` 또는 `commitResourceSync({ rows, watermark, ... })`처럼 원자성 경계를 계약에 포함하고 PGlite rollback 테스트를 추가한다.

## 발견 002-03 — `run_id` unique index는 이메일 중복 발송을 막지 못함

- 심각도: **높음**
- 영역: `agent_send_log`, DESIGN §11.5 구현 해석
- 증거:
  - unique index는 `status = 'sent'`인 로그 행이 이미 DB에 있을 때만 중복 기록을 거부한다.
  - provider가 이메일 발송에 성공하고 DB 로그 기록 전에 프로세스가 죽으면 성공 행은 존재하지 않는다.
  - 재실행은 동일 이메일을 다시 보낸 후에야 로그를 기록하려 한다.
- 영향: 문서와 SQL 주석이 주장하는 “provider 성공 후 로그 기록 실패 상황의 이중 발송 방지”가 성립하지 않는다.
- 요구 조치: 발송 전에 원자적으로 예약 상태(`sending`)를 확보하고 상태 머신으로 전이하거나, provider가 지원하는 idempotency key를 사용한다. crash recovery 정책과 동시 실행 테스트가 필요하다.

## 발견 002-04 — 마이그레이션 동시 실행 경쟁 조건

- 심각도: **높음**
- 영역: `runMigrations`
- 증거:
  - 적용 목록을 트랜잭션 밖에서 한 번 조회한다.
  - 두 프로세스가 동시에 시작하면 둘 다 같은 migration을 미적용으로 판단하고 DDL을 실행할 수 있다.
  - advisory lock 또는 migration 전용 lock이 없다.
- 영향: 배포 작업이 겹치면 relation already exists/PK 충돌로 한 실행이 실패하며, 더 복잡한 DDL에서는 예측하기 어려운 배포 상태가 된다.
- 요구 조치: 세션 단위 advisory lock을 획득한 동일 client에서 전체 실행을 수행하고 동시 실행 테스트를 추가한다.

## 발견 002-05 — 실패 시 명시적 rollback 및 동일 client 보장이 없음

- 심각도: **높음**
- 영역: `createPgExecutor`, `runMigrations`
- 증거:
  - `begin; ... commit;`을 하나의 SQL 문자열로 `pool.query()`에 전달한다.
  - 오류 경로에 명시적 `ROLLBACK`이 없다.
  - executor가 transaction-bound `PoolClient`가 아니라 `Pool`을 감싼다.
- 영향: PostgreSQL 오류가 COMMIT 전에 발생했을 때 세션이 aborted transaction 상태로 풀에 반환될 위험이 있고, 후속 쿼리가 다른 connection을 사용하면 rollback/상태 확인도 보장할 수 없다. PGlite 통과만으로 실제 `pg.Pool` 동작을 증명하지 못한다.
- 요구 조치: `pool.connect()`로 client를 고정하고 `try { BEGIN ... COMMIT } catch { ROLLBACK } finally { release }` 패턴을 사용한다. 실제 Postgres 호환 component test 또는 주입 client의 호출 순서 테스트를 추가한다.

## 발견 002-06 — 적용된 마이그레이션의 내용 변조를 감지하지 못함

- 심각도: **중간**
- 영역: `schema_migrations`
- 증거: 적용 이력은 파일명 `id`만 저장하고 checksum을 저장하지 않는다.
- 영향: 이미 적용된 `001_init.sql`이 나중에 수정돼도 운영 DB에서는 조용히 skip되어 새 환경과 기존 환경의 스키마가 갈라진다.
- 요구 조치: SQL checksum을 저장·검증하고, 적용된 migration의 checksum 불일치 시 수정 방법이 담긴 오류로 중단한다.

## 발견 002-07 — `createTestWarehouse`가 실제 migration runner 경로를 우회

- 심각도: **중간**
- 영역: `src/mocks/pglite.ts`
- 증거: helper가 SQL 파일을 직접 `db.exec()`하며 `loadMigrations/runMigrations`를 사용하지 않는다.
- 영향: 대부분의 이후 테스트가 migration ordering, filename 검증, 이력 테이블 및 runner 결함을 통과하지 않고도 운영과 동일하다고 오인할 수 있다.
- 요구 조치: helper가 공용 runner를 사용하도록 통합하고 `schema_migrations` 적용 이력까지 확인한다.

## 재검수 완료 기준

- [ ] snapshot orphan insert 거부
- [ ] 리소스 data + watermark 원자 커밋/rollback 테스트
- [ ] 동시 migration 실행이 직렬화됨
- [ ] 실패 시 동일 client에서 rollback 후 정상 쿼리 가능
- [ ] migration checksum 불일치 감지
- [ ] 발송 전 crash 및 동시 재시도에서 중복 발송 0건을 만들 수 있는 계약 확정
- [ ] `npm run check` 통과
