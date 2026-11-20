// Spur gears and gear trains: involute wheel outlines, pitch/tip/root radii, the meshing phase that interleaves two
// wheels' teeth, and the search for the two-stage compound train (drive arbor, stud arbor, output) whose integer tooth
// counts come closest to a wanted ratio while every wheel fits its frame. Pure maths, no GPU code: outlines extrude
// with @margoengine/geometry/extrude, and the same numbers drive a model's wheels frame by frame.
//
// Sources: the involute of a circle and the involute function inv(a) = tan a - a, tooth thickness at a radius from
// the thickness at the pitch circle (ISO 21771:2007, "Gears: Cylindrical involute gears and gear pairs, concepts and
// geometry"; Dudley's Handbook of Practical Gear Design, 1984, ch. 1); standard basic rack proportions addendum 1 m,
// dedendum 1.25 m, pressure angle 20 degrees (ISO 53:1998). The train search is Margo's own exhaustive search.

import { MargoError } from '@margoengine/math/errors';

type Point = [number, number];
const TAU = Math.PI * 2;

/** Pitch, tip (addendum), root (dedendum) and base radii of a spur wheel. */
export interface GearRadii {
  pitch: number;
  tip: number;
  root: number;
  base: number;
}

/** Tooth proportions, in modules, and the pressure angle. */
export interface ToothForm {
  /** Pressure angle in radians. Default 20 degrees (ISO 53). */
  pressureAngle?: number;
  /** Addendum in modules. Default 1. */
  addendum?: number;
  /** Dedendum in modules. Default 1.25. */
  dedendum?: number;
}

const DEFAULT_PRESSURE = (20 * Math.PI) / 180;
const form = (o: ToothForm = {}) => ({
  pressureAngle: o.pressureAngle ?? DEFAULT_PRESSURE,
  addendum: o.addendum ?? 1,
  dedendum: o.dedendum ?? 1.25,
});
const checkWheel = (where: string, teeth: number, module: number) => {
  if (!Number.isInteger(teeth) || teeth < 3)
    throw new RangeError(`${where}: ${teeth} teeth is not a whole number of 3 or more; pass a tooth count`);
  if (!(module > 0) || !Number.isFinite(module))
    throw new RangeError(`${where}: module ${module} is not a positive length; pass pitch diameter / teeth`);
};

/**
 * Radii of a spur wheel of `teeth` teeth and module `module` (pitch diameter over teeth, in your length unit).
 * @throws RangeError for a tooth count below 3 or a module that is not positive.
 * @example gearRadii(40, 0.001); // {pitch: 0.02, tip: 0.021, root: 0.01875, base: 0.01879...}
 */
export function gearRadii(teeth: number, module: number, toothForm: ToothForm = {}): GearRadii {
  checkWheel('gearRadii', teeth, module);
  const f = form(toothForm);
  const pitch = (module * teeth) / 2;
  return {
    pitch,
    tip: (module * (teeth + 2 * f.addendum)) / 2,
    root: (module * (teeth - 2 * f.dedendum)) / 2,
    base: pitch * Math.cos(f.pressureAngle),
  };
}

/** The involute function inv(a) = tan a - a. */
export const involute = (a: number): number => Math.tan(a) - a;

/** Options of {@link involuteOutline}. */
export interface InvoluteOutlineOptions extends ToothForm {
  /** Points along each flank from its foot to the tip, at least 2. Default 6. */
  flankPoints?: number;
}

/**
 * The counterclockwise outline of a spur wheel, tooth 0 centred on +x: involute flanks from the base circle (radial
 * below it, where the root circle is inside the base circle), straight tip lands and a three-point root between
 * teeth. Feed it to an extrusion for a solid wheel.
 * @throws RangeError for a tooth count below 3, a module that is not positive or fewer than 2 flank points.
 * @example const loop = involuteOutline(24, 0.002); // [[x, y], ...], about 14 points a tooth
 */
export function involuteOutline(teeth: number, module: number, options: InvoluteOutlineOptions = {}): Point[] {
  checkWheel('involuteOutline', teeth, module);
  const n = options.flankPoints ?? 6;
  if (!Number.isInteger(n) || n < 2)
    throw new RangeError(`involuteOutline: flankPoints ${n} must be a whole number of 2 or more`);
  const { pressureAngle } = form(options);
  const { base: rb, tip: ra, root: rf } = gearRadii(teeth, module, options);
  const halfPitch = Math.PI / (2 * teeth);
  const halfWidth = (rho: number) =>
    halfPitch + involute(pressureAngle) - involute(Math.acos(Math.min(1, rb / Math.max(rho, rb))));
  const start = Math.max(rb, rf);
  // Denser toward the foot, where the involute curves most: the samples of the Orrery's wheels for six points.
  const flank =
    n === 6
      ? [0.0, 0.18, 0.38, 0.6, 0.8, 1.0].map((t) => start + (ra - start) * t)
      : Array.from({ length: n }, (_, i) => start + (ra - start) * (i / (n - 1)) ** 1.15);
  const polar = (rho: number, a: number): Point => [rho * Math.cos(a), rho * Math.sin(a)];
  const out: Point[] = [];
  for (let k = 0; k < teeth; k++) {
    const c = (TAU * k) / teeth;
    if (rf < rb) out.push(polar(rf, c - halfWidth(rb)));
    for (const rho of flank) out.push(polar(rho, c - Math.max(halfWidth(rho), 0)));
    for (let i = flank.length - 1; i >= 0; i--) out.push(polar(flank[i], c + Math.max(halfWidth(flank[i]), 0)));
    if (rf < rb) out.push(polar(rf, c + halfWidth(rb)));
    out.push(polar(rf, c + Math.PI / teeth));
  }
  return out;
}

/**
 * The angle (radians, anticlockwise from +x about the driven wheel's own centre) of the driven wheel of an external
 * mesh, so that its tooth 0 (on its local +x at angle 0) and the driver's teeth interleave: where the driver has a
 * tooth on the line of centres, the driven wheel has a gap. `toward` is the direction from the driver's centre to the
 * driven one's. The driven wheel turns the other way, by `driverTeeth / drivenTeeth` of the driver's turn.
 */
export function meshAngle(driver: number, driverTeeth: number, drivenTeeth: number, toward: number): number {
  return toward + Math.PI - Math.PI / drivenTeeth + ((toward - driver) * driverTeeth) / drivenTeeth;
}

/** Fraction of a tooth pitch by which a wheel of `teeth` at `angle` has a tooth centred on direction `dir` (0: tooth, 0.5: gap). */
export function toothPhase(angle: number, teeth: number, dir: number): number {
  const p = (((dir - angle) * teeth) / TAU) % 1;
  return p < 0 ? p + 1 : p;
}

/**
 * Tooth counts of a two-stage compound train: wheel `a` on the drive arbor meshes `b` on the stud arbor; `c`, fixed to
 * `b`, meshes `d` on the output. Two external meshes: the output turns the same way as the drive.
 */
export interface CompoundTrain {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** Output turns per drive turn: (a c) / (b d). */
export const compoundRatio = (t: CompoundTrain): number => (t.a * t.c) / (t.b * t.d);

/** Where a compound train's arbors stand and what each wheel must clear, in one length unit. */
export interface CompoundFrame {
  /** Centre of the drive arbor (wheel a). */
  drive: readonly [number, number];
  /** Centre of the stud arbor (wheels b and c). */
  stud: readonly [number, number];
  /** Centre of the output (wheel d). Default [0, 0]. */
  output?: readonly [number, number];
  /** Tooth counts allowed, inclusive. Default [15, 140]. */
  teeth?: readonly [number, number];
  /** Modules allowed, inclusive. Default [0, Infinity]. */
  module?: readonly [number, number];
  /** Radius of what turns on the output centre that wheels a and b must clear (a tube bundle). Default 0. */
  outputBundle?: number;
  /** Arbor radius that wheels c and d must clear on the drive arbor, and the pinions' bores. Default 0. */
  arbor?: number;
  /** Running clearance between a wheel's tips and an arbor or bundle it does not mesh with. Default 0. */
  clearance?: number;
  /** Room wheel d's root needs outside the output bundle (rim and spokes). Default 0. */
  outputHub?: number;
  /** Room each of a, b and c needs between its root and its arbor. Default 0. */
  pinionHub?: number;
  /** Tooth form of every wheel. */
  toothForm?: ToothForm;
}

const frameOf = (f: CompoundFrame) => {
  const output = f.output ?? [0, 0];
  for (const [name, p] of [
    ['drive', f.drive],
    ['stud', f.stud],
    ['output', output],
  ] as const)
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new RangeError(`CompoundFrame: ${name} must be a finite [x, y] centre`);
  const driveToStud = Math.hypot(f.stud[0] - f.drive[0], f.stud[1] - f.drive[1]),
    studToOutput = Math.hypot(output[0] - f.stud[0], output[1] - f.stud[1]),
    driveToOutput = Math.hypot(output[0] - f.drive[0], output[1] - f.drive[1]);
  if (!(driveToStud > 0 && studToOutput > 0))
    throw new RangeError('CompoundFrame: the drive, stud and output centres must be apart; move them');
  return {
    output,
    driveToStud,
    studToOutput,
    driveToOutput,
    teeth: f.teeth ?? [15, 140],
    module: f.module ?? [0, Infinity],
    outputBundle: f.outputBundle ?? 0,
    arbor: f.arbor ?? 0,
    clearance: f.clearance ?? 0,
    outputHub: f.outputHub ?? 0,
    pinionHub: f.pinionHub ?? 0,
    toothForm: f.toothForm ?? {},
    towardStud: Math.atan2(f.stud[1] - f.drive[1], f.stud[0] - f.drive[0]),
    // Written as the negated stud offset, so an output level with the stud on its +x side gives -pi (as atan2(-0, -x)),
    // the angle the Orrery's wheels were built with.
    towardOutput: Math.atan2(-(f.stud[1] - output[1]), -(f.stud[0] - output[0])),
  };
};

/** The modules the frame's centre distances give the two meshes: A for a with b, B for c with d. */
export function compoundModules(t: CompoundTrain, frame: CompoundFrame): { A: number; B: number } {
  const f = frameOf(frame);
  return { A: (2 * f.driveToStud) / (t.a + t.b), B: (2 * f.studToOutput) / (t.c + t.d) };
}

const radiiOf = (teeth: number, m: number, f: ToothForm) => {
  const { addendum, dedendum } = form(f);
  return { tip: (m * (teeth + 2 * addendum)) / 2, root: (m * (teeth - 2 * dedendum)) / 2 };
};

function misfitIn(t: CompoundTrain, f: ReturnType<typeof frameOf>): string | null {
  const A = (2 * f.driveToStud) / (t.a + t.b),
    B = (2 * f.studToOutput) / (t.c + t.d);
  for (const [name, n] of Object.entries(t))
    if (!Number.isInteger(n) || n < f.teeth[0] || n > f.teeth[1]) return `${name} has ${n} teeth`;
  if (A < f.module[0] || A > f.module[1] || B < f.module[0] || B > f.module[1]) return `module ${A}, ${B}`;
  const r = (n: number, m: number) => radiiOf(n, m, f.toothForm);
  // Mesh A: a (drive) and b (stud) beside what turns on the output. Mesh B: c (stud) and d (output) beside the drive arbor.
  if (r(t.a, A).tip + f.outputBundle + f.clearance > f.driveToOutput) return 'a reaches the output bundle';
  if (r(t.b, A).tip + f.outputBundle + f.clearance > f.studToOutput) return 'b reaches the output bundle';
  if (r(t.c, B).tip + f.arbor + f.clearance > f.driveToStud) return 'c reaches the drive arbor';
  if (r(t.d, B).tip + f.arbor + f.clearance > f.driveToOutput) return 'd reaches the drive arbor';
  if (r(t.d, B).root < f.outputBundle + f.outputHub) return 'd is smaller than the output bundle and its hub';
  for (const [n, m] of [
    [t.a, A],
    [t.b, A],
    [t.c, B],
  ] as const)
    if (r(n, m).root < f.arbor + f.pinionHub) return "a pinion's root is inside its arbor";
  return null;
}

/** Why a train does not fit the frame (a short reason), or null when every wheel fits and clears. */
export function compoundTrainMisfit(t: CompoundTrain, frame: CompoundFrame): string | null {
  return misfitIn(t, frameOf(frame));
}

/** Options of {@link designCompoundTrain}. */
export interface CompoundSearchOptions {
  /** Relative ratio error under which trains count as equal; among those the coarsest finer module wins. Default 2e-6. */
  tolerance?: number;
}

/**
 * The fitting compound train whose ratio comes closest to `wanted` (output turns per drive turn). Every a, b and c in
 * the frame's tooth range is tried with the two nearest d. Among trains within `tolerance` of the ratio, the one whose
 * finer module is coarsest wins (bigger teeth read better and are stronger); otherwise the smallest error wins.
 * @throws RangeError when `wanted` is not a positive number; MargoError (`failed`) when no train fits the frame.
 * @example const t = designCompoundTrain(1 / 12, { drive: [0.06, 0.05], stud: [0.06, 0] });
 */
export function designCompoundTrain(
  wanted: number,
  frame: CompoundFrame,
  options: CompoundSearchOptions = {},
): CompoundTrain {
  if (!(wanted > 0) || !Number.isFinite(wanted))
    throw new RangeError(
      `designCompoundTrain: ratio ${wanted} is not a positive number; pass output turns per drive turn`,
    );
  const f = frameOf(frame);
  const tolerance = options.tolerance ?? 2e-6;
  let best: CompoundTrain | null = null,
    bestError = Infinity,
    bestModule = 0;
  const [lo, hi] = f.teeth;
  for (let a = lo; a <= hi; a++)
    for (let b = lo; b <= hi; b++)
      for (let c = lo; c <= hi; c++) {
        // d follows from the others: the nearest integers to the exact value.
        const exact = (a * c) / (b * wanted);
        for (const d of [Math.floor(exact), Math.ceil(exact)]) {
          if (d < lo || d > hi) continue;
          const t = { a, b, c, d };
          const error = Math.abs(compoundRatio(t) / wanted - 1);
          if (error > Math.max(bestError, tolerance)) continue;
          if (misfitIn(t, f)) continue;
          const m = Math.min((2 * f.driveToStud) / (a + b), (2 * f.studToOutput) / (c + d));
          const better =
            error <= tolerance
              ? bestError > tolerance || m > bestModule || (m === bestModule && error < bestError)
              : error < bestError;
          if (better) [best, bestError, bestModule] = [t, error, m];
        }
      }
  if (!best)
    throw new MargoError(
      'failed',
      `designCompoundTrain: no train fits ratio ${wanted} in this frame; widen the tooth or module range`,
    );
  return best;
}

/** Every wheel's angle (radians) of a compound train for a drive angle, teeth interleaved at both meshes. */
export function compoundWheelAngles(
  train: CompoundTrain,
  drive: number,
  frame: CompoundFrame,
): { a: number; b: number; c: number; d: number } {
  const f = frameOf(frame);
  const b = meshAngle(drive, train.a, train.b, f.towardStud);
  return { a: drive, b, c: b, d: meshAngle(b, train.c, train.d, f.towardOutput) };
}
