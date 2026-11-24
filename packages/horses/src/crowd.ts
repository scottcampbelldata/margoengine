/// <reference lib="esnext.disposable" preserve="true" />
// Hundreds of horses in one draw: the horse of ./model.js at crowd detail, its gait clips baked to a bone texture
// (@margoengine/animation/instanced-skin bakeBones) and drawn as one SkinnedCrowd with a coat atlas, so every horse has
// its own coat, place, heading, gait and stride phase and the CPU writes a few numbers per horse per frame. Each horse's
// stride phase is the distance it has travelled over its clip's stride length, so hooves do not slide; near a gait
// boundary the two clips blend by Froude number. Feed it the members of a @margoengine/navmesh/formations Army, or any
// list of {x, z, heading, speed, distance}. Each horse's saddle (the seat point on its moving back and the trunk's
// turn) is read back from the same bone texture on the CPU, so a rider placed there rides the very pose the GPU draws.
import type { Engine } from '@margoengine/core';
import type { BoneBake, SkinnedCrowd } from '@margoengine/animation/instanced-skin';
import { GAITS, GAIT_PATTERNS, froude, type Gait } from './gaits.js';
import { HORSE_COATS, coatAtlas, horseDocument, type HorseClip, type HorseCoat, type HorseModelOptions, type HorseSkeleton } from './model.js';
import type { HorseBody } from './anatomy.js';

/** One horse for {@link HorseCrowd.update}: an Army member fits. */
export interface CrowdHorse {
  readonly x: number;
  readonly z: number;
  /** Radians about +Y, 0 facing +Z. */
  readonly heading: number;
  /** Ground speed, m/s. */
  readonly speed: number;
  /** Metres travelled since time 0. */
  readonly distance: number;
  /** Ground height; default the crowd's `ground`. */
  readonly y?: number;
}

/** Options of {@link addHorseCrowd}. */
export interface HorseCrowdOptions extends Pick<HorseModelOptions, 'type' | 'withers' | 'condition' | 'speeds'> {
  /** Coats to deal out, horse by horse in turn. Default bay, brown, chestnut, black, grey, dun. */
  coats?: readonly HorseCoat[];
  /** Bake rate, frames a second. Default 30. */
  fps?: number;
  /** Ground height under a point. Default flat at 0. */
  ground?: (x: number, z: number) => number;
  /** Most horses, 1 to 65536. Default 1024. */
  capacity?: number;
}

/** What {@link addHorseCrowd} returns. */
export interface HorseCrowd {
  readonly crowd: SkinnedCrowd;
  readonly bake: BoneBake;
  readonly body: HorseBody;
  readonly clips: readonly HorseClip[];
  /** Horses drawn now. */
  readonly count: number;
  /** The clip and blend a horse at this speed and distance draws, as `SkinnedCrowd` instance fields. */
  pose(speed: number, distance: number): { clip: number; offset: number; blendClip: number; blendOffset: number; blend: number };
  /** Places every horse: one per entry, in order, and their saddles. Horses past the list are hidden. */
  update(horses: readonly CrowdHorse[]): this;
  /**
   * The seat frame of every horse drawn, 16 numbers each (column-major, world space): +Y up out of the saddle, +Z
   * toward the head, the origin the lowest point of the seat as the bone texture poses it now. Written by `update`.
   */
  readonly saddles: Float32Array;
  /** The rig the bake follows: `skeleton.index('body')` is the trunk bone the saddle rides. */
  readonly skeleton: HorseSkeleton;
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Froude band either side of a gait boundary where two clips blend. */
const BAND = 0.12;

/**
 * The seat frame of one horse in the world (16 numbers, column-major) from its trunk bone's skinning matrix (12 numbers,
 * the rows of the 3x4, as `@margoengine/animation/instanced-skin` `poseBone` gives it), the saddle's rest point in the
 * model (`skeleton.saddle`) and where the horse stands.
 */
export function saddleFrame(
  trunk: ArrayLike<number>,
  saddle: readonly [number, number, number] | readonly number[],
  horse: { readonly x: number; readonly y: number; readonly z: number; readonly heading: number },
  out: Float32Array = new Float32Array(16),
  at = 0,
): Float32Array {
  const m = trunk,
    [sx, sy, sz] = saddle as [number, number, number],
    c = Math.cos(horse.heading),
    s = Math.sin(horse.heading),
    // Posed seat point and trunk axes in the model, then turned by the heading (about +Y, +Z to (sin, 0, cos)).
    px = m[0]! * sx + m[1]! * sy + m[2]! * sz + m[3]!,
    py = m[4]! * sx + m[5]! * sy + m[6]! * sz + m[7]!,
    pz = m[8]! * sx + m[9]! * sy + m[10]! * sz + m[11]!;
  for (let k = 0; k < 3; k++) {
    // Column k of the trunk's rotation, normalised (the bake interpolates matrices, which shrinks them a hair).
    const ax = m[k]!,
      ay = m[4 + k]!,
      az = m[8 + k]!,
      l = Math.hypot(ax, ay, az) || 1;
    out[at + k * 4] = (c * ax + s * az) / l;
    out[at + k * 4 + 1] = ay / l;
    out[at + k * 4 + 2] = (-s * ax + c * az) / l;
    out[at + k * 4 + 3] = 0;
  }
  out[at + 12] = horse.x + c * px + s * pz;
  out[at + 13] = horse.y + py;
  out[at + 14] = horse.z - s * px + c * pz;
  out[at + 15] = 1;
  return out;
}

/**
 * Builds a crowd of horses: one bake, one draw, a coat each.
 * @example
 * const herd = await addHorseCrowd(engine, {type: 'cavalry'});
 * herd.update(army.members); // after army.advanceTime(dt)
 * @throws TypeError or RangeError for bad options.
 */
export async function addHorseCrowd(engine: Engine, options: HorseCrowdOptions = {}): Promise<HorseCrowd> {
  const coats = options.coats ?? (['bay', 'brown', 'chestnut', 'black', 'grey', 'dun'] as HorseCoat[]),
    fps = options.fps ?? 30,
    ground = options.ground ?? (() => 0),
    capacity = options.capacity ?? 1024;
  if (!Array.isArray(coats) || !coats.length || coats.some((c) => !HORSE_COATS.includes(c)))
    throw new TypeError(`addHorseCrowd coats must be a list of ${HORSE_COATS.join(', ')}`);
  if (!(fps >= 10 && fps <= 120)) throw new RangeError('addHorseCrowd fps must be 10 to 120');
  if (!(Number.isInteger(capacity) && capacity >= 1 && capacity <= 65536)) throw new RangeError('addHorseCrowd capacity must be 1 to 65536');
  if (typeof ground !== 'function') throw new TypeError('addHorseCrowd ground must be a function (x, z) => height');
  // The loader, the bake and the crowd draw load on the first crowd, so importing this entry stays light.
  const [{ parseGLTFAsync }, { Animation }, { bakeBones, SkinnedCrowd, poseBone }, { Texture }] = await Promise.all([
    import('@margoengine/gltf/pbr'),
    import('@margoengine/animation'),
    import('@margoengine/animation/instanced-skin'),
    import('@margoengine/materials'),
  ]);
  const doc = horseDocument({ ...options, coat: 'bay', detail: 0, atlas: true }),
    model = await parseGLTFAsync(engine as never, doc.doc, doc.buffers),
    animation = new Animation(model as never),
    bake = bakeBones(animation, { fps });
  animation.dispose?.();
  (model as unknown as { dispose?(): void }).dispose?.();
  const map = new Texture(coatAtlas(), { mipmaps: false, colorSpace: 'srgb' } as never),
    crowd = SkinnedCrowd.attach(engine as never, bake, { map, roughness: 0.6 }),
    clipIndex = new Map(doc.clips.map((c, i) => [c.name, i])),
    bay = HORSE_COATS.indexOf('bay');
  let count = 0;
  const saddles = new Float32Array(capacity * 16),
    trunkBone = doc.skeleton.index('body'),
    trunk = new Float32Array(12);
  if (!(trunkBone >= 0 && trunkBone < bake.bones)) throw new RangeError('addHorseCrowd needs the trunk bone in the bake; bake the horse of horseDocument');
  const hidden = { matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1e6, 0, 1] };
  const at = (gait: Gait | 'stand', distance: number, time: number) => {
    const c = doc.clips[clipIndex.get(gait)!]!;
    if (gait === 'stand') return { clip: clipIndex.get('stand')!, offset: time % c.duration };
    const p = distance / c.strideLength;
    return { clip: clipIndex.get(gait)!, offset: (p - Math.floor(p)) * c.duration };
  };
  const pose = (speed: number, distance: number) => {
    if (!(speed >= 0) || !Number.isFinite(distance)) throw new RangeError('A crowd horse needs a speed of 0 or more and a finite distance');
    if (speed < 0.05) {
      const a = at('stand', 0, distance);
      return { clip: a.clip, offset: a.offset, blendClip: a.clip, blendOffset: a.offset, blend: 0 };
    }
    const fr = froude(doc.body, speed);
    let gait: Gait = 'gallop';
    for (const g of GAITS)
      if (fr < GAIT_PATTERNS[g].froude[1]) {
        gait = g;
        break;
      }
    const a = at(gait, distance, 0);
    // Near the top of the gait, blend toward the next one.
    const top = GAIT_PATTERNS[gait].froude[1],
      i = GAITS.indexOf(gait),
      nextGait = GAITS[i + 1];
    let blend = 0,
      b = a;
    if (nextGait && fr > top * (1 - BAND)) {
      b = at(nextGait, distance, 0);
      blend = 0.5 * ((fr - top * (1 - BAND)) / (top * BAND));
    }
    return { clip: a.clip, offset: a.offset, blendClip: b.clip, blendOffset: b.offset, blend: Math.min(0.5, blend) };
  };
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    crowd.dispose?.();
    map.dispose?.();
  };
  const herd: HorseCrowd = {
    crowd,
    bake,
    body: doc.body,
    clips: doc.clips,
    saddles,
    skeleton: doc.skeleton,
    get count() {
      return count;
    },
    pose,
    update(horses: readonly CrowdHorse[]) {
      if (!Array.isArray(horses) && !(horses && typeof (horses as ArrayLike<CrowdHorse>).length === 'number'))
        throw new TypeError('HorseCrowd update needs a list of {x, z, heading, speed, distance}');
      if (horses.length > capacity) throw new RangeError(`HorseCrowd holds ${capacity} horses; raise capacity`);
      for (let i = 0; i < horses.length; i++) {
        const h = horses[i]!,
          c = Math.cos(h.heading),
          s = Math.sin(h.heading),
          y = h.y ?? ground(h.x, h.z),
          p = pose(h.speed, h.distance),
          coat = HORSE_COATS.indexOf(coats[i % coats.length]!),
          instance = {
            matrix: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, h.x, y, h.z, 1],
            clip: p.clip,
            offset: p.offset,
            speed: 0,
            blendClip: p.blendClip,
            blendOffset: p.blendOffset,
            blendSpeed: 0,
            blend: p.blend,
            uvTransform: { offset: [(coat - bay) / HORSE_COATS.length, 0], scale: [1, 1] },
          };
        if (i < count) crowd.set(i, instance);
        else crowd.add(instance);
        poseBone(bake, instance, trunkBone, 0, trunk);
        saddleFrame(trunk, doc.skeleton.saddle, { x: h.x, y, z: h.z, heading: h.heading }, saddles, i * 16);
      }
      for (let i = horses.length; i < count; i++) crowd.set(i, hidden);
      count = Math.max(count, horses.length);
      return herd;
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
  return herd;
}
