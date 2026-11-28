// Reads a 3MF volume data resource at points of its shape (volumetric extension chapter 5,
// https://github.com/3MFConsortium/spec_volumetric): the color (section 5.2.1), the mixing ratios of a composite
// (5.2.2 and 5.2.3: each mapping clipped to 0..1 and divided by their sum) and every property (5.2.4).
import { LinearToSRGB } from '@margoengine/math/color';
import { compileField, type FieldScope } from './threemf-functions.js';
import type { ThreeMFSampledField, ThreeMFVolumeData, ThreeMFVolumeSamples } from './threemf-volumetric.js';
import { LoaderError } from './types.js';

const F = '3MF';
/** The least sum of mixing contributions the extension lets a file have; under it a point has no mixture. */
const LEAST_MIX = 1e-5;

/** One field at `count` points: its output's numbers for each, the fallback value where it is undefined. */
function field(scope: FieldScope, given: ThreeMFSampledField, positions: ArrayLike<number>, count: number) {
  const { functionId, channel, fallback, transform: m = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] } = given,
    pos = new Float64Array(3),
    program = compileField(scope, functionId, new Map([['pos', pos]])),
    output = program.outputs.get(channel);
  if (!(output instanceof Float64Array))
    throw new LoaderError(F, 'unsupported', `output ${channel.slice(0, 64)} is not a number, vector or matrix`);
  const size = output.length,
    values = new Float32Array(count * size);
  for (let p = 0; p < count; p++) {
    const x = positions[p * 3],
      y = positions[p * 3 + 1],
      z = positions[p * 3 + 2];
    for (let k = 0; k < 3; k++) pos[k] = x * m[k] + y * m[3 + k] + z * m[6 + k] + m[9 + k];
    program.run();
    for (let i = 0; i < size; i++) values[p * size + i] = Number.isFinite(output[i]) ? output[i] : fallback;
  }
  return { size, values };
}

/**
 * The volume data at `positions` (x, y, z for each point, in the shape's object coordinates).
 *
 * @throws TypeError for positions that are not whole triples of finite numbers.
 */
export function sampleVolume(
  scope: FieldScope,
  volume: ThreeMFVolumeData,
  positions: ArrayLike<number>,
): ThreeMFVolumeSamples {
  const length = positions?.length;
  if (!(Number.isInteger(length) && length % 3 === 0))
    throw new TypeError('Volume samples need x, y and z for each point; give an array of whole triples.');
  for (let i = 0; i < length; i++)
    if (!Number.isFinite(positions[i])) throw new TypeError('Volume sample positions must be finite numbers.');
  const count = length / 3,
    { color, composite } = volume,
    result: ThreeMFVolumeSamples = {
      properties: volume.properties.map((property) => ({
        name: property.name,
        namespace: property.namespace,
        required: property.required,
        ...field(scope, property, positions, count),
      })),
    };
  if (color) {
    const { values } = field(scope, color, positions, count);
    result.colors = values.map((v) => LinearToSRGB(Math.min(1, Math.max(0, v))));
  }
  if (composite) {
    const materials = composite.mappings.length,
      ratios = new Float32Array(count * materials);
    composite.mappings.forEach((mapping, i) => {
      const { values } = field(scope, mapping, positions, count);
      for (let p = 0; p < count; p++) ratios[p * materials + i] = Math.min(1, Math.max(0, values[p]));
    });
    for (let p = 0; p < count; p++) {
      const own = ratios.subarray(p * materials, (p + 1) * materials),
        sum = own.reduce((a, b) => a + b, 0);
      for (let i = 0; i < materials; i++) own[i] = sum < LEAST_MIX ? 0 : own[i] / sum;
    }
    result.composite = { baseMaterialId: composite.baseMaterialId, materials, ratios };
  }
  return result;
}
