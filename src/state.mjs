const HOOK_STATE = Object.freeze({
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "complete",
  SubagentStop: "complete",
  PermissionRequest: "waiting",
  SessionEnd: "idle",
});

export function stateForHook(event) {
  const name = event.hook_event_name ?? event.event ?? event.type;
  // Claude emits PreToolUse before it presents AskUserQuestion. Because this
  // hook is installed only for that tool, it is the earliest reliable point
  // to show the amber "needs input" state.
  if (name === "PreToolUse" && event.tool_name === "AskUserQuestion") return "waiting";
  if (name === "Notification") {
    const text = JSON.stringify(event).toLowerCase();
    return text.includes("error") || text.includes("failed") ? "error" : "waiting";
  }
  return HOOK_STATE[name] ?? null;
}

export class SessionSlots {
  #slots = new Map();

  acquire(sessionId) {
    if (this.#slots.has(sessionId)) return this.#slots.get(sessionId);
    const used = new Set(this.#slots.values());
    const slot = Array.from({ length: 6 }, (_, index) => index).find((index) => !used.has(index));
    if (slot === undefined) throw new Error("All six Codex Micro agent slots are in use.");
    this.#slots.set(sessionId, slot);
    return slot;
  }

  release(sessionId) {
    this.#slots.delete(sessionId);
  }
}
