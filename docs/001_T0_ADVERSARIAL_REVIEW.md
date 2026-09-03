# 001 — T0 적대적 검수 기록

- 검수일: 2026-09-02
- 대상 커밋: `220c831` (`T0: Project scaffolding`)
- 판정(검수 당시): **조건부 실패 — 공통 게이트는 통과하지만 스캐폴딩 계약 일부가 실행 불가능하거나 강제되지 않음**
- 현재 상태(2026-09-03 재확인, docs/009 DOC-005 대응): **RESOLVED** — 아래 "재검수 완료 기준" 전 항목 [x], `fix-t0` 브랜치(2026-09-02)로 병합됨.
- 범위: 진단 및 기록만 수행. 이 문서에서는 코드를 수정하지 않는다.

## 검증 결과

```text
npm run check
Test Files  4 passed (4)
Tests       15 passed (15)
typecheck, lint, test 통과
```

현재 테스트 수는 T1·T2 구현 후 기준이다. T0 자체의 더미 테스트는 T1에서 제거되었다.

## 발견 001-01 — 완료 처리된 스크립트 중 진입점이 존재하지 않음

- 심각도: **중간**
- 영역: `package.json`, README 퀵스타트, TASKS T0 완료 범위
- 증거:
  - `dev`는 `src/server.ts`를 실행하지만 현재 파일이 없다.
  - `agent:reorder`는 `src/agent/reorder.ts`를 실행하지만 현재 파일이 없다.
  - `smoke`는 `scripts/smoke.ts`를 실행하지만 현재 파일이 없다.
  - README는 “T0 완료 후 유효”라고 안내한다.
- 영향: 사용자가 완료된 T0의 퀵스타트를 따르면 즉시 module-not-found로 실패한다. 스크립트 이름만 존재하는 상태와 실행 가능한 스캐폴딩이 구분되지 않는다.
- 요구 조치:
  1. README의 유효 시점을 실제 구현 태스크(T9/T11)에 맞추거나,
  2. T0에서 명확한 `not implemented` 메시지를 내는 임시 진입점을 제공한다.
  3. TASKS에서 “스크립트 등록”과 “스크립트 실행 가능”을 구분한다.

## 발견 001-02 — Prettier가 공통 게이트에서 강제되지 않음

- 심각도: **중간**
- 영역: `package.json`, T0의 “Prettier” 요구사항
- 증거: `format`은 쓰기 명령(`prettier --write .`)만 있고 `format:check`가 없으며 `npm run check`에도 포함되지 않는다.
- 영향: 포맷이 깨진 코드도 필수 게이트를 통과한다. 문서에 적힌 “TS strict + ESLint + Prettier” 스캐폴딩의 기계 판정이 불완전하다.
- 요구 조치: `prettier --check .` 스크립트를 추가하고 `check`에 포함하며, 의도적으로 제외할 파일은 `.prettierignore`로 관리한다.

## 발견 001-03 — 환경 파일 ignore 범위가 최소값에만 머묾

- 심각도: **낮음**
- 영역: `.gitignore`, 시크릿 가드레일
- 증거: `.env`만 제외하고 `.env.local`, `.env.development`, `.env.test.local` 같은 관례적 변형은 제외하지 않는다.
- 영향: 개발자가 변형 환경 파일에 실제 토큰을 넣으면 실수로 커밋할 수 있다.
- 요구 조치: `.env*`를 제외하고 `!.env.example`만 허용하거나, 프로젝트가 `.env` 단일 파일만 허용한다는 검증을 추가한다.

## 재검수 완료 기준

- [x] 존재하지 않는 진입점에 대한 README/TASKS 계약이 실제 상태와 일치 — `src/server.ts`/`src/agent/reorder.ts`/`scripts/smoke.ts`에 "T{n} 예정" 안내 후 종료 코드 1을 반환하는 자리표시자 추가, README 퀵스타트에 각 명령의 유효 시점 명시
- [x] 포맷 오류가 `npm run check`를 실패시킴 — `format:check`(`prettier --check .`)를 `check`에 포함. 산문 문서(`*.md`)는 `.prettierignore`로 제외(코드 포맷팅 게이트와 별개)
- [x] `.env.example` 외 환경 파일의 커밋 방지 정책 확인 — `.gitignore`를 `.env*` + `!.env.example`로 변경
- [x] `npm run check` 통과

해결 커밋: `fix-t0` 브랜치 (2026-09-02)
