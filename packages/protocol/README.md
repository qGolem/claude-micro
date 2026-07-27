# codex-micro-protocol

Pure, dependency-free codec for the Work Louder **Codex Micro** vendor HID RPC
protocol. It encodes requests into writable HID packets and decodes the
device's report stream into typed events — nothing else. No device I/O, no
Node-only APIs (`Uint8Array` + `TextEncoder` throughout), so it runs under
Node, Bun, Deno, or a browser with WebHID. Bring your own transport
(node-hid, WebHID, …) and build your own abstractions on top.

Everything documented here was discovered by observing the device; it is not
an official Work Louder specification.

## Wire protocol

**Device identity** — the RPC protocol lives on the vendor-specific HID
interface: vendor `0x303a`, product `0x8360`, usage page `0xff00`
(`isCodexMicroInterface(descriptor)` matches it).

**Framing** — every report is 64 bytes: `[reportId 6, channel 2,
payloadLength, …payload (≤61 bytes)]`. Longer messages span consecutive
packets; concatenate payloads to reassemble.

**RPC envelope** — newline-terminated JSON, one message per line:

| Direction | Shape |
| --- | --- |
| host → device | `{"method": string, "params": any, "id": number}\n` |
| device → host (event) | `{"m": string, "p": any}\n` |
| device → host (response) | `{"id": number, "method": string, "result": any}\n` |

**Methods** (`RpcMethod`):

| Method | Direction | Params |
| --- | --- | --- |
| `sys.version` | out | `null` — firmware version query |
| `v.oai.thstatus` | out | array of agent-key entries `{id: 0-5, c: rgb, b: 0-1, e: effect, s: 0-1, sk?: 0\|1, sa?: 0\|1}` |
| `v.oai.rgbcfg` | out | `{keys?: channel, ambient?: channel}` where channel = `{c, b, e, s, m}` |
| `v.oai.hid` | in | `{k: keyName, act: 0\|1\|2}` — release / press / encoder turn |
| `v.oai.rad` | in | `{a: angle 0-1, d: distance 0-1}` — continuous joystick stream |

**Key names** — `AG00`–`AG05` (six frosted agent keys), `ACT06`–`ACT12`
(seven action keys), `ENC_CW`/`ENC_CC` (encoder detents; on observed units
the physical *left* turn reports `ENC_CW`).

**Joystick** — angle runs clockwise from 0 = right (0.25 down, 0.5 left,
0.75 up); the device streams samples continuously while deflected.

**Lighting effects** (`LightingEffect`): off 0, solid 1, snake 2, rainbow 3,
breath 4, gradient 5, shallowBreath 6.

## Usage

Sending — one call from intent to writable packets:

```js
import {
  LightingEffect, RequestIdSequence,
  encodeAgentKeyLighting, agentKeyStatusRequest, encodeRequestPackets,
} from "codex-micro-protocol";

const requestIds = new RequestIdSequence();
const request = agentKeyStatusRequest({
  id: requestIds.next(),
  agentKeys: [
    encodeAgentKeyLighting({
      agentKeyIndex: 0,
      color: 0x22c55e,
      brightness: 1,
      effect: LightingEffect.solid,
      speed: 0,
    }),
  ],
});
for (const packet of encodeRequestPackets(request)) await hidDevice.write(packet);
```

Receiving — feed raw reports, get typed events:

```js
import { RpcMessageStream, parseDeviceEvent } from "codex-micro-protocol";

const stream = new RpcMessageStream();
hidDevice.on("data", (report) => {
  for (const message of stream.pushHidPacket(new Uint8Array(report))) {
    const deviceEvent = parseDeviceEvent(message);
    if (deviceEvent?.kind === "keyEvent" && deviceEvent.action === "press") {
      console.log(`pressed ${deviceEvent.keyName}`);
    }
  }
});
```

Turning the joystick stream into discrete flicks:

```js
import { JoystickFlickDetector } from "codex-micro-protocol";

const flickDetector = new JoystickFlickDetector();
// inside the event loop, for kind === "joystickSample":
const direction = flickDetector.update(deviceEvent); // "up" | "down" | "left" | "right" | null
```

## Module map

| Module | Contents |
| --- | --- |
| `device.mjs` | USB identity constants, `isCodexMicroInterface` |
| `framing.mjs` | packet constants, `encodeHidPackets`, `decodeHidPacket`, `rpcPayloadFromPacket` |
| `rpc.mjs` | `RpcMethod`, `RequestIdSequence`, `encodeRpcRequest`, `parseRpcMessage`, `RpcMessageStream` |
| `lighting.mjs` | `LightingEffect`, agent-key and whole-board payload builders (validated) |
| `input.mjs` | key-name tables, `parseKeyEvent`, joystick parsing, `JoystickFlickDetector`, `parseDeviceEvent` |
| `requests.mjs` | request builders + `encodeRequestPackets` |

Unknown methods parse as `{kind: "unrecognized"}` rather than throwing, so
firmware additions never break a consumer.

## Development

```sh
bun test
```
