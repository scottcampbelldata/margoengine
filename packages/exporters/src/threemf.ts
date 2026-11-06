// 3MF writer, from the 3MF core specification (1.3) and its materials extension: the format slicers prefer over STL, because
// it holds units, colours and one object placed many times. Printers need closed meshes, so vertices that share a position
// are written once whatever else differs between them.
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
  /** Written as the file's Title metadata. */
  title?: string;
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
  /** For each corner of each triangle, the index of its colour in `palette`. */
  corners?: number[];
  palette?: string[];
}

/**
 * Welds by position, in file units, and drops the triangles that leaves with no area. `mirrored` reflects the shape in X and
 * reverses its triangles.
 */
function shapeOf(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  colors: ((vertex: number) => string) | undefined,
  scale: number,
  mirrored: boolean,
): Shape {
  const flip = mirrored ? -1 : 1;
  const known = new Map<string, number>(),
    vertices: number[] = [],
    weld = new Uint32Array(positions.length / 3);
  for (let v = 0; v < weld.length; v++) {
    const x = Math.fround(positions[v * 3] * flip * scale),
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
  return colors ? { vertices, triangles, corners, palette: [...palette.keys()] } : { vertices, triangles };
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
 * The 3 x 4 matrix of a build item: rows of a row-vector transform, as 3MF lists them, of the scene `world` matrix with
 * the turn to Z up and the translation in file units.
 */
function itemTransform(world: ArrayLike<number>, zUp: boolean, scale: number): string {
  const column = (at: number): number[] => {
    const [x, y, z] = [world[at], world[at + 1], world[at + 2]];
    return zUp ? [x, -z, y] : [x, y, z];
  };
  const out = [...column(0), ...column(4), ...column(8), ...column(12).map((value) => value * scale)];
  return out.map(num).join(' ');
}

/**
 * Exports a scene or GLB bytes as a 3MF file: one object for each geometry, placed by build items, so a geometry drawn by several nodes
 * is stored once. A node with a reflection in its matrix draws a reflected object, shared by the nodes that mirror that
 * geometry, so no build item carries a reflection and a slicer sees nothing inside out. Colours come from the material's
 * base colour and from vertex colours; textures are not written. Vertices are welded by position, but a slicer still needs
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
 * @throws RangeError for an unknown `unit` or `upAxis`, a scene with no triangles to print, a singular node transform or a
 * position outside Float32 range in this unit.
 * @throws TypeError for bytes that are not a GLB or that need decompressing; what the scene collector throws for a bad source;
 * the signal's reason on an abort.
 */
export async function export3MF(
  source: ExportSource | Uint8Array,
  options: Export3MFOptions = {},
): Promise<Uint8Array> {
  const { unit = 'millimeter', upAxis = 'y', title, signal } = options;
  if (!Object.hasOwn(UNITS, unit)) throw new RangeError(`3MF unit must be one of ${Object.keys(UNITS).join(', ')}`);
  if (upAxis !== 'y' && upAxis !== 'z') throw new RangeError("3MF upAxis must be 'y' or 'z'");
  signal?.throwIfAborted();
  const scale = 1 / UNITS[unit],
    zUp = upAxis === 'y',
    fallback = normalizeMaterial({}),
    items = drawables(collect(source instanceof Uint8Array ? sceneOfGLB(source).scene : source, options)),
    materials = new Map<string, number>(),
    objects: string[] = [],
    groups: string[] = [],
    build: string[] = [],
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
  const write = (shape: Shape, name: string | undefined, material: Mat): number => {
    const { vertices, triangles, corners, palette } = shape;
    let group = 0;
    if (palette) {
      group = id++;
      groups.push(
        `<m:colorgroup id="${group}">${palette.map((color) => `<m:color color="${color}"/>`).join('')}</m:colorgroup>`,
      );
    }
    const object = id++,
      lines: string[] = [];
    for (let v = 0; v < vertices.length; v += 3)
      lines.push(`<vertex x="${num(vertices[v])}" y="${num(vertices[v + 1])}" z="${num(vertices[v + 2])}"/>`);
    const faces: string[] = [];
    for (let t = 0; t < triangles.length; t += 3) {
      const colour = corners ? ` pid="${group}" p1="${corners[t]}" p2="${corners[t + 1]}" p3="${corners[t + 2]}"` : '';
      faces.push(`<triangle v1="${triangles[t]}" v2="${triangles[t + 1]}" v3="${triangles[t + 2]}"${colour}/>`);
    }
    objects.push(
      `<object id="${object}" type="model" pid="1" pindex="${materialIndex(material)}"${name ? ` name="${escaped(name)}"` : ''}>` +
        `<mesh><vertices>${lines.join('')}</vertices><triangles>${faces.join('')}</triangles></mesh></object>`,
    );
    return object;
  };
  const placed = (item: Drawable, material: Mat): void => {
    const { geometry, name } = item,
      determinant = determinant3(item.world),
      mirrored = determinant < 0,
      world = mirrored ? item.world.map((v, i) => (i < 3 ? -v : v)) : item.world,
      key = `${geometries(geometry)} ${materialIndex(material)} ${mirrored}`;
    if (!determinant || !Number.isFinite(determinant))
      throw new RangeError('3MF needs a transform with a non-zero determinant; give the node a nonzero scale');
    let object = shared.get(key);
    if (object === undefined) {
      const shape = shapeOf(geometry.positions, geometry.indices, vertexColors(geometry, material), scale, mirrored);
      if (!shape.triangles.length) return;
      shared.set(key, (object = write(shape, name, material)));
    }
    build.push(`<item objectid="${object}" transform="${itemTransform(world, zUp, scale)}"/>`);
  };
  for (const item of items) placed(item, item.material ?? fallback);
  if (!build.length) throw new RangeError('3MF requires at least one mesh with triangles');
  const base = [...materials.keys()].map((color) => `<base name="${color}" displaycolor="${color}"/>`).join(''),
    model =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"` +
      ' xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">' +
      (title === undefined ? '' : `<metadata name="Title">${escaped(String(title))}</metadata>`) +
      `<resources><basematerials id="1">${base}</basematerials>${groups.join('')}${objects.join('')}</resources>` +
      `<build>${build.join('')}</build></model>\n`,
    encoder = new TextEncoder();
  return encodeZIP(
    [
      {
        name: '[Content_Types].xml',
        data: encoder.encode(
          '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n',
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
    ],
    { signal },
  );
}
