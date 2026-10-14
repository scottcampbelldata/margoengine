// glTF animation writer for exportModel, loaded with import() only when `animations` are passed.
import {FLOAT, type Bin} from './container.js';
import type {ExportClip} from './model.js';

type Writer = Bin & {memo(key: unknown, make: () => number): number};

/** One clip as a glTF animation: shared time and value arrays are written once; channels to unexported nodes are dropped. */
export function writeAnimation(w: Writer, clip: ExportClip, map: Int32Array): void {
  const channels: Record<string, unknown>[] = [], samplers: Record<string, unknown>[] = [];
  for (const track of clip.tracks) {
    const node = map[track.node], interpolation = track.interpolation ?? 'LINEAR';
    if (!(node >= 0)) continue; // hidden or unknown node
    if (!['STEP', 'LINEAR', 'CUBICSPLINE'].includes(interpolation)) throw new TypeError('Invalid animation interpolation');
    const input = w.memo(track.times, () => w.accessor(track.times, 'SCALAR', FLOAT, undefined, true));
    const output = w.memo(track.values, () => w.accessor(track.values, track.path === 'rotation' ? 'VEC4' : track.path === 'weights' ? 'SCALAR' : 'VEC3'));
    const sampler: Record<string, unknown> = {input, output};
    if (interpolation !== 'LINEAR') sampler.interpolation = interpolation;
    channels.push({sampler: samplers.push(sampler)-1, target: {node, path: track.path}});
  }
  if (!channels.length) return;
  const animation: Record<string, unknown> = {channels, samplers};
  if (clip.name) animation.name = clip.name;
  w.list('animations', animation);
}
