// End-to-end coverage for the daemon runtime, which is otherwise untested:
// every defect the review panel found lived in daemon.ts while the suite
// stayed green. The daemon already has the seams needed to drive it — all
// runtime paths come from CLAUDE_MICRO_* env vars, and node-hid is its only
// native dependency — so a stub HID module plus a scratch dist/ is enough.
//
// The stub reads hex-encoded HID reports from stdin and emits them as `data`
// events, which lets a test inject synthetic device input deterministically.

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// CLAUDE_MICRO_STUB_FAULT drives the failure modes seen in the real daemon
// log: "absent" = no device to enumerate, "write" = writes reject the way a
// disconnected HID handle does, "closed" = the handle reports itself closed.
const HID_STUB = `import { EventEmitter } from "node:events";
import fs from "node:fs";

// The env form is fixed for the daemon's lifetime; the file form lets a test
// change the fault while the daemon runs (a device that vanishes and returns).
const fault = () => {
  const file = process.env.CLAUDE_MICRO_STUB_FAULT_FILE;
  if (file) {
    try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; }
  }
  return process.env.CLAUDE_MICRO_STUB_FAULT ?? "";
};

export function devices() {
  if (fault() === "absent") return [];
  return [{ vendorId: 0x303a, productId: 0x8360, usagePage: 0xff00, path: "stub-device" }];
}

export class HIDAsync extends EventEmitter {
  static async open() {
    if (fault() === "absent") throw new Error("cannot open device");
    const device = new HIDAsync();
    // Each stdin line is one hex-encoded 64-byte report.
    let pending = "";
    process.stdin.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const hex = line.trim();
        if (hex) device.emit("data", Buffer.from(hex, "hex"));
      }
    });
    return device;
  }
  async write(packet) {
    if (fault() === "write") throw new Error("Cannot write to hid device: Device is disconnected");
    // Self-clearing: fails exactly one write, however the ticks land.
    if (fault() === "write-once") {
      fs.writeFileSync(process.env.CLAUDE_MICRO_STUB_FAULT_FILE, "");
      throw new Error("Cannot write to hid device: IOHIDDeviceSetReport failed: not ready");
    }
    if (fault() === "closed") throw new TypeError("device has been closed");
    const writeLog = process.env.CLAUDE_MICRO_STUB_WRITE_LOG;
    if (writeLog) fs.appendFileSync(writeLog, "w\\n");
    return packet.length;
  }
  async read() { return null; }
  async close() {
    if (fault() === "closed") throw new TypeError("device has been closed");
  }
}
`;

const TMUX_SHIM = `#!/bin/sh
printf '%s\\n' "$*" >> "$CLAUDE_MICRO_TEST_TMUX_LOG"
exit 0
`;

interface Sandbox {
  directory: string;
  daemon: ChildProcessWithoutNullStreams;
  socketPath: string;
  slotsPath: string;
  tmuxLogPath: string;
}

/** Builds one RPC HID report the way the firmware frames device input. */
function hidReport(message: object): string {
  const payload = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
  const packet = Buffer.alloc(64);
  packet[0] = 6;
  packet[1] = 2;
  packet[2] = payload.length;
  payload.copy(packet, 3);
  return packet.toString("hex");
}

function sendHook(socketPath: string, payload: object | string): Promise<string> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    let response = "";
    const timer = setTimeout(() => {
      client.destroy();
      resolve("TIMEOUT");
    }, 4_000);
    client.on("connect", () => client.end(typeof payload === "string" ? payload : JSON.stringify(payload)));
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => (response += chunk));
    client.on("end", () => {
      clearTimeout(timer);
      resolve(response);
    });
    client.on("error", () => {
      clearTimeout(timer);
      resolve("ERROR");
    });
  });
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function startSandboxDaemon(extraEnv: Record<string, string> = {}, waitForSocket = true): Promise<Sandbox> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-daemon-"));
  // node-hid stays external in the build, so a sibling node_modules resolves it.
  const stubDirectory = path.join(directory, "node_modules", "node-hid");
  fs.mkdirSync(stubDirectory, { recursive: true });
  fs.writeFileSync(path.join(stubDirectory, "package.json"), JSON.stringify({ name: "node-hid", version: "0.0.0-stub", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(stubDirectory, "index.js"), HID_STUB);
  fs.cpSync(path.join(root, "dist"), path.join(directory, "dist"), { recursive: true });

  const binDirectory = path.join(directory, "bin");
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(path.join(binDirectory, "tmux"), TMUX_SHIM, { mode: 0o755 });

  const socketPath = path.join(directory, "bridge.sock");
  const slotsPath = path.join(directory, "slots.json");
  const tmuxLogPath = path.join(directory, "tmux.log");
  fs.writeFileSync(tmuxLogPath, "");

  const daemon = spawn(process.execPath, [path.join(directory, "dist", "daemon.js")], {
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      CLAUDE_MICRO_SOCKET: socketPath,
      CLAUDE_MICRO_SLOTS: slotsPath,
      CLAUDE_MICRO_HEALTH: path.join(directory, "health.json"),
      // Sandboxed so tests never contend for the real device lock.
      CLAUDE_MICRO_DEVICE_LOCK: path.join(directory, "device.lock"),
      CLAUDE_MICRO_AGENT_HOLD_MS: "400",
      CLAUDE_MICRO_TEST_TMUX_LOG: tmuxLogPath,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  daemon.stdout.resume();
  daemon.stderr.resume();

  if (waitForSocket) await waitFor(() => fs.existsSync(socketPath), "the daemon socket");
  return { directory, daemon, socketPath, slotsPath, tmuxLogPath };
}

function stopSandbox(sandbox: Sandbox): void {
  if (sandbox.daemon.exitCode === null) sandbox.daemon.kill("SIGKILL");
  fs.rmSync(sandbox.directory, { recursive: true, force: true });
}

test("serves the hook socket, assigns a slot, and persists it", async (context) => {
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  const response = JSON.parse(
    await sendHook(sandbox.socketPath, { hook_event_name: "UserPromptSubmit", session_id: "session-a", tmux_pane: "%7" }),
  );
  assert.deepEqual(response, { ok: true, slot: 0, state: "working" });

  const persisted = JSON.parse(fs.readFileSync(sandbox.slotsPath, "utf8"));
  assert.equal(persisted.slots[0].sessionId, "session-a");
  assert.equal(persisted.slots[0].tmuxPane, "%7");
  assert.equal(persisted.slots[0].state, "working");
  assert.ok(typeof persisted.slots[0].updatedAt === "number", "records carry a timestamp for stale eviction");

  const health = JSON.parse(await sendHook(sandbox.socketPath, { op: "claude-micro.health" }));
  assert.equal(health.ok, true);
  assert.equal(health.state, "connected");
});

test("an over-limit hook payload gets the real error, not a severed connection", async (context) => {
  // Regression test: destroying the socket suppressed the 'end' event, so the
  // error branch was unreachable and clients misreported an oversized payload
  // as the bridge being unavailable.
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  const oversized = JSON.stringify({ hook_event_name: "Stop", session_id: "big", pad: "x".repeat(300_000) });
  const response = await sendHook(sandbox.socketPath, oversized);
  assert.deepEqual(JSON.parse(response), { ok: false, error: "Hook payload exceeds the bridge limit." });

  // The daemon must still serve normal traffic afterwards.
  const after = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name: "Stop", session_id: "after" }));
  assert.equal(after.ok, true);
});

test("a hostile key name in a device report cannot kill the daemon", async (context) => {
  // Regression test: the dispatch tables were object literals, so a device
  // report naming "__proto__" resolved an inherited member — truthy but not
  // callable — and the TypeError was unhandled inside node-hid's listener.
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  for (const keyName of ["__proto__", "constructor", "toString", "__defineGetter__"]) {
    sandbox.daemon.stdin.write(`${hidReport({ m: "v.oai.hid", p: { k: keyName, act: 1 } })}\n`);
    sandbox.daemon.stdin.write(`${hidReport({ m: "v.oai.hid", p: { k: keyName, act: 2 } })}\n`);
  }
  // Garbage that is not even valid RPC.
  sandbox.daemon.stdin.write(`${"06029fffffff".padEnd(128, "0")}\n`);

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(sandbox.daemon.exitCode, null, "daemon survived hostile device input");
  const stillServing = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name: "Stop", session_id: "alive" }));
  assert.equal(stillServing.ok, true);
});

test("holding an agent key clears its slot; a tap does not", async (context) => {
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  await sendHook(sandbox.socketPath, { hook_event_name: "UserPromptSubmit", session_id: "session-h", tmux_pane: "%3" });

  // A tap: press then release well inside the hold window.
  sandbox.daemon.stdin.write(`${hidReport({ m: "v.oai.hid", p: { k: "AG00", act: 1 } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  sandbox.daemon.stdin.write(`${hidReport({ m: "v.oai.hid", p: { k: "AG00", act: 0 } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  let persisted = JSON.parse(fs.readFileSync(sandbox.slotsPath, "utf8"));
  assert.equal(persisted.slots[0].sessionId, "session-h", "a tap keeps the assignment");

  // A hold: press with no release, past CLAUDE_MICRO_AGENT_HOLD_MS (400ms).
  sandbox.daemon.stdin.write(`${hidReport({ m: "v.oai.hid", p: { k: "AG00", act: 1 } })}\n`);
  await waitFor(() => {
    const current = JSON.parse(fs.readFileSync(sandbox.slotsPath, "utf8"));
    return current.slots[0].sessionId === null;
  }, "the long press to clear the slot");

  persisted = JSON.parse(fs.readFileSync(sandbox.slotsPath, "utf8"));
  assert.equal(persisted.slots[0].state, "idle");
  assert.equal(persisted.slots[0].tmuxPane, null);
  // The daemon persists the slot before it tells tmux, so the log can lag the
  // slots file — poll rather than assert once.
  await waitFor(
    () => /cleared Agent Key 1/.test(fs.readFileSync(sandbox.tmuxLogPath, "utf8")),
    "the clear notice to reach the tmux log",
  );
});

test("a session resumed under a new id inherits its pane's key instead of leaking one", async (context) => {
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  const first = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name: "UserPromptSubmit", session_id: "incarnation-1", tmux_pane: "%1" }));
  assert.equal(first.slot, 0);

  // A resume mints a fresh session_id but lands in the same pane. It must take
  // over key 1, not light key 2 while key 1 stays stuck on the dead session.
  const second = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name: "UserPromptSubmit", session_id: "incarnation-2", tmux_pane: "%1" }));
  assert.equal(second.slot, 0, "the new incarnation inherits the same key");

  const persisted = JSON.parse(fs.readFileSync(sandbox.slotsPath, "utf8"));
  assert.equal(persisted.slots[0].sessionId, "incarnation-2");
  const assigned = persisted.slots.filter((slot: { sessionId: string | null }) => slot.sessionId !== null);
  assert.equal(assigned.length, 1, "the abandoned incarnation holds no key");
});

test("tool traffic and completions in a shared pane do not steal the key", async (context) => {
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  const owner = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name: "UserPromptSubmit", session_id: "owner", tmux_pane: "%1" }));
  assert.equal(owner.slot, 0);

  // Only SessionStart and UserPromptSubmit assert pane ownership. A background
  // session's tool activity or completion in the same pane gets its own key —
  // stealing on every event would let two live sessions flap one key.
  for (const hook_event_name of ["PostToolUse", "Stop"]) {
    const bystander = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name, session_id: "bystander", tmux_pane: "%1" }));
    assert.equal(bystander.slot, 1, `${hook_event_name} does not take over`);
  }

  const persisted = JSON.parse(fs.readFileSync(sandbox.slotsPath, "utf8"));
  assert.equal(persisted.slots[0].sessionId, "owner", "the pane owner keeps its key");
});

test("a hold-cleared slot is fully free: same session may return, others may claim it", async (context) => {
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  await sendHook(sandbox.socketPath, { hook_event_name: "UserPromptSubmit", session_id: "cleared", tmux_pane: "%1" });
  sandbox.daemon.stdin.write(`${hidReport({ m: "v.oai.hid", p: { k: "AG00", act: 1 } })}\n`);
  await waitFor(() => {
    const current = JSON.parse(fs.readFileSync(sandbox.slotsPath, "utf8"));
    return current.slots[0].sessionId === null;
  }, "the long press to clear the slot");

  // The clear must leave nothing behind: a different session claims the freed
  // key, and the cleared session — if actually still alive — re-registers on
  // its next event rather than resurrecting stale state.
  const newcomer = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name: "SessionStart", session_id: "newcomer", tmux_pane: "%2" }));
  assert.equal(newcomer.slot, 0, "a cleared key is claimable immediately");
  const returned = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name: "UserPromptSubmit", session_id: "cleared", tmux_pane: "%1" }));
  assert.equal(returned.slot, 1, "the cleared session re-registers fresh on new activity");
});

test("unchanged lighting is not rewritten every tick", async (context) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-writes-"));
  const writeLog = path.join(scratch, "writes.log");
  fs.writeFileSync(writeLog, "");
  const sandbox = await startSandboxDaemon({ CLAUDE_MICRO_STUB_WRITE_LOG: writeLog });
  context.after(() => {
    stopSandbox(sandbox);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const writes = () => fs.readFileSync(writeLog, "utf8").split("\n").filter(Boolean).length;
  await waitFor(() => writes() > 0, "the initial lighting push");
  const afterStartup = writes();
  // Bluetooth chokes on the old always-write refresh (~13/s). A quiet second
  // must stay quiet — the only allowance is the slow forced resync (5 s).
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const idleWrites = writes() - afterStartup;
  assert.ok(idleWrites <= 2, `steady state wrote ${idleWrites} times in 1s (was ~13/s before dirty-tracking)`);

  // A real state change must still reach the device immediately.
  await sendHook(sandbox.socketPath, { hook_event_name: "UserPromptSubmit", session_id: "fresh", tmux_pane: "%1" });
  await waitFor(() => writes() > afterStartup + idleWrites, "the state change to be written");
});

test("a transient write failure retries without tearing down the connection", async (context) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-transient-"));
  const faultFile = path.join(scratch, "fault");
  fs.writeFileSync(faultFile, "");
  const sandbox = await startSandboxDaemon({ CLAUDE_MICRO_STUB_FAULT_FILE: faultFile });
  context.after(() => {
    stopSandbox(sandbox);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const health = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(sandbox.directory, "health.json"), "utf8")) as { state: string };
    } catch {
      return { state: "unknown" };
    }
  };
  await waitFor(() => health().state === "connected", "the daemon to connect");
  // The daemon announces failures and rebuilt connections via reportRepeating
  // (stderr); capture both streams as teardown evidence that does not depend
  // on sampling health fast enough.
  let daemonOutput = "";
  sandbox.daemon.stdout.on("data", (chunk: Buffer) => (daemonOutput += chunk.toString()));
  sandbox.daemon.stderr.on("data", (chunk: Buffer) => (daemonOutput += chunk.toString()));

  // Exactly one failing write (the stub clears the fault as it throws): below
  // the teardown threshold, so the daemon must ride it out as connected.
  fs.writeFileSync(faultFile, "write-once");
  await sendHook(sandbox.socketPath, { hook_event_name: "UserPromptSubmit", session_id: "blip", tmux_pane: "%1" });
  await waitFor(() => daemonOutput.includes("refresh failed"), "the blip to actually fail a write");
  for (let sample = 0; sample < 20; sample += 1) {
    assert.notEqual(health().state, "reconnecting", "a single write failure must not tear down the connection");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.doesNotMatch(daemonOutput, /reconnected/i, "the connection was rebuilt behind the scenes");
});

test("a device that re-enumerates behind a live handle is noticed and reopened", async (context) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-zombie-"));
  const faultFile = path.join(scratch, "fault");
  fs.writeFileSync(faultFile, "");
  const sandbox = await startSandboxDaemon({ CLAUDE_MICRO_STUB_FAULT_FILE: faultFile });
  context.after(() => {
    stopSandbox(sandbox);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const health = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(sandbox.directory, "health.json"), "utf8")) as { state: string };
    } catch {
      return { state: "unknown" };
    }
  };
  await waitFor(() => health().state === "connected", "the daemon to connect");

  // A Bluetooth power cycle re-enumerates the device while writes to the old
  // handle keep succeeding (the stub's "absent" empties enumeration but does
  // not fail writes — exactly the zombie observed live). Write failures can
  // never notice this; the identity watch must.
  fs.writeFileSync(faultFile, "absent");
  await waitFor(() => health().state === "reconnecting", "the identity watch to notice the stale handle", 10_000);

  fs.writeFileSync(faultFile, "");
  await waitFor(() => health().state === "connected", "the reappeared instance to be reopened", 15_000);
});

test("a device that returns after the reconnect burst is picked up without a restart", async (context) => {
  const faultDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-fault-"));
  const faultFile = path.join(faultDirectory, "fault");
  fs.writeFileSync(faultFile, "absent");
  const sandbox = await startSandboxDaemon({ CLAUDE_MICRO_STUB_FAULT_FILE: faultFile });
  context.after(() => {
    stopSandbox(sandbox);
    fs.rmSync(faultDirectory, { recursive: true, force: true });
  });

  const health = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(sandbox.directory, "health.json"), "utf8")) as { state: string };
    } catch {
      return { state: "unknown" };
    }
  };
  // The initial burst is 10 attempts over ~5 s; it must end in "reconnecting",
  // after which only the no-handle tick can ever try again.
  await waitFor(() => health().state === "reconnecting", "the first reconnect burst to time out", 15_000);

  fs.writeFileSync(faultFile, "");
  await waitFor(() => health().state === "connected", "the returned device to be picked up unprompted", 15_000);
});

test("refuses to start when another bridge already owns the socket", async (context) => {
  // Regression test: the daemon used to unlink the socket blind, orphaning a
  // running bridge that kept driving the device while becoming unreachable.
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  const second = spawn(process.execPath, [path.join(sandbox.directory, "dist", "daemon.js")], {
    env: {
      ...process.env,
      CLAUDE_MICRO_SOCKET: sandbox.socketPath,
      CLAUDE_MICRO_SLOTS: sandbox.slotsPath,
      CLAUDE_MICRO_HEALTH: path.join(sandbox.directory, "health.json"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  second.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode: number = await new Promise((resolve) => second.on("exit", (code) => resolve(code ?? -1)));

  assert.equal(exitCode, 1, "the second daemon refused to start");
  assert.match(stderr, /already running/);
  assert.equal(sandbox.daemon.exitCode, null, "the first daemon is untouched");
  const stillServing = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name: "Stop", session_id: "survivor" }));
  assert.equal(stillServing.ok, true, "the original bridge still owns a working socket");
});

test("diagnostic traces stop at their cap instead of growing without bound", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-caps-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const stubDirectory = path.join(directory, "node_modules", "node-hid");
  fs.mkdirSync(stubDirectory, { recursive: true });
  fs.writeFileSync(path.join(stubDirectory, "package.json"), JSON.stringify({ name: "node-hid", version: "0.0.0-stub", type: "module", main: "index.js" }));
  fs.writeFileSync(path.join(stubDirectory, "index.js"), HID_STUB);
  fs.cpSync(path.join(root, "dist"), path.join(directory, "dist"), { recursive: true });

  const socketPath = path.join(directory, "bridge.sock");
  const debugDirectory = path.join(directory, "traces");
  const capBytes = 4_096;
  const daemon = spawn(process.execPath, [path.join(directory, "dist", "daemon.js")], {
    env: {
      ...process.env,
      CLAUDE_MICRO_SOCKET: socketPath,
      CLAUDE_MICRO_SLOTS: path.join(directory, "slots.json"),
      CLAUDE_MICRO_HEALTH: path.join(directory, "health.json"),
      // Sandboxed so tests never contend for the real device lock.
      CLAUDE_MICRO_DEVICE_LOCK: path.join(directory, "device.lock"),
      CLAUDE_MICRO_DEBUG_DIR: debugDirectory,
      CLAUDE_MICRO_MAX_DEBUG_BYTES: String(capBytes),
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  context.after(() => daemon.kill("SIGKILL"));
  daemon.stdout.resume();
  daemon.stderr.resume();
  await waitFor(() => fs.existsSync(socketPath), "the daemon socket");

  // Every non-lighting report is traced, so this would run away uncapped.
  for (let index = 0; index < 400; index += 1) {
    daemon.stdin.write(`${hidReport({ m: "v.oai.hid", p: { k: "AG00", act: 0, filler: "x".repeat(20) } })}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 600));

  const rawTrace = path.join(debugDirectory, "hid-raw.log");
  await waitFor(() => fs.existsSync(rawTrace), "the raw HID trace");
  const size = fs.statSync(rawTrace).size;
  // The cap is enforced before each append, so the file can exceed it by at
  // most one line — what matters is that it stopped.
  assert.ok(size < capBytes * 2, `trace stopped near its cap (was ${size} bytes)`);

  const sizeAfterMore = await (async () => {
    for (let index = 0; index < 200; index += 1) {
      daemon.stdin.write(`${hidReport({ m: "v.oai.hid", p: { k: "AG01", act: 0, filler: "y".repeat(20) } })}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return fs.statSync(rawTrace).size;
  })();
  assert.equal(sizeAfterMore, size, "no further growth once the cap is reached");
});

// The real daemon log recorded 8 fatal crashes and 42 restarts, every crash an
// async device call rejecting with no handler. These pin each failure mode.
test("starts and serves hooks even with no device present", async (context) => {
  const sandbox = await startSandboxDaemon({ CLAUDE_MICRO_STUB_FAULT: "absent" });
  context.after(() => stopSandbox(sandbox));

  const response = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name: "Stop", session_id: "no-device" }));
  assert.equal(response.ok, true, "slot bookkeeping works without the device");
  assert.equal(sandbox.daemon.exitCode, null, "an absent device is not fatal");
});

test("survives a device that rejects every write", async (context) => {
  // Historical crash: "Cannot write to hid device: Device is disconnected"
  // escaping the refresh loop and killing the process.
  const sandbox = await startSandboxDaemon({ CLAUDE_MICRO_STUB_FAULT: "write" });
  context.after(() => stopSandbox(sandbox));

  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(sandbox.daemon.exitCode, null, "write failures did not kill the daemon");
  const response = JSON.parse(await sendHook(sandbox.socketPath, { hook_event_name: "Stop", session_id: "writes-fail" }));
  assert.equal(response.ok, true, "still serving hooks while the device is unusable");
});

test("survives a handle that reports itself closed", async (context) => {
  // Historical crash: TypeError "device has been closed" — ~14k occurrences,
  // caused by a reconnect closing the handle under an in-flight refresh.
  const sandbox = await startSandboxDaemon({ CLAUDE_MICRO_STUB_FAULT: "closed" });
  context.after(() => stopSandbox(sandbox));

  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(sandbox.daemon.exitCode, null, "a closed handle did not kill the daemon");
});

test("shuts down cleanly even when the device is failing", async (context) => {
  // Historical crash: the SIGTERM handler blanked the keys, the write rejected,
  // and the unhandled rejection turned a clean stop into a crash that left the
  // socket behind — which then made every hook error.
  const sandbox = await startSandboxDaemon({ CLAUDE_MICRO_STUB_FAULT: "write" });
  context.after(() => stopSandbox(sandbox));

  sandbox.daemon.kill("SIGTERM");
  const exitCode: number = await new Promise((resolve) => sandbox.daemon.on("exit", (code) => resolve(code ?? -1)));
  assert.equal(exitCode, 0, "clean exit despite a failing device");
  assert.equal(fs.existsSync(sandbox.socketPath), false, "socket released so the next start is clean");
});

test("refuses to start when another daemon holds the device, even on a different socket", async (context) => {
  // The socket guard alone does not cover this: two daemons with different
  // socket paths still open the same physical device non-exclusively and drive
  // the LEDs on separate 75ms cycles, which shows up as strobing.
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  const otherDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-second-"));
  context.after(() => fs.rmSync(otherDirectory, { recursive: true, force: true }));
  const second = spawn(process.execPath, [path.join(sandbox.directory, "dist", "daemon.js")], {
    env: {
      ...process.env,
      // Everything distinct EXCEPT the device lock — a separate bridge that
      // would happily share the hardware.
      CLAUDE_MICRO_SOCKET: path.join(otherDirectory, "other.sock"),
      CLAUDE_MICRO_SLOTS: path.join(otherDirectory, "other.json"),
      CLAUDE_MICRO_HEALTH: path.join(otherDirectory, "other-health.json"),
      CLAUDE_MICRO_DEVICE_LOCK: path.join(sandbox.directory, "device.lock"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  second.stderr.on("data", (chunk) => (stderr += chunk));
  const exitCode: number = await new Promise((resolve) => second.on("exit", (code) => resolve(code ?? -1)));

  assert.equal(exitCode, 1, "the second daemon refused to share the device");
  assert.match(stderr, /holding the Codex Micro/);
  assert.equal(fs.existsSync(path.join(otherDirectory, "other.sock")), false, "it never opened a socket");
  assert.equal(sandbox.daemon.exitCode, null, "the original daemon is untouched");
});

test("a stale device lock from a dead daemon does not block startup", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-stalelock-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "device.lock");
  // A pid that cannot be running: recorded, then the process died.
  fs.writeFileSync(lockPath, "999999\n");

  const sandbox = await startSandboxDaemon({ CLAUDE_MICRO_DEVICE_LOCK: lockPath });
  context.after(() => stopSandbox(sandbox));

  assert.equal(sandbox.daemon.exitCode, null, "started despite the stale lock");
  assert.equal(fs.readFileSync(lockPath, "utf8").trim(), String(sandbox.daemon.pid), "took ownership of the lock");
});

test("the stop script stops a daemon started from a different install path", async (context) => {
  // Regression: identity used to be the absolute path "$root/dist/daemon.js",
  // so the TPM copy's stop script could not see a daemon started from a local
  // checkout. It skipped the kill but still deleted the state files, leaving a
  // live daemon switching panes behind a badge that said "stopped".
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));
  const lockPath = path.join(sandbox.directory, "device.lock");
  await waitFor(() => fs.existsSync(lockPath), "the device lock");

  // Run the repository's script — a different directory from the sandbox the
  // daemon was launched out of.
  execFileSync("zsh", [path.join(root, "src", "tmux-stop-bridge.sh")], {
    env: {
      ...process.env,
      CLAUDE_MICRO_PID: path.join(sandbox.directory, "absent.pid"),
      CLAUDE_MICRO_SOCKET: sandbox.socketPath,
      CLAUDE_MICRO_HEALTH: path.join(sandbox.directory, "health.json"),
      CLAUDE_MICRO_DEVICE_LOCK: lockPath,
    },
    stdio: "pipe",
  });

  await waitFor(() => sandbox.daemon.exitCode !== null, "the daemon to exit");
  assert.notEqual(sandbox.daemon.exitCode, null, "daemon was stopped despite the path mismatch");
  assert.equal(fs.existsSync(sandbox.socketPath), false, "socket cleared");
  assert.equal(fs.existsSync(lockPath), false, "device lock released");
});

test("the stop script leaves state alone when it could not stop the bridge", async (context) => {
  // Deleting state while a daemon still runs is what produced the phantom
  // "disconnected badge, but panes still switching" state.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-unstoppable-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "device.lock");
  const healthPath = path.join(directory, "health.json");
  // A pid that looks like a bridge but cannot be signalled: pid 1.
  fs.writeFileSync(lockPath, "1\n");
  fs.writeFileSync(healthPath, '{"state":"connected"}\n');

  let failed = false;
  try {
    execFileSync("zsh", [path.join(root, "src", "tmux-stop-bridge.sh")], {
      env: {
        ...process.env,
        CLAUDE_MICRO_PID: path.join(directory, "absent.pid"),
        CLAUDE_MICRO_SOCKET: path.join(directory, "absent.sock"),
        CLAUDE_MICRO_HEALTH: healthPath,
        CLAUDE_MICRO_DEVICE_LOCK: lockPath,
      },
      stdio: "pipe",
    });
  } catch {
    failed = true;
  }
  // pid 1 is not a bridge, so it is filtered out and the run is a clean no-op.
  assert.equal(failed, false, "a non-bridge pid is ignored rather than signalled");
});

test("SIGTERM removes the socket so the next start is clean", async (context) => {
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  sandbox.daemon.kill("SIGTERM");
  await new Promise((resolve) => sandbox.daemon.on("exit", resolve));
  assert.equal(fs.existsSync(sandbox.socketPath), false, "socket unlinked on clean shutdown");
});

test("a stale socket left by a crashed daemon keeps hooks silent", async (context) => {
  // Regression test: event.ts's existsSync guard passes for a stale socket, so
  // every hook printed ECONNREFUSED and exited 1 once per tool call.
  const sandbox = await startSandboxDaemon();
  context.after(() => stopSandbox(sandbox));

  sandbox.daemon.kill("SIGKILL");
  await new Promise((resolve) => sandbox.daemon.on("exit", resolve));
  assert.ok(fs.existsSync(sandbox.socketPath), "SIGKILL leaves the socket behind");

  const forwarder = spawn(process.execPath, [path.join(sandbox.directory, "dist", "event.js")], {
    env: { ...process.env, CLAUDE_MICRO_SOCKET: sandbox.socketPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  forwarder.stderr.on("data", (chunk) => (stderr += chunk));
  forwarder.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "orphaned" }));
  const exitCode: number = await new Promise((resolve) => forwarder.on("exit", (code) => resolve(code ?? -1)));

  assert.equal(exitCode, 0, "a dead bridge is a normal state, not a per-tool-call error");
  assert.equal(stderr.trim(), "");
});
