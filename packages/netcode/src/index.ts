// @margoengine/netcode: game networking for any game. A schema-first binary codec with delta compression, a
// fixed-timestep authoritative server, client prediction with reconciliation, entity interpolation, clock sync and
// an in-memory loopback transport with simulated bad networks. No Node or browser APIs: it runs everywhere.
export {
  defineSchema,
  dequantize,
  fnv1a,
  quantize,
  type FieldType,
  type Infer,
  type Interpolation,
  type NormalizedField,
  type NormalizedSchema,
  type NumberKind,
  type ScalarKind,
  type Schema,
  type SchemaDefinition,
  type SchemaShape,
  type StructDefinition,
  type TypeName,
  type UntypedSchema,
} from './schema.js';
export { defineGame, type Game, type GameDefinition } from './game.js';
export {
  CloseCode,
  messages,
  type Channel,
  type Connection,
  type ConnectionMessage,
  type Listener,
} from './transport.js';
export { LoopbackNetwork, type LinkConditions, type LoopbackOptions, type LoopbackStats } from './loopback.js';
export { ClockSync } from './clock.js';
export {
  decodeEnvelope,
  encodeEnvelope,
  MAX_INPUT_BYTES,
  MAX_INPUTS_PER_MESSAGE,
  PROTOCOL_VERSION,
  type Envelope,
} from './protocol.js';
export { GameServer, type GameServerOptions, type GameServerStats, type RateLimits } from './server.js';
export { GameClient, type GameClientOptions, type GameClientStats } from './client.js';
