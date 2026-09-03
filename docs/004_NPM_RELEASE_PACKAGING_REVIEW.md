# 004 — npm 출시·패키징 적대적 검수

- 검수일: 2026-09-03
- 대상: `package.json`, npm tarball, 설치·실행 계약
- 판정: **출시 차단 — 현재 패키지는 publish 불가이며 설치 후 실행할 공개 진입점도 없음**
- 상태: **OPEN** — 추적: `docs/TASKS.md` T29(REL-001~004), T37(재검수). 정책 확정(scope/license)은 `docs/SPEC.md` §18에 반영됨(2026-09-03).
- 검수 명령: `npm pack --dry-run --json --cache /tmp/retail-mcp-npm-cache`

## REL-001 — `private: true`로 npm publish가 명시적으로 차단됨

- 심각도: **치명적**
- 근거: `package.json`의 `private`가 `true`다. npm은 이 설정의 패키지 게시를 거부한다.
- 영향: 현재 상태에서는 인증·권한이 올바르더라도 `npm publish`가 성공할 수 없다.
- 수정 기준: 공개/비공개 배포 정책과 npm scope를 먼저 확정한 뒤 `private` 정책을 바꾼다. 공개 패키지라면 개인/조직 scope 사용과 `publishConfig.access`를 명시해 우발적 대상 변경을 막는다.

## REL-002 — 설치자가 실행할 `bin`/`exports`/`main`이 없음

- 심각도: **치명적**
- 근거: 패키지에는 `src/server.ts`, `src/cli/onboard.ts` 등이 들어가지만 `package.json`에 `bin`, `exports`, `main`이 없다. Node 기본 진입점인 루트 `index.js`도 없다.
- 영향: `npm install retail-mcp`, `npx retail-mcp`, 라이브러리 import 중 어느 사용 방식도 성립하지 않는다. 저장소 안의 `npm run ...`만 동작한다.
- 수정 기준: 제품의 공개 계약을 먼저 고른다.
  - CLI/MCP 서버 제품이면 빌드된 JS 실행 파일에 shebang을 붙이고 `bin`을 등록한다.
  - 라이브러리도 제공하면 `exports`와 타입 선언을 별도로 정의한다.
  - tarball을 임시 디렉터리에 설치해 `npx <bin> --help` 또는 MCP initialize까지 검증한다.

## REL-003 — 배포물이 TypeScript 소스인데 실행기 `tsx`는 devDependency임

- 심각도: **치명적**
- 근거: tarball에는 `.ts` 소스만 있고 `dist/`가 없다. 실행 스크립트는 `tsx`를 호출하지만 `tsx`는 `devDependencies`에 있어 일반 운영 설치에서 보장되지 않는다.
- 영향: package script를 직접 호출하더라도 `npm install --omit=dev` 환경에서는 실행할 수 없다.
- 수정 기준: `prepack`에서 JS와 `.d.ts`를 `dist/`로 빌드하고 운영 진입점은 Node로 실행한다. 빌드 결과만으로 fresh install smoke test를 통과해야 한다.

## REL-004 — 배포 파일 allowlist가 없어 개발·테스트 자산 97개가 게시됨

- 심각도: **높음**
- 근거: `.npmignore`와 `package.json.files`가 없어 npm이 `.gitignore` fallback을 사용한다. dry-run tarball은 테스트 전체, 테스트 fixture, 기존 적대적 검수 문서, ESLint/Vitest 설정, 원시 fixture 95KB 등을 포함해 823,508 bytes로 풀린다.
- 영향: 설치 크기와 공개 공격 표면이 불필요하게 늘고, 향후 로컬 전용 fixture나 내부 문서가 실수로 배포될 수 있다.
- 수정 기준: `files` allowlist를 우선 사용해 `dist`, 런타임 migration/template, README, LICENSE처럼 필요한 파일만 포함한다. `npm pack --dry-run` 결과 파일 목록을 출시 게이트로 고정한다.

## REL-005 — 라이선스와 패키지 출처 메타데이터가 없음

- 심각도: **높음**
- 근거: LICENSE 파일과 `package.json.license`, `repository`, `bugs`, `homepage`, `author`가 없다.
- 영향: 외부 사용자가 합법적으로 재사용·배포할 조건과 소스/이슈 위치를 판단할 수 없다. 공개 npm 배포 준비가 완료됐다고 보기 어렵다.
- 수정 기준: 권리자가 라이선스를 결정한 뒤 LICENSE와 메타데이터를 일치시킨다. 라이선스 결정 전에는 publish하지 않는다.

## REL-006 — 설치·업그레이드·제거 및 데이터 경로 계약이 없음

- 심각도: **높음**
- 근거: README는 저장소 clone 후 `npm install` 흐름만 설명한다. npm registry 설치, CLI 이름, 현재 작업 디렉터리에 생성되는 `.retail-mcp/data`, migration/업그레이드, 제거 시 데이터 보존 여부가 없다.
- 영향: 전역 실행이나 다른 working directory에서 서로 다른 DB가 생성될 수 있고, 사용자는 데이터 위치와 백업 방법을 알 수 없다.
- 수정 기준: OS별 안정적인 사용자 데이터 디렉터리 또는 명시적 `RETAIL_MCP_DATA_DIR` 요구를 결정하고 install/upgrade/uninstall/backup 문서를 추가한다.

## REL-007 — publish 전 자동 차단 게이트가 없음

- 심각도: **높음**
- 근거: `prepublishOnly`/`prepack`/release script가 없어서 `npm run check`, coverage, audit, pack 검증 없이 게시 명령을 실행할 수 있다.
- 영향: 로컬 상태나 CI 실수로 검증되지 않은 tarball이 영구적인 npm version으로 올라갈 수 있다.
- 수정 기준: 최소 `clean → build → check → coverage → pack/install smoke`를 자동 실행하고, CI trusted publishing/provenance와 승인 단계를 별도로 둔다.

## REL-008 — 패키지명·소유권·공개 범위가 검증되지 않음

- 심각도: **높음**
- 근거: 현재 이름은 unscoped `retail-mcp`이며 저장소에는 npm owner/scope 결정 기록이 없다. `npm view retail-mcp name version owners --json`의 2026-09-03 응답은 단순 신규 이름이 아니라 **2026-01-12에 unpublished된 패키지**라는 E404를 반환했다. 이 응답만으로 현재 계정이 이름을 다시 사용할 수 있다는 뜻은 아니다. unscoped 이름은 사용자 계정 소유의 공개 패키지가 된다.
- 영향: 이름이 이미 점유됐거나 조직 소유로 게시해야 하는 경우 마지막 단계에서 실패하거나 잘못된 namespace로 공개될 수 있다.
- 수정 기준: `npm whoami`, npm 웹 UI/owner 정책, unpublished 이름 재사용 가능 여부, scope 및 공개/제한 배포를 사람이 확인한다. 조직 제품이면 `@org/retail-mcp`를 우선 검토한다.

## 출시 재검수 기준

- [ ] publish 대상(scope/access/registry/license) 승인
- [ ] `private` 정책, `bin`/`exports`, build 산출물 확정
- [ ] allowlist 기반 tarball 내용 검수
- [ ] tarball fresh install 후 운영 의존성만으로 CLI/MCP 실행
- [ ] 자동 release gate와 provenance/2FA 절차 확인
