import { LoaderError } from '@margoengine/loaders/common';
import { bracket, flat, slerp } from './clip.js';
import type { TimeSamples } from './crate.js';
import type { ExtensionHooks, SceneRead, USDExtension } from './extension.js';

/** PointInstancer expansion limits and the pose to read. */
export interface InstancerOptions {
  /** Stage time code. Default: the stage's startTimeCode, or the first authored sample. */
  timeCode?: number;
  /** Maximum added nodes, including prototype descendants. Default 100,000. */
  maxNodes?: number;
}
const invalid = (message: string): never => {
  throw new LoaderError('USD', 'syntax', message);
};

function expand(read: SceneRead, options: InstancerOptions): void {
  const { specs, document: doc } = read,
    nodes = doc.nodes!;
  const start = specs['/']?.fields.startTimeCode;
  let first = Infinity;
  for (const spec of Object.values(specs))
    first = Math.min(first, (spec.fields.timeSamples as TimeSamples | undefined)?.times[0] ?? Infinity);
  const time = options.timeCode ?? (typeof start === 'number' ? start : Number.isFinite(first) ? first : 0);
  const fields = (path: string, name: string) => specs[path + '.' + name]?.fields;
  const at = (path: string, name: string, held = false): number[] | undefined => {
    const f = fields(path, name),
      samples = f?.timeSamples as TimeSamples | undefined;
    if (!samples?.times.length) return f?.default == null ? undefined : flat(f.default);
    const [a, b, mix] = bracket(samples.times, time),
      from = flat(samples.values[a]),
      to = flat(samples.values[b]);
    if (held || !mix || from.length !== to.length) return from;
    if (name.startsWith('orientations')) {
      const out = from.slice();
      for (let i = 0; i < out.length; i += 4) {
        // USD quaternions are (real, imaginary), glTF quaternions are (x,y,z,w).
        const q = [from[i + 1], from[i + 2], from[i + 3], from[i]],
          r = [to[i + 1], to[i + 2], to[i + 3], to[i]],
          v: number[] = [];
        slerp(q, r, mix, v, 0);
        out.splice(i, 4, v[3], v[0], v[1], v[2]);
      }
      return out;
    }
    return from.map((v, i) => v + mix * (to[i] - v));
  };
  const max = options.maxNodes ?? 100000;
  let added = 0;
  const allocate = (node: NonNullable<typeof doc.nodes>[number]) => {
    if (++added > max) throw new LoaderError('USD', 'limit', 'PointInstancer node budget exceeded; raise maxNodes');
    nodes.push(node);
    return nodes.length - 1;
  };
  const completed = new Set<string>(),
    visiting = new Set<string>();
  const process = (path: string) => {
    if (completed.has(path)) return;
    if (visiting.has(path)) invalid('PointInstancer prototype cycle at ' + path);
    visiting.add(path);
    const owner = read.nodes.get(path);
    if (owner === undefined) {
      visiting.delete(path);
      completed.add(path);
      return;
    }
    const targets = fields(path, 'prototypes')?.targetPaths as string[] | undefined;
    const indices = at(path, 'protoIndices', true) ?? [],
      positions = at(path, 'positions') ?? [];
    if (!targets?.length && indices.length) invalid('PointInstancer has no prototypes at ' + path);
    const scales = at(path, 'scales'),
      orientations = at(path, 'orientationsf') ?? at(path, 'orientations'),
      ids = at(path, 'ids', true);
    for (const [name, stream, width] of [
      ['positions', positions, 3],
      ['scales', scales, 3],
      ['orientations', orientations, 4],
      ['ids', ids, 1],
    ] as const)
      if (stream && (stream.length !== indices.length * width || stream.some((v) => !Number.isFinite(v))))
        invalid(`PointInstancer ${name} count or value at ${path}`);
    const inactive = specs[path].fields.inactiveIds;
    const inactiveIds =
      Array.isArray(inactive) || ArrayBuffer.isView(inactive)
        ? flat(inactive)
        : flat((inactive as { explicit?: unknown } | undefined)?.explicit);
    const hidden = new Set([...inactiveIds, ...(at(path, 'invisibleIds', true) ?? [])]);
    const rate = Number(specs['/']?.fields.timeCodesPerSecond ?? specs['/']?.fields.framesPerSecond ?? 24);
    if (!(rate > 0) || !Number.isFinite(rate)) invalid('PointInstancer timeCodesPerSecond must be positive');
    const motion = (name: string, base: string) => {
      const samples = fields(path, base)?.timeSamples as TimeSamples | undefined;
      const baseTime = samples?.times[bracket(samples.times, time)[0]] ?? time;
      const stream = at(path, name, true);
      if (stream && (stream.length !== indices.length * 3 || stream.some((v) => !Number.isFinite(v))))
        invalid(`PointInstancer ${name} count or value at ${path}`);
      return { stream, dt: (time - baseTime) / rate, baseTime };
    };
    const velocity = motion('velocities', 'positions'),
      acceleration = at(path, 'accelerations', true),
      angular = motion('angularVelocities', fields(path, 'orientationsf') ? 'orientationsf' : 'orientations');
    if (acceleration && (acceleration.length !== positions.length || acceleration.some((v) => !Number.isFinite(v))))
      invalid('PointInstancer acceleration count at ' + path);
    // Expand nested instancers first. Descendant instancers in each prototype retain their shared meshes.
    for (const target of targets ?? []) {
      if (target === path || path.startsWith(target + '/'))
        invalid('PointInstancer prototype contains its instancer at ' + path);
      for (const p of read.nodes.keys())
        if ((p === target || p.startsWith(target + '/')) && specs[p]?.fields.typeName === 'PointInstancer') process(p);
    }
    const clone = (id: number, seen: Set<number>): number => {
      if (seen.has(id)) invalid('PointInstancer node cycle at ' + path);
      const next = new Set(seen).add(id),
        original = nodes[id];
      const copy = allocate({
        ...original,
        extras: { ...(original.extras as object), usdPrototype: true },
        children: [],
      });
      nodes[copy].children = original.children?.map((child) => clone(child, next));
      return copy;
    };
    const roots = new Set((targets ?? []).filter((t) => t.startsWith(path + '/')).map((t) => read.nodes.get(t)));
    // Prototype subtrees below this instancer are not rendered at their authored location.
    for (const node of nodes) if (node.children) node.children = node.children.filter((id) => !roots.has(id));
    for (let i = 0; i < indices.length; i++) {
      const proto = indices[i];
      if (!Number.isSafeInteger(proto) || proto < 0 || proto >= (targets?.length ?? 0))
        invalid('PointInstancer prototype index at ' + path);
      if (hidden.has(ids?.[i] ?? i)) continue;
      const target = read.nodes.get(targets![proto]);
      if (target === undefined) continue;
      const translation = positions.slice(i * 3, i * 3 + 3),
        scale = scales?.slice(i * 3, i * 3 + 3) ?? [1, 1, 1];
      if (velocity.stream) {
        // Velocity evaluation uses the lower position sample, rather than interpolated positions.
        const sample = fields(path, 'positions')?.timeSamples as TimeSamples | undefined;
        const base = sample ? flat(sample.values[bracket(sample.times, time)[0]]) : positions;
        for (let d = 0; d < 3; d++)
          translation[d] =
            base[i * 3 + d] +
            velocity.stream[i * 3 + d] * velocity.dt +
            0.5 * (acceleration?.[i * 3 + d] ?? 0) * velocity.dt ** 2;
      }
      const q = orientations?.slice(i * 4, i * 4 + 4) ?? [1, 0, 0, 0];
      if (angular.stream) {
        const name = fields(path, 'orientationsf') ? 'orientationsf' : 'orientations';
        const samples = fields(path, name)?.timeSamples as TimeSamples | undefined;
        if (samples) q.splice(0, 4, ...flat(samples.values[bracket(samples.times, time)[0]]).slice(i * 4, i * 4 + 4));
        const v = angular.stream.slice(i * 3, i * 3 + 3),
          speed = Math.hypot(...v),
          angle = (speed * angular.dt * Math.PI) / 360;
        const [w, x, y, z] = q,
          [a, b, c] = v.map((v) => (speed ? (v / speed) * Math.sin(angle) : 0)),
          r = Math.cos(angle);
        q.splice(
          0,
          4,
          w * r - x * a - y * b - z * c,
          w * a + x * r + y * c - z * b,
          w * b - x * c + y * r + z * a,
          w * c + x * b - y * a + z * r,
        );
      }
      const length = Math.hypot(...q);
      if (!length) invalid('PointInstancer zero orientation at ' + path);
      const instance = allocate({
        name: `instance_${ids?.[i] ?? i}`,
        translation,
        scale,
        rotation: [q[1] / length, q[2] / length, q[3] / length, q[0] / length],
        children: [clone(target, new Set())],
        extras: { usdInstanceId: ids?.[i] ?? i, usdInstancer: path },
      });
      (nodes[owner].children ??= []).push(instance);
    }
    visiting.delete(path);
    completed.add(path);
  };
  for (const path of read.nodes.keys()) if (specs[path]?.fields.typeName === 'PointInstancer') process(path);
}

/** Expand PointInstancer prototype subtrees into nodes sharing mesh accessors. Works with every USD reader and worker. */
export function pointInstancers(options: InstancerOptions = {}): USDExtension {
  if (options.timeCode !== undefined && !Number.isFinite(options.timeCode))
    throw new RangeError('timeCode must be finite');
  if (!Number.isSafeInteger(options.maxNodes ?? 100000) || (options.maxNodes ?? 100000) < 1)
    throw new RangeError('maxNodes must be a positive integer');
  const hook: ExtensionHooks & { options: InstancerOptions } = {
    name: 'instancer',
    options,
    scene: (read) => expand(read, options),
  };
  return hook;
}
