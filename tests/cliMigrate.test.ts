/**
 * Unit-tests only the pure functions of `src/cli/migrate.ts` (npm-published bin
 * `retail-mcp-migrate`, second adversarial review SR2-REL-001) — the actual DB apply/check
 * (`applyMigrationsToDatabaseUrl`/`checkPendingMigrationsForDatabaseUrl`) needs a real Postgres
 * and is verified in tests/component/** (guardrail 2; this file is part of the default gate).
 */
import { describe, expect, it } from "vitest";
import { describeTarget } from "../src/cli/migrate.js";

describe("describeTarget (SR2-REL-001)", () => {
  it("keeps only host, port and db name and strips the credentials (user/password)", () => {
    const url = "postgres://myuser:mysecretpassword@ep-example.neon.tech:5432/mydb"; // secretscan-allow: test fixture, not a real key
    expect(describeTarget(url)).toBe("ep-example.neon.tech:5432/mydb");
  });

  it("shows no port when there is none", () => {
    const url = "postgres://user:pw@db.example.com/mydb"; // secretscan-allow: test fixture, not a real key
    expect(describeTarget(url)).toBe("db.example.com/mydb");
  });

  it("leaves the credentials nowhere in the result string", () => {
    const url = "postgres://very-secret-user:very-secret-password@host/db"; // secretscan-allow: test fixture, not a real key
    const result = describeTarget(url);
    expect(result).not.toContain("very-secret-user");
    expect(result).not.toContain("very-secret-password");
  });

  it("does not throw on a value that cannot be parsed as a URL and substitutes a notice instead", () => {
    expect(describeTarget("this-is-not-a-connection-string")).toBe(
      "(could not parse the connection string, so the target cannot be shown)",
    );
  });
});
