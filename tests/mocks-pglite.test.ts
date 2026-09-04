import { describe, expect, it } from "vitest";
import { createTestWarehouse } from "../src/mocks/pglite.js";

describe("createTestWarehouse", () => {
  it("returns a fresh PGlite instance with the schema applied", async () => {
    const db = await createTestWarehouse();
    const { rows } = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    const tableNames = rows.map((r) => r.table_name);
    expect(tableNames).toContain("stores");
    expect(tableNames).toContain("sales_lines");
    expect(tableNames).toContain("agent_send_log");
  });
});
