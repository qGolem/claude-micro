import fs from "node:fs";
import net from "node:net";
import { execFile } from "node:child_process";
import { CodexMicro } from "./micro.mjs";
import { SessionSlots, stateForHook } from "./state.mjs";

const socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
const slotsPath = process.env.CLAUDE_MICRO_SLOTS ?? "/private/tmp/claude-micro-slots.json";
const focusLogPath = process.env.CLAUDE_MICRO_FOCUS_LOG ?? "/private/tmp/claude-micro-focus.log";
const commandLogPath = process.env.CLAUDE_MICRO_COMMAND_LOG ?? "/private/tmp/claude-micro-command-keys.log";
const rawCommandLogPath = process.env.CLAUDE_MICRO_RAW_COMMAND_LOG ?? "/private/tmp/claude-micro-command-raw.log";
const healthPath = process.env.CLAUDE_MICRO_HEALTH ?? "/private/tmp/claude-micro-health.json";
if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

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

let micro = await CodexMicro.connect();
writeHealth("connected", true);
const slots = new SessionSlots();
const agentStates = Array(6).fill("idle");
const agentPanes = Array(6).fill(null);
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
  const payload = { slots: agentStates.map((state, id) => ({ id, state, tmuxPane: agentPanes[id] })) };
  const temporaryPath = `${slotsPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload)}\n`, "utf8");
  fs.renameSync(temporaryPath, slotsPath);
}

await refreshAgentKeys();
const refreshTimer = setInterval(() => void refreshAgentKeys(), 75);

function run(command, args) {
  return new Promise((resolve) => execFile(command, args, (error, _stdout, stderr) => {
    if (error) fs.appendFileSync(focusLogPath, `${new Date().toISOString()} ${command}: ${stderr || error.message}\n`);
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

async function focusAgentSlot(slot) {
  const pane = agentPanes[slot];
  if (!pane) return;
  // Codex handles the same native Agent-key event. Let that finish, then bring
  // the tmux/iTerm target forward so Layer 1 can be used for Claude navigation.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const session = await runOutput("tmux", ["display-message", "-p", "-t", pane, "#{session_name}"]);
  const clients = await runOutput("tmux", ["list-clients", "-F", "#{client_tty}\t#{client_session}"]);
  const tty = clients
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, clientSession]) => clientSession === session)?.[0];
  if (tty) await run("tmux", ["switch-client", "-c", tty, "-t", session]);
  await run("tmux", ["select-window", "-t", pane]);
  await run("tmux", ["select-pane", "-t", pane]);
  if (tty) await focusITermTty(tty);
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
// the physical left turn reports ENC_CW and the physical right turn ENC_CCW.
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
fs.writeFileSync(rawCommandLogPath, "");
function attachInput(handle) {
  handle.onInput((report) => {
  const data = Buffer.from(report);
  // Keep every report except the bridge's own frequent lighting acknowledgements
  // while discovering the locked Layer 1 Command-key input format.
  const payloadText = data[1] === 2 ? data.subarray(3, 3 + data[2]).toString("utf8") : "";
  if (!payloadText.includes('"method":"v.oai.thstatus"')) {
    fs.appendFileSync(rawCommandLogPath, `${Date.now()} ${data.toString("hex")}\n`);
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
        fs.appendFileSync(commandLogPath, `${JSON.stringify(message)}\n`);
      }
      if (message?.p?.act === 1 && /^AG0[0-5]$/.test(key ?? "")) void focusAgentSlot(Number(key.slice(2)));
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
  connection.setEncoding("utf8");
  // A Claude hook may exit as soon as it has sent the event. Keep that normal
  // half-close from becoming an unhandled socket error in the bridge.
  connection.on("error", () => {});
  connection.on("data", (chunk) => (body += chunk));
  connection.on("end", async () => {
    try {
      const event = JSON.parse(body);
      const state = stateForHook(event);
      const sessionId = event.session_id ?? event.sessionId;
      if (!state || !sessionId) throw new Error("Hook event did not include a supported state and session_id.");
      const slot = slots.acquire(sessionId);
      agentStates[slot] = state;
      if (event.tmux_pane) agentPanes[slot] = event.tmux_pane;
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

server.listen(socketPath, () => console.log(`Claude Micro bridge listening on ${socketPath}`));
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
    process.exit(0);
  });
}
