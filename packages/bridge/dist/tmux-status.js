// src/tmux-status.ts
import fs from "fs";
var pidPath = process.env.CLAUDE_MICRO_PID ?? "/private/tmp/claude-micro.pid";
var healthPath = process.env.CLAUDE_MICRO_HEALTH ?? "/private/tmp/claude-micro-health.json";
function bridgeRunning() {
  try {
    process.kill(Number(fs.readFileSync(pidPath, "utf8").trim()), 0);
    return true;
  } catch {
    return false;
  }
}
var health;
try {
  health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
} catch {
  health = null;
}
var recent = health?.updatedAt !== void 0 && Date.now() - Date.parse(health.updatedAt) < 4e3;
if (bridgeRunning() && health?.state === "connected" && recent) {
  process.stdout.write("#[fg=#1e1e2e,bg=#a6e3a1,bold] \u25C8 MICRO #[fg=default,bg=default,nobold]");
} else if (bridgeRunning()) {
  process.stdout.write("#[fg=#1e1e2e,bg=#f9e2af,bold] \u21BB k #[fg=default,bg=default,nobold]");
} else {
  process.stdout.write("#[fg=#1e1e2e,bg=#f38ba8,bold] \u21BB k #[fg=default,bg=default,nobold]");
}
