// Diagnostic: cycle the whole board (typing keys + ambient underglow) through
// six breathing colors, two seconds each.
//
//   node dist/tools/pulse-board.js

import { setTimeout as delay } from "node:timers/promises";
import { LightingEffect, encodeLightingChannel, lightingConfigRequest } from "codex-micro-protocol";
import { openCodexMicro, sendRequestAndAwaitResponse } from "./shared";

const device = await openCodexMicro();
const namedColors = {
  red: 0xff0000,
  green: 0x00ff00,
  blue: 0x0000ff,
  yellow: 0xffff00,
  magenta: 0xff00ff,
  cyan: 0x00ffff,
};

try {
  let requestId = 100;
  for (const [colorName, color] of Object.entries(namedColors)) {
    console.log(`Pulsing ${colorName}`);
    const channel = encodeLightingChannel({ color, brightness: 1, effect: LightingEffect.breath, speed: 0.45 });
    requestId += 1;
    await sendRequestAndAwaitResponse(device, lightingConfigRequest({ keys: channel, ambient: channel, id: requestId }));
    await delay(2_000);
  }
} finally {
  await device.close();
}
