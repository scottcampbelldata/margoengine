// Crowds of hundreds: a navmesh Crowd (@margoengine/navmesh) moves the people, and a VATCrowd or SkinnedCrowd
// (@margoengine/animation/vat, /instanced-skin) draws them all in one instanced call. walkCrowd joins the two: each
// agent gets an instance whose place and heading follow the agent, and whose walk cycle advances by the distance the agent
// covers, so feet do not slide whatever speed the crowd allows (with `density` on, Weidmann's speeds). Standing agents
// play the stand clip. Outfit variety comes from atlas regions handed out by a seeded hash. Nothing here is imported by
// the rest of the package; the navmesh and animation types are structural, so this entry bundles neither.

/** The parts of a `@margoengine/navmesh` CrowdAgent that walkCrowd reads. */
export interface WalkingAgent {
  readonly position: ArrayLike<number>;
  readonly velocity: ArrayLike<number>;
}
/** The parts of a `@margoengine/navmesh` Crowd that walkCrowd reads. */
export interface WalkingCrowd {
  readonly agents: readonly WalkingAgent[];
}
/** One instance as `@margoengine/animation/vat` VATCrowd's `add` and `set` take it. */
export interface WalkerInstance {
  matrix?: ArrayLike<number>;
  clip?: number;
  offset?: number;
  speed?: number;
  uvTransform?: { offset?: readonly number[]; scale?: readonly number[] };
}
/** The parts of a VATCrowd or SkinnedCrowd that walkCrowd drives. */
export interface WalkerDrawer {
  add(instance?: WalkerInstance): number;
  set(index: number, instance: WalkerInstance): unknown;
  readonly vat: { readonly clips: readonly { readonly duration?: number; readonly name?: string }[] };
}
/** Options of {@link walkCrowd}. */
export interface WalkCrowdOptions {
  /** Index of the walk cycle in the drawer's clips. Default 0. */
  walk?: number;
  /** Index of the clip a standing agent plays. Default the walk clip, held still. */
  stand?: number;
  /** Ground the walk clip covers in one second at speed 1, world units (metres for a glTF model). Required. */
  stride: number;
  /** Speed below which an agent shows the stand clip, world units a second. Default 0.05. */
  standBelow?: number;
  /** Fastest an agent turns, radians a second, so heading does not snap when avoidance jerks the velocity. Default 4. */
  turnRate?: number;
  /** Size of every person, one number or [x, y, z]. Default 1. */
  scale?: number | readonly [number, number, number];
  /** Atlas regions (outfits) handed out one per agent by a seeded hash. Default none: the whole map. */
  variants?: readonly { offset: readonly number[]; scale: readonly number[] }[];
  /** Seed of the variant and starting phase hash. Default 1. */
  seed?: number;
}
/** What {@link walkCrowd} returns. */
export interface CrowdWalkers {
  /** Instance index of each agent, in the crowd's order. */
  readonly instances: readonly number[];
  /** Seconds into its walk cycle of each agent. */
  readonly phases: Float64Array;
  /** Heading of each agent, radians about +Y from +Z. */
  readonly headings: Float64Array;
  /** Moves every instance to its agent; call once a frame after `crowd.update(dt)`, with the same `dt`. */
  update(dt: number): void;
}
const hash = (n: number): number => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};
/**
 * Draws every agent of `crowd` with an instance of `drawer`, walking or standing, placed and turned with its agent. Agents
 * added to the crowd later get an instance at the next `update`.
 * @example
 * const walkers = walkCrowd(crowd, people, { walk: 0, stand: 1, stride: 1.4 });
 * engine.onUpdate((dt) => { crowd.update(dt); walkers.update(dt); });
 */
export function walkCrowd(crowd: WalkingCrowd, drawer: WalkerDrawer, options: WalkCrowdOptions): CrowdWalkers {
  if (!crowd || !Array.isArray(crowd.agents)) throw new TypeError('walkCrowd needs a navmesh Crowd; pass new Crowd(navMesh)');
  if (!drawer || typeof drawer.add !== 'function' || typeof drawer.set !== 'function')
    throw new TypeError('walkCrowd needs a VATCrowd or SkinnedCrowd to draw with; pass one from @margoengine/animation');
  const clips = drawer.vat?.clips?.length ?? 0,
    { walk = 0, stride, standBelow = 0.05, turnRate = 4, seed = 1, variants = [] } = options ?? ({} as WalkCrowdOptions),
    stand = options?.stand ?? walk;
  for (const [v, label] of [
    [walk, 'walk'],
    [stand, 'stand'],
  ] as const)
    if (!Number.isInteger(v) || v < 0 || v >= clips)
      throw new RangeError(`walkCrowd ${label} must be a clip index from 0 to ${clips - 1}; pass the clip's place in the bake`);
  if (!(stride > 0) || !Number.isFinite(stride))
    throw new RangeError('walkCrowd stride must be the ground the walk clip covers in a second, above 0; pass about 1.4 for a person');
  if (!(standBelow >= 0) || !(turnRate > 0) || !Number.isFinite(standBelow + turnRate))
    throw new RangeError('walkCrowd standBelow must be 0 or more and turnRate above 0, finite; pass the defaults 0.05 and 4');
  const s = typeof options.scale === 'number' || options.scale === undefined ? [options.scale ?? 1, options.scale ?? 1, options.scale ?? 1] : options.scale;
  if (s.length !== 3 || !s.every((k) => k > 0 && Number.isFinite(k)))
    throw new RangeError('walkCrowd scale must be a number above 0 or three of them; pass 1');
  const instances: number[] = [],
    matrix = new Float32Array(16);
  let phases = new Float64Array(0),
    headings = new Float64Array(0);
  const grow = () => {
    const agents = crowd.agents;
    if (instances.length >= agents.length) return;
    const p = new Float64Array(agents.length),
      h = new Float64Array(agents.length);
    p.set(phases);
    h.set(headings);
    for (let i = instances.length; i < agents.length; i++) {
      const v = agents[i].velocity;
      h[i] = Math.hypot(v[0], v[2]) > 1e-6 ? Math.atan2(v[0], v[2]) : hash(seed * 7919 + i) * 2 * Math.PI;
      p[i] = hash(seed * 104729 + i) * (drawer.vat.clips[walk].duration ?? 1);
      const variant = variants.length ? variants[Math.floor(hash(seed * 15485863 + i) * variants.length)] : undefined;
      instances.push(drawer.add(variant ? { uvTransform: variant } : {}));
    }
    phases = p;
    headings = h;
  };
  const walkers: CrowdWalkers = {
    get instances() {
      return instances;
    },
    get phases() {
      return phases;
    },
    get headings() {
      return headings;
    },
    update(dt: number) {
      if (!(dt >= 0) || !Number.isFinite(dt)) throw new RangeError('walkers update needs a finite dt of 0 or more seconds');
      grow();
      const agents = crowd.agents;
      for (let i = 0; i < instances.length && i < agents.length; i++) {
        const a = agents[i],
          vx = a.velocity[0],
          vz = a.velocity[2],
          speed = Math.hypot(vx, vz),
          moving = speed >= standBelow;
        if (moving) {
          // Turn toward the velocity by at most turnRate * dt, the short way round.
          let turn = Math.atan2(vx, vz) - headings[i];
          turn -= 2 * Math.PI * Math.round(turn / (2 * Math.PI));
          const most = turnRate * dt;
          headings[i] += Math.max(-most, Math.min(most, turn));
        }
        // The cycle advances by the ground covered, so feet do not slide (below standBelow the stand clip shows instead).
        phases[i] += (speed / stride) * dt;
        const c = Math.cos(headings[i]),
          n = Math.sin(headings[i]);
        // Column-major: rotation about +Y (+Z forward turned to (sin, 0, cos)), scale, then translation.
        matrix.set([c * s[0], 0, -n * s[0], 0, 0, s[1], 0, 0, n * s[2], 0, c * s[2], 0, a.position[0], a.position[1], a.position[2], 1]);
        // Walking: the cycle at its own phase. Standing: the stand clip plays at its own pace from a phase of its own, or
        // with no stand clip the walk holds where it stopped.
        drawer.set(
          instances[i],
          moving || stand === walk
            ? { matrix, clip: walk, offset: phases[i], speed: 0 }
            : { matrix, clip: stand, offset: hash(seed * 49979687 + i) * 10, speed: 1 },
        );
      }
    },
  };
  grow();
  return walkers;
}
