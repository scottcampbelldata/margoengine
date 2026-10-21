import type { MaterialMesh, Material, MeshGeometry } from './built-material.js';

/** One frame of a tile animation: seconds on screen (> 0) and the four corner UVs `[u0, v0, u1, v1, u2, v2, u3, v3]`. */
export interface TileFrame {
  duration: number;
  uvs: ArrayLike<number>;
}
/** A looping UV animation (Crocotile 3D's per-tileset "UV animation"): frames play in order, then from the first again. */
export interface TileAnimation {
  frames: readonly TileFrame[];
}
/** Where a placed tile's loop begins: at a frame index, or at an offset in seconds (a tile's custom start time). */
export type TileAnimationStart = { frame: number } | { seconds: number };

/**
 * The frame index `animation` shows at `time` seconds: pure and deterministic, looping forever in both directions.
 * A frame covers `[begin, begin + duration)`, so a time on a boundary shows the next frame. `start` shifts the loop
 * (`{frame: 2}` begins on frame 2, `{seconds: 0.4}` 0.4 s in). Throws RangeError for no frames, a duration that is
 * not finite and > 0, a non-finite time or offset, or a start frame outside the animation.
 */
export function tileAnimationFrame(animation: TileAnimation, time: number, start?: TileAnimationStart): number {
  const frames = animation?.frames;
  if (!Array.isArray(frames)) throw new TypeError('Tile animation needs a frames array; pass {frames: [...]}');
  if (!frames.length) throw new RangeError('Tile animation has no frames; add at least one frame');
  let total = 0;
  for (const frame of frames) {
    if (!(frame?.duration > 0 && frame.duration < Infinity))
      throw new RangeError('Tile animation frame durations must be finite seconds > 0; fix the frame duration');
    total += frame.duration;
  }
  let offset = 0;
  if (start && 'frame' in start) {
    if (!Number.isInteger(start.frame) || start.frame < 0 || start.frame >= frames.length)
      throw new RangeError(`Tile animation start frame must be an integer from 0 to ${frames.length - 1}`);
    for (let i = 0; i < start.frame; i++) offset += frames[i].duration;
  } else if (start) offset = start.seconds;
  const local = time + offset;
  if (!Number.isFinite(local)) throw new RangeError('Tile animation time and start seconds must be finite');
  let t = local % total;
  if (t < 0) t += total;
  for (let i = 0, end = 0; i < frames.length; i++) if (t < (end += frames[i].duration)) return i;
  return frames.length - 1;
}

/** A tile drawn as four consecutive vertices of a `createMesh` geometry, from `vertex`, in its frames' corner order. */
export interface AnimatedTile {
  vertex: number;
  animation: TileAnimation;
  start?: TileAnimationStart;
}

/**
 * Plays tile animations on a `createMesh` mesh. Each call of the returned function, with the time in seconds, writes
 * the current frame's corner UVs into `geometry.uvs` for the tiles whose frame changed and uploads only those vertices
 * through `mesh.setGeometry(geometry, range)` (tiles listed next to each other in the buffer share one upload). It
 * returns how many tiles changed. `tiles` is copied; animations are read on each call.
 */
export function tileAnimator(
  mesh: MaterialMesh<Material | readonly Material[]>,
  geometry: MeshGeometry & { uvs: number[] | Float32Array },
  tiles: readonly AnimatedTile[],
): (time: number) => number {
  const list = [...tiles],
    uvs = geometry?.uvs,
    shown = new Int32Array(list.length).fill(-1);
  if (typeof mesh?.setGeometry !== 'function' || !(Array.isArray(uvs) || uvs instanceof Float32Array))
    throw new TypeError('tileAnimator needs a createMesh mesh and its geometry with a writable uvs array');
  for (const tile of list) {
    if (!Number.isSafeInteger(tile?.vertex) || tile.vertex < 0 || (tile.vertex + 4) * 2 > uvs.length)
      throw new RangeError('Animated tile vertex must start four vertices inside the geometry');
    tileAnimationFrame(tile.animation, 0, tile.start);
    if (tile.animation.frames.some((frame) => frame.uvs?.length !== 8))
      throw new RangeError('Tile animation frames need eight corner UVs; pass [u0, v0, u1, v1, u2, v2, u3, v3]');
  }
  return (time) => {
    let changed = 0,
      from = 0,
      to = 0;
    const flush = () => {
      if (to > from) mesh.setGeometry(geometry, { start: from, count: to - from });
    };
    for (let i = 0; i < list.length; i++) {
      const { vertex, animation, start } = list[i],
        frame = tileAnimationFrame(animation, time, start);
      if (frame === shown[i]) continue;
      shown[i] = frame;
      changed++;
      const corners = animation.frames[frame].uvs;
      for (let k = 0; k < 8; k++) uvs[vertex * 2 + k] = corners[k];
      if (vertex !== to) {
        flush();
        from = vertex;
      }
      to = vertex + 4;
    }
    flush();
    return changed;
  };
}
