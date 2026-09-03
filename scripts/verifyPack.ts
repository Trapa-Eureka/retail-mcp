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

/**
 * SEC-006(005 검수, TASKS T32)의 "근거·만료일이 기록된 승인된 예외" — exceljs@4.4.0이 고정한
 * `uuid@^8.3.0`은 GHSA-w5hq-g745-h8pq(uuid v3/v5/v6에 buf를 넘길 때의 bounds check 결함,
 * 영향 범위 "<11.1.1")에 걸린다. exceljs는 `uuidv4()`를 인자 없이만 호출해(v4, buf 없음 —
 * `node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`로 확인) 실제
 * 취약 코드 경로를 타지 않는다. package.json의 `overrides`로 dev 체크아웃의 uuid는
 * 11.1.1로 올렸지만 **npm의 `overrides`는 이 패키지가 다른 프로젝트의 의존성으로 설치될 때는
 * 적용되지 않는다** — 실제 게시되는 tarball을 이 스크립트처럼 완전히 새 프로젝트에 설치해
 * 직접 확인한 결과 uuid@8.3.2가 그대로 해석됐다(착수 중 발견). 그래서 dev 체크아웃의
 * `npm audit`만으로는 이 결함이 가려진다 — 여기서 **실제 tarball을 설치한 디렉터리**를
 * 대상으로 다시 확인해야 진짜 상태를 안다. 재검토 기한: **2027-03-03**(exceljs가 uuid
 * 의존성을 올렸는지 재확인 — 그때도 안 올렸으면 패치/대체 라이브러리 재검토).
 *
 * 패키지 이름이 아니라 **advisory URL(GHSA ID)**로 비교한다 — `npm audit` 결과 트리는
 * `@trapa-eureka/retail-mcp` 자신도 "영향받음" 루트 항목으로 함께 나열하므로(설치하는
 * 프로젝트마다 이름이 다를 수 있음), 실제 취약점의 정체를 정확히 가리키는 advisory URL로
 * 비교해야 이름 우연 일치/불일치에 흔들리지 않는다.
 */
const ACCEPTED_ADVISORY_URL = "https://github.com/advisories/GHSA-w5hq-g745-h8pq";

function verifyDependencyAudit(installDir: string): void {
  heading("5) npm audit — 게시된 tarball을 실제로 설치한 디렉터리 기준 취약점 확인");
  let stdout: string;
  try {
    stdout = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      cwd: installDir,
      encoding: "utf8",
    });
  } catch (err) {
    // npm audit는 취약점이 있으면 0이 아닌 종료 코드로 끝난다 — JSON 리포트 자체는 그래도
    // stdout에 담겨 있다(execFileSync가 던지는 에러 객체가 들고 있다).
    const withStdout = err as { stdout?: unknown };
    if (typeof withStdout.stdout !== "string") throw err;
    stdout = withStdout.stdout;
  }

  const report = JSON.parse(stdout) as { vulnerabilities?: Record<string, { via?: unknown[] }> };
  const advisoryUrls = new Set<string>();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via === "object" && via !== null && "url" in via && typeof via.url === "string") {
        advisoryUrls.add(via.url);
      }
    }
  }
  const unexpected = [...advisoryUrls].filter((url) => url !== ACCEPTED_ADVISORY_URL);
  if (unexpected.length > 0) {
    throw new Error(
      `게시된 tarball에서 승인되지 않은 새 취약점이 발견됐습니다: ${unexpected.join(", ")} — ` +
        "docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md SEC-006을 재검토하세요.",
    );
  }
  if (advisoryUrls.size === 0) {
    console.log(
      "취약점 0건 — exceljs/uuid 승인된 예외(SEC-006)가 더 이상 필요 없을 수 있습니다. " +
        "docs/005와 이 스크립트의 ACCEPTED_ADVISORY_URL을 갱신하세요.",
    );
  } else {
    console.log(
      `승인된 예외만 확인됨(${ACCEPTED_ADVISORY_URL}) — docs/005 SEC-006, 재검토 기한 2027-03-03.`,
    );
  }
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
    verifyDependencyAudit(installDir);
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
