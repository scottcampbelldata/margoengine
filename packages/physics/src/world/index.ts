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
export { Arena, BYTES, regionWords, type RegionWords } from './memory.js';
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
export {
  BASE_HZ,
  HYPER_PERIOD,
  PhysicsWorld,
  ticksAt,
  type FrameRate,
  type PhysicsWorldOptions,
} from './world.js';
