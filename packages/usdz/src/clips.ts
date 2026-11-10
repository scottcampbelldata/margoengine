import { LoaderError } from '@margoengine/loaders/common';
import { parseCrate, type Specs, type TimeSamples } from './crate.js';
import { readTextLayer } from './layer.js';
import { anchored } from './stage.js';
import { flat, slerp } from './clip.js';
import type { ExtensionHooks, USDExtension, ValueRead } from './extension.js';
export { ValueClipPlayer, loadValueClips, valueClipFrames } from './clips-player.js';
export type { ClipFrame, ClipFrameOptions, ClipReader, ValueClipPlayerOptions } from './clips-player.js';

/** Pose and safety limits for optional value-clip resolution. Use with composition(). */
export interface ValueClipsOptions {
  /** Stage time code. Default stage startTimeCode, or 0. */
  timeCode?: number;
  /** Maximum clip files across all clip sets. Default 10,000. */
  maxClips?: number;
  /** Files available to synchronous archive/layer parsing, by anchored identifier. */
  layers?: Record<string, string | Uint8Array>;
}
type Pair = [number, number];
interface SetDefinition {
  clock: { scale: number; offset: number };
  owner: string;
  name: string;
  paths: string[];
  active: Pair[];
  times: Pair[];
  primPath: string;
  manifest?: string;
  interpolate: boolean;
  anchor?: string;
  template: boolean;
}
const bad = (message: string): never => {
  throw new LoaderError('USD', 'syntax', message + '; fix value clip metadata');
};
const pairs = (value: unknown): Pair[] => {
  const list = value as number[][] | undefined;
  if (!list) return [];
  if (
    !Array.isArray(list) ||
    list.some((v) => !Array.isArray(v) || v.length !== 2 || v.some((n) => !Number.isFinite(n)))
  )
    bad('invalid clip time pairs');
  return (list as Pair[]).slice().sort((a, b) => a[0] - b[0]);
};
function definitions(read: ValueRead, options: ValueClipsOptions, complete: boolean): SetDefinition[] {
  const out: SetDefinition[] = [];
  let total = 0;
  for (const [owner, spec] of Object.entries(read.specs)) {
    const dictionary =
      spec.specType === 6 ? (spec.fields.clips as Record<string, Record<string, unknown>> | undefined) : undefined;
    if (!dictionary) continue;
    if (typeof dictionary !== 'object' || Array.isArray(dictionary)) bad('clips must be a dictionary');
    const order = spec.fields.clipSets as string[] | undefined;
    if (order !== undefined && (!Array.isArray(order) || order.some((v) => typeof v !== 'string')))
      bad('clipSets must be a list of names');
    for (const name of order ?? Object.keys(dictionary).sort()) {
      const d: Record<string, unknown> = dictionary[name];
      if (!d) continue;
      if (typeof d !== 'object' || Array.isArray(d)) bad('clip definition must be a dictionary');
      let paths = d.assetPaths as string[] | undefined,
        active = pairs(d.active),
        times = pairs(d.times),
        template = false;
      if (paths === undefined && typeof d.templateAssetPath === 'string') {
        template = true;
        paths = [];
        active = [];
        times = [];
        const pattern = d.templateAssetPath,
          match = /^(.*?\.)(#+)(?:\.(#+))?(\.(?:usd|usda|usdc)\]?)$/.exec(pattern);
        const start = d.templateStartTime as number,
          end = d.templateEndTime as number,
          stride = d.templateStride as number,
          offset = (d.templateActiveOffset ?? 0) as number,
          clock = d._margoOffset as { scale: number; offset: number } | undefined;
        if (
          !match ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          !(stride > 0) ||
          !Number.isFinite(stride) ||
          end < start ||
          !Number.isFinite(offset) ||
          Math.abs(offset) > stride
        )
          bad('invalid clip template');
        const count = Math.floor((end - start) / stride + 1e-9) + 1;
        if (total + count > (options.maxClips ?? 10000))
          throw new LoaderError('USD', 'limit', 'too many template clips; raise maxClips');
        for (let i = 0; i < count; i++) {
          const t: number = start + i * stride,
            [integer, fraction] = (match![3] ? t.toFixed(match![3].length) : String(Math.trunc(t))).split('.');
          const digits: string = integer.startsWith('-')
            ? '-' + integer.slice(1).padStart(match![2].length - 1, '0')
            : integer.padStart(match![2].length, '0');
          const path = match![1] + digits + (match![3] ? '.' + fraction : '') + match![4];
          const present = read.entries.has(path) || (options.layers && Object.hasOwn(options.layers, path));
          if ((complete && !present) || read.absent?.has(path)) continue;
          active.push([(t + offset) * (clock?.scale ?? 1) + (clock?.offset ?? 0), paths.length]);
          paths.push(path);
          times.push([t * (clock?.scale ?? 1) + (clock?.offset ?? 0), t]);
        }
        if (times.length && offset) {
          const gap = Math.abs(offset),
            scale = clock?.scale ?? 1;
          times.unshift([times[0][0] - gap * scale, times[0][1] - gap]);
          times.push([times.at(-1)![0] + gap * scale, times.at(-1)![1] + gap]);
        }
      }
      if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string'))
        bad('clip set requires assetPaths or templateAssetPath');
      const assets: string[] = paths ?? bad('missing clip assets');
      total += assets.length;
      if (total > (options.maxClips ?? 10000)) throw new LoaderError('USD', 'limit', 'too many clips; raise maxClips');
      if (!assets.length) continue;
      if (!active.length) active = [[0, 0]];
      if (active.some((v) => !Number.isInteger(v[1]) || v[1] < 0 || v[1] >= paths!.length))
        bad('active clip index out of range');
      if (times.some((v, i) => i > 1 && times[i - 2][0] === v[0])) bad('more than two clip times at one stage time');
      const primPath = d.primPath;
      if (typeof primPath !== 'string' || !primPath.startsWith('/')) bad('clip primPath must be absolute');
      out.push({
        clock: (d._margoOffset as { scale: number; offset: number } | undefined) ?? { scale: 1, offset: 0 },
        owner,
        name,
        paths: assets,
        active,
        times,
        primPath: primPath as string,
        manifest: d.manifestAssetPath as string | undefined,
        interpolate: d.interpolateMissingClipValues === true,
        anchor: d._margoAnchor as string | undefined,
        template,
      });
    }
  }
  return out.sort((a, b) => b.owner.split('/').length - a.owner.split('/').length);
}
function sample(samples: TimeSamples | undefined, time: number, type = ''): unknown {
  if (!samples?.times.length) return undefined;
  let i = 0;
  while (i + 1 < samples.times.length && samples.times[i + 1] <= time) i++;
  if (time < samples.times[0]) i = 0;
  const a = samples.values[i],
    j = Math.min(i + 1, samples.times.length - 1),
    b = samples.values[j];
  if (
    i === j ||
    time <= samples.times[i] ||
    a == null ||
    b == null ||
    /^(?:bool|token|string|asset|u?int|int64|uint64)/.test(type)
  )
    return a;
  const t = (time - samples.times[i]) / (samples.times[j] - samples.times[i]);
  if (/^quat[fdh](?:\[\])?$/.test(type)) {
    const x = flat(a),
      y = flat(b);
    if (x.length !== y.length || x.length % 4) return a;
    const out: number[] = [];
    for (let k = 0; k < x.length; k += 4) {
      const q: number[] = [];
      slerp([x[k + 1], x[k + 2], x[k + 3], x[k]], [y[k + 1], y[k + 2], y[k + 3], y[k]], t, q, 0);
      out.push(q[3], q[0], q[1], q[2]);
    }
    return out;
  }
  const mix = (x: unknown, y: unknown): unknown =>
    typeof x === 'number' && typeof y === 'number'
      ? x + (y - x) * t
      : Array.isArray(x) && Array.isArray(y) && x.length === y.length
        ? x.map((v, k) => mix(v, y[k]))
        : ArrayBuffer.isView(x) &&
            ArrayBuffer.isView(y) &&
            (x as unknown as ArrayLike<number>).length === (y as unknown as ArrayLike<number>).length
          ? Array.from(
              x as unknown as ArrayLike<number>,
              (v, k) => v + ((y as unknown as ArrayLike<number>)[k] - v) * t,
            )
          : x;
  return mix(a, b);
}
function mapped(times: Pair[], time: number, left = false): number {
  if (!times.length) return time;
  let i = -1;
  while (i + 1 < times.length && (left ? times[i + 1][0] < time : times[i + 1][0] <= time)) i++;
  if (i < 0) return times[0][1];
  if (i === times.length - 1) return times[i][1];
  const a = times[i],
    b = times[i + 1];
  return a[1] + ((b[1] - a[1]) * (time - a[0])) / (b[0] - a[0]);
}
const inside = (path: string, root: string) =>
  root === '/' ? path.startsWith('/') : path === root || path.startsWith(root + '/') || path.startsWith(root + '.');

/** Resolve one requested pose from sequenced, retimed clip layers, opening only the necessary clips with a manifest. */
export function valueClips(options: ValueClipsOptions = {}): USDExtension {
  if (options.timeCode !== undefined && !Number.isFinite(options.timeCode))
    throw new RangeError('timeCode must be finite; fix valueClips options');
  if (!Number.isSafeInteger(options.maxClips ?? 10000) || (options.maxClips ?? 10000) < 1)
    throw new RangeError('maxClips must be positive; fix valueClips options');
  const cache = new Map<string, { data: Uint8Array; specs: Specs }>();
  const get = (read: ValueRead, id: string): Specs | undefined => {
    const extra = options.layers && Object.hasOwn(options.layers, id) ? options.layers[id] : undefined,
      data = read.entries.get(id) ?? (typeof extra === 'string' ? new TextEncoder().encode(extra) : extra);
    if (!data) return;
    if (data.byteLength > read.maxBytes)
      throw new LoaderError('USD', 'limit', 'clip exceeds byte budget; raise maxBytes');
    const known = cache.get(id);
    if (known?.data === data) return known.specs;
    read.signal?.throwIfAborted();
    const text = new TextDecoder().decode(data.subarray(0, 8));
    const specs =
      text === 'PXR-USDC'
        ? parseCrate(data, read.maxBytes, read.maxDepth, true)
        : readTextLayer(new TextDecoder().decode(data), read.maxDepth, read.signal);
    cache.set(id, { data, specs });
    return specs;
  };
  const timeOf = (read: ValueRead) => options.timeCode ?? Number(read.specs['/']?.fields.startTimeCode ?? 0);
  const hook: ExtensionHooks & { options: ValueClipsOptions } = {
    name: 'clips',
    options,
    requiresValueSources: true,
    files(read) {
      const wanted = new Set<string>(),
        time = timeOf(read);
      for (const set of definitions(read, options, false)) {
        if (set.manifest) wanted.add(set.manifest);
        if (!set.manifest || set.interpolate) {
          for (const id of set.paths) wanted.add(id);
          continue;
        }
        let index = 0;
        while (index + 1 < set.active.length && set.active[index + 1][0] <= time) index++;
        for (let i = Math.max(0, index - 1); i <= Math.min(set.active.length - 1, index + 1); i++)
          wanted.add(set.paths[set.active[i][1]]);
      }
      return [...wanted];
    },
    resolve(read) {
      const time = timeOf(read),
        sets = definitions(read, options, true),
        settled = new Set<string>();
      if (!Number.isFinite(time)) bad('stage start time must be finite');
      for (const set of sets) {
        const needed = new Set<string>();
        if (set.manifest) needed.add(set.manifest);
        let at = 0;
        while (at + 1 < set.active.length && set.active[at + 1][0] <= time) at++;
        if (!set.manifest || set.interpolate) for (const id of set.paths) needed.add(id);
        else
          for (let i = Math.max(0, at - 1); i <= Math.min(set.active.length - 1, at + 1); i++)
            needed.add(set.paths[set.active[i][1]]);
        for (const id of needed)
          if (
            !read.entries.has(id) &&
            !(options.layers && Object.hasOwn(options.layers, id)) &&
            !read.issues.some((issue) => issue.code === 'missing-clip' && issue.message === 'Missing ' + id)
          )
            read.issues.push({ code: 'missing-clip', message: 'Missing ' + id });
        const manifest = set.manifest ? get(read, set.manifest) : undefined;
        if (set.manifest && !manifest) {
          read.issues.push({ code: 'missing-clip-manifest', message: 'Missing ' + set.manifest });
          continue;
        }
        const properties = new Map<string, Record<string, unknown>>();
        if (manifest) {
          for (const [path, spec] of Object.entries(manifest))
            if (spec.specType === 1 && inside(path, set.primPath)) properties.set(path, spec.fields);
        } else {
          for (const id of set.paths)
            for (const [path, spec] of Object.entries(get(read, id) ?? {}))
              if (spec.specType === 1 && spec.fields.timeSamples && inside(path, set.primPath))
                properties.set(path, { typeName: spec.fields.typeName });
        }
        for (const [source, decl] of properties) {
          const target = set.owner + (set.primPath === '/' ? source : source.slice(set.primPath.length)),
            prim = target.slice(0, target.lastIndexOf('.'));
          if (settled.has(target) || !read.specs[prim]) continue;
          let spec = read.specs[target];
          if (!spec) {
            if (
              ![
                'points',
                'normals',
                'extent',
                'visibility',
                'widths',
                'faceVertexCounts',
                'faceVertexIndices',
                'velocities',
                'accelerations',
              ].includes(target.slice(target.lastIndexOf('.') + 1))
            )
              continue;
            spec = read.specs[target] = { specType: 1, fields: { typeName: decl.typeName } };
          }
          const layers = spec.fields._margoValueSources as string[] | undefined,
            origin = spec.fields._margoValueLayer as string | undefined;
          if (origin && layers && set.anchor && layers.indexOf(origin) <= layers.indexOf(set.anchor)) continue;
          const keys: { time: number; value: unknown }[] = [],
            type = String(decl.typeName ?? spec.fields.typeName ?? '');
          const add = (time: number, value: unknown) => {
            if (Number.isFinite(time)) keys.push({ time, value });
          };
          for (let i = 0; i < set.active.length; i++) {
            const start = set.active[i][0],
              end = set.active[i + 1]?.[0] ?? Infinity,
              id = set.paths[set.active[i][1]],
              fields = get(read, id)?.[source]?.fields,
              samples = fields?.timeSamples as TimeSamples | undefined;
            const blocked = (decl.timeSamples as TimeSamples | undefined)?.times.some(
              (t, k) => t === start && (decl.timeSamples as TimeSamples).values[k] === null,
            );
            if (!samples?.times.length || blocked) {
              if (!set.interpolate || decl.default !== undefined) add(start, decl.default ?? null);
              continue;
            }
            const value = (at: number, left = false) => {
              const v = sample(
                samples,
                set.times.length ? mapped(set.times, at, left) : (at - set.clock.offset) / set.clock.scale,
                type,
              );
              return type === 'asset' && typeof v === 'string' ? anchored(id, v) : v;
            };
            add(start, value(start));
            const segments =
              set.times.length > 1
                ? set.times.slice(0, -1).map((a, k) => [a, set.times[k + 1]])
                : [
                    [
                      [-Infinity, -Infinity],
                      [Infinity, Infinity],
                    ],
                  ];
            for (const t of samples.times) {
              if (!set.times.length) {
                const at = t * set.clock.scale + set.clock.offset;
                if (at >= start && at < end) add(at, value(at));
                continue;
              }
              for (const [a, b] of segments)
                if (b[0] > a[0] && a[1] !== b[1]) {
                  const at = a[0] + ((t - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
                  if (at >= a[0] && at <= b[0] && at >= start && at < end) add(at, value(at));
                }
            }
            for (let k = 0; k < set.times.length; k++) {
              const t = set.times[k][0];
              if (t >= start && t < end) add(t, value(t, set.times[k + 1]?.[0] === t));
            }
            if (set.times.filter((v) => v[0] === end).length === 2) add(end, value(end, true));
            if (i === set.active.length - 1 && time >= start) add(time, value(time));
            if (i === 0 && time < start) add(time, value(time));
          }
          keys.sort((a, b) => a.time - b.time);
          if (!keys.length) continue;
          const value = sample({ times: keys.map((k) => k.time), values: keys.map((k) => k.value) }, time, type);
          spec.fields = { ...spec.fields, default: value };
          delete spec.fields.timeSamples;
          settled.add(target);
        }
      }
      for (const spec of Object.values(read.specs))
        if (spec.specType === 1 && spec.fields.timeSamples) {
          spec.fields.default = sample(
            spec.fields.timeSamples as TimeSamples,
            time,
            String(spec.fields.typeName ?? ''),
          );
          delete spec.fields.timeSamples;
        }
    },
  };
  return hook;
}
