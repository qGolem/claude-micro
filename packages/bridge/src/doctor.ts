import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findCodexMicros } from "./micro";

const here = path.dirname(fileURLToPath(import.meta.url));
// Compiled location is packages/bridge/dist; the package root is one up and
// the repository root two more.
const root = path.resolve(here, "..");
const repoRoot = path.resolve(root, "..", "..");
const socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
const healthPath = process.env.CLAUDE_MICRO_HEALTH ?? "/private/tmp/claude-micro-health.json";
const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const installedPluginsPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
const entrypoint = path.join(repoRoot, "claude-micro.tmux");

let failed = false;
function report(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

report(Number(process.versions.node.split(".")[0]) >= 20, "Node.js 20+", process.version);
try {
  report(Boolean(execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim()), "tmux available");
} catch {
  report(false, "tmux available");
}

const foundDevices = findCodexMicros();
report(foundDevices.length > 0, "Codex Micro vendor HID interface", foundDevices.length ? `${foundDevices.length} detected` : "connect by USB and grant Input Monitoring");
report(fs.existsSync(entrypoint), "tmux plugin entrypoint", entrypoint);
const dependenciesInstalled = fs.existsSync(path.join(root, "node_modules", "node-hid"));
report(dependenciesInstalled, "Bridge dependencies", dependenciesInstalled ? "node-hid installed" : `run pnpm install in ${repoRoot}`);
const bridgeBuilt = fs.existsSync(path.join(root, "dist", "daemon.js"));
report(bridgeBuilt, "Bridge built", bridgeBuilt ? "dist/daemon.js present" : `run pnpm run build in ${repoRoot}`);

function readJson(pathname: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const settings = readJson(settingsPath) ?? {};
const installedPlugins = (readJson(installedPluginsPath)?.plugins ?? {}) as Record<string, unknown>;
const isMicroPlugin = ([key, value]: [string, unknown]) => key.startsWith("claude-micro@") && Boolean(value);
const enabledPlugins = (settings.enabledPlugins ?? {}) as Record<string, unknown>;
const pluginEnabled = Object.entries(enabledPlugins).some(isMicroPlugin) || Object.entries(installedPlugins).some(isMicroPlugin);
report(pluginEnabled, "Claude Code plugin", pluginEnabled ? "claude-micro hooks enabled" : "install with /plugin marketplace add + /plugin install claude-micro");

interface HookGroup {
  hooks?: Array<{ command?: unknown }>;
}
const settingsHooks = (settings.hooks ?? {}) as Record<string, unknown>;
const legacyHooks = Object.values(settingsHooks).some((groups) =>
  Array.isArray(groups) && (groups as HookGroup[]).some((group) =>
    group?.hooks?.some((hook) => typeof hook?.command === "string" && hook.command.includes("claude-micro/src/event.mjs")),
  ),
);
report(!legacyHooks, "No legacy 0.1.x hooks", legacyHooks ? "run pnpm run cleanup-legacy to remove duplicates" : "");

let health: { state?: string; updatedAt?: string } | null;
try {
  health = JSON.parse(fs.readFileSync(healthPath, "utf8")) as { state?: string; updatedAt?: string };
} catch {
  health = null;
}
report(Boolean(health), "Bridge health file", health ? `${health.state} at ${health.updatedAt}` : "bridge has not started yet");

const bridgeProbe = await new Promise<{ state?: string } | null>((resolve) => {
  const client = net.createConnection(socketPath);
  let response = "";
  const timer = setTimeout(() => {
    client.destroy();
    resolve(null);
  }, 750);
  client.once("connect", () => {
    client.end(JSON.stringify({ op: "claude-micro.health" }));
  });
  client.setEncoding("utf8");
  client.on("data", (data: string) => {
    response += data;
  });
  client.once("end", () => {
    clearTimeout(timer);
    try {
      const result = JSON.parse(response) as { ok?: boolean; state?: string };
      resolve(result?.ok === true ? result : null);
    } catch {
      resolve(null);
    }
  });
  client.once("error", () => {
    clearTimeout(timer);
    resolve(null);
  });
});
report(Boolean(bridgeProbe), "Bridge socket", bridgeProbe ? `${socketPath} (${bridgeProbe.state})` : "press Prefix + k after starting tmux");

if (failed) process.exitCode = 1;
