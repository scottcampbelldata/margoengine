// 3MF materials extension on top of parse3MF: texture2d, texture2dgroup, compositematerials and multiproperties.
import { LoaderError, type LoadedGroup } from './types.js';
import type { BinaryInput } from './util.js';
import { floats } from './util.js';
import { SRGBToLinear, LinearToSRGB } from '@margoengine/math/color';
import {
  cornerProperty,
  read3MF,
  type ThreeMFExtension,
  type ThreeMFModel,
  type ThreeMFOptions,
  type ThreeMFResult,
} from './threemf.js';

const F = '3MF';
type Color = [number, number, number, number];

/** One `<texture2d>` of a package with the bytes of its image. */
export interface ThreeMFTexture {
  /** The part's path in the package. */
  path: string;
  /** `image/png` or `image/jpeg`, as the file declares. */
  contentType: string;
  /** The image file, ready for `createImageBitmap`. */
  data: Uint8Array;
  /** How u and v repeat: `wrap` (the default), `mirror`, `clamp` or `none`. */
  tileStyleU: string;
  tileStyleV: string;
  /** `auto` (the default), `linear` or `nearest`. */
  filter: string;
}

/**
 * One layer of a `multiproperties` stack, in the order its `pids` list them (bottom first). Its per-vertex values are in
 * `attributes[attribute]`: four numbers per vertex for a colour layer (sRGB red, green, blue and linear alpha), two for a
 * texture layer (u and v, v = 1 - the file's v as in `uvs`). Vertices outside the group hold zeros.
 */
export interface ThreeMFLayer {
  /** `'color'` for a base material, composite or colour group layer, `'texture'` for a texture group layer. */
  kind: 'color' | 'texture';
  /** A texture layer's index into `textures`. */
  texture?: number;
  /** `layerColor<k>` or `layerUV<k>`, k the layer's place in the stack. */
  attribute: string;
  /**
   * How the layer goes over the result of the layers below (`blendmethods`): `'mix'` (the default) or `'multiply'`. The
   * spec blends in linear light: mix is `rgb = new.rgb * new.a + below.rgb * (1 - new.a)`, `a = new.a + below.a * (1 -
   * new.a)`; multiply is `rgb = new.rgb * below.rgb`, `a = new.a * below.a`. The first layer starts the stack, opaque.
   */
  blend: 'mix' | 'multiply';
}

/** A group of {@link ThreeMFMaterials}: {@link LoadedGroup} with the texture its triangles sample. */
export interface ThreeMFMaterialGroup extends LoadedGroup {
  /** Index into `textures`: the group's only texture, or the first texture layer of its `layers`. */
  texture?: number;
  /** The whole layer stack, when the group's triangles use a `multiproperties`; `create3MFMesh` draws it. */
  layers?: ThreeMFLayer[];
}

/** What {@link parse3MFMaterials} returns: {@link ThreeMFResult} with textures, and one vertex per triangle corner. */
export interface ThreeMFMaterials extends ThreeMFResult {
  groups: ThreeMFMaterialGroup[];
  /** Every texture the package declares. */
  textures: ThreeMFTexture[];
}

interface TextureGroup {
  texture: string;
  coords: number[];
}
interface Multi {
  pids: string[];
  rows: number[][];
  blends: string[];
  /** The kind of each layer, checked against the spec's rules when the element opens. */
  kinds: ('color' | 'texture')[];
}
interface Composite {
  base: Color[];
  indices: number[];
  colors: Color[];
}
interface Store {
  textures: Map<string, number>;
  groups: Map<string, TextureGroup>;
  multis: Map<string, Multi>;
  /** Base material and composite groups, which a multiproperties may name once, first. */
  materials: Set<string>;
}

function list(value: string | undefined, what: string): number[] {
  const parts = (value ?? '').trim().split(/\s+/).map(Number);
  if (!value?.trim() || !parts.every(Number.isFinite))
    throw new LoaderError(F, 'syntax', `invalid ${what} "${String(value).slice(0, 64)}"`);
  return parts;
}

function required(value: string | undefined, element: string, attribute: string): string {
  if (!value) throw new LoaderError(F, 'syntax', `<${element}> without ${attribute}`);
  return value;
}

/**
 * Reads a 3MF package like `parse3MF` and adds the materials extension: `texture2d` images, `texture2dgroup`
 * coordinates, `compositematerials` as mixed colours, and `multiproperties` layers. Every triangle corner gets its own
 * vertex, so `uvs` and `colors` can differ across a seam; `uvs` use Margo's convention, v = 1 - the file's v. `colors` is
 * present when corners of a triangle differ or a layer sets them. A group's `texture` indexes `textures`. In
 * `multiproperties` colour layers mix by their alpha, and the first texture layer sets the group's texture: draw
 * `colors` as a tint over it.
 *
 * @param input The package's bytes.
 * @param options The same options as `parse3MF`.
 * @returns The merged mesh with its coordinates, colours and images.
 * @throws LoaderError with the codes of `parse3MF`, with `range` for a property index outside its group.
 *
 * @example
 * ```ts
 * import { parse3MFMaterials } from '@margoengine/loaders/threemf-materials';
 *
 * const bytes = await (await fetch('/prints/lithophane.3mf')).arrayBuffer();
 * const { groups, textures, uvs } = await parse3MFMaterials(bytes);
 * const image = await createImageBitmap(new Blob([textures[groups[0].texture ?? 0].data]));
 * console.log(image.width, uvs?.length);
 * ```
 */
export function parse3MFMaterials(input: BinaryInput, options: ThreeMFOptions = {}): Promise<ThreeMFMaterials> {
  return read3MFMaterials(input, options);
}

/** Shared materials reader with optional additional format hooks, used by the lattice/slice entry. */
export async function read3MFMaterials(
  input: BinaryInput,
  options: ThreeMFOptions,
  extra?: ThreeMFExtension,
): Promise<ThreeMFMaterials> {
  const stores = new Map<ThreeMFModel, Store>(),
    textures: ThreeMFTexture[] = [],
    uvs = floats(),
    colors = floats(),
    opacity = floats(),
    /** Each layer attribute's values by vertex, written at each corner. */
    layerData = new Map<string, { size: number; values: Map<number, number[]> }>();
  let group: TextureGroup | undefined,
    multi: Multi | undefined,
    composite: Composite | undefined,
    textured = false,
    varied = false,
    translucent = false;
  const store = (model: ThreeMFModel): Store => {
    let found = stores.get(model);
    if (!found)
      stores.set(model, (found = { textures: new Map(), groups: new Map(), multis: new Map(), materials: new Set() }));
    return found;
  };

  /** What one corner samples: a texture and uv, a colour, or both through layers. */
  const sample = (
    model: ThreeMFModel,
    id: string,
    index: number,
    layered: boolean,
  ): { texture?: number; u?: number; v?: number; color?: Color } => {
    const { groups, multis, textures: known } = store(model),
      coords = groups.get(id);
    if (coords) {
      if ((index + 1) * 2 > coords.coords.length)
        throw new LoaderError(F, 'range', `property index ${index} is outside texture group ${id.slice(0, 32)}`);
      const texture = known.get(coords.texture);
      if (texture === undefined)
        throw new LoaderError(F, 'syntax', `texture ${coords.texture.slice(0, 32)} is not defined`);
      return { texture, u: coords.coords[index * 2], v: 1 - coords.coords[index * 2 + 1] };
    }
    const layers = layered ? undefined : multis.get(id);
    if (layers) {
      const row = layers.rows[index];
      if (!row)
        throw new LoaderError(F, 'range', `property index ${index} is outside multiproperties ${id.slice(0, 32)}`);
      const out: ReturnType<typeof sample> = {};
      layers.pids.forEach((pid, layer) => {
        const { color, ...image } = sample(model, pid, row[layer] ?? 0, true);
        if (image.texture !== undefined && out.texture === undefined) Object.assign(out, image);
        if (color) {
          const under = out.color,
            a = color[3];
          if (under) {
            const multiply = layers.blends[layer - 1] === 'multiply';
            out.color = [0, 1, 2].map((c) =>
              LinearToSRGB(
                multiply
                  ? SRGBToLinear(color[c]) * SRGBToLinear(under[c])
                  : SRGBToLinear(color[c]) * a + SRGBToLinear(under[c]) * (1 - a),
              ),
            ) as Color;
            out.color[3] = multiply ? a * under[3] : a + under[3] * (1 - a);
          } else out.color = [...color];
        }
      });
      return out;
    }
    const colorsOf = model.properties.get(id);
    if (!colorsOf) return {};
    if (index >= colorsOf.length)
      throw new LoaderError(F, 'range', `property index ${index} is outside property group ${id.slice(0, 32)}`);
    return { color: colorsOf[index] };
  };
  const at = (model: ThreeMFModel, ...where: Parameters<typeof cornerProperty>): ReturnType<typeof sample> => {
    const property = cornerProperty(...where);
    return property ? sample(model, property.id, property.index, false) : {};
  };

  const extension: ThreeMFExtension = {
    element(model, name, a) {
      if (name === 'basematerials' && a.id) store(model).materials.add(a.id);
    },
    open(model, name, a) {
      switch (name) {
        case 'texture2d': {
          const id = required(a.id, name, 'id');
          store(model).textures.set(id, textures.length);
          textures.push({
            path: required(a.path, name, 'path'),
            contentType: a.contenttype ?? '',
            data: new Uint8Array(0),
            tileStyleU: a.tilestyleu ?? 'wrap',
            tileStyleV: a.tilestylev ?? 'wrap',
            filter: a.filter ?? 'auto',
          });
          break;
        }
        case 'texture2dgroup': {
          const id = required(a.id, name, 'id');
          group = { texture: required(a.texid, name, 'texid'), coords: [] };
          store(model).groups.set(id, group);
          model.propertyIds.push(id);
          break;
        }
        case 'tex2coord': {
          const u = Number(a.u),
            v = Number(a.v);
          if (!Number.isFinite(u) || !Number.isFinite(v))
            throw new LoaderError(F, 'syntax', `invalid texture coordinate "${a.u}, ${a.v}"`);
          group?.coords.push(u, v);
          break;
        }
        case 'multiproperties': {
          const id = required(a.id, name, 'id');
          const pids = required(a.pids, name, 'pids').trim().split(/\s+/),
            blends = a.blendmethods?.trim().split(/\s+/) ?? [];
          if (blends.length >= pids.length || blends.some((b) => b !== 'mix' && b !== 'multiply'))
            throw new LoaderError(F, 'range', 'blendmethods must contain mix/multiply for at most layers minus one');
          const { groups, multis, materials } = store(model),
            kinds = pids.map((pid, k) => {
              if (groups.has(pid)) return 'texture' as const;
              if (multis.has(pid))
                throw new LoaderError(F, 'syntax', 'a multiproperties must not name a multiproperties');
              if (!model.properties.has(pid))
                throw new LoaderError(F, 'syntax', `property group ${pid.slice(0, 32)} is not defined`);
              if (materials.has(pid) && k)
                throw new LoaderError(F, 'syntax', 'a multiproperties names one material group at most, first');
              return 'color' as const;
            });
          if (kinds.filter((kind, k) => kind === 'color' && !materials.has(pids[k])).length > 1)
            throw new LoaderError(F, 'syntax', 'a multiproperties names one colour group at most');
          multi = { pids, rows: [], blends, kinds };
          store(model).multis.set(id, multi);
          model.propertyIds.push(id);
          break;
        }
        case 'multi':
          multi?.rows.push(list(a.pindices, 'pindices'));
          break;
        case 'compositematerials': {
          const id = required(a.id, name, 'id'),
            base = model.properties.get(required(a.matid, name, 'matid'));
          if (!base) throw new LoaderError(F, 'syntax', `material group ${a.matid.slice(0, 32)} is not defined`);
          composite = { base, indices: list(a.matindices, 'matindices'), colors: [] };
          store(model).materials.add(id);
          model.properties.set(id, composite.colors);
          model.propertyIds.push(id);
          break;
        }
        case 'composite': {
          if (!composite) break;
          const { base, indices } = composite,
            values = list(a.values, 'values'),
            mixed: Color = [0, 0, 0, 0];
          let total = 0;
          indices.forEach((index, i) => {
            const weight = values[i] ?? 0,
              color = base[index];
            if (weight < 0) throw new LoaderError(F, 'range', 'composite weights must be nonnegative');
            if (!color) throw new LoaderError(F, 'range', `matindices entry ${index} is outside its material group`);
            total += weight;
            for (let c = 0; c < 4; c++) mixed[c] += (c < 3 ? SRGBToLinear(color[c]) : color[c]) * weight;
          });
          if (total === 0) {
            for (const index of indices)
              for (let c = 0; c < 4; c++) mixed[c] += c < 3 ? SRGBToLinear(base[index][c]) : base[index][c];
            total = indices.length;
          }
          composite.colors.push(
            mixed.map((value, c) => (c < 3 ? LinearToSRGB(value / total) : value / total)) as Color,
          );
          break;
        }
      }
    },
    close(_, name) {
      if (name === 'texture2dgroup') group = undefined;
      else if (name === 'multiproperties') multi = undefined;
      else if (name === 'compositematerials') composite = undefined;
    },
    async ready(read) {
      for (const texture of textures) texture.data = await read(texture.path);
    },
    bucket(model, object, mesh, t) {
      const property = cornerProperty(model, object, mesh, t, 0),
        layered = property && store(model).multis.has(property.id) ? `|m${property.id}` : '';
      return String(at(model, model, object, mesh, t, 0).texture ?? '') + layered;
    },
    corner(model, object, mesh, t, k) {
      const property = cornerProperty(model, object, mesh, t, k),
        layers = property && store(model).multis.get(property.id);
      if (layers) {
        const vertex = uvs.length / 2,
          row = layers.rows[property.index];
        if (!row)
          throw new LoaderError(
            F,
            'range',
            `property index ${property.index} is outside multiproperties ${property.id.slice(0, 32)}`,
          );
        layers.pids.forEach((pid, layer) => {
          // A pindex the row leaves out is 0 (spec 5.1).
          const { color, u, v } = sample(model, pid, row[layer] ?? 0, true),
            name = `layer${color ? 'Color' : 'UV'}${layer}`;
          let data = layerData.get(name);
          if (!data) layerData.set(name, (data = { size: color ? 4 : 2, values: new Map() }));
          data.values.set(vertex, color ? [...color] : [u ?? 0, v ?? 0]);
        });
      }
      const { texture, u, v, color } = at(model, model, object, mesh, t, k);
      if (texture !== undefined) textured = true;
      uvs.push(u ?? 0);
      uvs.push(v ?? 0);
      const [r, g, b] = color ?? [1, 1, 1];
      colors.push3(r, g, b);
      const alpha = color?.[3] ?? 1;
      opacity.push(alpha);
      if (alpha !== 1) translucent = true;
      if (!varied) {
        const first = at(model, model, object, mesh, t, 0).color;
        varied = color !== first || (store(model).multis.size > 0 && color !== undefined);
      }
    },
    group(target: ThreeMFMaterialGroup, model, object, mesh, t) {
      const { texture } = at(model, model, object, mesh, t, 0);
      if (texture !== undefined) target.texture = texture;
      const property = cornerProperty(model, object, mesh, t, 0),
        { multis, groups, textures: known } = store(model),
        layers = property && multis.get(property.id);
      if (layers)
        target.layers = layers.pids.map((pid, k): ThreeMFLayer => {
          const kind = layers.kinds[k];
          return {
            kind,
            ...(kind === 'texture' ? { texture: known.get(groups.get(pid)!.texture) } : {}),
            attribute: `layer${kind === 'texture' ? 'UV' : 'Color'}${k}`,
            blend: k && layers.blends[k - 1] === 'multiply' ? 'multiply' : 'mix',
          };
        });
    },
  };
  const hooks: ThreeMFExtension = extra
    ? {
        element(model, name, a) {
          extension.element?.(model, name, a);
          return extra.element?.(model, name, a);
        },
        instance: extra.instance,
        hasGeometry: extra.hasGeometry,
        open(model, name, a) {
          extension.open?.(model, name, a);
          extra.open?.(model, name, a);
        },
        close(model, name) {
          extension.close?.(model, name);
          extra.close?.(model, name);
        },
        async ready(read, context) {
          await extra.ready?.(read, context);
          await extension.ready?.(read, context);
        },
        bucket(model, object, mesh, t) {
          return extension.bucket(model, object, mesh, t) + '|' + extra.bucket(model, object, mesh, t);
        },
        corner(model, object, mesh, t, k) {
          extension.corner(model, object, mesh, t, k);
          extra.corner(model, object, mesh, t, k);
        },
        group(group, model, object, mesh, t) {
          extension.group(group, model, object, mesh, t);
          extra.group(group, model, object, mesh, t);
        },
      }
    : extension;
  const result = (await read3MF(input, options, hooks)) as ThreeMFMaterials;
  result.textures = textures;
  if (textured) result.uvs = uvs.result();
  if (varied) result.colors = colors.result();
  else delete result.colors;
  if (translucent) result.attributes = { ...result.attributes, opacity: opacity.result() };
  const vertices = result.positions.length / 3;
  for (const [name, { size, values }] of layerData) {
    const out = new Float32Array(vertices * size);
    for (const [vertex, value] of values) out.set(value, vertex * size);
    result.attributes = { ...result.attributes, [name]: out };
  }
  return result;
}
