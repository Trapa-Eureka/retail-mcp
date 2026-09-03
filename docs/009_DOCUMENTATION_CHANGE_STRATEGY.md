# 009 — 문서 일관성 검수와 수정 순서 판정

- 검수일: 2026-09-03
- 질문: 기존 Markdown을 지금 바로 고칠지, 신규 검수 문서대로 구현한 뒤 관련 문서를 고칠지
- 판정: **둘 중 하나만 선택하지 않는다. 규범 문서 선행 → 코드/테스트 → 운영 문서 후행의 3단계가 가장 안전하다.**
- 상태: **1~3단계 RESOLVED** — 1단계(규범 문서)는 `docs/TASKS.md` T28(PR #39)에서 SPEC §18/DESIGN §12/TESTING §8/TASKS(T0~T7 정정 + T28~T37)를 반영했다(2026-09-03). 2단계(코드+테스트)는 T29~T35(PR #40~#47)로 완료. 3단계(운영 문서 동기화)는 T36에서 진행 — README/CLAUDE/SECURITY/CHANGELOG 동기화 + 004~008 finding별 해결 근거 기록(`docs/010`). 4단계(tarball 재검수)는 T37에서 진행한다. DOC-001/003/005는 T28에서 해소, **DOC-002는 T28~T35에 걸쳐 DESIGN §12 각 절이 누적되며 해소**(009 6번째 줄이 예전에 "DOC-002~004는 T36에서"라고 적었던 건 T28 완료 후 갱신을 놓친 것 — 지금 이 줄이 정정), DOC-004는 T36에서 README "설치" 절로 해소.

## 현재 문서에서 확인된 불일치

### DOC-001 — TASKS의 T0~T7이 TODO인데 README는 T0~T11 완료라고 함

- 심각도: **높음**
- 근거: `docs/TASKS.md` 상단 T0~T7은 TODO/미체크 상태지만 README 상태는 2026-09-02에 T0~T11 전체 완료라고 기록한다. 실제 git history와 구현 파일도 T0~T7 완료를 가리킨다.
- 영향: 현재 작업 상태와 의존 그래프를 신뢰할 수 없고 자동 에이전트가 완료 작업을 다시 수행할 수 있다.

### DOC-002 — CLAUDE/DESIGN의 v0.1 규칙이 현재 v0.2 구현을 금지하거나 누락함

- 심각도: **높음**
- 근거:
  - CLAUDE는 “v0.1 데이터 소스 Loyverse 단일”, “자유 SQL은 v0.1에 없다”고만 적어 현재 기본 CSV/PGlite와 완료된 `explore_sql` 정책을 충분히 반영하지 않는다.
  - DESIGN은 제목·아키텍처·디렉터리·도구 수가 v0.1/6종 중심이고 CSV/Excel, SCM, pack size, explore_sql의 정식 설계 절이 없다.
  - 구현 결정 대부분이 SPEC 후반과 TASKS 완료 로그에만 누적됐다.
- 영향: CLAUDE가 시작 문서이고 DESIGN이 구현 진실의 원천이라는 자체 규칙과 충돌한다. 후속 수정자가 오래된 규칙에 맞춰 최신 기능을 되돌릴 수 있다.

### DOC-003 — MCP 도구 수와 권한 설명이 문서마다 다름

- 심각도: **중간**
- 근거: DESIGN/초기 SPEC은 6종, 기본 서버는 5개 조회 도구에 조건부 `sync_now`와 조건부 `explore_sql`을 더한다. README 일부는 조회 도구 5종이라고 표현한다.
- 영향: 설치자가 실제 노출 도구와 필요한 권한을 예측하기 어렵다.

### DOC-004 — npm 배포 사용법과 지원 계약이 전무함

- 심각도: **치명적**
- 근거: README는 repository checkout 기준 명령만 제공하고 package install, bin, scope, 지원 Node/OS, 데이터 위치, upgrade, license를 설명하지 않는다.
- 영향: npm에 게시해도 소비자가 설치·실행할 수 없다.

### DOC-005 — 완료된 적대적 검수 문서의 lifecycle이 정의되지 않음

- 심각도: **중간**
- 근거: 001~003은 당시 실패 판정을 유지하지만 후속 수정으로 여러 항목이 해결됐다. 해결 여부·해결 commit·재검수 상태가 없다.
- 영향: 현재 결함과 역사적 결함이 섞여 출시 판정을 혼란스럽게 한다.

## 권장 수정 순서

### 1단계 — 구현 전에 규범 문서만 먼저 변경

먼저 변경할 문서는 “어떻게 동작해야 하는지”를 결정하는 문서다.

1. `SPEC.md`: npm 배포 대상 사용자, 공개/비공개 범위, CLI/MCP public contract, 데이터 보존·SCM 정책, `explore_sql` 허용 여부를 승인한다.
2. `DESIGN.md`: build/bin 구조, authoritative snapshot 교체, file idempotency, SQL 격리, atomic snapshot write를 구현 계약으로 만든다.
3. `TESTING.md`: 008의 release gate와 공격 회귀 테스트를 필수 기준으로 추가한다.
4. `TASKS.md`: 기존 T0~T27 실제 상태를 정정한 뒤 신규 수정 태스크를 의존 순서로 번호화한다.
5. `CLAUDE.md`: 위 결정이 확정된 뒤 최신 가드레일과 현재 v0.2 구조만 짧게 반영한다.

이 단계에서는 README의 “완료/사용 가능” 표현을 확대하지 않는다. 출시 차단 경고만 우선 표시할 수 있다.

### 2단계 — 신규 검수 문서 기준으로 코드와 테스트 수정

- 우선순위 P0: REL-001~004, SEC-001~002, DATA-001~004, QA-001
- 우선순위 P1: dependency/file security, SCM 정확성, Postgres component test, 운영 cleanup
- 각 항목은 실패 테스트를 먼저 추가하고 수정 후 해당 검수 문서에 해결 commit과 재검수 결과를 기록한다.
- 기존 001~003도 항목별 `OPEN/RESOLVED/SUPERSEDED` 상태를 추가해 현재성을 회복한다.

### 3단계 — 구현 완료 후 설명·운영 문서를 실제 결과에 맞춰 변경

마지막에 README, 퀵스타트, 설치/업그레이드/제거, SECURITY, CHANGELOG를 실제 tarball과 명령 출력에 맞춰 쓴다. 코드를 고치기 전에 최종 사용법을 확정 문장으로 적으면 구현 과정에서 다시 어긋날 가능성이 크다.

## 결론

“모든 기존 md를 먼저 수정”하면 아직 결정되지 않은 npm 제품 계약을 사실처럼 고정할 위험이 있다. 반대로 “코드를 먼저 수정하고 문서는 나중”이면 이 프로젝트의 문서 우선 원칙을 깨고 보안·데이터 정책을 구현자가 임의 결정하게 된다.

따라서 다음 순서를 출시 규칙으로 채택하는 것이 좋다.

```text
검수 기록 고정(004~009)
→ SPEC/DESIGN/TESTING/TASKS에서 결정·완료 기준 승인
→ 코드 + 실패 테스트 수정
→ README/CLAUDE/운영 문서를 실제 산출물에 동기화
→ npm pack/fresh-install/release gate 재검수
→ publish 승인
```

## 문서 재검수 완료 기준

- [ ] T0~T27 상태가 git history 및 검증 결과와 일치
- [ ] DESIGN이 v0.2 실제 구조와 조건부 도구를 포함
- [ ] CLAUDE 가드레일이 최신 기능과 충돌하지 않음
- [ ] README 명령을 clean tarball 설치 환경에서 그대로 재현
- [ ] 001~009 각 finding에 현재 상태와 해결 근거 기록
- [ ] 출시 시점 version/changelog/tag/package metadata 일치

