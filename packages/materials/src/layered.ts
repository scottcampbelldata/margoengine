// Layered materials: full material layers blended over the material's own surface by mask, vertex colour or height, plus
// a tiled detail map. The material is the bottom layer. Each layer's colour, roughness, metalness and normal mix over
// what is under it, in order, at the end of the surface in every pass that runs it. Bindings (the material's group):
// 150 the rows below, 151-169 one texture and sampler per distinct Texture, so a packed mask or a texture array counts once.
import { whiteTexture } from '../../shared/white-texture.js';
import type { Material, MaterialFeature, Texture } from './built-material.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** A channel of a mask or of the vertex colours. */
export type LayerChannel = 'r' | 'g' | 'b' | 'a';
/** A map of a layer: a 2D Texture, or `{texture, layer}` for one layer of a `'2d-array'` Texture. */
export type LayerMap = Texture | { texture: Texture; layer: number };
/** One layer of `layered()`. The numbers are live: edit them on `feature.layers[i]`; the maps are fixed at creation. */
export interface MaterialLayer {
  /** Colour map (sRGB unless the Texture says otherwise), multiplied by `color`. */
  map?: LayerMap;
  /** Linear colour multiplier, three numbers. Default white. */
  color?: readonly [number, number, number];
  /** Tangent-space normal map; a layer without one leaves the normal under it. */
  normalMap?: LayerMap;
  /** Strength of `normalMap`. Default 1. */
  normalScale?: number;
  /** glTF metallic-roughness map (G roughness, B metalness), multiplied by `roughness` and `metalness`. */
  metalRoughnessMap?: LayerMap;
  /** Default 1. */
  roughness?: number;
  /** Default 0. */
  metalness?: number;
  /** Repeats of this layer's maps across the UV set, two numbers. Default [1, 1]. */
  tiling?: readonly [number, number];
  /** UV offset of this layer's maps, two numbers. Default [0, 0]. */
  offset?: readonly [number, number];
  /** UV set of its maps and mask, 0 or 1. Default 0. */
  texCoord?: 0 | 1;
  /** Blend weight map, read without `tiling`. Without any weight source the layer covers everything. */
  mask?: LayerMap;
  /** The channel of `mask`. Default 'r'. */
  maskChannel?: LayerChannel;
  /** A vertex colour channel that multiplies the weight; the colours then stop tinting the surface. */
  vertexChannel?: LayerChannel;
  /** Multiplies the weight, 0 to 1. Default 1. */
  opacity?: number;
  /** Height map (red, linear, tiled like `map`): high points of this layer show first as its weight rises. */
  heightMap?: LayerMap;
  /** Width of the blend at a height edge, above 0: small is a hard edge, large a soft one. Default 0.1. */
  heightContrast?: number;
}
/** The tiled detail of `layered()`, applied over every layer for close-up texture. */
export interface MaterialDetail {
  /** Linear colour detail: 0.5 grey leaves the surface as it is, darker darkens, lighter lightens. */
  map?: LayerMap;
  /** Tangent-space normal detail, added to the surface normal. */
  normalMap?: LayerMap;
  /** Repeats across the UV set, two numbers. Default [8, 8]. */
  tiling?: readonly [number, number];
  /** UV set, 0 or 1. Default 0. */
  texCoord?: 0 | 1;
  /** Strength of both, 0 to 1. Default 1. Live on `feature.detail`. */
  strength?: number;
}
/** Options of `layered()`. */
export interface LayeredOptions {
  /** The layers over the material's own surface, lowest first. At most 8. */
  layers?: readonly MaterialLayer[];
  detail?: MaterialDetail;
}
/** What `layered()` returns: the feature, and the options whose numbers stay live. */
export interface LayeredFeature extends MaterialFeature {
  readonly layers: MaterialLayer[];
  readonly detail: MaterialDetail | undefined;
}
const maxTextures = 9,
  site = /if\((?:margoFaceTest&&)?!facing&&f\.settings\.z<0\.5\)\{discard;\}/g,
  rowsPerLayer = 3;
const textureOf = (m: LayerMap): Texture => ('texture' in m ? m.texture : m);
const channel = (v: unknown, label: string): LayerChannel => {
  if (v !== 'r' && v !== 'g' && v !== 'b' && v !== 'a')
    throw new TypeError(`layered ${label} must be 'r', 'g', 'b' or 'a'; pass a channel`);
  return v;
};
function numbers(v: readonly number[] | undefined, count: number, label: string): void {
  if (v !== undefined && (v.length !== count || !Array.from(v).every((n) => Number.isFinite(Math.fround(n)))))
    throw new RangeError(`layered ${label} must be ${count} finite numbers; pass an array of them`);
}
function checkMap(m: LayerMap | undefined, label: string): void {
  if (m === undefined) return;
  const texture = m && textureOf(m);
  if (!texture || typeof texture.bind !== 'function')
    throw new TypeError(`layered ${label} must be a Texture or {texture, layer}; pass one`);
  if (texture.dimension !== '2d' && texture.dimension !== '2d-array')
    throw new TypeError(`layered ${label} must be a 2D or 2D array Texture, not a ${texture.dimension} one`);
  const layer = 'texture' in m ? m.layer : undefined;
  if ((texture.dimension === '2d-array') !== (layer !== undefined))
    throw new TypeError(`layered ${label}: pass {texture, layer} for an array Texture and a Texture otherwise`);
  if (layer !== undefined && (!Number.isSafeInteger(layer) || layer < 0 || layer >= texture.depth))
    throw new RangeError(`layered ${label} layer must be an index into the Texture's ${texture.depth} layers`);
}
// A Texture clamps by default, so a tiled map would stretch its edge texels past the first tile with no error.
function checkRepeats(maps: (LayerMap | undefined)[], tiling: readonly [number, number], label: string): void {
  for (const m of maps) {
    if (!m) continue;
    const texture = textureOf(m);
    if ((tiling[0] !== 1 && texture.wrapS === 'clamp') || (tiling[1] !== 1 && texture.wrapT === 'clamp'))
      throw new TypeError(`layered ${label} tiling needs Textures that repeat; make them with {wrapS: 'repeat', wrapT: 'repeat'}`);
  }
}
const unitRange = (v: number | undefined, label: string) => {
  if (v !== undefined && !(typeof v === 'number' && v >= 0 && v <= 1))
    throw new RangeError(`layered ${label} must be from 0 to 1; pass a number in that range`);
};
function checkLayer(layer: MaterialLayer, k: number): void {
  const label = `layer ${k}`;
  if (!layer || typeof layer !== 'object') throw new TypeError(`layered ${label} must be an object; pass its options`);
  for (const key of ['map', 'normalMap', 'metalRoughnessMap', 'mask', 'heightMap'] as const)
    checkMap(layer[key], `${label} ${key}`);
  numbers(layer.color, 3, `${label} color`);
  numbers(layer.tiling, 2, `${label} tiling`);
  numbers(layer.offset, 2, `${label} offset`);
  checkRepeats([layer.map, layer.normalMap, layer.metalRoughnessMap, layer.heightMap], layer.tiling ?? [1, 1], label);
  unitRange(layer.opacity, `${label} opacity`);
  unitRange(layer.roughness, `${label} roughness`);
  unitRange(layer.metalness, `${label} metalness`);
  if (layer.normalScale !== undefined && !Number.isFinite(Math.fround(layer.normalScale)))
    throw new RangeError(`layered ${label} normalScale must be finite; pass a number`);
  if (layer.heightContrast !== undefined && !(layer.heightContrast > 0 && Number.isFinite(layer.heightContrast)))
    throw new RangeError(`layered ${label} heightContrast must be above 0; pass a width such as 0.1`);
  if (layer.texCoord !== undefined && layer.texCoord !== 0 && layer.texCoord !== 1)
    throw new TypeError(`layered ${label} texCoord must be 0 or 1; pass a UV set`);
  if (layer.maskChannel !== undefined) channel(layer.maskChannel, `${label} maskChannel`);
  if (layer.vertexChannel !== undefined) channel(layer.vertexChannel, `${label} vertexChannel`);
}
/**
 * Blends full material layers over a material, for worn, weathered and terrain-like surfaces (rock under moss under
 * snow) without baking one huge texture, and adds tiled detail for close-up texture. Assign it through
 * `Material.features`. Numbers on `feature.layers[i]` and `feature.detail.strength` are live; maps are fixed at creation.
 */
export function layered(options: LayeredOptions = {}): LayeredFeature {
  const layers = [...(options.layers ?? [])],
    detail = options.detail ? { ...options.detail } : undefined;
  if (layers.length > 8) throw new RangeError('layered takes at most 8 layers; merge some into one mask or texture array');
  if (!layers.length && !detail) throw new TypeError('layered needs layers or detail; pass at least one');
  layers.forEach(checkLayer);
  if (detail) {
    checkMap(detail.map, 'detail map');
    checkMap(detail.normalMap, 'detail normalMap');
    numbers(detail.tiling, 2, 'detail tiling');
    checkRepeats([detail.map, detail.normalMap], detail.tiling ?? [8, 8], 'detail');
    unitRange(detail.strength, 'detail strength');
    if (!detail.map && !detail.normalMap) throw new TypeError('layered detail needs a map or normalMap; pass one');
  }
  // Colour maps read sRGB by default: a Texture used both ways would need two views, so each slot keeps its own entry.
  const slots: { texture: Texture; srgb: boolean }[] = [];
  const slot = (m: LayerMap, srgb: boolean) => {
    const texture = textureOf(m);
    let k = slots.findIndex((s) => s.texture === texture && s.srgb === srgb);
    if (k < 0) k = slots.push({ texture, srgb }) - 1;
    return k;
  };
  const read = (m: LayerMap, srgb: boolean, uv: string) => {
    const k = slot(m, srgb);
    return `textureSample(margoLayerMap${k},margoLayerSampler${k},${uv}${'texture' in m ? `,${m.layer}` : ''})`;
  };
  const row = (k: number) => `margoLayerRows.rows[${k}]`;
  const uvOf = (texCoord: 0 | 1 | undefined) => (texCoord ? 'i.uv.zw' : 'i.uv.xy');
  let body = '';
  layers.forEach((layer, k) => {
    const a = row(k * rowsPerLayer),
      b = row(k * rowsPerLayer + 1),
      c = row(k * rowsPerLayer + 2),
      plain = uvOf(layer.texCoord),
      uv = `margoLayerUV${k}`,
      w = `margoLayerW${k}`;
    body += `  let ${uv}=${plain}*${b}.xy+${b}.zw;\n  var ${w}=${a}.w;\n`;
    if (layer.mask) body += `  ${w}*=${read(layer.mask, false, plain)}.${layer.maskChannel ?? 'r'};\n`;
    if (layer.vertexChannel) body += `  ${w}*=i.color.${layer.vertexChannel};\n`;
    if (layer.heightMap)
      body += `  ${w}=clamp((${read(layer.heightMap, false, uv)}.r+${w}*(1.0+${c}.y)-1.0)/${c}.y,0.0,1.0);\n`;
    body += `  s.base=vec4f(mix(s.base.rgb,${a}.rgb${layer.map ? `*${read(layer.map, true, uv)}.rgb` : ''},${w}),s.base.a);\n`;
    const mr = layer.metalRoughnessMap ? `margoLayerMR${k}` : '';
    if (mr) body += `  let ${mr}=${read(layer.metalRoughnessMap!, false, uv)};\n`;
    body += `  s.roughness=clamp(mix(s.roughness,${c}.z${mr ? `*${mr}.g` : ''},${w}),0.045,1.0);\n`;
    body += `  s.metal=mix(s.metal,${c}.w${mr ? `*${mr}.b` : ''},${w});\n`;
    if (layer.normalMap)
      body += `  let margoLayerN${k}=${read(layer.normalMap, false, uv)}.xyz*2-1;
  s.n=normalize(mix(s.n,normalize(t*margoLayerN${k}.x*${c}.x+b*margoLayerN${k}.y*${c}.x+n*margoLayerN${k}.z),${w}));\n`;
  });
  if (detail) {
    const d = row(layers.length * rowsPerLayer),
      uv = `(${uvOf(detail.texCoord)}*${d}.xy)`;
    if (detail.map)
      body += `  s.base=vec4f(s.base.rgb*mix(vec3f(1),${read(detail.map, false, uv)}.rgb*2.0,${d}.z),s.base.a);\n`;
    if (detail.normalMap)
      body += `  let margoDetailN=${read(detail.normalMap, false, uv)}.xyz*2-1;
  s.n=normalize(s.n+(t*margoDetailN.x+b*margoDetailN.y)*${d}.z);\n`;
  }
  if (slots.length > maxTextures)
    throw new RangeError(
      `layered uses ${slots.length} textures, ${maxTextures} at most; pack masks into one texture or layers into a texture array`,
    );
  const count = layers.length * rowsPerLayer + (detail ? 1 : 0),
    tinted = layers.some((layer) => layer.vertexChannel),
    cached = new Map<string, string>();
  function shader(source: string, group: number): string {
    const id = group + source;
    let out = cached.get(id);
    if (out !== undefined) return out;
    out = source.replace(site, (found) => `${body}  ${found}`);
    if (out === source)
      throw new TypeError('layered needs the standard gltf-pro PBR shader; use matching gltf-pro and materials versions');
    // Vertex colours that weigh layers stop tinting the base; their alpha still counts as opacity.
    if (tinted) out = out.replace('*f.base*i.color;', '*f.base*vec4f(1,1,1,i.color.a);');
    const keep = slots.map((_, k) => `_=margoLayerMap${k};_=margoLayerSampler${k};`).join('');
    out = out.replace('fn surface(i:Out,front:bool)->Surface {', (head) => `${head}\n  _=&margoLayerRows;${keep}`);
    out =
      `struct MargoLayerRows {rows:array<vec4f,${count}>}
@group(${group}) @binding(150) var<uniform> margoLayerRows:MargoLayerRows;
${slots
  .map(
    ({ texture }, k) =>
      `@group(${group}) @binding(${151 + k * 2}) var margoLayerMap${k}:${texture.dimension === '2d' ? 'texture_2d<f32>' : 'texture_2d_array<f32>'};
@group(${group}) @binding(${152 + k * 2}) var margoLayerSampler${k}:sampler;\n`,
  )
  .join('')}` + out;
    if (cached.size >= 16) cached.clear();
    cached.set(id, out);
    return out;
  }
  const data = new Float32Array(count * 4),
    buffers = new Map<GPUDevice, { buffer: GPUBuffer; last: Float32Array }>();
  function pack(): void {
    layers.forEach((layer, k) => {
      const [r, g, b] = layer.color ?? [1, 1, 1],
        [tu, tv] = layer.tiling ?? [1, 1],
        [ou, ov] = layer.offset ?? [0, 0];
      data.set(
        [
          ...[r, g, b, layer.opacity ?? 1],
          ...[tu, tv, ou, ov],
          ...[layer.normalScale ?? 1, layer.heightContrast ?? 0.1, layer.roughness ?? 1, layer.metalness ?? 0],
        ],
        k * rowsPerLayer * 4,
      );
    });
    if (detail) {
      const [tu, tv] = detail.tiling ?? [8, 8];
      data.set([tu, tv, detail.strength ?? 1, 0], layers.length * rowsPerLayer * 4);
    }
  }
  let users = 0;
  return {
    name: 'layered',
    serialization: () => ({ layers, detail }),
    layers,
    detail,
    shader,
    bindings(device) {
      let held = buffers.get(device);
      if (!held)
        buffers.set(
          device,
          (held = {
            buffer: device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
            last: new Float32Array(data.length).fill(Number.NaN),
          }),
        );
      pack();
      // Steady frames upload nothing.
      if (data.some((v, k) => v !== held.last[k])) {
        device.queue.writeBuffer(held.buffer, 0, data);
        held.last.set(data);
      }
      const entries: GPUBindGroupEntry[] = [{ binding: 150, resource: { buffer: held.buffer } }];
      slots.forEach(({ texture, srgb }, k) => {
        const [view, sampler] = texture.bind(device, srgb) ?? whiteTexture(device, texture.dimension);
        entries.push({ binding: 151 + k * 2, resource: view }, { binding: 152 + k * 2, resource: sampler });
      });
      return entries;
    },
    tangentFrame: layers.some((layer) => layer.normalMap) || !!detail?.normalMap,
    attach(_material: Material) {
      users++;
    },
    detach(_material: Material) {
      if (--users > 0) return;
      for (const { buffer } of buffers.values()) buffer.destroy();
      buffers.clear();
    },
  };
}
