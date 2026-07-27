import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("reset does not signal an unrelated process referenced by a stale PID file", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-reset-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  const pluginRoot = path.join(temporary, "plugin");
  const scripts = path.join(pluginRoot, "src");
  fs.mkdirSync(scripts, { recursive: true });
  const reset = path.join(scripts, "tmux-reset-bridge.sh");
  fs.copyFileSync(path.join(root, "src", "tmux-reset-bridge.sh"), reset);
  fs.chmodSync(reset, 0o755);
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

  execFileSync("zsh", [reset], { env: environment });
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "started");
  assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
});
