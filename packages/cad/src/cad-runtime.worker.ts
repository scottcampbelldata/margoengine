import { parseCADGeometry, capError, maxBytes, maxIndices, fingerprint, hash } from './cad-parser.js';
import { checkCount, countLimit } from '../../shared/limits.js';
import { meshBuffers, type MeshBuffers } from './internal/buffers.js';
import { readBRep, type BRepFormat } from './workers/brep-read.js';
declare const self: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
const brepFormats: readonly string[] = ['step', 'iges', 'sat', 'xt', 'jt'];
/**
 * STL/OBJ shading normals: corners at the same point are welded, and each corner takes the weighted normal (area times
 * corner angle) of the triangles at that point whose planes meet its own triangle's within `creaseAngle` degrees. A
 * tessellated curve shades round; an edge sharper than the crease angle (a CAD part's real edges) stays hard. Corners
 * whose normals come out equal share one vertex, so a smooth surface keeps one vertex per point.
 */
function smooth(geometry: MeshBuffers, creaseAngle: number, progress: (percent: number) => void): MeshBuffers {
  const vertices = geometry.vertices,
    indices = geometry.indices,
    corners = indices.length,
    seen = new Map<string, number>(),
    points: number[] = [],
    point = new Uint32Array(corners),
    // Per corner: its triangle's unit normal (stored at the triangle's first corner; zero for a zero-area triangle) and
    // its weight in a smooth normal (twice the triangle's area times the corner angle).
    face = new Float64Array(corners),
    weight = new Float64Array(corners),
    // Triangles meeting at a smaller angle than the crease share a normal; at 180 degrees every triangle at a point does.
    limit = creaseAngle >= 180 ? -2 : Math.cos((creaseAngle * Math.PI) / 180) - 1e-9;
  for (let f = 0; f < corners; f += 3) {
    const ids = [indices[f] * 6, indices[f + 1] * 6, indices[f + 2] * 6],
      a = ids[0],
      b = ids[1],
      c = ids[2],
      ux = vertices[b] - vertices[a],
      uy = vertices[b + 1] - vertices[a + 1],
      uz = vertices[b + 2] - vertices[a + 2],
      vx = vertices[c] - vertices[a],
      vy = vertices[c + 1] - vertices[a + 1],
      vz = vertices[c + 2] - vertices[a + 2],
      nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx,
      // Exporters emit zero-area triangles (repeated corners, e.g. along a degenerate edge); they stay as emitted and
      // add no normal weight (their corner angles are undefined).
      length = Math.hypot(nx, ny, nz);
    if (length) {
      face[f] = nx / length;
      face[f + 1] = ny / length;
      face[f + 2] = nz / length;
    }
    for (let j = 0; j < 3; j++) {
      const at = ids[j],
        next = ids[(j + 1) % 3],
        prev = ids[(j + 2) % 3],
        x = vertices[at],
        y = vertices[at + 1],
        z = vertices[at + 2],
        // Corners weld only at the same Float32 point (the stored values; -0 prints as 0). An exporter's copies of a
        // shared edge are bit-identical; a 1e-5 grid also merged distinct corners micrometres apart.
        key = `${x},${y},${z}`;
      let id = seen.get(key);
      if (id === undefined) {
        id = points.length / 3;
        seen.set(key, id);
        points.push(x, y, z);
      }
      point[f + j] = id;
      if (!length) continue;
      const ex = vertices[next] - x,
        ey = vertices[next + 1] - y,
        ez = vertices[next + 2] - z,
        fx = vertices[prev] - x,
        fy = vertices[prev + 1] - y,
        fz = vertices[prev + 2] - z;
      weight[f + j] =
        length *
        Math.acos(
          Math.max(-1, Math.min(1, (ex * fx + ey * fy + ez * fz) / (Math.hypot(ex, ey, ez) * Math.hypot(fx, fy, fz)))),
        );
    }
    if (f % 30_000 === 0) progress((0.5 * f) / corners);
  }
  // The corners at each point, contiguous: order[start[p] .. start[p + 1]) (a counting sort by point).
  const count = points.length / 3,
    start = new Uint32Array(count + 1),
    order = new Uint32Array(corners);
  for (let c = 0; c < corners; c++) start[point[c] + 1]++;
  for (let p = 0; p < count; p++) start[p + 1] += start[p];
  const fill = start.slice(0, count);
  for (let c = 0; c < corners; c++) order[fill[point[c]]++] = c;

  const positions: number[] = [],
    normals: number[] = [],
    packed = new Uint32Array(corners),
    // Per point: its distinct triangle directions (a fan of coplanar triangles is one direction), their summed weights,
    // and each direction's smooth normal.
    directions: number[] = [],
    sums: number[] = [],
    smoothed: number[] = [];
  for (let p = 0; p < count; p++) {
    directions.length = sums.length = smoothed.length = 0;
    for (let k = start[p]; k < start[p + 1]; k++) {
      const c = order[k],
        t = c - (c % 3);
      if (!weight[c]) continue;
      let d = 0;
      while (
        d < directions.length &&
        !(directions[d] === face[t] && directions[d + 1] === face[t + 1] && directions[d + 2] === face[t + 2])
      )
        d += 3;
      if (d === directions.length) {
        directions.push(face[t], face[t + 1], face[t + 2]);
        sums.push(0);
      }
      sums[d / 3] += weight[c];
    }
    for (let d = 0; d < directions.length; d += 3) {
      let nx = 0,
        ny = 0,
        nz = 0,
        total = 0;
      for (let e = 0; e < directions.length; e += 3) {
        if (
          directions[d] * directions[e] +
            directions[d + 1] * directions[e + 1] +
            directions[d + 2] * directions[e + 2] <
          limit
        )
          continue;
        const w = sums[e / 3];
        nx += directions[e] * w;
        ny += directions[e + 1] * w;
        nz += directions[e + 2] * w;
        total += w;
      }
      const length = Math.hypot(nx, ny, nz);
      // Opposite faces cancel (a zero-thickness sheet seen from both sides): keep the triangle's own direction.
      if (length > 1e-6 * total) smoothed.push(nx / length, ny / length, nz / length);
      else smoothed.push(directions[d], directions[d + 1], directions[d + 2]);
    }
    // One vertex per distinct normal at this point. A corner only zero-area triangles use draws nothing: it takes the
    // point's first vertex, or one with +Z when no triangle there has area.
    const first = positions.length / 3,
      vertex = (nx: number, ny: number, nz: number) => {
        let id = first;
        while (
          id < positions.length / 3 &&
          !(normals[id * 3] === nx && normals[id * 3 + 1] === ny && normals[id * 3 + 2] === nz)
        )
          id++;
        if (id === positions.length / 3) {
          positions.push(points[p * 3], points[p * 3 + 1], points[p * 3 + 2]);
          normals.push(nx, ny, nz);
        }
        return id;
      };
    for (let k = start[p]; k < start[p + 1]; k++) {
      const c = order[k],
        t = c - (c % 3);
      if (!weight[c]) continue;
      let d = 0;
      while (!(directions[d] === face[t] && directions[d + 1] === face[t + 1] && directions[d + 2] === face[t + 2]))
        d += 3;
      packed[c] = vertex(smoothed[d], smoothed[d + 1], smoothed[d + 2]);
    }
    for (let k = start[p]; k < start[p + 1]; k++) {
      const c = order[k];
      if (!weight[c]) packed[c] = positions.length / 3 > first ? first : vertex(0, 0, 1);
    }
    if (p % 10_000 === 0) progress(0.5 + (0.5 * p) / count);
  }
  return meshBuffers(positions, normals, packed);
}
self.onmessage = (event: MessageEvent) => {
  try {
    const {
      buffer,
      format,
      smoothing,
      creaseAngle = 40,
      maxParts,
      linearDeflection,
    } = event.data as {
      buffer: ArrayBuffer;
      format: string;
      smoothing: boolean;
      creaseAngle?: number;
      maxParts?: number;
      linearDeflection?: number;
    };
    if (
      !(buffer instanceof ArrayBuffer) ||
      !buffer.byteLength ||
      buffer.byteLength > maxBytes ||
      !(format === 'stl' || format === 'obj' || brepFormats.includes(format))
    )
      throw new TypeError(
        'Invalid CAD worker input: expected a non-empty ArrayBuffer within the size limit and format stl, obj, step, iges, sat, xt or jt.',
      );
    let last = -1;
    const progress = (percent: number) => {
      const value = Math.floor(percent);
      if (value > last) {
        last = value;
        self.postMessage({ progress: value });
      }
    };
    progress(0);
    if (brepFormats.includes(format)) {
      // Margo's B-rep kernel: each placed body is meshed once from its exact geometry (exact surface normals, hard at
      // every B-rep edge) and every placement reuses it with its own transform.
      const limit = countLimit('maxParts', maxParts),
        read = readBRep(buffer, format as BRepFormat, {
          deflection: linearDeflection,
          smoothing,
          progress: (fraction) => progress(5 + 90 * fraction),
          checkParts: (count) => checkCount('Too many CAD parts', count, limit, 'maxParts'),
          checkIndices: (count) => {
            if (count > maxIndices) throw capError(`CAD triangle limit (over ${maxIndices / 3})`, format);
          },
        }),
        sent = new Map<number, number>();
      read.placements.forEach((placement, i) => {
        const { geometry: id, name, color, position, rotation, scale } = placement,
          reuse = sent.get(id),
          transform = { position, rotation, scale };
        if (reuse !== undefined) self.postMessage({ part: { name, color, transform, reuse } });
        else {
          sent.set(id, i);
          const g = read.geometries[id];
          self.postMessage(
            { part: { name, color, transform, vertices: g.vertices, indices: g.indices, bounds: g.bounds } },
            [g.vertices.buffer, g.indices.buffer, g.bounds.buffer] as ArrayBuffer[],
          );
        }
        progress(95 + (4 * (i + 1)) / read.placements.length);
      });
      progress(100);
      self.postMessage({ done: true, failedFaces: read.failedFaces, warnings: read.warnings });
      return;
    }
    const parts = parseCADGeometry(buffer, format as 'stl' | 'obj', meshBuffers, (p) => progress(p * 50), maxParts);
    progress(50);
    const seen = new Map<string, Array<{ data: Float32Array; index: number }>>(),
      // Only parts with equal triangle counts can match (smoothing keeps the count), so a part whose count no other
      // part has skips the fingerprint: a sort of all its triangles plus a CRC, 40 ms for a 200k-triangle STL.
      counts = new Map<number, number>();
    for (const part of parts)
      counts.set(part.geometry.indices.length, (counts.get(part.geometry.indices.length) ?? 0) + 1);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // STL/OBJ carry no surface normals: weld and smooth them up to the crease angle.
      if (smoothing)
        part.geometry = smooth(part.geometry, creaseAngle, (p) => progress(50 + (49 * (i + p)) / parts.length));
      const g = part.geometry,
        data = counts.get(g.indices.length)! > 1 ? fingerprint(g) : undefined,
        key = data && `${data.length}:${hash(data)}`,
        bucket = (key && seen.get(key)) || [],
        match = data && bucket.find((entry) => entry.data.every((value, i) => value === data[i]));
      if (match) self.postMessage({ part: { name: part.name, reuse: match.index } });
      else {
        if (data && key) {
          bucket.push({ data, index: i });
          seen.set(key, bucket);
        }
        self.postMessage({ part: { name: part.name, vertices: g.vertices, indices: g.indices, bounds: g.bounds } }, [
          g.vertices.buffer,
          g.indices.buffer,
          g.bounds.buffer,
        ] as ArrayBuffer[]);
      }
      progress(50 + (49 * (i + 1)) / parts.length);
    }
    progress(100);
    self.postMessage({ done: true });
  } catch (error) {
    // The class travels with the message, so a cap or an invalid file still reaches the caller as RangeError or TypeError.
    self.postMessage({ error: error instanceof Error ? error.message : String(error), kind: (error as Error)?.name });
  }
};
