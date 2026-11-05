// Puts a loaded character on the wall: link hulls from its skin, one AvoidanceSolver per limb, a CCD chain per limb and a
// look-at, driven each frame from Climb. Nothing here knows the character's shape; rig.ts holds that.
import {
  addCCDChain,
  addLookAt,
  Animator,
  type CCDChain,
  type CCDJointLimit,
  type LookAt,
} from '@margoengine/animator';
import { Animation } from '@margoengine/animation';
import type { Vec3 } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf-pro';
import {
  AvoidanceSolver,
  ConvexHullVolume,
  SolveStatus,
  type ElbowEvaluator,
} from '@margoengine/kinematics-constraints';
import { jointHulls } from '@margoengine/rigging/hulls';
import { MIN_ARM_REACH, MIN_LEG_REACH, place, vec, type Climb } from './climb.ts';
import { CHARACTER, measureRig, restPosition, RIG } from './rig.ts';
import { VOLUMES, wallAt, wallSlabs, type Point, type Vec } from './wall.ts';

type Model = PBRModel;
type Node = PBRModel['nodes'][number];

/** Merges the character's primitives into jointHulls's input: bind positions and glTF-style skin weights. */
export function skinData(model: Model): {
  positions: Float32Array;
  joints: Uint16Array;
  weights: Float32Array;
  inverseBindMatrices: Float32Array;
  names: (string | undefined)[];
} {
  const { asset } = model,
    doc = asset.doc,
    accessors = doc.accessors!,
    primitives = doc.meshes!.flatMap((mesh) => mesh.primitives.map((p) => p.attributes!)),
    skin = doc.skins![0],
    count = primitives.reduce((n, attributes) => n + accessors[attributes.POSITION].count, 0),
    positions = new Float32Array(count * 3),
    joints = new Uint16Array(count * 4),
    weights = new Float32Array(count * 4);
  let at = 0;
  for (const attributes of primitives) {
    const vertexCount = accessors[attributes.POSITION].count;
    positions.set(asset.accessor(attributes.POSITION), at * 3);
    joints.set(asset.accessor(attributes.JOINTS_0), at * 4);
    // The asset reads normalized weights back as 0 to 1.
    weights.set(asset.accessor(attributes.WEIGHTS_0), at * 4);
    at += vertexCount;
  }
  return {
    positions,
    joints,
    weights,
    inverseBindMatrices: asset.accessor(skin.inverseBindMatrices),
    names: skin.joints.map((node: number) => doc.nodes![node].name),
  };
}

// A rotation (x, y, z, w) from the columns of an orthonormal basis.
function basisQuaternion(x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>, out: Float64Array): void {
  const trace = x[0] + y[1] + z[2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    out[3] = s / 4;
    out[0] = (y[2] - z[1]) / s;
    out[1] = (z[0] - x[2]) / s;
    out[2] = (x[1] - y[0]) / s;
  } else if (x[0] > y[1] && x[0] > z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    out[3] = (y[2] - z[1]) / s;
    out[0] = s / 4;
    out[1] = (y[0] + x[1]) / s;
    out[2] = (z[0] + x[2]) / s;
  } else if (y[1] > z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    out[3] = (z[0] - x[2]) / s;
    out[0] = (y[0] + x[1]) / s;
    out[1] = s / 4;
    out[2] = (z[1] + y[2]) / s;
  } else {
    const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
    out[3] = (x[1] - y[0]) / s;
    out[0] = (z[0] + x[2]) / s;
    out[1] = (z[1] + y[2]) / s;
    out[2] = s / 4;
  }
}

interface Limb {
  index: number;
  solver: AvoidanceSolver;
  chain: CCDChain;
  evaluator: ElbowEvaluator;
  rootNode: Node;
  endNode: Node;
  /** The last pose the solver cleared. */
  accepted: Float32Array;
  rotationGoal: Float64Array;
  rotationNow: Float64Array;
  resolved: boolean;
  /** The solver's last status and clearance. */
  status: number;
  clearance: number;
  /** The swivel angle of the last pose the solver cleared. */
  swivel: number;
  /** The direction the limb prefers to bend: see `PREFER`. */
  prefer: Vec;
  /** Added to every swivel angle the solver tries: see `solveLimb`. */
  swivelOrigin: Float64Array;
  clamped: Float32Array;
}

const OPTIONS = { swivelSpeedLimit: Math.PI * 3, reachMargin: 0.004, foldMargin: 0.02, searchBudget: 24 };
// Where each elbow and knee prefers to point. Elbows hang down and out in the world; `solveLimb` writes the knees each
// frame from the torso's frame, so they follow the body.
const PREFER: readonly Point[] = [
  [-0.8, -0.55, 0.25],
  [0.8, -0.55, 0.25],
  [-0.75, 0, -0.65],
  [0.75, 0, -0.65],
];

/** The climber on the wall. `use(stage)` it; it reads `climb` every frame. */
export class Climber {
  readonly name = 'boulder:climber';
  readonly limbs: Limb[] = [];
  readonly hullPointCounts: Record<string, number> = {};
  /** Average and largest time for one frame's four solves, milliseconds, since the last `resetTimes`. */
  solveMs = 0;
  solveMaxMs = 0;
  /** Time to build the link hulls from the skin at load, milliseconds. */
  readonly hullLoadMs: number;
  /** Frames on which a limb held its last clear pose instead of moving. */
  heldFrames = 0;
  readonly animator: Animator;
  private frames = 0;
  private delta = 1 / 60;
  private readonly look: LookAt;
  private solveTotal = 0;
  private readonly bodyHull: ConvexHullVolume;
  private readonly headHull: ConvexHullVolume;
  private readonly bodyNode: Node;
  private readonly headNode: Node;
  private readonly root: Model['root'];
  private readonly runtime: ReturnType<typeof engineRuntime>;
  private readonly quaternion = new Float64Array(4);
  private readonly rootPosition: Vec = vec();
  private readonly rootJoint: Float32Array = new Float32Array(3);
  private readonly climb: Climb;
  private readonly model: Model;
  private readonly skin: ReturnType<typeof skinData>;
  private readonly hulls: Map<string, Float32Array>;
  private time = 0;
  private readonly wallVolumes: ConvexHullVolume[];
  /** False holds still: a reduced motion visitor sees a frozen idle. */
  breathing = true;

  constructor(engine: unknown, model: Model, climb: Climb) {
    this.climb = climb;
    this.model = model;
    this.root = model.root;
    this.runtime = engineRuntime(engine as never);
    const skin = (this.skin = skinData(model)),
      nodes = model.asset.doc.nodes!,
      node = (name: string) => {
        const index = nodes.findIndex((n) => n.name === name);
        if (index < 0)
          throw new Error(`The character has no bone named ${name}; set the names in examples/boulder/rig.ts`);
        return index;
      };
    measureRig(skin.names, skin.inverseBindMatrices);
    const hullStart = performance.now(),
      made = jointHulls(
        { positions: skin.positions, skin: { joints: skin.joints, weights: skin.weights, influences: 4 } },
        { ...CHARACTER.hulls, inverseBindMatrices: skin.inverseBindMatrices },
      );
    this.hullLoadMs = performance.now() - hullStart;
    this.hulls = new Map(made.map((h) => [skin.names[h.joint] as string, h.points]));
    for (const [name, points] of this.hulls) this.hullPointCounts[name] = points.length / 3;
    const hull = (name: string) => {
      const points = this.hulls.get(name);
      if (!points) throw new Error(`The character's skin gives ${name} no hull; check its weights`);
      return points;
    };
    const { body, head, limbs } = CHARACTER.bones;
    this.bodyHull = new ConvexHullVolume({ points: hull(body) });
    this.headHull = new ConvexHullVolume({ points: hull(head) });
    this.bodyNode = model.nodes[node(body)];
    this.headNode = model.nodes[node(head)];
    this.wallVolumes = [...wallSlabs(), ...VOLUMES.map((v) => v.corners)].map(
      (points) => new ConvexHullVolume({ points }),
    );

    const animation = Animation.attach(model);
    this.animator = new Animator(animation, { initial: 'idle', states: { idle: animation.clips[0].name } });
    // Order matters: the climber places the root and clears the poses before the animator poses and solves.
    (engine as { use(p: unknown): void }).use(this);
    (engine as { use(p: unknown): void }).use(this.animator);

    const look: LookAt = {
      joints: [node(body), node(head)],
      target: climb.look as unknown as Vec3,
      shares: CHARACTER.lookShares,
      axis: CHARACTER.lookAxis,
      origin: CHARACTER.lens,
      maxAngle: CHARACTER.lookLimit,
      weight: 1,
    };
    this.look = look;
    addLookAt(this.animator, look);
    // After the look-at, so the solves see this frame's shoulders, torso and head, and before the chains that use them.
    this.animator.addSolver(this.solveLimbs);

    limbs.forEach(([upper, lower, end], index) => {
      const arm = index < 2,
        a = RIG.upper[index],
        b = RIG.lower[index],
        // The upper link's hull leaves out the part next to its root joint, which touches the torso by design.
        upperHull = arm ? trimmed(hull(upper), CHARACTER.shoulderTrim) : hull(upper),
        colliders = arm ? [...this.wallVolumes, this.bodyHull, this.headHull] : this.wallVolumes,
        swivelOrigin = new Float64Array(1),
        prefer = vec(PREFER[index][0], PREFER[index][1], PREFER[index][2]),
        solver = new AvoidanceSolver(colliders, {
          // The chain chooses each bone's twist and the solver assumes one; this covers the difference between the two hulls.
          minClearance: 0.014,
          complianceMargin: 0,
          links: [
            { hull: new ConvexHullVolume({ points: upperHull }), hinge: restHinge(skin, upper, lower, end, upper) },
            { hull: new ConvexHullVolume({ points: hull(lower) }), hinge: restHinge(skin, upper, lower, end, lower) },
          ],
        }),
        chain: CCDChain = {
          joints: [node(upper), node(lower), node(end)],
          target: [0, 0, 0],
          rotation: new Float64Array([0, 0, 0, 1]) as unknown as number[],
          pole: [0, 0, 0],
          // The middle joint is a hinge that folds one way, as in the rest pose. Free, it folded either way and the bone's
          // own twist was anyone's guess: that was a knee bending backward with its shin plate to the room.
          limits: [null, foldLimit(skin, upper, lower, end, arm ? CHARACTER.fold.elbow : CHARACTER.fold.knee), null],
          iterations: 12,
          tolerance: 0.001,
        };
      addCCDChain(this.animator, chain);
      this.limbs.push({
        index,
        solver,
        chain,
        evaluator: elbowEvaluator(a, b, prefer, swivelOrigin),
        rootNode: model.nodes[node(upper)],
        endNode: model.nodes[node(end)],
        accepted: new Float32Array(climb.targets[index]),
        rotationGoal: new Float64Array([0, 0, 0, 1]),
        rotationNow: new Float64Array([0, 0, 0, 1]),
        resolved: true,
        status: 0,
        clearance: 0,
        swivel: 0,
        prefer,
        swivelOrigin,
        clamped: new Float32Array(3),
      });
    });
    this.placeRoot();
    this.runtime.store.tick(false);
    this.footRest(skin.inverseBindMatrices, skin.names);
    this.snap();
  }

  setup(): void {}

  /** Each foot's world rotation: flat on the mat, and toes down on a hold. */
  private readonly footFlat = [new Float64Array(4), new Float64Array(4)];
  private readonly footPointed = [new Float64Array(4), new Float64Array(4)];
  private footRest(ibm: ArrayLike<number>, names: readonly (string | undefined)[]): void {
    // A foot starts from its rest world rotation, flat with the toe at the wall, and turns out about the vertical.
    const rest = new Float64Array(4),
      times = (a: readonly number[], b: ArrayLike<number>, out: Float64Array) => {
        out[0] = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
        out[1] = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
        out[2] = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
        out[3] = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
      },
      point = CHARACTER.footPoint / 2,
      pointed = new Float64Array(4);
    for (const side of [0, 1]) {
      const i = names.indexOf(CHARACTER.bones.limbs[2 + side][2]) * 16,
        half = (CHARACTER.footTurnOut / 2) * (side === 0 ? 1 : -1),
        yaw = [0, Math.sin(half), 0, Math.cos(half)];
      basisQuaternion(
        [ibm[i], ibm[i + 4], ibm[i + 8]],
        [ibm[i + 1], ibm[i + 5], ibm[i + 9]],
        [ibm[i + 2], ibm[i + 6], ibm[i + 10]],
        rest,
      );
      times(yaw, rest, this.footFlat[side]);
      // About +X, a negative turn takes -Z (the toes) down.
      times([-Math.sin(point), 0, 0, Math.cos(point)], rest, pointed);
      times(yaw, pointed, this.footPointed[side]);
    }
  }

  private placeRoot(): void {
    const { pelvis, frame } = this.climb,
      breath = this.breathing ? Math.sin(this.time * 1.7) * 0.004 : 0;
    place(frame, [-RIG.hips[0], -RIG.hips[1], -RIG.hips[2] + breath], pelvis, this.rootPosition);
    basisQuaternion(frame.right, frame.up, frame.back, this.quaternion);
    this.root.setPosition(this.rootPosition as unknown as Vec3);
    this.root.setQuaternion(this.quaternion as unknown as number[]);
  }

  private limbRotation(limb: Limb): void {
    const i = limb.index,
      climb = this.climb;
    if (i >= 2) {
      limb.rotationGoal.set(climb.footOnHold(i) ? this.footPointed[i - 2] : this.footFlat[i - 2]);
      return;
    }
    const f = scratchFingers,
      p = scratchPalm;
    if (climb.bound[i]) {
      // Palm on the hold and fingers up the wall and over it.
      const n = climb.handNormals[i],
        c = Math.cos(CHARACTER.hand.tilt),
        s = Math.sin(CHARACTER.hand.tilt);
      f[0] = 0;
      f[1] = n[2] * c + n[1] * s;
      f[2] = -n[1] * c + n[2] * s;
      p[0] = 0;
      p[1] = n[2] * s - n[1] * c;
      p[2] = -n[1] * s - n[2] * c;
      if (climb.moving === i) {
        // On the way the fingers lead along the arm, and take up the grip as they arrive. Going straight to the grip
        // folded a hand coming up from a hanging arm back against its forearm.
        const target = climb.targets[i],
          m = limb.rootNode.matrix,
          k = climb.travel[0];
        let ax = target[0] - m[12],
          ay = target[1] - m[13],
          az = target[2] - m[14];
        const length = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
        ax = (ax / length) * (1 - k) + f[0] * k;
        ay = (ay / length) * (1 - k) + f[1] * k;
        az = (az / length) * (1 - k) + f[2] * k;
        const l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
        f[0] = ax / l;
        f[1] = ay / l;
        f[2] = az / l;
        // Never more into the wall than the grip itself: a hand aimed along the arm at a hold would drive its fingers in.
        const short = s - (f[0] * n[0] + f[1] * n[1] + f[2] * n[2]);
        if (short > 0) {
          ax = f[0] + n[0] * short;
          ay = f[1] + n[1] * short;
          az = f[2] + n[2] * short;
          const lifted = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
          f[0] = ax / lifted;
          f[1] = ay / lifted;
          f[2] = az / lifted;
        }
        const along = p[0] * f[0] + p[1] * f[1] + p[2] * f[2];
        p[0] -= f[0] * along;
        p[1] -= f[1] * along;
        p[2] -= f[2] * along;
        const pl = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) || 1;
        p[0] /= pl;
        p[1] /= pl;
        p[2] /= pl;
      }
    } else {
      // A free arm hangs: fingers down, palm toward the body.
      const right = climb.frame.right,
        side = i === 0 ? 1 : -1;
      f[0] = 0;
      f[1] = -1;
      f[2] = 0;
      p[0] = right[0] * side;
      p[1] = right[1] * side;
      p[2] = right[2] * side;
    }
    handRotation(f, p, limb.rotationGoal);
  }

  /** Puts every limb straight on its target, no search limit: after a teleport. */
  snap(): void {
    for (const limb of this.limbs) {
      limb.solver.reset();
      limb.swivel = 0;
      limb.swivelOrigin[0] = 0;
      limb.accepted.set(this.climb.targets[limb.index]);
      this.limbRotation(limb);
      limb.rotationNow.set(limb.rotationGoal);
    }
  }

  onPreUpdate(delta: number): void {
    this.time += delta;
    this.climb.update(delta);
    this.placeRoot();
    this.delta = delta > 0 ? Math.min(delta, 0.05) : 1 / 60;
  }

  // Runs inside the animator, between the look-at and the chains.
  private readonly solveLimbs = (): void => {
    this.runtime.store.tick(false);
    this.bodyHull.setTransform(this.bodyNode.matrix);
    this.headHull.setTransform(this.headNode.matrix);
    const start = performance.now();
    for (let i = 0; i < 4; i++) this.solveLimb(this.limbs[i], this.delta);
    // The head gives way to an arm: while an arm finds no clear pose the gaze lets go, and it comes back once clear.
    const blocked = this.limbs[0].status !== SolveStatus.Success || this.limbs[1].status !== SolveStatus.Success,
      weight = (this.look.weight ?? 1) + (blocked ? -8 : 1.5) * this.delta;
    this.look.weight = weight < 0 ? 0 : weight > 1 ? 1 : weight;
    const spent = performance.now() - start;
    this.frames++;
    this.solveTotal += spent;
    this.solveMs = this.solveTotal / this.frames;
    if (spent > this.solveMaxMs) this.solveMaxMs = spent;
  };

  resetTimes(): void {
    this.frames = 0;
    this.solveTotal = 0;
    this.solveMs = 0;
    this.solveMaxMs = 0;
    this.heldFrames = 0;
  }

  private solveLimb(limb: Limb, dt: number): void {
    const m = limb.rootNode.matrix,
      i = limb.index,
      climb = this.climb,
      prefer = limb.prefer,
      back = climb.frame.back,
      right = climb.frame.right,
      kneeOut = i === 2 ? -CHARACTER.knee.out : CHARACTER.knee.out,
      target = climb.targets[i],
      root = this.rootJoint;
    root[0] = m[12];
    root[1] = m[13];
    root[2] = m[14];
    if (i >= 2) {
      prefer[0] = right[0] * kneeOut - back[0] * CHARACTER.knee.forward;
      prefer[1] = right[1] * kneeOut - back[1] * CHARACTER.knee.forward;
      prefer[2] = right[2] * kneeOut - back[2] * CHARACTER.knee.forward;
    }
    if (i < 2 && !climb.bound[i]) {
      // A free arm hangs from its shoulder.
      target[0] = root[0] + (i === 0 ? -0.14 : 0.14);
      target[1] = root[1] - (RIG.upper[i] + RIG.lower[i]) * 0.93;
      target[2] = root[2] + 0.04;
    }
    // Keep the request inside what the limb and the stance allow, so a pelvis that moves faster than a limb bends the
    // limb rather than leaving a request the solver has to refuse.
    const dx = target[0] - root[0],
      dy = target[1] - root[1],
      dz = target[2] - root[2],
      d = Math.hypot(dx, dy, dz) || 1e-6,
      max = RIG.upper[i] + RIG.lower[i] - 0.006,
      min = i < 2 ? MIN_ARM_REACH - 0.02 : MIN_LEG_REACH - 0.02,
      reach = d > max ? max : d < min ? min : d,
      request = limb.clamped;
    request[0] = root[0] + (dx / d) * reach;
    request[1] = root[1] + (dy / d) * reach;
    request[2] = root[2] + (dz / d) * reach;
    const result = limb.solver.solve(
      root,
      limb.accepted,
      request,
      RIG.upper[i],
      RIG.lower[i],
      0,
      0,
      dt,
      limb.evaluator,
      OPTIONS,
    );
    limb.resolved = result.status === SolveStatus.Success && result.resolved;
    limb.status = result.status;
    limb.clearance = result.clearance;
    const chainTarget = limb.chain.target as unknown as number[],
      pole = limb.chain.pole as unknown as number[];
    if (limb.resolved) {
      limb.accepted.set(result.target);
      limb.swivel = result.poleAngle;
      chainTarget[0] = result.target[0];
      chainTarget[1] = result.target[1];
      chainTarget[2] = result.target[2];
      pole[0] = result.elbow[0];
      pole[1] = result.elbow[1];
      pole[2] = result.elbow[2];
    } else {
      // No clear pose this frame. The hand stays where it was asked to be and the arm keeps its swivel about the shoulder
      // that moved. Carrying the old pose with the shoulder would take a planted hand off its hold and into the wall.
      //
      // The solver only remembers a pose it cleared, so an arm caught inside a blocked arc wider than one frame's swivel
      // would wait there for the arc to clear. Its best try this frame is the way out: moving the origin of its angles to
      // that try walks the elbow out at the swivel speed limit, without a jump.
      this.heldFrames++;
      limb.swivelOrigin[0] += result.poleAngle - limb.swivel;
      limb.accepted.set(request);
      chainTarget[0] = request[0];
      chainTarget[1] = request[1];
      chainTarget[2] = request[2];
      limb.evaluator(root, request, limb.swivel, scratchElbow);
      pole[0] = scratchElbow[0];
      pole[1] = scratchElbow[1];
      pole[2] = scratchElbow[2];
    }
    this.limbRotation(limb);
    const now = limb.rotationNow,
      goal = limb.rotationGoal,
      sign = now[0] * goal[0] + now[1] * goal[1] + now[2] * goal[2] + now[3] * goal[3] < 0 ? -1 : 1,
      rate = Math.min(1, dt * 10);
    let length = 0;
    for (let a = 0; a < 4; a++) {
      now[a] += (goal[a] * sign - now[a]) * rate;
      length += now[a] * now[a];
    }
    length = Math.sqrt(length);
    const rotation = limb.chain.rotation as unknown as Float64Array;
    for (let a = 0; a < 4; a++) rotation[a] = now[a] /= length;
  }

  /**
   * The current pose, measured off the real bones: how far each end joint is from its target, each limb's smallest gap
   * to the wall and volumes, and the knee flexion in degrees. For tests and the report; allocates.
   */
  measure() {
    const out = {
      error: [] as number[],
      wallGap: [] as number[],
      bodyGap: [] as number[],
      kneeDegrees: [] as number[],
      resolved: [] as boolean[],
      /** How far each end joint is from where its limb is planted. Only meaningful for a limb that is not moving. */
      contact: [] as number[],
    };
    const { limbs } = CHARACTER.bones,
      nodes = this.model.asset.doc.nodes as { name?: string }[],
      bone = (name: string) => this.model.nodes[nodes.findIndex((n) => n.name === name)];
    this.bodyHull.setTransform(this.bodyNode.matrix);
    this.headHull.setTransform(this.headNode.matrix);
    this.limbs.forEach((limb, i) => {
      const end = limb.endNode.matrix,
        target = limb.chain.target as unknown as number[];
      out.error.push(Math.hypot(end[12] - target[0], end[13] - target[1], end[14] - target[2]));
      out.resolved.push(limb.resolved);
      const c = this.climb.contacts[i];
      out.contact.push(Math.hypot(end[12] - c[0], end[13] - c[1], end[14] - c[2]));
      let wall = Infinity,
        body = Infinity;
      limbs[i].slice(0, 2).forEach((name, link) => {
        const points =
            i < 2 && link === 0 ? trimmed(this.hulls.get(name)!, CHARACTER.shoulderTrim) : this.hulls.get(name)!,
          hull = new ConvexHullVolume({ points });
        hull.setTransform(bone(name).matrix);
        for (const v of this.wallVolumes) wall = Math.min(wall, hull.hullClearance(v));
        if (i < 2) body = Math.min(body, hull.hullClearance(this.bodyHull), hull.hullClearance(this.headHull));
      });
      out.wallGap.push(wall);
      out.bodyGap.push(body);
      const a = limb.rootNode.matrix,
        k = bone(limbs[i][1]).matrix,
        ux = a[12] - k[12],
        uy = a[13] - k[13],
        uz = a[14] - k[14],
        vx = end[12] - k[12],
        vy = end[13] - k[13],
        vz = end[14] - k[14],
        cos = (ux * vx + uy * vy + uz * vz) / (Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1);
      out.kneeDegrees.push(180 - (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
    });
    return out;
  }

  /**
   * Which way each part faces, measured off the real bones, in the terms a person would judge it by. For tests and the
   * report; allocates. Angles are degrees. Rest-space axes go through each bone's inverse bind matrix, so this holds for
   * any model with the same bones.
   */
  facing() {
    const nodes = this.model.asset.doc.nodes as { name?: string }[],
      { names, inverseBindMatrices: ibm } = this.skin,
      matrix = (name: string) => this.model.nodes[nodes.findIndex((n) => n.name === name)].matrix,
      at = (name: string): Point => {
        const m = matrix(name);
        return [m[12], m[13], m[14]];
      },
      // A bone-space direction in the world.
      fromBone = (name: string, v: readonly number[]): Point => {
        const m = matrix(name),
          l = Math.hypot(m[0], m[1], m[2]) || 1;
        return [
          (m[0] * v[0] + m[4] * v[1] + m[8] * v[2]) / l,
          (m[1] * v[0] + m[5] * v[1] + m[9] * v[2]) / l,
          (m[2] * v[0] + m[6] * v[1] + m[10] * v[2]) / l,
        ];
      },
      // A character rest-space direction, carried by a bone into the world.
      fromRest = (name: string, v: readonly number[]): Point => {
        const o = names.indexOf(name) * 16;
        return fromBone(name, [
          ibm[o] * v[0] + ibm[o + 4] * v[1] + ibm[o + 8] * v[2],
          ibm[o + 1] * v[0] + ibm[o + 5] * v[1] + ibm[o + 9] * v[2],
          ibm[o + 2] * v[0] + ibm[o + 6] * v[1] + ibm[o + 10] * v[2],
        ]);
      },
      dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
      cross = (a: readonly number[], b: readonly number[]): Point => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ],
      minus = (a: readonly number[], b: readonly number[]): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
      along = (v: readonly number[], k: number): Point => [v[0] * k, v[1] * k, v[2] * k],
      unit = (v: readonly number[]): Point => along(v, 1 / (Math.hypot(v[0], v[1], v[2]) || 1)),
      degrees = (cos: number) => (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI,
      { hips, body, limbs } = CHARACTER.bones,
      climb = this.climb,
      forward: Point = [0, 0, -1],
      up: Point = [0, 1, 0],
      inward = (y: number): Point => {
        const n: Point = [0, 0, 1];
        wallAt(y, n);
        return [-n[0], -n[1], -n[2]];
      };
    const hipsForward = fromRest(hips, forward),
      hipsUp = fromRest(hips, up),
      hipsRight = cross(hipsForward, hipsUp),
      chestForward = fromRest(body, forward),
      wall = inward(at(hips)[1] + 0.35),
      flat = (v: Point) => unit(minus(v, along(hipsUp, dot(v, hipsUp)))),
      hipsFlat = flat(hipsForward);
    const knees = [2, 3].map((i) => {
      const [upper, lower, end] = limbs[i],
        a = at(upper),
        k = at(lower),
        e = at(end),
        u = minus(k, a),
        v = minus(e, k),
        line = unit(minus(e, a)),
        off = unit(minus(u, along(line, dot(u, line)))),
        out = i === 2 ? -1 : 1,
        hingeRest = fromBone(upper, restHinge(this.skin, upper, lower, end, upper));
      return {
        /** 1: the knee folds about its own hinge, the way it does at rest. -1: it folds backward. */
        hinge: dot(unit(cross(u, v)), hingeRest),
        /** 1: the shin has not turned about the thigh. */
        shinTwist: dot(fromBone(lower, restHinge(this.skin, upper, lower, end, lower)), hingeRest),
        /**
         * Where the knee points from the pelvis's front: 0 ahead, 90 straight out to its side, 180 behind, negative inward.
         * Null when it points mostly up or down, as on a high step, where a direction round the pelvis means nothing.
         */
        azimuth:
          Math.hypot(dot(off, hipsRight), dot(off, hipsFlat)) < 0.5
            ? null
            : (Math.atan2(dot(off, hipsRight) * out, dot(off, hipsFlat)) * 180) / Math.PI,
      };
    });
    const feet = [2, 3].map((i) => {
      const [, lower, end] = limbs[i],
        foot = fromRest(end, forward),
        out = i === 2 ? -1 : 1,
        into = inward(at(end)[1]);
      return {
        /** How far the toes point from straight at the wall. */
        toWall: degrees(dot(foot, into)),
        /** How far the toes turn out from straight at the wall, along the wall; negative is inward. */
        turnOut: (Math.atan2(dot(foot, hipsRight) * out, dot(foot, into)) * 180) / Math.PI,
        /** The tip of the shoe from the middle of its hold, metres. */
        toeToHold: (() => {
          const hold = climb.on[i] >= 0 && climb.moving !== i ? climb.holds[climb.on[i]] : null;
          if (!hold) return 0;
          const tip = fromRest(end, CHARACTER.toeTip),
            ankle = at(end);
          return Math.hypot(
            ankle[0] + tip[0] - hold.position[0],
            ankle[1] + tip[1] - hold.position[1],
            ankle[2] + tip[2] - hold.position[2],
          );
        })(),
        /** How far the sole tilts from flat. */
        sole: degrees(dot(fromRest(end, up), [0, 1, 0])),
        /** The angle between the ankle's axle, on the shin, and the foot's own side axis: 0 is no twist at the ankle. */
        ankleTwist: degrees(dot(fromRest(lower, [1, 0, 0]), fromRest(end, [1, 0, 0]))),
      };
    });
    const { fingers, palm, thumb } = CHARACTER.hand,
      hands = [0, 1].map((i) => {
        const [, lower, end] = limbs[i],
          wrist = at(end),
          fingerDirection = fromBone(end, fingers),
          palmDirection = fromBone(end, palm),
          thumbDirection = fromBone(end, thumb[i]),
          hold = climb.on[i] >= 0 ? climb.holds[climb.on[i]] : null,
          into = hold ? inward(hold.position[1]) : wall,
          upWall = unit(cross(cross(into, up), into));
        return {
          /** On a hold and not on its way somewhere. */
          holding: hold !== null && climb.moving !== i && climb.bound[i],
          /** Palm against the direction from the wrist to its hold: 1 is the palm square on it. */
          palmToHold: hold ? dot(palmDirection, unit(minus(hold.position, wrist))) : 0,
          /** Palm against straight into the wall under the hold. */
          palmToWall: dot(palmDirection, into),
          /** Thumb against the direction toward the climber's middle: 1 is the thumb on the inner side. */
          thumbInner: dot(thumbDirection, along(hipsRight, i === 0 ? 1 : -1)),
          /** Fingers against up the wall. */
          fingersUp: dot(fingerDirection, upWall),
          /** How far the wrist bends from the line of the forearm. */
          wrist: degrees(dot(unit(minus(wrist, at(lower))), fingerDirection)),
        };
      });
    const gap = (...parts: string[]) => {
      let least = Infinity;
      for (const name of parts) {
        const points = this.hulls.get(name);
        if (!points) continue;
        const hull = new ConvexHullVolume({ points });
        hull.setTransform(matrix(name));
        for (const v of this.wallVolumes) least = Math.min(least, hull.hullClearance(v));
      }
      return least;
    };
    return {
      /** Pelvis and chest front against straight into the wall. */
      hipsToWall: degrees(dot(hipsForward, wall)),
      chestToWall: degrees(dot(chestForward, wall)),
      /** Chest against pelvis, about the spine. */
      twist: degrees(dot(flat(chestForward), hipsFlat)),
      knees,
      feet,
      hands,
      footGap: [2, 3].map((i) => gap(limbs[i][2], limbs[i][2].replace('Foot', 'Toe'))),
      handGap: [0, 1].map((i) => gap(limbs[i][2])),
    };
  }
}

const scratchElbow = new Float32Array(3),
  scratchFingers = vec(0, 1, 0),
  scratchPalm = vec(0, 0, 1),
  scratchX = vec(1, 0, 0),
  scratchY = vec(0, 1, 0),
  scratchZ = vec(0, 0, 1),
  scratchThird = vec(1, 0, 0);

/** The hand bone's world rotation that sends its fingers and palm axes (CHARACTER.hand) to the unit directions `f` and `p`. */
function handRotation(f: Vec, p: Vec, out: Float64Array): void {
  const a = CHARACTER.hand.fingers,
    b = CHARACTER.hand.palm,
    // Third axis of each basis: fingers cross palm.
    cx = a[1] * b[2] - a[2] * b[1],
    cy = a[2] * b[0] - a[0] * b[2],
    cz = a[0] * b[1] - a[1] * b[0];
  scratchThird[0] = f[1] * p[2] - f[2] * p[1];
  scratchThird[1] = f[2] * p[0] - f[0] * p[2];
  scratchThird[2] = f[0] * p[1] - f[1] * p[0];
  for (let k = 0; k < 3; k++) {
    scratchX[k] = f[k] * a[0] + p[k] * b[0] + scratchThird[k] * cx;
    scratchY[k] = f[k] * a[1] + p[k] * b[1] + scratchThird[k] * cy;
    scratchZ[k] = f[k] * a[2] + p[k] * b[2] + scratchThird[k] * cz;
  }
  basisQuaternion(scratchX, scratchY, scratchZ, out);
}

/** A hinge about the limb's rest hinge axis that folds from straight to `most` degrees, the way the rest pose folds. */
function foldLimit(
  skin: ReturnType<typeof skinData>,
  upper: string,
  lower: string,
  end: string,
  most: number,
): CCDJointLimit {
  const ibm = skin.inverseBindMatrices,
    offset = (bone: string) => skin.names.indexOf(bone) * 16,
    a = restPosition(ibm, offset(upper)),
    b = restPosition(ibm, offset(lower)),
    c = restPosition(ibm, offset(end)),
    u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]],
    rest = Math.acos((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v)));
  // Turning about the axis u x v moves v away from u, so a positive angle folds further.
  return {
    type: 'hinge',
    axis: restHinge(skin, upper, lower, end, lower),
    min: -rest,
    max: (most * Math.PI) / 180 - rest,
  };
}

/** A limb's rest hinge axis (normal of the plane through its three joints) in the space of bone `name`. */
function restHinge(
  skin: ReturnType<typeof skinData>,
  upper: string,
  lower: string,
  end: string,
  name: string = upper,
): Point {
  const ibm = skin.inverseBindMatrices,
    offset = (bone: string) => skin.names.indexOf(bone) * 16,
    a = restPosition(ibm, offset(upper)),
    b = restPosition(ibm, offset(lower)),
    c = restPosition(ibm, offset(end)),
    u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]],
    n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
    m = offset(name),
    // World to bone: the rotation part of its inverse bind matrix.
    x = ibm[m] * n[0] + ibm[m + 4] * n[1] + ibm[m + 8] * n[2],
    y = ibm[m + 1] * n[0] + ibm[m + 5] * n[1] + ibm[m + 9] * n[2],
    z = ibm[m + 2] * n[0] + ibm[m + 6] * n[1] + ibm[m + 10] * n[2],
    l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** The hull corners past `start` along the bone's +Y; at least the corners at the far end. */
function trimmed(points: Float32Array, start: number): Float32Array {
  const kept: number[] = [];
  for (let i = 0; i < points.length; i += 3)
    if (points[i + 1] >= start) kept.push(points[i], points[i + 1], points[i + 2]);
  return Float32Array.from(kept);
}

/** Two-bone elbow position for a swivel angle, measured from the direction the limb prefers to bend. */
function elbowEvaluator(a: number, b: number, prefer: Vec, origin: Float64Array): ElbowEvaluator {
  return (root, target, angle, out) => {
    const dx = target[0] - root[0],
      dy = target[1] - root[1],
      dz = target[2] - root[2],
      d = Math.hypot(dx, dy, dz) || 1e-9,
      nx = dx / d,
      ny = dy / d,
      nz = dz / d,
      along = (a * a - b * b + d * d) / (2 * d),
      h = Math.sqrt(Math.max(0, a * a - along * along)),
      pd = prefer[0] * nx + prefer[1] * ny + prefer[2] * nz;
    let vx = prefer[0] - nx * pd,
      vy = prefer[1] - ny * pd,
      vz = prefer[2] - nz * pd;
    const vl = Math.hypot(vx, vy, vz) || 1;
    vx /= vl;
    vy /= vl;
    vz /= vl;
    const wx = ny * vz - nz * vy,
      wy = nz * vx - nx * vz,
      wz = nx * vy - ny * vx,
      turned = angle + origin[0],
      c = Math.cos(turned) * h,
      s = Math.sin(turned) * h;
    out[0] = root[0] + nx * along + vx * c + wx * s;
    out[1] = root[1] + ny * along + vy * c + wy * s;
    out[2] = root[2] + nz * along + vz * c + wz * s;
  };
}
