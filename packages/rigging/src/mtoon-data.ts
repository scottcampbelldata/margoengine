import type { GLTFTextureInfo } from '../../shared/gltf.js';
/** Linear RGB components, each from zero through one. */
export type MToonColor = readonly [number, number, number];
/** glTF texture lookup with a per-map UV transform and optional shading-shift scale. */
export interface MToonTextureInfo extends GLTFTextureInfo {
  index: number;
  texCoord?: number;
  scale?: number;
  extensions?: {
    KHR_texture_transform?: {
      offset?: readonly [number, number];
      scale?: readonly [number, number];
      rotation?: number;
      texCoord?: number;
    };
  };
}
/** Authored VRMC_materials_mtoon 1.0 fields. Texture ownership stays with the loaded model. */
export interface MToonDefinition {
  specVersion: '1.0';
  transparentWithZWrite?: boolean;
  renderQueueOffsetNumber?: number;
  shadeColorFactor?: MToonColor;
  shadeMultiplyTexture?: MToonTextureInfo;
  shadingShiftFactor?: number;
  shadingShiftTexture?: MToonTextureInfo;
  shadingToonyFactor?: number;
  giEqualizationFactor?: number;
  matcapFactor?: MToonColor;
  matcapTexture?: MToonTextureInfo;
  parametricRimColorFactor?: MToonColor;
  parametricRimFresnelPowerFactor?: number;
  parametricRimLiftFactor?: number;
  rimMultiplyTexture?: MToonTextureInfo;
  rimLightingMixFactor?: number;
  outlineWidthMode?: 'none' | 'worldCoordinates' | 'screenCoordinates';
  outlineWidthFactor?: number;
  outlineWidthMultiplyTexture?: MToonTextureInfo;
  outlineColorFactor?: MToonColor;
  outlineLightingMixFactor?: number;
  uvAnimationMaskTexture?: MToonTextureInfo;
  uvAnimationScrollXSpeedFactor?: number;
  uvAnimationScrollYSpeedFactor?: number;
  uvAnimationRotationSpeedFactor?: number;
}

const scalarDefaults = {
  shadingShiftFactor: 0,
  shadingToonyFactor: 0.9,
  giEqualizationFactor: 0.9,
  parametricRimFresnelPowerFactor: 5,
  parametricRimLiftFactor: 0,
  rimLightingMixFactor: 1,
  outlineWidthFactor: 0,
  outlineLightingMixFactor: 1,
  uvAnimationScrollXSpeedFactor: 0,
  uvAnimationScrollYSpeedFactor: 0,
  uvAnimationRotationSpeedFactor: 0,
  renderQueueOffsetNumber: 0,
} as const;
const mapFields = [
  'shadeMultiplyTexture',
  'shadingShiftTexture',
  'matcapTexture',
  'rimMultiplyTexture',
  'outlineWidthMultiplyTexture',
  'uvAnimationMaskTexture',
] as const;
const colorDefaults = {
  shadeColorFactor: [0, 0, 0],
  matcapFactor: [1, 1, 1],
  parametricRimColorFactor: [0, 0, 0],
  outlineColorFactor: [0, 0, 0],
} as const;
type Normalized = MToonDefinition &
  Required<
    Pick<
      MToonDefinition,
      keyof typeof scalarDefaults | keyof typeof colorDefaults | 'outlineWidthMode' | 'transparentWithZWrite'
    >
  >;
const finite = (value: unknown, label: string, min = -Infinity, max = Infinity): number => {
  if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)) || value < min || value > max)
    throw new RangeError(
      `Invalid MToon ${label}; use a finite float32 number in the documented range. See https://margoengine.com/errors#material`,
    );
  return value;
};
/** Validate before allocating GPU resources; return independent factor arrays. */
export function normalizeMToon(input: MToonDefinition): Normalized {
  if (!input || typeof input !== 'object' || input.specVersion !== '1.0')
    throw new TypeError(
      'MToon requires specVersion 1.0; migrate legacy VRM materials before installation. See https://margoengine.com/errors#material',
    );
  const result: Record<string, unknown> = { ...input };
  for (const [key, fallback] of Object.entries(scalarDefaults)) {
    const unit = [
      'shadingToonyFactor',
      'giEqualizationFactor',
      'rimLightingMixFactor',
      'outlineLightingMixFactor',
    ].includes(key);
    const positive = key === 'outlineWidthFactor' || key === 'parametricRimFresnelPowerFactor';
    result[key] = finite(
      input[key as keyof MToonDefinition] ?? fallback,
      key,
      unit || positive ? 0 : -Infinity,
      unit ? 1 : Infinity,
    );
  }
  if (!Number.isInteger(result.renderQueueOffsetNumber) || Math.abs(result.renderQueueOffsetNumber as number) > 9)
    throw new RangeError(
      'MToon renderQueueOffsetNumber must be an integer from -9 through 9. See https://margoengine.com/errors#material',
    );
  for (const [key, fallback] of Object.entries(colorDefaults)) {
    const value = input[key as keyof MToonDefinition] ?? fallback;
    if (!Array.isArray(value) || value.length !== 3)
      throw new TypeError(
        `MToon ${key} needs three linear colour channels. See https://margoengine.com/errors#material`,
      );
    result[key] = value.map((channel) => finite(channel, key, 0, 1));
  }
  const mode = input.outlineWidthMode ?? 'none';
  if (!['none', 'worldCoordinates', 'screenCoordinates'].includes(mode))
    throw new TypeError(
      'MToon outlineWidthMode must be none, worldCoordinates or screenCoordinates. See https://margoengine.com/errors#material',
    );
  result.outlineWidthMode = mode;
  if (input.transparentWithZWrite !== undefined && typeof input.transparentWithZWrite !== 'boolean')
    throw new TypeError('MToon transparentWithZWrite must be a boolean. See https://margoengine.com/errors#material');
  result.transparentWithZWrite = input.transparentWithZWrite ?? false;
  for (const key of mapFields) {
    const value = input[key];
    if (value === undefined) continue;
    if (
      !value ||
      typeof value !== 'object' ||
      !Number.isSafeInteger(value.index) ||
      value.index < 0 ||
      (value.texCoord !== undefined &&
        (!Number.isSafeInteger(value.texCoord) || value.texCoord < 0 || value.texCoord > 3))
    )
      throw new TypeError(
        `MToon ${key} requires a valid texture index and TEXCOORD_0 through TEXCOORD_3. See https://margoengine.com/errors#material`,
      );
    if (value.scale !== undefined) finite(value.scale, key + '.scale');
    const transform = value.extensions?.KHR_texture_transform;
    if (transform !== undefined) {
      if (!transform || typeof transform !== 'object' || Array.isArray(transform))
        throw new TypeError(
          `MToon ${key} texture transform must be an object. See https://margoengine.com/errors#material`,
        );
      for (const field of ['offset', 'scale'] as const) {
        const channels = transform[field];
        if (channels === undefined) continue;
        if (!Array.isArray(channels) || channels.length !== 2)
          throw new TypeError(
            `MToon ${key} ${field} needs two finite numbers. See https://margoengine.com/errors#material`,
          );
        for (const channel of channels) finite(channel, `${key}.${field}`);
      }
      if (transform.rotation !== undefined) finite(transform.rotation, `${key}.rotation`);
      if (
        transform.texCoord !== undefined &&
        (!Number.isSafeInteger(transform.texCoord) || transform.texCoord < 0 || transform.texCoord > 3)
      )
        throw new RangeError(
          `MToon ${key} texture transform requires TEXCOORD_0 through TEXCOORD_3. See https://margoengine.com/errors#material`,
        );
    }
    result[key] = structuredClone(value);
  }
  return result as unknown as Normalized;
}

/** Independent scalar oracle for the specification's direct-light transition. */
export function mtoonShading(cosine: number, shift = 0, toony = 0.9): number {
  finite(cosine, 'cosine', -1, 1);
  finite(shift, 'shift');
  finite(toony, 'toony', 0, 1);
  const width = 1 - toony,
    coordinate = cosine + shift;
  return width === 0 ? +(coordinate >= 0) : Math.min(1, Math.max(0, (coordinate + width) / (2 * width)));
}

/** The six MToon maps in uniform and binding order. */
export const MTOON_MAP_FIELDS = [
  'shadeMultiplyTexture',
  'shadingShiftTexture',
  'matcapTexture',
  'rimMultiplyTexture',
  'outlineWidthMultiplyTexture',
  'uvAnimationMaskTexture',
] as const;
type MapField = (typeof MTOON_MAP_FIELDS)[number];

/**
 * The 1x1 RGBA8 texel a map samples while it has no image (absent, or streamed and not yet arrived). VRMC_materials_mtoon
 * 1.0: an undefined matcapTexture "must be sampled as having 0.0 in RGB components", and an undefined shading shift adds
 * nothing, so both are black; the multiply maps and the UV animation mask are white (no change).
 */
export function fallbackTexel(field: MapField): Uint8Array {
  return new Uint8Array(
    field === 'matcapTexture' || field === 'shadingShiftTexture' ? [0, 0, 0, 255] : [255, 255, 255, 255],
  );
}

/** One map's three uniform rows: its KHR_texture_transform with expression moves blended in, texCoord, scale, presence. */
export function textureRows(
  v: Float32Array,
  row: number,
  map: MToonTextureInfo | undefined,
  moves: readonly { scale: readonly number[]; offset: readonly number[]; value: number }[],
): void {
  const t = map?.extensions?.KHR_texture_transform,
    offset = [...(t?.offset ?? [0, 0])],
    scale = [...(t?.scale ?? [1, 1])],
    angle = t?.rotation ?? 0,
    c = Math.cos(angle),
    s = Math.sin(angle);
  for (let k = 0; k < 2; k++) {
    const baseOffset = offset[k],
      baseScale = scale[k];
    for (const move of moves) {
      offset[k] += (move.offset[k] - baseOffset) * move.value;
      scale[k] += (move.scale[k] - baseScale) * move.value;
    }
  }
  v.set(
    [
      c * scale[0],
      s * scale[1],
      offset[0],
      t?.texCoord ?? map?.texCoord ?? 0,
      -s * scale[0],
      c * scale[1],
      offset[1],
      0,
      map?.scale ?? 1,
      +!!map,
      0,
      0,
    ],
    row * 4,
  );
}

/**
 * Writes every map's rows into the uniform `v` from row 8. VRM 1.0 expressions.md: a textureTransformBind applies to
 * the material's UV-accessed textures, and "the texture that does not have UV access is MToon's matcap", so the
 * matcap keeps its own transform and takes no expression move.
 */
export function mapRows(
  v: Float32Array,
  definition: Partial<Record<MapField, MToonTextureInfo | undefined>>,
  moves: readonly { scale: readonly number[]; offset: readonly number[]; value: number }[],
): void {
  MTOON_MAP_FIELDS.forEach((field, k) =>
    textureRows(v, 8 + k * 3, definition[field], field === 'matcapTexture' ? [] : moves),
  );
}

/** glTF CLAMP_TO_EDGE: a sampler axis the UV animation's scroll cannot be wrapped on. */
const CLAMP = 33071;
const scratchRows = new Float32Array(12);

/**
 * Whether the UV animation's scroll along `axis` (0 for x, 1 for y) may be taken modulo 2 without changing what `map`
 * samples. VRMC_materials_mtoon 1.0 animates before KHR_texture_transform and leaves the UV unclamped and unrepeated,
 * assuming REPEAT or MIRRORED_REPEAT wrapping; a whole number step of the transform's column through a repeating axis
 * of the sampler then moves the sampled UV by an even whole number, which samples the same texel under both. A
 * fractional column (a scale such as 0.5, a rotation) or a clamped axis it reaches keeps the full scroll.
 */
export function scrollWraps(
  map: MToonTextureInfo | undefined,
  wrap: readonly [number | undefined, number | undefined],
  axis: 0 | 1,
  moves: readonly { scale: readonly number[]; offset: readonly number[]; value: number }[] = [],
): boolean {
  if (!map) return true;
  textureRows(scratchRows, 0, map, moves);
  for (let k = 0; k < 2; k++) {
    const step = scratchRows[k * 4 + axis];
    if (step !== 0 && (!Number.isInteger(step) || wrap[k] === CLAMP)) return false;
  }
  return true;
}

/**
 * The UV animation's phases at `time` seconds, in float64, as the MToon shaders read them: scroll x and y in UV units
 * and rotation in turns, each split into a whole count `k` and a phase so the shader forms phase x mask +
 * period x fract(k x mask) with small numbers. Scroll uses period 2 where `wrapX` / `wrapY` allow it (`scrollWraps`)
 * and keeps the whole scroll as its phase otherwise; rotation always uses period 1 turn. Writes
 * [phaseX, phaseY, phaseTurns, kX, kY, kTurns] to `out`.
 */
export function uvAnimationPhases(
  out: { [index: number]: number },
  speeds: readonly [number, number, number],
  time: number,
  wrapX: boolean,
  wrapY: boolean,
): void {
  const scroll = (speed: number, wraps: boolean, k: number) => {
    const s = speed * time,
      whole = wraps ? Math.floor(s / 2) : 0;
    out[k] = s - 2 * whole;
    out[k + 3] = whole;
  };
  scroll(speeds[0], wrapX, 0);
  scroll(speeds[1], wrapY, 1);
  const turns = (speeds[2] * time) / (2 * Math.PI),
    whole = Math.floor(turns);
  out[2] = turns - whole;
  out[5] = whole;
}
