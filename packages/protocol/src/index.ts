export {
  WORK_LOUDER_VENDOR_ID,
  CODEX_MICRO_PRODUCT_ID,
  VENDOR_USAGE_PAGE,
  isCodexMicroInterface,
  type HidInterfaceDescriptor,
} from "./device";

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
} from "./framing";

export {
  RpcMethod,
  RequestIdSequence,
  encodeRpcRequest,
  parseRpcMessage,
  RpcMessageStream,
  type RpcMethodName,
  type RpcRequest,
  type RpcMessage,
  type RpcEventMessage,
  type RpcResponseMessage,
  type RpcUnknownMessage,
  type RpcInvalidMessage,
} from "./rpc";

export {
  LightingEffect,
  AGENT_KEY_COUNT,
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
} from "./lighting";

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
  type ParsedKeyEvent,
  type JoystickSample,
  type JoystickDirection,
  type JoystickFlickDetectorOptions,
  type DeviceEvent,
} from "./input";

export {
  firmwareVersionRequest,
  agentKeyStatusRequest,
  lightingConfigRequest,
  encodeRequestPackets,
} from "./requests";
