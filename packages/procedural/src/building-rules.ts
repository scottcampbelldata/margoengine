// Building rules: a rectangular house, shop, block, depot or shed made by splitting a footprint into storeys, sides
// into bays and bays into wall, window and door tiles, then putting a roof on it. Hip, gable, hip-and-gable (irimoya),
// shed and flat roofs; false fronts, parapets, cornices and floor bands; eaves, gutters and downspouts; window reveals
// through a wall of real thickness, frames, sills and casings; doors, porches, balconies, awnings and chimneys; roof
// courses of tile, shingle or standing seam metal. Style sets give a 2011 Japanese coastal town (wooden houses, concrete
// public buildings, fish market sheds) and a 1910 western town (frame houses, false-front shops, brick blocks, a rail
// depot); `townBuildings` turns the lots of a settlement layout into one building each. Local origin on the ground at
// the middle of the footprint, front on +z, +y up, metres. Seeded and deterministic. Our own code, clean room from:
// - Wonka, Wimmer, Sillion and Ribarsky 2003, "Instant Architecture", ACM TOG 22(3) (SIGGRAPH),
//   https://doi.org/10.1145/882262.882324: split grammars that divide a facade into floors and tiles.
// - Mueller, Wonka, Haegler, Ulmer and Van Gool 2006, "Procedural Modeling of Buildings", ACM TOG 25(3) (SIGGRAPH),
//   https://doi.org/10.1145/1141911.1141931: CGA shape, mass -> component split (facades, roof) -> floors -> repeated
//   tiles -> window, door and wall, with occlusion queries replaced here by the fixed rectangular plan.
// - Aichholzer, Aurenhammer, Alberts and Gaertner 1995, "A Novel Type of Skeleton for Polygons", J. UCS 1(12),
//   https://doi.org/10.3217/jucs-001-12-0752: the straight skeleton; on a rectangle it gives the hip roof's ridge of
//   length L - d and its four hips at the roof pitch, which we write out in closed form.
// - Kelly and Wonka 2011, "Interactive Architectural Modeling with Procedural Extrusions", ACM TOG 30(2),
//   https://doi.org/10.1145/1944846.1944854: roofs as sloped extrusions of the footprint edges (gable = a vertical
//   edge, hip = a sloped edge, the hip-and-gable switching from sloped to vertical at a height).
// - Parish and Mueller 2001, "Procedural Modeling of Cities", SIGGRAPH, https://doi.org/10.1145/383259.383292: one
//   building to a lot, facing its street.
// Measured sizes, each pinned by packages/procedural/test/building-rules.test.js:
// - Japan, Building Standard Law Enforcement Order (Kenchiku Kijun Ho Shiko Rei): art. 21, a living room's ceiling at
//   least 2.1 m; art. 22, a wooden ground floor at least 45 cm above the ground; art. 126, a balcony's railing at least
//   1.1 m high. JIS A 5208 (clay roof tiles): the J-shape 53A tile covers about 265 by 235 mm; Japanese tile roofs are
//   laid at 4 sun (4 in 10, 21.8 degrees) or steeper. The 910 mm module (one shaku-ken half) for plan and bay sizes.
// - US: International Code Council 2021, International Residential Code, R311.7.5 (a riser at most 7 3/4 in, a tread
//   at least 10 in) and R1003.9 (a chimney 3 ft above where it leaves the roof and 2 ft above any roof within 10 ft);
//   1910 frame houses with 8 1/2 to 9 ft ceilings and roofs of 6 in 12 to 12 in 12, commercial ground floors of 12 to
//   15 ft, as recorded by the US National Park Service, Preservation Brief 11 (storefronts) and the Sanborn fire
//   insurance maps' storey and material notes.
import type { GeometryData } from '@margoengine/geometry/utils';
import { MeshBuilder, add, clip, cross, dot, lerp, random, scale, sub, unit, type V3 } from './mesh-builder.js';

/** The style sets. Each is a full set of defaults; any option given overrides it. */
export type BuildingStyle =
  | 'japan-2011-house'
  | 'japan-2011-concrete'
  | 'japan-2011-warehouse'
  | 'western-1910-house'
  | 'western-1910-false-front'
  | 'western-1910-brick'
  | 'western-1910-depot';
/** Every style, in the order of the slider choice. */
export const BUILDING_STYLES: readonly BuildingStyle[] = [
  'japan-2011-house',
  'japan-2011-concrete',
  'japan-2011-warehouse',
  'western-1910-house',
  'western-1910-false-front',
  'western-1910-brick',
  'western-1910-depot',
];
/** `hip-gable` is the Japanese irimoya: hips below, a small gable above. */
export type BuildingRoof = 'flat' | 'gable' | 'hip' | 'hip-gable' | 'shed';
/** The roof covering, which sets its courses, ridge caps and thickness. */
export type BuildingRoofing = 'tile' | 'shingle' | 'metal' | 'membrane';
/** The outer wall finish: `clapboard` and `siding` get lap courses, `metal` gets corrugation, at `near` detail. */
export type BuildingCladding = 'clapboard' | 'siding' | 'brick' | 'concrete' | 'plaster' | 'metal';
/** `sliding` (two sashes side by side), `double-hung` (two sashes one over the other) or `strip` (wide bands). */
export type BuildingWindow = 'sliding' | 'double-hung' | 'strip';
/**
 * How much small geometry: `far` is walls, recessed glass and roof slabs; `mid` adds frames, sills, casings, roof
 * courses, ridge caps, railings and gutters; `near` adds tile rolls, standing seams, lap siding, muntins, door panels,
 * balusters and dentils.
 */
export type BuildingDetail = 'far' | 'mid' | 'near';
/** The ridge direction of a pitched roof (the high edge of a shed roof): `x` along the width, `z` front to back. */
export type BuildingRidge = 'auto' | 'x' | 'z';
/**
 * What is built behind the windows: `rooms` (partition walls with doorways and period furnishing blocks on every
 * floor), `cells` (one five-faced room cell behind each window: the cell interior mapping traces, built as geometry)
 * or `none` (the inner wall faces and floor slabs only).
 */
export type BuildingInterior = 'rooms' | 'cells' | 'none';

/** Options for {@link generateBuilding}. Every option has a default from the style. */
export interface BuildingRuleOptions {
  /** The style set the defaults come from. Default `japan-2011-house`. */
  readonly style?: BuildingStyle;
  /** Footprint along local x (the front), metres, 3 to 120. */
  readonly width?: number;
  /** Footprint along local z (front to back), metres, 3 to 120. */
  readonly depth?: number;
  /** Floor to floor height of each storey from the ground floor up, 1 to 12 entries of 2.2 to 8 m. */
  readonly storeys?: readonly number[];
  /** Height of the ground floor above the ground, metres, 0 to 2. */
  readonly plinth?: number;
  /** Wall thickness, metres, 0.08 to 1. */
  readonly wall?: number;
  readonly roof?: BuildingRoof;
  /** Roof pitch, degrees, 2 to 60 (ignored for flat roofs). */
  readonly pitch?: number;
  /** Ridge direction; `auto` runs it along the longer side. */
  readonly ridge?: BuildingRidge;
  /** Hip-and-gable only: how far the gable sits in from the end walls, as a share of half the depth, 0.1 to 0.9. */
  readonly gableInset?: number;
  /** Eaves and verge overhang past the walls, metres, 0 to 3 (flat roofs: past the walls when there is no parapet). */
  readonly overhang?: number;
  readonly roofing?: BuildingRoofing;
  /** Flat roofs: parapet height over the roof, metres, 0 to 3. */
  readonly parapet?: number;
  /** A false front over the front wall, metres over the eaves (0 for none), 0 to 8; it always clears the roof. */
  readonly falseFront?: number;
  /** `square` or `stepped` (a raised middle). */
  readonly falseFrontShape?: 'square' | 'stepped';
  readonly cladding?: BuildingCladding;
  /** Target bay width along each side, metres, 1 to 12; each side holds a whole number of equal bays. */
  readonly bayWidth?: number;
  /** Window width and height, metres, each 0.3 to 6 (strip windows: the height; their width fills the bay). */
  readonly window?: readonly [number, number];
  /** Window sill height above its floor, metres, 0 to 3. */
  readonly sill?: number;
  readonly windowKind?: BuildingWindow;
  /** Windows on the two end sides as well as the front and back. */
  readonly sideWindows?: boolean;
  /** Door width and height, metres, 0.6 to 8. */
  readonly door?: readonly [number, number];
  /** Front ground floor bays holding a door (0 is the left one seen from the street); -1 is the middle bay. */
  readonly doors?: readonly number[];
  /** Front ground floor of shop windows over a low bulkhead, with transoms. */
  readonly storefront?: boolean;
  /** A canvas awning over the storefront. */
  readonly awning?: boolean;
  /** Front porch depth, metres, 0 (none) to 5; a stoop with steps is built at each raised door without one. */
  readonly porch?: number;
  /** Porch width as a share of the front, 0.2 to 1. */
  readonly porchWidth?: number;
  /** Front balcony depth, metres, 0 (none) to 3. */
  readonly balcony?: number;
  /** Storey the balcony is on (1 is the second storey), 1 to 11. */
  readonly balconyFloor?: number;
  /** Balcony width as a share of the front, 0.2 to 1. */
  readonly balconyWidth?: number;
  readonly chimney?: boolean;
  /** Chimney position as shares of the half width and half depth, each -0.9 to 0.9. */
  readonly chimneyAt?: readonly [number, number];
  readonly gutters?: boolean;
  readonly cornerBoards?: boolean;
  /** Trim boards round windows and doors. */
  readonly casings?: boolean;
  /** A band at each upper floor line (slab edges, belt courses). */
  readonly bands?: boolean;
  /** A cornice at the wall top (flat roofs) or the false front's top. */
  readonly cornice?: boolean;
  /** Knee braces under the eaves. */
  readonly brackets?: boolean;
  /** Window reveal: how far glass and doors sit back from the wall face, metres, 0.02 to 0.5 (at most the wall). */
  readonly reveal?: number;
  /** Default `mid`. */
  readonly detail?: BuildingDetail;
  /** What is built behind the windows. Default `cells` at `far` detail, else `rooms`. */
  readonly interior?: BuildingInterior;
  /** Ground point under the middle of the footprint `[x, y, z]`. Default `[0, 0, 0]`. */
  readonly origin?: readonly [number, number, number];
  /** Turn about +y, radians; the front (+z) faces `[sin yaw, cos yaw]`. Default 0. */
  readonly yaw?: number;
  /** Integer seed for small differences (sash positions, which window sits open). Default 1. */
  readonly seed?: number;
}

/** A material hint for one part: linear albedo, roughness and metalness. */
export interface BuildingMaterial {
  readonly color: readonly [number, number, number];
  readonly roughness: number;
  readonly metalness: number;
}
/** The part names; a part missing from `parts` had nothing in it. */
export type BuildingPart =
  | 'walls'
  | 'interior'
  | 'furniture'
  | 'trim'
  | 'roof'
  | 'glass'
  | 'frames'
  | 'doors'
  | 'base'
  | 'porch'
  | 'awning'
  | 'chimney'
  | 'gutters';
/** An opening in a wall, in world space. */
export interface BuildingOpening {
  readonly kind: 'window' | 'door' | 'shop' | 'transom' | 'balcony-door';
  /** 0 front, 1 right, 2 back, 3 left, seen from outside. */
  readonly side: number;
  /** Storey index, 0 the ground floor. */
  readonly floor: number;
  /** Middle of the opening on the wall face, world `[x, y, z]`. */
  readonly centre: readonly [number, number, number];
  readonly width: number;
  readonly height: number;
}
/** A building from {@link generateBuilding}. */
export interface Building {
  readonly parts: Readonly<Partial<Record<BuildingPart, GeometryData>>>;
  /** A material for each part the style suggests. */
  readonly palette: Readonly<Record<BuildingPart, BuildingMaterial>>;
  /** The options after the style's defaults were applied. */
  readonly options: Readonly<Required<Omit<BuildingRuleOptions, 'origin'>>> & {
    readonly origin: readonly [number, number, number];
  };
  /** Each floor's level above the ground, metres (local, from the origin's y). */
  readonly floors: readonly number[];
  /** Wall top (eaves) above the ground, metres. */
  readonly eaves: number;
  /** Highest point of the roof, false front, parapet or chimney above the ground, metres. */
  readonly top: number;
  readonly openings: readonly BuildingOpening[];
  /** Footprint corners `[x, z]`, world, counter-clockwise from above. */
  readonly footprint: readonly (readonly [number, number])[];
  /** Roof covering height above the ground at local `[x, z]` (NaN off the roof). */
  roofHeight(x: number, z: number): number;
  /** Chimney top above the ground and its local `[x, z]`, when it has one. */
  readonly chimney?: { readonly top: number; readonly at: readonly [number, number] };
  /** Steps built: each flight's riser height and tread depth, metres. */
  readonly steps: readonly { readonly rise: number; readonly tread: number; readonly count: number }[];
  /** Railing heights built (porches and balconies), metres above their deck. */
  readonly railings: readonly number[];
  /** Rooms built (`interior: 'rooms'`), local metres, between the inner faces of walls and partitions. */
  readonly rooms: readonly BuildingRoom[];
  /** Furnishing blocks built, local metres. */
  readonly furniture: readonly BuildingFurniture[];
  /** Doorways through partition walls, local metres. */
  readonly doorways: readonly BuildingDoorway[];
}
/** A room: its storey, its floor rectangle (local `[x, z]`), floor level, clear height to the ceiling and area. */
export interface BuildingRoom {
  readonly floor: number;
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
  readonly level: number;
  readonly height: number;
  readonly area: number;
}
/** A furnishing block: an axis-aligned box in local metres. */
export interface BuildingFurniture {
  readonly kind: string;
  readonly floor: number;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}
/** A doorway in a partition: centre on the partition plane (local), clear width and height, and the axis it faces. */
export interface BuildingDoorway {
  readonly floor: number;
  readonly centre: readonly [number, number, number];
  readonly width: number;
  readonly height: number;
  readonly normal: 'x' | 'z';
}

type Resolved = Required<Omit<BuildingRuleOptions, 'origin'>> & { origin: readonly [number, number, number] };
type StyleSet = Omit<Resolved, 'style' | 'origin' | 'yaw' | 'seed' | 'detail' | 'interior'>;

const BASE: StyleSet = {
  width: 9.1,
  depth: 7.28,
  storeys: [2.9, 2.9],
  plinth: 0.5,
  wall: 0.15,
  roof: 'hip',
  pitch: 24.2,
  ridge: 'auto',
  gableInset: 0.5,
  overhang: 0.6,
  roofing: 'tile',
  parapet: 0,
  falseFront: 0,
  falseFrontShape: 'square',
  cladding: 'siding',
  bayWidth: 2.73,
  window: [1.69, 1.17],
  sill: 0.9,
  windowKind: 'sliding',
  sideWindows: true,
  door: [0.9, 2.1],
  doors: [-1],
  storefront: false,
  awning: false,
  porch: 0,
  porchWidth: 1,
  balcony: 0.91,
  balconyFloor: 1,
  balconyWidth: 0.6,
  chimney: false,
  chimneyAt: [0.4, 0],
  gutters: true,
  cornerBoards: false,
  casings: false,
  bands: false,
  cornice: false,
  brackets: false,
  reveal: 0.08,
};
/** The style sets' defaults (read only). */
export const BUILDING_STYLE_SETS: Readonly<Record<BuildingStyle, Readonly<StyleSet>>> = {
  // A two storey wooden house on the 910 mm module: 9.1 by 7.28 m (about 130 m2 over two floors), tiled hip roof at
  // 4.5 sun, ceramic siding, aluminium sliding windows, a second floor veranda, gutters.
  'japan-2011-house': BASE,
  // A four storey reinforced concrete public building: town hall, school or hospital wing.
  'japan-2011-concrete': {
    ...BASE,
    width: 30,
    depth: 14,
    storeys: [3.8, 3.6, 3.6, 3.6],
    plinth: 0.3,
    wall: 0.25,
    roof: 'flat',
    overhang: 0,
    roofing: 'membrane',
    parapet: 1.1,
    cladding: 'concrete',
    bayWidth: 6,
    window: [5.4, 1.6],
    windowKind: 'strip',
    door: [2.4, 2.5],
    balcony: 0,
    gutters: false,
    bands: true,
    reveal: 0.15,
  },
  // A fish market shed or harbour warehouse: one tall storey of steel frame, corrugated metal walls, a low metal roof,
  // two roller doors and a high band of windows.
  'japan-2011-warehouse': {
    ...BASE,
    width: 30,
    depth: 18,
    storeys: [6.5],
    plinth: 0.15,
    wall: 0.12,
    roof: 'gable',
    pitch: 15,
    overhang: 0.4,
    roofing: 'metal',
    cladding: 'metal',
    bayWidth: 6,
    window: [4.4, 1],
    sill: 4.4,
    windowKind: 'strip',
    door: [4.5, 4.6],
    doors: [1, 3],
    balcony: 0,
    reveal: 0.05,
  },
  // A front-gabled frame house: clapboard, corner boards and casings, a full width porch, double-hung sash, a brick
  // chimney, a cedar shingle roof at 10 in 12.
  'western-1910-house': {
    ...BASE,
    width: 7.3,
    depth: 9.8,
    storeys: [2.95, 2.8],
    plinth: 0.6,
    wall: 0.15,
    roof: 'gable',
    pitch: 39.8,
    ridge: 'z',
    overhang: 0.35,
    roofing: 'shingle',
    cladding: 'clapboard',
    bayWidth: 2.4,
    window: [0.81, 1.62],
    sill: 0.75,
    windowKind: 'double-hung',
    door: [0.91, 2.13],
    porch: 2.4,
    porchWidth: 1,
    balcony: 0,
    chimney: true,
    chimneyAt: [0.45, -0.3],
    gutters: false,
    cornerBoards: true,
    casings: true,
    reveal: 0.1,
  },
  // A two storey false-front store on a 25 ft lot: a square false front over a front-to-back gable, a storefront with
  // transoms and an awning, clapboard.
  'western-1910-false-front': {
    ...BASE,
    width: 7.6,
    depth: 18.3,
    storeys: [3.8, 3.1],
    plinth: 0.2,
    wall: 0.15,
    roof: 'gable',
    pitch: 26.6,
    ridge: 'z',
    overhang: 0.2,
    roofing: 'shingle',
    falseFront: 1.8,
    cladding: 'clapboard',
    bayWidth: 2.5,
    window: [0.81, 1.62],
    sill: 0.75,
    windowKind: 'double-hung',
    door: [1.05, 2.4],
    storefront: true,
    awning: true,
    balcony: 0,
    gutters: false,
    cornerBoards: true,
    casings: true,
    cornice: true,
    reveal: 0.1,
  },
  // A three storey brick commercial block: storefronts under tall double-hung windows, belt courses, a parapet with a
  // cornice, a flat roof.
  'western-1910-brick': {
    ...BASE,
    width: 15.2,
    depth: 24.4,
    storeys: [4.3, 3.7, 3.7],
    plinth: 0.15,
    wall: 0.33,
    roof: 'flat',
    overhang: 0,
    roofing: 'membrane',
    parapet: 1,
    cladding: 'brick',
    bayWidth: 2.5,
    window: [1, 2.1],
    sill: 0.8,
    windowKind: 'double-hung',
    door: [1.1, 2.6],
    storefront: true,
    awning: false,
    balcony: 0,
    gutters: false,
    bands: true,
    cornice: true,
    reveal: 0.2,
  },
  // A one storey rail depot: a long hip roof with deep bracketed eaves, clapboard, double-hung windows, two doors.
  'western-1910-depot': {
    ...BASE,
    width: 24,
    depth: 8,
    storeys: [4.2],
    plinth: 0.45,
    wall: 0.15,
    roof: 'hip',
    pitch: 30,
    overhang: 1.8,
    roofing: 'shingle',
    cladding: 'clapboard',
    bayWidth: 3,
    window: [0.9, 1.9],
    sill: 0.8,
    windowKind: 'double-hung',
    door: [1.2, 2.4],
    doors: [2, 5],
    balcony: 0,
    gutters: false,
    cornerBoards: true,
    casings: true,
    brackets: true,
    reveal: 0.1,
  },
};

const PALETTES: Record<
  'japan' | 'concrete' | 'warehouse' | 'frame' | 'brick',
  Record<BuildingPart, BuildingMaterial>
> = (() => {
  const m = (color: [number, number, number], roughness: number, metalness = 0): BuildingMaterial => ({
    color,
    roughness,
    metalness,
  });
  const common = {
    interior: m([0.55, 0.52, 0.47], 0.9),
    furniture: m([0.26, 0.17, 0.1], 0.55),
    glass: m([0.02, 0.025, 0.03], 0.05),
    base: m([0.32, 0.31, 0.29], 0.9),
    chimney: m([0.28, 0.1, 0.06], 0.9),
    gutters: m([0.2, 0.2, 0.2], 0.4, 0.8),
    awning: m([0.35, 0.07, 0.05], 0.85),
  };
  return {
    japan: {
      ...common,
      walls: m([0.56, 0.53, 0.47], 0.8),
      trim: m([0.6, 0.6, 0.58], 0.6),
      roof: m([0.05, 0.055, 0.06], 0.45),
      frames: m([0.55, 0.55, 0.55], 0.35, 0.9),
      doors: m([0.18, 0.12, 0.08], 0.6),
      porch: m([0.6, 0.6, 0.6], 0.4, 0.8),
    },
    concrete: {
      ...common,
      walls: m([0.5, 0.49, 0.46], 0.85),
      trim: m([0.55, 0.54, 0.51], 0.8),
      roof: m([0.25, 0.25, 0.24], 0.9),
      frames: m([0.6, 0.6, 0.6], 0.35, 0.9),
      doors: m([0.6, 0.6, 0.6], 0.35, 0.9),
      porch: m([0.5, 0.49, 0.46], 0.85),
    },
    warehouse: {
      ...common,
      walls: m([0.42, 0.45, 0.47], 0.5, 0.7),
      trim: m([0.3, 0.32, 0.33], 0.5, 0.7),
      roof: m([0.3, 0.33, 0.36], 0.45, 0.8),
      frames: m([0.45, 0.45, 0.45], 0.4, 0.9),
      doors: m([0.38, 0.4, 0.42], 0.5, 0.8),
      porch: m([0.3, 0.32, 0.33], 0.5, 0.7),
    },
    frame: {
      ...common,
      walls: m([0.7, 0.68, 0.62], 0.75),
      trim: m([0.75, 0.74, 0.7], 0.7),
      roof: m([0.2, 0.17, 0.14], 0.9),
      frames: m([0.75, 0.74, 0.7], 0.7),
      doors: m([0.22, 0.13, 0.07], 0.65),
      porch: m([0.45, 0.4, 0.33], 0.85),
    },
    brick: {
      ...common,
      walls: m([0.3, 0.11, 0.06], 0.9),
      trim: m([0.55, 0.5, 0.42], 0.85),
      roof: m([0.12, 0.12, 0.12], 0.9),
      frames: m([0.12, 0.1, 0.08], 0.7),
      doors: m([0.15, 0.09, 0.05], 0.65),
      porch: m([0.45, 0.4, 0.33], 0.85),
    },
  };
})();
const paletteOf = (style: BuildingStyle) =>
  style === 'japan-2011-house'
    ? PALETTES.japan
    : style === 'japan-2011-concrete'
      ? PALETTES.concrete
      : style === 'japan-2011-warehouse'
        ? PALETTES.warehouse
        : style === 'western-1910-brick'
          ? PALETTES.brick
          : PALETTES.frame;

// Roof courses: exposure (course height up the slope), lip height, roll height and tile width.
const ROOFING: Record<BuildingRoofing, { thickness: number; course: number; lip: number; roll: number; tile: number }> =
  {
    // JIS A 5208 J-shape 53A: about 265 mm wide by 235 mm exposed; the roll rises about 30 mm.
    tile: { thickness: 0.06, course: 0.235, lip: 0.04, roll: 0.03, tile: 0.265 },
    // Cedar shingles laid 5 in to the weather.
    shingle: { thickness: 0.05, course: 0.127, lip: 0.012, roll: 0, tile: 0 },
    // Standing seam: seams every 0.45 m.
    metal: { thickness: 0.04, course: 0, lip: 0, roll: 0, tile: 0.45 },
    membrane: { thickness: 0.25, course: 0, lip: 0, roll: 0, tile: 0 },
  };

function fail(name: string, want: string): never {
  throw new RangeError(`Invalid building ${name}; pass ${want}.`);
}
function num(o: Record<string, unknown>, name: string, lo: number, hi: number, fallback: number, int = false): number {
  const v = o[name];
  if (v === undefined) return fallback;
  if (typeof v !== 'number') throw new TypeError(`Invalid building ${name}; pass a number from ${lo} to ${hi}.`);
  if (!Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v)))
    fail(name, `${int ? 'an integer' : 'a number'} from ${lo} to ${hi}`);
  return v;
}
function bool(o: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const v = o[name];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new TypeError(`Invalid building ${name}; pass true or false.`);
  return v;
}
function pick<T extends string>(o: Record<string, unknown>, name: string, choices: readonly T[], fallback: T): T {
  const v = o[name];
  if (v === undefined) return fallback;
  if (!choices.includes(v as T)) fail(name, choices.map((c) => `'${c}'`).join(' or '));
  return v as T;
}
function tuple(
  o: Record<string, unknown>,
  name: string,
  n: number,
  lo: number,
  hi: number,
  fallback: readonly number[],
) {
  const v = o[name];
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === 'number' && x >= lo && x <= hi))
    fail(name, `${n} numbers from ${lo} to ${hi}`);
  return v as readonly number[];
}

/** Applies the style set and checks every option. */
export function resolveBuildingOptions(options: BuildingRuleOptions = {}): Resolved {
  if (typeof options !== 'object' || options === null) throw new TypeError('Invalid building options; pass an object.');
  const o = options as Record<string, unknown>,
    style = pick(o, 'style', BUILDING_STYLES, 'japan-2011-house'),
    s = BUILDING_STYLE_SETS[style];
  const storeys = o.storeys === undefined ? s.storeys : o.storeys;
  if (
    !Array.isArray(storeys) ||
    storeys.length < 1 ||
    storeys.length > 12 ||
    !storeys.every((h) => typeof h === 'number' && h >= 2.2 && h <= 8)
  )
    fail('storeys', '1 to 12 floor to floor heights of 2.2 to 8 m');
  const doors = o.doors === undefined ? s.doors : o.doors;
  if (!Array.isArray(doors) || doors.length > 16 || !doors.every((d) => Number.isInteger(d) && d >= -1 && d < 64))
    fail('doors', 'up to 16 bay indices (integers from -1 to 63)');
  const wall = num(o, 'wall', 0.08, 1, s.wall);
  const r: Resolved = {
    style,
    width: num(o, 'width', 3, 120, s.width),
    depth: num(o, 'depth', 3, 120, s.depth),
    storeys: [...storeys],
    plinth: num(o, 'plinth', 0, 2, s.plinth),
    wall,
    roof: pick(o, 'roof', ['flat', 'gable', 'hip', 'hip-gable', 'shed'], s.roof),
    pitch: num(o, 'pitch', 2, 60, s.pitch),
    ridge: pick(o, 'ridge', ['auto', 'x', 'z'], s.ridge),
    gableInset: num(o, 'gableInset', 0.1, 0.9, s.gableInset),
    overhang: num(o, 'overhang', 0, 3, s.overhang),
    roofing: pick(o, 'roofing', ['tile', 'shingle', 'metal', 'membrane'], s.roofing),
    parapet: num(o, 'parapet', 0, 3, s.parapet),
    falseFront: num(o, 'falseFront', 0, 8, s.falseFront),
    falseFrontShape: pick(o, 'falseFrontShape', ['square', 'stepped'], s.falseFrontShape),
    cladding: pick(o, 'cladding', ['clapboard', 'siding', 'brick', 'concrete', 'plaster', 'metal'], s.cladding),
    bayWidth: num(o, 'bayWidth', 1, 12, s.bayWidth),
    window: tuple(o, 'window', 2, 0.3, 6, s.window) as [number, number],
    sill: num(o, 'sill', 0, 3, s.sill),
    windowKind: pick(o, 'windowKind', ['sliding', 'double-hung', 'strip'], s.windowKind),
    sideWindows: bool(o, 'sideWindows', s.sideWindows),
    door: tuple(o, 'door', 2, 0.6, 8, s.door) as [number, number],
    doors: [...doors],
    storefront: bool(o, 'storefront', s.storefront),
    awning: bool(o, 'awning', s.awning),
    porch: num(o, 'porch', 0, 5, s.porch),
    porchWidth: num(o, 'porchWidth', 0.2, 1, s.porchWidth),
    balcony: num(o, 'balcony', 0, 3, s.balcony),
    balconyFloor: num(o, 'balconyFloor', 1, 11, s.balconyFloor, true),
    balconyWidth: num(o, 'balconyWidth', 0.2, 1, s.balconyWidth),
    chimney: bool(o, 'chimney', s.chimney),
    chimneyAt: tuple(o, 'chimneyAt', 2, -0.9, 0.9, s.chimneyAt) as [number, number],
    gutters: bool(o, 'gutters', s.gutters),
    cornerBoards: bool(o, 'cornerBoards', s.cornerBoards),
    casings: bool(o, 'casings', s.casings),
    bands: bool(o, 'bands', s.bands),
    cornice: bool(o, 'cornice', s.cornice),
    brackets: bool(o, 'brackets', s.brackets),
    reveal: Math.min(num(o, 'reveal', 0.02, 0.5, s.reveal), wall * 0.9),
    detail: pick(o, 'detail', ['far', 'mid', 'near'], 'mid'),
    interior: pick(o, 'interior', ['rooms', 'cells', 'none'], o.detail === 'far' ? 'cells' : 'rooms'),
    origin: tuple(o, 'origin', 3, -1e5, 1e5, [0, 0, 0]) as [number, number, number],
    yaw: num(o, 'yaw', -4 * Math.PI, 4 * Math.PI, 0),
    seed: num(o, 'seed', -0x80000000, 0xffffffff, 1, true),
  };
  return r;
}

interface Side {
  start: V3;
  dir: V3;
  out: V3;
  length: number;
}
interface Hole {
  kind: BuildingOpening['kind'];
  side: number;
  floor: number;
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}
const UP: V3 = [0, 1, 0];

/**
 * A building from the rules: a footprint split into storeys, each side split into bays and each bay into wall, window
 * and door, inside walls of real thickness, under a roof. The default is a 2011 Japanese two storey wooden house; pick
 * another `style` for the others, and override any option. Each part is its own mesh (see {@link BuildingPart}) with
 * UVs in metres for tiling textures and tangents; `palette` suggests a material for each.
 * @throws TypeError when an option has the wrong type; RangeError when it is out of range.
 */
export function generateBuilding(options: BuildingRuleOptions = {}): Building {
  const o = resolveBuildingOptions(options),
    rand = random(o.seed ^ 0x5bd1e995),
    near = o.detail === 'near',
    far = o.detail === 'far',
    W = o.width,
    D = o.depth,
    th = o.wall,
    rev = o.reveal;
  const parts: Record<BuildingPart, MeshBuilder> = {
    walls: new MeshBuilder(),
    interior: new MeshBuilder(),
    furniture: new MeshBuilder(),
    trim: new MeshBuilder(),
    roof: new MeshBuilder(),
    glass: new MeshBuilder(),
    frames: new MeshBuilder(),
    doors: new MeshBuilder(),
    base: new MeshBuilder(),
    porch: new MeshBuilder(),
    awning: new MeshBuilder(),
    chimney: new MeshBuilder(),
    gutters: new MeshBuilder(),
  };
  // Floors.
  const floors: number[] = [];
  let y = o.plinth;
  for (const h of o.storeys) {
    floors.push(y);
    y += h;
  }
  const eaves = y,
    flat = o.roof === 'flat',
    wallTop = flat ? eaves + o.parapet : eaves;
  const sides: Side[] = [
    { start: [-W / 2, 0, D / 2], dir: [1, 0, 0], out: [0, 0, 1], length: W },
    { start: [W / 2, 0, D / 2], dir: [0, 0, -1], out: [1, 0, 0], length: D },
    { start: [W / 2, 0, -D / 2], dir: [-1, 0, 0], out: [0, 0, -1], length: W },
    { start: [-W / 2, 0, -D / 2], dir: [0, 0, 1], out: [-1, 0, 0], length: D },
  ];
  const at = (s: Side, a: number, yy: number, off = 0): V3 =>
    add(add(s.start, scale(s.dir, a)), [s.out[0] * off, yy, s.out[2] * off]);

  // Openings: bays per side and floor.
  const holes: Hole[] = [];
  const balconyOn = o.balcony > 0 && o.balconyFloor < o.storeys.length;
  const balconySpan = (W * o.balconyWidth) / 2;
  for (let si = 0; si < 4; si++) {
    const s = sides[si],
      Ls = s.length,
      bays = Math.max(1, Math.round(Ls / o.bayWidth)),
      bw = Ls / bays,
      windows = si === 0 || si === 2 || o.sideWindows;
    const doorBays = new Set(o.doors.map((d) => (d < 0 ? Math.floor((bays - 1) / 2) : Math.min(d, bays - 1))));
    for (let k = 0; k < o.storeys.length; k++) {
      const fy = floors[k],
        h = o.storeys[k];
      for (let j = 0; j < bays; j++) {
        const c = bw * (j + 0.5);
        if (si === 0 && k === 0 && doorBays.has(j)) {
          const dw = Math.min(o.door[0], bw - 0.3),
            dh = Math.min(o.door[1], h - 0.25);
          holes.push({ kind: 'door', side: si, floor: k, a0: c - dw / 2, a1: c + dw / 2, y0: fy, y1: fy + dh });
          if (o.storefront && dh + 0.6 < h - 0.2)
            holes.push({
              kind: 'transom',
              side: si,
              floor: k,
              a0: c - dw / 2,
              a1: c + dw / 2,
              y0: fy + dh + 0.1,
              y1: fy + h - 0.6,
            });
          continue;
        }
        if (si === 0 && k === 0 && o.storefront) {
          const top = fy + h - 0.9,
            m = Math.min(0.25, bw * 0.1);
          holes.push({
            kind: 'shop',
            side: si,
            floor: k,
            a0: c - bw / 2 + m,
            a1: c + bw / 2 - m,
            y0: fy + 0.5,
            y1: top,
          });
          if (top + 0.15 < fy + h - 0.35)
            holes.push({
              kind: 'transom',
              side: si,
              floor: k,
              a0: c - bw / 2 + m,
              a1: c + bw / 2 - m,
              y0: top + 0.1,
              y1: fy + h - 0.35,
            });
          continue;
        }
        if (!windows) continue;
        // A balcony door (full height sash) where the balcony meets this bay.
        const wx = s.start[0] + s.dir[0] * c;
        if (
          si === 0 &&
          balconyOn &&
          k === o.balconyFloor &&
          Math.abs(wx) + Math.min(o.window[0], bw - 0.6) / 2 <= balconySpan
        ) {
          const ww = Math.min(o.window[0], bw - 0.6),
            wh = Math.min(2.03, h - 0.4);
          holes.push({
            kind: 'balcony-door',
            side: si,
            floor: k,
            a0: c - ww / 2,
            a1: c + ww / 2,
            y0: fy + 0.05,
            y1: fy + 0.05 + wh,
          });
          continue;
        }
        const ww = o.windowKind === 'strip' ? bw - 0.4 : Math.min(o.window[0], bw - 0.6),
          sill = Math.min(o.sill, h - 0.6),
          wh = Math.min(o.window[1], h - sill - 0.3);
        if (ww < 0.3 || wh < 0.3) continue;
        holes.push({
          kind: 'window',
          side: si,
          floor: k,
          a0: c - ww / 2,
          a1: c + ww / 2,
          y0: fy + sill,
          y1: fy + sill + wh,
        });
      }
    }
  }

  // Walls: the outer face, the inner face and the reveals, from a grid of breaks cut round the openings.
  const lap = near && (o.cladding === 'clapboard' || o.cladding === 'siding'),
    lapCourse = o.cladding === 'clapboard' ? 0.11 : 0.455,
    lapLip = o.cladding === 'clapboard' ? 0.014 : 0.006,
    corrugate = near && o.cladding === 'metal';
  for (let si = 0; si < 4; si++) {
    const s = sides[si],
      Ls = s.length,
      mine = holes.filter((h) => h.side === si),
      aBreak = [...new Set([0, Ls, ...mine.flatMap((h) => [h.a0, h.a1])])].sort((p, q) => p - q),
      yBreak = [...new Set([o.plinth, wallTop, ...mine.flatMap((h) => [h.y0, h.y1])])].sort((p, q) => p - q);
    const inside = (a: number, yy: number) => mine.some((h) => a > h.a0 && a < h.a1 && yy > h.y0 && yy < h.y1);
    for (let i = 0; i + 1 < aBreak.length; i++)
      for (let j = 0; j + 1 < yBreak.length; j++) {
        const a0 = aBreak[i],
          a1 = aBreak[i + 1],
          y0 = yBreak[j],
          y1 = yBreak[j + 1];
        if (a1 - a0 < 1e-6 || y1 - y0 < 1e-6 || inside((a0 + a1) / 2, (y0 + y1) / 2)) continue;
        if (lap) lapCells(parts.walls, s, at, a0, a1, y0, y1, o.plinth, lapCourse, lapLip);
        else if (corrugate) corrugatedCell(parts.walls, s, at, a0, a1, y0, y1);
        else parts.walls.poly([at(s, a0, y0), at(s, a1, y0), at(s, a1, y1), at(s, a0, y1)], s.out);
        const b0 = Math.max(a0, th),
          b1 = Math.min(a1, Ls - th);
        if (b1 - b0 > 1e-6)
          parts.interior.poly(
            [at(s, b0, y0, -th), at(s, b1, y0, -th), at(s, b1, y1, -th), at(s, b0, y1, -th)],
            scale(s.out, -1),
          );
      }
    // Reveals through the wall.
    for (const h of mine) {
      const L0 = at(s, h.a0, h.y0),
        L1 = at(s, h.a0, h.y1),
        R0 = at(s, h.a1, h.y0),
        R1 = at(s, h.a1, h.y1),
        back = (p: V3) => add(p, scale(s.out, -th));
      parts.walls.poly([L0, L1, back(L1), back(L0)], s.dir);
      parts.walls.poly([R0, R1, back(R1), back(R0)], scale(s.dir, -1));
      parts.walls.poly([L1, R1, back(R1), back(L1)], [0, -1, 0]);
      if (h.kind !== 'door') parts.walls.poly([L0, R0, back(R0), back(L0)], UP);
    }
    // The wall top: a cap where nothing sits on it (parapets get coping instead).
    if (!flat || o.parapet === 0) {
      const t = wallTop;
      parts.walls.poly([at(s, 0, t), at(s, Ls, t), at(s, Ls - th, t, -th), at(s, th, t, -th)], UP);
    }
  }
  // Openings: glass, frames, sills, casings and doors.
  const openings: BuildingOpening[] = [];
  for (const h of holes) {
    const s = sides[h.side],
      w = h.a1 - h.a0,
      hh = h.y1 - h.y0,
      mid = at(s, (h.a0 + h.a1) / 2, (h.y0 + h.y1) / 2);
    openings.push({ kind: h.kind, side: h.side, floor: h.floor, centre: mid, width: w, height: hh });
    const plane = (a: number, yy: number, off = -rev) => at(s, a, yy, off);
    if (h.kind === 'door') {
      buildDoor(parts, s, plane, h, near, far, o);
    } else {
      parts.glass.poly([plane(h.a0, h.y0), plane(h.a1, h.y0), plane(h.a1, h.y1), plane(h.a0, h.y1)], s.out);
      if (!far) buildFrame(parts.frames, s, plane, h, o.windowKind, near, rand, o.style.startsWith('japan'));
      if (!far && h.kind === 'window') {
        // Sill: a board under the glass that runs out past the wall face.
        const c = at(s, (h.a0 + h.a1) / 2, h.y0 - 0.025, (0.05 - rev) / 2);
        parts.trim.box(c, [w / 2 + 0.05, 0.025, (0.05 + rev) / 2], s.dir, UP, s.out);
      }
      if (h.kind === 'shop' && !far) {
        // Bulkhead panel under the shop window.
        const c = at(s, (h.a0 + h.a1) / 2, (floors[h.floor] + h.y0) / 2, 0.015);
        parts.trim.box(c, [w / 2, (h.y0 - floors[h.floor]) / 2 - 0.02, 0.015], s.dir, UP, s.out);
      }
    }
    if (o.casings && !far) casing(parts.trim, s, at, h);
    if (o.cladding === 'brick' && !far && (h.kind === 'window' || h.kind === 'balcony-door')) {
      // A stone lintel over the window and a stone sill under it.
      parts.trim.box(at(s, (h.a0 + h.a1) / 2, h.y1 + 0.12, 0.02), [w / 2 + 0.12, 0.12, 0.04], s.dir, UP, s.out);
      parts.trim.box(at(s, (h.a0 + h.a1) / 2, h.y0 - 0.05, 0.03), [w / 2 + 0.08, 0.05, 0.05], s.dir, UP, s.out);
    }
  }

  // Interior floors: one slab per storey (and a ceiling under a pitched roof).
  const levels = flat ? floors : [...floors, eaves];
  for (const fy of levels) parts.interior.box([0, fy - 0.1, 0], [W / 2 - th, 0.1, D / 2 - th]);
  if (flat) parts.roof.box([0, eaves - 0.1, 0], [W / 2 - th, 0.1, D / 2 - th]);
  const inside = buildInterior(parts, o, sides, holes, floors, eaves);
  // Base: the foundation from below the ground to the floor, slightly proud of the walls.
  parts.base.box([0, (o.plinth - 0.3) / 2, 0], [W / 2 + 0.02, (o.plinth + 0.3) / 2, D / 2 + 0.02]);

  // Roof.
  const roof = buildRoof(parts, o, eaves, near, far);
  // False front.
  let top = Math.max(wallTop, roof.top);
  if (o.falseFront > 0) {
    const s = sides[0],
      front = roof.frontTop,
      ft = Math.max(eaves + o.falseFront, front + 0.3),
      step = o.falseFrontShape === 'stepped' ? Math.min(0.9, (ft - eaves) * 0.4) : 0,
      low = ft - step,
      box = (a0: number, a1: number, y0: number, y1: number) =>
        parts.walls.slab([at(s, a0, y0), at(s, a1, y0), at(s, a1, y1), at(s, a0, y1)], th, s.out);
    box(0, s.length, eaves, low);
    if (step > 0) box(s.length * 0.2, s.length * 0.8, low, ft);
    if (o.cornice && !far) {
      const corn = (a0: number, a1: number, yy: number) => {
        parts.trim.box(
          at(s, (a0 + a1) / 2, yy - 0.18, 0.1),
          [(a1 - a0) / 2 + 0.1, 0.18, 0.1 + th / 2],
          s.dir,
          UP,
          s.out,
        );
        if (near) dentils(parts.trim, s, at, a0, a1, yy - 0.42);
      };
      corn(0, s.length, low);
      if (step > 0) corn(s.length * 0.2, s.length * 0.8, ft);
    }
    top = Math.max(top, ft);
  } else roof.frontFill();
  roof.otherFills();

  // Parapet coping and cornice, floor bands, corner boards.
  if (flat && o.parapet > 0 && !far)
    for (const s of sides)
      parts.trim.box(
        at(s, s.length / 2, wallTop + 0.04, -th / 2),
        [s.length / 2 + 0.03, 0.04, th / 2 + 0.03],
        s.dir,
        UP,
        s.out,
      );
  if (flat && o.cornice && !far)
    for (const s of sides) {
      const yy = eaves + Math.min(0.3, o.parapet * 0.3);
      parts.trim.box(at(s, s.length / 2, yy, 0.12), [s.length / 2 + 0.24, 0.22, 0.12], s.dir, UP, s.out);
      if (near) dentils(parts.trim, s, at, 0, s.length, yy - 0.3);
    }
  if (o.bands && !far)
    for (const s of sides)
      for (let k = 1; k < floors.length; k++)
        parts.trim.box(
          at(s, s.length / 2, floors[k] - 0.05, 0.03),
          [s.length / 2 + 0.03, 0.12, 0.03],
          s.dir,
          UP,
          s.out,
        );
  if (o.cornerBoards && !far)
    for (const s of sides)
      parts.trim.box(
        at(s, 0.05, (o.plinth + eaves) / 2, 0.012),
        [0.065, (eaves - o.plinth) / 2, 0.012],
        s.dir,
        UP,
        s.out,
      );

  // Porch, stoops, balcony, awning.
  const steps: { rise: number; tread: number; count: number }[] = [],
    railings: number[] = [];
  buildFrontage(parts, o, sides[0], holes, floors, eaves, near, far, steps, railings);
  // Chimney.
  let chimney: Building['chimney'];
  if (o.chimney && !flat) {
    const cx = (o.chimneyAt[0] * W) / 2,
      cz = (o.chimneyAt[1] * D) / 2,
      pass = roof.height(cx, cz);
    let nearby = pass;
    // Every roof point within 10 ft (3.048 m), on a 5 cm grid; the 4 cm spare over 2 ft covers the grid's step.
    for (let dx = -3.05; dx <= 3.05; dx += 0.05)
      for (let dz = -3.05; dz <= 3.05; dz += 0.05)
        if (dx * dx + dz * dz <= 3.05 * 3.05) {
          const r = roof.height(cx + dx, cz + dz);
          if (Number.isFinite(r)) nearby = Math.max(nearby, r);
        }
    const ct = Math.max(pass + 0.92, nearby + 0.65);
    parts.chimney.box([cx, (o.plinth + ct) / 2, cz], [0.3, (ct - o.plinth) / 2, 0.3]);
    if (!far) parts.chimney.box([cx, ct - 0.05, cz], [0.36, 0.05, 0.36]);
    chimney = { top: ct, at: [cx, cz] };
    top = Math.max(top, ct);
  }

  const origin = o.origin as V3,
    out: Partial<Record<BuildingPart, GeometryData>> = {};
  for (const [name, b] of Object.entries(parts) as [BuildingPart, MeshBuilder][])
    if (b.triangles > 0) out[name] = b.finish(origin, o.yaw);
  const c = Math.cos(o.yaw),
    sn = Math.sin(o.yaw),
    world = (x: number, z: number): [number, number] => [origin[0] + x * c + z * sn, origin[2] - x * sn + z * c];
  return {
    parts: out,
    palette: paletteOf(o.style),
    options: o,
    floors,
    eaves,
    top,
    openings: openings.map((p) => {
      const [x, z] = world(p.centre[0], p.centre[2]);
      return { ...p, centre: [x, origin[1] + p.centre[1], z] as const };
    }),
    footprint: [world(-W / 2, D / 2), world(W / 2, D / 2), world(W / 2, -D / 2), world(-W / 2, -D / 2)],
    roofHeight: roof.height,
    chimney,
    steps,
    railings,
    ...inside,
  };
}

type At = (s: Side, a: number, y: number, off?: number) => V3;

// Lap siding: sawtooth courses, each board's bottom edge proud of the one above.
function lapCells(
  m: MeshBuilder,
  s: Side,
  at: At,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  base: number,
  e: number,
  lip: number,
) {
  let k = Math.floor((y0 - base) / e);
  for (;;) {
    const c0 = base + k * e,
      c1 = c0 + e;
    if (c0 >= y1 - 1e-6) break;
    const lo = Math.max(c0, y0),
      hi = Math.min(c1, y1),
      off = (yy: number) => lip * (1 - (yy - c0) / e);
    if (hi - lo > 1e-6) {
      m.poly([at(s, a0, lo, off(lo)), at(s, a1, lo, off(lo)), at(s, a1, hi, off(hi)), at(s, a0, hi, off(hi))], s.out);
      if (Math.abs(lo - c0) < 1e-6)
        m.poly([at(s, a0, lo, 0), at(s, a1, lo, 0), at(s, a1, lo, lip), at(s, a0, lo, lip)], [0, -1, 0]);
    }
    k++;
  }
}
// Corrugated metal: a trapezoid profile every 76 mm, 18 mm deep.
function corrugatedCell(m: MeshBuilder, s: Side, at: At, a0: number, a1: number, y0: number, y1: number) {
  const pitch = 0.076,
    depth = 0.018;
  const q = pitch / 4;
  let k = Math.floor(a0 / q);
  const prof = (a: number) => {
    const f = (((a / pitch) % 1) + 1) % 1;
    return f < 0.25 ? 0 : f < 0.5 ? (depth * (f - 0.25)) / 0.25 : f < 0.75 ? depth : (depth * (1 - f)) / 0.25;
  };
  for (;;) {
    const c0 = Math.max(a0, k * q),
      c1 = Math.min(a1, (k + 1) * q);
    if (c0 >= a1 - 1e-6) break;
    if (c1 - c0 > 1e-6)
      m.poly(
        [at(s, c0, y0, prof(c0)), at(s, c1, y0, prof(c1)), at(s, c1, y1, prof(c1)), at(s, c0, y1, prof(c0))],
        s.out,
      );
    k++;
  }
}
function dentils(m: MeshBuilder, s: Side, at: At, a0: number, a1: number, yy: number) {
  for (let a = a0 + 0.1; a < a1 - 0.08; a += 0.2) m.box(at(s, a, yy, 0.06), [0.04, 0.06, 0.06], s.dir, UP, s.out);
}
function casing(m: MeshBuilder, s: Side, at: At, h: Hole) {
  const w = 0.1,
    p = 0.022,
    a = (h.a0 + h.a1) / 2,
    hw = (h.a1 - h.a0) / 2;
  m.box(at(s, h.a0 - w / 2, (h.y0 + h.y1) / 2, p / 2), [w / 2, (h.y1 - h.y0) / 2, p / 2], s.dir, UP, s.out);
  m.box(at(s, h.a1 + w / 2, (h.y0 + h.y1) / 2, p / 2), [w / 2, (h.y1 - h.y0) / 2, p / 2], s.dir, UP, s.out);
  m.box(at(s, a, h.y1 + 0.08, p / 2), [hw + w, 0.08, p / 2], s.dir, UP, s.out);
  m.box(at(s, a, h.y1 + 0.18, p), [hw + w + 0.03, 0.025, p], s.dir, UP, s.out);
}
function buildFrame(
  m: MeshBuilder,
  s: Side,
  plane: (a: number, y: number, off?: number) => V3,
  h: Hole,
  kind: BuildingWindow,
  near: boolean,
  rand: () => number,
  japan: boolean,
) {
  const f = japan ? 0.04 : 0.06,
    d = 0.05,
    c = (a: number, yy: number) => plane(a, yy, -0.0),
    aMid = (h.a0 + h.a1) / 2,
    yMid = (h.y0 + h.y1) / 2,
    beam = (a0: number, y0: number, a1: number, y1: number) => {
      const p0 = c(a0, y0),
        p1 = c(a1, y1);
      // Offset half the frame depth out from the glass so it reads round the pane.
      const off = scale(s.out, 0.005);
      m.box(
        add(lerp(p0, p1, 0.5), off),
        [Math.abs(a1 - a0) / 2 + f / 2, Math.abs(y1 - y0) / 2 + f / 2, d / 2],
        s.dir,
        UP,
        s.out,
      );
    };
  beam(h.a0 + f / 2, h.y0 + f / 2, h.a1 - f / 2, h.y0 + f / 2);
  beam(h.a0 + f / 2, h.y1 - f / 2, h.a1 - f / 2, h.y1 - f / 2);
  beam(h.a0 + f / 2, h.y0 + f / 2, h.a0 + f / 2, h.y1 - f / 2);
  beam(h.a1 - f / 2, h.y0 + f / 2, h.a1 - f / 2, h.y1 - f / 2);
  if (h.kind === 'shop' || h.kind === 'transom') {
    if (near && h.kind === 'transom') for (let a = h.a0 + 0.3; a < h.a1 - 0.15; a += 0.3) beam(a, h.y0, a, h.y1);
    return;
  }
  if (kind === 'double-hung') {
    // Meeting rail in the middle; at near detail the upper sash has two lights.
    beam(h.a0, yMid, h.a1, yMid);
    if (near) beam(aMid, yMid, aMid, h.y1);
  } else if (kind === 'sliding' || h.kind === 'balcony-door') {
    // Two sashes side by side, one slid a little open.
    const shift = (rand() - 0.5) * 0.1 * (h.a1 - h.a0);
    beam(aMid + shift, h.y0, aMid + shift, h.y1);
  } else if (kind === 'strip') {
    for (let a = h.a0 + 1.35; a < h.a1 - 0.3; a += 1.35) beam(a, h.y0, a, h.y1);
    if (near) beam(h.a0, h.y0 + (h.y1 - h.y0) * 0.7, h.a1, h.y0 + (h.y1 - h.y0) * 0.7);
  }
}
function buildDoor(
  parts: Record<BuildingPart, MeshBuilder>,
  s: Side,
  plane: (a: number, y: number, off?: number) => V3,
  h: Hole,
  near: boolean,
  far: boolean,
  o: Resolved,
) {
  const w = h.a1 - h.a0,
    hh = h.y1 - h.y0,
    leaf = 0.045,
    c = plane((h.a0 + h.a1) / 2, (h.y0 + h.y1) / 2, -o.reveal - leaf / 2),
    big = w > 2.2;
  if (o.storefront || o.style === 'japan-2011-concrete') {
    // A glazed door: a frame and a glass light.
    parts.glass.poly([plane(h.a0, h.y0 + 0.25), plane(h.a1, h.y0 + 0.25), plane(h.a1, h.y1), plane(h.a0, h.y1)], s.out);
    parts.doors.box(plane((h.a0 + h.a1) / 2, h.y0 + 0.125, -o.reveal), [w / 2, 0.125, leaf / 2], s.dir, UP, s.out);
    if (!far) buildFrame(parts.frames, s, plane, { ...h, kind: 'transom' }, 'sliding', near, () => 0.5, false);
    return;
  }
  parts.doors.box(c, [w / 2, hh / 2, leaf / 2], s.dir, UP, s.out);
  if (far) return;
  if (big) {
    // A roller door: horizontal slats.
    if (near)
      for (let yy = h.y0 + 0.1; yy < h.y1 - 0.05; yy += 0.1)
        parts.doors.box(plane((h.a0 + h.a1) / 2, yy, -o.reveal + 0.008), [w / 2, 0.012, 0.008], s.dir, UP, s.out);
    parts.trim.box(plane((h.a0 + h.a1) / 2, h.y1 + 0.2, 0.15), [w / 2 + 0.1, 0.2, 0.15], s.dir, UP, s.out);
    return;
  }
  // Door jamb trim inside the reveal and, at near detail, four raised panels.
  const f = 0.05;
  parts.frames.box(plane(h.a0 + f / 2, (h.y0 + h.y1) / 2, -o.reveal + 0.02), [f / 2, hh / 2, 0.03], s.dir, UP, s.out);
  parts.frames.box(plane(h.a1 - f / 2, (h.y0 + h.y1) / 2, -o.reveal + 0.02), [f / 2, hh / 2, 0.03], s.dir, UP, s.out);
  parts.frames.box(plane((h.a0 + h.a1) / 2, h.y1 - f / 2, -o.reveal + 0.02), [w / 2, f / 2, 0.03], s.dir, UP, s.out);
  if (near)
    for (const [fa, fy] of [
      [0.27, 0.28],
      [0.73, 0.28],
      [0.27, 0.7],
      [0.73, 0.7],
    ])
      parts.doors.box(
        plane(h.a0 + w * fa, h.y0 + hh * fy, -o.reveal + 0.006),
        [w * 0.17, hh * 0.15, 0.006],
        s.dir,
        UP,
        s.out,
      );
}

interface RoofResult {
  top: number;
  frontTop: number;
  height(x: number, z: number): number;
  frontFill(): void;
  otherFills(): void;
}
function buildRoof(
  parts: Record<BuildingPart, MeshBuilder>,
  o: Resolved,
  eaves: number,
  near: boolean,
  far: boolean,
): RoofResult {
  const W = o.width,
    D = o.depth,
    th = o.wall,
    spec = ROOFING[o.roofing];
  if (o.roof === 'flat') {
    // The slab sits at the eaves; with no parapet it overhangs as a canopy.
    const ov = o.parapet > 0 ? 0 : o.overhang,
      tt = spec.thickness;
    if (o.parapet === 0) parts.roof.box([0, eaves + tt / 2, 0], [W / 2 + ov, tt / 2, D / 2 + ov]);
    else parts.roof.box([0, eaves + 0.02, 0], [W / 2 - th, 0.02, D / 2 - th]);
    const h = eaves + (o.parapet === 0 ? tt : 0.04);
    return {
      top: h,
      frontTop: eaves + o.parapet,
      height: (x, z) => (Math.abs(x) <= W / 2 + ov && Math.abs(z) <= D / 2 + ov ? h : NaN),
      frontFill() {},
      otherFills() {},
    };
  }
  // Canonical frame: X along the ridge (length L), Z across it (depth d). `swap` maps it onto local x, z.
  const swap = o.roof === 'hip' || o.roof === 'hip-gable' ? W < D : o.ridge === 'auto' ? W < D : o.ridge === 'z';
  const L = swap ? D : W,
    d = swap ? W : D,
    map = (p: V3): V3 => (swap ? [p[2], p[1], p[0]] : p),
    unmap = (x: number, z: number): [number, number] => (swap ? [z, x] : [x, z]),
    t = Math.tan((o.pitch * Math.PI) / 180),
    ov = o.overhang,
    L2 = L / 2 + ov,
    d2 = d / 2 + ov,
    y0 = eaves - ov * t;
  const shed = o.roof === 'shed';
  const inset = o.roof === 'hip' ? d2 : o.roof === 'hip-gable' ? d2 * o.gableInset : 0,
    hInset = y0 + inset * t,
    H = y0 + d2 * t;
  const slopes: { poly: V3[]; toward: V3 }[] = [];
  if (shed) {
    // Rising toward +Z (local front when the ridge is along x).
    slopes.push({
      poly: [
        [-L2, y0, -d2],
        [L2, y0, -d2],
        [L2, y0 + 2 * d2 * t, d2],
        [-L2, y0 + 2 * d2 * t, d2],
      ],
      toward: [0, 1, -t],
    });
  } else {
    const i = inset;
    slopes.push({
      poly: [
        [-L2, y0, -d2],
        [L2, y0, -d2],
        [L2 - i, hInset, -d2 + i],
        [L2 - i, H, 0],
        [-L2 + i, H, 0],
        [-L2 + i, hInset, -d2 + i],
      ],
      toward: [0, 1, -t],
    });
    slopes.push({
      poly: [
        [L2, y0, d2],
        [-L2, y0, d2],
        [-L2 + i, hInset, d2 - i],
        [-L2 + i, H, 0],
        [L2 - i, H, 0],
        [L2 - i, hInset, d2 - i],
      ],
      toward: [0, 1, t],
    });
    if (i > 1e-6)
      for (const sx of [1, -1])
        slopes.push({
          poly: [
            [sx * L2, y0, -d2],
            [sx * L2, y0, d2],
            [sx * (L2 - i), hInset, d2 - i],
            [sx * (L2 - i), hInset, -d2 + i],
          ],
          toward: [sx * t, 1, 0],
        });
  }
  // Roof slabs (the soffit is the plane through the wall top) and courses on top.
  // Behind a false front the roof stops at its back face instead of running out over it.
  const front = o.falseFront > 0 ? D / 2 - th : Infinity;
  for (const sl of slopes) {
    const poly = clip(sl.poly.map(map), (q) => front - q[2]),
      toward = map(sl.toward),
      n = unit(toward),
      topPoly = poly.map((p) => add(p, scale(n, spec.thickness)));
    if (poly.length < 3) continue;
    parts.roof.slab(topPoly, spec.thickness, n);
    if (!far) courses(parts.roof, topPoly, n, o.roofing, near);
  }
  // Ridge and hip caps.
  if (!far && o.roofing !== 'membrane') {
    const cap = o.roofing === 'tile' ? [0.24, 0.16] : o.roofing === 'metal' ? [0.22, 0.05] : [0.18, 0.05];
    const lift = (p: V3, dy: number): V3 => [p[0], p[1] + dy, p[2]];
    if (shed) {
      parts.roof.beam(
        lift(map([-L2, y0 + 2 * d2 * t, d2]), spec.thickness),
        lift(map([L2, y0 + 2 * d2 * t, d2]), spec.thickness),
        cap[0] * 0.6,
        cap[1],
      );
    } else {
      const cut = (q: V3): V3 => [q[0], q[1], Math.min(q[2], front)],
        r0 = cut(map([-L2 + inset, H, 0])),
        r1 = cut(map([L2 - inset, H, 0]));
      parts.roof.beam(lift(r0, spec.thickness + cap[1] / 3), lift(r1, spec.thickness + cap[1] / 3), cap[0], cap[1]);
      if (inset > 1e-6)
        for (const sx of [1, -1])
          for (const sz of [1, -1]) {
            const a = map([sx * L2, y0, sz * d2]),
              b = map([sx * (L2 - inset), hInset, sz * (d2 - inset)]);
            parts.roof.beam(
              lift(a, spec.thickness + cap[1] / 3),
              lift(b, spec.thickness + cap[1] / 3),
              cap[0] * 0.8,
              cap[1],
            );
          }
    }
  }
  // Gutters along the level eaves, with a downspout at each end.
  if (o.gutters && !far) {
    const eaveLines: [V3, V3][] = shed
      ? [
          [
            [-L2, y0, -d2],
            [L2, y0, -d2],
          ],
        ]
      : [
          [
            [-L2, y0, -d2],
            [L2, y0, -d2],
          ],
          [
            [-L2, y0, d2],
            [L2, y0, d2],
          ],
          ...(inset > 1e-6
            ? ([
                [
                  [L2, y0, -d2],
                  [L2, y0, d2],
                ],
                [
                  [-L2, y0, -d2],
                  [-L2, y0, d2],
                ],
              ] as [V3, V3][])
            : []),
        ];
    for (const [a, b] of eaveLines) {
      const dirOut: V3 = Math.abs(a[2] - b[2]) < 1e-9 ? [0, 0, Math.sign(a[2])] : [Math.sign(a[0]), 0, 0],
        g0 = map(add(add(a, scale(dirOut, 0.07)), [0, -0.06, 0])),
        g1 = map(add(add(b, scale(dirOut, 0.07)), [0, -0.06, 0]));
      parts.gutters.beam(g0, g1, 0.12, 0.1);
      if (inset < 1e-6 || Math.abs(a[2] - b[2]) < 1e-9) {
        // Downspouts at the wall corners under this eave.
        for (const e of [a, b]) {
          const wx = Math.sign(e[0]) * (L / 2 + 0.06),
            wz = Math.sign(e[2]) * (d / 2 + 0.06),
            top = map([wx, y0 - 0.1, wz]),
            foot = map([wx, 0.05, wz]);
          parts.gutters.beam(top, foot, 0.08, 0.08, [1, 0, 0]);
        }
      }
    }
  }
  // Knee braces under the eaves on the long sides.
  if (o.brackets && !far && ov > 0.3) {
    const count = Math.max(1, Math.round((L - 2) / 2.2));
    for (const sz of [1, -1])
      for (let k = 0; k <= count; k++) {
        const x = -L / 2 + 1 + ((L - 2) * k) / count,
          foot = map([x, eaves - Math.min(1, ov * 0.7), sz * (d / 2 + 0.05)]),
          head = map([x, eaves - ov * 0.75 * t, sz * (d / 2 + ov * 0.75)]);
        parts.trim.beam(foot, head, 0.09, 0.14);
        parts.trim.beam(
          map([x, eaves - 0.12, sz * (d / 2 + 0.05)]),
          map([x, eaves - ov * t, sz * (d / 2 + ov)]),
          0.09,
          0.12,
        );
      }
  }
  // Roof height in local x, z (covering top).
  const heightC = (X: number, Z: number): number => {
    if (Math.abs(X) > L2 + 1e-9 || Math.abs(Z) > d2 + 1e-9) return NaN;
    if (shed) return y0 + (Z + d2) * t + spec.thickness;
    const zs = (d2 - Math.abs(Z)) * t,
      xs = (L2 - Math.abs(X)) * t,
      e = inset > 1e-6 && L2 - Math.abs(X) < inset ? xs : Infinity;
    return y0 + Math.min(zs, e) + spec.thickness;
  };
  const height = (x: number, z: number) => {
    const [X, Z] = unmap(x, z);
    return heightC(X, Z);
  };
  // Fills: gable triangles (or the shed's high wall) under the roof, in local terms split into front and the rest.
  const fills: { poly: V3[]; toward: V3; depth: number }[] = [];
  if (shed) {
    fills.push({
      poly: [
        [-L / 2, eaves, d / 2],
        [L / 2, eaves, d / 2],
        [L / 2, eaves + d * t, d / 2],
        [-L / 2, eaves + d * t, d / 2],
      ],
      toward: [0, 0, 1],
      depth: th,
    });
    for (const sx of [1, -1])
      fills.push({
        poly: [
          [(sx * L) / 2, eaves, -d / 2],
          [(sx * L) / 2, eaves, d / 2],
          [(sx * L) / 2, eaves + d * t, d / 2],
        ],
        toward: [sx, 0, 0],
        depth: th,
      });
  } else if (o.roof === 'gable') {
    for (const sx of [1, -1])
      fills.push({
        poly: [
          [(sx * L) / 2, eaves, -d / 2],
          [(sx * L) / 2, eaves, d / 2],
          [(sx * L) / 2, eaves + (d / 2) * t, 0],
        ],
        toward: [sx, 0, 0],
        depth: th,
      });
  } else if (o.roof === 'hip-gable') {
    for (const sx of [1, -1])
      fills.push({
        poly: [
          [sx * (L2 - inset), hInset, -(d2 - inset)],
          [sx * (L2 - inset), hInset, d2 - inset],
          [sx * (L2 - inset), H, 0],
        ],
        toward: [sx, 0, 0],
        depth: 0.05,
      });
  }
  const mapped = fills.map((f) => ({ poly: f.poly.map(map), toward: map(f.toward), depth: f.depth }));
  const isFront = (f: { toward: V3 }) => f.toward[2] > 0.5;
  const frontTop = Math.max(
    ...[0, ...mapped.filter(isFront).flatMap((f) => f.poly.map((p) => p[1]))],
    height(0, D / 2 - 1e-6) || eaves,
  );
  const all = slopes.flatMap((s) => s.poly.map((p) => p[1] + spec.thickness));
  return {
    top: Math.max(...all) + (o.roofing === 'tile' ? 0.16 : 0.05),
    frontTop,
    height,
    frontFill() {
      for (const f of mapped) if (isFront(f)) parts.walls.slab(f.poly, f.depth, f.toward);
    },
    otherFills() {
      for (const f of mapped) if (!isFront(f)) parts.walls.slab(f.poly, f.depth, f.toward);
    },
  };
}

// Courses on a roof slope's top face: sawtooth tile or shingle courses, tile rolls at near detail, or standing seams.
function courses(m: MeshBuilder, poly: V3[], n: V3, roofing: BuildingRoofing, near: boolean) {
  const spec = ROOFING[roofing];
  const vRaw: V3 = [-n[0] * n[1], 1 - n[1] * n[1], -n[2] * n[1]];
  if (Math.hypot(...vRaw) < 1e-6) return;
  const v = unit(vRaw),
    u = cross(v, n),
    o = poly[0],
    pu = (p: V3) => dot(sub(p, o), u),
    pv = (p: V3) => dot(sub(p, o), v);
  const vs = poly.map(pv),
    us = poly.map(pu),
    vmin = Math.min(...vs),
    vmax = Math.max(...vs),
    umin = Math.min(...us),
    umax = Math.max(...us);
  if (roofing === 'metal') {
    for (let k = Math.ceil((umin + 0.05) / spec.tile); k * spec.tile < umax - 0.05; k++) {
      const uk = k * spec.tile,
        band = clip(
          clip(poly, (p) => pu(p) - (uk - 0.01)),
          (p) => uk + 0.01 - pu(p),
        );
      if (band.length < 3) continue;
      const bv = band.map(pv),
        a = add(add(o, scale(u, uk)), scale(v, Math.min(...bv))),
        b = add(add(o, scale(u, uk)), scale(v, Math.max(...bv)));
      m.beam(add(a, scale(n, 0.02)), add(b, scale(n, 0.02)), 0.025, 0.04, n);
    }
    return;
  }
  if (!spec.course) return;
  const e = spec.course,
    lip = spec.lip;
  for (let k = 0; vmin + k * e < vmax - 1e-6; k++) {
    const v0 = vmin + k * e,
      v1 = v0 + e;
    const band = clip(
      clip(poly, (p) => pv(p) - v0),
      (p) => v1 - pv(p),
    );
    if (band.length < 3) continue;
    const liftOf = (p: V3) => lip * (1 - (pv(p) - v0) / e);
    if (near && spec.roll > 0) {
      // Tile rolls: four strips a tile, the middle two raised (a rounded pan and roll).
      const w = spec.tile / 4,
        offset = (k % 2) * spec.tile * 0.5;
      for (let j = Math.floor((umin - offset) / w); offset + j * w < umax; j++) {
        const a0 = offset + j * w,
          strip = clip(
            clip(band, (p) => pu(p) - a0),
            (p) => a0 + w - pu(p),
          );
        if (strip.length < 3) continue;
        const r = j % 4 === 1 || j % 4 === 2 ? spec.roll : 0;
        m.poly(
          strip.map((p) => add(p, scale(n, liftOf(p) + r * (1 - (pv(p) - v0) / e) + r * 0.3))),
          n,
        );
      }
    } else
      m.poly(
        band.map((p) => add(p, scale(n, liftOf(p)))),
        n,
      );
    // The lip along the course's lower edge.
    const low = band.filter((p) => Math.abs(pv(p) - v0) < 1e-6);
    if (low.length >= 2) {
      low.sort((p, q) => pu(p) - pu(q));
      const a = low[0],
        b = low[low.length - 1];
      m.poly([a, b, add(b, scale(n, lip)), add(a, scale(n, lip))], scale(v, -1));
    }
  }
}

function buildFrontage(
  parts: Record<BuildingPart, MeshBuilder>,
  o: Resolved,
  s: Side,
  holes: Hole[],
  floors: number[],
  eaves: number,
  near: boolean,
  far: boolean,
  steps: { rise: number; tread: number; count: number }[],
  railings: number[],
) {
  const W = o.width,
    D = o.depth,
    deck = o.plinth;
  const doors = holes.filter((h) => h.side === 0 && h.kind === 'door');
  const stair = (x: number, z0: number, width: number, height: number) => {
    if (height < 0.05) return;
    const count = Math.ceil(height / 0.18 - 1e-9),
      rise = height / count,
      tread = 0.28;
    // Step k is a block from the ground up to its tread, k = 1 just below the deck; the last riser lands on the ground.
    for (let k = 1; k < count; k++) {
      const ytop = height - k * rise,
        zc = z0 + (k - 1) * tread + tread / 2;
      parts.porch.box([x, ytop / 2, zc], [width / 2, ytop / 2, tread / 2]);
    }
    steps.push({ rise, tread, count });
  };
  const railing = (a: V3, b: V3, height: number, solid: boolean) => {
    if (far || solid) {
      parts.porch.slab([a, b, add(b, [0, height, 0]), add(a, [0, height, 0])], 0.04, cross(sub(b, a), UP));
    } else {
      parts.porch.beam(add(a, [0, height - 0.03, 0]), add(b, [0, height - 0.03, 0]), 0.07, 0.06);
      parts.porch.beam(add(a, [0, 0.1, 0]), add(b, [0, 0.1, 0]), 0.05, 0.05);
      const l = Math.hypot(b[0] - a[0], b[2] - a[2]),
        gap = 0.11,
        count = Math.max(1, Math.floor(l / gap));
      if (near || o.style.startsWith('japan'))
        for (let k = 1; k < count; k++) {
          const p = lerp(a, b, k / count);
          parts.porch.beam(add(p, [0, 0.12, 0]), add(p, [0, height - 0.06, 0]), 0.03, 0.03, [1, 0, 0]);
        }
    }
    railings.push(height);
  };
  if (o.porch > 0) {
    const pw = (W * o.porchWidth) / 2,
      z0 = D / 2,
      z1 = D / 2 + o.porch;
    parts.porch.box([0, deck - 0.075, (z0 + z1) / 2], [pw, 0.075, o.porch / 2]);
    // Posts and the porch roof (a shed roof from under the first floor's top down to the posts).
    const roofWall = Math.min(floors[0] + o.storeys[0] + 0.15, eaves - 0.1),
      drop = Math.tan((14 * Math.PI) / 180) * (o.porch + 0.3),
      roofEdge = roofWall - drop,
      posts = Math.max(2, Math.ceil((2 * pw) / 2.4) + 1);
    for (let k = 0; k < posts; k++) {
      const x = -pw + 0.1 + ((2 * pw - 0.2) * k) / (posts - 1);
      parts.porch.box([x, (deck + roofEdge) / 2, z1 - 0.12], [0.07, (roofEdge - deck) / 2, 0.07]);
    }
    parts.trim.box([0, roofEdge - 0.1, z1 - 0.12], [pw, 0.1, 0.08]);
    const rp: V3[] = [
      [-pw - 0.15, roofWall, z0],
      [pw + 0.15, roofWall, z0],
      [pw + 0.15, roofEdge - drop * (0.3 / (o.porch + 0.3)), z1 + 0.3],
      [-pw - 0.15, roofEdge - drop * (0.3 / (o.porch + 0.3)), z1 + 0.3],
    ];
    parts.roof.slab(
      rp.map((p) => add(p, [0, 0.06, 0])),
      0.08,
      UP,
    );
    if (!far) {
      let n = unit(cross(sub(rp[1], rp[0]), sub(rp[3], rp[0])));
      if (n[1] < 0) n = scale(n, -1);
      courses(
        parts.roof,
        rp.map((p) => add(p, [0, 0.06, 0])),
        n,
        o.roofing,
        near,
      );
    }
    // Railing along the front between the posts, open at the door.
    const door = doors[0];
    if (deck > 0.3) {
      const dx = door ? s.start[0] + (s.dir[0] * (door.a0 + door.a1)) / 2 : 0;
      const gap = 0.75;
      railing([-pw + 0.17, deck, z1 - 0.12], [dx - gap, deck, z1 - 0.12], 0.9, false);
      railing([dx + gap, deck, z1 - 0.12], [pw - 0.17, deck, z1 - 0.12], 0.9, false);
      stair(dx, z1, 1.4, deck);
    }
  } else {
    // A stoop at each raised door.
    for (const h of doors) {
      if (deck < 0.05) continue;
      const x = s.start[0] + s.dir[0] * ((h.a0 + h.a1) / 2),
        w = h.a1 - h.a0 + 0.5;
      if (h.a1 - h.a0 > 2.2) {
        // A vehicle door gets a ramp at 1 in 8 instead of steps.
        const run = deck * 8;
        parts.porch.slab(
          [
            [x - w / 2, deck, D / 2],
            [x + w / 2, deck, D / 2],
            [x + w / 2, 0, D / 2 + run],
            [x - w / 2, 0, D / 2 + run],
          ],
          deck,
          UP,
        );
        continue;
      }
      parts.porch.box([x, deck / 2, D / 2 + 0.5], [w / 2, deck / 2, 0.5]);
      stair(x, D / 2 + 1, w, deck);
    }
  }
  // Balcony (veranda): a slab with a 1.1 m railing at the chosen floor.
  if (o.balcony > 0 && o.balconyFloor < o.storeys.length) {
    const fy = floors[o.balconyFloor],
      bw = (W * o.balconyWidth) / 2,
      z0 = D / 2,
      z1 = D / 2 + o.balcony;
    parts.porch.box([0, fy - 0.08, (z0 + z1) / 2], [bw, 0.08, o.balcony / 2]);
    const solid = o.style === 'japan-2011-concrete';
    railing([-bw, fy, z1 - 0.03], [bw, fy, z1 - 0.03], 1.1, solid);
    railing([-bw + 0.03, fy, z0], [-bw + 0.03, fy, z1 - 0.03], 1.1, solid);
    railing([bw - 0.03, fy, z1 - 0.03], [bw - 0.03, fy, z0], 1.1, solid);
  }
  // Awning over the storefront.
  if (o.awning && o.storefront) {
    const h0 = floors[0] + o.storeys[0] - 0.45,
      depth = 1.5,
      drop = Math.tan((20 * Math.PI) / 180) * depth,
      w = (W * 0.92) / 2,
      p: V3[] = [
        [-w, h0, D / 2],
        [w, h0, D / 2],
        [w, h0 - drop, D / 2 + depth],
        [-w, h0 - drop, D / 2 + depth],
      ];
    parts.awning.slab(p, 0.02, UP);
    parts.awning.slab(
      [
        [-w, h0 - drop, D / 2 + depth],
        [w, h0 - drop, D / 2 + depth],
        [w, h0 - drop - 0.25, D / 2 + depth],
        [-w, h0 - drop - 0.25, D / 2 + depth],
      ],
      0.01,
      [0, 0, 1],
    );
  }
}

/** A lot of a settlement layout: the shape of a `House` from `@margoengine/biomes` `layoutSettlements`. */
export interface BuildingLot {
  /** Centre `[x, z]` in metres. */
  readonly centre: readonly [number, number];
  /** Width along the street and depth away from it, metres. */
  readonly size: readonly [number, number];
  /** Unit direction `[x, z]` along the street (the width axis). */
  readonly along: readonly [number, number];
  /** Ground height where the floor goes, metres. */
  readonly floor: number;
  /** Unit direction `[x, z]` from the building to its street; when missing, the side of `along` turned left. */
  readonly front?: readonly [number, number];
}
/** Options for {@link townBuildings}. */
export interface TownBuildingOptions {
  /** Styles to draw from, with their weights. Default `{ 'japan-2011-house': 1 }`. */
  readonly styles?: Readonly<Partial<Record<BuildingStyle, number>>>;
  /** Space kept clear between the building and the lot edge on each side, metres, 0 to 10. Default 1. */
  readonly margin?: number;
  /** Detail for every building. Default `mid`. */
  readonly detail?: BuildingDetail;
  /** Integer seed. Default 1. */
  readonly seed?: number;
  /** Options applied to every building after the style (for example `{ roofing: 'metal' }`). */
  readonly override?: Omit<BuildingRuleOptions, 'origin' | 'yaw' | 'width' | 'depth' | 'style' | 'seed' | 'detail'>;
}
/**
 * One building's options per lot: a style drawn by weight, the lot's size less the margin (capped by the style's own
 * size so a house does not grow to fill a field), its front to the street, and seeded variety (storeys, roof shape,
 * pitch and which side the door is on) within what the style allows. Pass each to {@link generateBuilding}.
 * @throws RangeError for a bad lot, weight or margin.
 */
export function townBuildings(lots: readonly BuildingLot[], options: TownBuildingOptions = {}): BuildingRuleOptions[] {
  if (!Array.isArray(lots)) throw new TypeError('Invalid lots; pass an array of lots.');
  const weights = Object.entries(options.styles ?? { 'japan-2011-house': 1 }) as [BuildingStyle, number][];
  if (!weights.length || weights.some(([k, w]) => !BUILDING_STYLES.includes(k) || !(w >= 0) || !Number.isFinite(w)))
    fail('styles', 'an object of style names to weights of 0 or more');
  const total = weights.reduce((a, [, w]) => a + w, 0);
  if (!(total > 0)) fail('styles', 'at least one weight above 0');
  const margin = num(options as Record<string, unknown>, 'margin', 0, 10, 1),
    seed = num(options as Record<string, unknown>, 'seed', -0x80000000, 0xffffffff, 1, true),
    detail = pick(options as Record<string, unknown>, 'detail', ['far', 'mid', 'near'], 'mid'),
    rand = random(seed ^ 0x2545f491);
  return lots.map((lot, i) => {
    const ok = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every((x) => Number.isFinite(x));
    if (!lot || !ok(lot.centre, 2) || !ok(lot.size, 2) || !ok(lot.along, 2) || !Number.isFinite(lot.floor))
      fail(`lot ${i}`, 'a lot with centre, size, along and floor');
    let r = rand() * total,
      style = weights[0][0];
    for (const [k, w] of weights) {
      if ((r -= w) < 0) {
        style = k;
        break;
      }
    }
    const set = BUILDING_STYLE_SETS[style],
      front = lot.front ?? ([-lot.along[1], lot.along[0]] as const),
      width = Math.max(3, Math.min(lot.size[0] - 2 * margin, set.width * (1 + (rand() - 0.5) * 0.2))),
      depth = Math.max(3, Math.min(lot.size[1] - 2 * margin, set.depth * (1 + (rand() - 0.5) * 0.2))),
      v = rand(),
      storeys =
        style === 'western-1910-brick'
          ? set.storeys.slice(0, v < 0.4 ? 2 : 3)
          : style === 'japan-2011-concrete'
            ? set.storeys.slice(0, 3 + Math.floor(v * 2))
            : style === 'western-1910-house' || style === 'western-1910-false-front' || style === 'japan-2011-house'
              ? set.storeys.slice(0, v < 0.2 ? 1 : 2)
              : set.storeys,
      roof: BuildingRoof =
        style === 'japan-2011-house' ? (rand() < 0.35 ? 'hip-gable' : rand() < 0.5 ? 'gable' : 'hip') : set.roof,
      pitch = Math.min(60, Math.max(2, set.pitch + (rand() - 0.5) * 4)),
      bays = Math.max(1, Math.round(width / set.bayWidth)),
      door = bays > 1 && rand() < 0.5 ? [Math.floor(rand() * bays)] : set.doors;
    return {
      ...options.override,
      style,
      detail,
      seed: (seed * 31 + i) | 0,
      width,
      depth,
      storeys,
      roof,
      pitch: Math.max(style === 'japan-2011-house' && roof !== 'flat' ? 21.8 : 2, pitch),
      doors: door,
      origin: [lot.centre[0], lot.floor, lot.centre[1]],
      yaw: Math.atan2(front[0], front[1]),
    };
  });
}

// Interiors. Room widths: two ken (2 x 1.82 m, the Edo-ma module) for the Japanese sets and 12 ft (3.66 m) for the
// western sets. Partition walls are 0.1 m (Japanese shoji and fusuma frames) and 0.12 m (a 2 by 4 stud wall with lath
// and plaster); doorways are 0.86 by 1.8 m (fusuma opening) and 32 by 80 in (0.81 by 2.03 m). Furnishing blocks keep to
// the sizes of their period pieces (chabudai, tansu, zabuton; table, chair, sideboard, bed, wardrobe; shop counter and
// shelves; office desks; stacked crates) and are placed only where they block no window, doorway or door.
const ROOM_WIDTH = { japan: 3.64, western: 3.66 } as const;
function buildInterior(
  parts: Record<BuildingPart, MeshBuilder>,
  o: Resolved,
  sides: Side[],
  holes: Hole[],
  floors: number[],
  eaves: number,
): { rooms: BuildingRoom[]; furniture: BuildingFurniture[]; doorways: BuildingDoorway[] } {
  const rooms: BuildingRoom[] = [],
    furniture: BuildingFurniture[] = [],
    doorways: BuildingDoorway[] = [];
  if (o.interior === 'none') return { rooms, furniture, doorways };
  const W = o.width,
    D = o.depth,
    th = o.wall,
    x0 = -W / 2 + th,
    x1 = W / 2 - th,
    z0 = -D / 2 + th,
    z1 = D / 2 - th,
    japan = o.style.startsWith('japan'),
    use =
      o.style === 'japan-2011-warehouse' || o.style === 'western-1910-depot'
        ? 'store'
        : o.style === 'japan-2011-concrete'
          ? 'office'
          : 'home',
    ceilingOf = (k: number) => (k + 1 < floors.length ? floors[k + 1] : eaves) - 0.2,
    m = parts.interior,
    f = parts.furniture;
  if (o.interior === 'cells') {
    // One cell per window: back wall, floor, ceiling and two sides, facing in: the room cell of van Dongen 2008.
    for (const h of holes) {
      if (h.kind === 'door' || h.kind === 'transom') continue;
      const s = sides[h.side],
        fy = floors[h.floor],
        cy = ceilingOf(h.floor),
        a0 = Math.max(th, h.a0 - 0.6),
        a1 = Math.min(s.length - th, h.a1 + 0.6),
        depth = Math.min(3.6, ((h.side % 2 === 0 ? D : W) - 2 * th) / 2),
        p = (a: number, y: number, off: number): V3 =>
          add(add(s.start, scale(s.dir, a)), [s.out[0] * off, y, s.out[2] * off]),
        i0 = -th,
        i1 = -th - depth,
        g = fy + 0.005;
      m.poly([p(a0, fy, i1), p(a1, fy, i1), p(a1, cy, i1), p(a0, cy, i1)], s.out);
      m.poly([p(a0, g, i0), p(a1, g, i0), p(a1, g, i1), p(a0, g, i1)], UP);
      m.poly([p(a0, cy, i0), p(a1, cy, i0), p(a1, cy, i1), p(a0, cy, i1)], [0, -1, 0]);
      m.poly([p(a0, fy, i0), p(a0, fy, i1), p(a0, cy, i1), p(a0, cy, i0)], s.dir);
      m.poly([p(a1, fy, i0), p(a1, fy, i1), p(a1, cy, i1), p(a1, cy, i0)], scale(s.dir, -1));
    }
    return { rooms, furniture, doorways };
  }
  const pt = japan ? 0.1 : 0.12,
    dw = japan ? 0.86 : 0.81,
    dh = japan ? 1.8 : 2.03,
    bays = Math.max(1, Math.round(W / o.bayWidth)),
    bw = W / bays;
  // Each opening on the inner wall face, in local terms: the wall plane and the span along it.
  const span = (h: Hole) => {
    if (h.side === 0) return { axis: 'z' as const, plane: z1, lo: -W / 2 + h.a0, hi: -W / 2 + h.a1, h };
    if (h.side === 2) return { axis: 'z' as const, plane: z0, lo: W / 2 - h.a1, hi: W / 2 - h.a0, h };
    if (h.side === 1) return { axis: 'x' as const, plane: x1, lo: D / 2 - h.a1, hi: D / 2 - h.a0, h };
    return { axis: 'x' as const, plane: x0, lo: -D / 2 + h.a0, hi: -D / 2 + h.a1, h };
  };
  const box = (b: MeshBuilder, ax: number, bx: number, ay: number, by: number, az: number, bz: number) =>
    b.box([(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2], [(bx - ax) / 2, (by - ay) / 2, (bz - az) / 2]);
  for (let k = 0; k < floors.length; k++) {
    const fy = floors[k],
      cy = ceilingOf(k),
      open = use === 'store' || (k === 0 && o.storefront),
      n = open ? 1 : Math.max(1, Math.round((x1 - x0) / ROOM_WIDTH[japan ? 'japan' : 'western'])),
      xs = [x0];
    for (let j = 1; j < n; j++) {
      // A partition on a bay line where one is close, so none stands behind a window.
      const even = x0 + (j * (x1 - x0)) / n,
        snap = -W / 2 + bw * Math.round((even + W / 2) / bw);
      xs.push(Math.abs(snap - even) < 0.6 && snap - xs[xs.length - 1] > 2.4 && x1 - snap > 2.4 ? snap : even);
    }
    xs.push(x1);
    const zs = !open && z1 - z0 > 6 ? [z0, z1 - 0.55 * (z1 - z0), z1] : [z0, z1],
      floorDoors: BuildingDoorway[] = [];
    for (let j = 1; j < xs.length - 1; j++)
      for (let r = 0; r + 1 < zs.length; r++) {
        const za = zs[r] + (r > 0 ? pt / 2 : 0),
          zb = zs[r + 1] - (r + 1 < zs.length - 1 ? pt / 2 : 0),
          d0 = za + 0.3,
          d1 = d0 + dw,
          x = xs[j];
        if (d1 > zb - 0.1) {
          box(m, x - pt / 2, x + pt / 2, fy, cy, za, zb);
          continue;
        }
        box(m, x - pt / 2, x + pt / 2, fy, cy, za, d0);
        box(m, x - pt / 2, x + pt / 2, fy, cy, d1, zb);
        box(m, x - pt / 2, x + pt / 2, fy + dh, cy, d0, d1);
        floorDoors.push({ floor: k, centre: [x, fy + dh / 2, (d0 + d1) / 2], width: dw, height: dh, normal: 'x' });
      }
    if (zs.length === 3)
      for (let i = 0; i + 1 < xs.length; i++) {
        const xa = xs[i] + (i > 0 ? pt / 2 : 0),
          xb = xs[i + 1] - (i + 1 < xs.length - 1 ? pt / 2 : 0),
          c = (xa + xb) / 2,
          z = zs[1];
        box(m, xa, c - dw / 2, fy, cy, z - pt / 2, z + pt / 2);
        box(m, c + dw / 2, xb, fy, cy, z - pt / 2, z + pt / 2);
        box(m, c - dw / 2, c + dw / 2, fy + dh, cy, z - pt / 2, z + pt / 2);
        floorDoors.push({ floor: k, centre: [c, fy + dh / 2, z], width: dw, height: dh, normal: 'z' });
      }
    doorways.push(...floorDoors);
    const openings = holes.filter((h) => h.floor === k).map(span);
    for (let i = 0; i + 1 < xs.length; i++)
      for (let r = 0; r + 1 < zs.length; r++) {
        const rx0 = xs[i] + (i > 0 ? pt / 2 : 0),
          rx1 = xs[i + 1] - (i + 1 < xs.length - 1 ? pt / 2 : 0),
          rz0 = zs[r] + (r > 0 ? pt / 2 : 0),
          rz1 = zs[r + 1] - (r + 1 < zs.length - 1 ? pt / 2 : 0),
          mx = (rx0 + rx1) / 2,
          mz = (rz0 + rz1) / 2;
        rooms.push({
          floor: k,
          min: [rx0, rz0],
          max: [rx1, rz1],
          level: fy,
          height: cy - fy,
          area: (rx1 - rx0) * (rz1 - rz0),
        });
        const placed: BuildingFurniture[] = [];
        // A block fits when it is inside the room, clear of the others, of every doorway's approach (0.9 m each side)
        // and of each outer door (1.2 m), and lower than the sill of any window it stands within 0.9 m of.
        const fits = (ax: number, bx: number, az: number, bz: number, top: number) => {
          if (ax < rx0 + 0.02 || bx > rx1 - 0.02 || az < rz0 + 0.02 || bz > rz1 - 0.02) return false;
          for (const q of placed) if (ax < q.max[0] && bx > q.min[0] && az < q.max[2] && bz > q.min[2]) return false;
          for (const d of floorDoors) {
            const [cx, , cz] = d.centre,
              [ex, ez] = d.normal === 'x' ? [0.9, d.width / 2 + 0.05] : [d.width / 2 + 0.05, 0.9];
            if (ax < cx + ex && bx > cx - ex && az < cz + ez && bz > cz - ez) return false;
          }
          for (const s of openings) {
            const near =
                s.axis === 'z'
                  ? Math.min(Math.abs(az - s.plane), Math.abs(bz - s.plane))
                  : Math.min(Math.abs(ax - s.plane), Math.abs(bx - s.plane)),
              [lo, hi] = s.axis === 'z' ? [ax, bx] : [az, bz],
              door = s.h.kind === 'door' || s.h.kind === 'balcony-door';
            if (lo < s.hi + 0.1 && hi > s.lo - 0.1 && near < (door ? 1.2 : 0.9) && (door || top > s.h.y0 - 0.05))
              return false;
          }
          return true;
        };
        const put = (kind: string, cx: number, cz: number, sx: number, sz: number, h: number, pieces?: () => void) => {
          const ax = cx - sx / 2,
            bx = cx + sx / 2,
            az = cz - sz / 2,
            bz = cz + sz / 2;
          if (!fits(ax, bx, az, bz, fy + h)) return false;
          if (pieces) pieces();
          else box(f, ax, bx, fy, fy + h, az, bz);
          placed.push({ kind, floor: k, min: [ax, fy, az], max: [bx, fy + h, bz] });
          return true;
        };
        // Against a wall: each wall of the room at its middle, then a quarter of the way along either way.
        const againstWall = (kind: string, w: number, d: number, h: number) => {
          for (const t of [0.5, 0.25, 0.75]) {
            const ax = rx0 + (rx1 - rx0) * t,
              az = rz0 + (rz1 - rz0) * t,
              spots: [number, number, number, number][] = [
                [rx0 + 0.03 + d / 2, az, d, w],
                [rx1 - 0.03 - d / 2, az, d, w],
                [ax, rz0 + 0.03 + d / 2, w, d],
                [ax, rz1 - 0.03 - d / 2, w, d],
              ];
            for (const [cx, cz, sx, sz] of spots) if (put(kind, cx, cz, sx, sz, h)) return;
          }
        };
        const legs = (cx: number, cz: number, hx: number, hz: number, top: number, leg: number) => {
          for (const [sx, sz] of [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ])
            box(f, cx + sx * hx - leg, cx + sx * hx + leg, fy, top, cz + sz * hz - leg, cz + sz * hz + leg);
        };
        if (use === 'store') {
          // Crates stacked two high in rows across the back half, 1.2 m cubes on 1.8 m centres.
          for (let cx = rx0 + 1.2; cx + 1.2 < rx1; cx += 1.8)
            for (let cz = rz0 + 1.2; cz < mz; cz += 1.8)
              put('crates', cx, cz, 1.2, 1.2, 2.4, () => {
                box(f, cx - 0.6, cx + 0.6, fy, fy + 1.2, cz - 0.6, cz + 0.6);
                box(f, cx - 0.55, cx + 0.55, fy + 1.2, fy + 2.4, cz - 0.55, cz + 0.55);
              });
        } else if (k === 0 && o.storefront) {
          // A shop counter across the floor and shelving against a wall.
          put('counter', mx, rz0 + 0.45 * (rz1 - rz0), Math.max(1.2, rx1 - rx0 - 2.4), 0.6, 0.95);
          againstWall('shelves', Math.min(3, (rx1 - rx0) * 0.5), 0.4, 2.2);
        } else if (use === 'office') {
          put('desk', mx, mz, 1.4, 0.7, 0.72, () => {
            box(f, mx - 0.7, mx + 0.7, fy + 0.69, fy + 0.72, mz - 0.35, mz + 0.35);
            box(f, mx + 0.25, mx + 0.68, fy, fy + 0.69, mz - 0.33, mz + 0.33);
            box(f, mx - 0.68, mx - 0.64, fy, fy + 0.69, mz - 0.33, mz + 0.33);
          });
          put('chair', mx, mz - 0.7, 0.5, 0.5, 0.95);
          againstWall('cabinet', 0.9, 0.45, 1.8);
        } else if (japan) {
          put('low table', mx, mz, 0.9, 0.9, 0.33, () => {
            box(f, mx - 0.45, mx + 0.45, fy + 0.3, fy + 0.33, mz - 0.45, mz + 0.45);
            legs(mx, mz, 0.38, 0.38, fy + 0.3, 0.03);
          });
          put('cushion', mx - 0.8, mz, 0.55, 0.55, 0.08);
          put('cushion', mx + 0.8, mz, 0.55, 0.55, 0.08);
          againstWall('tansu', 1.0, 0.45, 1.1);
        } else if (k === 0) {
          put('table', mx, mz, 1.2, 0.8, 0.76, () => {
            box(f, mx - 0.6, mx + 0.6, fy + 0.72, fy + 0.76, mz - 0.4, mz + 0.4);
            legs(mx, mz, 0.54, 0.34, fy + 0.72, 0.03);
          });
          for (const sx of [-1, 1]) {
            const cx = mx + sx * 0.85;
            put('chair', cx, mz, 0.45, 0.45, 0.9, () => {
              box(f, cx - 0.22, cx + 0.22, fy + 0.42, fy + 0.46, mz - 0.22, mz + 0.22);
              box(f, cx + sx * 0.2 - 0.02, cx + sx * 0.2 + 0.02, fy + 0.46, fy + 0.9, mz - 0.2, mz + 0.2);
              legs(cx, mz, 0.19, 0.19, fy + 0.42, 0.02);
            });
          }
          againstWall('sideboard', 1.2, 0.5, 0.9);
        } else {
          againstWall('bed', 1.4, 1.95, 0.6);
          againstWall('wardrobe', 1.0, 0.6, 1.9);
        }
        furniture.push(...placed);
      }
  }
  return { rooms, furniture, doorways };
}
