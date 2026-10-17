// One CAD load measured in a real browser; scripts/cad-scale-tests.js drives it. It reports load to first frame, orbit
// frame times, pick latency, frame times with a capped section plane, draws, JS heap, and exact part and triangle
// counts. Every time is this page's own clock around a frame that ends at GPU completion (queue.onSubmittedWorkDone).
// Orbit and section frames also report `encode`: the time engine.render() itself takes (culling and command encoding
// on this thread). The rest of a frame is the browser's GPU process and the GPU; a frame that is mostly encode is
// limited by per-part CPU work, not by triangles.
// Query: url (file under the dev server), format (obj, stl, step, iges, glb, gltf), frames (orbit frames, default 120),
// smoothing ('false' for flat CAD normals), kernel ('margo' reads STEP with our own kernel, @margoengine/brep, on this
// thread, instead of OpenCascade in a worker) and, for generated assemblies, the known bounds (minx..maxz).
import { Engine, Geometry, PbrMaterial, type Mesh } from '../packages/core/dist/extension.js';
import { parseSTEP, tessellateSTEP } from '../packages/brep/dist/index.js';
import { parseCADAsync, PartInstancer, SectionPlanes } from '../packages/machinery/dist/index.js';
import { loadGLTF } from '../packages/gltf-pro/dist/index.js';
import { instancing } from '../packages/gltf-pro/dist/instancing.js';
import { getSceneBounds } from '../packages/gltf-pro/dist/scene.js';
import { Picking } from '../packages/selection/dist/index.js';

type Roots = Parameters<typeof getSceneBounds>[1];
/** A view for scripts/cad-inspect.mjs: angles in degrees, `zoom` scales the framing distance, `focus` is a point inside
 * the model's bounds (0 to 1 per axis), `cut` adds the section ('upper' keeps the upper half, 'lower' the lower). */
type CloseView = {
  azimuth?: number;
  elevation?: number;
  zoom?: number;
  focus?: number[];
  cut?: 'upper' | 'lower';
};
declare global {
  interface Window {
    cadScale?: unknown;
    cadScaleShot?: (shot: 'whole' | 'section' | 'cap') => Promise<void>;
    cadScaleView?: (view: CloseView) => Promise<void>;
  }
}

const query = new URLSearchParams(location.search),
  url = query.get('url') ?? '',
  format = (query.get('format') ?? '').toLowerCase(),
  frames = Math.max(10, Number(query.get('frames') ?? 120)),
  smoothing = query.get('smoothing') !== 'false',
  kernel = query.get('kernel') === 'margo' ? 'margo' : 'occt',
  known = ['minx', 'miny', 'minz', 'maxx', 'maxy', 'maxz'].map((k) =>
    query.has(k) ? Number(query.get(k)) : Number.NaN,
  ),
  errors: string[] = [];
let stage = 'start';
addEventListener('error', (event) => errors.push(String(event.message)));
addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));

/** Position, rotation quaternion [x, y, z, w] and scale of a column-major placement matrix. */
function decompose(m: ArrayLike<number>) {
  const column = (c: number) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]],
    [c0, c1, c2] = [column(0), column(1), column(2)],
    det =
      c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
      c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
      c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]),
    scale = [Math.hypot(...c0) * Math.sign(det || 1), Math.hypot(...c1), Math.hypot(...c2)],
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
  return {
    position: [m[12], m[13], m[14]] as [number, number, number],
    quaternion: q,
    scale: scale as [number, number, number],
  };
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b),
    at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    count: sorted.length,
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
  };
}

async function run() {
  const canvas = document.querySelector('canvas')!;
  stage = 'engine';
  const engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 0, 10], target: [0, 0, 0], near: 0.1, far: 1000 },
    }),
    device = engine.gpu!;
  engine.stop();
  engine.onError = (error) => errors.push(String(error));
  device.addEventListener('uncapturederror', (event) => errors.push((event as GPUUncapturedErrorEvent).error.message));
  let encodeMs = 0;
  const frame = async () => {
    const start = performance.now();
    engine.render();
    encodeMs = performance.now() - start;
    await device.queue.onSubmittedWorkDone();
    return performance.now() - start;
  };

  const start = performance.now();
  let parts = 0,
    triangles = 0,
    roots: Roots = [],
    fetchMs = 0,
    instancer: PartInstancer | undefined,
    failedFaces = 0,
    widen = (_bounds: number[]) => {};
  stage = 'load';
  if (format === 'glb' || format === 'gltf') {
    const model = await loadGLTF(engine, url, {
      decoders: { instancing },
      maxDownloadBytes: 2 ** 30,
      maxNodes: 1_000_000,
    });
    // A part is a node that draws; an EXT_mesh_gpu_instancing node is one part per instance.
    const copiesByNode = new Map<number, number>();
    for (const p of model.primitives) {
      const copies = p.instances?.capacity ?? 1;
      copiesByNode.set(p.nodeIndex, copies);
      triangles += (p.indices.length / 3) * copies;
    }
    parts = [...copiesByNode.values()].reduce((s, n) => s + n, 0);
    roots = model.nodes;
    // getSceneBounds counts an instanced primitive once, without its instance matrices: add every instance's box.
    widen = (b) => {
      for (const p of model.primitives) {
        if (!p.instances) continue;
        const lo = [Infinity, Infinity, Infinity],
          hi = [-Infinity, -Infinity, -Infinity],
          v = p.vertices,
          n = p.node.matrix,
          d = p.instances.data;
        for (let o = 0; o < v.length; o += 20)
          for (let a = 0; a < 3; a++) {
            lo[a] = Math.min(lo[a], v[o + a]);
            hi[a] = Math.max(hi[a], v[o + a]);
          }
        for (let i = 0, m = 0; i < p.instances.count; i++, m += 24)
          for (let c = 0; c < 8; c++) {
            const x = c & 1 ? hi[0] : lo[0],
              y = c & 2 ? hi[1] : lo[1],
              z = c & 4 ? hi[2] : lo[2],
              ix = d[m] * x + d[m + 4] * y + d[m + 8] * z + d[m + 12],
              iy = d[m + 1] * x + d[m + 5] * y + d[m + 9] * z + d[m + 13],
              iz = d[m + 2] * x + d[m + 6] * y + d[m + 10] * z + d[m + 14];
            for (let a = 0; a < 3; a++) {
              const w = n[a] * ix + n[a + 4] * iy + n[a + 8] * iz + n[a + 12];
              b[a] = Math.min(b[a], w);
              b[a + 3] = Math.max(b[a + 3], w);
            }
          }
      }
    };
  } else if (format === 'step' && kernel === 'margo') {
    // Our kernel: one geometry per body (in metres), one part per placed body.
    const buffer = await (await fetch(url)).arrayBuffer();
    fetchMs = performance.now() - start;
    const model = parseSTEP(buffer),
      meshes = tessellateSTEP(model),
      material = new PbrMaterial({ color: '#a6b9c8', roughness: 0.4, metalness: 0.3 }),
      geometries = meshes.map((m) => {
        failedFaces += m.failures.length;
        if (!m.indices.length) return null;
        const positions = new Float32Array(m.positions.length);
        for (let i = 0; i < positions.length; i++) positions[i] = m.positions[i] * m.unit;
        return new Geometry(positions, m.normals, m.indices);
      }),
      root = engine.createMesh(),
      placed: Mesh[] = [];
    for (const instance of model.instances) {
      const geometry = geometries[instance.body];
      if (!geometry) continue;
      const { position, quaternion, scale } = decompose(instance.matrix);
      placed.push(
        engine
          .createMesh(root)
          .setGeometry(geometry)
          .setMaterial(material)
          .setPosition(position)
          .setQuaternion(quaternion)
          .setScale(scale),
      );
      triangles += geometry.indices.length / 3;
    }
    parts = placed.length;
    roots = placed;
    instancer = PartInstancer.attach(engine);
  } else if (['obj', 'stl', 'step', 'iges'].includes(format)) {
    const buffer = await (await fetch(url)).arrayBuffer();
    fetchMs = performance.now() - start;
    const model = await parseCADAsync(engine, buffer, format as 'obj' | 'stl' | 'step' | 'iges', {
      smoothing,
      maxParts: 1_000_000,
    });
    parts = model.meshes.length;
    for (const mesh of model.meshes) triangles += (mesh.geometry?.indices.length ?? 0) / 3;
    roots = model.meshes;
    instancer = PartInstancer.attach(engine);
  } else throw new TypeError(`Unknown format ${format}`);
  const parseMs = performance.now() - start - fetchMs;

  // Frame the whole model: the known bounds of a generated assembly, else the loaded geometry's world bounds.
  stage = 'frame';
  let b = known;
  if (!known.every(Number.isFinite)) {
    b = [...getSceneBounds(engine, roots)];
    widen(b);
  }
  const center = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2],
    radius = Math.max(1e-6, Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2),
    distance = 2.2 * radius,
    view = (degrees: number) => {
      const a = (degrees * Math.PI) / 180,
        up = Math.PI / 6;
      Object.assign(engine.camera, {
        position: [
          center[0] + distance * Math.cos(up) * Math.cos(a),
          center[1] + distance * Math.sin(up),
          center[2] + distance * Math.cos(up) * Math.sin(a),
        ],
        target: center,
        near: Math.max(distance * 1e-4, distance - 1.5 * radius),
        far: distance + 1.5 * radius,
      });
    };
  view(35);
  const firstFrameMs = await frame(),
    loadMs = performance.now() - start,
    draws = engine.stats.drawCalls,
    packs = instancer ? { ...instancer.stats } : null;

  stage = 'orbit';
  const orbit: number[] = [],
    orbitEncode: number[] = [];
  for (let i = 0; i < frames; i++) {
    view(35 + (360 * i) / frames);
    orbit.push(await frame());
    orbitEncode.push(encodeMs);
  }

  stage = 'pick';
  view(35);
  await frame();
  const picking = Picking.attach(engine),
    pickTimes: number[] = [];
  let hits = 0;
  for (let i = 0; i < 9; i++) {
    const x = canvas.clientWidth * (0.35 + 0.15 * (i % 3)),
      y = canvas.clientHeight * (0.35 + 0.15 * Math.floor(i / 3)),
      t = performance.now();
    if (await picking.pick(x, y)) hits++;
    pickTimes.push(performance.now() - t);
  }
  engine.removePlugin(picking.name);

  stage = 'section';
  const plane = [0, 1, 0, -center[1]],
    sections = SectionPlanes.attach(engine, { planes: [plane], cap: true, hatch: 0 });
  const section: number[] = [],
    sectionEncode: number[] = [];
  for (let i = 0; i < 30; i++) {
    view(35 + 12 * i);
    section.push(await frame());
    sectionEncode.push(encodeMs);
  }

  // The screenshots: the whole model (shading); cut at its middle height keeping the upper half (the timed section
  // view, whose caps face away from this camera); then keeping the lower half, so the cut and its caps face the camera.
  window.cadScaleShot = async (shot) => {
    sections.enabled = shot !== 'whole';
    plane[1] = shot === 'cap' ? -1 : 1;
    plane[3] = shot === 'cap' ? center[1] : -center[1];
    view(35);
    await frame();
  };
  window.cadScaleView = async ({ azimuth = 35, elevation = 30, zoom = 1, focus = [0.5, 0.5, 0.5], cut }) => {
    const a = (azimuth * Math.PI) / 180,
      e = (elevation * Math.PI) / 180,
      d = distance * zoom,
      target = [0, 1, 2].map((k) => b[k] + (b[k + 3] - b[k]) * focus[k]);
    sections.enabled = !!cut;
    plane[1] = cut === 'lower' ? -1 : 1;
    plane[3] = cut === 'lower' ? center[1] : -center[1];
    Object.assign(engine.camera, {
      position: [
        target[0] + d * Math.cos(e) * Math.cos(a),
        target[1] + d * Math.sin(e),
        target[2] + d * Math.cos(e) * Math.sin(a),
      ],
      target,
      near: Math.max(d * 1e-4, d - 1.5 * radius),
      far: d + 1.5 * radius,
    });
    await frame();
  };
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return {
    ok: true,
    format,
    smoothing,
    kernel,
    failedFaces,
    parts,
    triangles,
    fetchMs,
    parseMs,
    firstFrameMs,
    loadMs,
    draws,
    packs,
    orbit: { ...stats(orbit), encode: stats(orbitEncode) },
    pick: { ...stats(pickTimes), hits },
    section: { ...stats(section), encode: stats(sectionEncode) },
    heapBytes: memory?.usedJSHeapSize ?? null,
    errors,
  };
}

run().then(
  (result) => {
    window.cadScale = errors.length ? { ...result, ok: false, stage: 'errors' } : result;
  },
  (error) => {
    window.cadScale = { ok: false, stage, error: `${error?.name ?? 'Error'}: ${error?.message ?? error}`, errors };
  },
);
