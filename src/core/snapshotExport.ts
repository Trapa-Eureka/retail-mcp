/**
 * Serialize processed inventory data into the same SPEC §12 fixed-template CSV as T15
 * (TASKS T19). It is a round-trippable format that is both the branch instance's output and the
 * HQ instance's input (SPEC §12 "multi-store head-office consolidated view") — `store` is
 * already a required column, so it is reused as is without a schema change. It is not a
 * human-facing summary but a machine-readable output that T16 (csvExcelParser.ts) can read
 * back in.
 *
 * Pure function — no external IO (CLAUDE.md core principle). Writing the file is the caller's
 * job (T18 folderScan.ts).
 *
 * unit_price/currency are not exported — T16 never stores those fields in the first place, so
 * they are not part of the round trip (see "known scope boundaries" in csvExcelParser.ts).
 */
import { stringify } from "csv-stringify/sync";
import { escapeCsvFormulaPrefix } from "./csvSafety.js";
import type { InventoryRow, ProductRow, SalesPeriodAggRow } from "./types.js";

/** Minimal input T19 consumes — the same shape as T16's `ParsedCsvExcelFile` (minus stores,
 * which the export does not need) but without a direct dependency, to widen reusability. */
export interface SnapshotSource {
  inventory: InventoryRow[];
  products: ProductRow[];
  salesPeriodAgg: SalesPeriodAggRow[];
}

/** Exact column order of the SPEC §12 fixed template — must match the header T15's
 * `csvRowSchema` validates. `pack_size` is the optional column T24 added for §14 — found while
 * starting (006 DATA-001, TASKS T31): it was missing from this export, so in the branch
 * snapshot → HQ consolidation round trip packSize silently became null. Branch alerts round up
 * to pack units while the HQ consolidated view lost that information — a defect. */
const COLUMNS = [
  "store",
  "product",
  "sku",
  "stock_qty",
  "sales_qty",
  "period_start",
  "period_end",
  "low_stock_threshold",
  "pack_size",
] as const;

function csvKey(storeId: string, variantId: string): string {
  return `${storeId}:${variantId}`;
}

/** YYYY-MM-DD in UTC — when T15's `z.coerce.date()` reads it back it becomes the same UTC
 * midnight Date. */
function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Serialize `source` (domain rows T16 has already validated and converted) into a SPEC §12
 * fixed-template CSV string. One row per (store, SKU) that has inventory — when there is no
 * sales history the sales-related columns are blank.
 */
export function exportSnapshotCsv(source: SnapshotSource): string {
  const productByVariant = new Map(source.products.map((p) => [p.variantId, p]));
  const salesByKey = new Map(source.salesPeriodAgg.map((s) => [csvKey(s.storeId, s.variantId), s]));

  const rows = source.inventory.map((inv) => {
    const product = productByVariant.get(inv.variantId);
    const sales = salesByKey.get(csvKey(inv.storeId, inv.variantId));
    return {
      // Formula-injection escape (SEC-004, TASKS T32) — a person may open this snapshot
      // directly in Excel/Sheets (see the core/csvSafety.ts doc). Re-import (csvSchema.ts
      // requiredTrimmedString) strips it exactly symmetrically, so round-trip data is preserved.
      store: escapeCsvFormulaPrefix(inv.storeId),
      product: escapeCsvFormulaPrefix(product?.name ?? inv.variantId),
      sku: escapeCsvFormulaPrefix(inv.variantId),
      stock_qty: inv.inStock,
      sales_qty: sales?.soldQty ?? "",
      period_start: sales ? formatDateUtc(sales.periodStart) : "",
      period_end: sales ? formatDateUtc(sales.periodEnd) : "",
      low_stock_threshold:
        product?.lowStockThreshold !== undefined && product.lowStockThreshold !== null
          ? product.lowStockThreshold
          : "",
      pack_size:
        product?.packSize !== undefined && product.packSize !== null ? product.packSize : "",
    };
  });

  return stringify(rows, { header: true, columns: [...COLUMNS] });
}
