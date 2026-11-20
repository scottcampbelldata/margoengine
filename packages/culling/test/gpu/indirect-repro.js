// Browser side of indirect-repro.mjs. No culling: two plain engines draw NodePerformanceTest.glb, and while engine A
// records a frame every drawIndexed(count, n, first, base, firstInstance) it makes becomes drawIndexedIndirect on a
// buffer holding exactly those five words. WebGPU defines the two calls to draw the same thing.
import { Engine } from '../../../core/dist/index.js';
import { loadGLTF } from '../../../gltf/dist/pbr.js';

const forced = { on: false, n: 0, buffer: null, device: null },
  direct = GPURenderPassEncoder.prototype.drawIndexed;
GPURenderPassEncoder.prototype.drawIndexed = function (count, instances = 1, first = 0, base = 0, firstInstance = 0) {
  if (!forced.on) return direct.call(this, count, instances, first, base, firstInstance);
  forced.buffer ??= forced.device.createBuffer({
    size: 20 * 65536,
    usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });
  const at = forced.n++ * 20;
  forced.device.queue.writeBuffer(forced.buffer, at, new Uint32Array([count, instances, first, base, firstInstance]));
  return this.drawIndexedIndirect(forced.buffer, at);
};
let a, b, models;
const draw = async (indirect) => {
  Object.assign(forced, { on: indirect, n: 0, device: a.gpu });
  a.render();
  forced.on = false;
  b.render();
  await Promise.all([a.gpu.queue.onSubmittedWorkDone(), b.gpu.queue.onSubmittedWorkDone()]);
};
async function setup() {
  const camera = { fov: 50, near: 0.1, far: 100000 };
  a = await Engine.create(document.getElementById('a'), { camera });
  b = await Engine.create(document.getElementById('b'), { camera });
  const url = '/examples/assets/khronos/NodePerformanceTest/NodePerformanceTest.glb';
  models = [await loadGLTF(a, url), await loadGLTF(b, url)];
  a.render();
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (const { node } of models[0].primitives)
    for (let k = 0; k < 3; k++) {
      low[k] = Math.min(low[k], node.matrix[12 + k]);
      high[k] = Math.max(high[k], node.matrix[12 + k]);
    }
  const middle = low.map((v, k) => (v + high[k]) / 2),
    size = Math.max(...low.map((v, k) => high[k] - v));
  for (const e of [a, b]) {
    e.camera.position = [middle[0] + 0.2 * size, middle[1] + 0.9 * size, middle[2] + 1.2 * size];
    e.camera.target = middle;
  }
  // Settled: both engines have drawn this view directly before the first frame the script compares.
  for (let i = 0; i < 3; i++) await draw(false);
  return size;
}
// `move` shifts both models by the same amount; `indirect` draws engine A's frame with drawIndexedIndirect.
async function frame(move, indirect) {
  if (move !== undefined) for (const m of models) m.root.setPosition([move, 0, 0]);
  await draw(indirect);
}
window.repro = { setup, frame };
window.ready = true;
