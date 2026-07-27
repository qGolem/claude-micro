// Thin node-hid transport for the Codex Micro. All wire knowledge lives in
// codex-micro-protocol; this class only owns the device handle.

import { HIDAsync, devices } from "node-hid";
import { RequestIdSequence, encodeRequestPackets, isCodexMicroInterface } from "codex-micro-protocol";

export function findCodexMicros() {
  return devices().filter(isCodexMicroInterface);
}

export class CodexMicro {
  #device;
  #requestIds = new RequestIdSequence();

  static async connect() {
    const [descriptor] = findCodexMicros();
    if (!descriptor?.path) {
      throw new Error("Codex Micro vendor HID interface not found. Connect it by USB and grant Input Monitoring to your terminal.");
    }
    const handle = await HIDAsync.open(descriptor.path, { nonExclusive: true });
    return new CodexMicro(handle, descriptor);
  }

  constructor(device, descriptor) {
    this.#device = device;
    this.descriptor = descriptor;
  }

  /** Sends one RPC request; returns the request id it was assigned. */
  async sendRequest(method, params) {
    const requestId = this.#requestIds.next();
    for (const packet of encodeRequestPackets({ method, params, id: requestId })) {
      await this.#device.write(Buffer.from(packet));
    }
    return requestId;
  }

  async close() {
    await this.#device.close();
  }

  onInput(listener) {
    this.#device.on("data", listener);
    this.#device.on("error", () => {});
  }
}
