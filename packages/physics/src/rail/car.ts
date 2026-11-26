import { cos, dot, pow, sin } from '@margoengine/math/pinned';
import { checkedAdhesion, type RailAdhesion, railCreepForce, railNumber, railSlipLimit } from './contact.js';
import type { RailPoint, RailRoute, RailSample } from './track.js';

/**
 * The sprung carbody mass excludes bogies and axles. Stiffness and damping are per suspension point.
 * Each of the two bogies carries two wheelsets with a common angular speed per axle.
 */
export interface RailCarSpec {
  readonly track: RailRoute;
  readonly distance: number;
  readonly speed?: number;
  readonly mass?: number;
  readonly bogieMass?: number;
  readonly axleMass?: number;
  readonly gauge?: number;
  readonly wheelRadius?: number;
  readonly conicity?: number;
  readonly bogieSpacing?: number;
  readonly bogieWheelbase?: number;
  readonly centreHeight?: number;
  readonly primaryStiffness?: number;
  readonly primaryDamping?: number;
  readonly secondaryStiffness?: number;
  readonly secondaryDamping?: number;
  readonly contactStiffness?: number;
  readonly creepStiffness?: number;
  readonly flangeClearance?: number;
  readonly treadHalfWidth?: number;
  readonly flangeStiffness?: number;
  readonly maxDriveTorque?: number;
  readonly maxBrakeTorque?: number;
  readonly dry?: RailAdhesion;
  readonly wet?: RailAdhesion;
  readonly wetness?: number;
  readonly wetnessWord?: number;
}

/** Instrumentation for a physical wheelset and the current per-rail vertical reactions. */
export interface RailWheelset {
  readonly angle: number;
  readonly angularVelocity: number;
  readonly heave: number;
  readonly leftLoad: number;
  readonly rightLoad: number;
}

export interface RailCarState {
  readonly distance: number;
  readonly speed: number;
  readonly position: RailPoint;
  readonly forward: RailPoint;
  readonly up: RailPoint;
  readonly cant: number;
  readonly heave: number;
  readonly sway: number;
  readonly roll: number;
  readonly pitch: number;
  readonly bogieYaw: readonly [number, number];
  readonly bogieHeave: readonly [number, number];
  readonly bogieSway: readonly [number, number];
  readonly longitudinalForce: number;
  readonly lateralForce: number;
  readonly couplerForce: number;
  /** One set bit per axle with at least one unsupported wheel. */
  readonly lostSupport: number;
  readonly derailment: boolean;
  readonly wheelsets: readonly RailWheelset[];
}

interface AllSpec extends Required<Omit<RailCarSpec, 'track'>> {
  readonly track: RailRoute;
}
export interface Car extends AllSpec {
  readonly totalMass: number;
  readonly wheelInertia: number;
  readonly pitchInertia: number;
  readonly rollInertia: number;
  readonly bogieInertia: number;
  readonly restDepth: number;
  readonly restPrimary: number;
  readonly restSecondary: number;
  readonly axles: readonly number[];
}

export const CAR_WORDS = 56;
export const DISTANCE = 0,
  SPEED = 1,
  SWAY = 2,
  SWAY_SPEED = 3,
  HEIGHT = 4,
  VERTICAL_SPEED = 5;
export const ROLL = 6,
  ROLL_SPEED = 7,
  PITCH = 8,
  PITCH_SPEED = 9;
export const LONGITUDINAL = 10,
  LATERAL = 11,
  BOGIES = 12,
  BOGIE_WORDS = 6;
export const DRIVE = 24,
  BRAKE = 25,
  LOSS = 26,
  COUPLER = 27,
  DERAILED = 28,
  ROOF_REACTION = 29,
  ROOF_LATERAL = 30;
export const WHEELSETS = 32,
  AXLE_WORDS = 6;

const DRY: RailAdhesion = { friction: 0.32, highSlipRatio: 0.58, decay: 0.4, adhesionFactor: 0.86, slipFactor: 0.58 };
const WET: RailAdhesion = { friction: 0.12, highSlipRatio: 0.4, decay: 0.7, adhesionFactor: 0.52, slipFactor: 0.28 };
const positive = (value: number, description: string) => railNumber(value, description, Number.MIN_VALUE);
const blend = (a: number, b: number, t: number) => a + (b - a) * t;
const magnitude = (v: number, bound: number) => Math.sign(v) * Math.min(Math.abs(v), bound);
const signedSquare = (v: number) => Math.abs(v) * v;
const along = (p: RailPoint, a: RailPoint, x: number, b: RailPoint, y: number): RailPoint => [
  p[0] + a[0] * x + b[0] * y,
  p[1] + a[1] * x + b[1] * y,
  p[2] + a[2] * x + b[2] * y,
];

export function carOf(spec: RailCarSpec, gravity: RailPoint): Car {
  const mass = positive(spec.mass ?? 24000, 'rail carbody mass');
  const bogieMass = positive(spec.bogieMass ?? 2000, 'bogie mass');
  const axleMass = positive(spec.axleMass ?? 650, 'wheelset mass');
  const gauge = positive(spec.gauge ?? 1.435, 'distance between wheel contact centres');
  const wheelRadius = positive(spec.wheelRadius ?? 0.35, 'wheel tread radius');
  const bogieWheelbase = positive(spec.bogieWheelbase ?? 1.85, 'bogie wheelbase');
  const bogieSpacing = railNumber(spec.bogieSpacing ?? 6.6, 'bogie spacing', bogieWheelbase);
  const centreHeight = positive(spec.centreHeight ?? 1.05, 'carbody centre height above the rail plane');
  const contactStiffness = positive(spec.contactStiffness ?? 1e8, 'wheel Hertz stiffness');
  const totalMass = mass + 2 * bogieMass + 4 * axleMass;
  const distance = railNumber(spec.distance, 'carbody initial arclength');
  const axles = [-1, 1].flatMap((bogie) => [-1, 1].map((axle) => 0.5 * (bogie * bogieSpacing + axle * bogieWheelbase)));
  const g = Math.max(0, -dot(gravity, spec.track.sample(distance).up));
  const flangeClearance = positive(spec.flangeClearance ?? 0.008, 'wheel flange clearance');
  const treadHalfWidth = railNumber(spec.treadHalfWidth ?? 0.052, 'supported tread half width', flangeClearance);
  const wetnessWord = railNumber(spec.wetnessWord ?? 0, 'relative wetness word', 0);
  if (!Number.isSafeInteger(wetnessWord)) railNumber(NaN, 'integer relative wetness word');
  const load = totalMass * g * 0.125;
  const restDepth = load > 0 ? pow(load / contactStiffness, 2 / 3) : 0; // float division: static Hertz preload ratio
  return {
    track: spec.track,
    distance,
    mass,
    bogieMass,
    axleMass,
    gauge,
    wheelRadius,
    bogieWheelbase,
    bogieSpacing,
    centreHeight,
    speed: railNumber(spec.speed ?? 0, 'initial rail speed'),
    conicity: railNumber(spec.conicity ?? 0.045, 'equivalent conicity', 0, 0.5),
    primaryStiffness: positive(spec.primaryStiffness ?? 7.5e5, 'primary spring stiffness'),
    primaryDamping: railNumber(spec.primaryDamping ?? 9000, 'primary damping', 0),
    secondaryStiffness: positive(spec.secondaryStiffness ?? 1.9e5, 'secondary spring stiffness'),
    secondaryDamping: railNumber(spec.secondaryDamping ?? 16500, 'secondary damping', 0),
    contactStiffness,
    creepStiffness: positive(spec.creepStiffness ?? 600000, 'wheel creep stiffness'),
    flangeStiffness: positive(spec.flangeStiffness ?? 3e6, 'flange stiffness'),
    flangeClearance,
    treadHalfWidth,
    maxDriveTorque: railNumber(spec.maxDriveTorque ?? 1600, 'drive torque limit', 0),
    maxBrakeTorque: railNumber(spec.maxBrakeTorque ?? 2200, 'wheel brake torque limit', 0),
    dry: checkedAdhesion(spec.dry ?? DRY),
    wet: checkedAdhesion(spec.wet ?? WET),
    wetness: railNumber(spec.wetness ?? 0, 'initial wetness', 0, 1),
    wetnessWord,
    totalMass,
    axles,
    restDepth,
    restSecondary: 0.5 * mass * g,
    restPrimary: 0.5 * (bogieMass + 0.5 * mass) * g,
    wheelInertia: 0.5 * axleMass * wheelRadius * wheelRadius,
    pitchInertia: (mass * bogieSpacing * bogieSpacing) / 12, // float division: slender carbody estimate
    rollInertia: (mass * gauge * gauge) / 8, // float division: distributed carbody estimate
    bogieInertia: (bogieMass * bogieWheelbase * bogieWheelbase) / 6, // float division: distributed bogie estimate
  };
}

export function initCar(words: Float64Array, car: Car) {
  words[DISTANCE] = car.distance;
  words[SPEED] = car.speed;
  for (let index = 0; index < 4; index++) {
    words[WHEELSETS + index * AXLE_WORDS + 1] = car.speed / car.wheelRadius; // float division: initial pure rolling
  }
}

function adhesionAt(car: Car, wetness: number): RailAdhesion {
  const { dry, wet } = car;
  return {
    friction: blend(dry.friction, wet.friction, wetness),
    highSlipRatio: blend(dry.highSlipRatio, wet.highSlipRatio, wetness),
    decay: blend(dry.decay, wet.decay, wetness),
    adhesionFactor: blend(dry.adhesionFactor, wet.adhesionFactor, wetness),
    slipFactor: blend(dry.slipFactor, wet.slipFactor, wetness),
  };
}

const hertz = (stiffness: number, compression: number) =>
  compression > 0 ? stiffness * compression * Math.sqrt(compression) : 0;

/** Symplectic update of one sprung coordinate, including damping already present in the force. */
function integrate(w: Float64Array, index: number, force: number, mass: number, dt: number): void {
  const velocity = w[index + 1]! + (dt * force) / mass; // float division: acceleration
  w[index + 1] = velocity;
  w[index] = w[index]! + dt * velocity;
}

function resolveBogie(
  w: Float64Array,
  car: Car,
  gravity: RailPoint,
  centre: RailSample,
  adhesion: RailAdhesion,
  bogie: number,
  dt: number,
): { vertical: number; lateral: number; traction: number; contactSide: number; loss: number; unsupported: number } {
  const base = BOGIES + bogie * BOGIE_WORDS;
  const fore = (bogie * 2 - 1) * car.bogieSpacing * 0.5;
  const y = w[base]!,
    yVelocity = w[base + 1]!;
  const z = w[base + 2]!,
    zVelocity = w[base + 3]!;
  const yaw = w[base + 4]!,
    yawSpeed = w[base + 5]!;
  const speed = w[SPEED]!;
  const halfGauge = car.gauge * 0.5;
  const vertical =
    car.restSecondary +
    car.secondaryStiffness * (y - w[HEIGHT]! - fore * w[PITCH]!) +
    car.secondaryDamping * (yVelocity - w[VERTICAL_SPEED]! - fore * w[PITCH_SPEED]!);
  const lateral = car.secondaryStiffness * (z - w[SWAY]!) + car.secondaryDamping * (zVelocity - w[SWAY_SPEED]!);
  let traction = 0,
    contactSide = 0,
    yawMoment = 0,
    axleLoad = 0,
    tags = 0,
    unsupported = 0;
  for (let local = 0; local < 2; local++) {
    const i = bogie * 2 + local;
    const axle = WHEELSETS + i * AXLE_WORDS;
    const offset = car.axles[i]!;
    const arm = offset - fore;
    const s = car.track.sample(w[DISTANCE]! + offset);
    const wheelY = w[axle + 2]!,
      wheelVy = w[axle + 3]!;
    const spring = car.restPrimary + car.primaryStiffness * (wheelY - y) + car.primaryDamping * (wheelVy - yVelocity);
    const linSlip = zVelocity + arm * yawSpeed - speed * yaw;
    const sideError = z + arm * yaw;
    const flange = sideError - magnitude(sideError, car.flangeClearance);
    const isTread = w[DERAILED] === 0 && s.supported && Math.abs(sideError) < car.treadHalfWidth;
    let axleForce = 0,
      axleSide = 0,
      axleTorque = 0,
      normals = 0;
    const omega = w[axle + 1]!;
    const rolling = Math.max(0.35, Math.abs(speed), Math.abs(omega) * car.wheelRadius);
    const inverseLong = 1 / car.totalMass + (car.wheelRadius * car.wheelRadius) / car.wheelInertia; // float division: effective rolling mass
    for (let wheel = 0; wheel < 2; wheel++) {
      const side = 2 * wheel - 1;
      // Conicity compares the two wheel tread radii on the same rigid axle.
      const radius = Math.max(0.5 * car.wheelRadius, car.wheelRadius + side * car.conicity * sideError);
      const height = wheel === 0 ? s.leftHeight : s.rightHeight;
      const compression = car.restDepth + height - wheelY;
      const normal = isTread ? hertz(car.contactStiffness, compression) : 0;
      w[axle + 4 + wheel] = normal;
      if (!normal) continue;
      normals += normal;
      const longitudinalJacobian = 1 - side * halfGauge * s.curvature;
      const railSpeed = speed * longitudinalJacobian - side * halfGauge * yawSpeed;
      const relative = [railSpeed - radius * omega, linSlip] as const;
      const force = railCreepForce({
        slip: relative,
        rollingSpeed: rolling,
        normal,
        creepStiffness: car.creepStiffness,
        adhesion,
      });
      const scale = railSlipLimit(force, relative, [2 * inverseLong, 2 / car.bogieMass], dt); // float division: both contacts share axle inertia
      axleForce += scale * (longitudinalJacobian * force[0] - yaw * force[1]);
      axleSide += scale * force[1];
      axleTorque -= scale * force[0] * radius;
      yawMoment -= side * halfGauge * force[0] * scale;
    }
    if (w[axle + 4] === 0 || w[axle + 5] === 0) tags |= 1 << i;
    if (!isTread) unsupported++;
    if (normals > 0) axleSide -= magnitude(flange * car.flangeStiffness, normals);
    traction += axleForce;
    contactSide += axleSide;
    yawMoment += arm * axleSide;
    const spin = omega + (dt * (axleTorque + car.maxDriveTorque * w[DRIVE]!)) / car.wheelInertia; // float division: wheel angular acceleration
    const brake = (dt * car.maxBrakeTorque * w[BRAKE]!) / car.wheelInertia; // float division: wheel brake rate
    const next = spin - magnitude(spin, brake);
    w[axle + 1] = next;
    w[axle] = w[axle]! + dt * next;
    integrate(w, axle + 2, normals - spring + car.axleMass * dot(gravity, s.up), car.axleMass, dt);
    axleLoad += spring;
  }
  const cantGravity = dot(gravity, centre.right);
  const lateralInFrame = cantGravity - signedSquare(speed) * centre.curvature * cos(centre.cant);
  integrate(w, base, axleLoad - vertical + car.bogieMass * dot(gravity, centre.up), car.bogieMass, dt);
  integrate(w, base + 2, contactSide - lateral + car.bogieMass * lateralInFrame, car.bogieMass, dt);
  const yawSpring = 0.25 * car.primaryStiffness * car.bogieWheelbase * car.bogieWheelbase;
  const yawDamping = 0.25 * car.primaryDamping * car.bogieWheelbase * car.bogieWheelbase;
  integrate(w, base + 4, yawMoment - yawSpring * yaw - yawDamping * yawSpeed, car.bogieInertia, dt);
  return { vertical, lateral, traction, contactSide, loss: tags, unsupported };
}

export function stepCar(w: Float64Array, car: Car, gravity: RailPoint, wetness: number, dt: number): void {
  const centre = car.track.sample(w[DISTANCE]!);
  const adhesion = adhesionAt(car, wetness);
  const a = resolveBogie(w, car, gravity, centre, adhesion, 0, dt);
  const b = resolveBogie(w, car, gravity, centre, adhesion, 1, dt);
  w[LONGITUDINAL] = a.traction + b.traction;
  w[LATERAL] = a.contactSide + b.contactSide;
  w[LOSS] = a.loss | b.loss;
  w[DERAILED] = w[DERAILED]! || Number(a.unsupported + b.unsupported >= 2);
  const normalG = dot(gravity, centre.up),
    rightG = dot(gravity, centre.right);
  const lateralInFrame = rightG - signedSquare(w[SPEED]!) * centre.curvature * cos(centre.cant);
  integrate(
    w,
    DISTANCE,
    w[LONGITUDINAL]! + w[COUPLER]! + car.totalMass * dot(gravity, centre.tangent),
    car.totalMass,
    dt,
  );
  integrate(w, HEIGHT, a.vertical + b.vertical + w[ROOF_REACTION]! + car.mass * normalG, car.mass, dt);
  integrate(w, SWAY, a.lateral + b.lateral + w[ROOF_LATERAL]! + car.mass * lateralInFrame, car.mass, dt);
  const cantLever = 0.5 * car.gauge;
  const rollStiffness = 2 * car.secondaryStiffness * cantLever * cantLever;
  const rollDamping = 2 * car.secondaryDamping * cantLever * cantLever;
  integrate(
    w,
    ROLL,
    lateralInFrame * car.mass * car.centreHeight - rollStiffness * w[ROLL]! - rollDamping * w[ROLL_SPEED]!,
    car.rollInertia,
    dt,
  );
  const pitchMoment =
    0.5 * car.bogieSpacing * (b.vertical - a.vertical) + car.centreHeight * (w[LONGITUDINAL]! + w[COUPLER]!);
  integrate(w, PITCH, pitchMoment, car.pitchInertia, dt);
}

export function readCar(w: Float64Array, car: Car): RailCarState {
  const { centre, tangent, right, up, cant } = car.track.sample(w[DISTANCE]!);
  const roll = w[ROLL]!,
    pitch = w[PITCH]!;
  const forward = along([0, 0, 0], tangent, cos(pitch), up, sin(pitch));
  const tilted = along([0, 0, 0], up, cos(pitch), tangent, -sin(pitch));
  return {
    distance: w[DISTANCE]!,
    speed: w[SPEED]!,
    position: along(centre, right, w[SWAY]!, up, w[HEIGHT]! + car.centreHeight),
    forward,
    up: along([0, 0, 0], tilted, cos(roll), right, sin(roll)),
    cant,
    heave: w[HEIGHT]!,
    sway: w[SWAY]!,
    roll,
    pitch,
    bogieYaw: [w[BOGIES + 4]!, w[BOGIES + BOGIE_WORDS + 4]!],
    bogieHeave: [w[BOGIES]!, w[BOGIES + BOGIE_WORDS]!],
    bogieSway: [w[BOGIES + 2]!, w[BOGIES + BOGIE_WORDS + 2]!],
    longitudinalForce: w[LONGITUDINAL]!,
    lateralForce: w[LATERAL]!,
    couplerForce: w[COUPLER]!,
    lostSupport: w[LOSS]!,
    derailment: w[DERAILED] === 1,
    wheelsets: Array.from({ length: 4 }, (_, i) => {
      const a = WHEELSETS + i * AXLE_WORDS;
      return {
        angle: w[a]!,
        angularVelocity: w[a + 1]!,
        heave: w[a + 2]!,
        leftLoad: w[a + 4]!,
        rightLoad: w[a + 5]!,
      };
    }),
  };
}

export function carFrequency(car: Car): number {
  const normalStiffness = 3 * car.contactStiffness * Math.sqrt(car.restDepth);
  return Math.max(
    Math.sqrt((normalStiffness + car.primaryStiffness) / car.axleMass), // float division: wheel normal mode
    car.primaryDamping / car.axleMass, // float division: wheel damping time
    Math.sqrt((car.secondaryStiffness + 2 * car.primaryStiffness) / car.bogieMass), // float division: sprung bogie mode
    (2 * car.secondaryDamping) / car.mass, // float division: sprung body damping time
  );
}
