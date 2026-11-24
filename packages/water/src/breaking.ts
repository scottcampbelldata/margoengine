// Breaking and plunging wave fronts over a flood (film gap FG-04). The shallow-water flood (flood.ts) carries one height
// per cell, so a bore or a tsunami front draws as a steep hump and never overturns. This entry finds the breaking fronts
// of a flood frame and builds the overturning crest as a mesh drawn over the flood surface, in the way of N. Thuerey,
// M. Mueller-Fischer, S. Schirm and M. Gross, "Real-time breaking waves for shallow water simulations", Pacific Graphics
// 2007, https://doi.org/10.1109/PG.2007.54: steep fronts are detected on the height field and an overturning sheet is
// added there. Sources (papers, read as text; no code):
// - The front: a cell whose surface stands at least `minHeight` above the water (or dry ground) one cell ahead along
//   the flow, where the flood's white-water channel (its breaker, flood-shaders.ts) is at least `threshold`, and no
//   lower than the drop of the cell behind it (one front cell across). Fronts are linked across the flow into lines.
// - Which way it breaks: the surf similarity (Iribarren) number xi = tan(beta) / sqrt(H / L0), L0 = g T^2 / (2 pi):
//   spilling under 0.5, plunging from 0.5 to 3.3, surging above (J. A. Battjes, "Surf similarity", Proc. 14th Coastal
//   Engineering Conf., 1974, https://doi.org/10.9753/icce.v14.26). Margo ramps the curl from 0 at xi 0.4 to 1 at 0.7 and
//   back to 0 from 3.3 to 4 (surging fronts do not overturn); `plunge` sets it by hand.
// - The jet: the plunging lip is thrown forward at the crest speed and then falls nearly freely (M. S. Longuet-Higgins,
//   "Parametric solutions for breaking waves", J. Fluid Mech. 121, 1982, https://doi.org/10.1017/S0022112082001840;
//   D. H. Peregrine, "Breaking waves on beaches", Annu. Rev. Fluid Mech. 15, 1983,
//   https://doi.org/10.1146/annurev.fl.15.010183.001053), so at a breaking phase p the sheet is the parabola
//   y = crest - H (p x / R)^2 out to its tip at x = p R, R = c sqrt(2 H / g), the distance it covers while falling H,
//   with c = sqrt(g (h + H)) the speed of a bore of height H into water h deep (J. J. Stoker, Water Waves, 1957,
//   ch. 10). At p = 1 the tip meets the water ahead and closes the tube. The phase is the breaker's share above
//   `threshold`.
// Margo's own choices are named where they are made: the sheet's thickness (a fifth of H at the root, thinning to 30
// percent at the tip), R capped at 2.5 H, the back's length (3 H) and the 26-point section.
import { WgslMaterial, type MaterialOptions } from '@margoengine/materials';
import type { FloodReading } from './flood.js';

const G = 9.81,
  WET = 1e-3,
  /** Points of one front section, from the back to the toe (the mesh's rows). */
  SECTION = 26;

/** Options for {@link breakingFronts}. */
export interface BreakingFrontOptions {
  /** The map's world placement, the Water terrain's `origin` [x, z] and `size` [x, z] in metres. */
  place: { origin: readonly [number, number]; size: readonly [number, number] };
  /** Breaker (0..1) at which a front starts to break. Default 0.3. */
  threshold?: number;
  /** Least drop to the water ahead, metres, 0.01..1000. Default 0.5. */
  minHeight?: number;
  /** Swell period T in seconds for the Iribarren number's L0, 1..60. Default 10. */
  period?: number;
  /** 'auto' (default) takes the curl from the Iribarren number; 0..1 sets it (0 spills, 1 plunges). */
  plunge?: 'auto' | number;
  /** Least flow speed of a breaking front, m/s, 0..100. Default 0.1. */
  minSpeed?: number;
}

/** One breaking front line: `count` points, each a crest on the flood surface. */
export interface BreakingFront {
  count: number;
  /** x, y, z per point: the crest (the flood surface at the front cell's centre). */
  position: Float32Array;
  /** x, z per point: the unit direction the front runs. */
  direction: Float32Array;
  /** The drop to the water ahead, metres. */
  height: Float32Array;
  /** The surface (or dry ground) one cell ahead, metres. */
  base: Float32Array;
  /** The water depth ahead the front runs into, metres (0 on dry ground). */
  depth: Float32Array;
  /** The breaker, 0..1. */
  breaker: Float32Array;
  /** The breaking phase, 0..1: the breaker's share above the threshold. */
  phase: Float32Array;
  /** The curl, 0 (spilling) to 1 (plunging). */
  curl: Float32Array;
  /** The Iribarren number of the point. */
  iribarren: Float32Array;
  /** The cell index (row-major, rows of increasing z) per point. */
  cell: Uint32Array;
}

const inRange = (v: unknown, fallback: number, name: string, lo: number, hi: number): number => {
  const x = v ?? fallback;
  if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi)
    throw new RangeError(`Breaking front ${name} must be a number from ${lo} to ${hi}`);
  return x;
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The curl Margo gives an Iribarren number: none spilling, full plunging, none again surging (Battjes 1974). */
export function breakerCurl(iribarren: number): number {
  if (!(iribarren > 0)) return 0;
  return clamp01((iribarren - 0.4) / 0.3) * (1 - clamp01((iribarren - 3.3) / 0.7));
}

/**
 * The breaking fronts of a flood frame (a `flood.read()`), as lines of crest points ordered along each front.
 * Deterministic: the same reading and options give the same fronts in the same order.
 * @throws TypeError without a reading or `place`; RangeError for an option out of its range.
 */
export function breakingFronts(reading: FloodReading, options: BreakingFrontOptions): BreakingFront[] {
  if (!reading || !(reading.depth instanceof Float32Array) || reading.depth.length !== reading.width * reading.height)
    throw new TypeError('Breaking fronts need a reading from flood.read()');
  const place = options?.place;
  if (
    !place ||
    !Array.isArray(place.origin) ||
    !Array.isArray(place.size) ||
    ![...place.origin, ...place.size].every((v) => Number.isFinite(v)) ||
    !(place.size[0] > 0 && place.size[1] > 0)
  )
    throw new TypeError('Breaking fronts need place: { origin: [x, z], size: [x, z] }, the Water terrain placement');
  const threshold = inRange(options.threshold, 0.3, 'threshold', 0, 0.999),
    minHeight = inRange(options.minHeight, 0.5, 'minHeight', 0.01, 1000),
    period = inRange(options.period, 10, 'period', 1, 60),
    minSpeed = inRange(options.minSpeed, 0.1, 'minSpeed', 0, 100),
    plunge = options.plunge ?? 'auto';
  if (plunge !== 'auto') inRange(plunge, 0, 'plunge', 0, 1);
  const { width, height, depth, bed, velocity, breaker } = reading,
    dx = place.size[0] / width,
    dz = place.size[1] / height,
    L0 = (G * period * period) / (2 * Math.PI),
    n = width * height,
    surface = (k: number) => (depth[k] > WET ? bed[k] + depth[k] : bed[k]),
    // The step one cell along the flow at k (8 directions), or -1 off the map.
    step = (k: number, sign: number): number => {
      const s = Math.hypot(velocity[2 * k], velocity[2 * k + 1]),
        x = k % width,
        z = (k - x) / width,
        ox = Math.round((sign * velocity[2 * k]) / s),
        oz = Math.round((sign * velocity[2 * k + 1]) / s),
        nx = x + ox,
        nz = z + oz;
      return nx < 0 || nz < 0 || nx >= width || nz >= height ? -1 : nz * width + nx;
    },
    drop = new Float32Array(n).fill(-Infinity);
  for (let k = 0; k < n; k++) {
    if (!(depth[k] > WET) || !(breaker[k] >= threshold) || breaker[k] <= 0) continue;
    if (!(Math.hypot(velocity[2 * k], velocity[2 * k + 1]) > Math.max(minSpeed, 1e-6))) continue;
    const ahead = step(k, 1);
    if (ahead >= 0) drop[k] = surface(k) - surface(ahead);
  }
  const front = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (!(drop[k] >= minHeight)) continue;
    const behind = step(k, -1),
      ahead = step(k, 1);
    if (behind >= 0 && drop[behind] > drop[k]) continue;
    if (ahead >= 0 && drop[ahead] >= drop[k]) continue;
    front[k] = 1;
  }
  // Link the front cells into lines across the flow: from each unvisited cell (in index order) walk both ways to the
  // neighbour best along the front (within 60 degrees of the last step, or of the tangent at the start).
  const seen = new Uint8Array(n),
    lines: BreakingFront[] = [];
  const walk = (start: number, tx: number, tz: number): number[] => {
    const out: number[] = [];
    let c = start;
    for (;;) {
      const x = c % width,
        z = (c - x) / width;
      let best = -1,
        score = 0.5,
        bx = 0,
        bz = 0;
      for (let oz = -1; oz <= 1; oz++)
        for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox,
            nz = z + oz;
          if ((!ox && !oz) || nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
          const m = nz * width + nx;
          if (!front[m] || seen[m]) continue;
          const len = Math.hypot(ox * dx, oz * dz),
            s = (ox * dx * tx + oz * dz * tz) / len;
          if (s > score) (score = s), (best = m), (bx = (ox * dx) / len), (bz = (oz * dz) / len);
        }
      if (best < 0) return out;
      seen[best] = 1;
      out.push(best);
      (c = best), (tx = bx), (tz = bz);
    }
  };
  for (let k = 0; k < n; k++) {
    if (!front[k] || seen[k]) continue;
    seen[k] = 1;
    const s = Math.hypot(velocity[2 * k], velocity[2 * k + 1]),
      tx = -velocity[2 * k + 1] / s,
      tz = velocity[2 * k] / s,
      cells = [...walk(k, -tx, -tz).reverse(), k, ...walk(k, tx, tz)],
      count = cells.length,
      line: BreakingFront = {
        count,
        position: new Float32Array(count * 3),
        direction: new Float32Array(count * 2),
        height: new Float32Array(count),
        base: new Float32Array(count),
        depth: new Float32Array(count),
        breaker: new Float32Array(count),
        phase: new Float32Array(count),
        curl: new Float32Array(count),
        iribarren: new Float32Array(count),
        cell: Uint32Array.from(cells),
      };
    cells.forEach((c, i) => {
      const x = c % width,
        z = (c - x) / width,
        u = velocity[2 * c],
        v = velocity[2 * c + 1],
        sp = Math.hypot(u, v),
        ahead = step(c, 1),
        H = drop[c],
        run = Math.hypot(Math.round(u / sp) * dx, Math.round(v / sp) * dz),
        slope = Math.max(0, (bed[ahead] - bed[c]) / run),
        xi = slope / Math.sqrt(H / L0);
      line.position.set([place.origin[0] + (x + 0.5) * dx, surface(c), place.origin[1] + (z + 0.5) * dz], 3 * i);
      line.direction.set([u / sp, v / sp], 2 * i);
      line.height[i] = H;
      line.base[i] = surface(ahead);
      line.depth[i] = depth[ahead] > WET ? depth[ahead] : 0;
      line.breaker[i] = breaker[c];
      line.phase[i] = clamp01((breaker[c] - threshold) / (1 - threshold));
      line.iribarren[i] = xi;
      line.curl[i] = plunge === 'auto' ? breakerCurl(xi) : plunge;
    });
    lines.push(line);
  }
  return lines;
}

/** The mesh {@link breakingWaveGeometry} builds: a `createMesh` geometry (`@margoengine/materials`). */
export interface BreakingWaveGeometry {
  positions: Float32Array;
  normals: Float32Array;
  /** u: metres along the front; v: 0 at the back to 1 at the toe, by arc length. */
  uvs: Float32Array;
  /** x: the water's thickness behind the surface there, metres; y: the white water there, 0..1. */
  uvs1: Float32Array;
  indices: Uint32Array;
}

/** One section's profile in the front's own plane: s forward (m), y up (m), thickness (m), white water (0..1). */
export interface BreakingSection {
  s: Float32Array;
  y: Float32Array;
  thickness: Float32Array;
  white: Float32Array;
}

/**
 * The cross-section of a breaking front at one crest point: the back, the crest, the jet's top to its tip, the jet's
 * underside back to the root, and the face down to the toe; {@link SECTION_POINTS} points, s = 0 at the crest.
 */
export function breakingSection(
  crest: number,
  height: number,
  base: number,
  depth: number,
  phase: number,
  curl: number,
  breaker = 1,
): BreakingSection {
  const H = Math.max(0, height),
    p = clamp01(phase) * clamp01(curl),
    reach = Math.min(Math.sqrt(2 * H * (Math.max(0, depth) + H)), 2.5 * H) * p,
    root = Math.max(0.2 * H * p, 0.02 * H),
    toe = 1.2 * H * (1 - p) + 0.3 * reach,
    out: BreakingSection = {
      s: new Float32Array(SECTION),
      y: new Float32Array(SECTION),
      thickness: new Float32Array(SECTION),
      white: new Float32Array(SECTION),
    },
    b = clamp01(breaker);
  let i = 0;
  const put = (s: number, y: number, t: number, w: number) => {
    out.s[i] = s;
    out.y[i] = y;
    out.thickness[i] = t;
    out.white[i++] = clamp01(w);
  };
  // Back: 3 H long, rising 5 percent of H to the crest.
  for (let k = 0; k < 4; k++) {
    const a = k / 4;
    put(-3 * H * (1 - a), crest - 0.05 * H * (1 - a * a), 3 * H, 0);
  }
  put(0, crest, H, 0.6 * b * (0.3 + 0.7 * p));
  // Jet top: the free-fall parabola out to the tip.
  const thick = (j: number) => root * (1 - 0.7 * j),
    jy = (j: number) => crest - H * p * p * j * j;
  for (let k = 1; k <= 8; k++) {
    const j = k / 8;
    put(reach * j, jy(j), thick(j), b * (j < 0.3 ? 0.6 : j > 0.7 ? 1 : 0.3));
  }
  put(reach + 0.5 * thick(1), jy(1) - 0.5 * thick(1), thick(1), b);
  // Jet underside, from the tip back to the root.
  for (let k = 6; k >= 1; k--) {
    const j = (k - 1) / 6;
    put(reach * j, jy(j) - thick(j), thick(j), b * (j > 0.7 ? 0.8 : 0));
  }
  // Face: vertical under the root, flattening into the toe.
  const top = crest - root;
  for (let k = 1; k <= 6; k++) {
    const q = k / 6;
    put(toe * q * q, top - (top - base) * (2 * q - q * q), root + 2 * H * q, k >= 5 ? b * p : 0);
  }
  return out;
}
/** Points of one {@link breakingSection}. */
export const SECTION_POINTS = SECTION;

/**
 * The overturning crest of `fronts` as one mesh: a {@link breakingSection} at every crest point and a tapered one past
 * each end of a line, joined along the front. Draw it with a {@link BreakingWaveMaterial}; it rides over the flood
 * surface, whose own front is the mesh's back. Empty (no vertices) for no fronts.
 */
export function breakingWaveGeometry(fronts: readonly BreakingFront[]): BreakingWaveGeometry {
  let rows = 0,
    quads = 0;
  for (const f of fronts) if (f.count) (rows += f.count + 2), (quads += (f.count + 1) * (SECTION - 1));
  const positions = new Float32Array(rows * SECTION * 3),
    normals = new Float32Array(rows * SECTION * 3),
    uvs = new Float32Array(rows * SECTION * 2),
    uvs1 = new Float32Array(rows * SECTION * 2),
    indices = new Uint32Array(quads * 6);
  let row = 0,
    tri = 0;
  for (const f of fronts) {
    if (!f.count) continue;
    const first = row,
      count = f.count + 2;
    let along = 0;
    for (let r = 0; r < count; r++) {
      // Rows 0 and count - 1 are the tapers: half a cell past the end along the front, a twentieth of the height.
      const i = Math.min(f.count - 1, Math.max(0, r - 1)),
        end = r === 0 ? -1 : r === count - 1 ? 1 : 0,
        dxn = f.direction[2 * i],
        dzn = f.direction[2 * i + 1];
      let px = f.position[3 * i],
        pz = f.position[3 * i + 2];
      if (end) {
        // Along the line (from the neighbouring point), or across the flow for a one-point line.
        const j = Math.min(f.count - 1, Math.max(0, i - end));
        let tx = px - f.position[3 * j],
          tz = pz - f.position[3 * j + 2],
          len = Math.hypot(tx, tz),
          half = 0.5 * len;
        if (!(len > 0)) (tx = -dzn * end), (tz = dxn * end), (len = 1), (half = 0.5 * f.height[i]);
        (px += (tx / len) * half), (pz += (tz / len) * half);
      }
      if (r > 0)
        along += Math.hypot(px - positions[3 * (row - 1) * SECTION], pz - positions[3 * (row - 1) * SECTION + 2]);
      const H = f.height[i] * (end ? 0.05 : 1),
        sec = breakingSection(
          f.position[3 * i + 1],
          H,
          f.position[3 * i + 1] - H,
          f.depth[i],
          f.phase[i],
          f.curl[i],
          f.breaker[i],
        );
      let arc = 0;
      const arcs = new Float32Array(SECTION);
      for (let k = 1; k < SECTION; k++) arcs[k] = arc += Math.hypot(sec.s[k] - sec.s[k - 1], sec.y[k] - sec.y[k - 1]);
      for (let k = 0; k < SECTION; k++) {
        const v = row * SECTION + k;
        positions.set([px + dxn * sec.s[k], sec.y[k], pz + dzn * sec.s[k]], 3 * v);
        uvs.set([along, arc > 0 ? arcs[k] / arc : k / (SECTION - 1)], 2 * v);
        uvs1.set([sec.thickness[k], sec.white[k]], 2 * v);
      }
      row++;
    }
    // Normals by central differences over the grid, turned so the crest's faces up.
    let flip = 1;
    for (let r = 0; r < count; r++)
      for (let k = 0; k < SECTION; k++) {
        const at = (rr: number, kk: number) =>
            3 * ((first + Math.min(count - 1, Math.max(0, rr))) * SECTION + Math.min(SECTION - 1, Math.max(0, kk))),
          a = at(r + 1, k),
          b = at(r - 1, k),
          c = at(r, k + 1),
          d = at(r, k - 1),
          ux = positions[a] - positions[b],
          uy = positions[a + 1] - positions[b + 1],
          uz = positions[a + 2] - positions[b + 2],
          vx = positions[c] - positions[d],
          vy = positions[c + 1] - positions[d + 1],
          vz = positions[c + 2] - positions[d + 2];
        let nx = vy * uz - vz * uy,
          ny = vz * ux - vx * uz,
          nz = vx * uy - vy * ux;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-12) (nx /= len), (ny /= len), (nz /= len);
        else (nx = 0), (ny = 1), (nz = 0);
        normals.set([nx, ny, nz], 3 * ((first + r) * SECTION + k));
      }
    const mid = 3 * ((first + (count >> 1)) * SECTION + 4);
    if (normals[mid + 1] < 0) flip = -1;
    if (flip < 0) for (let v = 3 * first * SECTION; v < 3 * row * SECTION; v++) normals[v] = -normals[v];
    for (let r = 0; r + 1 < count; r++)
      for (let k = 0; k + 1 < SECTION; k++) {
        const a = (first + r) * SECTION + k,
          b = a + SECTION;
        // Wound counter-clockwise about the normals (the front faces).
        if (flip > 0) indices.set([a, a + 1, b, a + 1, b + 1, b], tri);
        else indices.set([a, b, a + 1, a + 1, b, b + 1], tri);
        tri += 6;
      }
  }
  return { positions, normals, uvs, uvs1, indices };
}

/** The look of a {@link BreakingWaveMaterial}. */
export interface BreakingWaveLook {
  /** Absorption of the water, per metre, red, green and blue. Default pure water (Pope and Fry 1997): 0.35, 0.06, 0.02. */
  absorption: readonly [number, number, number];
  /** Colour the water scatters back, linear. Default a grey-green [0.03, 0.06, 0.05]. */
  scatter: readonly [number, number, number];
  /** Suspended sediment, kilograms per cubic metre, 0..50 (FG-13 flood water over soil). Default 0. */
  sediment: number;
  /** Colour of the white water, linear. Default [0.85, 0.87, 0.88]. */
  foam: readonly [number, number, number];
  /** How strongly light coming through the thin lip shows, 0..4. Default 1. */
  transmission: number;
  /** Henyey-Greenstein forward scattering of the light through the lip, 0..0.95. Default 0.6. */
  forward: number;
}
/** {@link BreakingWaveLook}'s defaults. */
export const BREAKING_WAVE_LOOK: Readonly<BreakingWaveLook> = Object.freeze({
  absorption: Object.freeze([0.35, 0.06, 0.02]) as unknown as readonly [number, number, number],
  scatter: Object.freeze([0.03, 0.06, 0.05]) as unknown as readonly [number, number, number],
  sediment: 0,
  foam: Object.freeze([0.85, 0.87, 0.88]) as unknown as readonly [number, number, number],
  transmission: 1,
  forward: 0.6,
});

// The face (FG-12): body colour the water scatters back times the share of light the sheet does not let through,
// light through the sheet attenuated by Beer-Lambert over its thickness (uvs1.x) and spread forward by a
// Henyey-Greenstein phase (L. G. Henyey and J. L. Greenstein, "Diffuse radiation in the galaxy", Astrophys. J. 93,
// 1941, https://doi.org/10.1086/144246) about the light's direction, white water (uvs1.y) on top. Absorption of pure
// water: R. M. Pope and E. S. Fry, "Absorption spectrum (380-700 nm) of pure water. II", Appl. Opt. 36(33), 1997,
// https://doi.org/10.1364/AO.36.008710, at about 650, 550 and 450 nm. Sediment adds the non-algal particle absorption
// a(l) = a(443) exp(-0.0123 (l - 443)) with a(443) = 0.041 m^2/g x concentration (41 per metre for each kg/m^3) (M. Babin et al., "Variations in the
// light absorption coefficients of phytoplankton, nonalgal particles, and dissolved organic matter in coastal waters
// around Europe", J. Geophys. Res. 108(C7), 2003, https://doi.org/10.1029/2001JC000882) and a brown back-scatter of
// 0.02 per g/l (Margo's choice) that turns the face a brown-grey.
const WAVE_WGSL = /* wgsl */ `
fn waveHG(c:f32,g:f32)->f32 {let d=1.0+g*g-2.0*g*c;return (1.0-g*g)/(12.566371*pow(max(d,1e-4),1.5));}
fn shade(i:Out,s:Surface)->Surface {
 var o=s;let thick=max(i.uv.z,0.0);let white=clamp(i.uv.w,0.0,1.0);
 let mud=uniforms.waveLook.x;
 let sigma=uniforms.waveAbsorb.rgb+mud*41.0*vec3f(exp(-0.0123*207.0),exp(-0.0123*107.0),exp(-0.0123*7.0));
 let through=exp(-sigma*thick);
 let back=uniforms.waveScatter.rgb+mud*0.02*vec3f(0.55,0.42,0.3);
 let body=back*(1.0-through*0.5);
 let v=normalize(f.eye.xyz-i.position);let l=normalize(f.light.xyz);
 let phase=waveHG(dot(v,-l),uniforms.waveLook.z)*12.566371;
 let lit=through*f.radiance.rgb*phase*uniforms.waveLook.y*(1.0-white);
 o.base=vec4f(mix(body,uniforms.waveFoam.rgb,white),o.base.a);
 o.roughness=mix(0.05,0.6,white);o.metal=0.0;
 o.emissive=o.emissive+lit*(back+vec3f(0.02,0.05,0.04));
 return o;
}
`;

const triple = (v: unknown, name: string, hi: number): [number, number, number] => {
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    !v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= hi)
  )
    throw new RangeError(`Breaking wave ${name} must be three numbers from 0 to ${hi}`);
  return [v[0], v[1], v[2]];
};

/**
 * The material of a breaking wave mesh: a dark, translucent grey-green face, light through the thin lip, white only
 * where the crest, the tip and the toe break (FG-12), and brown-grey churn with `sediment` (FG-13). Double-sided.
 */
export class BreakingWaveMaterial extends WgslMaterial {
  /** The look; change it with `setLook`. */
  readonly look: BreakingWaveLook;
  constructor(options: Omit<MaterialOptions, 'shading'> & { look?: Partial<BreakingWaveLook> } = {}) {
    const { look, ...rest } = options;
    super({
      roughness: 0.05,
      doubleSided: true,
      ...rest,
      wgsl: WAVE_WGSL,
      uniforms: { waveAbsorb: [0, 0, 0, 0], waveScatter: [0, 0, 0, 0], waveFoam: [0, 0, 0, 0], waveLook: [0, 0, 0, 0] },
    });
    this.look = { ...BREAKING_WAVE_LOOK };
    this.setLook(look ?? {});
  }
  /** Changes look values (a name left out keeps its value). */
  setLook(look: Partial<BreakingWaveLook>): this {
    const next = { ...this.look };
    for (const [key, value] of Object.entries(look ?? {})) {
      if (!(key in BREAKING_WAVE_LOOK))
        throw new TypeError(`Unknown breaking wave look ${key}; use a name of BREAKING_WAVE_LOOK`);
      if (key === 'absorption') next.absorption = triple(value, key, 100);
      else if (key === 'scatter' || key === 'foam') next[key] = triple(value, key, 1);
      else {
        const [lo, hi] = key === 'sediment' ? [0, 50] : key === 'transmission' ? [0, 4] : [0, 0.95];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi)
          throw new RangeError(`Breaking wave ${key} must be a number from ${lo} to ${hi}`);
        (next as Record<string, unknown>)[key] = value;
      }
    }
    Object.assign(this.look, next);
    const u = this.uniforms as Record<string, number | Float32Array | readonly number[]>,
      l = this.look;
    u.waveAbsorb = [...l.absorption, 0];
    u.waveScatter = [...l.scatter, 0];
    u.waveFoam = [...l.foam, 0];
    u.waveLook = [l.sediment, l.transmission, l.forward, 0];
    return this;
  }
}
