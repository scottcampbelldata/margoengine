import type { FlowSample } from '@margoengine/math/fields';
import { cos, hypot, ln, pow, sin } from '@margoengine/math/pinned';
import type { HullMesh, Quat, Vec3 } from '../seakeeping/wetted.js';
import { type CapsuleDimensions, GAUSS_16 } from './capsule.js';
import { meshProjectedArea, projectedAboveWater, type EmergedSilhouette } from './compact-silhouette.js';
import { invalidLoad } from './errors.js';
import { sphereDrag } from './morison.js';
import { ellipsoidAlphas } from './shapes.js';

type Frame = readonly [Vec3, Vec3, Vec3];

export interface CompactDragGeometry {
  readonly axes: Vec3;
  readonly mesh: HullMesh | undefined;
  readonly box: boolean;
  readonly capsule: CapsuleDimensions | undefined;
  readonly diameter: number;
  readonly areas: Vec3;
  readonly surfaceArea: number;
  readonly equivalentArea: number;
  readonly sphericity: number;
  readonly pressureCoefficient: number;
  readonly spinResistance: Vec3;
  readonly spinRadiusSquared: Vec3;
}

function meshArea({ vertices, indices }: HullMesh): number {
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = 3 * indices[i]!,
      b = 3 * indices[i + 1]!,
      c = 3 * indices[i + 2]!;
    const abx = vertices[b]! - vertices[a]!,
      aby = vertices[b + 1]! - vertices[a + 1]!,
      abz = vertices[b + 2]! - vertices[a + 2]!;
    const acx = vertices[c]! - vertices[a]!,
      acy = vertices[c + 1]! - vertices[a + 1]!,
      acz = vertices[c + 2]! - vertices[a + 2]!;
    area += hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx) / 2;
  }
  return area;
}

function ellipsoidArea([a, b, c]: Vec3): number {
  if (a === b && b === c) return 4 * Math.PI * a * a;
  // Transform the unit sphere's area by the norm of the ellipsoid map's cofactor times its normal.
  // Cosine latitude is even, and the longitude integrand is symmetric on each quadrant.
  let area = 0;
  const span = Math.PI / 2;
  for (const [height, heightWeight] of GAUSS_16) {
    const radius = Math.sqrt(1 - height * height);
    for (const [node, weight] of GAUSS_16) {
      const first = (span * (1 - node)) / 2,
        second = (span * (1 + node)) / 2;
      const integrand = (angle: number) =>
        hypot(b * c * radius * cos(angle), a * c * radius * sin(angle), a * b * height);
      area += heightWeight * weight * (integrand(first) + integrand(second));
    }
  }
  return 4 * span * area;
}

/** Prepare fixed areas and resistance coefficients for a compact shape or closed hull. */
export function compactDragGeometry(
  volume: number,
  axes: Vec3,
  frame: Frame,
  mesh?: HullMesh,
  box?: Vec3,
  capsule?: CapsuleDimensions,
): CompactDragGeometry {
  const diameter = pow(volume * (6 / Math.PI), 1 / 3);
  const [a, b, c] = axes;
  let areas: Vec3 = [Math.PI * b * c, Math.PI * c * a, Math.PI * a * b];
  if (box) {
    const [x, y, z] = box;
    areas = [4 * y * z, 4 * z * x, 4 * x * y];
  } else if (mesh) {
    areas = [
      meshProjectedArea(mesh, frame[0], frame[1]),
      meshProjectedArea(mesh, frame[1], frame[2]),
      meshProjectedArea(mesh, frame[2], frame[0]),
    ];
  } else if (capsule) {
    const end = Math.PI * capsule.radius * capsule.radius;
    const broadside = end + 4 * capsule.halfHeight * capsule.radius;
    areas = [broadside, end, broadside];
  }
  const equivalentArea = (Math.PI * diameter * diameter) / 4;
  const surfaceArea = capsule
    ? 4 * Math.PI * capsule.radius * (capsule.radius + capsule.halfHeight)
    : mesh
      ? meshArea(mesh)
      : ellipsoidArea(axes);
  const sphericity = Math.min(1, (4 * equivalentArea) / surfaceArea);
  const pressureCoefficient = 0.42 * pow(10, 0.4 * pow(-ln(sphericity) / Math.LN10, 0.2));
  // Jeffery (1922), eq. 36, https://doi.org/10.1098/rspa.1922.0078. The existing Lamb integrals
  // include abc, so the numerator of the rotational tensor carries the same factor.
  const [alpha, beta, gamma] = a === b && b === c ? ([2 / 3, 2 / 3, 2 / 3] as const) : ellipsoidAlphas(axes);
  const common = (16 * Math.PI * a * b * c) / 3;
  const a2 = a * a,
    b2 = b * b,
    c2 = c * c;
  const spinResistance: Vec3 = [
    (common * (b2 + c2)) / (b2 * beta + c2 * gamma),
    (common * (c2 + a2)) / (c2 * gamma + a2 * alpha),
    (common * (a2 + b2)) / (a2 * alpha + b2 * beta),
  ];
  return {
    axes,
    mesh,
    box: box !== undefined,
    capsule,
    diameter,
    areas,
    surfaceArea,
    equivalentArea,
    sphericity,
    pressureCoefficient,
    spinResistance,
    spinRadiusSquared: [b * c, c * a, a * b],
  };
}

/** Project the emerged shape normal to the horizontal relative wind through its centre plane. */
export function emergedSilhouette(
  geometry: CompactDragGeometry,
  frameWorld: Frame,
  rotation: Quat,
  level: number,
  direction: Vec3,
): EmergedSilhouette {
  return projectedAboveWater(
    geometry.axes,
    frameWorld,
    rotation,
    geometry.mesh,
    geometry.box,
    level,
    direction,
    geometry.capsule,
  );
}

/** Effective Cd×reference area, m². An override is measured against the true supplied projection. */
export function compactDragArea(
  geometry: CompactDragGeometry,
  speed: number,
  viscosity: number,
  projection: number,
  sphere: boolean,
  override?: number,
  direction?: number | Vec3,
): number {
  if (override !== undefined) return override * projection;
  if (!(speed > 0 && projection > 0)) return 0;
  const re = (speed * geometry.diameter) / viscosity;
  if (sphere) return sphereDrag(re) * projection;
  const { equivalentArea, sphericity, pressureCoefficient, surfaceArea, areas } = geometry;
  // Hölzer and Sommerfeld (2008), https://doi.org/10.1016/j.powtec.2007.08.021,
  // reproduced with cube measurements by Khan et al. (2018), eq. 4. All terms originally
  // use the equivalent sphere's reference area. The Newton term then reduces to true area.
  // For a box, the longitudinal projection averages each face's absolute directional cosine.
  // Other shapes use Cauchy's spherical mean S/4 as a surrogate in this low-Re correction.
  let longitudinal = surfaceArea / 4;
  if (geometry.box && direction !== undefined) {
    if (typeof direction === 'number')
      longitudinal = (2 / Math.PI) * (areas[(direction + 1) % 3]! + areas[(direction + 2) % 3]!);
    else
      longitudinal =
        (2 / Math.PI) *
        (areas[0] * Math.sqrt(Math.max(0, 1 - direction[0] * direction[0])) +
          areas[1] * Math.sqrt(Math.max(0, 1 - direction[1] * direction[1])) +
          areas[2] * Math.sqrt(Math.max(0, 1 - direction[2] * direction[2])));
  }
  const inverseLongitudinalSphericity = (surfaceArea / 2 - longitudinal) / equivalentArea;
  const viscous = (8 * Math.sqrt(inverseLongitudinalSphericity) + 16 / Math.sqrt(sphericity)) / re;
  const transitional = 3 / (Math.sqrt(re) * pow(sphericity, 0.75));
  return (viscous + transitional) * equivalentArea + pressureCoefficient * projection;
}

export interface CompactWindLoad {
  readonly force: [number, number, number];
  readonly offset: Vec3;
}

/** Apply horizontal windage at the emerged projected centroid, where wind and point velocity are sampled. */
export function compactWindLoad(
  geometry: CompactDragGeometry,
  frameWorld: Frame,
  rotation: Quat,
  level: number,
  linear: Vec3,
  angular: Vec3,
  centreFromCm: Vec3,
  sampleAt: (offset: Vec3) => FlowSample,
  sphere: boolean,
  override?: number,
): CompactWindLoad | undefined {
  if (override === 0) return;
  let direction: Vec3 = [-linear[0], 0, -linear[2]];
  // Re-evaluate the silhouette when the centroid sample turns the relative wind. Four bounded
  // samples keep cost predictable when the field is discontinuous or sharply veers across the body.
  for (let i = 0; i < 4; i++) {
    const cut = emergedSilhouette(geometry, frameWorld, rotation, level, direction);
    if (cut.area === 0) return;
    const air = sampleAt(cut.offset);
    if (!(Number.isFinite(air.density) && air.density >= 0 && air.velocity.every(Number.isFinite)))
      throw invalidLoad('Invalid air field; return finite wind velocity and nonnegative density at the body.');
    if (air.density === 0) return;
    const rx = centreFromCm[0] + cut.offset[0],
      ry = centreFromCm[1] + cut.offset[1],
      rz = centreFromCm[2] + cut.offset[2];
    const x = air.velocity[0] - (linear[0] + angular[1] * rz - angular[2] * ry);
    const z = air.velocity[2] - (linear[2] + angular[0] * ry - angular[1] * rx);
    const speed = hypot(x, z);
    if (speed === 0) return;
    const prior = hypot(direction[0], direction[2]);
    const transverse =
      prior > 0 ? Math.abs((direction[0] * z - direction[2] * x) / (prior * speed)) : Math.abs(z / speed);
    if (transverse <= 1e-8 || i === 3) {
      const temperature = air.temperature;
      if (!(Number.isFinite(temperature) && temperature > 0))
        throw invalidLoad('Invalid air temperature; return a finite temperature above zero in kelvin.');
      // US Standard Atmosphere (1976), eq. 51, Sutherland dynamic viscosity divided by density.
      const viscosity = (1.458e-6 * temperature * Math.sqrt(temperature)) / ((temperature + 110.4) * air.density);
      const localAlong = (axis: Vec3) => (x * axis[0] + z * axis[2]) / speed;
      const local: Vec3 = [localAlong(frameWorld[0]), localAlong(frameWorld[1]), localAlong(frameWorld[2])];
      const area = compactDragArea(geometry, speed, viscosity, cut.fullArea, sphere, override, local);
      const factor = 0.5 * air.density * area * (cut.area / cut.fullArea) * speed;
      return { force: [factor * x, 0, factor * z], offset: cut.offset };
    }
    direction = [x, 0, z];
  }
}

// Dennis, Singh and Ingham (1980), Tables 2–3 and eqs. 50–55, doi:10.1017/S0022112080001656.
const SPIN_RE = [1, 2, 10, 20, 50, 100];
const SPIN_RATIO = [
  1 + 1 / 1200,
  1.0034,
  1.0736,
  (3.048 * 20) / (16 * Math.PI),
  (1.554 * 50) / (16 * Math.PI),
  (0.966 * 100) / (16 * Math.PI),
];

function spinCorrection(re: number): number {
  if (re <= 1) return 1 + (re * re) / 1200;
  if (re >= 100) return (6.45 * Math.sqrt(re) + 32.1) / (16 * Math.PI);
  let high = 1;
  while (re > SPIN_RE[high]!) high++;
  const low = high - 1;
  const fraction = ln(re / SPIN_RE[low]!) / ln(SPIN_RE[high]! / SPIN_RE[low]!);
  return SPIN_RATIO[low]! + fraction * (SPIN_RATIO[high]! - SPIN_RATIO[low]!);
}

/** Damping torque, N·m, about a body principal axis in the absence of ambient fluid spin. */
export function compactSpinTorque(
  geometry: CompactDragGeometry,
  axis: number,
  spin: number,
  wet: number,
  density: number,
  viscosity: number,
  scale = 1,
): number {
  if (spin === 0 || wet === 0 || scale === 0) return 0;
  // The finite-Re sphere correction uses the transverse geometric-mean radius for other shapes.
  const re = (Math.abs(spin) * geometry.spinRadiusSquared[axis]!) / viscosity;
  return -density * viscosity * wet * scale * geometry.spinResistance[axis]! * spin * spinCorrection(re);
}
