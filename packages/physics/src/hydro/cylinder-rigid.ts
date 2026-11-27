import { MargoError } from '@margoengine/math/errors';
import { regionWords } from '../world/memory.js';
import { isRateLevel, type Port, type RateLevel, type Region, type Solver, type SolverHost } from '../world/solver.js';
import { BODIES_FIELD, BODY_IMPULSES_FIELD, BODY_WORDS, bodyRowsOf, IMPULSE_WORDS } from '../world/solvers/rigid.js';
import {
  SHALLOW_BLOCKAGE_LAYOUT,
  SHALLOW_BLOCKAGE_REACTION_WORDS,
  SHALLOW_RIGID_BLOCKAGE_LAYOUT,
  SHALLOW_RIGID_BLOCKAGE_MOTION_WORDS,
} from './blockage-contract.js';
import type { ShallowWaterSolver } from './index.js';

export interface RigidCylinderOptions {
  /** Water solver ID. Defaults to 'water'. */
  readonly id?: string;
  /** Rigid solver ID. Defaults to 'rigid'. */
  readonly rigidId?: string;
  /** Rate shared with water and rigid. Defaults to the base level (60 Hz). */
  readonly rate?: RateLevel;
  readonly signal?: AbortSignal;
}

export interface RigidCylinderCoupling {
  readonly water: ShallowWaterSolver;
  readonly predictor: Solver;
  readonly reaction: Solver;
  /** Exact order for the world's staggered group. */
  readonly order: readonly [string, string, string, string];
}

function refuse(message: string): MargoError {
  return new MargoError('unsupported', `${message} See https://margoengine.com/errors#hydrodynamic-loads`);
}

function sameCell(a: Port['cell'], b: Port['cell']): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function rigidCylinderCoupling(
  water: ShallowWaterSolver,
  row: number,
  { id = 'water', rigidId = 'rigid', rate = 0 }: RigidCylinderOptions,
): RigidCylinderCoupling {
  if (!isRateLevel(rate))
    throw refuse('Invalid rigid cylinder rate; use the same rate level from 0 through 7 for all four solvers.');
  const { motion, reaction } = water.blockageFields!;
  const predictorId = `${id}.predictCylinder`;
  const reactionId = `${id}.reactCylinder`;
  let inputHost: SolverHost;
  let motionState: Region;
  let outputHost: SolverHost;
  let impulseState: Region;

  const predictor: Solver = {
    describe: () => ({
      id: predictorId,
      rate,
      stableRate: () => rate,
      fields: [
        { field: BODIES_FIELD, access: 'read' },
        { field: motion, access: 'write' },
      ],
    }),
    init(host) {
      if (host.gravity[0] !== 0 || host.gravity[2] !== 0)
        throw refuse('The guided cylinder needs vertical gravity; configure gravity along Y in this channel.');
      inputHost = host;
      motionState = host.allocate(
        'rigid-cylinder-motion',
        SHALLOW_RIGID_BLOCKAGE_MOTION_WORDS * 8,
        'f64',
        SHALLOW_RIGID_BLOCKAGE_LAYOUT,
      );
    },
    step({ cell, inputs, tick }, dt) {
      const bodies = inputs.get(BODIES_FIELD.name);
      if (
        !bodies ||
        bodies.tick !== tick - 1 ||
        !sameCell(bodies.cell, cell) ||
        bodies.region.layout !== 2 ||
        bodies.region.type !== 'f32'
      )
        throw refuse(
          'Missing previous rigid pose for the cylinder; put the predictor first in the same-rate staggered group and origin cell.',
        );
      const state = regionWords(inputHost.memory, bodies.region);
      const offset = row * BODY_WORDS;
      const [x, y, z, vx, vy, vz, wx, wy, wz, inverseMass] = state.subarray(offset + 7, offset + 17);
      if (
        state[offset + 23] !== 1 ||
        !(inverseMass! > 0) ||
        ![x, y, z, vx, vz, inverseMass].every(Number.isFinite) ||
        state[offset + 3] !== 0 ||
        state[offset + 5] !== 0 ||
        vy !== 0 ||
        wx !== 0 ||
        wy !== 0 ||
        wz !== 0
      )
        throw refuse(
          'A rigid blockage cylinder needs a dynamic upright guide; enable X/Z translation and lock Y translation and rotation.',
        );
      regionWords(inputHost.memory, motionState).set([
        tick + 1,
        x! + dt * vx!,
        z! + dt * vz!,
        y!,
        vx!,
        vz!,
        inverseMass!,
      ]);
    },
    importPorts() {},
    exportPorts: (tick) => [{ field: motion.name, region: motionState, cell: [0, 0, 0], tick }],
    stateRegions: () => [motionState],
    extraState: () => [],
  };

  const relay: Solver = {
    describe: () => ({
      id: reactionId,
      rate,
      stableRate: () => rate,
      fields: [
        { field: reaction, access: 'read' },
        { field: BODY_IMPULSES_FIELD, access: 'accumulate' },
      ],
    }),
    init(host) {
      outputHost = host;
      const capacity = bodyRowsOf(host, reactionId, [row]);
      impulseState = host.allocate(
        'rigid-cylinder-impulse',
        capacity * IMPULSE_WORDS * 8,
        'f64',
        SHALLOW_BLOCKAGE_LAYOUT,
      );
    },
    step({ cell, inputs, tick }) {
      const port = inputs.get(reaction.name);
      if (
        !port ||
        port.tick !== tick ||
        !sameCell(port.cell, cell) ||
        port.region.type !== 'f64' ||
        port.region.layout !== SHALLOW_BLOCKAGE_LAYOUT ||
        port.region.byteLength !== SHALLOW_BLOCKAGE_REACTION_WORDS * 8
      )
        throw refuse(
          'Missing the cylinder’s accepted reaction; schedule the relay after the water and before the rigid step.',
        );
      const words = regionWords(outputHost.memory, port.region);
      if (words[0] !== tick + 1 || words[1] !== row)
        throw refuse(
          'The accepted cylinder ticket or body row disagrees; bind the reaction relay to this water and its rigid row.',
        );
      regionWords(outputHost.memory, impulseState).set(words.subarray(2), row * IMPULSE_WORDS);
    },
    importPorts() {},
    exportPorts: (tick) => [{ field: BODY_IMPULSES_FIELD.name, region: impulseState, cell: [0, 0, 0], tick }],
    stateRegions: () => [impulseState],
    extraState: () => [],
  };

  return { water, predictor, reaction: relay, order: [predictorId, id, reactionId, rigidId] };
}
