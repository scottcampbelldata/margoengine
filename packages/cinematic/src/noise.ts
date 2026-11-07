// @margoengine/cinematic/noise: a camera held by someone. A profile is plain data: bands of smooth noise on each axis.
// Each band is one dimensional gradient noise, so the motion never repeats, its value is a pure function of time and seed,
// and any frame rate gives the same path. Gradient noise is 0 at every lattice point, so a band takes two lattice points
// a cycle, as a sine has two zeros: half the power then lies below `frequency` and half above.
import { createRandom } from '@margoengine/math/mathutils';
import type { CameraPose } from './brain.js';

/** One layer of noise on one axis. */
export interface NoiseBand {
  /** Hertz, above 0: the middle of the band's power. It is noise, so the power spreads about this. */
  frequency: number;
  /** The most this band can add: world units for `position`, radians for `rotation`. 0 or more. */
  amplitude: number;
}

/** Noise on each axis of the camera, as plain data you can save as JSON. An axis left out stays still. */
export interface NoiseProfile {
  /** Along the camera's own right, up and back axes, before its roll. */
  position?: { x?: readonly NoiseBand[]; y?: readonly NoiseBand[]; z?: readonly NoiseBand[] };
  /** Turns of the view: up and down, left and right, and about the view. */
  rotation?: { pitch?: readonly NoiseBand[]; yaw?: readonly NoiseBand[]; roll?: readonly NoiseBand[] };
}

/** Settings of a {@link CameraNoise}. */
export interface CameraNoiseOptions {
  /** Scales every amplitude, 0 or more. Change it at any time, or tween it to fade the noise. Default 1. */
  gain?: number;
  /** Scales every frequency, 0 or more. Change it at any time. Default 1. */
  speed?: number;
  /** The same seed gives the same motion. It wraps to a 32 bit integer. Default 0. */
  seed?: number;
}

const deg = Math.PI / 180;
/**
 * A hand-held camera: slow sway of the arms, and hand tremor near the 5 to 12 Hz of published physiological tremor. The
 * amplitudes are our own choice by eye, not measured.
 */
export const handheld: NoiseProfile = {
  position: {
    x: [{ frequency: 0.4, amplitude: 0.012 }],
    y: [{ frequency: 0.5, amplitude: 0.012 }],
    z: [{ frequency: 0.3, amplitude: 0.01 }],
  },
  rotation: {
    pitch: [
      { frequency: 0.5, amplitude: 0.5 * deg },
      { frequency: 1.7, amplitude: 0.12 * deg },
      { frequency: 8, amplitude: 0.02 * deg },
    ],
    yaw: [
      { frequency: 0.4, amplitude: 0.6 * deg },
      { frequency: 1.3, amplitude: 0.12 * deg },
      { frequency: 7, amplitude: 0.02 * deg },
    ],
    roll: [{ frequency: 0.3, amplitude: 0.3 * deg }],
  },
};
/** A camera carried at a walk: the step near 2 Hz up and down, the sway of each leg at half that. Amplitudes by eye. */
export const walking: NoiseProfile = {
  position: {
    x: [{ frequency: 1, amplitude: 0.02 }],
    y: [{ frequency: 2, amplitude: 0.025 }],
  },
  rotation: {
    pitch: [{ frequency: 2, amplitude: 0.25 * deg }],
    yaw: [{ frequency: 0.4, amplitude: 0.3 * deg }],
    roll: [{ frequency: 1, amplitude: 0.35 * deg }],
  },
};
/**
 * A camera on a road vehicle: body bounce and pitch near the 1 to 2 Hz of a sprung mass, and the buzz of wheel hop near
 * 10 to 15 Hz. Amplitudes by eye.
 */
export const vehicle: NoiseProfile = {
  position: {
    y: [
      { frequency: 1.2, amplitude: 0.02 },
      { frequency: 12, amplitude: 0.003 },
    ],
  },
  rotation: {
    pitch: [
      { frequency: 1.4, amplitude: 0.3 * deg },
      { frequency: 12, amplitude: 0.04 * deg },
    ],
    roll: [{ frequency: 1, amplitude: 0.2 * deg }],
  },
};

const hash = (index: number, seed: number): number => {
  let h = Math.imul(index ^ seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1;
};
/**
 * One dimensional gradient noise with Perlin's quintic fade, doubled. A gradient of at most 1 gives at most 0.5 half way
 * between lattice points, so the value stays within -1..1.
 */
const gradient = (x: number, seed: number): number => {
  const cell = Math.floor(x),
    f = x - cell,
    fade = f * f * f * (f * (f * 6 - 15) + 10),
    a = hash(cell, seed) * f,
    b = hash(cell + 1, seed) * (f - 1);
  return 2 * (a + (b - a) * fade);
};

const AXES = ['x', 'y', 'z', 'pitch', 'yaw', 'roll'] as const;

/** Compiled bands: lattice points a second, amplitude and seed of each, by axis. */
type Bands = Float64Array[];

/** Rotates `v` about the unit axis `k`, by Rodrigues' formula. */
const turn = (v: Float64Array, kx: number, ky: number, kz: number, angle: number): void => {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    d = (kx * v[0] + ky * v[1] + kz * v[2]) * (1 - c),
    x = v[0] * c + (ky * v[2] - kz * v[1]) * s + kx * d,
    y = v[1] * c + (kz * v[0] - kx * v[2]) * s + ky * d,
    z = v[2] * c + (kx * v[1] - ky * v[0]) * s + kz * d;
  v[0] = x;
  v[1] = y;
  v[2] = z;
};

/**
 * A stage that shakes the camera by a profile. Put it after the stages that aim. It runs until you stop it: set `gain`
 * to 0, or tween it. For one short hit use `Cinematic.shake`.
 */
export class CameraNoise {
  /** Scales every amplitude; change it at any time. */
  gain: number;
  /** Scales every frequency; change it at any time. */
  speed: number;
  /** Seconds of noise so far, after `speed`. Set it to replay a moment. */
  time = 0;
  /** The current value of each axis, in the order x, y, z, pitch, yaw, roll, with `gain` applied. */
  readonly values = new Float64Array(6);
  private readonly bands: Bands;
  private readonly view = new Float64Array(3);
  /** @throws RangeError for a band or option outside the allowed range. */
  constructor(
    readonly profile: NoiseProfile,
    options: CameraNoiseOptions = {},
  ) {
    const { gain = 1, speed = 1, seed = 0 } = options;
    if (!(gain >= 0 && gain < Infinity) || !(speed >= 0 && speed < Infinity) || !Number.isFinite(seed))
      throw new RangeError('Invalid camera noise; pass a gain and speed of 0 or more and a finite seed');
    this.gain = gain;
    this.speed = speed;
    const random = createRandom(seed),
      lists: (readonly NoiseBand[] | undefined)[] = [
        profile?.position?.x,
        profile?.position?.y,
        profile?.position?.z,
        profile?.rotation?.pitch,
        profile?.rotation?.yaw,
        profile?.rotation?.roll,
      ];
    this.bands = AXES.map((_axis, i) => {
      const list = lists[i] ?? [],
        packed = new Float64Array(list.length * 3);
      list.forEach((band, b) => {
        if (!(band?.frequency > 0 && band.frequency < Infinity && band.amplitude >= 0 && band.amplitude < Infinity))
          throw new RangeError('Invalid noise band; pass a frequency above 0 and an amplitude of 0 or more');
        packed[b * 3] = band.frequency * 2;
        packed[b * 3 + 1] = band.amplitude;
        packed[b * 3 + 2] = Math.floor(random() * 2147483647);
      });
      return packed;
    });
  }
  /** Stage hook. @throws RangeError when `gain` or `speed` was set out of range. */
  update(pose: CameraPose, delta: number): void {
    const { gain, speed, values, view } = this;
    if (!(gain >= 0 && gain < Infinity) || !(speed >= 0 && speed < Infinity))
      throw new RangeError('Invalid camera noise; pass a gain and speed of 0 or more');
    this.time += delta * speed;
    for (let axis = 0; axis < 6; axis++) {
      const bands = this.bands[axis];
      let sum = 0;
      for (let i = 0; i < bands.length; i += 3) sum += bands[i + 1] * gradient(this.time * bands[i], bands[i + 2]);
      values[axis] = sum * gain;
    }
    const { position, target, up } = pose;
    view[0] = target[0] - position[0];
    view[1] = target[1] - position[1];
    view[2] = target[2] - position[2];
    const length = Math.hypot(view[0], view[1], view[2]);
    if (!(length > 0)) return;
    const fx = view[0] / length,
      fy = view[1] / length,
      fz = view[2] / length;
    let rx = fy * up[2] - fz * up[1],
      ry = fz * up[0] - fx * up[2],
      rz = fx * up[1] - fy * up[0];
    let size = Math.hypot(rx, ry, rz);
    if (size < 1e-9) {
      // Looking along up: any side will do.
      const small = Math.abs(fx) < 0.9;
      rx = small ? 0 : -fz;
      ry = small ? fz : 0;
      rz = small ? -fy : fx;
      size = Math.hypot(rx, ry, rz);
    }
    rx /= size;
    ry /= size;
    rz /= size;
    const tx = ry * fz - rz * fy,
      ty = rz * fx - rx * fz,
      tz = rx * fy - ry * fx;
    turn(view, rx, ry, rz, values[3]);
    turn(view, tx, ty, tz, values[4]);
    const [x, y, z] = values;
    position[0] += rx * x + tx * y - fx * z;
    position[1] += ry * x + ty * y - fy * z;
    position[2] += rz * x + tz * y - fz * z;
    target[0] = position[0] + view[0];
    target[1] = position[1] + view[1];
    target[2] = position[2] + view[2];
    pose.roll += values[5];
  }
}
