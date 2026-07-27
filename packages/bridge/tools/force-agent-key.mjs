// Diagnostic: hold agent key 1 in a shallow-breath color for five seconds,
// re-sending continuously so the running bridge's own refresh loop cannot
// immediately overwrite it.
//
//   node tools/force-agent-key.mjs [rrggbb]

import { setTimeout as delay } from "node:timers/promises";
import {
  LightingEffect,
  agentKeyStatusRequest,
  encodeAgentKeyLighting,
  encodeRequestPackets,
} from "codex-micro-protocol";
import { openCodexMicro } from "./shared.mjs";

const color = Number.parseInt(process.argv[2] ?? "0066ff", 16);
if (!Number.isInteger(color) || color < 0 || color > 0xffffff) {
  throw new Error("Pass an RGB hex color, for example 22c55e.");
}

const device = await openCodexMicro();
const request = agentKeyStatusRequest({
  id: 777,
  agentKeys: [
    encodeAgentKeyLighting({ agentKeyIndex: 0, color, brightness: 1, effect: LightingEffect.shallowBreath, speed: 0.5 }),
  ],
});
const packets = encodeRequestPackets(request);

try {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const packet of packets) await device.write(Buffer.from(packet));
    await delay(75);
  }
} finally {
  await device.close();
}
