import { coneGeometry, cylinderGeometry, sphereGeometry, icosahedronGeometry } from '@margoengine/geometry/primitives';
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

/**
 * Initialization-only tree geometry with smooth foliage and enclosed pine supports. Broadleaf canopies are fifteen
 * lumpy lobes plus 24 opaque leaf clumps per lobe that break the outline; every canopy vertex's normal radiates from
 * the canopy centre. `options.detail` (default 2, the mesh above) trades triangles for distance: level 1 uses coarser
 * lobes with 8 clumps each, level 0 five merged coarse lobes (broadleaf) or 6-sided tiers (conifer); at levels 0 and 1
 * each broadleaf lobe vertex's normal mixes 40 percent toward its own lobe centre so the canopy keeps a clustered look.
 * @throws RangeError when `kind` is not a tree kind or `options.detail` is not 0, 1 or 2.
 */
export function generateTreeMesh(kind: 'conifer' | 'broadleaf', options?: MeshDetailOptions) {
  if (kind !== 'conifer' && kind !== 'broadleaf')
    throw new RangeError("Invalid tree kind; pass 'conifer' or 'broadleaf'.");
  const detail = resolveDetail(options),
    trunkHeight = kind === 'conifer' ? 6.2 : 5.3,
    trunk = cylinderGeometry(0.11, 0.32, trunkHeight, [5, 6, 8][detail], [2, 4, 6][detail]);
  for (let i = 0; i < trunk.positions.length; i += 3) {
    const y = trunk.positions[i + 1] + trunkHeight / 2,
      angle = y * 0.055,
      flare = y < 0.001 ? 1.8 : 1,
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
  if (kind === 'conifer') {
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

/**
 * Compact asymmetric hemispherical foliage with continuous smooth normals. `options.detail` (default 2, the full mesh)
 * lowers the lobes' segment counts at 1 and 0.
 * @throws RangeError when `options.detail` is not 0, 1 or 2.
 */
export function generateShrubMesh(options?: MeshDetailOptions): GeometryData {
  const detail = resolveDetail(options),
    lobes: GeometryData[] = [];
  for (let i = 0; i < 3; i++) {
    const angle = i * 2.399963,
      r = i === 2 ? 0 : 0.23;
    lobes.push(
      placed(
        perturb(sphereGeometry(1, [6, 10, 16][detail], [2, 4, 8][detail], 0, Math.PI * 2, 0, Math.PI / 2)),
        Math.cos(angle) * r,
        -0.04,
        Math.sin(angle) * r,
        0.47 + i * 0.07,
        0.68 + i * 0.09,
        0.45 + (i % 2) * 0.08,
        angle,
      ),
    );
  }
  if (detail === 0) fitToHull(lobes, FULL_HULLS.shrub);
  return computeTangents(mergeGeometries(lobes));
}

/** Deformed fieldstone with averaged surface normals and preserved UV seams. */
export function generateRockMesh(): GeometryData {
  const data = placed(perturb(icosahedronGeometry(1, 2)), 0, 0, 0, 1.15, 0.72, 0.82);
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
