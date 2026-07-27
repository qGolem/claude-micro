import { describe, expect, test } from "bun:test";
import {
  HID_PACKET_LENGTH,
  HID_PACKET_PAYLOAD_CAPACITY,
  HID_REPORT_ID,
  RPC_CHANNEL,
  decodeHidPacket,
  encodeHidPackets,
  rpcPayloadFromPacket,
} from "../src/index.js";

describe("encodeHidPackets", () => {
  test("frames a short message into one 64-byte packet", () => {
    const message = new TextEncoder().encode("hello\n");
    const packets = encodeHidPackets(message);
    expect(packets).toHaveLength(1);
    expect(packets[0]!.length).toBe(HID_PACKET_LENGTH);
    expect(packets[0]![0]).toBe(HID_REPORT_ID);
    expect(packets[0]![1]).toBe(RPC_CHANNEL);
    expect(packets[0]![2]).toBe(message.length);
  });

  test("splits long messages into 61-byte chunks", () => {
    const packets = encodeHidPackets(new Uint8Array(123));
    expect(packets.map((packet) => packet[2])).toEqual([61, 61, 1]);
  });

  test("produces no packets for an empty message", () => {
    expect(encodeHidPackets(new Uint8Array(0))).toEqual([]);
  });

  test("rejects non-Uint8Array input", () => {
    // @ts-expect-error deliberately violating the signature to test the runtime guard
    expect(() => encodeHidPackets("text")).toThrow(TypeError);
  });

  test("round-trips through decodeHidPacket", () => {
    const message = new TextEncoder().encode(`{"method":"sys.version","params":null,"id":1}\n`.repeat(3));
    const reassembled = encodeHidPackets(message).flatMap((packet) => [...decodeHidPacket(packet)!.payload]);
    expect(new Uint8Array(reassembled)).toEqual(message);
  });
});

describe("decodeHidPacket", () => {
  test("rejects reports shorter than the header", () => {
    expect(decodeHidPacket(new Uint8Array([HID_REPORT_ID, RPC_CHANNEL]))).toBeNull();
  });

  test("clamps a lying length byte to the available bytes", () => {
    const packet = new Uint8Array([HID_REPORT_ID, RPC_CHANNEL, 200, 65, 66]);
    expect(decodeHidPacket(packet)!.payload).toEqual(new Uint8Array([65, 66]));
  });

  test("payload capacity constant matches the framing", () => {
    expect(HID_PACKET_PAYLOAD_CAPACITY).toBe(61);
  });
});

describe("rpcPayloadFromPacket", () => {
  test("returns null for other report IDs, other channels, and empty payloads", () => {
    expect(rpcPayloadFromPacket(new Uint8Array([5, RPC_CHANNEL, 2, 65, 66]))).toBeNull();
    expect(rpcPayloadFromPacket(new Uint8Array([HID_REPORT_ID, 1, 2, 65, 66]))).toBeNull();
    expect(rpcPayloadFromPacket(new Uint8Array([HID_REPORT_ID, RPC_CHANNEL, 0, 0]))).toBeNull();
  });

  test("returns the payload view for RPC packets", () => {
    const payload = rpcPayloadFromPacket(new Uint8Array([HID_REPORT_ID, RPC_CHANNEL, 2, 65, 66, 0]));
    expect([...payload!]).toEqual([65, 66]);
  });
});
