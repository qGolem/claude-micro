// RPC envelope layer. Requests and device messages are JSON, one message per
// line. The firmware's parser only dispatches complete newline-terminated
// messages, so every encoded request ends with "\n".
//
// Wire shapes:
//   host → device   {"method": string, "params": any, "id": number}\n
//   device → host   {"m": string, "p": any}\n          (spontaneous event)
//   device → host   {"id": number, "method": string, "result": any}\n
//                                                      (response to a request)
//
// Note the asymmetry: the host sends full key names, the device abbreviates.

import { rpcPayloadFromPacket } from "./framing.mjs";

/** Every RPC method name the Codex Micro firmware is known to speak. */
export const RpcMethod = Object.freeze({
  /** Query firmware version information. Params: null. */
  firmwareVersion: "sys.version",
  /** Set the six frosted agent-key LEDs. Params: array of agent-key lighting objects. */
  agentKeyStatus: "v.oai.thstatus",
  /** Configure whole-board lighting. Params: {keys?, ambient?} channel objects. */
  lightingConfig: "v.oai.rgbcfg",
  /** Device → host: key press/release/encoder events. */
  keyEvent: "v.oai.hid",
  /** Device → host: continuous joystick radial samples. */
  joystickSample: "v.oai.rad",
});

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Cycles request ids through 1-999 so requests stay short on the wire. */
export class RequestIdSequence {
  #nextValue = 1;

  next() {
    const value = this.#nextValue;
    this.#nextValue = value >= 999 ? 1 : value + 1;
    return value;
  }
}

/**
 * Encodes one request as newline-terminated JSON bytes. `params` defaults to
 * null; `id` must be a non-negative integer (use RequestIdSequence).
 */
export function encodeRpcRequest({ method, params = null, id }) {
  if (typeof method !== "string" || method.length === 0) {
    throw new TypeError("encodeRpcRequest requires a non-empty method name.");
  }
  if (!Number.isInteger(id) || id < 0) {
    throw new TypeError("encodeRpcRequest requires a non-negative integer id.");
  }
  return utf8Encoder.encode(`${JSON.stringify({ method, params, id })}\n`);
}

/**
 * Classifies one complete message line from the device.
 *
 * Returns one of:
 *   {type: "event", method, params, raw}   spontaneous device event ("m"/"p")
 *   {type: "response", id, result, raw}    reply to a request this host sent
 *   {type: "unknown", raw}                 valid JSON of an unrecognized shape
 *   {type: "invalid", text}                not valid JSON
 */
export function parseRpcMessage(messageText) {
  let parsed;
  try {
    parsed = JSON.parse(messageText);
  } catch {
    return { type: "invalid", text: messageText };
  }
  if (parsed && typeof parsed.m === "string") {
    return { type: "event", method: parsed.m, params: parsed.p, raw: parsed };
  }
  if (parsed && Number.isInteger(parsed.id)) {
    return { type: "response", id: parsed.id, result: parsed.result, raw: parsed };
  }
  return { type: "unknown", raw: parsed };
}

/**
 * Incremental decoder for the device → host stream. Feed it raw HID reports
 * (or already-deframed payload bytes / text); it buffers partial lines across
 * packets and returns every complete message as a parseRpcMessage() result.
 */
export class RpcMessageStream {
  #pendingText = "";

  /** Feed one raw 64-byte HID report. Non-RPC reports are ignored. */
  pushHidPacket(packetBytes) {
    const payload = rpcPayloadFromPacket(packetBytes);
    if (!payload) return [];
    return this.pushPayload(payload);
  }

  /** Feed deframed payload bytes (a chunk of the UTF-8 message stream). */
  pushPayload(payloadBytes) {
    return this.pushText(utf8Decoder.decode(payloadBytes, { stream: true }));
  }

  /** Feed decoded text directly. */
  pushText(text) {
    this.#pendingText += text;
    const lines = this.#pendingText.split(/\r?\n/);
    this.#pendingText = lines.pop() ?? "";
    return lines.filter((line) => line.length > 0).map(parseRpcMessage);
  }

  /** Text received after the last complete message (useful for diagnostics). */
  get pendingText() {
    return this.#pendingText;
  }
}
