// Input events reported by the device on the RPC channel.
//
// Key events (RpcMethod.keyEvent) carry {k: keyName, act: actionCode}:
//   AG00-AG05    the six frosted agent keys (left to right)
//   ACT06-ACT12  the seven action keys (firmware position names)
//   ENC_CW/ENC_CC  the rotary encoder; on observed units the physical LEFT
//                  turn reports ENC_CW and the RIGHT turn reports ENC_CC
//
// Action codes: 0 = release, 1 = press, 2 = encoder turn (turns arrive as a
// single act=2 event per detent, on the ENC_* key names).
//
// Joystick samples (RpcMethod.joystickSample) carry {a: angle, d: distance}:
// a continuous radial stream while the stick is deflected. Angle is 0-1
// running clockwise from 0 = right (0.25 = down, 0.5 = left, 0.75 = up);
// distance is 0 (center) to 1 (full deflection).

import { RpcMethod } from "./rpc.mjs";
import { AGENT_KEY_COUNT } from "./lighting.mjs";

export const KeyActionCode = Object.freeze({
  release: 0,
  press: 1,
  encoderTurn: 2,
});

export const AGENT_KEY_NAMES = Object.freeze(
  Array.from({ length: AGENT_KEY_COUNT }, (_unused, agentKeyIndex) => `AG0${agentKeyIndex}`),
);

export const ACTION_KEY_NAMES = Object.freeze(["ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12"]);

export const ENCODER_KEY_NAMES = Object.freeze({
  clockwise: "ENC_CW",
  counterClockwise: "ENC_CC",
});

const AGENT_KEY_NAME_PATTERN = /^AG0([0-5])$/;

/** Maps an agent-key name (AG00-AG05) to its index 0-5, or null. */
export function agentKeyIndexForName(keyName) {
  const match = AGENT_KEY_NAME_PATTERN.exec(keyName ?? "");
  return match ? Number(match[1]) : null;
}

const ACTION_NAME_BY_CODE = Object.freeze(
  Object.fromEntries(Object.entries(KeyActionCode).map(([actionName, actionCode]) => [actionCode, actionName])),
);

/**
 * Parses the params of an RpcMethod.keyEvent message.
 * Returns {keyName, action, actionCode, agentKeyIndex} or null when the
 * params do not look like a key event. `action` is "press" | "release" |
 * "encoderTurn"; agentKeyIndex is set only for AG00-AG05.
 */
export function parseKeyEvent(eventParams) {
  const keyName = eventParams?.k;
  const actionCode = eventParams?.act;
  if (typeof keyName !== "string" || !(actionCode in ACTION_NAME_BY_CODE)) return null;
  return {
    keyName,
    action: ACTION_NAME_BY_CODE[actionCode],
    actionCode,
    agentKeyIndex: agentKeyIndexForName(keyName),
  };
}

/**
 * Parses the params of an RpcMethod.joystickSample message.
 * Returns {angle, distance} or null when the sample is malformed.
 */
export function parseJoystickSample(eventParams) {
  const angle = Number(eventParams?.a);
  const distance = Number(eventParams?.d);
  if (!Number.isFinite(angle) || !Number.isFinite(distance)) return null;
  return { angle, distance };
}

export const JOYSTICK_DIRECTIONS = Object.freeze(["right", "down", "left", "up"]);

/** Snaps a joystick angle (0-1, clockwise from right) to the nearest cardinal direction. */
export function joystickDirection(angle) {
  const normalizedAngle = ((angle % 1) + 1) % 1;
  return JOYSTICK_DIRECTIONS[Math.round(normalizedAngle * 4) % 4];
}

/**
 * Turns the continuous radial stream into discrete flicks: emits one cardinal
 * direction when the stick crosses triggerDistance, then stays silent until
 * it returns inside rearmDistance.
 */
export class JoystickFlickDetector {
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

  /** Feed one {angle, distance} sample; returns a direction or null. */
  update(sample) {
    if (!sample) return null;
    if (sample.distance < this.#rearmDistance) {
      this.#latched = false;
      return null;
    }
    if (this.#latched || sample.distance < this.#triggerDistance) return null;
    this.#latched = true;
    return joystickDirection(sample.angle);
  }
}

/**
 * Classifies a parsed device event message (from RpcMessageStream) into a
 * typed input event:
 *   {kind: "keyEvent", keyName, action, actionCode, agentKeyIndex}
 *   {kind: "joystickSample", angle, distance}
 *   {kind: "unrecognized", method, params}
 * Returns null when the message is not a device event.
 */
export function parseDeviceEvent(message) {
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
