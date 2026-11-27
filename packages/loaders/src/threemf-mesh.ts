// create3MFMesh: draws parse3MFMaterials output with @margoengine/materials, multiproperties layer stacks and metallic
// display properties included.
import type { EngineKernel } from '@margoengine/core';
import { Material, Texture, createMesh, type MaterialMesh, type TextureOptions } from '@margoengine/materials';
import { layered, type MaterialLayer } from '@margoengine/materials/layered';
import { SRGBToLinear } from '@margoengine/math/color';
import { computeVertexNormals } from './normals.js';
import type {
  ThreeMFLayer,
  ThreeMFMaterialGroup,
  ThreeMFMaterials,
  ThreeMFMetallic,
  ThreeMFTexture,
} from './threemf-materials.js';
import { LoaderError } from './types.js';
import { throwIfAborted } from './util.js';

const F = '3MF';

/** Options of {@link create3MFMesh}. */
export interface ThreeMFMeshOptions {
  /**
   * `'smooth'` (default) shares one area-weighted normal where corners meet at the same position, as `parse3MF` and
   * `createMeshes` shade; `'flat'` gives every triangle its face normal.
   */
  normals?: 'smooth' | 'flat';
  /**
   * Every material's roughness, 0 to 1, in place of the file's value and map. Default: the group's `metallic`, else
   * 0.6.
   */
  roughness?: number;
  /** Every material's metalness, 0 to 1, in place of the file's value and map. Default: the group's `metallic`, else 0. */
  metalness?: number;
  /** Draw both faces. Default true: printed parts are often open or inside out. */
  doubleSided?: boolean;
  /** Draw the colours as they are, without light (`shading: 'basic'`). Default false. */
  unlit?: boolean;
  /** Draw order of the mesh. Default 0. */
  renderOrder?: number;
  /** Stops the image decoding; the promise then rejects with a `LoaderError` code `aborted`. */
  signal?: AbortSignal;
}

/** What {@link create3MFMesh} made. The textures and materials are its own: `dispose()` releases them with the mesh. */
export interface ThreeMFMesh {
  mesh: MaterialMesh<Material[]>;
  /** One per group, in `groups` order, empty groups left out. */
  materials: Material[];
  /** The decoded textures, by their index in `textures`. */
  textures: Map<number, Texture>;
  dispose(): void;
  [Symbol.dispose](): void;
}

const wrap = (style: string): TextureOptions['wrapS'] =>
  style === 'mirror' ? 'mirror' : style === 'clamp' || style === 'none' ? 'clamp' : 'repeat';

async function decode(texture: ThreeMFTexture, signal?: AbortSignal): Promise<Texture> {
  // Pixels as stored: the spec reads colour as sRGB and alpha as linear, unpremultiplied.
  const image = await createImageBitmap(new Blob([texture.data.slice()], { type: texture.contentType }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  throwIfAborted(signal, F);
  const nearest = texture.filter === 'nearest',
    filter = nearest ? 'nearest' : 'linear';
  return new Texture(image, {
    wrapS: wrap(texture.tileStyleU),
    wrapT: wrap(texture.tileStyleV),
    minFilter: filter,
    magFilter: filter,
    mipmaps: !nearest,
  });
}

function smoothIndices(positions: Float32Array): Uint32Array {
  const first = new Map<string, number>(),
    out = new Uint32Array(positions.length / 3);
  for (let v = 0; v < out.length; v++) {
    const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
    let at = first.get(key);
    if (at === undefined) first.set(key, (at = v));
    out[v] = at;
  }
  return out;
}

/**
 * The metalness and roughness maps of one group as the single glTF-layout map a material reads (roughness in green,
 * metalness in blue). The extension samples each from its own image's red channel, or roughness from red and metalness
 * from green when both name one resource (section 7.4). A number given in the options leaves its channel white, and a
 * factor above 1 is applied to the texels, which stay at most 1. Images of two sizes meet at the larger one.
 */
async function finishMap(
  loaded: ThreeMFMaterials,
  metallic: ThreeMFMetallic,
  addressing: ThreeMFTexture,
  gains: { roughness: number | undefined; metalness: number | undefined },
  signal?: AbortSignal,
): Promise<Texture> {
  const { decodeImage } = await import('@margoengine/decoders/image'),
    shared = metallic.metalnessTexture === metallic.roughnessTexture,
    read = async (k: number | undefined) => {
      const source = loaded.textures[k!];
      if (!source) throw new LoaderError(F, 'range', `a group names texture ${k}, outside textures`);
      throwIfAborted(signal, F);
      return decodeImage(source.data);
    },
    rough = await read(metallic.roughnessTexture),
    metal = shared ? rough : await read(metallic.metalnessTexture),
    width = Math.max(rough.width, metal.width),
    height = Math.max(rough.height, metal.height),
    data = new Uint8Array(width * height * 4).fill(255),
    { tileStyleU, tileStyleV, filter } = addressing,
    nearest = filter === 'nearest';
  // One axis of a texel position, wrapped as the texture is.
  const wrapped = (i: number, size: number, style: string): number => {
    if (wrap(style) === 'repeat') return ((i % size) + size) % size;
    if (wrap(style) === 'mirror') {
      const m = ((i % (size * 2)) + size * 2) % (size * 2);
      return m < size ? m : size * 2 - 1 - m;
    }
    return Math.min(size - 1, Math.max(0, i));
  };
  const fill = (image: typeof rough, from: number, to: number, gain: number) => {
    // Rows are stored bottom first: raw texels put row 0 at v = 0, where an image's last row is.
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sx = ((x + 0.5) / width) * image.width - 0.5,
          sy = ((height - y - 0.5) / height) * image.height - 0.5,
          x0 = Math.floor(sx),
          y0 = Math.floor(sy),
          // Between two sizes, blend the four texels around the point, or take the nearest for a nearest texture.
          fx = nearest ? Math.round(sx - x0) : sx - x0,
          fy = nearest ? Math.round(sy - y0) : sy - y0,
          texel = (i: number, j: number) =>
            image.data[
              (wrapped(j, image.height, tileStyleV) * image.width + wrapped(i, image.width, tileStyleU)) * 4 + from
            ],
          value =
            (texel(x0, y0) * (1 - fx) + texel(x0 + 1, y0) * fx) * (1 - fy) +
            (texel(x0, y0 + 1) * (1 - fx) + texel(x0 + 1, y0 + 1) * fx) * fy;
        data[(y * width + x) * 4 + to] = Math.min(255, Math.round(value * gain));
      }
  };
  if (gains.roughness !== undefined) fill(rough, 0, 1, gains.roughness);
  if (gains.metalness !== undefined) fill(metal, shared ? 1 : 0, 2, gains.metalness);
  const sampling = nearest ? 'nearest' : 'linear';
  return new Texture(
    { data, width, height },
    {
      colorSpace: 'linear',
      wrapS: wrap(tileStyleU),
      wrapT: wrap(tileStyleV),
      minFilter: sampling,
      magFilter: sampling,
      mipmaps: !nearest,
    },
  );
}

/**
 * Turns one group's stack into the colour each vertex starts with and the `layered()` layers over it. The colour
 * layers below the first texture layer are blended per corner, in linear light as the spec says, into the vertex
 * colour; the first layer is opaque. Every layer from the first texture up becomes a material layer: a texture mixes by
 * its own alpha (the bottom one covers), a colour layer needs one colour across the group. Texture layers share UV0
 * and UV1 by their coordinates.
 */
function stack(
  loaded: ThreeMFMaterials,
  group: ThreeMFMaterialGroup,
  layers: ThreeMFLayer[],
  vertices: Uint32Array,
  textures: Map<number, Texture>,
  colors: Float32Array,
  uvs: Float32Array[],
): { layers: MaterialLayer[]; slots: Map<number, 0 | 1> } {
  const data = (layer: ThreeMFLayer): Float32Array => {
    const values = loaded.attributes?.[layer.attribute];
    if (!values) throw new LoaderError(F, 'range', `layer attribute ${layer.attribute} is missing from attributes`);
    return values;
  };
  const top = layers.findIndex((layer) => layer.kind === 'texture'),
    folded = top < 0 ? layers.length : top;
  for (const v of vertices) {
    const out = [1, 1, 1, 1];
    for (let k = 0; k < folded; k++) {
      const c = data(layers[k]).subarray(v * 4, v * 4 + 4),
        rgb = [0, 1, 2].map((i) => SRGBToLinear(c[i])),
        a = c[3];
      if (!k) out.splice(0, 4, ...rgb, 1);
      else if (layers[k].blend === 'multiply') out.splice(0, 4, ...rgb.map((x, i) => x * out[i]), a * out[3]);
      else out.splice(0, 4, ...rgb.map((x, i) => x * a + out[i] * (1 - a)), a + out[3] * (1 - a));
    }
    colors.set(out, v * 4);
  }
  const slots: Float32Array[] = [],
    same = (a: Float32Array, b: Float32Array) =>
      [...vertices].every((v) => a[v * 2] === b[v * 2] && a[v * 2 + 1] === b[v * 2 + 1]);
  const out: MaterialLayer[] = [],
    /** The UV set of each texture layer, by its place in the file's stack. */
    sets = new Map<number, 0 | 1>();
  for (let k = folded; k < layers.length; k++) {
    const layer = layers[k],
      values = data(layer),
      multiply = layer.blend === 'multiply';
    if (layer.kind === 'color') {
      const c = values.subarray(vertices[0] * 4, vertices[0] * 4 + 4);
      if (![...vertices].every((v) => [0, 1, 2, 3].every((i) => values[v * 4 + i] === c[i])))
        throw new LoaderError(
          F,
          'unsupported',
          `group ${group.name ?? group.objectId ?? ''}: a colour layer above a texture layer must hold one colour across the group`,
        );
      const color = [0, 1, 2].map((i) => SRGBToLinear(c[i])) as [number, number, number];
      out.push(multiply ? { color, blend: 'multiply' } : { color, opacity: c[3] });
      continue;
    }
    let slot = slots.findIndex((uv) => uv === values || same(uv, values));
    if (slot < 0) slot = slots.push(values) - 1;
    if (slot > 1)
      throw new LoaderError(
        F,
        'unsupported',
        'a layer stack uses more than two sets of texture coordinates (UV0, UV1)',
      );
    for (const v of vertices) uvs[slot].set([values[v * 2], 1 - values[v * 2 + 1]], v * 2);
    const map = textures.get(layer.texture!)!,
      texCoord = slot as 0 | 1,
      // The display properties' `basecolorfactor` scales the colour of the layer they come from.
      factor = group.metallic?.layer === k ? group.metallic.baseColorFactor : undefined,
      tint = factor ? { color: [0, 1, 2].map((i) => SRGBToLinear(factor[i])) as [number, number, number] } : {};
    sets.set(k, texCoord);
    // The bottom layer starts the stack opaque; a mix layer above covers by its alpha; multiply scales by it.
    out.push({
      ...tint,
      ...(k === 0
        ? { map, texCoord }
        : multiply
          ? { map, texCoord, blend: 'multiply' as const }
          : { map, texCoord, mask: map, maskChannel: 'a' as const }),
    });
  }
  return { layers: out, slots: sets };
}

/**
 * Draws a `parse3MFMaterials` result as one materials mesh with a material per group: colour groups, composites and
 * per-corner colours as vertex colours, a texture group's image as the colour map, and a `multiproperties` stack as its
 * layers (`layered()`), blended as the 3MF Materials and Properties Extension 1.2.1 specifies (mix and multiply, in
 * linear light). A group's `metallic` sets its material's metalness and roughness, with their maps. Colour images decode
 * with `createImageBitmap`; metalness and roughness maps need the optional `@margoengine/decoders` peer, which reads
 * their texels exactly.
 *
 * @param engine The engine to draw in.
 * @param loaded What `parse3MFMaterials` returned.
 * @param options Normals, surface numbers, draw order and an abort signal.
 * @returns The mesh, its materials and textures, and `dispose()`.
 * @throws LoaderError `unsupported` for a stack needing more than two UV sets or a varying colour above a texture
 *   layer, `range` for a group naming a missing texture or layer attribute, `aborted` when the signal fires.
 *
 * @example
 * ```ts
 * import { Engine } from '@margoengine/core';
 * import { parse3MFMaterials } from '@margoengine/loaders/threemf-materials';
 * import { create3MFMesh } from '@margoengine/loaders/threemf-mesh';
 *
 * const engine = await Engine.create(document.querySelector('canvas')!);
 * const bytes = await (await fetch('/prints/multiprop-opaque.3mf')).arrayBuffer();
 * using model = await create3MFMesh(engine, await parse3MFMaterials(bytes));
 * console.log(model.materials.length, model.textures.size);
 * ```
 */
export async function create3MFMesh(
  engine: EngineKernel,
  loaded: ThreeMFMaterials,
  options: ThreeMFMeshOptions = {},
): Promise<ThreeMFMesh> {
  const { positions, indices, groups = [] } = loaded,
    { signal } = options;
  if (loaded.kind !== 'mesh' || !indices?.length)
    throw new LoaderError(F, 'unsupported', 'create3MFMesh needs triangles; pass parse3MFMaterials output');
  const mode = options.normals ?? 'smooth';
  if (mode !== 'smooth' && mode !== 'flat') throw new LoaderError(F, 'range', 'normals must be smooth or flat');
  const count = positions.length / 3,
    used = new Set<number>();
  for (const group of groups) {
    if (group.texture !== undefined) used.add(group.texture);
    for (const layer of group.layers ?? []) if (layer.texture !== undefined) used.add(layer.texture);
  }
  const textures = new Map<number, Texture>(),
    /** Repacked metalness and roughness maps, shared by the groups that sample them alike. */
    finishes = new Map<string, Texture>(),
    materials: Material[] = [];
  const release = () => {
    for (const material of materials) material.dispose();
    for (const texture of [...textures.values(), ...finishes.values()]) texture.dispose();
  };
  try {
    for (const k of used) {
      throwIfAborted(signal, F);
      const source = loaded.textures[k];
      if (!source) throw new LoaderError(F, 'range', `a group names texture ${k}, outside textures`);
      textures.set(k, await decode(source, signal));
    }
    const colors = new Float32Array(count * 4).fill(1),
      uvs = [new Float32Array(count * 2), new Float32Array(count * 2)],
      geometryGroups: { start: number; count: number; materialIndex: number }[] = [];
    for (const group of groups) {
      if (!group.count) continue;
      const vertices = indices.subarray(group.start, group.start + group.count),
        { metallic } = group,
        roughness = options.roughness ?? (metallic ? Math.min(1, metallic.roughness) : 0.6),
        metalness = options.metalness ?? (metallic ? Math.min(1, metallic.metalness) : 0);
      let features: MaterialLayer[] = [],
        slots = new Map<number, 0 | 1>(),
        map: Texture | undefined,
        finish: Texture | undefined;
      if (
        metallic?.roughnessTexture !== undefined &&
        (options.roughness === undefined || options.metalness === undefined)
      ) {
        const colour = group.layers ? group.layers[metallic.layer!]?.texture : group.texture,
          addressing = loaded.textures[colour!];
        if (!addressing)
          throw new LoaderError(F, 'range', 'a group with a metalness or roughness map needs its colour texture');
        // A number from the options keeps the map out of its channel.
        const gains = {
            roughness: options.roughness === undefined ? Math.max(1, metallic.roughness) : undefined,
            metalness: options.metalness === undefined ? Math.max(1, metallic.metalness) : undefined,
          },
          key = JSON.stringify([metallic.metalnessTexture, metallic.roughnessTexture, colour, gains]);
        finish = finishes.get(key);
        if (!finish) finishes.set(key, (finish = await finishMap(loaded, metallic, addressing, gains, signal)));
        throwIfAborted(signal, F);
      }
      if (group.layers?.length)
        ({ layers: features, slots } = stack(loaded, group, group.layers, vertices, textures, colors, uvs));
      else {
        const { colors: rgb, uvs: uv } = loaded,
          alpha = loaded.attributes?.opacity,
          factor = metallic?.baseColorFactor;
        for (const v of vertices) {
          for (let c = 0; c < 3; c++)
            colors[v * 4 + c] =
              SRGBToLinear(rgb?.[v * 3 + c] ?? group.color?.[c] ?? 1) * (factor ? SRGBToLinear(factor[c]) : 1);
          colors[v * 4 + 3] = alpha?.[v] ?? group.color?.[3] ?? 1;
          if (uv) uvs[0].set([uv[v * 2], 1 - uv[v * 2 + 1]], v * 2);
        }
        if (group.texture !== undefined) map = textures.get(group.texture);
      }
      // A layer sets metalness and roughness where it covers, so each carries the material's own; a map lies over the
      // whole stack as one more layer that leaves the colour as it is.
      if (features.length) {
        if (!finish) features = features.map((layer) => ({ ...layer, roughness, metalness }));
        else {
          if (features.length >= 8)
            throw new LoaderError(F, 'unsupported', 'a stack of 8 texture layers has no room for its metallic map');
          const texCoord = slots.get(metallic!.layer!) ?? 0;
          features.push({ blend: 'multiply', metalRoughnessMap: finish, texCoord, roughness, metalness });
        }
      }
      const transparent = [...vertices].some((v) => colors[v * 4 + 3] < 1);
      geometryGroups.push({ start: group.start, count: group.count, materialIndex: materials.length });
      materials.push(
        new Material({
          ...(map ? { map } : {}),
          ...(finish && !features.length ? { metalRoughnessMap: finish } : {}),
          ...(options.unlit ? { shading: 'basic' as const } : {}),
          roughness,
          metalness,
          doubleSided: options.doubleSided ?? true,
          transparent,
          features: features.length ? [layered({ layers: features })] : [],
        }),
      );
    }
    if (!materials.length) throw new LoaderError(F, 'unsupported', 'the result has no nonempty groups to draw');
    const normals =
      mode === 'flat'
        ? computeVertexNormals(positions, indices)
        : (() => {
            const shared = smoothIndices(positions),
              welded = computeVertexNormals(
                positions,
                indices.map((v) => shared[v]),
              ),
              out = new Float32Array(count * 3);
            for (let v = 0; v < count; v++) out.set(welded.subarray(shared[v] * 3, shared[v] * 3 + 3), v * 3);
            return out;
          })();
    const mesh = createMesh(
      engine,
      { positions, normals, indices, uvs: uvs[0], uvs1: uvs[1], colors, groups: geometryGroups },
      materials,
      { renderOrder: options.renderOrder ?? 0 },
    );
    const dispose = () => {
      mesh.destroy();
      release();
    };
    return { mesh, materials, textures, dispose, [Symbol.dispose]: dispose };
  } catch (error) {
    release();
    throw error;
  }
}
