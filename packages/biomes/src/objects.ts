/// <reference lib="esnext.disposable" preserve="true" />
// BiomeObjects (B6): a placement's stored objects and detail densities drawn through scatter. Each species mesh is a
// `ScatterTiles` (decision D3) fed with the tiles' 8-byte records as they stream around the camera; dead trees draw as
// snags; every detail species (grass, ferns, reeds) is a camera-following `Scatter` whose density map is the
// placement's detail map, so grass is drawn per frame and never stored. Meshes come from `@margoengine/procedural`
// (the `procedural:<name>` keys of the presets). Scatter, its tiles entry, procedural and core are loaded on attach.
import type { EngineKernel, Geometry, PbrMaterial } from '@margoengine/core';
import type { Scatter } from '@margoengine/scatter';
import type { ScatterTiles } from '@margoengine/scatter/tiles';
import type { ScatterBase, ScatterSkyOcclusion, ScatterStateSource, ScatterTextures } from '@margoengine/scatter';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { BiomePlacement, PlacedSpecies, PlacedTile } from './placement.js';
import { captureScene } from '../../shared/scene-scope.js';
import { drawCapture, shareCapture } from '../../shared/capture.js';
import type { ScatterCapture } from '@margoengine/scatter';
import type { PassContext } from '@margoengine/core/extension';
import type { BiomeSeasons } from './seasons.js';
import type { ClearingMap, ClearingMapLook, ScatterClearingMap } from '@margoengine/scatter/clearing-map';
import type { BiomeWorld } from './world.js';

/** Settings of {@link BiomeObjects.attach}. */
export interface BiomeObjectsOptions {
  /** Height texture over `bounds` (r32float, texel centres on the rectangle's grid), read every frame. */
  readonly heightmap: () => GPUTexture | undefined;
  /** World rectangle the heightmap covers, `[minX, minZ, maxX, maxZ]`. */
  readonly bounds: readonly [number, number, number, number];
  /** Stored objects are drawn within this distance of the camera. Default 1,000 m. */
  readonly radius?: number;
  /**
   * Species off the canopy layer (shrubs, hedge shrubs, rocks, props) are drawn within this distance, at most `radius`.
   * A hedged countryside seen from a hill or a drone needs its hedge shrubs out to the view's reach: at 300 m a 2 m hedge
   * is about 26 pixels high through a 50 mm lens on a 1,920 pixel Super 35 frame (24.89 mm wide), and 5 pixels at 1,500 m.
   * Default 300 m.
   */
  readonly nearRadius?: number;
  /** Detail (grass, ferns) is drawn within this distance. Default 120 m. */
  readonly detailRadius?: number;
  /**
   * Screen-space tree LOD (KB-BIOMES-SCREENLOD1): a tree with detail levels hands its near and middle foliage to the
   * next ring once its sprays (the finest tenth of the foliage's area, see {@link foliageWidth}) would project under
   * this many viewport pixels through the camera's field of view, or at its ring distance, whichever comes first, so no
   * spray draws thinner than this before the imposter takes over (scatter `lodSize`). Default none: rings by distance
   * alone. On the timber-valley blowup (2160 rendered rows, 45 degrees) 1 px moved few rings and raised speckle in the
   * smoke band from 19.8 to 25.1 ppm early (47.4 to 48.4 mid), so it is not on by default.
   */
  readonly lodPixels?: number;
  /** Metres per detail density texel. Default 2. */
  readonly detailResolution?: number;
  /**
   * Most bytes the detail density maps may take over all detail species (each map is one byte per texel over `bounds`,
   * kept on this thread and as a GPU texture). Default 128 MiB.
   */
  readonly detailBudget?: number;
  /**
   * Trees beyond `radius`, out to `far.radius` metres: a 12-triangle stand-in per tree over the world's `canopyCover`, up
   * to `far.count` of them (default 300,000), lit by the engine light, no shadows. Default none.
   */
  readonly far?: {
    readonly radius: number;
    readonly count?: number;
    readonly world: BiomeWorld;
    /** Drawn surface heights for the distant forest. Defaults to the objects' heightmap. */
    readonly heightmap?: () => GPUTexture | undefined;
    /** Density rules shared with the placed forest. */
    readonly graph?: import('./graph.js').PlacementGraph;
  };
  /**
   * Seasons from `@margoengine/biomes/seasons` over the placement's world: the foliage of species with `color.seasonal`
   * (and of every species and detail of a biome with `tint.seasonal`) takes `seasonalColor` of its base colour under the
   * state at the centre of `bounds`, and follows each `seasons.set`. Placement and instances are unchanged; only colour
   * moves. Default none: the colours stay as they are.
   */
  readonly seasons?: BiomeSeasons;
  /**
   * Meshes by key, drawn in place of the procedural mesh of the same key: a species or detail whose `mesh` is a key here
   * draws these parts (a model from an asset library, such as a scanned fir or a boulder, by its own key or over a
   * `procedural:<name>` one), and `procedural:snag` replaces the dead-tree mesh. Placement, density and records do not
   * change; only what each record draws. See {@link BiomeMeshPart}. Default none: every key draws its procedural mesh.
   */
  readonly meshes?: Readonly<Record<string, readonly BiomeMeshPart[]>>;
  /**
   * Burnt and flooded plants: the plant state response of each part (`PlantStates.plant()` from
   * `@margoengine/scatter/states`), by mesh key and part kind, or undefined to leave that part as it is (stone, say).
   * Asked once per part at attach; species and details alike. Default none.
   * @example states: (key, kind) => (kind === 'stone' ? undefined : kind === 'bark' ? trunks : crowns)
   */
  readonly states?: (key: string, kind: 'bark' | 'foliage' | 'stone') => ScatterStateSource | undefined;
  /**
   * Objects meet the ground they stand on: stones darken and, on damp ground, mossen at the foot, trunks take soil on
   * theirs (`ScatterOptions.base`), trees keep exp(-0.5 x stand cover) of the sky's light at the ground line, all
   * of it from half their height up (`ScatterOptions.skyOcclusion`), and their foliage keeps exp(-1.2) of it at the
   * crown's axis, all of it at the outer tips (`skyOcclusion.crown`). Default true. A species' `sink` and `alignToGround` apply either
   * way.
   */
  readonly contact?: boolean;
  /**
   * Takes the footprints of each held tile's stones and trunks as tiles come and go: `set(key, [x, z, radius, kind,
   * ...])`, world metres, kind 0 a trunk and 1 a stone, and `remove(key)`. A `TerrainGroundContact` of
   * `@margoengine/terrain/ground-contact` takes them and draws the soil and contact shade there. Default none.
   */
  readonly ground?: {
    set(key: string, footprints: ArrayLike<number>): void;
    remove(key: string): void;
    /** The baked contact mask, when the ground has one: detail opens around the feet it holds (`groundCover`). */
    mask?(): ClearingMap | undefined;
  };
  /**
   * How detail (grass, ferns) answers `ground`'s mask: it thins out and stands shorter in the soil ring around every
   * trunk and stone, so the ring shows (`clearingMap` of `@margoengine/scatter/clearing-map`, whose defaults it takes).
   * False leaves the detail as it is. Needs a `ground` with a `mask()`. Default on.
   */
  readonly groundCover?: false | ClearingMapLook;
}

/** Vertex data of a registry mesh: positions and normals (xyz per vertex, metres, y up, the base at y = 0) and triangles. */
export interface BiomeMeshData {
  readonly positions: ArrayLike<number>;
  readonly normals: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}

/**
 * One part of a registry mesh (`BiomeObjectsOptions.meshes`): one colour and one look, drawn as one scatter of the
 * species' records. A tree is usually two parts (bark and foliage); a rock one.
 */
export interface BiomeMeshPart {
  /** The part's vertices, or one set per LOD ring (near, middle, far), finest first. */
  readonly geometry: BiomeMeshData | readonly [BiomeMeshData, BiomeMeshData, BiomeMeshData];
  /** Albedo, linear RGB 0..1 (a textured model's mean texture colour). Per-object tint follows `kind`. */
  readonly color: readonly [number, number, number];
  /** `'bark'`, `'foliage'` (sways, shades as clusters, follows the seasons) or `'stone'` (does not sway). */
  readonly kind: 'bark' | 'foliage' | 'stone';
  /**
   * The part's texture maps, as its glTF material holds them (a scanned fir's bark or needle cards): `uvs` per vertex of
   * each geometry and the base colour (with an alpha cut-out that also shapes the shadows), normal and
   * occlusion-roughness-metal maps. See `ScatterTextures` in `@margoengine/scatter`. With maps, `color` multiplies the
   * base colour map (the glTF factor): `[1, 1, 1]` draws it as authored. Default none: `color` alone.
   */
  readonly textures?: ScatterTextures;
}

/**
 * Checks a registry of {@link BiomeMeshPart} by key.
 * @throws TypeError for a malformed registry or part; RangeError for a colour outside 0..1, vertex data whose lengths
 *   are not whole vertices and triangles, or an index past the last vertex.
 */
export function checkBiomeMeshes(
  meshes: unknown,
): asserts meshes is Readonly<Record<string, readonly BiomeMeshPart[]>> {
  if (typeof meshes !== 'object' || meshes === null || Array.isArray(meshes))
    throw typeError('BiomeObjects meshes must be an object of mesh parts by key', 'biomes');
  for (const [key, parts] of Object.entries(meshes as Record<string, unknown>)) {
    if (!Array.isArray(parts) || parts.length === 0)
      throw typeError(`BiomeObjects meshes.${key} must be a non-empty array of parts`, 'biomes');
    for (const part of parts as BiomeMeshPart[]) {
      if (typeof part !== 'object' || part === null || !(part.kind in OBJECT_LOOKS))
        throw typeError(`BiomeObjects meshes.${key}: each part needs a kind of bark, foliage or stone`, 'biomes');
      const c = part.color as unknown as ArrayLike<unknown>;
      if (!c || c.length !== 3 || !Array.from(c).every((v) => typeof v === 'number' && v >= 0 && v <= 1))
        throw rangeError(`BiomeObjects meshes.${key}: color must be three linear RGB values 0 to 1`, 'biomes');
      const rings = Array.isArray(part.geometry)
        ? (part.geometry as readonly BiomeMeshData[])
        : [part.geometry as BiomeMeshData];
      if (rings.length !== 1 && rings.length !== 3)
        throw typeError(`BiomeObjects meshes.${key}: geometry is one mesh or three (near, middle, far)`, 'biomes');
      if (
        part.textures !== undefined &&
        (typeof part.textures !== 'object' || part.textures === null || typeof part.textures.uvs !== 'object')
      )
        throw typeError(`BiomeObjects meshes.${key}: textures need uvs and maps (ScatterTextures)`, 'biomes');
      for (const d of rings) {
        if (
          !d ||
          typeof d.positions?.length !== 'number' ||
          typeof d.normals?.length !== 'number' ||
          typeof d.indices?.length !== 'number'
        )
          throw typeError(`BiomeObjects meshes.${key}: geometry needs positions, normals and indices`, 'biomes');
        const n = d.positions.length / 3;
        if (
          !Number.isInteger(n) ||
          n === 0 ||
          d.normals.length !== d.positions.length ||
          d.indices.length % 3 ||
          !d.indices.length
        )
          throw rangeError(
            `BiomeObjects meshes.${key}: positions and normals must be equal whole vertices and indices whole triangles`,
            'biomes',
          );
        for (let i = 0; i < d.indices.length; i++)
          if (!(d.indices[i] >= 0 && d.indices[i] < n && Number.isInteger(d.indices[i])))
            throw rangeError(
              `BiomeObjects meshes.${key}: index ${d.indices[i]} is past the last vertex ${n - 1}`,
              'biomes',
            );
      }
    }
  }
}

/** Default {@link BiomeObjectsOptions.detailBudget}: 128 MiB of detail maps. */
export const DETAIL_BUDGET = 134_217_728;

/**
 * Whether the detail maps of `species` detail species over `bounds`, one texel every `resolution` metres, fit `budget`
 * bytes and textures of at most `limit` texels a side (the device's largest 2D texture).
 */
export function detailFits(
  bounds: readonly [number, number, number, number],
  resolution: number,
  species: number,
  limit: number,
  budget = DETAIL_BUDGET,
): boolean {
  const width = Math.ceil((bounds[2] - bounds[0]) / resolution), // float division: view only
    depth = Math.ceil((bounds[3] - bounds[1]) / resolution); // float division: view only
  return width <= limit && depth <= limit && width * depth * species <= budget;
}

/**
 * Colours (linear RGB) of the procedural meshes' parts. Each canopy tree has its own green: broadleaf a mid green,
 * birch a lighter yellow green, palm a fresh green, conifer a darker blue green (needles).
 */
const BARK = [0.22, 0.14, 0.08] as const,
  LEAF = [0.14, 0.3, 0.05] as const,
  BIRCH = [0.26, 0.36, 0.07] as const,
  PALM = [0.1, 0.32, 0.07] as const,
  NEEDLE = [0.04, 0.17, 0.07] as const,
  // Granite: ECOSTRESS Spectral Library 1.0 samples Granite_H2, H3 and H5 (JHU, directional hemispherical), the mean of
  // @margoengine/materials measured `granite`. Until 2026-11-28 it was (0.4, 0.37, 0.33), half again too bright.
  STONE = [0.2709, 0.224, 0.1869] as const,
  GREEN_GRASS = [0.1617, 0.2024, 0.0917] as const,
  DRY = [0.45, 0.33, 0.11] as const,
  // A green leaf reflects about a tenth of green light and half that of blue and red (PROSPECT, Jacquemoud and Baret
  // 1990; LOPEX93 leaf spectra, Hosgood et al. 1995).
  SHRUB = [0.065, 0.11, 0.035] as const,
  // Dwarf birch: copper-red twigs and small leaves, darker green above (Betula nana L.).
  TWIG = [0.11, 0.045, 0.028] as const,
  DWARF_BIRCH = [0.07, 0.105, 0.025] as const;

/**
 * Per-instance tint and leaf-cluster shading of each kind of part (scatter's `variation` and `clusters`): leaves vary
 * most and shade as clumps about 0.6 m across; bark and stone vary a little and stay smooth.
 */
const OBJECT_LOOKS = {
  foliage: { variation: { hue: 0.06, value: 0.15 }, clusters: 0.6 },
  bark: { variation: { hue: 0.02, value: 0.1 } },
  stone: { variation: { hue: 0.02, value: 0.1 } },
} as const;

// How objects meet the ground (`contact`). Sky light falls off with the leaves above, exponentially (Monsi and Saeki
// 1953; English translation 2005, Annals of Botany 95:549, https://doi.org/10.1093/aob/mci052). A crown's outer
// needles also see the sky from the side, so only a tree's lower half is shaded, to an optical depth of 0.7 at the
// ground, scaled by the share of its stand the species closes. Inside the crown the foliage shades itself
// (`skyOcclusion.crown`): that darkens each crown's middle against its tips, so overlapping crowns stand apart. All
// three numbers are chosen on rendered stands: the depth of 2 of a closed canopy seen from straight above, over whole
// trees, turned the crowns black and merged them.
const CANOPY_DEPTH = 0.5,
  CROWN_DEPTH = 1.2,
  // A species without a `stands` rule counts as half closed (chosen).
  OPEN_COVER = 0.5,
  // Linear albedo: forest soil and litter splashed on a trunk's foot (inside CLM5's dry soil range 0.08 to 0.36 in the
  // near infrared; the value is chosen), and the damp moss of RockSurface (@margoengine/terrain/rock-surface).
  SOIL = [0.1, 0.08, 0.055] as const,
  MOSS = [0.07, 0.1, 0.03] as const,
  // Ground materials under which stones grow moss at their foot; stones of a desert or a bare field only darken.
  DAMP_GROUND: readonly string[] = ['grass', 'meadow', 'moss', 'needles', 'leaf-litter', 'tundra', 'mud'];

/**
 * The width of a mesh's finest foliage: the area-weighted tenth percentile, over its triangles, of each triangle's
 * narrowest width (twice its area over its longest edge), in mesh units. A leaf spray or needle band is a strip of
 * triangles, so this is about the strip's width at its thin end; nine tenths of the area is at least this wide.
 * Screen-space LOD switches when this projects under a pixel (Luebke, Reddy, Cohen, Varshney, Watson and Huebner 2003,
 * Level of Detail for 3D Graphics, ch. 4: the projected size of a level's geometric error picks the level).
 */
export function foliageWidth(geometry: { readonly vertices: ArrayLike<number>; readonly indices: ArrayLike<number> }): number {
  const v = geometry.vertices,
    ix = geometry.indices,
    rows: [number, number][] = [];
  let total = 0;
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const a = ix[t] * 6,
      b = ix[t + 1] * 6,
      c = ix[t + 2] * 6,
      ux = v[b] - v[a],
      uy = v[b + 1] - v[a + 1],
      uz = v[b + 2] - v[a + 2],
      wx = v[c] - v[a],
      wy = v[c + 1] - v[a + 1],
      wz = v[c + 2] - v[a + 2],
      area = 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx),
      longest = Math.max(
        Math.hypot(ux, uy, uz),
        Math.hypot(wx, wy, wz),
        Math.hypot(v[c] - v[b], v[c + 1] - v[b + 1], v[c + 2] - v[b + 2]),
      );
    if (area > 0 && longest > 0) {
      rows.push([(2 * area) / longest, area]); // float division: view only
      total += area;
    }
  }
  rows.sort((x, y) => x[0] - y[0]);
  let sum = 0;
  for (const [width, area] of rows) if ((sum += area) >= 0.1 * total) return width;
  return 0;
}

/** Scatter `lodSize` of a form whose foliage has detail levels: its near and middle foliage widths, or none. */
function screenLod(form: readonly Part[]): [number, number] | undefined {
  const foliage = form.find((part) => part.kind === 'foliage' && Array.isArray(part.geometry));
  if (!foliage) return undefined;
  const [near, middle] = foliage.geometry as readonly [Geometry, Geometry, Geometry],
    a = foliageWidth(near),
    b = foliageWidth(middle);
  return a > 0 && b > 0 ? [Math.min(a, b), b] : undefined;
}

/** The foot and sky options of one part of a species whose mesh stands `height` metres at scale 1. */
function standingLooks(
  kind: Kind,
  tree: boolean,
  height: number,
  cover: number | undefined,
  damp: boolean,
  crown: number,
): { base?: ScatterBase; skyOcclusion?: ScatterSkyOcclusion } {
  if (!(height > 0)) return {};
  if (kind === 'stone')
    return {
      base: { height: Math.min(0.25, height / 3), shade: 0.5, ...(damp ? { tint: MOSS, amount: 0.65 } : {}) },
    };
  return {
    ...(kind === 'bark' ? { base: { height: Math.min(0.35, height / 4), shade: 0.4, tint: SOIL, amount: 0.6 } } : {}),
    ...(tree
      ? {
          skyOcclusion: {
            depth: CANOPY_DEPTH * (cover ?? OPEN_COVER),
            height: height / 2,
            ...(kind === 'foliage' && crown > 0 ? { crown: { depth: CROWN_DEPTH, radius: crown, top: height } } : {}),
          },
        }
      : {}),
  };
}

/** The widest reach across the ground of a part's near mesh, over the vertices below `under` metres. */
function reachOf(geometry: Part['geometry'], under = Infinity): number {
  const near = (Array.isArray(geometry) ? geometry[0] : geometry) as { readonly vertices?: ArrayLike<number> };
  let reach = 0;
  for (let i = 0; i < (near.vertices?.length ?? 0); i += 6)
    if (near.vertices![i + 1] < under) reach = Math.max(reach, Math.hypot(near.vertices![i], near.vertices![i + 2]));
  return reach;
}

// The share of a crown's radius that a tree's litter apron takes as its footprint radius: with TerrainGroundContact's
// trunk profile (soil exp(-s / 1.1 r) to 3 r past it) the soil then fades out about at the crown's edge. Litter and duff
// under pines and western mixed conifers are greater inside the crown than outside it (Prichard et al. 2025, "Forest
// floor properties in pine forests of the southeastern and western United States", Fire Ecology 21:85,
// https://doi.org/10.1186/s42408-025-00429-5).
// The share is chosen on rendered stands.
const LITTER_REACH = 0.3;

/**
 * A part's colour jitter under its species' `color`: the hue and value the rule gives, else the part kind's own. A hue
 * past half a turn either way covers the circle already.
 */
const jitterOf = (
  own: { readonly hue: number; readonly value: number },
  color: { readonly hue?: number; readonly value?: number },
): { hue: number; value: number } => ({ hue: Math.min(0.5, color.hue ?? own.hue), value: color.value ?? own.value });

/** The widest reach across the ground of a form's foliage, 0 for a form without any. */
const crownOf = (form: readonly Part[]): number =>
  Math.max(0, ...form.map((part) => (part.kind === 'foliage' ? reachOf(part.geometry) : 0)));

/**
 * A form's footprint at scale 1: a stone's from its widest reach across the ground; a tree's from its bark's widest
 * reach below 0.3 m, or `LITTER_REACH` of its crown's reach where that is wider. Plants of other layers leave none.
 */
function footOf(form: readonly Part[], tree: boolean): Foot | undefined {
  for (const part of form) {
    const stone = part.kind === 'stone';
    if (!stone && !(tree && part.kind === 'bark')) continue;
    const reach = reachOf(part.geometry, stone ? Infinity : 0.3);
    if (!(reach > 0)) continue;
    // A stone's widest corner reaches past its mean outline.
    if (stone) return { radius: reach * 0.8, kind: 1 };
    return { radius: Math.max(reach, LITTER_REACH * crownOf(form)), kind: 0 };
  }
  return undefined;
}

/** The top of a part's mesh above its origin at scale 1 (its near ring), 0 for one without vertices. */
function meshTop(geometry: Part['geometry']): number {
  const near = (Array.isArray(geometry) ? geometry[0] : geometry) as { readonly vertices?: ArrayLike<number> };
  let top = 0;
  for (let i = 1; i < (near.vertices?.length ?? 0); i += 6) top = Math.max(top, near.vertices![i]);
  return top;
}

/** The mesh detail level of each LOD ring (near, middle, far) of stored objects: `@margoengine/procedural`'s `detail`. */
const OBJECT_LOD_DETAIL = [2, 1, 0] as const;

type Procedural = typeof import('@margoengine/procedural');
type Conifers = typeof import('@margoengine/procedural/conifers');
type Broadleaves = typeof import('@margoengine/procedural/broadleaves');
/** The optional tree generators a key may need, loaded only when one names them. */
type Trees = { conifers?: Conifers; broadleaves?: Broadleaves };
type Data = { positions: ArrayLike<number>; normals: ArrayLike<number>; indices: ArrayLike<number> };
type Kind = keyof typeof OBJECT_LOOKS;
/** The options with no default value. */
type Optional =
  | 'heightmap'
  | 'bounds'
  | 'far'
  | 'seasons'
  | 'meshes'
  | 'states'
  | 'contact'
  | 'ground'
  | 'groundCover'
  | 'lodPixels';
/** What one form of a species presses into the ground: its radius at scale 1, and 0 a trunk or 1 a stone. */
type Foot = { readonly radius: number; readonly kind: 0 | 1 };
/** A mesh part: one geometry, or one per LOD ring (near, middle, far) for meshes with detail levels. */
type Part = {
  geometry: Geometry | readonly [Geometry, Geometry, Geometry];
  color: readonly [number, number, number];
  kind: Kind;
  blades?: boolean;
  textures?: ScatterTextures;
  /**
   * The mean linear colour a textured part's image carries under its white `color` (a broadleaf's leaf atlas): the
   * seasons tint such a part by the ratio of the tinted mean to the mean, which is exact at the mean.
   */
  mean?: readonly [number, number, number];
};
type Modules = {
  tiles: typeof import('@margoengine/scatter/tiles');
  scatter: typeof import('@margoengine/scatter');
  /** Loaded only when a detail draws `procedural:grass` and the `meshes` registry does not replace it. */
  grass?: typeof import('@margoengine/scatter/grass');
  procedural: Procedural;
  core: typeof import('@margoengine/core');
  /** Loaded only when a species, detail or snag key names a conifer of `@margoengine/procedural/conifers`. */
  conifers?: Conifers;
  /** Loaded only when a species or detail key names a broadleaf of `@margoengine/procedural/broadleaves`. */
  broadleaves?: Broadleaves;
  /** Loaded only when the placement has detail and `ground` has a mask for it to open around. */
  clearing?: typeof import('@margoengine/scatter/clearing-map');
};

/** Whether a detail key draws as GrassScatter blades: `procedural:grass` that the `meshes` registry leaves alone. */
const isBladeGrass = (key: string, own: Readonly<Record<string, unknown>>): boolean =>
  key === 'procedural:grass' && !Object.hasOwn(own, key);

/** Charred bark, linear RGB: a burnt conifer's stem. */
const CHAR = [0.035, 0.03, 0.028] as const;

/**
 * The parts of a mesh key: trees are wood and foliage, the rest one mesh. Unknown keys draw as a shrub. Meshes with
 * detail levels (trees, palms, birch, acacia, shrubs) give each part the {@link OBJECT_LOD_DETAIL} chain, one geometry
 * per LOD ring, as do rocks (finer subdivision near); the others (cacti, snags, ground cover) one geometry for every ring.
 */
function partsOf(
  key: string,
  p: Procedural,
  make: (data: Data) => Geometry,
  meshes?: Readonly<Record<string, readonly BiomeMeshPart[]>>,
  trees: Trees = {},
  seed = 1,
): Part[] {
  const { conifers, broadleaves } = trees;
  const own = meshes && Object.hasOwn(meshes, key) ? meshes[key] : undefined;
  if (own)
    return own.map((part) => ({
      geometry: Array.isArray(part.geometry)
        ? ((part.geometry as readonly Data[]).map(make) as unknown as [Geometry, Geometry, Geometry])
        : make(part.geometry as Data),
      color: part.color,
      kind: part.kind,
      ...(part.textures ? { textures: part.textures } : {}),
    }));
  const name = key.startsWith('procedural:') ? key.slice(11) : key,
    chain = <T>(level: (detail: 0 | 1 | 2) => T) => OBJECT_LOD_DETAIL.map(level) as [T, T, T],
    rings = (list: readonly [Data, Data, Data]) => list.map(make) as unknown as [Geometry, Geometry, Geometry],
    tree = (
      levels: [{ trunk: Data; canopy: Data }, ...{ trunk: Data; canopy: Data }[]],
      leaf: readonly [number, number, number],
    ) => {
      const many = levels.length === 3,
        pick = (part: 'trunk' | 'canopy') =>
          many ? rings(levels.map((t) => t[part]) as unknown as [Data, Data, Data]) : make(levels[0][part]);
      return [
        { geometry: pick('trunk'), color: BARK, kind: 'bark' as const },
        ...(levels[0].canopy.indices.length
          ? [{ geometry: pick('canopy'), color: leaf, kind: 'foliage' as const }]
          : []),
      ];
    };
  /** A shrub's wood and leaves. */
  const shrubParts = (
    stems: readonly [Data, Data, Data],
    leaves: readonly [Data, Data, Data],
    wood: readonly [number, number, number],
    leaf: readonly [number, number, number],
  ): Part[] => [
    { geometry: rings(stems), color: wood, kind: 'bark' },
    { geometry: rings(leaves), color: leaf, kind: 'foliage' },
  ];
  const conifer = conifers?.parseConiferKey(name);
  if (conifers && conifer) {
    // A northern Rockies conifer: near and middle meshes and, for a live tree, the imposter in the far ring. The canopy
    // draws white: its needle colour is in its image (solid for the nearer rings, the baked cut-out for the cards).
    const levels = conifers.coniferLevels(conifer.species, { age: conifer.age, condition: conifer.condition }),
      bark = conifer.condition === 'burnt' ? CHAR : conifers.CONIFER_SPECIES[conifer.species].bark,
      all = (list: readonly [Data, Data, Data]) => list.map(make) as unknown as [Geometry, Geometry, Geometry];
    return [
      { geometry: all(levels.trunk), color: bark, kind: 'bark' },
      ...(levels.textures
        ? [
            {
              geometry: all(levels.canopy),
              color: [1, 1, 1] as const,
              kind: 'foliage' as const,
              textures: levels.textures,
            },
          ]
        : []),
    ];
  }
  const broadleaf = broadleaves?.parseBroadleafKey(name);
  if (broadleaves && broadleaf) {
    // An oak, beech or alder grown with limbs and leaf-spray cards (KB-PROCEDURAL-OAKBLOB1): near and middle meshes and,
    // for a leafed tree, the imposter in the far ring. The canopy draws white: its leaf colour is in the atlas image.
    const levels = broadleaves.broadleafLevels(broadleaf.species, {
        age: broadleaf.age,
        condition: broadleaf.condition,
      }),
      all = (list: readonly [Data, Data, Data]) => list.map(make) as unknown as [Geometry, Geometry, Geometry];
    return [
      { geometry: all(levels.trunk), color: broadleaves.BROADLEAF_SPECIES[broadleaf.species].bark, kind: 'bark' },
      ...(levels.textures
        ? [
            {
              geometry: all(levels.canopy),
              color: [1, 1, 1] as const,
              kind: 'foliage' as const,
              textures: levels.textures,
              mean: broadleaves.BROADLEAF_SPECIES[broadleaf.species].leaves,
            },
          ]
        : []),
    ];
  }
  switch (name) {
    case 'broadleaf':
      return tree(
        chain((detail) => p.generateTreeMesh('broadleaf', { detail })),
        LEAF,
      );
    case 'conifer':
      return tree(
        chain((detail) => p.generateTreeMesh('conifer', { detail })),
        NEEDLE,
      );
    case 'palm':
      return tree(
        chain((detail) => p.generatePalmMesh({ detail })),
        PALM,
      );
    case 'birch':
      return tree(
        chain((detail) => p.generateBirchMesh({ detail })),
        BIRCH,
      );
    case 'acacia':
      return tree(
        chain((detail) => p.generateAcaciaMesh({ detail })),
        DRY,
      );
    case 'snag':
      return tree([p.generateSnagMesh()], LEAF);
    case 'rock':
      // Subdivided finer up close (2,880, 720 and 180 triangles), so a stone a metre or two from the lens shows no facets.
      return [
        {
          geometry: rings(chain((detail) => p.generateRockMesh(seed, undefined, { detail }))),
          color: STONE,
          kind: 'stone',
        },
      ];
    case 'cactus':
      return [{ geometry: make(p.generateCactusMesh()), color: [0.13, 0.3, 0.1], kind: 'bark' }];
    case 'tundra-shrub':
      return shrubParts(
        chain((detail) => p.generateTundraShrubStemsMesh({ detail })),
        chain((detail) => p.generateTundraShrubMesh({ detail })),
        TWIG,
        DWARF_BIRCH,
      );
    case 'grass':
      // Green grass leaves: ripgut brome and wild oat, ECOSTRESS Spectral Library 1.0 samples VH350 and VH352, the
      // path of looks.ts. Until 2026-11-28 it was (0.2, 0.4, 0.06), twice the measured green and half the blue.
      return [{ geometry: make(p.generateGrassMesh(3)), color: GREEN_GRASS, kind: 'foliage', blades: true }];
    case 'fern':
      return [{ geometry: make(p.generateFernMesh()), color: [0.08, 0.28, 0.07], kind: 'foliage' }];
    case 'sedge':
      // Cured grass leaves: wild oat litter, ECOSTRESS Spectral Library 1.0 samples VH354 and VH355 (looks.ts).
      return [{ geometry: make(p.generateSedgeMesh()), color: [0.35, 0.24, 0.1], kind: 'foliage', blades: true }];
    case 'lichen':
      // Pale and without green vegetation's peak at 0.55 um (Petzold and Goward, "Reflectance spectra of subarctic
      // lichens", Remote Sensing of Environment 24(3), 1988, https://doi.org/10.1016/0034-4257(88)90020-X); the value
      // itself is chosen.
      return [{ geometry: make(p.generateLichenMesh()), color: [0.27, 0.26, 0.19], kind: 'foliage' }];
    case 'reeds':
      return [{ geometry: make(p.generateReedMesh()), color: [0.36, 0.34, 0.11], kind: 'foliage', blades: true }];
    default:
      return shrubParts(
        chain((detail) => p.generateShrubStemsMesh({ detail })),
        chain((detail) => p.generateShrubMesh({ detail })),
        BARK,
        SHRUB,
      );
  }
}

/**
 * Seeded stones a `procedural:rock` species draws (KB-BIOMES-ROCKSEED1): seeds 1 to 8 cycle the five forms of
 * `generateRockMesh` (block, slab, wedge, shard, pebble) with their own proportions and joint planes, and each record
 * draws the form its variant nibble picks, so a talus field holds eight silhouettes and no stone is a turned copy of
 * its neighbour. Before 2026-11-28 every stone of every species was seed 1.
 */
const ROCK_FORM_COUNT = 8;

/**
 * The forms a species key draws, each a list of parts: eight seeded stones for `procedural:rock` (unless `meshes`
 * replaces it), one form for every other key.
 */
function formsOf(
  key: string,
  p: Procedural,
  make: (data: Data) => Geometry,
  meshes?: Readonly<Record<string, readonly BiomeMeshPart[]>>,
  trees: Trees = {},
): Part[][] {
  if (key !== 'procedural:rock' || (meshes && Object.hasOwn(meshes, key)))
    return [partsOf(key, p, make, meshes, trees)];
  return Array.from({ length: ROCK_FORM_COUNT }, (_, i) => partsOf(key, p, make, meshes, trees, i + 1));
}

/**
 * One species' 8-byte records split among its forms (a power of two up to 16) by each record's variant (the low four
 * bits of byte 7, a hash drawn at placement), each list in stored order.
 */
function splitForms(records: Uint8Array, forms: number): Uint8Array[] {
  if (forms === 1) return [records];
  const n = records.length >> 3,
    counts = new Int32Array(forms);
  for (let k = 0; k < n; k++) counts[records[k * 8 + 7] & (forms - 1)]++;
  const out = Array.from(counts, (c) => new Uint8Array(c * 8)),
    at = new Int32Array(forms);
  for (let k = 0; k < n; k++) {
    const f = records[k * 8 + 7] & (forms - 1);
    out[f].set(records.subarray(k * 8, k * 8 + 8), at[f]++ * 8);
  }
  return out;
}

/** A species' scatters: every part of every form (`tiles`) and the first part of each form, which holds its records. */
type SpeciesEntry = { tiles: ScatterTiles[]; heads: ScatterTiles[]; radius: number; feet: (Foot | undefined)[] };

type ObjectsPassContext = Extract<PassContext, { backend: 'webgpu' }>;
/**
 * One detail kind: its scatter (and, for blade grass, the dense layer near the camera), its density map's CPU copy and
 * the texture of the device it was last made on.
 */
type Detail = {
  id: string;
  scatter: Scatter;
  near?: Scatter;
  texture?: GPUTexture;
  device?: GPUDevice;
  data: Uint8Array;
};

/**
 * Blade grass's dense near layer: metres around the camera, clumps a square metre per unit of density, and the share of
 * its radius over which it thins out to the field (`edgeThin`).
 */
const NEAR_GRASS = { radius: 40, perDensity: 3, thin: 0.8, field: 0.45 } as const;

/**
 * The stored objects and detail of a biome placement, drawn through scatter around the camera. WebGPU only.
 * `BiomeView` attaches one by default; use it directly to draw a placement over your own terrain.
 * @example
 * const objects = await BiomeObjects.attach(engine, placement, { heightmap: () => heights, bounds: world.bounds });
 * await objects.stream([-500, -500, 500, 500]);
 */
export class BiomeObjects implements Disposable {
  readonly #engine: EngineKernel;
  readonly #placement: BiomePlacement;
  readonly #options: Required<Omit<BiomeObjectsOptions, Optional>> & Pick<BiomeObjectsOptions, Optional>;
  /** Foliage materials that follow the seasons, with their base colours, and the seasons listener's remover. */
  readonly #seasonal: {
    material: PbrMaterial;
    base: readonly [number, number, number];
    mean?: readonly [number, number, number];
  }[] = [];
  #offSeasons?: () => void;
  readonly #modules: Modules;
  /** Per species key: its ScatterTiles (one per mesh part of each form) and the distance it is drawn within. */
  readonly #species = new Map<string, SpeciesEntry>();
  #snags?: SpeciesEntry;
  readonly #details: Detail[] = [];
  /** What opens the detail around the ground's feet (`groundCover`). */
  #cover?: ScatterClearingMap;
  /** Held tiles and their object counts. */
  readonly #held = new Map<string, number>();
  #far?: import('@margoengine/biomes/far').FarForest;
  #disposed = false;
  /** `setCapture`'s hook, each child scatter's share of it, and the dispose listeners. */
  #capture?: ScatterCapture;
  readonly #shared = new Map<Scatter, () => void>();
  readonly #disposers = new Set<() => void>();

  private constructor(engine: EngineKernel, placement: BiomePlacement, options: BiomeObjectsOptions, modules: Modules) {
    this.#engine = engine;
    this.#placement = placement;
    this.#options = {
      radius: 1000,
      nearRadius: 300,
      detailRadius: 120,
      detailResolution: 2,
      detailBudget: DETAIL_BUDGET,
      ...options,
    };
    this.#modules = modules;
  }

  /**
   * Draws a placement's objects. Loads scatter, its tiles entry, procedural and core on first use.
   * @throws TypeError for bad arguments; RangeError for bad options.
   */
  static async attach(
    engine: EngineKernel,
    placement: BiomePlacement,
    options: BiomeObjectsOptions,
  ): Promise<BiomeObjects> {
    if (!engine || !placement || typeof placement.tile !== 'function')
      throw typeError('BiomeObjects.attach takes an engine and a BiomePlacement', 'biomes');
    const b = options?.bounds;
    if (typeof options?.heightmap !== 'function' || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite))
      throw typeError(
        'BiomeObjects needs a heightmap function and the bounds [minX, minZ, maxX, maxZ] it covers',
        'biomes',
      );
    for (const key of ['radius', 'nearRadius', 'detailRadius', 'detailResolution', 'detailBudget', 'lodPixels'] as const)
      if (options[key] !== undefined && !(options[key]! > 0))
        throw rangeError(`BiomeObjects ${key} must be above 0`, 'biomes');
    if (!(b[2] > b[0] && b[3] > b[1]))
      throw rangeError('BiomeObjects bounds must be [minX, minZ, maxX, maxZ] with max above min', 'biomes');
    if (options.meshes !== undefined) checkBiomeMeshes(options.meshes);
    if (options.states !== undefined && typeof options.states !== 'function')
      throw typeError(
        'BiomeObjects states must be a function (key, kind) returning a PlantStates.plant() response or undefined',
        'biomes',
      );
    if (options.seasons !== undefined && typeof options.seasons?.colorAt !== 'function')
      throw typeError('BiomeObjects seasons must be a BiomeSeasons from @margoengine/biomes/seasons', 'biomes');
    if (options.seasons !== undefined && options.seasons.world !== placement.world)
      throw typeError("BiomeObjects seasons must be a BiomeSeasons attached to the placement's world", 'biomes');
    // Checked before anything is allocated: a huge world or a fine resolution must not ask for gigabytes of maps.
    const limit = (engine as unknown as { gpu?: GPUDevice }).gpu?.limits.maxTextureDimension2D ?? 8192;
    if (!detailFits(b, options.detailResolution ?? 2, placement.details.length, limit, options.detailBudget))
      throw fault(
        'unsupported',
        "BiomeObjects detail maps exceed detailBudget or the device's largest texture; raise detailResolution or detailBudget, or shrink bounds",
        'biomes',
      );
    // The scene attached from: the scatter parts register there, whichever scene is active once the imports are in.
    const held = captureScene(engine);
    const [tiles, scatter, procedural, core, { parseConiferKey }, { parseBroadleafKey }] = await Promise.all([
      import('@margoengine/scatter/tiles'),
      import('@margoengine/scatter'),
      import('@margoengine/procedural'),
      import('@margoengine/core'),
      import('@margoengine/procedural/conifer-species'),
      import('@margoengine/procedural/broadleaf-species'),
    ]);
    // The conifer meshes load only when a key names one that the registry does not replace.
    const own = options.meshes ?? {},
      keys = [...placement.species.map((s) => s.mesh), ...placement.details.map((d) => d.mesh)],
      conifers = keys.some((k) => !Object.hasOwn(own, k) && parseConiferKey(k))
        ? await import('@margoengine/procedural/conifers')
        : undefined,
      // So do the broadleaf meshes (an oak, beech or alder key, `procedural:broadleaf` among them).
      broadleaves = keys.some((k) => !Object.hasOwn(own, k) && parseBroadleafKey(k))
        ? await import('@margoengine/procedural/broadleaves')
        : undefined,
      grass = placement.details.some((d) => isBladeGrass(d.mesh, own))
        ? await import('@margoengine/scatter/grass')
        : undefined,
      clearing =
        placement.details.length && options.groundCover !== false && typeof options.ground?.mask === 'function'
          ? await import('@margoengine/scatter/clearing-map')
          : undefined;
    const objects = new BiomeObjects(engine, placement, options, {
      tiles,
      scatter,
      procedural,
      core,
      ...(conifers ? { conifers } : {}),
      ...(broadleaves ? { broadleaves } : {}),
      ...(grass ? { grass } : {}),
      ...(clearing ? { clearing } : {}),
    });
    held.run(() => objects.#build());
    if (objects.#seasonal.length) {
      // Each `seasons.set` and each change of the placement's world (climate, heights, biomes) re-tints the foliage.
      const retint = () => {
          for (const { material, base, mean } of objects.#seasonal) material.set({ color: objects.#tint(base, mean) });
        },
        offSet = options.seasons!.onChange(retint),
        offWorld = placement.onChange(retint);
      objects.#offSeasons = () => {
        offSet();
        offWorld();
      };
    }
    if (options.far) {
      const { FarForest } = await import('@margoengine/biomes/far'),
        far = options.far,
        r = objects.#options.radius,
        side = placement.tileSize;
      // Stand-ins come in over the last tile of the stored trees.
      objects.#far = await held.run(() =>
        FarForest.attach(
          engine,
          { scatter, core },
          {
            ...far,
            heightmap: far.heightmap ?? options.heightmap,
            bounds: b,
            inner: Math.max(0, r - side),
            fade: side,
          },
        ),
      );
    }
    return objects;
  }

  /** Records left out because a tile held more than its slot (0 unless a stand is denser than expected). */
  dropped = 0;

  /**
   * GPU bytes held for stored objects (goal G2): per species, its held records (8 bytes each) and its LOD rings (32
   * bytes per instance they can draw), both sized from the held tiles with headroom; a tree's canopy shares its trunk's.
   */
  get gpuBytes(): number {
    let n = 0;
    for (const entry of [...this.#species.values(), ...(this.#snags ? [this.#snags] : [])])
      for (const t of entry.tiles) n += t.gpuBytes;
    return n;
  }

  /** Far stand-ins drawn at most (`far`), 0 without them. */
  get farCount(): number {
    return this.#far?.count ?? 0;
  }

  /** Objects drawn now (stored records held on the GPU). */
  get count(): number {
    let n = 0;
    for (const c of this.#held.values()) n += c;
    return n;
  }

  /** The `states` option of one part, as a spread: none when no response is given. */
  #states(key: string, kind: 'bark' | 'foliage' | 'stone'): { states?: ScatterStateSource } {
    const states = this.#options.states?.(key, kind);
    return states ? { states } : {};
  }

  #make = (d: Data): Geometry => new this.#modules.core.Geometry(d.positions, d.normals, d.indices);

  #build(): void {
    const { radius, nearRadius, detailRadius, detailResolution, bounds, heightmap } = this.#options,
      contact = this.#options.contact ?? true,
      side = this.#placement.tileSize,
      // Canopy trees are drawn within the full radius, smaller plants, rocks and props within `nearRadius`.
      seasons = this.#options.seasons,
      tiles = (key: string, near: boolean, seasonal = false, species?: PlacedSpecies): SpeciesEntry => {
        const r = near ? Math.min(radius, nearRadius) : radius,
          // Room for every tile within the draw distance plus a tile: a view keeps a tile's objects until it is a whole
          // tile beyond (sized for the distance alone, a view with tiles queued ran out of slots in a frame).
          slots = (Math.ceil((2 * (r + side)) / side) + 2) ** 2, // float division: view only
          // Memory follows the held records, so a tile may hold up to scatter's per-tile limit (no stand is dropped).
          slotSize = Math.min(65536, Math.floor(16777216 / slots)), // float division: view only
          all: ScatterTiles[] = [],
          heads: ScatterTiles[] = [],
          feet: (Foot | undefined)[] = [];
        for (const form of formsOf(key, this.#modules.procedural, this.#make, this.#options.meshes, this.#modules)) {
          const screen = this.#options.lodPixels ? screenLod(form) : undefined,
            list: ScatterTiles[] = [],
            // The form's height at scale 1, over all its parts, so a trunk and its crown shade as one tree.
            height = Math.max(0, ...form.map((part) => meshTop(part.geometry))),
            crown = crownOf(form),
            // Canopy and understory trees (layers 1 and 2) stand under their stand's crowns.
            tree = species?.layer === 1 || species?.layer === 2,
            damp = !!this.#placement.world?.biomes
              .find((b) => b.id === species?.biome)
              ?.ground?.some((g) => DAMP_GROUND.includes(g.material));
          for (const part of form)
            list.push(
              this.#modules.tiles.ScatterTiles.attach(this.#engine, part.geometry, {
                bounds,
                heightmap,
                slots,
                slotSize,
                lod: [r * 0.15, r * 0.4, r],
                lodFade: 0,
                // Foliage with detail levels switches ring by its sprays' projected width as well (KB-BIOMES-SCREENLOD1).
                ...(screen && this.#options.lodPixels ? { lodSize: screen, lodPixels: this.#options.lodPixels } : {}),
                // Lit by the engine's sun and sky and shadowed by an attached Shadows, like the terrain under it.
                material: this.#material(part.color, seasonal && part.kind === 'foliage', part.mean),
                // Each object its own tint; leaves shade as clusters (a few vertex operations, shadows unchanged).
                ...OBJECT_LOOKS[part.kind],
                maxSlope: 90,
                // The species' own bedding: sunk into the hill and tilted with it.
                ...(species?.sink !== undefined ? { sink: species.sink } : {}),
                ...(species?.alignToGround !== undefined ? { alignToGround: species.alignToGround } : {}),
                // A contact foot (soil or moss, less sky) and the sky light a crown loses lower down.
                ...(contact ? standingLooks(part.kind, tree, height, species?.cover, damp, crown) : {}),
                // The species' own colour jitter where its rule gives one: leaves and stone, never bark.
                ...(part.kind !== 'bark' && species?.color
                  ? { variation: jitterOf(OBJECT_LOOKS[part.kind].variation, species.color) }
                  : {}),
                // Plants sway with a light breeze; stone does not.
                ...(part.kind === 'stone' ? {} : { wind: [1, 0, 0.25] as const }),
                // A scanned part draws its own maps (base colour with a cut-out, normal, occlusion-roughness-metal).
                ...(part.textures ? { textures: part.textures } : {}),
                ...this.#states(key, part.kind),
                // A tree's canopy draws the trunk's objects: one set of records, culling and rings for both.
                ...(list.length ? { share: list[0] } : {}),
              }),
            );
          heads.push(list[0]);
          feet.push(footOf(form, tree));
          all.push(...list);
        }
        return { radius: r, tiles: all, heads, feet };
      };
    for (const s of this.#placement.species)
      this.#species.set(s.key, tiles(s.mesh, s.layer !== 1, !!seasons?.isSeasonal(s.biome, s.id), s));
    this.#snags = tiles('procedural:snag', false);
    const { ground, groundCover } = this.#options;
    this.#cover = this.#modules.clearing?.clearingMap(() => ground!.mask!(), groundCover || {});
    const [x0, z0, x1, z1] = bounds,
      width = Math.ceil((x1 - x0) / detailResolution), // float division: view only
      depth = Math.ceil((z1 - z0) / detailResolution); // float division
    for (const d of this.#placement.details) {
      const blades = this.#modules.grass && isBladeGrass(d.mesh, this.#options.meshes ?? {}),
        parts: Part[] = blades
          ? []
          : partsOf(d.mesh, this.#modules.procedural, this.#make, this.#options.meshes, this.#modules),
        area = 2 * detailRadius,
        entry = {
          id: d.id,
          data: new Uint8Array(width * depth),
          texture: undefined as GPUTexture | undefined,
          device: undefined as GPUDevice | undefined,
          scatter: undefined as unknown as Scatter,
          near: undefined as Scatter | undefined,
        };
      const seasonal = !!seasons?.world.biomes.some((b) => b.tint?.seasonal && b.details?.some((r) => r.id === d.id)),
        shared = {
          area: [area, area] as [number, number],
          follow: true,
          bounds,
          heightmap,
          densityMap: () => this.#detail(entry, width, depth),
          // Grass and ferns open around the feet of trunks and stones, so the ground's soil ring shows.
          ...(this.#cover ? { thinning: this.#cover } : {}),
          lod: [detailRadius * 0.3, detailRadius * 0.6, detailRadius] as [number, number, number],
          lodFade: 0,
          edgeShrink: detailRadius * 0.2,
          maxSlope: 60,
          wind: [1, 0, 0.5] as [number, number, number],
        };
      // Meadow grass is GrassScatter's GPU-built tussocks (KB-BIOMES-SPARSEGRASS1): eight blades a clump with cured
      // leaves and a brightness spread. The three-blade clump mesh at the old 400,000 cap left about 20 blades a square
      // metre, a field of tufts on bare ground. A dense layer of NEAR_GRASS.perDensity clumps a square metre per unit of
      // density lies over the field, which keeps scatter's million candidates across `detailRadius`. The near layer is
      // whole within a fifth of NEAR_GRASS.radius and thins out one clump at a time across the rest (`edgeThin`, the
      // thinning of Cook, Halstead, Planck and Ryu 2007), so the sum falls smoothly to the field's own density by its
      // edge (KB-BIOMES-GRASSRING1). Before, the near layer ended at 20 m, shrinking over its last 4 m as the field faded
      // in under it: the density fell about twelve times within 4 m, a band across the frame from a few metres up.
      const material = blades ? this.#material(GREEN_GRASS, seasonal) : this.#material(parts[0].color, seasonal),
        nearR = Math.min(NEAR_GRASS.radius, detailRadius / 2);
      entry.scatter = blades
        ? this.#modules.grass!.GrassScatter.attach(this.#engine, {
            ...shared,
            count: Math.min(1_000_000, Math.max(1000, Math.round(d.density * area * area * NEAR_GRASS.field))),
            material,
            ...this.#states(d.mesh, 'foliage'),
          })
        : this.#modules.scatter.Scatter.attach(this.#engine, parts[0].geometry, {
            ...shared,
            count: Math.min(400000, Math.max(1000, Math.round(d.density * area * area * 0.25))),
            material,
            ...(parts[0].blades ? { blades: {} } : {}),
            ...this.#states(d.mesh, parts[0].kind),
          });
      if (blades)
        entry.near = this.#modules.grass!.GrassScatter.attach(this.#engine, {
          ...shared,
          area: [2 * nearR, 2 * nearR],
          count: Math.min(1_000_000, Math.max(1000, Math.round(d.density * NEAR_GRASS.perDensity * 4 * nearR * nearR))),
          lod: [nearR * 0.3, nearR * 0.6, nearR],
          edgeShrink: 0,
          edgeThin: nearR * NEAR_GRASS.thin,
          seed: 2,
          material,
          ...this.#states(d.mesh, 'foliage'),
        });
      this.#details.push(entry);
    }
  }

  /**
   * A rough, double-sided PBR material of a part's colour (linear RGB); a `seasonal` one takes the seasons' tint and is
   * kept to follow them.
   */
  #material(color: readonly [number, number, number], seasonal = false, mean?: readonly [number, number, number]) {
    if (!seasonal) return new this.#modules.core.PbrMaterial({ color, roughness: 0.85 });
    const material = new this.#modules.core.PbrMaterial({ color: this.#tint(color, mean), roughness: 0.85 });
    this.#seasonal.push({ material, base: color, mean });
    return material;
  }

  /**
   * A base colour under the season state at the centre of `bounds`; with the `mean` colour of a part's image, the base
   * scaled by the tinted mean over the mean, so a textured canopy turns as a leaf of its mean colour would.
   */
  #tint(base: readonly [number, number, number], mean?: readonly [number, number, number]): [number, number, number] {
    const [x0, z0, x1, z1] = this.#options.bounds,
      x = (x0 + x1) / 2,
      z = (z0 + z1) / 2;
    if (!mean) return this.#options.seasons!.colorAt(base, x, z);
    const tinted = this.#options.seasons!.colorAt(mean, x, z);
    // A material factor is at most 1, so a tint brighter than the mean in some channel (autumn yellow) keeps its hue
    // at the largest factor that fits: the canopy turns the right colour, at most as bright as its summer atlas.
    const ratio = tinted.map((c, i) => (mean[i] > 0 ? c / mean[i] : 1)), // float division: a colour, mean[i] > 0
      fit = Math.max(1, ...ratio.map((r, i) => r * base[i]));
    return base.map((c, i) => (c * ratio[i]) / fit) as [number, number, number]; // float division: fit >= 1
  }

  /**
   * What thins and shortens the detail around the ground's feet (`groundCover`; change it with `set`); undefined
   * without it.
   */
  get groundCover(): ScatterClearingMap | undefined {
    return this.#cover;
  }

  /** Foliage materials that follow the seasons (with `seasons` set): one per seasonal species part and detail. */
  get seasonalMaterials(): readonly PbrMaterial[] {
    return this.#seasonal.map((entry) => entry.material);
  }

  /**
   * Lets a capture hook (`@margoengine/post` SSR, SceneTargets, LightBounce: `targets.add(objects, {ground: false})`)
   * draw every scattered object with its own material: the species parts, snags, detail (grass, ferns) and the far
   * stand-ins, each through `Scatter.setCapture`. Parts made later (tiles streamed in) join at their first capture.
   * Returns a remover. Without a hook nothing changes.
   * @throws TypeError for a bad hook or disposed objects.
   */
  setCapture(hook: ScatterCapture): () => void {
    if (
      this.#disposed ||
      !hook ||
      typeof hook.declarations !== 'function' ||
      typeof hook.begin !== 'function' ||
      !Array.isArray(hook.targets)
    )
      throw typeError(
        'Invalid biome objects capture hook; pass an object with declarations() and begin() functions and a targets array to live BiomeObjects.',
        'biomes',
      );
    this.#release();
    this.#capture = hook;
    return () => {
      if (this.#capture !== hook) return;
      this.#release();
      this.#capture = undefined;
    };
  }

  /** Calls `callback` once when the objects are disposed; returns a remover. */
  onDispose(callback: () => void): () => void {
    if (typeof callback !== 'function') throw typeError('BiomeObjects onDispose needs a function', 'biomes');
    this.#disposers.add(callback);
    return () => this.#disposers.delete(callback);
  }

  /**
   * `mode` 'capture': draws every lit scattered object into the capture hook's pass (`setCapture`); `color` and `depth`
   * are unused. Does nothing without a hook or after disposal.
   */
  draw(c: ObjectsPassContext, mode: 'capture', color?: GPUTextureView, depth?: GPUTextureView): void {
    const hook = this.#capture;
    if (mode !== 'capture' || !hook || this.#disposed) return;
    void color;
    void depth;
    // Tiles streamed out dispose their scatters: their shares go, so the map holds only live parts.
    for (const [scatter, restore] of this.#shared)
      if (scatter.disposed) {
        restore();
        this.#shared.delete(scatter);
      }
    for (const scatter of this.#scatters()) {
      if (scatter.disposed || !scatter.options.material) continue;
      if (!this.#shared.has(scatter)) this.#shared.set(scatter, shareCapture(scatter, hook));
      drawCapture(scatter, hook, c);
    }
  }

  /** Every scatter this draws: species parts, snags, detail and far stand-ins. */
  #scatters(): Scatter[] {
    return [
      ...this.casters,
      ...this.#details.flatMap((d) => (d.near ? [d.scatter, d.near] : [d.scatter])),
      ...(this.#far?.scatters ?? []),
    ];
  }

  /** Gives the children's hooks back. */
  #release(): void {
    for (const restore of this.#shared.values()) restore();
    this.#shared.clear();
  }

  /**
   * Every stored-object mesh: each species' parts (trunk and canopy) and the snags. `BiomeView`'s `shadows` option adds
   * them to a `Shadows` as casters; detail (grass, ferns) receives shadows but does not cast.
   */
  get casters(): readonly ScatterTiles[] {
    return [...this.#species.values(), ...(this.#snags ? [this.#snags] : [])].flatMap((entry) => entry.tiles);
  }

  /**
   * Every scatter this draws that sways in the wind (species parts but stone, snags, detail and far stand-ins with a
   * `wind`), for the passes that need their own motion: give each to TAA as `taa.add(new ScatterVelocity(scatter))`
   * (`@margoengine/scatter/velocity`), so it keeps history on swaying leaves instead of reprojecting them by the camera
   * alone. Built at attach; empty after `dispose()`.
   */
  get swaying(): readonly Scatter[] {
    return this.#scatters().filter((scatter) => !scatter.disposed && !!scatter.options.wind);
  }

  /**
   * A detail map's texture on the device drawing now, made from its CPU copy on first use and again on a restored
   * device: WebGPU objects are valid only with the device that made them, and a lost device's are unusable (W3C
   * WebGPU, sections 3.2.1 and 3.5.2), so the scatter must never bind the old one (KB-OWN-BIOMES3).
   */
  #detail(entry: Detail, width: number, depth: number): GPUTexture | undefined {
    const device = (this.#engine as unknown as { gpu?: GPUDevice }).gpu;
    if (!device) return undefined;
    if (entry.texture && entry.device === device) return entry.texture;
    entry.texture?.destroy();
    const texture = device.createTexture({ size: [width, depth], format: 'r8unorm', usage: 4 | 2 }); // TEXTURE_BINDING | COPY_DST
    device.queue.writeTexture({ texture }, entry.data as Uint8Array<ArrayBuffer>, { bytesPerRow: width }, [
      width,
      depth,
    ]);
    entry.device = device;
    return (entry.texture = texture);
  }

  /** Streams the tiles of a world rectangle (metres) in, nearest the camera first, and drops held tiles beyond the radius. */
  async stream(
    rect: readonly [number, number, number, number],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    const eye = this.#engine.camera.position,
      r = this.#options.radius;
    for await (const tile of this.#placement.tiles(rect, { focus: [eye[0], eye[2]], signal: options.signal })) {
      if (this.#disposed) return;
      const dx = Math.max(0, Math.abs(tile.origin[0] + tile.size / 2 - eye[0]) - tile.size / 2),
        dz = Math.max(0, Math.abs(tile.origin[1] + tile.size / 2 - eye[2]) - tile.size / 2);
      if (Math.hypot(dx, dz) <= r) this.add(tile, Math.hypot(dx, dz));
      await new Promise((done) => setTimeout(done, 0));
    }
    // Free the slots of tiles now out of range.
    for (const key of [...this.#held.keys()]) {
      const [x, z] = key.split(',').map(Number),
        side = this.#placement.tileSize,
        cx = this.#options.bounds[0] + (x + 0.5) * side,
        cz = this.#options.bounds[1] + (z + 0.5) * side;
      if (Math.hypot(cx - eye[0], cz - eye[2]) > r + side) this.remove(key);
    }
  }

  /**
   * Puts one placed tile on the GPU (its objects by species, dead trees as snags, each species only within its draw
   * distance of the tile's nearest point, `distance`) and, within 300 m or a tile beyond the detail radius, its detail
   * densities.
   */
  add(tile: PlacedTile, distance = 0): void {
    const key = `${tile.x},${tile.z}`,
      bySpecies = new Map<number, number[]>(),
      dead: number[] = [];
    if (tile.groups) {
      for (const step of this.steps(tile, distance)) step();
      return;
    }
    for (let k = 0; k < tile.count; k++) {
      const age = tile.instances[k * 8 + 7] >> 4;
      if (age >= 2) dead.push(k);
      else {
        const s = tile.instances[k * 8 + 4];
        let list = bySpecies.get(s);
        if (!list) bySpecies.set(s, (list = []));
        list.push(k);
      }
    }
    const gather = (list: number[]) => {
      const out = new Uint8Array(list.length * 8);
      list.forEach((k, i) => out.set(tile.instances.subarray(k * 8, k * 8 + 8), i * 8));
      return out;
    };
    this.remove(key);
    const feet: number[] = [];
    const put = (entry: SpeciesEntry | undefined, list: number[]) => {
      if (!entry || distance > entry.radius) return;
      // The first part of each form holds its records; the others share them.
      for (const [f, records] of splitForms(gather(list), entry.heads.length).entries()) {
        const held = this.#cap(records, entry.heads[f].slotSize);
        entry.heads[f].setTile(key, tile.origin, tile.size, held);
        this.#press(feet, tile, held, entry.feet[f]);
      }
    };
    for (const [s, list] of bySpecies) put(this.#species.get(tile.species[s]), list);
    put(this.#snags, dead);
    this.#options.ground?.set(key, feet);
    this.#held.set(key, tile.count);
    if (distance <= this.#detailReach) for (const d of tile.density) this.#density(tile, d);
  }

  /** Adds the footprints of one form's records to `out`: each record's place, and its scale times the form's radius. */
  #press(out: number[], tile: PlacedTile, records: Uint8Array, foot: Foot | undefined): void {
    if (!foot || !this.#options.ground) return;
    const side = tile.size / 65536; // float division: metres per record unit
    for (let at = 0; at < records.length; at += 8) {
      const x = tile.origin[0] + (records[at] | (records[at + 1] << 8)) * side,
        z = tile.origin[1] + (records[at + 2] | (records[at + 3] << 8)) * side;
      out.push(x, z, Math.min(100, foot.radius * 2 ** ((records[at + 5] - 128) / 32)), foot.kind); // float: view only
    }
  }

  /** A tile denser than its slot keeps the first records (recorded in `dropped`). */
  #cap(records: Uint8Array, slotSize: number): Uint8Array {
    const n = records.length >> 3;
    if (n <= slotSize) return records;
    this.dropped += n - slotSize;
    return records.subarray(0, slotSize * 8);
  }

  /** Tiles within this distance of the camera write their detail densities (detail is drawn much closer). */
  get #detailReach(): number {
    return Math.max(Math.min(this.#options.radius, 300), this.#options.detailRadius + this.#placement.tileSize);
  }

  /**
   * The work of `add` as small steps (one species' records, one detail map, each well under a tenth of a millisecond),
   * for a caller that spreads a tile over frames: run them in order. Each species is replaced in one step, so the
   * tile's old objects stay drawn until their new ones are in. Detail densities are written for tiles within 300 m
   * (or a tile beyond the detail radius); add the tile again when it comes closer.
   */
  steps(tile: PlacedTile, distance = 0): (() => void)[] {
    if (!tile.groups) return [() => this.add(tile, distance)];
    const key = `${tile.x},${tile.z}`,
      records = new Map<ScatterTiles, Uint8Array>(),
      pressed: [Uint8Array, Foot | undefined][] = [],
      out: (() => void)[] = [];
    for (const g of tile.groups) {
      const entry = g.dead ? this.#snags : this.#species.get(tile.species[g.species]);
      if (!entry || distance > entry.radius) continue;
      for (const [f, list] of splitForms(g.records, entry.heads.length).entries()) {
        const held = this.#cap(list, entry.heads[f].slotSize);
        records.set(entry.heads[f], held);
        pressed.push([held, entry.feet[f]]);
      }
    }
    const held = this.#held.has(key);
    for (const entry of [...this.#species.values(), ...(this.#snags ? [this.#snags] : [])])
      for (const t of entry.heads) {
        const r = records.get(t);
        if (r) out.push(() => t.setTile(key, tile.origin, tile.size, r));
        else if (held) out.push(() => t.removeTile(key));
      }
    if (this.#options.ground)
      out.push(() => {
        const feet: number[] = [];
        for (const [list, foot] of pressed) this.#press(feet, tile, list, foot);
        this.#options.ground!.set(key, feet);
      });
    out.push(() => this.#held.set(key, tile.count));
    if (distance <= this.#detailReach) for (const d of tile.density) out.push(() => this.#density(tile, d));
    return out;
  }

  /** One detail density map of a tile into its world-wide texture (one texel every detailResolution metres). */
  #density(tile: PlacedTile, d: PlacedTile['density'][number]): void {
    const entry = this.#details.find((e) => e.id === d.id);
    if (!entry) return;
    const res = this.#options.detailResolution,
      [x0, z0, x1] = this.#options.bounds,
      width = Math.ceil((x1 - x0) / res), // float division: view only
      depth = entry.data.length / width, // float division: exact
      cells = Math.round(Math.sqrt(d.data.length)),
      step = tile.size / cells, // float division: metres per cell
      every = Math.max(1, Math.round(res / step)), // float division: view only
      n = Math.ceil(cells / every), // float division: view only
      us = new Int32Array(n),
      vs = new Int32Array(n);
    // The texel of every sampled column and row, once.
    for (let i = 0; i < n; i++) {
      us[i] = Math.floor((tile.origin[0] + i * every * step - x0) / res); // float division: view only
      vs[i] = Math.floor((tile.origin[1] + i * every * step - z0) / res); // float division: view only
    }
    const device = (this.#engine as unknown as { gpu?: GPUDevice }).gpu,
      s = d.sampled;
    if (
      s?.every === every &&
      us[0] >= 0 &&
      vs[0] >= 0 &&
      us[n - 1] === us[0] + n - 1 &&
      vs[n - 1] === vs[0] + n - 1 &&
      us[n - 1] < width &&
      vs[n - 1] < depth
    ) {
      // Sampled by the worker for this texel grid and inside the texture: rows in, and the upload straight from it.
      for (let j = 0; j < n; j++) entry.data.set(s.data.subarray(j * n, (j + 1) * n), (vs[0] + j) * width + us[0]);
      if (entry.texture && device && entry.device === device)
        device.queue.writeTexture(
          { texture: entry.texture, origin: [us[0], vs[0]] },
          s.data as Uint8Array<ArrayBuffer>,
          { bytesPerRow: n },
          [n, n],
        );
      return;
    }
    let u0 = Infinity,
      u1 = -1,
      v0 = Infinity,
      v1 = -1;
    for (let j = 0; j < n; j++) {
      const v = vs[j];
      if (v < 0 || v >= depth) continue;
      for (let i = 0; i < n; i++) {
        const u = us[i];
        if (u < 0 || u >= width) continue;
        entry.data[v * width + u] = d.data[j * every * cells + i * every];
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
      }
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    // Upload the texels the tile covers from a compact copy (the texture is made on the first frame that reads it).
    if (!entry.texture || !device || entry.device !== device || u1 < u0 || v1 < v0) return;
    const w = u1 - u0 + 1,
      h = v1 - v0 + 1,
      block = new Uint8Array(w * h);
    for (let v = 0; v < h; v++) block.set(entry.data.subarray((v0 + v) * width + u0, (v0 + v) * width + u0 + w), v * w);
    device.queue.writeTexture({ texture: entry.texture, origin: [u0, v0] }, block, { bytesPerRow: w }, [w, h]);
  }

  /** Takes one tile's objects off the GPU, also those of a tile whose `steps` only ran in part. */
  remove(key: string): void {
    this.#held.delete(key);
    this.#options.ground?.remove(key);
    for (const entry of [...this.#species.values(), ...(this.#snags ? [this.#snags] : [])])
      for (const t of entry.heads) t.removeTile(key);
  }

  /** Frees every scatter and texture. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#release();
    this.#capture = undefined;
    this.#offSeasons?.();
    this.#far?.dispose();
    // Sharing parts first, then the part whose buffers they read.
    for (const entry of [...this.#species.values(), ...(this.#snags ? [this.#snags] : [])])
      for (const t of [...entry.tiles].reverse()) t.dispose();
    for (const d of this.#details) {
      d.scatter.dispose();
      d.near?.dispose();
      d.texture?.destroy();
    }
    this.#cover?.dispose();
    const listeners = [...this.#disposers];
    this.#disposers.clear();
    for (const listener of listeners) listener();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
