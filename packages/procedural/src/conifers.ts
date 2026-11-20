// Northern Rockies conifer meshes (`@margoengine/procedural/conifers`): western white pine, western larch, western red
// cedar, Douglas-fir and grand fir at any age, standing live, as snags or fire-killed and burnt, each at three detail
// levels plus an imposter (crossed cards with a baked cut-out image) for the far ring. Sizes and crowns come from
// `@margoengine/procedural/conifer-species` (Wykoff 1982 height-diameter, Crookston 2003 crown width, crown ratio by
// shade tolerance); the sources are listed there and in docs/clean-room.md.
//
// How the tree is built (our own construction, from the growth descriptions only):
// - Stem: a tapered column, radius (dbh / 2) ((H - z) / (H - 1.37))^0.75 above breast height (between the paraboloid
//   and the cone of stem form; Kozak 1988, "A variable-exponent taper equation", Canadian Journal of Forest Research
//   18(11)), with the species' butt flare below breast height, and its bark as ridges round the stem whose depth is the
//   bark's thickness from the Wykoff bark ratio (thick plated larch and furrowed Douglas-fir, thin checked white pine).
// - Crown: one growth unit a year from the leader, a whorl of branches at the top of each (Hallé, Oldeman and Tomlinson
//   1978); whorl heights are the species' height growth curve, so lower whorls sit wide apart (fast youth) and the top
//   whorls of an old tree close together. Whorls below the crown base (crown ratio) have shed their branches. Branch
//   length follows the crown profile, conic when young and blunter with age (oldTop), the widest crown the Crookston
//   width. Cedar branches spiral, one or two a year, and sweep down and up (a J); its leader nods.
// - Foliage: each branch carries a cupped spray (a band of needles along it, widest past its middle) and a narrower
//   upright band across it so a branch has volume from the side; both faces are built so a branch seen from below shows.
//   Normals blend the spray's own with the crown's radial direction (a crown-volume normal).
// - Imposter: three vertical cards at 60 degrees, each the near mesh's silhouette baked orthographically into an RGBA
//   image (needles and bark albedo, a depth-based occlusion term, alpha the coverage), the billboard-cloud level of
//   aggregate geometry (Décoret, Durand, Sillion and Dorsey 2003, "Billboard clouds for extreme model simplification",
//   ACM TOG 22(3); Lacewell, Edwards, Shirley and Thompson 2006, "Stochastic billboard clouds").
import { computeVertexNormals, geometryData, type GeometryData } from '@margoengine/geometry/utils';
import {
  CONIFER_SPECIES,
  coniferForm,
  coniferHeightAt,
  type ConiferForm,
  type ConiferFormOptions,
  type ConiferSpecies,
} from './conifer-species.js';

export * from './conifer-species.js';

/** What stands: a live tree, a snag (dead, bark sloughing, top broken, branch stubs) or a fire-killed burnt tree. */
export type ConiferCondition = 'live' | 'snag' | 'burnt';

/** Options of {@link generateConiferMesh}. */
export interface ConiferMeshOptions extends ConiferFormOptions {
  /** 2 near (limbs, sprays and cross bands), 1 middle (sprays only, fewer whorls), 0 far (crown tiers). Default 2. */
  readonly detail?: 0 | 1 | 2;
  /** Live, snag or burnt. Default 'live'. */
  readonly condition?: ConiferCondition;
  /** Unsigned 32-bit seed for branch phase, jitter and the snag's break. Default 1. */
  readonly seed?: number;
}

/** A conifer mesh in metres, standing on y = 0 at the origin. */
export interface ConiferMesh {
  /** Stem (and limbs at detail 2, bare limbs or stubs on dead trees). */
  readonly trunk: GeometryData;
  /** Needles; empty (no indices) on snags and burnt trees. */
  readonly canopy: GeometryData;
  /** The size and crown it was built from. */
  readonly form: ConiferForm;
  /** Heights of the whorls built, bottom to top (merged at lower detail). */
  readonly whorls: readonly number[];
}

const BREAST = 1.37;

function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

class Mesh {
  p: number[] = [];
  uv: number[] = [];
  i: number[] = [];
  /** Optional per-vertex normal override (blended with the computed one when given). */
  bend: number[] = [];
  vertex(x: number, y: number, z: number, u: number, v: number, bx = 0, by = 0, bz = 0): number {
    this.p.push(x, y, z);
    this.uv.push(u, v);
    this.bend.push(bx, by, bz);
    return this.p.length / 3 - 1;
  }
  finish(blend = 0): GeometryData {
    const g = computeVertexNormals(geometryData(this.p, new Array<number>(this.p.length).fill(0), this.uv, this.i));
    if (blend > 0)
      for (let k = 0; k < g.normals.length; k += 3) {
        const bx = this.bend[k],
          by = this.bend[k + 1],
          bz = this.bend[k + 2],
          bl = Math.hypot(bx, by, bz);
        if (bl < 1e-9) continue;
        // Back faces keep their flipped normal: blend toward the crown normal on the side the face looks to.
        const side = g.normals[k] * bx + g.normals[k + 1] * by + g.normals[k + 2] * bz < -0.2 * bl ? -1 : 1,
          nx = g.normals[k] * (1 - blend) + (side * blend * bx) / bl,
          ny = g.normals[k + 1] * (1 - blend) + (side * blend * by) / bl,
          nz = g.normals[k + 2] * (1 - blend) + (side * blend * bz) / bl,
          l = Math.hypot(nx, ny, nz) || 1;
        g.normals[k] = nx / l;
        g.normals[k + 1] = ny / l;
        g.normals[k + 2] = nz / l;
      }
    return g;
  }
}

/** Stem radius at height z of a tree `height` tall with breast-height diameter `dbh` and butt `flare`. */
export function coniferStemRadius(z: number, height: number, dbh: number, flare: number): number {
  const r = dbh / 2;
  if (z >= BREAST) return Math.max(0.004, r * Math.max(0, (height - z) / (height - BREAST)) ** 0.75);
  const fade = Math.exp(-BREAST / 0.35),
    a = (flare - 1) / (1 - fade);
  return r * (1 + a * (Math.exp(-z / 0.35) - fade));
}

// A closed tapered tube along a polyline (limbs and stubs), `sides` faces.
function tube(m: Mesh, path: readonly (readonly [number, number, number])[], r0: number, r1: number, sides: number): void {
  const first = m.p.length / 3;
  for (let k = 0; k < path.length; k++) {
    const a = path[Math.max(0, k - 1)],
      b = path[Math.min(path.length - 1, k + 1)];
    let dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    // e1 horizontal across the limb, e2 = d x e1.
    let ex = -dz,
      ez = dx;
    const el = Math.hypot(ex, ez) || 1;
    ex /= el;
    ez /= el;
    const fx = dy * ez,
      fy = dz * ex - dx * ez,
      fz = -dy * ex,
      r = r0 + ((r1 - r0) * k) / (path.length - 1);
    for (let j = 0; j < sides; j++) {
      const t = (j / sides) * Math.PI * 2,
        c = Math.cos(t) * r,
        s = Math.sin(t) * r;
      m.vertex(path[k][0] + ex * c + fx * s, path[k][1] + fy * s, path[k][2] + ez * c + fz * s, j / sides, k / (path.length - 1));
    }
  }
  for (let k = 0; k + 1 < path.length; k++)
    for (let j = 0; j < sides; j++) {
      const a = first + k * sides + j,
        b = first + k * sides + ((j + 1) % sides),
        c = a + sides,
        d = b + sides;
      m.i.push(a, c, b, b, c, d);
    }
  const tip = m.vertex(path[path.length - 1][0], path[path.length - 1][1], path[path.length - 1][2], 0.5, 1),
    last = first + (path.length - 1) * sides;
  for (let j = 0; j < sides; j++) m.i.push(last + j, tip, last + ((j + 1) % sides));
}

// The stem: rings from the ground to `top`, bark ridges, flare, a broken top for a snag and a fire scar for a burnt tree.
function stem(
  m: Mesh,
  s: (typeof CONIFER_SPECIES)[ConiferSpecies],
  form: ConiferForm,
  detail: 0 | 1 | 2,
  condition: ConiferCondition,
  rand: () => number,
): number {
  const H = form.height,
    radial = [6, 10, 16][detail],
    top = condition === 'snag' ? H * (0.5 + 0.3 * rand()) : H,
    count = [5, 10, 24][detail],
    rings = [0, 0.1, 0.25, 0.5, 0.8, BREAST].filter((z) => z < top * 0.5);
  for (let k = 1; k <= count; k++) rings.push(BREAST + ((top - BREAST) * k) / count);
  rings.sort((a, b) => a - b);
  const amp = detail ? (1 - s.barkRatio) * 0.9 : 0,
    scarAt = rand() * Math.PI * 2,
    scarTop = Math.min(3, H * 0.25),
    first = m.p.length / 3;
  for (let k = 0; k < rings.length; k++) {
    const z = rings[k],
      base = coniferStemRadius(z, H, form.dbh, s.flare),
      fade = Math.min(1, (H - z) / (0.6 * H)),
      flute = s.ridges > 18 ? 1 + 2 * Math.exp(-z / 1.2) : 1,
      jag = condition === 'snag' && k === rings.length - 1;
    for (let j = 0; j <= radial; j++) {
      const t = (j / radial) * Math.PI * 2,
        ridge = Math.abs(Math.cos((s.ridges / 2) * (t + s.twist * z))) ** 0.6 - 0.6;
      let r = base * (1 + amp * fade * flute * ridge);
      if (condition === 'burnt' && z < scarTop) {
        // A catface: the fire scar on one side of the butt, deepest at the ground, about a third of the way round.
        const off = Math.abs(Math.atan2(Math.sin(t - scarAt), Math.cos(t - scarAt)));
        if (off < 1) r *= 1 - 0.35 * (1 - z / scarTop) * Math.cos((off * Math.PI) / 2);
      }
      const y = jag ? z - (0.2 + 0.8 * Math.abs(Math.sin(t * 2.5 + scarAt))) * base * 3 : z;
      m.vertex(Math.sin(t) * r, y, Math.cos(t) * r, j / radial, z / H);
    }
  }
  for (let k = 0; k + 1 < rings.length; k++)
    for (let j = 0; j < radial; j++) {
      const a = first + k * (radial + 1) + j,
        c = a + radial + 1;
      m.i.push(a, a + 1, c, a + 1, c + 1, c);
    }
  const last = first + (rings.length - 1) * (radial + 1),
    zTop = rings[rings.length - 1],
    cap = m.vertex(0, condition === 'snag' ? zTop - coniferStemRadius(zTop, H, form.dbh, s.flare) * 2 : zTop, 0, 0.5, 1);
  for (let j = 0; j < radial; j++) m.i.push(cap, last + j, last + j + 1);
  return top;
}

// The crown profile: the branch reach at relative crown height z (0 the crown base, 1 the top) over the widest reach.
function profile(s: (typeof CONIFER_SPECIES)[ConiferSpecies], age: number): (z: number) => number {
  const old = Math.min(1, Math.max(0, (age - 40) / 160)),
    q = 1 + (s.oldTop - 1) * old,
    raw = (z: number) => (1 - Math.min(1, z) ** q) ** s.profile * (old > 0 ? 1 - 0.3 * old * Math.max(0, 1 - z / 0.15) : 1);
  let max = 0;
  for (let k = 0; k <= 64; k++) max = Math.max(max, raw(k / 64));
  return (z) => raw(z) / max;
}

// One branch's foliage: a cupped band along the branch path and (detail 2) a narrower upright band across it.
function spray(
  m: Mesh,
  at: (t: number) => readonly [number, number, number],
  dx: number,
  dz: number,
  length: number,
  half: number,
  detail: 0 | 1 | 2,
  cx: number,
  cy: number,
  cz: number,
): void {
  const rows = detail === 2 ? 4 : 3,
    band = (upright: boolean, width: number) => {
      const cols = detail === 2 && !upright ? 2 : 1;
      const first = m.p.length / 3;
      for (let i = 0; i <= rows; i++) {
        const t = 0.12 + (0.88 * i) / rows,
          w = width * Math.sin(Math.PI * Math.min(1, 0.15 + 0.85 * ((t - 0.12) / 0.88))) ** 0.7 * Math.min(1, 0.3 + 2 * t),
          [px, py, pz] = at(t);
        for (let j = 0; j <= cols; j++) {
          const u = (j / cols) * 2 - 1,
            l = u * w,
            x = upright ? px : px - dz * l,
            y = upright ? py + l * 0.8 : py - 0.3 * w * u * u,
            z = upright ? pz : pz + dx * l;
          m.vertex(x, y, z, t, j / cols, x - cx, y - cy, z - cz);
        }
      }
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < cols; j++) {
          const a = first + i * (cols + 1) + j,
            c = a + cols + 1;
          // Both faces: a branch seen from below shows its underside.
          m.i.push(a, a + 1, c, c, a + 1, c + 1, a, c, a + 1, c, c + 1, a + 1);
        }
    };
  band(false, half);
  if (detail === 2) band(true, half * 0.45);
  void length;
}

/**
 * A northern Rockies conifer at an age or height: stem with flare and bark ridges, annual whorls of branches through
 * the live crown with needle sprays, and for dead trees bare limbs (burnt) or stubs and a broken top (snag).
 * @throws RangeError for an unknown species or an option out of range.
 * @example
 * const fir = generateConiferMesh('douglas-fir', { age: 'mature', detail: 2 });
 * fir.form.height; // about 30 m
 */
export function generateConiferMesh(species: ConiferSpecies, options: ConiferMeshOptions = {}): ConiferMesh {
  const s = CONIFER_SPECIES[species];
  if (!s || !Object.hasOwn(CONIFER_SPECIES, species)) throw new RangeError(`Unknown conifer species '${String(species)}'; pass one of CONIFER_SPECIES_IDS.`);
  const detail = options.detail ?? 2,
    condition = options.condition ?? 'live',
    seed = options.seed ?? 1;
  if (detail !== 0 && detail !== 1 && detail !== 2) throw new RangeError('detail must be 0, 1 or 2.');
  if (condition !== 'live' && condition !== 'snag' && condition !== 'burnt')
    throw new RangeError("condition must be 'live', 'snag' or 'burnt'.");
  if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff)) throw new RangeError('seed must be an unsigned 32-bit integer.');
  const form = coniferForm(species, options),
    rand = random(seed * 2654435761 + 97),
    trunk = new Mesh(),
    canopy = new Mesh(),
    top = stem(trunk, s, form, detail, condition, rand),
    H = form.height,
    reach = profile(s, form.age),
    // Annual growth units: whorl heights on the growth curve, scaled so the last is the tree's height.
    years = Math.max(2, Math.round(form.age)),
    scale = H / coniferHeightAt(species, form.age),
    annual: number[] = [];
  for (let t = 1; t < years; t++) {
    const h = coniferHeightAt(species, (t * form.age) / years) * scale;
    if (h >= form.crownBase && h < H - 0.05) annual.push(h);
  }
  // The crown base is the lowest live branch: a whorl stands there (the shaded whorls below it have been shed).
  if (!annual.length || annual[0] - form.crownBase > 0.02) annual.unshift(form.crownBase);
  // Fewer whorls at lower detail: an even pick by index keeps the pattern of growth (wide low, close at the top).
  const most = [6, 12, 24][detail],
    whorls = annual.length <= most ? annual : Array.from({ length: most }, (_, k) => annual[Math.round((k * (annual.length - 1)) / (most - 1))]),
    merged = annual.length / Math.max(1, whorls.length),
    golden = Math.PI * (3 - Math.sqrt(5)),
    halfWidth = form.crownWidth / 2,
    live = condition === 'live';
  if (detail === 0 && live) {
    // Far trees: a cone skirt per whorl tier from the next tier's height down to its own reach.
    const sides = 7;
    for (let k = 0; k < whorls.length; k++) {
      const h = whorls[k],
        next = k + 1 < whorls.length ? whorls[k + 1] : H,
        z = (h - form.crownBase) / form.crownLength,
        r = halfWidth * reach(z),
        drop = r * Math.cos((s.branchAngle * Math.PI) / 180) * -1 + r * s.droop,
        apex = canopy.vertex(0, Math.min(H, next + (next - h) * 0.6), 0, 0.5, 0, 0, 1, 0),
        first = canopy.p.length / 3;
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2 + k * golden;
        canopy.vertex(Math.cos(a) * r, h - drop, Math.sin(a) * r, j / sides, 1, Math.cos(a), 0.4, Math.sin(a));
      }
      for (let j = 0; j < sides; j++) canopy.i.push(apex, first + j + 1, first + j, apex, first + j, first + j + 1);
    }
  } else if (live || detail === 2 || condition === 'burnt') {
    for (let k = 0; k < whorls.length; k++) {
      const h = whorls[k];
      if (h > top) break;
      const z = (h - form.crownBase) / form.crownLength,
        count = s.whorled ? s.branchesPerWhorl : Math.min(6, Math.max(1, Math.round(s.branchesPerWhorl * merged))),
        phase = s.whorled ? k * golden + rand() * 0.6 : 0;
      for (let b = 0; b < count; b++) {
        const yaw = s.whorled ? phase + (b / count) * Math.PI * 2 + (rand() - 0.5) * 0.4 : (k * count + b) * golden + rand() * 0.3,
          dx = Math.cos(yaw),
          dz = Math.sin(yaw),
          // Upper branches angle up, lower ones out and down.
          angle = ((s.branchAngle - 22 * Math.max(0, z - 0.5) * 2 + 8 * Math.max(0, 0.3 - z)) * Math.PI) / 180,
          horizontal = halfWidth * reach(z) * (0.85 + 0.15 * rand()),
          length = Math.max(0.15, horizontal / Math.max(0.3, Math.sin(angle))),
          r0 = coniferStemRadius(h, H, form.dbh, s.flare),
          cedar = !s.whorled,
          at = (t: number): [number, number, number] => {
            const out = r0 + length * t * Math.sin(angle),
              sag = s.droop * length * (cedar ? 2.2 * t * t - 1.6 * t * t * t : t * t);
            return [dx * out, h + length * t * Math.cos(angle) - sag, dz * out];
          };
        if (live) {
          const half = length * 0.34 * s.fill * Math.min(2.2, Math.sqrt(merged));
          spray(canopy, at, dx, dz, length, half, detail, 0, h - halfWidth * 0.35, 0);
        }
        if (detail === 2 || condition === 'burnt') {
          // Limbs: full and thinning outward (live, burnt with its fine twigs gone), or stubs on a snag.
          const reachOf = condition === 'snag' ? Math.min(0.8, 0.2 + rand() * 0.6) / length : condition === 'burnt' ? 0.6 : 0.85,
            steps = 2,
            path = Array.from({ length: steps + 1 }, (_, i) => at((reachOf * i) / steps)),
            rb = Math.max(0.006, Math.min(r0 * 0.35, 0.012 + length * 0.012));
          tube(trunk, path, rb, condition === 'snag' ? rb * 0.8 : rb * 0.2, 3);
        }
      }
    }
    if (live) {
      // The leader: this year's shoot above the top whorl, two crossed upright blades; a cedar's nods over.
      const h0 = whorls.length ? whorls[whorls.length - 1] : form.crownBase,
        len = Math.max(0.2, H - h0),
        nod = s.noddingLeader ? 0.35 : 0;
      for (const yaw of [0, Math.PI / 2]) {
        const dx = Math.cos(yaw),
          dz = Math.sin(yaw);
        spray(canopy, (t) => [nod * len * t * t, h0 + len * t, 0], dx, dz, len, Math.min(0.25, len * 0.12) + 0.04, detail === 2 ? 1 : detail, 0, h0, 0);
      }
    }
  }
  return {
    trunk: trunk.finish(),
    canopy: canopy.finish(0.5),
    form,
    whorls: Object.freeze([...whorls]),
  };
}

/** An RGBA8 image, rows top to bottom. */
export interface ConiferImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Options of {@link generateConiferImposter}. */
export interface ConiferImposterOptions {
  /** Image side in pixels, a power of two from 32 to 1024. The cut-out takes the left half. Default 256. */
  readonly size?: number;
  /** Needle albedo, linear RGB. Default the species' needles when made from a species, else a mid conifer green. */
  readonly needles?: readonly [number, number, number];
  /** Bark albedo, linear RGB. Default a grey brown. */
  readonly bark?: readonly [number, number, number];
  /** Vertical cards, 2 to 6, evenly turned. Default 3. */
  readonly cards?: number;
}

/** The far level of a conifer: crossed cards, their uvs and the cut-out image they sample. */
export interface ConiferImposter {
  /** The cards, both faces, standing on y = 0. */
  readonly geometry: GeometryData;
  /** sRGB colour with alpha coverage: the tree's silhouette in the left half, the needle colour solid in the right. */
  readonly image: ConiferImage;
  /** The uv of the solid needle colour: give it to every vertex of a nearer level that shares this image. */
  readonly solidUv: readonly [number, number];
  /** Share of the cut-out's pixels the tree covers. */
  readonly coverage: number;
}

const toSrgb = (c: number) => {
  const v = Math.min(1, Math.max(0, c));
  return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
};

/**
 * Bakes a conifer mesh into an imposter: its silhouette seen side on, drawn into the left half of an RGBA image with
 * a z-buffer (needle and bark albedo, darkened with depth into the crown as an occlusion term), and `cards` vertical
 * quads through the trunk axis that sample it. The right half holds the needle colour solid, so nearer levels drawn
 * with the same image (scatter `textures`) point every vertex at {@link ConiferImposter.solidUv}.
 * @throws RangeError for a bad size or card count, or a mesh with no triangles.
 */
export function generateConiferImposter(
  mesh: { readonly trunk: GeometryData; readonly canopy: GeometryData; readonly form?: ConiferForm },
  options: ConiferImposterOptions = {},
): ConiferImposter {
  const size = options.size ?? 256,
    cards = options.cards ?? 3;
  if (!(Number.isInteger(Math.log2(size)) && size >= 32 && size <= 1024)) throw new RangeError('size must be a power of two from 32 to 1024.');
  if (!(Number.isInteger(cards) && cards >= 2 && cards <= 6)) throw new RangeError('cards must be 2 to 6.');
  const species = mesh.form ? CONIFER_SPECIES[mesh.form.species] : undefined,
    needles = options.needles ?? species?.needles ?? [0.04, 0.13, 0.06],
    bark = options.bark ?? species?.bark ?? [0.2, 0.15, 0.1];
  let R = 0,
    top = 0;
  for (const g of [mesh.trunk, mesh.canopy])
    for (let k = 0; k < g.positions.length; k += 3) {
      R = Math.max(R, Math.hypot(g.positions[k], g.positions[k + 2]));
      top = Math.max(top, g.positions[k + 1]);
    }
  if (!(R > 0 && top > 0) || mesh.trunk.indices.length + mesh.canopy.indices.length === 0)
    throw new RangeError('The imposter needs a mesh with triangles.');
  const W = size / 2,
    Hh = size,
    depth = new Float32Array(W * Hh).fill(-Infinity),
    color = new Float32Array(W * Hh * 3),
    toX = (x: number) => ((x + R) / (2 * R)) * W,
    toY = (y: number) => (1 - y / top) * Hh;
  for (const [g, albedo] of [
    [mesh.trunk, bark],
    [mesh.canopy, needles],
  ] as const) {
    const P = g.positions,
      I = g.indices;
    for (let t = 0; t < I.length; t += 3) {
      const ax = toX(P[I[t] * 3]),
        ay = toY(P[I[t] * 3 + 1]),
        az = P[I[t] * 3 + 2],
        bx = toX(P[I[t + 1] * 3]),
        by = toY(P[I[t + 1] * 3 + 1]),
        bz = P[I[t + 1] * 3 + 2],
        cx = toX(P[I[t + 2] * 3]),
        cy = toY(P[I[t + 2] * 3 + 1]),
        cz = P[I[t + 2] * 3 + 2],
        area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
        x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx))),
        y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
        y1 = Math.min(Hh - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5,
            py = y + 0.5,
            w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area,
            w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area,
            w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * az + w1 * bz + w2 * cz,
            o = y * W + x;
          if (z <= depth[o]) continue;
          depth[o] = z;
          // Occlusion: the front of the crown full, the far side seen through gaps darker.
          const shade = 0.45 + 0.55 * Math.min(1, Math.max(0, (z + R) / (2 * R)) * 1.3);
          color[o * 3] = albedo[0] * shade;
          color[o * 3 + 1] = albedo[1] * shade;
          color[o * 3 + 2] = albedo[2] * shade;
        }
    }
  }
  const data = new Uint8Array(size * size * 4);
  let covered = 0;
  for (let y = 0; y < Hh; y++)
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      if (x >= W) {
        data[o] = toSrgb(needles[0]);
        data[o + 1] = toSrgb(needles[1]);
        data[o + 2] = toSrgb(needles[2]);
        data[o + 3] = 255;
        continue;
      }
      const k = y * W + x;
      if (depth[k] > -Infinity) {
        covered++;
        data[o] = toSrgb(color[k * 3]);
        data[o + 1] = toSrgb(color[k * 3 + 1]);
        data[o + 2] = toSrgb(color[k * 3 + 2]);
        data[o + 3] = 255;
      } else {
        // Uncovered texels take the needle colour, so mip levels blend no dark fringe into the cut-out's edge.
        data[o] = toSrgb(needles[0] * 0.7);
        data[o + 1] = toSrgb(needles[1] * 0.7);
        data[o + 2] = toSrgb(needles[2] * 0.7);
      }
    }
  const p: number[] = [],
    uv: number[] = [],
    idx: number[] = [],
    rows = 6,
    inset = 0.5 / size;
  for (let c = 0; c < cards; c++) {
    const a = (c / cards) * Math.PI,
      ux = Math.cos(a),
      uz = Math.sin(a),
      first = p.length / 3;
    for (let r = 0; r <= rows; r++)
      for (const side of [-1, 1]) {
        const y = (top * r) / rows;
        p.push(ux * R * side, y, uz * R * side);
        uv.push(side < 0 ? inset : 0.5 - inset, 1 - r / rows);
      }
    for (let r = 0; r < rows; r++) {
      const a0 = first + r * 2,
        b0 = a0 + 1,
        a1 = a0 + 2,
        b1 = a0 + 3;
      idx.push(a0, b0, a1, a1, b0, b1, a0, a1, b0, a1, b1, b0);
    }
  }
  const quad = computeVertexNormals(geometryData(p, new Array<number>(p.length).fill(0), uv, idx));
  // Card normals: out from the axis and a little up, the crown's own direction, so a card lights as the crown does.
  for (let k = 0; k < quad.positions.length; k += 3) {
    const x = quad.positions[k],
      z = quad.positions[k + 2],
      l = Math.hypot(x, 0.45 * R, z) || 1;
    quad.normals[k] = x / l;
    quad.normals[k + 1] = (0.45 * R) / l;
    quad.normals[k + 2] = z / l;
  }
  return { geometry: quad, image: { width: size, height: size, data }, solidUv: [0.75, 0.5], coverage: covered / (W * Hh) };
}

/** Options of {@link coniferLevels}. */
export interface ConiferLevelsOptions extends Omit<ConiferMeshOptions, 'detail'> {
  /** Imposter image side. Default 256. */
  readonly imposterSize?: number;
}

/** The three LOD rings of a conifer for scatter: near and middle meshes and the imposter (live trees). */
export interface ConiferLevels {
  readonly form: ConiferForm;
  /** Stem per ring: near, middle, far (a live tree's far stem is in the imposter: one degenerate triangle). */
  readonly trunk: readonly [GeometryData, GeometryData, GeometryData];
  /** Needles per ring: near, middle, imposter cards; empty on dead trees. */
  readonly canopy: readonly [GeometryData, GeometryData, GeometryData];
  /** Scatter `textures` of the canopy rings: uvs per ring and the imposter image (undefined on dead trees). */
  readonly textures?: {
    readonly uvs: readonly [Float32Array, Float32Array, Float32Array];
    readonly baseColor: ConiferImage;
    readonly alphaCutoff: number;
  };
}

/**
 * A conifer's three scatter LOD rings: near (detail 2), middle (detail 1) and, for a live tree, the imposter of the
 * near mesh with the canopy's maps (its needle colour comes from the image, so draw the canopy part white). Dead trees
 * draw their stem at detail 0 in the far ring.
 */
export function coniferLevels(species: ConiferSpecies, options: ConiferLevelsOptions = {}): ConiferLevels {
  const { imposterSize, ...rest } = options,
    near = generateConiferMesh(species, { ...rest, detail: 2 }),
    middle = generateConiferMesh(species, { ...rest, detail: 1 });
  if (near.canopy.indices.length === 0) {
    const far = generateConiferMesh(species, { ...rest, detail: 0 });
    return { form: near.form, trunk: [near.trunk, middle.trunk, far.trunk], canopy: [near.canopy, middle.canopy, far.canopy] };
  }
  const imp = generateConiferImposter(near, imposterSize === undefined ? {} : { size: imposterSize }),
    solid = (g: GeometryData) => {
      const u = new Float32Array((g.positions.length / 3) * 2);
      for (let k = 0; k < u.length; k += 2) {
        u[k] = imp.solidUv[0];
        u[k + 1] = imp.solidUv[1];
      }
      return u;
    },
    none = geometryData([0, 0, 0, 0, 0.001, 0, 0.001, 0, 0], [0, 1, 0, 0, 1, 0, 0, 1, 0], [0, 0, 0, 0, 0, 0], [0, 1, 2]);
  return {
    form: near.form,
    trunk: [near.trunk, middle.trunk, none],
    canopy: [near.canopy, middle.canopy, imp.geometry],
    textures: { uvs: [solid(near.canopy), solid(middle.canopy), imp.geometry.uvs], baseColor: imp.image, alphaCutoff: 0.5 },
  };
}
