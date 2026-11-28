// Temperate broadleaf meshes (`@margoengine/procedural/broadleaves`): English oak, European beech and black alder at
// any age, leafed or bare, each at three detail levels plus an imposter (three crossed cards, each with its own baked
// view) for the far ring. Sizes and crowns come from `@margoengine/procedural/broadleaf-species` (Hemery's crown width
// line, a Chapman-Richards height curve); the sources are listed there and in docs/clean-room.md.
//
// How the tree is built (our own construction, from the published growth descriptions only):
// - Scaffold: the trunk forks into 4 to 7 limbs (an oak; fewer for a leader-bearing alder), each a kinked path that
//   restarts growth every 0.5 to 1.5 m, flat low in the crown and steeper high, flattening and drooping toward its tip
//   (Eaton et al. 2016; Buck-Sorlin and Bell 2000; Barthelemy and Caraglio 2007). Each limb owns 2 to 4 flattened
//   foliage masses inside the crown envelope; the spaces between masses are the sky gaps.
// - Twigs: space colonisation (Runions, Lane and Prusinkiewicz 2007, "Modeling trees with a space colonization
//   algorithm", Eurographics Workshop on Natural Phenomena) from the limbs toward attraction points placed in the
//   masses, with an upward tropism term; a spatial hash finds each point's nearest node, and the number of distance
//   tests is returned as the work count.
// - Radii: the pipe model (Shinozaki, Yoda, Hozumi and Kira 1964, "A quantitative analysis of plant form", Japanese
//   Journal of Ecology 14): r^n at a fork is the sum of its children's r^n, n 2.4, scaled so breast height has the
//   stem's diameter; the wood is meshed with `@margoengine/procedural/tree-mesh`.
// - Light and shedding: the shadow-propagation field of Palubicki, Horel, Longay, Runions, Lane, Mech and Prusinkiewicz
//   2009, "Self-organizing tree models for image synthesis", ACM TOG 28(3): every tip shades a pyramid of voxels under
//   it; tips in deep shade are cut off with their dead branches, so the inside of the crown shows bare limbs and the
//   leaves sit in an outer shell.
// - Foliage: alpha-cut spray cards (a code-drawn leaf atlas: lobed oak leaves on twigs, in four variants and three
//   light levels), tilted 20 to 40 degrees from flat (broadleaf leaves are planophile to plagiophile; Pisek et al.
//   2013) with steep cross cards between; the card count follows the leaf area index. Normals blend each card's own
//   normal with the direction out of its own foliage mass, not the whole crown's centre.
// - Levels: the middle level keeps trunk and limbs and every fourth card at twice the size, the same leaf area (Cook,
//   Halstead, Planck and Ryu 2007, "Stochastic simplification of aggregate detail", ACM TOG 26(3)); the far level is
//   the billboard cloud of Behrendt, Colditz, Franzke, Kopf and Deussen 2005 ("Realistic real-time rendering of
//   landscapes using billboard clouds", Computer Graphics Forum 24(3)): three cards, each with its own baked
//   orthographic view of the near mesh (albedo, a depth-based occlusion term, alpha coverage).
import { geometryData, type GeometryData } from '@margoengine/geometry/utils';
import {
  BROADLEAF_SPECIES,
  broadleafForm,
  type BroadleafForm,
  type BroadleafFormOptions,
  type BroadleafSpecies,
  type BroadleafSpeciesData,
} from './broadleaf-species.js';
import { meshTree, type TreeMeshSkeleton } from './tree-mesh.js';

export * from './broadleaf-species.js';

/** What stands: a leafed tree or a bare (winter or dead) one. */
export type BroadleafCondition = 'live' | 'bare';

/** Options of {@link generateBroadleafMesh}. */
export interface BroadleafMeshOptions extends BroadleafFormOptions {
  /** 2 near (all wood, all cards), 1 middle (trunk and limbs, every fourth card at twice the size), 0 far (stem only). Default 2. */
  readonly detail?: 0 | 1 | 2;
  /** Leafed or bare. Default 'live'. */
  readonly condition?: BroadleafCondition;
  /** Unsigned 32-bit seed for the limbs, masses, twigs and cards. Default 1. */
  readonly seed?: number;
  /** Side of the leaf atlas image in pixels, a power of two from 128 to 1024. Default 512. */
  readonly atlasSize?: number;
}

/** An RGBA8 image, rows top to bottom. */
export interface BroadleafImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A broadleaf mesh in metres, standing on y = 0 at the origin. */
export interface BroadleafMesh {
  /** Stem, limbs and twigs (what the detail level keeps). */
  readonly trunk: GeometryData;
  /** Leaf cards, uvs into `atlas`; empty on a bare tree. */
  readonly canopy: GeometryData;
  /** The size and crown it was built from. */
  readonly form: BroadleafForm;
  /** The limbs the trunk forks into. */
  readonly limbs: number;
  /** Foliage masses (flattened ellipsoids) across the crown. */
  readonly masses: number;
  /** Leaf area in square metres: the cards' area times the leaf atlas' alpha cover. */
  readonly leafArea: number;
  /** Point to node distance tests the growth made (a work count). */
  readonly distanceTests: number;
  /** The grown skeleton, every node (metres, parent first), with its pipe-model radii and branch orders. */
  readonly skeleton: Required<TreeMeshSkeleton>;
  /** The leaf atlas: leaf tiles in the top half (4 variants by 3 light levels); the bottom half is empty. */
  readonly atlas: BroadleafImage;
}

const BREAST = 1.37,
  PIPE = 2.4,
  TILE_COLS = 4,
  TILE_ROWS = 3,
  POINTS = 2200,
  NODE_CAP = 9000,
  TILT = Math.tan(Math.PI / 12);

function random(seed: number): () => number {
  let s = (Math.imul(seed >>> 0, 2654435761) + 97) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t,
  clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x)),
  smooth = (a: number, b: number, x: number) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  },
  toSrgb = (c: number) => {
    const v = clamp(c, 0, 1);
    return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  },
  toLinear = (b: number) => {
    const v = b / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };

// ---------------------------------------------------------------------------------------------------------------
// The leaf atlas.

function drawLeaves(sp: BroadleafSpeciesData, size: number): { image: BroadleafImage; cover: Float64Array } {
  const t = size / 4,
    width = size,
    height = size * 2,
    data = new Uint8Array(width * height * 4),
    cover = new Float64Array(TILE_COLS * TILE_ROWS);
  const lightFactor = [1, 0.7, 0.45],
    ll = Math.max(3, t * 0.3),
    lw = ll * (sp.leaf[1] / sp.leaf[0]),
    lobes = sp.leaf[2];
  for (let v = 0; v < TILE_COLS; v++) {
    const rand = random(1000 + v * 7);
    // The spray: a main twig from the tile's bottom middle and two side twigs, leaves on both sides, one at each tip.
    const bend = (rand() - 0.5) * 0.4,
      twigs: { x: number; y: number; a: number; len: number }[] = [{ x: t * 0.5, y: t * 0.97, a: bend, len: t * 0.74 }],
      leaves: { x: number; y: number; a: number; k: number; len: number }[] = [];
    for (const [at, turn] of [
      [0.3, -0.7],
      [0.5, 0.7],
    ] as const) {
      const m = twigs[0];
      twigs.push({
        x: m.x + Math.sin(m.a) * m.len * at,
        y: m.y - Math.cos(m.a) * m.len * at,
        a: m.a + turn + (rand() - 0.5) * 0.3,
        len: t * (0.36 + 0.06 * rand()),
      });
    }
    for (const tw of twigs) {
      const count = 7;
      for (let j = 0; j < count; j++) {
        const s = j === count - 1 ? 1 : 0.2 + 0.7 * (j / (count - 1)) + 0.04 * rand(),
          side = j % 2 ? 1 : -1,
          x = tw.x + Math.sin(tw.a) * tw.len * s,
          y = tw.y - Math.cos(tw.a) * tw.len * s,
          // Leaves come off the twig at 50 to 85 degrees; the tip leaf points straight on.
          a = j === count - 1 ? tw.a - Math.PI / 2 : tw.a - Math.PI / 2 + side * (0.9 + 0.6 * rand());
        leaves.push({ x, y, a, k: 0.75 + 0.3 * rand(), len: ll * (0.85 + 0.3 * rand()) });
      }
    }
    // The three light levels are the first one's colours scaled: the shapes are drawn once.
    const baseCov = new Float32Array(t * t),
      baseCol = new Float32Array(t * t * 3);
    for (let l = 0; l < TILE_ROWS; l++) {
      const ox = v * t,
        oy = l * t,
        cov = baseCov,
        col = l === 0 ? baseCol : baseCol.map((x) => x * lightFactor[l]);
      const paint = (px: number, py: number, a: number, r: number, g: number, b: number) => {
        const o = py * t + px;
        col[o * 3] = col[o * 3] * (1 - a) + r * a;
        col[o * 3 + 1] = col[o * 3 + 1] * (1 - a) + g * a;
        col[o * 3 + 2] = col[o * 3 + 2] * (1 - a) + b * a;
        cov[o] = cov[o] + a * (1 - cov[o]);
      };
      if (l === 0) {
        // Twigs.
        for (const tw of twigs) {
          const tx1 = tw.x + Math.sin(tw.a) * tw.len,
            ty1 = tw.y - Math.cos(tw.a) * tw.len,
            dx = tx1 - tw.x,
            dy = ty1 - tw.y;
          for (let py = 0; py < t; py++)
            for (let px = 0; px < t; px++) {
              const u = clamp(((px + 0.5 - tw.x) * dx + (py + 0.5 - tw.y) * dy) / (dx * dx + dy * dy), 0, 1),
                d = Math.hypot(px + 0.5 - (tw.x + dx * u), py + 0.5 - (tw.y + dy * u));
              if (d < Math.max(0.8, t / 90)) paint(px, py, 1, sp.bark[0] * 1.6, sp.bark[1] * 1.6, sp.bark[2] * 1.6);
            }
        }
        for (const lf of leaves) {
          const ca = Math.cos(lf.a),
            sa = Math.sin(lf.a),
            reach = lf.len + lw,
            x0 = Math.max(0, Math.floor(lf.x - reach)),
            x1 = Math.min(t - 1, Math.ceil(lf.x + reach)),
            y0 = Math.max(0, Math.floor(lf.y - reach)),
            y1 = Math.min(t - 1, Math.ceil(lf.y + reach)),
            shade = lf.k;
          for (let py = y0; py <= y1; py++)
            for (let px = x0; px <= x1; px++) {
              let inside = 0,
                vein = 0;
              for (let sy = 0; sy < 2; sy++)
                for (let sx = 0; sx < 2; sx++) {
                  const dx = px + 0.25 + sx * 0.5 - lf.x,
                    dy = py + 0.25 + sy * 0.5 - lf.y,
                    along = (dx * ca + dy * sa) / lf.len,
                    across = (-dx * sa + dy * ca) / (lw / 2);
                  if (along < 0 || along > 1) continue;
                  const body = Math.sin(Math.PI * along ** 0.85) ** 0.8,
                    wave =
                      lobes > 0
                        ? 1 + 0.3 * Math.cos(2 * Math.PI * lobes * along - 0.5)
                        : 1 + 0.06 * Math.cos(along * 25),
                    edge = Math.min(1, body * wave);
                  if (Math.abs(across) <= edge) {
                    inside++;
                    if (
                      Math.abs(across) < 0.07 ||
                      Math.abs(Math.abs(across) - 0.55 * Math.abs(Math.sin(along * 14))) < 0.04
                    )
                      vein++;
                  }
                }
              if (!inside) continue;
              const a = inside / 4,
                lift = vein > inside / 2 ? 1.35 : 1;
              paint(px, py, a, sp.leaves[0] * shade * lift, sp.leaves[1] * shade * lift, sp.leaves[2] * shade * lift);
            }
        }
      }
      let n = 0,
        cr = 0,
        cg = 0,
        cb = 0,
        total = 0;
      for (let i = 0; i < t * t; i++)
        if (cov[i] > 0) {
          n++;
          total += cov[i];
          cr += col[i * 3];
          cg += col[i * 3 + 1];
          cb += col[i * 3 + 2];
        }
      const mr = n ? cr / n : sp.leaves[0],
        mg = n ? cg / n : sp.leaves[1],
        mb = n ? cb / n : sp.leaves[2];
      cover[l * TILE_COLS + v] = total / (t * t);
      for (let py = 0; py < t; py++)
        for (let px = 0; px < t; px++) {
          const i = py * t + px,
            o = ((oy + py) * width + ox + px) * 4,
            a = cov[i];
          // Empty texels take the tile's mean colour, so mip levels blend no dark fringe into the cut-out's edge.
          const r = a > 0 ? col[i * 3] / a : mr,
            g = a > 0 ? col[i * 3 + 1] / a : mg,
            b = a > 0 ? col[i * 3 + 2] / a : mb;
          data[o] = toSrgb(a > 0 ? r : mr * 0.8);
          data[o + 1] = toSrgb(a > 0 ? g : mg * 0.8);
          data[o + 2] = toSrgb(a > 0 ? b : mb * 0.8);
          data[o + 3] = Math.round(255 * Math.min(1, a));
        }
    }
  }
  return { image: { width, height, data }, cover };
}

// ---------------------------------------------------------------------------------------------------------------
// The grown tree.

interface Mass {
  x: number;
  y: number;
  z: number;
  rh: number;
  rv: number;
}
interface Card {
  b: [number, number, number];
  f: [number, number, number];
  u: [number, number, number];
  size: number;
  tile: number;
  m: [number, number, number];
}
interface Tree {
  form: BroadleafForm;
  pos: number[];
  parent: number[];
  level: number[];
  radii: number[];
  limbs: number;
  masses: Mass[];
  lit: number[];
  light: number[];
  kids: number[];
  cardSize: number;
  distanceTests: number;
  seed: number;
}

// The pipe-model radii of nodes (parent first): leaves 1, r^n summed at forks, then scaled so breast height has the
// stem's radius, with the butt flare below it.
function pipeRadii(pos: number[], parent: number[], dbh: number, tipFloor: number): number[] {
  const n = parent.length,
    pw = new Float64Array(n);
  const children = new Int32Array(n);
  for (let i = 1; i < n; i++) children[parent[i]]++;
  for (let i = n - 1; i >= 0; i--) {
    if (children[i] === 0) pw[i] = 1;
    else pw[i] += 0.012;
    if (i > 0) pw[parent[i]] += pw[i];
  }
  // The trunk node at breast height.
  let ref = 0;
  for (let i = 0; i < n && (i === 0 || parent[i] === i - 1); i++) {
    if (Math.abs(pos[i * 3 + 1] - BREAST) < 1e-6) ref = i;
    if (pos[i * 3 + 1] > BREAST + 1e-6) break;
  }
  const scale = dbh / 2 / pw[ref] ** (1 / PIPE),
    r = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const y = pos[i * 3 + 1],
      flare = i === 0 || parent[i] === i - 1 ? 1 + 0.7 * Math.max(0, Math.exp(-y / 0.5) - Math.exp(-BREAST / 0.5)) : 1;
    r[i] = Math.max(tipFloor, pw[i] ** (1 / PIPE) * scale * (y < BREAST ? flare : 1));
  }
  return r;
}

function grow(species: BroadleafSpecies, form: BroadleafForm, seed: number): Tree {
  const s = BROADLEAF_SPECIES[species],
    rand = random(seed),
    gauss = () => (rand() + rand() + rand() - 1.5) * 2,
    H = form.height,
    W = form.crownWidth,
    Rc = W / 2,
    zb = form.crownBase,
    CL = form.crownLength,
    D = Math.max(0.02, W / 32),
    env = (z: number) => {
      const t = (z - zb) / CL;
      if (t < -0.05 || t >= 1) return 0;
      const tt = Math.max(0, t),
        d = (tt - 0.35) / (tt < 0.35 ? 0.8 : 0.65);
      return 0.86 * Rc * Math.max(0, 1 - Math.abs(d) ** 2.4) ** (1 / 2.4);
    };
  const pos: number[] = [],
    parent: number[] = [],
    level: number[] = [],
    active: boolean[] = [],
    childCount: number[] = [];
  const node = (x: number, y: number, z: number, p: number, lv: number, act: boolean) => {
    pos.push(x, y, z);
    parent.push(p);
    level.push(lv);
    active.push(act);
    childCount.push(0);
    if (p >= 0) childCount[p]++;
    return parent.length - 1;
  };
  // Trunk.
  const zf = zb + s.fork * CL,
    ds = clamp(H / 36, 0.15, 0.6),
    wob = 0.01 * H,
    ph = rand() * 6.28;
  const zs = [0];
  while (zs[zs.length - 1] + ds < zf - ds * 0.5) zs.push(zs[zs.length - 1] + ds);
  if (zf > BREAST + 0.05) {
    const k = zs.findIndex((z) => z >= BREAST - 1e-9);
    if (k >= 0 && Math.abs(zs[k] - BREAST) > 1e-6) {
      if (k > 0 && zs[k] - BREAST < ds * 0.3) zs[k] = BREAST;
      else zs.splice(k, 0, BREAST);
    }
  }
  zs.push(zf);
  const trunk: number[] = [];
  for (const z of zs) {
    const f = z / H;
    trunk.push(
      node(
        wob * f * Math.sin(z * 0.5 + ph),
        z,
        wob * f * Math.cos(z * 0.43 + ph),
        trunk.length ? trunk[trunk.length - 1] : -1,
        0,
        false,
      ),
    );
  }
  // Limbs: each steers toward a target on the crown's dome (low limbs near the equator, high ones steep, the leader to
  // the top), kinking every 0.5 to 1.5 m, flattening and drooping a little toward its end.
  const n = s.limbs[0] + Math.floor(rand() * (s.limbs[1] - s.limbs[0] + 1)),
    ku = W / 13,
    nodeStep = D * 1.6,
    theta0 = rand() * 6.28,
    zc = zb + 0.42 * CL,
    masses: Mass[] = [];
  for (let i = 0; i < n; i++) {
    const lead = i === 0 && s.leader,
      frac = lead ? 1 : (i - (s.leader ? 1 : 0) + 0.3 + 0.6 * rand()) / Math.max(1, n - (s.leader ? 1 : 0)),
      zAttach = lead ? zf : zb + (zf - zb) * (0.05 + 0.9 * Math.min(1, frac)),
      theta = theta0 + i * 2.39996 + (rand() - 0.5) * 0.5,
      phi = ((lerp(s.limbPitch[0], s.limbPitch[1], Math.min(1, frac)) + 4 * gauss()) * Math.PI) / 180;
    // The target: along the dome direction until the envelope ends, then 12 percent short of it.
    let tx = 0,
      ty = H * 0.96,
      tz = 0;
    if (!lead) {
      const dx = Math.cos(phi) * Math.cos(theta),
        dy = Math.sin(phi),
        dz = Math.cos(phi) * Math.sin(theta);
      let r = 0;
      while (r < 4 * Rc && Math.hypot(dx * (r + 0.1), dz * (r + 0.1)) < env(zc + dy * (r + 0.1))) r += 0.1;
      // High limbs reach nearly to the envelope: the crown's top is the tree's height.
      const reach = lerp(0.88, 0.99, smooth(0.3, 0.9, dy));
      tx = dx * r * reach;
      ty = zc + dy * r * reach;
      tz = dz * r * reach;
    }
    let ti = trunk[0];
    for (const k of trunk) if (Math.abs(pos[k * 3 + 1] - zAttach) < Math.abs(pos[ti * 3 + 1] - zAttach)) ti = k;
    let x = pos[ti * 3],
      y = pos[ti * 3 + 1],
      z = pos[ti * 3 + 2],
      dirx = Math.cos(theta) * 0.8,
      diry = 0.25,
      dirz = Math.sin(theta) * 0.8,
      last = ti,
      total = 0;
    const path: [number, number, number, number][] = [[x, y, z, 0]],
      reach = Math.hypot(tx - x, ty - y, tz - z);
    for (let kink = 0; kink < 80; kink++) {
      const len = Math.max(nodeStep * 1.2, (0.5 + rand()) * ku),
        gx = tx - x,
        gy = ty - y,
        gz = tz - z,
        gl = Math.hypot(gx, gy, gz) || 1,
        near = smooth(0.5, 0.05, gl / reach);
      let nx = dirx * 0.45 + (gx / gl) * 0.55 + gauss() * 0.3,
        ny = diry * 0.45 + (gy / gl) * 0.55 + gauss() * 0.22 - 0.18 * near * (lead ? 0 : 1),
        nz = dirz * 0.45 + (gz / gl) * 0.55 + gauss() * 0.3;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      dirx = nx;
      diry = ny;
      dirz = nz;
      const segs = Math.max(1, Math.round(len / nodeStep));
      for (let j = 0; j < segs; j++) {
        x += (nx * len) / segs;
        y += (ny * len) / segs;
        z += (nz * len) / segs;
        last = node(x, y, z, last, 1, true);
        total += len / segs;
        path.push([x, y, z, total]);
      }
      if (gl < 1.2 * ku || y > H * 0.995) break;
    }
    // Foliage masses along the outer part of the limb, a little above it.
    const nm = 3 + Math.floor(rand() * 2),
      totalLen = path[path.length - 1][3];
    for (let m = 0; m < nm; m++) {
      const tm = (0.3 + (0.7 * (m + 0.3 + 0.4 * rand())) / nm) * totalLen;
      let k = 1;
      while (k < path.length - 1 && path[k][3] < tm) k++;
      const rh = Math.max(D * 3, W * s.massSize * (0.7 + 0.6 * rand())),
        rv = rh * 0.6,
        a = rand() * 6.2832,
        side = (rand() * 2 - 1) * 0.35 * rh;
      let cx = path[k][0] + Math.cos(a) * side,
        cz = path[k][2] + Math.sin(a) * side;
      const cy = path[k][1] + rv * (0.3 + 0.4 * rand()),
        rho = Math.hypot(cx, cz),
        limit = Math.max(0, env(cy) - 0.5 * rh);
      if (rho > limit && rho > 0) {
        cx *= limit / rho;
        cz *= limit / rho;
      }
      if (cy + rv < H) masses.push({ x: cx, y: cy, z: cz, rh, rv });
    }
  }
  // Fill masses: where the limbs' own masses leave the dome empty, a mass goes at the sampled spot farthest from the
  // others that a limb node can still reach, until the masses fill two thirds of the envelope.
  const volOf = (m: Mass) => (4 / 3) * Math.PI * m.rh * m.rh * m.rv;
  let envVol = 0;
  for (let k = 0; k < 64; k++) envVol += Math.PI * env(zb + (CL * (k + 0.5)) / 64) ** 2 * (CL / 64);
  let filled = masses.reduce((sum, m) => sum + volOf(m), 0);
  for (let extra = 0; extra < 16 && filled < 0.65 * envVol; extra++) {
    let best: Mass | undefined,
      bestScore = -1;
    for (let tryk = 0; tryk < 40; tryk++) {
      const y = zb + CL * (0.05 + 0.9 * rand()),
        a = rand() * 6.2832,
        r = Math.sqrt(rand()) * env(y) * 0.8,
        x = Math.cos(a) * r,
        z = Math.sin(a) * r;
      let reachable = false;
      for (let i = 0; i < parent.length && !reachable; i++)
        if (active[i] && (pos[i * 3] - x) ** 2 + (pos[i * 3 + 1] - y) ** 2 + (pos[i * 3 + 2] - z) ** 2 < (8 * D) ** 2)
          reachable = true;
      if (!reachable) continue;
      let score = Infinity;
      for (const m of masses) score = Math.min(score, Math.hypot(m.x - x, (m.y - y) * 1.5, m.z - z) / m.rh);
      if (score > bestScore) {
        bestScore = score;
        const rh = Math.max(D * 3, W * s.massSize * (0.8 + 0.3 * rand()));
        best = { x, y, z, rh, rv: rh * 0.6 };
      }
    }
    if (!best) break;
    masses.push(best);
    filled += volOf(best);
  }
  // Attraction points in the masses, denser toward each mass's shell.
  const volume = masses.reduce((sum, m) => sum + m.rh * m.rh * m.rv, 0),
    pts: number[] = [];
  for (const m of masses) {
    const count = Math.round((POINTS * m.rh * m.rh * m.rv) / volume);
    for (let k = 0; k < count; k++) {
      const u = rand() * 2 - 1,
        a = rand() * 6.2832,
        q = Math.sqrt(1 - u * u),
        r = 0.35 + 0.65 * rand() ** 0.6,
        px = m.x + Math.cos(a) * q * r * m.rh,
        py = m.y + u * r * m.rv,
        pz = m.z + Math.sin(a) * q * r * m.rh;
      if (Math.hypot(px, pz) <= env(py)) pts.push(px, py, pz);
    }
  }
  // Space colonisation.
  const dI = 7 * D,
    kD = 2 * D,
    cell = dI,
    grid = new Map<number, number[]>(),
    keyOf = (x: number, y: number, z: number) =>
      (Math.floor(x / cell) + 2048) * 16777216 + (Math.floor(y / cell) + 2048) * 4096 + (Math.floor(z / cell) + 2048),
    insert = (i: number) => {
      const k = keyOf(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]),
        list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    };
  // Inside the crown the limbs stay bare: only nodes outside a cone about the trunk (narrowing to the top) sprout side
  // shoots; a tip anywhere keeps growing.
  const sprouts = (x: number, y: number, z: number) =>
    Math.hypot(x, z) >= 0.45 * Rc * (1 - clamp((y - zb) / CL, 0, 1) ** 2);
  const sprout: boolean[] = [];
  for (let i = 0; i < parent.length; i++) {
    sprout[i] = sprouts(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    insert(i);
  }
  let tests = 0,
    alive = pts.length / 3;
  const dead = new Uint8Array(alive),
    tropism = 0.14;
  for (let iter = 0; iter < 400 && alive > 0 && parent.length < NODE_CAP; iter++) {
    const sums = new Map<number, [number, number, number]>();
    for (let k = 0; k < dead.length; k++) {
      if (dead[k]) continue;
      const px = pts[k * 3],
        py = pts[k * 3 + 1],
        pz = pts[k * 3 + 2],
        cx = Math.floor(px / cell),
        cy = Math.floor(py / cell),
        cz = Math.floor(pz / cell);
      let best = -1,
        bd = dI * dI,
        covered = false;
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          for (let c = -1; c <= 1; c++) {
            const list = grid.get((cx + a + 2048) * 16777216 + (cy + b + 2048) * 4096 + (cz + c + 2048));
            if (!list) continue;
            for (const i of list) {
              tests++;
              const dx = px - pos[i * 3],
                dy = py - pos[i * 3 + 1],
                dz = pz - pos[i * 3 + 2],
                d = dx * dx + dy * dy + dz * dz;
              if (d < kD * kD) covered = true;
              else if (d < bd && active[i] && (sprout[i] || childCount[i] === 0)) {
                bd = d;
                best = i;
              }
            }
          }
      if (covered) {
        dead[k] = 1;
        alive--;
        continue;
      }
      if (best < 0) continue;
      const d = Math.sqrt(bd),
        sum = sums.get(best) ?? [0, 0, 0];
      sum[0] += (px - pos[best * 3]) / d;
      sum[1] += (py - pos[best * 3 + 1]) / d;
      sum[2] += (pz - pos[best * 3 + 2]) / d;
      sums.set(best, sum);
    }
    if (!sums.size) break;
    let grown = 0;
    for (const i of [...sums.keys()].sort((a, b) => a - b)) {
      const sum = sums.get(i)!;
      let dx = sum[0],
        dy = sum[1] + tropism * Math.hypot(sum[0], sum[1], sum[2]),
        dz = sum[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l;
      dy /= l;
      dz /= l;
      const x = pos[i * 3] + dx * D,
        y = pos[i * 3 + 1] + dy * D,
        z = pos[i * 3 + 2] + dz * D;
      if (Math.hypot(x, z) > env(y) * 1.02) continue;
      const c = node(x, y, z, i, childCount[i] === 0 ? level[i] : Math.min(4, level[i] + 1), true);
      sprout[c] = sprouts(x, y, z);
      insert(c);
      grown++;
    }
    if (grown <= 1 && iter > 40) break;
  }
  // Light: every tip shades a pyramid of voxels under it (Palubicki 2009); shaded tips are pruned with their branches.
  const total = parent.length,
    removed = new Uint8Array(total),
    light = new Float64Array(total).fill(1),
    tips: number[] = [];
  for (let i = 1; i < total; i++) if (childCount[i] === 0 && active[i]) tips.push(i);
  const vs = Math.max(0.1, W / 14);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const i of tips) {
    minX = Math.min(minX, pos[i * 3]);
    maxX = Math.max(maxX, pos[i * 3]);
    minY = Math.min(minY, pos[i * 3 + 1]);
    maxY = Math.max(maxY, pos[i * 3 + 1]);
    minZ = Math.min(minZ, pos[i * 3 + 2]);
    maxZ = Math.max(maxZ, pos[i * 3 + 2]);
  }
  if (tips.length) {
    const nx = Math.ceil((maxX - minX) / vs) + 1,
      ny = Math.ceil((maxY - minY) / vs) + 1,
      nz = Math.ceil((maxZ - minZ) / vs) + 1,
      shadow = new Float32Array(nx * ny * nz),
      at = (i: number): [number, number, number] => [
        Math.floor((pos[i * 3] - minX) / vs),
        Math.floor((pos[i * 3 + 1] - minY) / vs),
        Math.floor((pos[i * 3 + 2] - minZ) / vs),
      ];
    for (const i of tips) {
      const [ix, iy, iz] = at(i);
      for (let q = 1; q <= 5; q++) {
        const yy = iy - q;
        if (yy < 0) break;
        const w = 1.5 ** -q;
        for (let a = -q; a <= q; a++)
          for (let b = -q; b <= q; b++) {
            const xx = ix + a,
              zz = iz + b;
            if (xx >= 0 && xx < nx && zz >= 0 && zz < nz) shadow[(yy * nz + zz) * nx + xx] += w;
          }
      }
    }
    // Shade is measured against the crown's own tips: the top tenth of shadow values count as no light at all.
    const own = tips.map((i) => {
        const [ix, iy, iz] = at(i);
        return shadow[(iy * nz + iz) * nx + ix];
      }),
      sorted = own.slice().sort((a, b) => a - b),
      full = Math.max(1e-6, sorted[Math.floor(sorted.length * 0.9)] * 1.15);
    tips.forEach((i, k) => {
      light[i] = clamp(1 - own[k] / full, 0, 1);
    });
  }
  for (const i of tips) if (light[i] < 0.1) removed[i] = 1;
  // Branches with no live tip left die back to the scaffold.
  const alivekids = new Int32Array(total);
  for (let i = total - 1; i > 0; i--) {
    if (!removed[i]) alivekids[parent[i]]++;
    else continue;
  }
  for (let i = total - 1; i > 0; i--)
    if (!removed[i] && active[i] && level[i] >= 2 && alivekids[i] === 0 && childCount[i] > 0) {
      removed[i] = 1;
      alivekids[parent[i]]--;
    }
  // Compact (parent first order is kept).
  const remap = new Int32Array(total).fill(-1),
    cpos: number[] = [],
    cparent: number[] = [],
    clevel: number[] = [],
    clight: number[] = [];
  for (let i = 0; i < total; i++) {
    if (removed[i]) continue;
    remap[i] = cparent.length;
    cpos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    cparent.push(i === 0 ? -1 : remap[parent[i]]);
    clevel.push(level[i]);
    clight.push(light[i]);
  }
  const m = cparent.length,
    kids = new Int32Array(m);
  for (let i = 1; i < m; i++) kids[cparent[i]]++;
  // Pipe-model radii (a tip is meshed as a 5 mm twig, so its last section tapers from the radius the model gives it).
  const radii = pipeRadii(cpos, cparent, form.dbh, 0.002);
  // Lit twig nodes: each lit tip and the thin nodes just behind it carry the cards.
  const lit: number[] = [],
    seen = new Uint8Array(cparent.length);
  for (let i = 1; i < m; i++) {
    if (kids[i] !== 0 || clight[i] < 0.3 || clevel[i] < 1) continue;
    for (let a = i, hops = 0; a > 0 && hops < 3; a = cparent[a], hops++) {
      if (seen[a] || clevel[a] < 1 || (hops > 0 && radii[a] > 0.03)) break;
      seen[a] = 1;
      lit.push(a);
    }
  }
  return {
    form,
    pos: cpos,
    parent: cparent,
    level: clevel,
    radii,
    limbs: n,
    masses,
    lit,
    light: clight,
    kids: Array.from(kids),
    cardSize: clamp(0.065 * W, 0.12, 1),
    distanceTests: tests,
    seed,
  };
}

// Leaf cards on the lit nodes: the count is the leaf area (LAI x crown ground area) over a card's leaf area, shared
// out in a seeded order; two cards in three are sprays tilted 20 to 40 degrees from flat, the rest steep crosses.
function makeCards(tree: Tree, cover: Float64Array, species: BroadleafSpecies): { cards: Card[]; leafArea: number } {
  const s = BROADLEAF_SPECIES[species],
    rand = random(tree.seed * 31 + 7),
    { pos, parent, masses, lit, light, cardSize } = tree,
    ground = Math.PI * (tree.form.crownWidth / 2) ** 2,
    meanCover = cover.reduce((a, b) => a + b, 0) / cover.length,
    wanted = lit.length && masses.length ? Math.round((s.lai * ground) / (cardSize * cardSize * meanCover)) : 0,
    order = lit.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  // Each lit node belongs to its nearest mass; a mass takes cards in proportion to its volume, spread over its nodes.
  const owner = new Map<number, number[]>();
  for (const i of order) {
    let best = 0,
      bd = Infinity;
    for (let k = 0; k < masses.length; k++) {
      const d =
        (masses[k].x - pos[i * 3]) ** 2 +
        ((masses[k].y - pos[i * 3 + 1]) * 1.6) ** 2 +
        (masses[k].z - pos[i * 3 + 2]) ** 2;
      if (d / (masses[k].rh * masses[k].rh) < bd) {
        bd = d / (masses[k].rh * masses[k].rh);
        best = k;
      }
    }
    (owner.get(best) ?? owner.set(best, []).get(best)!).push(i);
  }
  const volOf = (k: number) => masses[k].rh * masses[k].rh * masses[k].rv,
    total = [...owner.keys()].reduce((sum, k) => sum + volOf(k), 0),
    plan: [number, number][] = [];
  for (const [k, nodes] of owner)
    for (let c = 0, n = Math.round((wanted * volOf(k)) / total); c < n; c++) plan.push([k, nodes[c % nodes.length]]);
  const cards: Card[] = [];
  let area = 0;
  for (const [best, i] of plan) {
    const c = cards.length,
      x = pos[i * 3],
      y = pos[i * 3 + 1],
      z = pos[i * 3 + 2];
    const mc = masses[best];
    // Out of the node's own mass centre, and along the twig's growth.
    let ox = x - mc.x,
      oz = z - mc.z;
    const p = parent[i],
      gx = x - pos[p * 3],
      gz = z - pos[p * 3 + 2];
    ox = ox * 0.6 + gx * 0.4 * (Math.hypot(ox, oz) / (Math.hypot(gx, gz) || 1));
    oz = oz * 0.6 + gz * 0.4 * (Math.hypot(ox, oz) / (Math.hypot(gx, gz) || 1));
    const yaw0 = Math.atan2(oz, ox) + (rand() - 0.5) * 2.2,
      cross = c % 3 === 2,
      row = light[i] > 0.7 ? 0 : light[i] > 0.45 ? 1 : 2,
      tile = row * TILE_COLS + Math.floor(rand() * TILE_COLS),
      size = cardSize * (0.8 + 0.4 * rand()) * (cross ? 0.85 : 1),
      cy = Math.cos(yaw0),
      sy = Math.sin(yaw0);
    let f: [number, number, number], u: [number, number, number];
    if (cross) {
      // Steep: the width runs up the card, its normal lies near horizontal.
      f = [cy, 0.35 * (rand() - 0.5), sy];
      u = [0, 1, 0];
    } else {
      const tilt = (20 + 20 * rand()) * (Math.PI / 180) * (rand() < 0.7 ? 1 : -1);
      f = [cy * Math.cos(tilt), Math.sin(tilt), sy * Math.cos(tilt)];
      u = [-sy, 0, cy];
    }
    // A node carries several cards, spread about it so they cover the gaps between twigs.
    const jx = (rand() - 0.5) * 2.6 * cardSize,
      jy = (rand() - 0.5) * 1.4 * cardSize,
      jz = (rand() - 0.5) * 2.6 * cardSize;
    cards.push({ b: [x + jx, y + jy, z + jz], f, u, size, tile, m: [mc.x, mc.y, mc.z] });
    area += size * size * cover[tile];
  }
  return { cards, leafArea: area };
}

// ---------------------------------------------------------------------------------------------------------------
// Meshes.

interface Prepared {
  form: BroadleafForm;
  tree: Tree;
  cards: Card[];
  leafArea: number;
  atlas: BroadleafImage;
  live: boolean;
}

function prepare(species: BroadleafSpecies, options: BroadleafMeshOptions): Prepared {
  if (!Object.hasOwn(BROADLEAF_SPECIES, species))
    throw new RangeError(`Unknown broadleaf species '${String(species)}'; pass one of BROADLEAF_SPECIES_IDS.`);
  const condition = options.condition ?? 'live',
    seed = options.seed ?? 1,
    size = options.atlasSize ?? 512;
  if (condition !== 'live' && condition !== 'bare') throw new RangeError("condition must be 'live' or 'bare'.");
  if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff))
    throw new RangeError('seed must be an unsigned 32-bit integer.');
  if (!(Number.isInteger(Math.log2(size)) && size >= 128 && size <= 1024))
    throw new RangeError('atlasSize must be a power of two from 128 to 1024.');
  const form = broadleafForm(species, options),
    tree = grow(species, form, seed),
    drawn = drawLeaves(BROADLEAF_SPECIES[species], size),
    live = condition === 'live',
    made = live ? makeCards(tree, drawn.cover, species) : { cards: [], leafArea: 0 };
  return { form, tree, cards: made.cards, leafArea: made.leafArea, atlas: drawn.image, live };
}

// A sub-skeleton of the nodes `keep` accepts (their parents are kept too: orders never fall toward the leaves).
function skeletonOf(tree: Tree, keep: (i: number) => boolean, taper = true): Required<TreeMeshSkeleton> {
  const n = tree.parent.length,
    remap = new Int32Array(n).fill(-1),
    positions: number[] = [],
    parents: number[] = [],
    radii: number[] = [],
    levels: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!keep(i)) continue;
    remap[i] = parents.length;
    positions.push(tree.pos[i * 3], tree.pos[i * 3 + 1], tree.pos[i * 3 + 2]);
    parents.push(i === 0 ? -1 : remap[tree.parent[i]]);
    radii.push(tree.radii[i]);
    levels.push(tree.level[i]);
  }
  const kept = new Int32Array(parents.length);
  for (let i = 1; i < parents.length; i++) kept[parents[i]]++;
  if (taper) for (let i = 1; i < parents.length; i++) if (kept[i] === 0) radii[i] = Math.min(radii[i], 0.005);
  return {
    positions: Float64Array.from(positions),
    parents: Int32Array.from(parents),
    radii: Float64Array.from(radii),
    levels: Uint8Array.from(levels),
  };
}

function wood(
  p: Prepared,
  detail: 0 | 1 | 2,
  seed: number,
): { trunk: GeometryData; skeleton: Required<TreeMeshSkeleton> } {
  const tree = p.tree,
    keep =
      detail === 2
        ? (i: number) => tree.level[i] <= 2 || (tree.level[i] === 3 && tree.kids[i] > 0)
        : detail === 1 || !p.live
          ? (i: number) => tree.level[i] <= 1
          : (i: number) => tree.level[i] === 0,
    skeleton = skeletonOf(tree, keep),
    segments =
      detail === 2
        ? { 0: 10, 1: 7, 2: 4, 3: 3, 4: 3 }
        : detail === 1
          ? { 0: 8, 1: 5, 2: 3, 3: 3, 4: 3 }
          : { 0: 5, 1: 3, 2: 3, 3: 3, 4: 3 },
    mesh = meshTree(skeleton, {
      seed,
      bark: { type: 'oak' },
      leaves: { count: 0 },
      branch: { segments },
      detail: { sectionStride: detail === 2 ? 1 : detail === 1 ? 2 : 3 },
    });
  return { trunk: mesh.bark, skeleton };
}

const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// Cards as indexed quads, both faces on the same vertices. `every` thins them, `scale` grows each card's side.
function canopyOf(cards: readonly Card[], every: number, scale: number, atlasSize: number): GeometryData {
  const p: number[] = [],
    nrm: number[] = [],
    uv: number[] = [],
    idx: number[] = [],
    inset = 1 / atlasSize;
  for (let c = 0; c < cards.length; c += every) {
    const { b, f, u, tile, m } = cards[c],
      size = cards[c].size * scale,
      col = tile % TILE_COLS,
      row = Math.floor(tile / TILE_COLS),
      u0 = col / TILE_COLS + inset,
      u1 = (col + 1) / TILE_COLS - inset,
      v0 = row / (2 * TILE_COLS) + inset,
      v1 = (row + 1) / (2 * TILE_COLS) - inset,
      face = norm([u[1] * f[2] - u[2] * f[1], u[2] * f[0] - u[0] * f[2], u[0] * f[1] - u[1] * f[0]]),
      centre: [number, number, number] = [b[0] + f[0] * size * 0.5, b[1] + f[1] * size * 0.5, b[2] + f[2] * size * 0.5],
      out = norm([centre[0] - m[0], centre[1] - m[1], centre[2] - m[2]]),
      // Sprays face the sky; steep cards face away from their mass.
      sign = Math.abs(face[1]) > 0.5 ? (face[1] < 0 ? -1 : 1) : face[0] * out[0] + face[2] * out[2] < 0 ? -1 : 1,
      n = norm([
        face[0] * sign * 0.5 + out[0] * 0.5,
        face[1] * sign * 0.5 + out[1] * 0.5,
        face[2] * sign * 0.5 + out[2] * 0.5,
      ]),
      first = p.length / 3;
    for (const [s, t] of [
      [-1, 0],
      [1, 0],
      [1, 1],
      [-1, 1],
    ]) {
      p.push(
        b[0] + u[0] * s * size * 0.5 + f[0] * t * size,
        b[1] + u[1] * s * size * 0.5 + f[1] * t * size,
        b[2] + u[2] * s * size * 0.5 + f[2] * t * size,
      );
      nrm.push(n[0], n[1], n[2]);
      uv.push(s < 0 ? u0 : u1, t ? v0 : v1);
    }
    idx.push(
      first,
      first + 1,
      first + 2,
      first,
      first + 2,
      first + 3,
      first,
      first + 2,
      first + 1,
      first,
      first + 3,
      first + 2,
    );
  }
  return geometryData(p, nrm, uv, idx);
}

/**
 * A broadleaf at an age or height: trunk forking into limbs with pipe-model radii and twigs grown by space
 * colonisation, shaded inner branches shed, leaf cards cut from a code-drawn atlas, or the bare wood in winter.
 * @throws RangeError for an unknown species or an option out of range.
 * @example
 * const oak = generateBroadleafMesh('english-oak', { age: 'mature' });
 * oak.limbs; // 4 to 7
 */
export function generateBroadleafMesh(species: BroadleafSpecies, options: BroadleafMeshOptions = {}): BroadleafMesh {
  const detail = options.detail ?? 2;
  if (detail !== 0 && detail !== 1 && detail !== 2) throw new RangeError('detail must be 0, 1 or 2.');
  const p = prepare(species, options),
    w = wood(p, detail, (options.seed ?? 1) >>> 0),
    canopy =
      !p.live || detail === 0
        ? geometryData([], [], [], [])
        : detail === 2
          ? canopyOf(p.cards, 1, 1, p.atlas.width)
          : canopyOf(p.cards, 4, 2.25, p.atlas.width);
  return {
    trunk: w.trunk,
    canopy,
    form: p.form,
    limbs: p.tree.limbs,
    masses: p.tree.masses.length,
    leafArea: p.leafArea,
    distanceTests: p.tree.distanceTests,
    skeleton: skeletonOf(p.tree, () => true, false),
    atlas: p.atlas,
  };
}

/** Options of {@link generateBroadleafImposter}. */
export interface BroadleafImposterOptions {
  /** Vertical cards, 2 to 4, evenly turned, each with its own baked view. Default 3. */
  readonly cards?: number;
}

/** The far level of a broadleaf: crossed cards, their uvs and the image they sample. */
export interface BroadleafImposter {
  /** The cards, both faces, standing on y = 0: 72 triangles for three cards. */
  readonly geometry: GeometryData;
  /** The leaf atlas (top half) with each card's baked view (bottom half, 2 by 2 tiles): sRGB colour, alpha coverage. */
  readonly image: BroadleafImage;
  /** Share of the baked views' pixels the tree covers. */
  readonly coverage: number;
}

/**
 * Bakes a broadleaf mesh into an imposter: for each of `cards` vertical quads through the trunk axis, the near mesh
 * seen orthographically along the card's normal from 15 degrees above the horizon (the middle of the views a tree is
 * seen from), drawn into a tile of the lower half of the atlas with a z-buffer
 * (leaf cards cut by the atlas' alpha, bark, albedo darkened with depth into the crown as an occlusion term).
 * @throws RangeError for a bad card count or a mesh with no triangles.
 */
export function generateBroadleafImposter(
  mesh: {
    readonly trunk: GeometryData;
    readonly canopy: GeometryData;
    readonly form?: BroadleafForm;
    readonly atlas: BroadleafImage;
  },
  options: BroadleafImposterOptions = {},
): BroadleafImposter {
  const cards = options.cards ?? 3,
    S = mesh.atlas.width;
  if (!(Number.isInteger(cards) && cards >= 2 && cards <= 4)) throw new RangeError('cards must be 2 to 4.');
  const sp = mesh.form ? BROADLEAF_SPECIES[mesh.form.species] : BROADLEAF_SPECIES['english-oak'],
    bark = sp.bark;
  let R = 0,
    top = 0;
  for (const g of [mesh.trunk, mesh.canopy])
    for (let k = 0; k < g.positions.length; k += 3) {
      R = Math.max(R, Math.hypot(g.positions[k], g.positions[k + 2]));
      top = Math.max(top, g.positions[k + 1]);
    }
  if (!(R > 0 && top > 0) || mesh.trunk.indices.length + mesh.canopy.indices.length === 0)
    throw new RangeError('The imposter needs a mesh with triangles.');
  const T = S / 2,
    data = new Uint8Array(mesh.atlas.data),
    atlas = mesh.atlas;
  let covered = 0;
  for (let c = 0; c < cards; c++) {
    const a = (c / cards) * Math.PI,
      ux = Math.cos(a),
      uz = Math.sin(a),
      nx = -Math.sin(a),
      nz = Math.cos(a),
      depth = new Float32Array(T * T).fill(-Infinity),
      color = new Float32Array(T * T * 3);
    for (const [g, leaf] of [
      [mesh.trunk, false],
      [mesh.canopy, true],
    ] as const) {
      const P = g.positions,
        I = g.indices,
        UV = g.uvs,
        X = (i: number) => ((P[i * 3] * ux + P[i * 3 + 2] * uz + R) / (2 * R)) * T,
        Z = (i: number) => P[i * 3] * nx + P[i * 3 + 2] * nz,
        // Seen from 15 degrees above the horizon: nearer points sit lower on the card, so the card is right at that height.
        Y = (i: number) => (1 - (P[i * 3 + 1] - Z(i) * TILT) / top) * T;
      for (let t = 0; t < I.length; t += 3) {
        const [i0, i1, i2] = [I[t], I[t + 1], I[t + 2]],
          ax = X(i0),
          ay = Y(i0),
          bx = X(i1),
          by = Y(i1),
          cx = X(i2),
          cy = Y(i2),
          area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1e-12) continue;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
          x1 = Math.min(T - 1, Math.ceil(Math.max(ax, bx, cx))),
          y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
          y1 = Math.min(T - 1, Math.ceil(Math.max(ay, by, cy)));
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5,
              py = y + 0.5,
              w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area,
              w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area,
              w2 = 1 - w0 - w1;
            if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
            const z = w0 * Z(i0) + w1 * Z(i1) + w2 * Z(i2),
              o = y * T + x;
            if (z <= depth[o]) continue;
            let r: number, gg: number, b: number;
            if (leaf) {
              const u = w0 * UV[i0 * 2] + w1 * UV[i1 * 2] + w2 * UV[i2 * 2],
                v = w0 * UV[i0 * 2 + 1] + w1 * UV[i1 * 2 + 1] + w2 * UV[i2 * 2 + 1],
                tx = Math.min(atlas.width - 1, Math.floor(u * atlas.width)),
                ty = Math.min(atlas.height - 1, Math.floor(v * atlas.height)),
                q = (ty * atlas.width + tx) * 4;
              if (atlas.data[q + 3] < 128) continue;
              r = toLinear(atlas.data[q]);
              gg = toLinear(atlas.data[q + 1]);
              b = toLinear(atlas.data[q + 2]);
            } else [r, gg, b] = bark;
            depth[o] = z;
            const shade = 0.45 + 0.55 * Math.min(1, Math.max(0, (z + R) / (2 * R)) * 1.3);
            color[o * 3] = r * shade;
            color[o * 3 + 1] = gg * shade;
            color[o * 3 + 2] = b * shade;
          }
      }
    }
    const ox = (c % 2) * T,
      oy = S + (c >> 1) * T;
    let mr = 0,
      mg = 0,
      mb = 0,
      n = 0;
    for (let k = 0; k < T * T; k++)
      if (depth[k] > -Infinity) {
        mr += color[k * 3];
        mg += color[k * 3 + 1];
        mb += color[k * 3 + 2];
        n++;
      }
    covered += n;
    const fill = n
      ? [(mr / n) * 0.7, (mg / n) * 0.7, (mb / n) * 0.7]
      : [sp.leaves[0] * 0.7, sp.leaves[1] * 0.7, sp.leaves[2] * 0.7];
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const k = y * T + x,
          o = ((oy + y) * S + ox + x) * 4,
          has = depth[k] > -Infinity;
        data[o] = toSrgb(has ? color[k * 3] : fill[0]);
        data[o + 1] = toSrgb(has ? color[k * 3 + 1] : fill[1]);
        data[o + 2] = toSrgb(has ? color[k * 3 + 2] : fill[2]);
        data[o + 3] = has ? 255 : 0;
      }
  }
  const p: number[] = [],
    uv: number[] = [],
    idx: number[] = [],
    rows = 6,
    inset = 0.5 / S;
  for (let c = 0; c < cards; c++) {
    const a = (c / cards) * Math.PI,
      ux = Math.cos(a),
      uz = Math.sin(a),
      first = p.length / 3,
      u0 = (c % 2) * 0.5 + inset,
      u1 = (c % 2) * 0.5 + 0.5 - inset,
      vTop = 0.5 + (c >> 1) * 0.25,
      v0 = vTop + inset,
      v1 = vTop + 0.25 - inset;
    for (let r = 0; r <= rows; r++)
      for (const side of [-1, 1]) {
        p.push(ux * R * side, (top * r) / rows, uz * R * side);
        uv.push(side < 0 ? u0 : u1, v1 - (v1 - v0) * (r / rows));
      }
    for (let r = 0; r < rows; r++) {
      const a0 = first + r * 2,
        b0 = a0 + 1,
        a1 = a0 + 2,
        b1 = a0 + 3;
      idx.push(a0, b0, a1, a1, b0, b1, a0, a1, b0, a1, b1, b0);
    }
  }
  const quad = geometryData(p, new Array<number>(p.length).fill(0), uv, idx);
  // Card normals: out from the axis and a little up, so a card lights as the crown does.
  for (let k = 0; k < quad.positions.length; k += 3) {
    const x = quad.positions[k],
      z = quad.positions[k + 2],
      l = Math.hypot(x, 0.45 * R, z) || 1;
    quad.normals[k] = x / l;
    quad.normals[k + 1] = (0.45 * R) / l;
    quad.normals[k + 2] = z / l;
  }
  return { geometry: quad, image: { width: S, height: atlas.height, data }, coverage: covered / (cards * T * T) };
}

/** Options of {@link broadleafLevels}. */
export interface BroadleafLevelsOptions extends Omit<BroadleafMeshOptions, 'detail' | 'atlasSize'> {
  /** Atlas image side (the imposter tiles are half of it). Default 512. */
  readonly imposterSize?: number;
}

/** The three LOD rings of a broadleaf for scatter: near and middle meshes and the imposter (leafed trees). */
export interface BroadleafLevels {
  readonly form: BroadleafForm;
  /** Wood per ring: near, middle, far (a leafed tree's far wood is in the imposter: one degenerate triangle). */
  readonly trunk: readonly [GeometryData, GeometryData, GeometryData];
  /** Cards per ring: near, middle, imposter cards; empty on a bare tree. */
  readonly canopy: readonly [GeometryData, GeometryData, GeometryData];
  /** Scatter `textures` of the canopy rings: uvs per ring and the shared atlas (undefined on a bare tree). */
  readonly textures?: {
    readonly uvs: readonly [Float32Array, Float32Array, Float32Array];
    readonly baseColor: BroadleafImage;
    readonly alphaCutoff: number;
  };
}

/**
 * A broadleaf's three scatter LOD rings: near (detail 2), middle (detail 1) and, for a leafed tree, the imposter of
 * the near mesh, all drawing one atlas image (draw the canopy white: its colour is in the image). A bare tree draws
 * its wood at three coarseness levels. The tree is grown once for all rings.
 */
export function broadleafLevels(species: BroadleafSpecies, options: BroadleafLevelsOptions = {}): BroadleafLevels {
  const { imposterSize, ...rest } = options,
    p = prepare(species, { ...rest, ...(imposterSize === undefined ? {} : { atlasSize: imposterSize }) }),
    seed = (options.seed ?? 1) >>> 0,
    near = wood(p, 2, seed),
    middle = wood(p, 1, seed);
  if (!p.live) {
    const far = wood(p, 0, seed),
      none = geometryData([], [], [], []);
    return { form: p.form, trunk: [near.trunk, middle.trunk, far.trunk], canopy: [none, none, none] };
  }
  const nearCanopy = canopyOf(p.cards, 1, 1, p.atlas.width),
    middleCanopy = canopyOf(p.cards, 4, 2.25, p.atlas.width),
    imp = generateBroadleafImposter({ trunk: near.trunk, canopy: nearCanopy, form: p.form, atlas: p.atlas }),
    none = geometryData(
      [0, 0, 0, 0, 0.001, 0, 0.001, 0, 0],
      [0, 1, 0, 0, 1, 0, 0, 1, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 1, 2],
    );
  return {
    form: p.form,
    trunk: [near.trunk, middle.trunk, none],
    canopy: [nearCanopy, middleCanopy, imp.geometry],
    textures: {
      uvs: [nearCanopy.uvs, middleCanopy.uvs, imp.geometry.uvs],
      baseColor: imp.image,
      alphaCutoff: 0.5,
    },
  };
}
