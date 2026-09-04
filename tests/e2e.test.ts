/**
 * MCP e2e (T10, TASKS.md completion criteria): with a real MCP SDK client, verifies the
 * sync_now → sell_through → reorder_suggestions scenario through the same request/response shape
 * as the stdio protocol (JSON-RPC over Transport). No real process is spawned; Client↔Server are
 * linked in the same process via InMemoryTransport — keeping the zero-network principle
 * (TESTING §1) while still actually exercising the protocol layer (zod input validation,
 * registerTool registration, CallToolResult wrapping), which makes this stronger than a unit test
 * calling the `src/mcp/tools.ts` functions directly.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerTools, type RegisterToolsDeps } from "../src/server.js";
import { buildReorderReport } from "../src/agent/reorder.js";
import { createTestWarehouse } from "../src/mocks/pglite.js";
import { createPgWarehouse, createPgliteConnectionProvider } from "../src/adapters/pgWarehouse.js";
import { createFixtureLoyverseClient } from "../src/mocks/fixtureLoyverseClient.js";
import { createFixedClock } from "../src/mocks/fixedClock.js";
import type { Clock, ReorderReport, Warehouse } from "../src/core/types.js";

// The fixtures (fixtures/loyverse/*.json) anchor "today" at 2026-09-01T00:00:00Z (T2).
const NOW_ISO = "2026-09-01T00:00:00.000Z";
const BUSINESS_TIMEZONE = "Asia/Manila";

async function setupServer(): Promise<{ client: Client; warehouse: Warehouse; clock: Clock }> {
  const db = await createTestWarehouse();
  const warehouse = createPgWarehouse(createPgliteConnectionProvider(db));
  const loyverseClient = await createFixtureLoyverseClient({ receiptsPageSize: 50 });
  const clock = createFixedClock(NOW_ISO);

  const server = new McpServer({ name: "retail-mcp-e2e", version: "0.0.0" });
  const deps: RegisterToolsDeps = {
    warehouse,
    clock,
    config: {
      businessTimezone: BUSINESS_TIMEZONE,
      staleThresholdHours: 24,
      syncToolEnabled: true, // enabled because the e2e scenario must include sync_now.
      exploreSqlEnabled: false,
    },
    loyverseClient,
    runExclusively: async (fn) => fn(),
  };
  registerTools(server, deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e-test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, warehouse, clock };
}

/**
 * The return type of client.callTool() is a union with the experimental task result, so it does not
 * narrow to CallToolResult directly — our server does not use tasks (already confirmed at runtime),
 * so it is asserted here.
 */
function structuredOf<T>(result: unknown): T {
  const r = result as CallToolResult;
  if (r.isError) {
    throw new Error(`The tool call returned an error: ${JSON.stringify(r.content)}`);
  }
  return r.structuredContent as T;
}

describe("MCP e2e — sync_now → sell_through → reorder_suggestions (T10)", () => {
  it("the scenario calling the three tools in order through a real MCP client passes", async () => {
    const { client, warehouse, clock } = await setupServer();

    // 1) tools/list — the 6 registered tools are visible at the actual protocol level.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "inventory_status",
        "reorder_suggestions",
        "sell_through",
        "stockout_risk",
        "sync_now",
        "sync_status",
      ].sort(),
    );

    // 2) sync_now — loads the fixture data into PGlite.
    const syncResult = structuredOf<{
      ok: boolean;
      resources: { resource: string; status: string; item_count: number }[];
    }>(await client.callTool({ name: "sync_now", arguments: {} }));
    expect(syncResult.ok).toBe(true);
    expect(syncResult.resources.every((r) => r.status === "success")).toBe(true);
    expect(syncResult.resources.find((r) => r.resource === "receipts")?.item_count).toBeGreaterThan(
      0,
    );

    // Confirm via sync_status that the sync just performed is reflected — cross-tool state consistency.
    const statusResult = structuredOf<{
      resources: { resource: string; last_synced_at: string | null }[];
    }>(await client.callTool({ name: "sync_status", arguments: {} }));
    expect(statusResult.resources.every((r) => r.last_synced_at !== null)).toBe(true);

    // 3) sell_through — real values come out of the synced data (not an empty result).
    const sellThroughResult = structuredOf<{
      rows: { store_id: string; variant_id: string; sell_through: number | null }[];
      note: string;
    }>(await client.callTool({ name: "sell_through", arguments: { period_days: 30 } }));
    expect(sellThroughResult.rows.length).toBeGreaterThan(0);
    expect(sellThroughResult.note).toMatch(/approximat/i);

    // 4) reorder_suggestions — the result obtained through the MCP protocol is identical to a direct
    // buildReorderReport() call (TESTING §4 "tool = agent numbers match" regression guard, now
    // including the protocol round-trip).
    const reorderResult = structuredOf<ReorderReport>(
      await client.callTool({ name: "reorder_suggestions", arguments: {} }),
    );
    const directReport = await buildReorderReport(
      { warehouse, clock },
      { businessTimezone: BUSINESS_TIMEZONE },
    );
    // Dates are serialised to ISO strings through the protocol — compensate for only that and compare.
    expect({
      ...reorderResult,
      generatedAt: new Date(reorderResult.generatedAt as unknown as string),
      dataLastSyncedAt: reorderResult.dataLastSyncedAt
        ? new Date(reorderResult.dataLastSyncedAt as unknown as string)
        : null,
    }).toEqual(directReport);

    await client.close();
  });

  it("passing a non-existent store_id yields isError:true and a message stating the cause (protocol-level error wrapping)", async () => {
    const { client } = await setupServer();
    await client.callTool({ name: "sync_now", arguments: {} });

    const result = await client.callTool({
      name: "sell_through",
      arguments: { store_id: "store_nope" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/Unknown store_id/);

    await client.close();
  });
});
