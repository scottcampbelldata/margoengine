import { LoaderError, type LoadedGeometry, type ParseLimits } from './types.js';
import { computeVertexNormals } from './normals.js';
import { latin1, limits, TextScanner, throwIfAborted, toBytes, type BinaryInput, type Limits } from './util.js';

const F = 'STL';
/** How many triangles are read between two checks of the abort signal (a power of two). */
const ABORT_STEP = 16384;

/** Options of parseSTL: the shared size limits (ParseLimits), welding and an abort signal. */
export interface STLOptions extends ParseLimits {
  /**
   * `false` (default) keeps every triangle's three corners as written, like the file: three vertices per triangle,
   * one flat normal per triangle repeated on its corners, and `indices` counting 0, 1, 2, ... `true` merges corners
   * with identical positions (and identical facet colors) into one vertex, which cuts the vertex count to about a
   * sixth for a closed surface and replaces the flat normals with smooth, area-weighted ones.
   */
  weld?: boolean;
  /** Aborts the parse; it then throws a `LoaderError` with code `'aborted'`. Checked every 16,384 triangles. */
  signal?: AbortSignal;
}

/** Writes the flat normal of the triangle at `positions[at..at+8]` onto its three corners, (0, 0, 1) if degenerate. */
function flatNormal(positions: Float32Array, normals: Float32Array, at: number): void {
  const ux = positions[at + 3] - positions[at],
    uy = positions[at + 4] - positions[at + 1],
    uz = positions[at + 5] - positions[at + 2];
  const vx = positions[at + 6] - positions[at],
    vy = positions[at + 7] - positions[at + 1],
    vz = positions[at + 8] - positions[at + 2];
  let nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length > 0 && length < Infinity) {
    const scale = 1 / length;
    nx *= scale;
    ny *= scale;
    nz *= scale;
  } else {
    nx = 0;
    ny = 0;
    nz = 1;
  }
  normals[at] = normals[at + 3] = normals[at + 6] = nx;
  normals[at + 1] = normals[at + 4] = normals[at + 7] = ny;
  normals[at + 2] = normals[at + 5] = normals[at + 8] = nz;
}

/** True when a facet normal read from the file is usable: finite and not (0, 0, 0). */
const usable = (x: number, y: number, z: number): boolean =>
  Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && (x !== 0 || y !== 0 || z !== 0);

/** Stores the stored facet normal on the triangle's corners, or computes the flat one when it is unusable. */
function setNormal(
  positions: Float32Array,
  normals: Float32Array,
  at: number,
  nx: number,
  ny: number,
  nz: number,
): void {
  if (!usable(nx, ny, nz)) return flatNormal(positions, normals, at);
  for (let c = 0; c < 9; c += 3) {
    normals[at + c] = nx;
    normals[at + c + 1] = ny;
    normals[at + c + 2] = nz;
  }
}

function parseBinary(bytes: Uint8Array, count: number, options: STLOptions): LoadedGeometry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = new Float32Array(count * 9),
    normals = new Float32Array(count * 9);
  let colors: Float32Array | undefined;
  for (let t = 0, offset = 84; t < count; t++, offset += 50) {
    if ((t & (ABORT_STEP - 1)) === 0) throwIfAborted(options.signal, F);
    const at = t * 9;
    for (let i = 0; i < 9; i++) positions[at + i] = view.getFloat32(offset + 12 + i * 4, true);
    setNormal(
      positions,
      normals,
      at,
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true),
    );
    // VisCAM / SolidView color extension: bit 15 set means a color follows; red bits 10-14, green 5-9, blue 0-4.
    const attribute = view.getUint16(offset + 48, true);
    if (attribute & 0x8000) {
      colors ??= new Float32Array(count * 9).fill(0.8);
      const r = ((attribute >> 10) & 31) / 31,
        g = ((attribute >> 5) & 31) / 31,
        b = (attribute & 31) / 31;
      for (let c = 0; c < 9; c += 3) {
        colors[at + c] = r;
        colors[at + c + 1] = g;
        colors[at + c + 2] = b;
      }
    }
  }
  return finish(positions, normals, colors, options);
}

function parseASCII(bytes: Uint8Array, options: STLOptions, limit: Limits): LoadedGeometry {
  const scanner = new TextScanner(latin1(bytes), F);
  let capacity = Math.max(16, Math.min(limit.maxTriangles, Math.ceil(bytes.length / 250)));
  let positions = new Float32Array(capacity * 9),
    normals = new Float32Array(capacity * 9);
  let facets = 0,
    corners = 0,
    inFacet = false,
    nx = 0,
    ny = 0,
    nz = 0;
  const grow = (): void => {
    capacity *= 2;
    const p = new Float32Array(capacity * 9),
      n = new Float32Array(capacity * 9);
    p.set(positions);
    n.set(normals);
    positions = p;
    normals = n;
  };
  for (let word = scanner.token(); word !== null; word = scanner.token()) {
    const key = word.toLowerCase();
    if (key === 'facet') {
      if (inFacet) throw new LoaderError(F, 'syntax', `facet ${facets + 1} is not closed with "endfacet"`);
      if (facets >= limit.maxTriangles || facets * 3 >= limit.maxVertices)
        throw new LoaderError(
          F,
          'limit',
          `the file has more than ${limit.maxTriangles} triangles or ${limit.maxVertices} vertices; pass a larger maxTriangles and maxVertices`,
        );
      if (facets === capacity) grow();
      if ((facets & (ABORT_STEP - 1)) === 0) throwIfAborted(options.signal, F);
      const what = `the normal of facet ${facets + 1}`;
      if (scanner.token()?.toLowerCase() !== 'normal')
        throw new LoaderError(F, 'syntax', `facet ${facets + 1} must read "facet normal nx ny nz"`);
      nx = scanner.number(what);
      ny = scanner.number(what);
      nz = scanner.number(what);
      inFacet = true;
      corners = 0;
    } else if (key === 'vertex') {
      if (!inFacet || corners === 3)
        throw new LoaderError(F, 'syntax', `facet ${facets + 1} has a "vertex" where none belongs (a triangle has 3)`);
      const at = facets * 9 + corners * 3,
        what = `a vertex of facet ${facets + 1}`;
      positions[at] = scanner.number(what);
      positions[at + 1] = scanner.number(what);
      positions[at + 2] = scanner.number(what);
      corners++;
    } else if (key === 'endfacet') {
      if (!inFacet || corners !== 3)
        throw new LoaderError(F, 'syntax', `facet ${facets + 1} has ${corners} vertices, expected 3`);
      setNormal(positions, normals, facets * 9, nx, ny, nz);
      facets++;
      inFacet = false;
    } else if (key === 'solid' || key === 'endsolid') {
      scanner.line(); // the solid's name is the rest of the line and may hold anything
    }
  }
  if (inFacet) throw new LoaderError(F, 'truncated', `the file ends inside facet ${facets + 1}`);
  if (!facets) throw new LoaderError(F, 'syntax', 'the ASCII file has no "facet normal" blocks');
  return finish(positions.slice(0, facets * 9), normals.slice(0, facets * 9), undefined, options);
}

/** Builds the result: identity indices, or a position (and color) weld with smooth normals. */
function finish(
  positions: Float32Array,
  normals: Float32Array,
  colors: Float32Array | undefined,
  options: STLOptions,
): LoadedGeometry {
  const corners = positions.length / 3;
  if (!options.weld) {
    const indices = new Uint32Array(corners);
    for (let i = 0; i < corners; i++) indices[i] = i;
    const result: LoadedGeometry = { kind: 'mesh', positions, normals, indices };
    if (colors) result.colors = colors;
    return result;
  }
  for (let i = 0; i < positions.length; i++) positions[i] += 0; // -0 becomes +0, so equal positions have equal bits
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length),
    colorBits = colors && new Uint32Array(colors.buffer, colors.byteOffset, colors.length);
  let size = 16;
  while (size < corners * 2) size *= 2;
  const mask = size - 1,
    table = new Int32Array(size).fill(-1),
    indices = new Uint32Array(corners),
    first = new Uint32Array(corners); // the source corner of each welded vertex
  let count = 0;
  for (let corner = 0; corner < corners; corner++) {
    if ((corner & (ABORT_STEP * 4 - 1)) === 0) throwIfAborted(options.signal, F);
    const i = corner * 3;
    let h = Math.imul(bits[i], 0x9e3779b1) ^ Math.imul(bits[i + 1], 0x85ebca6b) ^ Math.imul(bits[i + 2], 0xc2b2ae35);
    if (colorBits) h ^= Math.imul(colorBits[i] ^ (colorBits[i + 1] << 7) ^ (colorBits[i + 2] << 13), 0x27d4eb2f);
    h ^= h >>> 15;
    let slot = h & mask,
      found = -1;
    for (let v = table[slot]; v !== -1; v = table[slot]) {
      const j = first[v] * 3;
      if (
        bits[j] === bits[i] &&
        bits[j + 1] === bits[i + 1] &&
        bits[j + 2] === bits[i + 2] &&
        (!colorBits ||
          (colorBits[j] === colorBits[i] &&
            colorBits[j + 1] === colorBits[i + 1] &&
            colorBits[j + 2] === colorBits[i + 2]))
      ) {
        found = v;
        break;
      }
      slot = (slot + 1) & mask;
    }
    if (found < 0) {
      found = count;
      first[count++] = corner;
      table[slot] = found;
    }
    indices[corner] = found;
  }
  const welded = new Float32Array(count * 3),
    weldedColors = colors && new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const i = first[v] * 3;
    for (let a = 0; a < 3; a++) {
      welded[v * 3 + a] = positions[i + a];
      if (weldedColors && colors) weldedColors[v * 3 + a] = colors[i + a];
    }
  }
  const result: LoadedGeometry = {
    kind: 'mesh',
    positions: welded,
    normals: computeVertexNormals(welded, indices),
    indices,
  };
  if (weldedColors) result.colors = weldedColors;
  return result;
}

/**
 * Parses a binary or ASCII STL file into plain typed arrays, the way a basic STL loader does: no GPU objects, no
 * parts, no normal smoothing. The flavor is detected from the data: a file whose length is exactly
 * `84 + 50 * triangles` is binary even when it starts with `solid`; otherwise text starting with `solid` and holding
 * facets is ASCII.
 *
 * - `positions`: three vertices per triangle, in file order (Float32).
 * - `normals`: the facet normal from the file repeated on the triangle's corners; a facet whose stored normal is zero
 *   or not finite (many writers leave it zero) gets the flat normal computed from its corners.
 * - `colors`: only for binary files using the VisCAM / SolidView color extension (bit 15 of the 16-bit attribute
 *   set), as sRGB 0 to 1; facets without a color get 0.8 gray. ASCII files and uncolored binary files have none.
 * - `indices`: 0, 1, 2, ... (or the weld's indices with `weld: true`).
 *
 * Use `parseCAD` from `@margoengine/machinery/cad` instead when you need welded parts for CAD sections, edges or
 * part deduplication.
 *
 * @throws LoaderError with code `'header'` (too short to be STL), `'truncated'` (binary data shorter than its
 * triangle count, or an ASCII file cut inside a facet), `'syntax'` (a malformed ASCII facet or number), `'limit'`
 * (past `maxTriangles` or `maxVertices`; raise them) or `'aborted'` (the `signal` fired); `'range'` for a bad limit.
 * @example
 * const mesh = parseSTL(await (await fetch('/part.stl')).arrayBuffer());
 * mesh.positions.length / 9; // triangles
 */
export function parseSTL(input: BinaryInput, options: STLOptions = {}): LoadedGeometry {
  const bytes = toBytes(input, F),
    limit = limits(options, F);
  throwIfAborted(options.signal, F);
  if (bytes.length < 15)
    throw new LoaderError(
      F,
      'header',
      `${bytes.length} bytes is too short for an STL file; pass the whole file (a binary header alone is 84 bytes)`,
    );
  const declared =
    bytes.length >= 84 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true) : -1;
  const exactBinary = declared >= 0 && bytes.length === 84 + 50 * declared;
  if (!exactBinary) {
    const head = latin1(bytes, 0, Math.min(bytes.length, 1024));
    if (/^\s*solid/i.test(head) && /facet|endsolid/i.test(head)) return parseASCII(bytes, options, limit);
    if (declared < 0)
      throw new LoaderError(
        F,
        'header',
        'the data is neither ASCII STL (it must start with "solid" and hold "facet" blocks) nor a binary file with its 84-byte header',
      );
    if (bytes.length < 84 + 50 * declared)
      throw new LoaderError(
        F,
        'truncated',
        `the header declares ${declared} triangles (${84 + 50 * declared} bytes) but the data has ${bytes.length}; pass the whole file`,
      );
  }
  // Longer than declared: the extra bytes are ignored.
  if (declared > limit.maxTriangles)
    throw new LoaderError(
      F,
      'limit',
      `triangle count ${declared} exceeds the limit of ${limit.maxTriangles}; pass a larger maxTriangles`,
    );
  if (declared * 3 > limit.maxVertices)
    throw new LoaderError(
      F,
      'limit',
      `vertex count ${declared * 3} exceeds the limit of ${limit.maxVertices}; pass a larger maxVertices (it applies before welding)`,
    );
  return parseBinary(bytes, declared, options);
}
