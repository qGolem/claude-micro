import {
  findCodexMicros
} from "./chunk-ZKFY4ZTV.js";

// src/doctor.ts
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
var here = path.dirname(fileURLToPath(import.meta.url));
var root = path.resolve(here, "..");
var repoRoot = path.resolve(root, "..", "..");
var socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
var healthPath = process.env.CLAUDE_MICRO_HEALTH ?? "/private/tmp/claude-micro-health.json";
var settingsPath = path.join(os.homedir(), ".claude", "settings.json");
var installedPluginsPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
var entrypoint = path.join(repoRoot, "claude-micro.tmux");
var failed = false;
function report(ok, label, detail = "") {
  console.log(`${ok ? "\u2713" : "\u2717"} ${label}${detail ? ` \u2014 ${detail}` : ""}`);
  if (!ok) failed = true;
}
report(Number(process.versions.node.split(".")[0]) >= 20, "Node.js 20+", process.version);
try {
  report(Boolean(execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim()), "tmux available");
} catch {
  report(false, "tmux available");
}
var foundDevices = findCodexMicros();
report(foundDevices.length > 0, "Codex Micro vendor HID interface", foundDevices.length ? `${foundDevices.length} detected` : "connect by USB and grant Input Monitoring");
report(fs.existsSync(entrypoint), "tmux plugin entrypoint", entrypoint);
var dependenciesInstalled = fs.existsSync(path.join(root, "node_modules", "node-hid"));
report(dependenciesInstalled, "Bridge dependencies", dependenciesInstalled ? "node-hid installed" : `run pnpm install in ${repoRoot}`);
var bridgeBuilt = fs.existsSync(path.join(root, "dist", "daemon.js"));
report(bridgeBuilt, "Bridge built", bridgeBuilt ? "dist/daemon.js present" : `run pnpm run build in ${repoRoot}`);
function readJson(pathname) {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return null;
  }
}
var settings = readJson(settingsPath) ?? {};
var installedPlugins = readJson(installedPluginsPath)?.plugins ?? {};
var isMicroPlugin = ([key, value]) => key.startsWith("claude-micro@") && Boolean(value);
var enabledPlugins = settings.enabledPlugins ?? {};
var pluginEnabled = Object.entries(enabledPlugins).some(isMicroPlugin) || Object.entries(installedPlugins).some(isMicroPlugin);
report(pluginEnabled, "Claude Code plugin", pluginEnabled ? "claude-micro hooks enabled" : "install with /plugin marketplace add + /plugin install claude-micro");
var settingsHooks = settings.hooks ?? {};
var legacyHooks = Object.values(settingsHooks).some(
  (groups) => Array.isArray(groups) && groups.some(
    (group) => group?.hooks?.some((hook) => typeof hook?.command === "string" && hook.command.includes("claude-micro/src/event.mjs"))
  )
);
report(!legacyHooks, "No legacy 0.1.x hooks", legacyHooks ? "run pnpm run cleanup-legacy to remove duplicates" : "");
var health;
try {
  health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
} catch {
  health = null;
}
report(Boolean(health), "Bridge health file", health ? `${health.state} at ${health.updatedAt}` : "bridge has not started yet");
var bridgeProbe = await new Promise((resolve) => {
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
