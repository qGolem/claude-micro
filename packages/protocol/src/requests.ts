// High-level request builders: one call from intent to HID packets.

import { encodeHidPackets } from "./framing";
import { encodeRpcRequest, RpcMethod, type RpcRequest } from "./rpc";
import {
  agentKeyStatusParams,
  lightingConfigParams,
  type AgentKeyLightingWire,
  type LightingConfigWire,
} from "./lighting";

/** {method, params, id} for a firmware-version query. */
export function firmwareVersionRequest({ id }: { id: number }): RpcRequest {
  return { method: RpcMethod.firmwareVersion, params: null, id };
}

/** {method, params, id} for an agent-key lighting update (validated). */
export function agentKeyStatusRequest({ agentKeys, id }: { agentKeys: AgentKeyLightingWire[]; id: number }): RpcRequest {
  return { method: RpcMethod.agentKeyStatus, params: agentKeyStatusParams(agentKeys), id };
}

/** {method, params, id} for a whole-board lighting update (validated). */
export function lightingConfigRequest({ keys, ambient, id }: LightingConfigWire & { id: number }): RpcRequest {
  return { method: RpcMethod.lightingConfig, params: lightingConfigParams({ keys, ambient }), id };
}

/** Encodes any {method, params, id} request straight to writable HID packets. */
export function encodeRequestPackets(request: RpcRequest): Uint8Array[] {
  return encodeHidPackets(encodeRpcRequest(request));
}
