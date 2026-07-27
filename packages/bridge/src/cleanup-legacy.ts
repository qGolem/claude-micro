import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Compiled location is packages/bridge/dist; the package root is one up.
const root = path.resolve(here, "..");
const tmuxConfig = process.argv[2] ?? path.join(os.homedir(), ".config", "tmux", "tmux.conf");
const settingsPath = process.argv[3] ?? path.join(os.homedir(), ".claude", "settings.json");
const markerStart = "# >>> claude-micro >>>";
const markerEnd = "# <<< claude-micro <<<";
const hookMarker = "claude-micro/src/event.mjs";

function atomicWrite(pathname: string, content: string): void {
  const temporary = `${pathname}.claude-micro-${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, pathname);
}

if (fs.existsSync(tmuxConfig)) {
  const content = fs.readFileSync(tmuxConfig, "utf8");
  const escapeForRegex = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`\\n?${escapeForRegex(markerStart)}[\\s\\S]*?${escapeForRegex(markerEnd)}\\n?`, "g");
  atomicWrite(tmuxConfig, `${content.replace(expression, "").trimEnd()}\n`);
}

interface HookGroup {
  hooks?: Array<{ command?: unknown }>;
}

if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, unknown> };
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    settings.hooks![event] = (groups as HookGroup[]).filter(
      (group) => !group?.hooks?.some((hook) => typeof hook?.command === "string" && hook.command.includes(hookMarker)),
    );
  }
  atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

try {
  execFileSync(path.join(root, "src", "tmux-stop-bridge.sh"), [], { stdio: "ignore", env: process.env });
} catch {
  // It is safe for removal to continue when tmux/the bridge is not running.
}

console.log("Removed the 0.1.x Claude Micro tmux config block and settings.json hooks.");
console.log("The old copied runtime under ~/.config/tmux/plugins/claude-micro can be deleted once TPM manages the plugin.");
