import {
  RpcMessageStream,
  encodeRequestPackets,
  findCodexMicros
} from "./chunk-ZKFY4ZTV.js";

// tools/shared.ts
import { HIDAsync } from "node-hid";
async function openCodexMicro() {
  const [descriptor] = findCodexMicros();
  if (!descriptor?.path) throw new Error("Codex Micro vendor HID interface not found.");
  return HIDAsync.open(descriptor.path, { nonExclusive: true });
}
async function sendRequestAndAwaitResponse(device, request, { timeoutMs = 3e3 } = {}) {
  for (const packet of encodeRequestPackets(request)) await device.write(Buffer.from(packet));
  const messageStream = new RpcMessageStream();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const report = await device.read(500);
    if (!report) continue;
    for (const message of messageStream.pushHidPacket(new Uint8Array(report))) {
      if (message.type === "response" && message.id === request.id) return message;
    }
  }
  return null;
}

export {
  openCodexMicro,
  sendRequestAndAwaitResponse
};
