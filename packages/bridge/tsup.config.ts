import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    daemon: "src/daemon.ts",
    event: "src/event.ts",
    "focus-slot": "src/focus-slot.ts",
    "tmux-status": "src/tmux-status.ts",
    doctor: "src/doctor.ts",
    "cleanup-legacy": "src/cleanup-legacy.ts",
    "tools/query-firmware": "tools/query-firmware.ts",
    "tools/pulse-board": "tools/pulse-board.ts",
    "tools/force-agent-key": "tools/force-agent-key.ts",
  },
  format: ["esm"],
  target: "node20",
  sourcemap: true,
  clean: true,
});
