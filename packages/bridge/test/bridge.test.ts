import assert from "node:assert/strict";
import test from "node:test";
import { LightingEffect } from "codex-micro-protocol";
import { SessionSlots, stateForHook } from "../src/state";
import { AGENT_STATE_STYLES, agentKeyLightingForState } from "../src/status-lighting";

test("maps Claude Code lifecycle events to status colors", () => {
  assert.equal(stateForHook({ hook_event_name: "PreToolUse" }), "working");
  assert.equal(stateForHook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }), "waiting");
  assert.equal(stateForHook({ hook_event_name: "PermissionRequest" }), "waiting");
  assert.equal(stateForHook({ hook_event_name: "Stop" }), "complete");
  assert.equal(stateForHook({ hook_event_name: "Notification", message: "failed" }), "error");
});

test("builds valid wire lighting for every session state", () => {
  for (const stateName of Object.keys(AGENT_STATE_STYLES)) {
    const wireEntry = agentKeyLightingForState(1, stateName);
    assert.equal(wireEntry.id, 1);
    assert.ok(Number.isInteger(wireEntry.c));
    assert.ok(Object.values(LightingEffect).includes(wireEntry.e as 0 | 1 | 2 | 3 | 4 | 5 | 6));
  }
  assert.equal(agentKeyLightingForState(0, "working").e, LightingEffect.shallowBreath);
});

test("unknown session states fall back to idle lighting", () => {
  assert.deepEqual(agentKeyLightingForState(2, "not-a-state"), agentKeyLightingForState(2, "idle"));
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
  const now = 1_000_000;
  const slots = new SessionSlots(
    [
      { sessionId: "alpha", slot: 2, lastSeenAt: now },
      { sessionId: "beta", slot: 5, lastSeenAt: now },
      { sessionId: "duplicate", slot: 5, lastSeenAt: now },
      { sessionId: "bad", slot: 9, lastSeenAt: now },
    ],
    { now: () => now },
  );
  assert.equal(slots.acquire("alpha"), 2);
  assert.equal(slots.acquire("beta"), 5);
  assert.equal(slots.acquire("gamma"), 0);
  assert.deepEqual(
    slots.entries().map(({ sessionId, slot }) => ({ sessionId, slot })),
    [
      { sessionId: "alpha", slot: 2 },
      { sessionId: "beta", slot: 5 },
      { sessionId: "gamma", slot: 0 },
    ],
  );
});

test("a live session evicts an abandoned one instead of wedging the bridge", () => {
  // A session killed without its SessionEnd hook (SIGKILL, closed terminal, or
  // a bridge that was down) used to hold its key forever, across restarts.
  let clock = 0;
  const slots = new SessionSlots([], { staleAfterMs: 1_000, now: () => clock });
  for (let index = 0; index < 6; index += 1) slots.acquire(`dead-${index}`);
  assert.throws(() => slots.acquire("fresh"), /recently active/);

  clock += 5_000;
  assert.equal(slots.acquire("fresh"), 0, "the stalest assignment is reused");
  assert.equal(slots.entries().length, 6);
  assert.ok(!slots.entries().some((entry) => entry.sessionId === "dead-0"), "the evicted session is gone");
});

test("an active session is never evicted by a newcomer", () => {
  let clock = 0;
  const slots = new SessionSlots([], { staleAfterMs: 1_000, now: () => clock });
  for (let index = 0; index < 6; index += 1) slots.acquire(`live-${index}`);
  clock += 5_000;
  // Every holder just checked in, so none is stale.
  for (let index = 0; index < 6; index += 1) slots.acquire(`live-${index}`);
  assert.throws(() => slots.acquire("newcomer"), /recently active/);
});

test("slot records restored without a timestamp are treated as evictable", () => {
  // State files written by older versions carry no updatedAt; they must not be
  // able to wedge the bridge permanently.
  let clock = 10_000;
  const slots = new SessionSlots(
    Array.from({ length: 6 }, (_unused, index) => ({ sessionId: `legacy-${index}`, slot: index })),
    { staleAfterMs: 1_000, now: () => clock },
  );
  assert.equal(slots.acquire("fresh"), 0);
});
