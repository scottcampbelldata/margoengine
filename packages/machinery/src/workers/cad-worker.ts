import { parseCADGeometry, maxBytes, fingerprint, hash } from '../cad-parser.js';
import { checkCount, countLimit } from '../../../shared/limits.js';
import { Geometry } from '@margoengine/core';
declare const self: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  importScripts(...urls: string[]): void;
  location: Location;
  occtimportjs?: (options: { locateFile: (file: string) => string }) => Promise<OCCT>;
};
interface OCCT {
  ReadStepFile(data: Uint8Array, options: unknown): Result;
  ReadIgesFile(data: Uint8Array, options: unknown): Result;
}
interface Result {
  success: boolean;
  meshes: Array<{ name: string; attributes: { position: { array: number[] } }; index: { array: number[] } }>;
}
function smooth(geometry: Geometry, progress: (percent: number) => void): Geometry {
  const vertices = geometry.vertices,
    indices = geometry.indices,
    seen = new Map<string, number>(),
    positions: number[] = [],
    normals: number[] = [],
    fallback: number[] = [],
    packed = new Uint32Array(indices.length);
  for (let f = 0; f < indices.length; f += 3) {
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
      nz = ux * vy - uy * vx;
    for (let j = 0; j < 3; j++) {
      const at = ids[j],
        next = ids[(j + 1) % 3],
        prev = ids[(j + 2) % 3],
        x = vertices[at],
        y = vertices[at + 1],
        z = vertices[at + 2],
        key = `${Math.round(x * 100_000)},${Math.round(y * 100_000)},${Math.round(z * 100_000)}`;
      let id = seen.get(key);
      if (id === undefined) {
        id = positions.length / 3;
        seen.set(key, id);
        positions.push(x, y, z);
        normals.push(0, 0, 0);
        fallback.push(nx, ny, nz);
      }
      packed[f + j] = id;
      const ex = vertices[next] - x,
        ey = vertices[next + 1] - y,
        ez = vertices[next + 2] - z,
        fx = vertices[prev] - x,
        fy = vertices[prev + 1] - y,
        fz = vertices[prev + 2] - z,
        angle = Math.acos(
          Math.max(-1, Math.min(1, (ex * fx + ey * fy + ez * fz) / (Math.hypot(ex, ey, ez) * Math.hypot(fx, fy, fz)))),
        );
      normals[id * 3] += nx * angle;
      normals[id * 3 + 1] += ny * angle;
      normals[id * 3 + 2] += nz * angle;
    }
    if (packed[f] === packed[f + 1] || packed[f] === packed[f + 2] || packed[f + 1] === packed[f + 2])
      throw new RangeError('Triangle collapses at CAD welding tolerance');
    if (f % 30_000 === 0) progress(f / indices.length);
  }
  for (let i = 0; i < normals.length; i += 3) {
    let length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (!length) {
      for (let a = 0; a < 3; a++) normals[i + a] = fallback[i + a];
      length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    }
    for (let a = 0; a < 3; a++) normals[i + a] /= length;
  }
  return new Geometry(positions, normals, packed);
}
self.onmessage = async (event: MessageEvent) => {
  try {
    const { buffer, format, smoothing, maxParts, occtURL, wasmURL } = event.data as {
      buffer: ArrayBuffer;
      format: string;
      smoothing: boolean;
      maxParts?: number;
      occtURL: string;
      wasmURL: string;
    };
    if (
      !(buffer instanceof ArrayBuffer) ||
      !buffer.byteLength ||
      buffer.byteLength > maxBytes ||
      !['stl', 'obj', 'step', 'iges'].includes(format)
    )
      throw new TypeError('Invalid CAD worker input');
    let last = -1;
    const progress = (percent: number) => {
      const value = Math.floor(percent);
      if (value > last) {
        last = value;
        self.postMessage({ progress: value });
      }
    };
    progress(0);
    let parts: Array<{ name: string; geometry: Geometry }>;
    if (format === 'stl' || format === 'obj') {
      parts = parseCADGeometry(buffer, format, (p) => progress(p * 50), maxParts);
      progress(50);
    } else {
      self.importScripts(occtURL);
      const occt = await self.occtimportjs!({
        locateFile: (file) => (file.endsWith('.wasm') ? wasmURL : new URL(file, self.location.href).href),
      });
      progress(10);
      const result =
        format === 'step'
          ? occt.ReadStepFile(new Uint8Array(buffer), { linearUnit: 'meter' })
          : occt.ReadIgesFile(new Uint8Array(buffer), { linearUnit: 'meter' });
      if (!result.success || !result.meshes.length) throw new Error('B-Rep import failed');
      checkCount('Too many CAD parts', result.meshes.length, countLimit('maxParts', maxParts), 'maxParts');
      let total = 0;
      parts = result.meshes.map((mesh) => {
        total += mesh.index.array.length;
        if (total > 3_000_000) throw new RangeError('CAD triangle limit');
        const normals = new Float32Array(mesh.attributes.position.array.length);
        for (let f = 0; f < mesh.index.array.length; f += 3) {
          const p = mesh.attributes.position.array,
            [a, b, c] = mesh.index.array.slice(f, f + 3).map((i) => i * 3),
            u = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]],
            v = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]],
            n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
            length = Math.hypot(...n);
          if (!length) throw new RangeError('Degenerate CAD triangle');
          for (const id of [a, b, c]) for (let axis = 0; axis < 3; axis++) normals[id + axis] = n[axis] / length;
        }
        return { name: mesh.name, geometry: new Geometry(mesh.attributes.position.array, normals, mesh.index.array) };
      });
      progress(50);
    }
    const seen = new Map<string, Array<{ data: Float32Array; index: number }>>();
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (smoothing) part.geometry = smooth(part.geometry, (p) => progress(50 + (49 * (i + p)) / parts.length));
      const g = part.geometry,
        data = fingerprint(g),
        key = `${data.length}:${hash(data)}`,
        bucket = seen.get(key) ?? [],
        match = bucket.find((entry) => entry.data.every((value, i) => value === data[i]));
      if (match) self.postMessage({ part: { name: part.name, reuse: match.index } });
      else {
        bucket.push({ data, index: i });
        seen.set(key, bucket);
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
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
