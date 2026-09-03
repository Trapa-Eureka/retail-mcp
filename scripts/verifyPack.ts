/**
 * npm 배포 tarball 검증 스크립트 (TASKS T29, QA-001 대응) — 사람/CI 전용, `npm run check`에는
 * 포함하지 않는다(TESTING.md §8 "release gate"는 매 로컬 check와 별도라고 명시).
 *
 * 저장소 소스가 아니라 **실제로 게시될 tarball**을 검증한다: 빌드 → `npm pack` → 완전히 새
 * 디렉터리에 `npm install --omit=dev`로 설치(개발 의존성 `tsx` 등이 없는 환경) → 설치된
 * `bin`(`retail-mcp`, `retail-mcp-onboard`)을 실제로 실행해 확인한다.
 *
 * - `retail-mcp`: 실제 MCP 클라이언트로 stdio 연결해 `tools/list`가 운영 기본값(조회 도구
 *   5종만, `sync_now`/`explore_sql`은 비활성)과 일치하는지 확인한다.
 * - `retail-mcp-onboard`: 지점 모드 답변을 stdin으로 흘려보내 `.env`와 예시 템플릿 CSV가
 *   실제로 만들어지는지 확인한다.
 *
 * 실패하면 원인이 담긴 에러로 non-zero 종료한다(CI가 release gate로 이 스크립트를 실행할
 * 수 있게).
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const EXPECTED_DEFAULT_TOOLS = [
  "inventory_status",
  "reorder_suggestions",
  "sell_through",
  "stockout_risk",
  "sync_status",
].sort();

function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** cwd를 지정해 명령을 실행하고 stdout을 반환한다 — 실패 시 stderr까지 포함된 에러를 던진다. */
function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function packTarball(destDir: string): string {
  heading("1) 빌드 + npm pack");
  run("npm", ["run", "build"], REPO_ROOT);
  const json = run("npm", ["pack", "--json", "--pack-destination", destDir], REPO_ROOT);
  const [entry] = JSON.parse(json) as { filename: string }[];
  if (!entry) throw new Error("npm pack이 결과 파일명을 반환하지 않았습니다.");
  const tarballPath = path.join(destDir, entry.filename);
  console.log(`tarball: ${tarballPath}`);
  return tarballPath;
}

async function installFresh(tarballPath: string, installDir: string): Promise<void> {
  heading("2) 완전히 새 디렉터리에 --omit=dev 설치");
  await writeFile(
    path.join(installDir, "package.json"),
    JSON.stringify({ name: "retail-mcp-pack-smoke", version: "0.0.0", private: true }, null, 2),
  );
  run("npm", ["install", "--omit=dev", tarballPath], installDir);
}

async function assertExecutable(binPath: string): Promise<void> {
  const info = await stat(binPath).catch(() => {
    throw new Error(
      `bin 파일이 설치되지 않았습니다: ${binPath} — package.json.bin/files allowlist를 확인하세요.`,
    );
  });
  if (!info.isFile()) throw new Error(`bin 경로가 파일이 아닙니다: ${binPath}`);
}

async function verifyMcpServerBin(installDir: string): Promise<void> {
  heading("3) retail-mcp(MCP 서버) bin 실행 — tools/list 확인");
  const binPath = path.join(installDir, "node_modules", ".bin", "retail-mcp");
  await assertExecutable(binPath);

  const client = new Client({ name: "verify-pack-client", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: binPath,
    cwd: installDir,
    env: { ...process.env, BUSINESS_TIMEZONE: "Asia/Manila" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_DEFAULT_TOOLS)) {
      throw new Error(
        `tools/list가 운영 기본값과 다릅니다.\n기대: ${EXPECTED_DEFAULT_TOOLS.join(", ")}\n실제: ${names.join(", ")}`,
      );
    }
    console.log(`tools/list 확인됨: ${names.join(", ")}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function verifyOnboardBin(installDir: string): Promise<void> {
  heading("4) retail-mcp-onboard(온보딩 CLI) bin 실행 — .env + 템플릿 생성 확인");
  const binPath = path.join(installDir, "node_modules", ".bin", "retail-mcp-onboard");
  await assertExecutable(binPath);

  const onboardCwd = path.join(installDir, "onboard-run");
  await mkdir(onboardCwd, { recursive: true });

  // collectOnboardAnswers() 질문 순서 그대로: 모드 → DB 연결문자열(비우면 임베디드) →
  // 감시폴더 → 스냅샷폴더 → 임계치(비우면 기본값) → 수신 이메일.
  const answers = ["branch", "", "./watch", "./snapshot", "", "smoke@example.com", ""].join("\n");

  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(binPath, [], {
    cwd: onboardCwd,
    input: answers,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `retail-mcp-onboard가 0이 아닌 종료 코드(${String(result.status)})를 반환했습니다.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  const envContent = await readFile(path.join(onboardCwd, ".env"), "utf8");
  if (!envContent.includes("CSV_MODE=branch")) {
    throw new Error(`.env에 CSV_MODE=branch가 없습니다:\n${envContent}`);
  }
  const templatePath = path.join(onboardCwd, "watch", "template-example.csv");
  await stat(templatePath).catch(() => {
    throw new Error(`예시 템플릿 CSV가 만들어지지 않았습니다: ${templatePath}`);
  });
  console.log(".env + 예시 템플릿 CSV 생성 확인됨");
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(path.join(tmpdir(), "retail-mcp-verify-pack-"));
  const installDir = path.join(workDir, "install");
  await mkdir(installDir, { recursive: true });

  try {
    const tarballPath = packTarball(workDir);
    await installFresh(tarballPath, installDir);
    await verifyMcpServerBin(installDir);
    await verifyOnboardBin(installDir);
    heading("전부 통과");
    console.log(`tarball fresh-install 검증 완료 (임시 디렉터리: ${workDir})`);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
