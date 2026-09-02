/**
 * 우리 픽스처가 아니라 Loyverse 공식 문서(https://developer.loyverse.com/docs/, Receipts/
 * Inventory 태그, 2026-09-02 확인)에 실린 응답 예시를 그대로 옮겨 적어 검증한다.
 * loyverseSchemas.test.ts가 "우리 픽스처를 우리 스키마로" 검증하는 자기참조 테스트라면,
 * 이 파일은 "공식 예시를 우리 스키마로" 검증해 스키마가 실제 계약과 맞는지 독립적으로 확인한다
 * (docs/003_T2_ADVERSARIAL_REVIEW.md 003-08).
 */
import { describe, expect, it } from "vitest";
import {
  LvInventoryResponseSchema,
  LvReceiptSchema,
  LvReceiptsResponseSchema,
} from "../src/adapters/loyverseSchemas.js";

// GET /receipts/{receipt_number} 응답 예시 (공식 문서 원문 그대로, 스키마에 없는 필드는 남겨둔다)
const OFFICIAL_SALE_RECEIPT_SAMPLE = {
  receipt_number: "2-1008",
  note: null,
  receipt_type: "SALE",
  refund_for: null,
  order: "O-1598498",
  created_at: "2020-06-23T08:35:47.047Z",
  updated_at: "2020-06-23T08:35:47.047Z",
  source: "My app",
  receipt_date: "2020-06-23T08:34:45.025Z",
  cancelled_at: null,
  total_money: 17.52,
  total_tax: 0.92,
  points_earned: 1.75,
  points_deducted: 0,
  points_balance: 332.32,
  customer_id: "c71758a2-79bf-11ea-bde9-1269e7c5a22d",
  total_discount: 7.4,
  employee_id: "58f53835-7a17-11ea-bde9-1269e7c5a22d",
  store_id: "42dc2cec-6f40-11ea-bde9-1269e7c5a22d",
  pos_device_id: "1cce2f2e-8033-4b67-ad2a-b9d1c749ec26",
  dining_option: "Dine in",
  line_items: [
    {
      id: "365972a1-7268-11ea-bde9-1269e7c5a22d",
      item_id: "d5fe0da6-44b3-4633-9915-e9dc5118cbfc",
      variant_id: "706e2626-3329-45f8-98d7-0e1dbcbcb9d9",
      item_name: "Ice cream",
      variant_name: null,
      sku: "10010",
      quantity: 2,
      price: 10,
      gross_total_money: 24,
      total_money: 17.52,
      cost: 5,
      cost_total: 10,
      line_note: "Note for the item",
      line_taxes: [],
      total_discount: 7.4,
      line_discounts: [],
      line_modifiers: [],
    },
  ],
  payments: [
    {
      payment_type_id: "42dd2a55-6f40-11ea-bde9-1269e7c5a22d",
      name: "Cash",
      type: "CASH",
      money_amount: 5.84,
      paid_at: "2020-06-23T08:35:47.047Z",
      payment_details: null,
    },
  ],
};

// POST /receipts/{receipt_number}/refund 응답 예시 (공식 문서 원문의 확인된 필드).
// line_items는 공식 문서가 SALE/REFUND에 동일한 line_item 스키마를 쓰므로 그 형태를 따르되,
// quantity는 공식 문서의 refund 생성 REQUEST 예시("quantity": 2, 양수)와 동일한 부호를 쓴다.
const OFFICIAL_REFUND_RECEIPT_SAMPLE = {
  receipt_number: "2-1009",
  note: null,
  receipt_type: "REFUND",
  refund_for: "2-1005",
  order: "O-15984978",
  created_at: "2020-06-23T08:35:47.047Z",
  updated_at: "2020-06-23T08:35:47.047Z",
  source: "My app",
  receipt_date: "2020-06-23T08:34:35.025Z",
  cancelled_at: null,
  total_money: 17.52,
  store_id: "42dc2cec-6f40-11ea-bde9-1269e7c5a22d",
  line_items: [
    {
      id: "06929667-cc44-4bbb-b226-6758285d7033",
      item_id: "d5fe0da6-44b3-4633-9915-e9dc5118cbfc",
      variant_id: "706e2626-3329-45f8-98d7-0e1dbcbcb9d9",
      item_name: "Ice cream",
      quantity: 2,
      gross_total_money: 24,
      total_discount: 0,
    },
  ],
};

// inventory_levels.update 웹훅 payload의 inventory_levels 원소 예시 (공식 문서 원문 그대로)
const OFFICIAL_INVENTORY_LEVEL_SAMPLE = {
  variant_id: "5fk4f446-01d2-8787-4fd5-7b7b1995df85",
  store_id: "5fk4f446-01d2-8787-4fd5-7b7b1995df85",
  in_stock: 0,
  updated_at: "2019-08-24T14:15:22Z",
};

describe("공식 Loyverse 응답 예시로 스키마를 독립 검증한다", () => {
  it("공식 SALE 영수증 예시가 파싱된다", () => {
    const parsed = LvReceiptSchema.parse(OFFICIAL_SALE_RECEIPT_SAMPLE);
    expect(parsed.receipt_type).toBe("SALE");
    expect(parsed.refund_for).toBeNull();
    expect(parsed.cancelled_at).toBeNull();
    expect(parsed.created_at).toBe("2020-06-23T08:35:47.047Z");
    expect(parsed.updated_at).toBe("2020-06-23T08:35:47.047Z");
  });

  it("공식 REFUND 영수증 예시가 파싱되고 quantity는 양수로 보존된다", () => {
    const parsed = LvReceiptSchema.parse(OFFICIAL_REFUND_RECEIPT_SAMPLE);
    expect(parsed.receipt_type).toBe("REFUND");
    expect(parsed.refund_for).toBe("2-1005");
    expect(parsed.line_items[0]?.quantity).toBe(2);
  });

  it("공식 inventory_levels 예시가 파싱되고 updated_at이 보존된다", () => {
    const parsed = LvInventoryResponseSchema.parse({
      inventory_levels: [OFFICIAL_INVENTORY_LEVEL_SAMPLE],
    });
    expect(parsed.inventory_levels[0]?.updated_at).toBe("2019-08-24T14:15:22Z");
  });

  it("receipts 목록 응답 봉투(envelope)로도 파싱된다", () => {
    const parsed = LvReceiptsResponseSchema.parse({
      receipts: [OFFICIAL_SALE_RECEIPT_SAMPLE, OFFICIAL_REFUND_RECEIPT_SAMPLE],
      cursor: null,
    });
    expect(parsed.receipts).toHaveLength(2);
  });

  it("passthrough는 미지정 필드를 허용할 뿐, 우리가 의존하는 필드가 빠지면 여전히 거부한다", () => {
    const { updated_at: _updatedAt, ...withoutUpdatedAt } = OFFICIAL_SALE_RECEIPT_SAMPLE;
    expect(() => LvReceiptSchema.parse(withoutUpdatedAt)).toThrow();

    const { receipt_type: _receiptType, ...withoutReceiptType } = OFFICIAL_SALE_RECEIPT_SAMPLE;
    expect(() => LvReceiptSchema.parse(withoutReceiptType)).toThrow();

    const { cancelled_at: _cancelledAt, ...withoutCancelledAt } = OFFICIAL_SALE_RECEIPT_SAMPLE;
    expect(() => LvReceiptSchema.parse(withoutCancelledAt)).toThrow();
  });

  it("날짜가 ISO 8601 형식이 아니면 거부한다", () => {
    expect(() =>
      LvReceiptSchema.parse({ ...OFFICIAL_SALE_RECEIPT_SAMPLE, updated_at: "not-a-date" }),
    ).toThrow();
    expect(() =>
      LvReceiptSchema.parse({ ...OFFICIAL_SALE_RECEIPT_SAMPLE, receipt_date: "2020-06-23" }),
    ).toThrow();
  });
});
