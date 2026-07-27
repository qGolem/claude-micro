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
  // dist/ is committed and executed straight from a plugin checkout that has
  // no node_modules, so the workspace codec must be bundled in. node-hid stays
  // external: it is a native module, and only the daemon needs it (the Claude
  // hooks run dist/event.js, which imports nothing outside node: builtins).
  noExternal: ["codex-micro-protocol"],
  sourcemap: false,
  clean: true,
});
