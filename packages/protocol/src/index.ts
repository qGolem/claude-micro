export {
  WORK_LOUDER_VENDOR_ID,
  CODEX_MICRO_PRODUCT_ID,
  VENDOR_USAGE_PAGE,
  isCodexMicroInterface,
  type HidInterfaceDescriptor,
} from "./device.js";

export {
  HID_REPORT_ID,
  RPC_CHANNEL,
  HID_PACKET_LENGTH,
  HID_PACKET_HEADER_LENGTH,
  HID_PACKET_PAYLOAD_CAPACITY,
  encodeHidPackets,
  decodeHidPacket,
  rpcPayloadFromPacket,
  type DecodedHidPacket,
} from "./framing.js";

export {
  RpcMethod,
  RequestIdSequence,
  encodeRpcRequest,
  parseRpcMessage,
  RpcMessageStream,
  MAX_PENDING_MESSAGE_LENGTH,
  type RpcMethodName,
  type RpcMethodInput,
  type RpcRequest,
  type RpcMessage,
  type RpcEventMessage,
  type RpcResponseMessage,
  type RpcUnknownMessage,
  type RpcInvalidMessage,
} from "./rpc.js";

export {
  LightingEffect,
  AGENT_KEY_COUNT,
  isAgentKeyIndex,
  assertAgentKeyIndex,
  encodeAgentKeyLighting,
  agentKeyStatusParams,
  encodeLightingChannel,
  lightingConfigParams,
  type LightingEffectValue,
  type AgentKeyIndex,
  type AgentKeyLightingOptions,
  type AgentKeyLightingWire,
  type LightingChannelOptions,
  type LightingChannelWire,
  type LightingConfigWire,
} from "./lighting.js";

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
  type KeyActionCodeValue,
  type KeyActionName,
  type AgentKeyName,
  type ActionKeyName,
  type EncoderKeyName,
  type KnownKeyName,
  type ParsedKeyEvent,
  type JoystickSample,
  type JoystickDirection,
  type JoystickFlickDetectorOptions,
  type DeviceEvent,
} from "./input.js";

export {
  firmwareVersionRequest,
  agentKeyStatusRequest,
  lightingConfigRequest,
  encodeRequestPackets,
} from "./requests.js";
