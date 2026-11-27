// 3MF writer, from the 3MF Consortium's Core Specification 1.4.0 and Materials and Properties Extension 1.2.1: the format
// slicers prefer over STL, because it holds units, colours and one object placed many times. Printers need closed meshes,
// so vertices that share a position are written once whatever else differs between them.
// https://github.com/3MFConsortium/spec_core and https://github.com/3MFConsortium/spec_materials
import type { Mesh } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { encodeZIP } from './archive.js';
import { sceneOfGLB } from './glb-scene.js';
import type { ExtendedMaterialData, MaterialTextureInfo } from './materials.js';
import {
  checkTexture,
  collect,
  determinant3,
  drawables,
  normalizeMaterial,
  num,
  type Drawable,
  type ExportNode,
  type ExportSource,
  type Geo,
  type Mat,
  type TextureData,
  type SceneOptions,
  type ExportWarning,
} from './scene.js';
import type { FieldContext, ThreeMFDisplacement, ThreeMFLevelSet, ThreeMFVolume } from './threemf-fields.js';

export type {
  ThreeMFDisplacement,
  ThreeMFField,
  ThreeMFFunction,
  ThreeMFImageFunction,
  ThreeMFImageStack,
  ThreeMFImplicitFunction,
  ThreeMFLevelSet,
  ThreeMFNode,
  ThreeMFTileStyle,
  ThreeMFValueType,
  ThreeMFVolume,
  ThreeMFVolumeProperty,
} from './threemf-fields.js';

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

const TYPES = ['model', 'solidsupport', 'support', 'surface', 'other'] as const;

/**
 * What an object is to the printer (core specification chapter 4 and section 4.1). `model` and `solidsupport` are solids
 * and must be closed; `support`, `surface` and `other` may be open. A consumer may replace or ignore support. `other`
 * is never printed: the format forbids the build to reference it.
 */
export type ThreeMFObjectType = (typeof TYPES)[number];

/** What one node's object says. */
export interface ThreeMFObjectInfo {
  /** The object's `type`. Default `'model'`. */
  type?: ThreeMFObjectType;
  /** The object's `partnumber`, which editors keep as they change the file. Default none. */
  partNumber?: string;
  /** The `partnumber` of the node's own build item, an identifier of that item. Default none. */
  itemPartNumber?: string;
  /**
   * Prints the node as a mixture of base materials (the materials extension's composite materials, chapter 4). It
   * takes the place of the node's glTF material: its colour, textures, vertex colours and display properties are not
   * written. Default none.
   */
  composite?: ThreeMFComposite;
  /**
   * What this node's own mesh is for, when alternatives give other representations of it (production extension).
   * Default `'fullres'`. Needs `production`.
   */
  modelResolution?: ThreeMFModelResolution;
  /**
   * Other representations of the node's object, in order of preference, each ranked above the node's own mesh. A reader
   * picks one it can use: a viewer a `lowres` one, a printer a `fullres` one. Needs `production`, and a build item or
   * component of the node's own (`assembly` `false` or `'components'`, or a single node). Default none.
   */
  alternatives?: readonly ThreeMFAlternative[];
  /**
   * A beam lattice in the node's mesh object (beam lattice extension), which then needs no triangles. It needs a
   * build item or component of the node's own (`assembly` `false` or `'components'`, or a single node) and a `model`
   * or `solidsupport` type. Default none.
   */
  lattice?: ThreeMFLattice;
  /**
   * The node's printed layers (slice extension), beside its mesh. It needs a build item or component of the node's own
   * (`assembly` `false` or `'components'`, or a single node) that neither tilts it nor scales its height. Default none.
   */
  slices?: ThreeMFSlices;
  /**
   * Colour, material mixtures and other properties that vary through the node's volume (volumetric extension). It needs
   * a build item or component of the node's own (`assembly` `false` or `'components'`, or a single node). Default none.
   */
  volume?: ThreeMFVolume;
  /**
   * Bounds the node's shape where a function is zero (volumetric extension): its mesh becomes the region the function
   * is evaluated in, and the file requires the extension. It needs a build item or component of the node's own, and no
   * lattice, slices or displacement. Default none.
   */
  levelSet?: ThreeMFLevelSet;
  /**
   * Moves the node's surface by a height map (displacement extension), which the file then requires. It needs a build
   * item or component of the node's own, a `model` type, UVs, four triangles or more, and no lattice, slices, volume
   * or level set. Default none.
   */
  displacement?: ThreeMFDisplacement;
}

/** One closed contour of a layer, or in a `support` object one open path, with colours. */
export interface ThreeMFSliceOutline {
  /** `x y` for each point. */
  points: ArrayLike<number>;
  /** One sRGB colour, `'#RRGGBB'` or `'#RRGGBBAA'`, or one for each point. Default the node's material. */
  color?: string | readonly string[];
}

/** One printed layer. */
export interface ThreeMFSliceLayer {
  /** The height of the layer's top, above the one before. */
  top: number;
  /**
   * Its contours, each `x y x y ...` or a {@link ThreeMFSliceOutline}. A solid's contours close by themselves and fill
   * by the positive rule, so an outer contour runs counter-clockwise and a hole clockwise. Default none: a gap.
   */
  contours?: readonly (ArrayLike<number> | ThreeMFSliceOutline)[];
}

/**
 * The layers of an object. Lengths are in scene units, in the object's frame with Z up: for a Y-up scene a point
 * `(x, y, z)` of the geometry is `(x, -z)` at height `y`.
 */
export interface ThreeMFSlices {
  layers: readonly ThreeMFSliceLayer[];
  /** The height the first layer starts at. Default 0. */
  bottom?: number;
  /**
   * `'lowres'` says the mesh is too coarse to make these layers from, and the file then requires the extension.
   * Default `'fullres'`.
   */
  meshResolution?: 'fullres' | 'lowres';
  /** Writes the layers into a model part of their own under `/2D/`. Default `false`. */
  separatePart?: boolean;
}

/** Layers checked against the extension's rules, each contour a point list without a repeated end. */
function checkSlices({ layers, bottom = 0, meshResolution = 'fullres', separatePart }: ThreeMFSlices, open: boolean) {
  const fail = (message: string): never => {
    throw new RangeError(`3MF slices ${message}`);
  };
  if (!Array.isArray(layers) || !layers.length) fail('need at least one layer');
  if (!Number.isFinite(bottom)) fail('bottom must be a number');
  if (meshResolution !== 'fullres' && meshResolution !== 'lowres') fail("meshResolution must be 'fullres' or 'lowres'");
  let below = bottom;
  const checked = (layers as readonly ThreeMFSliceLayer[]).map(({ top, contours = [] }) => {
    if (!(Number.isFinite(top) && top > below)) fail('layer tops must rise from the bottom, each above the one before');
    below = top;
    const outlines = contours.map((contour) => {
      const { points, color } = 'points' in contour ? contour : { points: contour, color: undefined };
      let count = (points?.length ?? 0) / 2;
      if (!Number.isInteger(count) || !Array.from(points).every(Number.isFinite))
        fail('contours need two finite numbers for each point');
      const same = (a: number, b: number): boolean =>
        Math.fround(points[a * 2]) === Math.fround(points[b * 2]) &&
        Math.fround(points[a * 2 + 1]) === Math.fround(points[b * 2 + 1]);
      // A solid's contour closes itself, so a repeated first point at its end is not a segment of its own.
      if (!open && count > 1 && same(0, count - 1)) count--;
      if (count < (open ? 2 : 3)) fail(open ? 'paths need two points' : 'contours need three points');
      for (let i = open ? 1 : 0; i < count; i++)
        if (same(i, (i + count - 1) % count)) fail('contours must not repeat a point next to itself');
      const colors = color === undefined || typeof color === 'string' ? color : Array.from(color);
      if (
        colors !== undefined &&
        ((typeof colors !== 'string' && colors.length < count) ||
          [colors].flat().some((c) => typeof c !== 'string' || !MIX_COLOR.test(c)))
      )
        fail("colours are '#RRGGBB' or '#RRGGBBAA', one or one for each point");
      return { points, count, color: colors };
    });
    return { top, outlines };
  });
  return { layers: checked, bottom, meshResolution, separatePart: !!separatePart, open };
}

const CAPS = ['sphere', 'hemisphere', 'butt'] as const;
const BALL_MODES = ['none', 'mixed', 'all'] as const;

/** How a beam's end closes. */
export type ThreeMFCapMode = (typeof CAPS)[number];

/** One beam: a cone frustum between two lattice points. */
export interface ThreeMFLatticeBeam {
  /** The index of its first point in `positions`. */
  v1: number;
  /** The index of its second point. */
  v2: number;
  /** Radius at the first point. Default the lattice's `radius`. */
  r1?: number;
  /** Radius at the second point. Default `r1`. */
  r2?: number;
  /** Default the lattice's `cap`. */
  cap1?: ThreeMFCapMode;
  /** Default the lattice's `cap`. */
  cap2?: ThreeMFCapMode;
  /** One sRGB colour, `'#RRGGBB'` or `'#RRGGBBAA'`, or one for each end. Default the node's material. */
  color?: string | readonly [string, string];
}

/** A sphere at a lattice point that ends a beam. */
export interface ThreeMFLatticeBall {
  /** The index of its centre in `positions`. */
  vertex: number;
  /** Default the lattice's `ballRadius`. */
  radius?: number;
  /** An sRGB colour. Default the node's material. */
  color?: string;
}

/** A named group of beams and balls, by their indices. It changes no geometry. */
export interface ThreeMFBeamGroup {
  name?: string;
  /** An identifier no other set of the lattice has. */
  identifier?: string;
  beams?: readonly number[];
  balls?: readonly number[];
}

/**
 * A beam lattice. Its points and radii are in the node's geometry coordinates, so the node's transform moves and
 * scales it as it does the mesh.
 */
export interface ThreeMFLattice {
  /** The beam ends, `x y z` for each. */
  positions: ArrayLike<number>;
  beams: readonly ThreeMFLatticeBeam[];
  /** The default beam radius. */
  radius: number;
  /** Consumers ignore beams shorter than this. Default 1e-7 scene units. */
  minLength?: number;
  /** The default end of a beam. Default `'sphere'`. */
  cap?: ThreeMFCapMode;
  balls?: readonly ThreeMFLatticeBall[];
  /**
   * `'none'` writes no ball, `'mixed'` the `balls` listed, `'all'` one at every beam end, `balls` overriding those
   * they name. Default `'mixed'` with `balls`, else `'none'`.
   */
  ballMode?: (typeof BALL_MODES)[number];
  /** The default ball radius, needed unless `ballMode` is `'none'`. */
  ballRadius?: number;
  sets?: readonly ThreeMFBeamGroup[];
  /** Keeps only the lattice inside, or outside, a closed mesh, given in the node's frame. */
  clipping?: { mode: 'inside' | 'outside'; mesh: ExportNode };
  /** A mesh of the lattice's intended shape, for previews only, in the node's frame. */
  representation?: ExportNode;
}

/** The intended use of a representation. An `obfuscated` one hides detail and must enclose the `fullres` shape. */
export type ThreeMFModelResolution = (typeof RESOLUTIONS)[number];

const RESOLUTIONS = ['fullres', 'lowres', 'obfuscated'] as const;

/** One alternative representation of a node's object. */
export interface ThreeMFAlternative {
  /**
   * The mesh and its material, in the frame of the node it stands for: this node's own transform places it there, and
   * the original's transform then places both.
   */
  node: ExportNode;
  /** Default `'fullres'`. */
  resolution?: ThreeMFModelResolution;
}

/** What a UUID of the production extension identifies. */
export interface ThreeMFElement {
  element: 'build' | 'item' | 'object' | 'component' | 'alternative';
  /** The name of the node it places or holds, when it has one. */
  name?: string;
  /** Its place among the elements of its kind, from 0, in the order they are written. */
  index: number;
}

/** How {@link export3MF} writes the production extension. */
export interface Export3MFProduction {
  /**
   * Writes each mesh object into a model part of its own, `/3D/Objects/object<id>.model`, which the root part's build
   * items and components name by path, so a reader can load or skip each on its own. An `other` object and an object
   * with alternatives stay in the root part. Default `false`.
   */
  separateParts?: boolean;
  /**
   * The UUID of each build, item, object, component and alternative, as 32 lower-case hex digits in the 8-4-4-4-12
   * form, none used twice. Give the same ones again to track a part across files, or to write the same bytes twice.
   * Default a random (version 4) UUID.
   */
  uuid?: (element: ThreeMFElement) => string;
}

/** One material of a mixture, written as a `<base>` of a base material group. */
export interface ThreeMFConstituent {
  /** The material's name, which a printer matches to what it holds. */
  name: string;
  /** Its sRGB display colour, `'#RRGGBB'` or `'#RRGGBBAA'`. */
  color: string;
}

/** The fraction of each material of a mixture, in the order of `materials`: 0 to 1 each, not all 0. */
export type ThreeMFRatios = readonly number[];

/** A mixture of two or more base materials. */
export interface ThreeMFComposite {
  materials: readonly ThreeMFConstituent[];
  /**
   * One mixture for the whole node, or a function that returns the mixture at a vertex, given its position in the
   * geometry's own coordinates (before the node's transform): a graded part, which the printer interpolates across each
   * triangle. Consumers divide each value by their sum.
   */
  ratios: ThreeMFRatios | ((position: [number, number, number]) => ThreeMFRatios);
}

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
   * Writes how each material looks as the materials extension's display properties. A transmissive material (a
   * `transmission` of at least 0.5 over its dielectric share) is `translucent`: attenuation per metre from
   * `KHR_materials_volume` and a refractive index for red, green and blue from `ior` and `KHR_materials_dispersion`.
   * A dielectric with `KHR_materials_specular` or an `ior` other than 1.5 is specular: its reflectance at normal
   * incidence, and 1 - roughness as glossiness. Any other keeps its metalness and roughness, written where they differ
   * from the extension's own 0 and 1. A base colour texture's metallic-roughness map and `specularColorTexture` are
   * written with it when they use the same UV set, transform and wrap. The `KHR_materials_*` values are read from a
   * material's `extensions`, as `exportMaterialGLB` takes them and a GLB holds them. Default `true`.
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
  /**
   * Called once for each node drawn, with the data node or engine mesh (for GLB bytes, a data node with the GLB node's
   * name), for its object's type and part numbers. With `assembly: true`, nodes of one type and part number share one
   * mesh; where nodes differ, the assembly is one object of components, a mesh for each type and part number, as the
   * format asks of support: referenced from an object of components beside the model it supports. An `other` object is
   * written among the resources and left out of the build. Default: every object a `model` without a part number.
   */
  objectInfo?: (node: Mesh | ExportNode) => ThreeMFObjectInfo | undefined;
  /**
   * The `partnumber` of the one build item of a scene written as one object (a single node, or `assembly` `true` or
   * `'components'`). With `assembly: false`, give each node's through `objectInfo`. Default none.
   */
  itemPartNumber?: string;
  /**
   * Writes the production extension: a UUID on the build and on each item, object and component, and what
   * {@link Export3MFProduction} asks for. Default `false`.
   */
  production?: boolean | Export3MFProduction;
  /** Deflates the package's parts; `false` stores them. Default `true`. */
  compress?: boolean;
  /** Called once for each mesh written with how it closes. Nothing is repaired. */
  onMeshCheck?: (report: ThreeMFMeshReport) => void;
  /** Stops the archive step. */
  signal?: AbortSignal;
}

/** XML text: tabs and line ends are references too, as an attribute value turns bare ones into spaces (XML 1.0 3.3.3). */
const escaped = (text: string): string =>
  text
    .replace(/[&<>"'\t\n\r]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

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

const MIX_COLOR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

/** One mixture as the file writes it, checked. */
function ratioRow(ratios: ThreeMFRatios, count: number): string {
  if (!Array.isArray(ratios) || ratios.length !== count)
    throw new RangeError(`3MF composite ratios need one number for each of its ${count} materials`);
  let sum = 0;
  for (const value of ratios) {
    if (!(typeof value === 'number' && value >= 0 && value <= 1))
      throw new RangeError('3MF composite ratios must be numbers from 0 to 1');
    sum += value;
  }
  if (!sum) throw new RangeError('3MF composite ratios must not all be 0');
  return ratios.map(num).join(' ');
}

/** A composite checked, and its constant ratios too. */
function checkComposite({ materials, ratios }: ThreeMFComposite): ThreeMFComposite {
  if (!Array.isArray(materials) || materials.length < 2)
    throw new RangeError('3MF composite materials mix two or more materials');
  const checked = (materials as readonly ThreeMFConstituent[]).map(({ name, color }) => {
    if (typeof name !== 'string' || !name) throw new TypeError('3MF composite materials each need a name');
    if (typeof color !== 'string' || !MIX_COLOR.test(color))
      throw new RangeError("3MF composite material colours are '#RRGGBB' or '#RRGGBBAA'");
    return { name, color: color.toUpperCase() };
  });
  if (typeof ratios !== 'function') ratioRow(ratios, checked.length);
  return { materials: checked, ratios };
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** A version 4 UUID (RFC 4122); `crypto.randomUUID` is missing from pages that are not secure contexts. */
function randomUUID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
}

const positive = (value: number): boolean => typeof value === 'number' && value > 0 && Number.isFinite(value);

/** A lattice checked against the extension's rules, with its defaults filled in. */
function checkLattice(lattice: ThreeMFLattice) {
  const {
      positions,
      beams,
      radius,
      minLength = 1e-7,
      cap = 'sphere',
      balls = [],
      ballMode = balls.length ? 'mixed' : 'none',
      ballRadius,
      sets = [],
      clipping,
      representation,
    } = lattice,
    points = Math.floor((positions?.length ?? 0) / 3),
    point = (index: number): boolean => Number.isInteger(index) && index >= 0 && index < points,
    fail = (message: string): never => {
      throw new RangeError(`3MF lattice ${message}`);
    };
  if (!points || positions.length % 3 || !Array.from(positions).every(Number.isFinite))
    fail('positions need three finite numbers for each point');
  if (!Array.isArray(beams) || !beams.length) fail('needs at least one beam');
  if (!positive(radius) || !positive(minLength)) fail('radius and minLength must be positive');
  if (!CAPS.includes(cap)) fail(`cap must be one of ${CAPS.join(', ')}`);
  if (!BALL_MODES.includes(ballMode)) fail(`ballMode must be one of ${BALL_MODES.join(', ')}`);
  if (ballRadius !== undefined && !positive(ballRadius)) fail('ballRadius must be positive');
  if (ballMode !== 'none' && ballRadius === undefined) fail('ballMode needs a ballRadius');
  if (ballMode === 'none' && balls.length) fail("lists balls but its ballMode is 'none'");
  const colour = (color: unknown): void => {
      if (typeof color !== 'string' || !MIX_COLOR.test(color)) fail("colours are '#RRGGBB' or '#RRGGBBAA'");
    },
    ends = new Set<number>();
  for (const { v1, v2, r1, r2, cap1, cap2, color } of beams as readonly ThreeMFLatticeBeam[]) {
    if (!point(v1) || !point(v2)) fail('beams must join points of positions');
    if ([0, 1, 2].every((k) => Math.fround(positions[v1 * 3 + k]) === Math.fround(positions[v2 * 3 + k])))
      fail('beams must join two distinct points');
    if ((r1 !== undefined && !positive(r1)) || (r2 !== undefined && !positive(r2))) fail('radii must be positive');
    if ([cap1, cap2].some((c) => c !== undefined && !CAPS.includes(c))) fail(`cap must be one of ${CAPS.join(', ')}`);
    if (color !== undefined) for (const c of typeof color === 'string' ? [color] : [color[0], color[1]]) colour(c);
    ends.add(v1).add(v2);
  }
  const centres = new Set<number>();
  for (const { vertex, radius: own, color } of balls) {
    if (!ends.has(vertex) || centres.has(vertex)) fail('balls must each sit on a beam end of their own');
    centres.add(vertex);
    if (own !== undefined && !positive(own)) fail('ball radii must be positive');
    if (color !== undefined) colour(color);
  }
  const identifiers = new Set<string>();
  for (const set of sets) {
    if (set.identifier !== undefined) {
      if (identifiers.has(set.identifier)) fail(`set identifier "${set.identifier}" is given twice`);
      identifiers.add(set.identifier);
    }
    const within = (list: readonly number[] = [], length: number): boolean =>
      list.every((i) => Number.isInteger(i) && i >= 0 && i < length);
    if (!within(set.beams, beams.length) || !within(set.balls, balls.length))
      fail('sets must name beams and balls of the lattice');
  }
  if (clipping && clipping.mode !== 'inside' && clipping.mode !== 'outside')
    fail("clipping mode must be 'inside' or 'outside'");
  return {
    positions,
    beams,
    radius,
    minLength,
    cap,
    balls,
    ballMode,
    ballRadius,
    sets,
    clipping,
    representation,
  };
}

/** The attributes that name another property resource, in the XML this writer makes (names are escaped). */
const REFERENCE = / (?:pid|pids|texid|matid|displaypropertiesid|[a-z]+textureid)="([\d ]+)"/g;
const idOf = (xml: string): string => / id="(\d+)"/.exec(xml)![1];

/** The property resources that `from` refers to, directly or through one another, in their own order. */
function resourcesOf(resources: readonly string[], from: string): string[] {
  const byId = new Map(resources.map((xml) => [idOf(xml), xml])),
    wanted = new Set<string>(),
    pending = [from];
  while (pending.length)
    for (const [, ids] of pending.pop()!.matchAll(REFERENCE))
      for (const id of ids.split(' ')) {
        if (wanted.has(id)) continue;
        wanted.add(id);
        const found = byId.get(id);
        if (found) pending.push(found);
      }
  return resources.filter((xml) => wanted.has(idOf(xml)));
}

/** What `objectInfo` says of a node, with its lattice and layers checked. */
type Described = ThreeMFObjectInfo & {
  type: ThreeMFObjectType;
  checked?: ReturnType<typeof checkLattice>;
  layered?: ReturnType<typeof checkSlices>;
};

/** Turns a Y-up object's frame to the file's Z up: `(x, y, z)` to `(x, -z, y)`. */
const TURN = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/** A base material: its group's resource id and its index there. */
interface Base {
  group: number;
  index: number;
}

/** One `<base>` of a base material group. */
interface BaseEntry {
  index: number;
  color: string;
  material: Mat;
}

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
  /** When asked for, the source vertex of each corner. */
  from?: number[];
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
  traced = false,
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
    from: number[] = [],
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
    const order = mirrored ? [0, 2, 1] : [0, 1, 2];
    if (colors) for (const k of order) corners.push(paletteIndex(colors(indices[i + k])));
    if (traced) for (const k of order) from.push(indices[i + k]);
  }
  return { weld, triangles, ...(colors && { corners, palette: [...palette.keys()] }), ...(traced && { from }) };
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

/** Reflects positions in X. */
const FLIP = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const PRODUCTION = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06',
  ALTERNATIVES = 'http://schemas.microsoft.com/3dmanufacturing/production/alternatives/2021/04';
const BEAMS = 'http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02',
  BALLS = 'http://schemas.microsoft.com/3dmanufacturing/beamlattice/balls/2020/07',
  SLICE = 'http://schemas.microsoft.com/3dmanufacturing/slice/2015/07';
const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02',
  MATERIAL = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02',
  RELATIONSHIP = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/',
  THUMBNAIL = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail',
  /** A 3D texture part's content type (materials extension, appendix E.1); `image/png` is a thumbnail's. */
  TEXTURE_PART = 'application/vnd.ms-package.3dmanufacturing-3dmodeltexture';

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
 * Whether a map can share the base colour texture's coordinates: the materials extension samples every map of a texture
 * group at the same points, with the base texture's wrap. `transform` and `texCoord` are the map's.
 */
function aligned(
  material: Mat,
  map: TextureData,
  transform: Mat['baseColorTextureTransform'],
  texCoord: number = map.texCoord ?? 0,
): boolean {
  const base = material.baseColorTexture!,
    place = (t: Mat['baseColorTextureTransform']): string =>
      `${t?.offset ?? [0, 0]} ${t?.scale ?? [1, 1]} ${t?.rotation ?? 0}`;
  return (
    (base.texCoord ?? 0) === texCoord &&
    (base.wrapS ?? 'repeat') === (map.wrapS ?? 'repeat') &&
    (base.wrapT ?? 'repeat') === (map.wrapT ?? 'repeat') &&
    place(material.baseColorTextureTransform) === place(transform)
  );
}

/** A textured material's metallic-roughness map where the extension can sample it. */
const roughnessMap = (material: Mat): TextureData | undefined => {
  const map = material.metallicRoughnessTexture;
  return map && aligned(material, map, material.metallicRoughnessTextureTransform) ? map : undefined;
};

/**
 * What the display properties of a textured material sample: its own metallic-roughness map, the white map (`null`) for
 * factors alone, or nothing when it needs none or its map lies elsewhere on the surface.
 */
function mapOf(material: Mat): TextureData | null | undefined {
  if (material.metallicRoughnessTexture) return roughnessMap(material);
  return finished(material) ? null : undefined;
}

/** Whether a material differs from the display properties' own default, metalness 0 and roughness 1. */
const finished = (material: Mat): boolean => material.metalness !== 0 || material.roughness !== 1;

/**
 * A map re-encoded with `write` giving each texel from the source's four bytes at `at`. A 1 x 1 white map, `null`,
 * carries factors alone.
 */
async function displayMap(
  texture: TextureData | null,
  signal: AbortSignal | undefined,
  write: (source: ArrayLike<number>, at: number) => readonly [number, number, number],
): Promise<Uint8Array> {
  const { png } = await import('./png.js');
  if (!texture) return png({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }, 1, false);
  const { decodeTexture } = await import('./texture-decode.js'),
    { width, height, data: source } = await decodeTexture(texture.image, signal),
    data = new Uint8Array(width * height * 4);
  for (let at = 0; at < data.length; at += 4) {
    data.set(write(source, at), at);
    data[at + 3] = 255;
  }
  return png({ width, height, data }, Math.max(width, height), false);
}

/** How a material's display properties describe it. */
type Look =
  | { kind: 'metallic' }
  /** `color` is the linear reflectance at normal incidence; `map` its texture, sampled at the base colour's places. */
  | { kind: 'specular'; color: number[]; map?: TextureData }
  | { kind: 'translucent'; attenuation: number[]; index: number[] };

/** A number of a material extension, `fallback` when absent. */
function extensionNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !(value >= 0)) throw new RangeError(`3MF needs ${name} to be a number of 0 or more`);
  return value;
}

/** A linear RGB triplet of a material extension, white when absent. */
function extensionColor(value: unknown, name: string): number[] {
  if (value === undefined) return [1, 1, 1];
  const color = Array.from(value as ArrayLike<number>);
  if (color.length !== 3 || !color.every((c) => Number.isFinite(c) && c >= 0))
    throw new RangeError(`3MF needs ${name} to be three numbers of 0 or more`);
  return color;
}

/**
 * The display properties a material takes, by the meanings of its glTF values: translucent when mostly transmissive,
 * specular when a dielectric gives its own reflectance, else metallic.
 */
function lookOf(material: Mat, warn: (message: string) => void): Look {
  if (material.shading !== 'standard' || material.unlit) return { kind: 'metallic' };
  const extensions = ((material.source as ExtendedMaterialData | undefined)?.extensions ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >,
    {
      KHR_materials_transmission: passing,
      KHR_materials_ior: refracting,
      KHR_materials_specular: specular,
      KHR_materials_volume: volume,
      KHR_materials_dispersion: dispersion,
    } = extensions,
    ior = extensionNumber(refracting?.ior, material.ior, 'ior'),
    share =
      extensionNumber(passing?.transmissionFactor, material.transmission, 'transmissionFactor') *
      (1 - material.metalness);
  if (share > 0 && ior >= 1) {
    if (share < 1)
      warn(
        `3MF translucency is all or nothing: a material passing ${num(share)} of its light is written ${share >= 0.5 ? 'translucent' : 'opaque'}`,
      );
    if (share >= 0.5) {
      const color = extensionColor(volume?.attenuationColor, 'attenuationColor'),
        distance = extensionNumber(volume?.attenuationDistance, Infinity, 'attenuationDistance'),
        spread = (ior - 1) * 0.025 * extensionNumber(dispersion?.dispersion, 0, 'dispersion');
      if (!distance) throw new RangeError('3MF needs attenuationDistance above 0');
      return {
        kind: 'translucent',
        // Beer-Lambert: the colour is what white keeps after the distance. 2^-16 stands for black, past 8-bit colour.
        attenuation: color.map((c) =>
          distance === Infinity ? 0 : Math.max(0, -Math.log(Math.min(1, Math.max(c, 2 ** -16))) / distance),
        ),
        index: [Math.max(1, ior - spread), ior, ior + spread],
      };
    }
  }
  if (material.metalness !== 0 || (!specular && ior === 1.5)) return { kind: 'metallic' };
  // KHR_materials_ior and _specular: F0 = min(((ior - 1) / (ior + 1))^2 x colour, 1) x factor; ior 0 makes the first 1.
  const reflectance = ((ior - 1) / (ior + 1)) ** 2,
    factor = extensionNumber(specular?.specularFactor, 1, 'specularFactor'),
    color = extensionColor(specular?.specularColorFactor, 'specularColorFactor').map(
      (c) => Math.min(1, reflectance * c) * factor,
    );
  if (specular?.specularTexture) warn('3MF has no specular strength map; specularTexture is left out');
  const info = specular?.specularColorTexture as MaterialTextureInfo | undefined;
  if (!info) return { kind: 'specular', color };
  const map = checkTexture(info.texture, 'specularColorTexture');
  if (!map) throw new TypeError('3MF needs specularColorTexture as { texture: TextureData }');
  // The transform may move the map to another UV set, over the reference's own and the texture's.
  const transform = info.extensions?.KHR_texture_transform as
      | (NonNullable<Mat['baseColorTextureTransform']> & { texCoord?: number })
      | undefined,
    texCoord = transform?.texCoord ?? info.texCoord ?? map.texCoord ?? 0;
  if (material.baseColorTexture && aligned(material, map, transform, texCoord)) return { kind: 'specular', color, map };
  warn(
    '3MF samples a specular colour map at the base colour coordinates; one without a base colour texture, or with another UV set, transform or wrap, is left out',
  );
  return { kind: 'specular', color };
}

/** A part number as given, refusing what is not text. */
function partText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) throw new TypeError(`3MF ${name} must be a string that is not empty`);
  return value;
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
 * are written as display properties, as are specular and transmissive materials (`displayProperties`); the format has no
 * normal, emissive or occlusion map. A node's primitives are one
 * mesh. `objectInfo` gives a node's object type (a support, a surface) and part numbers. Vertices are welded by position, but a slicer still needs
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
 * @throws RangeError for an unknown `unit`, `upAxis`, `assembly` or object type, an item part number with no one item to
 * take it, a bad metadata name, a CMYK thumbnail, a scene with
 * no triangles to print or a position outside Float32 range in this unit; MargoError `'unsupported'` for a node scaled to 0 on an axis (a solid to print needs a volume).
 * @throws TypeError for a part number that is not text, bytes that are not a GLB or that need decompressing; what the scene collector throws for a bad source;
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
    objectInfo,
    production = false,
    signal,
  } = options;
  if (typeof production !== 'boolean' && (typeof production !== 'object' || production === null))
    throw new TypeError('3MF production must be true, false or its options');
  const { separateParts = false, uuid = randomUUID } = typeof production === 'object' ? production : {};
  if (!Object.hasOwn(UNITS, unit)) throw new RangeError(`3MF unit must be one of ${Object.keys(UNITS).join(', ')}`);
  if (upAxis !== 'y' && upAxis !== 'z') throw new RangeError("3MF upAxis must be 'y' or 'z'");
  if (typeof assembly !== 'boolean' && assembly !== 'components')
    throw new RangeError("3MF assembly must be true, false or 'components'");
  if (objectInfo !== undefined && typeof objectInfo !== 'function')
    throw new TypeError('3MF objectInfo must be a function');
  const itemNumber = partText(options.itemPartNumber, 'itemPartNumber'),
    described = metadataXml(title, metadata),
    preview = thumbnail === undefined ? undefined : thumbnailType(thumbnail);
  signal?.throwIfAborted();
  const scale = 1 / UNITS[unit],
    zUp = upAxis === 'y',
    fallback = normalizeMaterial({}),
    onWarning = options.onWarning ?? ((warning: ExportWarning) => console.warn(warning.message)),
    items = drawables(
      collect(source instanceof Uint8Array ? sceneOfGLB(source).scene : source, options, undefined, 'shape', [], true),
    ),
    /** A node's primitives, which share its world matrix, are one mesh. */
    nodes = new Map<Float64Array, Drawable[]>(),
    /** Base material groups, one for each kind of display properties, as a group takes one resource of them. */
    bases = new Map<Look['kind'], { id: number; entries: Map<string, BaseEntry> }>(),
    looks = new Map<Mat, Look>(),
    /** Every object resource, with the model part it goes into when not the root. */
    objects: { id: number; xml: string; part?: string }[] = [],
    /** The model part of each object that has one of its own. */
    objectParts = new Map<number, string>(),
    /** The UUIDs given, and how many of each element. */
    uuids = new Set<string>(),
    counts = new Map<string, number>(),
    groups: string[] = [],
    /** `texture2d` ids by image bytes and sampling, as materials of one file share images through their own records. */
    textures = new Map<Uint8Array, Map<string, number>>(),
    /** The PNG of each display map, then its resource id once a group samples it. */
    maps = new Map<Uint8Array | null, { image: Uint8Array; id?: number }>(),
    /** The same for the glossiness maps of specular materials, by their source and roughness factor. */
    glosses = new Map<Uint8Array, Map<number, { image: Uint8Array; id?: number }>>(),
    textureXml: string[] = [],
    files: { name: string; data: Uint8Array }[] = [],
    build: string[] = [],
    components: string[] = [],
    /** Volumetric resources and the meshes they name, in the order they are defined. */
    fieldXml: string[] = [],
    /** The pictures volumetric and displacement resources sample. */
    fieldFiles: { name: string; data: Uint8Array }[] = [],
    /** With `assembly: true`, one mesh for each object type and part number. */
    merged = new Map<string, Merged>(),
    /** The object types the build references, for the format's rule about support. */
    printed: { type: ThreeMFObjectType; alone: boolean }[] = [],
    shared = new Map<string, number>(),
    /** The extensions whose references name another model part, beyond the production one. */
    pathed = new Set<string>(),
    /** The beam lattice namespaces the file uses. */
    lattices = new Set<'b' | 'b2'>(),
    /** The mesh resolutions of the sliced objects, and the model parts that hold layers alone. */
    sliced = new Set<'fullres' | 'lowres'>(),
    layerParts: { part: string; resources: string[] }[] = [],
    /** A composite material group for each list of constituents, with the mixtures its triangles use. */
    mixtures = new Map<string, { base: number; id: number; rows: Map<string, number> }>(),
    seen = new Map<object, number>(),
    numbered = (value: object): number => {
      let at = seen.get(value);
      if (at === undefined) seen.set(value, (at = seen.size));
      return at;
    };
  /** One mesh of a merged assembly. */
  interface Merged {
    type: ThreeMFObjectType;
    partNumber?: string;
    vertices: string[];
    faces: string[];
    base: Base;
    name?: string;
  }
  for (const item of items) {
    const parts = nodes.get(item.world);
    if (parts) parts.push(item);
    else nodes.set(item.world, [item]);
  }
  const together = assembly === true && nodes.size > 1,
    /** Each node gets a build item of its own, unless the scene is written as one object. */
    ownItems = nodes.size === 1 || assembly === false;
  if (itemNumber !== undefined && assembly === false && nodes.size > 1)
    throw new RangeError(
      '3MF itemPartNumber names one build item; with assembly false, give each node its own in objectInfo',
    );
  const warn = (message: string): void => onWarning({ code: 'unsupported', node: null, message });
  const look = (material: Mat): Look => {
    let found = looks.get(material);
    if (!found) looks.set(material, (found = displayProperties ? lookOf(material, warn) : { kind: 'metallic' }));
    return found;
  };

  // Maps are decoded and re-encoded first, as the writing below does not wait.
  // glTF holds roughness in green; metalness in blue. The extension reads roughness in red and metalness in green.
  const metallicTexel = (source: ArrayLike<number>, at: number) => [source[at + 1], source[at + 2], 0] as const;
  if (displayProperties)
    for (const item of items) {
      const material = item.material ?? fallback;
      if (!textureCoordinates(item.geometry, material)) continue;
      const { kind } = look(material);
      if (kind === 'translucent') continue;
      if (material.metallicRoughnessTexture && !roughnessMap(material))
        warn(
          '3MF samples a metallic-roughness map at the base colour coordinates; one with another UV set, transform or wrap is left out',
        );
      if (kind === 'metallic') {
        const map = mapOf(material);
        if (map === undefined) continue;
        const source = map?.image ?? null;
        if (!maps.has(source)) maps.set(source, { image: await displayMap(map, signal, metallicTexel) });
        continue;
      }
      if (!maps.has(null)) maps.set(null, { image: await displayMap(null, signal, metallicTexel) });
      const rough = roughnessMap(material);
      if (!rough) continue;
      let factors = glosses.get(rough.image);
      if (!factors) glosses.set(rough.image, (factors = new Map()));
      if (!factors.has(material.roughness))
        factors.set(material.roughness, {
          // 1 - factor x texel is no factor over a map, so the glossiness map holds it whole.
          image: await displayMap(rough, signal, (source, at) => {
            const gloss = 255 - Math.round(material.roughness * source[at + 1]);
            return [gloss, gloss, gloss];
          }),
        });
    }

  // Ids: 1 is the base material group; objects and property groups count up from 2.
  let id = 2;
  const label = (material: Mat): string => escaped(material.name || 'Material'),
    metallic = (material: Mat): string =>
      `<m:pbmetallic name="${label(material)}" metallicness="${num(material.metalness)}" roughness="${num(material.roughness)}"/>`;
  const lookXml = (material: Mat): string => {
    const found = look(material);
    if (found.kind === 'metallic') return metallic(material);
    if (found.kind === 'specular') {
      const [r, g, b] = found.color;
      return `<m:pbspecular name="${label(material)}" specularcolor="${colorOf(r, g, b, 1)}" glossiness="${num(1 - material.roughness)}"/>`;
    }
    return `<m:translucent name="${label(material)}" attenuation="${found.attenuation.map(num).join(' ')}" refractiveindex="${found.index.map(num).join(' ')}" roughness="${num(material.roughness)}"/>`;
  };
  /**
   * The base material of a part. `white` is a translucent material under colours or a texture, which multiply it in a
   * `multiproperties`, as those groups take no translucency (section 7.5.1).
   */
  const baseOf = (material: Mat, white: boolean): Base => {
    const [r, g, b, a] = material.color,
      color = white ? '#FFFFFF' : colorOf(r, g, b, a),
      { kind } = look(material),
      key = JSON.stringify([color, material.name ?? '', displayProperties ? lookXml(material) : '']);
    let group = bases.get(kind);
    if (!group) bases.set(kind, (group = { id: bases.size ? id++ : 1, entries: new Map() }));
    let found = group.entries.get(key);
    if (!found) group.entries.set(key, (found = { index: group.entries.size, color, material }));
    return { group: group.id, index: found.index };
  };
  /** The composite group of a node's constituents, which gives each mixture its index there. */
  const mixtureOf = ({ materials }: ThreeMFComposite) => {
    const key = JSON.stringify(materials);
    let found = mixtures.get(key);
    if (!found) mixtures.set(key, (found = { base: id++, id: id++, rows: new Map() }));
    const { rows } = found;
    return {
      key,
      group: found.id,
      row: (ratios: ThreeMFRatios): number => {
        const text = ratioRow(ratios, materials.length);
        let at = rows.get(text);
        if (at === undefined) rows.set(text, (at = rows.size));
        return at;
      },
    };
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
  const textureId = (texture: TextureData, sampling = true): number => {
    const tile = { repeat: 'wrap', mirror: 'mirror', clamp: 'clamp' } as const,
      // A display map names no sampling of its own: it takes the base colour texture's.
      attributes = sampling
        ? ` tilestyleu="${tile[texture.wrapS ?? 'repeat']}" tilestylev="${tile[texture.wrapT ?? 'repeat']}" filter="${texture.magFilter === 'nearest' ? 'nearest' : 'auto'}"`
        : '';
    let samplings = textures.get(texture.image);
    if (!samplings) textures.set(texture.image, (samplings = new Map()));
    let at = samplings.get(attributes);
    if (at === undefined) samplings.set(attributes, (at = addTexture(texture.image, texture.mimeType, attributes)));
    return at;
  };
  /** A colour group; with `material`, its display properties, one entry for each colour. */
  const colorGroup = (colors: readonly string[], material?: Mat): number => {
    let display = '';
    const kind = material && look(material).kind;
    if (displayProperties && material && (kind === 'specular' || (kind === 'metallic' && finished(material)))) {
      const at = id++,
        element = kind === 'specular' ? 'm:pbspeculardisplayproperties' : 'm:pbmetallicdisplayproperties';
      groups.push(`<${element} id="${at}">${lookXml(material).repeat(colors.length)}</${element}>`);
      display = ` displaypropertiesid="${at}"`;
    }
    const at = id++;
    groups.push(
      `<m:colorgroup id="${at}"${display}>${colors.map((color) => `<m:color color="${color}"/>`).join('')}</m:colorgroup>`,
    );
    return at;
  };
  /** A `multiproperties` that multiplies its layers; `rows` are each corner entry's index in every layer. */
  const multiplied = (pids: readonly number[], rows: readonly string[]): number => {
    const at = id++;
    groups.push(
      `<m:multiproperties id="${at}" pids="${pids.join(' ')}" blendmethods="${pids
        .slice(1)
        .fill(0)
        .map(() => 'multiply')
        .join(' ')}">${rows.map((row) => `<m:multi pindices="${row}"/>`).join('')}</m:multiproperties>`,
    );
    return at;
  };
  /** The corners of a translucent part with colours: its white translucent base, multiplied by them. */
  const translucentColors = (palette: readonly string[], base: Base): number =>
    multiplied(
      [base.group, colorGroup(palette)],
      palette.map((_, k) => `${base.index} ${k}`),
    );
  /** The resource id of a map in `maps` or `glosses`, added once; no tile style: it takes the base texture's. */
  const mapId = (map: { image: Uint8Array; id?: number }): number =>
    (map.id ??= addTexture(map.image, 'image/png', ''));
  /** The display properties of a textured material's group, or none. */
  const textureDisplay = (material: Mat): string => {
    const found = look(material);
    if (!displayProperties || found.kind === 'translucent') return '';
    if (found.kind === 'metallic') {
      const map = mapOf(material);
      if (map === undefined) return '';
      const sampled = mapId(maps.get(map?.image ?? null)!),
        at = id++;
      groups.push(
        `<m:pbmetallictexturedisplayproperties id="${at}" name="${label(material)}" metallictextureid="${sampled}" roughnesstextureid="${sampled}" metallicfactor="${num(material.metalness)}" roughnessfactor="${num(material.roughness)}"/>`,
      );
      return ` displaypropertiesid="${at}"`;
    }
    const rough = roughnessMap(material),
      [r, g, b] = found.color,
      colour = found.map ? textureId(found.map, false) : mapId(maps.get(null)!),
      gloss = mapId(rough ? glosses.get(rough.image)!.get(material.roughness)! : maps.get(null)!),
      at = id++;
    groups.push(
      `<m:pbspeculartexturedisplayproperties id="${at}" name="${label(material)}" speculartextureid="${colour}" glossinesstextureid="${gloss}" specularfactor="${colorOf(r, g, b, 1)}" glossinessfactor="${num(rough ? 1 : 1 - material.roughness)}"/>`,
    );
    return ` displaypropertiesid="${at}"`;
  };
  /**
   * The property group a textured shape's corners index, from their `u v tint` entries. White tints leave the texture
   * group alone; any other is a colour group under the texture, multiplied with it in a `multiproperties`, as is the
   * base of a translucent material.
   */
  const textureGroup = (palette: readonly string[], material: Mat, base: Base): number => {
    const coordinates = new Map<string, number>(),
      tints = new Map<string, number>(),
      indexIn = (known: Map<string, number>, key: string): number => {
        let at = known.get(key);
        if (at === undefined) known.set(key, (at = known.size));
        return at;
      },
      rows = palette.map((entry) => {
        const [u, v, tint] = entry.split(' ');
        return `${indexIn(tints, tint)} ${indexIn(coordinates, `${u} ${v}`)}`;
      }),
      image = textureId(material.baseColorTexture!),
      display = textureDisplay(material);
    const at = id++;
    groups.push(
      `<m:texture2dgroup id="${at}" texid="${image}"${display}>${[...coordinates.keys()]
        .map((uv) => {
          const [u, v] = uv.split(' ');
          return `<m:tex2coord u="${u}" v="${v}"/>`;
        })
        .join('')}</m:texture2dgroup>`,
    );
    const translucent = look(material).kind === 'translucent',
      white = tints.size === 1 && tints.has('#FFFFFF');
    // With white alone, each entry is its own coordinate, so the corners' indices serve the texture group as they are.
    if (white && !translucent) return at;
    const colors = white ? undefined : colorGroup([...tints.keys()]);
    return multiplied(
      [...(translucent ? [base.group] : []), ...(colors === undefined ? [] : [colors]), at],
      rows.map((row) => {
        const [tint, coordinate] = row.split(' ');
        return `${translucent ? `${base.index} ` : ''}${white ? '' : `${tint} `}${coordinate}`;
      }),
    );
  };

  /** One primitive of a node, ready to weld: where it lies, what its corners carry and its base material. */
  interface Part {
    geometry: Geo;
    material: Mat;
    positions: ArrayLike<number>;
    colors?: (vertex: number) => string;
    textured: boolean;
    base: Base;
    /** For a graded mixture, the composite group that `colors` indexes. */
    mixture?: number;
    /** Keeps each corner's source vertex, which displacement needs. */
    traced?: boolean;
  }
  type Welded = { part: Part; shape: Shape }[];
  /**
   * Welds a node's parts. A part that closes on its own stays a shell of its own, so shells that touch keep two
   * triangles to an edge; open parts, the primitives of one surface among them, are welded together.
   */
  const weldParts = (parts: readonly Part[], mirrored: boolean): Welded => {
    const shapeInto = (weld: Weld, part: Part): Shape =>
        shapeOf(weld, part.positions, part.geometry.indices, part.colors, scale, mirrored, part.traced),
      out = parts.map((part) => ({ part, shape: shapeInto({ vertices: [], known: new Map() }, part) })),
      open = out.length > 1 ? out.filter(({ shape }) => edgesOf(shape.triangles).open > 0) : [];
    if (open.length > 1) {
      const weld: Weld = { vertices: [], known: new Map() };
      for (const entry of open) entry.shape = shapeInto(weld, entry.part);
    }
    return out.filter(({ shape }) => shape.triangles.length);
  };
  /** Adds a node's shells to lists that may hold others; `own` is the base material of the object they join. */
  const append = (welded: Welded, vertices: string[], faces: string[], own: Base): void => {
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
      if (part.mixture !== undefined) group = part.mixture;
      else if (palette)
        group = part.textured
          ? textureGroup(palette, part.material, part.base)
          : look(part.material).kind === 'translucent'
            ? translucentColors(palette, part.base)
            : colorGroup(palette, part.material);
      const { base } = part,
        plain = base.group === own.group && base.index === own.index ? '' : ` pid="${base.group}" p1="${base.index}"`;
      // A graded mixture's palette holds indices in its composite group; any other group is the palette, in order.
      const entry = (corner: number): number | string => (part.mixture === undefined ? corner : palette![corner]);
      for (let t = 0; t < triangles.length; t += 3) {
        const colour = corners
          ? ` pid="${group}" p1="${entry(corners[t])}" p2="${entry(corners[t + 1])}" p3="${entry(corners[t + 2])}"`
          : plain;
        faces.push(
          `<triangle v1="${triangles[t] + first}" v2="${triangles[t + 1] + first}" v3="${triangles[t + 2] + first}"${colour}/>`,
        );
      }
    }
  };
  const named = (name: string | undefined): string => (name ? ` name="${escaped(name)}"` : '');
  const numberedPart = (partNumber: string | undefined, name = 'partnumber'): string =>
    partNumber === undefined ? '' : ` ${name}="${escaped(partNumber)}"`;
  /** A new UUID for an element, as the attribute `attribute`; nothing without the production extension. */
  const unique = (element: ThreeMFElement['element'], name: string | undefined, attribute = 'p:UUID'): string => {
    if (!production) return '';
    const index = counts.get(element) ?? 0;
    counts.set(element, index + 1);
    const given = uuid === randomUUID ? randomUUID() : uuid({ element, name, index });
    if (typeof given !== 'string' || !UUID.test(given))
      throw new RangeError('3MF production uuid must return a lower-case UUID in the 8-4-4-4-12 form');
    if (uuids.has(given)) throw new RangeError(`3MF production uuid ${given} is given twice`);
    uuids.add(given);
    return ` ${attribute}="${given}"`;
  };
  /** The path attribute of a reference to an object in a model part of its own. */
  const pathOf = (objectId: number, attribute = 'p:path'): string => {
    const part = objectParts.get(objectId);
    return part === undefined ? '' : ` ${attribute}="/${part}"`;
  };
  const object = (
    vertices: string[],
    faces: string[],
    base: Base,
    name: string | undefined,
    { type = 'model', partNumber, modelResolution }: ThreeMFObjectInfo,
    { alternatives = '', lattice = '', slices = '', rooted = false, volume = '', shape = '' } = {},
  ): number => {
    const at = id++,
      resolution = (modelResolution === undefined ? '' : ` pa:modelresolution="${modelResolution}"`) + slices,
      // Only the root part may name another (production extension 3.2), and an unreferenced object stays in it, as do
      // a lattice and the meshes it names, which must share a part.
      part =
        separateParts && type !== 'other' && !alternatives && !lattice && !slices && !rooted
          ? `3D/Objects/object${at}.model`
          : undefined;
    if (part) objectParts.set(at, part);
    objects.push({
      id: at,
      part,
      xml:
        `<object id="${at}" type="${type}"${resolution} pid="${base.group}" pindex="${base.index}"${named(name)}${numberedPart(partNumber)}${unique('object', name)}>` +
        `${shape || `<mesh${volume}><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles>${lattice}</mesh>`}${alternatives}</object>`,
    });
    return at;
  };
  const component = (objectId: number, name: string | undefined, transform = ''): string =>
    `<component objectid="${objectId}"${pathOf(objectId)}${transform}${unique('component', name)}/>`;
  /** An object of components, which takes no property of its own (core specification chapter 4). */
  const assemblyOf = (parts: readonly string[]): number => {
    const at = id++,
      name = title === undefined ? undefined : String(title);
    objects.push({
      id: at,
      xml: `<object id="${at}" type="model"${named(name)}${unique('object', name)}><components>${parts.join('')}</components></object>`,
    });
    return at;
  };
  const item = (objectId: number, partNumber: string | undefined, name?: string, transform = ''): void => {
    build.push(
      `<item objectid="${objectId}"${pathOf(objectId)}${transform}${numberedPart(partNumber)}${unique('item', name)}/>`,
    );
  };
  /** What `objectInfo` says of a node, checked. */
  /** `objectInfo`'s answer for each node, asked once each before writing, as it decides which writers to load. */
  const answers = new Map<Mesh | ExportNode, ThreeMFObjectInfo>();
  const infoOf = (source: Mesh | ExportNode): Described => {
    const given: ThreeMFObjectInfo = answers.get(source) ?? {},
      type = given.type ?? 'model',
      info = {
        type,
        partNumber: partText(given.partNumber, 'partNumber'),
        itemPartNumber: partText(given.itemPartNumber, 'itemPartNumber'),
        composite: given.composite && checkComposite(given.composite),
        modelResolution: given.modelResolution,
        alternatives: given.alternatives?.length ? given.alternatives : undefined,
        lattice: given.lattice,
        checked: given.lattice && checkLattice(given.lattice),
        slices: given.slices,
        layered: given.slices && checkSlices(given.slices, type === 'support'),
        volume: given.volume,
        levelSet: given.levelSet,
        displacement: given.displacement,
      };
    if (!TYPES.includes(type)) throw new RangeError(`3MF object type must be one of ${TYPES.join(', ')}`);
    if ((info.volume || info.levelSet || info.displacement) && together)
      throw new RangeError(
        "3MF writes a volume, level set or displacement for a node's own object; use assembly: false or 'components'",
      );
    if (info.displacement) {
      if (type !== 'model') throw new RangeError('3MF displaces only a model object');
      if (info.volume || info.levelSet || info.lattice || info.slices)
        throw new RangeError('3MF displacement takes no volume, level set, lattice or slices on the same node');
    }
    if (info.levelSet && (info.lattice || info.slices))
      throw new RangeError('3MF level sets take no lattice or slices on the same node');
    if (info.slices && together)
      throw new RangeError("3MF writes slices for a node's own object; use assembly: false or 'components'");
    if (info.lattice) {
      if (type !== 'model' && type !== 'solidsupport')
        throw new RangeError('3MF puts a beam lattice only in a model or solidsupport object');
      if (together)
        throw new RangeError("3MF writes a beam lattice in a node's own object; use assembly: false or 'components'");
    }
    const resolutions = [info.modelResolution, ...(info.alternatives ?? []).map(({ resolution }) => resolution)];
    if (resolutions.some((r) => r !== undefined && !RESOLUTIONS.includes(r)))
      throw new RangeError(`3MF model resolution must be one of ${RESOLUTIONS.join(', ')}`);
    if (info.modelResolution !== undefined || info.alternatives) {
      if (!production) throw new RangeError('3MF alternatives and model resolutions are in the production extension');
      if (together)
        throw new RangeError("3MF alternatives stand for a node's own object; use assembly: false or 'components'");
    }
    if (info.itemPartNumber !== undefined) {
      if (type === 'other')
        throw new RangeError('3MF keeps an other object out of the build, so it has no build item for itemPartNumber');
      if (!ownItems)
        throw new RangeError(
          '3MF writes this scene as one build item; give its itemPartNumber in the options, or use assembly: false',
        );
      if (itemNumber !== undefined) throw new RangeError('3MF itemPartNumber is given twice for one build item');
    }
    return info;
  };
  const check = (welded: Welded, name: string | undefined): void =>
    onMeshCheck?.(
      reportOf(
        welded.map(({ shape }) => shape),
        name,
      ),
    );
  /** One primitive's part, its corners' properties by its material or its node's mixture. */
  const partOf = (
    { geometry, material: given }: Drawable,
    positions: ArrayLike<number>,
    info: ThreeMFObjectInfo,
    keys: string[],
  ): Part => {
    const material = given ?? fallback;
    if (info.composite) {
      const { ratios } = info.composite,
        mixture = mixtureOf(info.composite),
        at = geometry.positions;
      if (textureCoordinates(geometry, material) || vertexColors(geometry, material))
        warn('3MF writes a composite node as its mixture alone, without its texture or vertex colours');
      const graded =
          typeof ratios === 'function'
            ? (vertex: number): string =>
                String(mixture.row(ratios([at[vertex * 3], at[vertex * 3 + 1], at[vertex * 3 + 2]])))
            : undefined,
        index = typeof ratios === 'function' ? Number(graded!(geometry.indices[0])) : mixture.row(ratios),
        base = { group: mixture.group, index };
      // A shared object holds one geometry under one mixture, or one function of its vertices.
      keys.push(`${numbered(geometry)} ${mixture.key} ${typeof ratios === 'function' ? numbered(ratios) : index}`);
      return { geometry, material, positions, colors: graded, textured: false, base, mixture: graded && mixture.group };
    }
    const coordinates = textureCoordinates(geometry, material),
      tint = coordinates && tintOf(geometry, material),
      colors = coordinates
        ? (vertex: number) => `${coordinates(vertex)} ${tint!(vertex)}`
        : vertexColors(geometry, material),
      base = baseOf(material, !!colors && look(material).kind === 'translucent'),
      found = look(material),
      map = coordinates && displayProperties ? mapOf(material) : undefined,
      sampled = found.kind === 'specular' ? [found.map, roughnessMap(material)] : [];
    // What a shared object's properties depend on.
    keys.push(
      `${numbered(geometry)} ${base.group} ${base.index} ${coordinates ? `${textureId(material.baseColorTexture!)} ${JSON.stringify(material.baseColorTextureTransform ?? null)} ${map ? numbered(map.image) : map} ${sampled.map((t) => t && numbered(t.image))}` : ''}`,
    );
    return { geometry, material, positions, colors, textured: !!coordinates, base };
  };
  /** A node's own positions in its object's frame: mirrored nodes reflect them, and sliced ones stand them up. */
  const framed = (positions: ArrayLike<number>, mirrored: boolean, turned: boolean): ArrayLike<number> => {
    const reflected = mirrored ? moved(positions, FLIP) : positions;
    return turned ? moved(reflected, TURN) : reflected;
  };
  /**
   * Writes an object's layers, into a part of their own when asked, and gives its slice stack's id. `mirrored`
   * reflects them in X and runs each contour the other way, so it still fills.
   */
  const sliceStack = (slices: ReturnType<typeof checkSlices>, mirrored: boolean): number => {
    const { layers, bottom, separatePart, open } = slices,
      colors = new Map<string, number>(),
      colorIndex = (color: string): number => {
        const key = color.toUpperCase();
        let at = colors.get(key);
        if (at === undefined) colors.set(key, (at = colors.size));
        return at;
      },
      height = (value: number): string => num(value * scale),
      group = layers.some(({ outlines }) => outlines.some(({ color }) => color !== undefined)) ? id++ : 0;
    const body = layers.map(({ top, outlines }) => {
      const vertices: string[] = [],
        known = new Map<string, number>();
      const polygons = outlines.map(({ points, count, color }) => {
        const order = Array.from({ length: count }, (_, i) => i);
        if (mirrored) order.reverse();
        const at = order.map((i) => {
          const x = Math.fround(points[i * 2] * scale * (mirrored ? -1 : 1)),
            y = Math.fround(points[i * 2 + 1] * scale);
          if (!Number.isFinite(x + y))
            throw new RangeError(
              '3MF position exceeds Float32 range in this unit; pick a larger unit or lower the scale',
            );
          const key = `${x} ${y}`;
          let found = known.get(key);
          if (found === undefined) {
            known.set(key, (found = vertices.length));
            vertices.push(`<s:vertex x="${num(x)}" y="${num(y)}"/>`);
          }
          return found;
        });
        const property = (corner: number): number =>
          colorIndex(typeof color === 'string' ? color : color![order[corner]]);
        const segments = Array.from({ length: open ? count - 1 : count }, (_, i) => {
          const next = (i + 1) % count;
          return `<s:segment v2="${at[next]}"${color === undefined ? '' : ` pid="${group}" p1="${property(i)}" p2="${property(next)}"`}/>`;
        });
        return `<s:polygon startv="${at[0]}">${segments.join('')}</s:polygon>`;
      });
      return `<s:slice ztop="${height(top)}">${polygons.length ? `<s:vertices>${vertices.join('')}</s:vertices>${polygons.join('')}` : ''}</s:slice>`;
    });
    const palette = group
        ? [
            `<m:colorgroup id="${group}">${[...colors.keys()].map((c) => `<m:color color="${c}"/>`).join('')}</m:colorgroup>`,
          ]
        : [],
      stack = (own: number, content: string): string =>
        `<s:slicestack id="${own}" zbottom="${height(bottom)}">${content}</s:slicestack>`,
      at = id++;
    if (!separatePart) groups.push(...palette, stack(at, body.join('')));
    else {
      const inner = id++,
        part = `2D/slices${at}.model`;
      layerParts.push({ part, resources: [...palette, stack(inner, body.join(''))] });
      groups.push(stack(at, `<s:sliceref slicestackid="${inner}" slicepath="/${part}"/>`));
    }
    sliced.add(slices.meshResolution);
    return at;
  };
  /** Writes a mesh given in a node's frame as an object of its own, which no build item places. */
  const meshObject = (
    node: ExportNode,
    mirrored: boolean,
    info: ThreeMFObjectInfo,
    name: string | undefined,
    rooted: boolean,
    turned: boolean,
  ): number => {
    const drawn = drawables(collect({ nodes: [node] }, options, undefined, 'shape')),
      parts = drawn.map((item) => {
        const own = moved(item.geometry.positions, item.world);
        return partOf(item, framed(own, mirrored, turned), info, []);
      }),
      // The mesh's own reflection reverses its triangles once more.
      reversed = mirrored !== (!!drawn.length && determinant3(drawn[0].world) < 0),
      welded = weldParts(parts, reversed);
    if (!welded.length)
      throw new RangeError('3MF alternative, clipping and representation nodes need a mesh with triangles');
    const vertices: string[] = [],
      faces: string[] = [],
      { base } = welded[0].part;
    check(welded, name);
    append(welded, vertices, faces, base);
    return object(vertices, faces, base, name, info, { rooted });
  };
  /**
   * Adds a lattice's points to its object's vertices and gives its element. The meshes it names are written first, in
   * the same model part.
   */
  const latticeOf = (
    lattice: ReturnType<typeof checkLattice>,
    mirrored: boolean,
    vertices: string[],
    info: ReturnType<typeof infoOf>,
    name: string | undefined,
    perUnit = scale,
  ): string => {
    const { positions, beams, balls, sets, clipping, representation, ballMode, ballRadius, cap } = lattice,
      // A mesh named by a lattice is a model with no lattice of its own.
      turned = !!info.layered && zUp,
      referred = (node: ExportNode): number =>
        meshObject(node, mirrored, { type: 'model', composite: info.composite }, node.name ?? name, true, turned),
      clip = clipping && referred(clipping.mesh),
      shown = representation && referred(representation),
      first = vertices.length,
      length = (value: number | undefined, attribute: string): string =>
        value === undefined ? '' : ` ${attribute}="${num(value * perUnit)}"`,
      colors = new Map<string, number>(),
      colorIndex = (color: string): number => {
        const key = color.toUpperCase();
        let at = colors.get(key);
        if (at === undefined) colors.set(key, (at = colors.size));
        return at;
      };
    const placedAt = framed(positions, mirrored, turned);
    for (let i = 0; i < positions.length; i += 3) {
      const [x, y, z] = [0, 1, 2].map((k) => Math.fround(placedAt[i + k] * perUnit));
      if (!Number.isFinite(x + y + z))
        throw new RangeError('3MF position exceeds Float32 range in this unit; pick a larger unit or lower the scale');
      vertices.push(`<vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>`);
    }
    // The colour group takes its id once its colours are known, and is written before the object that names it.
    const group = beams.some((b) => b.color !== undefined) || balls.some((b) => b.color !== undefined) ? id++ : 0;
    const beamXml = beams.map(({ v1, v2, r1, r2, cap1, cap2, color }) => {
      let property = '';
      if (color !== undefined) {
        const [a, b] = typeof color === 'string' ? [color, color] : color;
        property = ` pid="${group}" p1="${colorIndex(a)}" p2="${colorIndex(b)}"`;
      }
      return (
        `<b:beam v1="${first + v1}" v2="${first + v2}"` +
        // A second radius is not allowed without a first.
        length(r1 ?? (r2 === undefined ? undefined : lattice.radius), 'r1') +
        `${length(r2, 'r2')}${property}${cap1 ? ` cap1="${cap1}"` : ''}${cap2 ? ` cap2="${cap2}"` : ''}/>`
      );
    });
    const ballXml = balls.map(
      ({ vertex, radius, color }) =>
        `<b2:ball vindex="${first + vertex}"${length(radius, 'r')}${color === undefined ? '' : ` pid="${group}" p="${colorIndex(color)}"`}/>`,
    );
    if (group)
      groups.push(
        `<m:colorgroup id="${group}">${[...colors.keys()].map((color) => `<m:color color="${color}"/>`).join('')}</m:colorgroup>`,
      );
    const refs = (list: readonly number[] = [], element: string): string =>
        list.map((index) => `<${element} index="${index}"/>`).join(''),
      setXml = sets.map(
        (set) =>
          `<b:beamset${set.name === undefined ? '' : ` name="${escaped(set.name)}"`}${set.identifier === undefined ? '' : ` identifier="${escaped(set.identifier)}"`}>${refs(set.beams, 'b:ref')}${refs(set.balls, 'b2:ballref')}</b:beamset>`,
      );
    lattices.add('b');
    if (ballMode !== 'none') lattices.add('b2');
    return (
      `<b:beamlattice radius="${num(lattice.radius * perUnit)}" minlength="${num(lattice.minLength * perUnit)}" cap="${cap}"` +
      (clip === undefined ? '' : ` clippingmode="${clipping!.mode}" clippingmesh="${clip}"`) +
      (shown === undefined ? '' : ` representationmesh="${shown}"`) +
      (ballMode === 'none' ? '' : ` b2:ballmode="${ballMode}" b2:ballradius="${num(ballRadius! * perUnit)}"`) +
      `><b:beams>${beamXml.join('')}</b:beams>` +
      (setXml.length ? `<b:beamsets>${setXml.join('')}</b:beamsets>` : '') +
      (ballXml.length ? `<b2:balls>${ballXml.join('')}</b2:balls>` : '') +
      '</b:beamlattice>'
    );
  };
  /** Writes a node's alternative objects, and gives the element that lists them for its own object. */
  const alternativesOf = (info: ReturnType<typeof infoOf>, mirrored: boolean, name: string | undefined): string => {
    if (!info.alternatives) return '';
    const listed = info.alternatives.map(({ node, resolution = 'fullres' }) => {
      const own = node.name ?? name,
        at = meshObject(
          node,
          mirrored,
          { type: info.type, partNumber: info.partNumber, composite: info.composite },
          own,
          false,
          !!info.layered && zUp,
        );
      if (objectParts.has(at)) pathed.add('pa');
      return `<pa:alternative objectid="${at}"${pathOf(at, 'path')}${unique('alternative', own, 'UUID')} modelresolution="${resolution}"/>`;
    });
    return `<pa:alternatives>${listed.join('')}</pa:alternatives>`;
  };
  /**
   * A mesh that a volumetric function names, in the function's coordinates, which no unit, turn or build transform
   * touches. It is written among the volumetric resources, before the function.
   */
  const functionMesh = (node: ExportNode, lattice: ThreeMFLattice | undefined): number => {
    const checked = lattice && checkLattice(lattice),
      drawn = drawables(collect({ nodes: [node] }, options, undefined, 'shape', [], !!lattice)),
      vertices: string[] = [],
      faces: string[] = [];
    if (checked && (checked.clipping || checked.representation))
      throw new RangeError('3MF a lattice that a function names takes no clipping or representation mesh');
    for (const { geometry, world } of drawn) {
      const weld: Weld = { vertices: [], known: new Map() },
        first = vertices.length,
        { triangles } = shapeOf(
          weld,
          moved(geometry.positions, world),
          geometry.indices,
          undefined,
          1,
          determinant3(world) < 0,
        );
      for (let v = 0; v < weld.vertices.length; v += 3) {
        const [x, y, z] = weld.vertices.slice(v, v + 3);
        vertices.push(`<vertex x="${num(x)}" y="${num(y)}" z="${num(z)}"/>`);
      }
      for (let t = 0; t < triangles.length; t += 3)
        faces.push(
          `<triangle v1="${triangles[t] + first}" v2="${triangles[t + 1] + first}" v3="${triangles[t + 2] + first}"/>`,
        );
    }
    if (!faces.length && !checked) throw new RangeError('3MF a mesh that a function names needs triangles');
    const body = checked ? latticeOf(checked, false, vertices, { type: 'model' }, node.name, 1) : '',
      at = id++;
    fieldXml.push(
      `<object id="${at}" type="model"${named(node.name)}${unique('object', node.name)}><mesh><vertices>${vertices.join('')}</vertices><triangles>${faces.join('')}</triangles>${body}</mesh></object>`,
    );
    return at;
  };
  let fields: ReturnType<typeof import('./threemf-fields.js').fieldWriter> | undefined;
  /** Takes the file's object coordinates, or a normal, between the node's geometry frame and its object's. */
  const framing = (mirrored: boolean, turned: boolean) => {
    // Columns of the matrices from the object frame back to the geometry frame, and of normals the other way.
    const back = [0, 1, 2].map((axis) => {
        const p = [0, 0, 0];
        p[axis] = 1 / scale;
        const q = turned ? [p[0], p[2], -p[1]] : p;
        return [mirrored ? -q[0] : q[0], q[1], q[2], 0];
      }),
      forward = [0, 1, 2].map((axis) => {
        const p = [0, 0, 0];
        p[axis] = axis === 0 && mirrored ? -1 : 1;
        return [...(turned ? [p[0], -p[2], p[1]] : p), 0];
      });
    return { toGeometry: [...back.flat(), 0, 0, 0, 1], turn: [...forward.flat(), 0, 0, 0, 1] };
  };
  /** The bounds of a node's geometry, minimum then maximum. */
  const boundsOf = (drawn: readonly Drawable[]): number[] => {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const { geometry } of drawn)
      for (let i = 0; i < geometry.positions.length; i++) {
        const k = i % 3;
        box[k] = Math.min(box[k], geometry.positions[i]);
        box[k + 3] = Math.max(box[k + 3], geometry.positions[i]);
      }
    return box;
  };
  /** Turns an object's faces into a displacement mesh element. */
  const displacedShape = (
    given: ThreeMFDisplacement,
    welded: Welded,
    vertices: string[],
    faces: string[],
    turn: number[],
  ): string => {
    // The same order as `append` writes the vertices and faces in.
    const firsts = new Map<Weld, number>(),
      points: number[] = [],
      triangles: number[] = [],
      sources: [Geo, number][] = [];
    for (const { part, shape } of welded) {
      let first = firsts.get(shape.weld);
      if (first === undefined) {
        firsts.set(shape.weld, (first = points.length / 3));
        for (const value of shape.weld.vertices) points.push(value);
      }
      for (let i = 0; i < shape.triangles.length; i++) {
        triangles.push(shape.triangles[i] + first);
        sources.push([part.geometry, shape.from![i]]);
      }
    }
    const { group, corners } = fields!.displacement(given, points, triangles, sources, turn),
      prefixed = (xml: string): string => xml.replace('<', '<d:');
    return `<d:displacementmesh><d:vertices>${vertices.map(prefixed).join('')}</d:vertices><d:triangles did="${group}">${faces
      .map((face, i) => prefixed(face).replace('/>', `${corners[i]}/>`))
      .join('')}</d:triangles></d:displacementmesh>`;
  };
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
    const info = infoOf(drawn[0].source!),
      keys: string[] = [];
    if (!info.lattice && drawn.some(({ geometry }) => !geometry.indices.length))
      throw new RangeError('Indices must hold complete triangles; only a node with a lattice may have none');
    // A sliced object's frame has the file's Z up, so its build transform keeps layers level (slice extension 1).
    const turned = !!info.layered && zUp,
      placement = upright(world, zUp);
    if (turned)
      for (let row = 0; row < 3; row++)
        [placement[4 + row], placement[8 + row]] = [-placement[8 + row], placement[4 + row]];
    if (
      info.layered &&
      [placement[2], placement[6], placement[8], placement[9], placement[10] - 1].some((v) => v !== 0)
    )
      throw new RangeError(
        '3MF layers stay level: a sliced node may turn about the up axis, move and scale across the bed, not tilt or change its height',
      );
    const parts = drawn.map((item): Part => {
      const { positions } = item.geometry,
        placedAt = together ? moved(positions, upright(matrix, zUp)) : framed(positions, mirrored, turned);
      return { ...partOf(item, placedAt, info, keys), traced: !!info.displacement };
    });
    if (together) {
      const welded = weldParts(parts, mirrored);
      if (!welded.length) return;
      const kind = JSON.stringify([info.type, info.partNumber]);
      let into = merged.get(kind);
      if (!into) {
        const { type, partNumber } = info;
        merged.set(kind, (into = { type, partNumber, vertices: [], faces: [], base: welded[0].part.base, name }));
      }
      check(welded, name);
      append(welded, into.vertices, into.faces, into.base);
      return;
    }
    const others = info.alternatives && numbered(info.alternatives),
      beamed = info.lattice && numbered(info.lattice),
      layered = info.slices && numbered(info.slices),
      fielded = [info.volume, info.levelSet, info.displacement].map((value) => value && numbered(value)),
      key = `${mirrored} ${JSON.stringify([info.type, info.partNumber, info.modelResolution, others, beamed, layered, fielded])} ${keys.join('|')}`;
    let at = shared.get(key);
    if (at === undefined) {
      const welded = weldParts(parts, mirrored);
      // A lattice object may have no triangles.
      if (!welded.length && !(info.lattice && parts.length)) return;
      const vertices: string[] = [],
        faces: string[] = [],
        { base } = welded[0]?.part ?? parts[0];
      if (welded.length) check(welded, name);
      append(welded, vertices, faces, base);
      // Resources are defined before they are referred to, so the meshes this object names come first.
      const alternatives = alternativesOf(info, mirrored, name),
        lattice = info.checked && latticeOf(info.checked, mirrored, vertices, info, name),
        slices =
          info.layered &&
          ` s:slicestackid="${sliceStack(info.layered, mirrored)}"${info.layered.meshResolution === 'lowres' ? ' s:meshresolution="lowres"' : ''}`;
      let shape: string | undefined, volume: string | undefined;
      if (info.volume || info.levelSet || info.displacement) {
        const { toGeometry, turn } = framing(mirrored, turned),
          box = boundsOf(drawn),
          filled = info.volume && fields!.volume(info.volume, toGeometry, box);
        if (info.displacement) shape = displacedShape(info.displacement, welded, vertices, faces, turn);
        if (info.levelSet) {
          // The node's mesh bounds the region the function is evaluated in, as an object the build does not place.
          const domain = object(vertices, faces, base, name, { type: 'model' }, { rooted: true });
          shape = fields!.levelSet(info.levelSet, domain, filled, toGeometry, box);
        } else if (filled !== undefined) volume = ` v:volumeid="${filled}"`;
      }
      const rooted = !!(shape || volume),
        written = object(vertices, faces, base, name, info, { alternatives, lattice, slices, shape, volume, rooted });
      shared.set(key, (at = written));
    }
    if (info.type === 'other') return;
    const transform = ` transform="${itemTransform(placement, scale)}"`;
    printed.push({ type: info.type, alone: ownItems });
    if (!ownItems && assembly === 'components') components.push(component(at, name, transform));
    else item(at, info.itemPartNumber ?? itemNumber, name, transform);
  };
  for (const drawn of nodes.values()) {
    const source = drawn[0].source!,
      answer = objectInfo?.(source);
    if (answer) answers.set(source, answer);
  }
  if ([...answers.values()].some(({ volume, levelSet, displacement }) => volume || levelSet || displacement)) {
    const context: FieldContext = {
      id: () => id++,
      escaped,
      scale,
      group: (xml) => groups.push(xml),
      resource: (xml) => fieldXml.push(xml),
      file: (name, data) => fieldFiles.push({ name, data }),
      mesh: functionMesh,
    };
    // Loaded only for a file that asks for these extensions.
    fields = (await import('./threemf-fields.js')).fieldWriter(context);
    signal?.throwIfAborted();
  }
  for (const drawn of nodes.values()) {
    signal?.throwIfAborted();
    placed(drawn);
  }
  if (merged.size) {
    const referenced = [...merged.values()].filter(({ type }) => type !== 'other'),
      alone = referenced.length === 1,
      ids: string[] = [];
    for (const { vertices, faces, base, name, type, partNumber } of merged.values()) {
      // The one mesh of an assembly takes the title; meshes under components keep their first node's name.
      const own = alone && type !== 'other' && title !== undefined ? String(title) : name,
        at = object(vertices, faces, base, own, { type, partNumber });
      if (type === 'other') continue;
      printed.push({ type, alone });
      if (alone) item(at, itemNumber, own);
      else ids.push(component(at, own));
    }
    if (ids.length) item(assemblyOf(ids), itemNumber, title === undefined ? undefined : String(title));
  }
  if (components.length) item(assemblyOf(components), itemNumber, title === undefined ? undefined : String(title));
  if (!build.length)
    throw new RangeError('3MF requires at least one mesh with triangles in an object other than other');
  const supports = (type: ThreeMFObjectType): boolean => type === 'support' || type === 'solidsupport';
  if (printed.some(({ type, alone }) => supports(type) && (alone || !printed.some((p) => p.type === 'model'))))
    warn(
      '3MF asks that support be referenced only from an object of components beside the model it supports (core specification section 4.1); this support is not, as the scene is written as separate items or holds no model with it',
    );
  // Each base material group after the display properties it names.
  const baseXml = [...bases].flatMap(([kind, { id: group, entries }]) => {
    const list = [...entries.values()],
      shown = displayProperties && (kind !== 'metallic' || list.some(({ material }) => finished(material))) ? id++ : 0,
      element = `${kind === 'translucent' ? 'm:translucent' : kind === 'specular' ? 'm:pbspecular' : 'm:pbmetallic'}displayproperties`,
      materials = `<basematerials id="${group}"${shown ? ` displaypropertiesid="${shown}"` : ''}>${list
        .map(
          ({ color, material }) =>
            `<base name="${material.name ? escaped(material.name) : color}" displaycolor="${color}"/>`,
        )
        .join('')}</basematerials>`;
    return shown
      ? [`<${element} id="${shown}">${list.map(({ material }) => lookXml(material)).join('')}</${element}>`, materials]
      : [materials];
  });
  const mixtureXml = [...mixtures].flatMap(([key, { base, id: group, rows }]) => {
    const materials = JSON.parse(key) as ThreeMFConstituent[];
    return [
      `<basematerials id="${base}">${materials
        .map(({ name, color }) => `<base name="${escaped(name)}" displaycolor="${color}"/>`)
        .join('')}</basematerials>`,
      `<m:compositematerials id="${group}" matid="${base}" matindices="${materials.map((_, i) => i).join(' ')}">` +
        `${[...rows.keys()].map((values) => `<m:composite values="${values}"/>`).join('')}</m:compositematerials>`,
    ];
  });
  // Textures first: display properties of base materials never sample one, those of texture groups do.
  const resources = [...baseXml, ...textureXml, ...groups, ...mixtureXml],
    /** Each model part of one object, with the resources it needs: a part refers only to its own. */
    apart = objects
      .filter((object) => object.part)
      .map(({ part, xml }) => ({ part: part!, xml, needs: resourcesOf(resources, xml) })),
    rooted = objects.filter((object) => !object.part).map(({ xml }) => xml),
    rootNeeds = new Set(resourcesOf(resources, rooted.join(''))),
    elsewhere = new Set(apart.flatMap(({ needs }) => needs)),
    rootResources = resources.filter((xml) => rootNeeds.has(xml) || !elsewhere.has(xml)),
    alternatives = rooted.some((xml) => xml.includes('<pa:alternatives>') || xml.includes(' pa:modelresolution="')),
    declared = fields?.declarations() ?? { namespaces: '', required: [] },
    namespaces =
      ` xmlns="${CORE}" xmlns:m="${MATERIAL}"` +
      (production ? ` xmlns:p="${PRODUCTION}"` : '') +
      (alternatives ? ` xmlns:pa="${ALTERNATIVES}"` : '') +
      (lattices.size ? ` xmlns:b="${BEAMS}"` : '') +
      (lattices.has('b2') ? ` xmlns:b2="${BALLS}"` : '') +
      (sliced.size ? ` xmlns:s="${SLICE}"` : '') +
      declared.namespaces,
    // A package whose model parts refer to others must require the production extension (its chapter 1), and one with
    // beam lattices theirs (beam lattice extension chapter 1).
    // A file whose mesh is too coarse without its layers requires the slice extension (its chapter 2).
    extensions = [
      ...(apart.length ? ['p', ...pathed] : []),
      ...lattices,
      ...(sliced.has('lowres') ? ['s'] : []),
      ...declared.required,
    ],
    required = extensions.length ? ` requiredextensions="${extensions.join(' ')}"` : '',
    modelOf = (head: string, body: string, own: readonly string[], items: string): string =>
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<model unit="${unit}" xml:lang="en-US"${head}>${body}<resources>${own.join('')}</resources>${items}</model>\n`,
    model = modelOf(
      `${namespaces}${required}${described.namespaces}`,
      described.xml,
      [...rootResources, ...fieldXml, ...rooted],
      `<build${unique('build', title === undefined ? undefined : String(title))}>${build.join('')}</build>`,
    ),
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
    /** The relationships of the textures among `own`, in the order the textures were added. */
    sampled = (own: ReadonlySet<string>) =>
      files.filter((_, i) => own.has(textureXml[i])).map(({ name }) => [name, `${RELATIONSHIP}3dtexture`] as const),
    rootRelations = [
      ...sampled(new Set(rootResources)),
      ...fieldFiles.map(({ name }) => [name, `${RELATIONSHIP}3dtexture`] as const),
      ...[...apart, ...layerParts].map(({ part }) => [part, `${RELATIONSHIP}3dmodel`] as const),
    ],
    parts = apart.flatMap(({ part, xml, needs }) => {
      const textured = sampled(new Set(needs)),
        data = encoder.encode(modelOf(namespaces, '', [...needs, xml], '<build/>'));
      return [
        { name: part, data },
        ...(textured.length
          ? [{ name: part.replace(/([^/]+)$/, '_rels/$1.rels'), data: relationships(textured) }]
          : []),
      ];
    });
  return encodeZIP(
    [
      {
        name: '[Content_Types].xml',
        data: encoder.encode(
          '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
            (preview
              ? `<Default Extension="${preview}" ContentType="image/${preview === 'png' ? 'png' : 'jpeg'}"/>`
              : '') +
            files.map(({ name }) => `<Override PartName="/${name}" ContentType="${TEXTURE_PART}"/>`).join('') +
            fieldFiles.map(({ name }) => `<Override PartName="/${name}" ContentType="image/png"/>`).join('') +
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
      ...(rootRelations.length ? [{ name: '3D/_rels/3dmodel.model.rels', data: relationships(rootRelations) }] : []),
      ...parts,
      ...layerParts.map(({ part, resources: own }) => ({
        name: part,
        data: encoder.encode(modelOf(namespaces, '', own, '<build/>')),
      })),
      ...files,
      ...fieldFiles,
      ...pictures,
    ],
    { signal, compress },
  );
}
