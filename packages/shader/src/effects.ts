// Ready-made screen effects for a PostStack. Each preset composes one colour node from `inputColor` reads and live
// f32 uniforms and hands it to a NodePass: changing a uniform re-uploads it and never recompiles. Pixel maths uses
// fragment coordinates (centres at i + 0.5, origin top left) so texel-exact reads land on texel centres.
import { NodePass, inputColor, type NodePassOptions } from './post.js';
import {
  type Node,
  type UniformNode,
  clamp,
  mat3,
  max,
  mix,
  resolution,
  screenCoordinate,
  screenUV,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from './node.js';

/**
 * A ready-made PostStack effect: a {@link NodePass} whose live parameters are named f32 uniforms. Assign
 * `effect.uniforms.<name>.value` at any time; that only re-uploads the value, it never rebuilds a shader or pipeline.
 */
export type ScreenEffect<U extends Record<string, UniformNode<'f32'>>> = NodePass & { readonly uniforms: U };

type F32 = UniformNode<'f32'>;

/** One counter for every preset's default name, `shader:<preset>:<n>`. */
let made = 0;

/** A live f32 uniform for option `key`, or `fallback` when the option is undefined. */
function param(options: object, key: string, fallback: number): F32 {
  const value = (options as Record<string, unknown>)[key];
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))
    throw new RangeError(`Screen effect ${key} must be a finite number`);
  return uniform((value as number | undefined) ?? fallback, { name: key });
}

/** Wraps `rgb` (with the input's own alpha) in a NodePass carrying `uniforms`. */
function finish<U extends Record<string, F32>>(
  preset: string,
  options: NodePassOptions,
  rgb: Node<'vec3f'>,
  uniforms: U,
): ScreenEffect<U> {
  const pass = new NodePass(vec4(rgb, inputColor().a), {
    kind: options.kind,
    name: options.name ?? `shader:${preset}:${made++}`,
  });
  return Object.assign(pass, { uniforms }) as ScreenEffect<U>;
}

/** Rec. 709 luma (ITU-R BT.709-6, item 3.2) of an rgb node. */
const luma = (rgb: Node<'vec3f'>): Node<'f32'> => rgb.dot(vec3(0.2126, 0.7152, 0.0722));

/** Bilinear input read at a pixel coordinate (texel centres at i + 0.5). */
const atPixel = (p: Node<'vec2f'>): Node<'vec4f'> => inputColor(p.div(resolution));

/** Rotates `p` by the angle whose cosine and sine are `c` and `s`. */
const turn = (p: Node<'vec2f'>, c: Node<'f32'>, s: Node<'f32'>): Node<'vec2f'> =>
  vec2(c.mul(p.x).sub(s.mul(p.y)), s.mul(p.x).add(c.mul(p.y)));

/**
 * One rotated dot screen: a grid of `size`-pixel square cells turned by `angle` about the pixel origin. `value` gets
 * the cell centre in screen pixels and returns the 0..1 amount of ink for the pixel's cell; the dot's area follows it
 * (radius `sqrt(v) * size / sqrt(2)`, so 1 covers the cell). Returns this pixel's ink coverage, antialiased with a
 * 1 px linear ramp at the dot edge.
 */
function screen(size: F32, angle: Node<'f32'>, value: (centre: Node<'vec2f'>) => Node<'f32'>): Node<'f32'> {
  const c = angle.cos(),
    s = angle.sin(),
    // Into grid space (rotate by -angle), find the cell, and its centre back in screen pixels.
    q = turn(screenCoordinate, c, s.negate()),
    centre = q.div(size).floor().add(0.5).mul(size),
    radius = sqrt(value(turn(centre, c, s)).saturate()).mul(size.mul(Math.SQRT1_2)),
    edge = radius.sub(q.distance(centre)).add(0.5).saturate();
  // Dots under half a pixel in radius fade with their size instead of flickering in and out.
  return edge.mul(radius.mul(2).saturate());
}

/** Options for {@link vignette}. */
export interface VignetteOptions extends NodePassOptions {
  /** How much the corners darken: rgb is multiplied by `1 - darkness` there. Default 0.8. */
  darkness?: number;
  /** Distance from the centre where darkening starts, 0 at the centre and 1 at the corners. Default 0.4. */
  radius?: number;
  /** Width of the smooth ramp from no darkening to full darkening, same units as `radius`. Default 0.6. */
  softness?: number;
}

/**
 * Darkens towards the screen corners. Distance from the centre is measured in UV units scaled so the corners are 1
 * (not aspect-corrected, so the falloff is an ellipse on non-square screens); pixels inside `radius` are unchanged and
 * the darkening rises with a smoothstep over `softness`. The result is clamped to 0..1.
 * The parameterisation and its defaults are a Margo design choice.
 * @throws RangeError when a given option is not a finite number.
 */
export function vignette(options: VignetteOptions = {}): ScreenEffect<{
  darkness: UniformNode<'f32'>;
  radius: UniformNode<'f32'>;
  softness: UniformNode<'f32'>;
}> {
  const darkness = param(options, 'darkness', 0.8),
    radius = param(options, 'radius', 0.4),
    softness = param(options, 'softness', 0.6),
    d = screenUV.sub(0.5).length().mul(Math.SQRT2),
    // A softness floor keeps smoothstep's edges apart (equal edges are undefined in WGSL).
    ramp = smoothstep(radius, radius.add(max(softness, 1e-5)), d),
    rgb = inputColor().rgb.mul(ramp.mul(darkness).oneMinus()).saturate();
  return finish('vignette', options, rgb, { darkness, radius, softness });
}

/** Options for {@link rgbShift}. */
export interface RGBShiftOptions extends NodePassOptions {
  /** Offset of the red and blue images in UV units. Default 0.002: one five-hundredth of the screen, a fringe of about 4 px at 1920 wide (2 px at 960), visible as lens fringe without doubling edges. */
  amount?: number;
  /** Direction of the offset in radians; 0 moves red right and blue left, positive turns towards screen-down. Default 0. */
  angle?: number;
}

/**
 * Colour fringe: red is read `amount` UV units behind along `angle` and blue the same distance ahead, so the red
 * image moves along the direction and the blue image against it; green and alpha are the pixel's own.
 * @throws RangeError when a given option is not a finite number.
 */
export function rgbShift(options: RGBShiftOptions = {}): ScreenEffect<{
  amount: UniformNode<'f32'>;
  angle: UniformNode<'f32'>;
}> {
  const amount = param(options, 'amount', 0.002),
    angle = param(options, 'angle', 0),
    offset = vec2(angle.cos(), angle.sin()).mul(amount),
    rgb = vec3(inputColor(screenUV.sub(offset)).r, inputColor().g, inputColor(screenUV.add(offset)).b);
  return finish('rgbShift', options, rgb, { amount, angle });
}

/** Options for {@link chromaticAberration}. */
export interface ChromaticAberrationOptions extends NodePassOptions {
  /** Red is scaled about the centre by `1 - strength` and blue by `1 + strength`. Default 0.01. */
  strength?: number;
}

/**
 * Lateral chromatic aberration: red and blue are read from the image scaled about the screen centre by
 * `1 - strength` and `1 + strength`, so the fringes grow towards the edges and the centre stays sharp.
 * @throws RangeError when `strength` is given and is not a finite number.
 */
export function chromaticAberration(
  options: ChromaticAberrationOptions = {},
): ScreenEffect<{ strength: UniformNode<'f32'> }> {
  const strength = param(options, 'strength', 0.01),
    d = screenUV.sub(0.5),
    rgb = vec3(
      inputColor(d.mul(strength.oneMinus()).add(0.5)).r,
      inputColor().g,
      inputColor(d.mul(strength.add(1)).add(0.5)).b,
    );
  return finish('chromaticAberration', options, rgb, { strength });
}

/** Options for {@link pixelate}. */
export interface PixelateOptions extends NodePassOptions {
  /** Block size in pixels, floored, at least 1. Default 8. */
  size?: number;
}

/**
 * Block mosaic: square blocks of `size` pixels from the top left corner, each filled with the exact input pixel at
 * its centre (offset `floor(size / 2)`, kept on screen for partial blocks at the right and bottom).
 * @throws RangeError when `size` is given and is not a finite number.
 */
export function pixelate(options: PixelateOptions = {}): ScreenEffect<{ size: UniformNode<'f32'> }> {
  const size = param(options, 'size', 8),
    s = max(size.floor(), 1),
    origin = screenCoordinate.div(s).floor().mul(s),
    texel = clamp(origin.add(s.mul(0.5).floor()).add(0.5), vec2(0.5), resolution.sub(0.5));
  return finish('pixelate', options, atPixel(texel).rgb, { size });
}

/** Options for {@link halftone}. */
export interface HalftoneOptions extends NodePassOptions {
  /** Cell size in pixels. Default 8. */
  size?: number;
  /** Red screen angle in radians; green is 60 degrees on and blue 30 degrees on. Default 15 degrees (about 0.26). */
  angle?: number;
  /** One screen on the luma instead of three colour screens; read at construction. Default false. */
  greyscale?: boolean;
}

/**
 * Print-style colour halftone: one rotated dot screen per channel (red at `angle`, green at `angle + 60` degrees,
 * blue at `angle + 30` degrees: the conventional 15/75/45 degree screen set by default). Each cell reads the input once
 * at its centre and draws one dot whose area follows that channel, giving coloured dots on black. `greyscale` uses a
 * single screen on the Rec. 709 luma for all three channels.
 * @throws RangeError when a given numeric option is not a finite number.
 */
export function halftone(options: HalftoneOptions = {}): ScreenEffect<{
  size: UniformNode<'f32'>;
  angle: UniformNode<'f32'>;
}> {
  const size = param(options, 'size', 8),
    angle = param(options, 'angle', Math.PI / 12),
    rgb = options.greyscale
      ? vec3(screen(size, angle, (p) => luma(atPixel(p).rgb)))
      : vec3(
          screen(size, angle, (p) => atPixel(p).r),
          screen(size, angle.add(Math.PI / 3), (p) => atPixel(p).g),
          screen(size, angle.add(Math.PI / 6), (p) => atPixel(p).b),
        );
  return finish('halftone', options, rgb, { size, angle });
}

/** Options for {@link dotScreen}. */
export interface DotScreenOptions extends NodePassOptions {
  /** Cell size in pixels. Default 6. */
  size?: number;
  /** Screen angle in radians. Default pi/4. */
  angle?: number;
}

/**
 * Newspaper look: black dots on white from one rotated screen, each dot's area following the darkness (1 - Rec. 709
 * luma) of the pixel's own input colour.
 * @throws RangeError when a given option is not a finite number.
 */
export function dotScreen(options: DotScreenOptions = {}): ScreenEffect<{
  size: UniformNode<'f32'>;
  angle: UniformNode<'f32'>;
}> {
  const size = param(options, 'size', 6),
    angle = param(options, 'angle', Math.PI / 4),
    ink = luma(inputColor().rgb).oneMinus(),
    rgb = vec3(screen(size, angle, () => ink).oneMinus());
  return finish('dotScreen', options, rgb, { size, angle });
}

/** Options for {@link sobel}. */
export interface SobelOptions extends NodePassOptions {
  /** Gradient magnitude scale before clamping to 0..1. Default 1. */
  strength?: number;
  /** 0 shows white edges on black; 1 draws black edges over the image. Default 0. */
  overlay?: number;
}

/**
 * Edge detection with the Sobel operator (3x3, weights 1, 2, 1) on Rec. 709 luma, reading the eight neighbours
 * exactly at their texel centres. `edge = clamp(sqrt(gx^2 + gy^2) * strength, 0, 1)`; the output mixes the grey edge
 * image with the input darkened by the edge, by `overlay`.
 * @throws RangeError when a given option is not a finite number.
 */
export function sobel(options: SobelOptions = {}): ScreenEffect<{
  strength: UniformNode<'f32'>;
  overlay: UniformNode<'f32'>;
}> {
  const strength = param(options, 'strength', 1),
    overlay = param(options, 'overlay', 0),
    at = (dx: number, dy: number) => luma(atPixel(screenCoordinate.add(vec2(dx, dy))).rgb),
    [tl, t, tr, l, r, bl, b, br] = [
      at(-1, -1),
      at(0, -1),
      at(1, -1),
      at(-1, 0),
      at(1, 0),
      at(-1, 1),
      at(0, 1),
      at(1, 1),
    ],
    gx = tr
      .add(r.mul(2))
      .add(br)
      .sub(tl.add(l.mul(2)).add(bl)),
    gy = bl
      .add(b.mul(2))
      .add(br)
      .sub(tl.add(t.mul(2)).add(tr)),
    edge = sqrt(gx.mul(gx).add(gy.mul(gy)))
      .mul(strength)
      .saturate(),
    rgb = mix(vec3(edge), inputColor().rgb.mul(edge.oneMinus()), overlay);
  return finish('sobel', options, rgb, { strength, overlay });
}

/** Options for {@link sepia}. */
export interface SepiaOptions extends NodePassOptions {
  /** Blend from the input (0) to full sepia (1); not clamped, so larger values extrapolate. Default 1. */
  amount?: number;
}

/**
 * Sepia tone with the matrix of the W3C Filter Effects Module Level 1 `sepia()` function, blended with the input by
 * `amount`. Not clamped in the shader; an LDR target clamps on write.
 * @throws RangeError when `amount` is given and is not a finite number.
 */
export function sepia(options: SepiaOptions = {}): ScreenEffect<{ amount: UniformNode<'f32'> }> {
  const amount = param(options, 'amount', 1),
    // Column-major: column k holds what input channel k adds to R', G', B'.
    tone = mat3(0.393, 0.349, 0.272, 0.769, 0.686, 0.534, 0.189, 0.168, 0.131),
    c = inputColor().rgb;
  return finish('sepia', options, mix(c, tone.mul(c), amount), { amount });
}

/** Options for {@link posterize}. */
export interface PosterizeOptions extends NodePassOptions {
  /** Levels per channel, floored, at least 2. Default 4. */
  levels?: number;
}

/**
 * Reduces each channel to `levels` evenly spaced values from 0 to 1, rounding half up.
 * @throws RangeError when `levels` is given and is not a finite number.
 */
export function posterize(options: PosterizeOptions = {}): ScreenEffect<{ levels: UniformNode<'f32'> }> {
  const levels = param(options, 'levels', 4),
    steps = max(levels.floor(), 2).sub(1),
    rgb = inputColor().rgb.mul(steps).add(0.5).floor().div(steps);
  return finish('posterize', options, rgb, { levels });
}
