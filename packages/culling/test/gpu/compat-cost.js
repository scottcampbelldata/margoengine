// Browser side of compat-cost-check.mjs: a wall hides a crowd of small boxes (n of them, two geometries, four
// materials). One engine draws it with CulledMeshes (occlusion on or off) or with no plugin, and the page counts, per
// frame, the GL draw calls and triangles the WebGL2 layer submits, its stalls (GPU-to-CPU reads that wait), and the
// time to finish the frame. Work counts are exact; times are a diagnostic.
import { Engine, box, PbrMaterial } from '../../../core/dist/index.js';
import { CulledMeshes } from '../../dist/index.js';
import { WebGL2Culling } from '../../dist/webgl2.js';
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';

const canvas = document.getElementById('a'),
  counts = { draws: 0, triangles: 0 };
{
  const proto = WebGL2RenderingContext.prototype,
    tri = (mode, n) => (mode === 4 ? n / 3 : 0);
  for (const [name, f] of [
    ['drawElements', (a) => tri(a[0], a[1])],
    ['drawArrays', (a) => tri(a[0], a[2])],
    ['drawElementsInstanced', (a) => tri(a[0], a[1]) * a[4]],
    ['drawArraysInstanced', (a) => tri(a[0], a[2]) * a[3]],
  ]) {
    const original = proto[name];
    proto[name] = function (...args) {
      {
        counts.draws++;
        counts.triangles += f(args);
      }
      return original.apply(this, args);
    };
  }
}
const wall = box(4, 12, 1),
  small = box(0.6, 0.6, 0.6),
  round = box(0.4, 1.2, 0.4),
  colors = ['#e6331a', '#1a99e6', '#f2cc33', '#4dd966'].map(
    (color) => new PbrMaterial({ color, roughness: 0.5, doubleSided: false }),
  ),
  slab = new PbrMaterial({ color: '#c8c8c8', roughness: 0.8, doubleSided: true });
async function run({ n, mode, frames }) {
  const e = await Engine.create(canvas, {
    camera: { fov: 50, near: 0.1, far: 600, position: [0, 3, 40], target: [0, 2, 0] },
    capacity: n + 64,
  });
  const errors = [];
  e.gpu.addEventListener('uncapturederror', (ev) => errors.push(ev.error.message));
  const culled =
    mode === 'none'
      ? undefined
      : mode === 'software'
        ? WebGL2Culling.attach(e)
        : CulledMeshes.attach(e, { occlusion: mode === 'occlusion' });
  for (let i = 0; i < 9; i++) e.createMesh().setGeometry(wall).setMaterial(slab).setPosition([(i - 4) * 4, 3, 10]);
  for (let k = 0; k < n; k++)
    e.createMesh()
      .setGeometry(k % 3 ? small : round)
      .setMaterial(colors[k % 4])
      .setPosition([((k % 30) - 15) * 1, ((k * 7) % 5) * 1, -Math.floor(k / 30)]);
  const frame = async () => {
    e.render({ culling: false });
    await e.gpu.queue.onSubmittedWorkDone();
  };
  // Pipelines and the layer's compatibility route load lazily: draw over animation frames until every pipeline is
  // compiled and, on the WebGL2 layer, CulledMeshes has its route (meshes.ts `route`, set when ./compat.js arrives).
  await waitForPipelines(
    async () => {
      await frame();
      await new Promise(requestAnimationFrame);
    },
    {
      ready: () => !(culled instanceof CulledMeshes) || !globalThis.__margoCompat || culled.route !== undefined,
      describe: () => `mode ${mode}, compat route ${culled?.route ? 'loaded' : 'missing'}`,
    },
  );
  const stalls0 = e.gpu.stalls ?? 0,
    tiers0 = { ...(e.gpu.dispatches ?? {}) };
  counts.draws = counts.triangles = 0;
  const times = [];
  for (let i = 0; i < frames; i++) {
    const t = performance.now();
    await frame();
    times.push(performance.now() - t);
  }
  const result = {
    n,
    mode,
    compat: !!globalThis.__margoCompat,
    drawsPerFrame: counts.draws / frames,
    trianglesPerFrame: counts.triangles / frames,
    stallsPerFrame: ((e.gpu.stalls ?? 0) - stalls0) / frames,
    dispatchesPerFrame: Object.fromEntries(
      Object.entries(e.gpu.dispatches ?? {}).map(([k, v]) => [k, (v - (tiers0[k] ?? 0)) / frames]),
    ),
    msMin: Math.min(...times),
    msMedian: times.sort((x, y) => x - y)[times.length >> 1],
    drawn: culled ? [...(await culled.readCounts()).values()].reduce((x, y) => x + y, 0) : n + 9,
    errors,
  };
  culled?.dispose?.();
  e.dispose?.();
  return result;
}
window.check = { run };
window.ready = true;
