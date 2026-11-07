/// <reference lib="esnext.disposable" preserve="true" />
// A character that stays on its feet on its own legs: it watches the capture point of its centre of mass (J. Pratt et al.,
// "Capture Point: A Step toward Humanoid Push Recovery", Humanoids 2006; the point where a step stops the fall of an
// inverted pendulum) and swings a foot there, in the manner of SIMBICON (K. Yin, K. Loken, M. van de Panne, SIGGRAPH 2007).
// Two-bone maths sets each leg's motors from where the hips should be to where its foot is. The weight goes through the
// stance legs as joint torques by the transpose of the leg's Jacobian (J. Pratt et al., "Virtual Model Control", 1997):
// equal and opposite pairs on the bones of each joint, so nothing from outside holds it up. `carry` is an outside force,
// off by default, and `carried` reports what it gave. The torques are forces for the whole step, so the solver gives them
// through its passes: M. Macklin et al., "Small Steps in Physics Simulation", SCA 2019, is the scheme of those passes. Written
// clean room from those papers; no engine's source was read.
import type { Mesh } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { conjugateQuaternion, multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import type { RagdollMotors } from './powered.js';
import type { Ragdoll, RagdollPart } from './ragdoll.js';

type Vec3 = [number, number, number];
/** Options of {@link addRagdollBalance}. */
export interface RagdollBalanceOptions {
  /** The two foot bones. Each foot's parent bone must be a knee hinge, as `humanoidProfile` builds. */
  feet: readonly [Mesh | RagdollPart, Mesh | RagdollPart];
  /** Seconds a step takes. Default 0.28. */
  stepTime?: number;
  /** How high a foot lifts, as a share of the leg's length. Default 0.15. */
  stepHeight?: number;
  /** How far the capture point may leave the feet before a step, as a share of the leg's length. Default 0.2. */
  stepTrigger?: number;
  /** Hip height held, as a share of the height the character was added at. Default 0.97: knees a little bent. */
  stance?: number;
  /** Share of the upper body's weight an outside force carries, 0 to 1. Default 0: it stands on its own legs. */
  carry?: number;
  /** Frequency in rad/s of the turn that holds the hips upright, answered through the legs by the ground. Default 10. */
  upright?: number;
  /** Largest turn that gives, in rad/s². A harder blow than this can hold knocks the character over. Default 40. */
  maxUpright?: number;
  /** Tilt of the hips in radians past which the character has fallen and every assist stops. Default 0.8. */
  fallTilt?: number;
  /** World gravity along up, in m/s². Default 9.81. */
  gravity?: number;
}

/** What a balancing character is doing. */
export type RagdollBalanceState = 'standing' | 'stepping' | 'fallen';

interface Leg {
  upper: RagdollPart;
  lower: RagdollPart;
  foot: RagdollPart;
  thigh: number;
  shin: number;
  /** Rest directions of the thigh and shin, and each bone's rest rotation in the world. */
  rest: Vec3;
  upperRest: number[];
  footRest: number[];
  /** The hip joint from the hips' origin, at rest. */
  hip: Vec3;
  /** Largest torque of the knee, N m: what the whole body's weight turns about it at the shorter of the leg's two levers. */
  kneeCap: number;
  /** Inertia of the shin and foot about the knee, as the motors reckon it, and the hinge angle the leg's motors were last set to. */
  kneeInertia: number;
  bend: number;
  /** How far the sole reaches forward and back of the ankle along the character's forward, and to each side. */
  sole: { front: number; back: number; left: number; right: number };
  /** The bend a straight hinge already has in the rig: the angle at the knee between thigh and shin, at hinge angle 0. */
  restBend: number;
  plant: Vec3;
  swing: { from: Vec3; to: Vec3; t: number } | null;
}

const add = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const minus = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const times = (a: ArrayLike<number>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const size = (a: ArrayLike<number>): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: ArrayLike<number>): Vec3 => times(a, 1 / size(a));
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const turnAbout = (axis: ArrayLike<number>, angle: number): number[] => {
  const sin = Math.sin(angle / 2);
  return [axis[0] * sin, axis[1] * sin, axis[2] * sin, Math.cos(angle / 2)];
};
/** Shortest turn from the unit `a` to the unit `b`. */
function arc(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const c = cross(a, b),
    w = 1 + dot(a, b),
    length = Math.hypot(c[0], c[1], c[2], w);
  return length < 1e-9 ? [1, 0, 0, 0] : [c[0] / length, c[1] / length, c[2] / length, w / length];
}
/** The acceleration a motor's cap allows by default: see RagdollMotorOptions.maxAcceleration. */
const MOTOR_ACCELERATION = 400;
/** What RagdollMotors keeps a bone within, of what it carries: its MASS_RATIO and INERTIA_RATIO. */
const MOTOR_MASS_RATIO = 8,
  MOTOR_INERTIA_RATIO = 10;
/** Frequency in rad/s of the hold on the hips' height, and of the pull of the centre of mass over the feet. */
const HEIGHT_FREQUENCY = 12,
  LEAN_FREQUENCY = 6;
/** Frequency in rad/s of the solver motor on a joint the rod motors cannot hold. */
const JOINT_FREQUENCY = 30;
/** Frequency in rad/s of the spring on a stance knee at its full strength, and the radians off its bend it needs to reach that. */
const KNEE_FREQUENCY = 50,
  KNEE_BAND = 0.15;
/** Seconds the character takes to sink from its pose to `stance`. */
const SETTLE_TIME = 0.9;
/**
 * Inertia added to each foot and shin, as a share of the whole mass times the leg's length squared. A torque given before
 * the solver runs spins a light bone first, and in a solver's few passes the spin rattles the bone and creeps the foot
 * along the floor before a body many times heavier can answer it. Without it every figure measured steps or falls.
 */
const LEG_INERTIA = 0.012;
/** Solver passes the character's island gets, the world's included, at the least: a world set higher keeps its own. */
const SOLVER_PASSES = 8;
/** The share of the line between the feet, from each end, that does not count as between them: a wide stance still steps. */
const STANCE_INSET = 0.25;
/** How much better one step must leave the capture point, as a share of `stepTrigger`, to outrank the foot left behind. */
const CLEARLY_BETTER = 0.25;
/** How far above a foot's lowest point its collider still counts as sole, as a share of the foot's length. */
const SOLE_HEIGHT = 0.1;
/** The share of what friction holds that the pull over the feet may use. */
const GRIP = 0.8;
const ease = (t: number): number => t * t * (3 - 2 * t);
const within = (value: number | undefined, fallback: number, low: number, high: number, name: string): number => {
  const v = value ?? fallback;
  if (!(v >= low && v <= high)) throw new RangeError(`Ragdoll balance ${name} must be from ${low} to ${high}.`);
  return v;
};

/** A character keeping its feet ({@link addRagdollBalance}). */
export class RagdollBalance {
  /** What the character is doing. */
  state: RagdollBalanceState = 'standing';
  /** Steps started so far. */
  steps = 0;
  /** Where a step now would stop the fall, in the world, on the ground. */
  capture: Vec3 = [0, 0, 0];
  /** Share of the whole body's weight the `carry` force gave at the last physics step: 0 unless `carry` is set. */
  carried = 0;
  private readonly legs: [Leg, Leg];
  private readonly upper: readonly RagdollPart[];
  private readonly standing: readonly number[];
  private readonly up: Vec3 = [0, 1, 0];
  private readonly forward: Vec3;
  private readonly total: number;
  /** Height of a planted ankle. */
  private floor: number;
  /** From the right ankle to the left at rest. */
  private readonly stanceLine: Vec3;
  /** Inertia of a foot about the ankle, for its motor in the air. */
  private readonly footInertia: number;
  /** The inertia to give each bone's solver motor; 0 for a bone the rod motors hold. */
  private readonly real: readonly number[];
  private readonly upperMass: number;
  /** Each bone's centre of mass in its own frame. */
  private readonly massPoints: readonly Vec3[];
  private readonly upperShare: number;
  private readonly height: number;
  private readonly natural: number;
  private readonly stepTime: number;
  private readonly lift: number;
  private readonly trigger: number;
  private readonly stance: number;
  private readonly carry: number;
  private readonly upright: number;
  private readonly maxUpright: number;
  private readonly fallTilt: number;
  private readonly gravity: number;
  private readonly hipsOverFeet: Vec3;
  private readonly off: () => void;
  private disposed = false;
  /** How far through {@link SETTLE_TIME}, 0 to 1. */
  private settled = 0;
  private stanceNow = 1;
  /** False until the first step, when added inertia takes effect: see {@link control}. */
  private primed = false;
  /** Each bone's force and torque for this step, xyz each, and what the bodies hold from the last. */
  private readonly wanted: Float64Array;
  private readonly given: Float64Array;
  /** The feet's colliders as they came, for {@link dispose}. */
  private readonly soles: { part: RagdollPart; shape: RagdollPart['shape'] }[] = [];
  /** Where the hips stood at the last step, and how they moved to get there: see {@link readHips}. */
  private hipsWere: { position: Vec3; rotation: number[] } | null = null;
  private hipsSpeed: Vec3 = [0, 0, 0];
  private hipsSpin: Vec3 = [0, 0, 0];

  /** @internal use {@link addRagdollBalance}. */
  constructor(
    private readonly ragdoll: Ragdoll,
    private readonly motors: RagdollMotors,
    options: RagdollBalanceOptions,
  ) {
    const bones = ragdoll.bones,
      hips = bones[0],
      find = (item: Mesh | RagdollPart): RagdollPart => {
        const node = item && 'body' in item ? item.node : item,
          part = bones.find((candidate) => candidate.node === node);
        if (!part) throw new RangeError('That node is not a bone of this ragdoll; pass feet from ragdoll.bones.');
        return part;
      };
    if (!Array.isArray(options?.feet) || options.feet.length !== 2)
      throw new TypeError('addRagdollBalance needs two feet: addRagdollBalance(ragdoll, motors, {feet: [left, right]}).');
    const leg = (item: Mesh | RagdollPart): Leg => {
      const foot = find(item),
        lower = bones[foot.parent],
        upper = lower && bones[lower.parent];
      if (!upper || upper === hips || lower.spec?.type !== 'hinge')
        throw new RangeError('Each foot needs a knee hinge and a thigh above it; build the ragdoll with humanoidProfile.');
      const hip = upper.body.position,
        knee = lower.body.position,
        ankle = foot.body.position;
      return {
        upper,
        lower,
        foot,
        thigh: size(minus(knee, hip)),
        shin: size(minus(ankle, knee)),
        rest: unit(minus(knee, hip)),
        upperRest: [...upper.body.rotation],
        footRest: [...foot.body.rotation],
        hip: minus(hip, hips.body.position),
        kneeCap: 0,
        kneeInertia: 0,
        bend: 0,
        restBend: Math.acos(Math.max(-1, Math.min(1, dot(unit(minus(knee, hip)), unit(minus(ankle, knee)))))),
        sole: { front: 0, back: 0, left: 0, right: 0 },
        plant: [ankle[0], ankle[1], ankle[2]],
        swing: null,
      };
    };
    this.legs = [leg(options.feet[0]), leg(options.feet[1])];
    const [left, right] = this.legs,
      inLegs = new Set(this.legs.flatMap(({ upper, lower, foot }) => [upper, lower, foot]));
    // Every other bone under a leg (toes) moves with its foot.
    for (const part of bones) if (inLegs.has(bones[part.parent])) inLegs.add(part);
    this.upper = bones.filter((part) => !inLegs.has(part));
    this.standing = [...hips.body.rotation];
    const reach = (left.thigh + left.shin + right.thigh + right.shin) / 2,
      centre = times(add(left.plant, right.plant), 0.5),
      sideways = minus(left.plant, right.plant);
    this.hipsOverFeet = minus(hips.body.position, centre);
    this.floor = dot(centre, this.up);
    this.stanceLine = sideways;
    // Left of a character is +x when it faces +z with y up: its forward is left x up.
    this.forward = unit(cross(unit(sideways), this.up));
    for (const one of this.legs) this.flatten(one);
    this.total = bones.reduce((sum, part) => sum + part.body.mass, 0);
    this.upperMass = this.upper.reduce((sum, part) => sum + part.body.mass, 0);
    this.upperShare = this.upperMass / this.total;
    this.height = dot(this.hipsOverFeet, this.up);
    this.massPoints = bones.map((part) => {
      const at = part.body.raw.localCom();
      return [at.x, at.y, at.z];
    });
    const massHeight = dot(minus(this.massCentre().position, centre), this.up);
    this.gravity = within(options.gravity, 9.81, 0.01, 1000, 'gravity');
    const legInertia = LEG_INERTIA * this.total * (left.thigh + left.shin) ** 2;
    const passes = Math.max(0, SOLVER_PASSES - ragdoll.physics.world.numSolverIterations);
    for (const part of bones) this.solverPasses(part, passes);
    for (const { foot, lower } of this.legs) for (const part of [foot, lower]) this.addInertia(part, legInertia);
    this.footInertia = this.realInertia(left.foot);
    this.real = bones.map((part, i) => {
      if (!i) return 0;
      return this.limbInertia(part) * MOTOR_ACCELERATION < this.limbWeight(part) ? this.realInertia(part) : 0;
    });
    for (const one of this.legs) {
      one.kneeCap = this.total * this.gravity * Math.min(one.thigh, one.shin);
      one.kneeInertia = this.limbInertia(one.lower);
    }
    this.natural = Math.sqrt(this.gravity / massHeight);
    this.stepTime = within(options.stepTime, 0.28, 0.05, 2, 'stepTime');
    this.lift = within(options.stepHeight, 0.15, 0, 1, 'stepHeight') * reach;
    this.trigger = within(options.stepTrigger, 0.2, 0, 2, 'stepTrigger') * reach;
    this.stance = within(options.stance, 0.97, 0.5, 1, 'stance');
    this.carry = within(options.carry, 0, 0, 1, 'carry');
    this.upright = within(options.upright, 10, 0, 1000, 'upright');
    this.maxUpright = within(options.maxUpright, 40, 0, 1e6, 'maxUpright');
    this.fallTilt = within(options.fallTilt, 0.8, 0.01, Math.PI, 'fallTilt');
    this.wanted = new Float64Array(bones.length * 6);
    this.given = new Float64Array(bones.length * 6);
    this.off = ragdoll.physics.on('beforestep', (dt) => this.step(dt));
  }

  /** Radians the hips lean from how they stood. */
  get tilt(): number {
    const up = rotateByQuaternion(
      this.up,
      multiplyQuaternions(this.ragdoll.bones[0].body.rotation, conjugateQuaternion(this.standing)),
    );
    return Math.acos(Math.min(1, Math.max(-1, dot(up, this.up))));
  }

  private step(dt: number): void {
    if (this.disposed || !this.ragdoll.bones[0].body.valid) return;
    this.wanted.fill(0);
    this.readHips(dt);
    this.control(dt);
    this.settle();
  }

  /**
   * How the hips moved over the last step, from where they went. The velocity a body reports at the end of a step holds what
   * the solver's last pass left in it: Seed-san's hips reported 0.02 m/s one way while they moved 0.008 m/s the other, and the
   * height's spring rang on that at half the frame rate.
   */
  private readHips(dt: number): void {
    const hips = this.ragdoll.bones[0].body,
      position: Vec3 = [hips.position[0], hips.position[1], hips.position[2]],
      rotation = [...hips.rotation],
      was = this.hipsWere;
    if (was) {
      const turn = multiplyQuaternions(rotation, conjugateQuaternion(was.rotation)),
        sign = turn[3] < 0 ? -2 / dt : 2 / dt;
      this.hipsSpeed = times(minus(position, was.position), 1 / dt);
      this.hipsSpin = [turn[0] * sign, turn[1] * sign, turn[2] * sign];
    } else {
      this.hipsSpeed = [hips.linearVelocity[0], hips.linearVelocity[1], hips.linearVelocity[2]];
      this.hipsSpin = [hips.angularVelocity[0], hips.angularVelocity[1], hips.angularVelocity[2]];
    }
    this.hipsWere = { position, rotation };
  }

  /**
   * Hands the bodies what this step wants as forces. A force goes through every solver pass; an impulse would land before the
   * first, where one pass's share of friction and of the sole's weight must take a whole step's kick, so more passes meant
   * less hold and the feet crept at the same speed on every figure. Only the change is added: a force stays until taken
   * off, and anyone else's stays on the body. A bone that is not dynamic holds its force out of reach, so it is cleared.
   */
  private settle(): void {
    const { wanted, given } = this;
    this.ragdoll.bones.forEach((part, i) => {
      const a = i * 6,
        body = part.body;
      if (body.type !== 'dynamic') {
        if (given.subarray(a, a + 6).some((value) => value !== 0)) body.resetForces(false);
        given.fill(0, a, a + 6);
        return;
      }
      const force: Vec3 = [wanted[a] - given[a], wanted[a + 1] - given[a + 1], wanted[a + 2] - given[a + 2]],
        torque: Vec3 = [wanted[a + 3] - given[a + 3], wanted[a + 4] - given[a + 4], wanted[a + 5] - given[a + 5]];
      if (force[0] || force[1] || force[2]) body.addForce(force);
      if (torque[0] || torque[1] || torque[2]) body.addTorque(torque);
      given.set(wanted.subarray(a, a + 6), a);
    });
  }

  /** Adds to what bone `part` is given this step, N and N m. */
  private give(part: RagdollPart, force: Vec3 | null, torque: Vec3 | null): void {
    const a = this.ragdoll.bones.indexOf(part) * 6;
    for (let k = 0; k < 3; k++) {
      if (force) this.wanted[a + k] += force[k];
      if (torque) this.wanted[a + 3 + k] += torque[k];
    }
  }

  private control(dt: number): void {
    if (this.state === 'fallen' || this.ragdoll.bones[0].body.type !== 'dynamic') return;
    if (this.tilt > this.fallTilt) {
      this.fall();
      return;
    }
    // A planted foot is where it is, not where it was sent.
    for (const leg of this.legs)
      if (!leg.swing) {
        const at = leg.foot.body.position;
        leg.plant = [at[0], at[1], at[2]];
      }
    this.capture = this.capturePoint();
    const [a, b] = this.legs,
      centre = times(add(a.plant, b.plant), 0.5),
      swinging = a.swing ? a : b.swing ? b : null;
    if (!swinging && this.outside(a.plant, b.plant, STANCE_INSET) > this.trigger) this.startStep();
    const moving = a.swing ? a : b.swing ? b : null;
    let support = centre;
    if (moving) {
      const other = moving === a ? b : a,
        t = ease(Math.min(1, moving.swing!.t)),
        landing = times(add(moving.swing!.to, other.plant), 0.5);
      support = add(times(centre, 1 - t), times(landing, t));
    }
    this.settled = Math.min(1, this.settled + dt / SETTLE_TIME);
    this.stanceNow = 1 + (this.stance - 1) * ease(this.settled) ** 2;
    const across = minus(this.hipsOverFeet, times(this.up, this.height)),
      hips = add(add(support, across), times(this.up, this.height * this.stanceNow));
    for (const leg of this.legs) this.driveLeg(leg, hips, dt);
    this.state = this.legs.some((leg) => leg.swing) ? 'stepping' : 'standing';
    this.holdJoints();
    // Added inertia counts from the first step. A torque given before it would spin a bone by its old, smaller inertia and
    // the solver would carry that spin at the new one: the kick left the floor on RiggedFigure and shook Knight for seconds.
    if (this.primed) this.carryWeight(dt, this.legs.filter((leg) => !leg.swing), support);
    this.primed = true;
    this.assist(dt, centre);
  }

  /** The centre of mass of the whole body, and its velocity. */
  private massCentre(): { position: Vec3; velocity: Vec3 } {
    const position: Vec3 = [0, 0, 0],
      velocity: Vec3 = [0, 0, 0];
    this.ragdoll.bones.forEach((part, i) => {
      const body = part.body,
        x = add(body.position, rotateByQuaternion(this.massPoints[i], body.rotation)),
        v = body.linearVelocity,
        m = body.mass;
      for (let k = 0; k < 3; k++) {
        position[k] += x[k] * m;
        velocity[k] += v[k] * m;
      }
    });
    return { position: times(position, 1 / this.total), velocity: times(velocity, 1 / this.total) };
  }

  /**
   * Motors whose caps come from a rod per body cannot hold a limb whose mass lies past its bone (a head on a short neck:
   * Knight's rod inertia is 0.003 kg m² against 0.96 real, so its cap of 1.1 N m loses to up to 12 N m of weight). These joints
   * get a solver motor from the limb's real inertia, and a swinging foot one that keeps it level. A stance knee has its torque
   * from {@link carryWeight} and only a spring beside it, with no damper and growing with how far the knee is off its bend: a
   * solver motor on a knee the body's weight goes through slid the feet along the floor, a body at rest included, in proportion
   * to its damping and stiffness (RiggedFigure 0.045 m in five seconds). Without the spring a thrown leg lands loose and
   * the character stumbles on. The listeners run in the order they were added, so this comes after the rod motors' own step
   * and replaces it.
   */
  private holdJoints(): void {
    const bones = this.ragdoll.bones,
      strength = this.motors.strength,
      motor = (inertia: number) => ({
        model: 'force' as const,
        stiffness: inertia * JOINT_FREQUENCY * JOINT_FREQUENCY * strength,
        damping: 2 * inertia * JOINT_FREQUENCY * Math.sqrt(strength),
        maxForce: inertia * MOTOR_ACCELERATION * strength,
      });
    bones.forEach((part, i) => {
      const inertia = this.real[i];
      if (inertia <= 0 || part.spec?.type === 'hinge' || this.legs.some((leg) => leg.foot === part)) return;
      const a = part.animated,
        target = multiplyQuaternions([a[3], a[4], a[5], a[6]], conjugateQuaternion(part.bind));
      part.joint!.setRotationMotor(target as [number, number, number, number], motor(inertia));
    });
    for (const leg of this.legs) {
      if (leg.swing) {
        leg.foot.joint!.setRotationMotor(
          multiplyQuaternions(conjugateQuaternion(leg.lower.body.rotation), leg.footRest) as [number, number, number, number],
          motor(this.real[bones.indexOf(leg.foot)] || this.footInertia),
        );
        continue;
      }
      const share = Math.min(1, Math.abs(leg.bend - this.kneeAngle(leg)) / KNEE_BAND) * strength;
      if (share > 0)
        leg.lower.joint!.setMotor({
          model: 'force',
          targetPosition: leg.bend,
          targetVelocity: 0,
          stiffness: leg.kneeInertia * KNEE_FREQUENCY * KNEE_FREQUENCY * share,
          damping: 0,
          maxForce: leg.kneeInertia * MOTOR_ACCELERATION * strength,
        });
      else leg.lower.joint!.clearMotor();
    }
  }

  /** The hinge angle the knee stands at. */
  private kneeAngle(leg: Leg): number {
    const axis = (leg.lower.spec as { axis: ArrayLike<number> }).axis,
      turn = multiplyQuaternions(
        conjugateQuaternion(leg.lower.rest),
        multiplyQuaternions(conjugateQuaternion(leg.upper.body.rotation), leg.lower.body.rotation),
      );
    return 2 * Math.atan2(dot(turn, axis), turn[3]);
  }

  /** Sets the solver passes a bone's island gets on top of the world's. Rapier's own call: the physics package has no wrapper. */
  private solverPasses(part: RagdollPart, passes: number): void {
    (part.body.raw as unknown as { setAdditionalSolverIterations(passes: number): void }).setAdditionalSolverIterations(passes);
  }

  /** Gives a bone `inertia` on top of what the motors added to it, which a call to set them would replace. */
  private addInertia(part: RagdollPart, inertia: number): void {
    const bones = this.ragdoll.bones,
      children = bones.filter((bone) => bones[bone.parent] === part),
      heaviest = Math.max(bones[part.parent]?.mass ?? 0, ...children.map((bone) => bone.mass)),
      limb = Math.max(0, ...children.map((bone) => this.limbInertia(bone))),
      total = inertia + limb / MOTOR_INERTIA_RATIO;
    part.body.setAdditionalMass(Math.max(0, heaviest / MOTOR_MASS_RATIO - part.mass), [total, total, total]);
  }

  /** True for a bone of a stance leg, which {@link carryWeight} holds. */
  private planted(part: RagdollPart): boolean {
    return this.legs.some((leg) => !leg.swing && (part === leg.upper || part === leg.lower || part === leg.foot));
  }

  /** Inertia of a bone and what hangs from it about its joint, as the motors reckon it: a rod per body. */
  private limbInertia(top: RagdollPart): number {
    const bones = this.ragdoll.bones,
      origin = top.body.position,
      from = bones.indexOf(top);
    let total = 0;
    for (let i = from; i < bones.length; i++) {
      let j = i;
      while (j > from) j = bones[j].parent;
      if (j !== from) continue;
      const part = bones[i],
        reach = rotateByQuaternion(part.axis, part.body.rotation),
        centre = add(part.body.position, times(reach, part.length / 2));
      total += part.body.mass * ((part.length * part.length) / 12 + dot(minus(centre, origin), minus(centre, origin)));
    }
    return total;
  }

  /** Inertia of a bone and what hangs from it about its joint, from where their mass really lies. */
  private realInertia(top: RagdollPart): number {
    const bones = this.ragdoll.bones,
      origin = top.body.position,
      from = bones.indexOf(top);
    let total = 0;
    for (let i = from; i < bones.length; i++) {
      let j = i;
      while (j > from) j = bones[j].parent;
      if (j !== from) continue;
      const body = bones[i].body,
        centre = add(body.position, rotateByQuaternion(this.massPoints[i], body.rotation)),
        own = body.raw.principalInertia();
      total += body.mass * dot(minus(centre, origin), minus(centre, origin)) + (own.x + own.y + own.z) / 3;
    }
    return total;
  }

  /** The largest moment the weight of a bone and what hangs from it can have about its joint, N m. */
  private limbWeight(top: RagdollPart): number {
    const bones = this.ragdoll.bones,
      from = bones.indexOf(top),
      moment: Vec3 = [0, 0, 0];
    let mass = 0;
    for (let i = from; i < bones.length; i++) {
      let j = i;
      while (j > from) j = bones[j].parent;
      if (j !== from) continue;
      const body = bones[i].body,
        centre = add(body.position, rotateByQuaternion(this.massPoints[i], body.rotation));
      mass += body.mass;
      for (let k = 0; k < 3; k++) moment[k] += body.mass * (centre[k] - top.body.position[k]);
    }
    return size(moment) * this.gravity;
  }

  /** How far the sole of a foot reaches from the ankle: the points of its collider near its lowest point. */
  private soleOf(leg: Leg): Leg['sole'] {
    const foot = leg.foot,
      shape = foot.shape,
      side = cross(this.up, this.forward),
      fallback = { front: foot.length / 2, back: foot.length / 2, left: foot.length / 4, right: foot.length / 4 };
    if (shape.type !== 'hull') return fallback;
    const points: Vec3[] = [];
    for (let i = 0; i + 2 < shape.points.length; i += 3)
      points.push(rotateByQuaternion([shape.points[i], shape.points[i + 1], shape.points[i + 2]], foot.body.rotation) as Vec3);
    const lowest = Math.min(...points.map((point) => dot(point, this.up))),
      sole = points.filter((point) => dot(point, this.up) < lowest + foot.length * SOLE_HEIGHT),
      along = sole.map((point) => dot(point, this.forward)),
      across = sole.map((point) => dot(point, side));
    return { front: Math.max(...along), back: -Math.min(...along), left: Math.max(...across), right: -Math.min(...across) };
  }

  /**
   * Gives a hull foot a sole of four corners on one plane, the box of what {@link soleOf} found, and keeps the rest of the
   * hull. A hull fitted to a boot has a sole of many points a few millimetres apart in height, and a contact keeps four of
   * them for the solver: which four changes with the slightest turn, so the foot rocked and dropped on a point left out,
   * and the body shook. Four corners are all kept, and they are the sole the ankle torques reckon with.
   */
  private flatten(leg: Leg): void {
    leg.sole = this.soleOf(leg);
    const foot = leg.foot,
      shape = foot.shape;
    if (shape.type !== 'hull') return;
    const turn = foot.body.rotation,
      back = conjugateQuaternion(turn),
      side = cross(this.up, this.forward),
      points: Vec3[] = [];
    for (let i = 0; i + 2 < shape.points.length; i += 3)
      points.push(rotateByQuaternion([shape.points[i], shape.points[i + 1], shape.points[i + 2]], turn) as Vec3);
    const lowest = Math.min(...points.map((point) => dot(point, this.up))),
      above = points.filter((point) => dot(point, this.up) >= lowest + foot.length * SOLE_HEIGHT),
      { front, back: heel, left, right } = leg.sole,
      corner = (along: number, across: number): Vec3 =>
        add(add(times(this.forward, along), times(side, across)), times(this.up, lowest)),
      corners = [corner(front, left), corner(front, -right), corner(-heel, left), corner(-heel, -right)];
    this.soles.push({ part: foot, shape });
    this.ragdoll.setShape(foot, {
      type: 'hull',
      points: [...corners, ...above].flatMap((point) => [...rotateByQuaternion(point, back)]),
    });
  }

  /**
   * Carries the body through the legs: the force and turn the stance legs must give at the hips to hold them at their
   * height, the centre of mass over the feet and the upper body upright, as joint torques by the transpose of the leg's
   * Jacobian (J. Pratt et al., "Virtual Model Control", 1997), each an equal and opposite pair on the two bones of its joint.
   */
  private carryWeight(dt: number, stance: readonly Leg[], support: Vec3): void {
    if (!stance.length) return;
    const { position, velocity } = this.massCentre(),
      hips = this.ragdoll.bones[0].body,
      bones = this.ragdoll.bones,
      count = stance.length,
      strength = this.motors.strength,
      side = cross(this.up, this.forward),
      friction = this.ragdoll.settings.friction,
      // Springs and dampers solved implicitly, as a stiff one would ring at this step.
      implicit = (w: number): number => 1 / (1 + 2 * w * dt + w * w * dt * dt),
      feet = times(stance.reduce((sum, leg) => add(sum, leg.plant), [0, 0, 0] as Vec3), 1 / count),
      want = dot(feet, this.up) + this.height * this.stanceNow,
      w = HEIGHT_FREQUENCY,
      rise = implicit(w) * (w * w * (want - dot(hips.position, this.up)) - 2 * w * dot(this.hipsSpeed, this.up)),
      h = LEAN_FREQUENCY,
      push = times(minus(times(minus(support, position), h * h), times(velocity, 2 * h)), implicit(h)),
      flat = minus(push, times(this.up, dot(push, this.up))),
      load = (this.total * Math.max(0, this.gravity + rise)) / count,
      wanted = (size(flat) * this.total) / count,
      shove = times(flat, (this.total / count) * Math.min(1, (GRIP * friction * load) / Math.max(wanted, 1e-9))),
      centreOf = (part: RagdollPart): Vec3 =>
        add(part.body.position, rotateByQuaternion(this.massPoints[bones.indexOf(part)], part.body.rotation)),
      lift = (part: RagdollPart): Vec3 => times(this.up, part.body.mass * this.gravity);
    // What the stance legs carry: every bone but their own.
    let carriedMass = 0;
    const carried: Vec3 = [0, 0, 0];
    for (const part of bones) {
      if (this.planted(part)) continue;
      const at = centreOf(part);
      carriedMass += part.body.mass;
      for (let k = 0; k < 3; k++) carried[k] += at[k] * part.body.mass;
    }
    const carriedAt = times(carried, 1 / carriedMass),
      lifted = carriedMass * Math.max(0, this.gravity + rise),
      // Two feet share the weight by where the centre of mass lies between them; only what lies off their line is the ankles' to hold.
      line = count === 2 ? minus(stance[1].plant, stance[0].plant) : ([0, 0, 0] as Vec3),
      span = minus(line, times(this.up, dot(line, this.up))),
      along = count === 2 ? Math.min(1, Math.max(0, dot(minus(position, stance[0].plant), span) / Math.max(dot(span, span), 1e-9))) : 0;
    const wants = stance.map((leg, i) => {
      const part = count === 2 ? (i ? along : 1 - along) : 1,
        weight = times(this.up, lifted * part),
        offLine = count === 2 ? times(span, i ? along - 1 : along) : ([0, 0, 0] as Vec3),
        hip = leg.upper.body.position,
        knee = leg.lower.body.position,
        ankle = leg.foot.body.position,
        thigh = centreOf(leg.upper),
        shin = centreOf(leg.lower),
        atKnee = add(add(cross(minus(carriedAt, knee), weight), cross(minus(thigh, knee), lift(leg.upper))), cross(minus(hip, knee), shove)),
        atAnkle = add(
          add(add(cross(minus(minus(carriedAt, offLine), ankle), weight), cross(minus(thigh, ankle), lift(leg.upper))), cross(minus(shin, ankle), lift(leg.lower))),
          cross(minus(hip, ankle), shove),
        );
      return { leg, atKnee, atAnkle, foot: load * count * part };
    });
    // The upper body's turn, and the moment the ground must answer it with.
    const { turn, points, centre } = this.uprightTurn(dt);
    let moment: Vec3 = [0, 0, 0];
    this.upper.forEach((part, i) => {
      const r = minus(points[i], centre);
      moment = add(moment, cross(r, times(cross(turn, r), part.body.mass)));
    });
    const torque = times(moment, 1 / (dt * count));
    // Standing, the ground holds no more than the sole reaches: the turn gives way to what the force needs. Pressing on the
    // toes turns the shin back, so forward of the ankle is the negative side of `side`. Through a step nothing is held back:
    // the foot may roll on its edge until the other lands, and the ground answers only what it can.
    const limited = count === 2;
    let share = 1;
    const room = (value: number, more: number, low: number, high: number): number => {
      if (Math.abs(more) < 1e-9) return 1;
      return Math.max(0, Math.min(1, ((more > 0 ? high : low) - value) / more));
    };
    if (limited)
      for (const { leg, atAnkle, foot } of wants) {
        share = Math.min(share, room(dot(atAnkle, side), dot(torque, side), -leg.sole.front * foot, leg.sole.back * foot));
        share = Math.min(share, room(dot(atAnkle, this.forward), dot(torque, this.forward), -leg.sole.right * foot, leg.sole.left * foot));
      }
    const held = times(torque, share),
      inside = (value: number, low: number, high: number): number => (limited ? Math.max(low, Math.min(high, value)) : value);
    this.upper.forEach((part, i) => this.give(part, times(cross(times(turn, share), minus(points[i], centre)), part.body.mass / dt), null));
    // The turn's reaction goes down through hip, knee and ankle to the foot: on the thighs alone the hip motors would cancel it.
    for (const { leg, atKnee, atAnkle, foot } of wants) {
      const axis = rotateByQuaternion((leg.lower.spec as { axis: ArrayLike<number> }).axis, leg.lower.body.rotation),
        bend = dot(add(atKnee, held), axis),
        kneeTorque = times(axis, Math.max(-leg.kneeCap, Math.min(leg.kneeCap, bend)) * strength),
        full = add(atAnkle, held),
        pitch = inside(dot(full, side), -leg.sole.front * foot, leg.sole.back * foot),
        roll = inside(dot(full, this.forward), -leg.sole.right * foot, leg.sole.left * foot),
        twistCap = 0.5 * friction * foot * leg.sole.left,
        twist = inside(dot(full, this.up), -twistCap, twistCap),
        ankleTorque = times(add(add(times(side, pitch), times(this.forward, roll)), times(this.up, twist)), strength);
      this.give(leg.upper, null, minus(kneeTorque, held));
      this.give(leg.lower, null, minus(ankleTorque, kneeTorque));
      this.give(leg.foot, null, times(ankleTorque, -1));
    }
  }

  /** The turn this step gives the upper body toward how it stood, about its own centre of mass. */
  private uprightTurn(dt: number): { turn: Vec3; points: Vec3[]; centre: Vec3 } {
    const hips = this.ragdoll.bones[0].body,
      error = multiplyQuaternions(this.standing, conjugateQuaternion(hips.rotation)),
      sign = error[3] < 0 ? -1 : 1,
      sin = Math.hypot(error[0], error[1], error[2]),
      angle = sin > 1e-9 ? (2 * Math.atan2(sin, error[3] * sign) * sign) / sin : 2 * sign,
      w = this.upright,
      c = 2 * w,
      gain = dt / (1 + c * dt + w * w * dt * dt),
      spin = this.hipsSpin,
      turn = [0, 1, 2].map((k) => gain * (w * w * error[k] * angle - c * spin[k])) as Vec3,
      cap = this.maxUpright * dt,
      strength = size(turn);
    if (strength > cap) for (let k = 0; k < 3; k++) turn[k] *= cap / strength;
    const bones = this.ragdoll.bones,
      points = this.upper.map((part) => add(part.body.position, rotateByQuaternion(this.massPoints[bones.indexOf(part)], part.body.rotation))),
      centre: Vec3 = [0, 0, 0];
    this.upper.forEach((part, i) => {
      for (let k = 0; k < 3; k++) centre[k] += (points[i][k] * part.body.mass) / this.upperMass;
    });
    return { turn, points, centre };
  }

  /** The capture point: the centre of mass plus its velocity over the pendulum's natural frequency, on the ground. */
  private capturePoint(): Vec3 {
    const { position, velocity } = this.massCentre(),
      point = add(position, times(velocity, 1 / this.natural)),
      ground = Math.min(dot(this.legs[0].plant, this.up), dot(this.legs[1].plant, this.up));
    return add(point, times(this.up, ground - dot(point, this.up)));
  }

  /** How far the capture point lies from the line between two planted feet, across the ground. */
  private outside(a: Vec3, b: Vec3, inset = 0): number {
    const line = minus(b, a),
      flat = minus(line, times(this.up, dot(line, this.up))),
      t = Math.min(1 - inset, Math.max(inset, dot(minus(this.capture, a), flat) / Math.max(dot(flat, flat), 1e-9))),
      gap = minus(this.capture, add(a, times(flat, t)));
    return size(minus(gap, times(this.up, dot(gap, this.up))));
  }

  private startStep(): void {
    const [a, b] = this.legs,
      toA = this.landing(a),
      toB = this.landing(b),
      inA = this.outside(toA, b.plant),
      inB = this.outside(toB, a.plant),
      // The step that leaves the capture point between the feet; between two as good, the foot left farther behind.
      first = Math.abs(inA - inB) > this.trigger * CLEARLY_BETTER ? inA < inB : size(minus(toA, a.plant)) >= size(minus(toB, b.plant)),
      leg = first ? a : b;
    leg.swing = { from: leg.plant, to: first ? toA : toB, t: 0 };
    this.steps++;
  }

  /** Where a step of `leg` lands: beside the capture point by half the rest stance, on the foot's own side. */
  private landing(leg: Leg): Vec3 {
    const hip = add(this.ragdoll.bones[0].body.position, leg.hip),
      height = this.height * this.stance,
      side = leg === this.legs[0] ? 0.5 : -0.5;
    let to = add(this.capture, times(this.stanceLine, side));
    to = add(to, times(this.up, this.floor - dot(to, this.up)));
    // No farther than the leg reaches from the hips at standing height.
    const room = Math.sqrt(Math.max(0, (leg.thigh + leg.shin) ** 2 * 0.9 - height * height)),
      flat = minus(to, hip),
      across = minus(flat, times(this.up, dot(flat, this.up))),
      length = size(across);
    if (length > room) to = add(to, times(across, room / length - 1));
    return to;
  }

  /** Sets a leg's motors so its foot reaches the plant or the swing from `hips`, where the hips should be. */
  private driveLeg(leg: Leg, hips: Vec3, dt: number): void {
    const motors = this.motors,
      body = this.ragdoll.bones[0].body;
    let target = leg.plant;
    if (leg.swing) {
      const swing = leg.swing;
      swing.t += dt / this.stepTime;
      const t = Math.min(1, swing.t),
        e = ease(t);
      target = add(add(times(swing.from, 1 - e), times(swing.to, e)), times(this.up, this.lift * Math.sin(Math.PI * t)));
      if (swing.t >= 1) leg.swing = null;
    }
    const line = minus(target, add(hips, leg.hip)),
      { thigh, shin } = leg,
      distance = Math.min(size(line), (thigh + shin) * 0.999),
      direction = unit(line),
      // Law of cosines for the knee, and for the thigh's angle off the hip-to-foot line.
      knee = Math.acos(Math.max(-1, Math.min(1, (thigh * thigh + shin * shin - distance * distance) / (2 * thigh * shin)))),
      lean = Math.acos(Math.max(-1, Math.min(1, (thigh * thigh + distance * distance - shin * shin) / (2 * thigh * distance)))),
      out = rotateByQuaternion(direction, turnAbout(unit(cross(direction, this.forward)), lean)),
      upper = multiplyQuaternions(arc(leg.rest, out), leg.upperRest),
      spec = leg.lower.spec as { axis: ArrayLike<number>; limits: readonly [number, number] },
      bend = Math.min(spec.limits[1], Math.max(spec.limits[0], Math.PI - knee - leg.restBend));
    motors.setTarget(leg.upper, multiplyQuaternions(conjugateQuaternion(body.rotation), upper));
    motors.setTarget(leg.lower, multiplyQuaternions(leg.lower.rest, turnAbout(spec.axis, bend)));
    motors.setTarget(leg.foot, multiplyQuaternions(conjugateQuaternion(leg.lower.body.rotation), leg.footRest));
    leg.bend = bend;
  }

  /** The outside help when `carry` is set: a capped force under the upper body, moved as one rigid body. */
  private assist(dt: number, centre: Vec3): void {
    const hips = this.ragdoll.bones[0].body;
    // Implicit spring to standing height, on top of the share of the weight it carries.
    const v = 8,
      damping = 2 * v,
      share = dt / (1 + damping * dt + v * v * dt * dt),
      want = dot(centre, this.up) + this.height * this.stance,
      height = dot(hips.position, this.up),
      weight = this.gravity * dt * this.carry,
      rise = Math.max(
        0,
        Math.min(share * (v * v * (want - height) - damping * dot(hips.linearVelocity, this.up)) + weight, weight * 1.5),
      );
    this.carried = (rise / (this.gravity * dt)) * this.upperShare;
    if (rise > 0) for (const part of this.upper) part.body.setLinearVelocity(add(part.body.linearVelocity, times(this.up, rise)));
  }

  private fall(): void {
    this.state = 'fallen';
    this.carried = 0;
    for (const leg of this.legs) {
      leg.swing = null;
      for (const part of [leg.upper, leg.lower, leg.foot]) this.motors.setTarget(part, null);
    }
  }

  /** Stands again from where the feet are, after a get-up or a teleport. */
  reset(): this {
    if (this.disposed) throw new MargoError('disposed', 'This balance is disposed; call addRagdollBalance again.');
    for (const leg of this.legs) {
      const at = leg.foot.body.position;
      leg.plant = [at[0], at[1], at[2]];
      leg.swing = null;
    }
    this.floor = dot(times(add(this.legs[0].plant, this.legs[1].plant), 0.5), this.up);
    this.hipsWere = null;
    this.state = 'standing';
    return this;
  }

  /** Stops balancing and hands the legs back to the animation's pose. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.fall();
    if (!this.ragdoll.bones[0].body.valid) return;
    this.wanted.fill(0);
    this.settle();
    for (const { part, shape } of this.soles) this.ragdoll.setShape(part, shape);
    for (const part of this.ragdoll.bones) this.solverPasses(part, 0);
    for (const { foot, lower } of this.legs) for (const part of [foot, lower]) this.addInertia(part, 0);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * Keeps a powered ragdoll on its feet: it stands, and steps to where its momentum says it must when pushed. Add it with the
 * character standing still in the pose to hold, before `activate`. It stands on its own legs: every torque is a pair inside
 * the body, the ground answers within the sole, and a hard enough blow knocks it over. It adds inertia to the feet and shins
 * and solver passes to the character's island and gives a hull foot a flat sole of four corners, and `dispose` takes them away.
 * @example
 * const motors = addRagdollMotors(ragdoll, { frequency: 8 });
 * const balance = addRagdollBalance(ragdoll, motors, { feet: [leftFoot, rightFoot] });
 * ragdoll.activate();
 * motors.hit(chest, [0, 0, -40]); // it stumbles and catches itself; balance.steps counts how
 * @throws TypeError without a ragdoll, motors or two feet, RangeError for a foot with no knee hinge or an option out of range.
 */
export function addRagdollBalance(
  ragdoll: Ragdoll,
  motors: RagdollMotors,
  options: RagdollBalanceOptions,
): RagdollBalance {
  if (!ragdoll?.bones || typeof motors?.setTarget !== 'function')
    throw new TypeError('addRagdollBalance needs a Ragdoll and its motors: addRagdollBalance(ragdoll, motors, {feet}).');
  return new RagdollBalance(ragdoll, motors, options);
}
