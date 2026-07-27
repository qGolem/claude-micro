// Thin node-hid transport for the Codex Micro. All wire knowledge lives in
// codex-micro-protocol; this class only owns the device handle.

import { HIDAsync, devices, type Device } from "node-hid";
import { RequestIdSequence, encodeRequestPackets, isCodexMicroInterface } from "codex-micro-protocol";

export function findCodexMicros(): Device[] {
  return devices().filter(isCodexMicroInterface);
}

export class CodexMicro {
  #device: HIDAsync;
  #requestIds = new RequestIdSequence();
  readonly descriptor: Device;

  static async connect(): Promise<CodexMicro> {
    const [descriptor] = findCodexMicros();
    if (!descriptor?.path) {
      throw new Error("Codex Micro vendor HID interface not found. Connect it by USB and grant Input Monitoring to your terminal.");
    }
    const handle = await HIDAsync.open(descriptor.path, { nonExclusive: true });
    return new CodexMicro(handle, descriptor);
  }

  constructor(device: HIDAsync, descriptor: Device) {
    this.#device = device;
    this.descriptor = descriptor;
  }

  /** Sends one RPC request; returns the request id it was assigned. */
  async sendRequest(method: string, params: unknown): Promise<number> {
    const requestId = this.#requestIds.next();
    for (const packet of encodeRequestPackets({ method, params, id: requestId })) {
      await this.#device.write(Buffer.from(packet));
    }
    return requestId;
  }

  async close(): Promise<void> {
    await this.#device.close();
  }

  onInput(listener: (report: Buffer) => void): void {
    this.#device.on("data", listener);
    this.#device.on("error", () => {});
  }
}
