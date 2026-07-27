import { describe, expect, test } from "bun:test";
import {
  ACTION_KEY_NAMES,
  AGENT_KEY_NAMES,
  ENCODER_KEY_NAMES,
  JoystickFlickDetector,
  KeyActionCode,
  agentKeyIndexForName,
  joystickDirection,
  parseDeviceEvent,
  parseJoystickSample,
  parseKeyEvent,
  parseRpcMessage,
} from "../src/index.js";

describe("key name tables", () => {
  test("cover all six agent keys and seven action keys", () => {
    expect([...AGENT_KEY_NAMES]).toEqual(["AG00", "AG01", "AG02", "AG03", "AG04", "AG05"]);
    expect([...ACTION_KEY_NAMES]).toEqual(["ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12"]);
  });

  test("agentKeyIndexForName maps names to indexes and rejects everything else", () => {
    expect(agentKeyIndexForName("AG00")).toBe(0);
    expect(agentKeyIndexForName("AG05")).toBe(5);
    expect(agentKeyIndexForName("AG06")).toBeNull();
    expect(agentKeyIndexForName("ACT06")).toBeNull();
    expect(agentKeyIndexForName(undefined)).toBeNull();
  });
});

describe("parseKeyEvent", () => {
  test("parses press, release, and encoder turns", () => {
    expect(parseKeyEvent({ k: "AG03", act: KeyActionCode.press })).toEqual({
      keyName: "AG03",
      action: "press",
      actionCode: 1,
      agentKeyIndex: 3,
    });
    expect(parseKeyEvent({ k: "ACT12", act: KeyActionCode.release })).toMatchObject({
      action: "release",
      agentKeyIndex: null,
    });
    expect(parseKeyEvent({ k: ENCODER_KEY_NAMES.clockwise, act: KeyActionCode.encoderTurn })).toMatchObject({
      action: "encoderTurn",
    });
  });

  test("returns null for malformed params", () => {
    expect(parseKeyEvent({ k: "AG00", act: 3 })).toBeNull();
    expect(parseKeyEvent({ act: 1 })).toBeNull();
    expect(parseKeyEvent(null)).toBeNull();
  });
});

describe("joystick", () => {
  test("parseJoystickSample validates both fields", () => {
    expect(parseJoystickSample({ a: 0.25, d: 0.9 })).toEqual({ angle: 0.25, distance: 0.9 });
    expect(parseJoystickSample({ a: "spin", d: 1 })).toBeNull();
    expect(parseJoystickSample({})).toBeNull();
  });

  test("parseJoystickSample rejects coercible non-numbers instead of forging a centered sample", () => {
    // Number(null) / Number("") / Number([]) are all 0 — coercion here would
    // manufacture a distance-0 sample and silently re-arm the flick detector.
    for (const params of [{ a: null, d: null }, { a: "", d: "" }, { a: true, d: [] }, { a: "0.5", d: "0.9" }]) {
      expect(parseJoystickSample(params)).toBeNull();
    }
  });

  test("parseJoystickSample rejects out-of-range deflection", () => {
    expect(parseJoystickSample({ a: 0.25, d: 500 })).toBeNull();
    expect(parseJoystickSample({ a: 0.25, d: -0.1 })).toBeNull();
    expect(parseJoystickSample({ a: 7, d: 1 })).toEqual({ angle: 7, distance: 1 });
  });

  test("a malformed sample cannot un-latch a held deflection", () => {
    const detector = new JoystickFlickDetector();
    expect(detector.update({ angle: 0, distance: 0.95 })).toBe("right");
    expect(detector.update({ angle: 0, distance: 0.95 })).toBeNull();
    // Previously {a:null,d:null} parsed as a centered sample and re-armed here.
    expect(detector.update(parseJoystickSample({ a: null, d: null }))).toBeNull();
    expect(detector.update({ angle: 0, distance: 0.95 })).toBeNull();
  });

  test("joystickDirection rejects non-finite angles", () => {
    expect(() => joystickDirection(Number.NaN)).toThrow(RangeError);
    expect(() => joystickDirection(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test("flick detector ignores malformed samples without latching", () => {
    const detector = new JoystickFlickDetector();
    expect(detector.update({ angle: Number.NaN, distance: 1 })).toBeNull();
    expect(detector.update({ angle: 0, distance: Number.NaN })).toBeNull();
    // A NaN sample must not have latched the detector.
    expect(detector.update({ angle: 0, distance: 0.9 })).toBe("right");
  });

  test("joystickDirection snaps quadrants clockwise from right", () => {
    expect(joystickDirection(0)).toBe("right");
    expect(joystickDirection(0.25)).toBe("down");
    expect(joystickDirection(0.5)).toBe("left");
    expect(joystickDirection(0.75)).toBe("up");
    expect(joystickDirection(0.99)).toBe("right");
    expect(joystickDirection(1.25)).toBe("down");
    expect(joystickDirection(-0.25)).toBe("up");
  });

  test("flick detector emits once per deflection and re-arms near center", () => {
    const detector = new JoystickFlickDetector();
    expect(detector.update({ angle: 0.5, distance: 0.5 })).toBeNull();
    expect(detector.update({ angle: 0.5, distance: 0.95 })).toBe("left");
    expect(detector.update({ angle: 0.5, distance: 1 })).toBeNull();
    expect(detector.update({ angle: 0.5, distance: 0.5 })).toBeNull();
    expect(detector.update({ angle: 0.5, distance: 0.1 })).toBeNull();
    expect(detector.update({ angle: 0, distance: 0.9 })).toBe("right");
  });

  test("flick detector rejects inverted thresholds", () => {
    expect(() => new JoystickFlickDetector({ triggerDistance: 0.1, rearmDistance: 0.5 })).toThrow(RangeError);
  });
});

describe("parseDeviceEvent", () => {
  test("classifies full wire messages end to end", () => {
    const keyMessage = parseRpcMessage(`{"m":"v.oai.hid","p":{"k":"AG01","act":1}}`);
    expect(parseDeviceEvent(keyMessage)).toMatchObject({ kind: "keyEvent", agentKeyIndex: 1, action: "press" });

    const joystickMessage = parseRpcMessage(`{"m":"v.oai.rad","p":{"a":0.75,"d":1}}`);
    expect(parseDeviceEvent(joystickMessage)).toMatchObject({ kind: "joystickSample", angle: 0.75 });

    const futureMessage = parseRpcMessage(`{"m":"v.oai.new","p":{}}`);
    expect(parseDeviceEvent(futureMessage)).toMatchObject({ kind: "unrecognized", method: "v.oai.new" });
  });

  test("returns null for responses and invalid lines", () => {
    expect(parseDeviceEvent(parseRpcMessage(`{"id":9}`))).toBeNull();
    expect(parseDeviceEvent(parseRpcMessage("garbage"))).toBeNull();
    expect(parseDeviceEvent(null)).toBeNull();
  });

  test("malformed key params fall through to unrecognized, not a crash", () => {
    const malformed = parseRpcMessage(`{"m":"v.oai.hid","p":{"k":"AG00","act":9}}`);
    expect(parseDeviceEvent(malformed)).toMatchObject({ kind: "unrecognized", method: "v.oai.hid" });
  });
});
