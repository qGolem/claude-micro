export type SessionState = "idle" | "working" | "waiting" | "complete" | "error";

const HOOK_STATE: Record<string, SessionState> = Object.freeze({
  SessionStart: "idle",
  UserPromptSubmit: "working",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "complete",
  SubagentStop: "complete",
  PermissionRequest: "waiting",
  SessionEnd: "idle",
});

export function stateForHook(event: Record<string, unknown>): SessionState | null {
  const name = event.hook_event_name ?? event.event ?? event.type;
  // Claude emits PreToolUse before it presents AskUserQuestion. Because this
  // hook is installed only for that tool, it is the earliest reliable point
  // to show the amber "needs input" state.
  if (name === "PreToolUse" && event.tool_name === "AskUserQuestion") return "waiting";
  if (name === "Notification") {
    const text = JSON.stringify(event).toLowerCase();
    return text.includes("error") || text.includes("failed") ? "error" : "waiting";
  }
  return typeof name === "string" ? (HOOK_STATE[name] ?? null) : null;
}

export interface SlotAssignment {
  sessionId: string;
  slot: number;
}

export class SessionSlots {
  #slots = new Map<string, number>();

  constructor(entries: Array<{ sessionId?: unknown; slot?: unknown }> = []) {
    for (const entry of entries) {
      const { sessionId, slot } = entry ?? {};
      if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot > 5 || typeof sessionId !== "string") continue;
      if (this.#slots.has(sessionId) || Array.from(this.#slots.values()).includes(slot)) continue;
      this.#slots.set(sessionId, slot);
    }
  }

  acquire(sessionId: string): number {
    const existing = this.#slots.get(sessionId);
    if (existing !== undefined) return existing;
    const used = new Set(this.#slots.values());
    const slot = Array.from({ length: 6 }, (_unused, index) => index).find((index) => !used.has(index));
    if (slot === undefined) throw new Error("All six Codex Micro agent slots are in use.");
    this.#slots.set(sessionId, slot);
    return slot;
  }

  release(sessionId: string): void {
    this.#slots.delete(sessionId);
  }

  entries(): SlotAssignment[] {
    return Array.from(this.#slots, ([sessionId, slot]) => ({ sessionId, slot }));
  }
}
