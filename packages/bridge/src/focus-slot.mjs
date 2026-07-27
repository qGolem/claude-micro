import fs from "node:fs";
import { execFileSync } from "node:child_process";

const slot = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isInteger(slot) || slot < 0 || slot > 5) throw new Error("Pass an Agent slot from 0 through 5.");

const slotsPath = process.env.CLAUDE_MICRO_SLOTS ?? "/private/tmp/claude-micro-slots.json";
const data = JSON.parse(fs.readFileSync(slotsPath, "utf8"));
const pane = data.slots?.[slot]?.tmuxPane;
if (!pane) {
  execFileSync("tmux", ["display-message", `Claude Micro: Agent Key ${slot + 1} has no tmux pane yet.`]);
  process.exit(0);
}

execFileSync("tmux", ["select-window", "-t", pane]);
execFileSync("tmux", ["select-pane", "-t", pane]);
execFileSync("tmux", ["display-message", `Claude Micro: focused Agent Key ${slot + 1}.`]);
