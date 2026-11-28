// Hydraulic machines for the hydraulics entry (HYDRO-07): the Pelton impulse runner and the hinged bellows. Clean room:
// - L. A. Pelton, US patent 233,692 (1880), and the impulse-turbine momentum analysis in F. M. White, "Fluid Mechanics",
//   7th ed. (2011), section 11.6, and S. L. Dixon and C. A. Hall, "Fluid Mechanics and Thermodynamics of
//   Turbomachinery", 7th ed., Butterworth-Heinemann (2014), chapter 10 (bucket speed ratio, relative-speed retention k
//   and the bucket exit angle);
// - for the bellows, the volume swept by straight leather sides between two hinged boards, integrated exactly over the
//   board outline (the shoelace sums give the outline's area and its first moment about the hinge).
import { cos, sin } from '@margoengine/math/pinned';
import { circleArea, finite, GRAVITY, type Liquid, nonNegative, positive, WATER } from './fluid.js';

const TAU = 2 * Math.PI;

/** A Pelton wheel fed by one nozzle under a net head. */
export interface PeltonInput {
  /** Net head at the nozzle, m. */
  readonly netHead: number;
  /** Nozzle (jet) diameter, m. */
  readonly nozzleDiameter: number;
  /** Pitch-circle radius where the jet strikes the buckets, m. */
  readonly pitchRadius: number;
  /** Nozzle velocity coefficient C_v, jet speed over √(2gH). Default 0.98. */
  readonly nozzleCoefficient?: number;
  /** Bucket friction: the leaving relative speed over the arriving one, k. Default 0.9. */
  readonly bucketRetention?: number;
  /** Angle between the leaving relative velocity and the reversed jet, rad. Default 15° (a 165° deflection). */
  readonly exitAngle?: number;
  /** Runner speed, rev/min. */
  readonly rpm: number;
  readonly liquid?: Liquid;
  readonly gravity?: number;
}

/** The runner's state at one speed. */
export interface PeltonRunner {
  /** Jet speed C_v √(2 g H), m/s. */
  readonly jetSpeed: number;
  /** Jet volume flow, m³/s, and mass flow, kg/s. */
  readonly flow: number;
  readonly massFlow: number;
  /** Hydraulic power ρ g Q H, W. */
  readonly hydraulicPower: number;
  readonly rpm: number;
  /** Angular speed, rad/s, and bucket speed at the pitch circle, m/s. */
  readonly omega: number;
  readonly bucketSpeed: number;
  /** Jet speed relative to the bucket as it arrives, m/s. */
  readonly relativeSpeed: number;
  /** Absolute speed of the leaving water along the jet axis (positive with the jet), m/s. */
  readonly leavingAxial: number;
  /** Speed of the leaving water across the jet, out of the bucket's side, m/s. */
  readonly leavingTransverse: number;
  /** Force on the buckets along the jet, N; torque, N m; shaft power before mechanical losses, W. */
  readonly force: number;
  readonly torque: number;
  readonly power: number;
  /** power / hydraulicPower. */
  readonly efficiency: number;
  /** The speed of best efficiency (bucket at half the jet speed) and the runaway speed, rev/min. */
  readonly optimumRpm: number;
  readonly runawayRpm: number;
}

/**
 * Momentum through a Pelton bucket: the jet arrives at w₁ = V - u relative to a bucket moving at u and leaves at
 * k w₁, turned back by 180° minus the exit angle β. The force on the buckets is F = ρ Q (V - u)(1 + k cos β) and the
 * efficiency 2 C_v² (u/V)(1 - u/V)(1 + k cos β), highest at u = V/2.
 */
export function peltonRunner(input: PeltonInput): PeltonRunner {
  const liquid = input.liquid ?? WATER,
    g = positive('gravity', input.gravity ?? GRAVITY),
    head = positive('netHead', input.netHead),
    radius = positive('pitchRadius', input.pitchRadius),
    cv = positive('nozzleCoefficient', input.nozzleCoefficient ?? 0.98),
    k = nonNegative('bucketRetention', input.bucketRetention ?? 0.9),
    beta = finite('exitAngle', input.exitAngle ?? (15 * Math.PI) / 180),
    rpm = finite('rpm', input.rpm);
  const jetSpeed = cv * Math.sqrt(2 * g * head),
    flow = circleArea(positive('nozzleDiameter', input.nozzleDiameter)) * jetSpeed,
    massFlow = liquid.density * flow,
    hydraulicPower = massFlow * g * head,
    omega = (rpm * TAU) / 60,
    bucketSpeed = radius * omega,
    relativeSpeed = jetSpeed - bucketSpeed,
    leaving = k * relativeSpeed,
    leavingAxial = bucketSpeed - leaving * cos(beta),
    force = massFlow * (jetSpeed - leavingAxial),
    torque = radius * force,
    power = torque * omega;
  return {
    jetSpeed,
    flow,
    massFlow,
    hydraulicPower,
    rpm,
    omega,
    bucketSpeed,
    relativeSpeed,
    leavingAxial,
    leavingTransverse: leaving * sin(beta),
    force,
    torque,
    power,
    efficiency: power / hydraulicPower,
    optimumRpm: (30 * jetSpeed) / (TAU * radius),
    runawayRpm: (60 * jetSpeed) / (TAU * radius),
  };
}

/** Two boards hinged along a line, closed by straight leather sides: a hand or forge bellows. */
export interface BellowsInput {
  /**
   * The board outline in its own plane as [x, z] points, x measured from the hinge line (x = 0) and z along it.
   * Either winding; at least three points.
   */
  readonly outline: ArrayLike<readonly [number, number]>;
  /** Clear gap between the boards at the hinge, m. Default 0. */
  readonly gap?: number;
}

/** Air flows through a bellows' two check valves at one instant. */
export interface BellowsFlow {
  /** Volume between the boards, m³. */
  readonly volume: number;
  /** Rate of change of the volume, m³/s. */
  readonly rate: number;
  /** Flow in through the intake flap (opening), m³/s, and out of the nozzle (closing), m³/s. */
  readonly intake: number;
  readonly outlet: number;
}

/** A hinged bellows: its volume and valve flows as functions of the opening angle. */
export interface Bellows {
  /** Outline area, m², and its first moment about the hinge, m³. */
  readonly area: number;
  readonly firstMoment: number;
  readonly gap: number;
  /** Volume at opening angle θ, rad: A g (1 + cos θ)/2 + M sin θ. */
  volume(angle: number): number;
  /** Displacement at angle θ opening at θ' rad/s: (M cos θ - A g sin θ / 2) θ'. */
  rate(angle: number, angularSpeed: number): number;
  /** Volume, rate and the flow through each ideal check valve (no leakage, no air compressibility). */
  flow(angle: number, angularSpeed: number): BellowsFlow;
}

/**
 * The volume between a fixed board and one rotated by θ about the hinge, joined by straight sides from each outline
 * point to its rotated twin: integrating the ruled map exactly gives V(θ) = A g (1 + cos θ) / 2 + M sin θ.
 */
export function hingedBellows(input: BellowsInput): Bellows {
  const outline = input.outline,
    gap = nonNegative('gap', input.gap ?? 0);
  if (!outline || outline.length < 3) throw new RangeError('A bellows outline needs at least three [x, z] points.');
  let twiceArea = 0,
    sixMoment = 0;
  for (let i = 0; i < outline.length; i++) {
    const [x, z] = outline[i]!,
      [a, b] = outline[(i + 1) % outline.length]!;
    finite('outline x', x);
    finite('outline z', z);
    const cross = x * b - a * z;
    twiceArea += cross;
    sixMoment += (x + a) * cross;
  }
  const area = Math.abs(twiceArea / 2),
    firstMoment = Math.abs(sixMoment / 6);
  if (!(area > 0)) throw new RangeError('A bellows outline must enclose an area.');
  const volume = (angle: number): number => (area * gap * (1 + cos(angle))) / 2 + firstMoment * sin(angle);
  const rate = (angle: number, angularSpeed: number): number =>
    (firstMoment * cos(angle) - (area * gap * sin(angle)) / 2) * finite('angularSpeed', angularSpeed);
  return {
    area,
    firstMoment,
    gap,
    volume,
    rate,
    flow(angle, angularSpeed) {
      const r = rate(angle, angularSpeed);
      return { volume: volume(angle), rate: r, intake: Math.max(0, r), outlet: Math.max(0, -r) };
    },
  };
}
