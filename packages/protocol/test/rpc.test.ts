import { describe, expect, test } from "bun:test";
import {
  RequestIdSequence,
  RpcMessageStream,
  RpcMethod,
  encodeHidPackets,
  encodeRpcRequest,
  parseRpcMessage,
} from "../src/index";

describe("encodeRpcRequest", () => {
  test("emits newline-terminated JSON with method, params, id", () => {
    const encoded = encodeRpcRequest({ method: RpcMethod.firmwareVersion, id: 7 });
    const text = new TextDecoder().decode(encoded);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ method: "sys.version", params: null, id: 7 });
  });

  test("rejects missing method and invalid ids", () => {
    expect(() => encodeRpcRequest({ method: "", id: 1 })).toThrow(TypeError);
    expect(() => encodeRpcRequest({ method: "sys.version", id: 1.5 })).toThrow(TypeError);
    expect(() => encodeRpcRequest({ method: "sys.version", id: -1 })).toThrow(TypeError);
  });
});

describe("RequestIdSequence", () => {
  test("wraps from 999 back to 1", () => {
    const sequence = new RequestIdSequence();
    let lastId = 0;
    for (let step = 0; step < 998; step += 1) lastId = sequence.next();
    expect(lastId).toBe(998);
    expect(sequence.next()).toBe(999);
    expect(sequence.next()).toBe(1);
  });
});

describe("parseRpcMessage", () => {
  test("classifies device events, responses, unknown, and invalid lines", () => {
    expect(parseRpcMessage(`{"m":"v.oai.hid","p":{"k":"AG00","act":1}}`)).toMatchObject({
      type: "event",
      method: "v.oai.hid",
      params: { k: "AG00", act: 1 },
    });
    // Response shape as observed from firmware v0.4.1.
    expect(parseRpcMessage(`{"result":{"version":"v0.4.1"},"id":901,"method":"sys.version"}`)).toMatchObject({
      type: "response",
      id: 901,
      result: { version: "v0.4.1" },
    });
    expect(parseRpcMessage(`{"unexpected":true}`)).toMatchObject({ type: "unknown" });
    expect(parseRpcMessage("not json")).toMatchObject({ type: "invalid", text: "not json" });
  });
});

describe("RpcMessageStream", () => {
  test("reassembles messages split across HID packets", () => {
    const longParams = { k: "ACT06", act: 1, padding: "x".repeat(100) };
    const wireBytes = new TextEncoder().encode(`${JSON.stringify({ m: "v.oai.hid", p: longParams })}\n`);
    const packets = encodeHidPackets(wireBytes);
    expect(packets.length).toBeGreaterThan(1);

    const stream = new RpcMessageStream();
    const earlyMessages = packets.slice(0, -1).flatMap((packet) => stream.pushHidPacket(packet));
    expect(earlyMessages).toEqual([]);
    const finalMessages = stream.pushHidPacket(packets.at(-1)!);
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]).toMatchObject({ type: "event", method: "v.oai.hid" });
    expect(stream.pendingText).toBe("");
  });

  test("handles multiple messages in one packet and CRLF line endings", () => {
    const stream = new RpcMessageStream();
    const messages = stream.pushText(`{"id":1}\r\n{"id":2}\n{"m":"v.oai.rad","p":{"a":0.5,"d":1}}\n`);
    expect(messages.map((message) => message.type)).toEqual(["response", "response", "event"]);
  });

  test("ignores non-RPC packets entirely", () => {
    const stream = new RpcMessageStream();
    expect(stream.pushHidPacket(new Uint8Array([6, 1, 3, 65, 66, 67]))).toEqual([]);
    expect(stream.pendingText).toBe("");
  });

  test("keeps a partial line buffered and reports it as pendingText", () => {
    const stream = new RpcMessageStream();
    expect(stream.pushText(`{"id":`)).toEqual([]);
    expect(stream.pendingText).toBe(`{"id":`);
    expect(stream.pushText(`3}\n`)).toMatchObject([{ type: "response", id: 3 }]);
  });
});
