// STEP with Margo's own kernel (@margoengine/brep), one worker of a pool: each worker reads the whole file, then meshes
// the bodies the page hands it one at a time, so the bodies of an assembly mesh in parallel and each part can be shown
// as soon as it is ready. The primary worker also sends the file's structure (bodies, placements, products).
import { parseSAT, parseSTEP, Tessellator, type BodyMesh, type STEPModel } from '@margoengine/brep';
import { Geometry } from '@margoengine/core';
declare const self: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

/** Largest vertex count of one core geometry; a body's colour group above it is split at face boundaries. */
const maxVertices = 1_000_000;

let model: STEPModel | undefined,
  tessellator: Tessellator | undefined,
  smoothing = true;

/** sRGB display colour (0..1) as '#rrggbb'. */
const hex = (c: readonly number[]) =>
  `#${[0, 1, 2]
    .map((k) =>
      Math.round(Math.min(1, Math.max(0, c[k])) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/**
 * A body's triangles as core geometries in metres, one per colour (a face's own colour, else the body's): vertices
 * renumbered per group, with the kernel's exact surface normals, or one flat normal per triangle without smoothing.
 */
function groups(mesh: BodyMesh, bodyColor: string | null) {
  const runs = new Map<string, { first: number; count: number }[]>();
  for (const face of mesh.faces) {
    const key = face.color ? hex(face.color) : (bodyColor ?? '');
    runs.set(key, [...(runs.get(key) ?? []), { first: face.first, count: face.count }]);
  }
  const out: { color: string | null; geometry: Geometry }[] = [],
    p = mesh.positions,
    n = mesh.normals,
    t = mesh.indices,
    u = mesh.unit,
    slot = new Int32Array(p.length / 3).fill(-1);
  for (const [key, list] of runs) {
    let positions: number[] = [],
      normals: number[] = [],
      indices: number[] = [],
      used: number[] = [];
    const flush = () => {
      for (const v of used) slot[v] = -1;
      if (indices.length && positions.length >= 9)
        out.push({ color: key || null, geometry: new Geometry(positions, normals, indices) });
      positions = [];
      normals = [];
      indices = [];
      used = [];
    };
    for (const { first, count } of list) {
      // A face never spans two geometries: the group is cut before a face that would pass the vertex limit.
      if (positions.length / 3 + count > maxVertices) flush();
      for (let i = first; i < first + count; i += 3) {
        if (!smoothing) {
          const [a, b, c] = [t[i] * 3, t[i + 1] * 3, t[i + 2] * 3],
            ux = p[b] - p[a],
            uy = p[b + 1] - p[a + 1],
            uz = p[b + 2] - p[a + 2],
            vx = p[c] - p[a],
            vy = p[c + 1] - p[a + 1],
            vz = p[c + 2] - p[a + 2],
            nx = uy * vz - uz * vy,
            ny = uz * vx - ux * vz,
            nz = ux * vy - uy * vx,
            l = Math.hypot(nx, ny, nz) || 1;
          for (const v of [a, b, c]) {
            indices.push(positions.length / 3);
            positions.push(p[v] * u, p[v + 1] * u, p[v + 2] * u);
            normals.push(nx / l, ny / l, nz / l);
          }
          continue;
        }
        for (let k = 0; k < 3; k++) {
          const v = t[i + k];
          if (slot[v] < 0) {
            slot[v] = positions.length / 3;
            used.push(v);
            positions.push(p[v * 3] * u, p[v * 3 + 1] * u, p[v * 3 + 2] * u);
            normals.push(n[v * 3], n[v * 3 + 1], n[v * 3 + 2]);
          }
          indices.push(slot[v]);
        }
      }
    }
    flush();
  }
  return out;
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data as
    | { buffer: ArrayBuffer; primary: boolean; format?: 'step' | 'sat'; deflection?: number; smoothing?: boolean }
    | { body: number; deflection?: number };
  try {
    if ('buffer' in message) {
      if (!(message.buffer instanceof ArrayBuffer) || !message.buffer.byteLength)
        throw new TypeError('Invalid CAD worker input');
      smoothing = message.smoothing !== false;
      // ACIS SAT goes through the kernel's SAT-to-STEP conversion.
      model = message.format === 'sat' ? parseSAT(message.buffer) : parseSTEP(message.buffer);
      tessellator = new Tessellator(
        model.file,
        model.faceColors,
        message.deflection === undefined ? {} : { deflection: message.deflection },
      );
      if (!message.primary) {
        self.postMessage({ ready: true });
        return;
      }
      // Placements packed as typed arrays: an assembly may place hundreds of thousands of bodies.
      const count = model.instances.length,
        matrices = new Float64Array(count * 16),
        bodies = new Int32Array(count),
        products = new Int32Array(count);
      model.instances.forEach((instance, i) => {
        matrices.set(instance.matrix, i * 16);
        bodies[i] = instance.body;
        products[i] = instance.product;
      });
      self.postMessage(
        {
          structure: {
            bodies: model.bodies.map((b) => ({
              name: b.name,
              faces: b.faces.length,
              color: b.color ? hex(b.color) : null,
            })),
            products: model.products.map((p) => p.name),
            matrices,
            instanceBodies: bodies,
            instanceProducts: products,
            warnings: model.warnings,
          },
        },
        [matrices.buffer, bodies.buffer, products.buffer],
      );
      return;
    }
    if (!model || !tessellator) throw new TypeError('CAD worker got a body before the file');
    const index = message.body,
      body = model.bodies[index];
    if (!body) throw new RangeError(`CAD worker got body ${index} of ${model.bodies.length}`);
    let parts: { color: string | null; geometry: Geometry }[] = [],
      failures = 0,
      deflection = 0,
      error: string | undefined;
    try {
      // A refinement asks for its own deflection (meters): a fresh tessellator, so the body's edges are sampled anew.
      const mesh = (
        message.deflection === undefined
          ? tessellator
          : new Tessellator(model.file, model.faceColors, { deflection: message.deflection })
      ).body(body);
      failures = mesh.failures.length;
      deflection = mesh.deflection * mesh.unit;
      parts = groups(mesh, body.color ? hex(body.color) : null);
    } catch (e) {
      // One body the kernel cannot mesh (a face over the vertex cap, a malformed entity) leaves the others standing.
      error = e instanceof Error ? e.message : String(e);
      failures = Math.max(1, body.faces.length);
    }
    self.postMessage(
      {
        body: index,
        failures,
        deflection,
        ...(error ? { error } : {}),
        parts: parts.map(({ color, geometry: g }) => ({
          color,
          vertices: g.vertices,
          indices: g.indices,
          bounds: g.bounds,
        })),
      },
      parts.flatMap(({ geometry: g }) => [g.vertices.buffer, g.indices.buffer, g.bounds.buffer]) as ArrayBuffer[],
    );
  } catch (error) {
    // A file the kernel cannot read: the class travels with the message, as from the OpenCascade worker.
    self.postMessage({ fatal: error instanceof Error ? error.message : String(error), kind: (error as Error)?.name });
  }
};
