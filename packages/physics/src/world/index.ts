// `@margoengine/physics/world`: the physics framework (docs/physics-framework.md): the solver contract, the snapshot,
// restore and state hash of a set of solvers, the world's memory and the field registry. The world and the scheduler follow.
export {
  BASE_RATE,
  RATE_LEVELS,
  isRateLevel,
  rateOf,
  substepsBetween,
  type Cell,
  type Centring,
  type ElementType,
  type FieldAccess,
  type FieldDescriptor,
  type FieldKind,
  type FieldUse,
  type Port,
  type RateLevel,
  type Region,
  type Solver,
  type SolverDescription,
  type SolverHost,
  type StepContext,
} from './solver.js';
export {
  SNAPSHOT_VERSION,
  restoreSnapshot,
  stateHash,
  takeSnapshot,
  type Snapshot,
  type SnapshotSolver,
} from './snapshot.js';
export {
  Arena,
  BYTES,
  DYNAMIC_BASE,
  MAX_MEMORY_PAGES,
  MODULE_BASE,
  MODULE_SLOTS,
  MODULE_WINDOW,
  STACK_BYTES,
  canShareMemory,
  instantiateSolverModule,
  isShared,
  loadSolverModule,
  moduleBase,
  regionWords,
  stackRegion,
  worldMemory,
  type ModuleBuilds,
  type ModuleSlot,
  type RegionWords,
  type SolverModule,
} from './memory.js';
export {
  FieldRegistry,
  QUANTITY_UNITS,
  TransferRegistry,
  type PublishedPort,
  type RegisteredField,
  type Transfer,
} from './fields.js';
export { RandomStream, philox, solverNumber } from './random.js';
export {
  type CouplingEdge,
  type CouplingGraph,
  type CouplingNode,
  couplingGraph,
  stronglyConnected,
} from './graph.js';
export { BASE_HZ, HYPER_PERIOD, PhysicsWorld, type PhysicsWorldOptions } from './world.js';
export {
  Aitken,
  Anderson,
  coupling,
  staggeringStable,
  type Coupling,
  type CouplingOptions,
  type CouplingScheme,
} from './scheduler.js';
export {
  BODIES_FIELD,
  BODY_FORCES_FIELD,
  BODY_IMPULSES_FIELD,
  BODY_WORDS,
  FORCE_WORDS,
  IMPULSE_WORDS,
  RigidSolver,
  rateLevelOf,
  type RigidSolverParams,
} from './solvers/rigid.js';
export { SoftSolver, type SoftSolverParams } from './solvers/soft.js';
