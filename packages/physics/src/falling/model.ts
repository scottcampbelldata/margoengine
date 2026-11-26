import { MargoError } from '@margoengine/math/errors';
import { cos, hypot, sin } from '@margoengine/math/pinned';

export type Vector = readonly [number, number, number];
export type Rotation = readonly [number, number, number, number];

const ZERO = [0, 0, 0] as const;
const Z_AXIS = [0, 0, 1] as const;
const TURN = 2 * Math.PI;

interface FallingInitialState {
  /** Initial position in metres, in the solver's cell. Defaults to [0, 0, 0]. */
  readonly position?: Vector;
  /** Initial world-axis velocity in m/s. Defaults to [0, 0, 0]. */
  readonly velocity?: Vector;
  /** Dry mass in kg. */
  readonly mass: number;
}

/** A finite-span plate with an elliptical chord/thickness cross section (Andersen, Pesavento and Wang 2005). */
export interface FallingPlate extends FallingInitialState {
  readonly kind: 'plate';
  /** Full chord in metres. */
  readonly chord: number;
  /** Full span in metres. Defaults to the chord. */
  readonly span?: number;
  /** Full thickness in metres, in [0, chord]. Defaults to the thin-plate limit 0. */
  readonly thickness?: number;
  /** Fixed world-axis direction about which the plate pitches. Defaults to +Z. */
  readonly spanDirection?: Vector;
  /** Initial chord angle in radians above the flight plane's horizontal axis. Defaults to 0. */
  readonly angle?: number;
  /** Initial pitch rate in rad/s. Defaults to 0. */
  readonly angularVelocity?: number;
  /** Pitch inertia in kg m². Defaults to that of the elliptical cross section. */
  readonly pitchInertia?: number;
  /** Translational lift coefficient of Eq. (3.7). Defaults to 1.2. */
  readonly translationalLift?: number;
  /** Rotational lift coefficient of Eq. (3.7). Defaults to π. */
  readonly rotationalLift?: number;
  /** Edge-on drag, A - B in Eq. (3.8). Defaults to 0.4. */
  readonly edgeDrag?: number;
  /** Broadside drag, A + B in Eq. (3.8). Defaults to 2.4. */
  readonly faceDrag?: number;
  /** Spanwise drag coefficient, acting on the elliptical cross section. Defaults to edgeDrag. */
  readonly spanDrag?: number;
  /** Linear pitch damping μ1 in Eq. (3.9). Defaults to 0.2. */
  readonly spinDragLinear?: number;
  /** Quadratic pitch damping μ2 in Eq. (3.9). Defaults to 0.2. */
  readonly spinDragQuadratic?: number;
}

/** The local medium for a user-supplied drag law. */
export interface FallingDragSample {
  /** Air density in kg/m³. */
  readonly density: number;
  /** Air temperature in kelvin. */
  readonly temperature: number;
  /** Magnitude of world gravity in m/s². */
  readonly gravity: number;
}

/** A rigid rounded grain with size-dependent quadratic drag and buoyancy. */
export interface FallingSphere extends FallingInitialState {
  readonly kind: 'sphere';
  /** Diameter in metres. */
  readonly diameter: number;
  /** Nonnegative drag coefficient or pure local-air law. Defaults to 0.47. */
  readonly drag?: number | ((air: FallingDragSample) => number);
  /** Fraction of normal speed kept at a static surface, in [0, 1]. Defaults to 0. */
  readonly restitution?: number;
}

/** One constant-chord radial strip of a winged seed, relative to its centre of mass. */
export interface FallingBladeSection {
  /** Inner radius in metres, nonnegative. */
  readonly start: number;
  /** Outer radius in metres, strictly greater than start. */
  readonly end: number;
  /** Width of the strip in metres, along its chord. */
  readonly chord: number;
  /** Section pitch in radians (negative pitches feed normal autorotation). Defaults to -7 degrees. */
  readonly pitch?: number;
  /** Azimuth of this strip about the seed axis, in radians. Defaults to 0. */
  readonly azimuth?: number;
}

/** Blade-element autorotation with an authored fixed spin axis and pitch. */
export interface FallingSamara extends FallingInitialState {
  readonly kind: 'samara';
  /** Radial strips of the wing or wings. Disjoint strips with the same azimuth form one blade. */
  readonly sections: readonly FallingBladeSection[];
  /** Seed inertia about its spin axis, kg m². */
  readonly spinInertia: number;
  /** World-axis direction of the spin axis. Defaults to opposite gravity, or +Y in zero gravity. */
  readonly axis?: Vector;
  /** Initial azimuth in radians. Defaults to 0. */
  readonly angle?: number;
  /** Initial spin in radians per second. Defaults to 0. */
  readonly angularVelocity?: number;
  /** Fluid displaced by the seed in m³. Defaults to 0. */
  readonly volume?: number;
  /** Potential lift factor Kp (Rezgui et al., 2020). Defaults to 3.57. */
  readonly potentialLift?: number;
  /** Leading-edge-vortex lift factor Kv (Rezgui et al., 2020). Defaults to 2.57. */
  readonly vortexLift?: number;
  /** Section drag at zero angle. Defaults to 0.07. */
  readonly profileDrag?: number;
  /** Add pressure drag CL tan(alpha) to profile drag. Defaults to true. */
  readonly inducedDrag?: boolean;
}

/** Physical shape and initial state of one light body. */
export type FallingBody = FallingSphere | FallingPlate | FallingSamara;

// f64 rows agree with the Wasm Model and State structs. State uses the fixed
// span frame, which leaves the four RK stages independent of frame transforms.
export const MODEL_WORDS = 22;
export const STATE_WORDS = 8;
export const AIR_WORDS = 5;
export const SECTION_WORDS = 6;

export interface FallingFrame {
  readonly x: Vector;
  readonly y: Vector;
  readonly z: Vector;
  readonly orientation: Rotation;
}

export const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function worldVector(frame: FallingFrame, x: number, y: number, z: number): Vector {
  return [
    frame.x[0] * x + frame.y[0] * y + frame.z[0] * z,
    frame.x[1] * x + frame.y[1] * y + frame.z[1] * z,
    frame.x[2] * x + frame.y[2] * y + frame.z[2] * z,
  ];
}

function vector(value: Vector, label: string): Vector {
  if (value?.length !== 3 || !value.every(Number.isFinite))
    throw new RangeError(label + ' exceeds its domain. Pass three finite Cartesian components.');
  return value;
}

function scalar(value: number, label: string, zeroAllowed = false): number {
  if (!Number.isFinite(value) || (zeroAllowed ? value < 0 : value <= 0))
    throw new RangeError(
      label + ' exceeds its domain. Pass a finite ' + (zeroAllowed ? 'nonnegative' : 'positive') + ' value.',
    );
  return value;
}

function frameFor(span: Vector): FallingFrame {
  vector(span, 'Falling body spin axis');
  const scale = Math.max(Math.abs(span[0]), Math.abs(span[1]), Math.abs(span[2]));
  if (scale === 0) throw new RangeError('Falling body spin axis is zero. Pass a nonzero direction.');
  const [sx, sy, sz] = span.map((v) => v / scale) as [number, number, number];
  const norm = hypot(sx, sy, sz);
  const z = [sx / norm, sy / norm, sz / norm] as const;
  const projected = hypot(sx, sz);
  const hx = projected === 0 ? 0 : sx / projected;
  const hz = projected === 0 ? 1 : sz / projected;
  const x = [hz, 0, -hx] as const;
  const y = [-z[1] * hx, projected / norm, -z[1] * hz] as const;
  // Two axis rotations build the given orthonormal basis. Half angles come
  // from their unit pairs. This avoids atan2 and its platform variation.
  const highCos = Math.sqrt((1 + hz) / 2);
  const highSin = Math.sqrt((1 - hz) / 2) * (hx < 0 ? -1 : 1);
  const yawCos = hz >= 0 ? highCos : hx / (2 * highSin);
  const yawSin = hz >= 0 ? hx / (2 * highCos) : highSin;
  const pitchCos = Math.sqrt((1 + y[1]) / 2);
  const pitchSin = z[1] === 0 ? 0 : -z[1] / (2 * pitchCos);
  return {
    x,
    y,
    z,
    orientation: [yawCos * pitchSin, yawSin * pitchCos, -yawSin * pitchSin, yawCos * pitchCos],
  };
}

export function fallingRotation(frame: FallingFrame, angle: number): Rotation {
  const [x, y, z, w] = frame.orientation;
  const s = sin(angle / 2);
  const c = cos(angle / 2);
  return [x * c + y * s, y * c - x * s, z * c + w * s, w * c - z * s];
}

export interface FallingSphereSetup {
  readonly radius: number;
  readonly area: number;
  readonly restitution: number;
  readonly drag: NonNullable<FallingSphere['drag']>;
}

// Three Gauss–Legendre points integrate polynomials through degree five
// exactly, including the cubic radius moment of pure profile spin damping.
const GAUSS_POSITIONS = [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)] as const;
const GAUSS_WEIGHTS = [5 / 9, 8 / 9, 5 / 9] as const;

function bladeNodes(parts: readonly FallingBladeSection[]): number[] {
  if (!Array.isArray(parts) || parts.length === 0)
    throw new RangeError('Samara blade has no strips. Supply at least one radial strip.');
  const nodes: number[] = [];
  for (const part of parts) {
    if (part == null) throw new TypeError('Missing samara strip. Provide a radial strip object at every index.');
    const start = scalar(part.start, 'Samara strip start radius', true);
    const end = scalar(part.end, 'Samara strip end radius');
    const chord = scalar(part.chord, 'Samara strip chord');
    const pitch = (part.pitch ?? (-7 * Math.PI) / 180) % TURN;
    const azimuth = (part.azimuth ?? 0) % TURN;
    const half = (end - start) / 2;
    const area = half * chord;
    if (!(area > 0) || ![pitch, azimuth, area].every(Number.isFinite))
      throw new RangeError(
        'Samara blade strip is invalid. Provide finite angles and radii with end above start and positive area.',
      );
    const sinPitch = sin(pitch);
    const cosPitch = cos(pitch);
    const sinAzimuth = sin(azimuth);
    const cosAzimuth = cos(azimuth);
    for (let j = 0; j < GAUSS_POSITIONS.length; j++) {
      nodes.push(
        start + half * (1 + GAUSS_POSITIONS[j]!),
        area * GAUSS_WEIGHTS[j]!,
        sinPitch,
        cosPitch,
        sinAzimuth,
        cosAzimuth,
      );
    }
  }
  return nodes;
}

export function prepareFalling(body: FallingBody, gravity: Vector, sectionStart: number) {
  if (body?.kind !== 'plate' && body?.kind !== 'sphere' && body?.kind !== 'samara')
    throw new TypeError('Unknown falling body form. Set kind to plate, sphere or samara.');
  const mass = scalar(body.mass, 'Falling body mass');
  const up: Vector = gravity.some((value) => value !== 0) ? [-gravity[0], -gravity[1], -gravity[2]] : [0, 1, 0];
  const axis =
    body.kind === 'plate' ? (body.spanDirection ?? Z_AXIS) : body.kind === 'samara' ? (body.axis ?? up) : Z_AXIS;
  const frame = frameFor(axis);
  const parameters = [dot(gravity, frame.x), dot(gravity, frame.y), dot(gravity, frame.z), mass];
  const p = vector(body.position ?? ZERO, 'Falling body position');
  const v = vector(body.velocity ?? ZERO, 'Falling body velocity');
  let sphere: FallingSphereSetup | undefined;
  let sections: number[] = [];
  let angle = 0;
  let omega = 0;
  if (body.kind === 'sphere') {
    const radius = scalar(body.diameter, 'Sphere diameter') / 2;
    const area = Math.PI * radius * radius;
    const drag = body.drag ?? 0.47;
    const coefficient = typeof drag === 'function' ? 0 : scalar(drag, 'Sphere drag', true);
    const restitution = scalar(body.restitution ?? 0, 'Sphere restitution', true);
    if (!(radius > 0 && area > 0 && restitution <= 1))
      throw new RangeError(
        'Sphere shape or restitution exceeds its domain. Use a representable diameter and restitution in [0, 1].',
      );
    sphere = { radius, area, restitution, drag };
    parameters.push((4 * area * radius) / 3, area * coefficient, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0);
  } else if (body.kind === 'plate') {
    const a = scalar(body.chord, 'Plate chord') / 2;
    const b = scalar(body.thickness ?? 0, 'Plate thickness', true) / 2;
    const span = scalar(body.span ?? body.chord, 'Plate span');
    const inertia = scalar(body.pitchInertia ?? (mass * (a * a + b * b)) / 4, 'Plate pitch inertia');
    if (!(a > 0 && b <= a))
      throw new RangeError(
        'Plate cross section exceeds its domain. Use positive chord and thickness no larger than the chord.',
      );
    const edgeDrag = scalar(body.edgeDrag ?? 0.4, 'Plate edge drag', true);
    const crossSection = Math.PI * a * b;
    parameters.push(
      crossSection * span,
      crossSection * scalar(body.spanDrag ?? edgeDrag, 'Plate span drag', true),
      a,
      b,
      span,
      inertia,
      scalar(body.translationalLift ?? 1.2, 'Plate translational lift', true),
      scalar(body.rotationalLift ?? Math.PI, 'Plate rotational lift', true),
      edgeDrag,
      scalar(body.faceDrag ?? 2.4, 'Plate face drag', true),
      scalar(body.spinDragLinear ?? 0.2, 'Plate linear pitch damping', true),
      scalar(body.spinDragQuadratic ?? 0.2, 'Plate quadratic pitch damping', true),
    );
    angle = body.angle ?? 0;
    omega = body.angularVelocity ?? 0;
  } else {
    if (body.inducedDrag !== undefined && typeof body.inducedDrag !== 'boolean')
      throw new TypeError('Invalid samara pressure drag setting. Set inducedDrag to true or false.');
    sections = bladeNodes(body.sections);
    parameters.push(
      scalar(body.volume ?? 0, 'Samara volume', true),
      0,
      0,
      0,
      0,
      scalar(body.spinInertia, 'Samara spin inertia'),
      0,
      0,
      0,
      0,
      0,
      0,
      sectionStart,
      sections.length / SECTION_WORDS,
      scalar(body.potentialLift ?? 3.57, 'Samara potential lift', true),
      scalar(body.vortexLift ?? 2.57, 'Samara vortex lift', true),
      scalar(body.profileDrag ?? 0.07, 'Samara profile drag', true),
      Number(body.inducedDrag ?? true),
    );
    angle = body.angle ?? 0;
    omega = body.angularVelocity ?? 0;
  }
  while (parameters.length < MODEL_WORDS) parameters.push(0);
  const initial = [
    dot(p, frame.x),
    dot(p, frame.y),
    dot(v, frame.x),
    dot(v, frame.y),
    angle % TURN,
    omega,
    dot(p, frame.z),
    dot(v, frame.z),
  ];
  if (!parameters.every(Number.isFinite) || !initial.every(Number.isFinite))
    throw new RangeError('Falling body geometry or state overflows. Use finite, representable SI inputs.');
  return { parameters, initial, frame, sphere, sections };
}

export function indexError(index: number): MargoError {
  return new MargoError(
    'failed',
    'Falling body ' +
      index +
      ' exceeded finite integration precision. Check its mass, dimensions, flow and initial speed.',
  );
}
