// USB identity of the Work Louder Codex Micro's vendor-specific HID interface.
// The device exposes several HID interfaces (keyboard, consumer controls); the
// RPC protocol lives only on the interface with this usage page.

export const WORK_LOUDER_VENDOR_ID = 0x303a;
export const CODEX_MICRO_PRODUCT_ID = 0x8360;
export const VENDOR_USAGE_PAGE = 0xff00;

/**
 * Matches a HID device descriptor (as reported by node-hid, WebHID, or any
 * enumerator exposing vendorId/productId/usagePage) against the Codex Micro's
 * vendor RPC interface.
 */
export function isCodexMicroInterface(descriptor) {
  return (
    descriptor?.vendorId === WORK_LOUDER_VENDOR_ID &&
    descriptor?.productId === CODEX_MICRO_PRODUCT_ID &&
    descriptor?.usagePage === VENDOR_USAGE_PAGE
  );
}
