// Ready-made screen effects (vignette, RGB shift, pixelation, halftone, dot screen, Sobel,
// sepia, posterize), each one NodePass built from this package's nodes. Parameters are uniforms: `effect.uniforms.x.value`
// changes them live without recompiling. Formulas: Rec. 709 luma, the W3C Filter Effects sepia matrix, the 3x3 Sobel kernels.
import { NodePass, inputColor, type NodePassOptions } from './post.js';
import {
  type Node,
  type UniformNode,
  clamp,
  dot,
  floor,
  mat3,
  max,
  mix,
  resolution,
  saturate,
  screenCoordinate,
  screenUV,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from './node.js';

/** A preset NodePass with its live parameters: `effect.uniforms.amount.value = 0.5` (never recompiles). */
export type ScreenEffect<U extends Record<string, UniformNode<'f32'>>> = NodePass & { readonly uniforms: U };
let count = 0;
function preset<U extends Record<string, UniformNode<'f32'>>>(
  kind: string,
  node: Node<'vec3f' | 'vec4f'>,
  uniforms: U,
  options: NodePassOptions,
): ScreenEffect<U> {
  return Object.assign(new NodePass(node, { kind: options.kind, name: options.name ?? `shader:${kind}:${count++}` }), {
    uniforms,
  });
}
function param(value: number | undefined, fallback: number, name: string): UniformNode<'f32'> {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new RangeError(`Screen effect ${name} must be a finite number`);
  return uniform(v, { name });
}
const luma = (c: Node<'vec3f'>): Node<'f32'> => dot(c, vec3(0.2126, 0.7152, 0.0722));
/** Pixel `p` in a grid of `size`-pixel cells rotated by `angle`: the cell centre (screen pixels) and the distance to it. */
function cells(p: Node<'vec2f'>, size: Node<'f32'>, angle: Node<'f32'>) {
  const c = angle.cos(),
    s = angle.sin(),
    q = vec2(p.x.mul(c).add(p.y.mul(s)), p.y.mul(c).sub(p.x.mul(s))),
    cell = floor(q.div(size)).add(0.5).mul(size);
  return {
    centre: vec2(cell.x.mul(c).sub(cell.y.mul(s)), cell.x.mul(s).add(cell.y.mul(c))),
    distance: q.sub(cell).length(),
  };
}
/** Coverage of a dot whose area follows `value` (0 none, 1 fills the cell), antialiased over one pixel. */
function ink(value: Node<'f32'>, distance: Node<'f32'>, size: Node<'f32'>): Node<'f32'> {
  const r = sqrt(saturate(value)).mul(size).mul(Math.SQRT1_2);
  return saturate(r.sub(distance).add(0.5)).mul(saturate(r.mul(2)));
}

/** Options of {@link vignette}. */
export interface VignetteOptions extends NodePassOptions {
  /** 0 keeps the corners, 1 makes them black. Default 0.8. */
  darkness?: number;
  /** Where darkening starts: 0 centre, 1 corner. Default 0.4. */
  radius?: number;
  /** Width of the falloff, in the same units. Default 0.6. */
  softness?: number;
}
/** Darkens towards the corners. The centre inside `radius` is unchanged. */
export function vignette(options: VignetteOptions = {}): ScreenEffect<{
  darkness: UniformNode<'f32'>;
  radius: UniformNode<'f32'>;
  softness: UniformNode<'f32'>;
}> {
  const darkness = param(options.darkness, 0.8, 'darkness'),
    radius = param(options.radius, 0.4, 'radius'),
    softness = param(options.softness, 0.6, 'softness'),
    c = inputColor(),
    d = screenUV.sub(0.5).length().mul(Math.SQRT2),
    shade = smoothstep(radius, radius.add(max(softness, 1e-4)), d)
      .mul(darkness)
      .saturate()
      .oneMinus();
  return preset('vignette', vec4(c.rgb.mul(shade), c.a), { darkness, radius, softness }, options);
}

/** Options of {@link rgbShift}. */
export interface RGBShiftOptions extends NodePassOptions {
  /** Offset of red and blue, in screen widths/heights (UV units). Default 0.005. */
  amount?: number;
  /** Direction in radians; 0 moves red right and blue left. Default 0. */
  angle?: number;
}
/** Shifts red and blue apart along one direction. */
export function rgbShift(options: RGBShiftOptions = {}): ScreenEffect<{
  amount: UniformNode<'f32'>;
  angle: UniformNode<'f32'>;
}> {
  const amount = param(options.amount, 0.005, 'amount'),
    angle = param(options.angle, 0, 'angle'),
    offset = vec2(angle.cos(), angle.sin()).mul(amount),
    c = inputColor();
  return preset(
    'rgbShift',
    vec4(inputColor(screenUV.sub(offset)).r, c.g, inputColor(screenUV.add(offset)).b, c.a),
    { amount, angle },
    options,
  );
}

/** Options of {@link chromaticAberration}. */
export interface ChromaticAberrationOptions extends NodePassOptions {
  /** Relative radial separation of red and blue, growing towards the edges. Default 0.01. */
  strength?: number;
}
/** Lens-style lateral chromatic aberration: red and blue scaled about the centre in opposite directions. */
export function chromaticAberration(
  options: ChromaticAberrationOptions = {},
): ScreenEffect<{ strength: UniformNode<'f32'> }> {
  const strength = param(options.strength, 0.01, 'strength'),
    d = screenUV.sub(0.5),
    c = inputColor();
  return preset(
    'chromaticAberration',
    vec4(inputColor(d.mul(strength.oneMinus()).add(0.5)).r, c.g, inputColor(d.mul(strength.add(1)).add(0.5)).b, c.a),
    { strength },
    options,
  );
}

/** Options of {@link pixelate}. */
export interface PixelateOptions extends NodePassOptions {
  /** Block size in pixels (whole pixels, at least 1). Default 8. */
  size?: number;
}
/** Square blocks of `size` pixels, each the input colour at the block's centre pixel. */
export function pixelate(options: PixelateOptions = {}): ScreenEffect<{ size: UniformNode<'f32'> }> {
  const size = param(options.size, 8, 'size'),
    s = max(floor(size), 1),
    centre = floor(screenCoordinate.div(s))
      .mul(s)
      .add(floor(s.mul(0.5)))
      .add(0.5);
  return preset(
    'pixelate',
    inputColor(clamp(centre, vec2(0.5), resolution.sub(0.5)).div(resolution)),
    { size },
    options,
  );
}

/** Options of {@link halftone}. */
export interface HalftoneOptions extends NodePassOptions {
  /** Screen cell size in pixels. Default 8. */
  size?: number;
  /** Screen angle in radians (green and blue screens are turned a further 60 and 30 degrees). Default 0.26 (15 degrees). */
  angle?: number;
  /** One luminance screen instead of three colour screens (fixed at construction). Default false. */
  greyscale?: boolean;
}
/** Print-style halftone: per channel, dots on rotated grids whose area follows the colour. */
export function halftone(options: HalftoneOptions = {}): ScreenEffect<{
  size: UniformNode<'f32'>;
  angle: UniformNode<'f32'>;
}> {
  const size = param(options.size, 8, 'size'),
    angle = param(options.angle, 0.26, 'angle'),
    c = inputColor(),
    channel = (turn: number, pick: (x: Node<'vec4f'>) => Node<'f32'>) => {
      const grid = cells(screenCoordinate, size, turn ? angle.add(turn) : angle);
      return ink(pick(inputColor(grid.centre.div(resolution))), grid.distance, size);
    };
  const rgb = options.greyscale
    ? vec3(channel(0, (x) => luma(x.rgb)))
    : vec3(
        channel(0, (x) => x.r),
        channel(Math.PI / 3, (x) => x.g),
        channel(Math.PI / 6, (x) => x.b),
      );
  return preset('halftone', vec4(rgb, c.a), { size, angle }, options);
}

/** Options of {@link dotScreen}. */
export interface DotScreenOptions extends NodePassOptions {
  /** Dot cell size in pixels. Default 6. */
  size?: number;
  /** Grid angle in radians. Default 0.785 (45 degrees). */
  angle?: number;
}
/** Black newspaper dots on white, sized by each pixel's darkness. */
export function dotScreen(options: DotScreenOptions = {}): ScreenEffect<{
  size: UniformNode<'f32'>;
  angle: UniformNode<'f32'>;
}> {
  const size = param(options.size, 6, 'size'),
    angle = param(options.angle, Math.PI / 4, 'angle'),
    c = inputColor(),
    grid = cells(screenCoordinate, size, angle);
  return preset(
    'dotScreen',
    vec4(vec3(ink(luma(c.rgb).oneMinus(), grid.distance, size).oneMinus()), c.a),
    { size, angle },
    options,
  );
}

/** Options of {@link sobel}. */
export interface SobelOptions extends NodePassOptions {
  /** Scale of the gradient magnitude before clamping to 0..1. Default 1. */
  strength?: number;
  /** 0 shows the edges white on black; 1 draws them black over the image. Default 0. */
  overlay?: number;
}
/**
 * Sobel edge detection on Rec. 709 luma: the 3x3 gradient magnitude
 * `sqrt(gx^2 + gy^2) * strength`, clamped; a step of luma `d` gives `4 d` next to the step.
 */
export function sobel(options: SobelOptions = {}): ScreenEffect<{
  strength: UniformNode<'f32'>;
  overlay: UniformNode<'f32'>;
}> {
  const strength = param(options.strength, 1, 'strength'),
    overlay = param(options.overlay, 0, 'overlay'),
    at = (x: number, y: number) => luma(inputColor(screenCoordinate.add(vec2(x, y)).div(resolution)).rgb),
    [tl, t, tr, l, r, bl, b, br] = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ].map(([x, y]) => at(x, y)),
    gx = tr
      .add(r.mul(2))
      .add(br)
      .sub(tl.add(l.mul(2)).add(bl)),
    gy = bl
      .add(b.mul(2))
      .add(br)
      .sub(tl.add(t.mul(2)).add(tr)),
    edge = saturate(sqrt(gx.mul(gx).add(gy.mul(gy))).mul(strength)),
    c = inputColor();
  return preset(
    'sobel',
    vec4(mix(vec3(edge), c.rgb.mul(edge.oneMinus()), overlay), c.a),
    { strength, overlay },
    options,
  );
}

/** Options of {@link sepia}. */
export interface SepiaOptions extends NodePassOptions {
  /** 0 unchanged, 1 full sepia. Default 1. */
  amount?: number;
}
/** Sepia tone with the W3C Filter Effects `sepia()` matrix. */
export function sepia(options: SepiaOptions = {}): ScreenEffect<{ amount: UniformNode<'f32'> }> {
  const amount = param(options.amount, 1, 'amount'),
    c = inputColor(),
    m = mat3(0.393, 0.349, 0.272, 0.769, 0.686, 0.534, 0.189, 0.168, 0.131);
  return preset('sepia', vec4(mix(c.rgb, m.mul(c.rgb), amount), c.a), { amount }, options);
}

/** Options of {@link posterize}. */
export interface PosterizeOptions extends NodePassOptions {
  /** Values per channel (at least 2). Default 4. */
  levels?: number;
}
/** Rounds each channel to `levels` evenly spaced values, 0 and 1 included. */
export function posterize(options: PosterizeOptions = {}): ScreenEffect<{ levels: UniformNode<'f32'> }> {
  const levels = param(options.levels, 4, 'levels'),
    n = max(floor(levels), 2).sub(1),
    c = inputColor();
  return preset('posterize', vec4(floor(c.rgb.mul(n).add(0.5)).div(n), c.a), { levels }, options);
}
