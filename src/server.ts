#!/usr/bin/env node
/**
 * MCP 서버 진입점 (DESIGN.md §6, §9). 도구 6종을 등록하는 조립만 한다 — 로직은
 * `src/mcp/tools.ts`에 있다(CLAUDE.md "server.ts는 도구 등록·조립만, 로직 없음").
 *
 * npm 패키지 `bin`(TASKS T29, DESIGN §12.1) — `package.json.bin.retail-mcp`가 빌드된
 * `dist/server.js`를 가리킨다. shebang은 tsc가 소스 첫 줄 그대로 산출물에 보존한다.
 *
 * 조회 도구 5종(sell_through/inventory_status/stockout_risk/reorder_suggestions/sync_status)은
 * 항상 등록한다. `sync_now`(쓰기)는 `SYNC_TOOL_ENABLED=true`일 때만 등록한다 — 운영 기본값은
 * 비활성이다(DESIGN §11.4). 동시 `sync_now` 호출은 advisory lock으로 하나만 통과시키고
 * 나머지는 즉시 "실행 중" 에러를 받는다(TESTING §7).
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
import { createWarehouseFromEnv } from "./adapters/warehouseFactory.js";
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

/** sync_now 전용 advisory lock 키 — scripts/migrate.ts의 MIGRATION_LOCK_KEY와 겹치지 않는 임의값. */
const SYNC_NOW_LOCK_KEY = 727_100_205;

// ── 환경설정 파싱 (IO 없음 — 테스트 가능) ────────────────────────────────

export interface ServerConfig {
  businessTimezone: string;
  staleThresholdHours: number;
  syncToolEnabled: boolean;
  /** 운영 기본값 비활성(가드레일 4 예외, TASKS T27) — 임의 SELECT 조회 도구를 등록할지. */
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
      `${envVarName} 값이 올바르지 않습니다: "${raw}". 0보다 큰 숫자를 지정하거나 .env에서 지우세요.`,
    );
  }
  return n;
}

/**
 * env에서 서버 설정을 읽고 검증한다. IO 없음 — process.env만 읽는다.
 *
 * `DATABASE_URL`은 더 이상 여기서 필수로 검증하지 않는다(T14) — 없으면 웨어하우스가
 * 임베디드 PGlite로 기본 동작한다(`createWarehouseFromEnv`, SPEC §12). 다만 `sync_now`는
 * advisory lock(pg 전용, DESIGN §11.4)이 필요해 `SYNC_TOOL_ENABLED=true`일 때만 예외적으로
 * `DATABASE_URL`을 요구한다.
 */
export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const businessTimezone = env["BUSINESS_TIMEZONE"];
  if (!businessTimezone) {
    throw new Error(
      "BUSINESS_TIMEZONE이 없습니다. 예: Asia/Manila. .env의 BUSINESS_TIMEZONE에 추가하세요.",
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
      "SYNC_TOOL_ENABLED=true인데 DATABASE_URL이 없습니다. sync_now는 Loyverse 동기화용 " +
        "advisory lock에 Postgres가 필요합니다 — Neon/Supabase 연결 문자열을 .env에 추가하거나 " +
        "SYNC_TOOL_ENABLED를 꺼두세요(임베디드 PGlite 경로에서는 sync_now를 쓸 수 없습니다).",
    );
  }
  const exploreSqlEnabled = env["EXPLORE_SQL_ENABLED"] === "true";
  // SEC-001/002(005 검수, TASKS T30) — explore_sql의 진짜 안전장치는 위험 함수 실행 권한이
  // 없는 전용 DB role인데, 임베디드 PGlite는 role 기반 권한 분리를 지원하지 않고
  // statement_timeout도 집행하지 않는다(SPEC §17 기존 한계). DATABASE_URL이 없으면(=임베디드
  // PGlite 경로, createWarehouseFromEnv와 같은 판정 기준) 두 안전장치가 전부 빠진 채로
  // explore_sql이 켜지는 셈이라 기본적으로 거부한다 — 위험을 이해하고도 켜야 하는 운영자를
  // 위해 EXPLORE_SQL_ALLOW_PGLITE=true로만 우회할 수 있다(SEND_MODE=live&&--confirm과 같은
  // "명시적 위험 인지" 패턴, DESIGN §12.4).
  if (exploreSqlEnabled && !env["DATABASE_URL"] && env["EXPLORE_SQL_ALLOW_PGLITE"] !== "true") {
    throw new Error(
      "EXPLORE_SQL_ENABLED=true인데 DATABASE_URL이 없습니다(임베디드 PGlite 경로) — PGlite는 " +
        "역할 기반 권한 분리와 statement_timeout 집행을 지원하지 않아 explore_sql의 두 안전장치가 " +
        "모두 빠집니다(docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md SEC-001/002). Neon/Supabase " +
        "등 실 Postgres에 위험 함수 실행 권한이 없는 전용 role로 연결하는 걸 강력히 권장합니다 " +
        "— 그래도 PGlite로 켜야 한다면 위험을 이해했다는 뜻으로 EXPLORE_SQL_ALLOW_PGLITE=true를 " +
        "함께 설정하세요.",
    );
  }
  return { businessTimezone, staleThresholdHours, syncToolEnabled, exploreSqlEnabled };
}

// ── 도구 결과 포장 ───────────────────────────────────────────────────────

function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function errorResult(err: unknown): CallToolResult {
  // 시크릿·외부 응답 원문을 담지 않는다(DESIGN §11.4) — 어댑터들은 이미 원인만 담은 Error를
  // 던지도록 만들어져 있으므로(loyverseClient/resendProvider 등) message만 그대로 노출한다.
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

// ── 도구 등록 (조립만) ───────────────────────────────────────────────────

export interface RegisterToolsDeps {
  warehouse: Warehouse;
  clock: Clock;
  config: ServerConfig;
  /** sync_now에서만 쓴다. SYNC_TOOL_ENABLED=false면 아예 참조하지 않는다. */
  loyverseClient?: LoyverseClient;
  /** sync_now의 advisory lock 실행기. SYNC_TOOL_ENABLED=false면 아예 참조하지 않는다. */
  runExclusively?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** explore_sql에서만 쓴다. EXPLORE_SQL_ENABLED=false면 아예 참조하지 않는다(TASKS T27). */
  exploreSqlExecutor?: ExploreSqlExecutor;
}

/** 실제로 등록한 도구 이름 목록을 반환한다 — SYNC_TOOL_ENABLED 분기를 테스트로 확인하기 위함. */
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
      title: "셀스루(근사) 조회",
      description:
        "기간 판매수량 대비 기말재고로 근사 셀스루율을 계산한다(SPEC §2). 정통 정의(입고 기반)는 v0.2.",
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
      title: "현재고 + 커버일수 조회",
      description: "현재고와 재고커버일수(SPEC §2)를 매장·품목별로 반환한다.",
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
      title: "품절위험 조회",
      description: "재고커버일수 < 리드타임+안전일수인 품목과 예상 소진일을 반환한다(SPEC §2).",
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
      title: "재주문 제안 조회",
      description:
        "지점별 재주문 제안 수량 표를 반환한다 — 재주문 에이전트(npm run agent:reorder)와 완전히 " +
        "동일한 계산 함수를 쓴다(DESIGN §6).",
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
      title: "동기화 상태 조회",
      description: "리소스별 watermark(cursor)와 마지막 동기화 시각을 반환한다.",
      inputSchema: {},
    },
    () => wrap(() => syncStatusTool({ warehouse: deps.warehouse, clock: deps.clock })),
  );
  registered.push("sync_status");

  if (deps.config.syncToolEnabled) {
    if (!deps.loyverseClient || !deps.runExclusively) {
      throw new Error(
        "SYNC_TOOL_ENABLED=true인데 loyverseClient/runExclusively가 조립되지 않았습니다 " +
          "(server.ts 조립 버그 — createRetailMcpServer() 호출부를 확인하세요).",
      );
    }
    const loyverseClient = deps.loyverseClient;
    const runExclusively = deps.runExclusively;
    server.registerTool(
      "sync_now",
      {
        title: "즉시 동기화 실행 (쓰기)",
        description:
          "Loyverse에서 즉시 증분 동기화한다. 운영 기본값은 비활성 — SYNC_TOOL_ENABLED=true일 " +
          "때만 등록된다(DESIGN §11.4). 동시 호출은 하나만 실행되고 나머지는 즉시 오류를 받는다.",
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
        "EXPLORE_SQL_ENABLED=true인데 exploreSqlExecutor가 조립되지 않았습니다 " +
          "(server.ts 조립 버그 — createRetailMcpServer() 호출부를 확인하세요).",
      );
    }
    const exploreSqlExecutor = deps.exploreSqlExecutor;
    server.registerTool(
      "explore_sql",
      {
        title: "임의 SELECT 조회 (읽기 전용)",
        description:
          "select/with(CTE)로 시작하는 단일 조회문만 BEGIN READ ONLY 트랜잭션 안에서 실행한다 " +
          "— 데이터를 바꾸는 어떤 시도도 Postgres 엔진 자체가 거부한다. 운영 기본값은 비활성 " +
          "— EXPLORE_SQL_ENABLED=true일 때만 등록된다(가드레일 4 예외, DESIGN §6이 이름으로 " +
          "미리 예고해둔 도구). 주요 테이블: stores, products, sales_lines, sales_period_agg, " +
          "inventory_levels, purchase_receipts, sync_state, agent_send_log.",
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

// ── CLI 진입점 (조립만) ───────────────────────────────────────────────────

export async function createRetailMcpServer(): Promise<{
  server: McpServer;
  close: () => Promise<void>;
}> {
  const config = resolveServerConfig();
  const handle = await createWarehouseFromEnv();
  const clock = createSystemClock();

  const server = new McpServer({ name: "retail-mcp", version: "0.1.0" });

  const registerDeps: RegisterToolsDeps = { warehouse: handle.warehouse, clock, config };
  if (config.syncToolEnabled) {
    // resolveServerConfig가 SYNC_TOOL_ENABLED=true면 DATABASE_URL을 이미 요구했으므로
    // handle.kind는 항상 "pg"이고 pgPool이 존재한다.
    const pool = handle.pgPool;
    if (!pool) {
      throw new Error(
        "SYNC_TOOL_ENABLED=true인데 pg.Pool이 없습니다(내부 불변조건 위반) — DATABASE_URL 설정을 확인하세요.",
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
    // 시크릿·연결 정보는 로그에 남기지 않는다(CLAUDE.md 구현 해석 보충) — kind만 언급한다.
    // stdout은 MCP JSON-RPC 프로토콜 전용이라 stderr로만 쓴다(console.warn 기본 동작).
    console.warn(
      `[retail-mcp] explore_sql이 활성화됐습니다(웨어하우스: ${handle.kind}). 위험 함수 실행 ` +
        "권한이 없는 전용 DB role로 운영하는 걸 강력히 권장합니다 — BEGIN READ ONLY는 테이블/" +
        "시퀀스 쓰기만 막고 advisory lock 같은 세션 부수효과까지 막지는 않습니다(SEC-001/002, " +
        "docs/005_SECURITY_AND_DEPENDENCY_REVIEW.md).",
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
