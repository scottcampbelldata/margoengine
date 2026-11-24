// 3MF writer, from the 3MF core specification (1.3) and its materials extension: the format slicers prefer over STL, because
// it holds units, colours and one object placed many times. Printers need closed meshes, so vertices that share a position
// are written once whatever else differs between them.
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

/** Options for {@link export3MF}. Scene lengths are metres, as in glTF. */
export interface Export3MFOptions extends SceneOptions {
  /** The file's unit. Lengths are converted, so a 1 m cube is 1000 units long in `'millimeter'`. Default `'millimeter'`. */
  unit?: ThreeMFUnit;
  /** Which scene axis is up. A printer's Z is up, so `'y'`, the glTF way, turns the scene to stand on the bed. Default `'y'`. */
  upAxis?: 'y' | 'z';
  /** Written as the file's Title metadata, and as the name of the assembly. */
  title?: string;
  /**
   * `true` writes a scene of several nodes as one object whose mesh holds every part where the scene put it, each part a
   * shell of its own, so a slicer keeps them together and prints their union by the format's positive fill rule. `false`
   * writes one build item for each node, a geometry drawn twice stored once: slicers read each item as an object they move
   * on their own, so parts that overlap collide. Default `true`.
   */
  assembly?: boolean;
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

/** A mesh as 3MF holds it: unique positions and triangles, each corner with a colour when the geometry has them. */
interface Shape {
  vertices: number[];
  triangles: number[];
  /** For each corner of each triangle, the index of its colour (or, with `texture`, its texture coordinate) in `palette`. */
  corners?: number[];
  palette?: string[];
  /** The image the palette's `u v` coordinates sample. */
  texture?: TextureData;
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

/** Welds by position, in file units, and drops the triangles that leaves with no area. `mirrored` reverses the triangles. */
function shapeOf(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  colors: ((vertex: number) => string) | undefined,
  scale: number,
  mirrored: boolean,
  texture?: TextureData,
): Shape {
  const known = new Map<string, number>(),
    vertices: number[] = [],
    weld = new Uint32Array(positions.length / 3);
  for (let v = 0; v < weld.length; v++) {
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
    weld[v] = at;
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
    const a = weld[indices[i]],
      b = weld[indices[i + 1]],
      c = weld[indices[i + 2]];
    if (a === b || b === c || a === c) continue;
    triangles.push(a, mirrored ? c : b, mirrored ? b : c);
    if (colors) for (const k of mirrored ? [0, 2, 1] : [0, 1, 2]) corners.push(paletteIndex(colors(indices[i + k])));
  }
  return colors
    ? { vertices, triangles, corners, palette: [...palette.keys()], ...(texture ? { texture } : {}) }
    : { vertices, triangles };
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
 * base colour and from vertex colours; the base colour texture is written as a materials-extension texture (`texture2d` and `texture2dgroup`, with its texture transform and wrap) where the geometry has the UV set it uses, and wins over vertex colours on that mesh; other maps are not written. Vertices are welded by position, but a slicer still needs
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
 * @throws RangeError for an unknown `unit` or `upAxis`, a scene with no triangles to print or a position outside Float32
 * range in this unit; MargoError `'unsupported'` for a node scaled to 0 on an axis (a solid to print needs a volume).
 * @throws TypeError for bytes that are not a GLB or that need decompressing; what the scene collector throws for a bad source;
 * the signal's reason on an abort.
 */
export async function export3MF(
  source: ExportSource | Uint8Array,
  options: Export3MFOptions = {},
): Promise<Uint8Array> {
  const { unit = 'millimeter', upAxis = 'y', title, assembly = true, signal } = options;
  if (!Object.hasOwn(UNITS, unit)) throw new RangeError(`3MF unit must be one of ${Object.keys(UNITS).join(', ')}`);
  if (upAxis !== 'y' && upAxis !== 'z') throw new RangeError("3MF upAxis must be 'y' or 'z'");
  signal?.throwIfAborted();
  const scale = 1 / UNITS[unit],
    zUp = upAxis === 'y',
    fallback = normalizeMaterial({}),
    items = drawables(
      collect(source instanceof Uint8Array ? sceneOfGLB(source).scene : source, options, undefined, 'shape'),
    ),
    materials = new Map<string, number>(),
    objects: string[] = [],
    groups: string[] = [],
    textures = new Map<TextureData, number>(),
    textureXml: string[] = [],
    files: { name: string; data: Uint8Array }[] = [],
    build: string[] = [],
    merged: { vertices: string[]; faces: string[]; pindex: number; name?: string } = {
      vertices: [],
      faces: [],
      pindex: -1,
    },
    together = assembly && items.length > 1,
    shared = new Map<string, number>(),
    seen = new Map<Geo, number>(),
    geometries = (geometry: Geo): number => {
      let at = seen.get(geometry);
      if (at === undefined) seen.set(geometry, (at = seen.size));
      return at;
    };
  // Ids: 1 is the base material group; objects and colour groups count up from 2.
  let id = 2;
  const materialIndex = (material: Mat): number => {
    const [r, g, b, a] = material.color,
      color = colorOf(r, g, b, a);
    let index = materials.get(color);
    if (index === undefined) materials.set(color, (index = materials.size));
    return index;
  };
  /** The id of a `texture2d` resource for an image, written once however many materials share it. */
  const textureId = (texture: TextureData): number => {
    let at = textures.get(texture);
    if (at === undefined) {
      at = id++;
      textures.set(texture, at);
      const extension = texture.mimeType === 'image/png' ? 'png' : 'jpg',
        path = `3D/Textures/texture${textures.size}.${extension}`,
        tile = { repeat: 'wrap', mirror: 'mirror', clamp: 'clamp' } as const;
      files.push({ name: path, data: texture.image });
      textureXml.push(
        `<m:texture2d id="${at}" path="/${path}" contenttype="${texture.mimeType}" tilestyleu="${tile[texture.wrapS ?? 'repeat']}" tilestylev="${tile[texture.wrapT ?? 'repeat']}" filter="${texture.magFilter === 'nearest' ? 'nearest' : 'auto'}"/>`,
      );
    }
    return at;
  };
  /** Adds a shape's vertices and triangles to lists that may hold others; `pindex` is its colour where the object's differs. */
  const append = (shape: Shape, vertices: string[], faces: string[], pindex?: number): void => {
    const { triangles, corners, palette, texture } = shape,
      first = vertices.length;
    let group = 0;
    if (palette && texture) {
      group = id++;
      groups.push(
        `<m:texture2dgroup id="${group}" texid="${textureId(texture)}">${palette
          .map((uv) => {
            const [u, v] = uv.split(' ');
            return `<m:tex2coord u="${u}" v="${v}"/>`;
          })
          .join('')}</m:texture2dgroup>`,
      );
    } else if (palette) {
      group = id++;
      groups.push(
        `<m:colorgroup id="${group}">${palette.map((color) => `<m:color color="${color}"/>`).join('')}</m:colorgroup>`,
      );
    }
    for (let v = 0; v < shape.vertices.length; v += 3) {
      const [x, y, z] = [shape.vertices[v], shape.vertices[v + 1], shape.vertices[v + 2]];
      vertices.push(`<vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>`);
    }
    const plain = pindex === undefined ? '' : ` pid="1" p1="${pindex}"`;
    for (let t = 0; t < triangles.length; t += 3) {
      const colour = corners
        ? ` pid="${group}" p1="${corners[t]}" p2="${corners[t + 1]}" p3="${corners[t + 2]}"`
        : plain;
      faces.push(
        `<triangle v1="${triangles[t] + first}" v2="${triangles[t + 1] + first}" v3="${triangles[t + 2] + first}"${colour}/>`,
      );
    }
  };
  const object = (vertices: string[], faces: string[], pindex: number, name: string | undefined): number => {
    const at = id++;
    objects.push(
      `<object id="${at}" type="model" pid="1" pindex="${pindex}"${name ? ` name="${escaped(name)}"` : ''}>` +
        `<mesh><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh></object>`,
    );
    return at;
  };
  const placed = (item: Drawable, material: Mat): void => {
    const { geometry, name } = item,
      determinant = determinant3(item.world),
      mirrored = determinant < 0,
      world = mirrored ? item.world.map((v, i) => (i < 3 ? -v : v)) : item.world,
      pindex = materialIndex(material),
      coordinates = textureCoordinates(geometry, material),
      texture = coordinates ? material.baseColorTexture : undefined,
      key = `${geometries(geometry)} ${pindex} ${mirrored} ${texture ? `${textureId(texture)} ${JSON.stringify(material.baseColorTextureTransform ?? null)}` : ''}`;
    if (!Number.isFinite(determinant)) throw new RangeError('3MF needs a finite transform');
    // glTF and the other writers keep a zero scale; a 3MF item is a solid to print, and a flattened one has no volume.
    if (!determinant)
      throw new MargoError(
        'unsupported',
        '3MF holds solids to print, and a node scaled to 0 on an axis has no volume; give it a nonzero scale or leave it out',
      );
    const colors = coordinates ?? vertexColors(geometry, material);
    if (together) {
      const shape = shapeOf(
        moved(geometry.positions, upright(item.world, zUp)),
        geometry.indices,
        colors,
        scale,
        mirrored,
        texture,
      );
      if (!shape.triangles.length) return;
      if (merged.pindex < 0) Object.assign(merged, { pindex, name: title === undefined ? name : String(title) });
      append(shape, merged.vertices, merged.faces, pindex === merged.pindex ? undefined : pindex);
      return;
    }
    let at = shared.get(key);
    if (at === undefined) {
      const positions = mirrored
          ? moved(geometry.positions, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
          : geometry.positions,
        shape = shapeOf(positions, geometry.indices, colors, scale, mirrored, texture);
      if (!shape.triangles.length) return;
      const vertices: string[] = [],
        faces: string[] = [];
      append(shape, vertices, faces);
      shared.set(key, (at = object(vertices, faces, pindex, name)));
    }
    build.push(`<item objectid="${at}" transform="${itemTransform(upright(world, zUp), scale)}"/>`);
  };
  for (const item of items) placed(item, item.material ?? fallback);
  if (merged.faces.length)
    build.push(`<item objectid="${object(merged.vertices, merged.faces, merged.pindex, merged.name)}"/>`);
  if (!build.length) throw new RangeError('3MF requires at least one mesh with triangles');
  const base = [...materials.keys()].map((color) => `<base name="${color}" displaycolor="${color}"/>`).join(''),
    model =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"` +
      ' xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">' +
      (title === undefined ? '' : `<metadata name="Title">${escaped(String(title))}</metadata>`) +
      `<resources><basematerials id="1">${base}</basematerials>${textureXml.join('')}${groups.join('')}${objects.join('')}</resources>` +
      `<build>${build.join('')}</build></model>\n`,
    encoder = new TextEncoder();
  return encodeZIP(
    [
      {
        name: '[Content_Types].xml',
        data: encoder.encode(
          '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
            (files.some((f) => f.name.endsWith('.png')) ? '<Default Extension="png" ContentType="image/png"/>' : '') +
            (files.some((f) => f.name.endsWith('.jpg')) ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : '') +
            '</Types>\n',
        ),
      },
      {
        name: '_rels/.rels',
        data: encoder.encode(
          '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
            '</Relationships>\n',
        ),
      },
      { name: '3D/3dmodel.model', data: encoder.encode(model) },
      ...(files.length
        ? [
            {
              name: '3D/_rels/3dmodel.model.rels',
              data: encoder.encode(
                '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                  files
                    .map(
                      (f, i) =>
                        `<Relationship Target="/${f.name}" Id="tex${i}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dtexture"/>`,
                    )
                    .join('') +
                  '</Relationships>\n',
              ),
            },
            ...files,
          ]
        : []),
    ],
    { signal },
  );
}
