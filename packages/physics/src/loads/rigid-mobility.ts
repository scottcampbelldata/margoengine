import { regionWords } from '../world/memory.js';
import type { Cell, Port } from '../world/solver.js';
import { BODY_MOBILITY_WORDS } from '../world/solvers/rigid.js';
import { invalidLoad } from './errors.js';

/** Match the projected dry response to the body pose used for this exchange. */
export function rigidMobilityWords(
  memory: WebAssembly.Memory,
  port: Port | undefined,
  tick: number,
  cell: Cell,
  bodyRows: number,
): Float32Array | undefined {
  if (!port) return undefined;
  const { region } = port;
  if (
    port.tick !== tick ||
    !cell.every((coordinate, axis) => coordinate === port.cell[axis]) ||
    region.type !== 'f32' ||
    region.layout !== 1 ||
    region.byteLength !== bodyRows * BODY_MOBILITY_WORDS * 4
  )
    throw invalidLoad('Publish constrained mobility with the matching rigid body pose, capacity and origin cell.');
  return regionWords(memory, region) as Float32Array;
}
