import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Logging is opt-in. These drive the real start script but substitute a fake
// node binary, so no daemon is launched and the HID device is never opened.
for (const [name, enableLogging] of [
  ["writes no log by default", false],
  ["writes a log when CLAUDE_MICRO_LOG is set", true],
] as const) {
  test(`tmux-start-bridge.sh ${name}`, (context) => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "claude-micro-logging-"),
    );
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

    const fakeNode = path.join(temporary, "fake-node");
    fs.writeFileSync(fakeNode, "#!/bin/sh\nprintf 'daemon output line\\n'\n", {
      mode: 0o755,
    });
    const logPath = path.join(temporary, "daemon.log");
    const pidPath = path.join(temporary, "bridge.pid");

    execFileSync("zsh", [path.join(root, "src", "tmux-start-bridge.sh")], {
      env: {
        ...process.env,
        CLAUDE_MICRO_NODE: fakeNode,
        CLAUDE_MICRO_PID: pidPath,
        CLAUDE_MICRO_SOCKET: path.join(temporary, "bridge.sock"),
        CLAUDE_MICRO_HEALTH: path.join(temporary, "health.json"),
        CLAUDE_MICRO_DEVICE_LOCK: path.join(temporary, "device.lock"),
        ...(enableLogging
          ? { CLAUDE_MICRO_LOG: logPath }
          : { CLAUDE_MICRO_LOG: "" }),
      },
    });
    // The fake daemon exits immediately; give the redirection a moment to land.
    execFileSync("sleep", ["0.3"]);

    assert.ok(fs.existsSync(pidPath), "the launcher still records a pid");
    assert.equal(
      fs.existsSync(logPath),
      enableLogging,
      enableLogging
        ? "log captured when asked"
        : "no log file created by default",
    );
    if (enableLogging)
      assert.match(fs.readFileSync(logPath, "utf8"), /daemon output line/);
  });
}

test("tmux-start-bridge.sh rotates an oversized log instead of growing it", (context) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "claude-micro-rotate-"),
  );
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  const fakeNode = path.join(temporary, "fake-node");
  fs.writeFileSync(fakeNode, "#!/bin/sh\nprintf 'fresh\\n'\n", { mode: 0o755 });
  const logPath = path.join(temporary, "daemon.log");
  fs.writeFileSync(logPath, "x".repeat(5_000));

  execFileSync("zsh", [path.join(root, "src", "tmux-start-bridge.sh")], {
    env: {
      ...process.env,
      CLAUDE_MICRO_NODE: fakeNode,
      CLAUDE_MICRO_PID: path.join(temporary, "bridge.pid"),
      CLAUDE_MICRO_SOCKET: path.join(temporary, "bridge.sock"),
      CLAUDE_MICRO_HEALTH: path.join(temporary, "health.json"),
      CLAUDE_MICRO_DEVICE_LOCK: path.join(temporary, "device.lock"),
      CLAUDE_MICRO_LOG: logPath,
      CLAUDE_MICRO_MAX_LOG_BYTES: "1024",
    },
  });
  execFileSync("sleep", ["0.3"]);

  assert.equal(
    fs.readFileSync(`${logPath}.1`, "utf8").length,
    5_000,
    "previous generation kept",
  );
  assert.ok(fs.statSync(logPath).size < 1_000, "current log restarted small");
});

// Every script that reads the pid file must verify the process is actually
// this bridge before signalling it: pid files go stale on crash/reboot and
// PIDs are reused. Previously only reset was covered, and stop lacked the
// guard entirely — a documented cleanup step could SIGTERM a bystander.
for (const scriptName of ["tmux-reset-bridge.sh", "tmux-stop-bridge.sh"]) {
  test(`${scriptName} does not signal an unrelated process referenced by a stale PID file`, (context) => {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "claude-micro-lifecycle-"),
    );
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

    const pluginRoot = path.join(temporary, "plugin");
    const scripts = path.join(pluginRoot, "src");
    fs.mkdirSync(scripts, { recursive: true });
    const script = path.join(scripts, scriptName);
    fs.copyFileSync(path.join(root, "src", scriptName), script);
    fs.chmodSync(script, 0o755);
    // The scripts source their shared pid-identification helper from alongside.
    fs.copyFileSync(
      path.join(root, "src", "bridge-pid.sh"),
      path.join(scripts, "bridge-pid.sh"),
    );
    // Reset chains into start; give it a stub that only records the call.
    const marker = path.join(temporary, "start-marker");
    fs.writeFileSync(
      path.join(scripts, "tmux-start-bridge.sh"),
      `#!/bin/zsh\nprint started > '${marker}'\n`,
      { mode: 0o755 },
    );

    const unrelated = spawn("sleep", ["30"]);
    context.after(() => unrelated.kill());
    const pidPath = path.join(temporary, "bridge.pid");
    fs.writeFileSync(pidPath, `${unrelated.pid}\n`);
    const environment = {
      ...process.env,
      CLAUDE_MICRO_PID: pidPath,
      CLAUDE_MICRO_SOCKET: path.join(temporary, "bridge.sock"),
      CLAUDE_MICRO_HEALTH: path.join(temporary, "bridge-health.json"),
      CLAUDE_MICRO_DEVICE_LOCK: path.join(temporary, "device.lock"),
    };

    execFileSync("zsh", [script], { env: environment });
    assert.doesNotThrow(
      () => process.kill(unrelated.pid!, 0),
      `${scriptName} killed a process that is not the bridge`,
    );
    if (scriptName === "tmux-reset-bridge.sh") {
      assert.equal(fs.readFileSync(marker, "utf8").trim(), "started");
    }
  });
}
