// MagicaVoxel compatibility: turns a .vox file's palette colours, MATL materials, rOBJ render settings and rCAM
// cameras into this tracer's scene, environment, options and camera, so a file renders as MagicaVoxel 0.99.7 renders
// it. The mapping was measured from MagicaVoxel's own renders of calibration scenes (black-box; its code was not
// read): palette colours are linear by a pure 2.2 power, uniform sky radiance is its intensity, sun irradiance five
// times its intensity, emitted radiance colour x (1 + 3 x emission x 10^power), metal reflects
// min(1, specular x colour), the coat adds to the diffuse base, glass colour acts through `_d` absorption only, media
// extinction is `_d` per voxel, and the film is Narkowicz's ACES fit with a 2.2 power.
// MagicaVoxel is z-up; the tracer is y-up: tracer (x, y, z) = MagicaVoxel (x, z, -y).
import type {
  TraceBounceLimits,
  TraceEnvironment,
  TraceMaterial,
  TraceModel,
  TraceVec3,
  VoxelPathTracerOptions,
} from './types.js';

/** A MagicaVoxel attribute dictionary (MATL, rOBJ, rCAM): keys with their underscore, string values. */
export type MagicaVoxelDict = Readonly<Record<string, string>> | ReadonlyMap<string, string>;

/** Lighting and render options of a MagicaVoxel file, from {@link magicaVoxelLighting}. */
export interface MagicaVoxelLighting {
  /** Sky, sun and ground. */
  environment: TraceEnvironment;
  /**
   * Tracer options: tone mapping, gamma, exposure, bounce caps, MagicaVoxel's light-transport choices (no transparent
   * shadows, the sun on diffuse lobes only and not in media) and the lens.
   */
  options: Partial<Omit<VoxelPathTracerOptions, 'scene'>>;
  /** Settings found in the file that the tracer does not reproduce (bloom, fog, atmosphere, IBL, edges, grid). */
  unsupported: string[];
}

/** A camera from {@link magicaVoxelCamera}, in tracer world coordinates. */
export interface MagicaVoxelCamera {
  /** Eye position. */
  position: TraceVec3;
  /** Look-at point (MagicaVoxel's focus). */
  target: TraceVec3;
  /** Screen-up direction (rolled). */
  up: TraceVec3;
  /** Vertical field of view in degrees. */
  fov: number;
  /** 'perspective', or 'orthographic' for MagicaVoxel's ortho and iso modes. */
  projection: 'perspective' | 'orthographic';
  /** Distance from the eye to the target. */
  distance: number;
}

const get = (d: MagicaVoxelDict | undefined, key: string): string | undefined =>
  d === undefined ? undefined : d instanceof Map ? d.get(key) : (d as Record<string, string>)[key];
const num = (d: MagicaVoxelDict | undefined, key: string): number | undefined => {
  const v = get(d, key);
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const nums = (d: MagicaVoxelDict | undefined, key: string): number[] | undefined => {
  const v = get(d, key);
  if (v === undefined) return undefined;
  const parts = v.trim().split(/\s+/).map(Number);
  return parts.every(Number.isFinite) ? parts : undefined;
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** MagicaVoxel's 8-bit colour to linear: a pure 2.2 power (not the sRGB curve). */
export const magicaVoxelLinear = (value: number): number => (clamp01(value / 255)) ** 2.2;
const linear3 = (c: ArrayLike<number>): TraceVec3 => [magicaVoxelLinear(c[0]), magicaVoxelLinear(c[1]), magicaVoxelLinear(c[2])];
const colorOf = (d: MagicaVoxelDict | undefined, key: string, fallback: TraceVec3): TraceVec3 => {
  const c = nums(d, key);
  return c && c.length >= 3 ? linear3(c) : fallback;
};
/** MagicaVoxel (x, y, z), z up, to tracer (x, z, -y), y up. */
export const fromMagicaVoxel = (p: ArrayLike<number>): TraceVec3 => [p[0], p[2], -p[1]];

/**
 * The tracer material of palette index `id` with 8-bit colour `rgb` and MATL `attributes` (MagicaVoxel 0.99.7 keys,
 * and the older `_weight` / `_spec` / `_alpha` it still reads, which win when both are present). A missing key reads
 * as MagicaVoxel reads it: 0, except specular 1 (so `_type` alone is plain diffuse, opaque glass, a dark emitter).
 * @throws RangeError when `id` is not 1 to 255.
 */
export function magicaVoxelMaterial(id: number, rgb: ArrayLike<number>, attributes?: MagicaVoxelDict): TraceMaterial {
  if (!Number.isInteger(id) || id < 1 || id > 255)
    throw new RangeError(`magicaVoxelMaterial id ${id} is out of range; pass a palette index 1 to 255`);
  const a = attributes,
    type = get(a, '_type') ?? '_diffuse',
    color = linear3(rgb),
    weight = num(a, '_weight'),
    // MagicaVoxel's roughness r matches a GGX width of about 0.13 r (fitted to its reflections, r 0.05 to 1).
    rough = Math.sqrt(0.13 * clamp01(num(a, '_rough') ?? 0)),
    legacySpec = num(a, '_spec'),
    specular = legacySpec !== undefined ? 1 + legacySpec : (num(a, '_sp') ?? 1),
    ior = Math.min(3, Math.max(1, 1 + (num(a, '_ior') ?? (num(a, '_ri') ?? 1) - 1))),
    density = Math.max(0, num(a, '_d') ?? 0),
    g = Math.min(0.95, Math.max(-0.95, num(a, '_g') ?? 0)),
    media = get(a, '_media_type') ?? (type === '_media' ? '_scatter' : '_absorb'),
    // The glass share of a partly transparent voxel goes as the square root of `_trans` (fitted at 0.25 and 0.5).
    trans = Math.sqrt(clamp01(weight ?? num(a, '_alpha') ?? num(a, '_trans') ?? 0)),
    metalColor: TraceVec3 = [
      Math.min(1, specular * color[0]),
      Math.min(1, specular * color[1]),
      Math.min(1, specular * color[2]),
    ],
    // Glass and blend volumes: absorption (`_d` x -ln colour per voxel) or interior scattering.
    interior: Partial<TraceMaterial> =
      media === '_scatter' || media === '_sss'
        ? { scatter: density, anisotropy: g }
        : { density: media === '_absorb' ? density : 0 };
  switch (type) {
    case '_metal': {
      const metalness = clamp01(weight ?? num(a, '_metal') ?? 0);
      return {
        id,
        type: 'metal',
        color,
        metalColor,
        metalness,
        roughness: rough,
        ior,
        specular: 1,
        coat: 'additive',
      };
    }
    case '_glass':
      return {
        id,
        type: trans < 1 ? 'blend' : 'glass',
        color,
        transmission: trans,
        metalness: 0,
        roughness: rough,
        ior,
        specular: 1,
        coat: 'additive',
        tint: false,
        ...interior,
      };
    case '_blend':
      return {
        id,
        type: 'blend',
        color,
        metalColor,
        metalness: clamp01(num(a, '_metal') ?? 0),
        transmission: Math.sqrt(clamp01(num(a, '_alpha') ?? num(a, '_trans') ?? 0)),
        roughness: rough,
        ior,
        specular: 1,
        coat: 'additive',
        tint: false,
        ...interior,
      };
    case '_emit': {
      const emit = Math.max(0, weight ?? num(a, '_emit') ?? 0),
        power = num(a, '_flux') ?? 0;
      const ldr = clamp01(num(a, '_ldr') ?? 0);
      // A non-zero `_ldr` l shows the emitter at 1 + 3 l to the camera; the light it casts stays the same.
      return { id, type: 'emit', color, emission: 1 + 3 * emit * 10 ** power, ...(ldr > 0 ? { cameraEmission: 1 + 3 * ldr } : {}) };
    }
    case '_media': {
      // The older `_weight` reads as density 0.1 (measured at weights 0.3 and 0.89).
      const d = num(a, '_d') ?? (weight === undefined ? 0 : Math.min(0.1, weight));
      if (media === '_absorb')
        return { id, type: 'glass', color, ior: 1, roughness: 0, density: d, tint: false, specular: 0 };
      return {
        id,
        type: 'media',
        color,
        density: d,
        anisotropy: g,
        // Emissive media glow 0.93 x `_d` x colour per voxel and neither absorb nor scatter (measured, `_d` 0.01 to 1).
        ...(media === '_emit' ? { density: 0, emission: 0.93 * d } : {}),
      };
    }
    default:
      return { id, type: 'diffuse', color };
  }
}

/**
 * Environment, options and the unsupported settings of a file's render objects (rOBJ dictionaries, each with its
 * `_type`). Missing objects take MagicaVoxel's defaults.
 */
export function magicaVoxelLighting(objects: Iterable<MagicaVoxelDict>): MagicaVoxelLighting {
  const by = new Map<string, MagicaVoxelDict>();
  for (const o of objects) {
    const t = get(o, '_type');
    if (t) by.set(t, o);
  }
  const o = (t: string) => by.get(t),
    unsupported: string[] = [],
    mode = num(o('_env'), '_mode') ?? 0,
    sunI = num(o('_inf'), '_i') ?? 0.7,
    angle = nums(o('_inf'), '_angle') ?? [50, 50],
    elevation = (angle[0] * Math.PI) / 180,
    azimuth = (((angle[1] ?? 0) - 90) * Math.PI) / 180,
    setting = o('_setting'),
    groundOn = (num(setting, '_ground') ?? 1) !== 0,
    film = o('_film'),
    bounce = o('_bounce'),
    lens = o('_lens'),
    caps: TraceBounceLimits = {
      diffuse: Math.min(64, Math.max(1, Math.round(num(bounce, '_diffuse') ?? 2))),
      specular: Math.min(64, Math.max(1, Math.round(num(bounce, '_specular') ?? 5))),
      scatter: Math.min(64, Math.max(1, Math.round(num(bounce, '_scatter') ?? 5))),
    };
  const environment: TraceEnvironment = {
    skyColor: colorOf(o('_uni'), '_k', [1, 1, 1]),
    skyIntensity: Math.max(0, num(o('_uni'), '_i') ?? 0.7),
    sunDirection: fromMagicaVoxel([
      Math.cos(elevation) * Math.cos(azimuth),
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
    ]),
    sunColor: colorOf(o('_inf'), '_k', [1, 1, 1]),
    sunIntensity: 5 * Math.max(0, sunI),
    // `_area` a: a sun disk about 0.69 a radians across (fitted to its penumbrae at 0.07 and 0.2).
    sunAngularSize: Math.min(0.5, 0.69 * Math.max(0, num(o('_inf'), '_area') ?? 0.07)),
    sunVisible: (num(o('_inf'), '_disk') ?? 0) !== 0,
    ...(groundOn
      ? {
          groundColor: colorOf(o('_ground'), '_color', linear3([80, 80, 80])),
          groundHeight: 0,
          // `_hor` h: the camera's ground fades into the sky by a / (a + sin depression), a = 0.007 h (fitted).
          groundHorizon: 0.007 * Math.max(0, num(o('_ground'), '_hor') ?? 0.1),
        }
      : {}),
  };
  if (mode === 1) unsupported.push('atmosphere sky (_atm): a uniform sky stands in');
  if (mode === 2) unsupported.push('image sky (_ibl): pass the HDR image as environment.map');
  if ((num(o('_fog_uni'), '_d') ?? 0) > 0) unsupported.push('uniform fog (_fog_uni)');
  if ((num(o('_bloom'), '_mix') ?? 0.5) > 0 && (num(o('_bloom'), '_scale') ?? 0) > 0) unsupported.push('bloom (_bloom)');
  if ((num(setting, '_edge') ?? 0) !== 0) unsupported.push('edges (_edge)');
  if ((num(setting, '_grid') ?? 0) !== 0) unsupported.push('grid (_grid)');
  if ((num(film, '_vig') ?? 0) > 0) unsupported.push('vignette (_film _vig)');
  const expo = num(film, '_expo') ?? 1,
    blades = Math.round(num(lens, '_blade_n') ?? 0);
  return {
    environment,
    options: {
      toneMapping: (num(film, '_aces') ?? 1) !== 0 ? 'aces-narkowicz' : 'linear',
      gamma: Math.min(5, Math.max(1, num(film, '_gam') ?? 2.2)),
      exposure: Math.min(20, Math.max(-20, Math.log2(Math.max(expo, 2 ** -20)))),
      bounceLimits: caps,
      maxBounces: Math.min(64, caps.diffuse! + caps.specular! + caps.scatter!),
      transparentShadows: false,
      sunSpecular: false,
      sunInMedia: false,
      lensBlades: blades >= 3 && blades <= 16 ? blades : 0,
      lensRotation: ((num(lens, '_blade_r') ?? 0) * Math.PI) / 180,
    },
    unsupported,
  };
}

/**
 * The camera of an rCAM dictionary (`_focus`, `_angle` pitch yaw roll in degrees, `_radius`, `_mode`). MagicaVoxel
 * renders with the field of view of its lens render object, so pass the file's rOBJ dictionaries as `objects`; the
 * camera's own `_fov` applies only without a `_lens` object.
 */
export function magicaVoxelCamera(camera: MagicaVoxelDict, objects: Iterable<MagicaVoxelDict> = []): MagicaVoxelCamera {
  let lens: MagicaVoxelDict | undefined;
  for (const o of objects) if (get(o, '_type') === '_lens') lens = o;
  const focus = nums(camera, '_focus') ?? [0, 0, 0],
    angle = nums(camera, '_angle') ?? [0, 0, 0],
    radius = Math.max(1e-3, num(camera, '_radius') ?? 100),
    fov = Math.min(179, Math.max(1, num(lens, '_fov') ?? num(camera, '_fov') ?? 45)),
    mode = get(camera, '_mode') ?? 'pers',
    [p, y, r] = angle.map((v) => ((v ?? 0) * Math.PI) / 180),
    offset = [Math.cos(p) * Math.sin(y), -Math.cos(p) * Math.cos(y), -Math.sin(p)],
    eye = [focus[0] + radius * offset[0], focus[1] + radius * offset[1], focus[2] + radius * offset[2]];
  // Screen up: world z made perpendicular to the view, then rolled about it (looking straight down: +y).
  const f = offset.map((v) => -v),
    upGuess = Math.abs(f[2]) > 0.999 ? [Math.sin(y), Math.cos(y), 0] : [0, 0, 1],
    dot = upGuess[0] * f[0] + upGuess[1] * f[1] + upGuess[2] * f[2],
    u0 = upGuess.map((v, k) => v - dot * f[k]),
    ul = Math.hypot(u0[0], u0[1], u0[2]),
    u = u0.map((v) => v / ul),
    side = [f[1] * u[2] - f[2] * u[1], f[2] * u[0] - f[0] * u[2], f[0] * u[1] - f[1] * u[0]],
    up = u.map((v, k) => v * Math.cos(r) + side[k] * Math.sin(r));
  return {
    position: fromMagicaVoxel(eye),
    target: fromMagicaVoxel(focus),
    up: fromMagicaVoxel(up),
    fov,
    projection: mode === 'orth' || mode === 'iso' ? 'orthographic' : 'perspective',
    distance: radius,
  };
}

/**
 * A tracer model of a MagicaVoxel model: `size` [x, y, z] (z up) and `voxels` as stored (x, y, z, palette index per
 * 4 bytes). Place it with {@link magicaVoxelMatrix}.
 * @throws RangeError for a size outside 1 to 256.
 */
export function magicaVoxelModel(id: string, revision: number, size: ArrayLike<number>, voxels: Uint8Array): TraceModel {
  const [sx, sy, sz] = [size[0], size[1], size[2]];
  if (![sx, sy, sz].every((v) => Number.isInteger(v) && v >= 1 && v <= 256))
    throw new RangeError(`magicaVoxelModel size ${Array.from(size).join(' x ')} is out of range; pass 1 to 256 per axis`);
  const dense = new Uint8Array(sx * sy * sz);
  for (let i = 0; i + 3 < voxels.length; i += 4) {
    const x = voxels[i],
      y = voxels[i + 1],
      z = voxels[i + 2];
    if (x < sx && y < sy && z < sz) dense[x + sx * (sy - 1 - y + sy * z)] = voxels[i + 3];
  }
  return { id, revision, size: [sx, sz, sy], voxels: dense };
}

/**
 * Column-major tracer matrix of a MagicaVoxel model placed by a transform node: `translation` (`_t`, where the
 * model's centre voxel corner floor(size / 2) lands) and `rotation` (`_r` as a row-major 3 x 3 signed permutation,
 * identity by default), for the model built by {@link magicaVoxelModel}.
 */
export function magicaVoxelMatrix(
  size: ArrayLike<number>,
  translation: ArrayLike<number> = [0, 0, 0],
  rotation: ArrayLike<number> = [1, 0, 0, 0, 1, 0, 0, 0, 1],
): number[] {
  // MagicaVoxel world = t + R (local - pivot); local = (X, sy - Z, Y) for the tracer model point (X, Y, Z); tracer
  // world = C(MagicaVoxel world) with C(x, y, z) = (x, z, -y).
  const R = (i: number, j: number) => rotation[3 * i + j],
    pivot = [Math.floor(size[0] / 2), Math.floor(size[1] / 2), Math.floor(size[2] / 2)],
    // Local from tracer model axes: X -> (1,0,0), Y -> (0,0,1), Z -> (0,-1,0); offset (0, sy, 0).
    L = [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    lo = [-pivot[0], size[1] - pivot[1], -pivot[2]],
    // MagicaVoxel world = A P + b.
    A = L.map((_, i) => [0, 1, 2].map((j) => R(i, 0) * L[0][j] + R(i, 1) * L[1][j] + R(i, 2) * L[2][j])),
    b = [0, 1, 2].map((i) => translation[i] + R(i, 0) * lo[0] + R(i, 1) * lo[1] + R(i, 2) * lo[2]),
    // C applied to rows: tracer x = mv x, y = mv z, z = -mv y.
    M = [A[0], A[2], A[1].map((v) => -v)],
    t = [b[0], b[2], -b[1]];
  return [M[0][0], M[1][0], M[2][0], 0, M[0][1], M[1][1], M[2][1], 0, M[0][2], M[1][2], M[2][2], 0, t[0], t[1], t[2], 1];
}
