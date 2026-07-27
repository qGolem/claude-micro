import assert from "node:assert/strict";
import test from "node:test";
import { LightingEffect } from "codex-micro-protocol";
import { SessionSlots, stateForHook } from "../src/state.mjs";
import { AGENT_STATE_STYLES, agentKeyLightingForState } from "../src/status-lighting.mjs";

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
    assert.ok(Object.values(LightingEffect).includes(wireEntry.e));
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
