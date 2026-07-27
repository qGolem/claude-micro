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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const HID_STUB = `import { EventEmitter } from "node:events";

export function devices() {
  return [{ vendorId: 0x303a, productId: 0x8360, usagePage: 0xff00, path: "stub-device" }];
}

export class HIDAsync extends EventEmitter {
  static async open() {
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
  async write(packet) { return packet.length; }
  async read() { return null; }
  async close() {}
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

async function startSandboxDaemon(): Promise<Sandbox> {
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
      CLAUDE_MICRO_AGENT_HOLD_MS: "400",
      CLAUDE_MICRO_TEST_TMUX_LOG: tmuxLogPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  daemon.stdout.resume();
  daemon.stderr.resume();

  await waitFor(() => fs.existsSync(socketPath), "the daemon socket");
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
  assert.match(fs.readFileSync(sandbox.tmuxLogPath, "utf8"), /cleared Agent Key 1/);
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
