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
const markerStart = "# >>> claude-micro >>>";
const markerEnd = "# <<< claude-micro <<<";

function read(pathname) {
  try {
    return fs.readFileSync(pathname, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function atomicWrite(pathname, content) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const temporary = `${pathname}.claude-micro-${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, pathname);
}

function backupOnce(pathname) {
  const backup = `${pathname}.before-claude-micro`;
  if (fs.existsSync(pathname) && !fs.existsSync(backup)) fs.copyFileSync(pathname, backup);
}

function managedBlock(content, block) {
  const expression = new RegExp(`\\n?${markerStart.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}[\\s\\S]*?${markerEnd.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\n?`, "g");
  return `${content.replace(expression, "").trimEnd()}\n\n${markerStart}\n${block}\n${markerEnd}\n`;
}

if (!fs.existsSync(path.join(sourceRoot, "node_modules"))) {
  throw new Error("Dependencies are not installed. Run npm install in the plugin repository first.");
}

fs.mkdirSync(destination, { recursive: true });
for (const directory of ["src", "tmux", "node_modules"]) {
  fs.cpSync(path.join(sourceRoot, directory), path.join(destination, directory), {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });
}
for (const name of ["package.json", "package-lock.json", "README.md"]) {
  const source = path.join(sourceRoot, name);
  // npm packages omit package-lock.json. It is useful for a source checkout,
  // but the already-installed node_modules runtime does not require it.
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, name));
}
for (const script of ["tmux-start-bridge.sh", "tmux-reset-bridge.sh", "tmux-stop-bridge.sh"]) {
  fs.chmodSync(path.join(destination, "src", script), 0o755);
}
fs.chmodSync(path.join(destination, "tmux", "claude-micro.tmux"), 0o755);
const nodePathFile = path.join(destination, ".claude-micro-node");
const installedNode = read(nodePathFile).trim();
const nodePath = process.env.CLAUDE_MICRO_NODE || (installedNode && fs.existsSync(installedNode) ? installedNode : process.execPath);
atomicWrite(nodePathFile, `${nodePath}\n`);

const entrypoint = path.join(destination, "tmux", "claude-micro.tmux");
const tmuxBlock = `run-shell '${entrypoint}'`;
const legacySourceLine = `source-file ${entrypoint}`;
const config = read(tmuxConfig)
  .split("\n")
  .filter((line) => line.trim() !== legacySourceLine && line.trim() !== "# Codex Micro → Claude Code tmux focus")
  .join("\n");
backupOnce(tmuxConfig);
atomicWrite(tmuxConfig, managedBlock(config, tmuxBlock));

const bootstrapLine = `source-file ${tmuxConfig}`;
const bootstrap = read(bootstrapConfig);
if (!bootstrap.split("\n").some((line) => line.trim() === bootstrapLine)) {
  backupOnce(bootstrapConfig);
  atomicWrite(bootstrapConfig, `${bootstrap.trimEnd()}\n\n# Load the primary tmux configuration (including Claude Micro).\n${bootstrapLine}\n`);
}

// Install hooks from the copied plugin so source checkout moves do not break
// an already-installed integration.
execFileSync(process.execPath, [path.join(destination, "src", "install-hooks.mjs")], { stdio: "inherit" });

console.log(`Installed tmux plugin: ${destination}`);
console.log(`Updated tmux config: ${tmuxConfig}`);
console.log(`Status command: #{@claude_micro_status_command}`);
console.log("Reset binding: Prefix + k (customize with @claude_micro_reset_key)");
