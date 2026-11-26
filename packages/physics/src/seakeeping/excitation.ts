import type { Vec3 } from './wetted.js';
import type { HullMemory, HullWaveMemory } from './memory.js';
import { cos, exp, hypot, sin } from '@margoengine/math/pinned';

const WORDS = 3;
interface EncounterBand {
  readonly low: number;
  readonly fraction: number;
  readonly edge: 'low' | 'high' | 'inside';
}

function encounterBand(frequencies: Float64Array, frequency: number): EncounterBand {
  const last = frequencies.length - 1;
  if (frequency < frequencies[0]!) return { low: 0, fraction: frequency / frequencies[0]!, edge: 'low' };
  if (frequency >= frequencies[last]!) return { low: last, fraction: frequencies[last]! / frequency, edge: 'high' };
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (frequencies[mid]! > frequency) hi = mid;
    else lo = mid;
  }
  return { low: lo, fraction: (frequency - frequencies[lo]!) / (frequencies[hi]! - frequencies[lo]!), edge: 'inside' };
}

/** Slowly varying vertical wave transfer with no cancellation at very small depth-to-wavelength ratios. */
function verticalTransfer(k: number, depth: number, draft: number): number {
  if (depth === Infinity) return exp(-k * draft);
  if (!(depth > draft)) return 0;
  const depthNumber = k * depth;
  if (depthNumber < 1e-5) return 1 - draft / depth;
  return (exp(-k * draft) * (1 - exp(-2 * k * (depth - draft)))) / (1 - exp(-2 * depthNumber));
}

function retainedCoefficients(
  memory: HullWaveMemory,
  band: EncounterBand,
  encounter: number,
  frequency: number,
  values: Float64Array,
): void {
  const { low, fraction, edge } = band;
  for (let i = 0; i < memory.stripForms.length; i++) {
    const form = memory.stripForms[i]!;
    const { added, damping, staticMass } = memory.waveResponses![i]!;
    let mass = added[low]!;
    let drag = damping[low]!;
    let ratio: number;
    if (edge === 'low') {
      // The finite Cummins window has finite static mass. Continue its even mass and odd B/w
      // smoothly through a stationary encounter, matched to the first resolved strip frequency.
      const square = fraction * fraction;
      mass = staticMass + (mass - staticMass) * square;
      ratio = (drag * fraction * Math.sign(encounter)) / memory.frequencies[0]!;
      drag *= square;
    } else {
      if (edge === 'high') {
        const square = fraction * fraction;
        mass = form.a33 + (mass - form.a33) * square;
        drag *= square;
      } else {
        mass += fraction * (added[low + 1]! - mass);
        drag += fraction * (damping[low + 1]! - drag);
      }
      ratio = drag / encounter;
    }
    const at = WORDS * i;
    values[at] = mass;
    values[at + 1] = frequency * ratio - drag;
    values[at + 2] = mass - form.a33;
  }
}

function massGradient(strips: HullMemory['strips'], at: number, values: Float64Array): number {
  if (strips.length < 2) return 0;
  const start = Math.max(0, Math.min(at - 1, strips.length - 3));
  const a = strips[start]!;
  const b = strips[start + 1]!;
  const va = values[WORDS * a.form]!;
  const vb = values[WORDS * b.form]!;
  const slope = (vb - va) / (b.x - a.x);
  const c = strips[start + 2];
  if (!c) return slope;
  const curvature = ((values[WORDS * c.form]! - vb) / (c.x - b.x) - slope) / (c.x - a.x);
  const x = strips[at]!.x;
  return slope + curvature * (x - a.x + x - b.x);
}

/**
 * The ordinary-strip correction to the incident-wave heave and pitch excitation (Journée–Massie 8.47–8.48).
 * Subtract only the spectral part already in the moving relative-motion convolution, retaining the live water field.
 */
export function courseWaveCorrection(
  memory: HullWaveMemory,
  rows: Float32Array,
  count: number,
  depth: number,
  gravity: number,
  centre: Vec3,
  forward: Vec3,
  velocityX: number,
  velocityZ: number,
  speed: number,
  scratch: Float64Array,
): readonly [heave: number, pitch: number] {
  if (!(depth > 0)) return [0, 0];
  let heave = 0;
  let pitch = 0;
  const { strips, frequencies } = memory;
  for (let i = 0; i < count; i++) {
    const wave = 4 * i;
    const amplitude = rows[wave + 2]!;
    if (!(amplitude > 0)) continue;
    const kx = rows[wave]!;
    const kz = rows[wave + 1]!;
    const k = hypot(kx, kz);
    if (!(k > 0)) continue;
    const kd = k * depth;
    const bottom = depth === Infinity ? 0 : exp(-2 * kd);
    const shallow = kd < 1e-5 ? kd : (1 - bottom) / (1 + bottom);
    const omega = Math.sqrt(gravity * k * shallow);
    const encounter = omega - kx * velocityX - kz * velocityZ;
    const band = encounterBand(frequencies, Math.abs(encounter));
    retainedCoefficients(memory, band, encounter, omega, scratch);
    const phase = rows[wave + 3]! + kx * centre[0] + kz * centre[2];
    const along = kx * forward[0] + kz * forward[2];
    for (let j = 0; j < strips.length; j++) {
      const strip = strips[j]!;
      const gradient = massGradient(strips, j, scratch);
      const angle = phase + along * strip.x;
      const orbital = amplitude * omega * verticalTransfer(k, depth, strip.heaveDepth);
      const at = WORDS * strip.form;
      const force =
        strip.width *
        orbital *
        ((scratch[at + 1]! - speed * gradient) * sin(angle) - scratch[at + 2]! * (omega - encounter) * cos(angle));
      heave += force;
      pitch += strip.x * force;
    }
  }
  return [heave, pitch];
}
