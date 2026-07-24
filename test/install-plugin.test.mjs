import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "src", "install-plugin.mjs");
const uninstaller = path.join(root, "src", "uninstall-plugin.mjs");

test("plugin installer is idempotent and preserves unrelated tmux config", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-install-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, "plugin");
  const config = path.join(temporary, "tmux.conf");
  const bootstrap = path.join(temporary, ".tmux.conf");
  fs.writeFileSync(config, "set -g status-left 'theme-owned'\n", "utf8");

  const environment = {
    ...process.env,
    HOME: temporary,
    CLAUDE_MICRO_PID: path.join(temporary, "bridge.pid"),
    CLAUDE_MICRO_SOCKET: path.join(temporary, "bridge.sock"),
    CLAUDE_MICRO_HEALTH: path.join(temporary, "bridge-health.json"),
  };
  const run = () => execFileSync(process.execPath, [installer, destination, config, bootstrap], {
    cwd: root,
    env: environment,
    stdio: "pipe",
  });
  run();
  run();

  const installed = fs.readFileSync(config, "utf8");
  assert.match(installed, /set -g status-left 'theme-owned'/);
  assert.equal((installed.match(/# >>> claude-micro >>>/g) ?? []).length, 1);
  assert.equal((installed.match(/run-shell '/g) ?? []).length, 1);
  assert.equal(fs.readFileSync(path.join(destination, ".claude-micro-node"), "utf8").trim(), process.execPath);
  assert.ok(fs.statSync(path.join(destination, "tmux", "claude-micro.tmux")).mode & 0o111);

  const settings = path.join(temporary, ".claude", "settings.json");
  execFileSync(process.execPath, [uninstaller, config, settings], { cwd: root, env: environment, stdio: "pipe" });
  assert.doesNotMatch(fs.readFileSync(config, "utf8"), /# >>> claude-micro >>>/);
  assert.doesNotMatch(fs.readFileSync(settings, "utf8"), /claude-micro\/src\/event\.mjs/);
});
