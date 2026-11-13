// The orrery's gear trains: tooth counts, where each wheel sits and the angle every wheel turns to on a date.
// Shared by the page (main.ts turns the model's wheels) and the Blender build, which cuts the wheels from
// blender/layout.json (layout.ts writes it; tests/orrery-gears.test.js checks both).
//
// Layout, seen from above (+y is the ecliptic's 90 degrees): the planets' tubes turn on the central axis C; a fixed stud
// arbor L2 stands D2 from it; the drive arbor L1 stands D12 from L2, a quarter turn round. Each planet has a two-stage
// train: wheel a fixed on the drive arbor meshes wheel b on L2; b turns c (one sleeve on L2), and c meshes wheel d on
// the planet's tube. Two external meshes keep d turning the same way as the drive arbor: anticlockwise from above.
import { ELEMENTS, PLANETS, centuries, type PlanetName } from './ephemeris.ts';

/** Centre distances in metres. */
export const FRAME = { D2: 0.078, D12: 0.062, phi: Math.PI / 2 } as const;
export const L2: readonly [number, number] = [FRAME.D2, 0];
export const L1: readonly [number, number] = [
  FRAME.D2 + FRAME.D12 * Math.cos(FRAME.phi),
  FRAME.D12 * Math.sin(FRAME.phi),
];
/** Outer radius of the tube bundle on C (eight tubes round the Sun's arbor), and of an arbor. */
export const TUBE_BUNDLE = 0.0165;
export const ARBOR = 0.004;
/** Running clearance kept between a wheel's tips and any arbor or tube it does not mesh with. */
export const CLEARANCE = 0.003;
export const TEETH: readonly [number, number] = [15, 140];
export const MODULE: readonly [number, number] = [0.0006, 0.0024];
/** The drive arbor turns once every three Earth years: a third of Earth's rate of mean longitude (degrees/century). */
export const DRIVE_RATE = ELEMENTS.earth.rate[3] / 3;

export type Train = { a: number; b: number; c: number; d: number };
/** Pitch, tip and root radii of a wheel of `teeth` teeth with module `m` (standard addendum m, dedendum 1.25 m). */
export const radii = (teeth: number, m: number) => ({
  pitch: (m * teeth) / 2,
  tip: (m * (teeth + 2)) / 2,
  root: (m * (teeth - 2.5)) / 2,
});
export const ratio = (t: Train): number => (t.a * t.c) / (t.b * t.d);
export const modules = (t: Train) => ({ A: (2 * FRAME.D12) / (t.a + t.b), B: (2 * FRAME.D2) / (t.c + t.d) });
/** Wanted ratio of a planet's wheel to the drive arbor. */
export const target = (name: PlanetName): number => ELEMENTS[name].rate[3] / DRIVE_RATE;

/** Why a train does not fit the frame, or null. Every wheel clears the arbors and tubes it does not mesh with. */
export function misfit(t: Train): string | null {
  const { A, B } = modules(t);
  const l1 = Math.hypot(L1[0], L1[1]);
  for (const [name, n] of Object.entries(t))
    if (!Number.isInteger(n) || n < TEETH[0] || n > TEETH[1]) return `${name} has ${n} teeth`;
  if (A < MODULE[0] || A > MODULE[1] || B < MODULE[0] || B > MODULE[1]) return `module ${A}, ${B}`;
  // Level A: a (on L1) and b (on L2) beside the tube bundle on C. Level B: c (on L2) and d (on C) beside L1's arbor.
  if (radii(t.a, A).tip + TUBE_BUNDLE + CLEARANCE > l1) return 'a reaches the tubes';
  if (radii(t.b, A).tip + TUBE_BUNDLE + CLEARANCE > FRAME.D2) return 'b reaches the tubes';
  if (radii(t.c, B).tip + ARBOR + CLEARANCE > FRAME.D12) return 'c reaches the drive arbor';
  if (radii(t.d, B).tip + ARBOR + CLEARANCE > l1) return 'd reaches the drive arbor';
  // Hubs: d must sit round the tube bundle with a rim and spokes; the others (pinions included) clear their arbor.
  if (radii(t.d, B).root < TUBE_BUNDLE + 0.006) return 'd is smaller than the tube bundle';
  for (const [n, m] of [
    [t.a, A],
    [t.b, A],
    [t.c, B],
  ] as const)
    if (radii(n, m).root < ARBOR + 0.0015) return "a pinion's root is inside its arbor";
  return null;
}

/**
 * The closest-ratio train that fits the frame for `wanted`. Among trains within 2 parts per million of it, the one
 * with the coarsest finer module wins (bigger teeth read better at this size).
 */
export function bestTrain(wanted: number): Train {
  let best: Train | null = null,
    bestError = Infinity,
    bestModule = 0;
  const [lo, hi] = TEETH;
  for (let a = lo; a <= hi; a++)
    for (let b = lo; b <= hi; b++)
      for (let c = lo; c <= hi; c++) {
        // d follows from the others: the nearest integers to the exact value.
        const exact = (a * c) / (b * wanted);
        for (const d of [Math.floor(exact), Math.ceil(exact)]) {
          if (d < lo || d > hi) continue;
          const t = { a, b, c, d };
          const error = Math.abs(ratio(t) / wanted - 1);
          if (error > Math.max(bestError, 2e-6)) continue;
          if (misfit(t)) continue;
          const m = Math.min(modules(t).A, modules(t).B);
          const better =
            error <= 2e-6
              ? bestError > 2e-6 || m > bestModule || (m === bestModule && error < bestError)
              : error < bestError;
          if (better) [best, bestError, bestModule] = [t, error, m];
        }
      }
  if (!best) throw new Error(`no train fits ratio ${wanted}`);
  return best;
}

export const designTrains = (): Record<PlanetName, Train> =>
  Object.fromEntries(PLANETS.map((name) => [name, bestTrain(target(name))])) as Record<PlanetName, Train>;

const TAU = Math.PI * 2;
/**
 * The angle (radians, anticlockwise from +x about the wheel's own centre) of the driven wheel of a mesh, so that its
 * tooth 0 (on its local +x at angle 0) and the driver's teeth interleave: where the driver has a tooth on the line of
 * centres, the driven wheel has a gap. `toward` is the direction from the driver's centre to the driven one's.
 */
export function meshAngle(driver: number, driverTeeth: number, drivenTeeth: number, toward: number): number {
  return toward + Math.PI - Math.PI / drivenTeeth + ((toward - driver) * driverTeeth) / drivenTeeth;
}

/** Fraction of a tooth pitch by which wheel `n` at `angle` has a tooth centred on direction `dir` (0: tooth, 0.5: gap). */
export function toothPhase(angle: number, teeth: number, dir: number): number {
  const p = (((dir - angle) * teeth) / TAU) % 1;
  return p < 0 ? p + 1 : p;
}

export type WheelAngles = { a: number; b: number; c: number; d: number };
const towardL2 = Math.atan2(L2[1] - L1[1], L2[0] - L1[0]);
const towardC = Math.atan2(-L2[1], -L2[0]);

/** The drive arbor's angle (radians) on a Julian Day: zero at J2000. */
export const driveAngle = (jd: number): number => DRIVE_RATE * centuries(jd) * (Math.PI / 180);

/** Every wheel's angle in radians for one planet's train, from the drive arbor's angle. */
export function wheelAngles(train: Train, drive: number): WheelAngles {
  const a = drive;
  const b = meshAngle(a, train.a, train.b, towardL2);
  const c = b;
  const d = meshAngle(c, train.c, train.d, towardC);
  return { a, b, c, d };
}
