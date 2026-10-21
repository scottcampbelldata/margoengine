// Frame animation of voxel models: deduplicated packing of per-frame grids and a local timeline clock.
import type { Vec3 } from '@margoengine/math';
import { cellLimit, checkGrid, type GridLimits, type VoxelGrid } from './grid.js';

/** A model as stored in a packed animation: a grid and an optional pivot. */
export interface FrameBank extends VoxelGrid {
  /** Pivot point in cells, each within +-1,000,000; may lie outside the grid. */
  pivot?: Vec3;
}

/** One key of a frame animation: the model shown from `frame` on. */
export interface GridFrame extends FrameBank {
  /** Frame number, 0 to 2,147,483,647. */
  frame: number;
}

/**
 * A packed frame animation ({@link packFrames}): each distinct model once in `banks`, and per key the bank it shows.
 * Plain data, safe to save; the field names are a stable format.
 */
export interface PackedFrames {
  version: 1;
  banks: FrameBank[];
  keys: { frame: number; bank: number }[];
}

/** A clip's own clock inside a document's frame count. */
export interface LocalTimeline {
  /** Document frame where the clip starts, within int32. */
  offset: number;
  /** First and last clip frame played, 0 to 2,147,483,647, `startFrame <= endFrame`. */
  startFrame: number;
  endFrame: number;
  /** Clip frames per document frame, 1/256 to 256. */
  speed: number;
  /** Repeat from `startFrame` after `endFrame` (true) or hold `endFrame` (false). */
  loop: boolean;
}

const MAX_FRAME = 2_147_483_647,
  MAX_KEYS = 4_096,
  MAX_PIVOT = 1_000_000;

function checkInteger(value: unknown, min: number, max: number, subject: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${subject} must be an integer from ${min} to ${max}; pass one`);
}

/** Throws unless `value` is a valid {@link LocalTimeline}. */
export function checkTimeline(value: unknown): asserts value is LocalTimeline {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('A timeline is not an object; pass {offset, startFrame, endFrame, speed, loop}');
  const t = value as LocalTimeline;
  checkInteger(t.offset, -MAX_FRAME, MAX_FRAME, 'Timeline offset');
  checkInteger(t.startFrame, 0, MAX_FRAME, 'Timeline startFrame');
  checkInteger(t.endFrame, t.startFrame, MAX_FRAME, 'Timeline endFrame');
  if (!Number.isFinite(t.speed) || t.speed < 1 / 256 || t.speed > 256)
    throw new RangeError('Timeline speed must be 1/256 to 256; pass a speed in range');
  if (typeof t.loop !== 'boolean') throw new TypeError('Timeline loop is not a boolean; pass true or false');
}

/**
 * The clip frame showing at document frame `frame`: `frame` itself without a timeline. Fractional results let callers
 * interpolate; before `offset` the clip shows `startFrame`.
 */
export function localFrame(frame: number, timeline?: LocalTimeline): number {
  checkInteger(frame, 0, MAX_FRAME, 'Document frame');
  if (!timeline) return frame;
  checkTimeline(timeline);
  const elapsed = Math.max(0, frame - timeline.offset) * timeline.speed,
    span = timeline.endFrame - timeline.startFrame;
  return timeline.startFrame + (timeline.loop ? elapsed % (span + 1) : Math.min(span, elapsed));
}

function checkBank(bank: FrameBank, limit: number): number {
  const cells = checkGrid(bank, limit, 'Frame grid');
  const pivot = bank.pivot;
  if (pivot !== undefined) {
    if (!Array.isArray(pivot) || pivot.length !== 3)
      throw new TypeError('Frame pivot is not [x, y, z]; pass three numbers');
    if (!Array.from(pivot).every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_PIVOT))
      throw new RangeError(`Frame pivot must be finite within +-${MAX_PIVOT}; move the pivot closer`);
  }
  return cells;
}

function copyBank(bank: FrameBank): FrameBank {
  const copy: FrameBank = { size: [bank.size[0], bank.size[1], bank.size[2]], voxels: bank.voxels.slice() };
  if (bank.pivot) copy.pivot = [bank.pivot[0], bank.pivot[1], bank.pivot[2]];
  return copy;
}

function sameBank(a: FrameBank, b: FrameBank): boolean {
  if (a.voxels.length !== b.voxels.length) return false;
  for (let i = 0; i < a.voxels.length; i++) if (a.voxels[i] !== b.voxels[i]) return false;
  return true;
}

/** Hash bucket key: size, pivot and an FNV-1a hash of the cells. */
function bucketOf(bank: FrameBank): string {
  let hash = 2166136261;
  for (const value of bank.voxels) hash = Math.imul(hash ^ value, 16777619) >>> 0;
  return `${bank.size.join(',')}/${bank.pivot?.join(',') ?? '-'}/${hash}`;
}

/**
 * Packs keys (sorted by frame, at most 4,096, `maxCells` cells in all) so equal models (same size, pivot and cells)
 * are stored once. The result owns copies; changing the input later does not change it.
 */
export function packFrames(frames: readonly GridFrame[], limits: GridLimits = {}): PackedFrames {
  if (!Array.isArray(frames)) throw new TypeError('packFrames frames is not an array; pass the keys');
  if (frames.length > MAX_KEYS) throw new RangeError(`packFrames takes at most ${MAX_KEYS} keys; split the clip`);
  const limit = cellLimit(limits);
  let previous = -1,
    total = 0;
  for (const frame of frames) {
    checkInteger(frame?.frame, 0, MAX_FRAME, 'Frame number');
    if (frame.frame <= previous) throw new RangeError('packFrames keys are not sorted and unique by frame; sort them');
    previous = frame.frame;
    total += checkBank(frame, limit);
    if (total > limit)
      throw new RangeError(`packFrames keys hold over ${limit} cells; raise maxCells or split the clip`);
  }
  const packed: PackedFrames = { version: 1, banks: [], keys: [] },
    buckets = new Map<string, number[]>();
  for (const frame of frames) {
    const key = bucketOf(frame),
      bucket = buckets.get(key) ?? [];
    let bank = bucket.find((index) => sameBank(packed.banks[index], frame));
    if (bank === undefined) {
      bank = packed.banks.push(copyBank(frame)) - 1;
      bucket.push(bank);
      buckets.set(key, bucket);
    }
    packed.keys.push({ frame: frame.frame, bank });
  }
  return packed;
}

/** Unpacks {@link PackedFrames} (untrusted input is fine) into keys that each own their grid. */
export function unpackFrames(packed: PackedFrames, limits: GridLimits = {}): GridFrame[] {
  if (typeof packed !== 'object' || packed === null || packed.version !== 1)
    throw new TypeError('unpackFrames data is not packed frames version 1; pass what packFrames returned');
  if (
    !Array.isArray(packed.banks) ||
    !Array.isArray(packed.keys) ||
    packed.banks.length > MAX_KEYS ||
    packed.keys.length > MAX_KEYS
  )
    throw new RangeError(`unpackFrames data holds over ${MAX_KEYS} banks or keys; split the clip`);
  const limit = cellLimit(limits),
    cells = packed.banks.map((bank) => checkBank(bank, limit));
  let previous = -1,
    total = 0;
  for (const key of packed.keys) {
    checkInteger(key?.frame, 0, MAX_FRAME, 'Frame number');
    checkInteger(key.bank, 0, packed.banks.length - 1, 'Frame bank reference');
    if (key.frame <= previous)
      throw new RangeError('unpackFrames keys are not sorted and unique by frame; fix the data');
    previous = key.frame;
    total += cells[key.bank];
    if (total > limit) throw new RangeError(`unpackFrames keys hold over ${limit} cells; raise maxCells`);
  }
  return packed.keys.map((key) => ({ frame: key.frame, ...copyBank(packed.banks[key.bank]) }));
}
