// @margoengine/save: save and load. A versioned JSON scene/world document with stable ids and references, prefabs
// with overrides and nesting, schema migrations, validation, all-or-nothing loading into your world, optional gzip,
// and storage adapters (memory, localStorage, IndexedDB; files in @margoengine/save/node).
export {
  MAX_ENTITIES,
  MAX_JSON_DEPTH,
  MAX_PREFAB_DEPTH,
  findRefs,
  parseSave,
  validateSave,
  type ComponentCheck,
  type EntityRef,
  type Json,
  type PrefabDefinition,
  type Quat,
  type SaveDocument,
  type SavedEntity,
  type SavedTransform,
  type SaveIssue,
  type ValidateOptions,
  type Vec3,
} from './document.js';
export { expandSave, mergePatch, type ResolvedEntity } from './prefab.js';
export { Migrations, type Migration } from './migrations.js';
export { decodeSave, encodeSave, type EncodeOptions } from './codec.js';
export {
  indexedDBStorage,
  memoryStorage,
  webStorage,
  type IndexedDBStorageOptions,
  type SaveStorage,
  type StorageCallOptions,
  type WebStorageLike,
} from './storage.js';
export {
  ecsAdapter,
  loadGame,
  loadWorld,
  saveEcs,
  saveGame,
  type EcsComponentLike,
  type EcsWorldLike,
  type LoadOptions,
  type SaveGameOptions,
  type WorldAdapter,
} from './load.js';
