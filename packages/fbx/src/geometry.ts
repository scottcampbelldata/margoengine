import { defaultLimits, type FBXImportLimits } from './limits.js';
import type { GeometryData } from '@margoengine/exporters';
import { array, findChild, type FBXNode } from './document.js';

const MAX_POLYGON = 4096;
const budget = (): never => {
  throw new RangeError(
    'FBX geometry budget exceeded; simplify or split the scene, the import limits are listed in the README',
  );
};
const finite = (value: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)))
    throw new RangeError(`FBX ${label} must contain finite Float32 values`);
  return value;
};
const integer = (value: number, limit: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= limit)
    throw new RangeError(`FBX ${label} out of range; re-export the file, it looks damaged`);
  return value;
};

interface Layer {
  values: ArrayLike<number>;
  indices: ArrayLike<number>;
  mapping: string;
  reference: string;
  size: number;
  label: string;
}
function layer(node: FBXNode, name: string, values: string, indexes: string, size: number): Layer | undefined {
  const child = findChild(node, name);
  return child && readLayer(child, name, values, indexes, size);
}

/** Every layer of a kind by its index in the file, up to `most`: the first alone unless `all`. */
function layerList(
  node: FBXNode,
  name: string,
  values: string,
  indexes: string,
  size: number,
  most: number,
): { layer: Layer; name: string }[] {
  const found = node.children.filter((child) => child.name === name);
  found.sort((a, b) => Number(a.properties[0] ?? 0) - Number(b.properties[0] ?? 0));
  return found.slice(0, most).map((child) => ({
    layer: readLayer(child, name, values, indexes, size),
    name: String(findChild(child, 'Name')?.properties[0] ?? ''),
  }));
}

function readLayer(child: FBXNode, name: string, values: string, indexes: string, size: number): Layer {
  const mapping = String(findChild(child, 'MappingInformationType')?.properties[0]),
    reference = String(findChild(child, 'ReferenceInformationType')?.properties[0]);
  if (!['ByVertice', 'ByVertex', 'ByControlPoint', 'ByPolygonVertex', 'ByPolygon', 'AllSame'].includes(mapping))
    throw new RangeError(`FBX unsupported ${name} mapping ${mapping}; bake or remove it in your 3D tool before export`);
  if (!['Direct', 'IndexToDirect', 'Index'].includes(reference))
    throw new RangeError(
      `FBX unsupported ${name} reference ${reference}; bake or remove it in your 3D tool before export`,
    );
  const direct = array(child, values),
    indices = reference === 'Direct' ? [] : array(child, indexes);
  if (!direct.length || direct.length % size)
    throw new RangeError(`FBX malformed ${name} values; re-export the file, it looks damaged`);
  return { values: direct, indices, mapping, reference, size, label: name };
}

function layerIndex(layer: Layer, cp: number, corner: number, polygon: number): number {
  const mapped =
    layer.mapping === 'AllSame'
      ? 0
      : layer.mapping === 'ByPolygon'
        ? polygon
        : layer.mapping === 'ByPolygonVertex'
          ? corner
          : cp;
  if (layer.reference !== 'Direct') {
    if (mapped >= layer.indices.length)
      throw new RangeError(`FBX ${layer.label} index array too short; re-export the file, it looks damaged`);
    return integer(layer.indices[mapped], layer.values.length / layer.size, `${layer.label} direct index`);
  }
  return integer(mapped, layer.values.length / layer.size, `${layer.label} index`);
}

const unmapped = (layer: Layer, corner: number): boolean =>
  layer.reference !== 'Direct' && layer.mapping === 'ByPolygonVertex' && layer.indices[corner] === -1;

type Point = [number, number];
const cross = (a: Point, b: Point, c: Point): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
/**
 * Corners of a polygon as triangles. Real files hold polygons with a corner repeated, with no area, or crossing
 * themselves, and every tool keeps them and draws what it can: a repeat is skipped, no area gives no triangles, and a
 * polygon the ears run out on goes on from its next corner.
 */
function triangulate(
  given: number[],
  controlPoints: number[],
  positions: ArrayLike<number>,
  charge: (amount?: number) => void,
): number[] {
  if (given.length > MAX_POLYGON) budget();
  charge(given.length);
  const samePlace = (a: number, b: number): boolean => {
    const p = controlPoints[a] * 3,
      q = controlPoints[b] * 3;
    return (
      positions[p] === positions[q] && positions[p + 1] === positions[q + 1] && positions[p + 2] === positions[q + 2]
    );
  };
  const corners = given.filter((corner, i) => !samePlace(corner, given[(i + given.length - 1) % given.length])),
    n = corners.length;
  if (n < 3) return [];
  let nx = 0,
    ny = 0,
    nz = 0;
  // Newell projection is stable for concave polygons and does not depend on the first triangle.
  for (let i = 0; i < n; i++) {
    const a = controlPoints[corners[i]] * 3,
      b = controlPoints[corners[(i + 1) % n]] * 3;
    nx += (positions[a + 1] - positions[b + 1]) * (positions[a + 2] + positions[b + 2]);
    ny += (positions[a + 2] - positions[b + 2]) * (positions[a] + positions[b]);
    nz += (positions[a] - positions[b]) * (positions[a + 1] + positions[b + 1]);
  }
  // A crossing polygon can sum to no area and still have corners to draw: its strongest corner gives the plane.
  if (!Math.hypot(nx, ny, nz))
    for (let i = 0; i < n; i++) {
      const a = controlPoints[corners[i]] * 3,
        b = controlPoints[corners[(i + 1) % n]] * 3,
        c = controlPoints[corners[(i + 2) % n]] * 3,
        ux = positions[b] - positions[a],
        uy = positions[b + 1] - positions[a + 1],
        uz = positions[b + 2] - positions[a + 2],
        vx = positions[c] - positions[b],
        vy = positions[c + 1] - positions[b + 1],
        vz = positions[c + 2] - positions[b + 2],
        x = uy * vz - uz * vy,
        y = uz * vx - ux * vz,
        z = ux * vy - uy * vx;
      if (Math.hypot(x, y, z) > Math.hypot(nx, ny, nz)) [nx, ny, nz] = [x, y, z];
    }
  const axis =
    Math.abs(nx) > Math.abs(ny) ? (Math.abs(nx) > Math.abs(nz) ? 0 : 2) : Math.abs(ny) > Math.abs(nz) ? 1 : 2;
  if (!Math.hypot(nx, ny, nz)) return [];
  const points: Point[] = corners.map((c) => {
    const p = controlPoints[c] * 3;
    return axis === 0
      ? [positions[p + 1], positions[p + 2]]
      : axis === 1
        ? [positions[p], positions[p + 2]]
        : [positions[p], positions[p + 1]];
  });
  const min = [Infinity, Infinity],
    max = [-Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 2; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  const extent = Math.max(max[0] - min[0], max[1] - min[1]),
    eps = extent * extent * Number.EPSILON * 64;
  let area = 0;
  for (let i = 1; i < n - 1; i++) area += cross(points[0], points[i], points[i + 1]);
  const winding = Math.sign(area) || 1;
  let convex = true,
    turn = 0;
  for (let i = 0; i < n; i++) {
    const a = points[(i + n - 1) % n],
      b = points[i],
      c = points[(i + 1) % n],
      value = cross(a, b, c);
    if (Math.abs(value) <= eps || Math.sign(value) !== winding) convex = false;
    turn += Math.atan2(value, (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]));
  }
  // A star can have same-sign turns; one complete turn is required for the convex fast path.
  if (convex && Math.abs(Math.abs(turn) - 2 * Math.PI) < 1e-6) {
    const out: number[] = [];
    for (let i = 1; i < n - 1; i++) out.push(corners[0], corners[i], corners[i + 1]);
    return out;
  }
  const ring = Array.from({ length: n }, (_, i) => i),
    out: number[] = [];
  while (ring.length > 3) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const ai = ring[(i + ring.length - 1) % ring.length],
        bi = ring[i],
        ci = ring[(i + 1) % ring.length],
        a = points[ai],
        b = points[bi],
        c = points[ci],
        value = cross(a, b, c) * winding;
      charge();
      if (Math.abs(value) <= eps) {
        ring.splice(i, 1);
        clipped = true;
        break;
      }
      if (value < 0) continue;
      let inside = false;
      for (const pi of ring) {
        if (pi === ai || pi === bi || pi === ci) continue;
        charge();
        const p = points[pi];
        if (cross(a, b, p) * winding >= -eps && cross(b, c, p) * winding >= -eps && cross(c, a, p) * winding >= -eps) {
          inside = true;
          break;
        }
      }
      if (!inside) {
        out.push(corners[ai], corners[bi], corners[ci]);
        ring.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) {
      const [ai, bi, ci] = ring;
      out.push(corners[ai], corners[bi], corners[ci]);
      ring.splice(1, 1);
    }
  }
  if (ring.length === 3 && Math.abs(cross(points[ring[0]], points[ring[1]], points[ring[2]])) > eps)
    out.push(...ring.map((i) => corners[i]));
  return out;
}

interface Builder {
  positions: number[];
  normals: number[];
  uvs: number[][];
  tangents: number[];
  colors: number[][];
  indices: number[];
  controlPoints: number[];
  vertices: Map<string, number>;
}
export interface BuiltGeometry {
  primitives: { geometry: GeometryData; materialIndex: number }[];
  controlPoints: Uint32Array[];
  vertexCount: number;
  /** The file's name of each UV set kept, in order. */
  uvNames: string[];
}

const UV_KEYS = ['uvs', 'uvs1', 'uvs2', 'uvs3'] as const,
  COLOR_KEYS = ['colors', 'colors1'] as const;

/** Converts the first normal and tangent layer, and the first UV and color layer, or as many as glTF here holds with `all`. */
export function buildGeometry(
  node: FBXNode,
  all = false,
  limits: Readonly<FBXImportLimits> = defaultLimits,
): BuiltGeometry {
  const positions = array(node, 'Vertices'),
    polygonIndices = array(node, 'PolygonVertexIndex'),
    count = positions.length / 3;
  if (!positions.length || positions.length % 3) throw new RangeError('FBX vertices need xyz per control point');
  if (count > limits.vertices || polygonIndices.length > limits.corners) budget();
  for (let i = 0; i < positions.length; i++) finite(positions[i], 'positions');
  const normal = layer(node, 'LayerElementNormal', 'Normals', 'NormalsIndex', 3);
  const uvs = layerList(node, 'LayerElementUV', 'UV', 'UVIndex', 2, all ? UV_KEYS.length : 1),
    colors = layerList(node, 'LayerElementColor', 'Colors', 'ColorIndex', 4, all ? COLOR_KEYS.length : 1);
  const tangent = layer(node, 'LayerElementTangent', 'Tangents', 'TangentsIndex', 3),
    binormal = layer(node, 'LayerElementBinormal', 'Binormals', 'BinormalsIndex', 3);
  const material = findChild(node, 'LayerElementMaterial');
  const materialMapping = material ? String(findChild(material, 'MappingInformationType')?.properties[0]) : 'AllSame';
  if (material && !['ByPolygon', 'AllSame', 'NoMappingInformation'].includes(materialMapping))
    throw new RangeError(
      `FBX unsupported material mapping ${materialMapping}; bake or remove it in your 3D tool before export`,
    );
  const materials = material && materialMapping !== 'NoMappingInformation' ? array(material, 'Materials') : undefined;
  if (materials) {
    const reference = String(findChild(material!, 'ReferenceInformationType')?.properties[0]);
    if (!['Direct', 'IndexToDirect', 'Index'].includes(reference))
      throw new RangeError(
        `FBX unsupported material reference ${reference}; bake or remove it in your 3D tool before export`,
      );
  }
  const cp: number[] = [],
    cornerPolygon: number[] = [],
    triangles: number[] = [];
  let polygon: number[] = [],
    polygonCount = 0,
    work = 0;
  const charge = (amount = 1) => {
    if ((work += amount) > limits.geometryWork) budget();
  };
  for (let i = 0; i < polygonIndices.length; i++) {
    const index = polygonIndices[i];
    if (!Number.isSafeInteger(index)) throw new RangeError('FBX polygon index must be an integer');
    cp.push(integer(index < 0 ? -index - 1 : index, count, 'control point'));
    cornerPolygon.push(polygonCount);
    polygon.push(i);
    if (polygon.length > MAX_POLYGON) budget();
    if (index < 0) {
      const tri = triangulate(polygon, cp, positions, charge);
      if (triangles.length + tri.length > limits.corners) budget();
      // Avoid argument-spread limits on large but valid polygons.
      for (const corner of tri) triangles.push(corner);
      polygon = [];
      polygonCount++;
    }
  }
  if (polygon.length)
    throw new RangeError('FBX polygon is missing its terminator; re-export the file, it looks damaged');
  if (!triangles.length)
    throw new RangeError('FBX geometry contains no triangles; remove the empty mesh or add faces in your 3D tool');
  const generated = new Float64Array(count * 3);
  let kept = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = cp[triangles[i]] * 3,
      b = cp[triangles[i + 1]] * 3,
      c = cp[triangles[i + 2]] * 3;
    const ux = positions[b] - positions[a],
      uy = positions[b + 1] - positions[a + 1],
      uz = positions[b + 2] - positions[a + 2],
      vx = positions[c] - positions[a],
      vy = positions[c + 1] - positions[a + 1],
      vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    if (!Math.hypot(nx, ny, nz)) continue;
    for (const v of [a, b, c]) {
      generated[v] += nx;
      generated[v + 1] += ny;
      generated[v + 2] += nz;
    }
    triangles[kept++] = triangles[i];
    triangles[kept++] = triangles[i + 1];
    triangles[kept++] = triangles[i + 2];
  }
  triangles.length = kept;
  if (!kept)
    throw new RangeError('FBX geometry contains no triangles; remove the empty mesh or add faces in your 3D tool');
  const builders = new Map<number, Builder[]>();
  let vertexCount = 0;
  for (let at = 0; at < triangles.length; at++) {
    const corner = triangles[at],
      control = cp[corner],
      poly = cornerPolygon[corner];
    let materialIndex = materialMapping === 'NoMappingInformation' ? -1 : 0;
    if (materials) {
      const index = materialMapping === 'AllSame' ? 0 : poly;
      if (index >= materials.length)
        throw new RangeError('FBX material index array too short; re-export the file, it looks damaged');
      // The FBX SDK uses -1 for an unassigned polygon, even when the node has other materials.
      materialIndex = materials[index] === -1 ? -1 : integer(materials[index], 65536, 'material index');
    }
    const chunks = builders.get(materialIndex) ?? [];
    let builder = chunks[chunks.length - 1];
    // glTF's PBR storage binding holds at most one million 80-byte vertices. Start only at
    // triangle boundaries and retain every corner, layer and control-point mapping.
    if (!builder || (at % 3 === 0 && builder.controlPoints.length > 999_997)) {
      builder = {
        positions: [],
        normals: [],
        uvs: uvs.map(() => []),
        tangents: [],
        colors: colors.map(() => []),
        indices: [],
        controlPoints: [],
        vertices: new Map(),
      };
      chunks.push(builder);
      builders.set(materialIndex, chunks);
    }
    const ni = normal ? layerIndex(normal, control, corner, poly) : -1,
      // Index -1 is a corner the UV set leaves out: it sits at the origin, as in the tool that wrote it.
      ui = uvs.map(({ layer: uv }) => (unmapped(uv, corner) ? -1 : layerIndex(uv, control, corner, poly)));
    const ci = colors.map(({ layer: color }) => layerIndex(color, control, corner, poly)),
      ti = tangent ? layerIndex(tangent, control, corner, poly) : -1,
      bi = binormal ? layerIndex(binormal, control, corner, poly) : -1;
    const key = `${control}/${ni}/${ui}/${ci}/${ti}/${bi}`;
    let vertex = builder.vertices.get(key);
    if (vertex !== undefined) {
      builder.indices.push(vertex);
      continue;
    }
    if (++vertexCount > limits.vertices) budget();
    vertex = builder.controlPoints.length;
    builder.vertices.set(key, vertex);
    builder.controlPoints.push(control);
    builder.indices.push(vertex);
    builder.positions.push(positions[control * 3], positions[control * 3 + 1], positions[control * 3 + 2]);
    let nx = normal ? finite(normal.values[ni * 3], 'normals') : 0,
      ny = normal ? finite(normal.values[ni * 3 + 1], 'normals') : 0,
      nz = normal ? finite(normal.values[ni * 3 + 2], 'normals') : 0;
    if (!Math.hypot(nx, ny, nz)) {
      nx = generated[control * 3];
      ny = generated[control * 3 + 1];
      nz = generated[control * 3 + 2];
    }
    // The two halves of a crossing polygon can cancel at a shared corner: the corner then faces as its triangle does.
    if (!Math.hypot(nx, ny, nz)) {
      const first = at - (at % 3),
        a = cp[triangles[first]] * 3,
        b = cp[triangles[first + 1]] * 3,
        c = cp[triangles[first + 2]] * 3,
        ux = positions[b] - positions[a],
        uy = positions[b + 1] - positions[a + 1],
        uz = positions[b + 2] - positions[a + 2],
        vx = positions[c] - positions[a],
        vy = positions[c + 1] - positions[a + 1],
        vz = positions[c + 2] - positions[a + 2];
      nx = uy * vz - uz * vy;
      ny = uz * vx - ux * vz;
      nz = ux * vy - uy * vx;
    }
    const length = Math.hypot(nx, ny, nz);
    nx /= length;
    ny /= length;
    nz /= length;
    builder.normals.push(nx, ny, nz);
    uvs.forEach(({ layer: uv }, set) =>
      ui[set] < 0
        ? builder.uvs[set].push(0, 1)
        : builder.uvs[set].push(finite(uv.values[ui[set] * 2], 'UVs'), 1 - finite(uv.values[ui[set] * 2 + 1], 'UVs')),
    );
    colors.forEach(({ layer: color }, set) => {
      for (let k = 0; k < 4; k++) {
        const value = finite(color.values[ci[set] * 4 + k], 'colors');
        if (value < 0 || value > 1) throw new RangeError('FBX colors must be in [0, 1]');
        builder.colors[set].push(value);
      }
    });
    if (tangent) {
      let tx = finite(tangent.values[ti * 3], 'tangents'),
        ty = finite(tangent.values[ti * 3 + 1], 'tangents'),
        tz = finite(tangent.values[ti * 3 + 2], 'tangents');
      const projection = nx * tx + ny * ty + nz * tz;
      tx -= nx * projection;
      ty -= ny * projection;
      tz -= nz * projection;
      let tlength = Math.hypot(tx, ty, tz);
      // Tools write a zero tangent, or the normal, where a face's UVs give no direction. No texture has a direction to
      // follow there either, so any unit vector across the normal serves: the axis least like it, made perpendicular.
      if (tlength < 1e-6) {
        const axis =
          Math.abs(nx) <= Math.abs(ny) && Math.abs(nx) <= Math.abs(nz) ? 0 : Math.abs(ny) <= Math.abs(nz) ? 1 : 2;
        tx = (axis === 0 ? 1 : 0) - nx * (axis === 0 ? nx : axis === 1 ? ny : nz);
        ty = (axis === 1 ? 1 : 0) - ny * (axis === 0 ? nx : axis === 1 ? ny : nz);
        tz = (axis === 2 ? 1 : 0) - nz * (axis === 0 ? nx : axis === 1 ? ny : nz);
        tlength = Math.hypot(tx, ty, tz);
      }
      tx /= tlength;
      ty /= tlength;
      tz /= tlength;
      // Flipping texture V also reverses the tangent frame's handedness.
      let sign = -1;
      if (binormal) {
        const bx = finite(binormal.values[bi * 3], 'binormals'),
          by = finite(binormal.values[bi * 3 + 1], 'binormals'),
          bz = finite(binormal.values[bi * 3 + 2], 'binormals');
        sign = (ny * tz - nz * ty) * bx + (nz * tx - nx * tz) * by + (nx * ty - ny * tx) * bz < 0 ? 1 : -1;
      }
      builder.tangents.push(tx, ty, tz, sign);
    }
  }
  const primitives: BuiltGeometry['primitives'] = [],
    controlPoints: Uint32Array[] = [];
  for (const [materialIndex, chunks] of builders)
    for (const builder of chunks) {
      const geometry: GeometryData = {
        positions: Float32Array.from(builder.positions),
        normals: Float32Array.from(builder.normals),
        indices: Uint32Array.from(builder.indices),
      };
      uvs.forEach((_, set) => (geometry[UV_KEYS[set]] = Float32Array.from(builder.uvs[set])));
      if (tangent) geometry.tangents = Float32Array.from(builder.tangents);
      colors.forEach((_, set) => (geometry[COLOR_KEYS[set]] = Float32Array.from(builder.colors[set])));
      primitives.push({ materialIndex, geometry });
      controlPoints.push(Uint32Array.from(builder.controlPoints));
    }
  return { primitives, controlPoints, vertexCount, uvNames: uvs.map((uv) => uv.name) };
}
