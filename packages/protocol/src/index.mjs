export {
  WORK_LOUDER_VENDOR_ID,
  CODEX_MICRO_PRODUCT_ID,
  VENDOR_USAGE_PAGE,
  isCodexMicroInterface,
} from "./device.mjs";

export {
  HID_REPORT_ID,
  RPC_CHANNEL,
  HID_PACKET_LENGTH,
  HID_PACKET_HEADER_LENGTH,
  HID_PACKET_PAYLOAD_CAPACITY,
  encodeHidPackets,
  decodeHidPacket,
  rpcPayloadFromPacket,
} from "./framing.mjs";

export {
  RpcMethod,
  RequestIdSequence,
  encodeRpcRequest,
  parseRpcMessage,
  RpcMessageStream,
} from "./rpc.mjs";

export {
  LightingEffect,
  AGENT_KEY_COUNT,
  assertAgentKeyIndex,
  encodeAgentKeyLighting,
  agentKeyStatusParams,
  encodeLightingChannel,
  lightingConfigParams,
} from "./lighting.mjs";

export {
  KeyActionCode,
  AGENT_KEY_NAMES,
  ACTION_KEY_NAMES,
  ENCODER_KEY_NAMES,
  agentKeyIndexForName,
  parseKeyEvent,
  parseJoystickSample,
  JOYSTICK_DIRECTIONS,
  joystickDirection,
  JoystickFlickDetector,
  parseDeviceEvent,
} from "./input.mjs";

export {
  firmwareVersionRequest,
  agentKeyStatusRequest,
  lightingConfigRequest,
  encodeRequestPackets,
} from "./requests.mjs";
