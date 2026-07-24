import fs from "node:fs";

const pidPath = process.env.CLAUDE_MICRO_PID ?? "/private/tmp/claude-micro.pid";
const healthPath = process.env.CLAUDE_MICRO_HEALTH ?? "/private/tmp/claude-micro-health.json";

function bridgeRunning() {
  try {
    process.kill(Number(fs.readFileSync(pidPath, "utf8").trim()), 0);
    return true;
  } catch {
    return false;
  }
}

let health;
try {
  health = JSON.parse(fs.readFileSync(healthPath, "utf8"));
} catch {
  health = null;
}

const recent = health && Date.now() - Date.parse(health.updatedAt) < 4_000;
if (bridgeRunning() && health?.state === "connected" && recent) {
  process.stdout.write("#[fg=#1e1e2e,bg=#a6e3a1,bold] ◈ MICRO #[fg=default,bg=default,nobold]");
} else if (bridgeRunning()) {
  process.stdout.write("#[fg=#1e1e2e,bg=#f9e2af,bold] ◈ MICRO #[fg=default,bg=default,nobold]");
} else {
  process.stdout.write("#[fg=#1e1e2e,bg=#f38ba8,bold] ◈ MICRO #[fg=default,bg=default,nobold]");
}
