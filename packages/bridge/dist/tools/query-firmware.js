import {
  openCodexMicro,
  sendRequestAndAwaitResponse
} from "../chunk-3U3F6ITQ.js";
import {
  LightingEffect,
  agentKeyStatusRequest,
  assertAgentKeyIndex,
  encodeAgentKeyLighting,
  firmwareVersionRequest
} from "../chunk-ZKFY4ZTV.js";

// tools/query-firmware.ts
var device = await openCodexMicro();
var rainbowColors = [16711680, 65280, 255, 16776960, 16711935, 65535];
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
          speed: 0
        });
      })
    })
  );
  console.log(JSON.stringify(lightingResponse?.raw ?? null));
} finally {
  await device.close();
}
