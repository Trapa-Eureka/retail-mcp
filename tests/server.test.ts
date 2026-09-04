import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveServerConfig, registerTools, type RegisterToolsDeps } from "../src/server.js";
import { createExploreSqlExecutor } from "../src/adapters/exploreSqlExecutor.js";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";

const ORIGINAL_ENV = { ...process.env };

describe("resolveServerConfig", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("passes without error even when DATABASE_URL is missing (T14 — defaults to embedded PGlite)", () => {
    expect(() => resolveServerConfig({ BUSINESS_TIMEZONE: "Asia/Manila" })).not.toThrow();
  });

  it("throws an error carrying the cause when SYNC_TOOL_ENABLED=true but DATABASE_URL is missing", () => {
    expect(() =>
      resolveServerConfig({ BUSINESS_TIMEZONE: "Asia/Manila", SYNC_TOOL_ENABLED: "true" }),
    ).toThrow(/DATABASE_URL/);
  });

  it("throws an error carrying the cause when BUSINESS_TIMEZONE is missing", () => {
    expect(() => resolveServerConfig({ DATABASE_URL: "postgres://x" })).toThrow(
      /BUSINESS_TIMEZONE/,
    );
  });

  it("applies the STALE_THRESHOLD_HOURS/SYNC_TOOL_ENABLED defaults", () => {
    const config = resolveServerConfig({
      DATABASE_URL: "postgres://x",
      BUSINESS_TIMEZONE: "Asia/Manila",
    });
    expect(config.staleThresholdHours).toBe(24);
    expect(config.syncToolEnabled).toBe(false);
  });

  it("reflects SYNC_TOOL_ENABLED=true and STALE_THRESHOLD_HOURS", () => {
    const config = resolveServerConfig({
      DATABASE_URL: "postgres://x",
      BUSINESS_TIMEZONE: "Asia/Manila",
      SYNC_TOOL_ENABLED: "true",
      STALE_THRESHOLD_HOURS: "6",
    });
    expect(config.syncToolEnabled).toBe(true);
    expect(config.staleThresholdHours).toBe(6);
  });

  it("throws an error carrying the cause when STALE_THRESHOLD_HOURS is not a number", () => {
    expect(() =>
      resolveServerConfig({
        DATABASE_URL: "postgres://x",
        BUSINESS_TIMEZONE: "Asia/Manila",
        STALE_THRESHOLD_HOURS: "not-a-number",
      }),
    ).toThrow(/STALE_THRESHOLD_HOURS/);
  });

  it("EXPLORE_SQL_ENABLED defaults to false (TASKS T27, disabled by default in production)", () => {
    const config = resolveServerConfig({ BUSINESS_TIMEZONE: "Asia/Manila" });
    expect(config.exploreSqlEnabled).toBe(false);
  });

  it("reflects EXPLORE_SQL_ENABLED=true without further confirmation when DATABASE_URL is set (real Postgres)", () => {
    const config = resolveServerConfig({
      BUSINESS_TIMEZONE: "Asia/Manila",
      DATABASE_URL: "postgres://x",
      EXPLORE_SQL_ENABLED: "true",
    });
    expect(config.exploreSqlEnabled).toBe(true);
  });

  it("refuses with an error carrying the cause when EXPLORE_SQL_ENABLED=true but DATABASE_URL is missing (embedded PGlite) (TASKS T30, SEC-001/002)", () => {
    expect(() =>
      resolveServerConfig({
        BUSINESS_TIMEZONE: "Asia/Manila",
        EXPLORE_SQL_ENABLED: "true",
      }),
    ).toThrow(/EXPLORE_SQL_ALLOW_PGLITE/);
  });

  it("reflects EXPLORE_SQL_ENABLED=true + EXPLORE_SQL_ALLOW_PGLITE=true even without DATABASE_URL, accepting the risk", () => {
    const config = resolveServerConfig({
      BUSINESS_TIMEZONE: "Asia/Manila",
      EXPLORE_SQL_ENABLED: "true",
      EXPLORE_SQL_ALLOW_PGLITE: "true",
    });
    expect(config.exploreSqlEnabled).toBe(true);
  });
});

describe("registerTools — SYNC_TOOL_ENABLED gating (DESIGN §11.4)", () => {
  async function makeDeps(syncToolEnabled: boolean): Promise<RegisterToolsDeps> {
    const db = await createTestWarehouse();
    const warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    const base: RegisterToolsDeps = {
      warehouse,
      clock: createFixedClock("2026-09-01T00:00:00Z"),
      config: {
        businessTimezone: "Asia/Manila",
        staleThresholdHours: 24,
        syncToolEnabled,
        exploreSqlEnabled: false,
      },
    };
    if (!syncToolEnabled) return base;
    return {
      ...base,
      loyverseClient: {
        listStores: () => Promise.resolve([]),
        listItems: () => Promise.resolve({ items: [], cursor: null }),
        listReceipts: () => Promise.resolve({ items: [], cursor: null }),
        listInventory: () => Promise.resolve({ items: [], cursor: null }),
      },
      runExclusively: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
    };
  }

  it("does not register sync_now when SYNC_TOOL_ENABLED=false (production default)", async () => {
    const deps = await makeDeps(false);
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    const registered = registerTools(server, deps);
    expect(registered).toEqual([
      "sell_through",
      "inventory_status",
      "stockout_risk",
      "reorder_suggestions",
      "sync_status",
    ]);
    expect(registered).not.toContain("sync_now");
  });

  it("registers all 6 tools including sync_now when SYNC_TOOL_ENABLED=true", async () => {
    const deps = await makeDeps(true);
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    const registered = registerTools(server, deps);
    expect(registered).toContain("sync_now");
    expect(registered).toHaveLength(6);
  });

  it("throws an assembly error when SYNC_TOOL_ENABLED=true but loyverseClient/runExclusively are missing", async () => {
    const base = await makeDeps(false);
    const deps: RegisterToolsDeps = {
      ...base,
      config: { ...base.config, syncToolEnabled: true },
    };
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    expect(() => registerTools(server, deps)).toThrow(/assembl/);
  });
});

describe("registerTools — EXPLORE_SQL_ENABLED gating (TASKS T27, guardrail 4 exception)", () => {
  async function makeDeps(exploreSqlEnabled: boolean): Promise<RegisterToolsDeps> {
    const db = await createTestWarehouse();
    const warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
    const base: RegisterToolsDeps = {
      warehouse,
      clock: createFixedClock("2026-09-01T00:00:00Z"),
      config: {
        businessTimezone: "Asia/Manila",
        staleThresholdHours: 24,
        syncToolEnabled: false,
        exploreSqlEnabled,
      },
    };
    if (!exploreSqlEnabled) return base;
    return {
      ...base,
      exploreSqlExecutor: createExploreSqlExecutor(createPgliteConnectionProvider(db)),
    };
  }

  it("does not register explore_sql when EXPLORE_SQL_ENABLED=false (production default)", async () => {
    const deps = await makeDeps(false);
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    const registered = registerTools(server, deps);
    expect(registered).not.toContain("explore_sql");
  });

  it("registers all 6 tools including explore_sql when EXPLORE_SQL_ENABLED=true", async () => {
    const deps = await makeDeps(true);
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    const registered = registerTools(server, deps);
    expect(registered).toContain("explore_sql");
    expect(registered).toHaveLength(6);
  });

  it("throws an assembly error when EXPLORE_SQL_ENABLED=true but exploreSqlExecutor is missing", async () => {
    const base = await makeDeps(false);
    const deps: RegisterToolsDeps = {
      ...base,
      config: { ...base.config, exploreSqlEnabled: true },
    };
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    expect(() => registerTools(server, deps)).toThrow(/assembl/);
  });
});
