import {
  openCodexMicro
} from "../chunk-3U3F6ITQ.js";
import {
  LightingEffect,
  agentKeyStatusRequest,
  encodeAgentKeyLighting,
  encodeRequestPackets
} from "../chunk-ZKFY4ZTV.js";

// tools/force-agent-key.ts
import { setTimeout as delay } from "timers/promises";
var color = Number.parseInt(process.argv[2] ?? "0066ff", 16);
if (!Number.isInteger(color) || color < 0 || color > 16777215) {
  throw new Error("Pass an RGB hex color, for example 22c55e.");
}
var device = await openCodexMicro();
var request = agentKeyStatusRequest({
  id: 777,
  agentKeys: [
    encodeAgentKeyLighting({ agentKeyIndex: 0, color, brightness: 1, effect: LightingEffect.shallowBreath, speed: 0.5 })
  ]
});
var packets = encodeRequestPackets(request);
try {
  const deadline = Date.now() + 5e3;
  while (Date.now() < deadline) {
    for (const packet of packets) await device.write(Buffer.from(packet));
    await delay(75);
  }
} finally {
  await device.close();
}
