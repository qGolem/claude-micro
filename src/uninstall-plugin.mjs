import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmuxConfig = process.argv[2] ?? path.join(os.homedir(), ".config", "tmux", "tmux.conf");
const settingsPath = process.argv[3] ?? path.join(os.homedir(), ".claude", "settings.json");
const markerStart = "# >>> claude-micro >>>";
const markerEnd = "# <<< claude-micro <<<";
const hookMarker = "claude-micro/src/event.mjs";

function atomicWrite(pathname, content) {
  const temporary = `${pathname}.claude-micro-${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, pathname);
}

if (fs.existsSync(tmuxConfig)) {
  const content = fs.readFileSync(tmuxConfig, "utf8");
  const expression = new RegExp(`\\n?${markerStart.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}[\\s\\S]*?${markerEnd.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\n?`, "g");
  atomicWrite(tmuxConfig, `${content.replace(expression, "").trimEnd()}\n`);
}

if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.filter((group) => !group?.hooks?.some((hook) => typeof hook?.command === "string" && hook.command.includes(hookMarker)));
  }
  atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

try {
  execFileSync(path.join(root, "src", "tmux-stop-bridge.sh"), [], { stdio: "ignore", env: process.env });
} catch {
  // It is safe for removal to continue when tmux/the bridge is not running.
}

console.log("Removed Claude Micro tmux config block and Claude Code hooks.");
console.log("Restart tmux to clear the currently loaded binding, then remove the plugin directory if desired.");
