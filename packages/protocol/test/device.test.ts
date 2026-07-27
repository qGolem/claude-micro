import { describe, expect, test } from "bun:test";
import {
  CODEX_MICRO_PRODUCT_ID,
  VENDOR_USAGE_PAGE,
  WORK_LOUDER_VENDOR_ID,
  isCodexMicroInterface,
} from "../src/index.js";

describe("isCodexMicroInterface", () => {
  const matching = {
    vendorId: WORK_LOUDER_VENDOR_ID,
    productId: CODEX_MICRO_PRODUCT_ID,
    usagePage: VENDOR_USAGE_PAGE,
  };

  test("matches the vendor RPC interface, including descriptors with extra fields", () => {
    expect(isCodexMicroInterface(matching)).toBe(true);
    const nodeHidStyleDescriptor = { ...matching, path: "/dev/hidraw3", interface: 1 };
    expect(isCodexMicroInterface(nodeHidStyleDescriptor)).toBe(true);
  });

  test("rejects a mismatch on any single field", () => {
    expect(isCodexMicroInterface({ ...matching, vendorId: 0x1234 })).toBe(false);
    expect(isCodexMicroInterface({ ...matching, productId: 0x1234 })).toBe(false);
    expect(isCodexMicroInterface({ ...matching, usagePage: 0x0001 })).toBe(false);
  });

  test("rejects descriptors missing fields, null, and undefined", () => {
    expect(isCodexMicroInterface({})).toBe(false);
    expect(isCodexMicroInterface({ vendorId: WORK_LOUDER_VENDOR_ID })).toBe(false);
    expect(isCodexMicroInterface(null)).toBe(false);
    expect(isCodexMicroInterface(undefined)).toBe(false);
  });
});
