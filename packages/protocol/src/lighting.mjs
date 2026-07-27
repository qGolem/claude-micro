// Lighting payloads. Two independent surfaces:
//
//  - Agent-key status (RpcMethod.agentKeyStatus): the six frosted keys, each
//    addressed individually. Wire fields per key:
//      id  agent-key index 0-5
//      c   RGB color, 0xRRGGBB
//      b   brightness 0-1
//      e   effect (LightingEffect)
//      s   effect speed 0-1
//      sk  optional 0/1 — mirror this key's style onto the typing keys
//      sa  optional 0/1 — mirror this key's style onto the ambient/underglow
//
//  - Whole-board config (RpcMethod.lightingConfig): the "keys" and "ambient"
//    channels, each {c, b, e, s, m}. The m (mode) field is accepted by the
//    firmware; only mode 0 has been observed.

export const LightingEffect = Object.freeze({
  off: 0,
  solid: 1,
  snake: 2,
  rainbow: 3,
  breath: 4,
  gradient: 5,
  shallowBreath: 6,
});

export const AGENT_KEY_COUNT = 6;

const LIGHTING_EFFECT_VALUES = new Set(Object.values(LightingEffect));

function assertRgbColor(color, fieldName) {
  if (!Number.isInteger(color) || color < 0 || color > 0xffffff) {
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
    throw new RangeError(`effect must be one of LightingEffect (0-${LIGHTING_EFFECT_VALUES.size - 1}).`);
  }
}

export function assertAgentKeyIndex(agentKeyIndex) {
  if (!Number.isInteger(agentKeyIndex) || agentKeyIndex < 0 || agentKeyIndex >= AGENT_KEY_COUNT) {
    throw new RangeError(`agentKeyIndex must be an integer between 0 and ${AGENT_KEY_COUNT - 1}.`);
  }
}

/**
 * Builds one agent-key entry for an RpcMethod.agentKeyStatus request.
 * The sync flags are omitted from the wire unless explicitly set — the
 * firmware treats absent and 0 differently on some versions.
 */
export function encodeAgentKeyLighting({
  agentKeyIndex,
  color,
  brightness,
  effect,
  speed,
  syncKeysLighting,
  syncAmbientLighting,
}) {
  assertAgentKeyIndex(agentKeyIndex);
  assertRgbColor(color, "color");
  assertUnitInterval(brightness, "brightness");
  assertLightingEffect(effect);
  assertUnitInterval(speed, "speed");
  const wireEntry = { id: agentKeyIndex, c: color, b: brightness, e: effect, s: speed };
  if (syncKeysLighting !== undefined) wireEntry.sk = syncKeysLighting ? 1 : 0;
  if (syncAmbientLighting !== undefined) wireEntry.sa = syncAmbientLighting ? 1 : 0;
  return wireEntry;
}

/**
 * Validates and assembles the params array for RpcMethod.agentKeyStatus.
 * Accepts 1-6 already-encoded entries; entries may address any subset of keys
 * but each key at most once.
 */
export function agentKeyStatusParams(encodedEntries) {
  if (!Array.isArray(encodedEntries) || encodedEntries.length === 0 || encodedEntries.length > AGENT_KEY_COUNT) {
    throw new RangeError(`agentKeyStatusParams expects 1-${AGENT_KEY_COUNT} encoded entries.`);
  }
  const seenIndexes = new Set();
  for (const entry of encodedEntries) {
    assertAgentKeyIndex(entry?.id);
    if (seenIndexes.has(entry.id)) throw new RangeError(`agent key ${entry.id} appears more than once.`);
    seenIndexes.add(entry.id);
  }
  return encodedEntries;
}

/**
 * Builds one channel object for an RpcMethod.lightingConfig request.
 */
export function encodeLightingChannel({ color, brightness, effect, speed, mode = 0 }) {
  assertRgbColor(color, "color");
  assertUnitInterval(brightness, "brightness");
  assertLightingEffect(effect);
  assertUnitInterval(speed, "speed");
  if (!Number.isInteger(mode) || mode < 0) throw new RangeError("mode must be a non-negative integer.");
  return { c: color, b: brightness, e: effect, s: speed, m: mode };
}

/**
 * Assembles the params object for RpcMethod.lightingConfig. Pass either or
 * both channels (already encoded with encodeLightingChannel).
 */
export function lightingConfigParams({ keys, ambient }) {
  if (keys === undefined && ambient === undefined) {
    throw new TypeError("lightingConfigParams needs at least one of keys/ambient.");
  }
  const params = {};
  if (keys !== undefined) params.keys = keys;
  if (ambient !== undefined) params.ambient = ambient;
  return params;
}
