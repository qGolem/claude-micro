// High-level request builders: one call from intent to HID packets.

import { encodeHidPackets } from "./framing.mjs";
import { encodeRpcRequest, RpcMethod } from "./rpc.mjs";
import { agentKeyStatusParams, lightingConfigParams } from "./lighting.mjs";

/** {method, params, id} for a firmware-version query. */
export function firmwareVersionRequest({ id }) {
  return { method: RpcMethod.firmwareVersion, params: null, id };
}

/** {method, params, id} for an agent-key lighting update (validated). */
export function agentKeyStatusRequest({ agentKeys, id }) {
  return { method: RpcMethod.agentKeyStatus, params: agentKeyStatusParams(agentKeys), id };
}

/** {method, params, id} for a whole-board lighting update (validated). */
export function lightingConfigRequest({ keys, ambient, id }) {
  return { method: RpcMethod.lightingConfig, params: lightingConfigParams({ keys, ambient }), id };
}

/** Encodes any {method, params, id} request straight to writable HID packets. */
export function encodeRequestPackets(request) {
  return encodeHidPackets(encodeRpcRequest(request));
}
