/**
 * MCP e2e (T10, TASKS.md 완료 기준): 실제 MCP SDK 클라이언트로 stdio 프로토콜과 동일한
 * 요청/응답 형태(JSON-RPC over Transport)를 거쳐 sync_now → sell_through →
 * reorder_suggestions 시나리오를 검증한다. 실 프로세스를 띄우지 않고 InMemoryTransport로
 * 같은 프로세스 안에서 Client↔Server를 연결한다 — 네트워크 호출 0건 원칙(TESTING §1)을
 * 지키면서도 프로토콜 계층(zod 입력 검증, registerTool 등록, CallToolResult 포장)까지
 * 실제로 통과한다는 점에서 `src/mcp/tools.ts` 함수를 직접 부르는 단위 테스트보다 강하다.
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

// 픽스처(fixtures/loyverse/*.json)는 2026-09-01T00:00:00Z를 "오늘"로 anchor한다 (T2).
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
      syncToolEnabled: true, // e2e에서는 sync_now까지 시나리오에 포함해야 하므로 켠다.
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
 * client.callTool()의 반환 타입은 실험적 task 결과와의 유니온이라 CallToolResult로 바로 좁혀지지
 * 않는다 — 우리 서버는 task를 쓰지 않으므로(runtime으로 이미 확인됨) 여기서 단언한다.
 */
function structuredOf<T>(result: unknown): T {
  const r = result as CallToolResult;
  if (r.isError) {
    throw new Error(`도구 호출이 에러를 반환했습니다: ${JSON.stringify(r.content)}`);
  }
  return r.structuredContent as T;
}

describe("MCP e2e — sync_now → sell_through → reorder_suggestions (T10)", () => {
  it("실제 MCP 클라이언트로 세 도구를 순서대로 호출한 시나리오가 통과한다", async () => {
    const { client, warehouse, clock } = await setupServer();

    // 1) tools/list — 등록된 6종이 실제 프로토콜 레벨에서 보인다.
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

    // 2) sync_now — 픽스처 데이터를 PGlite에 적재한다.
    const syncResult = structuredOf<{
      ok: boolean;
      resources: { resource: string; status: string; item_count: number }[];
    }>(await client.callTool({ name: "sync_now", arguments: {} }));
    expect(syncResult.ok).toBe(true);
    expect(syncResult.resources.every((r) => r.status === "success")).toBe(true);
    expect(syncResult.resources.find((r) => r.resource === "receipts")?.item_count).toBeGreaterThan(
      0,
    );

    // sync_status로도 방금 동기화가 반영됐는지 확인 — 도구 간 상태 일관성.
    const statusResult = structuredOf<{
      resources: { resource: string; last_synced_at: string | null }[];
    }>(await client.callTool({ name: "sync_status", arguments: {} }));
    expect(statusResult.resources.every((r) => r.last_synced_at !== null)).toBe(true);

    // 3) sell_through — 동기화된 데이터로 실제 값이 나온다(빈 결과가 아님).
    const sellThroughResult = structuredOf<{
      rows: { store_id: string; variant_id: string; sell_through: number | null }[];
      note: string;
    }>(await client.callTool({ name: "sell_through", arguments: { period_days: 30 } }));
    expect(sellThroughResult.rows.length).toBeGreaterThan(0);
    expect(sellThroughResult.note).toMatch(/근사식/);

    // 4) reorder_suggestions — MCP 프로토콜을 거친 결과가 buildReorderReport() 직접 호출
    // 결과와 완전히 같다(TESTING §4 "도구=에이전트 수치 일치" 회귀 가드, 프로토콜 경유까지 포함).
    const reorderResult = structuredOf<ReorderReport>(
      await client.callTool({ name: "reorder_suggestions", arguments: {} }),
    );
    const directReport = await buildReorderReport(
      { warehouse, clock },
      { businessTimezone: BUSINESS_TIMEZONE },
    );
    // 프로토콜을 거치면 Date가 ISO 문자열로 직렬화된다 — 그 점만 보정해 비교한다.
    expect({
      ...reorderResult,
      generatedAt: new Date(reorderResult.generatedAt as unknown as string),
      dataLastSyncedAt: reorderResult.dataLastSyncedAt
        ? new Date(reorderResult.dataLastSyncedAt as unknown as string)
        : null,
    }).toEqual(directReport);

    await client.close();
  });

  it("존재하지 않는 store_id를 넘기면 isError:true와 원인이 담긴 메시지를 받는다(프로토콜 레벨 에러 포장)", async () => {
    const { client } = await setupServer();
    await client.callTool({ name: "sync_now", arguments: {} });

    const result = await client.callTool({
      name: "sell_through",
      arguments: { store_id: "store_nope" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text?: string }[])[0]?.text ?? "";
    expect(text).toMatch(/존재하지 않는 store_id/);

    await client.close();
  });
});
