// MagicaVoxel compatibility: turns a .vox file's palette colours, MATL materials, rOBJ render settings and rCAM
// cameras into this tracer's scene, environment, options and camera, so a file renders as MagicaVoxel 0.99.7 renders
// it. The mapping was measured from MagicaVoxel's own renders of calibration scenes (black-box; its code was not
// read): palette colours are linear by a pure 2.2 power, uniform sky radiance is its intensity, sun irradiance five
// times its intensity, emitted radiance colour x (1 + 3 x emission x 10^power), metal reflects
// min(1, specular x colour), the coat adds to the diffuse base, glass colour acts through `_d` absorption only, media
// extinction is `_d` per voxel, and the film is Narkowicz's ACES fit with a 2.2 power.
// MagicaVoxel is z-up; the tracer is y-up: tracer (x, y, z) = MagicaVoxel (x, z, -y).
import { atmosphereTransmittance, bakeAtmosphere } from './atmosphere.js';
import type {
  TraceBounceLimits,
  TraceEnvironment,
  TraceEnvironmentMap,
  TraceMaterial,
  TraceModel,
  TraceVec3,
  VoxelPathTracerOptions,
} from './types.js';

/** A MagicaVoxel attribute dictionary (MATL, rOBJ, rCAM): keys with their underscore, string values. */
export type MagicaVoxelDict = Readonly<Record<string, string>> | ReadonlyMap<string, string>;

/**
 * How {@link magicaVoxelLighting} renders a file: 'magicavoxel' reproduces MagicaVoxel 0.99.7's image (its light-transport
 * shortcuts included); 'margo' keeps the file's film, colours, sky, sun and fog but lights them physically (sun
 * highlights on metal and glass, light through glass, sun-lit clouds, rough metal keeps its energy, no bounce caps).
 */
export type MagicaVoxelLook = 'magicavoxel' | 'margo';

/** Lighting and render options of a MagicaVoxel file, from {@link magicaVoxelLighting}. */
export interface MagicaVoxelLighting {
  /** Sky, sun and ground. */
  environment: TraceEnvironment;
  /**
   * Tracer options: tone mapping, gamma, exposure, bounce caps, MagicaVoxel's light-transport choices (no transparent
   * shadows, the sun on diffuse lobes only and not in media) and the lens.
   */
  options: Partial<Omit<VoxelPathTracerOptions, 'scene'>>;
  /** Settings found in the file that the tracer does not reproduce (bloom). */
  unsupported: string[];
  /**
   * The image sky (`_env _mode 2`): the HDR file `_ibl _path` names and how it is shown (3 x `_i`, turned by the
   * second `_angle`). Pass the decoded image as the `imageSky` option to have it set as `environment.map`.
   */
  imageSky?: { path: string; intensity: number; rotation: number };
  /**
   * Non-cubic voxels (`_setting _scale`, MagicaVoxel x y z), when not 1 1 1: pass it to {@link magicaVoxelMatrix},
   * which scales the whole scene about the origin by it.
   */
  voxelScale?: [number, number, number];
  /** A transparent background (`_setting _bg_a`): pass `transparent: true` to `capture`. */
  transparentBackground?: boolean;
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
  /**
   * 'perspective'; 'orthographic' for MagicaVoxel's orth and iso modes (give the engine camera an orthographic
   * projection `orthographicHeight` tall); 'panorama' and 'stereographic' for its lens projections (pass `options` to
   * the tracer).
   */
  projection: 'perspective' | 'orthographic' | 'panorama' | 'stereographic';
  /**
   * Distance from the eye to the target: the radius, or for an orthographic view further back by its height over the
   * sine of the pitch (so the view starts above the ground).
   */
  distance: number;
  /** Orthographic projection: the view's height in world units, the radius (as MagicaVoxel shows it). */
  orthographicHeight?: number;
  /** Tracer options the projection needs (panorama and stereographic lenses); empty otherwise. */
  options: Partial<Pick<VoxelPathTracerOptions, 'projection' | 'panoramaFit' | 'fisheye'>>;
  /**
   * Environment settings the view changes: orthographic views show the ground unfaded (`groundFade` 0, measured);
   * empty otherwise. Merge it over the lighting helper's environment.
   */
  environment: Partial<Pick<TraceEnvironment, 'groundFade'>>;
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
export const magicaVoxelLinear = (value: number): number => clamp01(value / 255) ** 2.2;
const linear3 = (c: ArrayLike<number>): TraceVec3 => [
  magicaVoxelLinear(c[0]),
  magicaVoxelLinear(c[1]),
  magicaVoxelLinear(c[2]),
];
const colorOf = (d: MagicaVoxelDict | undefined, key: string, fallback: TraceVec3): TraceVec3 => {
  const c = nums(d, key);
  return c && c.length >= 3 ? linear3(c) : fallback;
};
/** An 8-bit colour as value / 255 (no 2.2 power), white when absent. */
const rawColor = (c: number[] | undefined): TraceVec3 =>
  c && c.length >= 3 ? [clamp01(c[0] / 255), clamp01(c[1] / 255), clamp01(c[2] / 255)] : [1, 1, 1];
/**
 * The linear radiance that the file's film (`_film`: exposure, ACES or not, gamma) shows as display value `c` (0-1):
 * MagicaVoxel's background is a display colour.
 */
function displayed(c: TraceVec3, film: MagicaVoxelDict | undefined): TraceVec3 {
  const gamma = Math.min(5, Math.max(1, num(film, '_gam') ?? 2.2)),
    aces = (num(film, '_aces') ?? 1) !== 0,
    expo = Math.max(num(film, '_expo') ?? 1, 2 ** -20);
  const one = (v: number) => {
    const x = Math.min(0.9999, v) ** gamma;
    if (!aces) return x / expo;
    // Narkowicz's fit inverted: (2.51 - 2.43 x) t^2 + (0.03 - 0.59 x) t - 0.14 x = 0, t = 0.6 L.
    const a = 2.51 - 2.43 * x,
      b = 0.03 - 0.59 * x,
      t = (-b + Math.sqrt(b * b + 4 * a * 0.14 * x)) / (2 * a);
    return t / 0.6 / expo;
  };
  return [one(c[0]), one(c[1]), one(c[2])];
}
/**
 * Subsurface (`_media_type _sss`): a cloud of extinction 14 x `_d` per voxel that the sun lights through its own volume
 * only (so faces away from the sun stay dark and nothing behind it is lit through it), its scattering events capped
 * by `bounceLimits.subsurface`. Fitted on 6- and 3-voxel blocks at `_d` 0.05 on a black base: sky-lit tops at diffuse
 * caps 2 and 4, the sun-lit top and its slope toward the sun (light travels several voxels inside).
 */
const subsurface = (id: number, color: TraceVec3, d: number, g: number): TraceMaterial => ({
  id,
  type: 'media',
  color,
  density: 14 * d,
  anisotropy: g,
  sunlit: true,
});
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
      // Subsurface glass renders like the subsurface cloud (measured within 4 levels of it).
      if (media === '_sss' && trans >= 1) return subsurface(id, color, density, g);
      return {
        id,
        type: trans < 1 ? 'blend' : 'glass',
        color,
        transmission: trans,
        // Partly transparent voxels pick glass or the rest at the block's faces to the air (sqrt(_trans) glass), and
        // what they rest on shows through with that share again (P boards: 64 tiles, heights 1-6, _trans 0.1-1).
        contactTransmission: trans < 1,
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
        // As partly transparent glass: picked at the block's faces to the air, what it rests on reached with the glass
        // share again (B boards: a 3-voxel block looks like a 1-voxel one; sky-lit 34 -> 56 of 64 tiles within 3).
        contactTransmission: true,
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
      // Radiance colour x (1 + 3 x emission x 10^power); a non-zero `_ldr` l shows 1 + 3 l to the camera only. Emitters
      // reflect nothing (neighbouring emitters do not light each other: measured between tiles).
      return {
        id,
        type: 'emit',
        color: [0, 0, 0],
        emissionColor: color,
        emission: 1 + 3 * emit * 10 ** power,
        ...(ldr > 0 ? { cameraEmission: 1 + 3 * ldr } : {}),
      };
    }
    case '_media': {
      // The older `_weight` reads as density 0.1 (measured at weights 0.3 and 0.89).
      const d = num(a, '_d') ?? (weight === undefined ? 0 : Math.min(0.1, weight));
      if (media === '_absorb')
        return { id, type: 'glass', color, ior: 1, roughness: 0, density: d, tint: false, specular: 0 };
      if (media === '_sss') return subsurface(id, color, d, g);
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
 * `_type`). Missing objects take MagicaVoxel's defaults. `look` (default 'magicavoxel') picks MagicaVoxel's light
 * transport or Margo's physical one; both keep the file's film, colours and lights.
 * @throws TypeError for an unknown look.
 */
export function magicaVoxelLighting(
  objects: Iterable<MagicaVoxelDict>,
  {
    look = 'magicavoxel',
    imageSky,
  }: { look?: MagicaVoxelLook; imageSky?: Pick<TraceEnvironmentMap, 'width' | 'height' | 'data'> } = {},
): MagicaVoxelLighting {
  if (look !== 'magicavoxel' && look !== 'margo')
    throw new TypeError(`magicaVoxelLighting look ${String(look)} is unknown; pass 'magicavoxel' or 'margo'`);
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
    bgOn = (num(setting, '_bg_c') ?? 0) !== 0,
    film = o('_film'),
    bounce = o('_bounce'),
    lens = o('_lens'),
    diffuseCap = Math.min(64, Math.max(1, Math.round(num(bounce, '_diffuse') ?? 2))),
    caps: TraceBounceLimits = {
      diffuse: diffuseCap,
      specular: Math.min(64, Math.max(1, Math.round(num(bounce, '_specular') ?? 5))),
      scatter: Math.min(64, Math.max(1, Math.round(num(bounce, '_scatter') ?? 5))),
      // Subsurface follows the diffuse cap: 2 d + 1 events (fitted at caps 2 and 4; the specular cap does nothing).
      subsurface: Math.min(64, 2 * diffuseCap + 1),
    };
  const sunMV = [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)],
    sunColor = colorOf(o('_inf'), '_k', [1, 1, 1]),
    atm = o('_atm'),
    atmosphere =
      mode === 1
        ? {
            rayleigh: num(atm, '_ray_d') ?? 0.4,
            rayleighColor: rawColor(nums(atm, '_ray_k') ?? [45, 104, 255]),
            mie: num(atm, '_mie_d') ?? 0.4,
            mieColor: rawColor(nums(atm, '_mie_k')),
            mieG: Math.min(0.99, Math.max(-0.99, num(atm, '_mie_g') ?? 0.85)),
            ozone: num(atm, '_o3_d') ?? 0,
            ozoneColor: rawColor(nums(atm, '_o3_k') ?? [105, 255, 110]),
          }
        : undefined;
  const environment: TraceEnvironment = {
    skyColor: colorOf(o('_uni'), '_k', [1, 1, 1]),
    skyIntensity: Math.max(0, num(o('_uni'), '_i') ?? 0.7),
    sunDirection: fromMagicaVoxel(sunMV),
    // In atmosphere mode the sun reaches the ground through the air (dimmed and reddened toward the horizon).
    sunColor: atmosphere
      ? ((t) => [sunColor[0] * t[0], sunColor[1] * t[1], sunColor[2] * t[2]] as TraceVec3)(
          atmosphereTransmittance(sunMV, atmosphere),
        )
      : sunColor,
    // Measured: 5 x `_i` under the uniform sky; 10 x `_i` (before the air dims it) under the atmosphere sky.
    sunIntensity: (atmosphere ? 10 : 5) * Math.max(0, sunI),
    // Atmosphere sky (`_env _mode 1`): single scattering fitted to MagicaVoxel's panoramas, baked to a map (512 rows:
    // 0.35 degrees each, so the reddening in the half degree above the horizon shows). Below the horizon it holds the
    // horizon's light, which the ground fades into; with the ground off, MagicaVoxel shows that light fading into a dim
    // surface instead (fitted to its panoramas).
    ...(atmosphere
      ? {
          map: bakeAtmosphere(
            sunMV,
            atmosphere,
            [sunColor[0] * Math.max(0, sunI), sunColor[1] * Math.max(0, sunI), sunColor[2] * Math.max(0, sunI)],
            256,
            512,
            groundOn ? 'horizon' : 'surface',
          ),
        }
      : {}),
    // `_area` a: a sun disk about 0.69 a radians across (fitted to its penumbrae at 0.07 and 0.2).
    sunAngularSize: Math.min(0.5, 0.69 * Math.max(0, num(o('_inf'), '_area') ?? 0.07)),
    sunVisible: (num(o('_inf'), '_disk') ?? 0) !== 0,
    // Uniform fog `_d` d: extinction about 0.001 d per voxel (fitted at d 0.5 and 5); phase `_g`; colour `_k` taken
    // as value / 255 without the 2.2 power (unlike every other colour: measured per channel).
    ...((num(o('_fog_uni'), '_d') ?? 0) > 0
      ? {
          fog: {
            density: 0.001 * (num(o('_fog_uni'), '_d') ?? 0),
            color: rawColor(nums(o('_fog_uni'), '_k')),
            anisotropy: Math.min(0.95, Math.max(-0.95, num(o('_fog_uni'), '_g') ?? 0)),
          },
        }
      : {}),
    // Background colour (`_setting _bg_c`): what camera rays leaving the scene show, as displayed (measured: the
    // exact colour on screen, lighting unchanged, the ground no longer fading).
    ...(bgOn ? { background: displayed(rawColor(nums(o('_bg'), '_color') ?? [0, 0, 0]), film) } : {}),
    ...(groundOn
      ? {
          groundColor: colorOf(o('_ground'), '_color', linear3([80, 80, 80])),
          groundHeight: 0,
          // `_hor` h: the ground the camera sees at distance D fades into the sky behind it by 1 - e^(-D h / c),
          // c 2030 under the uniform sky (measured per pixel against the unfaded ground: h 0.1 and 0.5, cameras 60-180
          // from their focus, D 40-5000). Under the atmosphere c is about 2250 and the nearest 100 do not fade (two
          // views; the one into a low sun prefers 2400, the one away from it 2100).
          // No fade under the image sky either (measured: the ground equals the unfaded ground at every distance).
          ...((num(o('_ground'), '_hor') ?? 0.1) > 0 && !bgOn && mode !== 2
            ? mode === 1
              ? { groundFade: 2250 / (num(o('_ground'), '_hor') ?? 0.1), groundFadeStart: 100 }
              : { groundFade: 2030 / (num(o('_ground'), '_hor') ?? 0.1) }
            : {}),
        }
      : {}),
  };
  // Image sky (`_env _mode 2`): measured with our own ramp image: MagicaVoxel +x at the image's centre column, azimuth
  // turning toward +y to the left, rows by elevation; radiance 3 x `_i`; the second `_angle` turns it (the first does
  // nothing). Within 0.003 of the image width at `_i` 0.25 and 1, turns 0, 30 and 120.
  const ibl = o('_ibl'),
    sky =
      mode === 2
        ? {
            path: get(ibl, '_path') ?? '',
            intensity: 3 * Math.max(0, num(ibl, '_i') ?? 1),
            rotation: Math.PI / 2 - ((nums(ibl, '_angle')?.[1] ?? 0) * Math.PI) / 180,
          }
        : undefined;
  if (sky && imageSky) environment.map = { ...imageSky, intensity: sky.intensity, rotation: sky.rotation };
  else if (sky) unsupported.push('image sky (_ibl): pass the decoded _ibl _path image as the imageSky option');

  if ((num(o('_bloom'), '_mix') ?? 0.5) > 0 && (num(o('_bloom'), '_scale') ?? 0) > 0)
    unsupported.push('bloom (_bloom)');
  const edge = o('_edge'),
    grid = o('_grid'),
    display = {
      // Vignette `_vig` v: cos^4 falloff, t = v r / (0.2238 H) (measured at v 0.5 and 1, two fields of view, two
      // image sizes: within 0.001).
      vignette: Math.max(0, num(film, '_vig') ?? 0),
      // Edges: a band `_width` voxels wide along turning voxel edges, in `_color` lit (measured on outer and inner
      // corners at widths 0.2 and 0.5).
      edges:
        (num(setting, '_edge') ?? 0) !== 0
          ? { color: colorOf(edge, '_color', [0, 0, 0]), width: Math.min(0.5, Math.max(0, num(edge, '_width') ?? 0.2)) }
          : null,
      // Grid: lines every `_spacing` with half width `_width` on the ground, and on voxels with `_display` 0
      // (measured: spacing 1 and 4, widths 0.02 and 0.1, both display modes).
      grid:
        (num(setting, '_grid') ?? 0) !== 0
          ? {
              color: colorOf(grid, '_color', [0, 0, 0]),
              spacing: Math.max(1e-3, num(grid, '_spacing') ?? 1),
              width: Math.max(0, num(grid, '_width') ?? 0.02),
              onVoxels: (num(grid, '_display') ?? 0) === 0,
            }
          : null,
    };
  const expo = num(film, '_expo') ?? 1,
    blades = Math.round(num(lens, '_blade_n') ?? 0),
    scaled = nums(setting, '_scale'),
    scale: [number, number, number] = [0, 1, 2].map((i) => {
      const v = scaled?.[i] ?? 1;
      return Number.isFinite(v) && v > 0 ? v : 1;
    }) as [number, number, number];
  return {
    environment,
    options: {
      ...display,
      // As many samples per frame as keep the display's pace (the same image, sooner).
      samplesPerFrame: 'auto',
      toneMapping: (num(film, '_aces') ?? 1) !== 0 ? 'aces-narkowicz' : 'linear',
      gamma: Math.min(5, Math.max(1, num(film, '_gam') ?? 2.2)),
      exposure: Math.min(20, Math.max(-20, Math.log2(Math.max(expo, 2 ** -20)))),
      ...(look === 'magicavoxel'
        ? {
            bounceLimits: caps,
            maxBounces: Math.min(64, caps.diffuse! + caps.specular! + caps.scatter! + caps.subsurface!),
            transparentShadows: false,
            sunSpecular: false,
            sunInMedia: false,
            energyCompensation: false,
          }
        : {
            // Margo's look also denoises the sparse viewport (clean while the camera moves).
            denoise: 'auto',
            bounceLimits: null,
            maxBounces: 12,
            transparentShadows: true,
            sunSpecular: true,
            sunInMedia: true,
            energyCompensation: true,
          }),
      lensBlades: blades >= 3 && blades <= 16 ? blades : 0,
      lensRotation: ((num(lens, '_blade_r') ?? 0) * Math.PI) / 180,
    },
    unsupported,
    ...(sky ? { imageSky: sky } : {}),
    ...(scale.some((v) => v !== 1) ? { voxelScale: scale } : {}),
    ...((num(setting, '_bg_a') ?? 0) !== 0 ? { transparentBackground: true } : {}),
  };
}

/** True isometric pitch: the three axes equally foreshortened, atan(1 / sqrt 2) below the horizontal. */
const ISO_PITCH = -Math.atan(Math.SQRT1_2);

/**
 * The camera of an rCAM dictionary (`_focus`, `_angle` pitch yaw roll in degrees, `_radius`, `_mode` pers, free,
 * orth, iso or pano). MagicaVoxel renders with the field of view and projection of its lens render object (`_fov`,
 * `_proj`), so pass the file's rOBJ dictionaries as `objects`; the camera's own `_fov` applies only without a `_lens`
 * object. Orth and iso are orthographic, as tall as the radius (measured); iso looks down at the isometric angle
 * (35.26 degrees) from the stored yaw (measured). Lens projection 2 (Pano, also `_mode pano`) is the equal-angle
 * panorama (180 degrees down the image, the same angle per pixel across); 1 (SG) is stereographic with the lens field
 * of view (measured: 100% of pixels within 3 levels at 35 degrees).
 */
export function magicaVoxelCamera(camera: MagicaVoxelDict, objects: Iterable<MagicaVoxelDict> = []): MagicaVoxelCamera {
  let lens: MagicaVoxelDict | undefined;
  for (const o of objects) if (get(o, '_type') === '_lens') lens = o;
  const focus = nums(camera, '_focus') ?? [0, 0, 0],
    stored = nums(camera, '_angle') ?? [0, 0, 0],
    radius = Math.max(1e-3, num(camera, '_radius') ?? 100),
    fov = Math.min(179, Math.max(1, num(lens, '_fov') ?? num(camera, '_fov') ?? 45)),
    mode = get(camera, '_mode') ?? 'pers',
    lensProjection = mode === 'pano' ? 2 : Math.round(num(lens, '_proj') ?? 0),
    iso = mode === 'iso',
    orthographic = (mode === 'orth' || iso) && lensProjection === 0,
    // Iso: the isometric pitch, the stored yaw and roll.
    angle = iso ? [(ISO_PITCH * 180) / Math.PI, stored[1] ?? 0, stored[2] ?? 0] : stored,
    [p, y, r] = angle.map((v) => ((v ?? 0) * Math.PI) / 180),
    offset = [Math.cos(p) * Math.sin(y), -Math.cos(p) * Math.cos(y), -Math.sin(p)],
    // MagicaVoxel's orthographic view is as tall as the radius (measured at a 35-degree lens).
    height = radius,
    // An orthographic eye sits further back by the view height over the sine of the pitch, so the image's lower edge
    // starts above the ground (orthographic views do not fade the ground, so the distance changes nothing else).
    distance = orthographic ? radius + height / Math.max(0.05, Math.abs(Math.sin(p))) : radius,
    eye = [focus[0] + distance * offset[0], focus[1] + distance * offset[1], focus[2] + distance * offset[2]];
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
    projection:
      lensProjection === 2
        ? 'panorama'
        : lensProjection === 1
          ? 'stereographic'
          : orthographic
            ? 'orthographic'
            : 'perspective',
    distance,
    ...(orthographic ? { orthographicHeight: height } : {}),
    options:
      lensProjection === 2
        ? { projection: 'panorama', panoramaFit: 'height' }
        : lensProjection === 1
          ? { projection: 'fisheye', fisheye: { mapping: 'stereographic', fov } }
          : {},
    environment: orthographic ? { groundFade: 0 } : {},
  };
}

/**
 * A tracer model of a MagicaVoxel model: `size` [x, y, z] (z up) and `voxels` as stored (x, y, z, palette index per
 * 4 bytes). Place it with {@link magicaVoxelMatrix}.
 * @throws RangeError for a size outside 1 to 256.
 */
export function magicaVoxelModel(
  id: string,
  revision: number,
  size: ArrayLike<number>,
  voxels: Uint8Array,
): TraceModel {
  const [sx, sy, sz] = [size[0], size[1], size[2]];
  if (![sx, sy, sz].every((v) => Number.isInteger(v) && v >= 1 && v <= 256))
    throw new RangeError(
      `magicaVoxelModel size ${Array.from(size).join(' x ')} is out of range; pass 1 to 256 per axis`,
    );
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
 * identity by default), for the model built by {@link magicaVoxelModel}; `scale` (the lighting helper's `voxelScale`,
 * MagicaVoxel axes) stretches the placed model about the world origin.
 */
export function magicaVoxelMatrix(
  size: ArrayLike<number>,
  translation: ArrayLike<number> = [0, 0, 0],
  rotation: ArrayLike<number> = [1, 0, 0, 0, 1, 0, 0, 0, 1],
  scale: ArrayLike<number> = [1, 1, 1],
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
    // MagicaVoxel world = A P + b (scaled about the origin).
    A = L.map((_, i) => [0, 1, 2].map((j) => scale[i] * (R(i, 0) * L[0][j] + R(i, 1) * L[1][j] + R(i, 2) * L[2][j]))),
    b = [0, 1, 2].map((i) => scale[i] * (translation[i] + R(i, 0) * lo[0] + R(i, 1) * lo[1] + R(i, 2) * lo[2])),
    // C applied to rows: tracer x = mv x, y = mv z, z = -mv y.
    M = [A[0], A[2], A[1].map((v) => -v)],
    t = [b[0], b[2], -b[1]];
  return [
    M[0][0],
    M[1][0],
    M[2][0],
    0,
    M[0][1],
    M[1][1],
    M[2][1],
    0,
    M[0][2],
    M[1][2],
    M[2][2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}
