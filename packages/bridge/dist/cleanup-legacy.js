// src/cleanup-legacy.ts
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
var here = path.dirname(fileURLToPath(import.meta.url));
var root = path.resolve(here, "..");
var tmuxConfig = process.argv[2] ?? path.join(os.homedir(), ".config", "tmux", "tmux.conf");
var settingsPath = process.argv[3] ?? path.join(os.homedir(), ".claude", "settings.json");
var markerStart = "# >>> claude-micro >>>";
var markerEnd = "# <<< claude-micro <<<";
var hookMarker = "claude-micro/src/event.mjs";
function atomicWrite(pathname, content) {
  const temporary = `${pathname}.claude-micro-${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, pathname);
}
if (fs.existsSync(tmuxConfig)) {
  const content = fs.readFileSync(tmuxConfig, "utf8");
  const escapeForRegex = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`\\n?${escapeForRegex(markerStart)}[\\s\\S]*?${escapeForRegex(markerEnd)}\\n?`, "g");
  atomicWrite(tmuxConfig, `${content.replace(expression, "").trimEnd()}
`);
}
if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.filter(
      (group) => !group?.hooks?.some((hook) => typeof hook?.command === "string" && hook.command.includes(hookMarker))
    );
  }
  atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}
`);
}
try {
  execFileSync(path.join(root, "src", "tmux-stop-bridge.sh"), [], { stdio: "ignore", env: process.env });
} catch {
}
console.log("Removed the 0.1.x Claude Micro tmux config block and settings.json hooks.");
console.log("The old copied runtime under ~/.config/tmux/plugins/claude-micro can be deleted once TPM manages the plugin.");
