import { HIDAsync, devices } from "node-hid";
import {
  CODEX_MICRO_PRODUCT_ID,
  WORK_LOUDER_VENDOR_ID,
  VENDOR_USAGE_PAGE,
  encodeHidPackets,
  encodeRpc,
  threadLighting,
} from "./protocol.mjs";

export function findCodexMicros() {
  return devices().filter(
    (device) =>
      device.vendorId === WORK_LOUDER_VENDOR_ID &&
      device.productId === CODEX_MICRO_PRODUCT_ID &&
      device.usagePage === VENDOR_USAGE_PAGE,
  );
}

export class CodexMicro {
  #device;
  #nextId = 1;

  static async connect() {
    const [device] = findCodexMicros();
    if (!device?.path) throw new Error("Codex Micro vendor HID interface not found. Connect it by USB and grant Input Monitoring to your terminal.");
    const handle = await HIDAsync.open(device.path, { nonExclusive: true });
    return new CodexMicro(handle, device);
  }

  constructor(device, descriptor) {
    this.#device = device;
    this.descriptor = descriptor;
  }

  async setThreadState(index, state, options = {}) {
    if (!Number.isInteger(index) || index < 0 || index > 5) throw new RangeError("Agent index must be 0 through 5.");
    return this.sendRpc("v.oai.thstatus", [threadLighting(index, state, options)]);
  }

  async setThreadStates(states) {
    if (!Array.isArray(states) || states.length !== 6) throw new RangeError("Pass exactly six Agent states.");
    return this.sendRpc("v.oai.thstatus", states.map((state, id) => threadLighting(id, state)));
  }

  async setAllIdle() {
    return this.setThreadStates(Array(6).fill("idle"));
  }

  async sendRpc(method, params) {
    const id = this.#nextId++ % 999;
    const payload = encodeRpc(method, params, id);
    for (const packet of encodeHidPackets(payload)) await this.#device.write(packet);
    return id;
  }

  async close() {
    await this.#device.close();
  }

  onInput(listener) {
    this.#device.on("data", listener);
    this.#device.on("error", () => {});
  }
}
