/**
 * Lightweight scanner that checks whether real secrets (CLAUDE.md guardrail 6: `LOYVERSE_API_TOKEN`/
 * `DATABASE_URL`/`RESEND_API_KEY`/`ANTHROPIC_API_KEY` and the like) slipped into committed source
 * (QA-006, TASKS T35).
 *
 * The reason this was built inside the repository instead of adding an external tool such as
 * gitleaks/truffleHog as a CI action is the same as other decisions in this session (e.g. the
 * OPS-002 PID-reuse mitigation being solved with a single `ps` call and no native module) — there
 * are only a handful of patterns, it is a pure function so vitest can unit-test it directly
 * (external actions cannot be verified locally), and a new kind of secret is handled by adding
 * one more pattern.
 *
 * Perfect secret detection is not the goal (no entropy analysis etc.) — this is a purpose-driven
 * check limited to the secret shapes this project actually handles (cloud key prefixes, PEM
 * blocks, credentials in DB connection strings).
 *
 * Coverage baseline (second adversarial review SR2-SEC-005): the 4 secrets in `.env.example`
 * (guardrail 6 — `LOYVERSE_API_TOKEN`/`DATABASE_URL`/`RESEND_API_KEY`/`ANTHROPIC_API_KEY`) + the
 * credentials the CI/publish flow handles (npm publish token, GitHub token, Bearer headers that
 * could end up in Actions logs) + Google credentials that the SCM sheet integration may encounter
 * (API key, service account JSON). Services this repository does not use (Slack etc.) are not
 * included — the principle that patterns are limited to "what this project actually handles" is
 * kept. Loyverse tokens, whose format is not public, are matched not by value shape but by the
 * **assignment** (`LOYVERSE_API_TOKEN=<value>`) — so the empty value in `.env.example` does not
 * match. Limitation (also stated in SECURITY.md): only known prefixes and assignments are checked.
 * Formatless arbitrary-string secrets (e.g. a hex token pasted without a variable name) are not
 * caught.
 */

export interface SecretPattern {
  name: string;
  /** Must have the global (g) flag — matchAll is used to find multiple hits per file. */
  regex: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: "AWS Access Key ID", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "PEM private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g },
  { name: "Resend API key", regex: /\bre_[A-Za-z0-9]{20,}\b/g },
  {
    name: "Postgres connection string (with credentials)",
    regex: /\bpostgres(?:ql)?:\/\/[^:\s'"]+:[^@\s'"]+@[^\s'"]+/g,
  },
  // ── SR2-SEC-005 additions ───────────────────────────────────────────────
  // Loyverse access tokens have no public prefix/length format (an opaque string issued by the
  // Back Office). So instead of a value shape, we match "a line assigning a real value to the env
  // var name" — `.env` being committed by mistake, or a real value pasted into docs/tests, is the
  // realistic leak path in this project. Values must be 16+ chars (excludes short placeholders and
  // empty values); quotes are optional. Whitespace is `[ \t]` only — `\s` includes newlines and
  // mistook the text on the line after `LOYVERSE_API_TOKEN=` (empty value) for the value (a real
  // false positive in the .env example of docs/DESIGN.md during implementation → regression test).
  {
    name: "LOYVERSE_API_TOKEN assignment (real value)",
    regex: /\bLOYVERSE_API_TOKEN[ \t]*[=:][ \t]*['"]?[A-Za-z0-9._~+/=-]{16,}/g,
  },
  // GitHub tokens — classic PAT/OAuth/user-to-server/server-to-server/refresh (prefix + 36 chars)
  // and fine-grained PAT (`github_pat_` + 82 chars, loosened to 22+ here).
  { name: "GitHub token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { name: "GitHub fine-grained PAT", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  // npm access token (common prefix `npm_` + 36 chars for granular/automation/publish tokens).
  { name: "npm access token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // Google — API key (`AIza` + 35 chars) and service account JSON (a JSON object with the
  // distinctive key name `private_key_id`. That file also contains a PEM private key, so the PEM
  // pattern above fires too, but if the PEM is split across lines or in escaped `\n` form the PEM
  // pattern can miss it, so we also match on the key name).
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "Google service account JSON", regex: /"private_key_id"[ \t]*:[ \t]*"[0-9a-f]{20,}"/g },
  // Bearer token hardcoded in an HTTP Authorization header (20+ chars). The `Bearer ${token}`
  // template in code does not match because `$` is not in the character class — only when a real
  // value is attached. Whitespace is limited to the same line (same reason as the LOYVERSE pattern
  // above).
  { name: "Bearer token (hardcoded)", regex: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/g },
];

/**
 * Only when this exact string is on the same line as the match is it treated as a test fixture
 * and skipped.
 *
 * Previously any one of several common English words such as `fake|example|placeholder|dummy|...`
 * was enough to skip — which is bypassed as-is when such a word happens to be (or is deliberately
 * put) on the same line as a real secret (second adversarial review SR2-SEC-001, reproduced and
 * confirmed directly with `const productionKey = "sk-ant-realkey"; // example`). Narrowed from
 * common words to a single dedicated marker that never occurs by accident — a reason may freely be
 * appended after it (`// secretscan-allow: test fixture`).
 */
const EXPLICIT_ALLOW_MARKER = "secretscan-allow";

/** Connection strings targeting localhost/127.0.0.1 have effectively no leak risk even with real credentials (not remotely reachable) — always skipped. */
function isLocalhostConnectionString(match: string): boolean {
  return /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(match);
}

export interface SecretFinding {
  file: string;
  patternName: string;
  line: number;
  /** The full matched value is never written to logs/reports (that would itself be a leak) — only the first 8 chars. */
  matchPreview: string;
}

/** Scans the content of a single file. filePath is only a display name for the report; the file is not read here (separated from IO). */
export function scanContentForSecrets(filePath: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");

  for (const pattern of SECRET_PATTERNS) {
    // matchAll requires the regex to have the g flag, and a fresh RegExp is created every time so
    // lastIndex state is not shared (reusing the same RegExp object across files accumulates
    // lastIndex and causes false positives/misses).
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    for (const match of content.matchAll(regex)) {
      const matchedText = match[0];
      if (pattern.name.startsWith("Postgres") && isLocalhostConnectionString(matchedText)) {
        continue;
      }
      const upToMatch = content.slice(0, match.index).split("\n");
      const lineNumber = upToMatch.length;
      const lineText = lines[lineNumber - 1] ?? "";
      if (lineText.includes(EXPLICIT_ALLOW_MARKER)) {
        continue;
      }
      findings.push({
        file: filePath,
        patternName: pattern.name,
        line: lineNumber,
        matchPreview: `${matchedText.slice(0, 8)}...`,
      });
    }
  }

  return findings;
}
