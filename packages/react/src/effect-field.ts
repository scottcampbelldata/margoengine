import { Color, parseColor, type ColorInput } from '@margoengine/math/color';
import { createRandom } from '@margoengine/math/mathutils';

/** Inputs shared by the two native point-field bindings. */
export interface FieldOptions {
  kind: 'stars' | 'sparkles';
  count: number;
  seed?: number;
  radius?: number;
  depth?: number;
  saturation?: number;
  scale?: number | readonly [number, number, number];
  size?: number | Float32Array;
  speed?: number | Float32Array;
  opacity?: number | Float32Array;
  noise?: number | readonly [number, number, number] | Float32Array;
  color?: ColorInput | Float32Array;
  fade?: boolean;
}
/** Arrays retained by the point cloud and an absolute-time animator. */
export interface FieldData {
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  step(time: number): void;
}
const triple = (value: number | readonly [number, number, number] = 1): readonly number[] => typeof value === 'number' ? [value, value, value] : value;
function scalar(value: number | Float32Array | undefined, index: number, fallback: number): number { return value instanceof Float32Array ? value[index] : value ?? fallback; }
/** Seeded native-point data; absolute-time updates preserve repeatable component tests. */
export function createField(options: FieldOptions): FieldData {
  const { count, kind } = options;
  if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) throw new RangeError('Effect count must be 0..1000000; reduce count or pass an integer.');
  const scale = triple(options.scale), noise = options.noise instanceof Float32Array ? options.noise : triple(options.noise), radius = options.radius ?? 100, depth = options.depth ?? 50, saturation = options.saturation ?? 0;
  if (scale.length !== 3 || (noise.length !== 3 && noise.length !== count * 3) || ![...scale, ...noise, radius, depth, saturation].every(v => Number.isFinite(Math.fround(v))) || scale.some(v => v < 0) || noise.some(v => v < 0) || radius < 0 || depth < 0 || saturation < 0 || saturation > 1) throw new RangeError('Effect bounds/noise must be finite and nonnegative, saturation 0..1; pass valid options.');
  for (const value of [options.size, options.speed, options.opacity]) {
    if (value instanceof Float32Array && value.length !== count) throw new RangeError('Per-point effect arrays need count entries; resize the array.');
    if (value !== undefined && !(typeof value === 'number' ? Number.isFinite(value) && value >= 0 : value.every(v => Number.isFinite(v) && v >= 0))) throw new RangeError('Effect size, speed and opacity must be finite and nonnegative; pass valid values.');
  }
  if (options.color instanceof Float32Array && options.color.length !== count * 3) throw new RangeError('Effect colors need count*3 RGB values; resize the array.');
  if (options.color instanceof Float32Array && !options.color.every(Number.isFinite)) throw new RangeError('Effect RGB values must be finite; replace invalid colors.');
  const random = createRandom(options.seed ?? 1), positions = new Float32Array(count * 3), home = new Float32Array(count * 3), colors = new Float32Array(count * 4), sizes = new Float32Array(count), phase = new Float32Array(count), base = new Float32Array(count * 3), tint = new Color();
  const uniform = options.color instanceof Float32Array ? null : parseColor(options.color ?? '#ffffff');
  for (let i = 0; i < count; i++) {
    if (kind === 'stars') {
      const y = 1 - 2 * random(), angle = random() * Math.PI * 2, horizontal = Math.sqrt(Math.max(0, 1 - y * y));
      const r = Math.cbrt(radius ** 3 + random() * ((radius + depth) ** 3 - radius ** 3));
      home.set([r * horizontal * Math.cos(angle), r * y, r * horizontal * Math.sin(angle)], i * 3);
    } else for (let axis = 0; axis < 3; axis++) home[i * 3 + axis] = (random() - 0.5) * scale[axis];
    phase[i] = random() * Math.PI * 2;
    if (kind === 'stars' && options.color === undefined) { tint.setHSL(random(), saturation, 0.85); base.set([tint.r, tint.g, tint.b], i * 3); }
    else base.set(uniform ?? (options.color as Float32Array).subarray(i * 3, i * 3 + 3), i * 3);
    sizes[i] = scalar(options.size, i, kind === 'stars' ? 4 : 6) * (kind === 'stars' ? 0.5 + random() : 1);
  }
  const result: FieldData = { positions, colors, sizes, step(time) {
    if (!Number.isFinite(time) || time < 0) throw new RangeError('Effect time must be finite and nonnegative; pass elapsed seconds.');
    for (let i = 0; i < count; i++) {
      const t = time * scalar(options.speed, i, 1), pulse = 0.5 + 0.5 * Math.sin(t + phase[i]);
      for (let axis = 0; axis < 3; axis++) {
        positions[i * 3 + axis] = home[i * 3 + axis] + (kind === 'sparkles' ? Math.sin(t * (0.6 + axis * 0.2) + phase[i] + axis) * noise[noise.length === 3 ? axis : i * 3 + axis] * scale[axis] * 0.1 : 0);
        colors[i * 4 + axis] = base[i * 3 + axis];
      }
      colors[i * 4 + 3] = Math.min(1, scalar(options.opacity, i, 1)) * (options.fade === false ? 0.75 + 0.25 * pulse : pulse);
    }
  } };
  result.step(0); return result;
}
