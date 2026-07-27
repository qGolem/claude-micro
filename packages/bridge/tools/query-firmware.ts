// Diagnostic: query the firmware version and paint the six agent keys with a
// rainbow so each key can be visually matched to its index.
//
//   node dist/tools/query-firmware.js

import {
  LightingEffect,
  agentKeyStatusRequest,
  assertAgentKeyIndex,
  encodeAgentKeyLighting,
  firmwareVersionRequest,
} from "codex-micro-protocol";
import { openCodexMicro, sendRequestAndAwaitResponse } from "./shared";

const device = await openCodexMicro();
const rainbowColors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff];

try {
  const versionResponse = await sendRequestAndAwaitResponse(device, firmwareVersionRequest({ id: 901 }));
  console.log(JSON.stringify(versionResponse?.raw ?? null));

  const lightingResponse = await sendRequestAndAwaitResponse(
    device,
    agentKeyStatusRequest({
      id: 902,
      agentKeys: rainbowColors.map((color, agentKeyIndex) => {
        assertAgentKeyIndex(agentKeyIndex);
        return encodeAgentKeyLighting({
          agentKeyIndex,
          color,
          brightness: 1,
          effect: LightingEffect.solid,
          speed: 0,
        });
      }),
    }),
  );
  console.log(JSON.stringify(lightingResponse?.raw ?? null));
} finally {
  await device.close();
}
