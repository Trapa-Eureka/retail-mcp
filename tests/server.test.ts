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

  it("DATABASE_URL이 없어도 에러 없이 통과한다(T14 — 임베디드 PGlite로 기본 동작)", () => {
    expect(() => resolveServerConfig({ BUSINESS_TIMEZONE: "Asia/Manila" })).not.toThrow();
  });

  it("SYNC_TOOL_ENABLED=true인데 DATABASE_URL이 없으면 원인이 담긴 에러를 던진다", () => {
    expect(() =>
      resolveServerConfig({ BUSINESS_TIMEZONE: "Asia/Manila", SYNC_TOOL_ENABLED: "true" }),
    ).toThrow(/DATABASE_URL/);
  });

  it("BUSINESS_TIMEZONE이 없으면 원인이 담긴 에러를 던진다", () => {
    expect(() => resolveServerConfig({ DATABASE_URL: "postgres://x" })).toThrow(
      /BUSINESS_TIMEZONE/,
    );
  });

  it("STALE_THRESHOLD_HOURS/SYNC_TOOL_ENABLED 기본값을 적용한다", () => {
    const config = resolveServerConfig({
      DATABASE_URL: "postgres://x",
      BUSINESS_TIMEZONE: "Asia/Manila",
    });
    expect(config.staleThresholdHours).toBe(24);
    expect(config.syncToolEnabled).toBe(false);
  });

  it("SYNC_TOOL_ENABLED=true와 STALE_THRESHOLD_HOURS를 반영한다", () => {
    const config = resolveServerConfig({
      DATABASE_URL: "postgres://x",
      BUSINESS_TIMEZONE: "Asia/Manila",
      SYNC_TOOL_ENABLED: "true",
      STALE_THRESHOLD_HOURS: "6",
    });
    expect(config.syncToolEnabled).toBe(true);
    expect(config.staleThresholdHours).toBe(6);
  });

  it("STALE_THRESHOLD_HOURS가 숫자가 아니면 원인이 담긴 에러를 던진다", () => {
    expect(() =>
      resolveServerConfig({
        DATABASE_URL: "postgres://x",
        BUSINESS_TIMEZONE: "Asia/Manila",
        STALE_THRESHOLD_HOURS: "not-a-number",
      }),
    ).toThrow(/STALE_THRESHOLD_HOURS/);
  });

  it("EXPLORE_SQL_ENABLED 기본값은 false다(TASKS T27, 운영 기본값 비활성)", () => {
    const config = resolveServerConfig({ BUSINESS_TIMEZONE: "Asia/Manila" });
    expect(config.exploreSqlEnabled).toBe(false);
  });

  it("EXPLORE_SQL_ENABLED=true를 반영한다 — DATABASE_URL 없이도(임베디드 PGlite에서도 동작)", () => {
    const config = resolveServerConfig({
      BUSINESS_TIMEZONE: "Asia/Manila",
      EXPLORE_SQL_ENABLED: "true",
    });
    expect(config.exploreSqlEnabled).toBe(true);
  });
});

describe("registerTools — SYNC_TOOL_ENABLED 게이팅 (DESIGN §11.4)", () => {
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

  it("SYNC_TOOL_ENABLED=false면 sync_now를 등록하지 않는다(운영 기본값)", async () => {
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

  it("SYNC_TOOL_ENABLED=true면 sync_now를 포함한 6종을 등록한다", async () => {
    const deps = await makeDeps(true);
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    const registered = registerTools(server, deps);
    expect(registered).toContain("sync_now");
    expect(registered).toHaveLength(6);
  });

  it("SYNC_TOOL_ENABLED=true인데 loyverseClient/runExclusively가 없으면 조립 오류를 던진다", async () => {
    const base = await makeDeps(false);
    const deps: RegisterToolsDeps = {
      ...base,
      config: { ...base.config, syncToolEnabled: true },
    };
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    expect(() => registerTools(server, deps)).toThrow(/조립/);
  });
});

describe("registerTools — EXPLORE_SQL_ENABLED 게이팅 (TASKS T27, 가드레일 4 예외)", () => {
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

  it("EXPLORE_SQL_ENABLED=false면 explore_sql을 등록하지 않는다(운영 기본값)", async () => {
    const deps = await makeDeps(false);
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    const registered = registerTools(server, deps);
    expect(registered).not.toContain("explore_sql");
  });

  it("EXPLORE_SQL_ENABLED=true면 explore_sql을 포함한 6종을 등록한다", async () => {
    const deps = await makeDeps(true);
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    const registered = registerTools(server, deps);
    expect(registered).toContain("explore_sql");
    expect(registered).toHaveLength(6);
  });

  it("EXPLORE_SQL_ENABLED=true인데 exploreSqlExecutor가 없으면 조립 오류를 던진다", async () => {
    const base = await makeDeps(false);
    const deps: RegisterToolsDeps = {
      ...base,
      config: { ...base.config, exploreSqlEnabled: true },
    };
    const server = new McpServer({ name: "retail-mcp-test", version: "0.0.0" });
    expect(() => registerTools(server, deps)).toThrow(/조립/);
  });
});
