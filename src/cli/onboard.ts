/**
 * 온보딩 CLI(`npm run onboard`, TASKS T21) — 지점/본사 모드 선택, 감시 폴더 경로, 저재고
 * 임계치·수신자 이메일, 웨어하우스 선택(임베디드 기본/`DATABASE_URL` 옵션)을 물어 `.env`에
 * 저장하고, 지점 모드면 SPEC §12 고정 템플릿 예시 CSV를 감시 폴더에 만들어준다.
 *
 * npm 패키지 `bin` 등록·게시는 범위 밖이다(TASKS T21) — 지금은 `tsx src/cli/onboard.ts`로
 * 직접 실행한다.
 *
 * 질문·답변 수집(`collectOnboardAnswers`)과 `.env` 병합(`mergeEnvFile`)은 순수 함수로
 * 분리해뒀다 — `ask()`를 주입하면 실제 터미널 없이도 비대화식으로(스크립트가 답을 미리
 * 정해둔 채) 테스트할 수 있다.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportSnapshotCsv } from "../core/snapshotExport.js";

export type AskFn = (question: string) => Promise<string>;

async function askRequired(ask: AskFn, question: string, maxAttempts = 3): Promise<string> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const answer = (await ask(question)).trim();
    if (answer !== "") return answer;
    if (attempt < maxAttempts) {
      console.log("값이 필요합니다 — 다시 입력해주세요.");
    }
  }
  throw new Error(
    `"${question}"에 대한 값을 ${maxAttempts}번 시도해도 받지 못했습니다. 값을 준비한 뒤 다시 실행하세요.`,
  );
}

async function askWithDefault(ask: AskFn, question: string, defaultValue: string): Promise<string> {
  const answer = (await ask(`${question} (기본값: ${defaultValue})`)).trim();
  return answer === "" ? defaultValue : answer;
}

async function askChoice<T extends string>(
  ask: AskFn,
  question: string,
  choices: readonly T[],
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = (await ask(`${question} (${choices.join("/")})`)).trim().toLowerCase();
    if ((choices as readonly string[]).includes(raw)) return raw as T;
    if (attempt < maxAttempts) {
      console.log(
        `"${raw}"는 알 수 없는 값입니다 — ${choices.join(" 또는 ")} 중 하나를 입력해주세요.`,
      );
    }
  }
  throw new Error(
    `"${question}"에 유효한 값(${choices.join("/")})을 ${maxAttempts}번 시도해도 받지 못했습니다.`,
  );
}

function isLikelyEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ── 답변 수집 (순수 로직 — ask()만 주입받는다) ───────────────────────────────

export interface BranchOnboardAnswers {
  mode: "branch";
  watchDir: string;
  snapshotDir: string;
  defaultLowStockThreshold: number;
  recipient: string;
  databaseUrl?: string;
}

export interface ConsolidatedOnboardAnswers {
  mode: "consolidated";
  collectDir: string;
  databaseUrl?: string;
}

export type OnboardAnswers = BranchOnboardAnswers | ConsolidatedOnboardAnswers;

export async function collectOnboardAnswers(ask: AskFn): Promise<OnboardAnswers> {
  const mode = await askChoice(
    ask,
    "연결 모드를 선택하세요 — branch(지점, 재고 파일 직접 감시) / consolidated(본사, 지점 스냅샷 취합)",
    ["branch", "consolidated"] as const,
  );

  const databaseUrlRaw = await ask(
    "웨어하우스로 쓸 Postgres 연결 문자열(Neon/Supabase 등)을 입력하세요. 비워두면 로컬 임베디드 PGlite를 씁니다",
  );
  const databaseUrl = databaseUrlRaw.trim() === "" ? undefined : databaseUrlRaw.trim();

  if (mode === "consolidated") {
    const collectDir = await askRequired(ask, "지점 스냅샷이 모이는 수집 폴더 경로를 입력하세요");
    return { mode, collectDir, ...(databaseUrl !== undefined ? { databaseUrl } : {}) };
  }

  const watchDir = await askRequired(ask, "재고 파일을 감시할 폴더 경로를 입력하세요");
  let snapshotDir: string;
  for (;;) {
    snapshotDir = await askRequired(
      ask,
      "스냅샷 CSV를 저장할 폴더 경로를 입력하세요(감시 폴더와 달라야 합니다)",
    );
    if (path.resolve(watchDir) !== path.resolve(snapshotDir)) break;
    console.log("감시 폴더와 스냅샷 폴더가 같습니다 — 서로 다른 폴더를 입력해주세요.");
  }

  const thresholdRaw = await askWithDefault(
    ask,
    "판매 이력이 없는 품목의 기본 저재고 임계치(품목별로 다르면 CSV의 저재고임계치 컬럼으로 개별 지정 가능)",
    "5",
  );
  const defaultLowStockThreshold = Number(thresholdRaw);
  if (!Number.isFinite(defaultLowStockThreshold) || defaultLowStockThreshold < 0) {
    throw new Error(
      `저재고 임계치가 올바르지 않습니다: "${thresholdRaw}". 0 이상의 숫자여야 합니다.`,
    );
  }

  let recipient: string;
  for (;;) {
    recipient = await askRequired(ask, "저재고 알림을 받을 이메일 주소를 입력하세요");
    if (isLikelyEmail(recipient)) break;
    console.log(`"${recipient}"는 이메일 주소 형식이 아닙니다 — 다시 입력해주세요.`);
  }

  return {
    mode,
    watchDir,
    snapshotDir,
    defaultLowStockThreshold,
    recipient,
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
  };
}

// ── .env 병합 (기존 내용 보존, 관리하는 키만 갱신/추가) ──────────────────────

/** `updates`의 키가 이미 있는 줄이면 그 줄의 값을 바꾸고, 없으면 파일 끝에 새로 추가한다. */
export function mergeEnvFile(
  existing: string,
  updates: Record<string, string | undefined>,
): string {
  const existingLines = existing.split("\n");
  const keysHandled = new Set<string>();

  const updatedLines = existingLines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match) return line;
    const key = match[1]!;
    if (!(key in updates)) return line;
    keysHandled.add(key);
    const value = updates[key];
    return value === undefined ? line : `${key}=${value}`;
  });

  const toAppend = Object.entries(updates).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !keysHandled.has(entry[0]),
  );
  if (toAppend.length === 0) return updatedLines.join("\n");

  const isBlankFile = updatedLines.length === 1 && updatedLines[0] === "";
  const header = isBlankFile ? [] : updatedLines;
  const appendedLines = toAppend.map(([key, value]) => `${key}=${value}`);
  return (
    [
      ...header,
      ...(header.length > 0 ? [""] : []),
      "# --- 온보딩(npm run onboard)이 추가함 ---",
      ...appendedLines,
    ].join("\n") + "\n"
  );
}

/** answers를 .env가 관리하는 키=값 맵으로 변환한다(값이 없으면 undefined — mergeEnvFile이 건드리지 않는다). */
export function envUpdatesFor(answers: OnboardAnswers): Record<string, string | undefined> {
  const shared: Record<string, string | undefined> = {
    CSV_MODE: answers.mode,
    DATABASE_URL: answers.databaseUrl,
  };
  if (answers.mode === "consolidated") {
    return { ...shared, CSV_COLLECT_DIR: answers.collectDir };
  }
  return {
    ...shared,
    CSV_WATCH_DIR: answers.watchDir,
    CSV_SNAPSHOT_DIR: answers.snapshotDir,
    CSV_DEFAULT_LOW_STOCK_THRESHOLD: String(answers.defaultLowStockThreshold),
    REPORT_RECIPIENT: answers.recipient,
  };
}

// ── 템플릿 예시 파일 (지점 모드) ─────────────────────────────────────────────

/** SPEC §12 고정 템플릿 헤더·형식 그대로인 예시 1행짜리 CSV — T19 export를 그대로 재사용한다. */
export function buildExampleTemplateCsv(now: Date = new Date()): string {
  return exportSnapshotCsv({
    inventory: [{ storeId: "본점", variantId: "SKU-EXAMPLE", inStock: "10", updatedAt: now }],
    products: [
      {
        variantId: "SKU-EXAMPLE",
        itemId: "SKU-EXAMPLE",
        name: "예시 상품명",
        sku: "SKU-EXAMPLE",
        category: null,
        lowStockThreshold: "5",
      },
    ],
    salesPeriodAgg: [],
  });
}

// ── CLI 진입점 ────────────────────────────────────────────────────────────

const ENV_PATH = ".env";
const EXAMPLE_TEMPLATE_FILE_NAME = "template-example.csv";

async function readExistingEnv(): Promise<string> {
  try {
    return await readFile(ENV_PATH, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return "";
    throw err;
  }
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask: AskFn = (question) => rl.question(`${question}: `);
    const answers = await collectOnboardAnswers(ask);

    const existingEnv = await readExistingEnv();
    const merged = mergeEnvFile(existingEnv, envUpdatesFor(answers));
    await writeFile(ENV_PATH, merged, "utf8");
    console.log(`설정을 ${ENV_PATH}에 저장했습니다.`);

    if (answers.mode === "branch") {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(answers.watchDir, { recursive: true });
      const templatePath = path.join(answers.watchDir, EXAMPLE_TEMPLATE_FILE_NAME);
      await writeFile(templatePath, buildExampleTemplateCsv(), "utf8");
      console.log(
        `예시 템플릿 파일을 만들었습니다: ${templatePath}\n` +
          "이 파일을 열어 실제 재고 데이터로 채우거나, 같은 형식의 파일로 교체하세요.",
      );
    }

    console.log(
      "온보딩 완료 — 이제 `npm run agent:folder-scan`으로 1회 실행해 확인하세요(기본은 SEND_MODE=dry_run이라 실제 발송은 되지 않습니다).",
    );
  } finally {
    rl.close();
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
