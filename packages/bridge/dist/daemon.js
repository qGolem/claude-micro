import {
  AGENT_KEY_COUNT,
  CodexMicro,
  ENCODER_KEY_NAMES,
  JoystickFlickDetector,
  LightingEffect,
  RpcMessageStream,
  RpcMethod,
  assertAgentKeyIndex,
  encodeAgentKeyLighting,
  parseDeviceEvent,
  rpcPayloadFromPacket
} from "./chunk-ZKFY4ZTV.js";

// src/daemon.ts
import fs from "fs";
import net from "net";
import path from "path";
import { execFile } from "child_process";

// src/state.ts
var HOOK_STATE = Object.freeze({
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "complete",
  SubagentStop: "complete",
  PermissionRequest: "waiting",
  SessionEnd: "idle"
});
function stateForHook(event) {
  const name = event.hook_event_name ?? event.event ?? event.type;
  if (name === "PreToolUse" && event.tool_name === "AskUserQuestion") return "waiting";
  if (name === "Notification") {
    const text = JSON.stringify(event).toLowerCase();
    return text.includes("error") || text.includes("failed") ? "error" : "waiting";
  }
  return typeof name === "string" ? HOOK_STATE[name] ?? null : null;
}
var SLOT_COUNT = 6;
var SessionSlots = class {
  #slots = /* @__PURE__ */ new Map();
  #staleAfterMs;
  #now;
  constructor(entries = [], { staleAfterMs = 12 * 60 * 60 * 1e3, now = Date.now } = {}) {
    this.#staleAfterMs = staleAfterMs;
    this.#now = now;
    const takenSlots = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      const { sessionId, slot, lastSeenAt } = entry ?? {};
      if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) continue;
      if (typeof sessionId !== "string") continue;
      if (this.#slots.has(sessionId) || takenSlots.has(slot)) continue;
      const seenAt = typeof lastSeenAt === "number" && Number.isFinite(lastSeenAt) ? lastSeenAt : 0;
      this.#slots.set(sessionId, { sessionId, slot, lastSeenAt: seenAt });
      takenSlots.add(slot);
    }
  }
  /**
   * Returns this session's slot, assigning a free one if needed. When all six
   * are held, the stalest assignment past staleAfterMs is evicted rather than
   * failing — a live session always outranks an abandoned one.
   */
  acquire(sessionId) {
    const now = this.#now();
    const existing = this.#slots.get(sessionId);
    if (existing) {
      existing.lastSeenAt = now;
      return existing.slot;
    }
    const used = new Set(Array.from(this.#slots.values(), (assignment) => assignment.slot));
    const freeSlot = Array.from({ length: SLOT_COUNT }, (_unused, index) => index).find((index) => !used.has(index));
    if (freeSlot !== void 0) {
      this.#slots.set(sessionId, { sessionId, slot: freeSlot, lastSeenAt: now });
      return freeSlot;
    }
    const stalest = Array.from(this.#slots.values()).sort((left, right) => left.lastSeenAt - right.lastSeenAt)[0];
    if (!stalest || now - stalest.lastSeenAt < this.#staleAfterMs) {
      throw new Error("All six Codex Micro agent slots are in use by recently active sessions.");
    }
    this.#slots.delete(stalest.sessionId);
    this.#slots.set(sessionId, { sessionId, slot: stalest.slot, lastSeenAt: now });
    return stalest.slot;
  }
  release(sessionId) {
    this.#slots.delete(sessionId);
  }
  /** Epoch ms of the last hook seen for whoever holds this slot, if anyone. */
  lastSeenAt(slot) {
    for (const assignment of this.#slots.values()) {
      if (assignment.slot === slot) return assignment.lastSeenAt;
    }
    return null;
  }
  entries() {
    return Array.from(this.#slots.values(), (assignment) => ({ ...assignment }));
  }
};

// src/status-lighting.ts
var AGENT_STATE_STYLES = Object.freeze({
  idle: { color: 16777215, brightness: 0.35, effect: LightingEffect.solid, speed: 0 },
  working: { color: 3900150, brightness: 1, effect: LightingEffect.shallowBreath, speed: 0.45 },
  waiting: { color: 16096779, brightness: 1, effect: LightingEffect.shallowBreath, speed: 0.35 },
  complete: { color: 2278750, brightness: 1, effect: LightingEffect.solid, speed: 0 },
  error: { color: 15680580, brightness: 1, effect: LightingEffect.breath, speed: 0.5 }
});
function agentKeyLightingForState(agentKeyIndex, stateName, syncOptions = {}) {
  assertAgentKeyIndex(agentKeyIndex);
  const style = AGENT_STATE_STYLES[stateName] ?? AGENT_STATE_STYLES.idle;
  return encodeAgentKeyLighting({ agentKeyIndex, ...style, ...syncOptions });
}

// src/daemon.ts
var socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
var slotsPath = process.env.CLAUDE_MICRO_SLOTS ?? "/private/tmp/claude-micro-slots.json";
var healthPath = process.env.CLAUDE_MICRO_HEALTH ?? "/private/tmp/claude-micro-health.json";
var debugDir = process.env.CLAUDE_MICRO_DEBUG_DIR;
var latencyLogPath = process.env.CLAUDE_MICRO_LATENCY_LOG;
var maxHookBytes = Number(process.env.CLAUDE_MICRO_MAX_HOOK_BYTES ?? 262144);
var agentHoldMs = Number(process.env.CLAUDE_MICRO_AGENT_HOLD_MS ?? 3e3);
var deviceTimeoutMs = Number(process.env.CLAUDE_MICRO_DEVICE_TIMEOUT_MS ?? 2e3);
var maxDebugFileBytes = Number(process.env.CLAUDE_MICRO_MAX_DEBUG_BYTES ?? 64 * 1024 * 1024);
var slotStaleMs = Number(process.env.CLAUDE_MICRO_SLOT_STALE_MS ?? 12 * 60 * 60 * 1e3);
function removeSocket() {
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error(`Refusing to remove non-socket path: ${socketPath}`);
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function probeRunningBridge() {
  if (!fs.existsSync(socketPath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    let response = "";
    const finish = (result) => {
      clearTimeout(timer);
      client.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 750);
    client.once("connect", () => client.end(JSON.stringify({ op: "claude-micro.health" })));
    client.setEncoding("utf8");
    client.on("data", (chunk) => response += chunk);
    client.once("end", () => {
      try {
        const parsed = JSON.parse(response);
        finish(parsed?.ok === true ? parsed : null);
      } catch {
        finish(null);
      }
    });
    client.once("error", () => finish(null));
  });
}
var runningBridge = await probeRunningBridge();
if (runningBridge && process.env.CLAUDE_MICRO_REPLACE !== "1") {
  console.error(
    `Claude Micro: a bridge is already running (pid ${runningBridge.pid ?? "unknown"}) on ${socketPath}.
Stop it first (Prefix + k restarts the tmux-managed bridge), or set CLAUDE_MICRO_REPLACE=1 to take over.`
  );
  process.exit(1);
}
var debugFileBytes = /* @__PURE__ */ new Map();
function debugLog(name, value) {
  if (!debugDir) return;
  fs.mkdirSync(debugDir, { recursive: true, mode: 448 });
  const target = path.join(debugDir, name);
  let written = debugFileBytes.get(name);
  if (written === void 0) {
    try {
      written = fs.statSync(target).size;
    } catch {
      written = 0;
    }
  }
  if (written >= maxDebugFileBytes) return;
  fs.appendFileSync(target, value, { mode: 384 });
  const total = written + Buffer.byteLength(value);
  debugFileBytes.set(name, total);
  if (total >= maxDebugFileBytes) {
    console.error(`Claude Micro: ${name} reached ${maxDebugFileBytes} bytes; tracing to it has stopped.`);
  }
}
function writeFileAtomically(targetPath, contents) {
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temporaryPath, "wx", 384);
    fs.writeFileSync(handle, contents);
  } catch (error) {
    if (error.code === "EEXIST") {
      fs.rmSync(temporaryPath, { force: true });
      handle = fs.openSync(temporaryPath, "wx", 384);
      fs.writeFileSync(handle, contents);
    } else {
      throw error;
    }
  } finally {
    if (handle !== void 0) fs.closeSync(handle);
  }
  fs.renameSync(temporaryPath, targetPath);
}
function withDeviceTimeout(operation, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${deviceTimeoutMs}ms`)), deviceTimeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function latencyLog(entry) {
  if (!latencyLogPath) return;
  fs.appendFileSync(latencyLogPath, `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...entry })}
`, { mode: 384 });
}
removeSocket();
var healthState = null;
var healthWrittenAt = 0;
function writeHealth(state, force = false) {
  const now = Date.now();
  if (!force && state === healthState && now - healthWrittenAt < 1e3) return;
  healthState = state;
  healthWrittenAt = now;
  writeFileAtomically(healthPath, `${JSON.stringify({ state, updatedAt: new Date(now).toISOString(), pid: process.pid })}
`);
}
function restoredSlotState() {
  try {
    const stored = JSON.parse(fs.readFileSync(slotsPath, "utf8"));
    return Array.isArray(stored?.slots) ? stored.slots : [];
  } catch {
    return [];
  }
}
var storedSlots = restoredSlotState();
var slots = new SessionSlots(
  storedSlots.map((record) => ({ sessionId: record.sessionId, slot: record.id, lastSeenAt: record.updatedAt })),
  { staleAfterMs: slotStaleMs }
);
var agentStates = Array(AGENT_KEY_COUNT).fill("idle");
var agentPanes = Array(AGENT_KEY_COUNT).fill(null);
for (const record of storedSlots) {
  const slotIndex = record.id;
  if (typeof slotIndex !== "number" || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= AGENT_KEY_COUNT) continue;
  if (typeof record.sessionId !== "string") continue;
  agentStates[slotIndex] = typeof record.state === "string" ? record.state : "idle";
  agentPanes[slotIndex] = typeof record.tmuxPane === "string" ? record.tmuxPane : null;
}
writeHealth("starting", true);
var micro;
try {
  micro = await CodexMicro.connect();
  writeHealth("connected", true);
} catch (error) {
  writeHealth("disconnected", true);
  throw error;
}
var refreshing = false;
var reconnecting = false;
var sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function reconnectMicro() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    try {
      await withDeviceTimeout(micro.close(), "device close");
    } catch {
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        micro = await withDeviceTimeout(CodexMicro.connect(), "device connect");
        messageStream.reset();
        attachInput(micro);
        writeHealth("connected", true);
        console.log("Claude Micro reconnected.");
        return;
      } catch {
        await sleep(500);
      }
    }
    console.error("Claude Micro reconnect timed out.");
    writeHealth("reconnecting", true);
  } finally {
    reconnecting = false;
  }
}
function agentKeyLightingSnapshot() {
  return agentStates.map((state, agentKeyIndex) => agentKeyLightingForState(agentKeyIndex, state));
}
async function refreshAgentKeys() {
  if (refreshing) return;
  if (reconnecting) return;
  refreshing = true;
  try {
    await withDeviceTimeout(micro.sendRequest(RpcMethod.agentKeyStatus, agentKeyLightingSnapshot()), "agent-key refresh");
    writeHealth("connected");
  } catch (error) {
    console.error(`Claude Micro refresh failed: ${error.message}`);
    writeHealth("reconnecting", true);
    void reconnectMicro();
  } finally {
    refreshing = false;
  }
}
function writeSlots() {
  const sessionIds = new Map(slots.entries().map(({ sessionId, slot }) => [slot, sessionId]));
  const payload = {
    slots: agentStates.map((state, id) => ({
      id,
      state,
      tmuxPane: agentPanes[id],
      sessionId: sessionIds.get(id) ?? null,
      updatedAt: slots.lastSeenAt(id) ?? null
    }))
  };
  writeFileAtomically(slotsPath, `${JSON.stringify(payload)}
`);
}
await refreshAgentKeys();
var refreshTimer = setInterval(() => void refreshAgentKeys(), 75);
function run(command, args) {
  return new Promise((resolve) => execFile(command, args, (error, _stdout, stderr) => {
    if (error) debugLog("bridge.log", `${(/* @__PURE__ */ new Date()).toISOString()} ${command}: ${stderr || error.message}
`);
    resolve("");
  }));
}
function runOutput(command, args) {
  return new Promise((resolve) => execFile(command, args, (_error, stdout) => resolve(stdout.trim())));
}
async function focusITermTty(tty) {
  const script = `on run argv
  set wantedTTY to item 1 of argv
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is wantedTTY then
            select w
            select t
            select s
            activate
            return
          end if
        end repeat
      end repeat
    end repeat
  end tell
end run`;
  await run("osascript", ["-e", script, tty]);
}
async function focusAgentSlot(slot, receivedAt = performance.now()) {
  const pane = agentPanes[slot];
  if (!pane) return;
  await sleep(30);
  const afterNativeKey = performance.now();
  const session = await runOutput("tmux", ["display-message", "-p", "-t", pane, "#{session_name}"]);
  const clients = await runOutput("tmux", ["list-clients", "-F", "#{client_tty}	#{client_session}"]);
  const tty = clients.split("\n").map((line) => line.split("	")).find(([, clientSession]) => clientSession === session)?.[0];
  const iTermFocus = tty ? focusITermTty(tty) : null;
  const focusCommand = [];
  if (tty) focusCommand.push("switch-client", "-c", tty, "-t", session, ";");
  focusCommand.push("select-window", "-t", pane, ";", "select-pane", "-t", pane);
  await run("tmux", focusCommand);
  const afterTmux = performance.now();
  if (iTermFocus) await iTermFocus;
  const completeAt = performance.now();
  latencyLog({
    slot: slot + 1,
    pane,
    nativeDelayMs: Math.round(afterNativeKey - receivedAt),
    tmuxFocusMs: Math.round(afterTmux - afterNativeKey),
    iTermFocusMs: Math.round(completeAt - afterTmux),
    totalMs: Math.round(completeAt - receivedAt)
  });
}
var agentHoldTimers = /* @__PURE__ */ new Map();
function cancelAgentKeyHold(slot) {
  const timer = agentHoldTimers.get(slot);
  if (timer) clearTimeout(timer);
  agentHoldTimers.delete(slot);
}
async function clearAgentSlot(slot) {
  const assignment = slots.entries().find((entry) => entry.slot === slot);
  if (!assignment && agentStates[slot] === "idle" && !agentPanes[slot]) return;
  if (assignment) slots.release(assignment.sessionId);
  agentStates[slot] = "idle";
  agentPanes[slot] = null;
  writeSlots();
  await refreshAgentKeys();
  await run("tmux", ["display-message", `Claude Micro: cleared Agent Key ${slot + 1}.`]);
}
function beginAgentKeyPress(slot) {
  cancelAgentKeyHold(slot);
  void focusAgentSlot(slot, performance.now());
  agentHoldTimers.set(slot, setTimeout(() => {
    agentHoldTimers.delete(slot);
    void clearAgentSlot(slot);
  }, agentHoldMs));
}
async function activeTmuxPane() {
  const clients = await runOutput("tmux", ["list-clients", "-F", "#{client_activity}	#{client_session}"]);
  const session = clients.split("\n").map((line) => line.split("	")).filter(([activity, name]) => activity && name).sort(([left], [right]) => Number(right) - Number(left))[0]?.[1];
  if (!session) return null;
  const panes = await runOutput("tmux", ["list-panes", "-t", `${session}:`, "-F", "#{pane_id}	#{pane_active}"]);
  return panes.split("\n").map((line) => line.split("	")).find(([, active]) => active === "1")?.[0] ?? null;
}
async function sendToActivePane(key) {
  const pane = await activeTmuxPane();
  if (pane) await run("tmux", ["send-keys", "-t", pane, key]);
}
async function sendSequenceToActivePane(keys) {
  const pane = await activeTmuxPane();
  if (pane) await run("tmux", ["send-keys", "-t", pane, ...keys]);
}
async function invokeWhisperflow() {
  const script = `ObjC.import("CoreGraphics");
var down = $.CGEventCreateKeyboardEvent(null, 54, true);
$.CGEventPost($.kCGHIDEventTap, down);
var up = $.CGEventCreateKeyboardEvent(null, 54, false);
$.CGEventPost($.kCGHIDEventTap, up);`;
  await run("osascript", ["-l", "JavaScript", "-e", script]);
}
var commandKeyActions = Object.assign(/* @__PURE__ */ Object.create(null), {
  ACT06: () => sendToActivePane("C-s"),
  ACT07: () => sendToActivePane("C-w"),
  ACT08: () => sendSequenceToActivePane(["d", "a", "w"]),
  ACT09: () => sendToActivePane("Enter"),
  ACT10: () => sendToActivePane("Escape"),
  ACT11: invokeWhisperflow,
  ACT12: () => sendToActivePane("C-c")
});
var encoderActions = Object.assign(/* @__PURE__ */ Object.create(null), {
  [ENCODER_KEY_NAMES.clockwise]: () => sendToActivePane("Left"),
  [ENCODER_KEY_NAMES.counterClockwise]: () => sendToActivePane("Right")
});
function keyAction(table, keyName) {
  const action = Object.hasOwn(table, keyName) ? table[keyName] : void 0;
  return typeof action === "function" ? action : null;
}
var tmuxKeyByJoystickDirection = {
  right: "Right",
  down: "Down",
  left: "Left",
  up: "Up"
};
var joystickFlickDetector = new JoystickFlickDetector({ triggerDistance: 0.8, rearmDistance: 0.2 });
var utf8Decoder = new TextDecoder();
var messageStream = new RpcMessageStream();
function handleDeviceMessage(message) {
  const deviceEvent = parseDeviceEvent(message);
  if (!deviceEvent || deviceEvent.kind === "unrecognized") return;
  if (deviceEvent.kind === "keyEvent") {
    const { keyName, action, agentKeyIndex } = deviceEvent;
    if (action === "press" && message.type === "event") debugLog("hid-keys.log", `${JSON.stringify(message.raw)}
`);
    if (agentKeyIndex !== null && action === "press") beginAgentKeyPress(agentKeyIndex);
    if (agentKeyIndex !== null && action === "release") cancelAgentKeyHold(agentKeyIndex);
    if (action === "press") void keyAction(commandKeyActions, keyName)?.();
    if (action === "encoderTurn") void keyAction(encoderActions, keyName)?.();
    return;
  }
  const direction = joystickFlickDetector.update(deviceEvent);
  if (direction) void sendToActivePane(tmuxKeyByJoystickDirection[direction]);
}
function attachInput(handle) {
  handle.onInput((report) => {
    const reportBytes = new Uint8Array(report);
    if (debugDir) {
      const rpcPayload = rpcPayloadFromPacket(reportBytes);
      const payloadText = rpcPayload ? utf8Decoder.decode(rpcPayload) : "";
      if (!payloadText.includes(`"method":"${RpcMethod.agentKeyStatus}"`)) {
        debugLog("hid-raw.log", `${Date.now()} ${Buffer.from(reportBytes).toString("hex")}
`);
      }
    }
    for (const message of messageStream.pushHidPacket(reportBytes)) {
      try {
        handleDeviceMessage(message);
      } catch (error) {
        console.error(`Claude Micro: ignoring unhandled device message \u2014 ${error.message}`);
        debugLog("bridge.log", `${(/* @__PURE__ */ new Date()).toISOString()} device message failed: ${error.stack}
`);
      }
    }
  });
}
attachInput(micro);
var server = net.createServer({ allowHalfOpen: true }, (connection) => {
  let body = "";
  let oversized = false;
  connection.setEncoding("utf8");
  connection.setTimeout(3e3, () => connection.destroy());
  connection.on("error", () => {
  });
  connection.on("data", (chunk) => {
    if (oversized) return;
    body += chunk;
    if (body.length > maxHookBytes) {
      oversized = true;
      body = "";
      connection.end(JSON.stringify({ ok: false, error: "Hook payload exceeds the bridge limit." }));
    }
  });
  connection.on("end", async () => {
    if (oversized) return;
    try {
      const event = JSON.parse(body);
      if (event?.op === "claude-micro.health") {
        connection.end(JSON.stringify({ ok: true, state: healthState, pid: process.pid }));
        return;
      }
      const state = stateForHook(event);
      const sessionId = event.session_id ?? event.sessionId;
      if (!state || typeof sessionId !== "string" || !sessionId) {
        throw new Error("Hook event did not include a supported state and session_id.");
      }
      const slot = slots.acquire(sessionId);
      agentStates[slot] = state;
      if (typeof event.tmux_pane === "string" && event.tmux_pane) {
        agentPanes[slot] = event.tmux_pane;
      } else if (!agentPanes[slot]) {
        agentPanes[slot] = await activeTmuxPane();
      }
      await refreshAgentKeys();
      if (event.hook_event_name === "SessionEnd") {
        cancelAgentKeyHold(slot);
        slots.release(sessionId);
        agentPanes[slot] = null;
      }
      writeSlots();
      connection.end(JSON.stringify({ ok: true, slot, state }));
    } catch (error) {
      connection.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
});
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 384);
  console.log(`Claude Micro bridge listening on ${socketPath}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    clearInterval(refreshTimer);
    try {
      await micro.sendRequest(
        RpcMethod.agentKeyStatus,
        agentStates.map((_state, agentKeyIndex) => agentKeyLightingForState(agentKeyIndex, "idle"))
      );
      await micro.close();
    } catch {
    }
    writeHealth("stopped", true);
    removeSocket();
    process.exit(0);
  });
}
