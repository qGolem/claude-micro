import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { CodexMicro } from "./micro.mjs";
import { SessionSlots, stateForHook } from "./state.mjs";

const socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
const slotsPath = process.env.CLAUDE_MICRO_SLOTS ?? "/private/tmp/claude-micro-slots.json";
const healthPath = process.env.CLAUDE_MICRO_HEALTH ?? "/private/tmp/claude-micro-health.json";
const debugDir = process.env.CLAUDE_MICRO_DEBUG_DIR;
const latencyLogPath = process.env.CLAUDE_MICRO_LATENCY_LOG;
const maxHookBytes = Number(process.env.CLAUDE_MICRO_MAX_HOOK_BYTES ?? 262_144);

function removeSocket() {
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error(`Refusing to remove non-socket path: ${socketPath}`);
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function debugLog(name, value) {
  if (!debugDir) return;
  fs.mkdirSync(debugDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(debugDir, name), value, { mode: 0o600 });
}

function latencyLog(entry) {
  if (!latencyLogPath) return;
  fs.appendFileSync(latencyLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

removeSocket();

let healthState = null;
let healthWrittenAt = 0;
function writeHealth(state, force = false) {
  const now = Date.now();
  if (!force && state === healthState && now - healthWrittenAt < 1_000) return;
  healthState = state;
  healthWrittenAt = now;
  const temporaryPath = `${healthPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ state, updatedAt: new Date(now).toISOString(), pid: process.pid })}\n`);
  fs.renameSync(temporaryPath, healthPath);
}

function restoredSlotState() {
  try {
    const stored = JSON.parse(fs.readFileSync(slotsPath, "utf8"));
    return Array.isArray(stored?.slots) ? stored.slots : [];
  } catch {
    return [];
  }
}

const storedSlots = restoredSlotState();
const slots = new SessionSlots(storedSlots.map(({ sessionId, id }) => ({ sessionId, slot: id })));
const agentStates = Array(6).fill("idle");
const agentPanes = Array(6).fill(null);
for (const record of storedSlots) {
  if (!Number.isInteger(record?.id) || record.id < 0 || record.id > 5 || typeof record?.sessionId !== "string") continue;
  agentStates[record.id] = typeof record.state === "string" ? record.state : "idle";
  agentPanes[record.id] = typeof record.tmuxPane === "string" ? record.tmuxPane : null;
}

writeHealth("starting", true);
let micro;
try {
  micro = await CodexMicro.connect();
  writeHealth("connected", true);
} catch (error) {
  writeHealth("disconnected", true);
  throw error;
}
let refreshing = false;
let reconnecting = false;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function reconnectMicro() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    try {
      await micro.close();
    } catch {
      // The old handle may already be invalid after a USB/HID reset.
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        micro = await CodexMicro.connect();
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

async function refreshAgentKeys() {
  if (refreshing) return;
  if (reconnecting) return;
  refreshing = true;
  try {
    // ChatGPT Codex can also publish an idle state. Refreshing only the
    // per-thread channel lets Claude own the Agent LEDs without changing the
    // Input layer or the frame/background RGB configuration.
    await micro.setThreadStates(agentStates);
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
  const payload = { slots: agentStates.map((state, id) => ({ id, state, tmuxPane: agentPanes[id], sessionId: sessionIds.get(id) ?? null })) };
  const temporaryPath = `${slotsPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload)}\n`, "utf8");
  fs.renameSync(temporaryPath, slotsPath);
}

await refreshAgentKeys();
const refreshTimer = setInterval(() => void refreshAgentKeys(), 75);

function run(command, args) {
  return new Promise((resolve) => execFile(command, args, (error, _stdout, stderr) => {
    if (error) debugLog("bridge.log", `${new Date().toISOString()} ${command}: ${stderr || error.message}\n`);
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
  // Codex handles the same native Agent-key event. Let that finish, then bring
  // the tmux/iTerm target forward so Layer 1 can be used for Claude navigation.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const afterNativeKey = performance.now();
  const session = await runOutput("tmux", ["display-message", "-p", "-t", pane, "#{session_name}"]);
  const clients = await runOutput("tmux", ["list-clients", "-F", "#{client_tty}\t#{client_session}"]);
  const tty = clients
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, clientSession]) => clientSession === session)?.[0];
  // Bringing the correct iTerm session forward is independent of selecting
  // its tmux pane. Start both operations together: invoking osascript costs
  // roughly 200 ms on macOS, so serializing it after tmux is perceptible.
  const iTermFocus = tty ? focusITermTty(tty) : null;
  // Send the focus sequence to tmux as one command rather than paying a
  // process launch and client/server round-trip for each selection.
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
    totalMs: Math.round(completeAt - receivedAt),
  });
}

async function activeTmuxPane() {
  const clients = await runOutput("tmux", ["list-clients", "-F", "#{client_activity}\t#{client_session}"]);
  const session = clients
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([activity, name]) => activity && name)
    .sort(([left], [right]) => Number(right) - Number(left))[0]?.[1];
  if (!session) return null;

  const panes = await runOutput("tmux", ["list-panes", "-t", `${session}:`, "-F", "#{pane_id}\t#{pane_active}"]);
  return panes
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, active]) => active === "1")?.[0] ?? null;
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
  // Right Command (key code 54) is distinct from Left Command (55), so it can
  // be reserved as Whisperflow's modifier-only trigger without changing normal
  // Command shortcuts. System Events does not reliably deliver a modifier-only
  // press, so post the actual keyboard down/up events through CoreGraphics.
  const script = `ObjC.import("CoreGraphics");
var down = $.CGEventCreateKeyboardEvent(null, 54, true);
$.CGEventPost($.kCGHIDEventTap, down);
var up = $.CGEventCreateKeyboardEvent(null, 54, false);
$.CGEventPost($.kCGHIDEventTap, up);`;
  await run("osascript", ["-l", "JavaScript", "-e", script]);
}

const commandKeyActions = {
  ACT06: () => sendToActivePane("C-s"),
  ACT07: () => sendToActivePane("C-w"),
  ACT08: () => sendSequenceToActivePane(["d", "a", "w"]),
  ACT09: () => sendToActivePane("Enter"),
  ACT10: () => sendToActivePane("Escape"),
  ACT11: invokeWhisperflow,
  ACT12: () => sendToActivePane("C-c"),
};

// Encoder turns use the same custom HID channel as key presses, but firmware
// labels the turn action as 2 rather than a normal press (1). On this unit,
// the physical left turn reports ENC_CW and the physical right turn ENC_CC.
const encoderActions = {
  ENC_CW: () => sendToActivePane("Left"),
  ENC_CC: () => sendToActivePane("Right"),
};

let joystickLatched = false;
function handleJoystickMove(position) {
  const angle = Number(position?.a);
  const distance = Number(position?.d);
  if (!Number.isFinite(angle) || !Number.isFinite(distance)) return;
  // The Micro reports a continuous radial stream. Send only once per full
  // flick, then re-arm after the stick returns near its center.
  if (distance < 0.2) {
    joystickLatched = false;
    return;
  }
  if (joystickLatched || distance < 0.8) return;
  joystickLatched = true;
  // 0 = right, .25 = down, .5 = left, .75 = up.
  const direction = ["Right", "Down", "Left", "Up"][Math.round((angle % 1) * 4) % 4];
  if (direction) void sendToActivePane(direction);
}

let hidBuffer = "";
function attachInput(handle) {
  handle.onInput((report) => {
  const data = Buffer.from(report);
  // Raw protocol traces are useful for discovering firmware controls, but are
  // deliberately opt-in so a normal bridge never accumulates device data.
  const payloadText = data[1] === 2 ? data.subarray(3, 3 + data[2]).toString("utf8") : "";
  if (!payloadText.includes('"method":"v.oai.thstatus"')) {
    debugLog("hid-raw.log", `${Date.now()} ${data.toString("hex")}\n`);
  }
  if (data[1] !== 2 || data[2] === 0) return;
  hidBuffer += data.subarray(3, 3 + data[2]).toString("utf8");
  const lines = hidBuffer.split(/\r?\n/);
  hidBuffer = lines.pop() ?? "";
  for (const line of lines) {
    try {
      const message = JSON.parse(line);
      const key = message?.m === "v.oai.hid" ? message.p?.k : null;
      if (message?.m === "v.oai.hid" && message?.p?.act === 1) {
        debugLog("hid-keys.log", `${JSON.stringify(message)}\n`);
      }
      if (message?.p?.act === 1 && /^AG0[0-5]$/.test(key ?? "")) void focusAgentSlot(Number(key.slice(2)), performance.now());
      if (message?.p?.act === 1 && commandKeyActions[key]) void commandKeyActions[key]();
      if (message?.p?.act === 2 && encoderActions[key]) void encoderActions[key]();
      if (message?.m === "v.oai.rad") handleJoystickMove(message.p);
    } catch {
      // Responses from normal lighting RPCs share this channel; ignore them.
    }
  }
  });
}
attachInput(micro);

const server = net.createServer({ allowHalfOpen: true }, (connection) => {
  let body = "";
  let oversized = false;
  connection.setEncoding("utf8");
  connection.setTimeout(3_000, () => connection.destroy());
  // A Claude hook may exit as soon as it has sent the event. Keep that normal
  // half-close from becoming an unhandled socket error in the bridge.
  connection.on("error", () => {});
  connection.on("data", (chunk) => {
    body += chunk;
    if (body.length > maxHookBytes) {
      oversized = true;
      connection.destroy();
    }
  });
  connection.on("end", async () => {
    try {
      if (oversized) throw new Error("Hook payload exceeds the bridge limit.");
      const event = JSON.parse(body);
      if (event?.op === "claude-micro.health") {
        connection.end(JSON.stringify({ ok: true, state: healthState, pid: process.pid }));
        return;
      }
      const state = stateForHook(event);
      const sessionId = event.session_id ?? event.sessionId;
      if (!state || !sessionId) throw new Error("Hook event did not include a supported state and session_id.");
      const slot = slots.acquire(sessionId);
      agentStates[slot] = state;
      if (event.tmux_pane) {
        agentPanes[slot] = event.tmux_pane;
      } else if (!agentPanes[slot]) {
        // TMUX_PANE is normally inherited by Claude's hook command.  If a
        // launcher strips it, use the most recently active tmux pane as a
        // conservative first-session fallback rather than leaving an Agent
        // Key with a status light but no navigation target.
        agentPanes[slot] = await activeTmuxPane();
      }
      await refreshAgentKeys();
      if (event.hook_event_name === "SessionEnd") {
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
  fs.chmodSync(socketPath, 0o600);
  console.log(`Claude Micro bridge listening on ${socketPath}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    clearInterval(refreshTimer);
    try {
      await micro.setAllIdle();
      await micro.close();
    } catch {
      // A USB reset can invalidate the handle while shutting down.
    }
    writeHealth("stopped", true);
    removeSocket();
    process.exit(0);
  });
}
