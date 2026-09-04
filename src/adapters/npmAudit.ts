/**
 * Runs `npm audit --json` with limited retries — shared by `src/adapters/auditLockfile.ts` (CI on
 * every PR, lockfile-based) and `scripts/verifyPack.ts` (release gate, based on the actual
 * published tarball).
 *
 * Why retries are needed (2026-09-04, observed in CI of SR2-AUD-003 PR #61): when npm 10.9.8 on
 * the Node 22 runner fails the bulk advisory request, it falls back to the deprecated
 * `/-/npm/v1/security/audits/quick`, and the registry rejects that request with `400 Bad Request`
 * + `npm-notice: This endpoint is being retired`. As a result `npm audit` emits `{"error": ...}`
 * or no report at all. SR2-AUD-001/002 correctly judge this as "could not verify" (the release gate
 * is fail-closed), but two out of three runs of the same workflow had to be re-run for this reason
 * — a transient state of the external registry, not a code defect. So we try a few more times with
 * a short exponential backoff **only when no valid report was obtained**. A valid report (with or
 * without vulnerabilities) is the real answer, so it is returned immediately and never retried. If
 * all retries are used and the result is still invalid, the last result is returned as-is so the
 * caller's existing fail-open (PR gate) / fail-closed (release gate) policy applies unchanged —
 * this module does not change policy, it only absorbs transient failures.
 *
 * Why a per-attempt cap is needed (2026-09-04 follow-up, T37 — observed on the macOS runner of
 * main run 33841569631 / PR #72): when the registry drops the response (`read ECONNRESET`), npm's
 * own fetch retries consumed **6-7 minutes per attempt** — npm defaults are `fetch-timeout` 300 s,
 * `fetch-retries` 2, retry interval up to 60 s, so every time a "connected but no response" state
 * is hit it waits 5 minutes. With our 3 retries on top, one job held `npm audit` alone for over 19
 * minutes (close to the 50-minute test job cap). So (1) short fetch settings are passed to npm as
 * CLI flags (`NPM_AUDIT_FETCH_FLAGS` — 30 s timeout, 1 retry, retry interval 2-10 s) and (2)
 * independently of that, the process itself is force-killed at `perAttemptTimeoutMs` (default 90
 * s) (the cap holds even if npm ignores the flags or hangs elsewhere). Worst case per attempt 90 s
 * × 3 attempts + 6 s backoff ≈ 5 minutes is now the upper bound — down from 19+ minutes. The result
 * policy is unchanged: a timeout is treated as "execution failed (null)" and becomes a retry
 * candidate, and if still invalid at the end the caller decides fail-open/closed.
 *
 * `run`/`sleep` are injectable — tests use neither the real npm nor real waiting (guardrail 2).
 */
import { execFileSync } from "node:child_process";
import { isValidAuditReport } from "../core/auditAllowlist.js";

/**
 * CLI settings that shorten npm's own network waits (module comment (1) above). Values in ms.
 * `fetch-timeout` 30 s: a normal response arrives within seconds, and beyond 30 s it is right to
 * consider the connection already "dropped". `fetch-retries` 1: only one internal npm retry — the
 * outer `runNpmAuditJsonWithRetry` handles per-attempt retries, so inner and outer retries do not
 * multiply.
 */
export const NPM_AUDIT_FETCH_FLAGS: readonly string[] = [
  "--fetch-timeout=30000",
  "--fetch-retries=1",
  "--fetch-retry-mintimeout=2000",
  "--fetch-retry-maxtimeout=10000",
];

/** Per-attempt process force-kill cap (module comment (2) above). Leaves headroom over the worst
 * case computed from the fetch settings (30 s + retry 10 s + 30 s ≈ 70 s). */
export const DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS = 90_000;

/** The full argument list passed to a single `npm audit` — separated so tests can verify the flags are included. */
export function npmAuditArgs(): string[] {
  return ["audit", "--omit=dev", "--json", ...NPM_AUDIT_FETCH_FLAGS];
}

export interface NpmAuditOnceOptions {
  /** Per-attempt force-kill cap (ms). Default DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Test injection — the command and args to run instead of the real npm (e.g. a node script that hangs for a while). */
  command?: { file: string; args: string[] };
}

export interface NpmAuditRunOptions {
  /** Directory in which to run `npm audit`. Default: current working directory. */
  cwd?: string;
  /** Total number of attempts (including the first). Default 3. */
  attempts?: number;
  /** Wait before the first retry (ms). Doubles on each subsequent attempt. Default 2000. */
  baseDelayMs?: number;
  /** Per-attempt process force-kill cap (ms). Default DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS (90 s). When
   * `run` is injected, that side is responsible (this value applies only to the default runner). */
  perAttemptTimeoutMs?: number;
  /** Test injection — the stdout of `npm audit --omit=dev --json ...`, or null if execution itself failed. */
  run?: (cwd: string | undefined) => string | null;
  /** Test injection — default: setTimeout-based wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Warning output between retries. Default: console.warn. */
  warn?: (message: string) => void;
}

/**
 * Runs npm audit once. Returns null if execution itself fails (registry unreachable, force-killed
 * after exceeding `timeoutMs`, etc.) — both cases are the same to the caller: "this attempt has no
 * answer".
 */
export function runNpmAuditJsonOnce(
  cwd: string | undefined,
  options: NpmAuditOnceOptions = {},
): string | null {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS;
  const file = options.command?.file ?? "npm";
  const args = options.command?.args ?? npmAuditArgs();
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      // SIGKILL — npm may keep waiting for its child fetch to finish even after SIGTERM. A cap is a cap.
      killSignal: "SIGKILL",
      ...(cwd !== undefined ? { cwd } : {}),
    });
  } catch (err) {
    // npm audit exits non-zero merely when vulnerabilities are found — in that case the JSON report
    // itself is in stdout (must be distinguished from a real execution failure). When killed by
    // timeout, stdout is empty or truncated and goes down the null path below (truncated JSON is
    // filtered out by isValidAuditStdout).
    const withStdout = err as { stdout?: unknown };
    if (typeof withStdout.stdout === "string" && withStdout.stdout.trim().length > 0) {
      return withStdout.stdout;
    }
    return null;
  }
}

/** Whether stdout parses and is a valid vulnerability report format (`isValidAuditReport`) — the sole criterion for retrying. */
export function isValidAuditStdout(stdout: string | null): boolean {
  if (stdout === null) return false;
  try {
    return isValidAuditReport(JSON.parse(stdout));
  } catch {
    return false;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tries up to `attempts` times until a valid report is obtained. The return value is the stdout of
 * the last attempt (or null) — validity judgement and the resulting policy are the caller's job.
 */
export async function runNpmAuditJsonWithRetry(
  options: NpmAuditRunOptions = {},
): Promise<string | null> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? DEFAULT_AUDIT_ATTEMPT_TIMEOUT_MS;
  const run =
    options.run ??
    ((cwd: string | undefined): string | null =>
      runNpmAuditJsonOnce(cwd, { timeoutMs: perAttemptTimeoutMs }));
  const sleep = options.sleep ?? defaultSleep;
  const warn = options.warn ?? ((message: string): void => console.warn(message));

  let last: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    last = run(options.cwd);
    if (isValidAuditStdout(last)) return last;
    if (attempt < attempts) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      warn(
        `[npm audit] attempt ${attempt}/${attempts} did not produce a valid report` +
          `(took ${elapsedSec}s — presumably a transient registry error: deprecated quick endpoint fallback, ` +
          `unresponsive connection, etc.). Retrying in ${delay}ms.`,
      );
      await sleep(delay);
    }
  }
  return last;
}
