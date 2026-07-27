// ../protocol/dist/index.js
var WORK_LOUDER_VENDOR_ID = 12346;
var CODEX_MICRO_PRODUCT_ID = 33632;
var VENDOR_USAGE_PAGE = 65280;
function isCodexMicroInterface(descriptor) {
  return descriptor?.vendorId === WORK_LOUDER_VENDOR_ID && descriptor?.productId === CODEX_MICRO_PRODUCT_ID && descriptor?.usagePage === VENDOR_USAGE_PAGE;
}
var HID_REPORT_ID = 6;
var RPC_CHANNEL = 2;
var HID_PACKET_LENGTH = 64;
var HID_PACKET_HEADER_LENGTH = 3;
var HID_PACKET_PAYLOAD_CAPACITY = HID_PACKET_LENGTH - HID_PACKET_HEADER_LENGTH;
function encodeHidPackets(messageBytes) {
  if (!(messageBytes instanceof Uint8Array)) {
    throw new TypeError("encodeHidPackets expects the message as a Uint8Array.");
  }
  const packets = [];
  for (let messageOffset = 0; messageOffset < messageBytes.length; messageOffset += HID_PACKET_PAYLOAD_CAPACITY) {
    const chunk = messageBytes.subarray(messageOffset, messageOffset + HID_PACKET_PAYLOAD_CAPACITY);
    const packet = new Uint8Array(HID_PACKET_LENGTH);
    packet[0] = HID_REPORT_ID;
    packet[1] = RPC_CHANNEL;
    packet[2] = chunk.length;
    packet.set(chunk, HID_PACKET_HEADER_LENGTH);
    packets.push(packet);
  }
  return packets;
}
function decodeHidPacket(packetBytes) {
  if (!(packetBytes instanceof Uint8Array) || packetBytes.length < HID_PACKET_HEADER_LENGTH) return null;
  const declaredLength = packetBytes[2];
  const availableLength = packetBytes.length - HID_PACKET_HEADER_LENGTH;
  return {
    reportId: packetBytes[0],
    channel: packetBytes[1],
    payload: packetBytes.subarray(
      HID_PACKET_HEADER_LENGTH,
      HID_PACKET_HEADER_LENGTH + Math.min(declaredLength, availableLength)
    )
  };
}
function rpcPayloadFromPacket(packetBytes) {
  const decoded = decodeHidPacket(packetBytes);
  if (!decoded || decoded.reportId !== HID_REPORT_ID || decoded.channel !== RPC_CHANNEL) return null;
  if (decoded.payload.length === 0) return null;
  return decoded.payload;
}
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var RpcMethod = Object.freeze({
  /** Query firmware version information. Params: null. */
  firmwareVersion: "sys.version",
  /** Set the six frosted agent-key LEDs. Params: array of agent-key lighting objects. */
  agentKeyStatus: "v.oai.thstatus",
  /** Configure whole-board lighting. Params: {keys?, ambient?} channel objects. */
  lightingConfig: "v.oai.rgbcfg",
  /** Device → host: key press/release/encoder events. */
  keyEvent: "v.oai.hid",
  /** Device → host: continuous joystick radial samples. */
  joystickSample: "v.oai.rad"
});
var utf8Encoder = new TextEncoder();
var RequestIdSequence = class {
  #nextValue = 1;
  next() {
    const value = this.#nextValue;
    this.#nextValue = value >= 999 ? 1 : value + 1;
    return value;
  }
};
function encodeRpcRequest({ method, params = null, id }) {
  if (typeof method !== "string" || method.length === 0) {
    throw new TypeError("encodeRpcRequest requires a non-empty method name.");
  }
  if (!Number.isInteger(id) || id < 0) {
    throw new TypeError("encodeRpcRequest requires a non-negative integer id.");
  }
  return utf8Encoder.encode(`${JSON.stringify({ method, params, id })}
`);
}
function parseRpcMessage(messageText) {
  let parsed;
  try {
    parsed = JSON.parse(messageText);
  } catch {
    return { type: "invalid", text: messageText };
  }
  if (isJsonObject(parsed) && typeof parsed.m === "string") {
    return { type: "event", method: parsed.m, params: parsed.p, raw: parsed };
  }
  if (isJsonObject(parsed) && Number.isInteger(parsed.id)) {
    const response = { type: "response", id: parsed.id, result: parsed.result, raw: parsed };
    if (typeof parsed.method === "string") response.method = parsed.method;
    return response;
  }
  return { type: "unknown", raw: parsed };
}
var MAX_PENDING_MESSAGE_LENGTH = 65536;
var RpcMessageStream = class {
  #pendingText = "";
  // Streaming decode holds partial multi-byte sequences between pushes, so
  // the decoder must be per-instance state, never shared.
  #utf8Decoder = new TextDecoder();
  /** Feed one raw 64-byte HID report. Non-RPC reports are ignored. */
  pushHidPacket(packetBytes) {
    const payload = rpcPayloadFromPacket(packetBytes);
    if (!payload) return [];
    return this.pushPayload(payload);
  }
  /** Feed deframed payload bytes (a chunk of the UTF-8 message stream). */
  pushPayload(payloadBytes) {
    return this.pushText(this.#utf8Decoder.decode(payloadBytes, { stream: true }));
  }
  /** Feed decoded text directly. */
  pushText(text) {
    this.#pendingText += text;
    const lines = this.#pendingText.split(/\r?\n/);
    this.#pendingText = lines.pop() ?? "";
    const messages = lines.filter((line) => line.length > 0).map(parseRpcMessage);
    if (this.#pendingText.length > MAX_PENDING_MESSAGE_LENGTH) {
      messages.push({ type: "invalid", text: this.#pendingText.slice(0, 1024) });
      this.#pendingText = "";
    }
    return messages;
  }
  /** Text received after the last complete message (useful for diagnostics). */
  get pendingText() {
    return this.#pendingText;
  }
  /**
   * Discards buffered text and partial UTF-8 state. Call after a device
   * disconnect/reconnect — the buffer is connection state.
   */
  reset() {
    this.#pendingText = "";
    this.#utf8Decoder = new TextDecoder();
  }
};
var LightingEffect = Object.freeze({
  off: 0,
  solid: 1,
  snake: 2,
  rainbow: 3,
  breath: 4,
  gradient: 5,
  shallowBreath: 6
});
var AGENT_KEY_COUNT = 6;
var LIGHTING_EFFECT_VALUES = new Set(Object.values(LightingEffect));
function assertRgbColor(color, fieldName) {
  if (!Number.isInteger(color) || color < 0 || color > 16777215) {
    throw new RangeError(`${fieldName} must be an integer RGB color between 0x000000 and 0xffffff.`);
  }
}
function assertUnitInterval(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${fieldName} must be a number between 0 and 1.`);
  }
}
function assertLightingEffect(effect) {
  if (!LIGHTING_EFFECT_VALUES.has(effect)) {
    throw new RangeError(`effect must be one of LightingEffect (${[...LIGHTING_EFFECT_VALUES].join(", ")}).`);
  }
}
function isAgentKeyIndex(value) {
  return Number.isInteger(value) && value >= 0 && value < AGENT_KEY_COUNT;
}
function assertAgentKeyIndex(agentKeyIndex) {
  if (!isAgentKeyIndex(agentKeyIndex)) {
    throw new RangeError(`agentKeyIndex must be an integer between 0 and ${AGENT_KEY_COUNT - 1}.`);
  }
}
function encodeAgentKeyLighting({
  agentKeyIndex,
  color,
  brightness,
  effect,
  speed,
  syncKeysLighting,
  syncAmbientLighting
}) {
  assertAgentKeyIndex(agentKeyIndex);
  assertRgbColor(color, "color");
  assertUnitInterval(brightness, "brightness");
  assertLightingEffect(effect);
  assertUnitInterval(speed, "speed");
  const wireEntry = { id: agentKeyIndex, c: color, b: brightness, e: effect, s: speed };
  if (syncKeysLighting !== void 0) wireEntry.sk = syncKeysLighting ? 1 : 0;
  if (syncAmbientLighting !== void 0) wireEntry.sa = syncAmbientLighting ? 1 : 0;
  return wireEntry;
}
function agentKeyStatusParams(encodedEntries) {
  if (!Array.isArray(encodedEntries) || encodedEntries.length === 0 || encodedEntries.length > AGENT_KEY_COUNT) {
    throw new RangeError(`agentKeyStatusParams expects 1-${AGENT_KEY_COUNT} encoded entries.`);
  }
  const seenIndexes = /* @__PURE__ */ new Set();
  for (const entry of encodedEntries) {
    assertAgentKeyIndex(entry?.id);
    if (seenIndexes.has(entry.id)) throw new RangeError(`agent key ${entry.id} appears more than once.`);
    seenIndexes.add(entry.id);
  }
  return encodedEntries.map((entry) => ({ ...entry }));
}
function encodeLightingChannel({ color, brightness, effect, speed, mode = 0 }) {
  assertRgbColor(color, "color");
  assertUnitInterval(brightness, "brightness");
  assertLightingEffect(effect);
  assertUnitInterval(speed, "speed");
  if (!Number.isInteger(mode) || mode < 0) throw new RangeError("mode must be a non-negative integer.");
  return { c: color, b: brightness, e: effect, s: speed, m: mode };
}
function lightingConfigParams({ keys, ambient }) {
  if (keys === void 0 && ambient === void 0) {
    throw new TypeError("lightingConfigParams needs at least one of keys/ambient.");
  }
  const params = {};
  if (keys !== void 0) params.keys = validatedChannel(keys, "keys");
  if (ambient !== void 0) params.ambient = validatedChannel(ambient, "ambient");
  return params;
}
function validatedChannel(channel, channelName) {
  assertRgbColor(channel?.c, `${channelName}.color`);
  assertUnitInterval(channel.b, `${channelName}.brightness`);
  assertLightingEffect(channel.e);
  assertUnitInterval(channel.s, `${channelName}.speed`);
  if (!Number.isInteger(channel.m) || channel.m < 0) {
    throw new RangeError(`${channelName}.mode must be a non-negative integer.`);
  }
  return { ...channel };
}
var KeyActionCode = Object.freeze({
  release: 0,
  press: 1,
  encoderTurn: 2
});
var AGENT_KEY_NAMES = Object.freeze(["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"]);
var ACTION_KEY_NAMES = Object.freeze(["ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12"]);
var ENCODER_KEY_NAMES = Object.freeze({
  clockwise: "ENC_CW",
  counterClockwise: "ENC_CC"
});
function agentKeyIndexForName(keyName) {
  if (typeof keyName !== "string") return null;
  const index = AGENT_KEY_NAMES.indexOf(keyName);
  return index >= 0 ? index : null;
}
var ACTION_NAME_BY_CODE = new Map(
  Object.entries(KeyActionCode).map(
    ([actionName, actionCode]) => [actionCode, actionName]
  )
);
function parseKeyEvent(eventParams) {
  if (!isJsonObject(eventParams)) return null;
  const keyName = eventParams.k;
  const actionCode = eventParams.act;
  if (typeof keyName !== "string" || typeof actionCode !== "number") return null;
  const action = ACTION_NAME_BY_CODE.get(actionCode);
  if (!action) return null;
  return {
    keyName,
    action,
    actionCode,
    agentKeyIndex: agentKeyIndexForName(keyName)
  };
}
function parseJoystickSample(eventParams) {
  if (!isJsonObject(eventParams)) return null;
  const angle = eventParams.a;
  const distance = eventParams.d;
  if (typeof angle !== "number" || typeof distance !== "number") return null;
  if (!Number.isFinite(angle) || !Number.isFinite(distance)) return null;
  if (distance < 0 || distance > 1) return null;
  return { angle, distance };
}
var JOYSTICK_DIRECTIONS = Object.freeze(["right", "down", "left", "up"]);
function joystickDirection(angle) {
  if (!Number.isFinite(angle)) throw new RangeError("angle must be a finite number.");
  const normalizedAngle = (angle % 1 + 1) % 1;
  return JOYSTICK_DIRECTIONS[Math.round(normalizedAngle * 4) % 4];
}
var JoystickFlickDetector = class {
  #latched = false;
  #triggerDistance;
  #rearmDistance;
  constructor({ triggerDistance = 0.8, rearmDistance = 0.2 } = {}) {
    if (!(rearmDistance < triggerDistance)) {
      throw new RangeError("rearmDistance must be smaller than triggerDistance.");
    }
    this.#triggerDistance = triggerDistance;
    this.#rearmDistance = rearmDistance;
  }
  /** Feed one sample; returns a direction or null. Malformed samples are ignored. */
  update(sample) {
    if (!sample || !Number.isFinite(sample.angle) || !Number.isFinite(sample.distance)) return null;
    if (sample.distance < this.#rearmDistance) {
      this.#latched = false;
      return null;
    }
    if (this.#latched || sample.distance < this.#triggerDistance) return null;
    this.#latched = true;
    return joystickDirection(sample.angle);
  }
};
function parseDeviceEvent(message) {
  if (message?.type !== "event") return null;
  if (message.method === RpcMethod.keyEvent) {
    const keyEvent = parseKeyEvent(message.params);
    if (keyEvent) return { kind: "keyEvent", ...keyEvent };
  }
  if (message.method === RpcMethod.joystickSample) {
    const joystickSample = parseJoystickSample(message.params);
    if (joystickSample) return { kind: "joystickSample", ...joystickSample };
  }
  return { kind: "unrecognized", method: message.method, params: message.params };
}
function firmwareVersionRequest({ id }) {
  return { method: RpcMethod.firmwareVersion, params: null, id };
}
function agentKeyStatusRequest({ agentKeys, id }) {
  return { method: RpcMethod.agentKeyStatus, params: agentKeyStatusParams(agentKeys), id };
}
function lightingConfigRequest({ keys, ambient, id }) {
  return { method: RpcMethod.lightingConfig, params: lightingConfigParams({ keys, ambient }), id };
}
function encodeRequestPackets(request) {
  return encodeHidPackets(encodeRpcRequest(request));
}

// src/micro.ts
import { HIDAsync, devices } from "node-hid";
function findCodexMicros() {
  return devices().filter(isCodexMicroInterface);
}
var CodexMicro = class _CodexMicro {
  #device;
  #requestIds = new RequestIdSequence();
  descriptor;
  static async connect() {
    const [descriptor] = findCodexMicros();
    if (!descriptor?.path) {
      throw new Error("Codex Micro vendor HID interface not found. Connect it by USB and grant Input Monitoring to your terminal.");
    }
    const handle = await HIDAsync.open(descriptor.path, { nonExclusive: true });
    return new _CodexMicro(handle, descriptor);
  }
  constructor(device, descriptor) {
    this.#device = device;
    this.descriptor = descriptor;
  }
  /** Sends one RPC request; returns the request id it was assigned. */
  async sendRequest(method, params) {
    const requestId = this.#requestIds.next();
    for (const packet of encodeRequestPackets({ method, params, id: requestId })) {
      await this.#device.write(Buffer.from(packet));
    }
    return requestId;
  }
  async close() {
    await this.#device.close();
  }
  onInput(listener) {
    this.#device.on("data", listener);
    this.#device.on("error", () => {
    });
  }
};

export {
  rpcPayloadFromPacket,
  RpcMethod,
  RpcMessageStream,
  LightingEffect,
  AGENT_KEY_COUNT,
  assertAgentKeyIndex,
  encodeAgentKeyLighting,
  encodeLightingChannel,
  ENCODER_KEY_NAMES,
  JoystickFlickDetector,
  parseDeviceEvent,
  firmwareVersionRequest,
  agentKeyStatusRequest,
  lightingConfigRequest,
  encodeRequestPackets,
  findCodexMicros,
  CodexMicro
};
