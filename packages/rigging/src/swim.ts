import type { RigPose } from './rig.js';

/** The supplied swimming profiles, including a fin-driven ray. */
export type SwimSpecies = 'reef-fish' | 'reef-shark' | 'bottlenose-dolphin' | 'humpback-whale' | 'bluespotted-ray';

interface SwimProfile {
  readonly vertical: boolean;
  readonly onset: number;
  readonly envelope: number;
  readonly wavelength: number;
  readonly excursion: number;
  readonly feather: number;
  readonly strouhal: number;
  readonly turn: number;
}

// Dimensionless silhouette and motion controls, expressed relative to head–tail hinge distance.
// The profiles describe representative cruising poses. See the README for their derivation.
const profiles: Record<SwimSpecies, SwimProfile> = {
  'reef-fish': {
    vertical: false,
    onset: 0.24,
    envelope: 2,
    wavelength: 0.94,
    excursion: 0.095,
    feather: 0.25,
    strouhal: 0.29,
    turn: 0.52,
  },
  'reef-shark': {
    vertical: false,
    onset: 0.16,
    envelope: 1.6,
    wavelength: 1.04,
    excursion: 0.078,
    feather: 0.16,
    strouhal: 0.29,
    turn: 0.48,
  },
  'bottlenose-dolphin': {
    vertical: true,
    onset: 0.46,
    envelope: 2.1,
    wavelength: 1.27,
    excursion: 0.088,
    feather: 0.33,
    strouhal: 0.27,
    turn: 0.49,
  },
  'humpback-whale': {
    vertical: true,
    onset: 0.48,
    envelope: 2.45,
    wavelength: 1.52,
    excursion: 0.085,
    feather: 0.4,
    strouhal: 0.25,
    turn: 0.38,
  },
  'bluespotted-ray': {
    vertical: false,
    onset: 0.78,
    envelope: 2.6,
    wavelength: 1.41,
    excursion: 0.012,
    feather: 0.04,
    strouhal: 0.25,
    turn: 0.16,
  },
};

const TAU = 2 * Math.PI;

/** Scale and joint placement for a swimming skeleton. */
export interface SwimRigOptions {
  /** Head to caudal-fin or fluke hinge in metres. */
  readonly length: number;
  /** Number of articulated spine segments. The tail hinge is one extra joint. Default 24. */
  readonly segments?: number;
  /** Optional nonuniform hinge positions as fractions of length, starting at 0 and ending at 1. */
  readonly stations?: readonly number[];
  /** Paired pectoral hinges, in head-relative metres. The closest spine station owns each hinge. */
  readonly pectorals?: readonly [left: SwimFin, right: SwimFin];
}

/** Hinge locations and rotation range for a pectoral fin. */
export interface SwimFin {
  /** Proximal hinge in head-relative metres. */
  readonly position: readonly [number, number, number];
  /** Available fin roll in radians. Default 0.22. */
  readonly roll?: number;
  /** Optional distal hinge in head-relative metres, for a travelling wave along a flexible fin. */
  readonly distal?: readonly [number, number, number];
}

/** A sampled swimmer's topology and local bind pose. */
export interface SwimRig extends RigPose {
  /** Profile used when sampling the chain. */
  readonly species: SwimSpecies;
  /** Head to caudal hinge, in metres. */
  readonly length: number;
  /** Fractional spine locations in head-to-tail order. */
  readonly stations: readonly number[];
  /** Optional calibrated paired fins. */
  readonly pectorals?: readonly [left: SwimFin, right: SwimFin];
  /** Local bind translations, quaternion rotations and scales, ten floats per joint. */
  readonly rest: Float32Array;
}

/** Animated stroke controls at one sample of the swimmer's path. */
export interface SwimStroke {
  /** Accumulated tail beats, including the fractional beat. Drive this continuously across speed changes. */
  readonly phase: number;
  /** Stroke amplitude. Fade to zero to coast. Default 1, range 0–1. */
  readonly effort?: number;
  /** Lateral body bend, left negative and right positive. Default 0, range −1 to 1. */
  readonly turn?: number;
}

/** Create a Y-up, +Z-forward chain. The head is at the origin and the tail extends along −Z. */
export function createSwimRig(species: SwimSpecies, options: SwimRigOptions): SwimRig {
  if (!Object.hasOwn(profiles, species))
    throw new RangeError('Unknown swimming species profile; pass a supplied SwimSpecies');
  const { length, segments = 24 } = options;
  if (!Number.isFinite(length) || length < 0.001 || length > 1_000)
    throw new RangeError('Swimmer length must be in the range 0.001–1000 metres');
  if (!Number.isInteger(segments) || segments < 4 || segments >= 65536)
    throw new RangeError('A swimmer needs 4 to 65,535 spine segments');
  const stations = options.stations
    ? Array.from(options.stations)
    : Array.from({ length: segments + 1 }, (_, i) => i / segments);
  if (
    stations.length < 5 ||
    stations.length > 65536 ||
    stations[0] !== 0 ||
    stations.at(-1) !== 1 ||
    stations.some((value, i) => !Number.isFinite(value) || (i > 0 && value - stations[i - 1] < 1e-8))
  )
    throw new RangeError('Swimmer stations need 5 to 65,536 increasing fractions from 0 to 1');
  const suppliedFins = options.pectorals ?? (species === 'bluespotted-ray' ? rayFins(length) : undefined);
  const pectorals = suppliedFins?.map(({ position, roll = 0.22, distal }) => {
    const valid = (p: readonly number[]) => p.length === 3 && p.every(Number.isFinite) && p[2] <= 0 && p[2] >= -length;
    if (!valid(position) || (distal && !valid(distal)) || !Number.isFinite(roll) || roll < 0 || roll > Math.PI / 2)
      throw new RangeError('Pectoral hinge needs a finite XYZ position along the body and roll from 0 to π/2');
    return { position: [...position], roll, ...(distal && { distal: [...distal] }) };
  }) as unknown as SwimRig['pectorals'];
  const finJoints = pectorals?.reduce((n, p) => n + (p.distal ? 2 : 1), 0) ?? 0;
  if ((pectorals && pectorals.length !== 2) || stations.length + finJoints > 65536)
    throw new RangeError('Pectorals need a left/right pair with available joint indices');
  const rest = new Float32Array((stations.length + finJoints) * 10);
  const last = stations.length - 1;
  for (let i = 0; i <= last; i++) {
    const distance = i > 0 ? (stations[i] - stations[i - 1]) * length : 0;
    rest.set([0, 0, -distance, 0, 0, 0, 1, 1, 1, 1], i * 10);
  }
  const names = stations.map((_, i) => (i === 0 ? 'head' : i === last ? 'caudal-fin' : `spine-${i}`));
  const parents = stations.map((_, i) => i - 1);
  pectorals?.forEach(({ position }, i) => {
    const [x, y, z] = position;
    const fraction = -z / length;
    const owner = stations.reduce(
      (best, s, index) => (Math.abs(fraction - s) < Math.abs(fraction - stations[best]) ? index : best),
      0,
    );
    names.push(i === 0 ? 'pectoral-L' : 'pectoral-R');
    parents.push(owner);
    rest.set([x, y, z + stations[owner] * length, 0, 0, 0, 1, 1, 1, 1], (stations.length + i) * 10);
  });
  pectorals?.forEach(({ position, distal }, i) => {
    if (!distal) return;
    const offset = names.length * 10;
    names.push(i === 0 ? 'pectoral-tip-L' : 'pectoral-tip-R');
    parents.push(stations.length + i);
    rest.set([...distal.map((v, axis) => v - position[axis]), 0, 0, 0, 1, 1, 1, 1], offset);
  });
  return { species, length, stations, names, parents, rest, ...(pectorals && { pectorals }) };
}

function rayFins(length: number): NonNullable<SwimRigOptions['pectorals']> {
  const fin = (side: number): SwimFin => ({
    position: [side * length * 0.054, length * 0.022, -length * 0.05],
    distal: [side * length * 0.285, length * 0.015, -length * 0.21],
    roll: 0.68,
  });
  return [fin(1), fin(-1)];
}

/** Estimate steady cruising cadence in beats/second using profile Strouhal number and peak-to-peak excursion. */
export function swimCadence(rig: SwimRig, speed: number, effort = 1): number {
  if (!Number.isFinite(speed) || speed < 0 || !Number.isFinite(effort) || effort <= 0 || effort > 1)
    throw new RangeError('Cruising speed must be nonnegative and effort greater than 0, up to 1');
  const profile = profiles[rig.species];
  const excursion = rig.species === 'bluespotted-ray' ? 0.13 : profile.excursion;
  const rate = (profile.strouhal * speed) / (2 * excursion * rig.length * effort);
  if (!Number.isFinite(rate))
    throw new RangeError('Cruising cadence exceeds the finite range; increase effort or lower speed');
  return rate;
}

/**
 * Evaluate local translation/rotation/scale frames. The output may be reused and must have the
 * same size as rig.rest. Each span follows an analytic body-wave tangent at its midpoint, keeping
 * the underlying segment length constant. The last joint feathers the caudal fin or flukes.
 */
export function sampleSwimPose(
  rig: SwimRig,
  stroke: SwimStroke,
  out = new Float32Array(rig.rest.length),
): Float32Array {
  const { phase, effort = 1, turn = 0 } = stroke;
  if (
    !Number.isFinite(phase) ||
    !Number.isFinite(effort) ||
    effort < 0 ||
    effort > 1 ||
    !Number.isFinite(turn) ||
    Math.abs(turn) > 1
  )
    throw new RangeError('A swim stroke needs a finite phase, effort from 0 to 1 and turn from −1 to 1');
  if (out.length !== rig.rest.length || out.buffer === rig.rest.buffer)
    throw new RangeError('The swim output must be separate from the matching rest pose');
  out.set(rig.rest);
  if (effort === 0 && turn === 0) return out;

  const { vertical, onset, envelope, wavelength, excursion, feather, turn: bend } = profiles[rig.species];
  const waveNumber = TAU / wavelength;
  const cycle = TAU * (phase % 1);
  const last = rig.stations.length - 1;
  let previousX = 0,
    previousY = 0,
    previousZ = 0,
    previousW = 1;
  for (let joint = 0; joint <= last; joint++) {
    const s = joint === last ? 1 : (rig.stations[joint] + rig.stations[joint + 1]) * 0.5;
    const posterior = Math.max(0, (s - onset) / (1 - onset));
    const wave = waveNumber * s - cycle;
    const amplitude = posterior ** envelope;
    const gradient = (envelope * posterior ** (envelope - 1)) / (1 - onset);
    const slope = effort * excursion * (gradient * Math.sin(wave) + waveNumber * amplitude * Math.cos(wave));
    const tailPitch = joint === last ? effort * feather * Math.cos(wave - Math.PI / 4) : 0;
    const lateral = turn * bend * s * s + (vertical ? 0 : -Math.atan(slope) + tailPitch);
    const sagittal = vertical ? Math.atan(slope) + tailPitch : 0;
    // Compose heading and pitch then convert to a parent-relative orientation. This retains
    // a true sagittal plane when a cetacean is turning and avoids introducing spine roll.
    const yaw = lateral * 0.5,
      pitch = sagittal * 0.5;
    const x = Math.cos(yaw) * Math.sin(pitch),
      y = Math.sin(yaw) * Math.cos(pitch);
    const z = -Math.sin(yaw) * Math.sin(pitch),
      w = Math.cos(yaw) * Math.cos(pitch);
    const i = joint * 10 + 3;
    out[i] = previousW * x - previousX * w - previousY * z + previousZ * y;
    out[i + 1] = previousW * y + previousX * z - previousY * w - previousZ * x;
    out[i + 2] = previousW * z - previousX * y + previousY * x - previousZ * w;
    out[i + 3] = previousW * w + previousX * x + previousY * y + previousZ * z;
    previousX = x;
    previousY = y;
    previousZ = z;
    previousW = w;
  }
  let tip = last + 3;
  rig.pectorals?.forEach(({ roll = 0.22, distal }, index) => {
    const side = index === 0 ? 1 : -1;
    const ray = rig.species === 'bluespotted-ray';
    const phase = cycle + side * 0.16 - 0.67;
    const beat = effort * (ray ? 0.85 : vertical ? 0.41 : 0.19) * Math.sin(phase);
    const angle = (side * beat + turn * 0.52) * roll * 0.5;
    const offset = (last + 1 + index) * 10;
    out[offset + 5] = Math.sin(angle);
    out[offset + 6] = Math.cos(angle);
    if (distal) {
      const tipAngle = (side * effort * Math.sin(phase - 0.78) + turn * 0.18) * roll * 0.5 - angle;
      out[tip * 10 + 5] = Math.sin(tipAngle);
      out[tip * 10 + 6] = Math.cos(tipAngle);
      tip++;
    }
  });

  return out;
}
