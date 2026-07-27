// Claude-side lighting policy: which color/effect each Claude Code session
// state gets on its agent key. Deliberately not part of the protocol package —
// the wire format is hardware truth, these colors are this bridge's opinion.

import {
  LightingEffect,
  assertAgentKeyIndex,
  encodeAgentKeyLighting,
  type AgentKeyLightingWire,
  type LightingEffectValue,
} from "codex-micro-protocol";
import type { SessionState } from "./state";

export interface AgentKeyStyle {
  color: number;
  brightness: number;
  effect: LightingEffectValue;
  speed: number;
}

export const AGENT_STATE_STYLES: Record<SessionState, AgentKeyStyle> = Object.freeze({
  idle: { color: 0xffffff, brightness: 0.35, effect: LightingEffect.solid, speed: 0 },
  working: { color: 0x3b82f6, brightness: 1, effect: LightingEffect.shallowBreath, speed: 0.45 },
  waiting: { color: 0xf59e0b, brightness: 1, effect: LightingEffect.shallowBreath, speed: 0.35 },
  complete: { color: 0x22c55e, brightness: 1, effect: LightingEffect.solid, speed: 0 },
  error: { color: 0xef4444, brightness: 1, effect: LightingEffect.breath, speed: 0.5 },
});

export interface SyncOptions {
  syncKeysLighting?: boolean;
  syncAmbientLighting?: boolean;
}

/**
 * Builds the wire entry lighting one agent key for a session state. Unknown
 * states render as idle so a bridge/firmware version skew never throws; the
 * index is runtime-validated by the codec.
 */
export function agentKeyLightingForState(agentKeyIndex: number, stateName: string, syncOptions: SyncOptions = {}): AgentKeyLightingWire {
  assertAgentKeyIndex(agentKeyIndex);
  const style = AGENT_STATE_STYLES[stateName as SessionState] ?? AGENT_STATE_STYLES.idle;
  return encodeAgentKeyLighting({ agentKeyIndex, ...style, ...syncOptions });
}
