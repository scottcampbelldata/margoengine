/// <reference lib="esnext.disposable" preserve="true" />
// Armies on the march: a `@margoengine/navmesh/formations` Army moves the men and horses (Reynolds slot following, van
// den Berg ORCA avoidance, a position projection; routing down Treuille continuum-crowd fields), and addArmy draws
// them: the foot soldiers and the riders as one PersonCrowd (./lod.js: skinned near, vertex animation far, culled and
// budgeted), the horses as a `@margoengine/horses/crowd` herd with the riders seated on its saddles (./riders.js).
// Every member's clip follows its ground speed (stand, walk, run; the walk-run change at about 2 m/s, where people
// change gait, Thorstensson and Roberthson 1987), its cycle moves on by the ground it covers over the clip's stride
// (the drill step by default: 30 inches at quick time, 36 at double time, Infantry Drill Regulations 1911), so feet
// never slide, and soldiers keep step unless they march at route step. Each man has his own height (a normal spread,
// 4 percent by default: about 7 cm on 1.75 m, Visscher 2008) and outfit (atlas regions, such as castVariants of the
// `@margoengine/humans` cast kit). Every frame is a pure function of the army's film time and the camera, so a film
// seeks exactly. Any person plugs in: a Character Creator export through `@margoengine/humans`, a glTF, a body built
// in code, through ./bake.js.
import type { EngineKernel } from '@margoengine/core';
import type { VATCrowdOptions } from '@margoengine/animation/vat';
import type { HorseCrowd, HorseCrowdOptions } from '@margoengine/horses/crowd';
import type { PersonBake } from './bake.js';
import { PersonCrowd, crowdBudget, type CrowdBudget, type CrowdPerson, type CrowdView } from './lod.js';
import { riderMatrix, type RiderPlacement } from './riders.js';

/** One member as a `@margoengine/navmesh/formations` Army keeps it. */
export interface ArmyMember {
  readonly formation: number;
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly speed: number;
  readonly distance: number;
}
/** The parts of a formations Army that addArmy reads. */
export interface MarchingArmy {
  readonly time: number;
  readonly members: readonly ArmyMember[];
  readonly formations: readonly { readonly kind: 'infantry' | 'cavalry' }[];
  heightAt(x: number, z: number): number;
}

/** Clip names or indices in the person bake. A clip left out falls back as noted. */
export interface ArmyClips {
  /** Standing. Default `'stand'`, else the walk held still. */
  stand?: string | number;
  /** Walking (quick time). Default `'walk'`, else clip 0. */
  walk?: string | number;
  /** Running (double time, a charge). Default `'run'`, else the walk. */
  run?: string | number;
  /** Sitting a horse. Default `'ride'`, else the stand. */
  ride?: string | number;
}

/** Options of {@link addArmy}. */
export interface AddArmyOptions extends CrowdBudget, VATCrowdOptions {
  /** The person every soldier and rider is drawn as, from `bakePerson`. */
  person: PersonBake;
  clips?: ArmyClips;
  /** Ground a clip's cycle covers at scale 1, m: walk 1.524 (two 30 inch steps), run 1.829 (two 36 inch steps). */
  strides?: { walk?: number; run?: number };
  /** Speed of the walk-run change, m/s. Default 2. */
  runAbove?: number;
  /** Speed band the two clips blend across, m/s. Default 0.4. */
  blendBand?: number;
  /** Below this a man stands, m/s. Default 0.1. */
  standBelow?: number;
  /** `'cadence'`: the men keep step; `'route'`: each his own (route step). Default `'cadence'`. */
  step?: 'cadence' | 'route';
  /** Spread of heights, a fraction of the mean (one standard deviation; cut at 2.5). Default 0.04. */
  stature?: number;
  /** Outfits: atlas regions handed out by a seeded hash (`castVariants` fits). Default the whole map. */
  variants?: readonly { readonly offset: readonly number[]; readonly scale: readonly number[] }[];
  /** The person model's facing, radians about +Y from +Z. Default 0. */
  facing?: number;
  /** The horses of cavalry formations, `addHorseCrowd` options; false draws none. Default `{}` when there is cavalry. */
  horses?: HorseCrowdOptions | false;
  /** How riders sit. Defaults as `riderMatrix`, with the person's own height. */
  rider?: Omit<RiderPlacement, 'facing'>;
  /** Seed of heights, outfits and route-step phases. Default 1. */
  seed?: number;
}

/** What {@link addArmy} returns. */
export interface ArmyCrowd {
  readonly army: MarchingArmy;
  /** The foot soldiers, then the riders, as drawn. */
  readonly people: PersonCrowd;
  readonly horses: HorseCrowd | null;
  /** This frame's people (soldiers then riders), as `update` wrote them. */
  readonly persons: readonly CrowdPerson[];
  /**
   * Places everyone for the army's film time and plans the levels for `view` (a core Camera fits, brought up to date at
   * `aspect`, default the canvas's). Call after the army and the camera move.
   */
  update(view: CrowdView, aspect?: number): this;
  dispose(): void;
  [Symbol.dispose](): void;
}

/** A seeded number in [0, 1). */
export const armyHash = (n: number): number => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};
/** A seeded standard normal number, cut at 2.5 (Box and Muller 1958). */
export function armyNormal(n: number): number {
  const u = Math.max(1e-12, armyHash(n * 2 + 1)),
    v = armyHash(n * 2 + 2);
  return Math.max(-2.5, Math.min(2.5, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
}

/** The clips a person plays at a speed, as {@link CrowdPerson} fields. */
export interface StepPose {
  clip: number;
  offset: number;
  blendClip: number;
  blendOffset: number;
  blend: number;
}

/** Resolved clip indices and strides: what {@link stepPose} reads. */
export interface Gaits {
  readonly stand: number;
  readonly walk: number;
  readonly run: number;
  readonly ride: number;
  readonly durations: readonly number[];
  readonly walkStride: number;
  readonly runStride: number;
  readonly runAbove: number;
  readonly blendBand: number;
  readonly standBelow: number;
}

/**
 * Resolves the clip names of `options` against the bake's clips and checks the gait numbers.
 * @throws RangeError for a clip the bake lacks (by index) or numbers out of range.
 */
export function armyGaits(bake: Pick<PersonBake, 'clips'>, options: Pick<AddArmyOptions, 'clips' | 'strides' | 'runAbove' | 'blendBand' | 'standBelow'> = {}): Gaits {
  const clips = bake.clips,
    find = (want: string | number | undefined, name: string): number | undefined => {
      if (typeof want === 'number') {
        if (!(Number.isInteger(want) && want >= 0 && want < clips.length)) throw new RangeError(`addArmy clips.${name} must be a clip index below ${clips.length}`);
        return want;
      }
      const i = clips.findIndex((c) => c.name === (want ?? name));
      if (i < 0 && want !== undefined) throw new RangeError(`addArmy clips.${name}: the bake has no clip named ${want}; it has ${clips.map((c) => c.name).join(', ')}`);
      return i < 0 ? undefined : i;
    },
    c = options.clips ?? {},
    walk = find(c.walk, 'walk') ?? 0,
    run = find(c.run, 'run') ?? walk,
    stand = find(c.stand, 'stand') ?? -1,
    ride = find(c.ride, 'ride') ?? stand,
    walkStride = options.strides?.walk ?? 1.524,
    runStride = options.strides?.run ?? 1.829,
    runAbove = options.runAbove ?? 2,
    blendBand = options.blendBand ?? 0.4,
    standBelow = options.standBelow ?? 0.1;
  if (!(walkStride > 0 && walkStride < 20) || !(runStride > 0 && runStride < 20)) throw new RangeError('addArmy strides must be above 0 and below 20 m');
  if (!(runAbove > 0 && runAbove < 20) || !(blendBand >= 0 && blendBand < runAbove) || !(standBelow >= 0 && standBelow < runAbove))
    throw new RangeError('addArmy runAbove must be 0 to 20 m/s, blendBand and standBelow 0 or more and below it');
  return { stand, walk, run, ride, durations: clips.map((x) => x.duration), walkStride, runStride, runAbove, blendBand, standBelow };
}

const frac = (x: number) => x - Math.floor(x);

/**
 * The clips a man on foot plays: standing below `standBelow`, the walk, the run above `runAbove`, the two blended
 * across `blendBand`, each at the phase the ground covered gives (`distance / (stride * scale)` cycles), shifted by
 * `phase` (0 in step). Standing plays the stand clip on the film clock from `idle` (a fraction of it), so a halted line
does not sway as one.
 */
export function stepPose(g: Gaits, speed: number, distance: number, scale: number, phase: number, time: number, idle = 0): StepPose {
  if (speed < g.standBelow) {
    const clip = g.stand >= 0 ? g.stand : g.walk,
      offset = g.stand >= 0 ? frac(time / g.durations[clip]! + idle) * g.durations[clip]! : frac(distance / (g.walkStride * scale) + phase) * g.durations[clip]!;
    return { clip, offset, blendClip: clip, blendOffset: offset, blend: 0 };
  }
  const walk = frac(distance / (g.walkStride * scale) + phase) * g.durations[g.walk]!,
    run = frac(distance / (g.runStride * scale) + phase) * g.durations[g.run]!,
    lo = g.runAbove - g.blendBand / 2,
    t = g.blendBand > 0 ? Math.min(1, Math.max(0, (speed - lo) / g.blendBand)) : speed >= g.runAbove ? 1 : 0;
  return { clip: g.walk, offset: walk, blendClip: g.run, blendOffset: run, blend: g.run === g.walk ? 0 : t };
}

/**
 * Draws an army: every foot soldier and rider as one person crowd at every distance, every horse in one herd with its
 * rider in the saddle, all following the army's members. Loads the crowd draws and the horse model on first use.
 * @example
 * const army = new Army();
 * army.add({count: 200, shape: 'line', ranks: 2}).march();
 * army.add({count: 40, kind: 'cavalry', shape: 'line', position: [0, -30]}).charge({goal: [0, 120]});
 * const drawn = await addArmy(engine, army, {person: await bakePerson(new Animation(model))});
 * engine.onUpdate((dt) => { army.advanceTime(dt); drawn.update(engine.camera); });
 * @throws TypeError for a missing army or person; RangeError for options out of range.
 */
export async function addArmy(engine: EngineKernel, army: MarchingArmy, options: AddArmyOptions): Promise<ArmyCrowd> {
  if (!army || !Array.isArray(army.formations) || typeof army.heightAt !== 'function') throw new TypeError('addArmy needs a @margoengine/navmesh/formations Army');
  if (!options?.person?.near) throw new TypeError('addArmy needs options.person, a bake from bakePerson');
  const person = options.person,
    gaits = armyGaits(person, options),
    budget = crowdBudget(options),
    stature = options.stature ?? 0.04,
    seed = options.seed ?? 1,
    facing = options.facing ?? 0,
    route = (options.step ?? 'cadence') === 'route',
    variants = options.variants ?? [];
  if (!(stature >= 0 && stature <= 0.3)) throw new RangeError('addArmy stature must be 0 to 0.3 of the mean height');
  if (options.step !== undefined && options.step !== 'cadence' && options.step !== 'route') throw new RangeError("addArmy step must be 'cadence' or 'route'");
  if (!Number.isFinite(facing) || !Number.isFinite(seed)) throw new RangeError('addArmy facing and seed must be finite');
  if (!Array.isArray(variants) || variants.some((v) => v?.offset?.length !== 2 || v?.scale?.length !== 2)) throw new RangeError('addArmy variants must be atlas regions {offset: [u, v], scale: [u, v]}');
  const rider = { height: person.height || 1.75, ...options.rider, facing };
  riderMatrix(new Float32Array(16), 0, 1, rider);
  const cavalry = army.formations.some((f) => f.kind === 'cavalry'),
    people = await PersonCrowd.attach(engine, person, { ...budget, color: options.color, map: options.map, roughness: options.roughness, metalness: options.metalness });
  let horses: HorseCrowd | null = null;
  try {
    if (cavalry && options.horses !== false) {
      const { addHorseCrowd } = await import('@margoengine/horses/crowd');
      horses = await addHorseCrowd(engine as never, { ground: (x, z) => army.heightAt(x, z), ...(options.horses || {}) });
    }
  } catch (error) {
    people.dispose();
    throw error;
  }
  const persons: (CrowdPerson & { matrix: Float32Array })[] = [],
    mounted: ArmyMember[] = [],
    mountedIndex: number[] = [],
    scaleOf = (i: number) => 1 + stature * armyNormal(seed * 7919 + i),
    regionOf = (i: number) => (variants.length ? variants[Math.floor(armyHash(seed * 15485863 + i) * variants.length)] : undefined),
    phaseOf = (i: number) => (route ? armyHash(seed * 104729 + i) : 0),
    cf = Math.cos(facing),
    sf = Math.sin(facing);
  const person0 = (k: number): CrowdPerson & { matrix: Float32Array } => {
    while (persons.length <= k) persons.push({ matrix: new Float32Array(16), clip: 0, offset: 0 } as CrowdPerson & { matrix: Float32Array });
    return persons[k]!;
  };
  let disposed = false;
  const drawn: ArmyCrowd = {
    army,
    people,
    horses,
    get persons() {
      return persons;
    },
    update(view: CrowdView, aspect?: number) {
      if (disposed) throw new RangeError('This army crowd is disposed; call addArmy again for a new one');
      const members = army.members,
        time = army.time;
      let k = 0;
      mounted.length = mountedIndex.length = 0;
      for (let i = 0; i < members.length; i++) {
        const m = members[i]!;
        if (army.formations[m.formation]?.kind === 'cavalry') {
          mounted.push(m);
          mountedIndex.push(i);
          continue;
        }
        const s = scaleOf(i),
          pose = stepPose(gaits, m.speed, m.distance, s, phaseOf(i), time, armyHash(seed * 49979687 + i)),
          p = person0(k++) as { -readonly [K in keyof CrowdPerson]: CrowdPerson[K] } & { matrix: Float32Array },
          h = m.heading,
          c = Math.cos(h),
          n = Math.sin(h),
          // Turned about +Y by the heading less the model's own facing, so the model's forward (sin facing, 0,
          // cos facing) points down the heading: columns x, y, z.
          xc = c * cf + n * sf,
          xs = n * cf - c * sf;
        p.matrix.set([xc * s, 0, -xs * s, 0, 0, s, 0, 0, xs * s, 0, xc * s, 0, m.x, army.heightAt(m.x, m.z), m.z, 1]);
        p.clip = pose.clip;
        p.offset = pose.offset;
        p.blendClip = pose.blendClip;
        p.blendOffset = pose.blendOffset;
        p.blend = pose.blend;
        p.uvTransform = regionOf(i);
      }
      if (horses && mounted.length) {
        horses.update(mounted.map((m) => ({ x: m.x, z: m.z, heading: m.heading, speed: m.speed, distance: m.distance })));
        mounted.forEach((m, j) => {
          const i = mountedIndex[j]!,
            s = scaleOf(i),
            p = person0(k++) as { -readonly [K in keyof CrowdPerson]: CrowdPerson[K] } & { matrix: Float32Array },
            hp = horses!.pose(m.speed, m.distance),
            horseClip = horses!.clips[hp.clip]!,
            // The rider's clip keeps time with the horse's stride: one cycle a stride.
            stridePhase = horseClip.duration > 0 ? hp.offset / horseClip.duration : 0,
            clip = gaits.ride >= 0 ? gaits.ride : gaits.walk;
          riderMatrix(horses!.saddles, j * 16, s, rider, p.matrix);
          p.clip = clip;
          p.offset = frac(stridePhase) * gaits.durations[clip]!;
          p.blendClip = clip;
          p.blendOffset = p.offset;
          p.blend = 0;
          p.uvTransform = regionOf(i);
        });
      }
      // With no herd the riders are not drawn either: a rider in the air is worse than none.
      persons.length = k;
      people.update(persons, view, aspect);
      return drawn;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      people.dispose();
      horses?.dispose();
    },
    [Symbol.dispose]() {
      drawn.dispose();
    },
  };
  return drawn;
}

export type { PersonBake, PersonBakeOptions } from './bake.js';
export { bakePerson } from './bake.js';
export { PersonCrowd, planCrowd, crowdBudget, NEAR, FAR, HIDDEN } from './lod.js';
export type { CrowdBudget, CrowdPerson, CrowdView, PersonCrowdOptions } from './lod.js';
export { riderMatrix } from './riders.js';
export type { RiderPlacement } from './riders.js';
