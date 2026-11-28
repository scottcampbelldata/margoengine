import { coneGeometry, cylinderGeometry, icosahedronGeometry } from '@margoengine/geometry/primitives';
import { createRandom } from '@margoengine/math/mathutils';
import {
  geometryData,
  mergeGeometries,
  mergeVertices,
  computeTangents,
  computeVertexNormals,
  toNonIndexed,
  applyMatrix4,
  type GeometryData,
} from '@margoengine/geometry/utils';
import { Noise } from './noise.js';

export function placed(
  data: GeometryData,
  x: number,
  y: number,
  z: number,
  sx = 1,
  sy = 1,
  sz = 1,
  yaw = 0,
  roll = 0,
): GeometryData {
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    a = Math.cos(roll),
    b = Math.sin(roll);
  return applyMatrix4(data, [
    c * a * sx,
    b * sx,
    -s * a * sx,
    0,
    -c * b * sy,
    a * sy,
    s * b * sy,
    0,
    s * sz,
    0,
    c * sz,
    0,
    x,
    y,
    z,
    1,
  ]);
}

function radialNormals(data: GeometryData, cx = 0, cy = 0, cz = 0): GeometryData {
  for (let i = 0; i < data.positions.length; i += 3) {
    const x = data.positions[i] - cx,
      y = data.positions[i + 1] - cy,
      z = data.positions[i + 2] - cz,
      length = Math.hypot(x, y, z);
    data.normals[i] = x / length;
    data.normals[i + 1] = y / length;
    data.normals[i + 2] = z / length;
  }
  return data;
}

/** Mixes 40 percent of each part's own radial direction into the canopy normals; `parts` lie in `data` in order. */
function mixLobeNormals(data: GeometryData, parts: readonly GeometryData[], centers: readonly number[][]): void {
  let vertex = 0;
  parts.forEach((part, k) => {
    const [cx, cy, cz] = centers[k],
      end = vertex + part.positions.length / 3;
    for (; vertex < end; vertex++) {
      const i = vertex * 3,
        x = data.positions[i] - cx,
        y = data.positions[i + 1] - cy,
        z = data.positions[i + 2] - cz,
        length = Math.hypot(x, y, z) || 1,
        nx = 0.6 * data.normals[i] + (0.4 * x) / length,
        ny = 0.6 * data.normals[i + 1] + (0.4 * y) / length,
        nz = 0.6 * data.normals[i + 2] + (0.4 * z) / length,
        norm = Math.hypot(nx, ny, nz) || 1;
      data.normals[i] = nx / norm;
      data.normals[i + 1] = ny / norm;
      data.normals[i + 2] = nz / norm;
    }
  });
}

/** Radius factor of a lumpy lobe at unit direction (x, y, z): three octaves of smooth bumps. */
function lump(x: number, y: number, z: number): number {
  let radius = 1;
  for (let octave = 0; octave < 3; octave++) {
    const frequency = 3 * 2 ** octave;
    radius += (0.2 / 2 ** octave) * Math.sin(x * frequency) * Math.cos(y * frequency) * Math.sin(z * frequency);
  }
  return radius;
}

export function perturb(data: GeometryData): GeometryData {
  for (let i = 0; i < data.positions.length; i += 3) {
    const radius = lump(data.positions[i], data.positions[i + 1], data.positions[i + 2]);
    data.positions[i] *= radius;
    data.positions[i + 1] *= radius;
    data.positions[i + 2] *= radius;
  }
  return data;
}

/** Mesh detail level: 2 is the full mesh (the default), 1 about half its triangles, 0 the far-ring silhouette. */
export type MeshDetail = 0 | 1 | 2;

/** Options shared by the tree, shrub and plant mesh generators. */
export interface MeshDetailOptions {
  /**
   * Triangle budget: 2 keeps the full mesh, 1 uses coarser lobes and fewer leaf clumps (about half the triangles),
   * 0 merges the lobes into a handful of coarse ones for far LOD rings (a few percent of the triangles, same
   * silhouette within about 25 percent of its size). Default 2.
   */
  detail?: MeshDetail;
}

/** Validates `options.detail`; returns the level (2 when absent). */
export function resolveDetail(options: MeshDetailOptions | undefined): MeshDetail {
  const detail = options?.detail === undefined ? 2 : options.detail;
  if (detail !== 0 && detail !== 1 && detail !== 2) throw new RangeError('Invalid mesh detail; pass 0, 1 or 2.');
  return detail;
}

/** One lumpy ellipsoid lobe: centre, radii and yaw. */
export interface LobeSpec {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
}

/** Merges each group of lobes into one lobe that covers them (centre of the group, per-axis extent, 0.85 fit). */
export function mergeLobeGroups(lobes: readonly LobeSpec[], groups: readonly (readonly number[])[]): LobeSpec[] {
  return groups.map((group) => {
    const members = group.map((i) => lobes[i]),
      n = members.length,
      x = members.reduce((a, m) => a + m.x, 0) / n,
      y = members.reduce((a, m) => a + m.y, 0) / n,
      z = members.reduce((a, m) => a + m.z, 0) / n;
    let sx = 0,
      sy = 0,
      sz = 0;
    for (const m of members) {
      sx = Math.max(sx, Math.abs(m.x - x) + m.sx);
      sy = Math.max(sy, Math.abs(m.y - y) + m.sy);
      sz = Math.max(sz, Math.abs(m.z - z) + m.sz);
    }
    return { x, y, z, sx: sx * 0.85, sy: sy * 0.85, sz: sz * 0.85, yaw: 0 };
  });
}

/** Consecutive groups of `size` indices from 0 to `count`: [[0,1,2],[3,4,5],...]. */
export function consecutiveGroups(count: number, size: number): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i < count; i += size) groups.push(Array.from({ length: Math.min(size, count - i) }, (_, k) => i + k));
  return groups;
}

/** A bounding box as [minX, minY, minZ, maxX, maxY, maxZ] in tree-local metres. */
export type HullBox = readonly [number, number, number, number, number, number];

/**
 * Detail-0 meshes merge or coarsen their lobes, which pulls the outline inside the full mesh (flat facets, fewer and
 * lower leaf clumps). This stretches the pieces of a detail-0 canopy per axis so their joint bounding box equals
 * `hull`, the detail-2 canopy's box, and carries `points` (lobe centres) with them. Normals follow the inverse
 * scale and stay unit length. Pieces and points are changed in place.
 */
export function fitToHull(pieces: readonly GeometryData[], hull: HullBox, points: number[][] = []): void {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (const { positions } of pieces)
    for (let i = 0; i < positions.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3], positions[i]);
      hi[i % 3] = Math.max(hi[i % 3], positions[i]);
    }
  const scale = lo.map((v, k) => (hi[k] > v ? (hull[k + 3] - hull[k]) / (hi[k] - v) : 1)),
    move = (v: number, k: number) => hull[k] + (v - lo[k]) * scale[k];
  for (const { positions, normals } of pieces) {
    for (let i = 0; i < positions.length; i++) positions[i] = move(positions[i], i % 3);
    for (let i = 0; normals && i < normals.length; i += 3) {
      const n = [0, 1, 2].map((k) => normals[i + k] / scale[k]),
        length = Math.hypot(n[0], n[1], n[2]) || 1;
      for (let k = 0; k < 3; k++) normals[i + k] = n[k] / length;
    }
  }
  for (const point of points) for (let k = 0; k < 3; k++) point[k] = move(point[k], k);
}

/** The detail-2 canopy boxes the detail-0 meshes are fitted to (a test compares them with the real meshes). */
export const FULL_HULLS = {
  conifer: [-1.74, 1.25, -2.47, 2.38, 7.4, 2.39],
  broadleaf: [-2.83, 3.44, -3.51, 3.76, 7.48, 3.46],
  palm: [-1.81, 8, -3.16, 4.4, 8.38, 2.99],
  birch: [-1.32, 4.22, -1.21, 1.17, 10.38, 1.25],
  acacia: [-3.56, 4.1, -3.52, 3.24, 4.65, 3.57],
  shrub: [-0.66, -0.04, -0.61, 0.7, 0.85, 0.83],
  tundra: [-0.85, -0.04, -0.82, 0.86, 0.3, 0.84],
} as const satisfies Record<string, HullBox>;

/**
 * Leaf clumps around one lumpy lobe centred at (x, y, z) with radii (size, 0.87 size, size): opaque double-sided
 * diamonds that start inside the surface and reach past it, so the canopy outline breaks into leafy points instead of
 * a smooth blob. Opaque on purpose: an alpha-tested card needs a fragment discard, which costs tile-based phone GPUs
 * their early depth rejection.
 */
function leafClumps(x: number, y: number, z: number, size: number, phase: number, count = 24): GeometryData {
  const positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  for (let k = 0; k < count; k++) {
    // Fibonacci directions, turned per lobe so neighbouring lobes do not line their clumps up.
    const dy = 1 - (2 * (k + 0.5)) / count,
      ring = Math.sqrt(1 - dy * dy),
      angle = k * 2.399963 + phase,
      dx = Math.cos(angle) * ring,
      dz = Math.sin(angle) * ring,
      r = lump(dx, dy, dz) * size,
      vary = 0.75 + 0.5 * ((k * 0.618034 + phase * 0.31) % 1);
    // Outward direction on the scaled lobe, leaning up toward the light; side axis rolled per clump.
    let ox = dx,
      oy = dy * 0.87 + 0.35,
      oz = dz;
    const ol = Math.hypot(ox, oy, oz);
    ox /= ol;
    oy /= ol;
    oz /= ol;
    const al = Math.hypot(ox, oz),
      ax = al > 1e-3 ? -oz / al : 1,
      az = al > 1e-3 ? ox / al : 0,
      bx = oy * az,
      by = oz * ax - ox * az,
      bz = -oy * ax,
      roll = k * 1.3 + phase,
      w = 0.2 * size * vary,
      sx = (ax * Math.cos(roll) + bx * Math.sin(roll)) * w,
      sy = by * Math.sin(roll) * w,
      sz = (az * Math.cos(roll) + bz * Math.sin(roll)) * w;
    const px = x + dx * r,
      py = y + dy * r * 0.87,
      pz = z + dz * r,
      inner = 0.2 * size,
      outer = 0.3 * size * vary,
      base = [px - ox * inner, py - oy * inner, pz - oz * inner],
      tip = [px + ox * outer, py + oy * outer, pz + oz * outer],
      mid = [(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, (base[2] + tip[2]) / 2],
      corners = [...base, mid[0] + sx, mid[1] + sy, mid[2] + sz, ...tip, mid[0] - sx, mid[1] - sy, mid[2] - sz],
      start = positions.length / 3;
    // Front and back get their own vertices so each side keeps a consistent tangent frame.
    positions.push(...corners, ...corners);
    uvs.push(0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5, 0.5, 0, 1, 0.5, 0.5, 1, 0, 0.5);
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    indices.push(start + 4, start + 6, start + 5, start + 4, start + 7, start + 6);
  }
  return geometryData(positions, new Float32Array(positions.length), uvs, indices);
}

/** Options of {@link generateTreeMesh}: the detail level, and for a conifer whether its tiers are branch whorls. */
export interface TreeMeshShapeOptions extends MeshDetailOptions {
  /**
   * Conifer only, detail 1 and 2: build each tier as a whorl of drooping branch sprays with gaps between them, as a
   * spruce's branches grow (7 main branches a whorl and 5 shorter ones between whorls, each a cupped spray that droops
   * toward its tip), instead of one jagged skirt. A tree seen up close, from below or against the sky then shows its
   * branches, the sky between them and each spray's own shading, where a skirt reads as one flat dark shape. Its
   * normals mix the spray's surface with the crown's radial direction and a per-vertex needle tilt. Default false: the
   * skirts, about a third of the triangles, for mid and far trees. `createTree` turns it on.
   */
  branches?: boolean;
  /**
   * Conifer with `branches`, detail 1 and 2: build each spray as the branch it stands for, a twig axis with lateral
   * shoots along it, alternating sides, each shoot and the axis edged with a serrated fringe of needle tufts, and the
   * sky between the shoots, inside the plain spray's outline. Seen from 1 to 30 m a branch then shows its twigs, ragged
   * needle edges and gaps, where the plain spray reads as one smooth tapered blade. About ten times the plain
   * sprays' triangles, so `createTree` builds it only for trees near the camera (its `shootDistance`). `'coarse'` is
   * the same branch for mid and far trees: at detail 2 the lateral shoots half as far apart again and 1.55 times as
   * wide, at detail 1 the same laterals, the needle fringe's serration folded into the band's width, so it covers the same
   * share of its outline as the shoots from every side, with the same normals and so the same colour and snow. This is
   * the level of detail rule of aggregate geometry: a coarser level keeps the expected projected area and the
   * distribution of normals of what it stands for (Cook, Halstead, Planck and Ryu 2007, Stochastic simplification of
   * aggregate detail; Lacewell, Edwards, Shirley and Thompson 2006, Stochastic billboard clouds; Bruneton and Neyret
   * 2012, Real-time realistic rendering and lighting of forests; Deussen, Colditz, Stamminger and Drettakis 2002,
   * Interactive visualization of complex plant ecosystems). The plain sprays cover all of their outline where the
   * shoots cover about 60 percent, so a tree switching between them changes its look. Default false: the plain sprays.
   */
  shoots?: boolean | 'coarse';
  /**
   * Butt flare: the trunk's diameter at the ground over its diameter at breast height (1.3 m of the unscaled mesh),
   * 1 to 2.5. The swell dies away over about the lowest 0.25 m, as a stem's butt swell does below breast height.
   * Unset: the historical trunk, one ring widened 1.8 times at the ground (about 2.1 times the breast-height
   * diameter). `createTree` gives a conifer `SPRUCE_FLARE`, 1.3.
   */
  flare?: number;
  /**
   * With `flare`: the height in mesh metres where the breast-height diameter is taken, 0.3 to 6. Default 1.3.
   * `createTree` sets 1.3 m of the placed tree (1.3 divided by its scale), so the flare holds at every height.
   */
  breastHeight?: number;
  /**
   * The trunk's diameter at `breastHeight` (1.3 m when unset) in mesh metres, 0.005 to 3: the whole trunk is scaled
   * across (not up) to it, so its taper and flare keep their shape. Unset: the historical trunk, about 0.55 m at 1.3 m
   * of the 7.6 m conifer. `createTree` gives a conifer the measured spruce stem for its height (`spruceDiameter`).
   */
  breastDiameter?: number;
}

/** Shoot layout of a near spray: metres along the axis per lateral shoot, and per needle tuft along a shoot. */
interface ShootSpacing {
  spacing: number;
  tooth: number;
  /**
   * The coarse level: no serrated teeth, each band as wide as the toothed band's mean (its half width w plus half of
   * the teeth's reach beyond it, the teeth being triangles), and the laterals widened by `widen`, the coarse spacing over
   * the near one, so the projected area per metre of branch is the near level's.
   */
  coarse?: { widen: number; ratio: number };
}

// One spray built as the branch it stands for, inside the plain spray's outline (half width `halfWidth` times the same
// profile, the same droop and cupping). A first-order axis runs from the trunk to the tip; lateral (second-order) shoots
// leave it every `spacing` metres, alternating sides, about 55 degrees forward of the axis, and run out to the outline;
// the spruce's flat, two-ranked branch system (Weber and Penn 1995, the child stems' down angle and rotation along their
// parent; Deussen and Lintermann 2005, ch. 6). Every shoot is a narrow twig strip edged on both sides by a serrated
// fringe, one forward-swept tooth per `tooth` metres: the needle tufts, about 30 mm a side for a Norway spruce shoot
// with its needles (needles 10 to 25 mm, Farjon 2010, A Handbook of the World's Conifers) and the third-order twigs that
// the fringe stands for. The sky shows between the shoots and between the teeth; a shoot's silhouette is the shoot's
// projected area, not its needles' (Smolander and Stenberg 2003, shoot silhouette to total area). Triangles wind as the
// plain spray's do, so their face normals point up.
// Reach of a lateral shoot's needle tufts beyond its twig, metres.
const NEEDLE_TUFT = 0.034;
// The leader (KB-CABIN-LEADER1): the stem's terminal shoot, this year's growth unit standing on the youngest whorl,
// 0.5 m to the crown's top (a young Norway spruce's annual height growth, 7 m in 20 years and quickening; Pokorný and
// Tomášková 2007), with no side shoots yet, and its half width, the axis twig and its needle tufts. A spruce grows
// rhythmically, a growth unit a year from the terminal bud, with a whorl of lateral buds at each unit's top (Hallé,
// Oldeman and Tomlinson 1978, Tropical Trees and Forests: An Architectural Analysis; Fabrika et al. 2019, BioResources,
// crown architecture of young Norway spruce).
const LEADER = 0.5,
  LEADER_HALF = 0.042,
  // The crown cone's half angle: the lowest whorl's 2.1 m reach under the 5.6 m from its top to the crown's.
  CROWN_HALF = Math.atan2(2.1, 5.6),
  CROWN_COS = Math.cos(CROWN_HALF),
  CROWN_SIN = Math.sin(CROWN_HALF);
function branchShoots(
  positions: number[],
  uvs: number[],
  indices: number[],
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dz: number,
  len: number,
  halfWidth: number,
  droop: number,
  { spacing, tooth, coarse }: ShootSpacing,
  hash: (n: number) => number,
  upright = false,
): void {
  const planar: number[] = [],
    halfAt = (t: number) =>
      halfWidth * Math.sin(Math.PI * Math.min(1, t * 0.85 + 0.15)) ** 0.8 * Math.min(1, 0.25 + t * 1.9),
    // The point s metres out along the axis and l metres to its side, drooped and cupped as the plain spray is; an
    // upright shoot (the leader) runs straight up from (cx, cy, cz) with its side l across (dx, dz).
    put = (s: number, l: number) => {
      const t = Math.min(1, Math.max(0, s / len)),
        r = 0.06 + s,
        drop = droop * (0.35 * t + 0.65 * t * t),
        cup = (0.28 * l * l) / Math.max(halfAt(t), halfWidth * 0.1);
      if (upright) positions.push(cx - dz * l, cy + s, cz + dx * l);
      else positions.push(cx + dx * r - dz * l, cy - drop - cup, cz + dz * r + dx * l);
      uvs.push(t, 0.5 + l / (2 * halfWidth));
      planar.push(s, l);
      return positions.length / 3 - 1;
    },
    base = positions.length / 3,
    tri = (a: number, b: number, c: number) => {
      const pa = (a - base) * 2,
        pb = (b - base) * 2,
        pc = (c - base) * 2,
        area =
          (planar[pb] - planar[pa]) * (planar[pc + 1] - planar[pa + 1]) -
          (planar[pb + 1] - planar[pa + 1]) * (planar[pc] - planar[pa]);
      // The plain spray's first triangle has a negative area in (s, l): keep that winding.
      if (area < 0) indices.push(a, b, c);
      else indices.push(a, c, b);
    },
    // A shoot from (s0, l0) along unit (as, al) for `length` metres: twig half width `twig`, tufts `needle` long.
    fringe = (
      s0: number,
      l0: number,
      as: number,
      al: number,
      length: number,
      twig: number,
      needle: number,
      widen = 1,
    ) => {
      const steps = Math.max(coarse ? 1 : 2, Math.ceil(length / tooth));
      let left = -1,
        right = -1;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps,
          // The band of needles along the twig, then the tufts' serrated tips beyond it. The coarse band is the toothed
          // band's mean width: w, plus half of the teeth's mean reach (hash 0.5) beyond it.
          band = (twig + 0.45 * needle) * (1 - 0.6 * f),
          w = coarse ? widen * 0.5 * (band + (twig + needle * 1.025) * (1 - 0.55 * f)) : band,
          s = s0 + as * length * f,
          l = l0 + al * length * f,
          nextLeft = put(s - al * w, l + as * w),
          nextRight = put(s + al * w, l - as * w);
        if (i > 0 && coarse) {
          tri(left, right, nextLeft);
          tri(nextLeft, right, nextRight);
        } else if (i > 0) {
          const m = (i - 0.5) / steps,
            k = 1 - 0.55 * m,
            reach = (twig + needle * (0.85 + 0.35 * hash(i * 7 + steps))) * k,
            ms = s0 + as * length * m + as * needle * k * 0.6,
            ml = l0 + al * length * m + al * needle * k * 0.6;
          tri(left, right, nextLeft);
          tri(nextLeft, right, nextRight);
          tri(left, nextLeft, put(ms - al * reach, ml + as * reach));
          tri(right, nextRight, put(ms + al * reach, ml - as * reach));
        }
        left = nextLeft;
        right = nextRight;
      }
    };
  fringe(0, 0, 1, 0, len, 0.012, 0.03);
  // The leader is this year's terminal shoot: needles, no side shoots yet.
  if (upright) return;
  const laterals = Math.max(4, Math.round((len * 0.84) / spacing)),
    // A short spray has at least 4 laterals at both levels. Where the near level's count is held up to that floor, the
    // coarse widening (spacing ratio times the teeth's share) is scaled by the near count over the coarse count and
    // over the spacing ratio, so a short spray (the crown top's) keeps its coverage too.
    nearLaterals = coarse ? Math.round((len * 0.84 * coarse.ratio) / spacing) : 0,
    widen = coarse && nearLaterals < 4 ? (coarse.widen * 4) / (laterals * coarse.ratio) : coarse?.widen;
  for (let k = 0; k < laterals; k++) {
    const s0 = len * (0.1 + (0.84 * (k + 0.5)) / laterals),
      side = k % 2 ? 1 : -1,
      angle = 0.96 + (hash(k + 3) - 0.5) * 0.2,
      as = Math.cos(angle),
      al = Math.sin(angle) * side;
    // Out to the spray's outline: the longest run that stays inside it.
    let length = 0;
    while (length < len) {
      const next = length + 0.01,
        s = s0 + as * next;
      if (s > len || Math.abs(al * next) > 0.97 * halfAt(s / len)) break;
      length = next;
    }
    if (length >= 0.04) fringe(s0, 0, as, al, length, 0.006, NEEDLE_TUFT, widen);
  }
}

// One whorl of branch sprays round the trunk at (cx, cy, cz). Each spray runs from the trunk out to `length` metres
// (jittered 0 to 18 percent shorter), lanceolate (widest at 40 percent of its length, a point at its tip), cupped across
// (its edges hang lower) and drooping along a parabola to `droop` metres at the tip: the spruce branch habit
// (Weber and Penn 1995, conifer shape and branch curvature; Deussen and Lintermann 2005, ch. 6). Vertex normals are
// the spray's own, half mixed with the direction from the trunk, a crown-volume normal, and tilted by up to 0.3 rad per
// vertex by a hash, the spread of needle orientations within a shoot (Smolander and Stenberg 2003) at the vertex scale.
// `upright`: `count` blades crossing on a vertical axis instead (the leader), each `across` metres a side at its widest,
// their normals the crown cone's at its apex (half angle CROWN_HALF), tilted the same way.
function sprayWhorl(
  cx: number,
  cy: number,
  cz: number,
  length: number,
  count: number,
  phase: number,
  droop: number,
  along: number,
  across: number,
  shoot?: ShootSpacing,
  upright = false,
): GeometryData {
  const positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [],
    hash = (n: number) => {
      const v = Math.sin(n * 12.9898 + phase * 78.233) * 43758.5453;
      return v - Math.floor(v);
    };
  for (let b = 0; b < count; b++) {
    // Upright blades cross on the axis (count of them, a half turn apart over all), each its full length.
    const yaw = phase + ((upright ? 1 : 2) * b * Math.PI) / count + (hash(b) - 0.5) * 0.35,
      len = upright ? length : length * (0.82 + 0.18 * hash(b + 17)),
      dx = Math.cos(yaw),
      dz = Math.sin(yaw),
      // Widest about 40 percent out, three quarters of the gap between neighbours there; an upright blade `across`
      // metres a side.
      halfWidth = upright ? across : len * Math.tan((Math.PI / count) * 0.75),
      first = positions.length / 3;
    if (shoot) {
      branchShoots(
        positions,
        uvs,
        indices,
        cx,
        cy,
        cz,
        dx,
        dz,
        len,
        halfWidth,
        droop,
        shoot,
        (n) => hash(b * 131 + n),
        upright,
      );
      continue;
    }
    const columns = upright ? 2 : across;
    for (let i = 0; i <= along; i++) {
      const t = i / along,
        r = 0.06 + len * t,
        width = halfWidth * Math.sin(Math.PI * Math.min(1, t * 0.85 + 0.15)) ** 0.8 * Math.min(1, 0.25 + t * 1.9),
        drop = droop * (0.35 * t + 0.65 * t * t);
      for (let j = 0; j <= columns; j++) {
        const u = (j / columns) * 2 - 1,
          lateral = u * width;
        if (upright) positions.push(cx - dz * lateral, cy + len * t, cz + dx * lateral);
        else positions.push(cx + dx * r - dz * lateral, cy - drop - 0.28 * width * u * u, cz + dz * r + dx * lateral);
        uvs.push(t, j / columns);
      }
    }
    for (let i = 0; i < along; i++)
      for (let j = 0; j < columns; j++) {
        const a = first + i * (columns + 1) + j,
          c = a + columns + 1;
        // Wound so the face normals point up.
        indices.push(a, a + 1, c, c, a + 1, c + 1);
      }
  }
  const data = computeVertexNormals(geometryData(positions, new Array<number>(positions.length).fill(0), uvs, indices));
  const n = data.normals,
    p = data.positions;
  for (let i = 0; i < p.length; i += 3) {
    let ox = p[i] - cx,
      oy = p[i + 1] - (cy - length * 0.35),
      oz = p[i + 2] - cz;
    const ol = Math.hypot(ox, oy, oz) || 1,
      tilt = (hash(i + 101) - 0.5) * 0.6,
      turn = hash(i + 211) * Math.PI * 2;
    if (upright) {
      // The leader's needles spread round its axis: its normal is the crown cone's own at the apex, out from the axis
      // (across the blade on the axis itself) and up by the crown's half angle, tilted as the sprays' normals are.
      const side = Math.hypot(ox, oz),
        hx = side > 1e-4 ? ox : n[i],
        hz = side > 1e-4 ? oz : n[i + 2],
        h = Math.hypot(hx, hz) || 1;
      ox = (hx / h) * CROWN_COS + Math.cos(turn) * tilt;
      oy = CROWN_SIN;
      oz = (hz / h) * CROWN_COS + Math.sin(turn) * tilt;
    } else {
      ox = n[i] * 0.5 + (ox / ol) * 0.5 + Math.cos(turn) * tilt;
      oy = n[i + 1] * 0.5 + (oy / ol) * 0.5;
      oz = n[i + 2] * 0.5 + (oz / ol) * 0.5 + Math.sin(turn) * tilt;
    }
    const l = Math.hypot(ox, oy, oz);
    n[i] = ox / l;
    n[i + 1] = oy / l;
    n[i + 2] = oz / l;
  }
  return data;
}

// A tapering trunk standing on y = 0, `radial` sides, radius 0.32 at the ground to 0.11 at the top as the cylinder, with
// a butt swell: the radius times 1 + A e^(-y / 0.2), A set so the diameter at the ground is `flare` times the diameter at
// `breast` (1.3 m, the breast height of forest mensuration, in the placed tree; Repola 2009 and Wharton 1984 for the
// measured spruce ratios). Extra rings in the lowest 0.75 m draw the swell; the top is closed.
function flaredTrunk(height: number, radial: number, segments: number, flare: number, breast: number): GeometryData {
  const taper = (y: number) => 0.32 - (0.21 * y) / height,
    fade = Math.exp(-breast / 0.2),
    swell = (flare * taper(breast) - taper(0)) / (taper(0) - flare * taper(breast) * fade),
    rings = [0, 0.06, 0.15, 0.3, 0.5, 0.75, breast];
  for (let k = 1; k <= segments; k++) rings.push((k * height) / segments);
  // A ring at breast height, so the mesh's diameter there is the flare's own; rings closer than 0.1 m above 0.75 m merge.
  rings.sort((a, b) => a - b);
  for (let i = rings.length - 1; i > 0; i--)
    if (rings[i] - rings[i - 1] < (rings[i] > 0.8 ? 0.1 : 1e-6)) rings.splice(rings[i] === breast ? i - 1 : i, 1);
  const positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  for (const y of rings) {
    const r = taper(y) * (1 + swell * Math.exp(-y / 0.2));
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      positions.push(Math.sin(a) * r, y, Math.cos(a) * r);
      uvs.push(j / radial, y / height);
    }
  }
  for (let i = 0; i + 1 < rings.length; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j,
        c = a + radial + 1;
      // Wound so the faces point out of the trunk.
      indices.push(a, a + 1, c, a + 1, c + 1, c);
    }
  const top = positions.length / 3,
    ring = (rings.length - 1) * (radial + 1);
  positions.push(0, height, 0);
  uvs.push(0.5, 1);
  for (let j = 0; j < radial; j++) indices.push(top, ring + j, ring + j + 1);
  return geometryData(positions, new Array<number>(positions.length).fill(0), uvs, indices);
}

/**
 * Initialization-only tree geometry with smooth foliage and enclosed pine supports. Broadleaf canopies are fifteen
 * lumpy lobes plus 24 opaque leaf clumps per lobe that break the outline; every canopy vertex's normal radiates from
 * the canopy centre. `options.detail` (default 2, the mesh above) trades triangles for distance: level 1 uses coarser
 * lobes with 8 clumps each, level 0 five merged coarse lobes (broadleaf) or 6-sided tiers (conifer); at levels 0 and 1
 * each broadleaf lobe vertex's normal mixes 40 percent toward its own lobe centre so the canopy keeps a clustered look.
 * A conifer's tiers are branch whorls with `options.branches` ({@link TreeMeshShapeOptions}).
 * @throws RangeError when `kind` is not a tree kind or `options.detail` is not 0, 1 or 2.
 */
export function generateTreeMesh(kind: 'conifer' | 'broadleaf', options?: TreeMeshShapeOptions) {
  if (kind !== 'conifer' && kind !== 'broadleaf')
    throw new RangeError("Invalid tree kind; pass 'conifer' or 'broadleaf'.");
  const flare = options?.flare;
  if (flare !== undefined && !(typeof flare === 'number' && flare >= 1 && flare <= 2.5))
    throw new RangeError('Invalid trunk flare; pass a ratio from 1 to 2.5.');
  const breast = options?.breastHeight;
  if (breast !== undefined && !(typeof breast === 'number' && breast >= 0.3 && breast <= 6))
    throw new RangeError('Invalid breast height; pass 0.3 to 6 mesh metres.');
  const wanted = options?.breastDiameter;
  if (wanted !== undefined && !(typeof wanted === 'number' && wanted >= 0.005 && wanted <= 3))
    throw new RangeError('Invalid breast diameter; pass 0.005 to 3 mesh metres.');
  const shoots = options?.shoots;
  if (shoots !== undefined && shoots !== true && shoots !== false && shoots !== 'coarse')
    throw new RangeError("Invalid shoots; pass true, false or 'coarse'.");
  const detail = resolveDetail(options),
    trunkHeight = kind === 'conifer' ? 6.2 : 5.3,
    flared = options?.flare,
    trunk =
      flared === undefined
        ? cylinderGeometry(0.11, 0.32, trunkHeight, [5, 6, 8][detail], [2, 4, 6][detail])
        : flaredTrunk(trunkHeight, [5, 6, 8][detail], [2, 4, 6][detail], flared, options?.breastHeight ?? 1.3),
    // The flared trunk is built standing on the ground; the cylinder is centred on its middle.
    lift = flared === undefined ? trunkHeight / 2 : 0;
  // With `breastDiameter`, the trunk scaled across so its diameter at breast height is that: the profile's radius there
  // is the ring's (flared trunk) or the cylinder's linear taper (0.32 at the ground to 0.11 at the top).
  const breastAt = options?.breastHeight ?? 1.3,
    profile =
      flared === undefined
        ? 0.32 - (0.21 * breastAt) / trunkHeight
        : (() => {
            let r = 0;
            for (let i = 0; i < trunk.positions.length; i += 3)
              if (Math.abs(trunk.positions[i + 1] - breastAt) < 1e-6)
                r = Math.max(r, Math.hypot(trunk.positions[i], trunk.positions[i + 2]));
            return r;
          })(),
    widthScale = wanted === undefined ? 1 : wanted / (2 * profile);
  for (let i = 0; i < trunk.positions.length; i += 3) {
    const y = trunk.positions[i + 1] + lift,
      angle = y * 0.055,
      flare = (flared === undefined && y < 0.001 ? 1.8 : 1) * widthScale,
      x = trunk.positions[i] * flare,
      z = trunk.positions[i + 2] * flare;
    trunk.positions[i] = x * Math.cos(angle) + z * Math.sin(angle) + y * y * 0.008;
    trunk.positions[i + 1] = y;
    trunk.positions[i + 2] = -x * Math.sin(angle) + z * Math.cos(angle) + Math.sin(y * 0.7) * 0.1;
  }
  const wood = [computeVertexNormals(toNonIndexed(trunk))],
    leaves: GeometryData[] = [],
    clumps: GeometryData[] = [],
    lobeCenters: number[][] = [];
  if (kind === 'conifer' && options?.branches === true && detail > 0) {
    // Six whorls on the skirts' heights and reach, a shorter whorl between each two, and a leader at the top.
    const along = detail === 2 ? 6 : 4,
      across = detail === 2 ? 4 : 2,
      near = detail === 2 ? { spacing: 0.075, tooth: 0.06 } : { spacing: 0.12, tooth: 0.1 },
      // The coarse level (detail 2): laterals 1.5 times as far apart and 1.55 times as wide, a segment per 0.15 m;
      // at detail 1 the near level's laterals, a segment per 0.15 m. Both widths keep the near level's coverage (see
      // ShootSpacing.coarse).
      coarseFactor = detail === 2 ? 1.5 : 1,
      shoot: ShootSpacing | undefined =
        options?.shoots === true
          ? near
          : options?.shoots === 'coarse'
            ? {
                spacing: near.spacing * coarseFactor,
                tooth: 0.15,
                coarse: { widen: detail === 2 ? 1.55 : 1, ratio: coarseFactor },
              }
            : undefined;
    for (let tier = 0; tier < 6; tier++) {
      const y = 1.8 + tier * 0.9,
        reach = 2.1 * (1 - tier * 0.12),
        top = y + 1.15 - tier * 0.05,
        at = (h: number): [number, number, number] => [h * h * 0.008, h, Math.sin(h * 0.7) * 0.1];
      leaves.push(sprayWhorl(...at(top), reach, 7, tier * 2.399963, reach * 0.62, along, across, shoot));
      if (detail === 2)
        leaves.push(
          sprayWhorl(...at(top - 0.45), reach * 0.82, 5, tier * 2.399963 + 0.45, reach * 0.55, along, across, shoot),
        );
    }
    // The crown's top: the youngest whorl, where the next tier's would stand, the whorl between (detail 2), and the
    // leader above them. Their reach closes the crown from the last tier's to the leader's tip.
    const whorl = 1.8 + 6 * 0.9 + 1.15 - 6 * 0.05,
      last = whorl - 0.85,
      apex = whorl + LEADER,
      reachAt = (h: number) => (2.1 * (1 - 5 * 0.12) * (apex - h)) / (apex - last),
      at = (h: number): [number, number, number] => [h * h * 0.008, h, Math.sin(h * 0.7) * 0.1];
    leaves.push(sprayWhorl(...at(whorl), reachAt(whorl), 5, 6 * 2.399963, reachAt(whorl) * 0.62, along, across, shoot));
    if (detail === 2) {
      const between = whorl - 0.45;
      leaves.push(
        sprayWhorl(
          ...at(between),
          reachAt(between),
          5,
          6 * 2.399963 + 0.45,
          reachAt(between) * 0.55,
          along,
          across,
          shoot,
        ),
      );
    }
    leaves.push(sprayWhorl(...at(whorl), LEADER, 2, 0.3, 0, along, LEADER_HALF, shoot, true));
  } else if (kind === 'conifer') {
    for (let tier = 0; tier < 6; tier++) {
      const r = 2.05 * (1 - tier * 0.115),
        skirt = coneGeometry(r, 2, [6, 8, 12][detail], 2);
      for (let i = 0; i < skirt.positions.length; i += 3) {
        const x = skirt.positions[i],
          y = skirt.positions[i + 1],
          z = skirt.positions[i + 2],
          angle = Math.atan2(z, x);
        const jitter = 1 + 0.25 * Math.sin(7 * angle) + 0.15 * Math.cos(11 * angle);
        skirt.positions[i] *= jitter;
        skirt.positions[i + 2] *= jitter;
        skirt.positions[i + 1] =
          y > 0.5
            ? 1.35 - tier * 0.05
            : y > -0.5
              ? 0.35
              : Math.hypot(x, z) < 0.001
                ? -0.06
                : -0.45 - 0.1 * Math.sin(3 * angle);
      }
      const y = 1.8 + tier * 0.9;
      leaves.push(placed(radialNormals(skirt), y * y * 0.008, y, Math.sin(y * 0.7) * 0.1, 1, 1, 1, tier * 0.37));
      if (detail > 0 && y + 0.12 < trunkHeight) {
        const angle = tier * 2.399963,
          length = r * 0.28,
          branchY = y + 0.12;
        const x = branchY * branchY * 0.008,
          z = Math.sin(branchY * 0.7) * 0.1;
        // Short supports sit above the underside cap and inside even the narrowest jagged rim.
        wood.push(
          placed(
            cylinderGeometry(0.015, 0.065, length, detail === 2 ? 8 : 6),
            x + (Math.cos(angle) * length) / 2,
            branchY,
            z + (Math.sin(angle) * length) / 2,
            1,
            1,
            1,
            -angle,
            -Math.PI / 2,
          ),
        );
      }
    }
  } else {
    const specs: LobeSpec[] = [];
    for (let limb = 0; limb < 3; limb++) {
      const angle = (limb * Math.PI * 2) / 3,
        c = Math.cos(angle),
        s = Math.sin(angle);
      wood.push(
        placed(
          cylinderGeometry(0.065, 0.18, 2.5, detail === 2 ? 8 : 6, detail === 2 ? 2 : 1),
          0.13 + c * 0.884,
          4.234,
          0.03 + s * 0.884,
          1,
          1,
          1,
          -angle,
          -Math.PI / 4,
        ),
      );
      for (let lobe = 0; lobe < 5; lobe++) {
        const t = 0.35 + lobe * 0.17,
          phase = angle + lobe * 2.399963,
          size = 1.1 + (lobe % 3) * 0.13;
        specs.push({
          x: 0.13 + c * (0.4 + t * 1.9) + Math.cos(phase) * 0.4,
          y: 4.05 + t * 1.9 + (lobe % 2) * 0.35,
          z: 0.03 + s * (0.4 + t * 1.9) + Math.sin(phase) * 0.4,
          sx: size,
          sy: size * 0.87,
          sz: size,
          yaw: phase,
        });
      }
    }
    // Level 0 draws five coarse lobes that each cover three neighbours; the others draw all fifteen.
    const drawn = detail === 0 ? mergeLobeGroups(specs, consecutiveGroups(specs.length, 3)) : specs;
    drawn.forEach((lobe, i) => {
      const mesh = perturb(icosahedronGeometry(1, detail === 2 ? 3 : detail === 1 ? 2 : 1));
      leaves.push(placed(mesh, lobe.x, lobe.y, lobe.z, lobe.sx, lobe.sy, lobe.sz));
      lobeCenters.push([lobe.x, lobe.y, lobe.z]);
      // The full mesh keeps its historical clump phase (the lobe's own yaw); lower levels have 8 clumps or none.
      if (detail === 2) clumps.push(leafClumps(lobe.x, lobe.y, lobe.z, lobe.sx, specs[i].yaw));
      else if (detail === 1) clumps.push(leafClumps(lobe.x, lobe.y, lobe.z, lobe.sx, lobe.yaw, 8));
    });
  }
  // Level 0 keeps the full canopy's bounding box, so far trees read at the right size.
  if (detail === 0) fitToHull([...leaves, ...clumps], FULL_HULLS[kind], lobeCenters);
  // Lobes first, then their leaf clumps (broadleaf only), so lobe i keeps its index range.
  const canopy = mergeGeometries([...leaves, ...clumps]),
    center = new Float32Array(3),
    count = canopy.positions.length / 3;
  for (let i = 0; i < canopy.positions.length; i++) center[i % 3] += canopy.positions[i] / count;
  // Broadleaf clouds share a single lighting volume, including vertices on inward-facing lobe surfaces.
  if (kind === 'broadleaf') {
    radialNormals(canopy, center[0], center[1], center[2]);
    if (detail < 2)
      mixLobeNormals(canopy, [...leaves, ...clumps], [...lobeCenters, ...lobeCenters.slice(0, clumps.length)]);
  }
  let radius = 0;
  for (let i = 0; i < canopy.positions.length; i += 3)
    radius = Math.max(
      radius,
      Math.hypot(
        canopy.positions[i] - center[0],
        canopy.positions[i + 1] - center[1],
        canopy.positions[i + 2] - center[2],
      ),
    );
  return { trunk: computeTangents(mergeGeometries(wood)), canopy: computeTangents(canopy), center, radius };
}

/** Leaves per lobe and detail level (0, 1, 2) of a shrub. */
const SHRUB_LEAVES = [16, 48, 130] as const;
/** Stems per lobe and detail level of a shrub. */
const SHRUB_STEMS = [2, 4, 7] as const;
/** A shrub's three lobes as [x, z, x radius, height, z radius, phase]. */
const SHRUB_LOBES: readonly (readonly number[])[] = [0, 1, 2].map((i) => {
  const angle = i * 2.399963,
    r = i === 2 ? 0 : 0.23;
  return [Math.cos(angle) * r, Math.sin(angle) * r, 0.47 + i * 0.07, 0.68 + i * 0.09, 0.45 + (i % 2) * 0.08, angle];
});

/**
 * `count` leaves through the outer shell of one upper half ellipsoid: six-cornered blades of half length `long` on a
 * golden-angle spiral, each at its own depth and turned every way (a spherical leaf angle distribution, from the R2
 * low-discrepancy pair), both faces lit by the direction out of a point `lift` under the origin, so the crown shades as
 * one soft volume.
 * @internal
 */
export function shrubLeaves(
  count: number,
  [x, z, rx, ry, rz, phase]: readonly number[],
  long: number,
  lift: number,
): GeometryData {
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  for (let k = 0; k < count; k++) {
    const dy = (k + 0.5) / count,
      ring = Math.sqrt(1 - dy * dy),
      angle = k * 2.399963 + phase,
      dx = Math.cos(angle) * ring,
      dz = Math.sin(angle) * ring,
      depth = lump(dx, dy, dz) * (0.66 + 0.4 * ((k * 0.618034 + phase * 0.31) % 1)),
      px = x + dx * rx * depth,
      py = dy * ry * depth - 0.04,
      pz = z + dz * rz * depth,
      // The leaf's own plane: a direction uniform on the sphere, and two axes across it.
      up = 2 * ((0.5 + k * 0.754878 + phase) % 1) - 1,
      turn = 2 * Math.PI * ((0.5 + k * 0.56984) % 1),
      side = Math.sqrt(1 - up * up),
      lx = Math.cos(turn) * side,
      lz = Math.sin(turn) * side,
      al = Math.hypot(lx, lz),
      ax = al > 1e-3 ? -lz / al : 1,
      az = al > 1e-3 ? lx / al : 0,
      bx = up * az,
      by = lz * ax - lx * az,
      bz = -up * ax,
      // A rounded blade, wider toward the stalk: [along, across] in half lengths.
      outline = [
        [-1, 0],
        [-0.55, 0.72],
        [0.35, 0.62],
        [1, 0],
        [0.35, -0.62],
        [-0.55, -0.72],
      ],
      start = positions.length / 3;
    // Front and back get their own vertices so each side keeps a consistent tangent frame.
    for (let face = 0; face < 2; face++)
      for (const [along, across] of outline) {
        const cx = px + (ax * along + bx * across) * long,
          cy = py + by * across * long,
          cz = pz + (az * along + bz * across) * long,
          length = Math.hypot(cx, cy + lift, cz);
        positions.push(cx, cy, cz);
        normals.push(cx / length, (cy + lift) / length, cz / length);
        uvs.push(0.5 + across * 0.5, 0.5 + along * 0.5);
      }
    for (let i = 1; i < 5; i++) {
      indices.push(start, start + i, start + i + 1);
      indices.push(start + 6, start + 6 + i + 1, start + 6 + i);
    }
  }
  return geometryData(positions, new Float32Array(normals), uvs, indices);
}

/**
 * `count` woody stems per lobe, from the shrub's foot into the leaves: two tapered three-sided lengths that rise and
 * then spread, `radius` metres thick at the foot.
 * @internal
 */
export function shrubStems(lobes: readonly (readonly number[])[], count: number, radius: number): GeometryData {
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  lobes.forEach(([x, z, rx, ry, rz, phase], lobe) => {
    for (let s = 0; s < count; s++) {
      const dy = 0.15 + (0.8 * (s + 0.5)) / count,
        ring = Math.sqrt(1 - dy * dy),
        angle = s * 2.399963 + phase + lobe,
        tip = [x + Math.cos(angle) * ring * rx * 0.72, dy * ry * 0.72 - 0.04, z + Math.sin(angle) * ring * rz * 0.72],
        foot = [0.07 * Math.cos(angle), -0.04, 0.07 * Math.sin(angle)],
        elbow = [
          foot[0] + (tip[0] - foot[0]) * 0.42,
          foot[1] + (tip[1] - foot[1]) * 0.66,
          foot[2] + (tip[2] - foot[2]) * 0.42,
        ],
        path = [foot, elbow, tip];
      for (let k = 0; k < 2; k++) {
        const p = path[k],
          q = path[k + 1],
          d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]],
          length = Math.hypot(d[0], d[1], d[2]),
          // Two axes across the length; a stem is never along x, since it rises from the foot.
          across = Math.hypot(d[2], d[1]),
          u = [0, d[2] / across, -d[1] / across],
          v = [
            (d[1] * u[2] - d[2] * u[1]) / length,
            (d[2] * u[0] - d[0] * u[2]) / length,
            (d[0] * u[1] - d[1] * u[0]) / length,
          ],
          start = positions.length / 3;
        for (let end = 0; end < 2; end++)
          for (let side = 0; side < 3; side++) {
            const turn = (side * 2 * Math.PI) / 3,
              n = [0, 1, 2].map((i) => u[i] * Math.cos(turn) + v[i] * Math.sin(turn)),
              thick = radius * (1 - 0.35 * (k + end));
            positions.push(...[0, 1, 2].map((i) => path[k + end][i] + n[i] * thick));
            normals.push(...n);
            uvs.push(side / 3, k + end);
          }
        for (let side = 0; side < 3; side++) {
          const a = start + side,
            b = start + ((side + 1) % 3);
          indices.push(a, b, b + 3, a, b + 3, a + 3);
        }
      }
    }
  });
  return geometryData(positions, new Float32Array(normals), uvs, indices);
}

/**
 * A compact, asymmetric dome of separate leaves in three lobes, with gaps between them and a ragged outline, normals
 * pointing out of the shrub; draw `generateShrubStemsMesh` with it for its wood. `options.detail` (default 2, 3,120
 * triangles) draws fewer, larger leaves at 1 (1,152) and 0 (384), in the same bounding box.
 * @throws RangeError when `options.detail` is not 0, 1 or 2.
 */
export function generateShrubMesh(options?: MeshDetailOptions): GeometryData {
  const count = SHRUB_LEAVES[resolveDetail(options)],
    long = 0.065 * Math.sqrt(SHRUB_LEAVES[2] / count),
    lobes = SHRUB_LOBES.map((lobe) => shrubLeaves(count, lobe, long, 0.15));
  fitToHull(lobes, FULL_HULLS.shrub);
  return computeTangents(mergeGeometries(lobes));
}

/**
 * The woody stems inside `generateShrubMesh`'s leaves, in its coordinates, for a bark material. `options.detail`
 * (default 2, 252 triangles) draws fewer, thicker stems at 1 (144) and 0 (72).
 * @throws RangeError when `options.detail` is not 0, 1 or 2.
 */
export function generateShrubStemsMesh(options?: MeshDetailOptions): GeometryData {
  const detail = resolveDetail(options);
  return computeTangents(shrubStems(SHRUB_LOBES, SHRUB_STEMS[detail], [0.03, 0.024, 0.018][detail]));
}

/** Dominant shape of a fieldstone. Pebbles are the more rounded, water-worn form. */
export type RockForm = 'block' | 'slab' | 'wedge' | 'shard' | 'pebble';

// Half-axis proportions, edge wear, pitch of the upper fracture and number of side fractures.
const ROCK_FORMS = {
  block: [1.02, 0.66, 0.79, 0.095, 0.19, 5],
  slab: [1.24, 0.29, 0.87, 0.075, 0.11, 5],
  wedge: [1.13, 0.53, 0.73, 0.08, 0.8, 4],
  shard: [1.36, 0.43, 0.41, 0.065, 0.41, 4],
  pebble: [0.93, 0.55, 0.76, 0.38, 0.18, 7],
} as const satisfies Record<RockForm, readonly number[]>;
const ROCK_FORM_ORDER: readonly RockForm[] = ['wedge', 'block', 'slab', 'shard', 'pebble'];

/**
 * A fieldstone with fracture faces, softened edges and seeded proportions, centered on the placement origin (+Y up).
 * The mesh retains its UV layout, tangent frame and 180-triangle budget.
 * @param seed - Unsigned 32-bit seed for the proportions, fracture planes and weathering. Default 1.
 * @param form - Dominant shape. If omitted, the seed selects the form (seed 1 selects a block).
 * @throws RangeError for an invalid seed or form.
 */
export function generateRockMesh(seed = 1, form?: RockForm): GeometryData {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError('Invalid rock seed; pass an integer from 0 to 4294967295.');
  const shape = form === undefined ? ROCK_FORM_ORDER[seed % ROCK_FORM_ORDER.length] : form;
  if (typeof shape !== 'string' || !Object.hasOwn(ROCK_FORMS, shape))
    throw new RangeError('Invalid rock form; pass block, slab, wedge, shard or pebble.');
  const random = createRandom(seed),
    noise = new Noise(seed),
    data = icosahedronGeometry(1, 2),
    [halfX, halfY, halfZ, edgeWear, roofPitch, sideCount] = ROCK_FORMS[shape],
    yaw = random() * 0.7 - 0.35,
    length = halfX * (0.89 + 0.24 * random()),
    height = halfY * (0.87 + 0.26 * random()),
    width = halfZ * (0.86 + 0.25 * random()),
    rounding = edgeWear * (0.85 + 0.35 * random()),
    planes: Array<readonly [number, number, number, number]> = [
      [roofPitch, 1, 0.26 * (random() - 0.5), 0.79 + 0.09 * random()],
      [0.08 * (random() - 0.5), -1, 0, 0.73 + 0.07 * random()],
    ];
  // Broad joint faces set the form; narrow oblique cuts leave broken corners and unequal shoulders.
  for (let side = 0; side < sideCount; side++) {
    const angle = yaw + ((side + (random() - 0.5) * 0.56) * 2 * Math.PI) / sideCount,
      tilt = 0.67 * (random() - 0.5);
    planes.push([Math.cos(angle), tilt, Math.sin(angle), 0.74 + 0.23 * random()]);
  }
  const chip = yaw + (1 + 2 * random()) * Math.PI,
    heel = chip + 1.6 + random() * 1.9;
  planes.push([0.71 * Math.cos(chip), 0.72, 0.71 * Math.sin(chip), 0.68 + 0.23 * random()]);
  planes.push([0.74 * Math.cos(heel), -0.66, 0.74 * Math.sin(heel), 0.72 + 0.21 * random()]);
  for (let i = 0; i < data.positions.length; i += 3) {
    const x = data.positions[i],
      y = data.positions[i + 1],
      z = data.positions[i + 2];
    let face = -Infinity,
      neighbour = -Infinity;
    for (const [nx, ny, nz, distance] of planes) {
      const plane = (nx * x + ny * y + nz * z) / distance;
      if (plane > face) {
        neighbour = face;
        face = plane;
      } else neighbour = Math.max(neighbour, plane);
    }
    // Smooth only around the closest two planes: rounding the whole shape loses the broad faces.
    const edge = Math.max(0, rounding - (face - neighbour)),
      wear = 0.045 * noise.simplex(2.1 * x, 3.2 * y, 2.6 * z) + 0.018 * noise.simplex(6 * x, 7 * y, 5 * z),
      radius = (1 + wear) / (face + (edge * edge) / (4 * rounding));
    data.positions[i] = x * radius * length;
    data.positions[i + 1] = y * radius * height;
    data.positions[i + 2] = z * radius * width;
  }
  const smooth = computeVertexNormals(mergeVertices(data, { positionOnly: true }));
  // Welding is only for normals; retain split UVs and triangle order in the rendered geometry.
  for (let i = 0; i < data.indices.length; i++) {
    const v = smooth.indices[i] * 3;
    data.normals.set(smooth.normals.subarray(v, v + 3), data.indices[i] * 3);
  }
  return computeTangents(data);
}

/** Seven tapered, curved ribbon fronds; render with a double-sided material. */
export function generateFernMesh(): GeometryData {
  const fronds: GeometryData[] = [];
  for (let frond = 0; frond < 7; frond++) {
    const positions: number[] = [],
      uvs: number[] = [],
      indices: number[] = [];
    for (let segment = 0; segment <= 5; segment++) {
      const t = segment / 5,
        q = t * 1.5,
        sag = -0.5 * q * q,
        tilt = (35 * Math.PI) / 180,
        width = 0.17 * (1 - t * 0.92);
      const x = Math.sin(tilt) * q - Math.cos(tilt) * sag,
        y = Math.cos(tilt) * q + Math.sin(tilt) * sag;
      positions.push(x, y, -width, x, y, width);
      uvs.push(t, 0, t, 1);
      if (segment < 5) {
        const a = segment * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const data = computeVertexNormals(geometryData(positions, new Float32Array(positions.length), uvs, indices));
    fronds.push(placed(data, 0, 0, 0, 0.8 + (frond % 3) * 0.08, 1, 1, (frond * Math.PI * 2) / 7));
  }
  return computeTangents(mergeGeometries(fronds));
}

/** Crossed tapered grass ribbons for near/middle/far scatter meshes. */
export function generateGrassMesh(blades = 3): GeometryData {
  if (!Number.isInteger(blades) || blades < 1 || blades > 64)
    throw new RangeError('Invalid grass blade count; pass an integer from 1 to 64.');
  const p: number[] = [],
    n: number[] = [],
    uv: number[] = [],
    indices: number[] = [];
  for (let blade = 0; blade < blades; blade++) {
    const angle = (blade * 2.399963229728653) % Math.PI,
      c = Math.cos(angle),
      s = Math.sin(angle),
      start = p.length / 3,
      length = Math.hypot(1, 0.25);
    p.push(-0.04 * c, 0, -0.04 * s, 0.04 * c, 0, 0.04 * s, 0.055 * c, 0.32, 0.055 * s, 0.08 * c, 0.48, 0.08 * s);
    for (let i = 0; i < 4; i++) n.push(-s / length, 0.25 / length, c / length);
    uv.push(0, 0, 1, 0, 0, 0.67, 1, 1);
    indices.push(start, start + 1, start + 2, start + 1, start + 3, start + 2);
  }
  return computeTangents(geometryData(p, n, uv, indices));
}

/**
 * Ground-contact occlusion factor for a vertex at height `y`: 0.2 at or below `groundY`, rising linearly
 * to 1 at 0.6 world units above it.
 * @throws RangeError when either height is not finite.
 */
export function contactAO(y: number, groundY: number): number {
  if (!Number.isFinite(y) || !Number.isFinite(groundY))
    throw new RangeError('Invalid contact height; pass finite y and groundY values.');
  return Math.min(1, 0.2 + 0.8 * Math.max(0, (y - groundY) / 0.6));
}

/**
 * Radial occlusion factor for point (x, y, z): 0.25 at `center`, rising linearly to 1 at `radius`
 * world units away and capped there.
 * @throws RangeError when an input is not finite, `center` does not have 3 values, or `radius` is not positive.
 */
export function radialAO(x: number, y: number, z: number, center: ArrayLike<number>, radius: number): number {
  if (
    center.length !== 3 ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    !Number.isFinite(center[0]) ||
    !Number.isFinite(center[1]) ||
    !Number.isFinite(center[2]) ||
    !Number.isFinite(radius) ||
    radius <= 0
  )
    throw new RangeError('Invalid occlusion volume; use finite x, y, z, a 3-value center and radius above 0.');
  return Math.min(1, 0.25 + (0.75 * Math.hypot(x - center[0], y - center[1], z - center[2])) / radius);
}
