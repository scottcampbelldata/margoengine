// @margoengine/voxel-edit/rig: bones and skinned voxel animation. Voxel parts are attached rigidly to the bones of a
// skeleton; a pose turns each bone about its joint (its parent's turn carried down the chain) and gives every part a
// matrix for drawing its mesh, or bakes the posed model back into one grid by sampling each part at the cell centres.
import type { Vec3 } from '@margoengine/math';
import { checkGrid, checkOptions, cellLimit, type GridLimits, type VoxelGrid } from './grid.js';

/** A rotation as a unit quaternion `[x, y, z, w]`. */
export type RigQuat = readonly [number, number, number, number];

/** One bone of a {@link VoxelRig}. */
export interface RigBone {
  /** Unique name. */
  name: string;
  /** The parent bone's name; a bone without one is a root. Parents come before their children. */
  parent?: string;
  /** Where the bone turns, in model cells (corner coordinates) at rest. Default [0, 0, 0]. */
  joint?: Vec3;
}

/** A voxel part carried by one bone. */
export interface RigPart {
  /** The bone that carries it. */
  bone: string;
  /** Its cells. */
  grid: VoxelGrid;
  /** Where the grid's corner (cell 0, 0, 0) sits in the model at rest, in cells. Default [0, 0, 0]. */
  offset?: Vec3;
}

/** A pose: bone rotations (about each joint, after the parent's) and a move of the whole model. */
export interface RigPose {
  /** Rotation per bone name; a bone left out keeps its parent's turn. */
  rotations?: Readonly<Record<string, RigQuat>>;
  /** Moves the whole posed model, in cells. Default [0, 0, 0]. */
  translation?: Vec3;
}

/** A key-framed clip: per bone, times in seconds (increasing) and a rotation at each. */
export interface RigClip {
  /** Seconds; `sampleRigClip` wraps time into it when `loop` is true. */
  duration: number;
  loop?: boolean;
  tracks: readonly { bone: string; times: readonly number[]; rotations: readonly RigQuat[] }[];
}

/** A baked pose: the grid of the posed model and where its corner is in the model, in cells. */
export interface RigBake {
  grid: VoxelGrid;
  origin: Vec3;
}

type M = Float64Array;
const identity = (): M => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
// Column-major 4 x 4 products and the rigid transforms built from them.
const multiply = (a: M, b: M): M => {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
};
// Rotation q about point p: T(p) R T(-p).
const turnAbout = (q: RigQuat, p: Vec3): M => {
  const [x, y, z, w] = q,
    m = identity();
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + z * w);
  m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w);
  m[9] = 2 * (y * z - x * w);
  m[10] = 1 - 2 * (x * x + y * y);
  for (let r = 0; r < 3; r++) m[12 + r] = p[r] - (m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2]);
  return m;
};
// Inverse of a rigid transform: the transposed rotation and the turned-back translation.
const invertRigid = (m: M): M => {
  const out = identity();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c];
  for (let r = 0; r < 3; r++) out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]);
  return out;
};

const checkVec = (value: unknown, subject: string): Vec3 => {
  if (value === undefined) return [0, 0, 0];
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === 'number' && Number.isFinite(v)))
    throw new TypeError(`${subject} must be three finite numbers; pass [x, y, z]`);
  return [value[0], value[1], value[2]];
};
const checkQuat = (value: unknown, subject: string): RigQuat => {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((v) => typeof v === 'number' && Number.isFinite(v)))
    throw new TypeError(`${subject} must be a quaternion of four finite numbers; pass [x, y, z, w]`);
  const n = Math.hypot(value[0], value[1], value[2], value[3]);
  if (Math.abs(n - 1) > 1e-3) throw new RangeError(`${subject} has length ${n}, not 1; pass a unit quaternion`);
  return [value[0] / n, value[1] / n, value[2] / n, value[3] / n];
};

/** The unit quaternion turning by `degrees` about `axis` (normalized here), right-handed. */
export function rigRotation(axis: Vec3, degrees: number): RigQuat {
  const [x, y, z] = checkVec(axis, 'rigRotation axis'),
    n = Math.hypot(x, y, z);
  if (!(n > 0)) throw new RangeError('rigRotation axis is zero; pass a direction such as [0, 1, 0]');
  if (typeof degrees !== 'number' || !Number.isFinite(degrees))
    throw new TypeError('rigRotation degrees must be a finite number; pass an angle such as 90');
  const h = (degrees * Math.PI) / 360,
    s = Math.sin(h) / n;
  return [x * s, y * s, z * s, Math.cos(h)];
}

/** Spherical interpolation between unit quaternions, the short way round. */
export function slerpRotation(a: RigQuat, b: RigQuat, t: number): RigQuat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  if (dot > 0.9995) {
    const out = [0, 1, 2, 3].map((i) => a[i] + (sign * b[i] - a[i]) * t),
      n = Math.hypot(...out);
    return [out[0] / n, out[1] / n, out[2] / n, out[3] / n];
  }
  const angle = Math.acos(dot),
    sa = Math.sin((1 - t) * angle) / Math.sin(angle),
    sb = (sign * Math.sin(t * angle)) / Math.sin(angle);
  return [a[0] * sa + b[0] * sb, a[1] * sa + b[1] * sb, a[2] * sa + b[2] * sb, a[3] * sa + b[3] * sb];
}

/**
 * The bone rotations of `clip` at `time` seconds: each track's keys interpolated by {@link slerpRotation}, held before
 * the first and after the last key; time wraps into `[0, duration)` when `clip.loop` is true.
 * @throws TypeError or RangeError for a malformed clip.
 */
export function sampleRigClip(clip: RigClip, time: number): Record<string, RigQuat> {
  checkOptions(clip, 'sampleRigClip clip');
  if (typeof clip.duration !== 'number' || !(clip.duration > 0) || clip.duration === Infinity)
    throw new RangeError(`sampleRigClip duration is ${clip.duration}; pass seconds > 0`);
  if (typeof time !== 'number' || !Number.isFinite(time))
    throw new TypeError('sampleRigClip time must be a finite number of seconds; pass one');
  if (!Array.isArray(clip.tracks))
    throw new TypeError('sampleRigClip tracks must be an array; pass [{bone, times, rotations}]');
  const t = clip.loop ? ((time % clip.duration) + clip.duration) % clip.duration : time,
    out: Record<string, RigQuat> = {};
  for (const track of clip.tracks) {
    const { bone, times, rotations } = track ?? {};
    if (
      typeof bone !== 'string' ||
      !Array.isArray(times) ||
      !Array.isArray(rotations) ||
      !times.length ||
      times.length !== rotations.length
    )
      throw new TypeError(
        'sampleRigClip track needs a bone name and as many rotations as times; pass {bone, times, rotations}',
      );
    for (let i = 1; i < times.length; i++)
      if (!(times[i] > times[i - 1]))
        throw new RangeError(`sampleRigClip track ${bone} times must increase; sort its keys`);
    const keys = rotations.map((q, i) => checkQuat(q, `sampleRigClip ${bone} rotation ${i}`));
    if (t <= times[0]) out[bone] = keys[0];
    else if (t >= times[times.length - 1]) out[bone] = keys[keys.length - 1];
    else {
      let i = 1;
      while (times[i] < t) i++;
      out[bone] = slerpRotation(keys[i - 1], keys[i], (t - times[i - 1]) / (times[i] - times[i - 1]));
    }
  }
  return out;
}

/**
 * A skeleton with voxel parts. {@link VoxelRig.matrices} gives each part's model matrix for a pose (draw the part's
 * mesh, from `meshGrid`, with it); {@link VoxelRig.bake} gives the posed model as one grid, for frames, export or a
 * world. Bones turn about their joints; a child turns with its parent.
 */
export class VoxelRig {
  readonly bones: readonly Readonly<Required<Omit<RigBone, 'parent'>> & { parent?: string }>[];
  readonly parts: readonly Readonly<Required<RigPart>>[];
  #index = new Map<string, number>();

  /**
   * @throws TypeError for a malformed bone or part, a duplicate bone name, a parent listed after its child or not at
   * all, or a part on an unknown bone.
   */
  constructor(options: { bones: readonly RigBone[]; parts: readonly RigPart[] }) {
    checkOptions(options, 'VoxelRig');
    const { bones, parts } = options;
    if (!Array.isArray(bones) || !bones.length)
      throw new TypeError('VoxelRig bones must be a non-empty array; pass [{name}]');
    if (!Array.isArray(parts)) throw new TypeError('VoxelRig parts must be an array; pass [{bone, grid}]');
    const list: { name: string; parent?: string; joint: Vec3 }[] = [];
    for (const bone of bones) {
      if (typeof bone?.name !== 'string' || !bone.name)
        throw new TypeError('VoxelRig bone name must be a non-empty string; pass {name}');
      if (this.#index.has(bone.name))
        throw new TypeError(`VoxelRig bone ${bone.name} is listed twice; give each bone its own name`);
      if (bone.parent !== undefined && !this.#index.has(bone.parent))
        throw new TypeError(
          `VoxelRig bone ${bone.name} has parent ${bone.parent}, not listed before it; list parents first`,
        );
      this.#index.set(bone.name, list.length);
      list.push({
        name: bone.name,
        parent: bone.parent,
        joint: checkVec(bone.joint, `VoxelRig bone ${bone.name} joint`),
      });
    }
    this.bones = list;
    this.parts = parts.map((part, i) => {
      if (typeof part?.bone !== 'string' || !this.#index.has(part.bone))
        throw new TypeError(`VoxelRig part ${i} is on an unknown bone ${part?.bone}; name one of the bones`);
      checkGrid(part.grid, Infinity, `VoxelRig part ${i} grid`);
      return { bone: part.bone, grid: part.grid, offset: checkVec(part.offset, `VoxelRig part ${i} offset`) };
    });
  }

  /**
   * Each part's model matrix in `pose` (column-major 4 x 4, cells to model cells, its grid corner at the origin of its
   * cells), in the order of `parts`. A rest pose gives a translation by each part's offset.
   * @throws TypeError or RangeError for an unknown bone or a malformed rotation.
   */
  matrices(pose: RigPose = {}): Float64Array[] {
    checkOptions(pose, 'VoxelRig pose');
    const rotations = pose.rotations ?? {};
    if (typeof rotations !== 'object')
      throw new TypeError('VoxelRig pose rotations must be an object; pass {bone: [x, y, z, w]}');
    for (const name of Object.keys(rotations))
      if (!this.#index.has(name))
        throw new TypeError(`VoxelRig pose turns unknown bone ${name}; name one of the bones`);
    const move = checkVec(pose.translation, 'VoxelRig pose translation'),
      root = identity(),
      bones: M[] = [];
    root.set(move, 12);
    for (const bone of this.bones) {
      const parent = bone.parent === undefined ? root : bones[this.#index.get(bone.parent) as number],
        q = rotations[bone.name];
      bones.push(
        q === undefined ? parent : multiply(parent, turnAbout(checkQuat(q, `VoxelRig pose ${bone.name}`), bone.joint)),
      );
    }
    return this.parts.map((part) => {
      const at = identity();
      at.set(part.offset, 12);
      return multiply(bones[this.#index.get(part.bone) as number], at);
    });
  }

  /**
   * The posed model as one grid: every cell whose centre falls in a filled cell of a posed part takes that cell's
   * index (a later part over an earlier one), so turned parts are resampled without holes. The grid covers the posed
   * parts' boxes; `origin` is its corner in model cells.
   * @throws RangeError when the posed box holds more than `maxCells` cells (default 16,777,216).
   */
  bake(pose: RigPose = {}, limits: GridLimits = {}): RigBake {
    checkOptions(limits, 'VoxelRig.bake');
    const limit = cellLimit(limits),
      matrices = this.matrices(pose),
      lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    // Posed boxes, shrunk by a hair so a face exactly on a cell boundary does not add a row.
    const boxes = this.parts.map((part, p) => {
      const m = matrices[p],
        [sx, sy, sz] = part.grid.size,
        b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 8; c++) {
        const x = c & 1 ? sx : 0,
          y = c & 2 ? sy : 0,
          z = c & 4 ? sz : 0;
        for (let r = 0; r < 3; r++) {
          const v = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
          b[r] = Math.min(b[r], v);
          b[3 + r] = Math.max(b[3 + r], v);
        }
      }
      for (let r = 0; r < 3; r++) {
        b[r] = Math.floor(b[r] + 1e-6);
        b[3 + r] = Math.ceil(b[3 + r] - 1e-6);
        lo[r] = Math.min(lo[r], b[r]);
        hi[r] = Math.max(hi[r], b[3 + r]);
      }
      return b;
    });
    if (!this.parts.length) return { grid: { size: [1, 1, 1], voxels: new Uint8Array(1) }, origin: [0, 0, 0] };
    const size: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
      cells = size[0] * size[1] * size[2];
    if (cells > limit)
      throw new RangeError(`VoxelRig.bake needs ${cells} cells, over maxCells ${limit}; raise maxCells`);
    const voxels = new Uint8Array(cells);
    this.parts.forEach((part, p) => {
      const inv = invertRigid(matrices[p]),
        b = boxes[p],
        [sx, sy, sz] = part.grid.size,
        src = part.grid.voxels;
      for (let y = b[1]; y < b[4]; y++)
        for (let z = b[2]; z < b[5]; z++)
          for (let x = b[0]; x < b[3]; x++) {
            const cx = x + 0.5,
              cy = y + 0.5,
              cz = z + 0.5,
              u = Math.floor(inv[0] * cx + inv[4] * cy + inv[8] * cz + inv[12] + 1e-9),
              v = Math.floor(inv[1] * cx + inv[5] * cy + inv[9] * cz + inv[13] + 1e-9),
              w = Math.floor(inv[2] * cx + inv[6] * cy + inv[10] * cz + inv[14] + 1e-9);
            if (u < 0 || v < 0 || w < 0 || u >= sx || v >= sy || w >= sz) continue;
            const value = src[u + sx * (w + sz * v)];
            if (value) voxels[x - lo[0] + size[0] * (z - lo[2] + size[2] * (y - lo[1]))] = value;
          }
    });
    return { grid: { size, voxels }, origin: [lo[0], lo[1], lo[2]] };
  }
}
