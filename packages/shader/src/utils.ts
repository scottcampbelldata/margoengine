// Ready-made nodes for what graphs keep rewriting: normal and bump mapping, triplanar and parallax lookups, UV helpers,
// colour adjustments, blend modes, remapping and oscillators. Each is plain nodes, so unused ones tree-shake and the WGSL
// stays readable. Sources: Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU" (2010); Schuler, "Followup: Normal
// Mapping Without Precomputed Tangents" (2013); W3C Compositing and Blending Level 1 (blend modes); Rec. 709 (luminance).
import {
  Node,
  acos,
  atan2,
  bitangentWorld,
  builtin,
  cast,
  clamp,
  cos,
  cross,
  div,
  dot,
  dpdx,
  dpdy,
  fract,
  max,
  min,
  mix,
  mul,
  add,
  normalView,
  normalWorld,
  normalize,
  positionView,
  positionWorld,
  select,
  sin,
  sqrt,
  step,
  sub,
  tangentWorld,
  time,
  uv,
  vec2,
  vec3,
  viewDirection,
  type NodeInput,
  type ScalarOf,
  type Type,
} from './node.js';
import { Break, If, Let, Loop, Var, block } from './control.js';
import { texture, type BindableTexture } from './texture.js';
import { cotangentFrameShader } from '../../shared/tangent-frame.js';

/** Where a tangent frame comes from: the surface's screen derivatives, or the mesh's own tangents. */
export type TangentFrame = 'derivatives' | 'tangents';
/** Options of {@link normalMap}. */
export interface NormalMapOptions {
  /** Scales the map's x and y, as glTF's normal scale does (default 1). */
  strength?: NodeInput<'f32'>;
  /**
   * `'derivatives'` (default) works on any mesh and follows `coord`. `'tangents'` reads the mesh's tangents, which
   * `computeTangents` from `@margoengine/geometry` makes; a mesh without them gets a fixed frame.
   */
  frame?: TangentFrame;
  /** The UV the map is read with, for the `'derivatives'` frame (default `uv()`). */
  coord?: NodeInput<'vec2f'>;
  /**
   * True (default) for a `Texture` on a mesh with its UV origin at the bottom left, which is what `@margoengine/geometry`
   * makes. False for UVs from a glTF file, with the origin at the top left. The `'tangents'` frame ignores it.
   */
  flipY?: boolean;
}
/** Options of {@link bumpNormal}. */
export interface BumpOptions {
  /** Scales the height (default 1). */
  strength?: NodeInput<'f32'>;
  /** The normal to tilt, in world space (default the surface's, facing the viewer). */
  normal?: Node<'vec3f'>;
}
/** Options of {@link triplanar}. */
export interface TriplanarOptions {
  /** Where to project from (default `positionWorld`; `positionLocal` sticks the pattern to the object). */
  position?: Node<'vec3f'>;
  /** The normal that picks the projections, in the same space as `position` (default `normalWorld`). */
  normal?: Node<'vec3f'>;
  /** Tiles per unit of `position` (default 1). */
  scale?: NodeInput<'f32'>;
  /** Higher values narrow the seams between projections (default 4). */
  sharpness?: NodeInput<'f32'>;
}
/** Options of {@link parallaxUV}. */
export interface ParallaxOptions {
  /** The UV to start from (default `uv()`). */
  coord?: NodeInput<'vec2f'>;
  /** How deep height 0 lies under height 1, in UV units (default 0.05). */
  scale?: NodeInput<'f32'>;
  /** Layers to march. 1 is a single offset with no search; more finds the true surface (default 16). */
  steps?: number;
  /** As in {@link NormalMapOptions.frame}. */
  frame?: TangentFrame;
}
/** Options of {@link equirectUV}. */
export interface EquirectOptions {
  /** True (default) for a `Texture`, whose rows are stored flipped: the top of the image is v = 1. */
  flipY?: boolean;
}

/** The normal facing the viewer, the one a double-sided surface shades with. */
const facing = (): Node<'vec3f'> => select(builtin('frontFacing', 'bool'), normalWorld, normalWorld.negate());
/** Columns: unit gradient of u, unit gradient of -v, the normal. */
function derivativeFrame(n: Node<'vec3f'>, coord: Node<'vec2f'>): Node<'mat3x3f'> {
  const p = positionWorld;
  return new Node('mat3x3f', 'zcotangent', [n, dpdx(p), dpdy(p), dpdx(coord), dpdy(coord)], (b, x) => {
    b.declare('utils:cotangent', cotangentFrameShader.replace('margoCotangentFrame', 'nodeCotangentFrame'));
    return `nodeCotangentFrame(${x.args.map((a) => b.expr(a)).join(', ')})`;
  });
}
/** The surface's tangent, bitangent and normal, with the bitangent along increasing v when `up` is true. */
function frameOf(
  frame: TangentFrame | undefined,
  coord: Node<'vec2f'>,
  up: boolean,
): [Node<'vec3f'>, Node<'vec3f'>, Node<'vec3f'>] {
  if (frame !== undefined && frame !== 'derivatives' && frame !== 'tangents')
    throw new TypeError(`Tangent frame must be 'derivatives' or 'tangents', got ${String(frame)}`);
  const n = facing();
  if (frame === 'tangents') return [tangentWorld, bitangentWorld, n];
  const m = derivativeFrame(n, coord),
    bitangent = m.element(1) as Node<'vec3f'>;
  return [m.element(0) as Node<'vec3f'>, up ? bitangent.negate() : bitangent, n];
}

/**
 * A `normalNode` from a tangent-space normal map: `normalNode: normalMap(texture(map).rgb)`. The value is the map's colour,
 * 0 to 1, so load the map with `{colorSpace: 'linear'}`.
 */
export function normalMap(value: Node<'vec3f'>, options: NormalMapOptions = {}): Node<'vec3f'> {
  const { strength = 1, frame, coord = uv(), flipY = true } = options,
    [t, b, n] = frameOf(frame, cast(coord, 'vec2f', 'normalMap coord'), flipY),
    m = cast(value, 'vec3f', 'normalMap value').mul(2).sub(1),
    xy = m.xy.mul(cast(strength, 'f32', 'normalMap strength'));
  return normalize(t.mul(xy.x).add(b.mul(xy.y)).add(n.mul(m.z)));
}
/** A `normalNode` that tilts the surface along a height in world units, from its screen derivatives. Works on any mesh. */
export function bumpNormal(height: NodeInput<'f32'>, options: BumpOptions = {}): Node<'vec3f'> {
  const { strength = 1, normal = facing() } = options,
    h = cast(height, 'f32', 'bumpNormal height').mul(cast(strength, 'f32', 'bumpNormal strength')),
    dp1 = dpdx(positionWorld),
    dp2 = dpdy(positionWorld),
    r1 = cross(dp2, normal),
    r2 = cross(normal, dp1),
    det = dot(dp1, r1),
    side = select<'f32'>(det.lessThan(0), -1, 1),
    gradient = r1.mul(dpdx(h)).add(r2.mul(dpdy(h))).mul(side);
  return normalize(normal.mul(det.abs()).sub(gradient));
}
/**
 * Three planar projections blended by the normal, for surfaces with no usable UVs: rock, terrain, anything sculpted. `map`
 * is a `Texture` or a function of the UV, so noise works too.
 */
export function triplanar(
  map: BindableTexture | ((coord: Node<'vec2f'>) => Node<'vec4f'>),
  options: TriplanarOptions = {},
): Node<'vec4f'> {
  const { position = positionWorld, normal = normalWorld, scale = 1, sharpness = 4 } = options,
    read = typeof map === 'function' ? map : (coord: Node<'vec2f'>) => texture(map, coord),
    p = cast(position, 'vec3f', 'triplanar position').mul(cast(scale, 'f32', 'triplanar scale')),
    w = cast(normal, 'vec3f', 'triplanar normal').abs().pow(cast(sharpness, 'f32', 'triplanar sharpness')),
    weights = w.div(w.x.add(w.y).add(w.z));
  return read(p.zy).mul(weights.x).add(read(p.xz).mul(weights.y)).add(read(p.xy).mul(weights.z));
}
/**
 * The UV where a line of sight meets a height field under the surface, so a flat mesh looks carved: read every map of the
 * surface with it. `height` is a `Texture` (red channel) or a function of the UV giving 1 at the surface and 0 at the
 * deepest; a function must read textures with an explicit level, because the search branches per pixel.
 */
export function parallaxUV(
  height: BindableTexture | ((coord: Node<'vec2f'>) => Node<'f32'>),
  options: ParallaxOptions = {},
): Node<'vec2f'> {
  const { coord = uv(), scale = 0.05, steps = 16, frame } = options;
  if (!Number.isInteger(steps) || steps < 1 || steps > 256)
    throw new RangeError(`parallaxUV steps must be a whole number from 1 to 256, got ${String(steps)}`);
  const start = cast(coord, 'vec2f', 'parallaxUV coord'),
    read = typeof height === 'function' ? height : (q: Node<'vec2f'>) => texture(height, q, 0).r,
    [t, b, n] = frameOf(frame, start, true),
    // The way to the camera in the surface's frame; grazing views are held at 0.1 so the shift stays bounded.
    across = vec2(dot(viewDirection, t), dot(viewDirection, b))
      .div(max(dot(viewDirection, n), 0.1))
      .mul(cast(scale, 'f32', 'parallaxUV scale'));
  if (steps === 1) return start.sub(across.mul(read(start).oneMinus()));
  return block(() => {
    // Worked out before the loop: its derivatives need uniform control flow, and the search branches per pixel.
    const shift = Let(across),
      depth = Var(0),
      before = Var(0),
      place = Var(start),
      last = Var(start),
      gap = Var(read(start).oneMinus()),
      gapBefore = Var(gap);
    // March down until the line of sight is under the height field, then cut the last layer where the two lines cross.
    Loop(steps, () => {
      If(depth.greaterThanEqual(gap), () => Break());
      last.assign(place);
      before.assign(depth);
      gapBefore.assign(gap);
      depth.addAssign(1 / steps);
      place.assign(start.sub(shift.mul(depth)));
      gap.assign(read(place).oneMinus());
    });
    const above = gapBefore.sub(before),
      span = above.add(depth.sub(gap));
    return mix(last, place, select<'f32'>(span.lessThan(1e-6), 1, above.div(span).saturate()));
  });
}
/** `coord` turned by `angle` radians, anticlockwise, around `center` (default the middle of the texture). */
export function rotateUV(
  coord: NodeInput<'vec2f'>,
  angle: NodeInput<'f32'>,
  center: NodeInput<'vec2f'> = 0.5,
): Node<'vec2f'> {
  const a = cast(angle, 'f32', 'rotateUV angle'),
    c = cast(center, 'vec2f', 'rotateUV center'),
    p = cast(coord, 'vec2f', 'rotateUV coord').sub(c),
    s = sin(a),
    k = cos(a);
  return vec2(p.x.mul(k).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(k))).add(c);
}
/** `v` turned by `angle` radians around the unit vector `axis`, by the right-hand rule (Rodrigues' formula). */
export function rotateAxis(v: Node<'vec3f'>, axis: NodeInput<'vec3f'>, angle: NodeInput<'f32'>): Node<'vec3f'> {
  const a = cast(angle, 'f32', 'rotateAxis angle'),
    k = cast(axis, 'vec3f', 'rotateAxis axis'),
    p = cast(v, 'vec3f', 'rotateAxis value'),
    c = cos(a);
  return p
    .mul(c)
    .add(cross(k, p).mul(sin(a)))
    .add(k.mul(dot(k, p)).mul(c.oneMinus()));
}
/** Where a matcap image is read for this surface, as `MatcapMaterial` reads it: `texture(matcap, matcapUV())`. */
export function matcapUV(normal: Node<'vec3f'> = normalView, position: Node<'vec3f'> = positionView): Node<'vec2f'> {
  const eye = normalize(cast(position, 'vec3f', 'matcapUV position').negate()),
    n = cast(normal, 'vec3f', 'matcapUV normal'),
    side = vec3(eye.z, 0, eye.x.negate()),
    length2 = dot(side, side),
    level = length2.greaterThan(1e-10),
    right = select<'vec3f'>(level, side.mul(max(length2, 1e-10).inverseSqrt()), vec3(1, 0, 0)),
    up = select<'vec3f'>(level, cross(eye, right), vec3(0, 1, 0));
  return vec2(dot(n, right), dot(n, up)).mul(0.49).add(0.5);
}
/**
 * Where a unit direction falls in a panorama, as `@margoengine/environment` lays one out: the middle of the image faces -z
 * and +x is to its right. The image's left and right edges meet at +z, so read it with an explicit level or no mipmaps.
 */
export function equirectUV(direction: NodeInput<'vec3f'>, options: EquirectOptions = {}): Node<'vec2f'> {
  const d = cast(direction, 'vec3f', 'equirectUV direction'),
    // Some implementations return PI for atan2(-0.0, x > 0), so a zero is always +0.0; atan2(0, 0) has no set value, so a
    // pole reads the middle column.
    x = select<'f32'>(d.x.equal(0), 0, d.x),
    z = select<'f32'>(d.z.equal(0), select<'f32'>(d.x.equal(0), 1, 0), d.z.negate()),
    v = acos(clamp(d.y, -1, 1)).div(Math.PI);
  return vec2(atan2(x, z).div(Math.PI * 2).add(0.5), (options.flipY ?? true) ? v.oneMinus() : v);
}

/** Brightness of a linear colour, by the Rec. 709 weights. */
export const luminance = (rgb: Node<'vec3f'>): Node<'f32'> => dot(rgb, vec3(0.2126, 0.7152, 0.0722));
/** A colour with its saturation scaled: 0 is grey of the same luminance, 1 leaves it, more strengthens it. */
export const saturation = (rgb: Node<'vec3f'>, amount: NodeInput<'f32'>): Node<'vec3f'> =>
  mix(luminance(rgb).xxx, rgb, cast(amount, 'f32', 'saturation amount').xxx);
/** A colour with its hue turned by `angle` radians around the grey axis; red moves towards green. */
export const hue = (rgb: Node<'vec3f'>, angle: NodeInput<'f32'>): Node<'vec3f'> =>
  rotateAxis(rgb, vec3(Math.sqrt(1 / 3)), angle);

/** A blend of `top` over `base`, both colours 0 to 1; `opacity` fades the result back to `base` (default 1). */
export type BlendMode = (base: Node<'vec3f'>, top: NodeInput<'vec3f'>, opacity?: NodeInput<'f32'>) => Node<'vec3f'>;
const mode =
  (formula: (base: Node<'vec3f'>, top: Node<'vec3f'>) => Node<'vec3f'>): BlendMode =>
  (base, top, opacity = 1) => {
    const b = cast(base, 'vec3f', 'blend base'),
      value = formula(b, cast(top, 'vec3f', 'blend top'));
    return opacity === 1 ? value : mix(b, value, cast(opacity, 'f32', 'blend opacity').xxx);
  };
const hard = (b: Node<'vec3f'>, t: Node<'vec3f'>): Node<'vec3f'> => {
  const high = t.mul(2).sub(1);
  return select<'vec3f'>(t.lessThanEqual(0.5), t.mul(2).mul(b), b.add(high).sub(b.mul(high)));
};
/** The W3C separable blend modes and plain add and subtract, each a {@link BlendMode}. */
export const blendAdd = /*@__PURE__*/ mode((b, t) => min(b.add(t), 1)),
  blendSubtract = /*@__PURE__*/ mode((b, t) => max(b.sub(t), 0)),
  blendMultiply = /*@__PURE__*/ mode((b, t) => b.mul(t)),
  blendScreen = /*@__PURE__*/ mode((b, t) => b.add(t).sub(b.mul(t))),
  blendOverlay = /*@__PURE__*/ mode((b, t) => hard(t, b)),
  blendHardLight = /*@__PURE__*/ mode(hard),
  blendDarken = /*@__PURE__*/ mode((b, t) => min(b, t)),
  blendLighten = /*@__PURE__*/ mode((b, t) => max(b, t)),
  blendDifference = /*@__PURE__*/ mode((b, t) => b.sub(t).abs()),
  blendExclusion = /*@__PURE__*/ mode((b, t) => b.add(t).sub(b.mul(t).mul(2))),
  blendDodge = /*@__PURE__*/ mode((b, t) =>
    select<'vec3f'>(
      b.lessThanEqual(0),
      vec3(0),
      select<'vec3f'>(t.greaterThanEqual(1), vec3(1), min(b.div(max(t.oneMinus(), 1e-6)), 1)),
    ),
  ),
  blendBurn = /*@__PURE__*/ mode((b, t) =>
    select<'vec3f'>(
      b.greaterThanEqual(1),
      vec3(1),
      select<'vec3f'>(t.lessThanEqual(0), vec3(0), min(b.oneMinus().div(max(t, 1e-6)), 1).oneMinus()),
    ),
  ),
  blendSoftLight = /*@__PURE__*/ mode((b, t) => {
    const curve = select<'vec3f'>(b.lessThanEqual(0.25), b.mul(16).sub(12).mul(b).add(4).mul(b), sqrt(b)),
      darker = b.sub(t.mul(-2).add(1).mul(b).mul(b.oneMinus())),
      lighter = b.add(t.mul(2).sub(1).mul(curve.sub(b)));
    return select<'vec3f'>(t.lessThanEqual(0.5), darker, lighter);
  });

// Plain signatures: the operators' result types over an open T make the compiler expand every swizzle of every type.
type Operator = (a: unknown, b: unknown) => Node;
const plus = add as unknown as Operator,
  minus = sub as unknown as Operator,
  times = mul as unknown as Operator,
  over = div as unknown as Operator;
const ratio = (value: unknown, low: unknown, high: unknown): Node => over(minus(value, low), minus(high, low));
const spread = (share: Node, low: unknown, high: unknown): unknown => plus(times(share, minus(high, low)), low);
/** `value` taken from the range `inLow..inHigh` to `outLow..outHigh`, unclamped. `inLow` and `inHigh` must differ. */
export function remap<T extends Type>(
  value: Node<T>,
  inLow: NodeInput<T> | NodeInput<ScalarOf<T>>,
  inHigh: NodeInput<T> | NodeInput<ScalarOf<T>>,
  outLow: NodeInput<T> | NodeInput<ScalarOf<T>> = 0,
  outHigh: NodeInput<T> | NodeInput<ScalarOf<T>> = 1,
): Node<T> {
  return spread(ratio(value, inLow, inHigh), outLow, outHigh) as Node<T>;
}
/** {@link remap}, with the result held between `outLow` and `outHigh`. */
export function remapClamp<T extends Type>(
  value: Node<T>,
  inLow: NodeInput<T> | NodeInput<ScalarOf<T>>,
  inHigh: NodeInput<T> | NodeInput<ScalarOf<T>>,
  outLow: NodeInput<T> | NodeInput<ScalarOf<T>> = 0,
  outHigh: NodeInput<T> | NodeInput<ScalarOf<T>> = 1,
): Node<T> {
  return spread(ratio(value, inLow, inHigh).saturate(), outLow, outHigh) as Node<T>;
}

/** A wave from 0 to 1 and back, one period per unit of `t`, rising through 0.5 at t = 0 (default `time`, so one per second). */
export const oscSine = (t: NodeInput<'f32'> = time): Node<'f32'> =>
  sin(cast(t, 'f32', 'oscSine time').mul(Math.PI * 2))
    .mul(0.5)
    .add(0.5);
/** 1 for the first half of each period, then 0. */
export const oscSquare = (t: NodeInput<'f32'> = time): Node<'f32'> =>
  step(0.5, fract(cast(t, 'f32', 'oscSquare time'))).oneMinus();
/** 0 at the start of each period, 1 half way, 0 at the end. */
export const oscTriangle = (t: NodeInput<'f32'> = time): Node<'f32'> =>
  fract(cast(t, 'f32', 'oscTriangle time')).mul(2).sub(1).abs().oneMinus();
/** Climbs from 0 to 1 over each period, then drops. */
export const oscSawtooth = (t: NodeInput<'f32'> = time): Node<'f32'> => fract(cast(t, 'f32', 'oscSawtooth time'));
