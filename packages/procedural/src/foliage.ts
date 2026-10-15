import {
  coneGeometry,
  cylinderGeometry,
  sphereGeometry,
  icosahedronGeometry,
  geometryData,
  mergeGeometries,
  mergeVertices,
  computeTangents,
  computeVertexNormals,
  toNonIndexed,
  applyMatrix4,
  type GeometryData,
} from '@margoengine/geometry';

function placed(
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

function perturb(data: GeometryData): GeometryData {
  for (let i = 0; i < data.positions.length; i += 3) {
    const x = data.positions[i],
      y = data.positions[i + 1],
      z = data.positions[i + 2];
    let radius = 1;
    for (let octave = 0; octave < 3; octave++) {
      const frequency = 3 * 2 ** octave;
      radius += (0.2 / 2 ** octave) * Math.sin(x * frequency) * Math.cos(y * frequency) * Math.sin(z * frequency);
    }
    data.positions[i] *= radius;
    data.positions[i + 1] *= radius;
    data.positions[i + 2] *= radius;
  }
  return data;
}

/** Initialization-only tree geometry with smooth foliage and enclosed pine supports. */
export function generateTreeMesh(kind: 'conifer' | 'broadleaf') {
  if (kind !== 'conifer' && kind !== 'broadleaf') throw new RangeError('Invalid tree kind');
  const trunkHeight = kind === 'conifer' ? 6.2 : 5.3,
    trunk = cylinderGeometry(0.11, 0.32, trunkHeight, 8, 6);
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
    leaves: GeometryData[] = [];
  if (kind === 'conifer') {
    for (let tier = 0; tier < 6; tier++) {
      const r = 2.05 * (1 - tier * 0.115),
        skirt = coneGeometry(r, 2, 12, 2);
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
      if (y + 0.12 < trunkHeight) {
        const angle = tier * 2.399963,
          length = r * 0.28,
          branchY = y + 0.12;
        const x = branchY * branchY * 0.008,
          z = Math.sin(branchY * 0.7) * 0.1;
        // Short supports sit above the underside cap and inside even the narrowest jagged rim.
        wood.push(
          placed(
            cylinderGeometry(0.015, 0.065, length, 8),
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
    for (let limb = 0; limb < 3; limb++) {
      const angle = (limb * Math.PI * 2) / 3,
        c = Math.cos(angle),
        s = Math.sin(angle);
      wood.push(
        placed(
          cylinderGeometry(0.065, 0.18, 2.5, 8, 2),
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
        leaves.push(
          placed(
            perturb(icosahedronGeometry(1, 3)),
            0.13 + c * (0.4 + t * 1.9) + Math.cos(phase) * 0.4,
            4.05 + t * 1.9 + (lobe % 2) * 0.35,
            0.03 + s * (0.4 + t * 1.9) + Math.sin(phase) * 0.4,
            size,
            size * 0.87,
            size,
          ),
        );
      }
    }
  }
  const canopy = mergeGeometries(leaves),
    center = new Float32Array(3),
    count = canopy.positions.length / 3;
  for (let i = 0; i < canopy.positions.length; i++) center[i % 3] += canopy.positions[i] / count;
  // Broadleaf clouds share a single lighting volume, including vertices on inward-facing lobe surfaces.
  if (kind === 'broadleaf') radialNormals(canopy, center[0], center[1], center[2]);
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

/** Compact asymmetric hemispherical foliage with continuous smooth normals. */
export function generateShrubMesh(): GeometryData {
  const lobes: GeometryData[] = [];
  for (let i = 0; i < 3; i++) {
    const angle = i * 2.399963,
      r = i === 2 ? 0 : 0.23;
    lobes.push(
      placed(
        perturb(sphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
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
  if (!Number.isInteger(blades) || blades < 1 || blades > 64) throw new RangeError('Invalid grass blade count');
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

export function contactAO(y: number, groundY: number): number {
  if (!Number.isFinite(y) || !Number.isFinite(groundY)) throw new RangeError('Invalid contact height');
  return Math.min(1, 0.2 + 0.8 * Math.max(0, (y - groundY) / 0.6));
}

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
    throw new RangeError('Invalid occlusion volume');
  return Math.min(1, 0.25 + (0.75 * Math.hypot(x - center[0], y - center[1], z - center[2])) / radius);
}
