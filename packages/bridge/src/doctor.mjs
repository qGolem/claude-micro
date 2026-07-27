import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findCodexMicros } from "./micro.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const repoRoot = path.resolve(root, "..", "..");
const socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
const healthPath = process.env.CLAUDE_MICRO_HEALTH ?? "/private/tmp/claude-micro-health.json";
const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const installedPluginsPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
const entrypoint = path.join(repoRoot, "claude-micro.tmux");

let failed = false;
function report(ok, label, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

report(Number(process.versions.node.split(".")[0]) >= 20, "Node.js 20+", process.version);
try {
  report(Boolean(execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim()), "tmux available");
} catch {
  report(false, "tmux available");
}

const devices = findCodexMicros();
report(devices.length > 0, "Codex Micro vendor HID interface", devices.length ? `${devices.length} detected` : "connect by USB and grant Input Monitoring");
report(fs.existsSync(entrypoint), "tmux plugin entrypoint", entrypoint);
report(fs.existsSync(path.join(root, "node_modules", "node-hid")), "Bridge dependencies", fs.existsSync(path.join(root, "node_modules", "node-hid")) ? "node-hid installed" : `run pnpm install in ${repoRoot}`);

function readJson(pathname) {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}

const settings = readJson(settingsPath) ?? {};
const installedPlugins = readJson(installedPluginsPath)?.plugins ?? {};
const isMicroPlugin = ([key, value]) => key.startsWith("claude-micro@") && Boolean(value);
const pluginEnabled = Object.entries(settings.enabledPlugins ?? {}).some(isMicroPlugin) || Object.entries(installedPlugins).some(isMicroPlugin);
report(pluginEnabled, "Claude Code plugin", pluginEnabled ? "claude-micro hooks enabled" : "install with /plugin marketplace add + /plugin install claude-micro");

const legacyHooks = Object.values(settings.hooks ?? {}).some((groups) =>
  Array.isArray(groups) && groups.some((group) => group?.hooks?.some((hook) => hook?.command?.includes("claude-micro/src/event.mjs"))),
);
report(!legacyHooks, "No legacy 0.1.x hooks", legacyHooks ? "run npm run cleanup-legacy to remove duplicates" : "");

let health;
try {
  health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
} catch {
  health = null;
}
report(Boolean(health), "Bridge health file", health ? `${health.state} at ${health.updatedAt}` : "bridge has not started yet");

const bridgeProbe = await new Promise((resolve) => {
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
  client.on("data", (data) => {
    response += data;
  });
  client.once("end", () => {
    clearTimeout(timer);
    try {
      const result = JSON.parse(response);
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
