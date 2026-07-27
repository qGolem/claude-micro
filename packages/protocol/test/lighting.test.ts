import { describe, expect, test } from "bun:test";
import {
  LightingEffect,
  agentKeyStatusParams,
  agentKeyStatusRequest,
  encodeAgentKeyLighting,
  encodeLightingChannel,
  firmwareVersionRequest,
  lightingConfigParams,
  lightingConfigRequest,
  encodeRequestPackets,
  type AgentKeyIndex,
} from "../src/index.js";

describe("encodeAgentKeyLighting", () => {
  test("maps descriptive fields onto the abbreviated wire shape", () => {
    const wireEntry = encodeAgentKeyLighting({
      agentKeyIndex: 2,
      color: 0x3b82f6,
      brightness: 1,
      effect: LightingEffect.shallowBreath,
      speed: 0.45,
    });
    expect(wireEntry).toEqual({ id: 2, c: 0x3b82f6, b: 1, e: 6, s: 0.45 });
  });

  test("includes sync flags only when explicitly set", () => {
    const withFlags = encodeAgentKeyLighting({
      agentKeyIndex: 0,
      color: 0,
      brightness: 0,
      effect: LightingEffect.off,
      speed: 0,
      syncKeysLighting: true,
      syncAmbientLighting: false,
    });
    expect(withFlags.sk).toBe(1);
    expect(withFlags.sa).toBe(0);
    const withoutFlags = encodeAgentKeyLighting({ agentKeyIndex: 0, color: 0, brightness: 0, effect: 0, speed: 0 });
    expect("sk" in withoutFlags).toBe(false);
    expect("sa" in withoutFlags).toBe(false);
  });

  test("rejects out-of-range fields", () => {
    const validEntry = { agentKeyIndex: 0 as AgentKeyIndex, color: 0xffffff, brightness: 1, effect: 1 as const, speed: 1 };
    // @ts-expect-error deliberately out-of-range index to test the runtime guard
    expect(() => encodeAgentKeyLighting({ ...validEntry, agentKeyIndex: 6 })).toThrow(RangeError);
    expect(() => encodeAgentKeyLighting({ ...validEntry, color: 0x1000000 })).toThrow(RangeError);
    expect(() => encodeAgentKeyLighting({ ...validEntry, color: 0.5 })).toThrow(RangeError);
    expect(() => encodeAgentKeyLighting({ ...validEntry, brightness: 1.1 })).toThrow(RangeError);
    // @ts-expect-error deliberately invalid effect to test the runtime guard
    expect(() => encodeAgentKeyLighting({ ...validEntry, effect: 7 })).toThrow(RangeError);
    expect(() => encodeAgentKeyLighting({ ...validEntry, speed: Number.NaN })).toThrow(RangeError);
  });
});

describe("agentKeyStatusParams", () => {
  const idleEntry = (agentKeyIndex: AgentKeyIndex) =>
    encodeAgentKeyLighting({ agentKeyIndex, color: 0xffffff, brightness: 0.35, effect: LightingEffect.solid, speed: 0 });

  test("accepts a full six-key update and partial updates", () => {
    expect(agentKeyStatusParams(([0, 1, 2, 3, 4, 5] as const).map(idleEntry))).toHaveLength(6);
    expect(agentKeyStatusParams([idleEntry(3)])).toHaveLength(1);
  });

  test("copies entries, not just the array, so later mutation cannot bypass validation", () => {
    const entry = idleEntry(0);
    const validated = agentKeyStatusParams([entry]);
    expect(validated).not.toBe(entry);
    // A caller reusing the entry object (e.g. across animation frames) must
    // not be able to push post-validation values onto the wire.
    entry.id = 99;
    entry.b = 42;
    expect(validated[0]).toMatchObject({ id: 0, b: 0.35 });
  });

  test("rejects empty, oversized, and duplicate-key updates", () => {
    expect(() => agentKeyStatusParams([])).toThrow(RangeError);
    expect(() => agentKeyStatusParams(([0, 1, 2, 3, 4, 5, 5] as const).map(idleEntry))).toThrow(RangeError);
    expect(() => agentKeyStatusParams([idleEntry(1), idleEntry(1)])).toThrow(RangeError);
  });
});

describe("whole-board lighting config", () => {
  test("builds channel objects with the mode field defaulted", () => {
    const channel = encodeLightingChannel({ color: 0xff0000, brightness: 1, effect: LightingEffect.breath, speed: 0.45 });
    expect(channel).toEqual({ c: 0xff0000, b: 1, e: 4, s: 0.45, m: 0 });
  });

  test("requires at least one channel", () => {
    expect(() => lightingConfigParams({})).toThrow(TypeError);
    const channel = encodeLightingChannel({ color: 0, brightness: 0, effect: 0, speed: 0 });
    expect(lightingConfigParams({ ambient: channel })).toEqual({ ambient: channel });
  });

  test("re-validates hand-built channels instead of trusting the wire type", () => {
    // LightingChannelWire fields are plain numbers, so only this check stops
    // out-of-range values reaching the firmware.
    expect(() => lightingConfigParams({ keys: { c: -1, b: 1, e: 1, s: 0, m: 0 } })).toThrow(RangeError);
    expect(() => lightingConfigParams({ keys: { c: 0, b: 99, e: 1, s: 0, m: 0 } })).toThrow(RangeError);
    expect(() => lightingConfigParams({ ambient: { c: 0, b: 1, e: 42, s: 0, m: 0 } })).toThrow(RangeError);
    expect(() => lightingConfigParams({ ambient: { c: 0, b: 1, e: 1, s: -3, m: 0 } })).toThrow(RangeError);
    expect(() => lightingConfigParams({ keys: { c: 0, b: 1, e: 1, s: 0, m: -7 } })).toThrow(RangeError);
  });
});

describe("request builders", () => {
  test("firmwareVersionRequest carries null params", () => {
    expect(firmwareVersionRequest({ id: 901 })).toEqual({ method: "sys.version", params: null, id: 901 });
  });

  test("agentKeyStatusRequest validates and wraps its entries", () => {
    const entry = encodeAgentKeyLighting({ agentKeyIndex: 0, color: 0x22c55e, brightness: 1, effect: 1, speed: 0 });
    const request = agentKeyStatusRequest({ agentKeys: [entry], id: 5 });
    expect(request.method).toBe("v.oai.thstatus");
    expect(request.params).toEqual([entry]);
  });

  test("encodeRequestPackets produces valid framed packets end to end", () => {
    const channel = encodeLightingChannel({ color: 0x00ffff, brightness: 1, effect: LightingEffect.breath, speed: 0.45 });
    const request = lightingConfigRequest({ keys: channel, ambient: channel, id: 100 });
    const packets = encodeRequestPackets(request);
    expect(packets.length).toBeGreaterThan(0);
    const wireText = new TextDecoder().decode(
      Uint8Array.from(packets.flatMap((packet) => [...packet.subarray(3, 3 + packet[2]!)])),
    );
    expect(JSON.parse(wireText)).toEqual({ method: "v.oai.rgbcfg", params: { keys: channel, ambient: channel }, id: 100 });
  });
});
