import type { MaterialExtension, MaterialExtensionTexture } from '@margoengine/gltf-pro';
import { textureCoordinates } from '@margoengine/gltf-pro';
import type { ClearcoatTexture } from './index.js';
import { coordinateSlot, coordinateWGSL } from './coordinates.js';
import { lobeShader, type LobeShaderConfig } from './lobe-shader.js';

export interface SheenOptions {
  colorFactor?: readonly [number, number, number];
  roughnessFactor?: number;
  sheenColorTexture?: ClearcoatTexture;
  sheenRoughnessTexture?: ClearcoatTexture;
}
export interface SpecularOptions {
  factor?: number;
  colorFactor?: readonly [number, number, number];
  specularTexture?: ClearcoatTexture;
  specularColorTexture?: ClearcoatTexture;
}
export interface AnisotropyOptions {
  strength?: number;
  rotation?: number;
  anisotropyTexture?: ClearcoatTexture;
}
export interface IridescenceOptions {
  factor?: number;
  ior?: number;
  thicknessMinimum?: number;
  thicknessMaximum?: number;
  iridescenceTexture?: ClearcoatTexture;
  iridescenceThicknessTexture?: ClearcoatTexture;
}
export interface MaterialLobeOptions {
  ior?: number;
  sheen?: SheenOptions;
  specular?: SpecularOptions;
  anisotropy?: AnisotropyOptions;
  iridescence?: IridescenceOptions;
}
export const lobeMaps = {
  sheen: ['sheenColorTexture', 'sheenRoughnessTexture'],
  specular: ['specularTexture', 'specularColorTexture'],
  anisotropy: ['anisotropyTexture'],
  iridescence: ['iridescenceTexture', 'iridescenceThicknessTexture'],
} as const;
const compiled = new WeakMap<MaterialExtension, { options: MaterialLobeOptions; base?: MaterialExtension }>();
function record(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid material ' + label);
}
function scalar(value: unknown, fallback: number, label: string, min = 0, max = 1): number {
  const number = value === undefined ? fallback : value;
  if (typeof number !== 'number' || !Number.isFinite(Math.fround(number)) || number < min || number > max)
    throw new RangeError('Invalid material ' + label);
  return number;
}
function color(
  value: unknown,
  fallback: readonly [number, number, number],
  label: string,
  max = 1,
): readonly [number, number, number] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    Array.from(value).some((n) => typeof n !== 'number' || !Number.isFinite(Math.fround(n)) || n < 0 || n > max)
  )
    throw new RangeError('Invalid material ' + label);
  return value as [number, number, number];
}
export function validateLobes(options: MaterialLobeOptions): MaterialLobeOptions {
  record(options, 'lobes');
  const result: MaterialLobeOptions = { ior: scalar(options.ior, 1.5, 'IOR', 1, Infinity) };
  for (const key of Object.keys(lobeMaps) as (keyof typeof lobeMaps)[])
    if (options[key] !== undefined) {
      record(options[key], key);
      const value = options[key]!;
      for (const field of lobeMaps[key]) {
        const map = (value as Record<string, ClearcoatTexture>)[field];
        if (map === undefined) continue;
        record(map, field);
        if (!map.view || (map.sampler !== undefined && !map.sampler))
          throw new TypeError('Invalid material ' + field + ' texture');
        textureCoordinates({ texCoord: map.texCoord, extensions: { KHR_texture_transform: map.transform } });
      }
    }
  if (options.sheen) {
    const v = options.sheen;
    result.sheen = {
      ...v,
      colorFactor: color(v.colorFactor, [0, 0, 0], 'sheen color'),
      roughnessFactor: scalar(v.roughnessFactor, 0, 'sheen roughness'),
    };
  }
  if (options.specular) {
    const v = options.specular;
    result.specular = {
      ...v,
      colorFactor: color(v.colorFactor, [1, 1, 1], 'specular color', Infinity),
      factor: scalar(v.factor, 1, 'specular factor'),
    };
  }
  if (options.anisotropy) {
    const v = options.anisotropy;
    result.anisotropy = {
      ...v,
      strength: scalar(v.strength, 0, 'anisotropy strength'),
      rotation: scalar(v.rotation, 0, 'anisotropy rotation', -Infinity, Infinity),
    };
  }
  if (options.iridescence) {
    const v = options.iridescence;
    result.iridescence = {
      ...v,
      factor: scalar(v.factor, 0, 'iridescence factor'),
      ior: scalar(v.ior, 1.3, 'iridescence IOR', 1, Infinity),
      thicknessMinimum: scalar(v.thicknessMinimum, 100, 'iridescence minimum thickness', 0, Infinity),
      thicknessMaximum: scalar(v.thicknessMaximum, 400, 'iridescence maximum thickness', 0, Infinity),
    };
  }
  return result;
}

/** Compose optional lobes in one group 3 block, retaining any clearcoat/output hooks. */
export function materialLobes(options: MaterialLobeOptions = {}, base?: MaterialExtension): MaterialExtension {
  if (base !== undefined) {
    record(base, 'base extension');
    const factors = base.factors;
    if (
      factors !== undefined &&
      (!(factors instanceof Float32Array) ||
        !factors.length ||
        factors.length % 4 ||
        factors.some((value) => !Number.isFinite(value)))
    )
      throw new TypeError('Material extension factors require finite vec4 values');
  }
  const previous = base && compiled.get(base);
  if (previous) {
    options = { ...previous.options, ...options };
    base = previous.base;
  }
  const values = validateLobes(options),
    factors = [...(base?.factors ?? [])],
    textures: MaterialExtensionTexture[] = [...(base?.textures ?? [])],
    config: LobeShaderConfig = { ior: values.ior, coordinateHelper: false };
  let transformed = false;
  const slot = (map?: ClearcoatTexture) => {
    if (!map) return undefined;
    let index = textures.findIndex((value) => value.view === map.view && value.sampler === map.sampler);
    if (index < 0) {
      index = textures.length;
      textures.push({ view: map.view, ...(map.sampler ? { sampler: map.sampler } : {}) });
    }
    const coordinates = coordinateSlot(map, factors);
    transformed ||= coordinates.transformIndex !== undefined;
    return { index, ...coordinates, sampler: !!map.sampler };
  };
  if (values.sheen) {
    const v = values.sheen,
      index = factors.length / 4;
    factors.push(...v.colorFactor!, v.roughnessFactor!);
    config.sheen = { index, color: slot(v.sheenColorTexture), roughness: slot(v.sheenRoughnessTexture) };
  }
  if (values.specular) {
    const v = values.specular,
      index = factors.length / 4;
    factors.push(...v.colorFactor!, v.factor!);
    config.specular = { index, color: slot(v.specularColorTexture), factor: slot(v.specularTexture) };
  }
  if (values.anisotropy) {
    const v = values.anisotropy,
      index = factors.length / 4;
    factors.push(v.strength!, v.rotation!, 0, 0);
    config.anisotropy = { index, texture: slot(v.anisotropyTexture) };
  }
  if (values.iridescence) {
    const v = values.iridescence,
      index = factors.length / 4;
    factors.push(v.factor!, v.ior!, v.thicknessMinimum!, v.thicknessMaximum!);
    config.iridescence = { index, factor: slot(v.iridescenceTexture), thickness: slot(v.iridescenceThicknessTexture) };
  }
  if (!config.sheen && !config.specular && !config.anisotropy && !config.iridescence) return base ?? {};
  const shader = lobeShader(config),
    helper = transformed && !base?.declarations?.includes('fn materialUV(') ? coordinateWGSL : '';
  const extension: MaterialExtension = {
    ...base,
    wgsl: [base?.wgsl, shader.wgsl].filter(Boolean).join('\n'),
    direct: [shader.direct, base?.direct].filter(Boolean).join('\n'),
    ambient: [shader.ambient, base?.ambient].filter(Boolean).join('\n'),
    declarations: (base?.declarations ?? '') + '\n' + helper + shader.declarations,
    factors: Float32Array.from(factors),
    ...(textures.length ? { textures } : {}),
  };
  compiled.set(extension, { options: values, base });
  return extension;
}
export function sheen(options: SheenOptions = {}, base?: MaterialExtension): MaterialExtension {
  return materialLobes({ sheen: options }, base);
}
export function specular(options: SpecularOptions = {}, base?: MaterialExtension): MaterialExtension {
  return materialLobes({ specular: options }, base);
}
export function anisotropy(options: AnisotropyOptions = {}, base?: MaterialExtension): MaterialExtension {
  return materialLobes({ anisotropy: options }, base);
}
export function iridescence(options: IridescenceOptions = {}, base?: MaterialExtension): MaterialExtension {
  return materialLobes({ iridescence: options }, base);
}
