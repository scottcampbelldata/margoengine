// 3MF writer, from the 3MF Consortium's Core Specification 1.4.0 and Materials and Properties Extension 1.2.1: the format
// slicers prefer over STL, because it holds units, colours and one object placed many times. Printers need closed meshes,
// so vertices that share a position are written once whatever else differs between them.
// https://github.com/3MFConsortium/spec_core and https://github.com/3MFConsortium/spec_materials
import { MargoError } from '@margoengine/math/errors';
import { encodeZIP } from './archive.js';
import { sceneOfGLB } from './glb-scene.js';
import {
  collect,
  determinant3,
  drawables,
  normalizeMaterial,
  num,
  type Drawable,
  type ExportSource,
  type Geo,
  type Mat,
  type TextureData,
  type SceneOptions,
  type ExportWarning,
} from './scene.js';

/** Metres in each unit 3MF names. */
const UNITS = {
  micron: 1e-6,
  millimeter: 1e-3,
  centimeter: 1e-2,
  inch: 0.0254,
  foot: 0.3048,
  meter: 1,
} as const;

/** A length unit of a 3MF file. */
export type ThreeMFUnit = keyof typeof UNITS;

/** One vendor `<metadata>` entry under its own XML namespace, as the core specification asks of names it does not define. */
export interface ThreeMFCustomMetadata {
  /** The namespace URI that owns the name. */
  namespace: string;
  /** An XML name without a colon, such as `Material`. */
  name: string;
  /** The entry's text. */
  value: string;
  /** Asks editors to keep the entry when they save the file again. Default false. */
  preserve?: boolean;
}

/** The model metadata the core specification names (Table 3-1), beside `title`, and vendor entries. */
export interface ThreeMFMetadata {
  /** `Designer`: who made the model. */
  designer?: string;
  /** `Description` of the model. */
  description?: string;
  /** `Copyright` notice. */
  copyright?: string;
  /** `LicenseTerms` it is shared under. */
  licenseTerms?: string;
  /** `Rating` for its audience. */
  rating?: string;
  /** `CreationDate`, such as `'2026-11-27'`. */
  creationDate?: string;
  /** `ModificationDate`, written as given. */
  modificationDate?: string;
  /** `Application` that wrote the file. */
  application?: string;
  /** Vendor entries, each under its own namespace. */
  custom?: readonly ThreeMFCustomMetadata[];
}

/**
 * How an object's mesh closes, counted on the welded triangles. A solid to print has all three counts 0 and
 * `insideOut` false (core specification section 4.1).
 */
export interface ThreeMFMeshReport {
  /** The node's name. */
  name?: string;
  /** Edges only one triangle uses: holes. */
  openEdges: number;
  /** Edges more than two triangles use. */
  nonManifoldEdges: number;
  /** Edges whose two triangles run along it the same way, so one of them faces the other way. */
  flippedEdges: number;
  /** The mesh is closed and consistent but its faces point inward. */
  insideOut: boolean;
}

/** Options for {@link export3MF}. Scene lengths are metres, as in glTF. */
export interface Export3MFOptions extends SceneOptions {
  /** The file's unit. Lengths are converted, so a 1 m cube is 1000 units long in `'millimeter'`. Default `'millimeter'`. */
  unit?: ThreeMFUnit;
  /** Which scene axis is up. A printer's Z is up, so `'y'`, the glTF way, turns the scene to stand on the bed. Default `'y'`. */
  upAxis?: 'y' | 'z';
  /** Written as the file's Title metadata, and as the name of the assembly. */
  title?: string;
  /** The model's other metadata. Default none. */
  metadata?: ThreeMFMetadata;
  /** A PNG or JPEG picture of the model, written as the package thumbnail that file browsers and slicers show. */
  thumbnail?: Uint8Array;
  /**
   * Writes each material's metalness and roughness as the materials extension's physically based display properties,
   * where they differ from the extension's own 0 and 1. A base colour texture's metallic-roughness map is written with
   * it when both use the same UV set, transform and wrap. Default `true`.
   */
  displayProperties?: boolean;
  /**
   * `true` writes a scene of several nodes as one object whose mesh holds every part where the scene put it, each part a
   * shell of its own, so a slicer keeps them together and prints their union by the format's positive fill rule.
   * `'components'` keeps them one object too, made of components that place shared meshes, so a geometry drawn twice is
   * stored once; some slicers read each component as an object of its own. `false` writes one build item for each node,
   * a geometry drawn twice stored once: slicers read each item as an object they move on their own, so parts that
   * overlap collide. Default `true`.
   */
  assembly?: boolean | 'components';
  /** Deflates the package's parts; `false` stores them. Default `true`. */
  compress?: boolean;
  /** Called once for each mesh written with how it closes. Nothing is repaired. */
  onMeshCheck?: (report: ThreeMFMeshReport) => void;
  /** Stops the archive step. */
  signal?: AbortSignal;
}

const escaped = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

const byte = (linear: number): number => {
  const v = Math.min(1, Math.max(0, linear)),
    srgb = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
};
const hex = (value: number): string => value.toString(16).padStart(2, '0').toUpperCase();

/** A colour of linear RGB and alpha as 3MF writes it: sRGB, the alpha left out when opaque. */
const colorOf = (r: number, g: number, b: number, a: number): string => {
  const alpha = Math.round(Math.min(1, Math.max(0, a)) * 255);
  return `#${hex(byte(r))}${hex(byte(g))}${hex(byte(b))}${alpha === 255 ? '' : hex(alpha)}`;
};

/** Vertices unique by position, in file units. */
interface Weld {
  vertices: number[];
  known: Map<string, number>;
}

/** One part's triangles on a weld, each corner with an entry of `palette` when the part has colours. */
interface Shape {
  weld: Weld;
  triangles: number[];
  /** For each corner of each triangle, the index in `palette` of its colour, or when textured of its `u v tint`. */
  corners?: number[];
  palette?: string[];
}

/** The positions moved by `transform`, a column-major 4 x 4 matrix. */
function moved(positions: ArrayLike<number>, m: ArrayLike<number>): Float64Array {
  const out = new Float64Array(positions.length);
  for (let v = 0; v + 2 < positions.length; v += 3) {
    const x = positions[v],
      y = positions[v + 1],
      z = positions[v + 2];
    for (let k = 0; k < 3; k++) out[v + k] = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k];
  }
  return out;
}

/** Adds a part to a weld, in file units, dropping the triangles that leaves with no area. `mirrored` reverses them. */
function shapeOf(
  weld: Weld,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  colors: ((vertex: number) => string) | undefined,
  scale: number,
  mirrored: boolean,
): Shape {
  const { known, vertices } = weld,
    welded = new Uint32Array(positions.length / 3);
  for (let v = 0; v < welded.length; v++) {
    const x = Math.fround(positions[v * 3] * scale),
      y = Math.fround(positions[v * 3 + 1] * scale),
      z = Math.fround(positions[v * 3 + 2] * scale),
      key = `${x} ${y} ${z}`;
    if (!Number.isFinite(x + y + z))
      throw new RangeError('3MF position exceeds Float32 range in this unit; pick a larger unit or lower the scale');
    let at = known.get(key);
    if (at === undefined) {
      at = vertices.length / 3;
      known.set(key, at);
      vertices.push(x, y, z);
    }
    welded[v] = at;
  }
  const triangles: number[] = [],
    corners: number[] = [],
    palette = new Map<string, number>(),
    paletteIndex = (color: string): number => {
      let at = palette.get(color);
      if (at === undefined) palette.set(color, (at = palette.size));
      return at;
    };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = welded[indices[i]],
      b = welded[indices[i + 1]],
      c = welded[indices[i + 2]];
    if (a === b || b === c || a === c) continue;
    triangles.push(a, mirrored ? c : b, mirrored ? b : c);
    if (colors) for (const k of mirrored ? [0, 2, 1] : [0, 1, 2]) corners.push(paletteIndex(colors(indices[i + k])));
  }
  return colors ? { weld, triangles, corners, palette: [...palette.keys()] } : { weld, triangles };
}

/** Counts how the triangles' edges pair up: each edge of a solid is run once in each direction. */
function edgesOf(triangles: readonly number[]): { open: number; many: number; flipped: number } {
  const edges = new Map<string, [number, number]>();
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k],
        b = triangles[t + ((k + 1) % 3)],
        key = a < b ? `${a} ${b}` : `${b} ${a}`;
      let uses = edges.get(key);
      if (!uses) edges.set(key, (uses = [0, 0]));
      uses[a < b ? 0 : 1]++;
    }
  let open = 0,
    many = 0,
    flipped = 0;
  for (const [forward, back] of edges.values()) {
    if (forward + back === 1) open++;
    else if (forward + back > 2) many++;
    else if (forward !== 1) flipped++;
  }
  return { open, many, flipped };
}

/** {@link ThreeMFMeshReport} of one node's shells; the volume's sign is by the divergence theorem. */
function reportOf(shapes: readonly Shape[], name: string | undefined): ThreeMFMeshReport {
  const welds = new Map<Weld, number[]>();
  for (const { weld, triangles } of shapes) {
    let all = welds.get(weld);
    if (!all) welds.set(weld, (all = []));
    for (const index of triangles) all.push(index);
  }
  let openEdges = 0,
    nonManifoldEdges = 0,
    flippedEdges = 0,
    inward = false;
  for (const [{ vertices }, triangles] of welds) {
    const edges = edgesOf(triangles);
    openEdges += edges.open;
    nonManifoldEdges += edges.many;
    flippedEdges += edges.flipped;
    if (edges.open || edges.many || edges.flipped) continue;
    // Six times the shell's volume, about its first vertex so that a shell far from the origin keeps its sign.
    const [ox, oy, oz] = vertices.slice(triangles[0] * 3, triangles[0] * 3 + 3);
    let volume = 0;
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t] * 3, triangles[t + 1] * 3, triangles[t + 2] * 3],
        ax = vertices[a] - ox,
        ay = vertices[a + 1] - oy,
        az = vertices[a + 2] - oz,
        bx = vertices[b] - ox,
        by = vertices[b + 1] - oy,
        bz = vertices[b + 2] - oz,
        cx = vertices[c] - ox,
        cy = vertices[c + 1] - oy,
        cz = vertices[c + 2] - oz;
      volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    if (volume < 0) inward = true;
  }
  return {
    ...(name === undefined ? {} : { name }),
    openEdges,
    nonManifoldEdges,
    flippedEdges,
    insideOut: inward,
  };
}

/** Reads a corner's colour: the vertex colour times the material's. */
function vertexColors(geometry: Geo, material: Mat): ((vertex: number) => string) | undefined {
  const { colors, colorSize } = geometry;
  if (!colors) return undefined;
  return (vertex) => {
    const at = vertex * colorSize,
      [r, g, b, a] = material.color;
    return colorOf(colors[at] * r, colors[at + 1] * g, colors[at + 2] * b, (colorSize === 4 ? colors[at + 3] : 1) * a);
  };
}

/**
 * A corner's texture coordinate as the materials extension writes it: the glTF texture transform (offset times rotation
 * times scale) applied, then v turned to point up, as 3MF's origin is the image's lower left corner.
 */
function textureCoordinates(geometry: Geo, material: Mat): ((vertex: number) => string) | undefined {
  const texture = material.baseColorTexture;
  if (!texture) return undefined;
  const uvs = [geometry.uvs, geometry.uvs1, geometry.uvs2, geometry.uvs3][texture.texCoord ?? 0];
  if (!uvs) return undefined;
  const { offset = [0, 0], scale = [1, 1], rotation = 0 } = material.baseColorTextureTransform ?? {},
    cos = Math.cos(rotation),
    sin = Math.sin(rotation);
  return (vertex) => {
    const u = uvs[vertex * 2] * scale[0],
      v = uvs[vertex * 2 + 1] * scale[1];
    return `${num(offset[0] + cos * u + sin * v)} ${num(1 - (offset[1] - sin * u + cos * v))}`;
  };
}

/**
 * A textured corner's tint: the vertex colour times the material's, without alpha, as the materials extension takes the
 * first layer of a `multiproperties` as opaque (section 5).
 */
function tintOf(geometry: Geo, material: Mat): (vertex: number) => string {
  const own = vertexColors(geometry, material),
    [r, g, b] = material.color,
    flat = colorOf(r, g, b, 1);
  return own ? (vertex) => own(vertex).slice(0, 7) : () => flat;
}

/** The scene `world` matrix with the turn to Z up, column-major. */
function upright(world: ArrayLike<number>, zUp: boolean): number[] {
  const out = Array.from(world);
  if (zUp)
    for (let at = 0; at < 16; at += 4) {
      out[at + 1] = -world[at + 2];
      out[at + 2] = world[at + 1];
    }
  return out;
}

const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02',
  MATERIAL = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02',
  RELATIONSHIP = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/',
  THUMBNAIL = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail';

/** The core specification's names, by option. */
const NAMES = {
  designer: 'Designer',
  description: 'Description',
  copyright: 'Copyright',
  licenseTerms: 'LicenseTerms',
  rating: 'Rating',
  creationDate: 'CreationDate',
  modificationDate: 'ModificationDate',
  application: 'Application',
} as const;

/** The namespace declarations and `<metadata>` elements of a model. */
function metadataXml(title: string | undefined, metadata: ThreeMFMetadata): { namespaces: string; xml: string } {
  const prefixes = new Map<string, string>(),
    names = new Set<string>();
  let xml = title === undefined ? '' : `<metadata name="Title">${escaped(String(title))}</metadata>`;
  const text = (value: unknown, label: string): string => {
    if (typeof value !== 'string') throw new TypeError(`3MF metadata ${label} must be a string`);
    return escaped(value);
  };
  for (const key of Object.keys(metadata)) {
    if (key === 'custom') continue;
    if (!Object.hasOwn(NAMES, key))
      throw new RangeError(`3MF metadata ${key} is not a name the format defines; give it under metadata.custom`);
    const known = key as keyof typeof NAMES,
      value = metadata[known];
    if (value !== undefined) xml += `<metadata name="${NAMES[known]}">${text(value, key)}</metadata>`;
  }
  for (const { namespace, name, value, preserve } of metadata.custom ?? []) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name))
      throw new RangeError('A custom 3MF metadata name must be an XML name without a colon');
    if (typeof namespace !== 'string' || !namespace || namespace === CORE || namespace === MATERIAL)
      throw new RangeError('A custom 3MF metadata namespace must be a URI of your own');
    let prefix = prefixes.get(namespace);
    if (!prefix) prefixes.set(namespace, (prefix = `v${prefixes.size + 1}`));
    const full = `${prefix}:${name}`;
    if (names.has(full)) throw new RangeError(`3MF allows one metadata element of a name; ${name} is given twice`);
    names.add(full);
    xml += `<metadata name="${full}"${preserve ? ' preserve="1"' : ''}>${text(value, name)}</metadata>`;
  }
  const namespaces = [...prefixes].map(([uri, prefix]) => ` xmlns:${prefix}="${escaped(uri)}"`).join('');
  return { namespaces, xml };
}

/** A thumbnail's extension, refusing what the core specification does: other formats and CMYK JPEG. */
function thumbnailType(bytes: Uint8Array): 'png' | 'jpg' {
  if (bytes instanceof Uint8Array) {
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      // Walk the marker segments to the frame header (ITU-T T.81 B.2.2), whose tenth byte counts the components.
      let at = 2;
      while (at + 9 < bytes.length && bytes[at] === 0xff) {
        const marker = bytes[at + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          if (bytes[at + 9] === 4) throw new RangeError('A 3MF thumbnail may not be a CMYK JPEG; save it as RGB');
          break;
        }
        // 0xFF is a fill byte before a marker (B.1.1.2).
        at += marker === 0xff ? 1 : 2 + (bytes[at + 2] << 8) + bytes[at + 3];
      }
      return 'jpg';
    }
  }
  throw new TypeError('A 3MF thumbnail must be the bytes of a PNG or JPEG file');
}

/**
 * Whether a metallic-roughness map can share the base colour texture's coordinates: the materials extension samples every
 * map of a texture group at the same points, with the base texture's wrap.
 */
function aligned(material: Mat): boolean {
  const a = material.baseColorTexture!,
    b = material.metallicRoughnessTexture!,
    place = (t: Mat['baseColorTextureTransform']): string =>
      `${t?.offset ?? [0, 0]} ${t?.scale ?? [1, 1]} ${t?.rotation ?? 0}`;
  return (
    (a.texCoord ?? 0) === (b.texCoord ?? 0) &&
    (a.wrapS ?? 'repeat') === (b.wrapS ?? 'repeat') &&
    (a.wrapT ?? 'repeat') === (b.wrapT ?? 'repeat') &&
    place(material.baseColorTextureTransform) === place(material.metallicRoughnessTextureTransform)
  );
}

/**
 * What the display properties of a textured material sample: its own metallic-roughness map, the white map (`null`) for
 * factors alone, or nothing when it needs none or its map lies elsewhere on the surface.
 */
function mapOf(material: Mat): TextureData | null | undefined {
  if (material.metallicRoughnessTexture) return aligned(material) ? material.metallicRoughnessTexture : undefined;
  return finished(material) ? null : undefined;
}

/** Whether a material differs from the display properties' own default, metalness 0 and roughness 1. */
const finished = (material: Mat): boolean => material.metalness !== 0 || material.roughness !== 1;

/**
 * A map as the materials extension reads one used for both values (section 7.4): roughness in red and metalness in green,
 * where glTF has them in green and blue. A 1 x 1 white map carries factors alone.
 */
async function displayMap(texture: TextureData | null, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const { png } = await import('./png.js');
  if (!texture) return png({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }, 1, false);
  const { decodeTexture } = await import('./texture-decode.js'),
    { width, height, data: source } = await decodeTexture(texture.image, signal),
    data = new Uint8Array(width * height * 4);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = source[at + 1];
    data[at + 1] = source[at + 2];
    data[at + 3] = 255;
  }
  return png({ width, height, data }, Math.max(width, height), false);
}

/** The 3 x 4 matrix of a build item, rows of a row-vector transform as 3MF lists them, with the translation in file units. */
function itemTransform(placed: readonly number[], scale: number): string {
  const column = (at: number): number[] => placed.slice(at, at + 3);
  const out = [...column(0), ...column(4), ...column(8), ...column(12).map((value) => value * scale)];
  return out.map(num).join(' ');
}

/**
 * Exports a scene or GLB bytes as a 3MF file. A scene of one node is one object on one build item. A scene of several is one
 * object holding every part in place, so a slicer prints what the scene shows; with `assembly: false` each node is a build
 * item instead, one object for each geometry, and a mirroring node draws a reflected object those nodes share. Either way no
 * transform carries a reflection, so a slicer sees nothing inside out. Colours come from the material's
 * base colour and from vertex colours; the base colour texture is written as a materials-extension texture (`texture2d` and `texture2dgroup`, with its texture transform and wrap) where the geometry has the UV set it uses; a base colour factor or vertex colours that are not white are a colour group multiplied with it (`multiproperties`), their alpha left out. Metalness, roughness and a metallic-roughness map on the same coordinates
 * are written as display properties; the format has no normal, emissive or occlusion map. A node's primitives are one
 * mesh. Vertices are welded by position, but a slicer still needs
 * a closed mesh to print: an open one is written as it is.
 *
 * @example
 * ```ts
 * import { export3MF } from '@margoengine/exporters/threemf';
 *
 * declare const source: Parameters<typeof export3MF>[0];
 * const file = await export3MF(source, { unit: 'millimeter', title: 'Bracket' });
 * ```
 *
 * @throws RangeError for an unknown `unit`, `upAxis` or `assembly`, a bad metadata name, a CMYK thumbnail, a scene with
 * no triangles to print or a position outside Float32 range in this unit; MargoError `'unsupported'` for a node scaled to 0 on an axis (a solid to print needs a volume).
 * @throws TypeError for bytes that are not a GLB or that need decompressing; what the scene collector throws for a bad source;
 * the signal's reason on an abort.
 */
export async function export3MF(
  source: ExportSource | Uint8Array,
  options: Export3MFOptions = {},
): Promise<Uint8Array> {
  const {
    unit = 'millimeter',
    upAxis = 'y',
    title,
    metadata = {},
    thumbnail,
    displayProperties = true,
    assembly = true,
    compress = true,
    onMeshCheck,
    signal,
  } = options;
  if (!Object.hasOwn(UNITS, unit)) throw new RangeError(`3MF unit must be one of ${Object.keys(UNITS).join(', ')}`);
  if (upAxis !== 'y' && upAxis !== 'z') throw new RangeError("3MF upAxis must be 'y' or 'z'");
  if (typeof assembly !== 'boolean' && assembly !== 'components')
    throw new RangeError("3MF assembly must be true, false or 'components'");
  const described = metadataXml(title, metadata),
    preview = thumbnail === undefined ? undefined : thumbnailType(thumbnail);
  signal?.throwIfAborted();
  const scale = 1 / UNITS[unit],
    zUp = upAxis === 'y',
    fallback = normalizeMaterial({}),
    onWarning = options.onWarning ?? ((warning: ExportWarning) => console.warn(warning.message)),
    items = drawables(
      collect(source instanceof Uint8Array ? sceneOfGLB(source).scene : source, options, undefined, 'shape'),
    ),
    /** A node's primitives, which share its world matrix, are one mesh. */
    nodes = new Map<Float64Array, Drawable[]>(),
    materials = new Map<string, { index: number; color: string; material: Mat }>(),
    objects: string[] = [],
    groups: string[] = [],
    /** `texture2d` ids by image bytes and sampling, as materials of one file share images through their own records. */
    textures = new Map<Uint8Array, Map<string, number>>(),
    /** The PNG of each display map, then its resource id once a group samples it. */
    maps = new Map<Uint8Array | null, { image: Uint8Array; id?: number }>(),
    textureXml: string[] = [],
    files: { name: string; data: Uint8Array }[] = [],
    build: string[] = [],
    components: string[] = [],
    merged: { vertices: string[]; faces: string[]; pindex: number; name?: string } = {
      vertices: [],
      faces: [],
      pindex: -1,
    },
    shared = new Map<string, number>(),
    seen = new Map<object, number>(),
    numbered = (value: object): number => {
      let at = seen.get(value);
      if (at === undefined) seen.set(value, (at = seen.size));
      return at;
    };
  for (const item of items) {
    const parts = nodes.get(item.world);
    if (parts) parts.push(item);
    else nodes.set(item.world, [item]);
  }
  const together = assembly === true && nodes.size > 1;

  // Maps are decoded and re-encoded first, as the writing below does not wait.
  if (displayProperties)
    for (const item of items) {
      const material = item.material ?? fallback;
      if (!textureCoordinates(item.geometry, material)) continue;
      const map = mapOf(material);
      if (map !== undefined) {
        const source = map?.image ?? null;
        if (!maps.has(source)) maps.set(source, { image: await displayMap(map, signal) });
      } else if (material.metallicRoughnessTexture)
        onWarning({
          code: 'unsupported',
          node: null,
          message:
            '3MF samples a metallic-roughness map at the base colour coordinates; one with another UV set, transform or wrap is left out',
        });
    }

  // Ids: 1 is the base material group; objects and property groups count up from 2.
  let id = 2;
  const label = (material: Mat): string => escaped(material.name || 'Material'),
    metallic = (material: Mat): string =>
      `<m:pbmetallic name="${label(material)}" metallicness="${num(material.metalness)}" roughness="${num(material.roughness)}"/>`;
  const materialIndex = (material: Mat): number => {
    const [r, g, b, a] = material.color,
      color = colorOf(r, g, b, a),
      finish = displayProperties ? [material.metalness, material.roughness] : [],
      key = JSON.stringify([color, material.name ?? '', ...finish]);
    let found = materials.get(key);
    if (!found) materials.set(key, (found = { index: materials.size, color, material }));
    return found.index;
  };
  const addTexture = (image: Uint8Array, mimeType: TextureData['mimeType'], attributes: string): number => {
    const at = id++,
      extension = mimeType === 'image/png' ? 'png' : 'jpg',
      path = `3D/Textures/texture${files.length + 1}.${extension}`;
    files.push({ name: path, data: image });
    textureXml.push(`<m:texture2d id="${at}" path="/${path}" contenttype="${mimeType}"${attributes}/>`);
    return at;
  };
  /** The id of a `texture2d` resource for an image, written once however many materials share it. */
  const textureId = (texture: TextureData): number => {
    const tile = { repeat: 'wrap', mirror: 'mirror', clamp: 'clamp' } as const,
      attributes = ` tilestyleu="${tile[texture.wrapS ?? 'repeat']}" tilestylev="${tile[texture.wrapT ?? 'repeat']}" filter="${texture.magFilter === 'nearest' ? 'nearest' : 'auto'}"`;
    let samplings = textures.get(texture.image);
    if (!samplings) textures.set(texture.image, (samplings = new Map()));
    let at = samplings.get(attributes);
    if (at === undefined) samplings.set(attributes, (at = addTexture(texture.image, texture.mimeType, attributes)));
    return at;
  };
  /** A colour group; with `material`, its display properties, one entry for each colour. */
  const colorGroup = (colors: readonly string[], material?: Mat): number => {
    let display = '';
    if (displayProperties && material && finished(material)) {
      const at = id++;
      groups.push(
        `<m:pbmetallicdisplayproperties id="${at}">${metallic(material).repeat(colors.length)}</m:pbmetallicdisplayproperties>`,
      );
      display = ` displaypropertiesid="${at}"`;
    }
    const at = id++;
    groups.push(
      `<m:colorgroup id="${at}"${display}>${colors.map((color) => `<m:color color="${color}"/>`).join('')}</m:colorgroup>`,
    );
    return at;
  };
  /**
   * The property group a textured shape's corners index, from their `u v tint` entries. White tints leave the texture
   * group alone; any other is a colour group under the texture, multiplied with it in a `multiproperties`.
   */
  const textureGroup = (palette: readonly string[], material: Mat): number => {
    const coordinates = new Map<string, number>(),
      tints = new Map<string, number>(),
      indexIn = (known: Map<string, number>, key: string): number => {
        let at = known.get(key);
        if (at === undefined) known.set(key, (at = known.size));
        return at;
      },
      rows = palette.map((entry) => {
        const [u, v, tint] = entry.split(' ');
        return `<m:multi pindices="${indexIn(tints, tint)} ${indexIn(coordinates, `${u} ${v}`)}"/>`;
      }),
      image = textureId(material.baseColorTexture!),
      map = displayProperties ? mapOf(material) : undefined;
    let display = '';
    if (map !== undefined) {
      const sampled = maps.get(map?.image ?? null)!;
      // No tile style or filter: the extension takes them from the base colour texture.
      sampled.id ??= addTexture(sampled.image, 'image/png', '');
      const at = id++;
      groups.push(
        `<m:pbmetallictexturedisplayproperties id="${at}" name="${label(material)}" metallictextureid="${sampled.id}" roughnesstextureid="${sampled.id}" metallicfactor="${num(material.metalness)}" roughnessfactor="${num(material.roughness)}"/>`,
      );
      display = ` displaypropertiesid="${at}"`;
    }
    const at = id++;
    groups.push(
      `<m:texture2dgroup id="${at}" texid="${image}"${display}>${[...coordinates.keys()]
        .map((uv) => {
          const [u, v] = uv.split(' ');
          return `<m:tex2coord u="${u}" v="${v}"/>`;
        })
        .join('')}</m:texture2dgroup>`,
    );
    // With white alone, each entry is its own coordinate, so the corners' indices serve the texture group as they are.
    if (tints.size === 1 && tints.has('#FFFFFF')) return at;
    const colors = colorGroup([...tints.keys()]),
      layered = id++;
    groups.push(
      `<m:multiproperties id="${layered}" pids="${colors} ${at}" blendmethods="multiply">${rows.join('')}</m:multiproperties>`,
    );
    return layered;
  };

  /** One primitive of a node, ready to weld: where it lies, what its corners carry and its base material. */
  interface Part {
    geometry: Geo;
    material: Mat;
    positions: ArrayLike<number>;
    colors?: (vertex: number) => string;
    textured: boolean;
    pindex: number;
  }
  type Welded = { part: Part; shape: Shape }[];
  /**
   * Welds a node's parts. A part that closes on its own stays a shell of its own, so shells that touch keep two
   * triangles to an edge; open parts, the primitives of one surface among them, are welded together.
   */
  const weldParts = (parts: readonly Part[], mirrored: boolean): Welded => {
    const shapeInto = (weld: Weld, part: Part): Shape =>
        shapeOf(weld, part.positions, part.geometry.indices, part.colors, scale, mirrored),
      out = parts.map((part) => ({ part, shape: shapeInto({ vertices: [], known: new Map() }, part) })),
      open = out.length > 1 ? out.filter(({ shape }) => edgesOf(shape.triangles).open > 0) : [];
    if (open.length > 1) {
      const weld: Weld = { vertices: [], known: new Map() };
      for (const entry of open) entry.shape = shapeInto(weld, entry.part);
    }
    return out.filter(({ shape }) => shape.triangles.length);
  };
  /** Adds a node's shells to lists that may hold others; `pindex` is the base material of the object they join. */
  const append = (welded: Welded, vertices: string[], faces: string[], pindex: number): void => {
    const bases = new Map<Weld, number>();
    for (const { part, shape } of welded) {
      const { weld, triangles, corners, palette } = shape;
      let first = bases.get(weld);
      if (first === undefined) {
        bases.set(weld, (first = vertices.length));
        for (let v = 0; v < weld.vertices.length; v += 3) {
          const [x, y, z] = [weld.vertices[v], weld.vertices[v + 1], weld.vertices[v + 2]];
          vertices.push(`<vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>`);
        }
      }
      let group = 0;
      if (palette) group = part.textured ? textureGroup(palette, part.material) : colorGroup(palette, part.material);
      const plain = part.pindex === pindex ? '' : ` pid="1" p1="${part.pindex}"`;
      for (let t = 0; t < triangles.length; t += 3) {
        const colour = corners
          ? ` pid="${group}" p1="${corners[t]}" p2="${corners[t + 1]}" p3="${corners[t + 2]}"`
          : plain;
        faces.push(
          `<triangle v1="${triangles[t] + first}" v2="${triangles[t + 1] + first}" v3="${triangles[t + 2] + first}"${colour}/>`,
        );
      }
    }
  };
  const named = (name: string | undefined): string => (name ? ` name="${escaped(name)}"` : '');
  const object = (vertices: string[], faces: string[], pindex: number, name: string | undefined): number => {
    const at = id++;
    objects.push(
      `<object id="${at}" type="model" pid="1" pindex="${pindex}"${named(name)}>` +
        `<mesh><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh></object>`,
    );
    return at;
  };
  const check = (welded: Welded, name: string | undefined): void =>
    onMeshCheck?.(
      reportOf(
        welded.map(({ shape }) => shape),
        name,
      ),
    );
  const placed = (drawn: readonly Drawable[]): void => {
    const { name, world: matrix } = drawn[0],
      determinant = determinant3(matrix),
      mirrored = determinant < 0,
      world = mirrored ? matrix.map((v, i) => (i < 3 ? -v : v)) : matrix;
    if (!Number.isFinite(determinant)) throw new RangeError('3MF needs a finite transform');
    // glTF and the other writers keep a zero scale; a 3MF item is a solid to print, and a flattened one has no volume.
    if (!determinant)
      throw new MargoError(
        'unsupported',
        '3MF holds solids to print, and a node scaled to 0 on an axis has no volume; give it a nonzero scale or leave it out',
      );
    const keys: string[] = [],
      parts = drawn.map((item): Part => {
        const { geometry } = item,
          material = item.material ?? fallback,
          pindex = materialIndex(material),
          coordinates = textureCoordinates(geometry, material),
          tint = coordinates && tintOf(geometry, material),
          colors = coordinates
            ? (vertex: number) => `${coordinates(vertex)} ${tint!(vertex)}`
            : vertexColors(geometry, material),
          map = coordinates && displayProperties ? mapOf(material) : undefined;
        // What a shared object's properties depend on.
        keys.push(
          `${numbered(geometry)} ${pindex} ${coordinates ? `${textureId(material.baseColorTexture!)} ${JSON.stringify(material.baseColorTextureTransform ?? null)} ${map ? numbered(map.image) : map}` : ''}`,
        );
        const positions = together
          ? moved(geometry.positions, upright(matrix, zUp))
          : mirrored
            ? moved(geometry.positions, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
            : geometry.positions;
        return { geometry, material, positions, colors, textured: !!coordinates, pindex };
      });
    if (together) {
      const welded = weldParts(parts, mirrored);
      if (!welded.length) return;
      if (merged.pindex < 0)
        Object.assign(merged, { pindex: welded[0].part.pindex, name: title === undefined ? name : String(title) });
      check(welded, name);
      append(welded, merged.vertices, merged.faces, merged.pindex);
      return;
    }
    const key = `${mirrored} ${keys.join('|')}`;
    let at = shared.get(key);
    if (at === undefined) {
      const welded = weldParts(parts, mirrored);
      if (!welded.length) return;
      const vertices: string[] = [],
        faces: string[] = [],
        { pindex } = welded[0].part;
      check(welded, name);
      append(welded, vertices, faces, pindex);
      shared.set(key, (at = object(vertices, faces, pindex, name)));
    }
    const placement = `objectid="${at}" transform="${itemTransform(upright(world, zUp), scale)}"`;
    if (assembly === 'components' && nodes.size > 1) components.push(`<component ${placement}/>`);
    else build.push(`<item ${placement}/>`);
  };
  for (const drawn of nodes.values()) {
    signal?.throwIfAborted();
    placed(drawn);
  }
  if (merged.faces.length)
    build.push(`<item objectid="${object(merged.vertices, merged.faces, merged.pindex, merged.name)}"/>`);
  if (components.length) {
    const at = id++;
    // An object of components takes no property of its own (core specification section 4.2).
    objects.push(
      `<object id="${at}" type="model"${named(title === undefined ? undefined : String(title))}><components>${components.join('')}</components></object>`,
    );
    build.push(`<item objectid="${at}"/>`);
  }
  if (!build.length) throw new RangeError('3MF requires at least one mesh with triangles');
  const bases = [...materials.values()],
    shiny = displayProperties && bases.some(({ material }) => finished(material)) ? id++ : 0,
    baseDisplay = shiny
      ? `<m:pbmetallicdisplayproperties id="${shiny}">${bases.map(({ material }) => metallic(material)).join('')}</m:pbmetallicdisplayproperties>`
      : '',
    base = bases
      .map(
        ({ color, material }) =>
          `<base name="${material.name ? escaped(material.name) : color}" displaycolor="${color}"/>`,
      )
      .join(''),
    model =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<model unit="${unit}" xml:lang="en-US" xmlns="${CORE}" xmlns:m="${MATERIAL}"${described.namespaces}>` +
      described.xml +
      `<resources>${baseDisplay}<basematerials id="1"${shiny ? ` displaypropertiesid="${shiny}"` : ''}>${base}</basematerials>${textureXml.join('')}${groups.join('')}${objects.join('')}</resources>` +
      `<build>${build.join('')}</build></model>\n`,
    encoder = new TextEncoder(),
    relationships = (entries: readonly (readonly [string, string])[]): Uint8Array =>
      encoder.encode(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          entries
            .map(([target, type], i) => `<Relationship Target="/${target}" Id="rel${i}" Type="${type}"/>`)
            .join('') +
          '</Relationships>\n',
      ),
    pictures = preview ? [{ name: `Metadata/thumbnail.${preview}`, data: thumbnail! }] : [],
    extensions = new Set([...files, ...pictures].map(({ name }) => name.slice(-3)));
  return encodeZIP(
    [
      {
        name: '[Content_Types].xml',
        data: encoder.encode(
          '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
            (extensions.has('png') ? '<Default Extension="png" ContentType="image/png"/>' : '') +
            (extensions.has('jpg') ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : '') +
            '</Types>\n',
        ),
      },
      {
        name: '_rels/.rels',
        data: relationships([
          ['3D/3dmodel.model', `${RELATIONSHIP}3dmodel`],
          ...pictures.map(({ name }) => [name, THUMBNAIL] as const),
        ]),
      },
      { name: '3D/3dmodel.model', data: encoder.encode(model) },
      ...(files.length
        ? [
            {
              name: '3D/_rels/3dmodel.model.rels',
              data: relationships(files.map(({ name }) => [name, `${RELATIONSHIP}3dtexture`] as const)),
            },
            ...files,
          ]
        : []),
      ...pictures,
    ],
    { signal, compress },
  );
}
