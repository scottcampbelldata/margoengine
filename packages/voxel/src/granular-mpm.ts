import { MargoError } from '@margoengine/math/errors';
import type { GranularMpmParams, GranularMpmSolver, GranularPoint } from '@margoengine/physics/granular-mpm';
import type { Cell, PhysicsWorld } from '@margoengine/physics/world';
import { blockId } from './blocks.js';
import { takeMatchingCells, type VoxelWorld } from './world.js';

/**
 * One voxel that becomes granular material: its position in voxel coordinates, the expected block ID and the
 * material table index (default 0).
 */
export interface VoxelGranularCell {
  /** Position of a loaded, solid cube in voxel coordinates. */
  readonly position: Cell;
  /** Expected block ID. Pick the voxel type representing the loose material. */
  readonly block: number;
  /** Index into the solver material table. Defaults to 0. */
  readonly material?: number;
}

/**
 * Options for turning voxels into granular points: the cells, voxel side in metres (default 1), samples per axis
 * (default 2), voxel origin, physics cell and solver parameters.
 */
export interface VoxelGranularOptions {
  readonly cells: readonly VoxelGranularCell[];
  /** Side length of a voxel, metres. Defaults to 1. */
  readonly metresPerVoxel?: number;
  /** Number of equal-volume samples along each axis of a cube. Defaults to 2. */
  readonly samplesPerAxis?: number;
  /** Voxel corner at the receiving cell's local origin. Defaults to [0, 0, 0]. */
  readonly voxelOrigin?: Cell;
  /** Floating-origin cell in the physics world. Defaults to [0, 0, 0]. */
  readonly cell?: Cell;
  /** Solver parameters. Grid spacing defaults to the voxel side divided by samplesPerAxis. */
  readonly params?: Omit<GranularMpmParams, 'points'>;
}

/**
 * Seeds a fresh, loaded MPM solver from the selected cells and consumes only those solids.
 * Call at a solver step boundary. Invalid input or a failed solver registration leaves all source cells available.
 * Observers receive ordinary voxel removals after the complete selection and the solver are committed.
 */
export function transferVoxelGranular(
  voxels: VoxelWorld,
  physics: PhysicsWorld,
  solver: GranularMpmSolver,
  options: VoxelGranularOptions,
): void {
  const { cells, metresPerVoxel = 1, samplesPerAxis = 2, voxelOrigin = [0, 0, 0], cell, params } = options;
  const width = metresPerVoxel / samplesPerAxis;
  const volume = width * width * width;
  if (!Number.isSafeInteger(samplesPerAxis) || samplesPerAxis < 1 || !(volume > 0 && Number.isFinite(volume)))
    throw new MargoError(
      'state',
      'Use a positive voxel size and a positive whole sample count with finite sample volume.',
    );
  if (!cells.length || voxelOrigin.length !== 3 || !voxelOrigin.every(Number.isSafeInteger))
    throw new MargoError(
      'state',
      'Select at least one loose-material cell and use three integer voxel origin coordinates.',
    );
  const sampleCount = cells.length * samplesPerAxis * samplesPerAxis * samplesPerAxis;
  // At minimum each point needs two 224-byte states and 27 nodes with 36 bytes of work and two 48-byte hash slots.
  if (!Number.isSafeInteger(sampleCount) || sampleCount * (448 + 27 * (36 + 96)) >= 0x100000000)
    throw new MargoError('state', 'Reduce the voxel selection or samples per axis to fit in the granular arena.');
  const captured: [number, number, number, number][] = [];
  const seen = new Set<string>();
  for (const {
    position: [x, y, z],
    block,
  } of cells) {
    const key = `${x},${y},${z}`;
    const state = voxels.getBlock(x, y, z);
    const type = voxels.blocks.table[blockId(state)];
    if (!state || !type?.solid || type.liquid || type.shape !== 'cube' || type.id !== block || seen.has(key))
      throw new MargoError('state', `Select each matching, loaded solid cube once. Check voxel (${key}).`);
    seen.add(key);
    captured.push([x, y, z, state]);
  }
  const points: GranularPoint[] = [];
  for (const [index, [x, y, z]] of captured.entries()) {
    const left = (x - voxelOrigin[0]) * metresPerVoxel;
    const bottom = (y - voxelOrigin[1]) * metresPerVoxel;
    const back = (z - voxelOrigin[2]) * metresPerVoxel;
    const material = cells[index]!.material;
    for (let k = 0; k < samplesPerAxis; k++)
      for (let j = 0; j < samplesPerAxis; j++)
        for (let i = 0; i < samplesPerAxis; i++) {
          points.push({
            position: [left + (i + 0.5) * width, bottom + (j + 0.5) * width, back + (k + 0.5) * width],
            volume,
            material,
          });
        }
  }
  physics.add(solver, { spacing: width, ...params, points }, cell);
  if (!takeMatchingCells(voxels, captured)) {
    physics.remove(solver.id);
    throw new MargoError(
      'state',
      'Voxel sources changed during registration. Select the current blocks and load a fresh solver.',
    );
  }
}
