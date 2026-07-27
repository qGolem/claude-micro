import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stateForHook } from "../src/state";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(root, "..", "..");

interface HookDefinition {
  type?: string;
  command?: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookDefinition[];
}

const hooksConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "hooks", "hooks.json"), "utf8")) as {
  hooks: Record<string, HookGroup[]>;
};
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "plugin.json"), "utf8")) as {
  name: string;
};
const marketplace = JSON.parse(fs.readFileSync(path.join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8")) as {
  plugins: Array<{ name: string; source: string }>;
};

test("hooks.json forwards every lifecycle event the bridge maps to a key state", () => {
  const expected = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "Notification",
    "PermissionRequest",
    "SessionEnd",
  ];
  assert.deepEqual(Object.keys(hooksConfig.hooks).sort(), [...expected].sort());

  for (const [event, groups] of Object.entries(hooksConfig.hooks)) {
    assert.ok(Array.isArray(groups) && groups.length === 1, `${event} has one hook group`);
    const [group] = groups;
    for (const hook of group!.hooks) {
      assert.equal(hook.type, "command");
      assert.match(hook.command ?? "", /\$\{CLAUDE_PLUGIN_ROOT\}\/packages\/bridge\/dist\/event\.js/, `${event} runs the built event forwarder via CLAUDE_PLUGIN_ROOT`);
    }
    // Every forwarded event must resolve to a lighting state in the daemon.
    const sample = { hook_event_name: event, ...(event === "PreToolUse" ? { tool_name: "AskUserQuestion" } : {}) };
    assert.notEqual(stateForHook(sample), null, `${event} maps to a key state`);
  }

  // PreToolUse fires for every tool; the plugin only needs the AskUserQuestion
  // early-warning, so the matcher must stay scoped to that tool.
  assert.equal(hooksConfig.hooks.PreToolUse![0]!.matcher, "AskUserQuestion");
});

test("plugin manifest and marketplace entry agree", () => {
  assert.equal(manifest.name, "claude-micro");
  const entry = marketplace.plugins.find((plugin) => plugin.name === manifest.name);
  assert.ok(entry, "marketplace lists the plugin");
  assert.equal(entry.source, "./");
});

test("tmux entrypoint lives at the repository root and is executable", () => {
  const entrypoint = path.join(repoRoot, "claude-micro.tmux");
  assert.ok(fs.statSync(entrypoint).mode & 0o111);
});

test("the built event forwarder exists where the hooks point", () => {
  assert.ok(fs.existsSync(path.join(root, "dist", "event.js")), "run pnpm run build first");
});

test("cleanup-legacy removes the 0.1.x tmux block and settings hooks, preserving the rest", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-micro-cleanup-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  const config = path.join(temporary, "tmux.conf");
  fs.writeFileSync(config, [
    "set -g status-left 'theme-owned'",
    "# >>> claude-micro >>>",
    "run-shell '/old/claude-micro/tmux/claude-micro.tmux'",
    "# <<< claude-micro <<<",
    "",
  ].join("\n"), "utf8");

  const settings = path.join(temporary, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: "'/usr/bin/node' '/old/claude-micro/src/event.mjs' # claude-micro:Stop" }] },
        { hooks: [{ type: "command", command: "echo user-owned" }] },
      ],
    },
  }), "utf8");

  execFileSync(process.execPath, [path.join(root, "dist", "cleanup-legacy.js"), config, settings], {
    cwd: root,
    env: {
      ...process.env,
      CLAUDE_MICRO_PID: path.join(temporary, "bridge.pid"),
      CLAUDE_MICRO_SOCKET: path.join(temporary, "bridge.sock"),
      CLAUDE_MICRO_HEALTH: path.join(temporary, "bridge-health.json"),
    },
    stdio: "pipe",
  });

  const cleanedConfig = fs.readFileSync(config, "utf8");
  assert.match(cleanedConfig, /theme-owned/);
  assert.doesNotMatch(cleanedConfig, /claude-micro/);

  const cleanedSettings = JSON.parse(fs.readFileSync(settings, "utf8")) as {
    hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
  };
  assert.equal(cleanedSettings.hooks.Stop.length, 1);
  assert.match(cleanedSettings.hooks.Stop[0]!.hooks[0]!.command, /user-owned/);
});
