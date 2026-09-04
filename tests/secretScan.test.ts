import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanContentForSecrets } from "../src/core/secretScan.js";

/**
 * Second adversarial review SR2-SEC-002 — this file is no longer excluded from the scan targets of
 * `scripts/secretScan.ts` (previously `SELF_EXCLUDE` removed the whole file, so even real
 * credentials placed here were a permanent blind spot that CI structurally could not see). Instead
 * every fixture is **assembled at runtime** — so that no single line of this file contains a
 * complete secret pattern literally. The assembled result exists only at runtime, so the scanner
 * finds nothing in the source text, and that very fact is asserted by the "self-check" test at the
 * bottom — if someone puts a complete literal back, the unit test fails before the CI secret-scan
 * does.
 *
 * The only exception is the `secretscan-allow` marker test — a complete literal with the marker on
 * the same line is the approved narrow allow mechanism that the scanner deliberately skips, so it
 * stays as-is (the self-check test also passes that line per the scanner rule).
 */
const assemble = (...parts: string[]): string => parts.join("");

/** AWS Access Key ID shape (AKIA + 16 uppercase/digits) — built only by assembly. */
const awsKey = (suffix16 = "ABCDEFGHIJKLMNOP"): string => assemble("AKIA", suffix16);
const pemHeader = (algo: string): string => assemble("-----BEGIN ", algo, " PRIVATE", " KEY-----");
const pemFooter = (algo: string): string => assemble("-----END ", algo, " PRIVATE", " KEY-----");
const anthropicKey = (): string => assemble("sk-ant-", "api03-realLookingSecretValue1234567890");
const resendKey = (): string => assemble("re_", "1234567890abcdefghijklmnop");
const pgUrl = (user: string, pass: string, hostAndDb: string): string =>
  assemble("postgres://", user, ":", pass, "@", hostAndDb);

describe("scanContentForSecrets (QA-006, TASKS T35)", () => {
  it("finds an AWS Access Key ID", () => {
    const findings = scanContentForSecrets("a.ts", `const key = "${awsKey()}";`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.patternName).toBe("AWS Access Key ID");
    expect(findings[0]?.line).toBe(1);
  });

  it("finds a PEM private key block", () => {
    const content = ["line1", pemHeader("RSA"), "MIIExxxx", pemFooter("RSA")].join("\n");
    const findings = scanContentForSecrets("key.pem", content);
    expect(findings.some((f) => f.patternName === "PEM private key block")).toBe(true);
    expect(findings.find((f) => f.patternName === "PEM private key block")?.line).toBe(2);
  });

  it("finds an Anthropic API key", () => {
    const findings = scanContentForSecrets("a.ts", `const k = "${anthropicKey()}";`);
    expect(findings.some((f) => f.patternName === "Anthropic API key")).toBe(true);
  });

  it("finds a Resend API key", () => {
    const findings = scanContentForSecrets(
      "a.ts",
      `process.env.RESEND_API_KEY = "${resendKey()}";`,
    );
    expect(findings.some((f) => f.patternName === "Resend API key")).toBe(true);
  });

  it("finds a postgres connection string containing credentials (excluding localhost)", () => {
    const findings = scanContentForSecrets(
      "a.ts",
      `DATABASE_URL = "${pgUrl("realuser", "S3cr3tPass", "db.neon.tech:5432/mydb")}";`,
    );
    expect(findings.some((f) => f.patternName.startsWith("Postgres"))).toBe(true);
  });

  it("does not false-positive ordinary identifiers (EXPLORE_SQL_ALLOW_PGLITE etc.) on the re_ pattern", () => {
    const findings = scanContentForSecrets(
      "a.ts",
      "if (env.EXPLORE_SQL_ALLOW_PGLITE !== 'true') throw new Error();",
    );
    expect(findings).toEqual([]);
  });

  it("skips postgres connection strings targeting localhost (no remote leak risk)", () => {
    const findings = scanContentForSecrets(
      "tests/x.test.ts",
      `env: { DATABASE_URL: "${pgUrl("user", "pass", "localhost:1/nonexistent")}" }`,
    );
    expect(findings).toEqual([]);
  });

  it("skips when the secretscan-allow marker is on the same line (intentional test fixture)", () => {
    // This line is deliberately a complete literal — the test verifies the marker mechanism itself.
    // The scanner skips it because the marker is on the same line, and the self-check test below
    // passes it by the same rule.
    const findings = scanContentForSecrets(
      "tests/x.test.ts",
      'const apiKey = "sk-ant-super-secret-key-should-never-leak"; // secretscan-allow: test fixture',
    );
    expect(findings).toEqual([]);
  });

  it("is no longer bypassed by common words alone (fake/example/placeholder etc.) (second adversarial review SR2-SEC-001 regression)", () => {
    // Previously findings were empty for all 5 of these cases — a defect where a single common
    // English word happening to be on the same line as a real secret skipped the whole line. Now
    // it must always be found unless the dedicated marker (secretscan-allow) is present.
    const trailingComments = [
      "// example",
      "// fake value below, this one is real though",
      "// placeholder for now",
      "// dummy? no",
      "// your_real_key_here",
    ];
    for (const comment of trailingComments) {
      const content = `const productionKey = "${awsKey()}"; ${comment}`;
      const findings = scanContentForSecrets("a.ts", content);
      expect(findings, `missed line: ${content}`).toHaveLength(1);
    }
  });

  it("does not mix matches across multiple files and lines (RegExp lastIndex isolation)", () => {
    const first = scanContentForSecrets("a.ts", `const a = "${awsKey()}";`);
    const second = scanContentForSecrets("b.ts", "no secrets here");
    const third = scanContentForSecrets("c.ts", `const b = "${awsKey("ZZZZZZZZZZZZZZZZ")}";`);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(1);
  });

  it("returns an empty array when there are no secrets", () => {
    expect(scanContentForSecrets("a.ts", "export const x = 1;")).toEqual([]);
  });

  it("matchPreview contains only the beginning, not the whole match (so the report itself is not a leak)", () => {
    const findings = scanContentForSecrets("a.ts", `const k = "${awsKey()}";`);
    expect(findings[0]?.matchPreview).toBe("AKIAABCD...");
    expect(findings[0]?.matchPreview).not.toContain("MNOP");
  });

  describe("credential coverage extension (second adversarial review SR2-SEC-005)", () => {
    // All assembled at runtime (SR2-SEC-002 rule) — no line of this file contains a complete pattern.
    const tok36 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // 36 chars
    const ghToken = (prefix: string): string => assemble(prefix, "_", tok36);
    const ghFinePat = (): string => assemble("github_", "pat_", "11ABCDEFG0", tok36);
    const npmToken = (): string => assemble("npm", "_", tok36);
    const googleApiKey = (): string => assemble("AIza", "SyA1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q"); // 4+35
    const saJson = (): string =>
      assemble(
        '{ "type": "service_account", "',
        "private_key",
        '_id": "',
        "0123456789abcdef0123456789abcdef",
        '" }',
      );
    const bearerLine = (token: string): string => assemble("Authorization: ", "Bearer", " ", token);
    const loyverseAssign = (sep: string, value: string): string =>
      assemble("LOYVERSE_", "API_TOKEN", sep, value);

    it("finds a line assigning a real value to LOYVERSE_API_TOKEN (.env commit / doc paste path)", () => {
      const cases = [
        loyverseAssign("=", "0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c"),
        loyverseAssign(' = "', '0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c"'),
        loyverseAssign(": '", "abcdefghijklmnopqrstuvwxyz'"),
      ];
      for (const content of cases) {
        const findings = scanContentForSecrets(".env", content);
        expect(
          findings.map((f) => f.patternName),
          `missed line: ${content}`,
        ).toEqual(["LOYVERSE_API_TOKEN assignment (real value)"]);
      }
    });

    it("does not false-positive LOYVERSE_API_TOKEN's empty value, short placeholder, or env-reading code", () => {
      const benign = [
        loyverseAssign("=", ""), // .env.example as-is
        loyverseAssign("=", "your-token"), // under 16 chars
        'const apiToken = process.env["LOYVERSE_API_TOKEN"];',
        "LOYVERSE_API_TOKEN is not set. Create one in Loyverse Back Office > Access tokens and add it to .env.",
        // Real false positive during implementation (.env example in docs/DESIGN.md): when 16+ chars of
        // text follow on the line after an empty value, `\s*` crossed the newline and took it as the
        // value — whitespace must be limited to the same line.
        [loyverseAssign("=", ""), "DATABASE_URL_PLACEHOLDER_NEXT_LINE"].join("\n"),
        [loyverseAssign("=", ""), "", `${assemble("Bearer", " ")}\n${"x".repeat(30)}`].join("\n"),
      ];
      for (const content of benign) {
        expect(scanContentForSecrets("a.ts", content), `false positive: ${content}`).toEqual([]);
      }
    });

    it("finds GitHub tokens (5 classic prefixes, fine-grained PAT)", () => {
      for (const prefix of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
        const findings = scanContentForSecrets("ci.yml", `token: ${ghToken(prefix)}`);
        expect(
          findings.map((f) => f.patternName),
          prefix,
        ).toEqual(["GitHub token"]);
      }
      const fine = scanContentForSecrets("a.ts", `const t = "${ghFinePat()}";`);
      expect(fine.map((f) => f.patternName)).toEqual(["GitHub fine-grained PAT"]);
    });

    it("finds an npm access token and does not false-positive ordinary identifiers starting with npm_", () => {
      expect(
        scanContentForSecrets(".npmrc", `//registry.npmjs.org/:_authToken=${npmToken()}`).map(
          (f) => f.patternName,
        ),
      ).toEqual(["npm access token"]);
      expect(scanContentForSecrets("a.ts", "const npm_audit_result = run();")).toEqual([]);
      expect(
        scanContentForSecrets("a.ts", `const short = "${assemble("npm_", "abc123")}";`),
      ).toEqual([]);
    });

    it("finds a Google API key and a service account JSON", () => {
      expect(
        scanContentForSecrets("a.ts", `key: "${googleApiKey()}"`).map((f) => f.patternName),
      ).toEqual(["Google API key"]);
      expect(scanContentForSecrets("sa.json", saJson()).map((f) => f.patternName)).toEqual([
        "Google service account JSON",
      ]);
    });

    it("finds a hardcoded Bearer token and does not false-positive the template (`Bearer ${token}`) or short values", () => {
      expect(
        scanContentForSecrets("a.ts", bearerLine("eyJhbGciOiJIUzI1NiJ9.realTokenValue123")).map(
          (f) => f.patternName,
        ),
      ).toEqual(["Bearer token (hardcoded)"]);
      // The shape in real code (loyverseClient.ts/resendProvider.ts) — no match because `$` is not in the character class.
      expect(scanContentForSecrets("a.ts", "Authorization: `Bearer ${apiToken}`,")).toEqual([]);
      expect(scanContentForSecrets("a.md", bearerLine("<token>"))).toEqual([]);
      expect(scanContentForSecrets("a.md", bearerLine("abc"))).toEqual([]);
    });

    it("new patterns also follow the secretscan-allow marker and the 8-char matchPreview rule", () => {
      const allowed = `${assemble("token: ", ghToken("ghp"))} // secretscan-allow: fixture`;
      expect(scanContentForSecrets("a.ts", allowed)).toEqual([]);
      const [finding] = scanContentForSecrets("a.ts", `t = ${ghToken("ghp")}`);
      expect(finding?.matchPreview).toBe("ghp_ABCD...");
    });
  });

  it("self-check: scanning this test file's own source yields 0 findings (SR2-SEC-002 — must pass CI without SELF_EXCLUDE)", () => {
    // scripts/secretScan.ts scans this file exactly like any other. If this fails, someone put a
    // complete secret literal back as a fixture — change it to be assembled with the assemble()
    // helpers above (do not revert to a file exclusion, that was the original defect).
    const selfPath = fileURLToPath(import.meta.url);
    const selfSource = readFileSync(selfPath, "utf8");
    expect(scanContentForSecrets("tests/secretScan.test.ts", selfSource)).toEqual([]);
  });
});
