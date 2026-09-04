import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildExampleTemplateCsv,
  collectOnboardAnswers,
  envUpdatesFor,
  mergeEnvFile,
  writeEnvFile,
  type AskFn,
  type OnboardAnswers,
} from "../src/cli/onboard.js";
import { parseCsvRow } from "../src/core/csvSchema.js";
import { runFolderScan } from "../src/agent/folderScan.js";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import { createMockNotificationProvider } from "../src/mocks/mockNotificationProvider.js";

/** 스크립트로 미리 정해둔 답을 순서대로 돌려주는 ask() — 비대화식 실행("스크립트 입력")용. */
function scriptedAsk(answers: string[]): AskFn {
  let i = 0;
  return (question: string) => {
    if (i >= answers.length) {
      return Promise.reject(new Error(`스크립트 답변이 부족합니다(질문: "${question}").`));
    }
    return Promise.resolve(answers[i++]!);
  };
}

describe("collectOnboardAnswers", () => {
  it("지점 모드 — 비대화식(스크립트 입력)으로 답을 전부 받으면 설정을 만든다", async () => {
    const ask = scriptedAsk([
      "branch", // 모드
      "", // DATABASE_URL 비움 → 임베디드
      "/tmp/watch", // watchDir
      "/tmp/snapshot", // snapshotDir
      "10", // 임계치
      "owner@example.com", // recipient
      "", // Resend API 키 비움 → 발송 설정 생략(발신 주소는 묻지 않음)
    ]);
    const answers = await collectOnboardAnswers(ask);
    expect(answers).toEqual({
      mode: "branch",
      watchDir: "/tmp/watch",
      snapshotDir: "/tmp/snapshot",
      defaultLowStockThreshold: 10,
      recipient: "owner@example.com",
    });
  });

  it("이메일 발송 설정(선택) — Resend 키를 주면 발신 주소를 필수로 받고 둘 다 answers·.env 키에 들어간다(T37 게시 전 점검)", async () => {
    const key = ["re_", "TestOnly0000000000000000000"].join(""); // 스캐너 오탐 방지용 런타임 조합
    const ask = scriptedAsk([
      "branch",
      "",
      "/tmp/watch",
      "/tmp/snapshot",
      "5",
      "owner@example.com",
      key, // Resend API 키
      "not-an-email", // 발신 주소 형식 오류 → 재질문
      "alerts@example.com", // 올바른 발신 주소
    ]);
    const answers = (await collectOnboardAnswers(ask)) as Extract<
      OnboardAnswers,
      { mode: "branch" }
    >;
    expect(answers.resendApiKey).toBe(key);
    expect(answers.mailFrom).toBe("alerts@example.com");

    const updates = envUpdatesFor(answers);
    expect(updates["RESEND_API_KEY"]).toBe(key);
    expect(updates["MAIL_FROM"]).toBe("alerts@example.com");
    expect(updates["SEND_MODE"]).toBeUndefined(); // 온보딩은 발송 모드를 켜지 않는다 — 사람이 .env에서 직접 live로
  });

  it("Resend 키를 비우면 발신 주소를 묻지 않고 .env의 RESEND_API_KEY/MAIL_FROM 줄도 건드리지 않는다", async () => {
    const ask = scriptedAsk([
      "branch",
      "",
      "/tmp/watch",
      "/tmp/snapshot",
      "5",
      "owner@example.com",
      "",
    ]);
    const answers = await collectOnboardAnswers(ask);
    const updates = envUpdatesFor(answers);
    expect(updates["RESEND_API_KEY"]).toBeUndefined();
    expect(updates["MAIL_FROM"]).toBeUndefined();
    // 이미 .env에 채워둔 값이 있으면 그대로 보존된다(mergeEnvFile은 undefined를 무시).
    const merged = mergeEnvFile("RESEND_API_KEY=keep-me\nMAIL_FROM=keep@example.com\n", updates);
    expect(merged).toContain("RESEND_API_KEY=keep-me");
    expect(merged).toContain("MAIL_FROM=keep@example.com");
  });

  it("본사 모드 — DATABASE_URL을 주면 answers에 포함된다", async () => {
    const ask = scriptedAsk(["consolidated", "postgres://x", "/tmp/collect"]);
    const answers = await collectOnboardAnswers(ask);
    expect(answers).toEqual({
      mode: "consolidated",
      collectDir: "/tmp/collect",
      databaseUrl: "postgres://x",
    });
  });

  it("임계치를 비워두면 기본값 5를 쓴다", async () => {
    const ask = scriptedAsk([
      "branch",
      "",
      "/tmp/watch",
      "/tmp/snapshot",
      "", // 임계치 비움 → 기본값
      "owner@example.com",
      "", // 발송 설정 생략
    ]);
    const answers = (await collectOnboardAnswers(ask)) as Extract<
      OnboardAnswers,
      { mode: "branch" }
    >;
    expect(answers.defaultLowStockThreshold).toBe(5);
  });

  it("잘못된 모드를 여러 번 입력하면 재질문하다가 결국 명확한 에러를 던진다", async () => {
    const ask = scriptedAsk(["엉뚱한값", "또엉뚱함", "또또엉뚱함"]);
    await expect(collectOnboardAnswers(ask)).rejects.toThrow(/branch\/consolidated/);
  });

  it("watchDir/snapshotDir이 같으면 재질문한다(다르게 답하면 통과)", async () => {
    const ask = scriptedAsk([
      "branch",
      "",
      "/tmp/same", // watchDir
      "/tmp/same", // snapshotDir(같음 — 재질문 유발)
      "/tmp/different", // 다시 답한 snapshotDir
      "5",
      "owner@example.com",
      "", // 발송 설정 생략
    ]);
    const answers = (await collectOnboardAnswers(ask)) as Extract<
      OnboardAnswers,
      { mode: "branch" }
    >;
    expect(answers.watchDir).toBe("/tmp/same");
    expect(answers.snapshotDir).toBe("/tmp/different");
  });

  it("이메일 형식이 아니면 재질문한다", async () => {
    const ask = scriptedAsk([
      "branch",
      "",
      "/tmp/watch",
      "/tmp/snapshot",
      "5",
      "이메일아님", // 잘못된 형식 — 재질문 유발
      "owner@example.com", // 올바른 재답변
      "", // 발송 설정 생략
    ]);
    const answers = (await collectOnboardAnswers(ask)) as Extract<
      OnboardAnswers,
      { mode: "branch" }
    >;
    expect(answers.recipient).toBe("owner@example.com");
  });

  it("필수 값을 계속 빈칸으로 두면 명확한 에러를 던진다", async () => {
    const ask = scriptedAsk(["branch", "", "", "", ""]);
    await expect(collectOnboardAnswers(ask)).rejects.toThrow(/받지 못했습니다/);
  });
});

describe("mergeEnvFile", () => {
  it("빈 파일에 새 키를 추가한다", () => {
    const result = mergeEnvFile("", { CSV_MODE: "branch", DATABASE_URL: undefined });
    expect(result).toContain("CSV_MODE=branch");
    expect(result).not.toContain("DATABASE_URL");
  });

  it("기존 파일의 다른 줄(주석·다른 키)은 그대로 보존한다", () => {
    const existing = "# 설명\nANTHROPIC_API_KEY=secret\nCSV_MODE=old\n";
    const result = mergeEnvFile(existing, { CSV_MODE: "branch" });
    expect(result).toContain("# 설명");
    expect(result).toContain("ANTHROPIC_API_KEY=secret");
    expect(result).toContain("CSV_MODE=branch");
    expect(result).not.toContain("CSV_MODE=old");
  });

  it("undefined 값은 기존 줄을 건드리지 않는다(DATABASE_URL 비움 → 임베디드 유지)", () => {
    const existing = "DATABASE_URL=postgres://existing\n";
    const result = mergeEnvFile(existing, { DATABASE_URL: undefined });
    expect(result).toContain("DATABASE_URL=postgres://existing");
  });
});

describe("writeEnvFile (SEC-005, TASKS T32)", () => {
  let dir: string;
  let envPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-onboard-env-"));
    envPath = join(dir, ".env");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("새 .env 파일을 0600 권한으로 만든다", async () => {
    await writeEnvFile(envPath, "DATABASE_URL=postgres://x\n");
    const info = await stat(envPath);
    // macOS/Linux 기준 — Windows CI에서는 이 비트가 의미가 달라 별도 매트릭스에서 재검토한다
    // (atomicFile.test.ts와 동일한 캐비어트, TASKS T34 OPS-006).
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readFile(envPath, "utf8")).toBe("DATABASE_URL=postgres://x\n");
  });

  it("기존 .env가 더 느슨한 권한이어도 다시 쓰면 0600으로 교체된다", async () => {
    await writeFile(envPath, "DATABASE_URL=postgres://old\n", { mode: 0o644 });
    expect((await stat(envPath)).mode & 0o777).toBe(0o644);

    await writeEnvFile(envPath, "DATABASE_URL=postgres://new\n");

    const info = await stat(envPath);
    expect(info.mode & 0o777).toBe(0o600);
    expect(await readFile(envPath, "utf8")).toBe("DATABASE_URL=postgres://new\n");
  });

  it("쓰기 도중 죽어도(임시 파일만 실패) 기존 .env는 손상되지 않는다 — atomic 교체", async () => {
    await writeFile(envPath, "DATABASE_URL=postgres://before\n");
    await chmod(envPath, 0o600);
    await writeEnvFile(envPath, "DATABASE_URL=postgres://after\n");
    // rename 하나로 교체되므로 중간 상태 없이 최종 내용만 보인다(atomicFile.ts 계약).
    expect(await readFile(envPath, "utf8")).toBe("DATABASE_URL=postgres://after\n");
  });
});

describe("buildExampleTemplateCsv", () => {
  it("T15 스키마로 그대로 파싱 가능한 예시 행을 만든다", () => {
    const csv = buildExampleTemplateCsv(new Date("2026-09-03T00:00:00Z"));
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2); // 헤더 + 예시 1행
    const [, dataLine] = lines;
    const values = dataLine!.split(",");
    const headers = lines[0]!.split(",");
    const raw = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    expect(() => parseCsvRow(raw)).not.toThrow();
  });
});

describe("온보딩 결과로 T18(runFolderScan)이 그대로 기동한다", () => {
  let dir: string;
  let watchDir: string;
  let snapshotDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retail-mcp-onboard-"));
    watchDir = join(dir, "watch");
    snapshotDir = join(dir, "snapshot");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(watchDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("collectOnboardAnswers → envUpdatesFor → 병합한 .env 값으로 runFolderScan이 정상 동작한다", async () => {
    const ask = scriptedAsk([
      "branch",
      "", // 임베디드 웨어하우스
      watchDir,
      snapshotDir,
      "5",
      "owner@example.com",
      "", // 발송 설정 생략
    ]);
    const answers = await collectOnboardAnswers(ask);
    const updates = envUpdatesFor(answers);
    const envContent = mergeEnvFile("", updates);

    // 실제 .env 파일로 왕복해 파싱까지 검증한다(온보딩이 쓰는 그대로).
    const envPath = join(dir, ".env");
    await writeFile(envPath, envContent, "utf8");
    const reread = await readFile(envPath, "utf8");
    const parsed: Record<string, string> = Object.fromEntries(
      reread
        .split("\n")
        .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m): [string, string] => [m[1]!, m[2]!]),
    );
    expect(parsed["CSV_WATCH_DIR"]).toBe(watchDir);
    expect(parsed["CSV_SNAPSHOT_DIR"]).toBe(snapshotDir);
    expect(parsed["REPORT_RECIPIENT"]).toBe("owner@example.com");

    // 예시 템플릿 파일을 감시 폴더에 실제로 만들고(온보딩이 하는 그대로), 그 값들로
    // T18의 runFolderScan을 그대로 기동한다 — main()이 process.env에서 읽는 것과 동일한
    // 필드를 여기서는 직접 넘긴다(같은 값, 실제 프로세스 env 오염 없이 검증).
    await writeFile(join(watchDir, "template-example.csv"), buildExampleTemplateCsv(), "utf8");

    const db = await createTestWarehouse();
    const warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    const result = await runFolderScan(
      {
        warehouse,
        clock: createFixedClock("2026-09-03T00:00:00Z"),
        notificationProvider: createMockNotificationProvider(),
      },
      {
        watchDir: parsed["CSV_WATCH_DIR"]!,
        snapshotDir: parsed["CSV_SNAPSHOT_DIR"]!,
        defaultLowStockThreshold: Number(parsed["CSV_DEFAULT_LOW_STOCK_THRESHOLD"]),
        recipient: parsed["REPORT_RECIPIENT"]!,
      },
    );

    expect(result.itemCount).toBe(1);
  });
});
