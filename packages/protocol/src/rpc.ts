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

import { rpcPayloadFromPacket } from "./framing.js";
import { isJsonObject } from "./json.js";

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
} as const);

export type RpcMethodName = (typeof RpcMethod)[keyof typeof RpcMethod];

/**
 * Known method names autocomplete; unknown firmware methods remain valid.
 * (`string & {}` keeps the literals visible to the language service.)
 */
export type RpcMethodInput = RpcMethodName | (string & {});

export interface RpcRequest {
  method: RpcMethodInput;
  params?: unknown;
  id: number;
}

/** A spontaneous device event ("m"/"p" wire shape). */
export interface RpcEventMessage {
  type: "event";
  method: RpcMethodInput;
  params: unknown;
  raw: Record<string, unknown>;
}

/** A reply to a request this host sent. */
export interface RpcResponseMessage {
  type: "response";
  id: number;
  result: unknown;
  /** Echoed by the firmware on observed versions; absent on some replies. */
  method?: string;
  raw: Record<string, unknown>;
}

/** Valid JSON of an unrecognized shape. */
export interface RpcUnknownMessage {
  type: "unknown";
  raw: unknown;
}

/** A line that was not valid JSON. */
export interface RpcInvalidMessage {
  type: "invalid";
  text: string;
}

export type RpcMessage = RpcEventMessage | RpcResponseMessage | RpcUnknownMessage | RpcInvalidMessage;

const utf8Encoder = new TextEncoder();

/** Cycles request ids through 1-999 so requests stay short on the wire. */
export class RequestIdSequence {
  #nextValue = 1;

  next(): number {
    const value = this.#nextValue;
    this.#nextValue = value >= 999 ? 1 : value + 1;
    return value;
  }
}

/**
 * Encodes one request as newline-terminated JSON bytes. `params` defaults to
 * null; `id` must be a non-negative integer. RequestIdSequence issues 1-999;
 * the encoder additionally accepts 0 for callers managing ids themselves.
 */
export function encodeRpcRequest({ method, params = null, id }: RpcRequest): Uint8Array {
  if (typeof method !== "string" || method.length === 0) {
    throw new TypeError("encodeRpcRequest requires a non-empty method name.");
  }
  if (!Number.isInteger(id) || id < 0) {
    throw new TypeError("encodeRpcRequest requires a non-negative integer id.");
  }
  return utf8Encoder.encode(`${JSON.stringify({ method, params, id })}\n`);
}

/**
 * Classifies one complete message line from the device. See the RpcMessage
 * union for the possible results.
 */
export function parseRpcMessage(messageText: string): RpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(messageText);
  } catch {
    return { type: "invalid", text: messageText };
  }
  if (isJsonObject(parsed) && typeof parsed.m === "string") {
    return { type: "event", method: parsed.m, params: parsed.p, raw: parsed };
  }
  if (isJsonObject(parsed) && Number.isInteger(parsed.id)) {
    const response: RpcResponseMessage = { type: "response", id: parsed.id as number, result: parsed.result, raw: parsed };
    if (typeof parsed.method === "string") response.method = parsed.method;
    return response;
  }
  return { type: "unknown", raw: parsed };
}

/**
 * The device stream is untrusted input: a peer that never sends a newline
 * must not grow host memory without bound. Real messages are well under 1 KB;
 * anything past this cap is surfaced as one invalid message and dropped.
 *
 * Measured in UTF-16 code units (JavaScript string length), not bytes — a
 * non-ASCII stream can therefore hold up to ~4 bytes per unit.
 */
export const MAX_PENDING_MESSAGE_LENGTH = 65_536;

/**
 * Incremental decoder for the device → host stream. Feed it raw HID reports
 * (or already-deframed payload bytes / text); it buffers partial lines across
 * packets and returns every complete message as a parseRpcMessage() result.
 */
export class RpcMessageStream {
  #pendingText = "";
  // Streaming decode holds partial multi-byte sequences between pushes, so
  // the decoder must be per-instance state, never shared.
  #utf8Decoder = new TextDecoder();

  /** Feed one raw 64-byte HID report. Non-RPC reports are ignored. */
  pushHidPacket(packetBytes: Uint8Array): RpcMessage[] {
    const payload = rpcPayloadFromPacket(packetBytes);
    if (!payload) return [];
    return this.pushPayload(payload);
  }

  /** Feed deframed payload bytes (a chunk of the UTF-8 message stream). */
  pushPayload(payloadBytes: Uint8Array): RpcMessage[] {
    return this.pushText(this.#utf8Decoder.decode(payloadBytes, { stream: true }));
  }

  /** Feed decoded text directly. */
  pushText(text: string): RpcMessage[] {
    this.#pendingText += text;
    const lines = this.#pendingText.split(/\r?\n/);
    this.#pendingText = lines.pop() ?? "";
    const messages = lines.filter((line) => line.length > 0).map(parseRpcMessage);
    if (this.#pendingText.length > MAX_PENDING_MESSAGE_LENGTH) {
      messages.push({ type: "invalid", text: this.#pendingText.slice(0, 1_024) });
      this.#pendingText = "";
    }
    return messages;
  }

  /** Text received after the last complete message (useful for diagnostics). */
  get pendingText(): string {
    return this.#pendingText;
  }

  /**
   * Discards buffered text and partial UTF-8 state. Call after a device
   * disconnect/reconnect — the buffer is connection state.
   */
  reset(): void {
    this.#pendingText = "";
    this.#utf8Decoder = new TextDecoder();
  }
}
