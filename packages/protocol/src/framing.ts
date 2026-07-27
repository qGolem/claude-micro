// HID transport framing. Every report is a fixed 64-byte packet:
//
//   byte 0   report ID (always 6 on the vendor interface)
//   byte 1   channel   (2 = Work Louder RPC; other channels are reserved)
//   byte 2   payload length (0-61)
//   byte 3+  payload bytes
//
// RPC messages longer than one packet's payload capacity are split across
// consecutive packets and reassembled by concatenating payloads in order.

export const HID_REPORT_ID = 6;
export const RPC_CHANNEL = 2;
export const HID_PACKET_LENGTH = 64;
export const HID_PACKET_HEADER_LENGTH = 3;
export const HID_PACKET_PAYLOAD_CAPACITY = HID_PACKET_LENGTH - HID_PACKET_HEADER_LENGTH;

export interface DecodedHidPacket {
  reportId: number;
  channel: number;
  /** A view into the input packet, not a copy. */
  payload: Uint8Array;
}

/**
 * Splits an encoded message into 64-byte HID packets ready to write to the
 * device. Accepts any Uint8Array (including Node Buffers).
 */
export function encodeHidPackets(messageBytes: Uint8Array): Uint8Array[] {
  if (!(messageBytes instanceof Uint8Array)) {
    throw new TypeError("encodeHidPackets expects the message as a Uint8Array.");
  }
  const packets: Uint8Array[] = [];
  for (let messageOffset = 0; messageOffset < messageBytes.length; messageOffset += HID_PACKET_PAYLOAD_CAPACITY) {
    const chunk = messageBytes.subarray(messageOffset, messageOffset + HID_PACKET_PAYLOAD_CAPACITY);
    const packet = new Uint8Array(HID_PACKET_LENGTH);
    packet[0] = HID_REPORT_ID;
    packet[1] = RPC_CHANNEL;
    packet[2] = chunk.length;
    packet.set(chunk, HID_PACKET_HEADER_LENGTH);
    packets.push(packet);
  }
  return packets;
}

/**
 * Decodes one received HID report into its header fields and payload view.
 * Returns null for reports too short to carry the framing header.
 */
export function decodeHidPacket(packetBytes: Uint8Array): DecodedHidPacket | null {
  if (!(packetBytes instanceof Uint8Array) || packetBytes.length < HID_PACKET_HEADER_LENGTH) return null;
  const declaredLength = packetBytes[2];
  const availableLength = packetBytes.length - HID_PACKET_HEADER_LENGTH;
  return {
    reportId: packetBytes[0],
    channel: packetBytes[1],
    payload: packetBytes.subarray(
      HID_PACKET_HEADER_LENGTH,
      HID_PACKET_HEADER_LENGTH + Math.min(declaredLength, availableLength),
    ),
  };
}

/**
 * Convenience: the RPC payload of a received report, or null when the report
 * is not an RPC packet or carries no payload.
 */
export function rpcPayloadFromPacket(packetBytes: Uint8Array): Uint8Array | null {
  const decoded = decodeHidPacket(packetBytes);
  if (!decoded || decoded.channel !== RPC_CHANNEL || decoded.payload.length === 0) return null;
  return decoded.payload;
}
