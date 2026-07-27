import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  AGENT_KEY_COUNT,
  ENCODER_KEY_NAMES,
  JoystickFlickDetector,
  RpcMessageStream,
  RpcMethod,
  parseDeviceEvent,
  rpcPayloadFromPacket,
  type JoystickDirection,
  type RpcMessage,
} from "codex-micro-protocol";
import { CodexMicro } from "./micro";
import { SessionSlots, stateForHook } from "./state";
import { agentKeyLightingForState } from "./status-lighting";

const socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
const slotsPath = process.env.CLAUDE_MICRO_SLOTS ?? "/private/tmp/claude-micro-slots.json";
const healthPath = process.env.CLAUDE_MICRO_HEALTH ?? "/private/tmp/claude-micro-health.json";
const debugDir = process.env.CLAUDE_MICRO_DEBUG_DIR;
const latencyLogPath = process.env.CLAUDE_MICRO_LATENCY_LOG;
const maxHookBytes = Number(process.env.CLAUDE_MICRO_MAX_HOOK_BYTES ?? 262_144);
const agentHoldMs = Number(process.env.CLAUDE_MICRO_AGENT_HOLD_MS ?? 3_000);
// A device call that never settles must not disable lighting for the life of
// the process; every HID await is raced against this.
const deviceTimeoutMs = Number(process.env.CLAUDE_MICRO_DEVICE_TIMEOUT_MS ?? 2_000);
// Opt-in tracing appends a line per HID report (~2 GB/day at the 75 ms refresh
// rate), so each trace file stops growing at this size.
const maxDebugFileBytes = Number(process.env.CLAUDE_MICRO_MAX_DEBUG_BYTES ?? 64 * 1024 * 1024);
// A session that dies without its SessionEnd hook would otherwise hold its key
// forever; assignments older than this are evictable when all six are taken.
const slotStaleMs = Number(process.env.CLAUDE_MICRO_SLOT_STALE_MS ?? 12 * 60 * 60 * 1_000);
// Ceiling for the exponential backoff between reconnect attempts.
const maxReconnectBackoffMs = Number(process.env.CLAUDE_MICRO_MAX_RECONNECT_BACKOFF_MS ?? 30_000);

function removeSocket(): void {
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error(`Refusing to remove non-socket path: ${socketPath}`);
    fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Answers whether a bridge is already listening on the socket. Unlinking it
 * blind would orphan that daemon's listener: it keeps running and driving the
 * LEDs, but becomes unreachable and untrackable (the pid file names only one).
 */
function probeRunningBridge(): Promise<{ pid?: number } | null> {
  if (!fs.existsSync(socketPath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    let response = "";
    const finish = (result: { pid?: number } | null) => {
      clearTimeout(timer);
      client.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 750);
    client.once("connect", () => client.end(JSON.stringify({ op: "claude-micro.health" })));
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => (response += chunk));
    client.once("end", () => {
      try {
        const parsed = JSON.parse(response) as { ok?: boolean; pid?: number };
        finish(parsed?.ok === true ? parsed : null);
      } catch {
        finish(null);
      }
    });
    client.once("error", () => finish(null));
  });
}

const runningBridge = await probeRunningBridge();
if (runningBridge && process.env.CLAUDE_MICRO_REPLACE !== "1") {
  console.error(
    `Claude Micro: a bridge is already running (pid ${runningBridge.pid ?? "unknown"}) on ${socketPath}.\n` +
      "Stop it first (Prefix + k restarts the tmux-managed bridge), or set CLAUDE_MICRO_REPLACE=1 to take over.",
  );
  process.exit(1);
}

// The socket guard above only stops a second daemon on the SAME socket path.
// Two daemons on different socket paths still open the same physical device
// (node-hid is opened non-exclusively) and both drive the LEDs on their own
// 75 ms cycle — which looks like strobing, and lets one close the handle while
// the other is mid-write. This lock is keyed to the device, not the socket.
const deviceLockPath = process.env.CLAUDE_MICRO_DEVICE_LOCK ?? "/private/tmp/claude-micro-device.lock";

function holderOfDeviceLock(): number | null {
  let recorded: string;
  try {
    recorded = fs.readFileSync(deviceLockPath, "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number(recorded);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null; // Recorded process is gone; the lock is stale.
  }
  return pid;
}

function acquireDeviceLock(): void {
  const holder = holderOfDeviceLock();
  if (holder !== null && holder !== process.pid && process.env.CLAUDE_MICRO_REPLACE !== "1") {
    console.error(
      `Claude Micro: another bridge is already running (pid ${holder}) and holding the Codex Micro.\n` +
        "Two daemons drive the LEDs on separate cycles, which shows up as strobing. Stop that one first\n" +
        "(Prefix + K), or set CLAUDE_MICRO_REPLACE=1 to take over.",
    );
    process.exit(1);
  }
  writeFileAtomically(deviceLockPath, `${process.pid}\n`);
}

function releaseDeviceLock(): void {
  if (holderOfDeviceLock() === process.pid) fs.rmSync(deviceLockPath, { force: true });
}

acquireDeviceLock();

// Every append-only diagnostic file the daemon owns goes through here, so no
// sink can grow without bound. Sizes are tracked in memory after the first
// stat, and each file stops (loudly, once) at the cap rather than rotating —
// these are traces, and the interesting part is where they started.
const appendedFileBytes = new Map<string, number>();
function appendCapped(target: string, value: string, capBytes: number): void {
  let written = appendedFileBytes.get(target);
  if (written === undefined) {
    try {
      written = fs.statSync(target).size;
    } catch {
      written = 0;
    }
  }
  if (written >= capBytes) return;
  fs.appendFileSync(target, value, { mode: 0o600 });
  const total = written + Buffer.byteLength(value);
  appendedFileBytes.set(target, total);
  if (total >= capBytes) {
    console.error(`Claude Micro: ${target} reached its ${capBytes}-byte cap; no longer writing to it.`);
  }
}

function debugLog(name: string, value: string): void {
  if (!debugDir) return;
  fs.mkdirSync(debugDir, { recursive: true, mode: 0o700 });
  appendCapped(path.join(debugDir, name), value, maxDebugFileBytes);
}

/**
 * Atomic write that cannot be redirected by a pre-planted symlink: the temp
 * file is created with O_EXCL (wx) at mode 0600, then renamed over the target.
 */
function writeFileAtomically(targetPath: string, contents: string): void {
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  let handle: number | undefined;
  try {
    handle = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(handle, contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Either a crashed run left it behind or someone planted it. Remove and
      // retry once; a planted symlink is unlinked, never followed.
      fs.rmSync(temporaryPath, { force: true });
      handle = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(handle, contents);
    } else {
      throw error;
    }
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  fs.renameSync(temporaryPath, targetPath);
}

/** Races a device call so a hung HID handle cannot wedge the refresh loop. */
function withDeviceTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${deviceTimeoutMs}ms`)), deviceTimeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function latencyLog(entry: Record<string, unknown>): void {
  if (!latencyLogPath) return;
  appendCapped(latencyLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, maxDebugFileBytes);
}

// A disconnected device makes the refresh loop fail every 75 ms; logging each
// failure is what filled the daemon log with tens of thousands of identical
// lines. Repeats are collapsed and counted instead.
const lastReportedAt = new Map<string, { at: number; suppressed: number }>();
function reportRepeating(message: string, intervalMs = 60_000): void {
  const now = Date.now();
  const previous = lastReportedAt.get(message);
  if (previous && now - previous.at < intervalMs) {
    previous.suppressed += 1;
    return;
  }
  const suppressed = previous?.suppressed ?? 0;
  lastReportedAt.set(message, { at: now, suppressed: 0 });
  console.error(suppressed > 0 ? `${message} (repeated ${suppressed}x since the last report)` : message);
}

removeSocket();

let healthState: string | null = null;
let healthWrittenAt = 0;
function writeHealth(state: string, force = false): void {
  const now = Date.now();
  if (!force && state === healthState && now - healthWrittenAt < 1_000) return;
  healthState = state;
  healthWrittenAt = now;
  writeFileAtomically(healthPath, `${JSON.stringify({ state, updatedAt: new Date(now).toISOString(), pid: process.pid })}\n`);
}

function restoredSlotState(): Array<Record<string, unknown>> {
  try {
    const stored = JSON.parse(fs.readFileSync(slotsPath, "utf8")) as { slots?: unknown };
    return Array.isArray(stored?.slots) ? (stored.slots as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

const storedSlots = restoredSlotState();
const slots = new SessionSlots(
  storedSlots.map((record) => ({ sessionId: record.sessionId, slot: record.id, lastSeenAt: record.updatedAt })),
  { staleAfterMs: slotStaleMs },
);
const agentStates: string[] = Array(AGENT_KEY_COUNT).fill("idle");
const agentPanes: Array<string | null> = Array(AGENT_KEY_COUNT).fill(null);
for (const record of storedSlots) {
  const slotIndex = record.id;
  if (typeof slotIndex !== "number" || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= AGENT_KEY_COUNT) continue;
  if (typeof record.sessionId !== "string") continue;
  agentStates[slotIndex] = typeof record.state === "string" ? record.state : "idle";
  agentPanes[slotIndex] = typeof record.tmuxPane === "string" ? record.tmuxPane : null;
}

// A background service must not die on a transient fault: losing the process
// loses the socket, the slot assignments, and the device, and nothing restarts
// it until the user presses Prefix + k. The historical crashes were all this
// shape — an async device write rejecting with no handler attached.
process.on("unhandledRejection", (reason) => {
  reportRepeating(`Claude Micro: unhandled rejection — ${reason instanceof Error ? reason.message : String(reason)}`);
  if (isDeviceFault(reason)) void reconnectMicro();
});
process.on("uncaughtException", (error) => {
  reportRepeating(`Claude Micro: uncaught exception — ${error.message}`);
  debugLog("bridge.log", `${new Date().toISOString()} uncaught: ${error.stack}\n`);
  if (isDeviceFault(error)) void reconnectMicro();
});

/** Whether a failure means the HID handle is gone and a reconnect is due. */
function isDeviceFault(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /device|hid|disconnect|IOHID/i.test(message);
}

writeHealth("starting", true);
let micro: CodexMicro | null = null;
let refreshing = false;
let reconnecting = false;
let refreshInFlight: Promise<unknown> | null = null;
let consecutiveDeviceFailures = 0;
let nextReconnectAllowedAt = 0;

try {
  micro = await CodexMicro.connect();
  writeHealth("connected", true);
} catch (error) {
  // Starting without the device is a normal state — it may be unplugged, or
  // asleep. Serve the socket, keep the slot bookkeeping, and pick the device
  // up when it appears; exiting here just left the user with no bridge.
  reportRepeating(`Claude Micro: starting without the device — ${(error as Error).message}`);
  writeHealth("disconnected", true);
  void reconnectMicro();
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function reconnectMicro(): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  try {
    // Closing under an in-flight write is what produced ~14k "device has been
    // closed" errors: the refresh holds the old handle across its await, and
    // the reconnect pulled it out from under it. Let that write settle first.
    if (refreshInFlight) {
      try {
        await withDeviceTimeout(Promise.resolve(refreshInFlight), "in-flight refresh");
      } catch {
        // Settled or timed out; either way the handle is ours to close now.
      }
    }
    try {
      if (micro) await withDeviceTimeout(micro.close(), "device close");
    } catch {
      // The old handle may already be invalid, or hung, after a USB/HID reset.
    }
    micro = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        micro = await withDeviceTimeout(CodexMicro.connect(), "device connect");
        messageStream.reset();
        attachInput(micro);
        writeHealth("connected", true);
        // Throttled: a device that connects but refuses writes would otherwise
        // announce a "reconnect" on every retry.
        reportRepeating("Claude Micro reconnected.");
        return;
      } catch {
        await sleep(500);
      }
    }
    reportRepeating("Claude Micro reconnect timed out.");
    writeHealth("reconnecting", true);
  } finally {
    reconnecting = false;
  }
}

function agentKeyLightingSnapshot() {
  return agentStates.map((state, agentKeyIndex) => agentKeyLightingForState(agentKeyIndex, state));
}

async function refreshAgentKeys(): Promise<void> {
  if (refreshing) return;
  if (reconnecting) return;
  const handle = micro;
  if (!handle) return;
  refreshing = true;
  try {
    // ChatGPT Codex can also publish an idle state. Refreshing only the
    // per-thread channel lets Claude own the Agent LEDs without changing the
    // Input layer or the frame/background RGB configuration.
    const write = handle.sendRequest(RpcMethod.agentKeyStatus, agentKeyLightingSnapshot());
    refreshInFlight = write;
    await withDeviceTimeout(write, "agent-key refresh");
    consecutiveDeviceFailures = 0;
    nextReconnectAllowedAt = 0;
    writeHealth("connected");
  } catch (error) {
    reportRepeating(`Claude Micro refresh failed: ${(error as Error).message}`);
    writeHealth("reconnecting", true);
    // Back off. The refresh loop runs every 75 ms, so reconnecting on every
    // failure means hammering the USB device ~13 times a second — which burns
    // CPU, floods the log, and makes a marginal device worse rather than
    // better. Delay doubles per consecutive failure up to 30 s, and resets the
    // moment a write succeeds.
    const now = Date.now();
    if (now >= nextReconnectAllowedAt) {
      consecutiveDeviceFailures += 1;
      const backoffMs = Math.min(maxReconnectBackoffMs, 500 * 2 ** Math.min(consecutiveDeviceFailures - 1, 6));
      nextReconnectAllowedAt = now + backoffMs;
      void reconnectMicro();
    }
  } finally {
    refreshInFlight = null;
    refreshing = false;
  }
}

function writeSlots(): void {
  const sessionIds = new Map(slots.entries().map(({ sessionId, slot }) => [slot, sessionId]));
  const payload = {
    slots: agentStates.map((state, id) => ({
      id,
      state,
      tmuxPane: agentPanes[id],
      sessionId: sessionIds.get(id) ?? null,
      updatedAt: slots.lastSeenAt(id) ?? null,
    })),
  };
  writeFileAtomically(slotsPath, `${JSON.stringify(payload)}\n`);
}

await refreshAgentKeys();
const refreshTimer = setInterval(() => void refreshAgentKeys(), 75);

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(command, args, (error, _stdout, stderr) => {
    if (error) debugLog("bridge.log", `${new Date().toISOString()} ${command}: ${stderr || error.message}\n`);
    resolve("");
  }));
}

function runOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(command, args, (_error, stdout) => resolve(stdout.trim())));
}

async function focusITermTty(tty: string): Promise<void> {
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

async function focusAgentSlot(slot: number, receivedAt = performance.now()): Promise<void> {
  const pane = agentPanes[slot];
  if (!pane) return;
  // Codex handles the same native Agent-key event. Let that finish, then bring
  // the tmux/iTerm target forward so Layer 1 can be used for Claude navigation.
  await sleep(30);
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
  const focusCommand: string[] = [];
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

const agentHoldTimers = new Map<number, ReturnType<typeof setTimeout>>();

function cancelAgentKeyHold(slot: number): void {
  const timer = agentHoldTimers.get(slot);
  if (timer) clearTimeout(timer);
  agentHoldTimers.delete(slot);
}

async function clearAgentSlot(slot: number): Promise<void> {
  const assignment = slots.entries().find((entry) => entry.slot === slot);
  if (!assignment && agentStates[slot] === "idle" && !agentPanes[slot]) return;
  if (assignment) slots.release(assignment.sessionId);
  agentStates[slot] = "idle";
  agentPanes[slot] = null;
  writeSlots();
  await refreshAgentKeys();
  await run("tmux", ["display-message", `Claude Micro: cleared Agent Key ${slot + 1}.`]);
}

function beginAgentKeyPress(slot: number): void {
  cancelAgentKeyHold(slot);
  void focusAgentSlot(slot, performance.now());
  agentHoldTimers.set(slot, setTimeout(() => {
    agentHoldTimers.delete(slot);
    void clearAgentSlot(slot);
  }, agentHoldMs));
}

async function activeTmuxPane(): Promise<string | null> {
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

async function sendToActivePane(key: string): Promise<void> {
  const pane = await activeTmuxPane();
  if (pane) await run("tmux", ["send-keys", "-t", pane, key]);
}

async function sendSequenceToActivePane(keys: string[]): Promise<void> {
  const pane = await activeTmuxPane();
  if (pane) await run("tmux", ["send-keys", "-t", pane, ...keys]);
}

async function invokeWhisperflow(): Promise<void> {
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

// Prototype-free: the key name comes from the device, and a plain object
// literal would resolve "__proto__"/"constructor" to inherited members —
// truthy but not callable, which crashes the input listener.
const commandKeyActions: Record<string, () => unknown> = Object.assign(Object.create(null), {
  ACT06: () => sendToActivePane("C-s"),
  ACT07: () => sendToActivePane("C-w"),
  ACT08: () => sendSequenceToActivePane(["d", "a", "w"]),
  ACT09: () => sendToActivePane("Enter"),
  ACT10: () => sendToActivePane("Escape"),
  ACT11: invokeWhisperflow,
  ACT12: () => sendToActivePane("C-c"),
});

// On this unit, the physical left turn reports ENC_CW and the right turn
// ENC_CC; the bindings below give left turn → Left arrow.
const encoderActions: Record<string, () => unknown> = Object.assign(Object.create(null), {
  [ENCODER_KEY_NAMES.clockwise]: () => sendToActivePane("Left"),
  [ENCODER_KEY_NAMES.counterClockwise]: () => sendToActivePane("Right"),
});

/** Looks up a device-supplied key name safely: own, callable entries only. */
function keyAction(table: Record<string, () => unknown>, keyName: string): (() => unknown) | null {
  const action = Object.hasOwn(table, keyName) ? table[keyName] : undefined;
  return typeof action === "function" ? action : null;
}

const tmuxKeyByJoystickDirection: Record<JoystickDirection, string> = {
  right: "Right",
  down: "Down",
  left: "Left",
  up: "Up",
};
// The Micro reports a continuous radial stream; the detector emits one
// direction per full flick and re-arms near center.
const joystickFlickDetector = new JoystickFlickDetector({ triggerDistance: 0.8, rearmDistance: 0.2 });

const utf8Decoder = new TextDecoder();
const messageStream = new RpcMessageStream();

function handleDeviceMessage(message: RpcMessage): void {
  const deviceEvent = parseDeviceEvent(message);
  // Responses to our own lighting requests share the channel; nothing to do.
  if (!deviceEvent || deviceEvent.kind === "unrecognized") return;
  if (deviceEvent.kind === "keyEvent") {
    const { keyName, action, agentKeyIndex } = deviceEvent;
    if (action === "press" && message.type === "event") debugLog("hid-keys.log", `${JSON.stringify(message.raw)}\n`);
    if (agentKeyIndex !== null && action === "press") beginAgentKeyPress(agentKeyIndex);
    if (agentKeyIndex !== null && action === "release") cancelAgentKeyHold(agentKeyIndex);
    if (action === "press") void keyAction(commandKeyActions, keyName)?.();
    if (action === "encoderTurn") void keyAction(encoderActions, keyName)?.();
    return;
  }
  const direction = joystickFlickDetector.update(deviceEvent);
  if (direction) void sendToActivePane(tmuxKeyByJoystickDirection[direction]);
}

function attachInput(handle: CodexMicro): void {
  handle.onInput((report) => {
    const reportBytes = new Uint8Array(report);
    // Raw protocol traces are useful for discovering firmware controls, but are
    // deliberately opt-in so a normal bridge never accumulates device data.
    if (debugDir) {
      const rpcPayload = rpcPayloadFromPacket(reportBytes);
      const payloadText = rpcPayload ? utf8Decoder.decode(rpcPayload) : "";
      if (!payloadText.includes(`"method":"${RpcMethod.agentKeyStatus}"`)) {
        debugLog("hid-raw.log", `${Date.now()} ${Buffer.from(reportBytes).toString("hex")}\n`);
      }
    }
    // One malformed report must never take the bridge down: an exception here
    // would be unhandled inside node-hid's data listener and kill the process.
    for (const message of messageStream.pushHidPacket(reportBytes)) {
      try {
        handleDeviceMessage(message);
      } catch (error) {
        reportRepeating(`Claude Micro: ignoring unhandled device message — ${(error as Error).message}`);
        debugLog("bridge.log", `${new Date().toISOString()} device message failed: ${(error as Error).stack}\n`);
      }
    }
  });
}
// May be null when the device was absent at startup; reconnectMicro attaches
// the listener to each new handle it opens.
if (micro) attachInput(micro);

const server = net.createServer({ allowHalfOpen: true }, (connection) => {
  let body = "";
  let oversized = false;
  connection.setEncoding("utf8");
  connection.setTimeout(3_000, () => connection.destroy());
  // A Claude hook may exit as soon as it has sent the event. Keep that normal
  // half-close from becoming an unhandled socket error in the bridge.
  connection.on("error", () => {});
  connection.on("data", (chunk: string) => {
    if (oversized) return;
    body += chunk;
    if (body.length > maxHookBytes) {
      oversized = true;
      // Answer before tearing down: destroying here suppresses the 'end'
      // event, so a client that got no reply would misreport an over-limit
      // payload as the bridge being unavailable.
      body = "";
      connection.end(JSON.stringify({ ok: false, error: "Hook payload exceeds the bridge limit." }));
    }
  });
  connection.on("end", async () => {
    if (oversized) return;
    try {
      const event = JSON.parse(body) as Record<string, unknown>;
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
        // TMUX_PANE is normally inherited by Claude's hook command.  If a
        // launcher strips it, use the most recently active tmux pane as a
        // conservative first-session fallback rather than leaving an Agent
        // Key with a status light but no navigation target.
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
      connection.end(JSON.stringify({ ok: false, error: (error as Error).message }));
    }
  });
});

server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
  console.log(`Claude Micro bridge listening on ${socketPath}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // Every step here is best-effort: the historical fatal crashes were an
    // async shutdown handler rejecting, which turns a clean stop into a crash
    // that leaves the socket behind.
    try {
      server.close();
      clearInterval(refreshTimer);
      try {
        if (micro) {
          await withDeviceTimeout(
            micro.sendRequest(
              RpcMethod.agentKeyStatus,
              agentStates.map((_state, agentKeyIndex) => agentKeyLightingForState(agentKeyIndex, "idle")),
            ),
            "shutdown blank",
          );
          await withDeviceTimeout(micro.close(), "shutdown close");
        }
      } catch {
        // A USB reset can invalidate the handle while shutting down.
      }
      try {
        writeHealth("stopped", true);
      } catch {
        // Losing the health record must not stop us releasing the socket.
      }
      removeSocket();
      releaseDeviceLock();
    } catch (error) {
      console.error(`Claude Micro: shutdown completed with errors — ${(error as Error).message}`);
    } finally {
      process.exit(0);
    }
  });
}
