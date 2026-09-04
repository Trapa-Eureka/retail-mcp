#!/usr/bin/env node
/**
 * 온보딩 CLI(`npm run onboard`, TASKS T21) — 지점/본사 모드 선택, 감시 폴더 경로, 저재고
 * 임계치·수신자 이메일, 웨어하우스 선택(임베디드 기본/`DATABASE_URL` 옵션)을 물어 `.env`에
 * 저장하고, 지점 모드면 SPEC §12 고정 템플릿 예시 CSV를 감시 폴더에 만들어준다.
 *
 * npm 패키지 `bin`(TASKS T29, DESIGN §12.1) — `package.json.bin["retail-mcp-onboard"]`가
 * 빌드된 `dist/cli/onboard.js`를 가리킨다. 저장소 안에서 개발할 땐 `npm run onboard`(tsx로
 * 소스 직접 실행)를 그대로 쓴다.
 *
 * 질문·답변 수집(`collectOnboardAnswers`)과 `.env` 병합(`mergeEnvFile`)은 순수 함수로
 * 분리해뒀다 — `ask()`를 주입하면 실제 터미널 없이도 비대화식으로(스크립트가 답을 미리
 * 정해둔 채) 테스트할 수 있다.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { writeFileAtomic } from "../adapters/atomicFile.js";
import { isMainModule } from "../adapters/mainModule.js";
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
  /**
   * 이메일 발송 설정(선택, T37 게시 전 점검에서 추가) — 둘 다 있어야 실제 발송이 가능하다.
   * 온보딩에서 비워두면 `retail-mcp-scan`은 미리보기(dry-run)만 하고, 나중에 `.env`에
   * `RESEND_API_KEY`/`MAIL_FROM`을 채우면 된다. 값은 `.env`(0600)에만 쓰고 화면에 되풀이하지 않는다.
   */
  resendApiKey?: string;
  mailFrom?: string;
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

  // 이메일 발송 설정(선택). 실제 발송에는 Resend API 키와 발신 주소가 둘 다 필요하다 — 키를
  // 비우면 미리보기(dry-run) 전용으로 안내하고 발신 주소는 묻지 않는다. 키를 줬는데 발신 주소가
  // 없으면 발송이 실패하므로 그 경우엔 발신 주소를 필수로 받는다.
  const resendApiKeyRaw = (
    await ask(
      "이메일 발송용 Resend API 키를 입력하세요(re_로 시작, resend.com > API Keys에서 발급). " +
        "비워두면 지금은 미리보기(dry-run)만 하고 발송 설정은 나중에 .env에 채웁니다",
    )
  ).trim();
  let mailFrom: string | undefined;
  if (resendApiKeyRaw !== "") {
    for (;;) {
      mailFrom = await askRequired(
        ask,
        "발신 이메일 주소를 입력하세요(Resend에서 인증한 도메인의 주소, 예: alerts@내도메인.com)",
      );
      if (isLikelyEmail(mailFrom)) break;
      console.log(`"${mailFrom}"는 이메일 주소 형식이 아닙니다 — 다시 입력해주세요.`);
    }
  }

  return {
    mode,
    watchDir,
    snapshotDir,
    defaultLowStockThreshold,
    recipient,
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    ...(resendApiKeyRaw !== "" ? { resendApiKey: resendApiKeyRaw } : {}),
    ...(mailFrom !== undefined ? { mailFrom } : {}),
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
    // 비우면 undefined → mergeEnvFile이 기존 줄을 건드리지 않는다(이미 채워둔 값 보존).
    RESEND_API_KEY: answers.resendApiKey,
    MAIL_FROM: answers.mailFrom,
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

/**
 * `.env`에 원자적으로 0o600 권한으로 쓴다(SEC-005, TASKS T32) — DATABASE_URL·이메일 주소
 * 등 민감정보가 담기므로 소유자만 읽기/쓰기 가능해야 한다. `writeFileAtomic`은 임시 파일을
 * 0o600으로 새로 만든 뒤 rename으로 교체하므로, 기존 `.env`가 더 느슨한 권한이었어도(예:
 * umask로 만들어진 0o644) rename 후에는 새 inode의 권한(0o600)으로 항상 교체된다 — 별도
 * "기존 파일 권한 검사·보정" 단계 없이 매 온보딩 실행이 곧 보정이다(rename(2)이 대상 경로의
 * 예전 inode를 완전히 새 inode로 교체하기 때문 — 예전 파일의 권한이 새 inode로 넘어오지
 * 않는다). `main()`과 분리해둬 실제 readline 없이 직접 테스트할 수 있다.
 */
export async function writeEnvFile(envPath: string, content: string): Promise<void> {
  await writeFileAtomic(envPath, content, { mode: 0o600 });
}

/**
 * `rl.question()`을 반복 호출하는 대신 `rl`의 비동기 이터레이터에서 한 줄씩 꺼내는 `AskFn`을
 * 만든다.
 *
 * 착수 중 발견(QA-001 tarball smoke test, `scripts/verifyPack.ts`) — 파이프로 넘긴 비대화식
 * 입력(`printf "a\nb\nc" | retail-mcp-onboard`, CI/스크립트 온보딩의 일반적인 방식)에서는
 * `readline/promises`의 `rl.question()`을 여러 번 순차 호출하면 **첫 질문만 응답을 받고
 * 이후 질문은 영원히 멈춘다** — stdin이 TTY가 아니면 파이프에 이미 도착해 있는 나머지 줄들이
 * `question()`이 다음 리스너를 등록하기 전에 먼저 소비돼버리는 Node 자체의 알려진 동작이다
 * (사람이 터미널에서 한 줄씩 타이핑할 때는 매 줄이 늦게 도착해 문제가 드러나지 않는다 —
 * `collectOnboardAnswers`의 단위 테스트가 주입한 `ask()`도 실제 `readline`을 거치지 않아
 * 이 결함을 가리고 있었다). 비동기 이터레이터로 한 줄씩 명시적으로 꺼내면 TTY·파이프 양쪽에서
 * 안전하다 — Node 공식 문서가 권장하는 `for await...of rl` 소비 방식과 같은 메커니즘이다.
 */
function createReadlineAsk(rl: ReturnType<typeof createInterface>): AskFn {
  const lines = rl[Symbol.asyncIterator]();
  return async (question) => {
    process.stdout.write(`${question}: `);
    const { value, done } = await lines.next();
    return done || value === undefined ? "" : value;
  };
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = createReadlineAsk(rl);
    const answers = await collectOnboardAnswers(ask);

    const existingEnv = await readExistingEnv();
    const merged = mergeEnvFile(existingEnv, envUpdatesFor(answers));
    await writeEnvFile(ENV_PATH, merged);
    console.log(`설정을 ${ENV_PATH}에 저장했습니다(권한 0600).`);

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

    // 설치 사용자(npm bin)와 저장소 개발자(npm run) 둘 다 보는 안내라 두 명령을 함께 적는다.
    const hasSending = answers.mode === "branch" && answers.resendApiKey !== undefined;
    console.log(
      [
        "온보딩 완료.",
        "다음: 같은 폴더에서 `retail-mcp-scan`(저장소에서는 `npm run agent:folder-scan`)을 한 번 실행해 결과를 확인하세요.",
        "  기본은 미리보기(SEND_MODE=dry_run)라 이메일은 나가지 않고 화면에만 표시됩니다.",
        hasSending
          ? "실제 발송을 켜려면 .env의 SEND_MODE를 live로 바꾸고, 처음 한 번은 직접 `retail-mcp-scan --confirm`을 실행해 수신을 확인한 뒤 자동 실행(cron)에 등록하세요."
          : '실제 발송을 켜려면 .env에 RESEND_API_KEY와 MAIL_FROM을 채우고 SEND_MODE를 live로 바꾼 뒤, 처음 한 번은 직접 `retail-mcp-scan --confirm`을 실행해 수신을 확인하세요(README "5. 이메일 발송 켜기").',
      ].join("\n"),
    );
  } finally {
    rl.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
