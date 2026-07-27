# Building on codex-micro-protocol

This walkthrough goes from zero to a working Codex Micro integration, in the
same order we built the [Claude Micro bridge](../bridge) — each step is the
codec plus one new idea of your own. The codec deliberately stops at bytes
and typed events; everything opinionated (colors, key meanings, focus
behavior) stays in *your* layer.

```
your policy        "working = pulsing blue", "AG03 focuses pane 3"
──────────────────────────────────────────────────────────────────
this codec         packets ⇄ RPC messages ⇄ typed events
──────────────────────────────────────────────────────────────────
your transport     node-hid / WebHID — open device, write/read reports
```

## Step 0 — find and open the device

The codec identifies the right HID interface; the transport is yours. With
[node-hid](https://github.com/node-hid/node-hid):

```ts
import { HIDAsync, devices } from "node-hid";
import { isCodexMicroInterface } from "codex-micro-protocol";

const descriptor = devices().find(isCodexMicroInterface);
if (!descriptor?.path) throw new Error("Codex Micro not found.");
// nonExclusive lets your program coexist with other hosts (e.g. the
// ChatGPT desktop app or the Claude Micro bridge) holding the same device.
const device = await HIDAsync.open(descriptor.path, { nonExclusive: true });
```

In a browser, filter `navigator.hid.requestDevice` with the same constants
(`WORK_LOUDER_VENDOR_ID`, `CODEX_MICRO_PRODUCT_ID`, `VENDOR_USAGE_PAGE`) — and
mind one difference: this codec frames packets the way node-hid delivers them,
with the report ID at byte 0, but WebHID strips that byte on input and takes it
as a separate argument on output. Adapt at the transport boundary:

```ts
// receiving — put the report ID back before handing bytes to the codec
device.addEventListener("inputreport", (event) => {
  const packet = new Uint8Array(1 + event.data.byteLength);
  packet[0] = event.reportId;
  packet.set(new Uint8Array(event.data.buffer), 1);
  for (const message of stream.pushHidPacket(packet)) { /* … */ }
});

// sending — strip it back off, and pass it as the first argument
await device.sendReport(HID_REPORT_ID, packet.subarray(1));
```

Skip this and nothing breaks loudly — the receive path just silently yields no
messages, because the codec reads the channel byte as a report ID and rejects
the packet.

## Step 1 — light a key

Requests are built in three composable stages — payload → request →
packets — so you can stop at whichever level your abstraction needs:

```ts
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
      color: 0x22c55e,          // 0xRRGGBB
      brightness: 1,
      effect: LightingEffect.solid,
      speed: 0,
    }),
  ],
});
for (const packet of encodeRequestPackets(request)) {
  await device.write(Buffer.from(packet));
}
```

Every field is validated at runtime with a specific `RangeError`, so a bad
color or index fails at the call site, not silently on the device.

The whole-board lighting (`encodeLightingChannel` + `lightingConfigRequest`)
works the same way for the typing keys and the ambient underglow.

## Step 2 — hear the hardware

Reports arrive as 64-byte packets that may split one JSON message or bundle
several. `RpcMessageStream` owns that reassembly; `parseDeviceEvent` turns
messages into a typed union you can exhaustively switch on:

```ts
import { RpcMessageStream, parseDeviceEvent } from "codex-micro-protocol";

const stream = new RpcMessageStream();   // one per device connection
device.on("data", (report) => {
  for (const message of stream.pushHidPacket(new Uint8Array(report))) {
    const deviceEvent = parseDeviceEvent(message);
    switch (deviceEvent?.kind) {
      case "keyEvent":
        // deviceEvent.action: "press" | "release" | "encoderTurn"
        // deviceEvent.agentKeyIndex: 0-5 for the frosted keys, else null
        break;
      case "joystickSample":
        // deviceEvent.angle / deviceEvent.distance — continuous stream
        break;
      case "unrecognized":
        // future firmware method — safe to ignore, never a crash
        break;
      case undefined:
        break; // a response to one of your own requests, not an event
    }
  }
});
```

For the joystick, you rarely want the raw radial stream. The codec includes
the one abstraction we found essential, as configurable state:

```ts
import { JoystickFlickDetector } from "codex-micro-protocol";

const flicks = new JoystickFlickDetector();  // 0.8 trigger / 0.2 re-arm
// inside the event loop:
if (deviceEvent?.kind === "joystickSample") {
  const direction = flicks.update(deviceEvent);
  // "up" | "down" | "left" | "right" | null
}
```

## Step 3 — request/response round-trips

Responses share the input channel and carry your request's `id`. A minimal
awaiter (this is [`tools/shared.ts`](../bridge/tools/shared.ts) in the
bridge, verbatim in spirit):

```ts
import { RpcMessageStream, encodeRequestPackets, type RpcRequest } from "codex-micro-protocol";

async function call(device: HIDAsync, request: RpcRequest, timeoutMs = 3_000) {
  for (const packet of encodeRequestPackets(request)) await device.write(Buffer.from(packet));
  const stream = new RpcMessageStream();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const report = await device.read(500);
    if (!report) continue;
    for (const message of stream.pushHidPacket(new Uint8Array(report))) {
      if (message.type === "response" && message.id === request.id) return message;
    }
  }
  return null; // lighting updates are occasionally accepted without an ack
}

const version = await call(device, { method: "sys.version", params: null, id: 901 });
console.log(version?.result); // { version: "v0.4.1" }
```

## Step 4 — add your policy layer

This is the step that makes it *yours*. The bridge's entire opinion about
colors is one small module
([`src/status-lighting.ts`](../bridge/src/status-lighting.ts)): a table from
session state to style, and one function closing over it:

```ts
import { LightingEffect, encodeAgentKeyLighting, type AgentKeyIndex } from "codex-micro-protocol";

const STYLES = {
  working:  { color: 0x3b82f6, brightness: 1, effect: LightingEffect.shallowBreath, speed: 0.45 },
  waiting:  { color: 0xf59e0b, brightness: 1, effect: LightingEffect.shallowBreath, speed: 0.35 },
  complete: { color: 0x22c55e, brightness: 1, effect: LightingEffect.solid,         speed: 0 },
} as const;

function keyLightingFor(index: AgentKeyIndex, state: keyof typeof STYLES) {
  return encodeAgentKeyLighting({ agentKeyIndex: index, ...STYLES[state] });
}
```

Swap the table and the same six keys become a CI dashboard, a pomodoro
timer, or a build-status monitor.

## Step 5 — production lessons from the bridge

Things the bridge does that you will probably want too
([`src/daemon.ts`](../bridge/src/daemon.ts)):

- **Re-send your lighting on an interval** (the bridge uses 75 ms). Another
  host sharing the device can repaint the LEDs at any time; steady-state
  re-assertion makes your state win without fighting over exclusivity.
- **Reconnect on write failure.** A USB replug invalidates the handle;
  the bridge retries `connect()` ten times at 500 ms before giving up.
- **One `RpcMessageStream` per connection**, re-fed after reconnects —
  its buffering is connection state.
- **Debounce the joystick with `JoystickFlickDetector`** instead of acting
  on raw samples; the stream fires continuously while deflected.

## Reference integration

The bridge is a complete production consumer of this codec, ~500 lines:

| Concern | File |
| --- | --- |
| transport wrapper (open/write/close) | [`packages/bridge/src/micro.ts`](../bridge/src/micro.ts) |
| event loop, lighting refresh, reconnect | [`packages/bridge/src/daemon.ts`](../bridge/src/daemon.ts) |
| color policy | [`packages/bridge/src/status-lighting.ts`](../bridge/src/status-lighting.ts) |
| request/response helper + diagnostics | [`packages/bridge/tools/`](../bridge/tools) |
