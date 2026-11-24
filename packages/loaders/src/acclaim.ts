// Acclaim ASF/AMC motion capture (the CMU Graphics Lab Motion Capture Database's format), written from the format's
// public description: the Acclaim Skeleton File definition v1.10 (Acclaim Entertainment, 1994). ASF bone directions
// and axes are given in the skeleton's world frame at rest; a bone's motion M turns it in its own frame C, so its
// world turn is C M C^-1, which lets every joint rest unrotated as BVH's do and tracks compose parent to child.
import type { BVH, BVHBone, BVHKey, BVHTrack } from './mocap.js';
import { multiplyQuaternions } from '@margoengine/math/quat';
import { LoaderError } from './types.js';
import { type BinaryInput, toText } from './util.js';

const A = 'ASF',
  M = 'AMC';

/** One bone of an {@link ASFSkeleton}, as {@link parseAMC} reads it. */
export interface ASFBoneData {
  /** The bone's name; `root` for the root. */
  readonly name: string;
  /** Unit direction from the bone's start to its end, in the rest frame. */
  readonly direction: readonly [number, number, number];
  /** Length in file units. */
  readonly length: number;
  /** The bone's frame C in the rest frame, as a quaternion [x, y, z, w]. */
  readonly axis: readonly [number, number, number, number];
  /** The AMC values this bone reads, in file order: `tx` `ty` `tz` `rx` `ry` `rz`, or `l` (length, read and unused). */
  readonly dof: readonly string[];
}

/** What {@link parseASF} returns: the skeleton {@link parseAMC} plays a motion file on. */
export interface ASFSkeleton {
  /** The skeleton name the file gives (`:name`), or ''. */
  readonly name: string;
  /**
   * The joints, parents first, in `parseBVH`'s shape: `root`, then one joint per bone at the bone's start (its parent
   * bone's end), resting unrotated. A bone with no children carries its own end as `endSite`.
   */
  readonly bones: BVHBone[];
  /** The `:units length` value the file gives (CMU files: 0.45 for inches, so metres are `0.0254 / 0.45` times file units). */
  readonly lengthUnit: number;
  /** Angles in degrees (`:units angle deg`, the default) or radians. */
  readonly angle: 'deg' | 'rad';
  /** Per-joint data in the order of `bones`. */
  readonly data: readonly ASFBoneData[];
  /** The multiplier `parseASF` applied to lengths, which `parseAMC` applies to root translations. */
  readonly scale: number;
}

/** Options of {@link parseASF}. */
export interface ASFOptions {
  /** Multiplies lengths and root positions. Default 1 (file units); CMU files in metres: `0.0254 / 0.45`. */
  scale?: number;
  /** Most bones. Default 4,096. */
  maxJoints?: number;
}

/** Options of {@link parseAMC}. */
export interface AMCOptions {
  /** Seconds per frame; AMC files do not store it. Default 1/120 (most CMU trials; the database lists 60 for some). */
  frameTime?: number;
  /** The clip's name. Default `'mocap'`. */
  name?: string;
  /** Most keys, frames times tracks. Default 4,000,000. */
  maxKeys?: number;
}

type Q = [number, number, number, number];
const qmul = (a: Q, b: Q): Q => multiplyQuaternions(a, b);
const qaxis = (axis: number, radians: number): Q => {
  const q: Q = [0, 0, 0, Math.cos(radians / 2)];
  q[axis] = Math.sin(radians / 2);
  return q;
};
/**
 * Acclaim Euler angles: the listed axes turn a vector one after another, first listed first, each about the fixed
 * frame's axis (`axis 10 20 30 XYZ` is Rz Ry Rx with column vectors: the X turn is applied first).
 */
function acclaimEuler(axes: readonly number[], radians: readonly number[]): Q {
  let q: Q = [0, 0, 0, 1];
  for (let i = 0; i < axes.length; i++) q = qmul(qaxis(axes[i], radians[i]), q);
  return q;
}
const AXIS: Record<string, number> = { x: 0, y: 1, z: 2 };

function orderOf(word: string | undefined, what: string): number[] {
  const w = (word ?? '').toLowerCase();
  if (!/^[xyz]{3}$/.test(w) || new Set(w).size !== 3)
    throw new LoaderError(A, 'syntax', `${what} order "${w.slice(0, 8)}" is not a permutation of XYZ`);
  return [...w].map((c) => AXIS[c]);
}

/**
 * Parses an Acclaim ASF skeleton (the CMU motion capture database's `.asf`). Bones become joints at each bone's start,
 * resting unrotated with offsets in the file's world frame, so {@link parseAMC} gives tracks that the animation
 * package plays and the rigging package's `cmu` retarget preset maps. Joint limits, ids and masses are read past.
 *
 * @param input The file's bytes or text.
 * @param options Scale and the joint limit.
 * @returns The skeleton to pass to {@link parseAMC}.
 * @throws LoaderError with format `ASF` and code `header`, `syntax`, `range`, `truncated` or `limit`.
 *
 * @example
 * ```ts
 * import { parseASF } from '@margoengine/loaders/mocap';
 *
 * const skeleton = parseASF(':root\n axis XYZ\n order TX TY TZ RX RY RZ\n:bonedata\n begin\n  name spine\n  direction 0 1 0\n  length 2\n  axis 0 0 0 XYZ\n  dof rx\n end\n:hierarchy\n begin\n  root spine\n end\n');
 * console.log(skeleton.bones.map((b) => b.name), skeleton.bones[1].endSite); // [ 'root', 'spine' ] [ 0, 2, 0 ]
 * ```
 */
export function parseASF(input: BinaryInput | string, options: ASFOptions = {}): ASFSkeleton {
  const text = toText(input, A),
    { scale = 1, maxJoints = 4096 } = options;
  if (!Number.isFinite(scale) || scale <= 0) throw new LoaderError(A, 'range', 'scale must be positive and finite');
  if (!Number.isSafeInteger(maxJoints) || maxJoints < 1)
    throw new LoaderError(A, 'range', 'maxJoints must be a positive integer');
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
  if (!lines.some((l) => /^:(root|bonedata)\b/i.test(l)))
    throw new LoaderError(A, 'header', 'missing the :root and :bonedata sections');
  const num = (token: string | undefined, what: string): number => {
    if (token === undefined) throw new LoaderError(A, 'truncated', `${what} is missing`);
    const v = Number(token);
    if (!Number.isFinite(v)) throw new LoaderError(A, 'syntax', `invalid number "${token.slice(0, 32)}" for ${what}`);
    return v;
  };
  interface Bone {
    name: string;
    direction: [number, number, number];
    length: number;
    angles: number[];
    order: number[];
    dof: string[];
  }
  let name = '',
    lengthUnit = 1,
    angle: 'deg' | 'rad' = 'deg',
    section = '',
    current: Bone | null = null;
  const root = { order: [] as string[], axis: [0, 1, 2], position: [0, 0, 0], orientation: [0, 0, 0] },
    bones: Bone[] = [],
    hierarchy: string[][] = [];
  for (const line of lines) {
    const words = line.split(/\s+/);
    if (words[0].startsWith(':')) {
      section = words[0].toLowerCase();
      if (section === ':name') name = words.slice(1).join(' ');
      continue;
    }
    const key = words[0].toLowerCase();
    if (section === ':units') {
      if (key === 'length') {
        lengthUnit = num(words[1], 'units length');
        if (!(lengthUnit > 0)) throw new LoaderError(A, 'range', `units length ${lengthUnit} is not positive`);
      } else if (key === 'angle') {
        const a = (words[1] ?? '').toLowerCase();
        if (a !== 'deg' && a !== 'rad')
          throw new LoaderError(A, 'syntax', `angle unit "${a.slice(0, 16)}" is not deg or rad`);
        angle = a;
      }
    } else if (section === ':root') {
      if (key === 'order') root.order = words.slice(1).map((w) => w.toLowerCase());
      else if (key === 'axis') root.axis = orderOf(words[1], 'root axis');
      else if (key === 'position') root.position = [1, 2, 3].map((i) => num(words[i], 'root position'));
      else if (key === 'orientation') root.orientation = [1, 2, 3].map((i) => num(words[i], 'root orientation'));
    } else if (section === ':bonedata') {
      if (key === 'begin') {
        if (current) throw new LoaderError(A, 'syntax', 'a bone begins inside another bone');
        if (bones.length + 1 >= maxJoints)
          throw new LoaderError(A, 'limit', `bone count exceeds the limit of ${maxJoints}`);
        current = { name: '', direction: [0, 0, 0], length: 0, angles: [0, 0, 0], order: [0, 1, 2], dof: [] };
      } else if (key === 'end') {
        if (!current) throw new LoaderError(A, 'syntax', 'end has no bone to close');
        const n = current.name;
        if (!n) throw new LoaderError(A, 'syntax', 'a bone has no name');
        if (n === 'root' || bones.some((b) => b.name === n))
          throw new LoaderError(A, 'syntax', `bone "${n.slice(0, 32)}" is named twice`);
        bones.push(current);
        current = null;
      } else if (!current) {
        throw new LoaderError(A, 'syntax', `"${key.slice(0, 32)}" is outside every bone`);
      } else if (key === 'name') current.name = words[1] ?? '';
      else if (key === 'direction') {
        const d = [1, 2, 3].map((i) => num(words[i], `bone ${current!.name} direction`)),
          l = Math.hypot(d[0], d[1], d[2]);
        current.direction = (l > 0 ? d.map((v) => v / l) : [0, 0, 0]) as [number, number, number];
      } else if (key === 'length') {
        current.length = num(words[1], `bone ${current.name} length`);
        if (current.length < 0) throw new LoaderError(A, 'range', `bone ${current.name} has a negative length`);
      } else if (key === 'axis') {
        current.angles = [1, 2, 3].map((i) => num(words[i], `bone ${current!.name} axis`));
        current.order = orderOf(words[4], `bone ${current.name} axis`);
      } else if (key === 'dof') {
        current.dof = words.slice(1).map((w) => w.toLowerCase());
        for (const d of current.dof)
          if (!/^(t[xyz]|r[xyz]|l)$/.test(d))
            throw new LoaderError(A, 'syntax', `bone ${current.name} has an unknown dof "${d.slice(0, 16)}"`);
      }
      // id, bodymass, cofmass and limits (with their continuation lines) are read past.
    } else if (section === ':hierarchy') {
      if (key !== 'begin' && key !== 'end') hierarchy.push(words);
    }
  }
  if (current) throw new LoaderError(A, 'truncated', `bone "${current.name.slice(0, 32)}" has no end`);
  for (const r of root.order)
    if (!/^(t[xyz]|r[xyz])$/.test(r))
      throw new LoaderError(A, 'syntax', `root order has an unknown channel "${r.slice(0, 16)}"`);

  const toRad = angle === 'deg' ? Math.PI / 180 : 1,
    all: ASFBoneData[] = [
      {
        name: 'root',
        direction: [0, 0, 0],
        length: 0,
        axis: acclaimEuler(
          root.axis,
          root.orientation.map((v) => v * toRad),
        ),
        dof: root.order,
      },
      ...bones.map((b) => ({
        name: b.name,
        direction: b.direction,
        length: b.length,
        axis: acclaimEuler(
          b.order,
          b.angles.map((v) => v * toRad),
        ),
        dof: b.dof,
      })),
    ],
    index = new Map(all.map((b, i) => [b.name, i])),
    parent = new Int32Array(all.length).fill(-2);
  parent[0] = -1;
  for (const [p, ...children] of hierarchy) {
    const pi = index.get(p);
    if (pi === undefined) throw new LoaderError(A, 'syntax', `hierarchy names an unknown bone "${p.slice(0, 32)}"`);
    for (const c of children) {
      const ci = index.get(c);
      if (ci === undefined || ci === 0)
        throw new LoaderError(A, 'syntax', `hierarchy names an unknown bone "${c.slice(0, 32)}"`);
      if (parent[ci] !== -2) throw new LoaderError(A, 'syntax', `bone "${c.slice(0, 32)}" has two parents`);
      parent[ci] = pi;
    }
  }
  // Parents first: walk down from the root; a bone the walk never reaches is outside the hierarchy.
  const children: number[][] = all.map(() => []);
  for (let i = 1; i < all.length; i++) {
    if (parent[i] === -2)
      throw new LoaderError(A, 'syntax', `bone "${all[i].name.slice(0, 32)}" is not in the hierarchy`);
    children[parent[i]].push(i);
  }
  const order = [0];
  for (let k = 0; k < order.length; k++) order.push(...children[order[k]]);
  const slot = new Map(order.map((i, k) => [i, k]));
  const end = (i: number) => all[i].direction.map((v) => v * all[i].length * scale) as [number, number, number];
  const out: BVHBone[] = order.map((i) => {
    const p = parent[i],
      bone: BVHBone = {
        name: all[i].name,
        parent: p < 0 ? -1 : slot.get(p)!,
        translation:
          i === 0 ? (root.position.map((v) => v * scale) as [number, number, number]) : p === 0 ? [0, 0, 0] : end(p),
        rotation: [0, 0, 0, 1],
      };
    if (i > 0 && !children[i].length) bone.endSite = end(i);
    return bone;
  });
  return { name, bones: out, lengthUnit, angle, data: order.map((i) => all[i]), scale };
}

/**
 * Parses an Acclaim AMC motion (the CMU database's `.amc`) for the skeleton {@link parseASF} read. Each frame turns
 * every bone that has rotation degrees of freedom by its Euler angles in the bone's own frame (each listed axis applied
 * in turn, first listed first) and moves the root from its rest position by its translation channels. Every bone with
 * degrees of freedom must have a line in every frame.
 *
 * @param input The file's bytes or text.
 * @param skeleton What {@link parseASF} returned for the trial's subject.
 * @param options Frame time, clip name and the key limit.
 * @returns The skeleton's bones, a clip in `parseBVH`'s shape (for `createKeyframeClip`) and the frame timing.
 * @throws LoaderError with format `AMC` and code `header`, `syntax`, `range` or `limit`.
 *
 * @example
 * ```ts
 * import { parseAMC, parseASF } from '@margoengine/loaders/mocap';
 *
 * const skeleton = parseASF(':root\n axis XYZ\n order TX TY TZ RX RY RZ\n:bonedata\n begin\n  name spine\n  direction 0 1 0\n  length 2\n  axis 0 0 0 XYZ\n  dof rx\n end\n:hierarchy\n begin\n  root spine\n end\n');
 * const { clip, frames } = parseAMC(':FULLY-SPECIFIED\n:DEGREES\n1\nroot 0 1 0 0 0 0\nspine 90\n', skeleton);
 * console.log(frames, clip.tracks.map((t) => `${t.target} ${t.path}`)); // 1 [ 'root translation', 'root rotation', 'spine rotation' ]
 * ```
 */
export function parseAMC(input: BinaryInput | string, skeleton: ASFSkeleton, options: AMCOptions = {}): BVH {
  const text = toText(input, M),
    { frameTime = 1 / 120, name = 'mocap', maxKeys = 4_000_000 } = options;
  if (!skeleton || !Array.isArray(skeleton.bones) || !Array.isArray(skeleton.data))
    throw new LoaderError(M, 'range', 'parseAMC needs the skeleton parseASF returned');
  if (!(frameTime > 0) || !Number.isFinite(frameTime))
    throw new LoaderError(M, 'range', `frame time ${frameTime} is not positive`);
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 0)
    throw new LoaderError(M, 'range', 'maxKeys must be a non-negative integer');
  const toRad = skeleton.angle === 'deg' ? Math.PI / 180 : 1,
    data = skeleton.data,
    byName = new Map(data.map((d, i) => [d.name, i])),
    listed = data.map((d, i) => (d.dof.length ? i : -1)).filter((i) => i >= 0),
    tracks: BVHTrack[] = [],
    rotationKeys = new Map<number, BVHKey[]>(),
    rootMoves = data[0].dof.some((c: string) => c[0] === 't'),
    rootKeys: BVHKey[] = [];
  if (rootMoves) tracks.push({ target: data[0].name, path: 'translation', keys: rootKeys });
  for (const i of listed)
    if (data[i].dof.some((c: string) => c[0] === 'r')) {
      const keys: BVHKey[] = [];
      rotationKeys.set(i, keys);
      tracks.push({ target: data[i].name, path: 'rotation', keys });
    }
  const lines = text.split(/\r?\n/),
    values = new Map<number, number[]>(),
    rest = skeleton.bones[0].translation;
  let k = 0,
    frames = 0;
  for (; k < lines.length; k++) {
    const l = lines[k].trim();
    if (/^\d+$/.test(l)) break;
    if (l && !l.startsWith('#') && !l.startsWith(':'))
      throw new LoaderError(M, 'header', `unexpected "${l.slice(0, 32)}" before the first frame`);
  }
  const flush = () => {
    if ((frames + 1) * tracks.length > maxKeys)
      throw new LoaderError(
        M,
        'limit',
        `${frames + 1} frames of ${tracks.length} tracks exceed the limit of ${maxKeys} keys`,
      );
    const time = frames * frameTime;
    for (const i of listed) {
      const d = data[i],
        v = values.get(i);
      if (!v) throw new LoaderError(M, 'syntax', `frame ${frames + 1} has no line for bone "${d.name}"`);
      const axes: number[] = [],
        angles: number[] = [],
        t = [0, 0, 0];
      d.dof.forEach((c: string, j: number) => {
        if (c[0] === 'r') {
          axes.push(AXIS[c[1]]);
          angles.push(v[j] * toRad);
        } else if (c[0] === 't') t[AXIS[c[1]]] = v[j] * skeleton.scale;
      });
      if (i === 0 && rootMoves) rootKeys.push({ time, value: [rest[0] + t[0], rest[1] + t[1], rest[2] + t[2]] });
      const keys = rotationKeys.get(i);
      if (keys) {
        const c = d.axis as Q;
        keys.push({ time, value: qmul(qmul(c, acclaimEuler(axes, angles)), [-c[0], -c[1], -c[2], c[3]]) });
      }
    }
    values.clear();
    frames++;
  };
  let started = false;
  for (; k < lines.length; k++) {
    const l = lines[k].trim();
    if (!l || l.startsWith('#')) continue;
    if (/^\d+$/.test(l)) {
      if (started) flush();
      started = true;
      continue;
    }
    const words = l.split(/\s+/),
      i = byName.get(words[0]);
    if (i === undefined)
      throw new LoaderError(M, 'syntax', `frame ${frames + 1} names an unknown bone "${words[0].slice(0, 32)}"`);
    const d = data[i];
    if (words.length - 1 !== d.dof.length)
      throw new LoaderError(
        M,
        'syntax',
        `bone "${d.name}" has ${words.length - 1} values in frame ${frames + 1}; its dof lists ${d.dof.length}`,
      );
    values.set(
      i,
      words.slice(1).map((w) => {
        const v = Number(w);
        if (!Number.isFinite(v))
          throw new LoaderError(M, 'syntax', `invalid number "${w.slice(0, 32)}" in frame ${frames + 1}`);
        return v;
      }),
    );
  }
  if (started) flush();
  return { bones: skeleton.bones, clip: { name, tracks: frames ? tracks : [] }, frames, frameTime };
}
