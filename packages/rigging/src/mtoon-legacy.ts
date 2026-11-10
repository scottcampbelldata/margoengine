import type { VRM0Material } from './vrm0.js';
import type { MToonColor, MToonDefinition, MToonTextureInfo } from './mtoon-data.js';

export interface LegacyMToon {
  definition: MToonDefinition;
  queue: number;
  mode: number;
  side: 'front' | 'back' | 'double';
  base: number[];
  emission: number[];
  baseTexture?: MToonTextureInfo;
  normalTexture?: MToonTextureInfo;
  emissionTexture?: MToonTextureInfo;
  normalScale: number;
  cutoff: number;
}
const bad = (field: string) =>
  new RangeError(`Invalid legacy MToon ${field}; repair the material. See https://margoengine.com/errors#material`);
/** Consortium runtime migration, checked against public latest-loader values for all Alicia materials. */
export function legacyMToon(material: VRM0Material): LegacyMToon | undefined {
  if (material.shader !== 'VRM/MToon') return;
  const floats = material.floatProperties ?? {},
    vectors = material.vectorProperties ?? {},
    textures = material.textureProperties ?? {};
  const number = (key: string, fallback: number, min = -Infinity, max = Infinity): number => {
    const n = floats[key] ?? fallback;
    if (!Number.isFinite(Math.fround(n)) || n < min || n > max) throw bad(key);
    return n;
  };
  const color = (key: string, fallback: MToonColor): MToonColor => {
    const v = vectors[key] ?? fallback;
    if (v.length < 3 || v.slice(0, 3).some((x) => !Number.isFinite(x) || x < 0 || x > 1)) throw bad(key);
    return [v[0] ** 2.2, v[1] ** 2.2, v[2] ** 2.2];
  };
  const map = (key: string): MToonTextureInfo | undefined => {
    const index = textures[key];
    if (index === undefined || index === -1) return;
    if (!Number.isSafeInteger(index) || index < 0) throw bad(key);
    const st = vectors[key] ?? [0, 0, 1, 1];
    if (st.length !== 4 || st.some((x) => !Number.isFinite(Math.fround(x)))) throw bad(key);
    return {
      index,
      extensions: { KHR_texture_transform: { scale: [st[2], st[3]], offset: [st[0], 1 - st[3] - st[1]] } },
    };
  };
  const shift = number('_ShadeShift', 0, -1, 1),
    toony = number('_ShadeToony', 0.9, 0, 1),
    upper = 1 - toony + toony * shift;
  const mode = number('_BlendMode', 0, 0, 3),
    outline = number('_OutlineWidthMode', 0, 0, 2),
    cull = number('_CullMode', 2, 0, 2);
  if (!Number.isInteger(mode) || !Number.isInteger(outline) || !Number.isInteger(cull)) throw bad('enum');
  const definition: MToonDefinition = {
    specVersion: '1.0',
    transparentWithZWrite: mode === 3,
    shadeColorFactor: color('_ShadeColor', [1, 1, 1]),
    shadeMultiplyTexture: map('_ShadeTexture') ?? map('_MainTex'),
    shadingShiftFactor: -(shift + upper) / 2,
    shadingToonyFactor: 1 - (upper - shift) / 2,
    giEqualizationFactor: 1 - number('_IndirectLightIntensity', 0.1, 0, 1),
    matcapFactor: [1, 1, 1],
    matcapTexture: map('_SphereAdd'),
    parametricRimColorFactor: color('_RimColor', [0, 0, 0]),
    rimMultiplyTexture: map('_RimTexture'),
    parametricRimFresnelPowerFactor: number('_RimFresnelPower', 1, 0),
    parametricRimLiftFactor: number('_RimLift', 0),
    rimLightingMixFactor: number('_RimLightingMix', 0, 0, 1),
    outlineWidthMode: ['none', 'worldCoordinates', 'screenCoordinates'][outline] as MToonDefinition['outlineWidthMode'],
    outlineWidthFactor: number('_OutlineWidth', 0, 0) * 0.01,
    outlineWidthMultiplyTexture: map('_OutlineWidthTexture'),
    outlineColorFactor: color('_OutlineColor', [0, 0, 0]),
    outlineLightingMixFactor: number('_OutlineColorMode', 0) === 0 ? 0 : number('_OutlineLightingMix', 1, 0, 1),
    uvAnimationMaskTexture: map('_UvAnimMaskTexture'),
    uvAnimationScrollXSpeedFactor: number('_UvAnimScrollX', 0),
    uvAnimationScrollYSpeedFactor: -number('_UvAnimScrollY', 0),
    uvAnimationRotationSpeedFactor: number('_UvAnimRotation', 0),
  };
  const queue =
    material.renderQueue === undefined || material.renderQueue === -1
      ? mode === 0
        ? 2000
        : mode === 1
          ? 2450
          : mode === 3
            ? 2500
            : 3000
      : material.renderQueue;
  if (!Number.isInteger(queue) || queue < 0 || queue > 5000) throw bad('renderQueue');
  const rawBase = vectors._Color ?? [1, 1, 1, 1],
    rawEmission = vectors._EmissionColor ?? [0, 0, 0, 1];
  if (
    rawBase.length !== 4 ||
    rawBase.some((x) => !Number.isFinite(x) || x < 0 || x > 1) ||
    rawEmission.length < 3 ||
    rawEmission.slice(0, 3).some((x) => !Number.isFinite(Math.fround(x)) || x < 0)
  )
    throw bad('base/emission');
  const emission = rawEmission.slice(0, 3).map((x) => x ** 2.2);
  if (emission.some((x) => !Number.isFinite(Math.fround(x)))) throw bad('linear emission');
  return {
    definition,
    queue,
    base: [...color('_Color', [1, 1, 1]), rawBase[3]],
    emission,
    baseTexture: map('_MainTex'),
    normalTexture: map('_BumpMap'),
    emissionTexture: map('_EmissionMap'),
    normalScale: number('_BumpScale', 1),
    cutoff: number('_Cutoff', 0.5, 0, 1),
    mode: mode === 3 ? 2 : mode,
    side: cull === 0 ? 'double' : cull === 1 ? 'back' : 'front',
  };
}
