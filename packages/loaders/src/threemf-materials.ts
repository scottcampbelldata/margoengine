// 3MF materials extension on top of parse3MF: texture2d, texture2dgroup, compositematerials, multiproperties and the
// display properties (metallic, specular and translucent).
import { LoaderError, type LoadedGroup } from './types.js';
import type { BinaryInput } from './util.js';
import { floats } from './util.js';
import { SRGBToLinear, LinearToSRGB, hexColor } from '@margoengine/math/color';
import {
  THREEMF_UNITS,
  cornerProperty,
  read3MF,
  type ThreeMFExtension,
  type ThreeMFModel,
  type ThreeMFOptions,
  type ThreeMFResult,
} from './threemf.js';

const F = '3MF';
type Color = [number, number, number, number];
/** The arguments that name one triangle. */
type Triangle = Parameters<ThreeMFExtension['bucket']>;

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

/**
 * The metalness and roughness a group's triangles are shown with: the materials extension's `pbmetallic`, or its
 * `pbmetallictexturedisplayproperties` (chapter 7 of the extension).
 */
export interface ThreeMFMetallic {
  /** The element's `name`, usually the material's. */
  name: string;
  /** The metalness, 0 to 1. With `metalnessTexture` it is the factor over the sampled value (default 1). */
  metalness: number;
  /** The roughness, 0 to 1. With `roughnessTexture` it is the factor over the sampled value (default 1). */
  roughness: number;
  /**
   * Index into `textures` of the linear map metalness is sampled from, at the group's own coordinates and with the tile
   * style and filter of its colour texture: the red channel, or the green one when `roughnessTexture` is the same
   * resource.
   */
  metalnessTexture?: number;
  /** Index into `textures` of the linear map roughness is sampled from, in its red channel. */
  roughnessTexture?: number;
  /** `basecolorfactor`, sRGB red, green, blue and linear alpha over the colour texture, when it is not white. */
  baseColorFactor?: [number, number, number, number];
  /** In a `multiproperties` stack, the index of the layer these properties come from. */
  layer?: number;
}

/**
 * The specular colour and glossiness a group's triangles are shown with: the materials extension's `pbspecular`, or its
 * `pbspeculartexturedisplayproperties` (chapter 7 of the extension). The diffuse colour is the group's own colour or
 * colour texture.
 */
export interface ThreeMFSpecular {
  /** The element's `name`, usually the material's. */
  name: string;
  /**
   * Reflectance at normal incidence, sRGB red, green and blue (default `#383838`, 4 % in linear light, as plastics have).
   * With `specularTexture` it is the factor over the sampled colour (default white).
   */
  specularColor: [number, number, number];
  /** Smoothness, 0 (rough, the default) to 1 (mirror). With `glossinessTexture` it is the factor (default 1). */
  glossiness: number;
  /** Index into `textures` of the sRGB map the specular colour is sampled from, at the group's own coordinates. */
  specularTexture?: number;
  /**
   * Index into `textures` of the linear map glossiness is sampled from: the alpha channel when it is the same resource
   * as `specularTexture`, else the red one.
   */
  glossinessTexture?: number;
  /** `diffusefactor`, sRGB red, green, blue and linear alpha over the colour texture, when it is not white. */
  diffuseFactor?: [number, number, number, number];
  /** In a `multiproperties` stack, the index of the layer these properties come from. */
  layer?: number;
}

/** The volume a translucent group's triangles enclose: the materials extension's `translucent` (section 7.5). */
export interface ThreeMFTranslucent {
  /** The element's `name`, usually the print material's. */
  name: string;
  /**
   * Linear attenuation of red, green and blue per metre, whatever the model's unit: light keeps `exp(-a * t)` of itself
   * after `t` metres inside (Beer-Lambert). 0 is clear.
   */
  attenuation: [number, number, number];
  /** Index of refraction of red, green and blue. Default 1, 1, 1: light passes straight through. */
  refractiveIndex: [number, number, number];
  /** Roughness of the surface, 0 (the default) to 1. */
  roughness: number;
  /** In a `multiproperties` stack, the index of the layer these properties come from. */
  layer?: number;
}

/** A group of {@link ThreeMFMaterials}: {@link LoadedGroup} with the texture its triangles sample. */
export interface ThreeMFMaterialGroup extends LoadedGroup {
  /** Index into `textures`: the group's only texture, or the first texture layer of its `layers`. */
  texture?: number;
  /** The whole layer stack, when the group's triangles use a `multiproperties`; `create3MFMesh` draws it. */
  layers?: ThreeMFLayer[];
  /**
   * The metallic display properties of the group's triangles (their first corner's, as the spec says). A group has at
   * most one of `metallic`, `specular` and `translucent`, and none when the file gives no display properties. In a stack
   * they are those of the lowest layer that has any. `create3MFMesh` draws them.
   */
  metallic?: ThreeMFMetallic;
  /** The specular display properties of the group's triangles, chosen as `metallic` is. */
  specular?: ThreeMFSpecular;
  /** The translucent display properties of the group's triangles, chosen as `metallic` is. */
  translucent?: ThreeMFTranslucent;
}

/** What {@link parse3MFMaterials} returns: {@link ThreeMFResult} with textures, and one vertex per triangle corner. */
export interface ThreeMFMaterials extends ThreeMFResult {
  groups: ThreeMFMaterialGroup[];
  /** Every texture the package declares. */
  textures: ThreeMFTexture[];
  /**
   * Metres in one unit of `positions`, which the reader sets: 1, or the length of the model's unit with
   * `units: 'file'`. Default 1.
   */
  metresPerUnit?: number;
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
  /** Display property resources by id. */
  displays: Map<string, Display>;
  /** A property group's `displaypropertiesid`. */
  shown: Map<string, string>;
  /** The `displaypropertiesid` of single `<base>` elements, as the 3MF Consortium's metallic sample writes it. */
  bases: Map<string, Map<number, string>>;
}
/** The display property kinds, each under the name of the group field that holds it. */
interface Finishes {
  metallic: ThreeMFMetallic;
  specular: ThreeMFSpecular;
  translucent: ThreeMFTranslucent;
}
/** A triangle's display properties: their kind and values. */
type Finish = { [K in keyof Finishes]: [K, Finishes[K]] }[keyof Finishes];
/** A resource of display properties: one entry for each of a property group's, or two maps over a texture group. */
type Display =
  | { kind: keyof Finishes; entries: Finishes[keyof Finishes][] }
  | {
      kind: 'metallic' | 'specular';
      entry: ThreeMFMetallic | ThreeMFSpecular;
      /** The two `texture2d` ids: metalness and roughness, or specular colour and glossiness. */
      maps: [string, string];
    };

/** A display property number: `fallback` when absent, refused below 0 or above `max`. */
function amount(value: string | undefined, fallback: number, max: number, what: string): number {
  if (value === undefined) return fallback;
  const number = value.trim() ? Number(value) : Number.NaN;
  if (!(Number.isFinite(number) && number >= 0 && number <= max))
    throw new LoaderError(F, 'range', `invalid ${what} "${value.slice(0, 32)}"`);
  return number;
}

/** An sRGB colour attribute, `fallback` when absent. */
function colorOf(value: string | undefined, fallback: Color): Color {
  if (value === undefined) return fallback;
  const color = hexColor(value.trim());
  if (!color) throw new LoaderError(F, 'syntax', `invalid color "${value.slice(0, 16)}"`);
  return color;
}

/** Three numbers of 0 or more, above 0 with `positive`. */
function triplet(value: string, what: string, positive: boolean): [number, number, number] {
  const out = list(value, what);
  if (out.length !== 3) throw new LoaderError(F, 'syntax', `${what} needs three numbers, not "${value.slice(0, 64)}"`);
  if (out.some((v) => v < 0 || (positive && v === 0)))
    throw new LoaderError(F, 'range', `invalid ${what} "${value.slice(0, 64)}"`);
  return out as [number, number, number];
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
 * coordinates, `compositematerials` as mixed colours, `multiproperties` layers, and the display properties as each
 * group's `metallic` (`pbmetallic` and `pbmetallictexturedisplayproperties`), `specular` (`pbspecular` and
 * `pbspeculartexturedisplayproperties`) or `translucent`. Every triangle corner gets its own
 * vertex, so `uvs` and `colors` can differ across a seam; `uvs` use Margo's convention, v = 1 - the file's v. `colors` is
 * present when corners of a triangle differ or a layer sets them. A group's `texture` indexes `textures`. In
 * `multiproperties` colour layers mix by their alpha, and the first texture layer sets the group's texture: draw
 * `colors` as a tint over it.
 *
 * @param input The package's bytes.
 * @param options The same options as `parse3MF`.
 * @returns The merged mesh with its coordinates, colours and images.
 * @throws LoaderError with the codes of `parse3MF`, with `range` for a property index outside its group or its display
 *   properties, for a metalness, roughness or glossiness outside 0 to 1 (a texture's factor: below 0), a negative
 *   attenuation or a refractive index of 0 or less, and `syntax` for display properties that are not defined or are of a
 *   kind their group cannot take, and for a colour or a number triplet that is not one.
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
    /** The open container of display properties, and the open `basematerials` with the `<base>` elements seen in it. */
    entries: Finishes[keyof Finishes][] | undefined,
    materialGroup: { id: string; count: number } | undefined,
    textured = false,
    varied = false,
    translucent = false;
  const store = (model: ThreeMFModel): Store => {
    let found = stores.get(model);
    if (!found) {
      found = {
        textures: new Map(),
        groups: new Map(),
        multis: new Map(),
        materials: new Set(),
        displays: new Map(),
        shown: new Map(),
        bases: new Map(),
      };
      stores.set(model, found);
    }
    return found;
  };
  /** The display properties of entry `index` of a property group. Read after parsing, so a later resource counts. */
  const finish = (model: ThreeMFModel, id: string, index: number): Finish | undefined => {
    const { displays, shown, bases, groups, multis, textures: known } = store(model),
      layers = multis.get(id);
    if (layers) {
      for (let layer = 0; layer < layers.pids.length; layer++) {
        const found = finish(model, layers.pids[layer], layers.rows[index]?.[layer] ?? 0);
        if (found) return [found[0], { ...found[1], layer }] as Finish;
      }
      return undefined;
    }
    const reference = shown.get(id) ?? bases.get(id)?.get(index);
    if (reference === undefined) return undefined;
    const display = displays.get(reference),
      refuse = (code: 'syntax' | 'range', what: string): never => {
        throw new LoaderError(F, code, what);
      },
      short = reference.slice(0, 32);
    if (!display) return refuse('syntax', `display properties ${short} are not defined`);
    if ('maps' in display !== groups.has(id))
      return refuse('syntax', `property group ${id.slice(0, 32)} cannot take the kind of display properties ${short}`);
    if (!('maps' in display))
      return [
        display.kind,
        display.entries[index] ?? refuse('range', `property index ${index} is outside display properties ${short}`),
      ] as Finish;
    const [first, second] = display.maps.map(
        (texture) => known.get(texture) ?? refuse('syntax', `texture ${texture.slice(0, 32)} is not defined`),
      ),
      named =
        display.kind === 'metallic'
          ? { metalnessTexture: first, roughnessTexture: second }
          : { specularTexture: first, glossinessTexture: second };
    return [display.kind, { ...display.entry, ...named }] as Finish;
  };
  /** A triangle's display properties: its first corner's. */
  const finishAt = (...[model, object, mesh, t]: Triangle): Finish | undefined => {
    const property = cornerProperty(model, object, mesh, t, 0);
    return property && finish(model, property.id, property.index);
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
      if (name === 'basematerials' || name === 'colorgroup') {
        if (a.id && a.displaypropertiesid) store(model).shown.set(a.id, a.displaypropertiesid);
        if (name === 'basematerials' && a.id) {
          store(model).materials.add(a.id);
          materialGroup = { id: a.id, count: 0 };
        }
      } else if (name === 'base' && materialGroup) {
        const index = materialGroup.count++;
        if (a.displaypropertiesid) {
          const { bases } = store(model);
          let own = bases.get(materialGroup.id);
          if (!own) bases.set(materialGroup.id, (own = new Map()));
          own.set(index, a.displaypropertiesid);
        }
      }
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
          if (a.displaypropertiesid) store(model).shown.set(id, a.displaypropertiesid);
          model.propertyIds.push(id);
          break;
        }
        case 'pbmetallicdisplayproperties':
        case 'pbspeculardisplayproperties':
        case 'translucentdisplayproperties': {
          const kind =
            name === 'translucentdisplayproperties'
              ? 'translucent'
              : name === 'pbspeculardisplayproperties'
                ? 'specular'
                : 'metallic';
          entries = [];
          store(model).displays.set(required(a.id, name, 'id'), { kind, entries });
          break;
        }
        case 'pbmetallic':
          entries?.push({
            name: a.name ?? '',
            metalness: amount(a.metallicness, 0, 1, 'metallicness'),
            roughness: amount(a.roughness, 1, 1, 'roughness'),
          });
          break;
        case 'pbspecular': {
          const [r, g, b] = colorOf(a.specularcolor, [56 / 255, 56 / 255, 56 / 255, 1]);
          entries?.push({
            name: a.name ?? '',
            specularColor: [r, g, b],
            glossiness: amount(a.glossiness, 0, 1, 'glossiness'),
          });
          break;
        }
        case 'translucent':
          entries?.push({
            name: a.name ?? '',
            attenuation: triplet(required(a.attenuation, name, 'attenuation'), 'attenuation', false),
            refractiveIndex: triplet(a.refractiveindex ?? '1 1 1', 'refractiveindex', true),
            roughness: amount(a.roughness, 0, 1, 'roughness'),
          });
          break;
        case 'pbmetallictexturedisplayproperties': {
          const factor = colorOf(a.basecolorfactor, [1, 1, 1, 1]);
          store(model).displays.set(required(a.id, name, 'id'), {
            kind: 'metallic',
            maps: [
              required(a.metallictextureid, name, 'metallictextureid'),
              required(a.roughnesstextureid, name, 'roughnesstextureid'),
            ],
            entry: {
              name: a.name ?? '',
              // A factor above 1 brightens the sampled value, which stays at most 1.
              metalness: amount(a.metallicfactor, 1, Number.MAX_VALUE, 'metallicfactor'),
              roughness: amount(a.roughnessfactor, 1, Number.MAX_VALUE, 'roughnessfactor'),
              ...(factor.some((value) => value !== 1) ? { baseColorFactor: factor } : {}),
            },
          });
          break;
        }
        case 'pbspeculartexturedisplayproperties': {
          const [r, g, b] = colorOf(a.specularfactor, [1, 1, 1, 1]),
            diffuse = colorOf(a.diffusefactor, [1, 1, 1, 1]);
          store(model).displays.set(required(a.id, name, 'id'), {
            kind: 'specular',
            maps: [
              required(a.speculartextureid, name, 'speculartextureid'),
              required(a.glossinesstextureid, name, 'glossinesstextureid'),
            ],
            entry: {
              name: a.name ?? '',
              specularColor: [r, g, b],
              glossiness: amount(a.glossinessfactor, 1, Number.MAX_VALUE, 'glossinessfactor'),
              ...(diffuse.some((value) => value !== 1) ? { diffuseFactor: diffuse } : {}),
            },
          });
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
          if (a.displaypropertiesid) store(model).shown.set(id, a.displaypropertiesid);
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
      else if (name.endsWith('displayproperties')) entries = undefined;
      else if (name === 'basematerials') materialGroup = undefined;
    },
    async ready(read) {
      for (const texture of textures) texture.data = await read(texture.path);
    },
    bucket(model, object, mesh, t) {
      const property = cornerProperty(model, object, mesh, t, 0),
        layered = property && store(model).multis.has(property.id) ? `|m${property.id}` : '';
      const found = finishAt(model, object, mesh, t),
        // The name does not change how a triangle looks, so it does not split a group.
        shown = found ? `|${found[0]}${JSON.stringify({ ...found[1], name: undefined })}` : '';
      return String(at(model, model, object, mesh, t, 0).texture ?? '') + layered + shown;
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
      const found = finishAt(model, object, mesh, t);
      if (found) Object.assign(target, { [found[0]]: found[1] });
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
  result.metresPerUnit = options.units === 'file' ? THREEMF_UNITS[result.unit as keyof typeof THREEMF_UNITS] : 1;
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
