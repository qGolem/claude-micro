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
  /** Epoch ms of the last hook seen for this session. */
  lastSeenAt: number;
}

export interface SessionSlotsOptions {
  /**
   * When every slot is taken, an assignment older than this may be evicted for
   * a new session. A session that dies without delivering its SessionEnd hook
   * (SIGKILL, closed terminal, or a bridge that was down at the time) would
   * otherwise hold its key forever, including across restarts.
   */
  staleAfterMs?: number;
  now?: () => number;
}

const SLOT_COUNT = 6;

export class SessionSlots {
  #slots = new Map<string, SlotAssignment>();
  #staleAfterMs: number;
  #now: () => number;

  constructor(
    entries: Array<{ sessionId?: unknown; slot?: unknown; lastSeenAt?: unknown }> = [],
    { staleAfterMs = 12 * 60 * 60 * 1_000, now = Date.now }: SessionSlotsOptions = {},
  ) {
    this.#staleAfterMs = staleAfterMs;
    this.#now = now;
    const takenSlots = new Set<number>();
    for (const entry of entries) {
      const { sessionId, slot, lastSeenAt } = entry ?? {};
      if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) continue;
      if (typeof sessionId !== "string") continue;
      if (this.#slots.has(sessionId) || takenSlots.has(slot)) continue;
      // A restored record with no/invalid timestamp is treated as ancient, so
      // pre-timestamp state files cannot wedge the bridge permanently.
      const seenAt = typeof lastSeenAt === "number" && Number.isFinite(lastSeenAt) ? lastSeenAt : 0;
      this.#slots.set(sessionId, { sessionId, slot, lastSeenAt: seenAt });
      takenSlots.add(slot);
    }
  }

  /**
   * Returns this session's slot, assigning a free one if needed. When all six
   * are held, the stalest assignment past staleAfterMs is evicted rather than
   * failing — a live session always outranks an abandoned one.
   */
  acquire(sessionId: string): number {
    const now = this.#now();
    const existing = this.#slots.get(sessionId);
    if (existing) {
      existing.lastSeenAt = now;
      return existing.slot;
    }
    const used = new Set(Array.from(this.#slots.values(), (assignment) => assignment.slot));
    const freeSlot = Array.from({ length: SLOT_COUNT }, (_unused, index) => index).find((index) => !used.has(index));
    if (freeSlot !== undefined) {
      this.#slots.set(sessionId, { sessionId, slot: freeSlot, lastSeenAt: now });
      return freeSlot;
    }
    const stalest = Array.from(this.#slots.values()).sort((left, right) => left.lastSeenAt - right.lastSeenAt)[0];
    if (!stalest || now - stalest.lastSeenAt < this.#staleAfterMs) {
      throw new Error("All six Codex Micro agent slots are in use by recently active sessions.");
    }
    this.#slots.delete(stalest.sessionId);
    this.#slots.set(sessionId, { sessionId, slot: stalest.slot, lastSeenAt: now });
    return stalest.slot;
  }

  release(sessionId: string): void {
    this.#slots.delete(sessionId);
  }

  /** Epoch ms of the last hook seen for whoever holds this slot, if anyone. */
  lastSeenAt(slot: number): number | null {
    for (const assignment of this.#slots.values()) {
      if (assignment.slot === slot) return assignment.lastSeenAt;
    }
    return null;
  }

  entries(): SlotAssignment[] {
    return Array.from(this.#slots.values(), (assignment) => ({ ...assignment }));
  }
}
