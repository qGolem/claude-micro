import assert from "node:assert/strict";
import test from "node:test";
import { Effect, encodeHidPackets, encodeRpc, threadLighting } from "../src/protocol.mjs";
import { SessionSlots, stateForHook } from "../src/state.mjs";

test("encodes a Work Louder RPC HID report", () => {
  const payload = encodeRpc("v.oai.thstatus", [threadLighting(2, "working")], 7);
  const packets = encodeHidPackets(payload);
  assert.equal(packets[0].length, 64);
  assert.equal(packets[0][0], 6);
  assert.equal(packets[0][1], 2);
  const message = Buffer.concat(packets.map((packet) => packet.subarray(3, 3 + packet[2])));
  assert.equal(message.at(-1), 10);
  const reconstructed = Buffer.concat(packets.map((packet) => packet.subarray(3, 3 + packet[2])));
  assert.equal(reconstructed.toString(), payload.toString());
});

test("splits long JSON RPC payloads into 61-byte HID chunks", () => {
  const packets = encodeHidPackets(Buffer.alloc(123));
  assert.deepEqual(packets.map((packet) => packet[2]), [61, 61, 1]);
});

test("maps Claude Code lifecycle events to status colors", () => {
  assert.equal(stateForHook({ hook_event_name: "PreToolUse" }), "working");
  assert.equal(stateForHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }), "waiting");
  assert.equal(stateForHook({ hook_event_name: "PermissionRequest" }), "waiting");
  assert.equal(stateForHook({ hook_event_name: "Stop" }), "complete");
  assert.equal(stateForHook({ hook_event_name: "Notification", message: "failed" }), "error");
  assert.equal(threadLighting(0, "working").e, Effect.shallowBreath);
});

test("assigns stable slots and reuses released ones", () => {
  const slots = new SessionSlots();
  assert.equal(slots.acquire("one"), 0);
  assert.equal(slots.acquire("two"), 1);
  assert.equal(slots.acquire("one"), 0);
  slots.release("one");
  assert.equal(slots.acquire("three"), 0);
});

test("restores valid session slots after a bridge restart", () => {
  const slots = new SessionSlots([
    { sessionId: "alpha", slot: 2 },
    { sessionId: "beta", slot: 5 },
    { sessionId: "duplicate", slot: 5 },
    { sessionId: "bad", slot: 9 },
  ]);
  assert.equal(slots.acquire("alpha"), 2);
  assert.equal(slots.acquire("beta"), 5);
  assert.equal(slots.acquire("gamma"), 0);
  assert.deepEqual(slots.entries(), [
    { sessionId: "alpha", slot: 2 },
    { sessionId: "beta", slot: 5 },
    { sessionId: "gamma", slot: 0 },
  ]);
});
