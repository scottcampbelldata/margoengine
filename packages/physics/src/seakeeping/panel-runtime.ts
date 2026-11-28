import { atan2 } from '../ship/propeller.js';
import { cos, hypot, sin } from '@margoengine/math/pinned';
import { kernelOf, type RadiationPair } from './memory.js';
import { depthRatio, type HullPanelResponse } from './panels.js';
import type { Vec3 } from './wetted.js';

const AXES = 6;
const TWO_PI = 2 * Math.PI;

/** Samples the same Cummins transform as the strip model, including an explicit continuous high band end. */
export function panelDampingKernels(table: HullPanelResponse, dt: number, lags: number): readonly RadiationPair[] {
  const last = table.frequencies.length - 1,
    end = 2 * table.frequencies[last]! - table.frequencies[last - 1]!,
    frequencies = Float64Array.from([...table.frequencies, end]),
    pairs: RadiationPair[] = [];
  for (let i = 0; i < AXES; i++) {
    for (let j = i; j < AXES; j++) {
      const component = i * AXES + j;
      const values = table.samples.map(({ damping }) => damping[component]!);
      if (values.every((value) => value === 0)) continue;
      const damping = Float64Array.from([...values, 0]);
      pairs.push({ i, j, damping, kernel: kernelOf(frequencies, damping, dt, lags * dt) });
    }
  }
  return pairs;
}

function band(frequencies: readonly number[], frequency: number): number {
  let lo = 0;
  let hi = frequencies.length - 1;
  while (hi - lo > 1) {
    const middle = (lo + hi) >>> 1;
    if (frequency < frequencies[middle]!) hi = middle;
    else lo = middle;
  }
  return lo;
}

/** Linear scattered force per incident component. The wetted mesh supplies Froude–Krylov separately. */
export function panelDiffraction(
  table: HullPanelResponse,
  rows: Float32Array,
  count: number,
  origin: Vec3,
  forward: Vec3,
  across: Vec3,
  force: Float64Array,
): void {
  force.fill(0);
  const { frequencies, headings, samples } = table;
  if (headings === 0) return;
  const final = frequencies.length - 1;
  const last = frequencies[final]!;
  const tail = last - frequencies[final - 1]!;
  for (let i = 0; i < count; i++) {
    const at = 4 * i;
    const [kx, kz, amplitude, phase] = [rows[at]!, rows[at + 1]!, rows[at + 2]!, rows[at + 3]!];
    const k = hypot(kx, kz);
    if (!(amplitude > 0 && k > 0)) continue;
    const omega = Math.sqrt(table.gravity * k * depthRatio(k, table.depth));
    // Taper scattering outside the sampled band. The caller retains the immersed pressure there.
    if (omega >= last + tail) continue;
    const above = omega > last;
    const low = above ? final : band(frequencies, omega);
    const below = omega < frequencies[0]!;
    const weight = above
      ? 1 - (omega - last) / tail
      : below
        ? omega / frequencies[0]!
        : (omega - frequencies[low]!) / (frequencies[low + 1]! - frequencies[low]!);
    const direction = atan2(kx * across[0] + kz * across[2], kx * forward[0] + kz * forward[2]);
    const wrapped = ((direction < 0 ? direction + TWO_PI : direction) * headings) / TWO_PI;
    const h = Math.floor(wrapped);
    const s = 2 * AXES * (h % headings);
    const t = 2 * AXES * ((h + 1) % headings);
    const ratio = wrapped - h;
    const previous = samples[low]!.diffraction;
    const next = samples[low + 1]?.diffraction;
    const phaseAtOrigin = phase + kx * origin[0] + kz * origin[2];
    const re = amplitude * cos(phaseAtOrigin);
    const im = -amplitude * sin(phaseAtOrigin);
    for (let j = 0; j < 2 * AXES; j++) {
      const p = previous[s + j]! + ratio * (previous[t + j]! - previous[s + j]!);
      const value =
        below || !next ? p * weight : p + weight * (next[s + j]! + ratio * (next[t + j]! - next[s + j]!) - p);
      force[j >>> 1]! += value * (j % 2 === 0 ? re : im);
    }
  }
}
