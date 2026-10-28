// More plant generators for the biome presets (decision D5): palm, birch, acacia and a dead snag as trunk + canopy
// pairs like generateTreeMesh, and cactus, reeds and a tundra shrub as single meshes. Our own shapes from primitives:
// heights in metres for a tree of reference size, local origin at the root, +Y up.
import { coneGeometry, cylinderGeometry, sphereGeometry, icosahedronGeometry } from '@margoengine/geometry/primitives';
import {
  geometryData,
  mergeGeometries,
  computeTangents,
  computeVertexNormals,
  toNonIndexed,
  type GeometryData,
} from '@margoengine/geometry/utils';
import { perturb, placed } from './foliage.js';

/** A tree as two meshes: wood and foliage (empty for a snag). */
export interface TreeMesh {
  readonly trunk: GeometryData;
  readonly canopy: GeometryData;
}

/** A trunk of `segments` stacked tapered cylinders along a bend `lean` (metres of sideways drift at the top). */
function trunk(height: number, r0: number, r1: number, lean: number, segments = 4): GeometryData {
  const parts: GeometryData[] = [];
  for (let s = 0; s < segments; s++) {
    const t0 = s / segments,
      t1 = (s + 1) / segments,
      h = height / segments,
      piece = cylinderGeometry(r0 + (r1 - r0) * t1, r0 + (r1 - r0) * t0, h * 1.02, 7, 1),
      x = lean * ((t0 + t1) / 2) ** 2;
    parts.push(placed(piece, x, height * (t0 + t1) * 0.5, 0, 1, 1, 1, 0, (-lean / height) * 1.6 * (t0 + t1) * 0.5));
  }
  return computeVertexNormals(toNonIndexed(mergeGeometries(parts)));
}

/** A fan of drooping leaf ribbons from (x, y, z): palm fronds. */
function fronds(x: number, y: number, z: number, count: number, length: number): GeometryData {
  const leaves: GeometryData[] = [];
  for (let f = 0; f < count; f++) {
    const positions: number[] = [],
      uvs: number[] = [],
      indices: number[] = [];
    for (let s = 0; s <= 6; s++) {
      const t = s / 6,
        q = t * length,
        width = 0.35 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.02,
        px = q,
        py = 0.45 * q - (0.42 * q * q) / length;
      positions.push(px, py, -width, px, py, width);
      uvs.push(t, 0, t, 1);
      if (s < 6) indices.push(s * 2, s * 2 + 1, s * 2 + 2, s * 2 + 1, s * 2 + 3, s * 2 + 2);
    }
    const leaf = computeVertexNormals(geometryData(positions, new Float32Array(positions.length), uvs, indices));
    leaves.push(placed(leaf, x, y, z, 1, 1, 1, (f * Math.PI * 2) / count + (f % 2) * 0.2, 0));
  }
  return mergeGeometries(leaves);
}

/** A coconut-style palm: a slender leaning trunk and a crown of drooping fronds. Render fronds double sided. */
export function generatePalmMesh(): TreeMesh {
  return {
    trunk: computeTangents(trunk(8, 0.13, 0.22, 1.2, 6)),
    canopy: computeTangents(fronds(1.2, 8, 0, 9, 3.2)),
  };
}

/** A birch: a thin straight trunk and a narrow, loose oval crown of small lobes. */
export function generateBirchMesh(): TreeMesh {
  const lobes: GeometryData[] = [];
  for (let i = 0; i < 9; i++) {
    const a = i * 2.399963,
      t = i / 8,
      r = 0.55 * Math.sin(Math.PI * (0.15 + t * 0.7));
    lobes.push(
      placed(perturb(icosahedronGeometry(1, 2)), Math.cos(a) * r, 5.2 + t * 4.2, Math.sin(a) * r, 0.75, 1.0, 0.75, a),
    );
  }
  return { trunk: computeTangents(trunk(9.5, 0.06, 0.16, 0.25, 5)), canopy: computeTangents(mergeGeometries(lobes)) };
}

/** An acacia: a short forked trunk and a wide, flat umbrella crown. */
export function generateAcaciaMesh(): TreeMesh {
  const wood = [trunk(2.6, 0.12, 0.2, 0.3, 3)];
  for (const side of [-1, 1])
    wood.push(placed(trunk(2.2, 0.06, 0.12, 0, 3), 0.2 * side, 2.4, 0, 1, 1, 1, 0, side * 0.55));
  const crown: GeometryData[] = [];
  for (let i = 0; i < 7; i++) {
    const a = i * 2.399963,
      r = i ? 1.6 : 0;
    crown.push(
      placed(
        perturb(sphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2)),
        Math.cos(a) * r,
        4.1,
        Math.sin(a) * r,
        1.9,
        0.55,
        1.9,
        a,
      ),
    );
  }
  return {
    trunk: computeTangents(computeVertexNormals(toNonIndexed(mergeGeometries(wood)))),
    canopy: computeTangents(mergeGeometries(crown)),
  };
}

/** A dead standing tree: a bare trunk with a few broken limbs, no foliage (the canopy is empty). */
export function generateSnagMesh(): TreeMesh {
  const wood = [trunk(7, 0.07, 0.3, 0.4, 5)];
  for (let i = 0; i < 4; i++)
    wood.push(
      placed(trunk(1.6 - i * 0.2, 0.03, 0.07, 0, 2), 0, 2.8 + i * 1.1, 0, 1, 1, 1, i * 2.1, 0.9 + (i % 2) * 0.3),
    );
  return {
    trunk: computeTangents(computeVertexNormals(toNonIndexed(mergeGeometries(wood)))),
    canopy: geometryData([], [], [], []),
  };
}

/** A columnar cactus with two arms, ribbed. */
export function generateCactusMesh(): GeometryData {
  const parts = [cylinderGeometry(0.22, 0.26, 3, 12, 6)].map((g) => placed(g, 0, 1.5, 0));
  for (const [side, y, h] of [
    [-1, 1.2, 1.1],
    [1, 1.7, 0.8],
  ] as const) {
    parts.push(placed(cylinderGeometry(0.13, 0.15, 0.5, 10, 1), side * 0.38, y, 0, 1, 1, 1, 0, Math.PI / 2));
    parts.push(placed(cylinderGeometry(0.12, 0.14, h, 10, 3), side * 0.6, y + h / 2, 0));
  }
  const data = mergeGeometries(parts);
  // Ribs: push every vertex out along its radius by a 12-fold wave.
  for (let i = 0; i < data.positions.length; i += 3) {
    const x = data.positions[i],
      z = data.positions[i + 2],
      a = Math.atan2(z, x),
      rib = 1 + 0.06 * Math.cos(12 * a);
    data.positions[i] = x * rib;
    data.positions[i + 2] = z * rib;
  }
  return computeTangents(computeVertexNormals(toNonIndexed(data)));
}

/** A clump of reeds: thin upright tapered blades, a few with seed heads. Render double sided. */
export function generateReedMesh(stems = 9): GeometryData {
  if (!Number.isInteger(stems) || stems < 1 || stems > 64)
    throw new RangeError('Invalid reed stem count; pass an integer from 1 to 64.');
  const parts: GeometryData[] = [];
  for (let s = 0; s < stems; s++) {
    const a = s * 2.399963,
      r = 0.12 * Math.sqrt(s),
      h = 1.4 + (s % 3) * 0.35;
    parts.push(
      placed(
        coneGeometry(0.018, h, 4, 1),
        Math.cos(a) * r,
        h / 2,
        Math.sin(a) * r,
        1,
        1,
        1,
        a,
        (s % 2 ? 1 : -1) * 0.08,
      ),
    );
    if (s % 3 === 0)
      parts.push(placed(cylinderGeometry(0.03, 0.03, 0.22, 6, 1), Math.cos(a) * r, h - 0.05, Math.sin(a) * r));
  }
  return computeTangents(computeVertexNormals(toNonIndexed(mergeGeometries(parts))));
}

/** A low, wind-pressed tundra shrub: a flat mat of lumpy lobes. */
export function generateTundraShrubMesh(): GeometryData {
  const lobes: GeometryData[] = [];
  for (let i = 0; i < 6; i++) {
    const a = i * 2.399963,
      r = 0.12 + 0.18 * (i % 3);
    lobes.push(
      placed(
        perturb(sphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2)),
        Math.cos(a) * r,
        -0.02,
        Math.sin(a) * r,
        0.42,
        0.22,
        0.36,
        a,
      ),
    );
  }
  return computeTangents(mergeGeometries(lobes));
}
