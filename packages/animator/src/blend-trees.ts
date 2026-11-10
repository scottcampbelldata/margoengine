import type { BlendTree } from './index.js';
import { blend1D } from './blend.js';

/** A recursively nested tree. Every child may itself be any tree type. */
export type RichBlendTree =
  | string
  | { type: '1d'; parameter: string; samples: readonly { value: number; tree: RichBlendTree }[] }
  | {
      type: 'cartesian' | 'directional';
      parameters: readonly [string, string];
      samples: readonly { value: readonly [number, number]; tree: RichBlendTree }[];
    }
  | { type: 'direct'; children: readonly { parameter: string; tree: RichBlendTree }[] };

const angle = (a: readonly number[], b: readonly number[]) =>
  Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);

/** Cartesian or polar gradient-band weights, normalized and exact at every sample. */
export function blendGradient2D(
  samples: readonly (readonly [number, number])[],
  x: number,
  y: number,
  mode: 'cartesian' | 'directional' = 'cartesian',
): Float64Array {
  if (
    !samples.length ||
    ![x, y].every(Number.isFinite) ||
    !['cartesian', 'directional'].includes(mode) ||
    samples.some((p) => p.length !== 2 || !p.every(Number.isFinite)) ||
    new Set(samples.map((p) => `${p[0]},${p[1]}`)).size !== samples.length
  )
    throw new RangeError(
      'Blend points need unique finite pairs and finite parameters; use cartesian or directional mode',
    );
  const weights = new Float64Array(samples.length);
  const exact = samples.findIndex((p) => p[0] === x && p[1] === y);
  if (exact >= 0) {
    weights[exact] = 1;
    return weights;
  }
  const scale = Math.max(...samples.flatMap((p) => [Math.abs(p[0]), Math.abs(p[1])]), Math.abs(x), Math.abs(y), 1);
  const points = samples.map((p) => [p[0] / scale, p[1] / scale]);
  const query = [x / scale, y / scale];
  const radius = Math.hypot(...query);
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      r = Math.hypot(...a);
    let w = 1;
    for (let j = 0; j < points.length; j++)
      if (i !== j) {
        const b = points[j],
          s = Math.hypot(...b);
        let dx = b[0] - a[0],
          dy = b[1] - a[1],
          qx = query[0] - a[0],
          qy = query[1] - a[1];
        if (mode === 'directional') {
          const average = (r + s) / 2;
          dx = (s - r) / average;
          qx = (radius - r) / average;
          dy = r === 0 || s === 0 ? 0 : angle(a, b) * 2;
          qy = r === 0 || s === 0 || radius === 0 ? 0 : angle(a, query) * 2;
        }
        const length = dx * dx + dy * dy;
        if (!(length > 0))
          throw new RangeError('Blend points are indistinguishable at this scale; separate the sample positions');
        w = Math.min(w, Math.max(0, 1 - (qx * dx + qy * dy) / length));
      }
    weights[i] = w;
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0))
    throw new RangeError('Directional blend has no influence here; add samples around the missing direction');
  for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  return weights;
}

/** Compiles a nested tree into a state playable by Animator, AnimatorGraph and state layers. */
export function createBlendTree(tree: RichBlendTree): BlendTree {
  const clips: string[] = [],
    names = new Set<string>(),
    active = new Set<object>();
  type Values = Readonly<Record<string, number>>;
  type Node = (values: Values, weight: number, out: Float64Array) => void;
  const parameter = (name: string): string => {
    if (typeof name !== 'string' || !name)
      throw new TypeError('Blend parameter needs a nonempty name; name every controlling parameter');
    names.add(name);
    return name;
  };
  const compile = (input: RichBlendTree, depth = 0): Node => {
    if (typeof input === 'string') {
      if (!input) throw new TypeError('Blend leaf needs a clip name; supply a nonempty clip name');
      let index = clips.indexOf(input);
      if (index < 0) {
        index = clips.length;
        clips.push(input);
      }
      return (_values, weight, out) => {
        out[index] += weight;
      };
    }
    if (!input || typeof input !== 'object' || active.has(input) || depth > 64)
      throw new TypeError('Blend trees must be acyclic and at most 64 levels deep; remove the recursive child');
    active.add(input);
    let get: (values: Values) => ArrayLike<number>, children: Node[];
    if (input.type === 'direct') {
      if (!input.children?.length)
        throw new RangeError('Direct tree needs children; add a parameter and tree for each child');
      const params = input.children.map((child) => parameter(child.parameter));
      children = input.children.map((child) => compile(child.tree, depth + 1));
      get = (values) => {
        const w = params.map((name) => Math.max(0, values[name] ?? 0)),
          max = Math.max(...w);
        if (max === 0) return w;
        const sum = w.reduce((total, value) => total + value / max, 0);
        return w.map((value) => value / max / sum);
      };
    } else if (input.type === '1d') {
      const name = parameter(input.parameter),
        positions = input.samples.map((s) => s.value);
      blend1D(positions, 0);
      children = input.samples.map((s) => compile(s.tree, depth + 1));
      get = (values) => blend1D(positions, values[name] ?? 0);
    } else if (input.type === 'cartesian' || input.type === 'directional') {
      if (input.parameters?.length !== 2) throw new TypeError('2D tree needs two parameters; supply [x, y] names');
      const params = input.parameters.map(parameter),
        mode = input.type;
      const positions = input.samples.map((s) => [...s.value] as [number, number]);
      blendGradient2D(positions, positions[0]?.[0] ?? 0, positions[0]?.[1] ?? 0, mode);
      children = input.samples.map((s) => compile(s.tree, depth + 1));
      get = (values) => blendGradient2D(positions, values[params[0]] ?? 0, values[params[1]] ?? 0, mode);
    } else throw new TypeError('Unknown blend type; use 1d, direct, cartesian or directional');
    active.delete(input);
    return (values, weight, out) => {
      const weights = get(values);
      for (let i = 0; i < children.length; i++) if (weights[i] > 0) children[i](values, weight * weights[i], out);
    };
  };
  const root = compile(tree);
  return {
    parameters: [...names],
    samples: clips.map((clip) => ({ clip })),
    weights(values: Values): Float64Array {
      for (const name of names)
        if (!Number.isFinite(values[name] ?? 0))
          throw new RangeError(`Blend parameter ${name} must be finite; set a finite number`);
      const out = new Float64Array(clips.length);
      root(values, 1, out);
      return out;
    },
  };
}
