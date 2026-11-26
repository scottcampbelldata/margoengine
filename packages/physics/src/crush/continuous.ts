import { MargoError } from '@margoengine/math/errors';
import { type CrushMaterial, type CrushStrokeResult, crushStrokePrepared } from './material.js';

/** End-of-step compression and impulse for a continuous contact. */
export interface CompressionStep extends CrushStrokeResult {
  readonly impulse: number;
  readonly totalStroke: number;
}

/** Solves the implicit normal contact equation on the elastic, yielding or compacted branch. */
export function stepCompression(
  material: Required<CrushMaterial>,
  prior: number,
  current: number,
  speed: number,
  inverseMass: number,
  dt: number,
): CompressionStep | undefined {
  const free = current + dt * speed;
  if (free <= prior || dt === 0) return undefined;

  const { stiffness, yieldForce, hardening, stroke, backingStiffness } = material;
  const yieldLoad = yieldForce + hardening * prior;
  const capLoad = yieldForce + hardening * stroke;
  const yieldStroke = prior + yieldLoad / stiffness; // float division: end of the elastic branch
  const capStroke = stroke + capLoad / stiffness; // float division: onset of elastic backing
  const compliance = dt * dt * inverseMass;
  let offset = prior;
  let force = 0;
  let slope = stiffness;
  // The increasing function x + h²wF(x) determines which material branch contains the end stroke.
  if (free > yieldStroke + compliance * yieldLoad) {
    if (free <= capStroke + compliance * capLoad) {
      offset = yieldStroke;
      force = yieldLoad;
      slope = stiffness * (hardening / (stiffness + hardening)); // float division: loading tangent
    } else {
      offset = capStroke;
      force = capLoad;
      slope = backingStiffness;
    }
  }
  const endForce = (force + slope * (free - offset)) / (1 + compliance * slope); // float division
  const impulse = dt * endForce;
  const totalStroke = Math.max(prior, free - compliance * endForce);
  if (!(Number.isFinite(endForce) && endForce >= 0 && Number.isFinite(impulse) && Number.isFinite(totalStroke)))
    throw new MargoError('state', 'Choose representable stiffness, mass and end stroke for progressive crush contact.');
  if (impulse === 0) return undefined;
  return { ...crushStrokePrepared(material, totalStroke, prior), impulse, totalStroke };
}
