import {
  openCodexMicro,
  sendRequestAndAwaitResponse
} from "../chunk-3U3F6ITQ.js";
import {
  LightingEffect,
  encodeLightingChannel,
  lightingConfigRequest
} from "../chunk-ZKFY4ZTV.js";

// tools/pulse-board.ts
import { setTimeout as delay } from "timers/promises";
var device = await openCodexMicro();
var namedColors = {
  red: 16711680,
  green: 65280,
  blue: 255,
  yellow: 16776960,
  magenta: 16711935,
  cyan: 65535
};
try {
  let requestId = 100;
  for (const [colorName, color] of Object.entries(namedColors)) {
    console.log(`Pulsing ${colorName}`);
    const channel = encodeLightingChannel({ color, brightness: 1, effect: LightingEffect.breath, speed: 0.45 });
    requestId += 1;
    await sendRequestAndAwaitResponse(device, lightingConfigRequest({ keys: channel, ambient: channel, id: requestId }));
    await delay(2e3);
  }
} finally {
  await device.close();
}
