# 보안 정책

`@trapa-eureka/retail-mcp`(리테일 다지점 셀스루·재고 BI MCP 서버 + 재주문 제안 에이전트)의 취약점 신고 절차입니다. `docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md` SEC-007 대응(TASKS T32)으로 작성됐습니다.

## 지원 버전

npm 공개 배포 전(`docs/TASKS.md` T37 통과 전까지 `npm publish` 보류 — 진행 상황은 README의 "출시 차단" 배너 참고)이라 아직 released major/minor 버전 구분이 없습니다. 배포 전에는 **`main` 브랜치 최신 커밋만** 보안 패치 대상입니다. npm 배포 이후에는 이 절을 최신 major 버전(예: `1.x`) 기준으로 갱신합니다.

| 버전 | 지원 여부 |
|---|---|
| `main`(배포 전) | ✅ |
| 배포된 최신 major | 배포 후 갱신 예정 |
| 그 이전 major | 배포 후 갱신 예정 |

## 취약점 신고 방법

**공개 GitHub 이슈로 신고하지 마세요** — 패치가 나오기 전에 공격 방법이 노출됩니다.

대신 GitHub의 비공개 신고 채널을 이용해주세요:

**[Trapa-Eureka/retail-mcp → Security → Report a vulnerability](https://github.com/Trapa-Eureka/retail-mcp/security/advisories/new)**

신고에 다음을 포함해주시면 대응이 빨라집니다:

- 영향받는 파일/버전(가능하면 커밋 해시)
- 재현 절차 또는 PoC
- 예상 영향(예: 정보 노출, 웨어하우스 쓰기, 임의 코드 실행)
- 알고 있는 완화 방법이 있다면 함께

## 대응 목표

이 프로젝트는 1인 유지보수 체제입니다 — 기업형 보안팀 SLA를 약속드릴 수는 없지만, 아래를 목표로 합니다:

- **최초 응답**: 신고 접수 후 5영업일 이내
- **심각도 평가 공유**: 최초 응답 후 5영업일 이내
- **치명적(Critical)/높음(High) 등급**: 확인 즉시 최우선으로 패치 착수, 목표 30일 이내 패치 배포
- **패치 공개**: 신고자와 조율한 시점에 CHANGELOG·GitHub Security Advisory로 공개(신고자 원하면 credit 표기)

## 이 프로젝트의 알려진 보안 설계 경계

정식 신고 전에 아래를 먼저 확인해주세요 — 이미 알려져 있고 설계상 의도된 동작이거나, 대응이 진행 중인 항목입니다.

- **`explore_sql`(임의 SELECT 조회 도구)**: 운영 기본값은 비활성(`EXPLORE_SQL_ENABLED=false`). 켤 때는 함수 실행 권한이 제한된 전용 DB role을 강력히 권장하며, 임베디드 PGlite(role 분리 불가)에서는 `EXPLORE_SQL_ALLOW_PGLITE=true`를 명시하지 않으면 아예 켜지지 않습니다 — `docs/DESIGN.md` §12.4, `docs/005` SEC-001/002.
- **CSV/XLSX 파일 크기·행·셀 길이 상한**: `src/adapters/fileLimits.ts` 참고 — XLSX는 zip 압축폭탄의 shared-strings 캐시 단계처럼 상한 검사 이전에 이미 메모리에 펼쳐지는 잔여 위험이 문서화돼 있습니다.
- **스냅샷 CSV formula injection escape**: 매장명·상품명·SKU만 대상입니다(`src/core/csvSafety.ts`) — 다른 자유 텍스트 필드가 추가되면 같은 escape를 적용해야 합니다.
- **CI 보안 게이트**(`.github/workflows/ci.yml`, TASKS T35): 매 push/PR에서 dependency audit(lockfile 기준, 승인되지 않은 새 취약점은 fail-closed로 막음), 커밋된 시크릿 패턴 스캔(현재 트리 전체 + PR/push의 `base..head` 범위 안 **모든 커밋**에 새로 들어온 blob — 중간 커밋에 넣고 지운 시크릿도 잡는다, 2차 적대적 검수 SR2-SEC-003), SBOM(CycloneDX) 생성, 게시 tarball 기준 audit(`npm run verify:pack`)을 자동으로 돕니다 — `src/adapters/auditLockfile.ts`/`src/core/secretScan.ts` 참고. 워크플로 전체 `GITHUB_TOKEN` 권한은 최소값(`contents: read`)으로 고정돼 있습니다(2차 적대적 검수 SR2-CI-001) — fork PR 코드가 repository 기본 권한이 나중에 넓어져도 그걸 상속하지 않습니다. CI가 실행하는 외부 코드도 immutable하게 고정돼 있습니다(SR2-CI-002) — 모든 Action은 이동 가능한 `@v4` 태그가 아니라 full commit SHA(태그는 주석), Postgres 서비스 컨테이너는 manifest digest로 참조하므로 upstream 태그가 옮겨지거나 침해돼도 같은 커밋의 CI는 같은 코드를 실행합니다. SHA 갱신은 Dependabot(`.github/dependabot.yml`, 월 1회)이 PR로 제안하고 사람이 검토·머지합니다.
- 이 외 진행 중인 항목은 `docs/004~009`(적대적 검수 결과)와 `docs/TASKS.md` T28~T37에서 추적합니다.

## 범위

- 이 저장소의 코드(`src/`, `migrations/`, `scripts/`)와 공식 배포 산출물(npm 패키지)
- 이 프로젝트가 직접 관리하지 않는 것(Loyverse API 자체, Resend 서비스 자체, 사용자가 스스로 구성한 Postgres 인스턴스)은 범위 밖입니다 — 해당 서비스의 보안 채널로 신고해주세요.
