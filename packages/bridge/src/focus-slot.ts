import fs from "node:fs";
import { execFileSync } from "node:child_process";

const slot = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isInteger(slot) || slot < 0 || slot > 5) throw new Error("Pass an Agent slot from 0 through 5.");

const slotsPath = process.env.CLAUDE_MICRO_SLOTS ?? "/private/tmp/claude-micro-slots.json";

// The slots file only appears once a Claude hook has reached the bridge, so a
// fresh install has none. Treat that exactly like an unassigned key rather
// than throwing a stack trace into the blocking tmux output window.
function readSlots(): Array<{ tmuxPane?: string | null }> {
  try {
    const data = JSON.parse(fs.readFileSync(slotsPath, "utf8")) as { slots?: Array<{ tmuxPane?: string | null }> };
    return Array.isArray(data.slots) ? data.slots : [];
  } catch {
    return [];
  }
}

const pane = readSlots()[slot]?.tmuxPane;
if (!pane) {
  execFileSync("tmux", ["display-message", `Claude Micro: Agent Key ${slot + 1} has no tmux pane yet.`]);
  process.exit(0);
}

execFileSync("tmux", ["select-window", "-t", pane]);
execFileSync("tmux", ["select-pane", "-t", pane]);
execFileSync("tmux", ["display-message", `Claude Micro: focused Agent Key ${slot + 1}.`]);
