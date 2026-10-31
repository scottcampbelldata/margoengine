// @margoengine/voxel-net: multiplayer for voxel worlds (design: packages/voxel-net/DESIGN.md). This entry runs in
// browsers and Node: the wire format and the client. The Node server is `./server`, the load-test bot `./bot`.
export type {
  RemotePlayer,
  VoxelNetClientOptions,
  VoxelNetClientStats,
  VoxelNetClose,
  VoxelNetControls,
  VoxelNetTransport,
} from './client.js';
export { connectVoxelNet, SERVER_SILENT_CODE, VoxelNetClient } from './client.js';
export type { ClientMessage, InputRun, PlayerName, PlayerState, ServerMessage } from './protocol.js';
export {
  blockTableHash,
  cleanPlayerName,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  Keys,
  MAX_APP_BYTES,
  MAX_NAME_BYTES,
  moveIntent,
  PLAYER_SCHEMA,
  PROTOCOL_VERSION,
  quantizePitch,
  quantizeYaw,
  STEP_SECONDS,
} from './protocol.js';
