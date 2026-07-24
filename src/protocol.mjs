export const WORK_LOUDER_VENDOR_ID = 0x303a;
export const CODEX_MICRO_PRODUCT_ID = 0x8360;
export const VENDOR_USAGE_PAGE = 0xff00;

export const Effect = Object.freeze({
  off: 0,
  solid: 1,
  snake: 2,
  rainbow: 3,
  breath: 4,
  gradient: 5,
  shallowBreath: 6,
});

export const Status = Object.freeze({
  idle: { color: 0xffffff, brightness: 0.35, effect: Effect.solid, speed: 0 },
  working: { color: 0x3b82f6, brightness: 1, effect: Effect.shallowBreath, speed: 0.45 },
  waiting: { color: 0xf59e0b, brightness: 1, effect: Effect.shallowBreath, speed: 0.35 },
  complete: { color: 0x22c55e, brightness: 1, effect: Effect.solid, speed: 0 },
  error: { color: 0xef4444, brightness: 1, effect: Effect.breath, speed: 0.5 },
});

export function threadLighting(id, state, { syncKeysLighting, syncAmbientLighting } = {}) {
  const style = Status[state] ?? Status.idle;
  const thread = {
    id,
    c: style.color,
    b: style.brightness,
    e: style.effect,
    s: style.speed,
  };
  if (syncKeysLighting !== undefined) thread.sk = syncKeysLighting ? 1 : 0;
  if (syncAmbientLighting !== undefined) thread.sa = syncAmbientLighting ? 1 : 0;
  return thread;
}

export function encodeRpc(method, params, id) {
  // The firmware's RPC parser only dispatches complete newline-delimited
  // messages. Without this terminator it retains the JSON in its input buffer.
  return Buffer.from(`${JSON.stringify({ method, params, id })}\n`, "utf8");
}

export function encodeHidPackets(message) {
  const packets = [];
  for (let offset = 0; offset < message.length; offset += 61) {
    const chunk = message.subarray(offset, offset + 61);
    const packet = Buffer.alloc(64);
    packet[0] = 6; // Report ID used by the vendor-specific HID interface.
    packet[1] = 2; // Work Louder RPC channel.
    packet[2] = chunk.length;
    chunk.copy(packet, 3);
    packets.push(packet);
  }
  return packets;
}
