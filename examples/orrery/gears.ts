// The orrery's gear trains, composed from @margoengine/procedural/gears: this frame's arbors and clearances, and the
// wanted ratio of each planet. Shared by the page (main.ts turns the model's wheels) and the Blender build, which cuts
// the wheels from blender/layout.json (layout.ts writes it; tests/orrery-gears.test.js checks both).
//
// Layout, seen from above (+y is the ecliptic's 90 degrees): the planets' tubes turn on the central axis C; a fixed stud
// arbor L2 stands D2 from it; the drive arbor L1 stands D12 from L2, a quarter turn round. Each planet has a two-stage
// train: wheel a fixed on the drive arbor meshes wheel b on L2; b turns c (one sleeve on L2), and c meshes wheel d on
// the planet's tube. Two external meshes keep d turning the same way as the drive arbor: anticlockwise from above.
import {
  compoundModules,
  compoundRatio,
  compoundTrainMisfit,
  compoundWheelAngles,
  designCompoundTrain,
  gearRadii,
  type CompoundFrame,
  type CompoundTrain,
} from '@margoengine/procedural/gears';
import {
  HELIOCENTRIC_PLANETS as PLANETS,
  STANDISH_ELEMENTS as ELEMENTS,
  centuries,
  type HeliocentricPlanet as PlanetName,
} from '@margoengine/sky/ephemeris';

export { toothPhase } from '@margoengine/procedural/gears';
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

/** The orrery's frame: d's hub needs a rim and spokes round the tubes; pinions keep 1.5 mm of metal over the arbor. */
export const ORRERY_FRAME: CompoundFrame = {
  drive: L1,
  stud: L2,
  output: [0, 0],
  teeth: TEETH,
  module: MODULE,
  outputBundle: TUBE_BUNDLE,
  arbor: ARBOR,
  clearance: CLEARANCE,
  outputHub: 0.006,
  pinionHub: 0.0015,
};

export type Train = CompoundTrain;
/** Pitch, tip and root radii of a wheel (standard addendum m, dedendum 1.25 m), as layout.json records them. */
export const radii = (teeth: number, m: number) => {
  const { pitch, tip, root } = gearRadii(teeth, m);
  return { pitch, tip, root };
};
export const ratio = compoundRatio;
export const modules = (t: Train) => compoundModules(t, ORRERY_FRAME);
/** Wanted ratio of a planet's wheel to the drive arbor. */
export const target = (name: PlanetName): number => ELEMENTS[name].rate[3] / DRIVE_RATE;
/** Why a train does not fit the frame, or null. */
export const misfit = (t: Train): string | null => compoundTrainMisfit(t, ORRERY_FRAME);
/** The closest-ratio train that fits the frame (coarsest module among those within 2 parts per million). */
export const bestTrain = (wanted: number): Train => designCompoundTrain(wanted, ORRERY_FRAME);
export const designTrains = (): Record<PlanetName, Train> =>
  Object.fromEntries(PLANETS.map((name) => [name, bestTrain(target(name))])) as Record<PlanetName, Train>;

/** The drive arbor's angle (radians) on a Julian Day: zero at J2000. */
export const driveAngle = (jd: number): number => DRIVE_RATE * centuries(jd) * (Math.PI / 180);
/** Every wheel's angle in radians for one planet's train, from the drive arbor's angle. */
export const wheelAngles = (train: Train, drive: number) => compoundWheelAngles(train, drive, ORRERY_FRAME);
