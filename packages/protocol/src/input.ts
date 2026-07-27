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

import { RpcMethod, type RpcMessage } from "./rpc";
import { AGENT_KEY_COUNT } from "./lighting";

export const KeyActionCode = Object.freeze({
  release: 0,
  press: 1,
  encoderTurn: 2,
} as const);

export type KeyActionCodeValue = (typeof KeyActionCode)[keyof typeof KeyActionCode];
export type KeyActionName = keyof typeof KeyActionCode;

export const AGENT_KEY_NAMES: readonly string[] = Object.freeze(
  Array.from({ length: AGENT_KEY_COUNT }, (_unused, agentKeyIndex) => `AG0${agentKeyIndex}`),
);

export const ACTION_KEY_NAMES: readonly string[] = Object.freeze([
  "ACT06",
  "ACT07",
  "ACT08",
  "ACT09",
  "ACT10",
  "ACT11",
  "ACT12",
]);

export const ENCODER_KEY_NAMES = Object.freeze({
  clockwise: "ENC_CW",
  counterClockwise: "ENC_CC",
} as const);

export interface ParsedKeyEvent {
  keyName: string;
  action: KeyActionName;
  actionCode: KeyActionCodeValue;
  /** Set only for AG00-AG05; null for action keys and the encoder. */
  agentKeyIndex: number | null;
}

export interface JoystickSample {
  /** 0-1, clockwise from 0 = right. */
  angle: number;
  /** 0 (center) to 1 (full deflection). */
  distance: number;
}

export type JoystickDirection = "right" | "down" | "left" | "up";

export type DeviceEvent =
  | ({ kind: "keyEvent" } & ParsedKeyEvent)
  | ({ kind: "joystickSample" } & JoystickSample)
  | { kind: "unrecognized"; method: string; params: unknown };

const AGENT_KEY_NAME_PATTERN = /^AG0([0-5])$/;

/** Maps an agent-key name (AG00-AG05) to its index 0-5, or null. */
export function agentKeyIndexForName(keyName: unknown): number | null {
  if (typeof keyName !== "string") return null;
  const match = AGENT_KEY_NAME_PATTERN.exec(keyName);
  return match ? Number(match[1]) : null;
}

const ACTION_NAME_BY_CODE: ReadonlyMap<number, KeyActionName> = new Map(
  (Object.entries(KeyActionCode) as [KeyActionName, KeyActionCodeValue][]).map(
    ([actionName, actionCode]) => [actionCode, actionName],
  ),
);

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parses the params of an RpcMethod.keyEvent message. Returns null when the
 * params do not look like a key event.
 */
export function parseKeyEvent(eventParams: unknown): ParsedKeyEvent | null {
  if (!isJsonObject(eventParams)) return null;
  const keyName = eventParams.k;
  const actionCode = eventParams.act;
  if (typeof keyName !== "string" || typeof actionCode !== "number") return null;
  const action = ACTION_NAME_BY_CODE.get(actionCode);
  if (!action) return null;
  return {
    keyName,
    action,
    actionCode: actionCode as KeyActionCodeValue,
    agentKeyIndex: agentKeyIndexForName(keyName),
  };
}

/**
 * Parses the params of an RpcMethod.joystickSample message. Returns null when
 * the sample is malformed.
 */
export function parseJoystickSample(eventParams: unknown): JoystickSample | null {
  if (!isJsonObject(eventParams)) return null;
  const angle = Number(eventParams.a);
  const distance = Number(eventParams.d);
  if (!Number.isFinite(angle) || !Number.isFinite(distance)) return null;
  return { angle, distance };
}

export const JOYSTICK_DIRECTIONS: readonly JoystickDirection[] = Object.freeze(["right", "down", "left", "up"]);

/** Snaps a joystick angle (0-1, clockwise from right) to the nearest cardinal direction. */
export function joystickDirection(angle: number): JoystickDirection {
  const normalizedAngle = ((angle % 1) + 1) % 1;
  return JOYSTICK_DIRECTIONS[Math.round(normalizedAngle * 4) % 4] as JoystickDirection;
}

export interface JoystickFlickDetectorOptions {
  /** Deflection that fires a flick. Default 0.8. */
  triggerDistance?: number;
  /** Deflection under which the detector re-arms. Default 0.2. */
  rearmDistance?: number;
}

/**
 * Turns the continuous radial stream into discrete flicks: emits one cardinal
 * direction when the stick crosses triggerDistance, then stays silent until
 * it returns inside rearmDistance.
 */
export class JoystickFlickDetector {
  #latched = false;
  #triggerDistance: number;
  #rearmDistance: number;

  constructor({ triggerDistance = 0.8, rearmDistance = 0.2 }: JoystickFlickDetectorOptions = {}) {
    if (!(rearmDistance < triggerDistance)) {
      throw new RangeError("rearmDistance must be smaller than triggerDistance.");
    }
    this.#triggerDistance = triggerDistance;
    this.#rearmDistance = rearmDistance;
  }

  /** Feed one sample; returns a direction or null. */
  update(sample: JoystickSample | null | undefined): JoystickDirection | null {
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
 * typed input event. Returns null when the message is not a device event.
 */
export function parseDeviceEvent(message: RpcMessage | null | undefined): DeviceEvent | null {
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
