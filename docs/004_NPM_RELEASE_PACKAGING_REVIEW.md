# 004 — npm 출시·패키징 적대적 검수

- 검수일: 2026-09-03
- 대상: `package.json`, npm tarball, 설치·실행 계약
- 판정: **출시 차단 — 현재 패키지는 publish 불가이며 설치 후 실행할 공개 진입점도 없음**
- 상태: **부분 RESOLVED(T29, PR #40, 2026-09-03)** — REL-001~005는 해결. REL-006(설치/업그레이드 문서)은 T36에서 README에 문서화(마이그레이션 CLI 미포함 간극은 명시적으로 남겨두고 T37로 이관). REL-007(전체 release gate)은 T37에서 `prepublishOnly` 연결로 RESOLVED(2026-09-04). REL-008은 T37에서 `npm view` 404(이름 사용 가능, 사용자 결정: 재사용 무관)까지 확인했고 **scope `@trapa-eureka`의 npm 조직 소유권은 사람 확인 대기**(`npm org ls trapa-eureka` 403 — `docs/TASKS.md` T37 체크리스트). 정책 확정(scope/license)은 `docs/SPEC.md` §18에 반영됨.
- 검수 명령: `npm pack --dry-run --json --cache /tmp/retail-mcp-npm-cache`

## REL-001 — `private: true`로 npm publish가 명시적으로 차단됨

- 심각도: **치명적**
- 근거: `package.json`의 `private`가 `true`다. npm은 이 설정의 패키지 게시를 거부한다.
- 영향: 현재 상태에서는 인증·권한이 올바르더라도 `npm publish`가 성공할 수 없다.
- 수정 기준: 공개/비공개 배포 정책과 npm scope를 먼저 확정한 뒤 `private` 정책을 바꾼다. 공개 패키지라면 개인/조직 scope 사용과 `publishConfig.access`를 명시해 우발적 대상 변경을 막는다.
- **해결(T29)**: `private` 제거, `name: "@trapa-eureka/retail-mcp"`, `publishConfig.access: "public"` 명시.

## REL-002 — 설치자가 실행할 `bin`/`exports`/`main`이 없음

- 심각도: **치명적**
- 근거: 패키지에는 `src/server.ts`, `src/cli/onboard.ts` 등이 들어가지만 `package.json`에 `bin`, `exports`, `main`이 없다. Node 기본 진입점인 루트 `index.js`도 없다.
- 영향: `npm install retail-mcp`, `npx retail-mcp`, 라이브러리 import 중 어느 사용 방식도 성립하지 않는다. 저장소 안의 `npm run ...`만 동작한다.
- 수정 기준: 제품의 공개 계약을 먼저 고른다.
  - CLI/MCP 서버 제품이면 빌드된 JS 실행 파일에 shebang을 붙이고 `bin`을 등록한다.
  - 라이브러리도 제공하면 `exports`와 타입 선언을 별도로 정의한다.
  - tarball을 임시 디렉터리에 설치해 `npx <bin> --help` 또는 MCP initialize까지 검증한다.
- **해결(T29)**: `bin`에 `retail-mcp`(`dist/server.js`)·`retail-mcp-onboard`(`dist/cli/onboard.js`) 등록, `main: "dist/server.js"`. `exports`(라이브러리 계약)는 범위 밖으로 명시적으로 제외(DESIGN §12.1 — CLI/MCP 서버 제품으로만 배포). tarball fresh-install + MCP initialize + onboard 실행까지 `scripts/verifyPack.ts`(QA-001)로 검증 — 이 과정에서 두 가지 실제 결함을 추가로 발견·수정했다: (1) `isMainModule` 판정이 `process.argv[1] === fileURLToPath(import.meta.url)`로 심볼릭 링크(npm bin)를 통과하면 항상 false가 되어 `main()`이 전혀 실행되지 않던 결함(`src/adapters/mainModule.ts`로 분리, realpath 비교로 수정), (2) `readline/promises`의 `rl.question()`을 파이프 입력으로 반복 호출하면 첫 질문만 응답받고 이후는 영원히 멈추는 Node 자체의 알려진 동작(`createReadlineAsk()`로 비동기 이터레이터 소비 방식으로 교체).

## REL-003 — 배포물이 TypeScript 소스인데 실행기 `tsx`는 devDependency임

- 심각도: **치명적**
- 근거: tarball에는 `.ts` 소스만 있고 `dist/`가 없다. 실행 스크립트는 `tsx`를 호출하지만 `tsx`는 `devDependencies`에 있어 일반 운영 설치에서 보장되지 않는다.
- 영향: package script를 직접 호출하더라도 `npm install --omit=dev` 환경에서는 실행할 수 없다.
- 수정 기준: `prepack`에서 JS와 `.d.ts`를 `dist/`로 빌드하고 운영 진입점은 Node로 실행한다. 빌드 결과만으로 fresh install smoke test를 통과해야 한다.
- **해결(T29)**: `tsconfig.build.json`(`rootDir: src`, `outDir: dist`, `src/mocks/**` 제외 — 런타임에 쓰이지 않음을 grep으로 확인) + `npm run build`(`tsc -p tsconfig.build.json` + bin 파일 `chmod +x`), `package.json.scripts.prepack`이 자동 호출. `tsx`는 devDependency로 유지(저장소 내 개발용 `npm run dev` 등만 사용). **착수 중 추가 발견**: `@electric-sql/pglite`가 `devDependencies`에 있었는데 실제로는 임베디드 웨어하우스 기본 경로(`warehouseFactory.ts`, 운영 런타임)가 이를 직접 import — `npm install --omit=dev`로 설치하면 `ERR_MODULE_NOT_FOUND`로 즉시 죽었다. `dependencies`로 옮겨 해결.

## REL-004 — 배포 파일 allowlist가 없어 개발·테스트 자산 97개가 게시됨

- 심각도: **높음**
- 근거: `.npmignore`와 `package.json.files`가 없어 npm이 `.gitignore` fallback을 사용한다. dry-run tarball은 테스트 전체, 테스트 fixture, 기존 적대적 검수 문서, ESLint/Vitest 설정, 원시 fixture 95KB 등을 포함해 823,508 bytes로 풀린다.
- 영향: 설치 크기와 공개 공격 표면이 불필요하게 늘고, 향후 로컬 전용 fixture나 내부 문서가 실수로 배포될 수 있다.
- 수정 기준: `files` allowlist를 우선 사용해 `dist`, 런타임 migration/template, README, LICENSE처럼 필요한 파일만 포함한다. `npm pack --dry-run` 결과 파일 목록을 출시 게이트로 고정한다.
- **해결(T29)**: `package.json.files = ["dist", "migrations", "README.md", "LICENSE", ".env.example"]`. `npm pack --dry-run` 결과 97개(823,508 bytes) → 63개(unpacked 301.2kB)로 축소, 테스트·fixture·내부 검수 문서·ESLint/Vitest 설정 전부 제외 확인.

## REL-005 — 라이선스와 패키지 출처 메타데이터가 없음

- 심각도: **높음**
- 근거: LICENSE 파일과 `package.json.license`, `repository`, `bugs`, `homepage`, `author`가 없다.
- 영향: 외부 사용자가 합법적으로 재사용·배포할 조건과 소스/이슈 위치를 판단할 수 없다. 공개 npm 배포 준비가 완료됐다고 보기 어렵다.
- 수정 기준: 권리자가 라이선스를 결정한 뒤 LICENSE와 메타데이터를 일치시킨다. 라이선스 결정 전에는 publish하지 않는다.
- **해결(T29)**: 사용자 확인(MIT)에 따라 `LICENSE` 신설 + `package.json`의 `license`/`author`/`repository`/`bugs`/`homepage` 전부 채움(GitHub 조직 `Trapa-Eureka`의 실제 원격 저장소 값 그대로 사용).

## REL-006 — 설치·업그레이드·제거 및 데이터 경로 계약이 없음

- 심각도: **높음**
- 근거: README는 저장소 clone 후 `npm install` 흐름만 설명한다. npm registry 설치, CLI 이름, 현재 작업 디렉터리에 생성되는 `.retail-mcp/data`, migration/업그레이드, 제거 시 데이터 보존 여부가 없다.
- 영향: 전역 실행이나 다른 working directory에서 서로 다른 DB가 생성될 수 있고, 사용자는 데이터 위치와 백업 방법을 알 수 없다.
- 수정 기준: OS별 안정적인 사용자 데이터 디렉터리 또는 명시적 `RETAIL_MCP_DATA_DIR` 요구를 결정하고 install/upgrade/uninstall/backup 문서를 추가한다.
- **부분 해결(T36, 2026-09-03)**: README에 "설치(npm 게시 후)" 절을 신설 — 정책 자체는 이미 코드로 확정돼 있던 것(CWD 기준 `.retail-mcp/data`, `RETAIL_MCP_DATA_DIR` override, `warehouseFactory.ts`)을 문서화만 했다. install(`npm install -g`)/업그레이드(`npm install -g @latest`, 마이그레이션 순번+체크섬으로 안전)/제거(`npm uninstall -g`, 데이터는 안 지워짐) 절차를 명시. **착수 중 발견한 진짜 간극**: 외부 `DATABASE_URL`(Neon 등) 사용자를 위한 마이그레이션 CLI가 게시된 npm 패키지에 없다 — `scripts/migrate.ts`는 `package.json.files`/`tsconfig.build.json`의 `dist` 빌드 산출물에 포함되지 않는 저장소 전용 스크립트다(devDependency `tsx` 필요). 임베디드 PGlite 경로는 자동 마이그레이션이라 영향 없다. 이 간극은 README에 명시하고 **T37에서 마이그레이션 bin 추가 여부를 결정**하도록 남겨뒀다(코드 변경은 T36 범위 밖).
- **완전 해결(2026-09-04, 2차 적대적 검수 SR2-REL-001)**: `retail-mcp-migrate` bin을 `package.json.bin`에 등록하고 `src/cli/migrate.ts`로 구현 — 기본 dry-run(대상 host/db명·대기 중인 마이그레이션 목록만 표시, 자격증명은 안 보임), 실제 적용은 `--confirm`(가드레일 1의 dry_run+--confirm 이중 게이트와 같은 패턴을 migration에도 적용). `server.ts`/`agent/reorder.ts`/`agent/folderScan.ts`는 `DATABASE_URL` 경로 기동 시 `ensureNetworkMigrationsApplied()`(`warehouseFactory.ts`)로 스키마 누락을 raw Postgres 에러 대신 이 명령을 안내하는 에러로 즉시 알린다. `scripts/verifyPack.ts`(release gate)가 실제 tarball에서 bin 실행·에러 경로를 확인하고, `tests/component/postgres.component.test.ts`가 real Postgres 대상 적용·멱등성을 확인한다.

## REL-007 — publish 전 자동 차단 게이트가 없음

- 심각도: **높음**
- 근거: `prepublishOnly`/`prepack`/release script가 없어서 `npm run check`, coverage, audit, pack 검증 없이 게시 명령을 실행할 수 있다.
- 영향: 로컬 상태나 CI 실수로 검증되지 않은 tarball이 영구적인 npm version으로 올라갈 수 있다.
- 수정 기준: 최소 `clean → build → check → coverage → pack/install smoke`를 자동 실행하고, CI trusted publishing/provenance와 승인 단계를 별도로 둔다.
- 부분 진행(T29): `prepack`이 `build`를 자동 호출해 최소한 "빌드 안 된 채로 pack되는" 사고는 막는다. `npm run verify:pack`(pack/install smoke)은 만들었지만 아직 `prepublishOnly`에 연결하지 않았다 — 전체 게이트 연결은 T37.
- **RESOLVED(T37, 2026-09-04)**: `package.json`에 `prepublishOnly: npm run check && npm run verify:pack`을 연결했다 — `npm publish`가 어디서 실행되든(로컬/CI) typecheck·lint·format·전체 테스트 → clean build → `npm pack` allowlist → `--omit=dev` fresh install → bin 3종 smoke → tarball 기준 audit을 통과하지 못하면 게시가 중단된다. coverage threshold·lockfile audit·secret scan은 매 PR의 CI가 이미 필수 check(SR2-CI-004 ruleset)로 막고 있어 로컬 publish 훅에 중복해서 넣지 않았다(무겁고, main에 머지된 커밋만 게시 대상이므로 이미 통과한 상태). "CI trusted publishing/provenance와 승인 단계"는 T37 사람 확인 항목(`docs/TASKS.md` T37)으로 분리 — 로컬 publish(provenance 없음) vs. release 워크플로(OIDC provenance) 결정은 사용자가.

## REL-008 — 패키지명·소유권·공개 범위가 검증되지 않음

- 심각도: **높음**
- 근거: 현재 이름은 unscoped `retail-mcp`이며 저장소에는 npm owner/scope 결정 기록이 없다. `npm view retail-mcp name version owners --json`의 2026-09-03 응답은 단순 신규 이름이 아니라 **2026-01-12에 unpublished된 패키지**라는 E404를 반환했다. 이 응답만으로 현재 계정이 이름을 다시 사용할 수 있다는 뜻은 아니다. unscoped 이름은 사용자 계정 소유의 공개 패키지가 된다.
- 영향: 이름이 이미 점유됐거나 조직 소유로 게시해야 하는 경우 마지막 단계에서 실패하거나 잘못된 namespace로 공개될 수 있다.
- 수정 기준: `npm whoami`, npm 웹 UI/owner 정책, unpublished 이름 재사용 가능 여부, scope 및 공개/제한 배포를 사람이 확인한다. 조직 제품이면 `@org/retail-mcp`를 우선 검토한다.
- 완화(T29): scoped 이름 `@trapa-eureka/retail-mcp` 채택으로 unscoped `retail-mcp` 재사용 불확실성 자체를 회피(SPEC §18). 다만 `npm whoami`/조직 계정 접근권한 확인은 여전히 사람이 해야 하는 항목 — T37에서 진행.

## 출시 재검수 기준

- [x] publish 대상(scope/access/registry/license) 승인 — `@trapa-eureka/retail-mcp`, public, MIT(SPEC §18, T29)
- [x] `private` 정책, `bin`/`exports`, build 산출물 확정(T29 — `exports`는 의도적으로 미제공)
- [x] allowlist 기반 tarball 내용 검수(T29, `npm pack --dry-run` 61→63개 파일로 재확인 완료)
- [x] tarball fresh install 후 운영 의존성만으로 CLI/MCP 실행(T29, `scripts/verifyPack.ts`)
- [ ] 자동 release gate와 provenance/2FA 절차 확인 — T37(008 8단계 release gate)에서 진행
