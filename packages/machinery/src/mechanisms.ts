// Closed-form poses of classic mechanisms: the exact solution a physics-joint model of each mechanism tracks, and the number a
// readout shows. Every function is pure, takes angles in radians and lengths in metres, and returns plain numbers and arrays.
//
// Sources (clean room, from the texts, no code read):
// - F. Reuleaux, "The Kinematics of Machinery" (Theoretische Kinematik), 1876: the constant-width triangle in a square, pairs and
//   chains, the Oldham coupling and the Sarrus straight-line motion as kinematic chains.
// - R. Willis, "Principles of Mechanism", 1841: trains of wheels and the epicyclic (Willis) relation for sun, planet, ring and arm.
// - J. J. Uicker, G. R. Pennock and J. E. Shigley, "Theory of Machines and Mechanisms", 5th ed., 2017: loop-closure equations,
//   the Scotch yoke, the toggle and its mechanical advantage, the Geneva wheel, the bevel-gear differential.
// - J. H. Bickford, "Mechanisms for Intermittent Motion", 1972: the external Geneva drive, its crank radius and engaged arc.
// - C. W. Musser, "Strain Wave Gearing", US patent 2,906,143, 1959: the harmonic drive and its tooth-difference ratio.
// - J. C. Maxwell, "On Governors", Proc. Royal Society 16, 1868: the conical-pendulum governor and its equilibrium.
// - W. Thomson (Kelvin), "An Integrating Machine", Proc. Royal Society 24, 1876: the disk-ball integrator.
// - C. E. Shannon, "Communication in the Presence of Noise", Proc. IRE 37, 1949, and H. E. Edgerton, "Stroboscopic and slow-motion
//   moving pictures by means of intermittent light", J. SMPE 18, 1932: sampling, aliasing and the stroboscope's apparent speed.
// - C. Rorres, "The Turn of the Screw: Optimal Design of an Archimedes Screw", J. Hydraulic Engineering 126, 2000: the buckets of
//   water between the blades of an inclined screw.
const TAU = Math.PI * 2;
type V2 = [number, number];
type V3 = [number, number, number];

const positive = (value: number, label: string): number => {
  if (!(value > 0 && Number.isFinite(value))) throw new RangeError(`${label} must be a positive finite number; got ${value}.`);
  return value;
};
const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number; got ${value}.`);
  return value;
};
const teethCount = (value: number, label: string): number => {
  if (!(Number.isInteger(value) && value > 0)) throw new RangeError(`${label} must be a whole number of teeth; got ${value}.`);
  return value;
};
const clamp1 = (v: number): number => Math.min(1, Math.max(-1, v));

// ---------------------------------------------------------------------------------------------------------------------------------
// Geneva drive

/** Options of {@link genevaPose}. */
export interface GenevaOptions {
  /** Slots in the wheel, 3 or more (default 4). */
  slots?: number;
  /** Distance between the crank's and the wheel's centres in metres (default 1). */
  centerDistance?: number;
}

/** Pose of an external Geneva drive, from {@link genevaPose}. */
export interface GenevaPose {
  /** The wheel's angle in radians, turning the other way from the crank: 0 at crank -pi (before the first stroke), one slot pitch less each crank turn. */
  wheel: number;
  /** True while the pin is in a slot (the wheel moves); false while the locking disc holds it. */
  indexing: boolean;
  /** Whole indexing steps done since crank angle 0 (negative when turned backwards). */
  step: number;
  /** The wheel's speed per unit crank speed (0 while it dwells, largest at mid-stroke). */
  velocityRatio: number;
  /** The pin centre, in a frame at the crank centre with +x toward the wheel centre. */
  pin: V2;
  /** Distance of the pin from its slot's centre line, 0 when the loop closes (only meaningful while indexing). */
  residual: number;
}

/** Crank radius of an external Geneva drive whose pin enters the slots tangentially: `c sin(pi / n)` (Bickford 1972). */
export function genevaCrankRadius(slots = 4, centerDistance = 1): number {
  if (!(Number.isInteger(slots) && slots >= 3)) throw new RangeError(`A Geneva wheel has 3 slots or more; got ${slots}.`);
  return positive(centerDistance, 'Centre distance') * Math.sin(Math.PI / slots);
}

/**
 * The exact pose of an external Geneva drive at crank angle `crank` (radians, unbounded, 0 with the pin on the line of centres at
 * mid-stroke of the first step). The pin is in a slot while the crank is within `pi/2 - pi/n` of the line of centres, and there the
 * wheel follows `atan2(r sin t, c - r cos t)` (Uicker, Pennock and Shigley; Bickford 1972); between strokes it dwells.
 */
export function genevaPose(crank: number, options: GenevaOptions = {}): GenevaPose {
  const n = options.slots ?? 4,
    c = options.centerDistance ?? 1,
    r = genevaCrankRadius(n, c);
  finite(crank, 'Crank angle');
  const pitch = TAU / n,
    half = Math.PI / n,
    engaged = Math.PI / 2 - half,
    cycle = Math.round(crank / TAU),
    local = crank - cycle * TAU,
    pin: V2 = [r * Math.cos(crank), r * Math.sin(crank)];
  let phi: number, ratio: number, indexing: boolean;
  if (local > engaged) [phi, ratio, indexing] = [half, 0, false];
  else if (local < -engaged) [phi, ratio, indexing] = [-half, 0, false];
  else {
    const cos = Math.cos(local);
    phi = Math.atan2(r * Math.sin(local), c - r * cos);
    ratio = (r * (c * cos - r)) / (c * c - 2 * c * r * cos + r * r);
    indexing = true;
  }
  // The slot the pin is in points from the wheel centre at angle pi - phi; the pin's distance from that line.
  const dx = pin[0] - c,
    dy = pin[1],
    residual = indexing ? Math.abs(dx * Math.sin(Math.PI - phi) - dy * Math.cos(Math.PI - phi)) : 0;
  const total = cycle * pitch + phi + half;
  return { wheel: -total, indexing, step: Math.floor(total / pitch + 1e-9), velocityRatio: -ratio, pin, residual };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Scotch yoke

/** Pose of a Scotch yoke, from {@link scotchYokePose}. */
export interface ScotchYokePose {
  /** The pin centre relative to the crank centre. */
  pin: V2;
  /** The yoke's travel along its line from mid-stroke: exactly `r cos(t)`, simple harmonic motion. */
  slide: number;
  /** Where the pin sits along the slot, `r sin(t)`. */
  slot: number;
  /** The yoke's speed per unit crank speed, `-r sin(t)`. */
  velocity: number;
  /** The yoke's acceleration per unit crank speed squared, `-r cos(t)`. */
  acceleration: number;
}

/** The exact pose of a Scotch yoke at crank angle `crank` with crank radius `radius` (Uicker, Pennock and Shigley). */
export function scotchYokePose(crank: number, radius = 1): ScotchYokePose {
  finite(crank, 'Crank angle');
  positive(radius, 'Crank radius');
  const c = Math.cos(crank),
    s = Math.sin(crank);
  return { pin: [radius * c, radius * s], slide: radius * c, slot: radius * s, velocity: -radius * s, acceleration: -radius * c };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Oldham coupling

/** Pose of an Oldham coupling, from {@link oldhamPose}. */
export interface OldhamPose {
  /** The output shaft's angle: equal to the input's, the coupling has constant velocity ratio 1. */
  output: number;
  /** The middle disc's angle, also equal to the input's. */
  disc: number;
  /** The disc centre in the transverse plane, the input axis at the origin and the output axis at (offset, 0). */
  center: V2;
  /** The circle the disc centre runs on (twice per shaft turn): its centre and radius. */
  orbitCenter: V2;
  orbitRadius: number;
  /** The disc's slide along the input hub's slot and along the output hub's slot. */
  inputSlide: number;
  outputSlide: number;
  /** Distances of the disc centre from the two slot lines, both 0 when the loop closes. */
  residual: V2;
}

/**
 * The exact pose of an Oldham coupling at input angle `angle` with the shafts `offset` apart (Reuleaux 1876). The disc's tongues are
 * at right angles, so its centre is the foot of the perpendicular from the output axis onto the input slot: `d cos(t) (cos t, sin t)`.
 */
export function oldhamPose(angle: number, offset: number): OldhamPose {
  finite(angle, 'Input angle');
  if (!(offset >= 0 && Number.isFinite(offset))) throw new RangeError(`Shaft offset must be 0 or more; got ${offset}.`);
  const c = Math.cos(angle),
    s = Math.sin(angle),
    center: V2 = [offset * c * c, offset * c * s];
  const residual: V2 = [Math.abs(center[0] * s - center[1] * c), Math.abs((center[0] - offset) * c + center[1] * s)];
  return {
    output: angle,
    disc: angle,
    center,
    orbitCenter: [offset / 2, 0],
    orbitRadius: offset / 2,
    inputSlide: offset * c,
    outputSlide: offset * s,
    residual,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Sarrus linkage

/** Pose of a Sarrus linkage, from {@link sarrusPose}. */
export interface SarrusPose {
  /** The deck's height above the base hinges: `2 L sin(a)`. */
  height: number;
  /** Each knee's rise above the base and its reach out from the hinge line. */
  rise: number;
  reach: number;
  /** The knee hinge's included angle between its two links, `pi - 2a`, and each link's angle from vertical, `pi/2 - a`. */
  knee: number;
  fromVertical: number;
  /** The deck's speed per unit link speed, `2 L cos(a)`. */
  velocity: number;
  /** Error in each link's length, 0 when the loop closes. */
  residual: number;
}

/**
 * The exact pose of a Sarrus linkage whose equal links of length `link` stand at `angle` from the base (radians). Two hinged limbs in
 * planes at right angles leave the deck one freedom, straight up (Sarrus 1853, in Reuleaux 1876).
 */
export function sarrusPose(angle: number, link = 1): SarrusPose {
  finite(angle, 'Link angle');
  positive(link, 'Link length');
  const rise = link * Math.sin(angle),
    reach = link * Math.cos(angle),
    height = 2 * rise;
  const residual = Math.abs(Math.hypot(reach, height - rise) - link);
  return {
    height,
    rise,
    reach,
    knee: Math.PI - 2 * angle,
    fromVertical: Math.PI / 2 - angle,
    velocity: 2 * reach,
    residual,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Toggle press

/** Pose of a toggle press, from {@link togglePressPose}. */
export interface TogglePressPose {
  /** Each link's drop from the fixed pivot to the knee, `sqrt(L^2 - x^2)`; the ram is twice that below the pivot. */
  drop: number;
  ram: number;
  /** Each link's angle from vertical. */
  angle: number;
  /** Ram force per unit of the force pushing the knee across, `h / (2x)`: unbounded as the links straighten. */
  advantage: number;
  /** Error in each link's length, 0 when the loop closes. */
  residual: number;
}

/**
 * The exact pose of a symmetric toggle press with two links of length `link` and the knee `knee` metres off the line of the pivot and
 * the ram (Uicker, Pennock and Shigley). With the knee pushed across by P, each link carries P / (2 sin a) and the ram feels
 * P cos a / (2 sin a).
 */
export function togglePressPose(knee: number, link = 1): TogglePressPose {
  positive(link, 'Link length');
  if (!(Math.abs(knee) <= link)) throw new RangeError(`The knee offset must be within the link length ${link}; got ${knee}.`);
  const drop = Math.sqrt(link * link - knee * knee);
  return {
    drop,
    ram: 2 * drop,
    angle: Math.asin(knee / link),
    advantage: knee === 0 ? Infinity : drop / (2 * Math.abs(knee)),
    residual: Math.abs(Math.hypot(knee, drop) - link),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Reuleaux triangle in a square

/** Pose of a Reuleaux triangle turning in a square, from {@link reuleauxPose}. */
export interface ReuleauxPose {
  /** The triangle's centre relative to the square's centre (it runs on a nearly square path). */
  center: V2;
  /** The four contacts, on the square's +x, +y, -x and -y sides, relative to the square's centre. */
  contacts: [V2, V2, V2, V2];
  /** The widths across the square in x and in y, both equal to the triangle's width: it has constant width. */
  span: V2;
}

const reuleauxVertices = (width: number): V2[] => [
  [0, width / Math.sqrt(3)],
  [-width / 2, -width / (2 * Math.sqrt(3))],
  [width / 2, -width / (2 * Math.sqrt(3))],
];

/** Points around a Reuleaux triangle of `width`, its centroid at the origin, `subdivisions` points an arc (counter-clockwise). */
export function reuleauxOutline(width = 1, subdivisions = 64): V2[] {
  positive(width, 'Width');
  const vertices = reuleauxVertices(width);
  return vertices.flatMap((start, i) => {
    const origin = vertices[(i + 2) % 3],
      a = Math.atan2(start[1] - origin[1], start[0] - origin[0]);
    return Array.from({ length: subdivisions }, (_, j): V2 => {
      const t = a + (j * Math.PI) / (3 * subdivisions);
      return [origin[0] + width * Math.cos(t), origin[1] + width * Math.sin(t)];
    });
  });
}

/** The point of a Reuleaux triangle (in its own frame) farthest along `direction`: a vertex, or a point of the opposite arc. */
function reuleauxSupport(vertices: V2[], width: number, d: V2): V2 {
  let best = vertices[0],
    far = -Infinity;
  for (const v of vertices) {
    const h = v[0] * d[0] + v[1] * d[1];
    if (h > far) [best, far] = [v, h];
    // The arc centred on v reaches v + width d when that point lies on the arc (inside every vertex's circle).
    const p: V2 = [v[0] + width * d[0], v[1] + width * d[1]];
    if (vertices.every(([x, y]) => (p[0] - x) ** 2 + (p[1] - y) ** 2 <= width * width * (1 + 1e-12))) {
      const hp = p[0] * d[0] + p[1] * d[1];
      if (hp > far) [best, far] = [p, hp];
    }
  }
  return best;
}

/**
 * The exact pose of a Reuleaux triangle of `width` turned by `angle` inside a square of the same side: it touches all four sides at
 * every angle, so the centre moves to keep the +x and +y sides touching and the other two follow (Reuleaux 1876).
 */
export function reuleauxPose(angle: number, width = 1): ReuleauxPose {
  finite(angle, 'Angle');
  positive(width, 'Width');
  const vertices = reuleauxVertices(width),
    c = Math.cos(angle),
    s = Math.sin(angle);
  const extremes = ([[1, 0], [0, 1], [-1, 0], [0, -1]] as V2[]).map(([x, y]) => {
    const [px, py] = reuleauxSupport(vertices, width, [x * c + y * s, -x * s + y * c]);
    return [px * c - py * s, px * s + py * c] as V2;
  });
  const center: V2 = [width / 2 - extremes[0][0], width / 2 - extremes[1][1]];
  const contacts = extremes.map(([x, y]): V2 => [x + center[0], y + center[1]]) as [V2, V2, V2, V2];
  return { center, contacts, span: [contacts[0][0] - contacts[2][0], contacts[1][1] - contacts[3][1]] };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Rose engine

/** A rosette: a cam whose radius swings `amplitude` metres `lobes` times a turn, with an optional second harmonic `overtone`. */
export interface Rosette {
  lobes: number;
  amplitude: number;
  overtone?: number;
}

/** Pose of a rose engine, from {@link roseEnginePose}. */
export interface RoseEnginePose {
  /** The spindle's rock (its shift off its rest line) as the rosette rides the rubber, metres. */
  shift: number;
  /** Where the work turns under the fixed tool: the angle in the work's frame. */
  contact: number;
  /** The point the tool cuts, in the work's frame. */
  cut: V2;
  /** The spindle angle over which the pattern repeats, `2 pi / lobes`. */
  period: number;
}

/** The rosette's radial swing at `angle`: `a cos(n t) + b cos(2 n t)`. */
export function rosetteModulation(rosette: Rosette, angle: number): number {
  const { lobes, amplitude, overtone = 0 } = rosette;
  return amplitude * Math.cos(lobes * angle) + overtone * Math.cos(2 * lobes * angle);
}

/**
 * The exact pose of a rose engine at spindle angle `angle`: the rosette pushes the rocking headstock against the rubber, so the
 * fixed tool at `toolRadius` cuts the path `(R + m(t)) (cos t, sin t)` in the work's frame, `t = -angle`.
 */
export function roseEnginePose(angle: number, rosette: Rosette, toolRadius = 1): RoseEnginePose {
  finite(angle, 'Spindle angle');
  teethCount(rosette.lobes, 'Rosette lobes');
  const contact = -angle,
    modulation = rosetteModulation(rosette, contact),
    radius = toolRadius + modulation;
  return {
    shift: -modulation,
    contact,
    cut: [radius * Math.cos(contact), radius * Math.sin(contact)],
    period: TAU / rosette.lobes,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Archimedes screw

/** An inclined single-start Archimedes screw, for {@link archimedesScrew}. */
export interface ArchimedesScrewSpec {
  /** Axial length of one blade turn, metres. */
  pitch: number;
  /** Inner radius of the casing and the blade's outer edge, metres. */
  outerRadius: number;
  /** Radius of the central shaft, metres. */
  innerRadius: number;
  /** The axis's angle above horizontal, radians (less than the angle at which buckets vanish). */
  incline: number;
  /** Axial length of the flighted part, metres (default one pitch). */
  length?: number;
}

/** One wet slice of a bucket between blades, from {@link ArchimedesScrew.wetSection}. */
export interface WetSection {
  /** Axial start of the slice and the water's depth along the axis there. */
  start: number;
  depth: number;
  /** The water line's radius where the slice starts and how fast it grows along the axis. */
  inner: number;
  growth: number;
}

/** An Archimedes screw's water and lift, from {@link archimedesScrew}. */
export interface ArchimedesScrew {
  readonly spec: Required<ArchimedesScrewSpec>;
  /** Axial advance a radian, `pitch / 2 pi`. */
  readonly lead: number;
  /** Height the water climbs a turn and over the whole flight. */
  readonly risePerTurn: number;
  readonly lift: number;
  /** Height of the still water line in a bucket, relative to the shaft axis at the bucket's start. */
  readonly fillLevel: number;
  /** Volume of one bucket, cubic metres: the water carried a turn. */
  readonly volumePerTurn: number;
  /** The wet slice at blade angle `theta`, or null where that part of the turn holds no water. */
  wetSection(theta: number): WetSection | null;
  /** Flow in cubic metres a second and axial water speed in metres a second at `rpm`. */
  flow(rpm: number): { volumePerSecond: number; axialSpeed: number };
}

/**
 * The buckets of an inclined Archimedes screw (Rorres 2000): water sits between blade turns below the shaft, up to the level where it
 * would spill over the blade toward the shaft; the bucket's volume, integrated in slices around the turn, is the water lifted a turn.
 */
export function archimedesScrew(spec: ArchimedesScrewSpec, slices = 1600): ArchimedesScrew {
  const pitch = positive(spec.pitch, 'Pitch'),
    outer = positive(spec.outerRadius, 'Outer radius'),
    inner = positive(spec.innerRadius, 'Inner radius'),
    incline = positive(spec.incline, 'Incline'),
    length = positive(spec.length ?? pitch, 'Length');
  if (!(inner < outer)) throw new RangeError('The shaft radius must be less than the outer radius.');
  if (!(incline < Math.PI / 2)) throw new RangeError('The incline must be less than 90 degrees.');
  const vertical = Math.sin(incline),
    across = Math.cos(incline),
    lead = pitch / TAU;
  // The blade edge at the shaft, along a turn: its height above the bucket start; the water line is its lowest point in the turn.
  const shaftHeight = (theta: number): number => lead * theta * vertical + inner * across * Math.cos(theta);
  const critical = Math.PI - Math.asin(Math.min(1, (lead * vertical) / (inner * across)));
  const fillLevel = Math.min(shaftHeight(0), shaftHeight(TAU), shaftHeight(critical));
  const wetSection = (theta: number): WetSection | null => {
    const radial = Math.cos(theta) * across;
    if (radial >= 0) return null;
    const start = lead * theta,
      depth = Math.min(pitch, (fillLevel - start * vertical - outer * radial) / vertical);
    if (depth <= 0) return null;
    return { start, depth, inner: (fillLevel - start * vertical) / radial, growth: -vertical / radial };
  };
  let sum = 0;
  const delta = TAU / slices;
  for (let i = 0; i < slices; i++) {
    const section = wetSection((i + 0.5) * delta);
    if (!section) continue;
    const { depth, inner: r0, growth: g } = section;
    sum += 0.5 * (outer * outer * depth - (r0 * r0 * depth + r0 * g * depth * depth + (g * g * depth ** 3) / 3));
  }
  const volumePerTurn = sum * delta;
  return {
    spec: { pitch, outerRadius: outer, innerRadius: inner, incline, length },
    lead,
    risePerTurn: pitch * vertical,
    lift: length * vertical,
    fillLevel,
    volumePerTurn,
    wetSection,
    flow(rpm) {
      const turns = Math.max(0, finite(rpm, 'Speed')) / 60;
      return { volumePerSecond: volumePerTurn * turns, axialSpeed: pitch * turns };
    },
  };
}

/** Where the blades stand at shaft angle `angle`: the phase within the turn and how far the buckets have moved up the axis. */
export function archimedesScrewPose(angle: number, pitch: number): { phase: number; travel: number; turns: number } {
  finite(angle, 'Shaft angle');
  positive(pitch, 'Pitch');
  return { phase: ((angle % TAU) + TAU) % TAU, travel: (pitch * angle) / TAU, turns: angle / TAU };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Gimbal

const rotateAbout = (v: V3, k: V3, angle: number): V3 => {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    d = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c);
  const x: V3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  return [v[0] * c + x[0] * s + k[0] * d, v[1] * c + x[1] * s + k[1] * d, v[2] * c + x[2] * s + k[2] * d];
};
const unit3 = (v: readonly number[], label: string): V3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!(n > 0 && Number.isFinite(n))) throw new RangeError(`${label} must be a nonzero finite vector.`);
  return [v[0] / n, v[1] / n, v[2] / n];
};

/** The rotor axis a two-ring gimbal points along: `R_y(outer) R_x(inner)` applied to +z, in the frame of its mount. */
export function gimbalAxis(outer: number, inner: number): V3 {
  return [Math.sin(outer) * Math.cos(inner), -Math.sin(inner), Math.cos(outer) * Math.cos(inner)];
}

/**
 * The ring angles of a two-ring gimbal (outer about y, inner about x) that point its rotor's +z along `direction` in the mount's
 * frame: `outer = atan2(x, z)`, `inner = -asin(y)`. `lock` is the cosine of the inner angle; it reaches 0 at gimbal lock, where the
 * outer ring's angle is no longer fixed by the direction.
 */
export function gimbalAngles(direction: readonly number[]): { outer: number; inner: number; lock: number } {
  const [x, y, z] = unit3(direction, 'Direction'),
    inner = -Math.asin(clamp1(y));
  return { outer: Math.atan2(x, z), inner, lock: Math.cos(inner) };
}

/** Pose of a gimbal on a tilting mount, from {@link gimbalPose}. */
export interface GimbalPose {
  /** The mount's turn as a quaternion [x, y, z, w]. */
  mount: [number, number, number, number];
  outer: number;
  inner: number;
  /** The rotor axis achieved, in the room's frame, and its angle from `target` in radians (0 unless locked). */
  axis: V3;
  deviation: number;
}

/**
 * A two-ring gimbal on a mount turned `tilt` radians about `mountAxis`, holding its rotor along `target` in the room's frame. With
 * `locked` the rings are clamped at 0 and the rotor turns with the mount.
 */
export function gimbalPose(
  tilt: number,
  options: { mountAxis: readonly number[]; target?: readonly number[]; locked?: boolean },
): GimbalPose {
  finite(tilt, 'Tilt');
  const k = unit3(options.mountAxis, 'Mount axis'),
    target = unit3(options.target ?? [0, 0, 1], 'Target');
  const { outer, inner } = options.locked ? { outer: 0, inner: 0 } : gimbalAngles(rotateAbout(target, k, -tilt));
  const axis = rotateAbout(gimbalAxis(outer, inner), k, tilt),
    s = Math.sin(tilt / 2);
  const deviation = Math.acos(clamp1(axis[0] * target[0] + axis[1] * target[1] + axis[2] * target[2]));
  return { mount: [k[0] * s, k[1] * s, k[2] * s, Math.cos(tilt / 2)], outer, inner, axis, deviation };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Epicyclic train

/** Teeth of a simple epicyclic (planetary) train. */
export interface EpicyclicTeeth {
  sun: number;
  planet: number;
  ring: number;
}

/** Speeds (or angles) of an epicyclic train's members, from {@link epicyclicSpeeds}. */
export interface EpicyclicSpeeds {
  sun: number;
  ring: number;
  carrier: number;
  /** The planet's own speed about its pin, in the fixed frame. */
  planet: number;
}

/**
 * Solves an epicyclic train by Willis's relation (Willis 1841), `(sun - carrier) / (ring - carrier) = -ring teeth / sun teeth`: give
 * any two of `sun`, `ring` and `carrier` (speeds or angles; a held member is 0) and the third and the planet follow. The planet turns
 * `carrier - (sun - carrier) sun teeth / planet teeth`. Linear, so it holds for angles as well as speeds.
 */
export function epicyclicSpeeds(
  teeth: EpicyclicTeeth,
  known: { sun?: number; ring?: number; carrier?: number },
): EpicyclicSpeeds {
  const zs = teethCount(teeth.sun, 'Sun teeth'),
    zp = teethCount(teeth.planet, 'Planet teeth'),
    zr = teethCount(teeth.ring, 'Ring teeth');
  if (zr !== zs + 2 * zp) throw new RangeError(`The ring needs sun + 2 planet teeth (${zs + 2 * zp}) to mesh; got ${zr}.`);
  const given = (['sun', 'ring', 'carrier'] as const).filter((key) => known[key] !== undefined);
  if (given.length !== 2) throw new RangeError('Give exactly two of sun, ring and carrier.');
  for (const key of given) finite(known[key] as number, key);
  let { sun, ring, carrier } = known as Required<typeof known>;
  if (sun === undefined) sun = carrier - ((ring - carrier) * zr) / zs;
  else if (ring === undefined) ring = carrier - ((sun - carrier) * zs) / zr;
  else carrier = (sun * zs + ring * zr) / (zs + zr);
  return { sun, ring, carrier, planet: carrier - ((sun - carrier) * zs) / zp };
}

/** Whether `planets` equally spaced planets fit: `(sun + ring) / planets` is whole (Willis 1841; Uicker, Pennock and Shigley). */
export function epicyclicAssembles(teeth: EpicyclicTeeth, planets: number): boolean {
  return Number.isInteger((teeth.sun + teeth.ring) / planets);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Differential

/** Options of {@link differentialSpeeds}. */
export interface DifferentialOptions {
  /** Half the distance between the wheels, metres. */
  halfTrack: number;
  /** Turn curvature, 1 / radius in 1/m; a positive curvature speeds the left wheel and slows the right. */
  curvature: number;
  /** Teeth of the side gears and of the spider pinions (default 1 and 1). */
  sideTeeth?: number;
  pinionTeeth?: number;
}

/**
 * Speeds of an open bevel-gear differential driven at `carrier` (Uicker, Pennock and Shigley): the side gears average to the carrier,
 * `left + right = 2 carrier`, and on a turn of curvature k the wheels part by `carrier h k` each way. The spiders turn on their pins at
 * the side gears' difference from the carrier times sideTeeth / pinionTeeth. Positive curvature speeds the left wheel.
 */
export function differentialSpeeds(
  carrier: number,
  options: DifferentialOptions,
): { left: number; right: number; spider: number; offset: number } {
  finite(carrier, 'Carrier speed');
  const h = positive(options.halfTrack, 'Half track'),
    k = finite(options.curvature, 'Curvature'),
    zs = teethCount(options.sideTeeth ?? 1, 'Side teeth'),
    zp = teethCount(options.pinionTeeth ?? 1, 'Pinion teeth');
  const offset = carrier * h * k;
  return { left: carrier + offset, right: carrier - offset, spider: (offset * zs) / zp, offset };
}

/** Angles of a differential's carrier, sides and spiders when the left side has run `sideOffset` ahead of the carrier. */
export function differentialPose(
  carrier: number,
  sideOffset: number,
  teeth: { side: number; pinion: number; phase?: number },
): { carrier: number; left: number; right: number; pinion: number } {
  const zs = teethCount(teeth.side, 'Side teeth'),
    zp = teethCount(teeth.pinion, 'Pinion teeth');
  return {
    carrier,
    left: carrier + sideOffset,
    right: carrier - sideOffset,
    pinion: (sideOffset * zs + (teeth.phase ?? 0)) / zp,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Harmonic drive

/** A harmonic drive's tooth counts and which spline is held. */
export interface HarmonicDriveSpec {
  /** Teeth of the flexspline and of the circular spline (2 more for a two-lobe wave generator). */
  flexTeeth: number;
  circularTeeth: number;
  /** The member held still (default 'circular': the flexspline is the output). */
  fixed?: 'circular' | 'flex';
}

/**
 * The speed ratio output / wave generator of a harmonic drive (Musser 1959): with the circular spline held the flexspline turns
 * `(Zf - Zc) / Zf` (backwards for Zc > Zf); with the flexspline held the circular spline turns `(Zc - Zf) / Zc`.
 */
export function harmonicDriveRatio(spec: HarmonicDriveSpec): number {
  const zf = teethCount(spec.flexTeeth, 'Flexspline teeth'),
    zc = teethCount(spec.circularTeeth, 'Circular spline teeth');
  if (zf === zc) throw new RangeError('A harmonic drive needs a tooth difference between the splines.');
  return (spec.fixed ?? 'circular') === 'circular' ? (zf - zc) / zf : (zc - zf) / zc;
}

/** Radius of an elliptical wave generator of semi-axes `major` and `minor` at `angle` from its major axis. */
export function waveGeneratorRadius(angle: number, major: number, minor: number): number {
  return (major * minor) / Math.hypot(minor * Math.cos(angle), major * Math.sin(angle));
}

/**
 * Where a flexspline point sits, for drawing the deformed spline: material at `material` (radians on the undeformed spline, which
 * has turned `output`) is pushed out to the wave generator's ellipse and, inside the two engagement zones about the major axis, takes
 * the circular spline's tooth pitch so its teeth sit in the fixed spline's gaps. `engageStart` and `engageWidth` (radians off the
 * major axis) bound the smooth hand-over between the two pitches (default 0.44 and 0.86). Returns the point's angle and its radial
 * offset from the nominal radius `(major + minor) / 2`.
 */
export function flexsplinePoint(
  material: number,
  input: number,
  output: number,
  spec: HarmonicDriveSpec & { major: number; minor: number; engageStart?: number; engageWidth?: number; strength?: number },
): { angle: number; offset: number } {
  const zf = teethCount(spec.flexTeeth, 'Flexspline teeth'),
    zc = teethCount(spec.circularTeeth, 'Circular spline teeth');
  const angle = material + output,
    delta = angle - input,
    local = delta - Math.PI * Math.round(delta / Math.PI);
  const start = spec.engageStart ?? 0.44,
    width = spec.engageWidth ?? 0.86,
    blend = Math.min(1, Math.max(0, (Math.abs(local) - start) / width)),
    taper = 1 - blend * blend * (3 - 2 * blend);
  const pitched = angle - (spec.strength ?? 1) * taper * local * (1 - zf / zc);
  return { angle: pitched, offset: waveGeneratorRadius(pitched - input, spec.major, spec.minor) - (spec.major + spec.minor) / 2 };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Ball-and-disk integrator

/** A ball-and-disk (Kelvin) integrator, from {@link ballDiskIntegrator}. */
export interface BallDiskIntegrator {
  /** Output turns a disk turn with the ball at `radius` from the disk centre: `radius / wheelRadius`. */
  ratio(radius: number): number;
  /** Turns the disk `diskTurns` while the ball moves linearly from `radiusStart` to `radiusEnd`; returns the output turns added. */
  advance(diskTurns: number, radiusStart: number, radiusEnd?: number): number;
  /** Disk and output turns so far. */
  readonly diskTurns: number;
  readonly outputTurns: number;
  /** Sets the output count back to 0. */
  reset(): void;
}

/**
 * A ball-and-disk integrator (Thomson 1876): the output roller turns `r / rho` for each disk turn with the ball `r` from the disk's
 * centre, so its turns are the integral of r over the disk's turns. `advance` is exact for a ball moving linearly during the step.
 */
export function ballDiskIntegrator(options: { wheelRadius: number; diskRadius?: number }): BallDiskIntegrator {
  const rho = positive(options.wheelRadius, 'Wheel radius'),
    limit = options.diskRadius === undefined ? Infinity : positive(options.diskRadius, 'Disk radius');
  const check = (r: number): number => {
    if (!(Math.abs(r) <= limit)) throw new RangeError(`The ball must stay on the disk (|r| <= ${limit}); got ${r}.`);
    return r;
  };
  let disk = 0,
    output = 0;
  return {
    ratio: (radius) => check(radius) / rho,
    advance(diskTurns, radiusStart, radiusEnd = radiusStart) {
      finite(diskTurns, 'Disk turns');
      const added = (diskTurns * (check(radiusStart) + check(radiusEnd))) / (2 * rho);
      disk += diskTurns;
      output += added;
      return added;
    },
    get diskTurns() {
      return disk;
    },
    get outputTurns() {
      return output;
    },
    reset() {
      output = 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Watt governor

/** A Watt governor's arms and linkage, for {@link wattGovernorEquilibrium}. */
export interface WattGovernorSpec {
  /** Length from the top pivot to a ball's centre, metres. */
  arm: number;
  /** Distance down the arm to the link's joint, and the link's length to the sleeve (defaults: no linkage, sleeve not solved). */
  pickoff?: number;
  link?: number;
  /** Gravity, m/s^2 (default 9.80665). */
  gravity?: number;
}

/** Equilibrium of a Watt governor, from {@link wattGovernorEquilibrium}. */
export interface WattGovernorEquilibrium {
  /** The arms' angle from the spindle (0 below the lift-off speed). */
  angle: number;
  /** The conical pendulum's height `g / w^2` (capped at the arm length), and each ball's distance out and drop below the pivot. */
  height: number;
  radius: number;
  drop: number;
  /** The lowest speed at which the balls lift, `sqrt(g / L)` rad/s. */
  liftOff: number;
  /** The joint on the arm (out and down from the pivot) and the sleeve's drop below the pivot, when the linkage is given. */
  joint?: V2;
  sleeve?: number;
  /** Error in Maxwell's balance `w^2 L cos(a) - g` per unit g, 0 at equilibrium. */
  residual: number;
}

/**
 * The equilibrium of a Watt governor spinning at `omega` rad/s (Maxwell 1868): each ball is a conical pendulum, so
 * `w^2 L cos(a) = g` and the height of the cone is `g / w^2`, whatever the balls' mass. Below `sqrt(g / L)` the arms hang straight.
 */
export function wattGovernorEquilibrium(omega: number, spec: WattGovernorSpec): WattGovernorEquilibrium {
  if (!(omega >= 0 && Number.isFinite(omega))) throw new RangeError(`Spin speed must be 0 or more rad/s; got ${omega}.`);
  const L = positive(spec.arm, 'Arm length'),
    g = positive(spec.gravity ?? 9.80665, 'Gravity'),
    height = omega > 0 ? Math.min(L, g / (omega * omega)) : L,
    angle = Math.acos(height / L),
    sin = Math.sin(angle),
    cos = Math.cos(angle);
  const out: WattGovernorEquilibrium = {
    angle,
    height,
    radius: L * sin,
    drop: L * cos,
    liftOff: Math.sqrt(g / L),
    residual: angle > 0 ? (omega * omega * L * cos - g) / g : 0,
  };
  if (spec.pickoff !== undefined && spec.link !== undefined) {
    const p = positive(spec.pickoff, 'Pickoff'),
      l = positive(spec.link, 'Link length'),
      joint: V2 = [p * sin, p * cos];
    if (!(joint[0] <= l)) throw new RangeError('The link is too short to reach the spindle at this speed.');
    out.joint = joint;
    out.sleeve = joint[1] + Math.sqrt(l * l - joint[0] * joint[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Stroboscope

/**
 * The speed a rotor seems to turn at under a strobe flashing `flashRate` times a second (Shannon 1949; Edgerton 1932): a pattern
 * repeating `symmetry` times a turn passes `rpm symmetry / 60` features a second, and the eye sees that rate folded to the nearest
 * multiple of the flash rate. Returns apparent rpm (negative turns backwards, 0 frozen).
 */
export function stroboscopicRate(rpm: number, flashRate: number, symmetry = 1): number {
  finite(rpm, 'Speed');
  positive(flashRate, 'Flash rate');
  teethCount(symmetry, 'Symmetry');
  const features = (rpm * symmetry) / 60,
    observed = ((features - Math.round(features / flashRate) * flashRate) * 60) / symmetry;
  return Math.abs(observed) < 1e-10 ? 0 : observed;
}

/** The rotor's true angle and the angle a strobe shows at time `elapsed` seconds, and the flash index. */
export function stroboscopicPose(
  elapsed: number,
  rpm: number,
  flashRate: number,
): { reference: number; sampled: number; flash: number } {
  finite(elapsed, 'Time');
  positive(flashRate, 'Flash rate');
  const turnsPerSecond = finite(rpm, 'Speed') / 60,
    flash = Math.floor(elapsed * flashRate + 1e-10);
  const wrap = (turns: number): number => (((turns % 1) + 1) % 1) * TAU;
  return { reference: wrap(elapsed * turnsPerSecond), sampled: wrap((flash * turnsPerSecond) / flashRate), flash };
}
