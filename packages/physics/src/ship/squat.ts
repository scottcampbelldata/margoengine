// A ship's squat (SEA-09): how far a ship under way sinks and trims in shallow water, by the published empirical laws as S.
// Serban and V. Panaitescu restate and work them ("Squat assessment for a ship in a confined channel", 2016 review, read;
// its worked case of a 118 m cargo ship in a 10 m canal is the test):
// - ICORELS (PIANC 1997): bow squat S_b = C_S (V / L^2) Fn_h^2 / sqrt(1 - Fn_h^2), C_S 2.4 (1.7 below C_B 0.7, 2.0 to 0.8,
//   2.4 above, the Finnish Maritime Administration's);
// - Huuska and Guliev: the same times K_s = 7.45 s_1 + 0.76 (s_1 > 0.03, else 1), s_1 the blockage S K_1, for channels;
// - Hooft, after E. O. Tuck, "Shallow-water flows past slender bodies", J. Fluid Mech. 26, 1966: mean sinkage C_z (V / L^2)
//   Fn_h^2 / sqrt(1 - Fn_h^2) with C_z 1.46 (of 1.4 to 1.53), and trim by the stern C_theta (V / L^3) Fn_h^2 / sqrt(1 -
//   Fn_h^2) radians with C_theta 1, the scaling Tuck's slender-body theory gives in open water of constant depth.
// Fn_h = V / sqrt(g h). All hold below Fn_h 0.7 (Huuska's limit), where the flow under the ship is still subcritical.
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { shipError } from './errors.js';

/** What a squat law needs: the ship's length, beam, draught, block coefficient, its speed, the water's depth. */
export interface SquatCase {
  readonly length: number;
  readonly beam: number;
  readonly draught: number;
  readonly block: number;
  /** Speed through the water, m/s. */
  readonly speed: number;
  /** The water's depth, m. */
  readonly depth: number;
  /** For a channel: its cross-section's area, m^2 (default open water), and K_1 of Huuska's diagram (default 1, a canal). */
  readonly channel?: { readonly area: number; readonly k1?: number };
  readonly gravity?: number;
}

/** A ship's squat: the bow's sinkage, the mean sinkage and the trim by the stern (radians), m. */
export interface Squat {
  bow: number;
  mean: number;
  trim: number;
  /** The depth Froude number V / sqrt(g h). */
  froude: number;
}

function depthFroude(c: SquatCase): number {
  const { length, beam, draught, block, speed, depth } = c ?? ({} as SquatCase);
  for (const [name, v] of [
    ['length', length],
    ['beam', beam],
    ['draught', draught],
    ['block', block],
    ['depth', depth],
  ] as const)
    if (!(v > 0 && Number.isFinite(v)))
      throw shipError(`A squat case's ${name} is finite and above 0 (got ${v}); pass it.`);
  if (!(depth > draught))
    throw shipError(`The water (${depth} m) is deeper than the draught (${draught} m) for a ship afloat; pass both.`);
  if (!(speed >= 0 && Number.isFinite(speed)))
    throw shipError(`A speed is finite m/s, 0 or more (got ${speed}); pass one.`);
  const g = c.gravity ?? gravityMagnitude(DEFAULT_GRAVITY),
    fn = speed / Math.sqrt(g * depth);
  if (!(fn < 0.7))
    throw shipError(
      `Squat laws hold below a depth Froude number of 0.7 (got ${fn.toFixed(3)}); slow the ship or deepen the water.`,
    );
  return fn;
}

/**
 * A ship's squat in open water or a channel: the bow's by ICORELS (with Huuska's channel factor when `channel` is given),
 * the mean sinkage and the trim by Hooft's form of Tuck's law.
 */
export function squat(c: SquatCase): Squat {
  const fn = depthFroude(c),
    { length: L, beam: B, draught: T, block: CB } = c,
    volume = CB * L * B * T,
    shape = ((volume / (L * L)) * fn * fn) / Math.sqrt(1 - fn * fn),
    cs = CB < 0.7 ? 1.7 : CB < 0.8 ? 2.0 : 2.4;
  let ks = 1;
  if (c.channel) {
    if (!(c.channel.area > 0.98 * B * T))
      throw shipError(
        `A channel's cross-section (${c.channel.area} m^2) is larger than the ship's; pass its area in m^2.`,
      );
    const s1 = ((0.98 * B * T) / c.channel.area) * (c.channel.k1 ?? 1);
    ks = s1 > 0.03 ? 7.45 * s1 + 0.76 : 1;
  }
  return { bow: cs * shape * ks, mean: 1.46 * shape * ks, trim: (shape * ks) / L, froude: fn };
}

/** ICORELS' bow squat with a given C_S (2.4 its mean), m. */
export function icorels(c: SquatCase, cs = 2.4): number {
  const fn = depthFroude(c),
    volume = c.block * c.length * c.beam * c.draught;
  return ((cs * volume) / (c.length * c.length)) * ((fn * fn) / Math.sqrt(1 - fn * fn));
}

/** Huuska and Guliev's bow squat in a channel of cross-section `area` m^2 (C_S 2.4, K_1 from Huuska's diagram, 1 for a canal), m. */
export function huuska(c: SquatCase, area: number, k1 = 1): number {
  const s1 = ((0.98 * c.beam * c.draught) / area) * k1;
  return icorels(c) * (s1 > 0.03 ? 7.45 * s1 + 0.76 : 1);
}
