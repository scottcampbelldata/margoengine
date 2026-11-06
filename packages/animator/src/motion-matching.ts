// Motion matching: no graph. Every frame of the clips becomes a row of features in a database, a few times a second the
// row closest to what the character is doing and where it is asked to go is found, and playback jumps there (S. Clavet,
// "Motion Matching and The Road to Next-Gen Animation", GDC 2016). Jumps are smoothed by inertialization.
//
// The character's root is the hips' path on the ground, smoothed, so the sway of a walk stays in the pose and only the
// journey comes out. A row is measured in that root's frame: the tracked bones' places and speeds, the hips' speed, then
// where the root goes in the next second and which way it faces. Features are centred and scaled per group, so one
// metre and one metre a second weigh the same, and groups can be weighted. The search is exact: boxes around 16 and 64
// rows are skipped when even their nearest corner is worse than the best row so far.
import type { Mesh, Vec3 } from '@margoengine/core/extension';
import { sampleTrackInto } from '@margoengine/animation/sampling';
import { multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import { finiteVector } from '@margoengine/math/validate';
import { MargoError } from '@margoengine/math/errors';
import type { Animator } from './index.js';
import { addInertialization, type Inertialization } from './inertialize.js';

/** A clip in a {@link MotionDatabase}. */
export interface MotionClip {
  /** The clip's name. */
  clip: string;
  /** It loops, so its path carries on past its end. Default the Animation's `options.loop`, which defaults to true. */
  loop?: boolean;
  /** Forward travel to add, units a second, for an in-place clip whose real speed is known. Default 0. */
  speed?: number;
}

/** How much each feature group counts. The path counts most, so a request is answered even with no clip that eases into it. */
export interface MotionWeights {
  /** Tracked bones' places (default 0.5). */
  position?: number;
  /** Tracked bones' speeds (default 0.5). */
  velocity?: number;
  /** The hips' speed (default 1). */
  hips?: number;
  /** Where the path goes (default 2). */
  trajectory?: number;
  /** Which way the path faces (default 1.5). */
  facing?: number;
}

/** Options of {@link MotionDatabase.build}. */
export interface MotionDatabaseOptions {
  /** glTF node index of the hips: their path on the ground, smoothed, is the character's root. */
  root: number;
  /** glTF node indices of the bones to match, usually the feet (1-8). */
  bones: readonly number[];
  /** The clips, by name or with settings. Default every clip of the Animation. */
  clips?: readonly (string | MotionClip)[];
  /** Rows a second, 1-240 (default 30). */
  rate?: number;
  /** Seconds ahead the path is read at, each above 0 (default a third, two thirds and one second). */
  trajectory?: readonly number[];
  /** The way the character faces in the rest pose, in model space (default +Z). */
  forward?: Vec3;
  /** Seconds of the hips' path averaged into the root, so a walk's sway stays in the pose (default 0.5). */
  smoothing?: number;
  /** Feature weights. */
  weights?: MotionWeights;
}

/** One clip of a {@link MotionDatabase}. */
export interface MotionBlock {
  /** Clip name. */
  clip: string;
  /** First row. */
  start: number;
  /** Rows. */
  count: number;
  /** First root. */
  rootStart: number;
  /** Roots: one per row, and on a loop one more that closes the lap. */
  rootCount: number;
  /** Its path carries on past its end. */
  loop: boolean;
  /** Seconds. */
  duration: number;
  /** Forward travel added, units a second. */
  speed: number;
}

/** One search result. */
export interface MotionMatch {
  /** Row index. */
  frame: number;
  /** Clip name. */
  clip: string;
  /** Seconds into the clip. */
  time: number;
  /** Squared distance from the query, in scaled features. */
  cost: number;
}

/** Options of {@link addMotionMatching}. The Animator keeps the object and reads it every frame. */
export interface MotionMatching {
  /** What to match against. */
  database: MotionDatabase;
  /** Where the character is asked to go, world units a second, on the ground plane. Write into it every frame. */
  velocity: Vec3;
  /** Which way it is asked to face, a world direction. Default the way `velocity` points, or as it is when standing. */
  facing?: Vec3 | null;
  /** The node moved and turned, facing +Z at no turn. Default the model's root. */
  character?: Mesh;
  /** Move and turn `character` along the predicted path (default true). False: the game moves it and writes `velocity`. */
  drive?: boolean;
  /** Seconds between searches (default 0.1). */
  interval?: number;
  /** Seconds an inertialized jump takes to settle (default 0.2). */
  blend?: number;
  /** Seconds the character takes to reach a new velocity or facing (default 0.5). */
  response?: number;
  /** How much better a row must be to leave the current one, in cost (default 0.05). */
  stickiness?: number;
}

/** A motion matcher handle. */
export interface MotionMatcher {
  /** The clip playing. */
  readonly clip: string;
  /** Cost of the row last chosen or kept. */
  readonly cost: number;
  /** Jumps so far. */
  readonly jumps: number;
  /** The character's simulated velocity now, world units a second. */
  readonly velocity: readonly [number, number, number];
  /** Searches on the next frame, for an input that changed at once. */
  search(): void;
  /** Stops matching; the Animator keeps playing the current state. */
  dispose(): void;
  [Symbol.dispose](): void;
}

const SMALL_BOX = 16,
  LARGE_BOX = 64,
  AVERAGE = 9,
  MAGIC = 0x4d4d4442,
  VERSION = 1;

type Clip = Animator['animation']['clips'][number];
type Track = Clip['tracks'][number];
/** A rigid move on the ground: x, z and a turn about +Y, at which +Z becomes (sin, cos). */
type Ground = [number, number, number];

const wrapAngle = (angle: number) => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
/** `b` measured in `a`'s frame. */
function relative(a: Ground, b: Ground): Ground {
  const c = Math.cos(a[2]),
    s = Math.sin(a[2]),
    x = b[0] - a[0],
    z = b[1] - a[1];
  return [x * c - z * s, x * s + z * c, b[2] - a[2]];
}
/** `b`, given in `a`'s frame, in the frame `a` is in. */
function compose(a: Ground, b: Ground): Ground {
  const c = Math.cos(a[2]),
    s = Math.sin(a[2]);
  return [a[0] + b[0] * c + b[1] * s, a[1] - b[0] * s + b[1] * c, a[2] + b[2]];
}
const yawQuaternion = (angle: number): number[] => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];

/** Forward kinematics of a few bones from local transforms by node. */
function skeletonOf(animator: Animator) {
  const model = animator.animation.model,
    nodes = model.nodes,
    parents = model.root.engine.store.parents,
    indexOf = new Map(nodes.map((node, i) => [node.id, i])),
    parentOf = nodes.map((node) => indexOf.get(parents[node.id]) ?? -1);
  return {
    parentOf,
    /** Node `bone`'s place, turn and scale in model space. */
    model(
      bone: number,
      place: (i: number) => ArrayLike<number>,
      turn: (i: number) => ArrayLike<number>,
      scale: (i: number) => ArrayLike<number>,
    ) {
      const chain: number[] = [];
      for (let at = bone; at !== -1; at = parentOf[at]) chain.push(at);
      let p: number[] = [0, 0, 0],
        q: number[] = [0, 0, 0, 1],
        s = [1, 1, 1];
      for (let k = chain.length - 1; k >= 0; k--) {
        const i = chain[k],
          local = place(i),
          size = scale(i),
          moved = rotateByQuaternion([local[0] * s[0], local[1] * s[1], local[2] * s[2]], q);
        p = [p[0] + moved[0], p[1] + moved[1], p[2] + moved[2]];
        q = multiplyQuaternions(q, turn(i));
        s = [s[0] * size[0], s[1] * size[1], s[2] * size[2]];
      }
      return { position: p, rotation: q, scale: s };
    },
  };
}

/**
 * Every frame of a set of clips as a searchable table of features. Build it once with {@link MotionDatabase.build}, keep
 * it with {@link MotionDatabase.toBinary} and bring it back with {@link MotionDatabase.fromBinary}.
 */
export class MotionDatabase {
  /** Numbers in a row. */
  readonly width: number;
  /** Rows. */
  readonly rows: number;
  private readonly small: { low: Float32Array; high: Float32Array };
  private readonly large: { low: Float32Array; high: Float32Array };
  private constructor(
    /** The scaled features, row by row. */
    readonly features: Float32Array,
    /** What to subtract from a raw feature before scaling. */
    readonly centres: Float32Array,
    /** What to multiply a centred feature by. */
    readonly scales: Float32Array,
    /** 1 for a row a search may land on: one whose path is all inside its clip. */
    readonly searchable: Uint8Array,
    /** Each clip's own root in model space, x, z and turn, at each row's moment. */
    readonly roots: Float32Array,
    /** Each clip's block of rows. */
    readonly clips: readonly MotionBlock[],
    /** Rows a second. */
    readonly rate: number,
    /** Seconds ahead the path is read at. */
    readonly trajectory: readonly number[],
    /** glTF node index of the hips. */
    readonly root: number,
    /** Tracked glTF node indices. */
    readonly bones: readonly number[],
  ) {
    this.width = centres.length;
    this.rows = features.length / centres.length;
    const width = this.width,
      boxes = (size: number) => {
        const count = Math.ceil(this.rows / size),
          low = new Float32Array(count * width).fill(Infinity),
          high = new Float32Array(count * width).fill(-Infinity);
        for (let row = 0; row < this.rows; row++) {
          const box = Math.floor(row / size) * width;
          for (let i = 0; i < width; i++) {
            const value = features[row * width + i];
            if (value < low[box + i]) low[box + i] = value;
            if (value > high[box + i]) high[box + i] = value;
          }
        }
        return { low, high };
      };
    this.small = boxes(SMALL_BOX);
    this.large = boxes(LARGE_BOX);
  }
  /** First feature of the path: where a row's trajectory starts. */
  get trajectoryAt(): number {
    return this.width - 4 * this.trajectory.length;
  }
  /**
   * Builds the table from `animator`'s clips. A loop's path carries on over its seam; rows of a clip that does not loop
   * whose path runs past its end can be played but not landed on.
   * @throws RangeError for invalid bones or settings, or no rows.
   */
  static build(animator: Animator, options: MotionDatabaseOptions): MotionDatabase {
    const nodes = animator.animation.model.nodes,
      joint = (index: unknown, label: string): number => {
        if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= nodes.length)
          throw new RangeError(`Motion database ${label} ${index} is not one of the model's ${nodes.length} glTF nodes`);
        return index as number;
      };
    const root = joint(options?.root, 'root'),
      bones = options.bones,
      rate = options.rate ?? 30,
      ahead = options.trajectory ?? [1 / 3, 2 / 3, 1],
      forward = options.forward ?? [0, 0, 1],
      smoothing = options.smoothing ?? 0.5,
      weights = options.weights ?? {};
    if (!Array.isArray(bones) || bones.length < 1 || bones.length > 8)
      throw new RangeError('Motion database needs 1-8 bones to match, usually the feet');
    bones.forEach((bone, i) => joint(bone, `bone ${i}`));
    if (!(rate >= 1 && rate <= 240)) throw new RangeError('Motion database rate must be from 1 to 240 rows a second');
    if (!Array.isArray(ahead) || !ahead.length || ahead.some((t) => !(t > 0 && t < Infinity)))
      throw new RangeError('Motion database trajectory must list seconds ahead, each above 0');
    if (!(smoothing >= 0 && smoothing < Infinity)) throw new RangeError('Motion database smoothing must be 0 seconds or more');
    finiteVector(forward, 3, 'Motion database forward');
    const list = (options.clips ?? animator.animation.clips.map((clip) => clip.name)).map((item): Required<MotionClip> => {
      const entry = typeof item === 'string' ? { clip: item } : item;
      if (!(entry.speed === undefined || (entry.speed >= 0 && entry.speed < Infinity)))
        throw new RangeError('Motion database clip speed must be 0 or more');
      return { clip: entry.clip, loop: entry.loop ?? animator.animation.options.loop ?? true, speed: entry.speed ?? 0 };
    });
    const skeleton = skeletonOf(animator),
      local = new Float32Array(4),
      rest = skeleton.model(
        root,
        (i) => animator.restPosition(i),
        (i) => animator.restRotation(i),
        (i) => animator.restScale(i),
      ).rotation,
      // The way the character faces, in the hips' own frame.
      facingInHips = rotateByQuaternion(forward, [-rest[0], -rest[1], -rest[2], rest[3]]);
    const dims = bones.length * 6 + 3 + ahead.length * 4,
      raw: number[] = [],
      searchable: number[] = [],
      roots: number[] = [],
      blocks: MotionBlock[] = [];
    for (const { clip: name, loop, speed } of list) {
      const clip = animator.animation.clips.find((c) => c.name === name);
      if (!clip) throw new RangeError(`Motion database clip "${name}" is not one of the Animation's clips; pass its name`);
      const duration = clip.duration;
      if (!(duration > 0)) throw new RangeError(`Motion database clip "${name}" has no length; pass clips with a duration`);
      const tracks = new Map<string, Track>();
      for (const track of clip.tracks) tracks.set(`${track.node}:${track.path}`, track);
      const sample = (i: number, path: string, time: number, fallback: ArrayLike<number>): ArrayLike<number> => {
        const track = tracks.get(`${i}:${path}`);
        if (!track) return fallback;
        return Array.from(
          sampleTrackInto(track.times, track.values, track.width, time, track.interpolation, path === 'rotation', local),
        );
      };
      const at = (bone: number, time: number) =>
        skeleton.model(
          bone,
          (i) => sample(i, 'translation', time, animator.restPosition(i)),
          (i) => sample(i, 'rotation', time, animator.restRotation(i)),
          (i) => sample(i, 'scale', time, animator.restScale(i)),
        );
      const hipsAt = (time: number): Ground => {
        const hips = at(root, time),
          facing = rotateByQuaternion(facingInHips, hips.rotation);
        return [hips.position[0], hips.position[2], Math.atan2(facing[0], facing[2])];
      };
      // The hips through one lap, turn unwrapped, in the frame the clip starts in.
      const stops = Math.max(2, Math.ceil(duration * rate - 1e-4) + 1),
        timeOf = (i: number) => Math.min(i / rate, duration),
        start = hipsAt(0),
        lapPath: Ground[] = [];
      for (let i = 0, turned = 0, last = start[2]; i < stops; i++) {
        const now = hipsAt(timeOf(i)),
          move = relative(start, now);
        turned += wrapAngle(now[2] - last);
        last = now[2];
        lapPath.push([move[0], move[1], turned]);
      }
      const lap = lapPath[stops - 1],
        back = relative(lap, [0, 0, 0]);
      /** The hips at any time, carried over the laps of a loop. */
      const hipsPath = (time: number): Ground => {
        let travelled: Ground = [0, 0, 0],
          left = loop ? time : Math.min(Math.max(time, 0), duration);
        for (; left >= duration && loop; left -= duration) travelled = compose(travelled, lap);
        for (; left < 0; left += duration) travelled = compose(travelled, back);
        const i = Math.min(stops - 2, Math.floor(left * rate)),
          a = lapPath[i],
          b = lapPath[i + 1],
          k = (left - timeOf(i)) / (timeOf(i + 1) - timeOf(i));
        return compose(travelled, [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
      };
      /** The clip's own root: the hips' path averaged over `smoothing` seconds around `time`. */
      const smoothPath = (time: number): Ground => {
        const sum: Ground = [0, 0, 0];
        for (let k = 0; k < AVERAGE; k++) {
          const place = hipsPath(time + (k / (AVERAGE - 1) - 0.5) * smoothing);
          sum[0] += place[0] / AVERAGE;
          sum[1] += place[1] / AVERAGE;
          sum[2] += place[2] / AVERAGE;
        }
        return sum;
      };
      /** The root's journey in the clip's start frame: the forward travel it was told it has, then its own path. */
      const path = (time: number): Ground =>
        compose([0, speed * (loop ? time : Math.min(time, duration)), 0], smoothPath(time));
      /** A bone in the root's frame. */
      const inRoot = (bone: number, time: number): number[] => {
        const lapTime = loop ? time % duration : Math.min(time, duration),
          place = at(bone, lapTime).position,
          move = relative(compose(start, smoothPath(lapTime)), [place[0], place[2], 0]);
        return [move[0], place[1], move[1]];
      };
      /** How fast a bone goes, in the root's frame at `time`. */
      const speedOf = (bone: number, time: number, here: Ground): number[] => {
        const step = 1 / rate,
          carried = (moment: number) => {
            const place = inRoot(bone, moment),
              moved = compose(path(moment), [place[0], place[2], 0]);
            return [moved[0], place[1], moved[1]];
          },
          now = carried(time),
          next = carried(time + step),
          c = Math.cos(here[2]),
          s = Math.sin(here[2]),
          dx = (next[0] - now[0]) / step,
          dz = (next[2] - now[2]) / step;
        return [dx * c - dz * s, (next[1] - now[1]) / step, dx * s + dz * c];
      };
      const count = loop ? stops - 1 : stops,
        reach = ahead.reduce((a, b) => Math.max(a, b), 0);
      blocks.push({
        clip: name,
        start: searchable.length,
        count,
        rootStart: roots.length / 3,
        rootCount: stops,
        loop,
        duration,
        speed,
      });
      for (let i = 0; i < stops; i++) roots.push(...compose(start, smoothPath(timeOf(i))));
      for (let frame = 0; frame < count; frame++) {
        const time = timeOf(frame),
          here = path(time);
        for (const bone of bones) raw.push(...inRoot(bone, time));
        for (const bone of bones) raw.push(...speedOf(bone, time, here));
        raw.push(...speedOf(root, time, here));
        for (const seconds of ahead) {
          const move = relative(here, path(time + seconds));
          raw.push(move[0], move[1]);
        }
        for (const seconds of ahead) {
          const turn = path(time + seconds)[2] - here[2];
          raw.push(Math.sin(turn), Math.cos(turn));
        }
        searchable.push(loop || time + reach <= duration ? 1 : 0);
      }
    }
    const rows = searchable.length;
    if (!rows) throw new RangeError('Motion database has no rows; pass at least one clip with a duration');
    // Centre each number, and scale each group by its numbers' mean spread.
    const n = bones.length,
      t = ahead.length,
      groups: [number, number, number][] = [
        [0, n * 3, weights.position ?? 0.5],
        [n * 3, n * 3, weights.velocity ?? 0.5],
        [n * 6, 3, weights.hips ?? 1],
        [n * 6 + 3, t * 2, weights.trajectory ?? 2],
        [n * 6 + 3 + t * 2, t * 2, weights.facing ?? 1.5],
      ],
      centres = new Float32Array(dims),
      scales = new Float32Array(dims),
      features = new Float32Array(rows * dims);
    for (const [from, size, weight] of groups) {
      if (!(weight >= 0 && weight < Infinity)) throw new RangeError('Motion database weights must be 0 or more');
      let spread = 0;
      for (let i = from; i < from + size; i++) {
        let sum = 0;
        for (let row = 0; row < rows; row++) sum += raw[row * dims + i];
        centres[i] = sum / rows;
        let squares = 0;
        for (let row = 0; row < rows; row++) squares += (raw[row * dims + i] - centres[i]) ** 2;
        spread += Math.sqrt(squares / rows) / size;
      }
      for (let i = from; i < from + size; i++) scales[i] = weight / (spread > 1e-9 ? spread : 1);
    }
    for (let row = 0; row < rows; row++)
      for (let i = 0; i < dims; i++) features[row * dims + i] = (raw[row * dims + i] - centres[i]) * scales[i];
    return new MotionDatabase(
      features,
      centres,
      scales,
      Uint8Array.from(searchable),
      Float32Array.from(roots),
      blocks,
      rate,
      [...ahead],
      root,
      [...bones],
    );
  }
  private block(clip: string): MotionBlock {
    const block = this.clips.find((entry) => entry.clip === clip);
    if (!block) throw new RangeError(`Motion database has no clip "${clip}"; pass a clip it was built from`);
    return block;
  }
  /** The row of `clip` at `time` seconds, wrapped on a loop and held at the ends otherwise. */
  frameAt(clip: string, time: number): number {
    const block = this.block(clip),
      lap = block.loop ? ((time % block.duration) + block.duration) % block.duration : time,
      row = Math.round(lap * this.rate);
    return block.start + (block.loop ? row % block.count : Math.min(block.count - 1, Math.max(0, row)));
  }
  /** The clip's own root at `time` seconds of its lap, into `out` as x, z and turn. */
  rootAt(clip: string, time: number, out: [number, number, number]): [number, number, number] {
    const block = this.block(clip),
      i = Math.max(0, Math.min(block.rootCount - 2, Math.floor(time * this.rate))),
      from = i / this.rate,
      to = Math.min((i + 1) / this.rate, block.duration),
      k = Math.max(0, Math.min(1, (time - from) / (to - from))),
      at = (block.rootStart + i) * 3,
      roots = this.roots;
    for (let c = 0; c < 3; c++) out[c] = roots[at + c] + (roots[at + 3 + c] - roots[at + c]) * k;
    return out;
  }
  /** Squared distance from `query` to row `frame`. */
  cost(query: ArrayLike<number>, frame: number): number {
    const width = this.width,
      at = frame * width;
    let sum = 0;
    for (let i = 0; i < width; i++) {
      const d = query[i] - this.features[at + i];
      sum += d * d;
    }
    return sum;
  }
  /** What a row stands for. */
  match(frame: number, cost = 0): MotionMatch {
    const block = this.clips.find((entry) => frame >= entry.start && frame < entry.start + entry.count);
    if (!block) throw new RangeError(`Motion database has no row ${frame}; pass a row below ${this.rows}`);
    return { frame, clip: block.clip, time: Math.min(block.duration, (frame - block.start) / this.rate), cost };
  }
  /**
   * The row nearest `query` (scaled features, a row's length) that a search may land on. Exact: it returns what comparing
   * every row would, skipping boxes of rows that cannot win.
   * @throws RangeError for a query of the wrong length, or a database with no row to land on.
   */
  search(query: ArrayLike<number>): MotionMatch {
    const width = this.width,
      rows = this.rows,
      features = this.features;
    if (query?.length !== width) throw new RangeError(`Motion query must hold ${width} numbers, a row's length`);
    const lowest = (box: { low: Float32Array; high: Float32Array }, at: number, limit: number): number => {
      let sum = 0;
      for (let i = 0; i < width && sum < limit; i++) {
        const q = query[i],
          low = box.low[at + i],
          high = box.high[at + i],
          d = q < low ? low - q : q > high ? q - high : 0;
        sum += d * d;
      }
      return sum;
    };
    let best = -1,
      bestCost = Infinity;
    for (let large = 0; large < rows; large += LARGE_BOX) {
      if (lowest(this.large, (large / LARGE_BOX) * width, bestCost) >= bestCost) continue;
      const end = Math.min(rows, large + LARGE_BOX);
      for (let small = large; small < end; small += SMALL_BOX) {
        if (lowest(this.small, (small / SMALL_BOX) * width, bestCost) >= bestCost) continue;
        const stop = Math.min(rows, small + SMALL_BOX);
        for (let row = small; row < stop; row++) {
          if (!this.searchable[row]) continue;
          const at = row * width;
          let sum = 0;
          for (let i = 0; i < width && sum < bestCost; i++) {
            const d = query[i] - features[at + i];
            sum += d * d;
          }
          if (sum < bestCost) {
            bestCost = sum;
            best = row;
          }
        }
      }
    }
    if (best === -1) throw new RangeError('Motion database has no row to land on; pass longer or looping clips');
    return this.match(best, bestCost);
  }
  /** The whole table as bytes, to store and load with {@link MotionDatabase.fromBinary}. */
  toBinary(): ArrayBuffer {
    const header = new TextEncoder().encode(
        JSON.stringify({
          clips: this.clips,
          rate: this.rate,
          trajectory: this.trajectory,
          root: this.root,
          bones: this.bones,
          width: this.width,
          rows: this.rows,
          roots: this.roots.length,
        }),
      ),
      padded = Math.ceil((12 + header.length) / 4) * 4,
      floats = (this.rows + 2) * this.width + this.roots.length,
      bytes = new ArrayBuffer(padded + floats * 4 + this.rows),
      view = new DataView(bytes);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, VERSION, true);
    view.setUint32(8, header.length, true);
    new Uint8Array(bytes).set(header, 12);
    const out = new Float32Array(bytes, padded, floats);
    out.set(this.features);
    out.set(this.centres, this.features.length);
    out.set(this.scales, this.features.length + this.width);
    out.set(this.roots, this.features.length + this.width * 2);
    new Uint8Array(bytes, padded + floats * 4).set(this.searchable);
    return bytes;
  }
  /**
   * A table from {@link MotionDatabase.toBinary}.
   * @throws RangeError for bytes that are not such a table.
   */
  static fromBinary(bytes: ArrayBuffer): MotionDatabase {
    const view = new DataView(bytes);
    if (bytes.byteLength < 12 || view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== VERSION)
      throw new RangeError('Not a motion database; pass the bytes toBinary() returned');
    const length = view.getUint32(8, true),
      head = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 12, length))),
      padded = Math.ceil((12 + length) / 4) * 4,
      count = head.rows * head.width,
      floats = count + head.width * 2 + head.roots;
    if (bytes.byteLength !== padded + floats * 4 + head.rows)
      throw new RangeError('Motion database bytes are cut short; pass all the bytes toBinary() returned');
    const all = new Float32Array(bytes, padded, floats);
    return new MotionDatabase(
      all.slice(0, count),
      all.slice(count, count + head.width),
      all.slice(count + head.width, count + head.width * 2),
      new Uint8Array(bytes, padded + floats * 4, head.rows).slice(),
      all.slice(count + head.width * 2),
      head.clips,
      head.rate,
      head.trajectory,
      head.root,
      head.bones,
    );
  }
}

/** One state per clip, named after it: the `states` a matcher's Animator needs. */
export function motionStates(animation: Animator['animation']): Record<string, string> {
  return Object.fromEntries(animation.clips.map((clip) => [clip.name, clip.name]));
}

/**
 * Plays `animator` by motion matching: write where the character should go into `matching.velocity`, and a few times a
 * second the row of `matching.database` that best continues the current pose along that path is found and played, with
 * inertialized jumps. The Animator needs one state per clip ({@link motionStates}). The clips play in place and the
 * character moves along the predicted path; `drive: false` leaves moving it to the game. Returns the handle; dispose it
 * to stop.
 * @throws RangeError for invalid settings, or a database clip with no state of that name.
 */
export function addMotionMatching(animator: Animator, matching: MotionMatching): MotionMatcher {
  const database = matching?.database;
  if (!(database instanceof MotionDatabase))
    throw new TypeError('Motion matching needs a database; pass one from MotionDatabase.build');
  for (const { clip } of database.clips)
    if (animator.options.states[clip] !== clip)
      throw new RangeError(`Motion matching needs a state per clip, and "${clip}" has none; pass states: motionStates(animation)`);
  if (!database.clips.some((block) => block.clip === animator.state))
    throw new RangeError(`Motion matching needs the Animator in a database clip, not "${animator.state}"; pass initial: a clip name`);
  const read = () => {
    const interval = matching.interval ?? 0.1,
      response = matching.response ?? 0.5,
      stickiness = matching.stickiness ?? 0.05;
    finiteVector(matching.velocity, 3, 'Motion matching velocity');
    if (matching.facing) finiteVector(matching.facing, 3, 'Motion matching facing');
    if (!(interval > 0 && interval < Infinity)) throw new RangeError('Motion matching interval must be above 0 seconds');
    if (!(response > 0 && response < Infinity)) throw new RangeError('Motion matching response must be above 0 seconds');
    if (!(stickiness >= 0 && stickiness < Infinity)) throw new RangeError('Motion matching stickiness must be 0 or more');
    return { interval, damping: 4 / response, stickiness };
  };
  read();
  const model = animator.animation.model,
    inertia: Inertialization = addInertialization(animator, { duration: matching.blend ?? 0.2 }),
    character = matching.character ?? model.root,
    t = model.root.engine.store.transforms,
    id = character.id,
    skeleton = skeletonOf(animator),
    root = database.root,
    above = skeleton.parentOf[root],
    loops = animator.animation.options.loop ?? true,
    lengths = new Map(database.clips.map((block) => [block.clip, block.duration])),
    query = new Float32Array(database.width),
    ahead = database.trajectory,
    here: [number, number, number] = [0, 0, 0],
    scale = (i: number) => animator.restScale(i);
  // The character as simulated: velocity and its rate of change, and a facing and its rate.
  const velocity: [number, number, number] = [0, 0, 0],
    acceleration = [0, 0];
  let facing = 2 * Math.atan2(t.qy[id], t.qw[id]),
    facingRate = 0,
    wait = 0,
    cost = 0,
    jumps = 0,
    removed = false;
  // The clip plays in place: its root comes out of the hips, in the frame of the hips' parent. The sway stays.
  const removeStep = animator.addPoseStep((position, rotation) => {
    const state = animator.state,
      length = lengths.get(state);
    if (length === undefined) return;
    const place = (i: number) => position[i],
      turn = (i: number) => rotation[i],
      hips = skeleton.model(root, place, turn, scale);
    database.rootAt(state, loops ? animator.time % length : Math.min(animator.time, length), here);
    const undo = yawQuaternion(-here[2]),
      flat = rotateByQuaternion([hips.position[0] - here[0], hips.position[1], hips.position[2] - here[1]], undo),
      turned = multiplyQuaternions(undo, hips.rotation);
    if (above === -1) {
      position[root] = [flat[0], flat[1], flat[2]];
      rotation[root] = turned;
      return;
    }
    const parent = skeleton.model(above, place, turn, scale),
      back = [-parent.rotation[0], -parent.rotation[1], -parent.rotation[2], parent.rotation[3]],
      inParent = rotateByQuaternion(
        [flat[0] - parent.position[0], flat[1] - parent.position[1], flat[2] - parent.position[2]],
        back,
      );
    position[root] = [inParent[0] / parent.scale[0], inParent[1] / parent.scale[1], inParent[2] / parent.scale[2]];
    rotation[root] = multiplyQuaternions(back, turned);
  });
  /** Where a critically damped velocity goes in `seconds`: the change of place, and the velocity and its rate there. */
  const glide = (v: number, a: number, goal: number, damping: number, seconds: number): [number, number, number] => {
    const u = v - goal,
      j = a + u * damping,
      e = Math.exp(-damping * seconds),
      moved = goal * seconds + (u / damping) * (1 - e) + (j / (damping * damping)) * (1 - e * (1 + damping * seconds));
    return [moved, goal + e * (u + j * seconds), e * (a - j * damping * seconds)];
  };
  const removeSolver = animator.addSolver((step) => {
    const { interval, damping, stickiness } = read(),
      goal = matching.velocity,
      wanted = matching.facing ?? (Math.hypot(goal[0], goal[2]) > 1e-3 ? goal : null),
      goalFacing = wanted ? facing + wrapAngle(Math.atan2(wanted[0], wanted[2]) - facing) : facing,
      x = glide(velocity[0], acceleration[0], goal[0], damping, step),
      z = glide(velocity[2], acceleration[1], goal[2], damping, step);
    velocity[0] = x[1];
    velocity[2] = z[1];
    acceleration[0] = x[2];
    acceleration[1] = z[2];
    const offset = facing - goalFacing,
      j = facingRate + offset * damping,
      e = Math.exp(-damping * step);
    facing = goalFacing + e * (offset + j * step);
    facingRate = e * (facingRate - j * damping * step);
    if (matching.drive ?? true) {
      character.setPosition([t.x[id] + x[0], t.y[id], t.z[id] + z[0]]);
      character.setQuaternion(yawQuaternion(facing));
    }
    wait -= step;
    const state = animator.state,
      current = database.frameAt(state, animator.time),
      ended = !database.searchable[current];
    if (wait > 0 && !ended) return;
    wait = interval;
    // The query: the current row, with the path the character is asked to follow.
    const at = current * database.width,
      path = database.trajectoryAt,
      count = ahead.length,
      c = Math.cos(facing),
      s = Math.sin(facing),
      m = model.root.matrix,
      // Rows are in model units; velocity is in world units.
      units = 1 / (Math.hypot(m[0], m[1], m[2]) || 1),
      left = facing - goalFacing,
      rate = facingRate + left * damping;
    for (let i = 0; i < path; i++) query[i] = database.features[at + i];
    for (let k = 0; k < count; k++) {
      const seconds = ahead[k],
        dx = glide(velocity[0], acceleration[0], goal[0], damping, seconds)[0],
        dz = glide(velocity[2], acceleration[1], goal[2], damping, seconds)[0],
        turned = goalFacing + Math.exp(-damping * seconds) * (left + rate * seconds) - facing,
        place = path + k * 2,
        side = path + count * 2 + k * 2;
      query[place] = ((dx * c - dz * s) * units - database.centres[place]) * database.scales[place];
      query[place + 1] = ((dx * s + dz * c) * units - database.centres[place + 1]) * database.scales[place + 1];
      query[side] = (Math.sin(turned) - database.centres[side]) * database.scales[side];
      query[side + 1] = (Math.cos(turned) - database.centres[side + 1]) * database.scales[side + 1];
    }
    const best = database.search(query),
      kept = database.cost(query, current),
      near = best.clip === state && Math.abs(best.frame - current) <= database.rate * 0.2;
    cost = kept;
    if (near || (!ended && best.cost >= kept - stickiness)) return;
    cost = best.cost;
    jumps++;
    if (best.clip === state) inertia.smooth();
    else animator.transition(best.clip, 0);
    animator.enterAt(best.time);
  });
  const handle: MotionMatcher = {
    get clip() {
      return animator.state;
    },
    get cost() {
      return cost;
    },
    get jumps() {
      return jumps;
    },
    velocity,
    search() {
      if (removed) throw new MargoError('disposed', 'Motion matcher is disposed; add a new one');
      wait = 0;
    },
    dispose() {
      if (removed) return;
      removed = true;
      removeStep();
      removeSolver();
      inertia.dispose();
    },
    [Symbol.dispose]() {
      handle.dispose();
    },
  };
  return handle;
}
