// Biovision BVH motion capture: HIERARCHY to bones, MOTION to keyframe tracks in the animation package's clip shape.
import { LoaderError } from './types.js';
import { type BinaryInput, toText } from './util.js';

const F = 'BVH';

/** One bone of {@link BVH.bones}: what `new Skeleton(bones)` in `@margoengine/animation` reads. */
export interface BVHBone {
  /** The joint's name, unique in the file. */
  name: string;
  /** Index of the parent bone, parents first; -1 for a root. */
  parent: number;
  /** The joint's OFFSET times `scale`. */
  translation: [number, number, number];
  /** Rest rotation: BVH rests with no rotation. */
  rotation: [number, number, number, number];
  /** The End Site OFFSET times `scale` when this joint ends a chain. */
  endSite?: [number, number, number];
}

/** One key of a {@link BVHTrack}. */
export interface BVHKey {
  time: number;
  value: number[];
}

/** One bone's translation or rotation over the file's frames; rotations are quaternions [x, y, z, w]. */
export interface BVHTrack {
  target: string;
  path: 'translation' | 'rotation';
  keys: BVHKey[];
}

/** What {@link parseBVH} returns. */
export interface BVH {
  /** The skeleton, parents first. */
  bones: BVHBone[];
  /** `{name, tracks}`, ready for `createKeyframeClip` in `@margoengine/animation`. */
  clip: { name: string; tracks: BVHTrack[] };
  /** The file's frame count. */
  frames: number;
  /** Seconds per frame. */
  frameTime: number;
}

/** Options of {@link parseBVH}. */
export interface BVHOptions {
  /** Multiplies offsets and positions; BVH has no unit, so 0.01 turns centimetres to metres. Default 1. */
  scale?: number;
  /** The clip's name. Default `'mocap'`. */
  name?: string;
  /** Most joints. Default 4,096. */
  maxJoints?: number;
  /** Most keys, frames times tracks. Default 4,000,000. */
  maxKeys?: number;
}

const POSITION: Record<string, number> = { xposition: 0, yposition: 1, zposition: 2 },
  ROTATION: Record<string, number> = { xrotation: 0, yrotation: 1, zrotation: 2 };

/**
 * Parses a Biovision BVH file. Euler channels apply in the order the file lists them, each about the joint's own axes
 * after the ones before it. A position channel moves the joint from its OFFSET. Keys sit at `frame * frameTime`.
 *
 * @param input The file's bytes or text.
 * @param options Scale, clip name and limits.
 * @returns The bones, the clip and the frame timing.
 * @throws LoaderError with code `header`, `syntax`, `range`, `truncated` or `limit`.
 *
 * @example
 * ```ts
 * import { parseBVH } from '@margoengine/loaders/mocap';
 *
 * const { bones, clip, frameTime } = parseBVH(
 *   'HIERARCHY ROOT Hip { OFFSET 0 0 0 CHANNELS 3 Zrotation Xrotation Yrotation } MOTION Frames: 1 Frame Time: 0.5 0 0 0',
 * );
 * console.log(bones[0].name, clip.tracks.length, frameTime);
 * ```
 */
export function parseBVH(input: BinaryInput | string, options: BVHOptions = {}): BVH {
  const text = toText(input, F),
    { scale = 1, name = 'mocap', maxJoints = 4096, maxKeys = 4_000_000 } = options;
  if (!Number.isFinite(scale) || scale <= 0) throw new LoaderError(F, 'range', 'scale must be positive and finite');
  for (const [label, value] of [
    ['maxJoints', maxJoints],
    ['maxKeys', maxKeys],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new LoaderError(F, 'range', `${label} must be a non-negative integer`);

  const scan = /[{}]|[^\s{}]+/g;
  const next = (): string | null => scan.exec(text)?.[0] ?? null;
  const need = (what: string): string => {
    const token = next();
    if (token === null) throw new LoaderError(F, 'truncated', `file ends where ${what} should be`);
    return token;
  };
  const number = (what: string): number => {
    const token = need(what),
      value = Number(token);
    if (!Number.isFinite(value))
      throw new LoaderError(F, 'syntax', `invalid number "${token.slice(0, 32)}" for ${what}`);
    return value;
  };
  const expect = (word: string) => {
    const token = need(word);
    if (token !== word) throw new LoaderError(F, 'syntax', `expected ${word}, found "${token.slice(0, 32)}"`);
  };
  const offset = (): [number, number, number] => {
    expect('OFFSET');
    return [number('OFFSET x') * scale, number('OFFSET y') * scale, number('OFFSET z') * scale];
  };

  if (next() !== 'HIERARCHY') throw new LoaderError(F, 'header', 'missing HIERARCHY keyword');
  const bones: BVHBone[] = [],
    channels: { position: number[]; rotation: number[]; order: string[] }[] = [],
    seen = new Set<string>(),
    stack: number[] = [];
  let token = need('ROOT');
  // Joints open and close by the stack, so a deep file cannot run out the call stack.
  while (token !== 'MOTION') {
    if (token === 'ROOT' || token === 'JOINT') {
      if ((token === 'ROOT') !== (stack.length === 0))
        throw new LoaderError(
          F,
          'syntax',
          `${token} is in the wrong place; ROOT is outermost, JOINT is inside a joint`,
        );
      const joint = need('a joint name');
      if (seen.has(joint)) throw new LoaderError(F, 'syntax', `joint "${joint.slice(0, 32)}" is named twice`);
      if (bones.length >= maxJoints) throw new LoaderError(F, 'limit', `joint count exceeds the limit of ${maxJoints}`);
      seen.add(joint);
      expect('{');
      const translation = offset();
      expect('CHANNELS');
      const count = number('the channel count');
      if (!Number.isInteger(count) || count < 0 || count > 6)
        throw new LoaderError(F, 'syntax', `joint "${joint.slice(0, 32)}" has ${count} channels; expected 0 to 6`);
      const entry = { position: [] as number[], rotation: [] as number[], order: [] as string[] };
      for (let i = 0; i < count; i++) {
        const channel = need('a channel name').toLowerCase();
        if (!Object.hasOwn(POSITION, channel) && !Object.hasOwn(ROTATION, channel))
          throw new LoaderError(F, 'syntax', `unknown channel "${channel.slice(0, 32)}"`);
        entry.order.push(channel);
      }
      bones.push({
        name: joint,
        parent: stack.length ? stack[stack.length - 1] : -1,
        translation,
        rotation: [0, 0, 0, 1],
      });
      channels.push(entry);
      stack.push(bones.length - 1);
    } else if (token === 'End') {
      if (!stack.length) throw new LoaderError(F, 'syntax', 'End Site is outside every joint');
      expect('Site');
      expect('{');
      bones[stack[stack.length - 1]].endSite = offset();
      expect('}');
    } else if (token === '}') {
      if (!stack.length) throw new LoaderError(F, 'syntax', 'a closing brace has no joint to close');
      stack.pop();
    } else throw new LoaderError(F, 'syntax', `unexpected "${token.slice(0, 32)}" in HIERARCHY`);
    token = need('MOTION');
  }
  if (stack.length)
    throw new LoaderError(F, 'syntax', `MOTION starts inside joint "${bones[stack[stack.length - 1]].name}"`);
  if (!bones.length) throw new LoaderError(F, 'header', 'HIERARCHY has no ROOT');

  expect('Frames:');
  const frames = number('the frame count');
  if (!Number.isSafeInteger(frames) || frames < 0) throw new LoaderError(F, 'header', `invalid frame count ${frames}`);
  expect('Frame');
  expect('Time:');
  const frameTime = number('the frame time');
  if (!(frameTime > 0)) throw new LoaderError(F, 'range', `frame time ${frameTime} is not positive`);

  const tracks: BVHTrack[] = [],
    plan: { positions?: BVHKey[]; rotations?: BVHKey[] }[] = [];
  let width = 0;
  bones.forEach((bone, b) => {
    const entry = channels[b],
      item: (typeof plan)[number] = {};
    width += entry.order.length;
    if (entry.order.some((c) => Object.hasOwn(POSITION, c))) {
      item.positions = [];
      tracks.push({ target: bone.name, path: 'translation', keys: item.positions });
    }
    if (entry.order.some((c) => Object.hasOwn(ROTATION, c))) {
      item.rotations = [];
      tracks.push({ target: bone.name, path: 'rotation', keys: item.rotations });
    }
    plan.push(item);
  });
  if (frames * tracks.length > maxKeys)
    throw new LoaderError(
      F,
      'limit',
      `${frames} frames of ${tracks.length} tracks exceed the limit of ${maxKeys} keys`,
    );
  // Budget before the keys: every value takes a digit and a separator, so a short file cannot claim millions of frames.
  if (frames * width * 2 - 1 > text.length - scan.lastIndex)
    throw new LoaderError(F, 'truncated', `file is too short for ${frames} frames of ${width} values`);

  for (let frame = 0; frame < frames; frame++) {
    const time = frame * frameTime;
    bones.forEach((bone, b) => {
      const { order } = channels[b],
        item = plan[b],
        position = [0, 0, 0];
      let qx = 0,
        qy = 0,
        qz = 0,
        qw = 1;
      for (const channel of order) {
        const value = number(`frame ${frame}, joint "${bone.name}"`);
        if (Object.hasOwn(POSITION, channel)) {
          position[POSITION[channel]] = value * scale;
          continue;
        }
        // Each listed rotation multiplies on the right: about the axes the ones before it left.
        const half = (value * Math.PI) / 360,
          sin = Math.sin(half),
          cos = Math.cos(half),
          axis = ROTATION[channel],
          x = axis === 0 ? sin : 0,
          y = axis === 1 ? sin : 0,
          z = axis === 2 ? sin : 0,
          nx = qw * x + qx * cos + qy * z - qz * y,
          ny = qw * y - qx * z + qy * cos + qz * x,
          nz = qw * z + qx * y - qy * x + qz * cos,
          nw = qw * cos - qx * x - qy * y - qz * z;
        qx = nx;
        qy = ny;
        qz = nz;
        qw = nw;
      }
      if (item.positions)
        item.positions.push({
          time,
          value: [
            bone.translation[0] + position[0],
            bone.translation[1] + position[1],
            bone.translation[2] + position[2],
          ],
        });
      if (item.rotations) item.rotations.push({ time, value: [qx, qy, qz, qw] });
    });
  }
  return { bones, clip: { name, tracks: frames ? tracks : [] }, frames, frameTime };
}
