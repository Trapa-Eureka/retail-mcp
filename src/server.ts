#!/usr/bin/env node
/**
 * MCP server entry point (DESIGN.md §6, §9). Only assembles and registers the 6 tools — the
 * logic lives in `src/mcp/tools.ts` (CLAUDE.md: "server.ts only registers/assembles tools, no
 * logic").
 *
 * npm package `bin` (TASKS T29, DESIGN §12.1) — `package.json.bin.retail-mcp` points at the
 * built `dist/server.js`. tsc preserves the shebang from the first source line in the output.
 *
 * The 5 query tools (sell_through/inventory_status/stockout_risk/reorder_suggestions/sync_status)
 * are always registered. `sync_now` (write) is registered only when `SYNC_TOOL_ENABLED=true` —
 * the production default is disabled (DESIGN §11.4). Concurrent `sync_now` calls are serialized
 * by an advisory lock: only one passes and the rest immediately receive an "already running"
 * error (TESTING §7).
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { withTryAdvisoryLock } from "./adapters/advisoryLock.js";
import {
  createExploreSqlExecutor,
  EXPLORE_SQL_MAX_LIMIT,
  EXPLORE_SQL_MAX_TIMEOUT_MS,
} from "./adapters/exploreSqlExecutor.js";
import { createLoyverseClientFromEnv } from "./adapters/loyverseClient.js";
import { isMainModule } from "./adapters/mainModule.js";
import { createSystemClock } from "./adapters/systemClock.js";
import {
  createWarehouseFromEnv,
  ensureNetworkMigrationsApplied,
} from "./adapters/warehouseFactory.js";
import { DEFAULT_STALE_THRESHOLD_HOURS } from "./core/freshness.js";
import {
  DEFAULT_LEAD_TIME_DAYS,
  DEFAULT_SAFETY_DAYS,
  DEFAULT_TARGET_COVER_DAYS,
} from "./core/metrics.js";
import type { Clock, ExploreSqlExecutor, LoyverseClient, Warehouse } from "./core/types.js";
import {
  exploreSqlTool,
  inventoryStatusTool,
  reorderSuggestionsTool,
  sellThroughTool,
  stockoutRiskTool,
  syncNowTool,
  syncStatusTool,
  type QueryToolDeps,
} from "./mcp/tools.js";

/** Advisory lock key dedicated to sync_now — arbitrary value that does not collide with MIGRATION_LOCK_KEY in scripts/migrate.ts. */
const SYNC_NOW_LOCK_KEY = 727_100_205;

// ── Config parsing (no IO — testable) ────────────────────────────────────

export interface ServerConfig {
  businessTimezone: string;
  staleThresholdHours: number;
  syncToolEnabled: boolean;
  /** Disabled by default in production (guardrail 4 exception, TASKS T27) — whether to register the arbitrary SELECT query tool. */
  exploreSqlEnabled: boolean;
}

function parsePositiveNumber(
  envVarName: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${envVarName} has an invalid value: "${raw}". Set a number greater than 0 or remove it from .env.`,
    );
  }
  return n;
}

/**
 * Reads and validates the server config from env. No IO — reads process.env only.
 *
 * `DATABASE_URL` is no longer required here (T14) — without it the warehouse defaults to
 * embedded PGlite (`createWarehouseFromEnv`, SPEC §12). `sync_now`, however, needs an advisory
 * lock (pg only, DESIGN §11.4), so `DATABASE_URL` is required as an exception only when
 * `SYNC_TOOL_ENABLED=true`.
 */
export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const businessTimezone = env["BUSINESS_TIMEZONE"];
  if (!businessTimezone) {
    throw new Error(
      "BUSINESS_TIMEZONE is not set. Example: Asia/Manila. Add BUSINESS_TIMEZONE to .env.",
    );
  }
  const staleThresholdHours = parsePositiveNumber(
    "STALE_THRESHOLD_HOURS",
    env["STALE_THRESHOLD_HOURS"],
    DEFAULT_STALE_THRESHOLD_HOURS,
  );
  const syncToolEnabled = env["SYNC_TOOL_ENABLED"] === "true";
  if (syncToolEnabled && !env["DATABASE_URL"]) {
    throw new Error(
      "SYNC_TOOL_ENABLED=true but DATABASE_URL is not set. sync_now needs Postgres for the " +
        "advisory lock that serializes Loyverse syncs — add a Neon/Supabase connection string to " +
        ".env or turn SYNC_TOOL_ENABLED off (sync_now is not available on the embedded PGlite path).",
    );
  }
  const exploreSqlEnabled = env["EXPLORE_SQL_ENABLED"] === "true";
  // SEC-001/002 (review 005, TASKS T30) — the real safeguard for explore_sql is a dedicated DB
  // role without permission to execute dangerous functions, but embedded PGlite supports neither
  // role-based privilege separation nor statement_timeout enforcement (known limitation, SPEC
  // §17). Without DATABASE_URL (= the embedded PGlite path, same criterion as
  // createWarehouseFromEnv) explore_sql would be enabled with both safeguards missing, so it is
  // refused by default — an operator who understands the risk and still needs it can bypass this
  // only with EXPLORE_SQL_ALLOW_PGLITE=true (the same "explicit risk acknowledgement" pattern as
  // SEND_MODE=live && --confirm, DESIGN §12.4).
  if (exploreSqlEnabled && !env["DATABASE_URL"] && env["EXPLORE_SQL_ALLOW_PGLITE"] !== "true") {
    throw new Error(
      "EXPLORE_SQL_ENABLED=true but DATABASE_URL is not set (embedded PGlite path) — PGlite " +
        "supports neither role-based privilege separation nor statement_timeout enforcement, so " +
        "both explore_sql safeguards are missing (docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md " +
        "SEC-001/002). We strongly recommend connecting to a real Postgres (Neon/Supabase etc.) " +
        "with a dedicated role that cannot execute dangerous functions — if you still need to " +
        "enable it on PGlite, also set EXPLORE_SQL_ALLOW_PGLITE=true to acknowledge the risk.",
    );
  }
  return { businessTimezone, staleThresholdHours, syncToolEnabled, exploreSqlEnabled };
}

// ── Tool result wrapping ─────────────────────────────────────────────────

function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function errorResult(err: unknown): CallToolResult {
  // Never include secrets or raw external responses (DESIGN §11.4) — the adapters
  // (loyverseClient/resendProvider etc.) already throw Errors carrying only the cause, so the
  // message is exposed as-is.
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function wrap(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

// ── Tool registration (assembly only) ────────────────────────────────────

export interface RegisterToolsDeps {
  warehouse: Warehouse;
  clock: Clock;
  config: ServerConfig;
  /** Used by sync_now only. Never referenced when SYNC_TOOL_ENABLED=false. */
  loyverseClient?: LoyverseClient;
  /** Advisory-lock runner for sync_now. Never referenced when SYNC_TOOL_ENABLED=false. */
  runExclusively?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Used by explore_sql only. Never referenced when EXPLORE_SQL_ENABLED=false (TASKS T27). */
  exploreSqlExecutor?: ExploreSqlExecutor;
}

/** Returns the list of tool names actually registered — so tests can verify the SYNC_TOOL_ENABLED branch. */
export function registerTools(server: McpServer, deps: RegisterToolsDeps): string[] {
  const registered: string[] = [];
  const queryDeps: QueryToolDeps = {
    warehouse: deps.warehouse,
    clock: deps.clock,
    businessTimezone: deps.config.businessTimezone,
    staleThresholdHours: deps.config.staleThresholdHours,
  };

  server.registerTool(
    "sell_through",
    {
      title: "Sell-through (approximate)",
      description:
        "Computes the approximate sell-through rate from period sales quantity versus ending stock (SPEC §2). The canonical definition (receipt-based) comes in v0.2.",
      inputSchema: {
        store_id: z.string().optional(),
        category: z.string().optional(),
        period_days: z.number().int().positive().default(30),
        order: z.enum(["asc", "desc"]).default("desc"),
        top: z.number().int().positive().max(500).default(20),
      },
    },
    (args) =>
      wrap(() =>
        sellThroughTool(queryDeps, {
          ...(args.store_id !== undefined ? { storeId: args.store_id } : {}),
          ...(args.category !== undefined ? { category: args.category } : {}),
          periodDays: args.period_days,
          order: args.order,
          top: args.top,
        }),
      ),
  );
  registered.push("sell_through");

  server.registerTool(
    "inventory_status",
    {
      title: "Current stock + days of cover",
      description: "Returns current stock and days of cover (SPEC §2) per store and item.",
      inputSchema: {
        store_id: z.string().optional(),
        below_days_cover: z.number().positive().optional(),
      },
    },
    (args) =>
      wrap(() =>
        inventoryStatusTool(queryDeps, {
          ...(args.store_id !== undefined ? { storeId: args.store_id } : {}),
          ...(args.below_days_cover !== undefined ? { belowDaysCover: args.below_days_cover } : {}),
        }),
      ),
  );
  registered.push("inventory_status");

  server.registerTool(
    "stockout_risk",
    {
      title: "Stockout risk",
      description:
        "Returns items whose days of cover < lead time + safety days, with the expected stockout date (SPEC §2).",
      inputSchema: {
        store_id: z.string().optional(),
        lead_time_days: z.number().int().nonnegative().default(DEFAULT_LEAD_TIME_DAYS),
        safety_days: z.number().int().nonnegative().default(DEFAULT_SAFETY_DAYS),
      },
    },
    (args) =>
      wrap(() =>
        stockoutRiskTool(queryDeps, {
          ...(args.store_id !== undefined ? { storeId: args.store_id } : {}),
          leadTimeDays: args.lead_time_days,
          safetyDays: args.safety_days,
        }),
      ),
  );
  registered.push("stockout_risk");

  server.registerTool(
    "reorder_suggestions",
    {
      title: "Reorder suggestions",
      description:
        "Returns the per-branch reorder suggestion table — uses exactly the same calculation " +
        "function as the reorder agent (npm run agent:reorder) (DESIGN §6).",
      inputSchema: {
        store_id: z.string().optional(),
        target_days_cover: z.number().int().positive().default(DEFAULT_TARGET_COVER_DAYS),
        lead_time_days: z.number().int().nonnegative().default(DEFAULT_LEAD_TIME_DAYS),
      },
    },
    (args) =>
      wrap(() =>
        reorderSuggestionsTool(queryDeps, {
          ...(args.store_id !== undefined ? { storeId: args.store_id } : {}),
          targetDaysCover: args.target_days_cover,
          leadTimeDays: args.lead_time_days,
        }),
      ),
  );
  registered.push("reorder_suggestions");

  server.registerTool(
    "sync_status",
    {
      title: "Sync status",
      description: "Returns the watermark (cursor) and last sync time per resource.",
      inputSchema: {},
    },
    () => wrap(() => syncStatusTool({ warehouse: deps.warehouse, clock: deps.clock })),
  );
  registered.push("sync_status");

  if (deps.config.syncToolEnabled) {
    if (!deps.loyverseClient || !deps.runExclusively) {
      throw new Error(
        "SYNC_TOOL_ENABLED=true but loyverseClient/runExclusively were not assembled " +
          "(server.ts assembly bug — check the createRetailMcpServer() call site).",
      );
    }
    const loyverseClient = deps.loyverseClient;
    const runExclusively = deps.runExclusively;
    server.registerTool(
      "sync_now",
      {
        title: "Run sync now (write)",
        description:
          "Runs an incremental sync from Loyverse immediately. Disabled by default in production — " +
          "registered only when SYNC_TOOL_ENABLED=true (DESIGN §11.4). Of concurrent calls only one runs; the rest receive an error immediately.",
        inputSchema: {
          resources: z.array(z.enum(["stores", "items", "receipts", "inventory"])).optional(),
        },
      },
      (args) =>
        wrap(() =>
          syncNowTool(
            { loyverseClient, warehouse: deps.warehouse, clock: deps.clock, runExclusively },
            args.resources !== undefined ? { resources: args.resources } : {},
          ),
        ),
    );
    registered.push("sync_now");
  }

  if (deps.config.exploreSqlEnabled) {
    if (!deps.exploreSqlExecutor) {
      throw new Error(
        "EXPLORE_SQL_ENABLED=true but exploreSqlExecutor was not assembled " +
          "(server.ts assembly bug — check the createRetailMcpServer() call site).",
      );
    }
    const exploreSqlExecutor = deps.exploreSqlExecutor;
    server.registerTool(
      "explore_sql",
      {
        title: "Arbitrary SELECT query (read-only)",
        description:
          "Runs a single query statement starting with select/with (CTE) inside a BEGIN READ ONLY " +
          "transaction — any attempt to change data is rejected by the Postgres engine itself. " +
          "Disabled by default in production — registered only when EXPLORE_SQL_ENABLED=true " +
          "(guardrail 4 exception, the tool DESIGN §6 announced by name). Main tables: stores, " +
          "products, sales_lines, sales_period_agg, inventory_levels, purchase_receipts, " +
          "sync_state, agent_send_log.",
        inputSchema: {
          sql: z.string().min(1),
          limit: z.number().int().positive().max(EXPLORE_SQL_MAX_LIMIT).optional(),
          timeout_ms: z.number().int().positive().max(EXPLORE_SQL_MAX_TIMEOUT_MS).optional(),
        },
      },
      (args) =>
        wrap(() =>
          exploreSqlTool(
            { executor: exploreSqlExecutor },
            {
              sql: args.sql,
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
              ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
            },
          ),
        ),
    );
    registered.push("explore_sql");
  }

  return registered;
}

// ── CLI entry point (assembly only) ──────────────────────────────────────

export async function createRetailMcpServer(): Promise<{
  server: McpServer;
  close: () => Promise<void>;
}> {
  const config = resolveServerConfig();
  const handle = await createWarehouseFromEnv();
  // SR2-REL-001 (second adversarial review) — on the network Postgres (DATABASE_URL) path, if
  // the schema is missing or only partially applied, stop right here with clear guidance instead
  // of a raw Postgres error. The embedded PGlite path is already auto-migrated, so this is a no-op.
  await ensureNetworkMigrationsApplied(handle);
  const clock = createSystemClock();

  const server = new McpServer({ name: "retail-mcp", version: "0.1.0" });

  const registerDeps: RegisterToolsDeps = { warehouse: handle.warehouse, clock, config };
  if (config.syncToolEnabled) {
    // resolveServerConfig already required DATABASE_URL when SYNC_TOOL_ENABLED=true, so
    // handle.kind is always "pg" and pgPool exists.
    const pool = handle.pgPool;
    if (!pool) {
      throw new Error(
        "SYNC_TOOL_ENABLED=true but there is no pg.Pool (internal invariant violated) — check the DATABASE_URL setting.",
      );
    }
    registerDeps.loyverseClient = createLoyverseClientFromEnv();
    registerDeps.runExclusively = async <T>(fn: () => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        return await withTryAdvisoryLock(client, SYNC_NOW_LOCK_KEY, fn);
      } finally {
        client.release();
      }
    };
  }
  if (config.exploreSqlEnabled) {
    registerDeps.exploreSqlExecutor = createExploreSqlExecutor(handle.connectionProvider);
    // Never log secrets or connection details (CLAUDE.md implementation notes) — mention only
    // the kind. stdout is reserved for the MCP JSON-RPC protocol, so write to stderr only
    // (console.warn's default behaviour).
    console.warn(
      `[retail-mcp] explore_sql is enabled (warehouse: ${handle.kind}). We strongly recommend ` +
        "operating with a dedicated DB role that cannot execute dangerous functions — BEGIN READ " +
        "ONLY only blocks table/sequence writes and does not block session side effects such as " +
        "advisory locks (SEC-001/002, docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md).",
    );
  }
  registerTools(server, registerDeps);

  return { server, close: () => handle.close() };
}

async function main(): Promise<void> {
  const { server } = await createRetailMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
