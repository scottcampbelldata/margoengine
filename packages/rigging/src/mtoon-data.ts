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
