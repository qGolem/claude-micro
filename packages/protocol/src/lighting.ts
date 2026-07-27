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
} as const);

export type LightingEffectValue = (typeof LightingEffect)[keyof typeof LightingEffect];

export const AGENT_KEY_COUNT = 6;

export type AgentKeyIndex = 0 | 1 | 2 | 3 | 4 | 5;

export interface AgentKeyLightingOptions {
  agentKeyIndex: AgentKeyIndex;
  /** RGB color, 0xRRGGBB. */
  color: number;
  /** 0-1. */
  brightness: number;
  effect: LightingEffectValue;
  /** Effect speed, 0-1. */
  speed: number;
  /** Mirror this key's style onto the typing keys. */
  syncKeysLighting?: boolean;
  /** Mirror this key's style onto the ambient/underglow. */
  syncAmbientLighting?: boolean;
}

/** One entry of an RpcMethod.agentKeyStatus params array, as sent on the wire. */
export interface AgentKeyLightingWire {
  id: number;
  c: number;
  b: number;
  e: number;
  s: number;
  sk?: 0 | 1;
  sa?: 0 | 1;
}

export interface LightingChannelOptions {
  /** RGB color, 0xRRGGBB. */
  color: number;
  /** 0-1. */
  brightness: number;
  effect: LightingEffectValue;
  /** Effect speed, 0-1. */
  speed: number;
  /** Firmware lighting mode; only 0 has been observed. */
  mode?: number;
}

/** One channel of an RpcMethod.lightingConfig params object, as sent on the wire. */
export interface LightingChannelWire {
  c: number;
  b: number;
  e: number;
  s: number;
  m: number;
}

export interface LightingConfigWire {
  keys?: LightingChannelWire;
  ambient?: LightingChannelWire;
}

const LIGHTING_EFFECT_VALUES = new Set<number>(Object.values(LightingEffect));

function assertRgbColor(color: number, fieldName: string): void {
  if (!Number.isInteger(color) || color < 0 || color > 0xffffff) {
    throw new RangeError(`${fieldName} must be an integer RGB color between 0x000000 and 0xffffff.`);
  }
}

function assertUnitInterval(value: number, fieldName: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${fieldName} must be a number between 0 and 1.`);
  }
}

function assertLightingEffect(effect: number): void {
  if (!LIGHTING_EFFECT_VALUES.has(effect)) {
    throw new RangeError(`effect must be one of LightingEffect (${[...LIGHTING_EFFECT_VALUES].join(", ")}).`);
  }
}

/** Type guard for the 0-5 agent-key range. */
export function isAgentKeyIndex(value: number): value is AgentKeyIndex {
  return Number.isInteger(value) && value >= 0 && value < AGENT_KEY_COUNT;
}

/** Throwing variant of isAgentKeyIndex; narrows on success. */
export function assertAgentKeyIndex(agentKeyIndex: number): asserts agentKeyIndex is AgentKeyIndex {
  if (!isAgentKeyIndex(agentKeyIndex)) {
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
}: AgentKeyLightingOptions): AgentKeyLightingWire {
  assertAgentKeyIndex(agentKeyIndex);
  assertRgbColor(color, "color");
  assertUnitInterval(brightness, "brightness");
  assertLightingEffect(effect);
  assertUnitInterval(speed, "speed");
  const wireEntry: AgentKeyLightingWire = { id: agentKeyIndex, c: color, b: brightness, e: effect, s: speed };
  if (syncKeysLighting !== undefined) wireEntry.sk = syncKeysLighting ? 1 : 0;
  if (syncAmbientLighting !== undefined) wireEntry.sa = syncAmbientLighting ? 1 : 0;
  return wireEntry;
}

/**
 * Validates and assembles the params array for RpcMethod.agentKeyStatus.
 * Accepts 1-6 already-encoded entries; entries may address any subset of keys
 * but each key at most once.
 */
export function agentKeyStatusParams(encodedEntries: AgentKeyLightingWire[]): AgentKeyLightingWire[] {
  if (!Array.isArray(encodedEntries) || encodedEntries.length === 0 || encodedEntries.length > AGENT_KEY_COUNT) {
    throw new RangeError(`agentKeyStatusParams expects 1-${AGENT_KEY_COUNT} encoded entries.`);
  }
  const seenIndexes = new Set<number>();
  for (const entry of encodedEntries) {
    assertAgentKeyIndex(entry?.id);
    if (seenIndexes.has(entry.id)) throw new RangeError(`agent key ${entry.id} appears more than once.`);
    seenIndexes.add(entry.id);
  }
  // Copy the entries themselves, not just the array: a caller holding a
  // reference (e.g. reusing one entry object across animation frames) could
  // otherwise mutate validated values onto the wire.
  return encodedEntries.map((entry) => ({ ...entry }));
}

/**
 * Builds one channel object for an RpcMethod.lightingConfig request.
 */
export function encodeLightingChannel({ color, brightness, effect, speed, mode = 0 }: LightingChannelOptions): LightingChannelWire {
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
export function lightingConfigParams({ keys, ambient }: LightingConfigWire): LightingConfigWire {
  if (keys === undefined && ambient === undefined) {
    throw new TypeError("lightingConfigParams needs at least one of keys/ambient.");
  }
  const params: LightingConfigWire = {};
  // Re-validate even though the channels are meant to come from
  // encodeLightingChannel — the wire types are plain numbers, so nothing but
  // this check stops out-of-range values reaching the firmware.
  if (keys !== undefined) params.keys = validatedChannel(keys, "keys");
  if (ambient !== undefined) params.ambient = validatedChannel(ambient, "ambient");
  return params;
}

function validatedChannel(channel: LightingChannelWire, channelName: string): LightingChannelWire {
  assertRgbColor(channel?.c, `${channelName}.color`);
  assertUnitInterval(channel.b, `${channelName}.brightness`);
  assertLightingEffect(channel.e);
  assertUnitInterval(channel.s, `${channelName}.speed`);
  if (!Number.isInteger(channel.m) || channel.m < 0) {
    throw new RangeError(`${channelName}.mode must be a non-negative integer.`);
  }
  return { ...channel };
}
