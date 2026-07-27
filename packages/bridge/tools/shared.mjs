// Shared plumbing for the diagnostic tools: open the device and perform one
// request/response round-trip using the codec's stream decoder.

import { HIDAsync } from "node-hid";
import { RpcMessageStream, encodeRequestPackets } from "codex-micro-protocol";
import { findCodexMicros } from "../src/micro.mjs";

export async function openCodexMicro() {
  const [descriptor] = findCodexMicros();
  if (!descriptor?.path) throw new Error("Codex Micro vendor HID interface not found.");
  return HIDAsync.open(descriptor.path, { nonExclusive: true });
}

/**
 * Writes one request and polls reads until the matching response arrives.
 * Returns the parsed response message, or null on timeout (the firmware
 * occasionally accepts a lighting update without acknowledging it).
 */
export async function sendRequestAndAwaitResponse(device, request, { timeoutMs = 3_000 } = {}) {
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
