import type { Mesh } from '@margoengine/core/extension';

type WeightSource = { weights: Float32Array };
const fields = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'sx', 'sy', 'sz'] as const;
const methods = ['check', 'setPosition', 'setQuaternion', 'setRotation', 'setScale', 'syncRotation'] as const;
const stride = 45;

/** Exact inputs of an accepted demo pose, held in private reusable buffers. */
export class PresentedPoseSnapshot {
  private valid = false;
  private readonly roots: readonly Mesh[];
  private readonly morphs: readonly WeightSource[];
  private readonly sourceNodes: readonly Mesh[];
  private readonly nodes: Mesh[] = [];
  private readonly nodeSet = new Set<Mesh>();
  private readonly values: Float64Array;
  private readonly calls: unknown[] = [];
  private readonly scalars: Float64Array;
  private readonly weightArrays: Float32Array[];
  private readonly weights: Float64Array[];
  private readonly sourceCount: number;

  constructor(roots: readonly Mesh[], morphs: readonly WeightSource[], scalarCount: number) {
    if (!roots.length || !Number.isSafeInteger(scalarCount) || scalarCount < 0)
      throw new RangeError('Invalid presented-pose snapshot');
    this.roots = roots;
    this.morphs = morphs;
    this.sourceNodes = roots.slice();
    this.sourceCount = roots.length;
    const engine = roots[0].engine;
    for (let i = 0; i < roots.length; i++) {
      let node: Mesh | undefined = roots[i];
      for (let depth = 0; node; depth++) {
        if (depth >= 64 || node.engine !== engine) throw new Error('Invalid presented-pose hierarchy');
        node.check();
        if (this.nodeSet.has(node)) break;
        this.nodeSet.add(node);
        this.nodes.push(node);
        const parent: number = engine.store.parents[node.id];
        node = parent === -1 ? undefined : engine.meshes.get(parent);
        if (parent !== -1 && !node) throw new Error('Missing presented-pose parent');
      }
    }
    this.values = new Float64Array(this.nodes.length * stride);
    this.scalars = new Float64Array(scalarCount);
    this.weightArrays = morphs.map((source) => source.weights);
    this.weights = this.weightArrays.map((weights) => new Float64Array(weights.length));
    for (let i = 0; i < this.nodes.length; i++)
      for (let j = 0; j < methods.length; j++) this.calls[i * methods.length + j] = this.nodes[i][methods[j]];
  }

  invalidate(): void {
    this.valid = false;
  }

  private inspect(copy: boolean, state: Float64Array): boolean {
    if (
      state.length !== this.scalars.length ||
      this.roots.length !== this.sourceCount ||
      this.morphs.length !== this.weights.length
    )
      return false;
    for (let i = 0; i < this.roots.length; i++) if (this.roots[i] !== this.sourceNodes[i]) return false;
    for (let i = 0; i < state.length; i++) {
      const value = state[i];
      if (!Number.isFinite(value)) return false;
      if (copy) this.scalars[i] = value;
      else if (!Object.is(this.scalars[i], value)) return false;
    }
    const values = this.values;
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      // Keep disposal/foreign-slot errors observable; stale values cannot make disposed meshes reusable.
      node.check();
      const store = node.engine.store,
        id = node.id;
      const parent = store.parents[id];
      if (parent !== -1 && !this.nodeSet.has(node.engine.meshes.get(parent)!)) return false;
      let at = i * stride;
      for (let j = 0; j < fields.length; j++, at++) {
        const value = store.transforms[fields[j]][id];
        if (!Number.isFinite(value)) return false;
        if (copy) values[at] = value;
        else if (!Object.is(values[at], value)) return false;
      }
      for (let j = 0; j < 3; j++, at++) {
        const value = node.euler[j];
        if (!Number.isFinite(value)) return false;
        if (copy) values[at] = value;
        else if (!Object.is(values[at], value)) return false;
      }
      for (let j = 0; j < 16; j++, at++) {
        const value = node.matrix[j];
        if (!Number.isFinite(value)) return false;
        if (copy) values[at] = value;
        else if (!Object.is(values[at], value)) return false;
      }
      for (let j = 0; j < 12; j++, at++) {
        const value = store.limits[id * 12 + j];
        if (!Number.isFinite(value)) return false;
        if (copy) values[at] = value;
        else if (!Object.is(values[at], value)) return false;
      }
      const parentSlot = at++,
        activeSlot = at++,
        constrainedSlot = at++,
        hiddenSlot = at++;
      if (copy) {
        values[parentSlot] = parent;
        values[activeSlot] = store.active[id];
        values[constrainedSlot] = store.constrained[id];
        values[hiddenSlot] = store.hidden[id];
      } else if (
        values[parentSlot] !== parent ||
        values[activeSlot] !== store.active[id] ||
        values[constrainedSlot] !== store.constrained[id] ||
        values[hiddenSlot] !== store.hidden[id]
      )
        return false;
      for (let j = 0; j < methods.length; j++) {
        const index = i * methods.length + j,
          method = node[methods[j]];
        if (Object.hasOwn(node, methods[j]) || this.calls[index] !== method) return false;
      }
    }
    for (let i = 0; i < this.morphs.length; i++) {
      const input = this.morphs[i].weights,
        output = this.weights[i];
      if (input !== this.weightArrays[i] || input.length !== output.length) return false;
      for (let j = 0; j < input.length; j++) {
        const value = input[j];
        if (!Number.isFinite(value)) return false;
        if (copy) output[j] = value;
        else if (!Object.is(output[j], value)) return false;
      }
    }
    return true;
  }

  capture(state: Float64Array, safe: boolean): boolean {
    this.valid = false;
    if (!safe) return false;
    this.valid = this.inspect(true, state);
    return this.valid;
  }

  matches(state: Float64Array): boolean {
    return this.valid && this.inspect(false, state);
  }
}

type PoseHook = { name: string; onPreUpdate?: (dt: number) => void };

/** Unknown updates between the two owned pose hooks keep their original ordering. */
export class PoseUpdateOrder {
  private readonly plugins: ReadonlyMap<string, PoseHook>;
  private readonly animator: PoseHook;
  private readonly pose: PoseHook;
  private readonly animatorUpdate: PoseHook['onPreUpdate'];
  private readonly poseUpdate: PoseHook['onPreUpdate'];
  private phase = 0;
  private compatible = true;
  private readonly inspect = (plugin: PoseHook): void => {
    if (!plugin.onPreUpdate) return;
    if (plugin === this.animator) this.phase = 1;
    else if (plugin === this.pose && this.phase === 1) this.phase = 2;
    else if (this.phase === 1) this.compatible = false;
  };

  constructor(plugins: ReadonlyMap<string, PoseHook>, animator: PoseHook, pose: PoseHook) {
    this.plugins = plugins;
    this.animator = animator;
    this.pose = pose;
    this.animatorUpdate = animator.onPreUpdate;
    this.poseUpdate = pose.onPreUpdate;
  }

  matches(): boolean {
    if (
      this.plugins.get(this.animator.name) !== this.animator ||
      this.plugins.get(this.pose.name) !== this.pose ||
      this.animator.onPreUpdate !== this.animatorUpdate ||
      this.pose.onPreUpdate !== this.poseUpdate
    )
      return false;
    this.phase = 0;
    this.compatible = true;
    this.plugins.forEach(this.inspect);
    return this.compatible && this.phase === 2;
  }
}

/** Reuses only an explicitly bounded, synchronous zero-delta repeat of a presented pose. */
export class ProbePoseReuse {
  /** Lifetime counts of explicit zero-delta capture attempts; ordinary frames are excluded. */
  readonly counters = { attempts: 0, reused: 0, fallback: 0 };
  private active = false;
  private skipped = false;
  private readonly snapshot: PresentedPoseSnapshot;
  private readonly state: Float64Array;
  private readonly readState: (out: Float64Array) => boolean;
  private readonly replayAnimation: () => void;

  constructor(
    snapshot: PresentedPoseSnapshot,
    state: Float64Array,
    readState: (out: Float64Array) => boolean,
    replayAnimation: () => void,
  ) {
    this.snapshot = snapshot;
    this.state = state;
    this.readState = readState;
    this.replayAnimation = replayAnimation;
  }

  begin(): void {
    if (this.active) throw new Error('Nested probe pose scope');
    this.active = true;
    this.skipped = false;
  }

  end(): void {
    if (this.skipped) this.counters.fallback++;
    this.active = false;
    this.skipped = false;
  }

  invalidate(): void {
    this.snapshot.invalidate();
    if (this.skipped) this.counters.fallback++;
    this.skipped = false;
  }

  private matches(): boolean {
    return this.readState(this.state) && this.snapshot.matches(this.state);
  }

  skipAnimation(dt: number): boolean {
    if (this.skipped) this.counters.fallback++;
    this.skipped = false;
    if (!this.active || dt !== 0) return false;
    this.counters.attempts++;
    this.skipped = this.matches();
    if (!this.skipped) this.counters.fallback++;
    return this.skipped;
  }

  reusePose(dt: number): boolean {
    if (!this.active || dt !== 0 || !this.skipped) return false;
    this.skipped = false;
    if (this.matches()) {
      this.counters.reused++;
      return true;
    }
    this.counters.fallback++;
    // A supported callback changed an input after the first check. Reapply the
    // ordinary base pose before the normal workshop path reconciles the arm.
    // Unknown intervening pre-update hooks are rejected by readState up front.
    const active = this.active;
    this.active = false;
    try {
      this.replayAnimation();
    } finally {
      this.active = active;
    }
    return false;
  }

  accept(safe: boolean): void {
    if (this.active) return;
    if (!safe || !this.readState(this.state)) this.snapshot.invalidate();
    else this.snapshot.capture(this.state, true);
  }
}
