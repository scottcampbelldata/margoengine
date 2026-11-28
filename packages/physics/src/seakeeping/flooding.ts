// Flooding (SEA-10): the sea coming into a damaged hull's compartments and spreading between them, the air it drives out
// or traps, the cargo that leaves through a breach, and the floodwater's weight on the hull.
//
// The hydraulic model of progressive flooding (Ruponen, "Progressive flooding of a damaged passenger ship", doctoral
// thesis, Helsinki University of Technology, 2007; Dankowski, "A fast and explicit method for simulating flooding and
// sinkage scenarios of ships", doctoral thesis, TU Hamburg-Harburg, 2013; Dankowski and Kruger, "Dynamic extension of a
// numerical flooding simulation in the time-domain", STAB 2015, eqs. 1-4):
// - Each compartment is a closed mesh in the body's frame; its floodwater has a level surface square to gravity (the
//   water's quasi-static surface), so it runs to the low side as the hull heels (the free-surface effect), and fills
//   `permeability` of the space below that level (the share cargo, machinery and structure leave free: SOLAS II-1,
//   regulation 7-3, 0.95 for spaces in general, 0.85 machinery, 0.60 to 0.70 cargo).
// - Water flows through an opening by Bernoulli's equation: at a height z the pressures on its two sides, each its air's
//   pressure plus the water's head over z, P(z) = p_air + rho g max(0, L - z), drive u = sqrt(2 |dP| / rho) from the
//   higher side; the flow is Cd times u integrated over the opening (Dankowski's eq. 3). A large opening part under water
//   and part in the air is integrated exactly in strips: the pressure difference is linear in z between the two water
//   levels, so each strip's mean of sqrt(|dP|) is closed-form (the weir's (2/3) h^(3/2) where a side is dry).
// - Cd is the contraction of a jet through a sharp-edged hole, pi / (pi + 2) = 0.611 for a slot (Kirchhoff's free
//   streamline, 1869; von Mises, "Berechnung von Ausfluss- und Ueberfallzahlen", Z. VDI 61, 1917), the value Ruponen and
//   Dankowski take for openings of unknown shape (0.6).
// - Air: each compartment holds its air's mass, its pressure by Boyle's law at the air's volume (isothermal, Dankowski's air
//   compression), so a compartment with no vent above its water keeps a pocket that stops the water (and floats an upturned
//   hull); air flows by Bernoulli at the upstream air's density where the higher-pressure side is air, out through vents
//   and the dry part of a breach, or into the water below (the bubbles of a hull venting under water).
// - Time: backward Euler on the compartments' volumes, solved by nonlinear Gauss-Seidel (each compartment's volume in turn
//   by a bracketed root, its flows falling as its volume rises), then the same for the air's pressures. Backward Euler
//   keeps every level between its neighbours' (no overshoot where two levels meet, where the explicit step's derivative of
//   sqrt(dh) is unbounded), for any step; the volumes then move by the flows, so the water is conserved exactly.
//
// Cargo: a hold's granular cargo leaves through the part of a breach under the cargo's top, by Beverloo's law where the
// cargo is dry (Beverloo, Leniger and van de Velde, "The flow of granular solids through orifices", Chem. Eng. Sci. 15,
// 1961: W = 0.58 rho_b sqrt(g) (D - 1.5 d)^(5/2)) and by Wilson, Pfeifer, Mesyngier and Durian's law where it is under
// water ("Granular discharge rate for submerged hoppers", Papers in Physics 6, 060009, 2014: W = 0.67^2 rho_g v_t
// (D - 2.4 d)^2, v_t a grain's terminal speed in water, their Fig. 2's line through the 0.3 to 3 mm glass beads), D the
// diameter of a hole of that area. Water coming in through the breach holds the grains in; a liquid cargo leaves well
// mixed with the water flowing out.

import { hypot, pow } from '@margoengine/math/pinned';
import type { MargoError } from '@margoengine/math/errors';
import { settlingVelocity } from '../tracers.js';
import { floodError } from './flood-errors.js';
import type { FloodVolumeKernel } from './flood-volume-kernel.js';
import type { ShellAperture } from './shell-opening.js';
import { BREACH_CARGO, type BreachCargo } from '../world/flooding.js';
import type { HullMesh, Vec3 } from './wetted.js';

/** The atmosphere's pressure at sea level, Pa (ISO 2533, 1975). */
export const ATMOSPHERE = 101325;
/** Air's density at sea level and 15 degrees C, kg/m^3 (ISO 2533, 1975). */
export const AIR_DENSITY = 1.225;
/** The contraction of a jet through a sharp-edged slot, pi / (pi + 2) (Kirchhoff 1869; von Mises 1917). */
export const DISCHARGE = Math.PI / (Math.PI + 2);
/** SOLAS II-1 regulation 7-3's permeability of a space in general (accommodation, stores, voids). */
export const PERMEABILITY = 0.95;

/** Cargo in a compartment, part of the body's mass. */
export interface CompartmentCargo {
  /** What it is: a granular cargo (with `diameter`) pours out of a breach; a liquid one leaves with the water. */
  readonly material: BreachCargo;
  /** Its mass, kg (included in the body's mass). */
  readonly mass: number;
  /** Its grains' or its liquid's density, kg/m^3 (default the material's: iron ore 5200, coal 1400, grain 1300, sand 2650). */
  readonly density?: number;
  /**
   * Its grains' diameter, m (default the tracer material's: iron ore fines 1e-4, sand 2.5e-4, coal 5e-4, grain 4e-3);
   * pass about 0.012 for taconite pellets; 0 for a liquid.
   */
  readonly diameter?: number;
  /** The share of the cargo's bulk its grains fill (default 0.6, random packing of spheres). */
  readonly packing?: number;
}

/** A watertight space of a hull that can flood. */
export interface Compartment {
  /** Its space: a closed mesh in the body's frame, wound outward, inside the hull. */
  readonly mesh: HullMesh;
  /** The share of its space water can fill (default 0.95; machinery 0.85, cargo 0.6 to 0.7: SOLAS II-1 reg. 7-3). */
  readonly permeability?: number;
  /** The water in it at the start, m^3 (default 0), less than its free space so some air is left. */
  readonly water?: number;
  /** Cargo carried in it. */
  readonly cargo?: CompartmentCargo;
}

/**
 * An opening: a breach in the shell, a door, a hatch, a vent or a pipe, between a compartment and another or the outside
 * (the sea below its surface and the air above). A rectangle in the body's frame.
 */
export interface Opening {
  /** The compartment it opens from (an index into the compartments). */
  readonly from: number;
  /** The compartment it opens into, or 'outside'. */
  readonly to: number | 'outside';
  /** Its centre, m, body frame. */
  readonly centre: Vec3;
  /** Its normal, from `from` toward `to` (body frame; its length does not matter). */
  readonly normal: Vec3;
  /** Its size, m: `width` along `axis` and `height` across it, in its plane. */
  readonly width: number;
  readonly height: number;
  /** The direction of its width in its plane (default level in the body: normal x up, or x for a horizontal opening). */
  readonly axis?: Vec3;
  /** Its discharge coefficient (default 0.611, a sharp-edged hole). */
  readonly discharge?: number;
  /** Opens/closes in world seconds. Defaults to open from zero unless a failure trigger is configured. */
  readonly opens?: number;
  readonly closes?: number;
  /**
   * The head across it, m of water, at which it gives way and stays open (a hatch cover, a window, a door under the sea's
   * load: Dankowski's pressure-height criterion). Left out, it never gives way.
   */
  readonly collapse?: number;
  /** Keep shut by default until this zero-based CrushSolver patch loses its seal. */
  readonly crushPatch?: number;
  /** Keep shut by default until this zero-based GirderJointSolver joint releases. */
  readonly girderJoint?: number;
  /** Read current opening geometry from this zero-based CrushShellSolver seam. */
  readonly shellSeam?: number;
}

/** f64 words of a compartment's state: its water (m^3), its air (kg) and its cargo left (kg). */
export const COMPARTMENT_WORDS = 3;

function finiteVector(value: readonly number[] | undefined, length: number): boolean {
  if (value?.length !== length) return false;
  for (let component = 0; component < length; component++) {
    if (!Number.isFinite(value[component])) return false;
  }
  return true;
}

function floodElevation(sea: Surface, x: number, z: number, t: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z))
    throw floodError(
      'failed',
      'A flood opening is outside the numerical range. Use a local hull pose and opening coordinates.',
    );
  const height = sea.elevation(x, z, t);
  if (!Number.isFinite(height))
    throw floodError(
      'failed',
      'The sea returned a non-finite flood elevation. Return a finite local height at every opening.',
    );
  return height;
}

/** What a flooding step leaves: per opening its flows, per compartment its water's weight and where it acts. */
export interface FloodResult {
  /** Per opening: water m^3/s, air kg/s and cargo kg/s from `from` toward `to`, and 1 where it is open. */
  readonly water: Float64Array;
  readonly air: Float64Array;
  readonly cargo: Float64Array;
  readonly open: Float64Array;
  /** Per compartment: the floodwater's mass (kg) and its centre (world, x y z). */
  readonly mass: Float64Array;
  readonly centre: Float64Array;
  /** Per compartment: the cargo lost through breaches (kg) and the centre it was lost from (world). */
  readonly lost: Float64Array;
  readonly lostCentre: Float64Array;
  /** Per compartment: its water level (world height) and its air's pressure (Pa). */
  readonly level: Float64Array;
  readonly pressure: Float64Array;
  /** The water and air sweeps of the last accepted step. Read `Flooding.convergenceWarning` if either reaches the limit. */
  readonly sweeps: Float64Array;
}

/** A pose: the body's frame origin (world) and its rotation (unit quaternion x, y, z, w). */
interface Pose {
  readonly position: Vec3;
  readonly rotation: readonly [number, number, number, number];
}

/** A sea's surface height over (x, z) at time t. */
interface Surface {
  elevation(x: number, z: number, t: number): number;
}

/** Levels in a compartment's volume table, from its lowest point to its highest along the world's up. */
const LEVELS = 48;
/** Cells a side of an opening's grid. */
export const FLOOD_OPENING_GRID = 4;
const GRID = FLOOD_OPENING_GRID;
/** Air's gas constant times its temperature, p / rho, m^2/s^2 (isothermal). */
const RT = ATMOSPHERE / AIR_DENSITY;
/** Gauss-Seidel sweeps at most, and the root's iterations at most. */
const SWEEPS = 200;
const ITERATIONS = 100;
/**
 * The roots' and the sweeps' tolerance, relative: a few units in the last place. Where two levels meet, a flow goes as
 * sqrt(dh), so a pressure solved only to 1e-12 of the atmosphere's (1e-7 Pa) still drives 1e-5 kg/s of air through a vent
 * and stirs the water 1e-7 m; solved to its last bits, the stir is under 1e-10 m.
 */
const TOLERANCE = 4e-16;
/**
 * The sweeps stop when no compartment's volume or pressure moved by more than this share in a sweep: the sweeps converge
 * geometrically, and where levels meet, movements under it are the roots' own last bits.
 */
const SETTLED = 1e-13;

/** Beverloo's constants for dry grains, and Wilson et al.'s for grains under water. */
const BEVERLOO_C = 0.58,
  BEVERLOO_K = 1.5,
  SUBMERGED_C = 0.67 * 0.67,
  SUBMERGED_K = 2.4;

/** Material defaults: grain density (kg/m^3) and diameter (m), 0 for a liquid. */
const CARGO: Record<BreachCargo, readonly [number, number]> = {
  none: [1000, 0],
  dye: [1000, 0],
  silt: [2650, 4e-5],
  sand: [2650, 2.5e-4],
  ironOre: [5200, 1e-4],
  coal: [1400, 5e-4],
  grain: [1300, 4e-3],
  oil: [870, 0],
};

/** The volume of the part of a closed mesh below the plane u . p = s, and its first moment (body frame). */
export function volumeBelow(mesh: HullMesh, u: Vec3, s: number, moment?: [number, number, number]): number {
  const v = mesh.vertices,
    idx = mesh.indices;
  // Above the mesh, the whole of it (the plane through its highest point).
  if (s === Infinity) {
    s = -Infinity;
    for (let k = 0; k < v.length; k += 3) s = Math.max(s, u[0] * v[k]! + u[1] * v[k + 1]! + u[2] * v[k + 2]!);
  }
  const // A point on the plane: the apex of every tetrahedron, so the cap in the plane adds nothing.
    ox = u[0] * s,
    oy = u[1] * s,
    oz = u[2] * s,
    poly: number[] = [];
  let volume = 0,
    mx = 0,
    my = 0,
    mz = 0;
  for (let k = 0; k + 2 < idx.length; k += 3) {
    poly.length = 0;
    for (let e = 0; e < 3; e++) {
      const a = idx[k + e]! * 3,
        b = idx[k + ((e + 1) % 3)]! * 3,
        da = u[0] * v[a]! + u[1] * v[a + 1]! + u[2] * v[a + 2]! - s,
        db = u[0] * v[b]! + u[1] * v[b + 1]! + u[2] * v[b + 2]! - s;
      if (da <= 0) poly.push(v[a]!, v[a + 1]!, v[a + 2]!);
      if (da <= 0 !== db <= 0) {
        const f = da / (da - db);
        poly.push(
          v[a]! + f * (v[b]! - v[a]!),
          v[a + 1]! + f * (v[b + 1]! - v[a + 1]!),
          v[a + 2]! + f * (v[b + 2]! - v[a + 2]!),
        );
      }
    }
    for (let i = 3; i + 5 < poly.length; i += 3) {
      const ax = poly[0]! - ox,
        ay = poly[1]! - oy,
        az = poly[2]! - oz,
        bx = poly[i]! - ox,
        by = poly[i + 1]! - oy,
        bz = poly[i + 2]! - oz,
        cx = poly[i + 3]! - ox,
        cy = poly[i + 4]! - oy,
        cz = poly[i + 5]! - oz,
        w = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
      volume += w;
      mx += (w * (ax + bx + cx)) / 4;
      my += (w * (ay + by + cy)) / 4;
      mz += (w * (az + bz + cz)) / 4;
    }
  }
  if (moment) {
    moment[0] = mx + volume * ox;
    moment[1] = my + volume * oy;
    moment[2] = mz + volume * oz;
  }
  return volume;
}

/**
 * The mean of sqrt(g) over a strip where g runs linearly from g0 to g1 (both 0 or more):
 * (2/3) (g1^(3/2) - g0^(3/2)) / (g1 - g0), written without the difference.
 */
function meanRoot(g0: number, g1: number): number {
  const r0 = Math.sqrt(g0),
    r1 = Math.sqrt(g1);
  return r0 + r1 > 0 ? (2 * (g0 + r0 * r1 + g1)) / (3 * (r0 + r1)) : 0;
}

/**
 * One side of an opening at an instant: its air's pressure (Pa), its water's level (world height), and the height its
 * water reaches (the level, or everywhere in a full compartment).
 */
interface Side {
  p: number;
  level: number;
  wet: number;
}

/**
 * The flow of one phase (water, m^3/s; or air, kg/s) through a strip of an opening of `area` spread evenly over heights
 * zlo to zhi, from side a toward side b, where the higher-pressure side holds that phase.
 */
function stripFlow(
  zlo: number,
  zhi: number,
  area: number,
  cd: number,
  a: Side,
  b: Side,
  air: boolean,
  rho: number,
  g: number,
): number {
  const pa = (z: number) => a.p + rho * g * Math.max(0, a.level - z),
    pb = (z: number) => b.p + rho * g * Math.max(0, b.level - z);
  // One piece: the pressure difference linear on it, one side higher throughout.
  const piece = (z0: number, z1: number): number => {
    const zm = (z0 + z1) / 2,
      d = pa(zm) - pb(zm);
    if (d === 0) return 0;
    const high = d > 0 ? a : b;
    if (zm < high.wet === air) return 0;
    const g0 = Math.abs(pa(z0) - pb(z0)),
      g1 = Math.abs(pa(z1) - pb(z1)),
      root = z1 > z0 ? meanRoot(g0, g1) * (z1 - z0) : Math.sqrt(Math.abs(d)),
      // Water: u = sqrt(2 dP / rho); air: its mass flux sqrt(2 rho_air dP) at the upstream air's density.
      scale = air ? Math.sqrt((2 * high.p) / RT) : Math.sqrt(2 / rho);
    return (d > 0 ? 1 : -1) * scale * root;
  };
  let total = 0;
  if (!(zhi - zlo > 1e-9)) total = piece(zlo, zlo);
  else {
    // Kinks at the two levels, then a sign change of the linear difference between them.
    const cuts = [zlo, zhi];
    for (const z of [a.level, b.level]) if (z > zlo && z < zhi) cuts.push(z);
    cuts.sort((x, y) => x - y);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const z0 = cuts[i]!,
        z1 = cuts[i + 1]!,
        d0 = pa(z0) - pb(z0),
        d1 = pa(z1) - pb(z1);
      if ((d0 > 0 && d1 < 0) || (d0 < 0 && d1 > 0)) {
        const zc = z0 + (d0 / (d0 - d1)) * (z1 - z0);
        total += piece(z0, zc) + piece(zc, z1);
      } else total += piece(z0, z1);
    }
    total /= zhi - zlo;
  }
  return cd * area * total;
}

/** An opening's cells in the body's frame: each cell's four corners (x, y, z each) and its area. */
interface OpeningShape {
  readonly corners: Float64Array;
  readonly area: number;
  readonly cd: number;
  readonly from: number;
  readonly to: number;
  readonly opens: number;
  readonly closes: number;
  readonly collapse: number;
  readonly shellSeam: boolean;
}

/** A compartment's fixed data. */
interface CompartmentShape {
  readonly mesh: HullMesh;
  readonly permeability: number;
  readonly cargo: CompartmentCargo | null;
  readonly grain: number;
  readonly density: number;
  readonly packing: number;
  readonly water: number;
  /** Its free space (its permeability times its volume), m^3. */
  readonly free: number;
}

/**
 * A hull's compartments and openings, and the step that moves the water, the air and the cargo between them and the sea.
 * Its state is `COMPARTMENT_WORDS` f64 words a compartment, then one word an opening (1 once it has given way).
 */
export class Flooding {
  readonly compartments: readonly CompartmentShape[];
  private readonly openings: readonly OpeningShape[];
  private readonly tables: Float64Array;
  private readonly heights: Float64Array;
  private readonly capacity: Float64Array;
  /** The attitude (the world's up in the body's frame) and the height the tables were made for. */
  private up: Vec3 = [Number.NaN, Number.NaN, Number.NaN];
  private base = 0;
  private active = false;
  private unsettled = 0;
  private readonly relative: Float64Array;
  private readonly candidateState: Float64Array;
  private readonly candidateResult: FloodResult;
  private readonly volumeHeights: Float64Array | undefined;
  private readonly volumeValues: Float64Array | undefined;
  readonly result: FloodResult;

  constructor(compartments: readonly Compartment[], openings: readonly Opening[]);
  constructor(compartments: readonly Compartment[], openings: readonly Opening[], volumeKernel: FloodVolumeKernel);
  constructor(
    compartments: readonly Compartment[],
    openings: readonly Opening[],
    private readonly volumeKernel?: FloodVolumeKernel,
  ) {
    if (!Array.isArray(compartments) || compartments.length === 0)
      throw floodError(
        'unsupported',
        'Flooding needs one or more compartments: pass {compartments: [{mesh}], openings}.',
      );
    if (openings != null && !Array.isArray(openings))
      throw floodError('unsupported', 'Flooding openings must be an array. Supply the openings or an empty array.');
    this.compartments = compartments.map((c: Compartment, i: number) => {
      const { vertices, indices } = c?.mesh ?? {};
      if (!vertices || !indices || vertices.length % 3 !== 0 || indices.length % 3 !== 0 || indices.length === 0)
        throw floodError(
          'unsupported',
          `Compartment ${i}'s mesh is not whole; pass vertices and triangles wound outward.`,
        );
      for (let word = 0; word < vertices.length; word++)
        if (!Number.isFinite(vertices[word]))
          throw floodError('unsupported', `Compartment ${i} has an invalid vertex. Supply finite body-local metres.`);
      for (let k = 0; k < indices.length; k++)
        if (!Number.isInteger(indices[k]) || indices[k]! < 0 || indices[k]! >= vertices.length / 3)
          throw floodError(
            'unsupported',
            `Compartment ${i} names an invalid vertex. Keep triangles inside the vertex array.`,
          );
      const permeability = c.permeability ?? PERMEABILITY;
      if (!(permeability > 0 && permeability <= 1))
        throw floodError(
          'unsupported',
          `Compartment ${i}'s permeability is ${permeability}; pass a share above 0, at most 1.`,
        );
      const cargo = c.cargo ?? null;
      let grain = 0,
        density = 1000,
        packing = 0.6;
      if (cargo) {
        const known = CARGO[cargo.material];
        if (!known)
          throw floodError(
            'unsupported',
            `Compartment ${i}'s cargo is '${cargo.material}'; pass one of ${BREACH_CARGO.join(', ')}.`,
          );
        if (!(cargo.mass >= 0 && Number.isFinite(cargo.mass)))
          throw floodError(
            'unsupported',
            `Compartment ${i}'s cargo mass is ${cargo.mass} kg; pass a finite mass of 0 or more.`,
          );
        grain = cargo.diameter ?? known[1];
        density = cargo.density ?? known[0];
        packing = cargo.packing ?? 0.6;
        if (
          !(
            Number.isFinite(grain) &&
            grain >= 0 &&
            Number.isFinite(density) &&
            density > 0 &&
            packing > 0 &&
            packing <= 1
          )
        )
          throw floodError(
            'unsupported',
            `Compartment ${i}'s cargo has diameter ${grain} m, density ${density} kg/m^3 and packing ${packing}; pass a diameter of 0 or more, a density above 0 and a packing above 0, at most 1.`,
          );
      }
      const free = permeability * volumeBelow(c.mesh, [0, 1, 0], Infinity),
        water = c.water ?? 0;
      if (!(free > 0 && Number.isFinite(free) && Number.isFinite(AIR_DENSITY * free)))
        throw floodError(
          'unsupported',
          `Compartment ${i}'s mesh holds no volume (${free} m^3); wind its triangles outward.`,
        );
      if (!(water >= 0 && water < free))
        throw floodError(
          'unsupported',
          `Compartment ${i} starts with ${water} m^3 of water in ${free} m^3 of free space; pass 0 or more and less than its space (a full tank's water goes in the body's mass).`,
        );
      return { mesh: c.mesh, permeability, cargo, grain, density, packing, water, free };
    });
    const n = this.compartments.length;
    this.openings = (openings ?? []).map((o, i) => {
      if (!o || !finiteVector(o.centre, 3) || !finiteVector(o.normal, 3) || (o.axis && !finiteVector(o.axis, 3)))
        throw floodError(
          'unsupported',
          `Opening ${i}'s centre, normal or axis is invalid. Use three finite SI components each.`,
        );
      const to = o.to === 'outside' ? -1 : o.to;
      const shellSeam = o.shellSeam !== undefined;
      if (shellSeam && (o.crushPatch !== undefined || o.girderJoint !== undefined || o.collapse !== undefined))
        throw floodError(
          'unsupported',
          'Use the live shell geometry as the sole structural trigger on a shell opening.',
        );
      if (
        !(Number.isInteger(o.from) && o.from >= 0 && o.from < n) ||
        !(to === -1 || (Number.isInteger(to) && to >= 0 && to < n && to !== o.from))
      )
        throw floodError(
          'unsupported',
          `Opening ${i} joins ${o.from} to ${String(o.to)}; name a compartment index under ${n} for from, and another or 'outside' for to.`,
        );
      if (!(o.width > 0 && o.height > 0 && Number.isFinite(o.width) && Number.isFinite(o.height)))
        throw floodError(
          'unsupported',
          `Opening ${i} is ${o.width} by ${o.height} m; pass a finite width and height above 0.`,
        );
      const nl = hypot(o.normal[0], o.normal[1], o.normal[2]);
      if (!(nl > 0 && Number.isFinite(nl)))
        throw floodError('unsupported', `Opening ${i}'s normal has no usable length; pass the direction it faces.`);
      const nn: Vec3 = [o.normal[0] / nl, o.normal[1] / nl, o.normal[2] / nl];
      let ax: Vec3 = o.axis ?? [nn[2], 0, -nn[0]];
      // Take the normal's part out of the axis; a horizontal opening's default axis is x.
      let dot = ax[0] * nn[0] + ax[1] * nn[1] + ax[2] * nn[2];
      ax = [ax[0] - dot * nn[0], ax[1] - dot * nn[1], ax[2] - dot * nn[2]];
      if (!(hypot(ax[0], ax[1], ax[2]) > 1e-9)) {
        dot = nn[0];
        ax = [1 - dot * nn[0], -dot * nn[1], -dot * nn[2]];
      }
      const al = hypot(ax[0], ax[1], ax[2]);
      if (!(al > 1e-9))
        throw floodError('unsupported', `Opening ${i}'s axis lies along its normal; pass an axis in its plane.`);
      ax = [ax[0] / al, ax[1] / al, ax[2] / al];
      const up: Vec3 = [nn[1] * ax[2] - nn[2] * ax[1], nn[2] * ax[0] - nn[0] * ax[2], nn[0] * ax[1] - nn[1] * ax[0]],
        corners = new Float64Array(GRID * GRID * 12);
      for (let a = 0; a < GRID; a++)
        for (let b = 0; b < GRID; b++)
          for (let c = 0; c < 4; c++) {
            const s = ((a + (c & 1)) / GRID - 0.5) * o.width,
              t = ((b + (c >> 1)) / GRID - 0.5) * o.height,
              at = ((a * GRID + b) * 4 + c) * 3;
            for (let k = 0; k < 3; k++) corners[at + k] = o.centre[k]! + s * ax[k]! + t * up[k]!;
          }
      const cd = o.discharge ?? DISCHARGE;
      if (!(cd > 0 && cd <= 1))
        throw floodError('unsupported', `Opening ${i}'s discharge coefficient is ${cd}; pass one above 0, at most 1.`);
      const collapse = o.collapse ?? Infinity,
        opens =
          o.opens ??
          (o.collapse === undefined && o.crushPatch === undefined && o.girderJoint === undefined ? 0 : Infinity),
        closes = o.closes ?? Infinity;
      if (!(collapse > 0) || Number.isNaN(opens) || Number.isNaN(closes))
        throw floodError(
          'unsupported',
          `Opening ${i} gives way at ${collapse} m of head; pass a head above 0, and times as numbers.`,
        );
      const area = (o.width * o.height) / (GRID * GRID);
      if (!(area > 0 && Number.isFinite(area)) || !corners.every(Number.isFinite))
        throw floodError(
          'unsupported',
          `Opening ${i} overflows in body space. Use finite metre centres and dimensions.`,
        );
      return {
        corners,
        area,
        cd,
        from: o.from,
        to,
        opens,
        closes,
        collapse,
        shellSeam,
      };
    });
    this.tables = new Float64Array(n * LEVELS);
    this.heights = new Float64Array(n * LEVELS);
    this.relative = new Float64Array(n * LEVELS);
    this.capacity = new Float64Array(n);
    const m = this.openings.length;
    const makeResult = (): FloodResult => ({
      water: new Float64Array(m),
      air: new Float64Array(m),
      cargo: new Float64Array(m),
      open: new Float64Array(m),
      mass: new Float64Array(n),
      centre: new Float64Array(n * 3),
      lost: new Float64Array(n),
      lostCentre: new Float64Array(n * 3),
      level: new Float64Array(n),
      pressure: new Float64Array(n),
      sweeps: new Float64Array(2),
    });
    this.result = makeResult();
    this.candidateResult = makeResult();
    this.candidateState = new Float64Array(n * COMPARTMENT_WORDS + m);
    if (volumeKernel) {
      this.volumeHeights = new Float64Array(LEVELS - 1);
      this.volumeValues = new Float64Array(LEVELS - 1);
    }
  }

  /** f64 words of the state. */
  get words(): number {
    return this.compartments.length * COMPARTMENT_WORDS + this.openings.length;
  }

  /** The openings' count. */
  get openingCount(): number {
    return this.openings.length;
  }

  /** Opening `i`: the compartment it opens from, and -1 for the outside or the compartment it opens to. */
  ends(i: number): readonly [number, number] {
    const o = this.openings[i];
    if (!o) throw floodError('unsupported', 'The opening index is invalid. Use an opening in this Flooding model.');
    return [o.from, o.to];
  }

  /** Permanently opens an opening, using its existing saved failure word. */
  failOpening(state: Float64Array, opening: number): void {
    if (this.active) throw floodError('state', 'Flooding is stepping. Open a breach between steps.');
    if (
      !(state instanceof Float64Array) ||
      state.length !== this.words ||
      !Number.isSafeInteger(opening) ||
      opening < 0 ||
      opening >= this.openingCount
    )
      throw floodError('unsupported', 'Pass the Flooding state and the index of an existing opening to failOpening.');
    state[this.compartments.length * COMPARTMENT_WORDS + opening] = 1;
  }

  /** The state at the start: each compartment's water, its air at the atmosphere's pressure, its cargo. */
  initialise(state: Float64Array): void {
    if (this.active) throw floodError('state', 'Flooding is stepping. Initialise its state between steps.');
    this.checkStateLayout(state);
    this.compartments.forEach((c, i) => {
      state[i * COMPARTMENT_WORDS] = c.water;
      state[i * COMPARTMENT_WORDS + 1] = AIR_DENSITY * (c.free - c.water);
      state[i * COMPARTMENT_WORDS + 2] = c.cargo?.mass ?? 0;
    });
    state.fill(0, this.compartments.length * COMPARTMENT_WORDS);
  }

  /**
   * Each compartment's volume table at this pose: its free volume below each of LEVELS heights along the world's up. The
   * volumes depend on the hull's attitude alone, so they are made again only when it has turned; the heights follow
   * the hull's height.
   */
  private tabulate(u: Vec3, base: number, native = true): void {
    this.base = base;
    const last = this.up;
    if (last[0] === u[0] && last[1] === u[1] && last[2] === u[2]) {
      for (let k = 0; k < this.heights.length; k++) {
        const height = base + this.relative[k]!;
        if (!Number.isFinite(height))
          throw floodError('failed', 'A flood plane overflowed. Use a local hull pose and mesh in SI metres.');
        this.heights[k] = height;
      }
      return;
    }
    this.up = [u[0], u[1], u[2]];
    this.compartments.forEach((c, i) => {
      const v = c.mesh.vertices;
      let lo = Infinity,
        hi = -Infinity;
      for (let k = 0; k < v.length; k += 3) {
        const s = u[0] * v[k]! + u[1] * v[k + 1]! + u[2] * v[k + 2]!;
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
      }
      const heights = this.volumeHeights;
      const values = this.volumeValues;
      if (native && this.volumeKernel && heights && values) {
        for (let k = 1; k < LEVELS; k++) heights[k - 1] = lo + ((hi - lo) * k) / (LEVELS - 1);
        this.volumeKernel.volumes(c.mesh, u, heights, values);
      }
      let last = 0;
      for (let k = 0; k < LEVELS; k++) {
        const s = lo + ((hi - lo) * k) / (LEVELS - 1),
          raw = k === 0 ? 0 : native && values ? values[k - 1]! : volumeBelow(c.mesh, u, s),
          volume = Math.max(last, c.permeability * raw);
        if (!Number.isFinite(volume) || !Number.isFinite(base + s))
          throw floodError('failed', 'A compartment volume or plane overflowed. Use a closed mesh in local SI metres.');
        this.tables[i * LEVELS + k] = volume;
        this.relative[i * LEVELS + k] = s;
        this.heights[i * LEVELS + k] = base + s;
        last = volume;
      }
      this.capacity[i] = last;
    });
  }

  /** The world height of compartment `i`'s water at `volume` (m^3 of water). */
  levelOf(i: number, volume: number): number {
    if (this.active)
      throw floodError('state', 'Flooding is stepping. Read the accepted compartment level between steps.');
    if (!Number.isSafeInteger(i) || i < 0 || i >= this.compartments.length || !Number.isFinite(volume))
      throw floodError('unsupported', 'The flood level query is invalid. Use a valid compartment and a finite volume.');
    return this.levelAt(i, volume);
  }

  /** A coded warning for the last accepted direct step, if either implicit solve exhausted its sweeps. */
  get convergenceWarning(): MargoError | undefined {
    if (this.unsettled === 0) return undefined;
    const phase = this.unsettled === 3 ? 'water and air' : this.unsettled === 1 ? 'water' : 'air';
    return floodError(
      'failed',
      `The flood ${phase} solve reached ${SWEEPS} sweeps. Reduce the step and check flow and mass balance.`,
    );
  }

  private levelAt(i: number, volume: number): number {
    const t = this.tables,
      h = this.heights,
      at = i * LEVELS;
    if (!(volume > 0)) return h[at]!;
    for (let k = 1; k < LEVELS; k++)
      if (t[at + k]! >= volume) {
        const span = t[at + k]! - t[at + k - 1]!;
        return h[at + k - 1]! + (span > 0 ? (volume - t[at + k - 1]!) / span : 1) * (h[at + k]! - h[at + k - 1]!);
      }
    return h[at + LEVELS - 1]!;
  }

  /**
   * Moves the water, the air and the cargo over `dt` seconds at time `t` (the step's middle), the hull at `pose` in the sea
   * `sea` of density `rho` under gravity `g` (m/s^2, down the world's y). Fills `result`.
   */
  step(state: Float64Array, pose: Pose, sea: Surface, t: number, dt: number, rho: number, g: number): FloodResult {
    return this.stepWithShellApertures(state, pose, sea, t, dt, rho, g);
  }

  /** Moves fluids through live fractured polygons at their world positions. */
  stepWithShellApertures(
    state: Float64Array,
    pose: Pose,
    sea: Surface,
    t: number,
    dt: number,
    rho: number,
    g: number,
    live?: ReadonlyMap<number, ShellAperture>,
  ): FloodResult {
    this.checkStateLayout(state);
    if (this.active)
      throw floodError('state', 'Flooding is already stepping. Keep sea queries synchronous and free of solver calls.');
    if (!pose || !finiteVector(pose.position, 3) || !finiteVector(pose.rotation, 4))
      throw floodError(
        'unsupported',
        'The flood pose is invalid. Supply a finite local position and a unit quaternion.',
      );
    const [qx, qy, qz, qw] = pose.rotation;
    if (Math.abs(qx * qx + qy * qy + qz * qz + qw * qw - 1) > 1e-5)
      throw floodError(
        'unsupported',
        'The flood pose has a scaled rotation. Normalise its quaternion before stepping.',
      );
    if (!sea || typeof sea.elevation !== 'function')
      throw floodError('unsupported', 'Flooding needs a sea surface. Supply elevation(x, z, time) in local metres.');
    if (
      !Number.isFinite(t) ||
      !(dt > 0 && Number.isFinite(dt)) ||
      !(rho > 0 && Number.isFinite(rho)) ||
      !(g > 0 && Number.isFinite(g) && Number.isFinite(rho * g))
    )
      throw floodError(
        'unsupported',
        'The flood step or fluid is invalid. Use finite time and positive SI step, density and gravity.',
      );
    const compartmentWords = this.compartments.length * COMPARTMENT_WORDS;
    for (let word = 0; word < state.length; word++) {
      const value = state[word]!;
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        (word >= compartmentWords && value !== 0 && value !== 1) ||
        (word < compartmentWords && word % COMPARTMENT_WORDS === 1 && !Number.isFinite(RT * value))
      )
        throw floodError(
          'unsupported',
          'The flood state is invalid. Restore a valid snapshot or initialise this model’s state.',
        );
    }
    const oldUp = this.up;
    const oldBase = this.base;
    this.candidateState.set(state);
    this.active = true;
    try {
      const unsettled = this.advance(this.candidateState, pose, sea, t, dt, rho, g, live);
      const keys = Object.keys(this.result) as (keyof FloodResult)[];
      if (
        !this.candidateState.every(Number.isFinite) ||
        keys.some((key) => !this.candidateResult[key].every(Number.isFinite))
      )
        throw floodError('failed', 'A flood result exceeds numerical range. Reduce the fluid scales or step size.');
      state.set(this.candidateState);
      for (const key of keys) this.result[key].set(this.candidateResult[key]);
      this.unsettled = unsettled;
      return this.result;
    } catch (cause) {
      if (this.up !== oldUp || this.base !== oldBase) this.restoreTables(oldUp, oldBase);
      throw cause;
    } finally {
      this.active = false;
    }
  }

  private checkStateLayout(state: Float64Array): void {
    if (!(state instanceof Float64Array) || state.length !== this.words)
      throw floodError(
        'unsupported',
        `Flooding needs ${this.words} Float64 state words. Initialise that array with this model.`,
      );
  }

  private restoreTables(up: Vec3, base: number): void {
    if (Number.isFinite(up[1])) {
      this.tabulate(up, base, false);
      return;
    }
    this.up = up;
    this.base = base;
    for (const words of [this.tables, this.heights, this.relative, this.capacity]) words.fill(0);
  }

  private advance(
    state: Float64Array,
    pose: Pose,
    sea: Surface,
    t: number,
    dt: number,
    rho: number,
    g: number,
    live?: ReadonlyMap<number, ShellAperture>,
  ): number {
    const q = pose.rotation,
      // The world's up in the body's frame: the conjugate rotation of y.
      u: Vec3 = [2 * (q[0] * q[1] + q[3] * q[2]), 1 - 2 * (q[0] * q[0] + q[2] * q[2]), 2 * (q[1] * q[2] - q[3] * q[0])],
      n = this.compartments.length,
      openings = this.openings,
      r = this.candidateResult;
    this.tabulate(u, pose.position[1]);
    const toWorld = (x: number, y: number, z: number): Vec3 => {
      const [qx, qy, qz, qw] = q,
        tx = 2 * (qy * z - qz * y),
        ty = 2 * (qz * x - qx * z),
        tz = 2 * (qx * y - qy * x);
      return [
        x + qw * tx + (qy * tz - qz * ty) + pose.position[0],
        y + qw * ty + (qz * tx - qx * tz) + pose.position[1],
        z + qw * tz + (qx * ty - qy * tx) + pose.position[2],
      ];
    };
    // Each opening's cells: their height spans (world), and the sea's level at the opening.
    const spans = openings.map((o, index) => {
      const aperture = o.shellSeam ? live?.get(index) : undefined;
      if (aperture) {
        const { centre, spans, stripAreas } = aperture;
        if (
          !finiteVector(centre, 3) ||
          !(spans instanceof Float64Array) ||
          !(stripAreas instanceof Float64Array) ||
          spans.length !== 2 * stripAreas.length ||
          !stripAreas.length ||
          !stripAreas.every((area) => Number.isFinite(area) && area >= 0) ||
          !spans.every((height, word) => Number.isFinite(height) && (word % 2 === 0 || height >= spans[word - 1]!))
        )
          throw floodError(
            'unsupported',
            'A shell aperture has invalid strips. Supply finite heights and matching nonnegative areas.',
          );
        return spans;
      }
      const s = new Float64Array(GRID * GRID * 2);
      for (let c = 0; c < GRID * GRID; c++) {
        let lo = Infinity,
          hi = -Infinity;
        for (let k = 0; k < 4; k++) {
          const at = (c * 4 + k) * 3,
            h = u[0] * o.corners[at]! + u[1] * o.corners[at + 1]! + u[2] * o.corners[at + 2]! + pose.position[1];
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi))
          throw floodError(
            'failed',
            'An opening span overflowed. Use a local hull pose and opening geometry in SI metres.',
          );
        s[c * 2] = lo;
        s[c * 2 + 1] = hi;
      }
      return s;
    });
    const seaLevel = openings.map((o, index) => {
      if (o.to !== -1) return 0;
      const aperture = o.shellSeam ? live?.get(index) : undefined;
      if (aperture) return floodElevation(sea, aperture.centre[0], aperture.centre[2], t);
      const c = o.corners,
        mid = (k: number) => (c[k]! + c[(GRID * GRID * 4 - 1) * 3 + k]!) / 2,
        w = toWorld(mid(0), mid(1), mid(2));
      return floodElevation(sea, w[0], w[2], t);
    });
    const outside = openings.map((_, k) => ({ p: ATMOSPHERE, level: seaLevel[k]!, wet: seaLevel[k]! }));
    // Which openings are open: in their window, or given way under the head across them at the step's start.
    const sides: Side[] = [];
    for (let i = 0; i < n; i++) sides.push({ p: ATMOSPHERE, level: 0, wet: 0 });
    // A compartment's side at a volume of water and a mass of air: Boyle's pressure in the air's room; with no air, the
    // room above the water is vapour (no pressure), and a full compartment's pressure is `pressed`, its own unknown.
    const setSide = (i: number, volume: number, air: number, pressed = 0) => {
      const s = sides[i]!,
        free = this.capacity[i]! - volume;
      // An empty room's floor is a geometric datum, not a source of water or hydrostatic head under an opening.
      s.level = volume > 0 ? this.levelAt(i, volume) : -Infinity;
      s.wet = free > 0 ? s.level : Infinity;
      s.p = free > 0 ? (RT * air) / free : air > 0 ? Infinity : pressed;
    };
    for (let i = 0; i < n; i++) setSide(i, state[i * COMPARTMENT_WORDS]!, state[i * COMPARTMENT_WORDS + 1]!);
    const base = n * COMPARTMENT_WORDS;
    openings.forEach((o, k) => {
      if (o.shellSeam) {
        r.open[k] = live?.has(k) && t >= o.opens && t < o.closes ? 1 : 0;
        return;
      }
      if (state[base + k] !== 1 && o.collapse < Infinity) {
        const a = sides[o.from]!,
          b = o.to === -1 ? outside[k]! : sides[o.to]!,
          span = spans[k]!;
        let head = 0;
        for (let c = 0; c < span.length; c++) {
          const z = span[c]!,
            d = a.p + rho * g * Math.max(0, a.level - z) - (b.p + rho * g * Math.max(0, b.level - z));
          head = Math.max(head, Math.abs(d) / (rho * g));
        }
        if (head >= o.collapse) state[base + k] = 1;
      }
      r.open[k] = state[base + k] === 1 || (t >= o.opens && t < o.closes) ? 1 : 0;
    });
    // The flow of a phase through opening k from its `from` side (positive) at the sides' present states.
    const flow = (k: number, air: boolean): number => {
      if (r.open[k] !== 1) return 0;
      const o = openings[k]!,
        a = sides[o.from]!,
        b = o.to === -1 ? outside[k]! : sides[o.to]!,
        span = spans[k]!,
        cellAreas = o.shellSeam ? live?.get(k)?.stripAreas : undefined;
      let sum = 0;
      for (let c = 0; c < span.length / 2; c++) {
        const area = cellAreas?.[c] ?? o.area;
        if (area > 0) sum += stripFlow(span[c * 2]!, span[c * 2 + 1]!, area, o.cd, a, b, air, rho, g);
      }
      return sum;
    };
    const touching: number[][] = Array.from({ length: n }, () => []);
    openings.forEach((o, k) => {
      if (r.open[k] !== 1) return;
      touching[o.from]!.push(k);
      if (o.to !== -1) touching[o.to]!.push(k);
    });
    const inflow = (i: number, air: boolean): number => {
      let sum = 0;
      for (const k of touching[i]!) sum += (openings[k]!.from === i ? -1 : 1) * flow(k, air);
      return sum;
    };
    // The water: each compartment's volume at the step's end, V - V0 - dt Q(V) = 0, in turn until none moves.
    const v0 = new Float64Array(n),
      m0 = new Float64Array(n),
      v = new Float64Array(n),
      pressed = new Float64Array(n),
      last = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      v0[i] = state[i * COMPARTMENT_WORDS]!;
      m0[i] = state[i * COMPARTMENT_WORDS + 1]!;
      v[i] = v0[i]!;
    }
    const root = (f: (x: number) => number, lo: number, hi: number, flo: number, fhi: number, tol: number): number => {
      // Bisection to a narrow bracket, then the Illinois method (the end that stays has its residual halved); when it
      // stops, the point with the smallest residual it has seen.
      let side = 0,
        best = Math.abs(flo) <= Math.abs(fhi) ? lo : hi,
        least = Math.min(Math.abs(flo), Math.abs(fhi)),
        wlo = flo,
        whi = fhi;
      for (let it = 0; it < ITERATIONS && hi - lo > tol; it++) {
        const x =
          it < 8 || !Number.isFinite(whi) || !Number.isFinite(wlo)
            ? (lo + hi) / 2
            : (lo * whi - hi * wlo) / (whi - wlo);
        if (!(x > lo && x < hi)) break;
        const fx = f(x);
        if (Math.abs(fx) < least) {
          least = Math.abs(fx);
          best = x;
        }
        if (fx === 0) break;
        if (fx < 0) {
          lo = x;
          wlo = fx;
          if (side === -1) whi /= 2;
          side = -1;
        } else {
          hi = x;
          whi = fx;
          if (side === 1) wlo /= 2;
          side = 1;
        }
      }
      return best;
    };
    let unsettled = 3;
    r.sweeps[0] = SWEEPS;
    for (let sweep = 0; sweep < SWEEPS; sweep++) {
      let moved = 0;
      for (let i = 0; i < n; i++) {
        if (touching[i]!.length === 0) continue;
        const cap = this.capacity[i]!,
          f = (x: number) => {
            setSide(i, x, m0[i]!);
            return x - v0[i]! - dt * inflow(i, false);
          },
          // Up to the space less 1e-14 of it (the air's pressure there passes any sea's head; the air left at the
          // atmosphere's pressure in that room is under the trillionth that counts as gone).
          top = m0[i]! > 0 ? cap - 1e-14 * cap : cap,
          full = f(top);
        let x: number;
        if (m0[i]! > 0 || full > 0) x = root(f, 0, top, f(0), full, TOLERANCE * cap);
        else {
          // Full with no air: the water through it balances (it cannot be squeezed), at the pressure that does that.
          x = cap;
          const g2 = (p: number) => {
            setSide(i, cap, 0, p);
            return cap - v0[i]! - dt * inflow(i, false);
          };
          let hi = ATMOSPHERE;
          for (const k of touching[i]!) {
            const o = openings[k]!,
              other = o.to === -1 ? outside[k]! : sides[o.from === i ? o.to : o.from]!,
              span = spans[k]!;
            let low = Infinity;
            for (let c = 0; c < span.length; c++) low = Math.min(low, span[c]!);
            if (Number.isFinite(other.p)) hi = Math.max(hi, other.p + rho * g * Math.max(0, other.level - low));
          }
          hi *= 1 + 1e-9;
          pressed[i] = root(g2, 0, hi, g2(0), g2(hi), TOLERANCE * hi);
        }
        setSide(i, x, m0[i]!, pressed[i]);
        moved = Math.max(moved, Math.abs(x - v[i]!) / (cap + 1e-30), Math.abs(pressed[i]! - last[i]!) / ATMOSPHERE);
        last[i] = pressed[i]!;
        v[i] = x;
      }
      if (moved < SETTLED) {
        r.sweeps[0] = sweep + 1;
        unsettled &= ~1;
        break;
      }
    }
    // The volumes are the solved ones and the flows those at the solved levels. (Moving the volumes by those flows instead
    // would trade the solve's last bits for the flows' sqrt(dh) of them where two levels meet: a level a step out of turn
    // by 1e-11 m drives the next step's flow 1e-9 m^3/s the other way, a two-step cycle.)
    openings.forEach((_, k) => (r.water[k] = flow(k, false)));
    // The air: each compartment's pressure, its mass p V_air / RT, m - m0 - dt q(p) = 0, the water now where it is.
    const vAir = new Float64Array(n),
      pressure = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      vAir[i] = this.capacity[i]! - v[i]!;
      setSide(i, v[i]!, m0[i]!, pressed[i]);
      pressure[i] = vAir[i]! > 0 ? sides[i]!.p : ATMOSPHERE;
    }
    r.sweeps[1] = SWEEPS;
    for (let sweep = 0; sweep < SWEEPS; sweep++) {
      let moved = 0;
      for (let i = 0; i < n; i++) {
        if (touching[i]!.length === 0 || !(vAir[i]! > 0)) continue;
        const s = sides[i]!,
          f = (p: number) => {
            s.p = p;
            return (p * vAir[i]!) / RT - m0[i]! - dt * inflow(i, true);
          };
        // Above every pressure it meets, air only leaves; at none, it only comes in.
        let hi = Math.max(pressure[i]!, ATMOSPHERE);
        for (const k of touching[i]!) {
          const o = openings[k]!,
            other = o.to === -1 ? outside[k]! : sides[o.from === i ? o.to : o.from]!,
            span = spans[k]!;
          let low = Infinity;
          for (let c = 0; c < span.length; c++) low = Math.min(low, span[c]!);
          hi = Math.max(hi, other.p + rho * g * Math.max(0, other.level - low));
        }
        hi *= 1 + 1e-9;
        const p = root(f, 0, hi, f(0), f(hi), TOLERANCE * hi);
        s.p = p;
        moved = Math.max(moved, Math.abs(p - pressure[i]!) / hi);
        pressure[i] = p;
      }
      if (moved < SETTLED) {
        r.sweeps[1] = sweep + 1;
        unsettled &= ~2;
        break;
      }
    }
    openings.forEach((_, k) => (r.air[k] = flow(k, true)));
    for (let i = 0; i < n; i++) {
      state[i * COMPARTMENT_WORDS] = v[i]!;
      // The air's mass at its solved pressure. Air under a trillionth of what fills the space is gone: the compartment is
      // then full (its water reaches an opening in its top), not held off it by a pocket thinner than the floats can tell.
      const air = vAir[i]! > 0 && touching[i]!.length > 0 ? (pressure[i]! * vAir[i]!) / RT : vAir[i]! > 0 ? m0[i]! : 0;
      state[i * COMPARTMENT_WORDS + 1] = air > 1e-12 * AIR_DENSITY * this.capacity[i]! ? air : 0;
      if (vAir[i]! > 0) sides[i]!.p = pressure[i]!;
    }
    // The cargo: out through the part of each open breach under the cargo's top, while the water does not come in.
    r.cargo.fill(0);
    openings.forEach((o, k) => {
      const c = this.compartments[o.from]!;
      if (r.open[k] !== 1 || o.to !== -1 || !c.cargo) return;
      const left = state[o.from * COMPARTMENT_WORDS + 2]!;
      if (!(left > 0) || r.water[k]! < 0) return;
      if (!(c.grain > 0)) {
        // A liquid, mixed through the water going out.
        const water = v[o.from]!;
        r.cargo[k] = water > 0 ? (left / (water + left / c.density)) * r.water[k]! : 0;
        return;
      }
      // The cargo's top: the level its bulk fills (grains, packed, and the space between).
      const bulk = left / (c.density * c.packing),
        topLevel = this.levelAt(o.from, Math.min(bulk * c.permeability, this.capacity[o.from]!)),
        span = spans[k]!,
        water = sides[o.from]!.level,
        cellAreas = o.shellSeam ? live?.get(k)?.stripAreas : undefined;
      let under = 0,
        wet = 0;
      for (let cell = 0; cell < span.length / 2; cell++) {
        const lo = span[cell * 2]!,
          hi = span[cell * 2 + 1]!,
          share = hi - lo > 1e-9 ? Math.min(1, Math.max(0, (topLevel - lo) / (hi - lo))) : topLevel > lo ? 1 : 0,
          wetShare = hi - lo > 1e-9 ? Math.min(share, Math.max(0, (water - lo) / (hi - lo))) : water > lo ? share : 0;
        const area = cellAreas?.[cell] ?? o.area;
        under += share * area;
        wet += wetShare * area;
      }
      if (!(under > 0)) return;
      const d = Math.sqrt((4 * under) / Math.PI),
        grain = c.grain,
        // The share of the hole under water takes the submerged law, the rest Beverloo's.
        submerged = wet / under,
        vt = settlingVelocity({ density: c.density, diameter: grain, colour: [0, 0, 0] }, rho, 1e-6, g),
        wetRate =
          d > SUBMERGED_K * grain && vt > 0
            ? SUBMERGED_C * c.density * vt * (d - SUBMERGED_K * grain) * (d - SUBMERGED_K * grain)
            : 0,
        dryRate =
          d > BEVERLOO_K * grain
            ? BEVERLOO_C * c.packing * c.density * Math.sqrt(g) * pow(d - BEVERLOO_K * grain, 2.5)
            : 0;
      r.cargo[k] = submerged * wetRate + (1 - submerged) * dryRate;
    });
    for (let i = 0; i < n; i++) {
      let sum = 0;
      openings.forEach((o, k) => {
        if (o.from === i) sum += r.cargo[k]!;
      });
      const at = i * COMPARTMENT_WORDS + 2;
      if (sum * dt > state[at]!) {
        // Not more than is left: each breach's share of what is.
        const scale = state[at]! / (sum * dt);
        openings.forEach((o, k) => {
          if (o.from === i) r.cargo[k]! *= scale;
        });
        state[at] = 0;
      } else state[at]! -= sum * dt;
    }
    // The floodwater's mass and centre, and the cargo lost and where it came from (the layer between its tops then and now).
    const moment: [number, number, number] = [0, 0, 0],
      other: [number, number, number] = [0, 0, 0];
    r.lostCentre.fill(0);
    for (let i = 0; i < n; i++) {
      const c = this.compartments[i]!,
        level = this.levelAt(i, v[i]!) - pose.position[1];
      r.level[i] = level + pose.position[1];
      r.pressure[i] = vAir[i]! > 0 ? pressure[i]! : sides[i]!.p;
      const volume = v[i]! > 0 ? volumeBelow(c.mesh, u, level, moment) : 0;
      r.mass[i] = rho * v[i]!;
      const centre =
        volume > 0 ? toWorld(moment[0] / volume, moment[1] / volume, moment[2] / volume) : toWorld(0, 0, 0);
      r.centre.set(centre, i * 3);
      r.lost[i] = 0;
      if (c.cargo) {
        const lost = c.cargo.mass - state[i * COMPARTMENT_WORDS + 2]!;
        r.lost[i] = lost;
        if (lost > 0) {
          const bulk = (m: number) => (c.grain > 0 ? m / (c.density * c.packing) : m / c.density) * c.permeability,
            topThen = this.levelAt(i, Math.min(bulk(c.cargo.mass), this.capacity[i]!)) - pose.position[1],
            topNow =
              this.levelAt(i, Math.min(bulk(state[i * COMPARTMENT_WORDS + 2]!), this.capacity[i]!)) - pose.position[1],
            then = volumeBelow(c.mesh, u, topThen, moment),
            now = volumeBelow(c.mesh, u, topNow, other),
            layer = then - now,
            at =
              layer > 1e-12
                ? toWorld(
                    (moment[0] - other[0]) / layer,
                    (moment[1] - other[1]) / layer,
                    (moment[2] - other[2]) / layer,
                  )
                : toWorld(moment[0] / (then || 1), moment[1] / (then || 1), moment[2] / (then || 1));
          r.lostCentre.set(at, i * 3);
        }
      }
    }
    return unsettled;
  }
}
