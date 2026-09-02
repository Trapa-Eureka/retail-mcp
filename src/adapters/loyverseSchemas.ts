/**
 * Loyverse REST API 응답 zod 스키마 — 외부 입력은 경계에서 파싱한다(CLAUDE.md 컨벤션).
 * 실제 API 응답에는 여기 정의하지 않은 필드가 더 있을 수 있으므로 `.passthrough()`로
 * 알 수 없는 필드를 허용하고, 우리가 실제로 쓰는 필드만 엄격히 검증한다.
 * FixtureLoyverseClient(mocks)와 T3 실어댑터(adapters/loyverseClient)가 공유한다.
 */
import { z } from "zod";

export const LvStoreSchema = z
  .object({
    id: z.string(),
    name: z.string(),
  })
  .passthrough();

export const LvItemVariantSchema = z
  .object({
    variant_id: z.string(),
    sku: z.string().nullable(),
  })
  .passthrough();

export const LvItemSchema = z
  .object({
    id: z.string(),
    item_name: z.string(),
    category_id: z.string().nullable(),
    variants: z.array(LvItemVariantSchema).min(1),
  })
  .passthrough();

export const LvReceiptLineItemSchema = z
  .object({
    variant_id: z.string(),
    item_id: z.string(),
    quantity: z.number(),
    gross_total_money: z.number(),
    total_discount: z.number(),
  })
  .passthrough();

export const LvReceiptSchema = z
  .object({
    receipt_number: z.string(),
    store_id: z.string(),
    receipt_date: z.string().min(1),
    line_items: z.array(LvReceiptLineItemSchema),
  })
  .passthrough();

export const LvInventoryLevelSchema = z
  .object({
    variant_id: z.string(),
    store_id: z.string(),
    in_stock: z.number(),
  })
  .passthrough();

export const LvStoresResponseSchema = z.object({ stores: z.array(LvStoreSchema) }).passthrough();

export const LvItemsResponseSchema = z
  .object({
    items: z.array(LvItemSchema),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();

export const LvReceiptsResponseSchema = z
  .object({
    receipts: z.array(LvReceiptSchema),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();

export const LvInventoryResponseSchema = z
  .object({
    inventory_levels: z.array(LvInventoryLevelSchema),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();
