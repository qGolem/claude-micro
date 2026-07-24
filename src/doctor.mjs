import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findCodexMicros } from "./micro.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const socketPath = process.env.CLAUDE_MICRO_SOCKET ?? "/private/tmp/claude-micro.sock";
const healthPath = process.env.CLAUDE_MICRO_HEALTH ?? "/private/tmp/claude-micro-health.json";
const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const entrypoint = path.join(root, "tmux", "claude-micro.tmux");

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

let hooksInstalled = false;
try {
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  hooksInstalled = Object.values(settings.hooks ?? {}).some((groups) =>
    Array.isArray(groups) && groups.some((group) => group?.hooks?.some((hook) => hook?.command?.includes("claude-micro/src/event.mjs"))),
  );
} catch {
  // Report below.
}
report(hooksInstalled, "Claude Code hooks", hooksInstalled ? settingsPath : "run npm run install-plugin");

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
