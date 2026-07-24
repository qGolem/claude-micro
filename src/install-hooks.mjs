import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(here, "..");
const settingsPath = process.argv[2] ?? path.join(os.homedir(), ".claude", "settings.json");
const eventScript = process.argv[3] ?? path.join(here, "event.mjs");
const marker = "claude-micro/src/event.mjs";

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function commandFor(event) {
  return `${shellQuote(process.execPath)} ${shellQuote(eventScript)} # claude-micro:${event}`;
}

const hookEvents = {
  SessionStart: undefined,
  UserPromptSubmit: undefined,
  Stop: undefined,
  Notification: undefined,
  PermissionRequest: undefined,
  PreToolUse: "AskUserQuestion",
  PostToolUse: undefined,
  SessionEnd: undefined,
};

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw new Error(`Could not parse ${settingsPath}: ${error.message}`);
}

if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
  settings.hooks = {};
}

for (const [event, matcher] of Object.entries(hookEvents)) {
  const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const preserved = existing.filter((group) => {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
    return !hooks.some((hook) => typeof hook?.command === "string" && hook.command.includes(marker));
  });
  settings.hooks[event] = [
    ...preserved,
    {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: commandFor(event) }],
    },
  ];
}

const backupPath = `${settingsPath}.before-claude-micro`;
const settingsExisted = fs.existsSync(settingsPath);
const backupCreated = settingsExisted && !fs.existsSync(backupPath);
if (backupCreated) fs.copyFileSync(settingsPath, backupPath);
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
const temporaryPath = `${settingsPath}.claude-micro-tmp`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
fs.renameSync(temporaryPath, settingsPath);

console.log(`Installed Claude Micro hooks in ${settingsPath}`);
console.log(`Backup: ${backupCreated ? backupPath : settingsExisted ? "already exists" : "not needed (new settings file)"}`);
console.log(`Start the bridge with: cd ${bridgeRoot} && npm start`);
