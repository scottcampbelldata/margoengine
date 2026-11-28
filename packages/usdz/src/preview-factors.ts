// A UsdUVTexture's `scale` and `bias` and UsdPreviewSurface's emission and occlusion as glTF material values, for the
// default importer and previewSurface(). A texture reads `texel * scale + bias` (UsdPreviewSurface specification, Pixar,
// https://openusd.org/release/spec_usdpreviewsurface.html). Where glTF has a factor that holds that, the file's image
// is kept; otherwise the two are written into the pixels when the model is created.
import type { GLTFDocument, GLTFMaterial } from '../../shared/gltf.js';
import { LinearToSRGB, SRGBToLinear } from '@margoengine/math/color';
import type { SurfaceRead, USDImage } from './extension.js';
import type { PhysicalMap } from './preview-physical.js';

/** A UsdUVTexture of the surface. `raw` is a stated raw colour space, which a colour input would otherwise decode. */
export interface ShaderMap extends PhysicalMap {
  raw?: boolean;
}
type Info = ReturnType<SurfaceRead['image']>;
type Mapped = (source: USDImage, map: ShaderMap) => Info;
/** The textures a surface reads, and the constants of the inputs that have none. */
export interface SurfaceMaps {
  diffuse?: ShaderMap;
  /** The opacity map, when it is the base colour texture's own alpha. */
  alpha?: ShaderMap;
  normal?: ShaderMap;
  rough?: ShaderMap;
  metal?: ShaderMap;
  occlusion?: ShaderMap;
  emit?: ShaderMap;
  /** `inputs:emissiveColor` without a texture. */
  emissive: readonly number[];
}

const unit = (v: number): boolean => v >= 0 && v <= 1;
const clamp = (v: number): number => Math.min(1, Math.max(0, v));
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/** The base colour texture and the factor beside it; `opacity` is the factor of an alpha the texture does not drive. */
function baseColor(
  map: ShaderMap,
  alpha: ShaderMap | undefined,
  opacity: number,
): { source: USDImage; factor: [number, number, number, number] } {
  const rgb = [0, 1, 2],
    plain = rgb.every((c) => !map.bias[c] && unit(map.scale[c])),
    // The opacity map's scale and bias, for its alpha channel.
    scale = alpha ? alpha.scale[3] : 0,
    bias = alpha ? alpha.bias[3] : 1,
    held = !!alpha && !bias && unit(scale);
  if (plain && (!alpha || held))
    return {
      source: { path: map.path, ...(map.raw ? { linearColor: true } : {}) },
      factor: [map.scale[0], map.scale[1], map.scale[2], alpha ? scale : opacity],
    };
  return {
    source: {
      path: map.path,
      color: {
        scale: [...(plain ? [1, 1, 1] : rgb.map((c) => map.scale[c])), held ? 1 : scale],
        bias: [...(plain ? [0, 0, 0] : rgb.map((c) => map.bias[c])), held ? 0 : bias],
        srgb: !map.raw,
      },
    },
    factor: [
      ...((plain ? [map.scale[0], map.scale[1], map.scale[2]] : [1, 1, 1]) as [number, number, number]),
      held ? scale : alpha ? 1 : opacity,
    ],
  };
}

/** An emission map: glTF's factor holds 0 to 1, and KHR_materials_emissive_strength what is brighter. */
function emission(map: ShaderMap): { source: USDImage; factor: [number, number, number]; strength: number } {
  const rgb = [0, 1, 2];
  if (rgb.every((c) => !map.bias[c] && map.scale[c] >= 0)) {
    const strength = Math.max(1, ...rgb.map((c) => map.scale[c]));
    return {
      source: { path: map.path, ...(map.raw ? { linearColor: true } : {}) },
      factor: rgb.map((c) => map.scale[c] / strength) as [number, number, number],
      strength,
    };
  }
  const strength = Math.max(1, ...rgb.flatMap((c) => [map.bias[c], map.scale[c] + map.bias[c]]));
  return {
    source: {
      path: map.path,
      color: {
        scale: [...rgb.map((c) => map.scale[c] / strength), 0],
        bias: [...rgb.map((c) => map.bias[c] / strength), 1],
        srgb: !map.raw,
      },
    },
    factor: [1, 1, 1],
    strength,
  };
}

/** One of roughness and metalness: the channel read and its factor, or its conversion. */
function scalarPart(map: ShaderMap): {
  part: NonNullable<USDImage['roughness']>;
  remap?: NonNullable<USDImage['roughnessRemap']>;
  factor: number;
} {
  const { path, channel } = map,
    scale = map.scale[channel],
    bias = map.bias[channel],
    srgb = map.srgb && channel !== 3;
  if (!bias && !srgb && unit(scale)) return { part: { path, channel }, factor: scale };
  return { part: { path, channel }, remap: { scale, bias, srgb }, factor: 1 };
}

/**
 * A normal map. The scale and bias that decode a stored vector, times a normalScale s, are (2s, 2s, 2) and
 * (-s, -s, -1). A node that states neither is read as the stored map, which is what such a file means.
 */
function normal(map: ShaderMap): { source: USDImage; scale: number } {
  const { path, scale, bias, srgb } = map,
    stated = [0, 1, 2].some((c) => scale[c] !== 1 || bias[c] !== 0),
    s = scale[0] / 2;
  if (!stated) return { source: { path }, scale: 1 };
  if (
    !srgb &&
    near(scale[1], scale[0]) &&
    near(scale[2], 2) &&
    near(bias[0], -s) &&
    near(bias[1], -s) &&
    near(bias[2], -1)
  )
    return { source: { path }, scale: s };
  return { source: { path, normal: { scale: scale.slice(0, 3), bias: bias.slice(0, 3), srgb } }, scale: 1 };
}

/** An occlusion map: glTF reads `1 - strength + strength * red`. */
function occlusion(map: ShaderMap): { source: USDImage; strength: number } {
  const { path, channel, srgb } = map,
    scale = map.scale[channel],
    bias = map.bias[channel];
  if (!channel && !srgb && unit(scale) && near(bias, 1 - scale)) return { source: { path }, strength: scale };
  return { source: { path, scalar: { channel, scale, bias, srgb } }, strength: 1 };
}

/**
 * Sets a material's textures, the factors beside them and its emission. `material.pbrMetallicRoughness` holds the
 * constant roughness, metalness and opacity on entry. `mapped` adds a texture and binds its coordinate set.
 */
export function surfaceMaps(material: GLTFMaterial, maps: SurfaceMaps, mapped: Mapped, document: GLTFDocument): void {
  const p = material.pbrMetallicRoughness!,
    { diffuse, rough, metal, emit } = maps;
  if (diffuse) {
    const base = baseColor(diffuse, maps.alpha, (p.baseColorFactor as number[])[3]);
    p.baseColorTexture = mapped(base.source, diffuse);
    p.baseColorFactor = base.factor;
  }
  if (maps.normal) {
    const bumps = normal(maps.normal),
      info = mapped(bumps.source, maps.normal);
    material.normalTexture = bumps.scale === 1 ? info : { ...info, scale: bumps.scale };
  }
  if (rough || metal) {
    // One packed texture: a side with no map is written into the pixels and keeps a factor of 1.
    const r = rough && scalarPart(rough),
      m = metal && scalarPart(metal);
    p.metallicRoughnessTexture = mapped(
      {
        roughness: r?.part,
        metallic: m?.part,
        ...(r?.remap ? { roughnessRemap: r.remap } : {}),
        ...(m?.remap ? { metallicRemap: m.remap } : {}),
        roughnessValue: p.roughnessFactor,
        metallicValue: p.metallicFactor,
      },
      (rough ?? metal)!,
    );
    p.roughnessFactor = r ? r.factor : 1;
    p.metallicFactor = m ? m.factor : 1;
  }
  if (maps.occlusion) {
    const shade = occlusion(maps.occlusion),
      info = mapped(shade.source, maps.occlusion);
    material.occlusionTexture = shade.strength === 1 ? info : { ...info, strength: shade.strength };
  }
  let factor = maps.emissive.map((v) => Math.max(0, v)),
    strength = Math.max(1, ...factor);
  factor = factor.map((v) => v / strength);
  if (emit) {
    const glow = emission(emit);
    material.emissiveTexture = mapped(glow.source, emit);
    ({ factor, strength } = glow);
  }
  if (factor.some((v) => v)) material.emissiveFactor = factor as [number, number, number];
  if (strength > 1) {
    material.extensions = {
      ...material.extensions,
      KHR_materials_emissive_strength: { emissiveStrength: strength },
    };
    const used = (document.extensionsUsed ??= []);
    if (!used.includes('KHR_materials_emissive_strength')) used.push('KHR_materials_emissive_strength');
  }
}

/** Each byte of a channel through a `remap`: the byte itself without one. */
export function scalarTable(remap?: { scale: number; bias: number; srgb: boolean }): Uint8Array {
  return Uint8Array.from({ length: 256 }, (_, t) =>
    remap ? Math.round(255 * clamp((remap.srgb ? SRGBToLinear(t / 255) : t / 255) * remap.scale + remap.bias)) : t,
  );
}

/** Applies a source's pixel conversion to decoded RGBA bytes, in place. */
export function remapPixels(data: Uint8ClampedArray, source: USDImage): void {
  const byte = (value: number): number => Math.round(255 * clamp(value)),
    read = (t: number, srgb: boolean): number => (srgb ? SRGBToLinear(t / 255) : t / 255),
    table = (map: (t: number) => number) => Uint8Array.from({ length: 256 }, (_, t) => map(t));
  const value = source.opacity ?? source.scalar;
  if (value) {
    const out = scalarTable({ ...value, srgb: value.srgb && value.channel !== 3 });
    for (let i = 0; i < data.length; i += 4) {
      const v = out[data[i + value.channel]];
      // A coat map stays opaque: a canvas premultiplies, so a low alpha would round its colours away.
      data.set(source.opacity ? [255, v, 255, v] : [v, v, 0, 255], i);
    }
    return;
  }
  const vector = source.color ?? source.normal!,
    tables = vector.scale.map((scale, c) =>
      table((t) => {
        const v = read(t, vector.srgb && c < 3) * scale + vector.bias[c];
        if (source.normal) return byte((v + 1) / 2);
        return byte(c < 3 ? LinearToSRGB(clamp(v)) : v);
      }),
    );
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < tables.length; c++) data[i + c] = tables[c][data[i + c]];
}
