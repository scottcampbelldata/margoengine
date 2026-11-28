// Mechanism rigs: the classic mechanisms of ./mechanisms.ts built as stepped @margoengine/physics worlds. The input shaft is a
// position-driven body (a servo: it reaches the angle it is given each fixed step), the followers are dynamic bodies held by the
// kernel's joints (hinges, sliders, a pin in a slot as a generic joint with two free axes, a gear coupling), and every step the
// bodies the solver moved are compared with the closed form, so a rig is a simulation and its own check. The joints are rows of
// the kernel's sequential-impulse solve (Catto, "Iterative Dynamics with Temporal Coherence", GDC 2005; Baraff, "Linear-Time Dynamics
// using Lagrange Multipliers", SIGGRAPH 1996); the closed forms are Reuleaux, "The Kinematics of Machinery", 1876, and Willis,
// "Principles of Mechanism", 1841. A Geneva wheel is held by its locking disc between strokes, modelled as the wheel made fixed
// while the pin is out of every slot, the way the convex arc of the disc holds it in the real drive.
import type { Physics, PhysicsBody, PhysicsJoint } from '@margoengine/physics';
import { epicyclicSpeeds, genevaPose, oldhamPose, scotchYokePose, type EpicyclicTeeth } from './mechanisms.js';

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
    this.maxStep = finite(options.maxStep ?? Math.PI / 90, 'Rig maxStep');
    if (!(this.maxStep > 0)) throw new RangeError(`Rig maxStep must be above 0; got ${this.maxStep}.`);
    this.check = { worst: 0, last: 0, ever: 0, unit, steps: 0 };
    const physics = new (physicsModule().Physics)(null);
    physics.gravity = [0, 0, 0];
    this.physics = physics;
    this.ground = physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: [] });
    this.crank = this.disc([0, 0, 0], this.input, 'kinematicPosition');
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

  drive(angle: number, shortest = true): Pose {
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
    return { driver: this.input, wheel: this.wheelAngle(), indexing: this.indexing(this.input) };
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

/**
 * The largest gap since the rig was made, as short text for a readout: micrometres for a length, thousandths of a degree for an
 * angle (`'1.4 µm'`, `'0.004°'`).
 */
export function describeCheck(check: RigCheck): string {
  return check.unit === 'm' ? `${(check.ever * 1e6).toFixed(1)} µm` : `${((check.ever * 180) / Math.PI).toFixed(3)}°`;
}
