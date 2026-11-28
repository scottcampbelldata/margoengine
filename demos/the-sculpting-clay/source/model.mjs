const tau = 2 * Math.PI;

export const clayCenter = 1.365;
export const clayRadius = 1.035;

function underlying(x, y, z) {
  return 1 + .026 * Math.sin(2.6 * x + 2.1 * z - .5) * Math.cos(2.8 * y)
    + .019 * (z * z - x * y) - .021 * Math.sin(3.4 * y + 1.1 * x);
}

function worked(x, y, z) {
  const rake = 10.0 * (x + .51 * y - .27 * z) + 2.6 * y * y - 1.7 * Math.sin(2.2 * z);
  const body = .61 + .20 * z + .15 * Math.cos(4 * y - 2 * x);
  const sideFolds = .032 * body * Math.sin(rake) + .009 * Math.sin(2 * rake + 1.5);
  const x0 = x + .13 + .15 * y * y;
  const y0 = .85 * (y - .23);
  const center = Math.hypot(x0,y0);
  const spiral = 16.2 * center + Math.atan2(y0,x0) + 2.7 * x0 * y0;
  const envelope = Math.min(1, center * 6) * Math.pow(Math.max(0,z),1.6);
  const relief = .086 * Math.pow(.5 + .5 * Math.cos(spiral),2)
    - .044 * Math.pow(.5 + .5 * Math.cos(spiral + 2.2),5);
  const incisions = .007 * Math.pow(.5 + .5 * Math.sin(6.7 * rake + 8.1 * y * z),5);
  return sideFolds * (1 - .72 * envelope) + relief * envelope - incisions
    + .004 * Math.sin(21*x + 13*y) * Math.sin(24*z - 3*x);
}

function point(u, v, detailed) {
  const longitude = tau * u;
  const latitude = Math.PI * v;
  const x = Math.cos(longitude) * Math.sin(latitude);
  const y = Math.cos(latitude);
  const z = Math.sin(longitude) * Math.sin(latitude);
  const radius = clayRadius * (underlying(x, y, z) + (detailed ? worked(x, y, z) : 0));
  return [x * radius, clayCenter + y * radius, z * radius];
}

/** Shared sphere topology for the sculpt, cut only by corner UVs. */
export function createClay(columns, rows, detailed = false) {
  const vertices = [point(0, 0, detailed)];
  for (let j = 1; j < rows; j++) {
    for (let i = 0; i < columns; i++) vertices.push(point(i / columns, j / rows, detailed));
  }
  const south = vertices.length;
  vertices.push(point(0, 1, detailed));
  const vertex = (i, j) => j === 0 ? 0 : j === rows ? south : 1 + (j - 1) * columns + i % columns;
  const faces = [];
  const add = (coordinates, corners) => faces.push({
    id: String(faces.length),
    vertices: coordinates.map(([i, j]) => vertex(i, j)),
    uv: corners.map(([i, j]) => [i / columns, j / rows]),
  });
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const a = [i, j], b = [i + 1, j], c = [i + 1, j + 1], d = [i, j + 1];
      if (j > 0) add([a, b, c], [a, b, j === rows - 1 ? [i + .5, rows] : c]);
      if (j < rows - 1) add([a, c, d], [j === 0 ? [i + .5, 0] : a, c, d]);
    }
  }
  return {vertices, faces};
}

export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const unit = a => {
  const length = Math.hypot(...a);
  return length > 0 ? a.map(x => x / length) : [0, 1, 0];
};

/** Bake inputs and the matching visible low mesh, with the same explicit frame. */
export function lowSurface(mesh) {
  const shared = mesh.vertices.map(() => [0, 0, 0]);
  for (const face of mesh.faces) {
    const [a, b, c] = face.vertices.map(index => mesh.vertices[index]);
    const n = cross(subtract(b, a), subtract(c, a));
    for (const index of face.vertices) for (let k = 0; k < 3; k++) shared[index][k] += n[k];
  }
  const surface = {positions: [], normals: [], tangents: [], uvs: [], indices: []};
  const remap = new Map();
  for (const face of mesh.faces) {
    face.vertices.forEach((vertex, corner) => {
      const [u, v] = face.uv[corner];
      const key = vertex + '/' + u + '/' + v;
      if (!remap.has(key)) {
        remap.set(key, surface.positions.length / 3);
        surface.positions.push(...mesh.vertices[vertex]);
        surface.normals.push(...unit(shared[vertex]));
        surface.tangents.push(-Math.sin(tau * u), 0, Math.cos(tau * u), -1);
        surface.uvs.push(u, v);
      }
      surface.indices.push(remap.get(key));
    });
  }
  return surface;
}

export const highResolution = [80, 40];
export const lowResolution = [28, 15];
export const mapWidth = 256;
export const mapHeight = 128;
