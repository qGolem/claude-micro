import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, "..");
const destination = process.argv[2] ?? path.join(os.homedir(), ".config", "tmux", "plugins", "claude-micro");
const tmuxConfig = process.argv[3] ?? path.join(os.homedir(), ".config", "tmux", "tmux.conf");
const bootstrapConfig = process.argv[4] ?? path.join(os.homedir(), ".tmux.conf");

function tmuxQuote(value) {
  return value.replaceAll("'", "'\\\"'\\\"'");
}

function currentStatusLeft() {
  try {
    return execFileSync("tmux", ["show-options", "-gqv", "status-left"], { encoding: "utf8" }).trim();
  } catch {
    return "#S";
  }
}

fs.mkdirSync(destination, { recursive: true });
fs.cpSync(path.join(sourceRoot, "src"), path.join(destination, "src"), { recursive: true, force: true, dereference: false });
for (const script of ["tmux-start-bridge.sh", "tmux-reset-bridge.sh"]) {
  fs.chmodSync(path.join(destination, "src", script), 0o755);
}
if (!fs.existsSync(path.join(destination, "node_modules"))) {
  if (!fs.existsSync(path.join(sourceRoot, "node_modules"))) {
    throw new Error("Dependencies are not installed. Run npm install in the plugin repository first.");
  }
  fs.cpSync(path.join(sourceRoot, "node_modules"), path.join(destination, "node_modules"), { recursive: true, dereference: false });
}
for (const name of ["package.json", "package-lock.json", "README.md"]) {
  fs.copyFileSync(path.join(sourceRoot, name), path.join(destination, name));
}

const sourceLine = `source-file ${path.join(destination, "tmux", "claude-micro.tmux")}`;
fs.mkdirSync(path.join(destination, "tmux"), { recursive: true });
const statusScript = path.join(destination, "src", "tmux-status.mjs");
const statusCommand = `#(node ${statusScript})`;
const existingStatus = currentStatusLeft();
const legacyStatusCommand = `#(${statusScript})`;
const statusWithoutLegacy = existingStatus
  .replaceAll(` ${legacyStatusCommand}`, "")
  .replaceAll(legacyStatusCommand, "")
  .trim();
const previousStatus = statusWithoutLegacy.endsWith(` ${statusCommand}`)
  ? statusWithoutLegacy.slice(0, -(statusCommand.length + 1))
  : statusWithoutLegacy.startsWith(`${statusCommand} `)
    ? statusWithoutLegacy.slice(statusCommand.length + 1)
    : statusWithoutLegacy || "#S";
const bindings = `# Work Louder Codex Micro / Claude Code tmux integration\nrun-shell -b '${path.join(destination, "src", "tmux-start-bridge.sh")}'\n# Connected = green; reconnecting = amber; stopped = red.\nset-option -g status-interval 2\nset-option -g status-left '${tmuxQuote(`${previousStatus} ${statusCommand}`)}'\n# Prefix + Shift-R resets only the Claude Micro bridge.\nbind-key R run-shell -b '${path.join(destination, "src", "tmux-reset-bridge.sh")}'\n${[1, 2, 3, 4, 5, 6].map((key, slot) => `bind-key -n M-${key} run-shell 'node ${path.join(destination, "src", "focus-slot.mjs")} ${slot}'`).join("\n")}\n`;
fs.writeFileSync(path.join(destination, "tmux", "claude-micro.tmux"), bindings, "utf8");

let config = fs.existsSync(tmuxConfig) ? fs.readFileSync(tmuxConfig, "utf8") : "";
config = config
  .split("\n")
  .filter((line) => !line.includes("claude-micro.tmux"))
  .join("\n")
  .trimEnd();
fs.mkdirSync(path.dirname(tmuxConfig), { recursive: true });
fs.writeFileSync(tmuxConfig, `${config}\n\n# Codex Micro → Claude Code tmux focus\n${sourceLine}\n`, "utf8");

const bootstrapLine = `source-file ${tmuxConfig}`;
let bootstrap = fs.existsSync(bootstrapConfig) ? fs.readFileSync(bootstrapConfig, "utf8") : "";
if (!bootstrap.split("\n").some((line) => line.trim() === bootstrapLine)) {
  fs.writeFileSync(bootstrapConfig, `${bootstrap.trimEnd()}\n\n# Load the primary tmux configuration (including Claude Micro).\n${bootstrapLine}\n`, "utf8");
}

// Install hooks from the copied plugin so they continue to work if the source
// checkout is later moved or removed.
execFileSync(process.execPath, [path.join(destination, "src", "install-hooks.mjs")], { stdio: "inherit" });

console.log(`Installed tmux plugin: ${destination}`);
console.log(`Updated tmux config: ${tmuxConfig}`);
console.log(`Bootstrapped tmux startup: ${bootstrapConfig}`);
