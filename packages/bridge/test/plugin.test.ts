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

// Claude Code installs this plugin by cloning the repo and runs the hooks with
// no build or install step, so asserting the file merely EXISTS is meaningless
// here — `pnpm test` builds it first. What matters is that it is committed.
test("every hook target is committed, not just built locally", () => {
  const hookTargets = new Set<string>();
  for (const groups of Object.values(hooksConfig.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const match = /\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+?\.js)/.exec(hook.command ?? "");
        if (match) hookTargets.add(match[1]!);
      }
    }
  }
  assert.ok(hookTargets.size > 0, "hooks.json references at least one built file");

  for (const target of hookTargets) {
    assert.ok(fs.existsSync(path.join(repoRoot, target)), `${target} exists (run pnpm run build)`);
    const tracked = execFileSync("git", ["ls-files", "--error-unmatch", target], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    assert.equal(tracked, target, `${target} is committed — a cloned plugin has no build step`);
  }
});

test("the committed bridge build is not stale", () => {
  // A stale dist/ ships old behavior to every plugin user, and nothing else in
  // the suite would notice: the tests import from src/.
  execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "pipe" });
  const status = execFileSync("git", ["status", "--porcelain", "--", "packages/bridge/dist"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  // Column 2 is the worktree state: a rebuild that changed nothing leaves it
  // clean. Staged-but-uncommitted adds ("A ") are fine; modified ("?M"/" M")
  // or untracked ("??") output means the committed build is stale.
  const drifted = status
    .split("\n")
    .filter((line) => line.length > 2 && (line.startsWith("??") || line[1] !== " "));
  assert.deepEqual(drifted, [], `rebuild changed the build output — run pnpm run build and commit:\n${drifted.join("\n")}`);
});

test("the event forwarder runs with no node_modules present", () => {
  // The plugin cache has no install step, so dist/event.js must not import
  // anything outside node: builtins.
  const built = fs.readFileSync(path.join(root, "dist", "event.js"), "utf8");
  const imports = [...built.matchAll(/from\s*"([^"]+)"/g)].map((match) => match[1]!);
  const external = imports.filter((specifier) => !specifier.startsWith("node:") && !/^(fs|net|path|os|child_process|url|timers)$/.test(specifier));
  assert.deepEqual(external, [], "event.js must bundle everything except node builtins");
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
