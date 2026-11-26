// The built-in filter graph blocks: plain data in the same format as custom blocks. Colours are straight alpha.
// Formulae: Rec. ITU-R BT.709 luma and colour difference, W3C Compositing and Blending Level 1 (blend modes and source
// over), Sobel's 3 x 3 gradient and the pcg3d hash (Jarzynski and Olano 2020); docs/clean-room.md.
import type { FilterBlock, FilterImageAccess, FilterParam, FilterParamType, FilterValue } from './filter-graph-plan.js';

const p = (type: FilterParamType, value: FilterValue, min?: number, max?: number): FilterParam => ({
  type,
  default: value,
  ...(min === undefined ? {} : { min }),
  ...(max === undefined ? {} : { max }),
});
const float = (value: number, min?: number, max?: number) => p('float', value, min, max);
const amount = (value: number) => float(value, 0, 1);
const input = (access: FilterImageAccess) => ({ images: { input: access } });
const LUMA = 'const LUMA = vec3f(0.2126, 0.7152, 0.0722);\n';

/** A one-image colour block: `body` returns the new colour from `c` and the params. */
const colour = (type: string, params: Record<string, FilterParam>, signature: string, body: string): FilterBlock => ({
  type,
  ...input('pixel'),
  params,
  wgsl: `${LUMA}fn apply(uv: vec2f, c: vec4f${signature}) -> vec4f { ${body} }`,
});

/**
 * Every built-in block. Parameter units: pixels are pixels of the graph output; angles are radians; `uv` runs 0..1 from
 * the top left. `time`-driven looks bind a parameter to `'$time'`.
 */
export const filterBlocks: readonly FilterBlock[] = /* @__PURE__ */ Object.freeze<FilterBlock[]>([
  colour(
    'black-and-white',
    { amount: amount(1) },
    ', amount: f32',
    'return vec4f(mix(c.rgb, vec3f(dot(c.rgb, LUMA)), amount), c.a);',
  ),
  colour(
    'saturation',
    { amount: float(1, 0, 8) },
    ', amount: f32',
    'return vec4f(mix(vec3f(dot(c.rgb, LUMA)), c.rgb, amount), c.a);',
  ),
  colour('exposure', { stops: float(0, -20, 20) }, ', stops: f32', 'return vec4f(c.rgb * exp2(stops), c.a);'),
  colour(
    'brightness-contrast',
    { brightness: float(0, -1, 1), contrast: float(1, 0, 8) },
    ', brightness: f32, contrast: f32',
    'return vec4f((c.rgb - 0.5) * contrast + 0.5 + brightness, c.a);',
  ),
  colour(
    'hue',
    { angle: float(0) },
    ', angle: f32',
    // Rodrigues' rotation about the grey axis.
    'let k = vec3f(0.57735027); let s = sin(angle); let h = cos(angle); return vec4f(c.rgb * h + cross(k, c.rgb) * s + k * dot(k, c.rgb) * (1.0 - h), c.a);',
  ),
  colour(
    'tint',
    { color: p('color', '#ffb070'), amount: amount(0.5) },
    ', tint: vec4f, amount: f32',
    'return vec4f(mix(c.rgb, c.rgb * tint.rgb, amount), c.a);',
  ),
  colour('invert', { amount: amount(1) }, ', amount: f32', 'return vec4f(mix(c.rgb, 1.0 - c.rgb, amount), c.a);'),
  colour(
    'sepia',
    { amount: amount(1) },
    ', amount: f32',
    'let y = dot(c.rgb, LUMA); return vec4f(mix(c.rgb, min(vec3f(y) * vec3f(1.2, 1.0, 0.75), vec3f(1.0)), amount), c.a);',
  ),
  colour(
    'levels',
    {
      inBlack: float(0, 0, 1),
      inWhite: float(1, 0, 1),
      gamma: float(1, 0.01, 10),
      outBlack: float(0, 0, 1),
      outWhite: float(1, 0, 1),
    },
    ', inBlack: f32, inWhite: f32, gamma: f32, outBlack: f32, outWhite: f32',
    'let t = clamp((c.rgb - inBlack) / max(inWhite - inBlack, 0.00001), vec3f(0.0), vec3f(1.0)); return vec4f(mix(vec3f(outBlack), vec3f(outWhite), pow(t, vec3f(1.0 / gamma))), c.a);',
  ),
  colour(
    'color-matrix',
    {
      red: p('vec4', [1, 0, 0, 0]),
      green: p('vec4', [0, 1, 0, 0]),
      blue: p('vec4', [0, 0, 1, 0]),
      alpha: p('vec4', [0, 0, 0, 1]),
      offset: p('vec4', [0, 0, 0, 0]),
    },
    ', r: vec4f, g: vec4f, b: vec4f, a: vec4f, offset: vec4f',
    'return vec4f(dot(r, c), dot(g, c), dot(b, c), dot(a, c)) + offset;',
  ),
  colour(
    'posterize',
    { steps: p('int', 6, 2, 256) },
    ', steps: i32',
    'let n = f32(steps - 1); return vec4f(floor(c.rgb * n + 0.5) / n, c.a);',
  ),
  colour(
    'threshold',
    { level: float(0.5), softness: amount(0) },
    ', level: f32, softness: f32',
    'let y = dot(c.rgb, LUMA); let hard = step(level, y); let soft = smoothstep(level - softness, level + max(softness, 0.00001), y); return vec4f(vec3f(select(soft, hard, softness == 0.0)), c.a);',
  ),
  colour(
    'vignette',
    { amount: amount(0.5), radius: float(0.75, 0, 2), softness: float(0.45, 0.001, 2), color: p('color', '#000000') },
    ', amount: f32, radius: f32, softness: f32, edge: vec4f',
    // Distance from the centre, 1 at the middle of each side.
    'let d = length(uv * 2.0 - 1.0); return vec4f(mix(c.rgb, edge.rgb, amount * smoothstep(radius, radius + softness, d)), c.a);',
  ),
  {
    type: 'noise',
    ...input('pixel'),
    params: { amount: amount(0.08), seed: float(0) },
    wgsl: `fn hash(x: vec3u) -> vec3u {
  var v = x * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z;
  return v;
}
fn apply(uv: vec2f, c: vec4f, amount: f32, seed: f32) -> vec4f {
  let n = hash(vec3u(vec2u(uv * filterSize()), bitcast<u32>(seed))).x >> 8u;
  return vec4f(c.rgb + (f32(n) / 16777216.0 - 0.5) * amount, c.a);
}`,
  },
  colour('opacity', { opacity: amount(1) }, ', opacity: f32', 'return vec4f(c.rgb, c.a * opacity);'),
  colour('premultiply-alpha', {}, '', 'return vec4f(c.rgb * c.a, c.a);'),
  {
    type: 'green-screen',
    ...input('pixel'),
    params: { key: p('color', '#00ff00'), similarity: amount(0.4), smoothness: amount(0.1), spill: amount(0.1) },
    wgsl: `fn chroma(c: vec3f) -> vec2f {
  let y = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return vec2f((c.b - y) / 1.8556, (c.r - y) / 1.5748);
}
fn apply(uv: vec2f, c: vec4f, screen: vec4f, similarity: f32, smoothness: f32, spill: f32) -> vec4f {
  let d = distance(chroma(c.rgb), chroma(screen.rgb));
  let keep = smoothstep(similarity, similarity + max(smoothness, 0.00001), d);
  let near = 1.0 - smoothstep(similarity, similarity + max(spill, 0.00001), d);
  return vec4f(mix(c.rgb, vec3f(dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722))), near), c.a * keep);
}`,
  },
  {
    type: 'mask',
    images: { input: 'pixel', mask: 'pixel' },
    params: { invert: p('bool', false) },
    consts: { CHANNEL: { default: 0, options: { luminance: 0, alpha: 1, red: 2 } } },
    wgsl: `fn apply(uv: vec2f, c: vec4f, m: vec4f, invert: bool) -> vec4f {
  var k = dot(m.rgb, vec3f(0.2126, 0.7152, 0.0722));
  if (CHANNEL == 1) { k = m.a; }
  if (CHANNEL == 2) { k = m.r; }
  k = clamp(k, 0.0, 1.0);
  return vec4f(c.rgb, c.a * select(k, 1.0 - k, invert));
}`,
  },
  {
    type: 'composite',
    images: { background: 'pixel', foreground: 'pixel' },
    params: { opacity: amount(1) },
    consts: {
      MODE: {
        default: 0,
        options: { over: 0, add: 1, multiply: 2, screen: 3, overlay: 4, difference: 5, darken: 6, lighten: 7 },
      },
    },
    wgsl: `fn blend(b: vec3f, s: vec3f) -> vec3f {
  if (MODE == 1) { return b + s; }
  if (MODE == 2) { return b * s; }
  if (MODE == 3) { return b + s - b * s; }
  if (MODE == 4) { return select(1.0 - 2.0 * (1.0 - b) * (1.0 - s), 2.0 * b * s, b <= vec3f(0.5)); }
  if (MODE == 5) { return abs(b - s); }
  if (MODE == 6) { return min(b, s); }
  if (MODE == 7) { return max(b, s); }
  return s;
}
fn apply(uv: vec2f, b: vec4f, f: vec4f, opacity: f32) -> vec4f {
  let a = f.a * opacity;
  let s = mix(f.rgb, blend(b.rgb, f.rgb), b.a);
  let o = a + b.a * (1.0 - a);
  return vec4f((s * a + b.rgb * b.a * (1.0 - a)) / max(o, 0.00001), o);
}`,
  },
  {
    type: 'wipe',
    images: { start: 'pixel', end: 'pixel' },
    params: { progress: amount(0.5), angle: float(0), softness: amount(0.02) },
    wgsl: `fn apply(uv: vec2f, a: vec4f, b: vec4f, progress: f32, angle: f32, softness: f32) -> vec4f {
  let axis = vec2f(cos(angle), sin(angle));
  let t = dot(uv - 0.5, axis) / (abs(axis.x) + abs(axis.y)) + 0.5;
  let w = max(softness, 0.00001);
  let edge = progress * (1.0 + 2.0 * w) - w;
  return mix(b, a, smoothstep(edge - w, edge + w, t));
}`,
  },
  {
    type: 'solid-color',
    params: { color: p('color', '#000000') },
    wgsl: 'fn apply(uv: vec2f, fill: vec4f) -> vec4f { return fill; }',
  },
  {
    type: 'gradient',
    params: { start: p('color', '#000000'), end: p('color', '#ffffff'), angle: float(0) },
    wgsl: `fn apply(uv: vec2f, a: vec4f, b: vec4f, angle: f32) -> vec4f {
  let axis = vec2f(cos(angle), sin(angle));
  return mix(a, b, clamp(dot(uv - 0.5, axis) / (abs(axis.x) + abs(axis.y)) + 0.5, 0.0, 1.0));
}`,
  },
  {
    type: 'pixelate',
    ...input('texel'),
    params: { size: float(8, 1, 4096) },
    wgsl: `fn apply(uv: vec2f, size: f32) -> vec4f {
  let cell = size / filterOutputSize();
  return sample_input(min((floor(uv / cell) + 0.5) * cell, vec2f(1.0)));
}`,
  },
  {
    type: 'kaleidoscope',
    ...input('sample'),
    params: { segments: p('int', 6, 1, 64), angle: float(0), center: p('vec2', [0.5, 0.5]) },
    wgsl: `fn apply(uv: vec2f, segments: i32, angle: f32, center: vec2f) -> vec4f {
  let size = filterSize();
  let d = (uv - center) * size;
  let wedge = 6.28318531 / f32(segments);
  var a = atan2(d.y, d.x + select(0.0, 0.00001, d.x == 0.0)) - angle;
  a = abs(a - wedge * floor(a / wedge + 0.5)) + angle;
  return sample_input(center + vec2f(cos(a), sin(a)) * length(d) / size);
}`,
  },
  {
    type: 'mirror',
    ...input('sample'),
    params: { position: amount(0.5) },
    consts: { AXIS: { default: 0, options: { x: 0, y: 1 } } },
    wgsl: `fn apply(uv: vec2f, position: f32) -> vec4f {
  var q = uv;
  if (AXIS == 0) { q.x = position - abs(uv.x - position); } else { q.y = position - abs(uv.y - position); }
  return sample_input(q);
}`,
  },
  {
    type: 'tile',
    ...input('sample'),
    params: { count: p('vec2', [2, 2], 0.001, 1024) },
    wgsl: 'fn apply(uv: vec2f, count: vec2f) -> vec4f { return sample_input(fract(uv * count)); }',
  },
  {
    type: 'transform',
    ...input('sample'),
    params: { offset: p('vec2', [0, 0]), scale: p('vec2', [1, 1], 0.001, 1000), rotation: float(0) },
    wgsl: `fn apply(uv: vec2f, offset: vec2f, scale: vec2f, rotation: f32) -> vec4f {
  let size = filterSize();
  let d = (uv - 0.5 - offset) * size;
  let c = cos(rotation); let s = sin(rotation);
  let q = vec2f(c * d.x + s * d.y, c * d.y - s * d.x) / (size * scale) + 0.5;
  let color = sample_input(q);
  let inside = all(q >= vec2f(0.0)) && all(q <= vec2f(1.0));
  return select(vec4f(0.0), color, inside);
}`,
  },
  {
    type: 'ripple',
    ...input('sample'),
    params: { amplitude: amount(0.01), frequency: float(30, 0, 1000), phase: float(0) },
    wgsl: `fn apply(uv: vec2f, amplitude: f32, frequency: f32, phase: f32) -> vec4f {
  let d = uv - 0.5;
  let r = length(d);
  return sample_input(uv + d / max(r, 0.00001) * sin(r * frequency - phase * 6.28318531) * amplitude);
}`,
  },
  {
    type: 'directional-blur',
    ...input('sample'),
    params: { radius: float(8, 0, 256), angle: float(0) },
    consts: { TAPS: { default: 17, options: { low: 9, medium: 17, high: 33 } } },
    wgsl: `fn apply(uv: vec2f, radius: f32, angle: f32) -> vec4f {
  let step = vec2f(cos(angle), sin(angle)) * radius / filterOutputSize() / f32(TAPS / 2);
  var sum = vec4f(0.0);
  var total = 0.0;
  for (var i = -(TAPS / 2); i <= TAPS / 2; i++) {
    let x = f32(i) / f32(TAPS / 2);
    let w = exp(-4.5 * x * x);
    let c = sample_input(uv + step * f32(i));
    sum += vec4f(c.rgb * c.a, c.a) * w;
    total += w;
  }
  return vec4f(sum.rgb / max(sum.a, 0.00001), sum.a / total);
}`,
  },
  {
    type: 'blur',
    graph: {
      inputs: { input: { type: 'image' }, radius: float(8, 0, 256) },
      nodes: [
        {
          id: 'horizontal',
          type: 'directional-blur',
          images: { input: 'input' },
          params: { radius: '$radius' },
          scale: 0.5,
        },
        {
          id: 'vertical',
          type: 'directional-blur',
          images: { input: 'horizontal' },
          params: { radius: '$radius', angle: Math.PI / 2 },
          scale: 0.5,
        },
      ],
      output: 'vertical',
    },
  },
  {
    type: 'sharpen',
    ...input('sample'),
    params: { amount: float(0.5, 0, 8) },
    wgsl: `fn apply(uv: vec2f, amount: f32) -> vec4f {
  let t = 1.0 / filterOutputSize();
  let c = sample_input(uv);
  let around = sample_input(uv + vec2f(t.x, 0.0)).rgb + sample_input(uv - vec2f(t.x, 0.0)).rgb +
    sample_input(uv + vec2f(0.0, t.y)).rgb + sample_input(uv - vec2f(0.0, t.y)).rgb;
  return vec4f(c.rgb + (4.0 * c.rgb - around) * amount, c.a);
}`,
  },
  {
    type: 'edges',
    ...input('sample'),
    params: { amount: float(1, 0, 16) },
    wgsl: `fn luma(uv: vec2f) -> f32 { return dot(sample_input(uv).rgb, vec3f(0.2126, 0.7152, 0.0722)); }
fn apply(uv: vec2f, amount: f32) -> vec4f {
  let t = 1.0 / filterOutputSize();
  let a = luma(uv + vec2f(-t.x, -t.y)); let b = luma(uv + vec2f(0.0, -t.y)); let c = luma(uv + vec2f(t.x, -t.y));
  let d = luma(uv + vec2f(-t.x, 0.0)); let f = luma(uv + vec2f(t.x, 0.0));
  let g = luma(uv + vec2f(-t.x, t.y)); let h = luma(uv + vec2f(0.0, t.y)); let i = luma(uv + vec2f(t.x, t.y));
  let x = c + 2.0 * f + i - a - 2.0 * d - g;
  let y = g + 2.0 * h + i - a - 2.0 * b - c;
  return vec4f(vec3f(length(vec2f(x, y)) * amount), sample_input(uv).a);
}`,
  },
  {
    type: 'chromatic-aberration',
    ...input('sample'),
    params: { amount: float(3, -256, 256) },
    wgsl: `fn apply(uv: vec2f, amount: f32) -> vec4f {
  let d = (uv - 0.5) * 2.0 * amount / filterOutputSize();
  let c = sample_input(uv);
  return vec4f(sample_input(uv + d).r, c.g, sample_input(uv - d).b, c.a);
}`,
  },
  // sprite-sheet reads from half a texel in from each cell edge, so a frame never filters in its neighbour.
  {
    type: 'sprite-sheet',
    ...input('sample'),
    params: { columns: p('int', 4, 1, 1024), rows: p('int', 4, 1, 1024), frame: float(0) },
    wgsl: `fn apply(uv: vec2f, columns: i32, rows: i32, frame: f32) -> vec4f {
  let count = f32(columns * rows);
  let f = i32(floor(frame - count * floor(frame / count)));
  let grid = vec2f(f32(columns), f32(rows));
  let inset = 0.5 * grid / size_input();
  let within = clamp(uv, inset, 1.0 - inset);
  return sample_input((vec2f(f32(f % columns), f32(f / columns)) + within) / grid);
}`,
  },
]);
