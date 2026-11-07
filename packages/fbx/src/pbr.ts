// Physically based FBX materials and layered textures, as glTF metallic-roughness. The property names are the ones real
// files carry; their meaning follows Autodesk's public help on the Max Physical and PBR materials, the Stingray PBS
// shader and the Arnold Standard Surface, and the FBX SDK class reference for layered textures. The specular to metallic
// sum is the published glTF conversion (Khronos, KHR_materials_pbrSpecularGlossiness notes); see docs/clean-room.md.
import { encodePNG } from '@margoengine/exporters/capture';
import { decodeJPEG } from '@margoengine/exporters/jpeg-read';
import type { MaterialData, TextureData } from '@margoengine/exporters';
import { decodePNG } from '@margoengine/decoders/png';
import { parseTGA } from '@margoengine/decoders/tga';
import { parseTIFF } from '@margoengine/decoders/tiff';
import { MargoError } from '@margoengine/math/errors';
import { array, findChild, objectName, property, type FBXNode } from './document.js';
import type { ExtensionHooks, FBXExtension, MaterialRead } from './extension.js';

interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}
/** One material, whatever its family: values, and the maps that replace them. */
interface Surface {
  color: number[];
  /** Multiplies the colour map, as Max Physical's weight does. */
  weight: number;
  colorMap?: string;
  metalness: number;
  metalnessMap?: string;
  roughness: number;
  roughnessMap?: string;
  /** The roughness value and map hold glossiness. */
  glossy: boolean;
  emissive: number[];
  emissiveMap?: string;
  normalMap?: string;
  occlusionMap?: string;
  opacity: number;
  opacityMap?: string;
  /** A cut-out: the opacity map keeps or drops a pixel. */
  cutout?: boolean;
  transmission?: number;
  ior?: number;
  /** A specular colour: the material is in the specular workflow, and `color` is its diffuse. */
  specular?: number[];
  uvOffset?: readonly number[];
  uvScale?: readonly number[];
}

const finite = (value: unknown, fallback: number): number => {
  const out = Number(value);
  return Number.isFinite(out) ? out : fallback;
};
const unit = (value: number): number => Math.min(1, Math.max(0, value));

function reader(source: FBXNode, prefix: string) {
  const raw = (name: string): unknown => property(source, prefix + name, undefined);
  const has = (name: string): boolean => raw(name) !== undefined;
  const number = (name: string, fallback: number): number => finite(raw(name), fallback);
  const color = (name: string, fallback: readonly number[]): number[] => {
    const value = raw(name);
    return Array.isArray(value) && value.length >= 3 && value.every((v) => Number.isFinite(Number(v)))
      ? value.slice(0, 3).map(Number)
      : [...fallback];
  };
  return { raw, has, number, color };
}

/** 3ds Max PBR Material, metal and rough or specular and gloss. Its `useGlossiness` is 1 for glossiness, 2 for roughness. */
function maxPBR(source: FBXNode): Surface {
  const main = reader(source, '3dsMax|main|'),
    specular = main.has('Specular') ? main.color('Specular', [1, 1, 1]) : undefined,
    hasGloss = main.has('glossiness'),
    glossy = main.number('useGlossiness', hasGloss ? 1 : 2) === 1;
  return {
    color: main.color(main.has('baseColor') ? 'baseColor' : 'basecolor', [1, 1, 1]),
    weight: 1,
    colorMap: '3dsMax|main|base_color_map',
    metalness: main.number('metalness', 0),
    metalnessMap: '3dsMax|main|metalness_map',
    roughness: main.number(hasGloss ? 'glossiness' : 'roughness', 0.5),
    roughnessMap: hasGloss ? '3dsMax|main|glossiness_map' : '3dsMax|main|roughness_map',
    glossy,
    emissive: main.color('emit_color', [0, 0, 0]),
    emissiveMap: '3dsMax|main|emit_color_map',
    normalMap: '3dsMax|main|norm_map',
    occlusionMap: '3dsMax|main|ao_map',
    opacity: 1,
    opacityMap: '3dsMax|main|opacity_map',
    specular,
  };
}

/** 3ds Max Physical Material. Every map has an `_on` switch. */
function maxPhysical(source: FBXNode): Surface {
  const p = reader(source, '3dsMax|Parameters|'),
    map = (name: string): string | undefined =>
      p.number(`${name}_on`, 1) ? `3dsMax|Parameters|${name}` : undefined,
    iorIn = p.number('trans_ior', 1.52),
    emission = p.number('emission', 0),
    emit = p.color('emit_color', [1, 1, 1]);
  return {
    color: p.color('base_color', [1, 1, 1]),
    weight: p.number('base_weight', 1),
    colorMap: map('base_color_map'),
    metalness: p.number('metalness', 0),
    metalnessMap: map('metalness_map'),
    roughness: p.number('roughness', 0),
    roughnessMap: map('roughness_map'),
    glossy: !!p.number('roughness_inv', 0),
    emissive: emit.map((v) => v * emission),
    emissiveMap: map('emit_color_map'),
    opacity: 1,
    opacityMap: map('cutout_map'),
    cutout: true,
    transmission: p.number('transparency', 0),
    // Below 1 is the same surface seen from inside.
    ior: iorIn > 0 && iorIn < 1 ? 1 / iorIn : iorIn,
  };
}

/** Maya's Stingray PBS shader: a `use_x_map` switch beside each `TEX_x_map`. */
function stingray(source: FBXNode): Surface {
  const p = reader(source, 'Maya|'),
    map = (use: string, name: string): string | undefined =>
      p.number(use, 0) ? `Maya|TEX_${name}` : undefined,
    intensity = p.number('emissive_intensity', 1);
  return {
    color: p.color('base_color', [1, 1, 1]),
    weight: 1,
    colorMap: map('use_color_map', 'color_map'),
    metalness: p.number('metallic', 0),
    metalnessMap: map('use_metallic_map', 'metallic_map'),
    roughness: p.number('roughness', 0.5),
    roughnessMap: map('use_roughness_map', 'roughness_map'),
    glossy: false,
    emissive: p.color('emissive', [0, 0, 0]).map((v) => v * intensity),
    emissiveMap: map('use_emissive_map', 'emissive_map'),
    normalMap: map('use_normal_map', 'normal_map'),
    occlusionMap: map('use_ao_map', 'ao_map'),
    opacity: 1,
    uvOffset: p.has('uv_offset') ? (p.raw('uv_offset') as number[]) : undefined,
    uvScale: p.has('uv_scale') ? (p.raw('uv_scale') as number[]) : undefined,
  };
}

/** Arnold Standard Surface as Maya writes it. */
function arnold(source: FBXNode): Surface {
  const p = reader(source, 'Maya|'),
    opacity = p.color('opacity', [1, 1, 1]),
    emission = p.number('emission', 0);
  return {
    color: p.color('baseColor', [1, 1, 1]),
    weight: p.number('base', 1),
    colorMap: 'Maya|baseColor',
    metalness: p.number('metalness', 0),
    metalnessMap: 'Maya|metalness',
    roughness: p.number('specularRoughness', 0.2),
    roughnessMap: 'Maya|specularRoughness',
    glossy: false,
    emissive: p.color('emissionColor', [1, 1, 1]).map((v) => v * emission),
    emissiveMap: 'Maya|emissionColor',
    normalMap: 'Maya|normalCamera',
    opacity: (opacity[0] + opacity[1] + opacity[2]) / 3,
    opacityMap: 'Maya|opacity',
  };
}

function surfaceOf(source: FBXNode): Surface | undefined {
  const has = (name: string): boolean => property(source, name, undefined) !== undefined;
  if (has('3dsMax|main|base_color_map') || has('3dsMax|main|baseColor') || has('3dsMax|main|basecolor'))
    return maxPBR(source);
  if (has('3dsMax|Parameters|base_color')) return maxPhysical(source);
  if (has('Maya|base_color') || has('Maya|TEX_color_map')) return stingray(source);
  if (has('Maya|specularRoughness')) return arnold(source);
  return undefined;
}

/** A specular colour and diffuse as a metalness and base colour, for dielectric reflectance 0.04. */
export function specularToMetal(
  diffuse: readonly number[],
  specular: readonly number[],
): { metalness: number; color: number[] } {
  const dielectric = 0.04,
    perceived = ([r, g, b]: readonly number[]) => Math.sqrt(0.299 * r * r + 0.587 * g * g + 0.114 * b * b),
    peak = Math.max(specular[0], specular[1], specular[2]),
    d = perceived(diffuse),
    s = perceived(specular);
  let metalness = 0;
  if (s >= dielectric) {
    const b = (d * (1 - peak)) / (1 - dielectric) + s - 2 * dielectric,
      c = dielectric - s;
    metalness = unit((-b + Math.sqrt(Math.max(0, b * b - 4 * dielectric * c))) / (2 * dielectric));
  }
  const color = diffuse.map((v, i) => {
    const fromDiffuse = (v * (1 - peak)) / (1 - dielectric) / Math.max(1 - metalness, 1e-6),
      fromSpecular = (specular[i] - dielectric * (1 - metalness)) / Math.max(metalness, 1e-6);
    return unit(fromDiffuse + (fromSpecular - fromDiffuse) * metalness * metalness);
  });
  return { metalness, color };
}

const pixels = (texture: TextureData): Pixels =>
  (texture.mimeType === 'image/png' ? decodePNG(texture.image) : decodeJPEG(texture.image)) as Pixels;

/** The texel of `image` under pixel (x, y) of a `width` x `height` image, at byte `channel`. */
const texel = (image: Pixels, x: number, y: number, width: number, height: number, channel: number): number =>
  image.data[
    (Math.min(image.height - 1, ((y * image.height) / height) | 0) * image.width +
      Math.min(image.width - 1, ((x * image.width) / width) | 0)) *
      4 +
      channel
  ];

async function encoded(name: string, image: Pixels, from?: TextureData): Promise<TextureData> {
  return {
    name,
    mimeType: 'image/png',
    image: await encodePNG(image),
    ...(from?.texCoord ? { texCoord: from.texCoord } : {}),
  };
}

/** glTF keeps roughness in green and metalness in blue of one image; FBX has an image each, in any channel layout. */
async function packMetalRough(
  name: string,
  metal: TextureData | undefined,
  rough: TextureData | undefined,
  metalness: number,
  roughness: number,
  glossy: boolean,
): Promise<TextureData> {
  const m = metal && pixels(metal),
    r = rough && pixels(rough),
    width = Math.max(m?.width ?? 1, r?.width ?? 1),
    height = Math.max(m?.height ?? 1, r?.height ?? 1),
    data = new Uint8Array(width * height * 4),
    flatMetal = Math.round(unit(metalness) * 255),
    flatRough = Math.round(unit(roughness) * 255);
  for (let y = 0, at = 0; y < height; y++)
    for (let x = 0; x < width; x++, at += 4) {
      const value = r ? texel(r, x, y, width, height, 0) : flatRough;
      data[at] = 255;
      data[at + 1] = glossy && r ? 255 - value : value;
      data[at + 2] = m ? texel(m, x, y, width, height, 0) : flatMetal;
      data[at + 3] = 255;
    }
  return encoded(`${name} metallic roughness`, { width, height, data }, rough ?? metal);
}

/** Opacity of a texel: the map's alpha when it has one, else its red, or the inverse for a transparency map. */
function opacityReader(map: Pixels, inverse: boolean): (x: number, y: number, w: number, h: number) => number {
  return hasAlpha(map)
    ? (x, y, w, h) => texel(map, x, y, w, h, 3)
    : (x, y, w, h) => (inverse ? 255 - texel(map, x, y, w, h, 0) : texel(map, x, y, w, h, 0));
}

/**
 * Puts an opacity map into the base colour's alpha, where glTF has it, and picks MASK for a map of holes and BLEND for a
 * map with real gradients: at least 95 of 100 texels at the two ends make it holes.
 */
async function mergeOpacity(
  out: MaterialData,
  map: TextureData,
  inverse: boolean,
  cutout: boolean,
): Promise<void> {
  const base = out.baseColorTexture,
    same = base !== undefined && sameImage(base, map),
    o = pixels(map),
    b = base && !same ? pixels(base) : undefined,
    width = Math.max(b?.width ?? 0, o.width),
    height = Math.max(b?.height ?? 0, o.height),
    data = new Uint8Array(width * height * 4),
    read = opacityReader(o, inverse);
  let ends = 0;
  for (let y = 0, at = 0; y < height; y++)
    for (let x = 0; x < width; x++, at += 4) {
      const a = read(x, y, width, height);
      if (a < 16 || a > 239) ends++;
      for (let c = 0; c < 3; c++) data[at + c] = same ? texel(o, x, y, width, height, c) : b ? texel(b, x, y, width, height, c) : 255;
      data[at + 3] = a;
    }
  if (cutout || ends >= width * height * 0.95) {
    out.alphaMode = 'MASK';
    out.alphaCutoff = 0.5;
  } else out.alphaMode = 'BLEND';
  // The same image with an alpha of its own already says everything.
  if (same && hasAlpha(o)) return;
  out.baseColorTexture = await encoded(base?.name ?? String(map.name), { width, height, data }, base ?? map);
}

const hasAlpha = (image: Pixels): boolean => {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] < 255) return true;
  return false;
};
const sameImage = (a: TextureData, b: TextureData): boolean => a.image === b.image;

/** FbxLayeredTexture blend modes, by number; the other modes of the list composite as a plain layer. */
const BLEND: Record<number, (bottom: number, top: number) => number> = {
  1: (b, t) => Math.min(1, b + t), // add
  2: (b, t) => b * t, // modulate
  3: (b, t) => Math.min(1, 2 * b * t), // modulate 2
  7: (b, t) => Math.min(b, t), // darken
  11: (b, t) => Math.max(b, t), // lighten
  12: (b, t) => 1 - (1 - b) * (1 - t), // screen
  21: (b, t) => Math.abs(b - t), // difference
  23: (b, t) => Math.max(0, b - t), // subtract
};

/**
 * A layered texture flattened to one image, first layer at the bottom, each drawn over the result by its blend mode
 * and alpha. glTF has one image per slot; the layers must share a UV set, and the image takes the largest layer's size.
 */
async function flatten(read: MaterialRead, node: FBXNode): Promise<TextureData | undefined> {
  const layers = read.children(node).filter((n) => n.name === 'Texture'),
    textures = (await Promise.all(layers.map((layer) => read.texture(layer)))).filter((t) => t !== undefined);
  if (textures.length < 2) return textures[0];
  const blend = findChild(node, 'BlendModes') ? array(node, 'BlendModes') : [],
    alphas = findChild(node, 'Alphas') ? array(node, 'Alphas') : [],
    images = textures.map(pixels),
    width = Math.max(...images.map((i) => i.width)),
    height = Math.max(...images.map((i) => i.height)),
    data = new Uint8Array(width * height * 4);
  for (let y = 0, at = 0; y < height; y++)
    for (let x = 0; x < width; x++, at += 4) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      images.forEach((image, k) => {
        const mode = BLEND[blend[k]],
          coverage = (texel(image, x, y, width, height, 3) / 255) * finite(alphas[k], 1),
          mix = (under: number, channel: number): number => {
            const top = texel(image, x, y, width, height, channel) / 255;
            // The blended colour shows where there is something under it, as in any paint program's layer.
            const over = mode ? top + (mode(under, top) - top) * a : top;
            return under + (over - under) * coverage;
          };
        r = mix(r, 0);
        g = mix(g, 1);
        b = mix(b, 2);
        a = a + (1 - a) * coverage;
      });
      data[at] = Math.round(unit(r) * 255);
      data[at + 1] = Math.round(unit(g) * 255);
      data[at + 2] = Math.round(unit(b) * 255);
      data[at + 3] = Math.round(unit(a) * 255);
    }
  return encoded(objectName(node), { width, height, data }, textures[0]);
}

/** TGA and TIFF textures as PNG: Max and Maya files name them as often as any other. */
async function toPNG(bytes: Uint8Array): Promise<Uint8Array | undefined> {
  const tiff = (bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d);
  try {
    const decoded = tiff ? parseTIFF(bytes) : parseTGA(bytes);
    if (decoded.data instanceof Uint8Array) return await encodePNG(decoded as Pixels);
  } catch (error) {
    if (!(error instanceof MargoError)) throw error;
  }
  return undefined;
}

async function apply(read: MaterialRead): Promise<void> {
  const { source, out } = read,
    surface = surfaceOf(source),
    used = new Set<string>();
  const map = async (name: string | undefined): Promise<TextureData | undefined> => {
    if (!name) return undefined;
    // Max versions differ in the case of a name: `Roughness_Map` and `roughness_map`.
    const link = read.links.find((l) => l.property.toLowerCase() === name.toLowerCase());
    if (!link) return undefined;
    used.add(link.property);
    return link.node.name === 'LayeredTexture' ? flatten(read, link.node) : read.texture(link.node);
  };
  // The slots of every plain material, which the base reader leaves for an entry that can flatten or merge.
  const diffuse = read.links.find((l) => l.property === 'DiffuseColor');
  if (diffuse?.node.name === 'LayeredTexture') {
    used.add('DiffuseColor');
    const flat = await flatten(read, diffuse.node);
    if (flat) out.baseColorTexture = flat;
  }
  if (surface) {
    const color = surface.color.map(unit),
      weight = unit(surface.weight),
      alpha = unit(surface.opacity);
    let metalness = unit(surface.metalness),
      base = color;
    if (surface.specular) ({ metalness, color: base } = specularToMetal(color, surface.specular.map(unit)));
    const colorMap = await map(surface.colorMap);
    if (colorMap) out.baseColorTexture = colorMap;
    out.color = colorMap ? [weight, weight, weight, alpha] : [...base.map((v) => v * weight), alpha];
    if (surface.uvScale && surface.uvOffset && colorMap) {
      const [su, sv] = surface.uvScale,
        [ou, ov] = surface.uvOffset;
      if (su !== 1 || sv !== 1 || ou !== 0 || ov !== 0)
        out.baseColorTextureTransform = { offset: [ou, ov], scale: [su, sv] };
    }
    const rough = surface.glossy ? 1 - surface.roughness : surface.roughness,
      metalMap = await map(surface.metalnessMap),
      roughMap = await map(surface.roughnessMap);
    out.metalness = metalness;
    out.roughness = unit(rough);
    if (metalMap || roughMap) {
      out.metallicRoughnessTexture = await packMetalRough(
        String(out.name),
        metalMap,
        roughMap,
        metalness,
        unit(rough),
        surface.glossy,
      );
      out.metalness = 1;
      out.roughness = 1;
    }
    const normal = await map(surface.normalMap);
    if (normal) out.normalTexture = normal;
    const occlusion = await map(surface.occlusionMap);
    if (occlusion) out.occlusionTexture = occlusion;
    const peak = Math.max(...surface.emissive, 0);
    out.emissive = peak > 1 ? surface.emissive.map((v) => v / peak) : surface.emissive;
    if (peak > 1) out.emissiveStrength = peak;
    else delete out.emissiveStrength;
    const emissive = await map(surface.emissiveMap);
    if (emissive) {
      out.emissiveTexture = emissive;
      if (!(peak > 0)) out.emissive = [1, 1, 1];
    }
    out.alphaMode = alpha < 1 ? 'BLEND' : 'OPAQUE';
    if (surface.transmission) out.transmission = unit(surface.transmission);
    if (surface.transmission && surface.ior && surface.ior >= 1) out.ior = surface.ior;
    const opacity = await map(surface.opacityMap);
    if (opacity) await mergeOpacity(out, opacity, false, !!surface.cutout);
  }
  const emissive = read.links.find((l) => l.property === 'EmissiveColor');
  if (emissive && !out.emissiveTexture) {
    used.add('EmissiveColor');
    const image =
      emissive.node.name === 'LayeredTexture' ? await flatten(read, emissive.node) : await read.texture(emissive.node);
    if (image) {
      out.emissiveTexture = image;
      if (!Math.max(...(out.emissive ?? [0]))) out.emissive = [1, 1, 1];
    }
  }
  const transparent = read.links.find((l) => l.property === 'TransparentColor');
  if (transparent) {
    used.add('TransparentColor');
    const image =
      transparent.node.name === 'LayeredTexture'
        ? await flatten(read, transparent.node)
        : await read.texture(transparent.node);
    if (image) await mergeOpacity(out, image, true, false);
  }
  // What has no slot in glTF stays on the record, so a tool can see what the material lost.
  const left = read.links.map((l) => l.property).filter((p) => !used.has(p) && !read.handled.has(p));
  if (left.length) out.extras = { ...out.extras, fbxUnmappedTextures: [...new Set(left)] };
}

/**
 * Reads Stingray PBS, 3ds Max Physical and PBR and Arnold Standard Surface materials as metallic-roughness, flattens
 * layered textures, and takes emissive and transparency maps of plain materials.
 * Pass it in `extensions`: `loadFBX(engine, url, {extensions: [pbrMaterials]})`.
 */
export const pbrMaterials: FBXExtension = { name: 'pbr', material: apply, image: toPNG } as ExtensionHooks;
