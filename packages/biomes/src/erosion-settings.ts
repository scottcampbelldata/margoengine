// Shared validation and Q16 normalization; no erosion runtime or hook is imported.
import { rangeError, typeError } from '../../shared/errors.js';
import { degreesToAngle, divFloor, ONE, sincos } from './fixed.js';
import type { HeightGrid } from './hydrology.js';
import type { ErosionOptions } from './erosion.js';
const LIMIT = 33554432;
/** A rate option quantised to Q16 after a range check. */
function rate(value: number | undefined, fallback: number, max: number, name: string): number {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !(v >= 0 && v <= max))
    throw rangeError(`Erosion ${name} must be a number from 0 to ${max}`, 'biomes');
  return Math.round(v * ONE);
}

/** Internal: identical option quantization for the ordered JS and Wasm routes. */
export function erosionSettings(grid: HeightGrid, options: ErosionOptions, cells: number) {
  const { height, nx, nz, step } = grid;
  if (!(height instanceof Int32Array)) throw typeError('erode needs height as an Int32Array of millimetres', 'biomes');
  if (typeof options !== 'object' || options === null)
    throw typeError('Erosion options must be an object; pass {} for the defaults', 'biomes');
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(nz) ||
    !(nx >= 2 && nz >= 2 && nx * nz <= cells) ||
    height.length !== nx * nz ||
    !Number.isInteger(step) ||
    !(step >= 1 && step <= 1048576) ||
    height.some((v) => v > LIMIT || v < -LIMIT)
  )
    throw rangeError(
      `erode needs nx and nz of 2 or more (at most ${cells} cells), nx x nz heights within +-33,554,432 mm and a step of 1..1,048,576 mm`,
      'biomes',
    );
  const iterations = options.iterations ?? 32,
    talus = options.talus ?? 35,
    sea = options.sea === undefined ? undefined : Math.round(options.sea);
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 1024)
    throw rangeError('Erosion iterations must be an integer from 0 to 1,024', 'biomes');
  if (typeof talus !== 'number' || !(talus >= 0 && talus <= 89))
    throw rangeError('Erosion talus must be an angle of 0 to 89 degrees', 'biomes');
  if (sea !== undefined && !Number.isFinite(sea)) throw rangeError('Erosion sea must be a height in mm', 'biomes');
  const thermal = rate(options.thermal, 0.25, 0.5, 'thermal'),
    rates = [
      rate(options.capacity, 0.01, 1, 'capacity'),
      rate(options.incision, 0.25, 1, 'incision'),
      rate(options.deposition, 0.5, 1, 'deposition'),
    ],
    cs = sincos(degreesToAngle(talus), [0, 0]),
    tan = divFloor(cs[1] * ONE, cs[0]);
  const straight = Math.floor((tan * step) / ONE),
    diagonal = Math.floor((tan * Math.floor((step * 92682) / ONE)) / ONE);
  return { iterations, thermal, rates, sea, straight, diagonal };
}
