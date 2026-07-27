import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every script that reads the pid file must verify the process is actually
// this bridge before signalling it: pid files go stale on crash/reboot and
// PIDs are reused. Previously only reset was covered, and stop lacked the
// guard entirely — a documented cleanup step could SIGTERM a bystander.
for (const scriptName of ["tmux-reset-bridge.sh", "tmux-stop-bridge.sh"]) {
  test(`${scriptName} does not signal an unrelated process referenced by a stale PID file`, (context) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-lifecycle-"));
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

    const pluginRoot = path.join(temporary, "plugin");
    const scripts = path.join(pluginRoot, "src");
    fs.mkdirSync(scripts, { recursive: true });
    const script = path.join(scripts, scriptName);
    fs.copyFileSync(path.join(root, "src", scriptName), script);
    fs.chmodSync(script, 0o755);
    // Reset chains into start; give it a stub that only records the call.
    const marker = path.join(temporary, "start-marker");
    fs.writeFileSync(path.join(scripts, "tmux-start-bridge.sh"), `#!/bin/zsh\nprint started > '${marker}'\n`, { mode: 0o755 });

    const unrelated = spawn("sleep", ["30"]);
    context.after(() => unrelated.kill());
    const pidPath = path.join(temporary, "bridge.pid");
    fs.writeFileSync(pidPath, `${unrelated.pid}\n`);
    const environment = {
      ...process.env,
      CLAUDE_MICRO_PID: pidPath,
      CLAUDE_MICRO_SOCKET: path.join(temporary, "bridge.sock"),
      CLAUDE_MICRO_HEALTH: path.join(temporary, "bridge-health.json"),
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
