// Tracer options: their defaults, validation and resolution. Shared by `VoxelPathTracer` (attach, setOptions,
// resetOptions) and the standalone `resolveTraceOptions` / `validateTraceOptions`, which need no engine or GPU.
import { checkNumber, checkVec3, resolveMaterial } from './scene.js';
import type {
  ResolvedTraceMaterial,
  ResolvedTraceOptions,
  TraceBounceLimits,
  TraceEdges,
  TraceFisheye,
  TraceGrid,
  TraceLensDistortion,
  TraceMaterial,
  TracePreviousCamera,
  TraceProblem,
  TraceValidation,
  VoxelPathTracerOptions,
} from './types.js';

/** Resolved tracer options (every field set; uncapped bounce kinds are BOUNCE_FREE). */
export interface Settings {
  samplesPerFrame: number | 'auto';
  maxBounces: number;
  maxSamples: number;
  seed: number;
  resolutionScale: number;
  exposure: number;
  aperture: number;
  focusDistance: number | undefined;
  denoise: boolean | 'auto';
  lensBlades: number;
  lensRotation: number;
  shutter: number;
  clamp: number;
  toneMapping: 'neutral' | 'linear' | 'aces-narkowicz';
  gamma: number | undefined;
  bounceLimits: Required<TraceBounceLimits> | undefined;
  transparentShadows: boolean;
  sunSpecular: boolean;
  sunInMedia: boolean;
  energyCompensation: boolean;
  vignette: number;
  edges: TraceEdges | undefined;
  grid: Required<TraceGrid> | undefined;
  order: number;
  previousCamera: TracePreviousCamera | undefined;
  projection: 'camera' | 'panorama' | 'fisheye';
  fisheye: Required<TraceFisheye>;
  distortion: Required<TraceLensDistortion> | undefined;
}
export const DEFAULTS: Settings = {
  samplesPerFrame: 1,
  maxBounces: 8,
  maxSamples: 1024,
  seed: 0,
  resolutionScale: 1,
  exposure: 0,
  aperture: 0,
  focusDistance: undefined,
  denoise: false,
  lensBlades: 0,
  lensRotation: 0,
  shutter: 0,
  clamp: Infinity,
  toneMapping: 'neutral',
  gamma: undefined,
  bounceLimits: undefined,
  transparentShadows: true,
  sunSpecular: true,
  sunInMedia: true,
  energyCompensation: true,
  vignette: 0,
  edges: undefined,
  grid: undefined,
  order: 20,
  previousCamera: undefined,
  projection: 'camera',
  fisheye: { mapping: 'equidistant', fov: 180 },
  distortion: undefined,
};
/** Every option name but `scene`, in the order of {@link VoxelPathTracerOptions}. */
const OPTION_NAMES = Object.keys(DEFAULTS) as readonly (keyof Settings)[];
// Options whose change invalidates the accumulated samples (the others only change how they are shown or paced).
export const RESETS: readonly (keyof Settings)[] = [
  'maxBounces',
  'seed',
  'resolutionScale',
  'aperture',
  'focusDistance',
  'lensBlades',
  'lensRotation',
  'shutter',
  'previousCamera',
  'projection',
  'fisheye',
  'distortion',
  'clamp',
  'bounceLimits',
  'transparentShadows',
  'sunSpecular',
  'sunInMedia',
  'energyCompensation',
  'edges',
  'grid',
];

export const whole = (value: unknown, name: string, min: number, max: number, fix: string): number => {
  const v = checkNumber(value, name, min, max, fix);
  if (!Number.isInteger(v)) throw new RangeError(`VoxelPathTracer ${name} ${v} must be a whole number; ${fix}`);
  return v;
};
export const flag = (value: unknown, name: string): boolean => {
  if (typeof value !== 'boolean') throw new TypeError(`VoxelPathTracer ${name} must be true or false`);
  return value;
};

/** Per-kind bounce caps with absent kinds uncapped (BOUNCE_FREE); null clears them. */
export const BOUNCE_FREE = 0xffff;
function bounceLimits(value: unknown): Required<TraceBounceLimits> | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'object')
    throw new TypeError('VoxelPathTracer bounceLimits must be {diffuse?, specular?, scatter?} or null');
  const o = value as Record<string, unknown>,
    cap = (k: 'diffuse' | 'specular' | 'scatter') =>
      o[k] === undefined ? BOUNCE_FREE : whole(o[k], `bounceLimits.${k}`, 1, 64, 'pass 1 to 64, or leave it out');
  return { diffuse: cap('diffuse'), specular: cap('specular'), scatter: cap('scatter') };
}

/** Edge bands, or undefined for null. */
function edges(value: unknown): TraceEdges | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'object') throw new TypeError('VoxelPathTracer edges must be {color, width} or null');
  const o = value as Record<string, unknown>;
  return {
    color: checkVec3(o.color, 'VoxelPathTracer edges.color', true, 'pass linear RGB, 0 or more'),
    width: checkNumber(o.width, 'edges.width', 0, 0.5, 'pass 0 to 0.5 voxels'),
  };
}
/** Grid lines, or undefined for null. */
function grid(value: unknown): Required<TraceGrid> | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'object')
    throw new TypeError('VoxelPathTracer grid must be {color, spacing, width, onVoxels?} or null');
  const o = value as Record<string, unknown>;
  return {
    color: checkVec3(o.color, 'VoxelPathTracer grid.color', true, 'pass linear RGB, 0 or more'),
    spacing: checkNumber(o.spacing, 'grid.spacing', 1e-3, 1e6, 'pass a distance above 0'),
    width: checkNumber(o.width, 'grid.width', 0, 1e6, 'pass a half width, 0 or more'),
    onVoxels: o.onVoxels === undefined ? false : flag(o.onVoxels, 'grid.onVoxels'),
  };
}

/** Validates `input` over `base`; throws before returning anything. */
export function settings(input: Partial<Omit<VoxelPathTracerOptions, 'scene'>>, base: Settings): Settings {
  if (!input || typeof input !== 'object') throw new TypeError('VoxelPathTracer options must be an object');
  const s = { ...base },
    o = input as Record<string, unknown>;
  if (o.samplesPerFrame !== undefined)
    s.samplesPerFrame =
      o.samplesPerFrame === 'auto'
        ? 'auto'
        : whole(o.samplesPerFrame, 'samplesPerFrame', 1, 64, "pass 1 to 64 or 'auto'");
  if (o.maxBounces !== undefined) s.maxBounces = whole(o.maxBounces, 'maxBounces', 1, 64, 'pass 1 to 64');
  if (o.maxSamples !== undefined) {
    const v = checkNumber(o.maxSamples, 'maxSamples', 1, Infinity, 'pass 1 or more, or Infinity');
    if (v !== Infinity && !Number.isInteger(v))
      throw new RangeError(`VoxelPathTracer maxSamples ${v} must be a whole number or Infinity`);
    s.maxSamples = v;
  }
  if (o.seed !== undefined) s.seed = whole(o.seed, 'seed', 0, 0xffffffff, 'pass an integer 0 to 4294967295');
  if (o.resolutionScale !== undefined)
    s.resolutionScale = checkNumber(o.resolutionScale, 'resolutionScale', 0.1, 2, 'pass 0.1 to 2');
  if (o.exposure !== undefined) s.exposure = checkNumber(o.exposure, 'exposure', -20, 20, 'pass EV stops, -20 to 20');
  if (o.aperture !== undefined) s.aperture = checkNumber(o.aperture, 'aperture', 0, 1e6, 'pass a diameter, 0 or more');
  // null: automatic focus (camera position to target) again.
  if (o.focusDistance === null) s.focusDistance = undefined;
  else if (o.focusDistance !== undefined)
    s.focusDistance = checkNumber(
      o.focusDistance,
      'focusDistance',
      1e-6,
      1e9,
      'pass a distance above 0, or null for automatic focus',
    );
  if (o.denoise !== undefined) s.denoise = o.denoise === 'auto' ? 'auto' : flag(o.denoise, 'denoise');
  if (o.lensBlades !== undefined) {
    const v = whole(o.lensBlades, 'lensBlades', 0, 16, 'pass 0 (round) or 3 to 16');
    if (v === 1 || v === 2) throw new RangeError('VoxelPathTracer lensBlades must be 0 (round) or 3 to 16');
    s.lensBlades = v;
  }
  if (o.lensRotation !== undefined)
    s.lensRotation = checkNumber(o.lensRotation, 'lensRotation', -1e6, 1e6, 'pass radians');
  if (o.shutter !== undefined) s.shutter = checkNumber(o.shutter, 'shutter', 0, 1, 'pass 0 (off) to 1');
  if (o.clamp !== undefined) {
    const v = checkNumber(o.clamp, 'clamp', 0, Infinity, 'pass a luminance above 0, or Infinity');
    if (!(v > 0)) throw new RangeError('VoxelPathTracer clamp must be above 0 (Infinity turns it off)');
    s.clamp = v;
  }
  if (o.toneMapping !== undefined) {
    if (o.toneMapping !== 'neutral' && o.toneMapping !== 'linear' && o.toneMapping !== 'aces-narkowicz')
      throw new TypeError(
        `VoxelPathTracer toneMapping ${String(o.toneMapping)} is unknown; pass 'neutral', 'linear' or 'aces-narkowicz'`,
      );
    s.toneMapping = o.toneMapping;
  }
  if ('gamma' in o)
    s.gamma =
      o.gamma === undefined ? undefined : checkNumber(o.gamma, 'gamma', 1, 5, 'pass 1 to 5, or undefined for sRGB');
  if (o.bounceLimits !== undefined) s.bounceLimits = bounceLimits(o.bounceLimits);
  if (o.transparentShadows !== undefined) s.transparentShadows = flag(o.transparentShadows, 'transparentShadows');
  if (o.sunSpecular !== undefined) s.sunSpecular = flag(o.sunSpecular, 'sunSpecular');
  if (o.sunInMedia !== undefined) s.sunInMedia = flag(o.sunInMedia, 'sunInMedia');
  if (o.energyCompensation !== undefined) s.energyCompensation = flag(o.energyCompensation, 'energyCompensation');
  if (o.vignette !== undefined) s.vignette = checkNumber(o.vignette, 'vignette', 0, 100, 'pass 0 (off) or more');
  if (o.edges !== undefined) s.edges = edges(o.edges);
  if (o.grid !== undefined) s.grid = grid(o.grid);
  if (o.order !== undefined) s.order = checkNumber(o.order, 'order', -1e9, 1e9, 'pass a finite frame-graph order');
  if (o.previousCamera !== undefined) s.previousCamera = previousCamera(o.previousCamera);
  if (o.projection !== undefined) {
    if (o.projection !== 'camera' && o.projection !== 'panorama' && o.projection !== 'fisheye')
      throw new TypeError(
        `VoxelPathTracer projection ${String(o.projection)} is unknown; pass 'camera', 'panorama' or 'fisheye'`,
      );
    s.projection = o.projection;
  }
  if (o.fisheye !== undefined) {
    if (!o.fisheye || typeof o.fisheye !== 'object')
      throw new TypeError('VoxelPathTracer fisheye must be {mapping?, fov?}');
    const e = o.fisheye as Record<string, unknown>;
    if (e.mapping !== undefined && e.mapping !== 'equidistant' && e.mapping !== 'equisolid')
      throw new TypeError(
        `VoxelPathTracer fisheye.mapping ${String(e.mapping)} is unknown; pass 'equidistant' or 'equisolid'`,
      );
    s.fisheye = {
      mapping: (e.mapping as 'equidistant' | 'equisolid' | undefined) ?? 'equidistant',
      fov: e.fov === undefined ? 180 : checkNumber(e.fov, 'fisheye.fov', 1e-3, 360, 'pass degrees above 0 to 360'),
    };
  }
  if (o.distortion !== undefined) {
    if (o.distortion === null) s.distortion = undefined;
    else {
      if (typeof o.distortion !== 'object')
        throw new TypeError('VoxelPathTracer distortion must be {k1?, k2?, p1?, p2?} or null');
      const d = o.distortion as Record<string, unknown>,
        c = (k: string) => (d[k] === undefined ? 0 : checkNumber(d[k], `distortion.${k}`, -1, 1, 'pass -1 to 1'));
      s.distortion = { k1: c('k1'), k2: c('k2'), p1: c('p1'), p2: c('p2') };
    }
  }
  return s;
}

// A validated copy of a previous camera pose (undefined for null).
function previousCamera(value: unknown): TracePreviousCamera | undefined {
  if (value === null) return undefined;
  if (!value || typeof value !== 'object')
    throw new TypeError('VoxelPathTracer previousCamera must be {position, target, up?, fov?} or null');
  const c = value as Record<string, unknown>,
    position = checkVec3(c.position, 'previousCamera.position', false, 'pass a world point'),
    target = checkVec3(c.target, 'previousCamera.target', false, 'pass a world point'),
    up = c.up === undefined ? undefined : checkVec3(c.up, 'previousCamera.up', false, 'pass a direction'),
    fov = c.fov === undefined ? undefined : checkNumber(c.fov, 'previousCamera.fov', 1e-3, 179.999, 'pass degrees');
  if (position.every((v, i) => v === target[i]))
    throw new RangeError('VoxelPathTracer previousCamera.position equals its target; pass a distinct target');
  return { position, target, up, fov };
}

/** The public shape of resolved settings: copies, with uncapped bounce kinds absent. */
export function publicSettings(s: Settings): ResolvedTraceOptions {
  const caps = s.bounceLimits,
    cap = (v: number) => (v === BOUNCE_FREE ? undefined : v),
    out: Record<string, unknown> = {
      ...s,
      fisheye: { ...s.fisheye },
      bounceLimits: caps && { diffuse: cap(caps.diffuse), specular: cap(caps.specular), scatter: cap(caps.scatter) },
      edges: s.edges && { ...s.edges },
      grid: s.grid && { ...s.grid },
      previousCamera: s.previousCamera && { ...s.previousCamera },
      distortion: s.distortion && { ...s.distortion },
    };
  return out as unknown as ResolvedTraceOptions;
}

/** Settings from resolved public options (a resolved options object is itself a valid set of options). */
const fromPublic = (base: ResolvedTraceOptions | undefined): Settings => {
  if (base === undefined) return DEFAULTS;
  if (!base || typeof base !== 'object') throw new TypeError('VoxelPathTracer base options must be an object');
  return settings(base as Partial<Omit<VoxelPathTracerOptions, 'scene'>>, DEFAULTS);
};

/** Frozen defaults of every tracer option (`scene` excluded); fields absent here are off or automatic by default. */
export const VOXEL_PATHTRACER_DEFAULTS: Readonly<ResolvedTraceOptions> = Object.freeze(publicSettings(DEFAULTS));

/**
 * Resolves `options` over `base` (default: {@link VOXEL_PATHTRACER_DEFAULTS}) exactly as `attach` and `setOptions` do,
 * without an engine or GPU: the options a tracer would then run with, defaults filled in. Fields left out or
 * `undefined` keep the base's value; `null` turns off `previousCamera`, `distortion`, `bounceLimits`, `edges` and
 * `grid`, and returns `focusDistance` to automatic focus. `scene` is not an option here.
 * @throws TypeError / RangeError naming the first invalid option and its fix (as `setOptions` would).
 */
export function resolveTraceOptions(
  options: Partial<Omit<VoxelPathTracerOptions, 'scene'>>,
  base?: Readonly<ResolvedTraceOptions>,
): ResolvedTraceOptions {
  if (options && typeof options === 'object' && 'scene' in options)
    throw new TypeError('VoxelPathTracer options here do not take a scene; validate the scene with setScene');
  return publicSettings(settings(options, fromPublic(base)));
}

/**
 * Checks every option of `options` without throwing: `ok` is true exactly when `setOptions(options)` (and `attach`
 * with them) would accept them. Each invalid option is listed with the error `setOptions` would throw for it; names
 * that are not options (which `setOptions` ignores) are listed in `unknown` and do not make `ok` false.
 */
export function validateTraceOptions(options: unknown): TraceValidation {
  if (!options || typeof options !== 'object')
    return {
      ok: false,
      problems: [{ field: '', error: new TypeError('VoxelPathTracer options must be an object') }],
      unknown: [],
    };
  const problems: TraceProblem[] = [],
    unknown: string[] = [],
    o = options as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key === 'scene') continue;
    if (!(OPTION_NAMES as readonly string[]).includes(key)) {
      unknown.push(key);
      continue;
    }
    try {
      settings({ [key]: o[key] }, DEFAULTS);
    } catch (error) {
      problems.push({ field: key, error: error as TypeError | RangeError });
    }
  }
  return { ok: problems.length === 0, problems, unknown };
}

/** Settings with the named options (all when omitted) back at their defaults; throws for a name that is no option. */
export function resetSettings(s: Settings, names: unknown): Settings {
  if (names === undefined) return { ...DEFAULTS };
  if (names === null || typeof names !== 'object' || !(Symbol.iterator in names))
    throw new TypeError('VoxelPathTracer resetOptions takes a list of option names, or nothing for all of them');
  const next = { ...s } as Record<string, unknown>;
  for (const name of names as Iterable<unknown>) {
    if (typeof name !== 'string' || !(OPTION_NAMES as readonly string[]).includes(name))
      throw new TypeError(
        `VoxelPathTracer resetOptions: ${String(name)} is not an option; pass names such as 'focusDistance' or 'exposure'`,
      );
    next[name] = DEFAULTS[name as keyof Settings];
  }
  return next as unknown as Settings;
}

/**
 * Resolves one material as the tracer would: validated, with the defaults of its type filled in (see
 * {@link ResolvedTraceMaterial}); needs no engine or GPU. With `textures` (the scene's texture count) texture indices
 * are checked against it as `setScene` does; without it only their shape is.
 * @throws TypeError / RangeError naming the first invalid field and its fix (as `setScene` would).
 */
export function resolveTraceMaterial(material: TraceMaterial, textures?: number): ResolvedTraceMaterial {
  if (textures !== undefined) whole(textures, 'textures', 0, 4096, 'pass the scene texture count, 0 to 4096');
  return resolveMaterial(material, 'material', textures);
}

// Fields every material check needs; each other field is checked on a material made of these and it alone.
const MATERIAL_BASE = ['id', 'type', 'color'] as const;
const MATERIAL_FIELDS = [
  'roughness',
  'metalness',
  'emission',
  'emissionColor',
  'cameraEmission',
  'sunlit',
  'voxelwise',
  'contactTransmission',
  'texture',
  'cutout',
  'ior',
  'transmission',
  'density',
  'specular',
  'scatter',
  'anisotropy',
  'abbe',
  'metalColor',
  'coat',
  'tint',
] as const;

/**
 * Checks every field of a material without throwing: `ok` is true exactly when `setScene` would accept it (given
 * `textures` textures; texture indices are checked for shape only without it). Each invalid field is listed with
 * the error `setScene` would throw for it; unknown fields, which the tracer ignores, are listed in `unknown`.
 */
export function validateTraceMaterial(material: unknown, textures?: number): TraceValidation {
  if (!material || typeof material !== 'object')
    return {
      ok: false,
      problems: [{ field: '', error: new TypeError('VoxelPathTracer material must be an object {id, color, type}') }],
      unknown: [],
    };
  const m = material as Record<string, unknown>,
    problems: TraceProblem[] = [],
    stand = { id: 1, type: 'diffuse', color: [1, 1, 1] } as Record<string, unknown>,
    check = (probe: Record<string, unknown>, field: string) => {
      try {
        resolveMaterial(probe as unknown as TraceMaterial, 'material', textures);
        return true;
      } catch (error) {
        problems.push({ field, error: error as TypeError | RangeError });
        return false;
      }
    };
  for (const field of MATERIAL_BASE) if (check({ ...stand, [field]: m[field] }, field)) stand[field] = m[field];
  for (const field of Object.keys(m))
    if ((MATERIAL_FIELDS as readonly string[]).includes(field) && m[field] !== undefined)
      check({ ...stand, [field]: m[field] }, field);
  const known = [...MATERIAL_BASE, ...MATERIAL_FIELDS] as readonly string[];
  return { ok: problems.length === 0, problems, unknown: Object.keys(m).filter((k) => !known.includes(k)) };
}
