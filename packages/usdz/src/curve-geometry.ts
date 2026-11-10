import { LoaderError } from '@margoengine/loaders/common';
import { meshWorldMatrix } from '@margoengine/math/mesh';
import type { Mesh } from '@margoengine/core';
import { bracket, flat } from './clip.js';
import type { TimeSamples } from './crate.js';
import type { ExtensionHooks, SceneRead } from './extension.js';

/** Resolution and pose for USD BasisCurves and Points. */
export interface CurvesOptions {
  /** Linear pieces per cubic segment, 1..256. Default 16. Linear curves keep their authored points. */
  segments?: number;
  /** Stage time code. Default startTimeCode or the first sample. */
  timeCode?: number;
}
export interface Part {
  points: number;
  widths: number;
  colors: number;
  kind: 'curve' | 'points';
}
const invalid = (message: string): never => {
  throw new LoaderError('USD', 'syntax', message + '; fix curve data');
};
const weights = (basis: string, t: number): number[] => {
  const s = 1 - t,
    t2 = t * t,
    t3 = t2 * t;
  return basis === 'bezier'
    ? [s * s * s, 3 * s * s * t, 3 * s * t2, t3]
    : basis === 'bspline'
      ? [(s * s * s) / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6]
      : [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
};

function convert(read: SceneRead, options: CurvesOptions): void {
  const { specs, document: doc } = read;
  let total = read.meshes.reduce((sum, mesh) => sum + mesh.vertexOf.length, 0);
  const start = specs['/']?.fields.startTimeCode;
  let first = Infinity;
  for (const s of Object.values(specs))
    first = Math.min(first, (s.fields.timeSamples as TimeSamples | undefined)?.times[0] ?? Infinity);
  const time = options.timeCode ?? (typeof start === 'number' ? start : Number.isFinite(first) ? first : 0);
  const field = (path: string, name: string) => specs[path + '.' + name]?.fields;
  const get = (path: string, name: string, held = false): unknown => {
    const f = field(path, name),
      s = f?.timeSamples as TimeSamples | undefined;
    if (!s?.times.length) return f?.default;
    const [a, b, t] = bracket(s.times, time);
    if (held || !t) return s.values[a];
    const x = flat(s.values[a]),
      y = flat(s.values[b]);
    return x.length === y.length ? x.map((v, i) => v + t * (y[i] - v)) : s.values[a];
  };
  const numbers = (value: unknown): number[] => {
    const out = flat(value);
    if (out.some((v) => typeof v !== 'number' || !Number.isFinite(Math.fround(v)))) invalid('nonfinite numeric stream');
    return out;
  };
  for (const [path, spec] of Object.entries(specs)) {
    const kind = spec.fields.typeName;
    if (spec.specType !== 6 || (kind !== 'BasisCurves' && kind !== 'Points')) continue;
    const node = read.nodes.get(path);
    if (node === undefined) continue;
    let purposePath = path,
      purpose: unknown;
    while (purposePath && purpose === undefined) {
      purpose = get(purposePath, 'purpose', true);
      purposePath = purposePath.slice(0, purposePath.lastIndexOf('/'));
    }
    if (purpose === 'guide' || purpose === 'proxy') continue;
    const points = numbers(get(path, 'points'));
    if (points.length % 3) invalid('points require xyz');
    if (!points.length) continue;
    const isPoints = kind === 'Points',
      type = get(path, 'type', true) ?? 'cubic',
      basis = String(get(path, 'basis', true) ?? 'bezier'),
      wrap = get(path, 'wrap', true) ?? 'nonperiodic';
    if (
      !isPoints &&
      (!['linear', 'cubic'].includes(String(type)) ||
        !['bezier', 'bspline', 'catmullRom'].includes(basis) ||
        !['nonperiodic', 'periodic', 'pinned'].includes(String(wrap)))
    )
      invalid('unknown curve basis, type or wrap');
    const linear = type === 'linear',
      periodic = wrap === 'periodic',
      pinned = !linear && basis !== 'bezier' && wrap === 'pinned';
    const counts = isPoints ? [points.length / 3] : numbers(get(path, 'curveVertexCounts', true));
    const step = basis === 'bezier' ? 3 : 1;
    if (
      !counts.length ||
      counts.some((v) => !Number.isInteger(v) || v < (isPoints ? 1 : linear || pinned ? 2 : periodic ? step : 4)) ||
      counts.reduce((a, b) => a + b, 0) !== points.length / 3
    )
      invalid('curve counts do not match points');
    const segments = counts.map((n) =>
      isPoints ? 0 : linear ? n - (periodic ? 0 : 1) : pinned ? n - 1 : periodic ? n / step : (n - 4) / step + 1,
    );
    if (segments.some((v) => !Number.isInteger(v) || v < 0)) invalid('curve count does not divide basis step');
    const varyingTotal = segments.reduce((a, n) => a + n + (periodic ? 0 : 1), 0);
    let offset = 0,
      varyingOffset = 0;
    const parts: Part[] = [];
    const stream = (name: string, width: number, fallback: number[], defaultInterpolation: string) => {
      let owner = path,
        f = field(owner, name);
      while (!f && name.startsWith('primvars:') && owner.includes('/')) {
        owner = owner.slice(0, owner.lastIndexOf('/'));
        f = field(owner, name);
      }
      if (!f) return (_curve: number, _vertex: number, _varying: number) => fallback;
      const values = numbers(get(owner, name)),
        indicesValue = get(owner, name + ':indices', true),
        indices = indicesValue === undefined ? undefined : numbers(indicesValue);
      if (name.endsWith('widths') && values.some((v) => v < 0)) invalid('negative width');
      const interpolation = String(f.interpolation ?? defaultInterpolation);
      const count =
        interpolation === 'constant'
          ? 1
          : interpolation === 'uniform'
            ? isPoints
              ? 1
              : counts.length
            : interpolation === 'vertex'
              ? points.length / 3
              : interpolation === 'varying'
                ? isPoints
                  ? points.length / 3
                  : varyingTotal
                : invalid('unsupported curve interpolation');
      if (values.length % width || (indices ? indices.length !== count : values.length !== count * width))
        invalid('primvar cardinality mismatch for ' + name);
      if (indices?.some((i) => !Number.isInteger(i) || i < 0 || (i + 1) * width > values.length))
        invalid('primvar index out of range');
      return (curve: number, vertex: number, varying: number) => {
        const i =
          interpolation === 'constant'
            ? 0
            : interpolation === 'uniform'
              ? isPoints
                ? 0
                : curve
              : interpolation === 'vertex'
                ? vertex
                : varying;
        return values.slice((indices?.[i] ?? i) * width, (indices?.[i] ?? i) * width + width);
      };
    };
    const widthName = field(path, 'primvars:widths') ? 'primvars:widths' : 'widths';
    const widthAt = stream(widthName, 1, [1], 'vertex'),
      colorAt = stream('primvars:displayColor', 3, [0.5, 0.5, 0.5], 'constant'),
      alphaAt = stream('primvars:displayOpacity', 1, [1], 'constant');
    for (let curve = 0; curve < counts.length; curve++) {
      const n = counts[curve],
        segmentCount = segments[curve],
        pieces = linear ? 1 : (options.segments ?? 16),
        outCount = isPoints ? n : segmentCount * pieces + 1;
      total += outCount;
      if (total > read.maxVertices)
        throw new LoaderError('USD', 'limit', 'curve vertex budget exceeded; lower segments or raise maxVertices');
      const p = new Float32Array(outCount * 3),
        w = new Float32Array(outCount),
        c = new Float32Array(outCount * 4);
      const control = (index: number, getValue: (i: number) => number[]): number[] => {
        if (periodic) return getValue(((index % n) + n) % n);
        if (index < 0) return getValue(0).map((v, d) => 2 * v - getValue(1)[d]);
        if (index >= n) return getValue(n - 1).map((v, d) => 2 * v - getValue(n - 2)[d]);
        return getValue(index);
      };
      for (let i = 0; i < outCount; i++) {
        const seg = isPoints ? i : Math.min(segmentCount - 1, Math.floor(i / pieces)),
          t = isPoints ? 0 : (i - seg * pieces) / pieces;
        const ids = isPoints
          ? [i]
          : linear
            ? [seg, seg + 1]
            : [0, 1, 2, 3].map((v) => seg * step + v - (pinned ? 1 : 0));
        const basisWeights = isPoints ? [1] : linear ? [1 - t, t] : weights(basis, t);
        const evaluate = (getValue: (index: number) => number[], dim: number) => {
          const out = new Array<number>(dim).fill(0);
          for (let k = 0; k < ids.length; k++) {
            const v = control(ids[k], getValue);
            for (let d = 0; d < dim; d++) out[d] += v[d] * basisWeights[k];
          }
          return out;
        };
        p.set(
          evaluate((j) => points.slice((offset + j) * 3, (offset + j) * 3 + 3), 3),
          i * 3,
        );
        const interpolate = (name: string, reader: typeof widthAt, dim: number) => {
          const interpolation = field(path, name)?.interpolation;
          if (interpolation === 'varying' && !isPoints) {
            const a = reader(curve, 0, varyingOffset + seg),
              b = reader(curve, 0, varyingOffset + (periodic ? (seg + 1) % segmentCount : seg + 1));
            return a.map((v, d) => v + t * (b[d] - v));
          }
          return evaluate((j) => reader(curve, offset + j, isPoints ? offset + j : varyingOffset), dim);
        };
        w[i] = Math.max(0, interpolate(widthName, widthAt, 1)[0]);
        c.set(interpolate('primvars:displayColor', colorAt, 3), i * 4);
        c[i * 4 + 3] = Math.max(0, Math.min(1, interpolate('primvars:displayOpacity', alphaAt, 1)[0]));
      }
      parts.push({
        kind: isPoints ? 'points' : 'curve',
        points: read.accessor(p, 'VEC3'),
        widths: read.accessor(w, 'SCALAR'),
        colors: read.accessor(c, 'VEC4'),
      });
      offset += n;
      varyingOffset += segmentCount + (periodic ? 0 : 1);
    }
    // Native transparent points retain real bounds, hierarchy and worker preparation without triangle placeholders.
    const material = doc.materials!.length;
    doc.materials!.push({ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0] }, alphaMode: 'BLEND' });
    doc.nodes![node].mesh = doc.meshes!.length;
    doc.meshes!.push({
      primitives: parts.map((part) => ({ mode: 0, attributes: { POSITION: part.points }, material })),
      extras: { usdCurves: parts },
    });
  }
}

/** Import BasisCurves and Points with sampled widths and display primvars, using optional Lines and Points renderers. */
export function curveGeometry(options: CurvesOptions = {}): ExtensionHooks & { options: CurvesOptions } {
  if (
    !Number.isInteger(options.segments ?? 16) ||
    (options.segments ?? 16) < 1 ||
    (options.segments ?? 16) > 256 ||
    (options.timeCode !== undefined && !Number.isFinite(options.timeCode))
  )
    throw new RangeError('Invalid curves options; use segments 1..256 and a finite timeCode');
  const hook: ExtensionHooks & { options: CurvesOptions } = {
    name: 'curves',
    options,
    geometry: (read) => convert(read, options),
  };
  return hook;
}
