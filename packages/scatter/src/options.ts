import type { Geometry, PbrMaterial } from '@margoengine/core';
import type { GroundBounds, GroundPath } from './placement.js';
import type { ScatterBase, ScatterSkyOcclusion } from './contact.js';
import type { ScatterSway, ScatterWind } from './wind.js';
import type { ScatterTextures } from './maps.js';
/**
 * What `Scatter.velocityParts` hands `@margoengine/scatter/velocity`: this frame's culled instances and how each LOD ring
 * is drawn. Internal plumbing between the two entries; its shape may change with the package.
 */
export interface ScatterVelocityParts {
  /** The frame values: camera 0-15, eye 16-18, wind 68-71, ground fit 72-75, blades 76-79, pixel footprint 80, sway 84-87. */
  readonly values: Float32Array;
  /**
   * The wind (frame values 68-71: direction, strength, wind clock) of the last frame drawn with an earlier wind clock;
   * the last frame's own on the first frame and after `resetTime`. `@margoengine/scatter/read` poses the shutter's open with it.
   */
  readonly windBefore: Float32Array;
  /** The sway (frame values 84-87: plant top, reach, calm clock, wind clock rate) of the same frame as `windBefore`. */
  readonly swayBefore: Float32Array;
  /** The unpatched WGSL pose functions (`windShader` and `poseShader`), which `pose` patches into a posing stage. */
  readonly poseSource: string;
  readonly instances: readonly GPUBuffer[];
  readonly commands: GPUBuffer;
  readonly vertices: readonly GPUBuffer[];
  readonly indices: readonly GPUBuffer[];
  /** Index counts per ring, for the route's direct draws. */
  readonly counts: readonly number[];
  /** Vertex stride in bytes (32 with texture uvs). */
  readonly stride: number;
  /** How the colour pass draws each ring; undefined for a ring it does not draw. */
  readonly stages: readonly ('opaque' | 'cover' | 'split' | undefined)[];
  /** Applies the scatter's pose patches (grass blades, plant states) to a vertex stage, its extra bindings from `binding`. */
  pose(code: string, binding: number): string;
  entries(): { buffer: GPUBuffer }[];
  /** The WebGL2 layer's route: a counted vertex stage with each ring's count at binding 2, drawn `capacity` times. */
  readonly route?: { vertex(code: string): string; count(ring: number): GPUBufferBinding; capacity: number };
  /** Each ring's mesh, near to far. */
  readonly geometries: readonly Geometry[];
  /** The frame cull's own rings and commands before any occlusion pass, readable (COPY_SRC): `@margoengine/scatter/read`. */
  readonly cull: { readonly instances: readonly GPUBuffer[]; readonly commands: GPUBuffer };
}
/** Grass-blade shading for GPU `Scatter` (see `ScatterOptions.blades`). */
export interface ScatterBlades {
  /** Albedo lost at the root, 0-1 (default 0.5): blades darken linearly from the tip (1) to the root (1 - rootShade). */
  rootShade?: number;
  /**
   * Extra blade width at the last LOD distance as a fraction, 0-10 (default 1: twice as wide), growing linearly with
   * distance from 0 at the camera. Thin distant blades otherwise fall below a pixel and shimmer.
   */
  widen?: number;
  /**
   * Sunlight seen through the blades, 0-1 (default 0): wrapped back-light translucency (Barre-Brisebois and Bouchard,
   * GDC 2011), as `ScatterInstances` foliage takes it. Blades glow against a low sun, so a field reads as thin leaves
   * instead of flat card. 1 matches the albedo's front-lit diffuse. 0 leaves the shader as it was.
   */
  translucency?: number;
}
/**
 * Colour spread for lit GPU `Scatter` and `ScatterTiles` (see `ScatterOptions.variation`). Each instance draws its two
 * random numbers from a hash of its world position, so its tint stays put across frames, culling and LOD rings.
 */
export interface ScatterVariation {
  /** Largest hue turn either way around the grey axis, as a fraction of the colour wheel, 0-0.5 (default 0). */
  hue?: number;
  /** Largest brightness change either way, 0-1 (default 0): the albedo scales by a factor from 1 - value to 1 + value. */
  value?: number;
}
/** GPU scatter rules, fixed at construction (out of range throws RangeError). Distances are world units. */
/**
 * Patches of instances (`ScatterOptions.clumps`): plants of one kind grow in drifts, not evenly. A smoothed value noise
 * of the world position (two octaves) is cut at `cover`, and each instance is kept with the chance its place is inside
 * a patch, over a soft rim `edge` wide, so patches have ragged edges and thin out instead of stopping at a line.
 */
export interface ScatterClumps {
  /** Patch size in world units: the wavelength of the noise, above 0. */
  readonly size: number;
  /** Threshold of the patch noise, 0 to 1: 0 keeps nothing and 1 everything; 0.5 covers about half the ground. */
  readonly cover: number;
  /** Width of the soft rim in noise units, 0.001 to 1 (default 0.2). */
  readonly edge?: number;
}
/**
 * Ground around a placed object where instances thin out (`ScatterOptions.clearings`): none root within `radius` of
 * `center`, and over the next `falloff` the chance of keeping one rises smoothly to 1. Grass thins around a boulder this
 * way, where the stone sheds water past its base and shades it.
 */
export interface ScatterClearing {
  /** World XZ centre. */
  readonly center: readonly [x: number, z: number];
  /** Bare radius, 0 or more. */
  readonly radius: number;
  /** Width of the thinning ring past `radius`, 0 or more (default 0: a hard edge). */
  readonly falloff?: number;
  /**
   * Keep instances inside instead (default false): all of them within `radius`, thinning to none over `falloff`, such
   * as moss gathered at a boulder's base. Each clearing's chance multiplies, so give a scatter one inside circle.
   */
  readonly inside?: boolean;
}
/**
 * Options of `Scatter` and `Scatter.attach`: how many candidates, where and how densely they stand, which rules thin
 * them, and how each LOD ring looks. Every option has a default.
 */
export interface ScatterOptions {
  /** Candidate instances on a stratified grid, an integer 1-1,000,000 (GPU memory: three buffers of this many). Default 10,000. */
  count?: number;
  /** XZ extent covered around `center`, each 0-100,000 (exclusive of 0). Default [50, 50]. */
  area?: readonly [number, number];
  /** World centre of the area; its Y is added to the heightmap. Default [0, 0, 0]. */
  center?: readonly [number, number, number];
  /** Fraction of candidates kept, 0..1. Default 1. */
  density?: number;
  /** Lowest world height that gets instances. Default -10,000. */
  minHeight?: number;
  /** Highest world height that gets instances, >= `minHeight`. Default 10,000. */
  maxHeight?: number;
  /** Steepest ground slope that gets instances, degrees 0-90. Default 45. */
  maxSlope?: number;
  /** Random uniform scale range [min, max], 0 < min <= max <= 100. Default [0.7, 1.3]. */
  scale?: readonly [number, number];
  /** Positive normal f32 distances, strictly increasing after upload; the third is the culling distance. Default [25, 60, 120]. */
  lod?: readonly [number, number, number];
  /**
   * Width of the dithered cross-fade between LOD meshes, in world units (default 2). 0 switches hard and compiles the
   * shaders without the fade's `discard`, which keeps early depth rejection on tile-based phone GPUs; one shared
   * Geometry for all rings does the same. The phone quality tier sets 0 when the app leaves it unset.
   */
  lodFade?: number;
  /**
   * Screen-space LOD (Luebke et al. 2003, ch. 4 screen-space error): the finest feature of the near and middle mesh at
   * scale 1, in world units (a leaf spray's width). With it, an object moves to the next ring once that feature, times
   * the object's scale, would project under `lodPixels` pixels through the camera's field of view and viewport height,
   * or at the `lod` distance, whichever comes first. Default none: rings by `lod` distance alone.
   */
  lodSize?: readonly [number, number];
  /** Pixels (of the viewport) a `lodSize` feature keeps before its ring hands over. Default 1. */
  lodPixels?: number;
  /** Placement seed, an integer 0..2^32-1. Default 1. */
  seed?: number;
  /** Diffuse colour (linear RGB 0..1) when no `material` is given. Default [0.12, 0.35, 0.08]. */
  color?: readonly [number, number, number];
  /** Shade instances with core's PBR shader (and receive PCSS shadows) instead of the simple diffuse colour. */
  material?: PbrMaterial;
  /**
   * Texture maps of the mesh (a scanned plant, bark or rock): base colour with an alpha cut-out (glTF MASK, also in the
   * shadow casters), a normal map and an occlusion-roughness-metal map, multiplied by `material` as glTF factors. See
   * {@link ScatterTextures}. Needs `material`. Default none: one material colour for the whole mesh. Cost: 8 more bytes
   * a vertex, three texture reads a pixel and, with a cut-out, a fragment stage in the shadow pass.
   */
  textures?: ScatterTextures;
  /** World XZ rectangles `[minX, minZ, maxX, maxZ]` kept free of instances (up to 1,000,000). */
  exclusions?: readonly GroundBounds[];
  /**
   * Circles around placed objects (boulders, trunks, posts) where instances thin out to none (see
   * {@link ScatterClearing}); up to 100,000. Fixed for the scatter's life. Default none.
   */
  clearings?: readonly ScatterClearing[];
  /**
   * One more test in the distribute pass, which may drop or shorten an instance by where it stands, read again every
   * frame: `clearingMap()` of `@margoengine/scatter/clearing-map` thins and shortens instances where a world map is
   * high, such as the ground contact around trunks and stones. Fixed for the scatter's life. Default none: the shader as
   * it was.
   */
  thinning?: ScatterThinningSource;
  /**
   * Gathers the instances into patches with soft, ragged edges (see {@link ScatterClumps}). Fixed for the scatter's
   * life; the patches follow `seed`, so scatters that share a seed share their patches. Default none: even cover.
   */
  clumps?: ScatterClumps;
  /**
   * The reach of an instance from its root per unit scale, in mesh units, for culling and exclusions (default: from the
   * meshes' bounding spheres); it must hold the meshes' farthest vertex from the root. Scatters that draw the parts of one plant with one seed (leaves, stem, flowers) take the
   * same reach (and the same `sway.height`) so the same instances survive and bend alike in each.
   */
  reach?: number;
  /**
   * Ground paths kept free of instances (a road, track or river bed): each instance's footprint stays more than
   * `width / 2` from the path's centreline. `roadPath` from `@margoengine/road` gives a road's. Up to 1,000,000
   * segments in all. Default none.
   */
  paths?: readonly GroundPath[];
  /**
   * Red-channel height texture covering `area` around `center` (r32float, r16float, rgba32float, rgba16float or
   * r8unorm), read every frame. Default: flat ground.
   */
  heightmap?: () => GPUTexture | undefined;
  /**
   * Rooted wind bend `[directionX, directionZ, strength]`, or `[directionX, directionZ, strength, speed]` with the mean
   * wind in m/s at 10 m, which makes the plants thrash faster in a storm (`windClockRate`; a weather drive writes it).
   * Omitted: static.
   */
  wind?: ScatterWind;
  /**
   * How the plants sway in the wind: `stiffness` 0.1 to 10 (default 1) divides the reach, the most a tall plant's top
   * moves at full wind strength (1.2 m at stiffness 1), and `height` is the plant's top in mesh units (default the
   * meshes' highest vertex). A plant's sway is bounded by min(0.354 H, reach) x strength, H its top times the instance's
   * scale, and a trunk sways at its own frequency (2.55 H^-0.59 Hz, `swayFrequency`) however hard the wind blows.
   */
  sway?: ScatterSway;
  /**
   * How far each instance's up axis tilts from world +Y toward the ground normal, 0-1 (default 0, upright). 1 lays
   * stones and debris along the slope; grass and trees usually stay upright.
   */
  alignToGround?: number;
  /**
   * Lowers each instance by `sink * scale * (1 + tan(slope))` world units (default 0), so roots and stone bases stay
   * buried on the downhill side of steeper ground. The heightmap gives the slope.
   */
  sink?: number;
  /**
   * The foot of each lit instance, where it meets the ground: the lowest `height` metres (at scale 1) above the ground
   * lose up to `shade` of the sky's light and turn toward `tint` (moss on stones, soil on trunks), with a ragged upper
   * edge. The ground line follows `sink` and the slope. Default none: the shader as it was. Fixed at construction.
   */
  base?: ScatterBase;
  /**
   * Sky light lit instances lose lower down, as under a closed canopy: exp(-depth * (1 - h / height)) of it is kept at
   * height h above the ground (Beer-Lambert light in a canopy, Monsi and Saeki 1953). The sun's beam is untouched;
   * shadows give that. Default none: the shader as it was. Fixed at construction.
   */
  skyOcclusion?: ScatterSkyOcclusion;
  /**
   * World units before the last LOD distance over which instances scale down to zero (default 0: cut at that
   * distance). Shrinking instead of cutting keeps the edge of a grass field from popping, without a fragment
   * `discard`; widths past the last distance are clamped to it.
   */
  edgeShrink?: number;
  /**
   * World units from the camera within which nothing is drawn (default 0: off), so another layer can take over nearby,
   * such as stored objects in front of far stand-ins. Instances keep their places and random numbers: those beyond
   * `inner + innerFade` are the same as without it. Measured in 3D, like the LOD distances; must be below the last one.
   */
  inner?: number;
  /**
   * World units past `inner` over which instances appear one by one instead of all at `inner` (default 0: a sharp
   * circle). Each instance takes its own start from a hash, so the band thins toward the camera and nothing changes size.
   */
  innerFade?: number;
  /**
   * World units before the last LOD distance over which instances drop out one by one instead of all at that distance
   * (default 0: off). Each instance takes its own drop distance from a hash, so the count falls linearly to none at the
   * last distance while every survivor keeps its size, place and random numbers (the thinning of stochastic
   * simplification, Cook, Halstead, Planck and Ryu 2007). A dense near layer laid over a sparser far one with this set
   * hands over to it as a smooth fall in density, with no line where the near layer ends. Measured in 3D, like the LOD
   * distances; at most the last one.
   */
  edgeThin?: number;
  /**
   * Shades instances as grass blades: upright geometry whose local origin is the root and whose tallest vertex is the
   * tip (default off). Albedo darkens toward the root; the shading normal blends from the ground normal at the root to
   * the blade's own normal at the tip, and fully to the ground normal by the last LOD distance, so a field shades like
   * the terrain under it instead of speckling (after Wohllaib, GDC 2021); distant blades widen. `{}` uses the defaults.
   */
  blades?: ScatterBlades;
  /**
   * World rectangle `[minX, minZ, maxX, maxZ]` that `heightmap` and `densityMap` cover, instead of `area` around
   * `center` (default: none, the textures cover `area`). Needed with `follow`, whose area moves.
   */
  bounds?: readonly [number, number, number, number];
  /**
   * Red-channel density texture (0..1) over `bounds` that multiplies `density` per instance, such as a biome detail
   * map (default: none). Instances outside `bounds` are dropped.
   */
  densityMap?: () => GPUTexture | undefined;
  /**
   * Keeps the grid around the camera: `center` moves in whole grid cells every frame, and each instance's random
   * numbers come from its world cell, so instances stay where they are as the camera moves (default off). Needs
   * `bounds` when a `heightmap` or `densityMap` is given.
   */
  follow?: boolean;
  /**
   * Tints each instance from a hash of its world position (default none: every instance takes the material colour):
   * a hue turn of up to `hue` and a brightness change of up to `value` either way, so a forest of one mesh does not
   * read as one colour. Needs `material`. Cost: a few vertex operations; no extra binding.
   */
  variation?: ScatterVariation;
  /**
   * Cell size in mesh units for leaf-cluster shading (default 0: off). The mesh is cut into cubic cells; each vertex
   * is lightened or darkened by up to `variation.value` from a hash of its cell and its instance, and its normal bends
   * away from its cell's centre, so a canopy shades as clumps instead of one smooth blob. Needs `material`. Cost:
   * about ten vertex operations; the shadow pass is unchanged.
   */
  clusters?: number;
  /**
   * Per-instance plant states (default none): a source from `@margoengine/scatter/states` (`PlantStates.plant()`)
   * that scorches, chars, strips, mud-coats, stains and flattens each instance from the state map at its root, in the
   * colour and shadow passes alike. Colour treatments need `material`; the shape treatments work on any Scatter.
   */
  states?: ScatterStateSource;
}
/**
 * What `ScatterOptions.states` takes: code for every posing vertex stage reading `entries()` from `binding` on in bind
 * group `group`, and an update recorded once a frame before the distribute pass. Made by `PlantStates.plant()`.
 */
export interface ScatterStateSource {
  poseCode(code: string, group: number, binding: number): string;
  entries(device: GPUDevice): { buffer: GPUBuffer }[];
  update(context: { device: GPUDevice; encoder: GPUCommandEncoder }): void;
}
/** What `ScatterOptions.thinning` takes. Made by `clearingMap()` of `@margoengine/scatter/clearing-map`. */
export interface ScatterThinningSource {
  /**
   * The distribute shader with the source's declarations (bindings 12 and up) and test; `key` is the variable that
   * keys an instance's random numbers.
   */
  cullCode(code: string, key: 'i' | 'key'): string;
  /**
   * The entries of those bindings, written for this frame. The same array while its resources are the same ones, so the
   * bind group is made again only when they change.
   */
  entries(device: GPUDevice): GPUBindGroupEntry[];
}
