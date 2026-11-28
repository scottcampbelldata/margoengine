// Alpine wildflowers (`@margoengine/procedural/forbs`): rosette leaves, stems and flower heads of five forbs of the
// alpine turf, each as up to three parts (foliage, petals, flower centres) in three levels of detail, with measured
// colours. Our own shapes from botanical descriptions: leaves and stem leaves stand on the golden angle (H. Vogel, "A
// better way to construct the sunflower head", Mathematical Biosciences 44, 179-189, 1979; P. Prusinkiewicz and A.
// Lindenmayer, "The Algorithmic Beauty of Plants", Springer, 1990, chapter 4) or in opposite pairs, a leaf is a strip
// along its curved midrib with a width profile and a fold (the parametric leaf of Prusinkiewicz and Lindenmayer, chapter
// 5), and a flower head is a disc with rays, a bell of five lobes, a spike of florets or a cushion (T. Ijiri, S. Owada,
// M. Okabe and T. Igarashi, "Floral diagrams and inflorescences: interactive flower modeling using botanical structural
// constraints", SIGGRAPH 2005). Heights, leaf and head sizes are from the species' floras (see FORB_SPECIES). Metres,
// local origin at the root, +Y up.
import { computeVertexNormals, geometryData, type GeometryData } from '@margoengine/geometry/utils';

/** The forbs drawn: heartleaf arnica, Parry's gentian, alpine aster, American bistort and moss campion. */
export type ForbSpecies = 'arnica' | 'gentian' | 'aster' | 'bistort' | 'campion';
/** A part of a forb that takes one material. */
export type ForbPartName = 'foliage' | 'petals' | 'centres';

/** One material's share of a forb: its colour and roughness and a mesh for each of the three LOD rings. */
export interface ForbPart {
  readonly name: ForbPartName;
  /** Linear sRGB albedo, measured (see {@link FORB_COLORS}). */
  readonly color: readonly [number, number, number];
  /** A plain default: no source here measures it. */
  readonly roughness: number;
  /** Near, middle and far meshes: the same plant with fewer segments and florets further out. */
  readonly rings: readonly [GeometryData, GeometryData, GeometryData];
}
/** A forb: its parts and the bounds every part's `Scatter` shares (`reach` and `sway.height`). */
export interface Forb {
  readonly species: ForbSpecies;
  /** Height of the tallest point, metres. */
  readonly top: number;
  /** Largest distance of any part's vertex from the root, metres: give it to every part as `ScatterOptions.reach`. */
  readonly reach: number;
  readonly parts: readonly ForbPart[];
}
/** Options of {@link forb}. */
export interface ForbOptions {
  /** Variant seed, an integer (default 1): leaf count, lengths and leans follow it. */
  readonly seed?: number;
  /** Multiplies the species' height and every size with it, 0.2 to 5 (default 1). */
  readonly scale?: number;
  /** Flower heads (or flowering stems), 0 to 12 (default the species'). 0 draws a plant not in flower. */
  readonly heads?: number;
}

/**
 * Measured colours, linear sRGB: FReD (Arnold, Faruq, Savolainen, McOwan and Chittka, PLoS ONE 5(12), e14287, 2010)
 * spectra of the named records integrated under a 6504 K black body by @margoengine/optics SpectralIntegrator; the
 * spectra are in test/fixtures/forb-spectra.json and test/forbs.test.js integrates them again.
 */
export const FORB_COLORS = {
  /** Arnica montana ray florets (record 1812). */
  arnicaRay: [0.6815, 0.3375, 0.0042],
  /** Arnica montana disc (records 1813, 1814). */
  arnicaDisc: [0.5614, 0.2632, 0.0182],
  /** Gentiana acaulis and grandiflora corolla, outer side (records 3128, 3644). */
  gentian: [0.0726, 0.0678, 0.1447],
  /** Aster alpinus ray florets (record 3123). */
  asterRay: [0.1969, 0.146, 0.3372],
  /** Aster alpinus disc (record 2180). */
  asterDisc: [0.3254, 0.1614, 0.0219],
  /** Bistorta vivipara flowers (records 1867, 3525). */
  bistort: [0.3711, 0.349, 0.2525],
  /** Silene acaulis flowers (records 1566, 2477). */
  campion: [0.3075, 0.1849, 0.2854],
  /** Upper leaf sides of eight alpine forbs (records 1302, 1303, 1136, 1138, 1868, 2096, 3164, 1356). */
  leaf: [0.1093, 0.1257, 0.0665],
} as const satisfies Record<string, readonly [number, number, number]>;

/** Size of each species, metres, from its flora: flowering height, leaf length and width, heads and head size. */
export const FORB_SPECIES = {
  /** Arnica cordifolia: 10-60 cm; basal leaves heart shaped 4-12 cm; one to three heads, rays 1.5-2.5 cm (Flora of North America 21). */
  arnica: { height: 0.3, leaf: 0.08, width: 0.045, heads: 1, ray: 0.022, disc: 0.009 },
  /** Gentiana parryi: 10-40 cm; opposite leaves 2-4 cm; one to several bells 3-5 cm (Flora of North America 8). */
  gentian: { height: 0.18, leaf: 0.03, width: 0.014, heads: 3, ray: 0.04, disc: 0.012 },
  /** Aster alpinus: 5-25 cm; basal leaves spatulate to 8 cm; one head, rays 1-2 cm (Flora Europaea 4). */
  aster: { height: 0.15, leaf: 0.06, width: 0.012, heads: 1, ray: 0.016, disc: 0.008 },
  /** Bistorta bistortoides: 20-70 cm; basal leaves 10-25 cm on petioles; spike 2-5 cm by 1-2 cm (Flora of North America 5). */
  bistort: { height: 0.4, leaf: 0.16, width: 0.025, heads: 1, ray: 0.035, disc: 0.008 },
  /** Silene acaulis: cushions 3-8 cm tall and to 30 cm or more across; flowers 1 cm (Flora of North America 5). */
  campion: { height: 0.06, leaf: 0.12, width: 0, heads: 110, ray: 0.006, disc: 0 },
} as const satisfies Record<ForbSpecies, { height: number; leaf: number; width: number; heads: number; ray: number; disc: number }>;

type V3 = [number, number, number];
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** A seeded generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Positions and triangles being gathered into one part's mesh. */
class Builder {
  readonly p: number[] = [];
  readonly i: number[] = [];
  vertex(v: V3): number {
    this.p.push(v[0], v[1], v[2]);
    return this.p.length / 3 - 1;
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.i.push(a, b, c, a, c, d);
  }
  done(): GeometryData {
    const n = this.p.length / 3;
    return computeVertexNormals(geometryData(this.p, new Float32Array(n * 3), new Float32Array(n * 2), this.i));
  }
}

/** Width of a leaf along its length, 0 at the root to 0 at the tip, peaking at 1. */
const PROFILES = {
  /** Heart shaped to ovate: widest low. */
  ovate: (t: number) => Math.sin(Math.PI * t ** 0.65) ** 0.9,
  /** Lanceolate: widest a third up, long taper. */
  lanceolate: (t: number) => Math.sin(Math.PI * t ** 0.8) ** 1.1,
  /** Spatulate: narrow at the root, widest near the round tip. */
  spatulate: (t: number) => Math.sin(Math.PI * t ** 1.6) ** 0.7,
  /** A ray floret: an even strap with a round tip. */
  strap: (t: number) => Math.min(1, 4 * t) * Math.sqrt(Math.max(0, 1 - t ** 4)),
};
type Profile = keyof typeof PROFILES;

/**
 * A leaf or ray: a strip along a midrib from `base`, heading `azimuth` (radians about +Y) at `elevation` above the
 * horizontal and curving down by `droop` radians by its tip, `segments` long, folded by `fold` of its half width
 * along the midrib. The first `petiole` of the length is a stalk 0.12 of the width wide.
 */
function strip(
  b: Builder,
  base: V3,
  azimuth: number,
  elevation: number,
  length: number,
  width: number,
  profile: Profile,
  segments: number,
  droop = 0.3,
  fold = 0.25,
  petiole = 0,
): void {
  const side: V3 = [-Math.sin(azimuth), 0, Math.cos(azimuth)];
  let at: V3 = [...base];
  let previous: [number, number, number] | undefined;
  const step = length / segments;
  for (let s = 0; s <= segments; s++) {
    const t = s / segments,
      lift = elevation - droop * t * t,
      dir: V3 = [Math.cos(lift) * Math.cos(azimuth), Math.sin(lift), Math.cos(lift) * Math.sin(azimuth)];
    if (s) at = [at[0] + dir[0] * step, at[1] + dir[1] * step, at[2] + dir[2] * step];
    const u = petiole > 0 ? Math.max(0, (t - petiole) / (1 - petiole)) : t,
      half = 0.5 * width * (t < petiole ? 0.12 : Math.max(PROFILES[profile](u), s === segments ? 0 : 0.02)),
      // The leaf's own up: perpendicular to the midrib and the side vector.
      up: V3 = [-Math.sin(lift) * Math.cos(azimuth), Math.cos(lift), -Math.sin(lift) * Math.sin(azimuth)],
      edge = (k: number): V3 => [
        at[0] + side[0] * half * k + up[0] * fold * half,
        at[1] + side[1] * half * k + up[1] * fold * half,
        at[2] + side[2] * half * k + up[2] * fold * half,
      ];
    const row: [number, number, number] = [b.vertex(edge(-1)), b.vertex(at), b.vertex(edge(1))];
    if (previous) {
      b.quad(previous[0], row[0], row[1], previous[1]);
      b.quad(previous[1], row[1], row[2], previous[2]);
    }
    previous = row;
  }
}

/**
 * A tapering stem from `base` up to its top, leaning `lean` metres sideways along `azimuth` at the top (a quadratic
 * bow), `radial` sides; returns the top and the direction there.
 */
function stem(b: Builder, base: V3, height: number, radius: number, azimuth: number, lean: number, segments: number, radial: number): { top: V3; at: (t: number) => V3 } {
  const at = (t: number): V3 => [
    base[0] + Math.cos(azimuth) * lean * t * t,
    base[1] + height * t,
    base[2] + Math.sin(azimuth) * lean * t * t,
  ];
  let previous: number[] | undefined;
  for (let s = 0; s <= segments; s++) {
    const t = s / segments,
      c = at(t),
      r = radius * (1 - 0.45 * t),
      row: number[] = [];
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      row.push(b.vertex([c[0] + Math.cos(a) * r, c[1], c[2] + Math.sin(a) * r]));
    }
    if (previous) for (let k = 0; k < radial; k++) b.quad(previous[k], previous[(k + 1) % radial], row[(k + 1) % radial], row[k]);
    previous = row;
  }
  return { top: at(1), at };
}

/** A low dome (flower disc or cushion) of radius `r` and height `h` on `base`, `rings` by `sides`, bumped by `bump`. */
function dome(b: Builder, base: V3, r: number, h: number, rings: number, sides: number, bump = 0, seed = 1): void {
  const next = random(seed),
    jitter = Array.from({ length: (rings + 1) * sides }, () => 1 + bump * (next() * 2 - 1)),
    apex = b.vertex([base[0], base[1] + h, base[2]]);
  let previous: number[] | undefined;
  for (let s = 1; s <= rings; s++) {
    const a = (s / rings) * (Math.PI / 2),
      row: number[] = [];
    for (let k = 0; k < sides; k++) {
      const turn = (k / sides) * Math.PI * 2,
        j = s < rings ? jitter[s * sides + k] : 1;
      row.push(b.vertex([base[0] + Math.cos(turn) * Math.sin(a) * r * j, base[1] + Math.cos(a) * h * j, base[2] + Math.sin(turn) * Math.sin(a) * r * j]));
    }
    for (let k = 0; k < sides; k++)
      if (previous) b.quad(previous[k], previous[(k + 1) % sides], row[(k + 1) % sides], row[k]);
      else b.i.push(apex, row[(k + 1) % sides], row[k]);
    previous = row;
  }
}

/** A closed oblong spheroid (a bistort spike's core) from `base` up `length`, radius `r`, `rings` along by `sides`. */
function spike(b: Builder, base: V3, length: number, r: number, sides: number, rings: number): void {
  const bottom = b.vertex([base[0], base[1], base[2]]),
    apex = b.vertex([base[0], base[1] + length, base[2]]),
    rows: number[][] = [];
  const n = rings + 2;
  for (let s = 1; s < n; s++) {
    const t = s / n,
      radius = r * Math.sin(Math.PI * t) ** 0.8,
      row: number[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      row.push(b.vertex([base[0] + Math.cos(a) * radius, base[1] + length * t, base[2] + Math.sin(a) * radius]));
    }
    rows.push(row);
  }
  for (let k = 0; k < sides; k++) b.i.push(bottom, rows[0][k], rows[0][(k + 1) % sides]);
  for (let s = 1; s < rows.length; s++)
    for (let k = 0; k < sides; k++) b.quad(rows[s - 1][k], rows[s - 1][(k + 1) % sides], rows[s][(k + 1) % sides], rows[s][k]);
  const last = rows[rows.length - 1];
  for (let k = 0; k < sides; k++) b.i.push(apex, last[(k + 1) % sides], last[k]);
}

/**
 * A bell (gentian corolla) at `base` opening upward: a tube from radius `r0` flaring to `r1` over `length`, its rim cut
 * into five pointed lobes. `sides` around (a multiple of 5) and `rings` along.
 */
function bell(b: Builder, base: V3, length: number, r0: number, r1: number, sides: number, rings: number): void {
  let previous: number[] | undefined;
  for (let s = 0; s <= rings; s++) {
    const t = s / rings,
      row: number[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2,
        lobe = Math.cos((5 * a) / 2) ** 2,
        rim = Math.max(0, (t - 0.7) / 0.3),
        r = r0 + (r1 - r0) * t * t + 0.25 * r1 * rim * lobe,
        y = length * t * (1 + 0.18 * rim * (lobe - 0.5));
      row.push(b.vertex([base[0] + Math.cos(a) * r, base[1] + y, base[2] + Math.sin(a) * r]));
    }
    if (previous) for (let k = 0; k < sides; k++) b.quad(previous[k], previous[(k + 1) % sides], row[(k + 1) % sides], row[k]);
    previous = row;
  }
}

/** A five-petalled flat flower (campion) at `c` facing `n`, radius `r`. */
function star(b: Builder, c: V3, n: V3, r: number): void {
  const t: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u: V3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  const ul = Math.hypot(...u),
    e1: V3 = [u[0] / ul, u[1] / ul, u[2] / ul],
    e2: V3 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]],
    centre = b.vertex([c[0] + n[0] * r * 0.15, c[1] + n[1] * r * 0.15, c[2] + n[2] * r * 0.15]),
    rim: number[] = [];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2,
      d = k % 2 ? r * 0.45 : r;
    rim.push(b.vertex([c[0] + (e1[0] * Math.cos(a) + e2[0] * Math.sin(a)) * d, c[1] + (e1[1] * Math.cos(a) + e2[1] * Math.sin(a)) * d, c[2] + (e1[2] * Math.cos(a) + e2[2] * Math.sin(a)) * d]));
  }
  for (let k = 0; k < 10; k++) b.i.push(centre, rim[k], rim[(k + 1) % 10]);
}

/**
 * Appends `src`, built upright about the origin, to `dst` turned so +Y points along unit `n` (the shortest rotation,
 * Rodrigues' formula) and moved to `at`: a nodding head or a bell turned on its stalk.
 */
function place(dst: Builder, src: Builder, at: V3, n: V3): void {
  const c = n[1],
    k: V3 = [n[2], 0, -n[0]],
    s = Math.hypot(k[0], k[2]),
    base = dst.p.length / 3;
  if (s > 1e-6) {
    k[0] /= s;
    k[2] /= s;
  }
  for (let i = 0; i < src.p.length; i += 3) {
    const v: V3 = [src.p[i], src.p[i + 1], src.p[i + 2]];
    let r: V3 = v;
    if (s > 1e-6) {
      const kv = k[0] * v[0] + k[2] * v[2],
        x: V3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
      r = [0, 1, 2].map((j) => v[j] * c + x[j] * s + k[j] * kv * (1 - c)) as V3;
    }
    dst.vertex([r[0] + at[0], r[1] + at[1], r[2] + at[2]]);
  }
  for (const i of src.i) dst.i.push(i + base);
}

/** A unit direction `tilt` radians off +Y toward azimuth `az`. */
const nod = (az: number, tilt: number): V3 => [Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az)];

/**
 * A composite head (arnica, aster) at `top`, facing `n`: a domed disc and `rays` ray florets on the golden angle, each
 * rising from the disc's rim, then spreading and drooping a little at its tip, so the head reads as a flower from the
 * side too, not a flat disc. In the far ring (`d` under 0.5) the rays are 1.3 times as long and 1.4 times as wide,
 * so the head keeps its coloured area when the camera sees it at a few pixels.
 */
function head(petals: Builder, centres: Builder, top: V3, n: V3, disc: number, rays: number, ray: number, width: number, d: number, next: () => number): void {
  const p = new Builder(),
    c = new Builder(),
    far = d < 0.5,
    length = ray * (far ? 1.3 : 1),
    wide = width * (far ? 1.4 : 1);
  dome(c, [0, -disc * 0.2, 0], disc, disc * 0.8, Math.max(1, Math.round(3 * d)), Math.max(5, Math.round(10 * d)));
  for (let k = 0; k < rays; k++) {
    const az = k * GOLDEN * 2.0 + next() * 0.15;
    strip(p, [Math.cos(az) * disc * 0.85, 0, Math.sin(az) * disc * 0.85], az, 0.32 + next() * 0.2, length * (0.85 + 0.3 * next()), wide * (0.8 + 0.4 * next()), 'strap', Math.max(2, Math.round(4 * d)), 0.55, 0.22);
  }
  place(petals, p, top, n);
  place(centres, c, top, n);
}

/** Detail of the near, middle and far rings. */
const DETAIL = [1, 0.5, 0.2] as const;

/**
 * Builds a forb of `species` as up to three parts (foliage, petals, flower centres), each in three LOD rings, with
 * measured colours. Draw each part as a `Scatter` with the same seed, placement, `reach` and `sway.height` (see the
 * README), so every part keeps the same plants.
 * @throws RangeError for an unknown species or options out of range.
 */
export function forb(species: ForbSpecies, options: ForbOptions = {}): Forb {
  const spec = FORB_SPECIES[species];
  if (!spec) throw new RangeError(`Unknown forb species "${String(species)}"; use one of ${Object.keys(FORB_SPECIES).join(', ')}`);
  const { seed = 1, scale = 1, heads = spec.heads } = options;
  if (!Number.isInteger(seed) || !(scale >= 0.2 && scale <= 5) || !Number.isInteger(heads) || heads < 0 || heads > (species === 'campion' ? 400 : 12))
    throw new RangeError('forb needs an integer seed, scale 0.2-5 and heads an integer 0-12 (0-400 for campion)');
  const rings = DETAIL.map((d) => build(species, spec, seed, scale, heads, d));
  const names = ['foliage', 'petals', 'centres'] as const;
  const colors: Record<ForbSpecies, readonly [readonly number[], readonly number[]]> = {
    arnica: [FORB_COLORS.arnicaRay, FORB_COLORS.arnicaDisc],
    gentian: [FORB_COLORS.gentian, FORB_COLORS.gentian],
    aster: [FORB_COLORS.asterRay, FORB_COLORS.asterDisc],
    bistort: [FORB_COLORS.bistort, FORB_COLORS.bistort],
    campion: [FORB_COLORS.campion, FORB_COLORS.campion],
  };
  const parts: ForbPart[] = [];
  let reach = 0,
    top = 0;
  names.forEach((name, k) => {
    if (!rings[0][k].indices.length) return;
    for (const ring of rings)
      for (let i = 0; i < ring[k].positions.length; i += 3) {
        const [x, y, z] = [ring[k].positions[i], ring[k].positions[i + 1], ring[k].positions[i + 2]];
        reach = Math.max(reach, Math.hypot(x, y, z));
        top = Math.max(top, y);
      }
    parts.push({
      name,
      color: (k === 0 ? FORB_COLORS.leaf : colors[species][k - 1]) as unknown as readonly [number, number, number],
      roughness: k === 0 ? 0.55 : 0.6,
      rings: [rings[0][k], rings[1][k], rings[2][k]],
    });
  });
  return { species, top, reach, parts };
}

function build(species: ForbSpecies, spec: (typeof FORB_SPECIES)[ForbSpecies], seed: number, scale: number, heads: number, d: number): [GeometryData, GeometryData, GeometryData] {
  const next = random(seed * 2654435761 + 1013904223),
    foliage = new Builder(),
    petals = new Builder(),
    centres = new Builder(),
    seg = (n: number) => Math.max(1, Math.round(n * d)),
    radial = d >= 1 ? 5 : d >= 0.5 ? 4 : 3,
    h = spec.height * scale,
    leaf = spec.leaf * scale,
    width = spec.width * scale,
    ray = spec.ray * scale,
    disc = spec.disc * scale,
    turn = next() * Math.PI * 2;
  if (species === 'campion') {
    // A cushion: a mound of packed rosettes, as tall as 0.45 of its radius, its surface lumpy with them (a bump each
    // 1.5 to 2 cm), its rim rounded down into the ground, and flowers standing just clear of it. A smooth low dome read
    // as a lily pad.
    const r = leaf * (0.7 + 0.6 * next()),
      tall = Math.max(h, 0.45 * r),
      phase = [next(), next(), next(), next()].map((v) => v * Math.PI * 2),
      k = (Math.PI * 2) / (0.018 * scale);
    // The rosettes: a product of sines over the surface point, so the lumps lie every way alike (a function of the
    // angles alone drew creases running out from the crown, like a lily pad's veins).
    const lump = (a: number, polar: number) => {
      const x = Math.cos(a) * Math.sin(polar) * r,
        y = Math.cos(polar) * tall,
        z = Math.sin(a) * Math.sin(polar) * r;
      return 1 + 0.06 * Math.sin(x * k + phase[0]) * Math.sin(y * k * 1.3 + phase[1]) * Math.sin(z * k + phase[2]) + 0.03 * Math.sin((x + z) * k * 1.9 + phase[3]);
    };
    const rings = seg(16),
      sides = seg(56),
      apex = foliage.vertex([0, tall - 0.005 * scale, 0]);
    let previous: number[] | undefined;
    for (let s = 1; s <= rings; s++) {
      const polar = (s / rings) * (Math.PI / 2) * 1.08,
        row: number[] = [];
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2,
          j = s < rings ? lump(a, polar) : 1;
        row.push(foliage.vertex([Math.cos(a) * Math.sin(polar) * r * j, Math.cos(polar) * tall * j - 0.005 * scale, Math.sin(a) * Math.sin(polar) * r * j]));
      }
      for (let k = 0; k < sides; k++)
        if (previous) foliage.quad(previous[k], previous[(k + 1) % sides], row[(k + 1) % sides], row[k]);
        else foliage.i.push(apex, row[(k + 1) % sides], row[k]);
      previous = row;
    }
    for (let k = 0; k < Math.round(heads * Math.max(d, 0.35)); k++) {
      const a = k * GOLDEN + turn,
        q = Math.sqrt((k + 0.5) / heads) * 0.95,
        polar = q * (Math.PI / 2),
        n: V3 = [Math.cos(a) * Math.sin(polar) / r, Math.cos(polar) / tall, Math.sin(a) * Math.sin(polar) / r],
        nl = Math.hypot(...n),
        lift = 1.11 * lump(a, polar);
      // Just above the lumps so no flower sinks into the cushion.
      star(petals, [Math.cos(a) * Math.sin(polar) * r * lift, Math.cos(polar) * tall * lift - 0.005 * scale, Math.sin(a) * Math.sin(polar) * r * lift], [n[0] / nl, n[1] / nl, n[2] / nl], ray * (d < 0.5 ? 1.6 : 1.15));
    }
    return [foliage.done(), petals.done(), centres.done()];
  }
  // Basal rosette on the golden angle: outer leaves longest and flattest.
  const basal = species === 'gentian' ? 0 : 4 + Math.floor(next() * 3);
  const profile: Profile = species === 'arnica' ? 'ovate' : species === 'aster' ? 'spatulate' : 'lanceolate';
  for (let k = 0; k < basal; k++) {
    const age = 1 - k / Math.max(basal, 1);
    strip(
      foliage,
      [0, 0.004 * scale, 0],
      turn + k * GOLDEN,
      (species === 'bistort' ? 0.75 : 0.3) + 0.45 * (1 - age) + 0.15 * next(),
      leaf * (0.6 + 0.4 * age) * (0.85 + 0.3 * next()),
      width * (0.85 + 0.3 * next()),
      profile,
      seg(species === 'bistort' ? 6 : 4),
      species === 'bistort' ? 0.6 : 0.5,
      0.3,
      species === 'arnica' ? 0.3 : species === 'bistort' ? 0.35 : 0,
    );
  }
  // Flowering stems: one per head, leaning out from the crown.
  for (let s = 0; s < heads; s++) {
    const az = turn + s * GOLDEN + 0.4,
      height = h * (0.8 + 0.35 * next()),
      lean = height * (heads > 1 ? 0.25 + 0.15 * next() : 0.08 * next()),
      { top, at } = stem(foliage, [0, 0, 0], height, (species === 'bistort' ? 0.0018 : 0.0022) * scale, az, lean, seg(6), radial);
    // Stem leaves: opposite pairs (arnica, gentian) or alternate narrow ones (aster, bistort).
    const pairs = species === 'gentian' ? 4 : species === 'arnica' ? 1 : 2;
    for (let p = 0; p < pairs; p++) {
      const t = (p + 1) / (pairs + 1.4),
        c = at(t),
        a = az + p * (species === 'gentian' || species === 'arnica' ? Math.PI / 2 : GOLDEN),
        size = species === 'gentian' ? leaf * (0.7 + 0.4 * t) : leaf * 0.45 * (1 - 0.5 * t);
      for (const side of species === 'gentian' || species === 'arnica' ? [0, Math.PI] : [0])
        strip(foliage, c, a + side, 0.45, size, (species === 'gentian' ? width : width * 0.5), 'lanceolate', seg(3), 0.35, 0.3);
    }
    if (species === 'arnica' || species === 'aster')
      // Heads nod 15 to 40 degrees toward the stem's lean (heliotropic heads face the low sun, not the zenith).
      head(
        petals,
        centres,
        top,
        nod(az, 0.26 + 0.44 * next()),
        disc,
        species === 'arnica' ? 10 + Math.floor(next() * 4) : 26 + Math.floor(next() * 10),
        ray,
        species === 'arnica' ? ray * 0.3 : ray * 0.22,
        d,
        next,
      );
    else if (species === 'gentian') {
      // A terminal cluster: one upright bell and one or two lateral bells on short stalks just below it, turned out
      // 25 to 45 degrees (Gentiana parryi's crowded cymes). The far ring's bells are 1.3 times as wide.
      const sides = d >= 1 ? 20 : d >= 0.5 ? 10 : 5,
        mouth = disc * (d < 0.5 ? 1.3 : 1),
        bells = 1 + Math.floor(next() * 2.2);
      for (let k = 0; k <= bells - 1; k++) {
        const one = new Builder(),
          a = az + k * 2.3 + next() * 0.5,
          below = k ? ray * (0.35 + 0.25 * next()) : 0;
        bell(one, [0, 0, 0], ray * (k ? 0.85 : 1), mouth * 0.45, mouth, sides, seg(5));
        place(petals, one, [top[0] + (k ? Math.cos(a) * disc * 0.6 : 0), top[1] - ray * 0.3 - below, top[2] + (k ? Math.sin(a) * disc * 0.6 : 0)], k ? nod(a, 0.45 + 0.35 * next()) : nod(az, 0.1 * next()));
      }
    } else {
      // Bistort: a dense, fluffy spike, a smooth oblong core with small open florets standing out of it at random,
      // not in rows (rows of solid florets read as a pine cone). The far ring keeps the core alone, 1.7 times as wide (the florets' area).
      const length = ray * (0.8 + 0.4 * next()),
        core = disc * (d < 0.5 ? 1.7 : 1);
      spike(petals, top, length, core, Math.max(4, Math.round(10 * d)), Math.max(1, Math.round(4 * d)));
      const count = d < 0.5 ? 0 : Math.round(80 * d);
      for (let k = 0; k < count; k++) {
        const y = 0.06 + 0.88 * next(),
          a = next() * Math.PI * 2,
          r = core * Math.sqrt(Math.max(0, 1 - (2 * y - 1) ** 2)) * (1.0 + 0.25 * next()),
          out: V3 = [Math.cos(a) * 0.9, 0.3 * (2 * y - 1) + 0.15, Math.sin(a) * 0.9],
          ol = Math.hypot(...out);
        star(petals, [top[0] + Math.cos(a) * r, top[1] + y * length, top[2] + Math.sin(a) * r], [out[0] / ol, out[1] / ol, out[2] / ol], 0.0022 * scale * (0.8 + 0.5 * next()));
      }
    }
  }
  return [foliage.done(), petals.done(), centres.done()];
}
