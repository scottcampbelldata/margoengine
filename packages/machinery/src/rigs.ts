// Mechanism rigs: the classic mechanisms of ./mechanisms.ts built as stepped @margoengine/physics worlds. The input shaft is a
// position-driven body (a servo: it reaches the angle it is given each fixed step), the followers are dynamic bodies held by the
// kernel's joints (hinges, sliders, a pin in a slot as a generic joint with two free axes, a gear coupling), and every step the
// bodies the solver moved are compared with the closed form, so a rig is a simulation and its own check. The joints are rows of
// the kernel's sequential-impulse solve (Catto, "Iterative Dynamics with Temporal Coherence", GDC 2005; Baraff, "Linear-Time Dynamics
// using Lagrange Multipliers", SIGGRAPH 1996); the closed forms are Reuleaux, "The Kinematics of Machinery", 1876, and Willis,
// "Principles of Mechanism", 1841. A Geneva wheel is held by its locking disc between strokes, modelled as the wheel made fixed
// while the pin is out of every slot, the way the convex arc of the disc holds it in the real drive.
import type { Physics, PhysicsBody, PhysicsJoint } from '@margoengine/physics';
import {
  archimedesScrewPose,
  differentialPose,
  epicyclicSpeeds,
  genevaPose,
  gimbalPose,
  harmonicDriveRatio,
  oldhamPose,
  reuleauxOutline,
  reuleauxPose,
  roseEnginePose,
  rosetteModulation,
  scotchYokePose,
  togglePressPose,
  wattGovernorEquilibrium,
  type EpicyclicTeeth,
  type HarmonicDriveSpec,
  type Rosette,
  type WattGovernorSpec,
} from './mechanisms.js';

type Quat = [number, number, number, number];
const zTurn = (angle: number): Quat => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
const zAngle = (q: readonly number[]): number => 2 * Math.atan2(q[2]!, q[3]!);
/** `angle` moved by whole turns to lie within half a turn of `near`. */
const unwrap = (angle: number, near: number): number => angle + 2 * Math.PI * Math.round((near - angle) / (2 * Math.PI));
const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number; got ${value}.`);
  return value;
};

/** How closely the stepped world matched the closed form. */
export interface RigCheck {
  /** The largest gap seen over the last {@link MechanismRig.drive} call (metres or radians, see `unit`). */
  worst: number;
  /** The gap after the last step. */
  last: number;
  /** The largest gap since the rig was made. */
  ever: number;
  /** What the gaps measure. */
  unit: 'm' | 'rad';
  /** Fixed steps the world has taken. */
  steps: number;
}

/** Options every rig takes. */
export interface RigOptions {
  /** The input angle the rig is built at, in radians (default 0). */
  angle?: number;
  /** The most the input turns in one fixed step, in radians (default 2 degrees): a long move is split into steps this size. */
  maxStep?: number;
  /** Disposes the rig when it aborts, so a page's one AbortController tears it down with the rest (default none). */
  signal?: AbortSignal;
}

/** A mechanism on a stepped physics world: turn its input, read the bodies the solver moved and how far they are from exact. */
export interface MechanismRig<Pose> extends Disposable {
  /** The physics world (no engine, no gravity unless the rig needs it). */
  readonly physics: Physics;
  /** The input angle reached, in radians, unwrapped (it keeps counting past a turn). */
  readonly input: number;
  /** The comparison with the closed form. */
  readonly check: RigCheck;
  /**
   * Turns the input to `angle` radians in fixed steps of at most `maxStep`, the shortest way round unless `shortest` is false
   * (then `angle` is taken as an unwrapped target), and returns the pose of the stepped bodies.
   */
  drive(angle: number, shortest?: boolean): Pose;
  /** The pose of the bodies now. */
  pose(): Pose;
  dispose(): void;
}

// The solver is another package's heavy entry: it loads with loadRigs, so importing this entry costs only its own bytes.
let solver: typeof import('@margoengine/physics') | null = null;
const physicsModule = (): typeof import('@margoengine/physics') => {
  if (!solver) throw new Error('The physics solver is not loaded; await loadRigs() before making a rig.');
  return solver;
};

/** Loads the physics solver (its module and Wasm); await it once before making a rig. */
export async function loadRigs(): Promise<void> {
  const module = await import('@margoengine/physics');
  await module.Physics.load();
  solver = module;
}

abstract class Rig<Pose> implements MechanismRig<Pose> {
  readonly physics: Physics;
  readonly check: RigCheck;
  input: number;
  protected readonly ground: PhysicsBody;
  protected readonly crank: PhysicsBody;
  private readonly maxStep: number;

  protected constructor(unit: 'm' | 'rad', options: RigOptions) {
    this.input = finite(options.angle ?? 0, 'Rig angle');
    this.requested = this.input;
    this.maxStep = finite(options.maxStep ?? Math.PI / 90, 'Rig maxStep');
    if (!(this.maxStep > 0)) throw new RangeError(`Rig maxStep must be above 0; got ${this.maxStep}.`);
    this.check = { worst: 0, last: 0, ever: 0, unit, steps: 0 };
    options.signal?.throwIfAborted();
    const physics = new (physicsModule().Physics)(null);
    physics.gravity = [0, 0, 0];
    this.physics = physics;
    this.ground = physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: [] });
    this.crank = this.disc([0, 0, 0], this.input, 'kinematicPosition');
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true });
  }

  protected disc(position: [number, number, number], angle = 0, type: 'dynamic' | 'kinematicPosition' = 'dynamic'): PhysicsBody {
    return this.physics.addBody(null, {
      type,
      position,
      rotation: zTurn(angle),
      colliders: { shape: 'cylinder', radius: 0.05, halfHeight: 0.01, mass: 1 },
    });
  }

  /** Angles at which the input must land exactly (a stroke's start or end), as values modulo a full turn. */
  protected stops(): readonly number[] {
    return [];
  }
  /** Called before each step with the angle the input will reach. */
  protected beforeStep(_angle: number): void {}
  /** The gap between the bodies and the closed form now. */
  protected abstract gap(): number;
  abstract pose(): Pose;

  /** The angle last asked of {@link drive}, as given. */
  protected requested = 0;

  drive(angle: number, shortest = true): Pose {
    this.requested = angle;
    const target = shortest ? unwrap(finite(angle, 'Rig angle'), this.input) : finite(angle, 'Rig angle');
    this.check.worst = 0;
    while (this.input !== target) {
      let next = Math.abs(target - this.input) <= this.maxStep ? target : this.input + Math.sign(target - this.input) * this.maxStep;
      // Land exactly on a stroke boundary the move crosses, so a joint is made where its loop closes.
      for (const stop of this.stops()) {
        const at = unwrap(stop, (this.input + next) / 2);
        if ((at - this.input) * (at - next) < 0) next = at;
      }
      this.beforeStep(next);
      this.crank.setNextRotation(zTurn(next));
      this.physics.step();
      this.input = next;
      const gap = this.gap();
      this.check.steps++;
      this.check.last = gap;
      this.check.worst = Math.max(this.check.worst, gap);
      this.check.ever = Math.max(this.check.ever, gap);
    }
    return this.pose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
  dispose(): void {
    this.physics.dispose();
  }
}

/** Pose of {@link scotchYokeRig}. */
export interface ScotchYokeRigPose {
  angle: number;
  /** The yoke's travel along its slide, from the solver. */
  slide: number;
  /** Where the crank pin sits along the slot, from the solver. */
  slot: number;
}

class ScotchYoke extends Rig<ScotchYokeRigPose> {
  private readonly yoke: PhysicsBody;
  constructor(
    private readonly radius: number,
    options: RigOptions,
  ) {
    super('m', options);
    this.yoke = this.disc([scotchYokePose(this.input, radius).slide, 0, 0.05]);
    this.physics.addJoint(this.ground, this.yoke, { type: 'prismatic', axis: [1, 0, 0], anchorA: [this.yoke.position[0], 0, 0.05] });
    // The slot runs along the yoke's y: the pin may slide along it and turn about z.
    this.physics.addJoint(this.yoke, this.crank, {
      type: 'generic',
      anchorA: [0, 0, -0.05],
      anchorB: [radius, 0, 0],
      locked: ['linX', 'linZ', 'angX', 'angY'],
    });
  }
  protected gap(): number {
    return Math.abs(this.yoke.position[0] - scotchYokePose(this.input, this.radius).slide);
  }
  pose(): ScotchYokeRigPose {
    const t = zAngle(this.crank.rotation);
    return { angle: this.input, slide: this.yoke.position[0], slot: this.radius * Math.sin(t) - this.yoke.position[1] };
  }
}

/**
 * A Scotch yoke: a crank of `radius` metres whose pin runs in the slot of a yoke on a straight slide. The yoke's travel is the
 * solver's; the check is against `r cos(t)`.
 */
export function scotchYokeRig(radius: number, options: RigOptions = {}): MechanismRig<ScotchYokeRigPose> {
  if (!(radius > 0 && Number.isFinite(radius))) throw new RangeError(`Crank radius must be above 0; got ${radius}.`);
  return new ScotchYoke(radius, options);
}

/** Options of {@link genevaRig}. */
export interface GenevaRigOptions extends RigOptions {
  /** Slots in the wheel, 3 or more (default 4). */
  slots?: number;
  /** Distance between the crank's and the wheel's centres in metres (default 1). */
  centerDistance?: number;
}
/** Pose of {@link genevaRig}. */
export interface GenevaRigPose {
  driver: number;
  /** The wheel's angle from the solver, unwrapped like {@link GenevaPose.wheel}. */
  wheel: number;
  /** True while the pin is in a slot. */
  indexing: boolean;
  /**
   * The wheel's angle moved by whole slot pitches to the crank turn of the angle last asked of `drive` (the angle as given, not
   * unwrapped): the same picture as `wheel`, since a slot pitch turns the wheel onto itself, read within one crank turn.
   */
  turnWheel: number;
}

class Geneva extends Rig<GenevaRigPose> {
  private readonly wheel: PhysicsBody;
  private readonly half: number;
  private slot: PhysicsJoint | null = null;
  private readonly crankRadius: number;
  constructor(
    private readonly slots: number,
    private readonly centerDistance: number,
    options: RigOptions,
  ) {
    super('rad', options);
    this.half = Math.PI / 2 - Math.PI / slots;
    this.crankRadius = centerDistance * Math.sin(Math.PI / slots);
    this.wheel = this.disc([centerDistance, 0, 0.05], this.exact());
    this.physics.addJoint(this.ground, this.wheel, { type: 'revolute', axis: [0, 0, 1], anchorA: [centerDistance, 0, 0.05] });
    this.engage(this.indexing(this.input));
  }
  private exact(): number {
    return genevaPose(this.input, { slots: this.slots, centerDistance: this.centerDistance }).wheel;
  }
  /** Strictly inside a stroke: at its ends the pin sits at the slot's mouth and the locking disc takes over. */
  private indexing(angle: number): boolean {
    return Math.abs(unwrap(angle, 0)) < this.half - 1e-9;
  }
  private engage(on: boolean): void {
    if (on && !this.slot) {
      // The slot the pin is entering, in the wheel's frame: the pin's direction from the wheel centre less the wheel's angle.
      const t = zAngle(this.crank.rotation),
        pin = [this.crankRadius * Math.cos(t) - this.centerDistance, this.crankRadius * Math.sin(t)];
      const slot = Math.atan2(pin[1]!, pin[0]!) - zAngle(this.wheel.rotation);
      this.wheel.setType('dynamic');
      this.slot = this.physics.addJoint(this.wheel, this.crank, {
        type: 'generic',
        frameA: zTurn(slot),
        anchorA: [0, 0, -0.05],
        anchorB: [this.crankRadius, 0, 0],
        locked: ['linY', 'linZ', 'angX', 'angY'],
      });
    } else if (!on && this.slot) {
      this.physics.removeJoint(this.slot);
      this.slot = null;
      this.wheel.setType('fixed');
    } else if (!on) this.wheel.setType('fixed');
  }
  protected override stops(): readonly number[] {
    return [-this.half, this.half];
  }
  protected override beforeStep(angle: number): void {
    // A step that ends inside a stroke starts with the pin already engaged at the stroke's mouth.
    this.engage(this.indexing((this.input + angle) / 2));
  }
  protected gap(): number {
    this.engage(this.indexing(this.input));
    return Math.abs(unwrap(this.wheelAngle(), this.exact()) - this.exact());
  }
  private wheelAngle(): number {
    return unwrap(zAngle(this.wheel.rotation), this.exact());
  }
  pose(): GenevaRigPose {
    const wheel = this.wheelAngle(),
      turns = Math.round((this.input - this.requested) / (2 * Math.PI));
    return { driver: this.input, wheel, indexing: this.indexing(this.input), turnWheel: wheel + (turns * 2 * Math.PI) / this.slots };
  }
}

/**
 * An external Geneva drive: a crank pin enters a slot of the wheel, turns it one slot pitch and leaves; between strokes the locking
 * disc holds the wheel. The pin in the slot is a generic joint made as the pin enters and removed as it leaves; the check is against
 * {@link genevaPose}.
 */
export function genevaRig(options: GenevaRigOptions = {}): MechanismRig<GenevaRigPose> {
  const slots = options.slots ?? 4,
    centerDistance = options.centerDistance ?? 1;
  if (!(Number.isInteger(slots) && slots >= 3)) throw new RangeError(`A Geneva wheel has 3 slots or more; got ${slots}.`);
  if (!(centerDistance > 0 && Number.isFinite(centerDistance)))
    throw new RangeError(`Centre distance must be above 0; got ${centerDistance}.`);
  return new Geneva(slots, centerDistance, options);
}

/** Pose of {@link oldhamRig}. */
export interface OldhamRigPose {
  input: number;
  /** The output shaft's angle, from the solver. */
  output: number;
  /** The middle disc's angle and centre, from the solver. */
  disc: number;
  center: [number, number];
  /** The disc's slide along the input hub's slot and along the output hub's slot, from the solver. */
  inputSlide: number;
  outputSlide: number;
  /** The circle the disc centre runs on: centre and radius (half the offset). */
  orbitCenter: [number, number];
  orbitRadius: number;
}

/** The radius the output's angle error is measured at, in metres: a hub's size. */
const HUB = 0.1;

class Oldham extends Rig<OldhamRigPose> {
  private readonly output: PhysicsBody;
  private readonly middle: PhysicsBody;
  constructor(
    private readonly offset: number,
    options: RigOptions,
  ) {
    super('m', options);
    const t = this.input,
      center = oldhamPose(t, offset).center;
    this.output = this.disc([offset, 0, 0.1], t);
    this.physics.addJoint(this.ground, this.output, { type: 'revolute', axis: [0, 0, 1], anchorA: [offset, 0, 0.1] });
    this.middle = this.disc([center[0], center[1], 0.05], t);
    // The disc's tongue slides in the input hub's slot (along the input's x) and its other tongue in the output's (along its y).
    this.physics.addJoint(this.crank, this.middle, {
      type: 'generic',
      anchorA: [0, 0, 0.05],
      locked: ['linY', 'linZ', 'angX', 'angY', 'angZ'],
    });
    this.physics.addJoint(this.output, this.middle, {
      type: 'generic',
      anchorA: [0, 0, -0.05],
      locked: ['linX', 'linZ', 'angX', 'angY', 'angZ'],
    });
  }
  protected gap(): number {
    const exact = oldhamPose(this.input, this.offset),
      p = this.middle.position;
    return Math.max(
      Math.hypot(p[0] - exact.center[0], p[1] - exact.center[1]),
      // The output's angle error as an arc at the hub, so both gaps are lengths.
      Math.abs(unwrap(zAngle(this.output.rotation), exact.output) - exact.output) * HUB,
    );
  }
  pose(): OldhamRigPose {
    const p = this.middle.position,
      input = zAngle(this.crank.rotation),
      output = unwrap(zAngle(this.output.rotation), this.input),
      o = zAngle(this.output.rotation);
    return {
      input: this.input,
      output,
      disc: unwrap(zAngle(this.middle.rotation), this.input),
      center: [p[0], p[1]],
      inputSlide: p[0] * Math.cos(input) + p[1] * Math.sin(input),
      outputSlide: -(p[0] - this.offset) * Math.sin(o) + p[1] * Math.cos(o),
      orbitCenter: [this.offset / 2, 0],
      orbitRadius: this.offset / 2,
    };
  }
}

/**
 * An Oldham coupling between shafts `offset` metres apart: a middle disc whose two crossed tongues slide in slots of the input and
 * output hubs. Both slides are generic joints; the check is against {@link oldhamPose} (the disc centre, and the output angle as an
 * arc 0.1 m out).
 */
export function oldhamRig(offset: number, options: RigOptions = {}): MechanismRig<OldhamRigPose> {
  if (!(offset >= 0 && Number.isFinite(offset))) throw new RangeError(`Shaft offset must be 0 or more; got ${offset}.`);
  return new Oldham(offset, options);
}

/** Options of {@link epicyclicRig}. */
export interface EpicyclicRigOptions extends RigOptions {
  /** The member held still (default the ring); the input is the sun, or the ring when the sun is held. */
  held?: 'sun' | 'ring' | 'carrier';
}
/** Pose of {@link epicyclicRig}: each member's angle (the held one 0), the driven one from the solver, the planet from Willis. */
export interface EpicyclicRigPose {
  sun: number;
  ring: number;
  carrier: number;
  planet: number;
}

class Epicyclic extends Rig<EpicyclicRigPose> {
  private readonly driven: PhysicsBody;
  private readonly inputName: 'sun' | 'ring';
  private readonly drivenName: 'ring' | 'carrier';
  constructor(
    private readonly teeth: EpicyclicTeeth,
    private readonly held: 'sun' | 'ring' | 'carrier',
    options: RigOptions,
  ) {
    super('rad', options);
    this.inputName = held === 'sun' ? 'ring' : 'sun';
    this.drivenName = held === 'carrier' ? 'ring' : 'carrier';
    const rate = this.exact(1)[this.drivenName];
    // Coaxial members are not jointed to one another, so they sit apart along the axis and never touch.
    this.driven = this.disc([0, 0, 0.5], rate * this.input);
    this.physics.addJoint(this.ground, this.driven, { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0.5] });
    new (physicsModule().GearJoint)(this.physics, this.crank, this.driven, { ratio: -1 / rate });
  }
  private exact(input: number) {
    const known = this.held === 'carrier' ? { sun: input, carrier: 0 } : this.held === 'sun' ? { ring: input, sun: 0 } : { sun: input, ring: 0 };
    return epicyclicSpeeds(this.teeth, known);
  }
  private drivenAngle(): number {
    const exact = this.exact(this.input)[this.drivenName];
    return unwrap(zAngle(this.driven.rotation), exact);
  }
  protected gap(): number {
    return Math.abs(this.drivenAngle() - this.exact(this.input)[this.drivenName]);
  }
  pose(): EpicyclicRigPose {
    const known: { sun?: number; ring?: number; carrier?: number } = { [this.held]: 0, [this.inputName]: this.input };
    known[this.drivenName] = this.drivenAngle();
    // The planet follows from the sun and the carrier (Willis); the solver's members carry it.
    const { sun = 0, ring = 0, carrier = 0 } = known;
    const zs = this.teeth.sun,
      zp = this.teeth.planet;
    return { sun, ring, carrier, planet: carrier - ((sun - carrier) * zs) / zp };
  }
}

/**
 * A simple epicyclic (planetary) train: one member held, the input turned, and the driven member turned by a gear joint at Willis's
 * ratio. The check is against {@link epicyclicSpeeds}.
 */
export function epicyclicRig(teeth: EpicyclicTeeth, options: EpicyclicRigOptions = {}): MechanismRig<EpicyclicRigPose> {
  const held = options.held ?? 'ring';
  if (!['sun', 'ring', 'carrier'].includes(held)) throw new RangeError(`Held member is sun, ring or carrier; got ${String(held)}.`);
  epicyclicSpeeds(teeth, { sun: 0, ring: 0 });
  return new Epicyclic(teeth, held, options);
}

/** Pose of {@link harmonicDriveRig}: the wave generator's angle and the output spline's, from the solver. */
export interface HarmonicDriveRigPose {
  input: number;
  output: number;
}

class Harmonic extends Rig<HarmonicDriveRigPose> {
  private readonly output: PhysicsBody;
  private readonly ratio: number;
  constructor(spec: HarmonicDriveSpec, options: RigOptions) {
    super('rad', options);
    this.ratio = harmonicDriveRatio(spec);
    this.output = this.disc([0, 0, 0.5], this.ratio * this.input);
    this.physics.addJoint(this.ground, this.output, { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0.5] });
    // The teeth in mesh at the two ends of the major axis carry the output on at the tooth-count ratio: a gear row.
    new (physicsModule().GearJoint)(this.physics, this.crank, this.output, { ratio: -1 / this.ratio });
  }
  private outputAngle(): number {
    return unwrap(zAngle(this.output.rotation), this.ratio * this.input);
  }
  protected gap(): number {
    return Math.abs(this.outputAngle() - this.ratio * this.input);
  }
  pose(): HarmonicDriveRigPose {
    return { input: this.input, output: this.outputAngle() };
  }
}

/**
 * A harmonic drive: the wave generator is the input, and the output spline (the flexspline with the circular spline held, or the
 * circular spline with the flexspline held) is turned by a gear row at Musser's tooth-count ratio. The check is against
 * {@link harmonicDriveRatio} times the input.
 */
export function harmonicDriveRig(spec: HarmonicDriveSpec, options: RigOptions = {}): MechanismRig<HarmonicDriveRigPose> {
  harmonicDriveRatio(spec);
  return new Harmonic(spec, options);
}

/** Options of {@link integratorRig}. */
export interface IntegratorRigOptions extends RigOptions {
  /** The output roller's radius in metres. */
  wheelRadius: number;
  /** The disk's radius in metres: the ball stays within it (default no bound). */
  diskRadius?: number;
  /** The ball's distance from the disk centre at the start, metres (default 0). */
  radius?: number;
}
/** Pose of {@link integratorRig}: the disk's angle, the output roller's from the solver since the last reset, and the ball radius. */
export interface IntegratorRigPose {
  disk: number;
  output: number;
  radius: number;
}
/** A ball-and-disk integrator on the solver, from {@link integratorRig}. */
export interface IntegratorRig extends MechanismRig<IntegratorRigPose> {
  /** Moves the ball to `radius` metres from the disk centre; the next drive integrates at it. */
  setRadius(radius: number): void;
  /** Sets the output reading back to 0 (the roller keeps its angle; the count starts again). */
  resetOutput(): void;
}

class Integrator extends Rig<IntegratorRigPose> implements IntegratorRig {
  private readonly roller: PhysicsBody;
  private readonly rho: number;
  private readonly limit: number;
  private radius = 0;
  private built = false;
  private mesh: { remove(): void } | null = null;
  /** The output's exact angle since the last reset (Thomson's integral, summed a step at a time) and the roller's angle then. */
  private exact = 0;
  private zero = 0;
  constructor(options: IntegratorRigOptions) {
    super('rad', options);
    this.rho = options.wheelRadius;
    this.limit = options.diskRadius ?? Infinity;
    this.roller = this.disc([0, 0, 0.5]);
    this.physics.addJoint(this.ground, this.roller, { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0.5] });
    this.setRadius(options.radius ?? 0);
  }
  setRadius(radius: number): void {
    if (!(Math.abs(finite(radius, 'Ball radius')) <= this.limit))
      throw new RangeError(`The ball must stay on the disk (|r| <= ${this.limit}); got ${radius}.`);
    if (this.built && radius === this.radius) return;
    this.built = true;
    this.radius = radius;
    // The ball's friction drive is a gear row of ratio r / rho; a new radius makes a new row from where the roller stands.
    this.mesh?.remove();
    this.mesh = null;
    if (radius === 0) {
      // At the centre the ball does not turn, and the roller stands.
      this.roller.setType('fixed');
      return;
    }
    this.roller.setType('dynamic');
    this.roller.setAngularVelocity([0, 0, (radius / this.rho) * this.crank.angularVelocity[2]]);
    this.mesh = new (physicsModule().GearJoint)(this.physics, this.roller, this.crank, { ratio: -radius / this.rho });
  }
  resetOutput(): void {
    this.zero += this.exact;
    this.exact = 0;
  }
  protected override beforeStep(angle: number): void {
    this.exact += ((angle - this.input) * this.radius) / this.rho;
  }
  private rollerAngle(): number {
    return unwrap(zAngle(this.roller.rotation), this.zero + this.exact) - this.zero;
  }
  protected gap(): number {
    return Math.abs(this.rollerAngle() - this.exact);
  }
  pose(): IntegratorRigPose {
    return { disk: this.input, output: this.rollerAngle(), radius: this.radius };
  }
}

/**
 * A ball-and-disk (Kelvin) integrator: the disk is the input and the ball's friction drive is a gear row of ratio r / rho to the
 * output roller, remade from where the roller stands whenever the ball moves. The roller's angle is the integral of r / rho over the
 * disk's angle; the check is against that integral summed over the steps, the sum `ballDiskIntegrator` makes.
 */
export function integratorRig(options: IntegratorRigOptions): IntegratorRig {
  if (!(options.wheelRadius > 0 && Number.isFinite(options.wheelRadius)))
    throw new RangeError(`Wheel radius must be above 0; got ${options.wheelRadius}.`);
  if (options.diskRadius !== undefined && !(options.diskRadius > 0 && Number.isFinite(options.diskRadius)))
    throw new RangeError(`Disk radius must be above 0; got ${options.diskRadius}.`);
  return new Integrator(options);
}

/** Pose of {@link archimedesScrewRig}: the shaft angle and the water's travel up the axis, from the solver. */
export interface ArchimedesScrewRigPose {
  angle: number;
  /** The water's travel up the axis, metres. */
  travel: number;
  /** The blades' phase within the turn, radians in [0, 2 pi), read from the travel. */
  phase: number;
}

class Screw extends Rig<ArchimedesScrewRigPose> {
  private readonly water: PhysicsBody;
  private thread: { remove(): void } | null = null;
  /** Whole pitches the water was moved back by, so its body stays within half a pitch of the origin. */
  private band: number;
  constructor(
    private readonly pitch: number,
    options: RigOptions,
  ) {
    super('m', options);
    const travel = archimedesScrewPose(this.input, pitch).travel;
    this.band = Math.round(travel / pitch);
    // The water touches nothing, so it has no collider: its mass is given, and it sits on the axis near the origin, where a
    // position's float spacing is finest.
    this.water = this.physics.addBody(null, { type: 'dynamic', position: [0, 0, travel - this.band * pitch], colliders: [] });
    this.water.setMassProperties({ mass: 1, inertia: [1e-3, 1e-3, 1e-3] });
    this.physics.addJoint(this.ground, this.water, { type: 'prismatic', axis: [0, 0, 1] });
    this.wind();
  }
  /** The thread: the water climbs a pitch a turn, a rack on the shaft's pinion of radius pitch / 2 pi. */
  private wind(): void {
    this.thread?.remove();
    this.thread = new (physicsModule().RackAndPinionJoint)(this.physics, this.crank, this.water, {
      rackAxis: [0, 0, -1],
      radius: this.pitch / (2 * Math.PI),
    });
  }
  private travel(): number {
    return this.water.position[2] + this.band * this.pitch;
  }
  protected override beforeStep(): void {
    // A bucket that has climbed a whole pitch is the next one up: the body moves back a pitch so it stays near the origin.
    const shift = Math.round(this.water.position[2] / this.pitch);
    if (shift !== 0) {
      this.band += shift;
      const p = this.water.position;
      this.water.setPosition([p[0], p[1], p[2] - shift * this.pitch]);
      this.wind();
    }
  }
  protected gap(): number {
    return Math.abs(this.travel() - archimedesScrewPose(this.input, this.pitch).travel);
  }
  pose(): ArchimedesScrewRigPose {
    const travel = this.travel(),
      turns = travel / this.pitch;
    return { angle: this.input, travel, phase: (turns - Math.floor(turns)) * 2 * Math.PI };
  }
}

/**
 * An Archimedes screw: the shaft is the input, and the water in a bucket climbs the axis on a slide, held to the shaft by the
 * thread as a rack and pinion of radius pitch / 2 pi. The check is against {@link archimedesScrewPose}'s travel.
 */
export function archimedesScrewRig(pitch: number, options: RigOptions = {}): MechanismRig<ArchimedesScrewRigPose> {
  if (!(pitch > 0 && Number.isFinite(pitch))) throw new RangeError(`Pitch must be above 0; got ${pitch}.`);
  return new Screw(pitch, options);
}

/** Options of {@link stroboscopeRig}. */
export interface StroboscopeRigOptions {
  /** The rotor's speed in revolutions a minute. */
  rpm: number;
  /** Flashes a second. */
  flashRate: number;
  /** Disposes the rig when it aborts (default none). */
  signal?: AbortSignal;
}
/** Pose of {@link stroboscopeRig}: the rotor's angle now and at the last flash, both from the solver, and the flash count. */
export interface StroboscopeRigPose {
  /** The rotor's angle now, radians in [0, 2 pi). */
  reference: number;
  /** The rotor's angle at the last flash, what the eye sees under the strobe, radians in [0, 2 pi). */
  sampled: number;
  /** Flashes since the flash rate was set. */
  flash: number;
}
/** A rotor coasting on a frictionless bearing under a strobe, from {@link stroboscopeRig}. */
export interface StroboscopeRig extends Disposable {
  readonly physics: Physics;
  /** The rotor's angle against its speed times the time run. */
  readonly check: RigCheck;
  /** Runs the world on by `seconds`, stepping onto each flash, and returns the pose. */
  advance(seconds: number): StroboscopeRigPose;
  /** Spins the rotor at `rpm` from now on (a belt brought to speed). */
  setSpeed(rpm: number): void;
  /** Flashes `hertz` times a second from now on, the count starting again with a flash now. */
  setFlashRate(hertz: number): void;
  /** Runs the world on to the next flash and returns the pose. */
  nextFlash(): StroboscopeRigPose;
  pose(): StroboscopeRigPose;
  dispose(): void;
}

const wrapTurn = (angle: number): number => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

class Stroboscope implements StroboscopeRig {
  readonly physics: Physics;
  readonly check: RigCheck = { worst: 0, last: 0, ever: 0, unit: 'rad', steps: 0 };
  private readonly rotor: PhysicsBody;
  private readonly step: number;
  private omega = 0;
  private period = 1;
  /** Time to the next flash, the flash count and the angle the last flash caught. */
  private toFlash = 0;
  private flash = 0;
  private caught = 0;
  /** The rotor's exact angle: its speed integrated over the time run. */
  private exact = 0;
  constructor(options: StroboscopeRigOptions) {
    options.signal?.throwIfAborted();
    const physics = new (physicsModule().Physics)(null);
    physics.gravity = [0, 0, 0];
    this.physics = physics;
    this.step = physics.fixedTimestep;
    const ground = physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: [] });
    this.rotor = physics.addBody(null, {
      type: 'dynamic',
      position: [0, 0, 0],
      colliders: { shape: 'cylinder', radius: 0.05, halfHeight: 0.01, mass: 1 },
    });
    physics.addJoint(ground, this.rotor, { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0] });
    this.setSpeed(options.rpm);
    this.setFlashRate(options.flashRate);
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true });
  }
  setSpeed(rpm: number): void {
    this.omega = (finite(rpm, 'Speed') * 2 * Math.PI) / 60;
    this.rotor.setAngularVelocity([0, 0, this.omega]);
  }
  setFlashRate(hertz: number): void {
    if (!(hertz > 0 && Number.isFinite(hertz))) throw new RangeError(`Flash rate must be above 0; got ${hertz}.`);
    this.period = 1 / hertz;
    this.flash = 0;
    this.toFlash = this.period;
    this.caught = this.angle();
  }
  private angle(): number {
    return unwrap(zAngle(this.rotor.rotation), this.exact);
  }
  advance(seconds: number): StroboscopeRigPose {
    let left = finite(seconds, 'Time');
    if (left < 0) throw new RangeError(`Time runs forward; got ${seconds} s.`);
    this.check.worst = 0;
    try {
      while (left > 1e-12) {
        // Step onto the next flash when it comes first, so the strobe catches the rotor where the solver has it at that instant.
        const dt = Math.min(this.step, left, this.toFlash);
        this.physics.fixedTimestep = dt;
        this.physics.step();
        this.exact += this.omega * dt;
        left -= dt;
        this.toFlash -= dt;
        if (this.toFlash <= 1e-12) {
          this.flash++;
          this.caught = this.angle();
          this.toFlash = this.period;
        }
        const gap = Math.abs(this.angle() - this.exact);
        this.check.steps++;
        this.check.last = gap;
        this.check.worst = Math.max(this.check.worst, gap);
        this.check.ever = Math.max(this.check.ever, gap);
      }
    } finally {
      this.physics.fixedTimestep = this.step;
    }
    return this.pose();
  }
  nextFlash(): StroboscopeRigPose {
    return this.advance(this.toFlash);
  }
  pose(): StroboscopeRigPose {
    return { reference: wrapTurn(this.angle()), sampled: wrapTurn(this.caught), flash: this.flash };
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
  dispose(): void {
    this.physics.dispose();
  }
}

/**
 * A stroboscope: a rotor coasting at `rpm` on a frictionless hinge (the solver integrates its turn) and a strobe flashing
 * `flashRate` times a second. The world steps onto every flash, so `sampled` is the solver's angle at the flash; the check is the
 * rotor against its speed times the time run, `stroboscopicPose` for a steady speed.
 */
export function stroboscopeRig(options: StroboscopeRigOptions): StroboscopeRig {
  return new Stroboscope(options);
}

/** A body of `mass` kg that meets nothing: a link whose only ties are its joints. */
const point = (physics: Physics, position: [number, number, number], rotation: Quat = [0, 0, 0, 1], mass = 1): PhysicsBody =>
  physics.addBody(null, {
    type: 'dynamic',
    position,
    rotation,
    colliders: { shape: 'sphere', radius: 0.02, mass, collisionGroups: 0 },
  });
const turnAbout = (axis: readonly number[], angle: number): Quat => {
  const s = Math.sin(angle / 2);
  return [axis[0]! * s, axis[1]! * s, axis[2]! * s, Math.cos(angle / 2)];
};
const times = (a: readonly number[], b: readonly number[]): Quat => [
  a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
  a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
  a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
  a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
];
const conjugate = (q: readonly number[]): Quat => [-q[0]!, -q[1]!, -q[2]!, q[3]!];
const turnVector = (q: readonly number[], v: readonly number[]): [number, number, number] => {
  const r = times(times(q, [v[0]!, v[1]!, v[2]!, 0]), conjugate(q));
  return [r[0], r[1], r[2]];
};
const X: [number, number, number] = [1, 0, 0],
  Y: [number, number, number] = [0, 1, 0],
  Z: [number, number, number] = [0, 0, 1];

/** Pose of {@link togglePressRig}: the knee from the crank, the rest from the solver. */
export interface TogglePressRigPose {
  /** The links' angle from the vertical, radians. */
  angle: number;
  /** The knee's offset across the line of the pivot and the ram, and its drop below the pivot, metres. */
  knee: number;
  drop: number;
  /** The ram's drop below the fixed pivot, and the lower link's angle from the vertical. */
  ram: number;
  lower: number;
  /** Ram force per unit of the force pushing the knee across, from the solver's geometry. */
  advantage: number;
}

class TogglePress extends Rig<TogglePressRigPose> {
  private readonly lower: PhysicsBody;
  private readonly ram: PhysicsBody;
  constructor(
    private readonly link: number,
    options: RigOptions,
  ) {
    super('m', options);
    const t = this.input,
      knee: [number, number, number] = [link * Math.sin(t), -link * Math.cos(t), 0],
      ram: [number, number, number] = [0, 2 * knee[1], 0],
      physics = this.physics;
    // The crank is the upper link, hanging from the fixed pivot; the lower link joins its knee to the ram on its slide.
    this.lower = point(physics, knee);
    this.ram = point(physics, ram);
    physics.addJoint(this.crank, this.lower, { type: 'revolute', axis: Z, anchorA: [0, -link, 0] });
    physics.addJoint(this.lower, this.ram, { type: 'revolute', axis: Z, anchorA: [-knee[0], ram[1] - knee[1], 0] });
    physics.addJoint(this.ground, this.ram, { type: 'prismatic', axis: Y, anchorA: ram });
  }
  protected gap(): number {
    return Math.abs(-this.ram.position[1] - togglePressPose(this.link * Math.sin(this.input), this.link).ram);
  }
  pose(): TogglePressRigPose {
    const t = zAngle(this.crank.rotation),
      knee = this.link * Math.sin(t),
      drop = this.link * Math.cos(t),
      ram = -this.ram.position[1],
      k = this.lower.position;
    return {
      angle: this.input,
      knee,
      drop,
      ram,
      lower: Math.atan2(k[0] - this.ram.position[0], k[1] - this.ram.position[1]),
      advantage: knee === 0 ? Infinity : (ram - drop) / (2 * Math.abs(knee)),
    };
  }
}

/**
 * A symmetric toggle press: two links `link` metres long, the upper one the crank swung `angle` radians from the vertical about
 * the fixed pivot, the lower one pinned to a ram on a vertical slide. The ram's drop is the solver's; the check is against
 * {@link togglePressPose} for the knee `link sin(angle)` across.
 */
export function togglePressRig(link: number, options: RigOptions = {}): MechanismRig<TogglePressRigPose> {
  if (!(link > 0 && Number.isFinite(link))) throw new RangeError(`Link length must be above 0; got ${link}.`);
  return new TogglePress(link, options);
}

/** Options of {@link gimbalRig}. */
export interface GimbalRigOptions extends RigOptions {
  /** The axis the mount tilts about, in the room's frame. */
  mountAxis: readonly number[];
  /** The rotor axis the rig starts holding, in the room's frame (default +z). */
  target?: readonly number[];
  /** Rings clamped at 0, so the rotor turns with the mount (default false). */
  locked?: boolean;
}
/** Pose of {@link gimbalRig}: the rings' angles and the rotor's axis, from the solver. */
export interface GimbalRigPose {
  tilt: number;
  /** The mount's turn as a quaternion [x, y, z, w]. */
  mount: Quat;
  /** The outer ring's angle about the mount's y and the inner ring's about the outer ring's x. */
  outer: number;
  inner: number;
  /** The rotor's axis in the room's frame and its angle from the target, radians. */
  axis: [number, number, number];
  deviation: number;
}

class Gimbal extends Rig<GimbalRigPose> {
  private readonly mount: PhysicsBody;
  private readonly outer: PhysicsBody;
  private readonly inner: PhysicsBody;
  private readonly rotor: PhysicsBody;
  private readonly axis: [number, number, number];
  private readonly target: [number, number, number];
  constructor(
    private readonly locked: boolean,
    options: GimbalRigOptions,
  ) {
    super('rad', options);
    const start = gimbalPose(this.input, { mountAxis: options.mountAxis, target: options.target, locked });
    const n = Math.hypot(...(options.target ?? Z));
    this.target = (options.target ?? Z).map((v) => v / n) as [number, number, number];
    this.axis = options.mountAxis.map((v) => v / Math.hypot(...options.mountAxis)) as [number, number, number];
    const physics = this.physics,
      mount = start.mount,
      outer = times(mount, turnAbout(Y, start.outer)),
      inner = times(outer, turnAbout(X, start.inner));
    this.mount = physics.addBody(null, { type: 'kinematicPosition', position: [0, 0, 0], rotation: mount, colliders: [] });
    // Light rings on frictionless hinges about the mount's y and the outer ring's x, and a heavy rotor free about its own z.
    this.outer = point(physics, [0, 0, 0], outer, 1e-4);
    this.inner = point(physics, [0, 0, 0], inner, 1e-4);
    this.rotor = physics.addBody(null, {
      type: 'dynamic',
      position: [0, 0, 0],
      rotation: inner,
      colliders: { shape: 'cylinder', radius: 0.05, halfHeight: 0.01, mass: 1, collisionGroups: 0 },
    });
    const toY = turnAbout(Z, Math.PI / 2),
      toZ = turnAbout(Y, -Math.PI / 2),
      none: Quat = [0, 0, 0, 1];
    if (locked) {
      physics.addJoint(this.mount, this.outer, { type: 'fixed' });
      physics.addJoint(this.outer, this.inner, { type: 'fixed' });
    } else {
      physics.addJoint(this.mount, this.outer, { type: 'revolute', frameA: toY, frameB: toY });
      physics.addJoint(this.outer, this.inner, { type: 'revolute', frameA: none, frameB: none });
    }
    physics.addJoint(this.inner, this.rotor, { type: 'revolute', frameA: toZ, frameB: toZ });
  }
  protected override beforeStep(angle: number): void {
    this.mount.setNextRotation(turnAbout(this.axis, angle));
  }
  private rotorAxis(): [number, number, number] {
    return turnVector(this.rotor.rotation, Z);
  }
  protected gap(): number {
    const exact = gimbalPose(this.input, { mountAxis: this.axis, target: this.target, locked: this.locked }).axis,
      a = this.rotorAxis();
    return Math.acos(Math.min(1, Math.max(-1, a[0] * exact[0] + a[1] * exact[1] + a[2] * exact[2])));
  }
  pose(): GimbalRigPose {
    const ring = times(conjugate(this.mount.rotation), this.outer.rotation),
      cross = times(conjugate(this.outer.rotation), this.inner.rotation),
      axis = this.rotorAxis(),
      t = this.target;
    return {
      tilt: this.input,
      mount: [...this.mount.rotation] as Quat,
      outer: 2 * Math.atan2(ring[1], ring[3]),
      inner: 2 * Math.atan2(cross[0], cross[3]),
      axis,
      deviation: Math.acos(Math.min(1, Math.max(-1, axis[0] * t[0] + axis[1] * t[1] + axis[2] * t[2]))),
    };
  }
}

/**
 * A two-ring gimbal on a mount the input tilts about `mountAxis`: light rings on frictionless hinges (outer about the mount's y,
 * inner about the outer's x) and a rotor free about its own axis, so the solver leaves the rotor where it points while the mount
 * turns under it. With `locked` the rings are fixed and the rotor turns with the mount. The check is the rotor's axis against
 * {@link gimbalPose}.
 */
export function gimbalRig(options: GimbalRigOptions): MechanismRig<GimbalRigPose> {
  const k = options.mountAxis;
  if (!(k && k.length === 3 && k.every(Number.isFinite) && Math.hypot(k[0]!, k[1]!, k[2]!) > 0))
    throw new RangeError('The mount axis must be a nonzero finite vector of three numbers.');
  return new Gimbal(Boolean(options.locked), options);
}

/** Options of {@link differentialRig}. */
export interface DifferentialRigOptions extends RigOptions {
  /** Teeth of the side gears and of the spider pinions. */
  sideTeeth: number;
  pinionTeeth: number;
  /** How far the left wheel runs ahead of the carrier per radian the carrier turns, `half track x curvature` (default 0). */
  split?: number;
}
/** Pose of {@link differentialRig}: the carrier, the two side gears and a spider's turn on its pin, from the solver. */
export interface DifferentialRigPose {
  carrier: number;
  left: number;
  right: number;
  /** The spider pinion's angle on its pin, relative to the carrier. */
  pinion: number;
  /** The left side's lead over the carrier. */
  offset: number;
}

class Differential extends Rig<DifferentialRigPose> {
  private readonly tree: import('@margoengine/physics').Multibody;
  private readonly road: PhysicsBody;
  private roadAngle: number;
  private offset = 0;
  private split: number;
  constructor(
    private readonly teeth: { side: number; pinion: number },
    split: number,
    options: RigOptions,
  ) {
    super('rad', options);
    this.split = split;
    this.roadAngle = this.input;
    const physics = this.physics,
      module = physicsModule();
    // The side gears turn in the carrier's bearings and a spider on its pin, so their joint coordinates are relative to the carrier,
    // and the bevel meshes are couplings of those coordinates: left + right = 0 (equal sides) and spider + (zs / zp) left fixed.
    const left = point(physics, [0, 0, 0.5]),
      right = point(physics, [0, 0, -0.5]),
      spider = point(physics, [0.3, 0, 0]);
    this.tree = physics.addMultibody(this.crank, [
      { body: left, parent: this.crank, joint: { type: 'revolute', axis: Z, anchorA: [0, 0, 0.5] } },
      { body: right, parent: this.crank, joint: { type: 'revolute', axis: Z, anchorA: [0, 0, -0.5] } },
      { body: spider, parent: this.crank, joint: { type: 'revolute', axis: X, anchorA: [0.3, 0, 0] } },
    ]);
    module.coupleDofs(physics, this.tree, left, right, { ratio: 1 });
    module.coupleDofs(physics, this.tree, spider, left, { ratio: -teeth.side / teeth.pinion });
    // The road under the left wheel: a roller the left side is geared to one for one, turned at (1 + split) times the carrier.
    this.road = physics.addBody(null, { type: 'kinematicPosition', position: [0, 0, 1], rotation: zTurn(this.input), colliders: [] });
    new module.GearJoint(physics, left, this.road, { ratio: -1 });
  }
  /** Sets how far the left wheel runs ahead per radian of the carrier from now on (a new steering angle). */
  setSplit(split: number): void {
    this.split = finite(split, 'Split');
  }
  protected override beforeStep(angle: number): void {
    const turn = angle - this.input;
    this.offset += this.split * turn;
    this.roadAngle += (1 + this.split) * turn;
    this.road.setNextRotation(zTurn(this.roadAngle));
  }
  protected gap(): number {
    const [l = 0, r = 0, p = 0] = this.tree.coordinates(),
      exact = differentialPose(0, this.offset, this.teeth);
    return Math.max(Math.abs(l - exact.left), Math.abs(r - exact.right), Math.abs(p - exact.pinion));
  }
  pose(): DifferentialRigPose {
    const [l = 0, r = 0, p = 0] = this.tree.coordinates(),
      carrier = this.input;
    return { carrier, left: carrier + l, right: carrier + r, pinion: p, offset: l };
  }
}

/** A differential rig, from {@link differentialRig}: its world, and the turn it is driven through. */
export interface DifferentialRig extends MechanismRig<DifferentialRigPose> {
  /** Sets how far the left wheel runs ahead of the carrier per radian it turns from now on (half track times curvature). */
  setSplit(split: number): void;
}

/**
 * An open bevel-gear differential: the carrier is the input, the side gears and a spider pinion are a multibody tree on it whose
 * meshes are couplings of their joint coordinates (Rapier's multibody DOF couplings), and the road turns the left side through a
 * gear at `1 + split` times the carrier, so the right side and the spider are what the gears make of it. The check is against
 * {@link differentialPose} for the lead the road has given.
 */
export function differentialRig(options: DifferentialRigOptions): DifferentialRig {
  const side = options.sideTeeth,
    pinion = options.pinionTeeth;
  differentialPose(0, 0, { side, pinion });
  return new Differential({ side, pinion }, finite(options.split ?? 0, 'Split'), options);
}

/** Options of {@link wattGovernorRig}. */
export interface WattGovernorRigOptions extends WattGovernorSpec {
  /** The spindle's speed the rig starts settled at, revolutions a minute (default 0: the arms on their stop). */
  rpm?: number;
  /** Drag on each arm's hinge per unit of the arm's inertia, 1/s (default 3.5: a swing dies in about two seconds). */
  damping?: number;
  /** The stop the arms rest on at low speed, radians from the spindle (default 0.05). */
  rest?: number;
  /** Disposes the rig when it aborts (default none). */
  signal?: AbortSignal;
}
/** Pose of {@link wattGovernorRig}: the arms from the solver, and the linkage from their angle. */
export interface WattGovernorRigPose {
  /** The spindle's angle, unwrapped, and its speed in rpm. */
  spindle: number;
  rpm: number;
  /** The two arms' angles from the spindle and their mean, radians. */
  arms: [number, number];
  arm: number;
  /** Each ball's distance out from the spindle and drop below the pivot, from the mean arm. */
  radius: number;
  drop: number;
  /** The link's joint on the arm (out, down) and the sleeve's drop below the pivot, when the linkage is given. */
  joint?: [number, number];
  sleeve?: number;
  /** Maxwell's equilibrium at this speed, held up by the stop. */
  equilibrium: number;
}
/** A Watt governor spinning under gravity, from {@link wattGovernorRig}. */
export interface WattGovernorRig extends Disposable {
  readonly physics: Physics;
  /** The arms against Maxwell's equilibrium for the speed now: `last` shrinks as they settle. */
  readonly check: RigCheck;
  /** Spins the spindle at `rpm` for `seconds` of the world's time and returns the pose. */
  spin(rpm: number, seconds: number): WattGovernorRigPose;
  /** Spins at `rpm` until the arms are within `tolerance` radians of equilibrium and still (default 1e-4), at most `limit` s (default 60). */
  settle(rpm: number, tolerance?: number, limit?: number): WattGovernorRigPose;
  pose(): WattGovernorRigPose;
  dispose(): void;
}

class Governor implements WattGovernorRig {
  readonly physics: Physics;
  readonly check: RigCheck = { worst: 0, last: 0, ever: 0, unit: 'rad', steps: 0 };
  private readonly spindle: PhysicsBody;
  private readonly balls: PhysicsBody[];
  private readonly dt: number;
  private readonly rest: number;
  private time = 0;
  private angle = 0;
  private rpm: number;
  constructor(
    private readonly spec: WattGovernorSpec,
    options: WattGovernorRigOptions,
  ) {
    options.signal?.throwIfAborted();
    this.rpm = this.speed(options.rpm ?? 0);
    this.rest = finite(options.rest ?? 0.05, 'Rest angle');
    if (!(this.rest >= 0 && this.rest < Math.PI / 2)) throw new RangeError(`The stop is from 0 to pi/2; got ${this.rest}.`);
    const damping = finite(options.damping ?? 3.5, 'Damping');
    if (!(damping >= 0)) throw new RangeError(`Damping must be 0 or more; got ${damping}.`);
    const L = spec.arm,
      omega = (this.rpm * Math.PI) / 30,
      start = this.exact(omega),
      physics = new (physicsModule().Physics)(null, { substeps: 32 });
    physics.gravity = [0, 0, -(spec.gravity ?? 9.80665)];
    this.physics = physics;
    this.dt = physics.fixedTimestep;
    this.spindle = physics.addBody(null, { type: 'kinematicPosition', position: [0, 0, 0], colliders: [] });
    // Each ball is a point mass on a light arm (Maxwell's model), hinged to the spindle at the pivot about the spindle's
    // tangent, so the swing is free and a drag on the hinge alone settles it without moving the balance.
    this.balls = [1, -1].map((side) => {
      const out = side * L * Math.sin(start),
        down = -L * Math.cos(start),
        ball = point(physics, [out, 0, down]);
      ball.setMassProperties({ mass: 1, inertia: [1e-5 * L * L, 1e-5 * L * L, 1e-5 * L * L] });
      ball.setLinearVelocity([0, omega * out, 0]);
      ball.setAngularVelocity([0, 0, omega]);
      const hinge = physics.addJoint(this.spindle, ball, { type: 'revolute', axis: [0, -side, 0], anchorB: [-out, 0, -down] });
      hinge.setLimits(this.rest - start, Math.PI / 2 - start);
      if (damping > 0) hinge.setDamping(damping * L * L);
      return ball;
    });
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true });
  }
  private speed(rpm: number): number {
    if (!(rpm >= 0 && Number.isFinite(rpm))) throw new RangeError(`Spindle speed must be 0 or more rpm; got ${rpm}.`);
    return rpm;
  }
  private exact(omega: number): number {
    return Math.max(this.rest, wattGovernorEquilibrium(omega, this.spec).angle);
  }
  private arms(): [number, number] {
    const angle = (ball: PhysicsBody) => {
      const p = ball.position;
      return Math.atan2(Math.hypot(p[0], p[1]), -p[2]);
    };
    return [angle(this.balls[0]!), angle(this.balls[1]!)];
  }
  spin(rpm: number, seconds: number): WattGovernorRigPose {
    this.rpm = this.speed(rpm);
    if (!(seconds >= 0 && Number.isFinite(seconds))) throw new RangeError(`Time runs forward; got ${seconds} s.`);
    const omega = (rpm * Math.PI) / 30,
      exact = this.exact(omega);
    this.time += seconds;
    this.check.worst = 0;
    while (this.time >= this.dt * (1 - 1e-9)) {
      this.time -= this.dt;
      this.angle += omega * this.dt;
      this.spindle.setNextRotation(zTurn(this.angle));
      this.physics.step();
      const [a, b] = this.arms(),
        gap = Math.max(Math.abs(a - exact), Math.abs(b - exact));
      this.check.steps++;
      this.check.last = gap;
      this.check.worst = Math.max(this.check.worst, gap);
      this.check.ever = Math.max(this.check.ever, gap);
    }
    return this.pose();
  }
  settle(rpm: number, tolerance = 1e-4, limit = 60): WattGovernorRigPose {
    let before = Infinity;
    for (let run = 0; run < limit; run += 0.25) {
      this.spin(rpm, 0.25);
      if (this.check.worst < tolerance && Math.abs(this.check.last - before) < tolerance / 10) break;
      before = this.check.last;
    }
    return this.pose();
  }
  pose(): WattGovernorRigPose {
    const arms = this.arms(),
      arm = (arms[0] + arms[1]) / 2,
      L = this.spec.arm,
      out: WattGovernorRigPose = {
        spindle: this.angle,
        rpm: this.rpm,
        arms,
        arm,
        radius: L * Math.sin(arm),
        drop: L * Math.cos(arm),
        equilibrium: this.exact((this.rpm * Math.PI) / 30),
      };
    const { pickoff, link } = this.spec;
    if (pickoff !== undefined && link !== undefined) {
      const joint: [number, number] = [pickoff * Math.sin(arm), pickoff * Math.cos(arm)];
      out.joint = joint;
      out.sleeve = joint[1] + Math.sqrt(Math.max(0, link * link - joint[0] * joint[0]));
    }
    return out;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
  dispose(): void {
    this.physics.dispose();
  }
}

/**
 * A Watt flyball governor under gravity: the spindle turns at the speed given, two balls on hinged arms swing out until the
 * centrifugal pull balances their weight, and the drag on the hinges settles them there. The arms are the solver's; the check is
 * against Maxwell's equilibrium `w^2 L cos(a) = g` (Maxwell 1868, {@link wattGovernorEquilibrium}).
 */
export function wattGovernorRig(options: WattGovernorRigOptions): WattGovernorRig {
  wattGovernorEquilibrium(0, options);
  return new Governor(
    { arm: options.arm, pickoff: options.pickoff, link: options.link, gravity: options.gravity },
    options,
  );
}

/** Options of {@link roseEngineRig}. */
export interface RoseEngineRigOptions extends RigOptions {
  /** The tool's distance from the spindle with the rosette swing at zero, metres (default 1). */
  toolRadius?: number;
  /** Points round the rosette groove, 8 or more (default 720). */
  points?: number;
}
/** Pose of {@link roseEngineRig}: the rocking headstock and the cut, from the solver. */
export interface RoseEngineRigPose {
  /** The spindle angle, unwrapped. */
  angle: number;
  /** The headstock rock off its rest line, metres. */
  shift: number;
  /** Where the work turns under the tool: the angle in the work frame. */
  contact: number;
  /** The point the tool cuts in the work frame. */
  cut: [number, number];
  /** The spindle angle over which the pattern repeats. */
  period: number;
}

class RoseEngine extends Rig<RoseEngineRigPose> {
  private readonly follower: PhysicsBody;
  constructor(
    private readonly rosette: Rosette,
    private readonly toolRadius: number,
    points: number,
    options: RigOptions,
  ) {
    super('m', options);
    const module = physicsModule(),
      groove = Array.from({ length: points }, (_, i): [number, number, number] => {
        const phi = (i * 2 * Math.PI) / points,
          radius = toolRadius + rosetteModulation(rosette, phi);
        return [radius * Math.cos(phi), radius * Math.sin(phi), 0];
      }),
      start: [number, number, number] = [toolRadius + rosetteModulation(rosette, -this.input), 0, 0.2];
    // The rosette is the turning cam and its groove a closed path in its frame. The headstock rides a slide along x and is held to
    // the groove by a point 0.2 m off its centre, the way a real follower pin sits off the axis of its slide.
    this.follower = point(this.physics, start);
    this.physics.addJoint(this.ground, this.follower, { type: 'prismatic', axis: [1, 0, 0], anchorA: start });
    new module.PathJoint(this.physics, this.crank, this.follower, { points: groove, closed: true, anchor: [0, 0, -0.2] });
  }
  protected gap(): number {
    return Math.abs(this.follower.position[0] - (this.toolRadius + rosetteModulation(this.rosette, -this.input)));
  }
  pose(): RoseEngineRigPose {
    const x = this.follower.position[0],
      contact = -this.input;
    return {
      angle: this.input,
      shift: this.toolRadius - x,
      contact,
      cut: [x * Math.cos(contact), x * Math.sin(contact)],
      period: (2 * Math.PI) / this.rosette.lobes,
    };
  }
}

/**
 * A rose engine: the spindle turns a rosette whose groove (radius `toolRadius + m(t)`, {@link rosetteModulation}) holds a follower
 * on the headstock slide, so the headstock rocks `m` as the work turns under a fixed tool and the tool cuts the rosette curve.
 * The follower is a dynamic body on a slide held to the groove by a path joint on the turning cam; the rock and the cut are the
 * solver's, and the check is the follower against `toolRadius + m(-angle)` ({@link roseEnginePose}).
 */
export function roseEngineRig(rosette: Rosette, options: RoseEngineRigOptions = {}): MechanismRig<RoseEngineRigPose> {
  const toolRadius = finite(options.toolRadius ?? 1, 'Tool radius'),
    points = finite(options.points ?? 720, 'Groove points');
  roseEnginePose(0, rosette, toolRadius);
  if (!(toolRadius > Math.abs(rosette.amplitude) + Math.abs(rosette.overtone ?? 0)))
    throw new RangeError(`The tool radius must exceed the rosette swing; got ${toolRadius}.`);
  if (!(Number.isInteger(points) && points >= 8)) throw new RangeError(`The groove needs 8 or more points; got ${points}.`);
  return new RoseEngine(rosette, toolRadius, points, options);
}

/** Options of {@link reuleauxRig}. */
export interface ReuleauxRigOptions extends RigOptions {
  /** Points an arc of the triangle collision hull, 4 or more (default 64: the chord is 15 um off the arc at 0.456 m). */
  subdivisions?: number;
}
/** Pose of {@link reuleauxRig}, as {@link ReuleauxPose}: the centre and the contacts the solver triangle makes with the square. */
export interface ReuleauxRigPose {
  angle: number;
  center: [number, number];
  contacts: [[number, number], [number, number], [number, number], [number, number]];
  span: [number, number];
}

class Reuleaux extends Rig<ReuleauxRigPose> {
  private readonly triangle: PhysicsBody;
  constructor(
    private readonly width: number,
    subdivisions: number,
    options: RigOptions,
  ) {
    super('m', options);
    const physics = this.physics,
      half = width / 2,
      thick = 0.2,
      hull = reuleauxOutline(width, subdivisions).flatMap(([x, y]) => [x, y, -0.02, x, y, 0.02]),
      start = reuleauxPose(this.input, width).center;
    // The square is four fixed walls a width apart; the triangle is a convex hull free in the plane with its turn locked to the
    // input, so the contacts with the walls alone place its centre (it touches all four at every angle).
    for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
      physics.addBody(null, {
        type: 'fixed',
        position: [x * (half + thick), y * (half + thick), 0],
        colliders: { shape: 'box', halfExtents: x ? [thick, half + 2 * thick, 0.05] : [half + 2 * thick, thick, 0.05] },
      });
    this.triangle = physics.addBody(null, {
      type: 'dynamic',
      position: [start[0], start[1], 0],
      rotation: zTurn(this.input),
      colliders: { shape: 'convexHull', points: hull, mass: 1 },
    });
    physics.addJoint(this.crank, this.triangle, { type: 'generic', locked: ['linZ', 'angX', 'angY', 'angZ'] });
  }
  protected gap(): number {
    const exact = reuleauxPose(this.input, this.width).center,
      p = this.triangle.position;
    return Math.hypot(p[0] - exact[0], p[1] - exact[1]);
  }
  pose(): ReuleauxRigPose {
    const exact = reuleauxPose(this.input, this.width),
      p = this.triangle.position,
      center: [number, number] = [p[0], p[1]],
      move = [center[0] - exact.center[0], center[1] - exact.center[1]],
      contacts = exact.contacts.map(([x, y]): [number, number] => [x + move[0]!, y + move[1]!]) as ReuleauxRigPose['contacts'];
    return { angle: this.input, center, contacts, span: [contacts[0][0] - contacts[2][0], contacts[1][1] - contacts[3][1]] };
  }
}

/**
 * A Reuleaux triangle of `width` turning in a square of the same side: four fixed walls and a convex-hull triangle whose turn is
 * locked to the input and whose centre is free in the plane, so the solver contacts with the walls place it. The centre and the
 * contacts are the solver's; the check is the centre against {@link reuleauxPose}.
 */
export function reuleauxRig(width: number, options: ReuleauxRigOptions = {}): MechanismRig<ReuleauxRigPose> {
  if (!(width > 0 && Number.isFinite(width))) throw new RangeError(`Width must be above 0; got ${width}.`);
  const subdivisions = finite(options.subdivisions ?? 64, 'Subdivisions');
  if (!(Number.isInteger(subdivisions) && subdivisions >= 4)) throw new RangeError(`An arc needs 4 or more subdivisions; got ${subdivisions}.`);
  return new Reuleaux(width, subdivisions, options);
}

/**
 * A gap of the check as short text for a readout, the largest since the rig was made unless `which` names another (`'last'` for a
 * rig that settles, as a governor does): micrometres for a length, thousandths of a degree for an angle (`'1.4 µm'`, `'0.004°'`).
 */
export function describeCheck(check: RigCheck, which: 'ever' | 'last' | 'worst' = 'ever'): string {
  const gap = check[which];
  return check.unit === 'm' ? `${(gap * 1e6).toFixed(1)} µm` : `${((gap * 180) / Math.PI).toFixed(3)}°`;
}

/** Loads the solver and makes a rig: `await openRig(scotchYokeRig, 0.142, { angle })`. */
export async function openRig<Args extends unknown[], R>(make: (...args: Args) => R, ...args: Args): Promise<R> {
  await loadRigs();
  return make(...args);
}

/** A rig remade at the current input whenever its key (a held member, a shaft offset) changes, from {@link keyedRig}. */
export interface KeyedRig<Key, Pose> extends Disposable {
  /** Remakes the rig at `angle` when `key` differs from the last one, then drives it there like {@link MechanismRig.drive}. */
  drive(angle: number, key: Key, shortest?: boolean): Pose;
  /** The current rig's check, or null before the first drive. */
  readonly check: RigCheck | null;
  dispose(): void;
}

/**
 * A rig whose build parameters change while it runs: `make(key, angle)` builds it, and a drive with a new key disposes the old
 * world and builds the new one at the angle asked, so the mechanism is never stepped through a jump of its geometry. `signal`
 * disposes it on abort, after which `drive` throws the signal's reason (default none).
 */
export function keyedRig<Key, Pose>(
  make: (key: Key, angle: number) => MechanismRig<Pose>,
  options: { signal?: AbortSignal } = {},
): KeyedRig<Key, Pose> {
  let rig: MechanismRig<Pose> | null = null,
    current: Key | undefined;
  const { signal } = options;
  const keyed: KeyedRig<Key, Pose> = {
    drive(angle, key, shortest = true) {
      signal?.throwIfAborted();
      if (!rig || !Object.is(key, current)) {
        rig?.dispose();
        rig = make(key, angle);
        current = key;
      }
      return rig.drive(angle, shortest);
    },
    get check() {
      return rig?.check ?? null;
    },
    dispose() {
      rig?.dispose();
      rig = null;
    },
    [Symbol.dispose]() {
      this.dispose();
    },
  };
  signal?.addEventListener('abort', () => keyed.dispose(), { once: true });
  return keyed;
}

/**
 * A signed reading for a readout: `digits` decimals, a typographic minus or a plus, and no sign on zero (`'+53.2 mm'`,
 * `'−12.0°'`, `'0.0 mm'`). `value` is already in the unit shown.
 */
export function signedReading(value: number, unit: string, digits = 1): string {
  const rounded = Number(value.toFixed(digits)) || 0;
  return `${rounded < 0 ? '−' : rounded > 0 ? '+' : ''}${Math.abs(rounded).toFixed(digits)}${unit}`;
}
