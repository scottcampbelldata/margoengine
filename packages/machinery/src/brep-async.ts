// STEP with Margo's own kernel in a pool of workers (workers/brep-runtime.js): every worker reads the file, the page hands
// out bodies largest first, and each body's parts join the scene the moment its mesh arrives.
import { Geometry, PbrMaterial, type Engine, type Mesh } from '@margoengine/core/extension';
import { checkCount, countLimit } from '../../shared/limits.js';
import type { CADModel, CADRefineOptions } from './cad.js';
import type { CADImportOptions } from './cad-async.js';

interface Structure {
  bodies: { name: string; faces: number; color: string | null }[];
  products: string[];
  matrices: Float64Array;
  instanceBodies: Int32Array;
  instanceProducts: Int32Array;
  warnings: string[];
}
interface BodyResult {
  body: number;
  failures: number;
  /** The chord deflection the mesh was made with, in meters. */
  deflection: number;
  error?: string;
  parts: { color: string | null; vertices: Float32Array; indices: Uint32Array; bounds: Float32Array }[];
}

/** Position, rotation (x, y, z, w) and scale of a column-major affine matrix with no shear. */
function decompose(m: Float64Array, at: number) {
  const c = (k: number) => [m[at + k * 4], m[at + k * 4 + 1], m[at + k * 4 + 2]],
    [c0, c1, c2] = [c(0), c(1), c(2)],
    det =
      c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
      c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
      c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]),
    scale: [number, number, number] = [Math.hypot(...c0) * Math.sign(det || 1), Math.hypot(...c1), Math.hypot(...c2)],
    [r0, r1, r2] = [c0.map((v) => v / scale[0]), c1.map((v) => v / scale[1]), c2.map((v) => v / scale[2])],
    trace = r0[0] + r1[1] + r2[2];
  let q: number[];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(r1[2] - r2[1]) * s, (r2[0] - r0[2]) * s, (r0[1] - r1[0]) * s, 0.25 / s];
  } else if (r0[0] > r1[1] && r0[0] > r2[2]) {
    const s = 2 * Math.sqrt(1 + r0[0] - r1[1] - r2[2]);
    q = [0.25 * s, (r1[0] + r0[1]) / s, (r2[0] + r0[2]) / s, (r1[2] - r2[1]) / s];
  } else if (r1[1] > r2[2]) {
    const s = 2 * Math.sqrt(1 + r1[1] - r0[0] - r2[2]);
    q = [(r1[0] + r0[1]) / s, 0.25 * s, (r2[1] + r1[2]) / s, (r2[0] - r0[2]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + r2[2] - r0[0] - r1[1]);
    q = [(r2[0] + r0[2]) / s, (r2[1] + r1[2]) / s, 0.25 * s, (r0[1] - r1[0]) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return {
    position: [m[at + 12], m[at + 13], m[at + 14]] as [number, number, number],
    quaternion: q.map((v) => v / l),
    scale,
  };
}

/**
 * Reads a STEP file with `@margoengine/brep` in parallel workers (`options.workers`, default the device's logical
 * cores less one, at most 8, and no more copies of the file than fit in 1 GiB). A file under 2 MiB starts one worker,
 * then as many more as it has bodies left once that one has read the structure. Parts join `root` as their bodies
 * finish, largest bodies first; with `progressive` (default true) the root is visible from the first part.
 */
export function parseSTEPWithMargo(
  engine: Engine,
  buffer: ArrayBuffer,
  workerURL: URL,
  options: CADImportOptions,
  timeoutMs: number,
): Promise<CADModel> {
  const cores = Math.max(1, Math.min(8, ((globalThis.navigator?.hardwareConcurrency as number | undefined) ?? 4) - 1)),
    requested = options.workers ?? cores;
  if (!(Number.isInteger(requested) && requested >= 1 && requested <= 64))
    throw new RangeError('workers must be a whole number from 1 to 64');
  const count = Math.max(1, Math.min(requested, Math.floor(2 ** 30 / buffer.byteLength))),
    progressive = options.progressive ?? true,
    maxParts = countLimit('maxParts', options.maxParts);
  return new Promise((resolve, reject) => {
    const workers: Worker[] = [],
      created: Mesh[] = [],
      meshes: Mesh[] = [],
      materials = new Map<string, PbrMaterial>(),
      material = (color: string | null) => {
        const key = color ?? '#a6b9c8';
        let m = materials.get(key);
        if (!m) materials.set(key, (m = new PbrMaterial({ color: key, roughness: 0.4, metalness: 0.3 })));
        return m;
      };
    let structure: Structure | undefined,
      root: Mesh | undefined,
      queue: number[] = [],
      remaining = 0,
      settled = false,
      ended = false,
      failedFaces = 0,
      placedTriangles = 0;
    /** Instance indices of each body. */
    const placements = new Map<number, number[]>();
    /**
     * Each meshed body, for refining: its current deflection (meters), triangles, bounding sphere in its own frame, the
     * finest deflection a refinement could not reach, and its parts by colour group (every placement's).
     */
    const meshed = new Map<
      number,
      { deflection: number; triangles: number; center: number[]; radius: number; floor: number; groups: Mesh[][] }
    >();
    const timer = setTimeout(
      () => fail(new RangeError(`CAD import did not finish within ${timeoutMs} ms (raise the timeoutMs option)`)),
      timeoutMs,
    );
    const cleanup = (keep?: Worker) => {
        settled = true;
        clearTimeout(timer);
        for (const worker of workers) {
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          if (worker !== keep) worker.terminate();
        }
        options.signal?.removeEventListener('abort', abort);
      },
      dispose = () => {
        ended = true;
        for (const worker of workers) worker.terminate();
        for (let i = created.length - 1; i >= 0; i--) created[i].dispose();
      },
      fail = (error: unknown) => {
        if (settled) return;
        cleanup();
        dispose();
        reject(error);
      },
      abort = () => fail(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });

    const next = (worker: Worker) => {
      const body = queue.shift();
      if (body !== undefined) worker.postMessage({ body });
    };
    const finish = () => {
      if (!root || !meshes.length) throw new Error('CAD contains no geometry');
      root.visible = true;
      options.onProgress?.(100);
      // The primary worker read the whole file and stays for refining; the others end.
      const kept = options.refine ? workers[0] : undefined;
      cleanup(kept);
      resolve({ root, meshes, dispose, failedFaces, ...(kept ? { refine: refiner(kept) } : {}) });
    };
    /** Geometry from a worker's part: core's own constructor ran there, so the transferred buffers are adopted. */
    const adopt = (part: BodyResult['parts'][number]) =>
      Object.assign(Object.create(Geometry.prototype) as Geometry, {
        vertices: part.vertices,
        indices: part.indices,
        bounds: part.bounds,
      });
    const refiner = (worker: Worker) => {
      const initial = placedTriangles;
      let running: Promise<number> | undefined;
      return ({ pixels = 0.5, maxTriangles = Math.max(3 * initial, 5_000_000) }: CADRefineOptions = {}) => {
        if (!(typeof pixels === 'number' && pixels > 0 && pixels < Infinity))
          throw new RangeError('pixels must be a positive number of canvas pixels');
        if (!(typeof maxTriangles === 'number' && maxTriangles > 0))
          throw new RangeError('maxTriangles must be a positive number');
        if (ended || engine.disposed) return Promise.reject(new Error('The CAD model or its engine is disposed'));
        running ??= new Promise<number>((done, refused) => {
          const s = structure!,
            camera = engine.camera,
            eye = camera.position,
            ahead = [0, 1, 2].map((k) => camera.target[k] - eye[k]),
            length = Math.hypot(ahead[0], ahead[1], ahead[2]) || 1,
            // Meters per canvas pixel at one meter from the eye.
            perPixel = (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, engine.canvas.height),
            jobs: { body: number; deflection: number; gain: number; extra: number }[] = [];
          for (const [body, state] of meshed) {
            // The nearest placement in front of the eye decides how fine the body must be.
            let near = Infinity;
            for (const i of placements.get(body) ?? []) {
              const m = s.matrices,
                o = i * 16,
                [x, y, z] = state.center,
                c = [0, 1, 2].map((k) => m[o + k] * x + m[o + 4 + k] * y + m[o + 8 + k] * z + m[o + 12 + k]),
                scale = Math.max(
                  Math.hypot(m[o], m[o + 1], m[o + 2]),
                  Math.hypot(m[o + 4], m[o + 5], m[o + 6]),
                  Math.hypot(m[o + 8], m[o + 9], m[o + 10]),
                ),
                r = state.radius * scale,
                d = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]];
              if ((d[0] * ahead[0] + d[1] * ahead[1] + d[2] * ahead[2]) / length < -r) continue;
              near = Math.min(near, Math.max(camera.near, Math.hypot(d[0], d[1], d[2]) - r));
            }
            if (near === Infinity) continue;
            const want = Math.max(pixels * near * perPixel, state.radius * 1e-5);
            if (want < 0.7 * state.deflection && want < state.floor)
              jobs.push({
                body,
                deflection: want,
                gain: state.deflection / want,
                // Triangles grow about as the inverse of the deflection on curved faces (fewer on flat ones).
                extra: state.triangles * (state.deflection / want - 1) * (placements.get(body)?.length ?? 1),
              });
          }
          jobs.sort((a, b) => b.gain - a.gain);
          let total = placedTriangles,
            count = 0;
          const work = jobs.filter((job) => {
            if (total + job.extra > maxTriangles) return false;
            total += job.extra;
            return true;
          });
          const step = () => {
            const job = work.shift();
            if (!job || ended) {
              running = undefined;
              done(count);
            } else worker.postMessage({ body: job.body, deflection: job.deflection });
          };
          worker.onerror = (event) => {
            event.preventDefault?.();
            running = undefined;
            refused(new Error(`CAD worker failed: ${event.message || 'unknown error'}`));
          };
          worker.onmessage = (event) => {
            const result = event.data as BodyResult & { fatal?: string };
            if (ended) return;
            if (result.fatal) {
              running = undefined;
              refused(new Error(result.fatal));
              return;
            }
            const state = meshed.get(result.body);
            if (state && !result.error && result.parts.length === state.groups.length) {
              const instances = placements.get(result.body)?.length ?? 1;
              let triangles = 0;
              result.parts.forEach((part, g) => {
                const geometry = adopt(part);
                triangles += geometry.indices.length / 3;
                for (const mesh of state.groups[g]) mesh.setGeometry(geometry);
              });
              placedTriangles += (triangles - state.triangles) * instances;
              Object.assign(state, { deflection: result.deflection, triangles });
              count++;
              // A body that failed to re-mesh, or came back in other groups (a colour group over the vertex limit),
              // keeps the mesh it has.
            } else if (state) state.floor = 0;
            step();
          };
          step();
        });
        return running;
      };
    };

    const start = (s: Structure) => {
      structure = s;
      for (let i = 0; i < s.instanceBodies.length; i++) {
        const b = s.instanceBodies[i];
        placements.set(b, [...(placements.get(b) ?? []), i]);
      }
      // Largest first, so the slowest bodies do not start last; bodies nothing places are not meshed.
      queue = [...placements.keys()].sort((a, b) => s.bodies[b].faces - s.bodies[a].faces);
      remaining = queue.length;
      root = engine.createMesh();
      root.visible = progressive;
      created.push(root);
      if (!remaining) finish();
    };
    const add = (result: BodyResult) => {
      failedFaces += result.failures;
      const s = structure!,
        geometries = result.parts.map((part) => ({ color: part.color, geometry: adopt(part) })),
        groups: Mesh[][] = geometries.map(() => []);
      // The body's bounding sphere in its own frame: around the first group's centre, holding every group's sphere.
      if (geometries.length) {
        const [first] = geometries,
          center = [...first.geometry.bounds.subarray(0, 3)],
          radius = Math.max(
            ...geometries.map(
              ({ geometry: g }) =>
                Math.hypot(g.bounds[0] - center[0], g.bounds[1] - center[1], g.bounds[2] - center[2]) + g.bounds[3],
            ),
          ),
          triangles = geometries.reduce((sum, { geometry: g }) => sum + g.indices.length / 3, 0);
        meshed.set(result.body, { deflection: result.deflection, triangles, center, radius, floor: Infinity, groups });
        placedTriangles += triangles * (placements.get(result.body)?.length ?? 0);
      }
      for (const instance of placements.get(result.body) ?? []) {
        const product = s.instanceProducts[instance],
          name = (product >= 0 ? s.products[product] : '') || s.bodies[result.body].name || `body ${result.body}`,
          { position, quaternion, scale } = decompose(s.matrices, instance * 16);
        for (const [g, { color, geometry }] of geometries.entries()) {
          checkCount('Too many CAD parts', meshes.length + 1, maxParts, 'maxParts');
          const mesh = engine.createMesh(root);
          created.push(mesh);
          mesh.name = name;
          meshes.push(
            mesh
              .setGeometry(geometry)
              .setMaterial(material(color))
              .setPosition(position)
              .setQuaternion(quaternion)
              .setScale(scale),
          );
          groups[g].push(mesh);
          options.onPart?.(mesh);
        }
      }
      remaining--;
      options.onProgress?.(Math.floor(99 * (1 - remaining / Math.max(1, placements.size))));
    };

    const waiting: Worker[] = [];
    /** Starts a worker on its own copy of the file. */
    const spawn = (primary: boolean) => {
      const worker = new Worker(workerURL),
        data = buffer.slice(0);
      workers.push(worker);
      // A worker that died (out of memory, an uncaught error) is reported by name; the next load starts new ones.
      worker.onerror = (event) => {
        event.preventDefault?.();
        fail(new Error(`CAD worker failed: ${event.message || 'unknown error'}`));
      };
      worker.onmessageerror = () => fail(new Error('CAD worker message failed'));
      worker.onmessage = (event) => {
        if (settled) return;
        const message = event.data;
        try {
          options.signal?.throwIfAborted();
          if (engine.disposed) throw new Error('Engine is disposed');
          if (!message || typeof message !== 'object') throw new TypeError('Invalid CAD worker message');
          if (message.fatal)
            throw new (message.kind === 'RangeError' ? RangeError : message.kind === 'TypeError' ? TypeError : Error)(
              message.fatal,
            );
          if (message.structure) {
            start(message.structure as Structure);
            if (settled) return;
            // A small file starts its other workers only now, and only as many as there are bodies left for them.
            if (!early) for (let i = Math.min(count, queue.length) - 1; i > 0; i--) spawn(false);
          } else if (typeof message.body === 'number') {
            add(message as BodyResult);
            if (!remaining) {
              finish();
              return;
            }
          }
          // The primary worker starts once it has sent the structure; the others when they have read the file. A
          // worker that is ready before the structure arrives waits for it.
          if (structure) {
            next(worker);
            if (message.structure) for (const w of waiting.splice(0)) next(w);
          } else waiting.push(worker);
        } catch (error) {
          fail(error);
        }
      };
      worker.postMessage(
        { buffer: data, primary, deflection: options.linearDeflection, smoothing: options.smoothing ?? true },
        [data],
      );
    };
    // A large file (likely an assembly of many bodies) starts every worker at once, so they read it in parallel.
    const early = buffer.byteLength >= 2 ** 21;
    try {
      spawn(true);
      if (early) for (let i = 1; i < count; i++) spawn(false);
    } catch (error) {
      fail(error);
    }
  });
}
