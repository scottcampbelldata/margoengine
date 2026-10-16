import type {GeometryData} from '@margoengine/exporters';
import {array, findChild, type FBXNode} from './document.js';

const MAX_VERTICES = 1_000_000, MAX_CORNERS = 3_000_000, MAX_POLYGON = 4096, MAX_WORK = 40_000_000;
const budget = (): never => {throw new RangeError('FBX geometry budget exceeded');};
const finite = (value: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) throw new RangeError(`FBX ${label} must contain finite Float32 values`);
  return value;
};
const integer = (value: number, limit: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= limit) throw new RangeError(`FBX ${label} out of range`);
  return value;
};

interface Layer {values: ArrayLike<number>; indices: ArrayLike<number>; mapping: string; reference: string; size: number; label: string}
function layer(node: FBXNode, name: string, values: string, indexes: string, size: number): Layer|undefined {
  const child = findChild(node, name); if (!child) return;
  const mapping = String(findChild(child, 'MappingInformationType')?.properties[0]), reference = String(findChild(child, 'ReferenceInformationType')?.properties[0]);
  if (!['ByVertice', 'ByVertex', 'ByControlPoint', 'ByPolygonVertex', 'ByPolygon', 'AllSame'].includes(mapping)) throw new RangeError(`FBX unsupported ${name} mapping ${mapping}`);
  if (!['Direct', 'IndexToDirect', 'Index'].includes(reference)) throw new RangeError(`FBX unsupported ${name} reference ${reference}`);
  const direct = array(child, values), indices = reference === 'Direct' ? [] : array(child, indexes);
  if (!direct.length || direct.length % size) throw new RangeError(`FBX malformed ${name} values`);
  return {values: direct, indices, mapping, reference, size, label: name};
}

function layerIndex(layer: Layer, cp: number, corner: number, polygon: number): number {
  const mapped = layer.mapping === 'AllSame' ? 0 : layer.mapping === 'ByPolygon' ? polygon : layer.mapping === 'ByPolygonVertex' ? corner : cp;
  if (layer.reference !== 'Direct') {
    if (mapped >= layer.indices.length) throw new RangeError(`FBX ${layer.label} index array too short`);
    return integer(layer.indices[mapped], layer.values.length/layer.size, `${layer.label} direct index`);
  }
  return integer(mapped, layer.values.length/layer.size, `${layer.label} index`);
}

type Point = [number, number];
const cross = (a: Point, b: Point, c: Point): number => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function intersects(a: Point, b: Point, c: Point, d: Point, eps: number): boolean {
  const values = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)].map(v => Math.abs(v) <= eps ? 0 : Math.sign(v));
  if (values[0]*values[1] < 0 && values[2]*values[3] < 0) return true;
  const on = (p: Point, x: Point, y: Point) => p[0] >= Math.min(x[0], y[0]) && p[0] <= Math.max(x[0], y[0]) && p[1] >= Math.min(x[1], y[1]) && p[1] <= Math.max(x[1], y[1]);
  return !values[0] && on(c, a, b) || !values[1] && on(d, a, b) || !values[2] && on(a, c, d) || !values[3] && on(b, c, d);
}

/** Returns original polygon-corner indices, never newly inserted vertices. */
function triangulate(corners: number[], controlPoints: number[], positions: ArrayLike<number>, charge: (amount?: number) => void): number[] {
  const n = corners.length;
  if (n < 3) throw new RangeError('FBX polygon needs at least three vertices');
  if (n > MAX_POLYGON) budget();
  charge(n);
  let nx = 0, ny = 0, nz = 0;
  // Newell projection is stable for concave polygons and does not depend on the first triangle.
  for (let i = 0; i < n; i++) {
    const a = controlPoints[corners[i]]*3, b = controlPoints[corners[(i+1)%n]]*3;
    nx += (positions[a+1]-positions[b+1])*(positions[a+2]+positions[b+2]);
    ny += (positions[a+2]-positions[b+2])*(positions[a]+positions[b]);
    nz += (positions[a]-positions[b])*(positions[a+1]+positions[b+1]);
  }
  const axis = Math.abs(nx) > Math.abs(ny) ? Math.abs(nx) > Math.abs(nz) ? 0 : 2 : Math.abs(ny) > Math.abs(nz) ? 1 : 2;
  if (!Math.hypot(nx, ny, nz)) throw new RangeError('FBX polygon has zero area');
  const points: Point[] = corners.map(c => {const p = controlPoints[c]*3; return axis === 0 ? [positions[p+1], positions[p+2]] : axis === 1 ? [positions[p], positions[p+2]] : [positions[p], positions[p+1]];});
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 2; k++) {min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]);}
  const extent = Math.max(max[0]-min[0], max[1]-min[1]), eps = extent*extent*Number.EPSILON*64;
  let area = 0;
  for (let i = 1; i < n-1; i++) area += cross(points[0], points[i], points[i+1]);
  if (Math.abs(area) <= eps) throw new RangeError('FBX polygon has zero area');
  const winding = Math.sign(area); let convex = true, turn = 0;
  for (let i = 0; i < n; i++) {
    const a = points[(i+n-1)%n], b = points[i], c = points[(i+1)%n], value = cross(a, b, c);
    if (Math.abs(value) <= eps || Math.sign(value) !== winding) convex = false;
    turn += Math.atan2(value, (b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1]));
    if (a[0] === b[0] && a[1] === b[1]) throw new RangeError('FBX polygon has repeated adjacent vertices');
  }
  // A star can have same-sign turns; one complete turn is required for the convex fast path.
  if (convex && Math.abs(Math.abs(turn)-2*Math.PI) < 1e-6) {
    const out: number[] = [];
    for (let i = 1; i < n-1; i++) out.push(corners[0], corners[i], corners[i+1]);
    return out;
  }
  for (let i = 0; i < n; i++) for (let j = i+1; j < n; j++) {
    if (j === i+1 || i === 0 && j === n-1) continue;
    charge();
    if (intersects(points[i], points[(i+1)%n], points[j], points[(j+1)%n], eps)) throw new RangeError('FBX polygon crosses itself');
  }
  const ring = Array.from({length: n}, (_, i) => i), out: number[] = [];
  while (ring.length > 3) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const ai = ring[(i+ring.length-1)%ring.length], bi = ring[i], ci = ring[(i+1)%ring.length], a = points[ai], b = points[bi], c = points[ci], value = cross(a, b, c)*winding;
      charge();
      if (Math.abs(value) <= eps) {ring.splice(i, 1); clipped = true; break;}
      if (value < 0) continue;
      let inside = false;
      for (const pi of ring) {
        if (pi === ai || pi === bi || pi === ci) continue;
        charge(); const p = points[pi];
        if (cross(a, b, p)*winding >= -eps && cross(b, c, p)*winding >= -eps && cross(c, a, p)*winding >= -eps) {inside = true; break;}
      }
      if (!inside) {out.push(corners[ai], corners[bi], corners[ci]); ring.splice(i, 1); clipped = true; break;}
    }
    if (!clipped) throw new RangeError('FBX polygon cannot be triangulated');
  }
  if (ring.length === 3 && Math.abs(cross(points[ring[0]], points[ring[1]], points[ring[2]])) > eps) out.push(...ring.map(i => corners[i]));
  if (!out.length) throw new RangeError('FBX polygon has zero area');
  return out;
}

interface Builder {positions: number[]; normals: number[]; uvs: number[]; tangents: number[]; colors: number[]; indices: number[]; controlPoints: number[]; vertices: Map<string, number>}
export interface BuiltGeometry {primitives: {geometry: GeometryData; materialIndex: number}[]; controlPoints: Uint32Array[]; vertexCount: number}

/** Converts the first normal, UV, tangent and color layer; later UV sets are deliberately omitted. */
export function buildGeometry(node: FBXNode): BuiltGeometry {
  const positions = array(node, 'Vertices'), polygonIndices = array(node, 'PolygonVertexIndex'), count = positions.length/3;
  if (!positions.length || positions.length%3) throw new RangeError('FBX vertices need xyz per control point');
  if (count > MAX_VERTICES || polygonIndices.length > MAX_CORNERS) budget();
  for (let i = 0; i < positions.length; i++) finite(positions[i], 'positions');
  const normal = layer(node, 'LayerElementNormal', 'Normals', 'NormalsIndex', 3);
  const uv = layer(node, 'LayerElementUV', 'UV', 'UVIndex', 2), color = layer(node, 'LayerElementColor', 'Colors', 'ColorIndex', 4);
  const tangent = layer(node, 'LayerElementTangent', 'Tangents', 'TangentsIndex', 3), binormal = layer(node, 'LayerElementBinormal', 'Binormals', 'BinormalsIndex', 3);
  const material = findChild(node, 'LayerElementMaterial');
  const materialMapping = material ? String(findChild(material, 'MappingInformationType')?.properties[0]) : 'AllSame';
  if (material && !['ByPolygon', 'AllSame', 'NoMappingInformation'].includes(materialMapping)) throw new RangeError(`FBX unsupported material mapping ${materialMapping}`);
  const materials = material && materialMapping !== 'NoMappingInformation' ? array(material, 'Materials') : undefined;
  if (materials) {const reference = String(findChild(material!, 'ReferenceInformationType')?.properties[0]); if (!['Direct', 'IndexToDirect', 'Index'].includes(reference)) throw new RangeError(`FBX unsupported material reference ${reference}`);}
  const cp: number[] = [], cornerPolygon: number[] = [], triangles: number[] = [];
  let polygon: number[] = [], polygonCount = 0, work = 0;
  const charge = (amount = 1) => {if ((work += amount) > MAX_WORK) budget();};
  for (let i = 0; i < polygonIndices.length; i++) {
    const index = polygonIndices[i];
    if (!Number.isSafeInteger(index)) throw new RangeError('FBX polygon index must be an integer');
    cp.push(integer(index < 0 ? -index-1 : index, count, 'control point')); cornerPolygon.push(polygonCount); polygon.push(i);
    if (polygon.length > MAX_POLYGON) budget();
    if (index < 0) {
      const tri = triangulate(polygon, cp, positions, charge);
      if (triangles.length+tri.length > MAX_CORNERS) budget();
      // Avoid argument-spread limits on large but valid polygons.
      for (const corner of tri) triangles.push(corner);
      polygon = []; polygonCount++;
    }
  }
  if (polygon.length) throw new RangeError('FBX polygon is missing its terminator');
  if (!triangles.length) throw new RangeError('FBX geometry contains no triangles');
  const generated = new Float64Array(count*3);
  for (let i = 0; i < triangles.length; i += 3) {
    const a = cp[triangles[i]]*3, b = cp[triangles[i+1]]*3, c = cp[triangles[i+2]]*3;
    const ux = positions[b]-positions[a], uy = positions[b+1]-positions[a+1], uz = positions[b+2]-positions[a+2], vx = positions[c]-positions[a], vy = positions[c+1]-positions[a+1], vz = positions[c+2]-positions[a+2];
    const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    if (!Math.hypot(nx, ny, nz)) throw new RangeError('FBX triangle has zero area');
    for (const v of [a, b, c]) {generated[v] += nx; generated[v+1] += ny; generated[v+2] += nz;}
  }
  const builders = new Map<number, Builder>(); let vertexCount = 0;
  for (const corner of triangles) {
    const control = cp[corner], poly = cornerPolygon[corner];
    let materialIndex = materialMapping === 'NoMappingInformation' ? -1 : 0;
    if (materials) {
      const index = materialMapping === 'AllSame' ? 0 : poly;
      if (index >= materials.length) throw new RangeError('FBX material index array too short');
      // The FBX SDK uses -1 for an unassigned polygon, even when the node has other materials.
      materialIndex = materials[index] === -1 ? -1 : integer(materials[index], 65536, 'material index');
    }
    let builder = builders.get(materialIndex);
    if (!builder) {builder = {positions: [], normals: [], uvs: [], tangents: [], colors: [], indices: [], controlPoints: [], vertices: new Map()}; builders.set(materialIndex, builder);}
    const ni = normal ? layerIndex(normal, control, corner, poly) : -1, ui = uv ? layerIndex(uv, control, corner, poly) : -1;
    const ci = color ? layerIndex(color, control, corner, poly) : -1, ti = tangent ? layerIndex(tangent, control, corner, poly) : -1, bi = binormal ? layerIndex(binormal, control, corner, poly) : -1;
    const key = `${control}/${ni}/${ui}/${ci}/${ti}/${bi}`; let vertex = builder.vertices.get(key);
    if (vertex !== undefined) {builder.indices.push(vertex); continue;}
    if (++vertexCount > MAX_VERTICES) budget();
    vertex = builder.controlPoints.length; builder.vertices.set(key, vertex); builder.controlPoints.push(control); builder.indices.push(vertex);
    builder.positions.push(positions[control*3], positions[control*3+1], positions[control*3+2]);
    let nx = normal ? finite(normal.values[ni*3], 'normals') : 0, ny = normal ? finite(normal.values[ni*3+1], 'normals') : 0, nz = normal ? finite(normal.values[ni*3+2], 'normals') : 0;
    if (!Math.hypot(nx, ny, nz)) {nx = generated[control*3]; ny = generated[control*3+1]; nz = generated[control*3+2];}
    const length = Math.hypot(nx, ny, nz);
    if (!length) throw new RangeError('FBX generated normal has zero length');
    nx /= length; ny /= length; nz /= length; builder.normals.push(nx, ny, nz);
    if (uv) builder.uvs.push(finite(uv.values[ui*2], 'UVs'), 1-finite(uv.values[ui*2+1], 'UVs'));
    if (color) for (let k = 0; k < 4; k++) {const value = finite(color.values[ci*4+k], 'colors'); if (value < 0 || value > 1) throw new RangeError('FBX colors must be in [0, 1]'); builder.colors.push(value);}
    if (tangent) {
      let tx = finite(tangent.values[ti*3], 'tangents'), ty = finite(tangent.values[ti*3+1], 'tangents'), tz = finite(tangent.values[ti*3+2], 'tangents');
      const projection = nx*tx+ny*ty+nz*tz; tx -= nx*projection; ty -= ny*projection; tz -= nz*projection;
      const tlength = Math.hypot(tx, ty, tz); if (!tlength) throw new RangeError('FBX tangent must be nonzero and perpendicular to its normal');
      tx /= tlength; ty /= tlength; tz /= tlength;
      // Flipping texture V also reverses the tangent frame's handedness.
      let sign = -1;
      if (binormal) {const bx = finite(binormal.values[bi*3], 'binormals'), by = finite(binormal.values[bi*3+1], 'binormals'), bz = finite(binormal.values[bi*3+2], 'binormals'); sign = (ny*tz-nz*ty)*bx+(nz*tx-nx*tz)*by+(nx*ty-ny*tx)*bz < 0 ? 1 : -1;}
      builder.tangents.push(tx, ty, tz, sign);
    }
  }
  const primitives: BuiltGeometry['primitives'] = [], controlPoints: Uint32Array[] = [];
  for (const [materialIndex, builder] of builders) {
    const geometry: GeometryData = {positions: Float32Array.from(builder.positions), normals: Float32Array.from(builder.normals), indices: Uint32Array.from(builder.indices)};
    if (uv) geometry.uvs = Float32Array.from(builder.uvs);
    if (tangent) geometry.tangents = Float32Array.from(builder.tangents);
    if (color) geometry.colors = Float32Array.from(builder.colors);
    primitives.push({materialIndex, geometry}); controlPoints.push(Uint32Array.from(builder.controlPoints));
  }
  return {primitives, controlPoints, vertexCount};
}
