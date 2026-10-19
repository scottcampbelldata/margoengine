// Crocotile-style lighting and ambient occlusion baked into vertex colours, on the CPU against an occluder BVH.
import type { ColorInput, Vec3 } from '@margoengine/math';
import { LinearToSRGB, parseColor } from '@margoengine/math/color';
import { createRandom } from '@margoengine/math/mathutils';
import { finiteVector } from '@margoengine/math/validate';
import type { MeshBVH } from './bvh.js';

/**
 * A light for {@link bakeVertexColors}. Falloff is the definition Margo's GPU lights share: directional
 * `color * intensity * max(N.L, 0)`; point and spot multiply that by `window / max(d^decay, 0.01)` with
 * `window = distance > 0 ? clamp(1 - (d / distance)^4, 0, 1)^2 : 1` (Karis 2013), and spot also by
 * `smoothstep(cos(angle), cos(angle * (1 - penumbra)), dot(-L, direction))` (a hard edge when `penumbra` is 0).
 * Ambient adds `color * intensity` everywhere, unshadowed.
 */
export interface BakeLight {
  type: 'ambient' | 'directional' | 'point' | 'spot';
  /** Default white. `'#rrggbb'`/`0xrrggbb` are sRGB, `[r, g, b]` linear. */
  color?: ColorInput;
  /** Default 1, >= 0. */
  intensity?: number;
  /** Directional: the direction toward the light (as core's light). Spot: the way the cone points. Need not be unit. */
  direction?: Vec3;
  /** Point and spot: world position. */
  position?: Vec3;
  /** Point and spot: range in world units; 0 (default) is unlimited. */
  distance?: number;
  /** Point and spot: distance exponent. Default 2. */
  decay?: number;
  /** Spot: cone half-angle in radians, (0, pi / 2]. Required for spots. */
  angle?: number;
  /** Spot: fraction of the cone that fades, 0..1. Default 0. */
  penumbra?: number;
  /** A hidden light is baked only with `includeHidden`. Default true. */
  visible?: boolean;
}

/** Ambient occlusion settings for {@link bakeVertexColors}. */
export interface BakeAmbientOcclusion {
  /** How dark full occlusion gets, 0..1. Default 1. */
  strength?: number;
  /** Rays cast per vertex, all in the hemisphere above the normal (cosine weighted). Default 32. */
  rays?: number;
  /** Hits farther than this (world units) do not occlude. Default 1. */
  distance?: number;
}

/** Options for {@link bakeVertexColors}. */
export interface BakeOptions {
  /** Lights to bake. Omitted, the lighting term is 1, which makes an AO-only bake. */
  lights?: readonly BakeLight[];
  /** Cast occlusion rays toward each directional, point and spot light. Default true. */
  shadows?: boolean;
  /** Occluder back faces block rays. Default true; false lets light and AO rays through them. */
  backfaces?: boolean;
  /** Also bake lights with `visible: false`. Default false. */
  includeHidden?: boolean;
  /** Ambient occlusion; omitted, none. */
  ao?: BakeAmbientOcclusion;
  /** `'none'` (default) overwrites the colours; `'standard'` multiplies the bake onto the existing `colors`. */
  apply?: 'none' | 'standard';
  /** Scales the baked RGB (Crocotile's Vertex Color Multiplier). Default 1. */
  multiplier?: number;
  /** Seed for the AO ray directions: the same inputs and seed give the same colours. Default 0. */
  seed?: number;
  /** Ray origins move this far along the normal so a surface does not occlude itself. Default 1e-3 world units. */
  bias?: number;
}

/** Vertices to bake: xyz `positions` and `normals` in the occluder's space, optional existing RGB or RGBA `colors`. */
export interface BakeTarget {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  colors?: ArrayLike<number> | null;
}

const smoothstep = (low: number, high: number, x: number): number => {
  if (x < low) return 0;
  if (x >= high) return 1;
  const t = (x - low) / (high - low);
  return t * t * (3 - 2 * t);
};

/**
 * Bakes lighting and ambient occlusion into linear RGBA vertex colours (Crocotile's Bake Lighting panel): for each
 * vertex, the sum of `lights` (see {@link BakeLight} for the falloff), each directional, point or spot light
 * shadowed by a ray toward it when `shadows` is on, times the AO term `1 - strength * occludedRays / rays`, times
 * `multiplier`, and with `apply: 'standard'` times the existing colour. Alpha is the existing alpha, or 1. Rays test
 * `occluder` (null: nothing occludes), so a separate occluder set gives Crocotile's Cast Against. Use flat or smooth
 * normals from `creasedNormals` in `@margoengine/geometry`. A zero normal gets ambient light only and no AO.
 * Deterministic for a given `seed`; results are not clamped, so limit them with {@link limitPalette} if needed.
 */
export function bakeVertexColors(
  target: BakeTarget,
  occluder: MeshBVH | null,
  options: BakeOptions = {},
): Float32Array {
  const {
      lights,
      shadows = true,
      backfaces = true,
      includeHidden = false,
      ao,
      apply = 'none',
      multiplier = 1,
      seed = 0,
      bias = 1e-3,
    } = options,
    { positions: P, normals: N, colors: C } = target ?? ({} as BakeTarget),
    count = (P?.length ?? 0) / 3;
  if (!P || !N || !Number.isInteger(count) || N.length !== P.length)
    throw new RangeError('Bake target needs xyz positions and normals of the same length');
  const stride = !C ? 0 : C.length === count * 4 ? 4 : C.length === count * 3 ? 3 : -1;
  if (stride < 0) throw new RangeError('Bake target colors must be RGB or RGBA per vertex');
  if (apply !== 'none' && apply !== 'standard') throw new TypeError("Bake apply must be 'none' or 'standard'");
  if (!(multiplier >= 0 && multiplier < Infinity)) throw new RangeError('Bake multiplier must be finite and >= 0');
  if (!(bias >= 0 && bias < Infinity)) throw new RangeError('Bake bias must be finite and >= 0');
  const strength = ao?.strength ?? 1,
    rays = ao?.rays ?? 32,
    reach = ao?.distance ?? 1;
  if (ao && !(strength >= 0 && strength <= 1 && Number.isInteger(rays) && rays >= 1 && reach > 0 && reach < Infinity))
    throw new RangeError('Bake ao needs strength 0..1, an integer rays >= 1 and a finite distance > 0');
  const baked = (lights ?? []).filter((light) => includeHidden || light?.visible !== false).map(checkLight),
    side = backfaces ? 'double' : 'front',
    random = createRandom(seed),
    out = new Float32Array(count * 4),
    origin = [0, 0, 0],
    direction = [0, 0, 0],
    ray = { origin, direction };
  const blocked = (far: number): boolean => !!occluder && occluder.raycastFirst(ray, { far, side }) !== null;
  for (let i = 0; i < count; i++) {
    const px = P[i * 3],
      py = P[i * 3 + 1],
      pz = P[i * 3 + 2];
    let nx = N[i * 3],
      ny = N[i * 3 + 1],
      nz = N[i * 3 + 2];
    const nl = Math.hypot(nx, ny, nz);
    if (nl) {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    }
    origin[0] = px + nx * bias;
    origin[1] = py + ny * bias;
    origin[2] = pz + nz * bias;
    let r = lights ? 0 : 1,
      g = r,
      b = r;
    for (const light of baked) {
      let lx: number, ly: number, lz: number, scale: number, far: number;
      if (light.type === 'ambient') {
        r += light.rgb[0];
        g += light.rgb[1];
        b += light.rgb[2];
        continue;
      }
      if (light.type === 'directional') {
        [lx, ly, lz] = light.direction;
        scale = 1;
        far = Infinity;
      } else {
        lx = light.position[0] - px;
        ly = light.position[1] - py;
        lz = light.position[2] - pz;
        const d = Math.hypot(lx, ly, lz);
        if (!d) continue;
        lx /= d;
        ly /= d;
        lz /= d;
        const window = light.distance > 0 ? Math.min(Math.max(1 - (d / light.distance) ** 4, 0), 1) ** 2 : 1;
        scale = window / Math.max(d ** light.decay, 0.01);
        if (light.type === 'spot') {
          const [sx, sy, sz] = light.direction;
          scale *= smoothstep(
            Math.cos(light.angle),
            Math.cos(light.angle * (1 - light.penumbra)),
            -(lx * sx + ly * sy + lz * sz),
          );
        }
        far = Math.hypot(light.position[0] - origin[0], light.position[1] - origin[1], light.position[2] - origin[2]);
      }
      const lambert = nx * lx + ny * ly + nz * lz;
      if (!(lambert > 0 && scale > 0)) continue;
      direction[0] = lx;
      direction[1] = ly;
      direction[2] = lz;
      if (shadows && blocked(far)) continue;
      r += light.rgb[0] * scale * lambert;
      g += light.rgb[1] * scale * lambert;
      b += light.rgb[2] * scale * lambert;
    }
    let occlusion = 1;
    if (ao && nl && strength) {
      // Cosine-weighted hemisphere about the normal, in the branchless basis of Duff et al. 2017.
      const sign = nz >= 0 ? 1 : -1,
        k = -1 / (sign + nz),
        m = nx * ny * k,
        tx = 1 + sign * nx * nx * k,
        ty = sign * m,
        tz = -sign * nx,
        bx = m,
        by = sign + ny * ny * k,
        bz = -ny;
      let hits = 0;
      for (let n = 0; n < rays; n++) {
        const u = random(),
          phi = 2 * Math.PI * random(),
          radius = Math.sqrt(u),
          x = radius * Math.cos(phi),
          y = radius * Math.sin(phi),
          z = Math.sqrt(1 - u);
        direction[0] = tx * x + bx * y + nx * z;
        direction[1] = ty * x + by * y + ny * z;
        direction[2] = tz * x + bz * y + nz * z;
        if (blocked(reach)) hits++;
      }
      occlusion = 1 - (strength * hits) / rays;
    }
    const f = occlusion * multiplier,
      o = i * 4;
    out[o] = r * f;
    out[o + 1] = g * f;
    out[o + 2] = b * f;
    out[o + 3] = C && stride === 4 ? C[o + 3] : 1;
    if (C && apply === 'standard') {
      out[o] *= C[i * stride];
      out[o + 1] *= C[i * stride + 1];
      out[o + 2] *= C[i * stride + 2];
    }
  }
  return out;
}

interface CheckedLight {
  type: BakeLight['type'];
  rgb: number[];
  direction: number[];
  position: Vec3;
  distance: number;
  decay: number;
  angle: number;
  penumbra: number;
}

function checkLight(light: BakeLight): CheckedLight {
  const { type, color = [1, 1, 1], intensity = 1, distance = 0, decay = 2, angle = 0, penumbra = 0 } = light ?? {};
  if (type !== 'ambient' && type !== 'directional' && type !== 'point' && type !== 'spot')
    throw new TypeError("Bake light type must be 'ambient', 'directional', 'point' or 'spot'");
  if (!(intensity >= 0 && intensity < Infinity)) throw new RangeError('Bake light intensity must be finite and >= 0');
  const rgb = (parseColor(color) as number[]).map((c) => c * intensity);
  let direction: number[] = [0, 0, 0];
  if (type === 'directional' || type === 'spot') {
    finiteVector(light.direction!, 3, `Bake ${type} light direction`);
    const [x, y, z] = light.direction!,
      l = Math.hypot(x, y, z);
    if (!l) throw new RangeError(`Bake ${type} light direction must be non-zero`);
    direction = [x / l, y / l, z / l];
  }
  if (type === 'point' || type === 'spot') {
    finiteVector(light.position!, 3, `Bake ${type} light position`);
    if (!(distance >= 0 && distance < Infinity && decay >= 0 && decay < Infinity))
      throw new RangeError('Bake light distance and decay must be finite and >= 0 (distance 0 is unlimited)');
  }
  if (type === 'spot' && !(angle > 0 && angle <= Math.PI / 2 && penumbra >= 0 && penumbra <= 1))
    throw new RangeError('Bake spot light needs an angle in (0, pi/2] radians and a penumbra 0..1');
  return { type, rgb, direction, position: light.position ?? [0, 0, 0], distance, decay, angle, penumbra };
}

/**
 * How {@link limitPalette} measures closeness. Margo's reading of Crocotile's modes: `'nearest'` is the closest RGB in
 * sRGB-encoded values (what the palette's hex codes mean); `'luminance'` the closest relative luminance (linear
 * Rec. 709 Y), ignoring hue; `'balanced'` the closest colour in OKLab (Ottosson 2020), a perceptual space that weighs
 * lightness and hue evenly.
 */
export type PaletteMode = 'nearest' | 'balanced' | 'luminance';

/** Coordinates of a linear RGB colour in which `mode` measures Euclidean distance. */
function paletteSpace(r: number, g: number, b: number, mode: PaletteMode): [number, number, number] {
  if (mode === 'nearest') return [LinearToSRGB(r), LinearToSRGB(g), LinearToSRGB(b)];
  if (mode === 'luminance') return [0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 0];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * Snaps each linear RGBA colour (four values per vertex, as {@link bakeVertexColors} returns) to the closest
 * `palette` entry by `mode` (default `'nearest'`), keeping alpha. Returns a new array of linear RGBA; ties go to the
 * earlier palette entry.
 */
export function limitPalette(
  colors: ArrayLike<number>,
  palette: readonly ColorInput[],
  mode: PaletteMode = 'nearest',
): Float32Array {
  if (mode !== 'nearest' && mode !== 'balanced' && mode !== 'luminance')
    throw new TypeError("Palette mode must be 'nearest', 'balanced' or 'luminance'");
  if (!palette?.length) throw new RangeError('Palette must list at least one colour');
  if (colors.length % 4) throw new RangeError('Palette colors must be RGBA, four values per vertex');
  const linear = palette.map((c) => parseColor(c) as number[]),
    keys = linear.map(([r, g, b]) => paletteSpace(r, g, b, mode)),
    out = new Float32Array(colors.length);
  // ponytail: linear scan over the palette per vertex; fine for editor palettes (<= 256 entries).
  for (let i = 0; i < colors.length; i += 4) {
    const [x, y, z] = paletteSpace(
      Math.max(colors[i], 0),
      Math.max(colors[i + 1], 0),
      Math.max(colors[i + 2], 0),
      mode,
    );
    let best = 0,
      distance = Infinity;
    for (let k = 0; k < keys.length; k++) {
      const d = (keys[k][0] - x) ** 2 + (keys[k][1] - y) ** 2 + (keys[k][2] - z) ** 2;
      if (d < distance) {
        distance = d;
        best = k;
      }
    }
    out[i] = linear[best][0];
    out[i + 1] = linear[best][1];
    out[i + 2] = linear[best][2];
    out[i + 3] = colors[i + 3];
  }
  return out;
}
