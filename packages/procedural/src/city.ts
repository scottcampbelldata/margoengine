// A city from one seed: streets and avenues, blocks, lots and the rule-built building of every lot, with the places for
// street trees and lamps. Pure data in metres, Y up; `buildCity` (city-mesh.ts) turns it into meshes.
// Our own code, written from these papers (no paper's code was read):
// - Y. Parish and P. Müller, "Procedural Modeling of Cities", SIGGRAPH 2001, https://doi.org/10.1145/383259.383292:
//   the street network first, with a road hierarchy, then the blocks between the streets, lots in the blocks and a
//   building per lot, driven by maps of land use and height.
// - G. Chen, G. Esch, P. Wonka, P. Müller and E. Zhang, "Interactive Procedural Street Modeling", ACM TOG 27(3), 2008,
//   https://doi.org/10.1145/1360612.1360702: grid and radial street patterns and a major and minor road hierarchy.
// - Y.-L. Yang, J. Wang, E. Vouga and P. Wonka, "Urban Pattern: Layout Design by Hierarchical Domain Splitting", ACM
//   TOG 32(6), 2013, https://doi.org/10.1145/2508363.2508405: streets as the cuts of a recursive split of the town's
//   area, so the network is planar and the blocks fill it exactly.
// - C. Vanegas, T. Kelly, B. Weber, J. Halatsch, D. Aliaga and P. Müller, "Procedural Generation of Parcels in Urban
//   Modeling", Computer Graphics Forum 31(2), 2012, https://doi.org/10.1111/j.1467-8659.2012.03047.x: lots by cutting a
//   block's oriented box across its long side, keeping every lot on a street.
// This file keeps every area convex: all roads are straight cuts, so blocks, kerbs and lots come out of half-plane
// clipping exactly, with no triangulator and no overlap.
import { fault } from '../../shared/errors.js';
import {
  BUILDING_STYLES,
  BUILDING_STYLE_SETS,
  type BuildingLot,
  type BuildingRuleOptions,
  type BuildingStyle,
} from './building-rules.js';
import {
  add2,
  area,
  centroid,
  clipHalf,
  dot2,
  extent,
  frontRect,
  inset,
  left,
  length2,
  minWidth,
  mul2,
  orientedBox,
  outset,
  split,
  sub2,
  unit2,
  type Poly,
  type V2,
} from './city-geometry.js';
import { random } from './mesh-builder.js';

export * from './city-mesh.js';

/** The street pattern: straight rows and columns, recursive uneven cuts, or rings and spokes round the centre. */
export type CityLayout = 'grid' | 'organic' | 'radial';
/** What a block is used for; it picks the building styles, lot sizes and heights. */
export type CityUse = 'downtown' | 'commercial' | 'residential' | 'industrial' | 'park';
/** The default building styles: Japanese buildings of 2011, or an American town of 1910. */
export type CityEra = 'modern' | 'western-1910';

/** Options for {@link generateCity}. Every option has a default. */
export interface CityOptions {
  /** Size along x between the middles of the two edge streets, metres, 60 to 4000. Default 400. */
  readonly width?: number;
  /** Size along z between the middles of the two edge streets, metres, 60 to 4000. Default 400. */
  readonly depth?: number;
  /**
   * A convex outline `[x, z]` in metres instead of the rectangle: the middle line of the edge streets, 3 to 64
   * corners in either order, each within 2000 of zero.
   */
  readonly outline?: readonly (readonly [number, number])[];
  /** Default `grid`. */
  readonly layout?: CityLayout;
  /** Target block length from street to street, metres, 30 to 500. Default 90. */
  readonly blockWidth?: number;
  /** Target block depth from street to street, metres, 30 to 500. Default 60. */
  readonly blockDepth?: number;
  /** Turn of the grid, or of the first spoke, radians within +/-2pi. Default 0. */
  readonly angle?: number;
  /** How uneven the streets and lots are, 0 to 1. Default 0.25. */
  readonly irregularity?: number;
  /** Street width, kerb to kerb, metres, 4 to 30. Default 8. */
  readonly streetWidth?: number;
  /** Avenue width, kerb to kerb, metres, from the street width to 60. Default 16 (or the street width). */
  readonly avenueWidth?: number;
  /**
   * Grid and radial: every this many streets (or rings) is an avenue; organic: the first cuts are avenues. 0 for no
   * avenues (radial spokes included). Default 4.
   */
  readonly avenueEvery?: number;
  /** Radial: the number of spoke streets, 3 to 24. Default 8. */
  readonly spokes?: number;
  /** Pavement width round each block, metres, 0 to 8. Default 2.5. */
  readonly sidewalk?: number;
  /** Pavement height over the road, metres, 0 to 0.5. Default 0.15. */
  readonly curb?: number;
  /** Target lot width on the street, metres, 6 to 200 (downtown 1.4 times, houses 0.8, industry 2). Default 18. */
  readonly lotFrontage?: number;
  /** Target lot depth, metres, 8 to 120. Default 26. */
  readonly lotDepth?: number;
  /** Smallest gap kept between a building and its lot's street edges, metres, 0 to 20. Default 0 (houses 2). */
  readonly setback?: number;
  /** Smallest gap kept between two neighbouring buildings, metres, 0 to 20. Default 0 downtown, else 1. */
  readonly spacing?: number;
  /** The middle of downtown `[x, z]` (and of the rings). Default the middle of the outline. */
  readonly centre?: readonly [number, number];
  /** Downtown radius, metres, 0 (no downtown) to 4000. Default 0.22 of the smaller size. */
  readonly downtownRadius?: number;
  /** Fewest storeys of a downtown or commercial building, 1 to 60. Default 2. */
  readonly minStoreys?: number;
  /** Most storeys, at the middle of downtown, from `minStoreys` to 60. Default 24 (4 in the 1910 era). */
  readonly maxStoreys?: number;
  /** Share of blocks that are parks, 0 to 1. Default 0.08. */
  readonly parks?: number;
  /** Share of the ring outside downtown that is industry (one side of town), 0 to 1. Default 0.15. */
  readonly industry?: number;
  /** Default `modern`. */
  readonly era?: CityEra;
  /** Styles by use, with weights, replacing the era's for the uses given. */
  readonly styles?: Readonly<
    Partial<Record<Exclude<CityUse, 'park'>, Readonly<Partial<Record<BuildingStyle, number>>>>>
  >;
  /** Space between street trees, metres, 0 (none) or 1 to 100. Default 11. */
  readonly treeSpacing?: number;
  /** Space between street lamps, metres, 0 (none) or 1 to 200. Default 30. */
  readonly lampSpacing?: number;
  /** World position of the city's zero point at road level. Default `[0, 0, 0]`. */
  readonly origin?: readonly [number, number, number];
  /** Integer seed. The same options and seed give the same city. Default 1. */
  readonly seed?: number;
  /** Checked before and between the stages of the synchronous work. */
  readonly signal?: AbortSignal;
}

/** One stretch of road between two junctions: indices into {@link City.nodes}. */
export interface CityRoad {
  readonly from: number;
  readonly to: number;
  /** Kerb to kerb, metres. */
  readonly width: number;
  readonly kind: 'avenue' | 'street';
  readonly length: number;
}
/** The land inside the kerbs between streets. Polygons are `[x, z]`, counter-clockwise from above. */
export interface CityBlock {
  readonly use: CityUse;
  /** The kerb line. */
  readonly polygon: readonly (readonly [number, number])[];
  /** Inside the pavement. */
  readonly inner: readonly (readonly [number, number])[];
  readonly centre: readonly [number, number];
  /** Area inside the kerb, square metres. */
  readonly area: number;
}
/** A lot on a street. A lot with a building is also a `BuildingLot`, so `townBuildings` accepts it. */
export interface CityLot extends BuildingLot {
  /** Index into {@link City.blocks}. */
  readonly block: number;
  readonly use: CityUse;
  /** The lot's outline `[x, z]`, counter-clockwise from above. */
  readonly polygon: readonly (readonly [number, number])[];
}
/** One building of the city. */
export interface CityBuilding {
  /** Index into {@link City.lots}. */
  readonly lot: number;
  readonly use: CityUse;
  /** Pass to `generateBuilding`; `buildCity` sets its `detail` and `interior`. */
  readonly options: BuildingRuleOptions & {
    readonly style: BuildingStyle;
    readonly width: number;
    readonly depth: number;
    readonly storeys: readonly number[];
    readonly origin: readonly [number, number, number];
    readonly yaw: number;
    readonly seed: number;
  };
}
/** A place for a street tree or a lamp. */
export interface CityProp {
  /** Ground point on the pavement, world `[x, y, z]`. */
  readonly position: readonly [number, number, number];
  /** Turn about +y, radians: +z faces the road. */
  readonly yaw: number;
  /** Size: a tree's over a 7.4 m broadleaf (street trees 0.55, park trees 0.7 to 1.1); lamps 1. */
  readonly scale: number;
}
/** A city from {@link generateCity}. */
export interface City {
  /** The options after defaults. */
  readonly options: Readonly<
    Required<Omit<CityOptions, 'signal' | 'styles' | 'outline' | 'setback' | 'spacing'>> &
      Pick<CityOptions, 'styles' | 'setback' | 'spacing'>
  >;
  /** The edge of the asphalt `[x, z]`, counter-clockwise from above: half a street outside the outline. */
  readonly edge: readonly (readonly [number, number])[];
  /** Junctions and road ends `[x, z]`. */
  readonly nodes: readonly (readonly [number, number])[];
  readonly roads: readonly CityRoad[];
  readonly blocks: readonly CityBlock[];
  readonly lots: readonly CityLot[];
  readonly buildings: readonly CityBuilding[];
  readonly trees: readonly CityProp[];
  readonly lamps: readonly CityProp[];
}

const LIMIT_BLOCKS = 20000;
const LIMIT_LOTS = 60000;
const invalid = (name: string, rule: string) =>
  fault('failed', `Invalid city option ${name}; use ${rule}`, 'procedural');

const ERA_STYLES: Record<CityEra, Record<Exclude<CityUse, 'park'>, Partial<Record<BuildingStyle, number>>>> = {
  modern: {
    downtown: { 'japan-2011-concrete': 1 },
    commercial: { 'japan-2011-concrete': 3, 'japan-2011-house': 1 },
    residential: { 'japan-2011-house': 1 },
    industrial: { 'japan-2011-warehouse': 1 },
  },
  'western-1910': {
    downtown: { 'western-1910-brick': 1 },
    commercial: { 'western-1910-brick': 1, 'western-1910-false-front': 2 },
    residential: { 'western-1910-house': 1 },
    industrial: { 'western-1910-depot': 1 },
  },
};
/** Styles that grow with the downtown's height; the others keep their own storeys. */
const TALL: ReadonlySet<BuildingStyle> = new Set(['japan-2011-concrete', 'western-1910-brick']);
const HOUSES: ReadonlySet<BuildingStyle> = new Set(['japan-2011-house', 'western-1910-house']);

type Resolved = City['options'] & { outline: V2[] };

function resolve(options: CityOptions): Resolved {
  if (typeof options !== 'object' || options === null) throw invalid('options', 'an object');
  const o = options as Record<string, unknown>;
  const num = (name: string, lo: number, hi: number, fallback: number, integer = false): number => {
    const v = o[name];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !(v >= lo && v <= hi) || (integer && !Number.isInteger(v)))
      throw invalid(name, `${integer ? 'an integer' : 'a number'} from ${lo} to ${hi}`);
    return v;
  };
  const pick = <T extends string>(name: string, all: readonly T[], fallback: T): T => {
    const v = o[name];
    if (v === undefined) return fallback;
    if (!all.includes(v as T)) throw invalid(name, `one of ${all.join(', ')}`);
    return v as T;
  };
  const point = (v: unknown, limit: number): v is V2 =>
    Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Math.abs(x) <= limit);
  let width = num('width', 60, 4000, 400),
    depth = num('depth', 60, 4000, 400),
    outline: V2[] = [
      [-width / 2, -depth / 2],
      [width / 2, -depth / 2],
      [width / 2, depth / 2],
      [-width / 2, depth / 2],
    ];
  if (options.outline !== undefined) {
    const p = options.outline;
    const rule = 'a convex polygon of 3 to 64 corners [x, z] within 2000 of zero, at least 60 across';
    if (!Array.isArray(p) || p.length < 3 || p.length > 64 || !p.every((q) => point(q, 2000)))
      throw invalid('outline', rule);
    outline = p.map((q): V2 => [q[0], q[1]]);
    if (area(outline) < 0) outline.reverse();
    let turn = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = sub2(outline[(i + 1) % outline.length], outline[i]),
        b = sub2(outline[(i + 2) % outline.length], outline[(i + 1) % outline.length]),
        cross = a[0] * b[1] - a[1] * b[0];
      if (length2(a) < 1 || cross < -1e-6) throw invalid('outline', rule);
      turn += Math.atan2(cross, dot2(a, b));
    }
    // A star turns left at every corner too, but goes round more than once.
    if (Math.abs(turn - 2 * Math.PI) > 1e-3 || minWidth(outline) < 60) throw invalid('outline', rule);
    const [a, b, c, d] = extent(outline, [1, 0]);
    width = b - a;
    depth = d - c;
  }
  const era = pick('era', ['modern', 'western-1910'], 'modern'),
    streetWidth = num('streetWidth', 4, 30, 8),
    minStoreys = num('minStoreys', 1, 60, 2, true),
    treeSpacing = num('treeSpacing', 0, 100, 11),
    lampSpacing = num('lampSpacing', 0, 200, 30);
  if (treeSpacing > 0 && treeSpacing < 1) throw invalid('treeSpacing', '0 or a number from 1 to 100');
  if (lampSpacing > 0 && lampSpacing < 1) throw invalid('lampSpacing', '0 or a number from 1 to 200');
  const centre = options.centre ?? centroid(outline);
  if (!point(centre, 4000)) throw invalid('centre', 'a point [x, z]');
  if (options.centre !== undefined) {
    const inside = outline.every((a, i) => {
      const n = left(unit2(sub2(outline[(i + 1) % outline.length], a)));
      return dot2(n, sub2(centre, a)) > 0;
    });
    if (!inside) throw invalid('centre', 'a point inside the outline');
  }
  const origin = options.origin ?? [0, 0, 0];
  if (
    !Array.isArray(origin) ||
    origin.length !== 3 ||
    !origin.every((v) => typeof v === 'number' && Math.abs(v) <= 90000)
  )
    throw invalid('origin', '3 numbers within 90000 of zero');
  if (options.styles !== undefined) {
    const rule = 'an object of uses, each an object of building styles to weights of 0 or more, one above 0';
    if (typeof options.styles !== 'object' || options.styles === null) throw invalid('styles', rule);
    for (const [use, set] of Object.entries(options.styles)) {
      const entries = Object.entries(set ?? {}) as [BuildingStyle, number][];
      if (
        !Object.hasOwn(ERA_STYLES.modern, use) ||
        !entries.every(([k, w]) => BUILDING_STYLES.includes(k) && Number.isFinite(w) && w >= 0) ||
        !entries.some(([, w]) => w > 0)
      )
        throw invalid('styles', rule);
    }
  }
  return {
    width,
    depth,
    outline,
    layout: pick('layout', ['grid', 'organic', 'radial'], 'grid'),
    blockWidth: num('blockWidth', 30, 500, 90),
    blockDepth: num('blockDepth', 30, 500, 60),
    angle: num('angle', -2 * Math.PI, 2 * Math.PI, 0),
    irregularity: num('irregularity', 0, 1, 0.25),
    streetWidth,
    avenueWidth: num('avenueWidth', streetWidth, 60, Math.max(16, streetWidth)),
    avenueEvery: num('avenueEvery', 0, 100, 4, true),
    spokes: num('spokes', 3, 24, 8, true),
    sidewalk: num('sidewalk', 0, 8, 2.5),
    curb: num('curb', 0, 0.5, 0.15),
    lotFrontage: num('lotFrontage', 6, 200, 18),
    lotDepth: num('lotDepth', 8, 120, 26),
    setback: options.setback === undefined ? undefined : num('setback', 0, 20, 0),
    spacing: options.spacing === undefined ? undefined : num('spacing', 0, 20, 0),
    centre: [centre[0], centre[1]],
    downtownRadius: num('downtownRadius', 0, 4000, 0.22 * Math.min(width, depth)),
    minStoreys,
    maxStoreys: num('maxStoreys', minStoreys, 60, Math.max(minStoreys, era === 'modern' ? 24 : 4), true),
    parks: num('parks', 0, 1, 0.08),
    industry: num('industry', 0, 1, 0.15),
    era,
    styles: options.styles,
    treeSpacing,
    lampSpacing,
    origin: [origin[0], origin[1], origin[2]],
    seed: num('seed', -0x80000000, 0xffffffff, 1, true),
  };
}

/** A straight cut or edge of the town: a road before it is divided at its junctions. */
interface Chord {
  a: V2;
  b: V2;
  avenue: boolean;
}
interface Plan {
  chords: Chord[];
  areas: Poly[];
  /** Index into `areas` of the radial layout's central square. */
  square?: number;
}

/** The two ends of the edge labelled `label`. */
function chordOf(poly: Poly, label: number): [V2, V2] | undefined {
  const i = poly.e.indexOf(label);
  return i < 0 ? undefined : [poly.p[i], poly.p[(i + 1) % poly.p.length]];
}
/** Cuts one area by a road; keeps it whole when a side would be narrower than `least`. */
function cut(plan: Plan, poly: Poly, at: V2, dir: V2, avenue: boolean, least: number): [Poly, Poly] | undefined {
  const label = plan.chords.length,
    [a, b] = split(poly, at, dir, label);
  if (!a.p.length || !b.p.length || minWidth(a.p) < least || minWidth(b.p) < least) return undefined;
  const ends = chordOf(a, label);
  if (!ends) return undefined;
  plan.chords.push({ a: ends[0], b: ends[1], avenue });
  if (plan.chords.length > LIMIT_BLOCKS * 2) throw tooMany();
  return [a, b];
}
const tooMany = () =>
  fault(
    'failed',
    `A city holds at most ${LIMIT_BLOCKS} blocks and ${LIMIT_LOTS} lots; use larger blocks or lots`,
    'procedural',
  );

/** Recursive cuts until every piece is near the block size (Yang et al. 2013's domain splitting, with straight cuts). */
function subdivide(
  plan: Plan,
  start: Poly,
  o: Resolved,
  rand: () => number,
  irregularity: number,
  avenueLevels: number,
  out: Poly[],
): void {
  const long = Math.max(o.blockWidth, o.blockDepth),
    short = Math.min(o.blockWidth, o.blockDepth),
    least = o.streetWidth + 2 * o.sidewalk + 10,
    queue: [Poly, number][] = [[start, 0]];
  for (let head = 0; head < queue.length; head++) {
    const [poly, level] = queue[head],
      box = orientedBox(poly.p),
      overLong = box.long / (long + o.streetWidth),
      overShort = box.short / (short + o.streetWidth);
    let pieces: [Poly, Poly] | undefined;
    if (Math.max(overLong, overShort) > 1.5) {
      // Across whichever side is furthest over its target.
      const across = overLong >= overShort ? box.u : left(box.u),
        size = overLong >= overShort ? box.long : box.short;
      for (let attempt = 0; attempt < 4 && !pieces; attempt++) {
        const wild = attempt < 3 ? irregularity / (attempt + 1) : 0,
          shift = (rand() - 0.5) * 0.4 * wild,
          turn = (rand() - 0.5) * 0.6 * wild,
          along = left(across),
          c = Math.cos(turn),
          s = Math.sin(turn);
        pieces = cut(
          plan,
          poly,
          add2(box.middle, mul2(across, shift * size)),
          [along[0] * c - along[1] * s, along[0] * s + along[1] * c],
          level < avenueLevels,
          least,
        );
      }
    }
    if (pieces) queue.push([pieces[0], level + 1], [pieces[1], level + 1]);
    else out.push(poly);
    if (queue.length > LIMIT_BLOCKS * 2) throw tooMany();
  }
}

function planStreets(o: Resolved, rand: () => number): Plan {
  const plan: Plan = { chords: [], areas: [] },
    town: Poly = { p: o.outline, e: [] };
  town.e = o.outline.map((a, i) => {
    plan.chords.push({ a, b: o.outline[(i + 1) % o.outline.length], avenue: false });
    return i;
  });
  const least = o.streetWidth + 2 * o.sidewalk + 10;
  if (o.layout === 'organic') {
    subdivide(plan, town, o, rand, o.irregularity, o.avenueEvery ? 2 : 0, plan.areas);
  } else if (o.layout === 'grid') {
    const u: V2 = [Math.cos(o.angle), Math.sin(o.angle)],
      v = left(u),
      [a, b, c, d] = extent(o.outline, u);
    let areas = [town];
    for (const [axis, along, lo, hi, block] of [
      [u, v, a, b, o.blockWidth],
      [v, u, c, d, o.blockDepth],
    ] as const) {
      const count = Math.max(1, Math.round((hi - lo) / (block + o.streetWidth))),
        pitch = (hi - lo) / count;
      if (count > LIMIT_BLOCKS) throw tooMany();
      for (let k = 1; k < count; k++) {
        const offset = lo + k * pitch + (rand() - 0.5) * 0.4 * o.irregularity * pitch,
          avenue = o.avenueEvery > 0 && (k - Math.floor(count / 2)) % o.avenueEvery === 0,
          next: Poly[] = [];
        for (const poly of areas) {
          const pieces = cut(plan, poly, mul2(axis, offset), along, avenue, least);
          if (pieces) next.push(...pieces);
          else next.push(poly);
        }
        areas = next;
        if (areas.length > LIMIT_BLOCKS) throw tooMany();
      }
    }
    plan.areas = areas;
  } else {
    const centre = o.centre,
      step = (2 * Math.PI) / o.spokes,
      angles = Array.from(
        { length: o.spokes },
        (_, k) => o.angle + k * step + (rand() - 0.5) * 0.3 * o.irregularity * step,
      ),
      ray = (k: number): V2 => [Math.cos(angles[k % o.spokes]), Math.sin(angles[k % o.spokes])],
      sectors = angles.map((a, k) => {
        const next = k + 1 < o.spokes ? angles[k + 1] : angles[0] + 2 * Math.PI,
          middle = (a + next) / 2;
        return { bisector: [Math.cos(middle), Math.sin(middle)] as V2, cos: Math.cos((next - a) / 2) };
      });
    // How far a point on spoke k can go before it leaves the town.
    const reach = (dir: V2): number => {
      let best = Infinity;
      o.outline.forEach((a, i) => {
        const n = left(unit2(sub2(o.outline[(i + 1) % o.outline.length], a))),
          toward = dot2(n, dir);
        if (toward < -1e-12) best = Math.min(best, dot2(n, sub2(a, centre)) / toward);
      });
      return best;
    };
    const square = Math.min(
        0.6 * o.blockDepth + o.streetWidth / 2,
        0.4 * Math.min(...angles.map((_, k) => reach(ray(k)))),
      ),
      spoke = angles.map((_, k) => {
        const dir = ray(k);
        plan.chords.push({
          a: add2(centre, mul2(dir, square)),
          b: add2(centre, mul2(dir, reach(dir))),
          avenue: o.avenueEvery > 0,
        });
        return plan.chords.length - 1;
      }),
      first = sectors.map((_, k) => {
        const a = add2(centre, mul2(ray(k), square)),
          b = add2(centre, mul2(ray(k + 1), square));
        plan.chords.push({ a, b, avenue: o.avenueEvery > 0 });
        return plan.chords.length - 1;
      });
    let middle = town;
    sectors.forEach(({ bisector: n, cos }, k) => {
      middle = clipHalf(middle, [-n[0], -n[1]], -(dot2(n, centre) + square * cos), first[k]);
    });
    if (middle.p.length) {
      plan.square = 0;
      plan.areas.push(middle);
    }
    sectors.forEach(({ bisector: n, cos }, k) => {
      const from = ray(k),
        to = ray(k + 1);
      let rest = clipHalf(town, left(from), dot2(left(from), centre), spoke[k]);
      const back: V2 = [to[1], -to[0]];
      rest = clipHalf(rest, back, dot2(back, centre), spoke[(k + 1) % o.spokes]);
      rest = clipHalf(rest, n, dot2(n, centre) + square * cos, first[k]);
      const along = left(n),
        rings: Poly[] = [];
      for (let ring = 1; rest.p.length; ring++) {
        if (ring > 400) throw tooMany();
        const radius = square + ring * (o.blockDepth + o.streetWidth),
          pieces = cut(
            plan,
            rest,
            add2(centre, mul2(n, radius * cos)),
            along,
            o.avenueEvery > 0 && ring % o.avenueEvery === 0,
            least,
          );
        if (!pieces) break;
        // The side of the ring road nearer the centre is done; the cut goes on outward.
        const near = dot2(n, centroid(pieces[0].p)) < dot2(n, centroid(pieces[1].p)) ? 0 : 1;
        rings.push(pieces[near]);
        rest = pieces[1 - near];
      }
      if (rest.p.length) rings.push(rest);
      // Wide outer pieces get side streets.
      const sideways = { ...o, blockDepth: o.blockWidth };
      for (const piece of rings) subdivide(plan, piece, sideways, rand, o.irregularity * 0.3, 0, plan.areas);
    });
  }
  return plan;
}

/** The roads between junctions: every chord divided where other chords end on it, near points joined into one node. */
function roadGraphOf(plan: Plan, o: Resolved): { nodes: V2[]; roads: CityRoad[] } {
  const cell = 32,
    key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`,
    buckets = new Map<string, number[]>(),
    nodes: V2[] = [],
    join = o.streetWidth / 2;
  const nodeAt = (q: V2): number => {
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const k of buckets.get(key(q[0] + dx * cell, q[1] + dz * cell)) ?? [])
          if (Math.hypot(nodes[k][0] - q[0], nodes[k][1] - q[1]) <= join) return k;
    const at = key(q[0], q[1]),
      list = buckets.get(at);
    if (list) list.push(nodes.length);
    else buckets.set(at, [nodes.length]);
    nodes.push(q);
    return nodes.length - 1;
  };
  const ends = new Map<string, V2[]>();
  for (const { a, b } of plan.chords)
    for (const q of [a, b]) {
      const at = key(q[0], q[1]),
        list = ends.get(at);
      if (list) list.push(q);
      else ends.set(at, [q]);
    }
  const roads = new Map<string, CityRoad>();
  for (const { a, b, avenue } of plan.chords) {
    const d = sub2(b, a),
      l = length2(d);
    if (l < 1e-6) continue;
    const u = mul2(d, 1 / l),
      n = left(u),
      seen = new Set<string>(),
      on: [number, V2][] = [];
    for (let s = 0; ; s += cell / 2) {
      const q = add2(a, mul2(u, Math.min(s, l)));
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          const at = key(q[0] + dx * cell, q[1] + dz * cell);
          if (seen.has(at)) continue;
          seen.add(at);
          for (const e of ends.get(at) ?? []) {
            const w = sub2(e, a),
              t = dot2(w, u);
            if (Math.abs(dot2(w, n)) < 0.01 && t > -0.01 && t < l + 0.01) on.push([t, e]);
          }
        }
      if (s >= l) break;
    }
    on.sort((p, q) => p[0] - q[0]);
    let before = -1;
    for (const [, q] of on) {
      const node = nodeAt(q);
      if (before >= 0 && node !== before) {
        const id = before < node ? `${before},${node}` : `${node},${before}`,
          old = roads.get(id);
        if (!old || (avenue && old.kind === 'street'))
          roads.set(id, {
            from: before,
            to: node,
            width: avenue ? o.avenueWidth : o.streetWidth,
            kind: avenue ? 'avenue' : 'street',
            length: Math.hypot(nodes[node][0] - nodes[before][0], nodes[node][1] - nodes[before][1]),
          });
      }
      before = node;
    }
  }
  return { nodes, roads: [...roads.values()] };
}

/** Lots by cutting the oriented box across its long side, every lot on a street (Vanegas et al. 2012). */
function lotsOf(inner: Poly, frontage: number, depth: number, irregularity: number, rand: () => number): Poly[] {
  // Edges labelled 0 or more lie on a street; cuts between lots are -1.
  const out: Poly[] = [],
    queue = [inner],
    street = Math.max(5, frontage * 0.4);
  const onStreet = (p: Poly) =>
    p.e.some((label, i) => label >= 0 && length2(sub2(p.p[(i + 1) % p.p.length], p.p[i])) >= street);
  for (let head = 0; head < queue.length; head++) {
    const poly = queue[head],
      box = orientedBox(poly.p);
    let pieces: [Poly, Poly] | undefined;
    if (box.long > 1.6 * frontage || box.short > 1.6 * depth || area(poly.p) > 1.8 * frontage * depth) {
      for (const [axis, size] of [
        [box.u, box.long],
        [left(box.u), box.short],
      ] as const) {
        if (size < 12) continue;
        const shift = (rand() - 0.5) * 0.3 * irregularity,
          [a, b] = split(poly, add2(box.middle, mul2(axis, shift * size)), left(axis), -1);
        if (a.p.length && b.p.length && onStreet(a) && onStreet(b) && minWidth(a.p) >= 6 && minWidth(b.p) >= 6) {
          pieces = [a, b];
          break;
        }
      }
    }
    if (pieces) queue.push(...pieces);
    else out.push(poly);
    if (queue.length > LIMIT_LOTS) throw tooMany();
  }
  return out;
}

/**
 * How far a style's porch or stoop with its steps or ramp, balcony, awning and eaves reach past its footprint at the
 * front, and its eaves at the sides, by the sizes `generateBuilding` builds them with.
 */
function reach(style: BuildingStyle): { front: number; side: number } {
  const s = BUILDING_STYLE_SETS[style],
    stairs = Math.ceil(s.plinth / 0.18 - 1e-9) * 0.28,
    entry = s.porch
      ? s.porch + (s.plinth > 0.3 ? stairs : 0)
      : s.plinth < 0.05
        ? 0
        : s.door[0] > 2.2
          ? 8 * s.plinth
          : 1 + stairs,
    eaves = s.overhang + 0.35;
  return { front: Math.max(eaves, entry + 0.1, s.balcony + 0.15, s.awning ? 2 : 0), side: eaves };
}

/**
 * A city: streets by the layout, blocks between them, parks and land use by distance from the centre, lots along the
 * streets, one building's options per lot and places for street trees and lamps. The same options give the same city.
 * The ground is flat. Pass the result to `buildCity` for meshes, or draw the data your own way.
 * @throws MargoError `failed` for a bad option or past 20000 blocks or 60000 lots; the signal's reason when aborted.
 */
export function generateCity(options: CityOptions = {}): City {
  options?.signal?.throwIfAborted();
  const o = resolve(options),
    rand = random(o.seed ^ 0x43697479),
    plan = planStreets(o, rand);
  options.signal?.throwIfAborted();
  const [ox, oy, oz] = o.origin,
    world = (q: V2): V2 => [q[0] + ox, q[1] + oz],
    // Polygons go out counter-clockwise from above, which is clockwise in (x, z).
    ring = (p: readonly V2[]) => p.map(world).reverse(),
    width = (label: number) => (plan.chords[label].avenue ? o.avenueWidth : o.streetWidth),
    { nodes, roads } = roadGraphOf(plan, o);

  const kept: { kerb: Poly; inner: Poly; centre: V2 }[] = [],
    middles: number[] = [];
  plan.areas.forEach((poly, index) => {
    const kerb = inset(poly, (label) => width(label) / 2);
    if (!kerb.p.length || area(kerb.p) < 40 || minWidth(kerb.p) < 4) return;
    if (index === plan.square) middles.push(kept.length);
    kept.push({ kerb, inner: inset(kerb, () => o.sidewalk), centre: centroid(kerb.p) });
    if (kept.length > LIMIT_BLOCKS) throw tooMany();
  });

  // Land use: parks spread by the seed, downtown and the commercial ring by distance, industry on one side.
  const order = kept.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const parks = new Set<number>(o.parks > 0 ? middles : []);
  const wanted = Math.round(o.parks * kept.length);
  for (const i of order) {
    if (parks.size >= wanted) break;
    parks.add(i);
  }
  const side = rand() * 2 * Math.PI - Math.PI,
    uses = kept.map(({ centre }, i): CityUse => {
      if (parks.has(i)) return 'park';
      const dx = centre[0] - o.centre[0],
        dz = centre[1] - o.centre[1],
        d = Math.hypot(dx, dz),
        R = o.downtownRadius;
      if (d < R) return 'downtown';
      const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(dz, dx) - side), Math.cos(Math.atan2(dz, dx) - side)));
      if (d > 1.5 * R && turn < Math.PI * o.industry) return 'industrial';
      return d < 2 * R ? 'commercial' : 'residential';
    });

  const blocks: CityBlock[] = [],
    lots: CityLot[] = [],
    buildings: CityBuilding[] = [],
    trees: CityProp[] = [],
    lamps: CityProp[] = [],
    ground = oy + o.curb;

  const place = (list: CityProp[], at: V2, toRoad: V2, scale: number) =>
    list.push({ position: [at[0] + ox, ground, at[1] + oz], yaw: Math.atan2(toRoad[0], toRoad[1]), scale });

  kept.forEach(({ kerb, inner, centre }, b) => {
    if (!(b & 63)) options.signal?.throwIfAborted();
    const use = uses[b];
    blocks.push({
      use,
      polygon: ring(kerb.p),
      inner: ring(inner.p),
      centre: world(centre),
      area: area(kerb.p),
    });
    // Street furniture along the kerb, clear of the corners.
    for (let i = 0; i < kerb.p.length; i++) {
      const a = kerb.p[i],
        d = sub2(kerb.p[(i + 1) % kerb.p.length], a),
        l = length2(d),
        u = unit2(d),
        n = left(u),
        out: V2 = [-n[0], -n[1]];
      if (o.sidewalk < 1.2) continue;
      for (const [list, spacing, off, shift] of [
        [trees, o.treeSpacing, 0.8, 0.5],
        [lamps, o.lampSpacing, 0.45, 0.25],
      ] as const) {
        if (!spacing || (use === 'industrial' && list === trees)) continue;
        const count = Math.floor((l - 8) / spacing);
        for (let k = 0; k < count; k++) {
          const s = 4 + ((l - 8) / count) * (k + shift);
          place(list, add2(add2(a, mul2(u, s)), mul2(n, off)), out, list === trees ? 0.55 : 1);
        }
      }
    }
    if (!inner.p.length || area(inner.p) < 60) return;
    if (use === 'park') {
      // A loose wood: one tree in most cells of a 9 m grid, kept 2 m inside the pavement.
      const wood = inset(inner, () => 2);
      if (!wood.p.length || !o.treeSpacing) return;
      const [x0, x1, z0, z1] = extent(wood.p, [1, 0]);
      for (let x = x0; x < x1; x += 9)
        for (let z = z0; z < z1; z += 9) {
          const q: V2 = [x + rand() * 7, z + rand() * 7],
            inside = wood.p.every((a, i) => {
              const n = left(unit2(sub2(wood.p[(i + 1) % wood.p.length], a)));
              return dot2(n, sub2(q, a)) >= 0;
            });
          if (inside && rand() < 0.8)
            place(trees, q, [Math.sin(rand() * 6.283), Math.cos(rand() * 6.283)], 0.7 + rand() * 0.4);
        }
      return;
    }
    const scale = use === 'downtown' ? 1.4 : use === 'residential' ? 0.8 : use === 'industrial' ? 2 : 1,
      streets: Poly = { p: inner.p, e: inner.e.map(() => 0) };
    for (const lot of lotsOf(
      streets,
      o.lotFrontage * scale,
      o.lotDepth * (use === 'industrial' ? 1.5 : 1),
      o.irregularity,
      rand,
    )) {
      // The longest street edge is the front.
      let front = -1,
        most = 0;
      for (let i = 0; i < lot.p.length; i++) {
        const l = length2(sub2(lot.p[(i + 1) % lot.p.length], lot.p[i]));
        if (lot.e[i] >= 0 && l > most) {
          most = l;
          front = i;
        }
      }
      if (front < 0) continue;
      const weights = Object.entries(o.styles?.[use] ?? ERA_STYLES[o.era][use]) as [BuildingStyle, number][];
      let r = rand() * weights.reduce((sum, [, w]) => sum + w, 0),
        style = weights[0][0];
      for (const [k, w] of weights) {
        if ((r -= w) < 0) {
          style = k;
          break;
        }
      }
      const set = BUILDING_STYLE_SETS[style],
        house = HOUSES.has(style),
        past = reach(style),
        along = unit2(sub2(lot.p[(front + 1) % lot.p.length], lot.p[front])),
        inward = left(along),
        room = inset(lot, (label, i) => {
          // How far the eaves, porch and steps reach toward this edge: the building's box grown by them, seen along
          // the edge's normal, so a slanted boundary keeps their corners off too.
          const n = left(unit2(sub2(lot.p[(i + 1) % lot.p.length], lot.p[i]))),
            ahead = dot2(n, inward),
            grown = past.side * Math.abs(dot2(n, along)) + (ahead > 0 ? past.front : past.side) * Math.abs(ahead),
            kept =
              i === front
                ? (o.setback ?? (house ? 2 : 0))
                : Math.max(label >= 0 ? (o.setback ?? 0) : 0, (o.spacing ?? (use === 'downtown' ? 0 : 1)) / 2);
          return Math.max(grown, kept);
        }),
        rect = frontRect(
          room.p,
          along,
          3,
          house ? set.width * (1.05 + rand() * 0.3) : 120,
          house ? set.depth * (1.05 + rand() * 0.3) : Math.min(120, o.lotDepth * (use === 'industrial' ? 1.5 : 1)),
        ),
        frontPoint = lot.p[front],
        middle = rect ? (rect.s0 + rect.s1) / 2 : dot2(centroid(lot.p), along),
        deep = rect ? (rect.t0 + rect.t1) / 2 : dot2(centroid(lot.p), inward),
        at = add2(mul2(along, middle), mul2(inward, deep)),
        size: V2 = rect
          ? [rect.s1 - rect.s0, rect.t1 - rect.t0]
          : [length2(sub2(lot.p[(front + 1) % lot.p.length], frontPoint)), 0],
        index = lots.length,
        out: V2 = [-inward[0], -inward[1]];
      lots.push({
        block: b,
        use,
        polygon: ring(lot.p),
        centre: world(at),
        size,
        along,
        front: out,
        floor: ground,
      });
      if (lots.length > LIMIT_LOTS) throw tooMany();
      if (!rect) continue;
      const lower = set.storeys[0],
        upper = set.storeys[set.storeys.length - 1];
      let count = set.storeys.length;
      if (TALL.has(style) && (use === 'downtown' || use === 'commercial')) {
        const d = Math.hypot(at[0] - o.centre[0], at[1] - o.centre[1]) / Math.max(1, o.downtownRadius),
          peak = o.downtownRadius > 0 ? Math.exp(-d * d) : 0,
          tall = o.minStoreys + (o.maxStoreys - o.minStoreys) * peak * (0.45 + 0.55 * rand());
        // A narrow footprint does not carry a tower.
        count = Math.max(
          o.minStoreys,
          Math.min(Math.round(tall), Math.max(o.minStoreys, Math.floor(Math.min(...size)))),
        );
      } else if (house) {
        count = rand() < 0.2 ? 1 : 2;
      }
      const storeys = Array.from({ length: count }, (_, k) => (k ? upper : lower)),
        shops = use === 'commercial' && TALL.has(style) && size[0] >= 6;
      buildings.push({
        lot: index,
        use,
        options: {
          style,
          width: size[0],
          depth: size[1],
          storeys,
          origin: [at[0] + ox, ground, at[1] + oz],
          yaw: Math.atan2(out[0], out[1]),
          seed: (Math.imul(o.seed, 31) + index) | 0,
          ...(shops ? { storefront: true, awning: false } : {}),
          // Above the walk-up height the balconies and windows become the strips and floor bands of an office block.
          ...(count > 8
            ? { windowKind: 'strip' as const, bands: true, balcony: 0, parapet: 1.2, roof: 'flat' as const }
            : {}),
          ...(house && style === 'japan-2011-house'
            ? { roof: (['hip', 'gable', 'hip-gable'] as const)[Math.floor(rand() * 3)], pitch: 21.8 + rand() * 4 }
            : {}),
        },
      });
    }
  });

  const { outline, ...settled } = o;
  return {
    options: { ...settled, centre: o.centre },
    edge: ring(outset({ p: outline, e: outline.map(() => 0) }, o.streetWidth / 2).p),
    nodes: nodes.map(world),
    roads,
    blocks,
    lots,
    buildings,
    trees,
    lamps,
  };
}
