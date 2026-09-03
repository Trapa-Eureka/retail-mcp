#!/usr/bin/env node
/**
 * npm 배포 전용 migration CLI(`retail-mcp-migrate`) — 2차 적대적 검수 SR2-REL-001 대응.
 *
 * `DATABASE_URL`(Neon/Supabase 등 network Postgres)을 선택한 npm 설치 사용자는 게시된
 * 패키지 안에 스키마를 적용할 공식 명령이 없었다 — `scripts/migrate.ts`는 저장소 전용이라
 * npm 패키지엔 포함되지 않고(CLAUDE.md 소스 레이아웃), `package.json.bin`엔 server/onboard만
 * 등록돼 있었다. 이 파일이 그 간극을 메운다 — `package.json.bin["retail-mcp-migrate"]`가
 * 빌드된 `dist/cli/migrate.js`를 가리킨다.
 *
 * 실제 적용/점검 로직(advisory lock 포함)은 `scripts/migrate.ts`(저장소 전용)와 함께
 * `src/adapters/migratePg.ts`를 공유한다. 다만 이 bin은 npm으로 처음 설치해 처음 쓰는
 * 사람도 안전해야 하므로 사람 확인 가드를 하나 더 둔다 — 기본은 **dry-run**(대상 DB
 * host/db명과 대기 중인 마이그레이션 목록만 보여주고 아무것도 적용하지 않음), 실제 적용은
 * `--confirm`을 명시해야 한다(가드레일 1의 `SEND_MODE=dry_run` + `--confirm` 이중 게이트와
 * 같은 패턴을 migration에도 적용한 것). CLAUDE.md 가드레일 5("프로덕션 마이그레이션은
 * 사람만")는 이 bin이 있어도 여전히 유효하다 — 이 게이트는 그 "사람"이 실수로 자동화
 * 파이프라인에 실려 확인 없이 실행되는 걸 한 번 더 막는다.
 *
 * `DATABASE_URL` 원문(자격증명 포함)은 어떤 출력에도 남기지 않는다(CLAUDE.md 구현 해석
 * 보충) — host/db명만 보여준다(describeTarget).
 */
import { isMainModule } from "../adapters/mainModule.js";
import {
  applyMigrationsToDatabaseUrl,
  checkPendingMigrationsForDatabaseUrl,
} from "../adapters/migratePg.js";

/** DATABASE_URL에서 자격증명을 뺀 host[:port]/dbname만 뽑는다 — 로그에 원문을 남기지 않기
 * 위해서다. 파싱 자체가 실패해도(형식이 이상한 값) 에러를 던지지 않고 안내 문구로 대체한다. */
export function describeTarget(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(연결 문자열을 해석할 수 없어 대상을 표시할 수 없습니다)";
  }
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL이 없습니다. Neon/Supabase 등에서 발급한 Postgres 연결 문자열을 .env에 추가하세요.",
    );
  }

  const target = describeTarget(databaseUrl);
  const confirm = argv.includes("--confirm");

  if (!confirm) {
    const { pending } = await checkPendingMigrationsForDatabaseUrl(databaseUrl);
    if (pending.length === 0) {
      console.log(
        `[dry-run] 대상: ${target} — 대기 중인 마이그레이션이 없습니다. 실행할 것이 없습니다.`,
      );
      return;
    }
    console.log(
      `[dry-run] 대상: ${target}\n` +
        `적용될 마이그레이션(${pending.length}건): ${pending.join(", ")}\n` +
        "실제로 적용하려면 --confirm을 붙여 다시 실행하세요: retail-mcp-migrate --confirm",
    );
    return;
  }

  console.log(`대상: ${target} — 마이그레이션을 적용합니다...`);
  const result = await applyMigrationsToDatabaseUrl(databaseUrl);
  console.log(
    `마이그레이션 완료 — 적용 ${result.applied.length}건 (${result.applied.join(", ") || "없음"}), ` +
      `건너뜀 ${result.skipped.length}건`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
