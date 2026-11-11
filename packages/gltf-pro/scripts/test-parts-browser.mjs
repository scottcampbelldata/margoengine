// Real-GPU scale check of split primitives: a 2237 x 2237-vertex height field (5,004,169 vertices, 9,999,392 triangles,
// one primitive, a 240 MB GLB) loads with no options through loadGLTF and loadGLTFProgressive and draws the same pixels
// as a reference GLB pre-split at export into row bands of at most 262,144 vertices, far away and close up, natively
// and on the WebGL2 layer (--compat). For maxPartVertices 2^16, 2^18 and 2^20 it records the work counts (parts,
// draws, triangles submitted) of both views, and the Node prepare's peak ArrayBuffer bytes per input byte.
// The GLBs are generated once into test-results/gltf-parts/ (git-ignored). Run from the repository root after building
// packages, under the GPU lock:
//   node scripts/gpu-lock.mjs run --owner=<lane> -- node packages/gltf-pro/scripts/test-parts-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';

const compat = process.argv.includes('--compat'),
  side = 2237,
  spacing = 0.01,
  dir = 'test-results/gltf-parts',
  sizes = (process.env.PART_SIZES ?? '65536,262144,1048576').split(',').map(Number);

/** Height and normal of the field at grid point (x, y): two waves and a ripple, so every part has relief. */
function field(x, y) {
  const h = (Math.sin(x * 0.031) * Math.cos(y * 0.027) * 4 + Math.sin(x * 0.4 + y * 0.3) * 0.2) * spacing,
    dx = Math.cos(x * 0.031) * 0.124 * Math.cos(y * 0.027) + Math.cos(x * 0.4 + y * 0.3) * 0.08,
    dy = -Math.sin(x * 0.031) * Math.sin(y * 0.027) * 0.108 + Math.cos(x * 0.4 + y * 0.3) * 0.06,
    l = Math.hypot(dx, 1, dy);
  return [h, -dx / l, 1 / l, -dy / l];
}

/** A GLB of one mesh whose primitives are the row bands [r0, r1] (vertex rows, inclusive) of the field. */
function glb(bands) {
  const views = [],
    accessors = [],
    primitives = [],
    chunks = [];
  let offset = 0;
  const add = (array, target) => {
    views.push({ buffer: 0, byteOffset: offset, byteLength: array.byteLength, target });
    chunks.push(array);
    offset += array.byteLength;
    return views.length - 1;
  };
  for (const [r0, r1] of bands) {
    const rows = r1 - r0 + 1,
      count = rows * side,
      position = new Float32Array(count * 3),
      normal = new Float32Array(count * 3),
      indices = new Uint32Array((rows - 1) * (side - 1) * 6);
    let lo = Infinity,
      hi = -Infinity;
    for (let r = 0, v = 0; r < rows; r++)
      for (let x = 0; x < side; x++, v++) {
        const [h, nx, ny, nz] = field(x, r0 + r);
        position.set([x * spacing, h, (r0 + r) * spacing], v * 3);
        normal.set([nx, ny, nz], v * 3);
        lo = Math.min(lo, Math.fround(h));
        hi = Math.max(hi, Math.fround(h));
      }
    for (let r = 0, i = 0; r < rows - 1; r++)
      for (let x = 0; x < side - 1; x++, i += 6) {
        const a = r * side + x,
          c = a + side;
        indices.set([a, c, a + 1, a + 1, c, c + 1], i);
      }
    const base = accessors.length;
    accessors.push(
      {
        bufferView: add(position, 34962),
        componentType: 5126,
        count,
        type: 'VEC3',
        min: [0, lo, Math.fround(r0 * spacing)],
        max: [Math.fround((side - 1) * spacing), hi, Math.fround(r1 * spacing)],
      },
      { bufferView: add(normal, 34962), componentType: 5126, count, type: 'VEC3' },
      { bufferView: add(indices, 34963), componentType: 5125, count: indices.length, type: 'SCALAR' },
    );
    primitives.push({ attributes: { POSITION: base, NORMAL: base + 1 }, indices: base + 2, material: 0 });
  }
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: offset }],
    bufferViews: views,
    accessors,
    meshes: [{ primitives }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.5, 0.3, 1], metallicFactor: 0, roughnessFactor: 0.7 } },
    ],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  };
  const text = JSON.stringify(doc),
    json = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, ' ')),
    out = Buffer.alloc(12 + 8 + json.length + 8 + offset);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  json.copy(out, 20);
  let at = 20 + json.length;
  out.writeUInt32LE(offset, at);
  out.writeUInt32LE(0x004e4942, at + 4);
  at += 8;
  for (const c of chunks) {
    Buffer.from(c.buffer, c.byteOffset, c.byteLength).copy(out, at);
    at += c.byteLength;
  }
  return out;
}

mkdirSync(dir, { recursive: true });
const whole = `${dir}/field-${side}-v1.glb`,
  banded = `${dir}/field-${side}-bands-v1.glb`;
if (!existsSync(whole)) writeFileSync(whole, glb([[0, side - 1]]));
if (!existsSync(banded)) {
  const rows = Math.floor(262_144 / side),
    bands = [];
  for (let r0 = 0; r0 < side - 1; r0 += rows - 1) bands.push([r0, Math.min(r0 + rows - 1, side - 1)]);
  writeFileSync(banded, glb(bands));
}

// Node prepare of the one-primitive file: peak ArrayBuffer bytes over the input's (sampled every 2 ms and at the end).
let memory = null;
if (!compat) {
  const { prepareGLTF } = await import('../dist/prepare.js');
  const input = readFileSync(whole),
    base = process.memoryUsage().arrayBuffers;
  let peak = 0;
  const sample = () => (peak = Math.max(peak, process.memoryUsage().arrayBuffers - base));
  const timer = setInterval(sample, 2);
  const prepared = await prepareGLTF(undefined, input);
  sample();
  clearInterval(timer);
  memory = { inputBytes: input.length, peakArrayBufferBytes: peak, perInputByte: +(peak / input.length).toFixed(2) };
  assert.ok(prepared);
}

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const result = await browser.page.evaluate(
      async ({ whole, banded, sizes, side, spacing }) => {
        const { EngineKernel } = await import('/packages/core/dist/index.js'),
          { engineRuntime } = await import('/packages/core/dist/extension.js'),
          { loadGLTF } = await import('/packages/gltf-pro/dist/index.js'),
          { loadGLTFProgressive } = await import('/packages/gltf-pro/dist/progressive.js'),
          { CulledModels } = await import('/packages/culling/dist/models.js');
        const canvas = document.createElement('canvas'),
          W = 512;
        canvas.width = canvas.height = W;
        canvas.style.cssText = `width:${W}px;height:${W}px`;
        document.body.append(canvas);
        const mid = ((side - 1) * spacing) / 2,
          views = {
            far: { position: [mid, mid * 1.6, mid * 3.2], target: [mid, 0, mid] },
            low: { position: [mid * 0.7, 0.35, mid * 0.62], target: [mid * 0.9, 0, mid * 0.75] },
            close: { position: [mid * 0.8, 0.6, mid * 0.8], target: [mid * 0.8 + 0.05, 0, mid * 0.8 + 0.1] },
          };
        const instance = await EngineKernel.create(canvas, {
            backend: 'webgpu',
            capacity: 64,
            camera: { ...views.far, fov: 50, near: 0.05, far: 200 },
          }),
          engine = engineRuntime(instance),
          device = engine.gpu,
          validation = [];
        device.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
        engine.lighting.direction.set([0.3, 1, 0.4, 1]);
        // Triangles submitted in a frame: drawIndexed's index counts (native encoder only; the WebGL2 layer has its own).
        let submitted = 0;
        const Pass = globalThis.GPURenderPassEncoder?.prototype,
          drawIndexed = Pass?.drawIndexed;
        if (drawIndexed)
          Pass.drawIndexed = function (count, instances = 1, ...rest) {
            submitted += count * instances;
            return drawIndexed.call(this, count, instances, ...rest);
          };
        const context = canvas.getContext('webgpu');
        context.configure({
          device,
          format: navigator.gpu.getPreferredCanvasFormat(),
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        const render = async (view) => {
          instance.camera.position = [...views[view].position];
          instance.camera.target = [...views[view].target];
          let texture;
          const original = context.getCurrentTexture.bind(context);
          context.getCurrentTexture = () => (texture = original());
          try {
            submitted = 0;
            instance.render();
            const counts = { draws: engine.stats.drawCalls, triangles: drawIndexed ? submitted / 3 : null };
            const row = W * 4,
              read = device.createBuffer({ size: row * W, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture }, { buffer: read, bytesPerRow: row }, [W, W]);
            device.queue.submit([encoder.finish()]);
            await read.mapAsync(GPUMapMode.READ);
            const pixels = new Uint8Array(read.getMappedRange()).slice();
            read.unmap();
            read.destroy();
            return { pixels, counts };
          } finally {
            context.getCurrentTexture = original;
          }
        };
        // Renders each view until two frames agree (pipelines compile in the background).
        const settle = async (model) => {
          await model.compile();
          const out = {};
          for (const view of Object.keys(views)) {
            let frame = await render(view),
              same = false;
            for (let t = 0; t < 20 && !same; t++) {
              const next = await render(view);
              same = next.pixels.every((v, i) => v === frame.pixels[i]);
              frame = next;
            }
            if (!same) throw new Error(`${view} frames did not settle in 20 renders`);
            out[view] = frame;
          }
          return out;
        };
        const differ = (a, b) => {
          let n = 0;
          for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
          return n;
        };
        const background = (p) => {
          let n = 0;
          for (let i = 0; i < p.length; i += 4) if (p[i] === p[0] && p[i + 1] === p[1] && p[i + 2] === p[2]) n++;
          return n;
        };
        // With CulledModels (@margoengine/culling/models) each part culls on its own: parts and triangles drawn per view.
        const culledCounts = async (model) => {
          const culled = CulledModels.attach(instance, [model]),
            out = {};
          try {
            for (const view of Object.keys(views)) {
              await render(view);
              await render(view);
              let parts = 0,
                triangles = 0;
              for (const [primitive, rows] of await culled.readCounts())
                if (rows) {
                  parts++;
                  triangles += (rows * primitive.indices.length) / 3;
                }
              out[view] = { parts, triangles };
            }
          } finally {
            culled.remove(model);
            instance.removePlugin(culled.name);
          }
          return out;
        };
        const runs = {};
        const measure = async (name, load) => {
          const model = await load();
          runs[name] = { parts: model.primitives.length, frames: await settle(model), culled: await culledCounts(model) };
          model.dispose();
        };
        await measure('reference', () => loadGLTF(instance, banded));
        await measure('loadGLTF', () => loadGLTF(instance, whole));
        await measure('progressive', () => loadGLTFProgressive(instance, whole).complete);
        // A part size whose 80-byte vertices pass this device's storage binding is refused at upload by design.
        const fitting = sizes.filter((size) => size * 80 <= device.limits.maxStorageBufferBindingSize);
        for (const size of fitting) await measure(`parts${size}`, () => loadGLTF(instance, whole, { maxPartVertices: size }));
        const ref = runs.reference.frames,
          out = {
            validation,
            backend: instance.backend,
            sizes: fitting,
            limits: {
              maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
              maxBufferSize: device.limits.maxBufferSize,
            },
            coverage: Object.fromEntries(
              Object.keys(views).map((view) => [view, 1 - background(ref[view].pixels) / (W * W)]),
            ),
          };
        for (const [name, run] of Object.entries(runs))
          out[name] = {
            parts: run.parts,
            ...Object.fromEntries(
              Object.keys(views).map((view) => [
                view,
                {
                  ...run.frames[view].counts,
                  differ: differ(run.frames[view].pixels, ref[view].pixels),
                  culled: run.culled[view],
                },
              ]),
            ),
          };
        if (drawIndexed) Pass.drawIndexed = drawIndexed;
        instance.dispose();
        return out;
      },
      { whole: '/' + whole, banded: '/' + banded, sizes, side, spacing },
    );
    console.log(JSON.stringify({ compat, memory, ...result }));
    assert.deepEqual(result.validation, []);
    assert.ok(result.coverage.far > 0.2 && result.coverage.close > 0.98, JSON.stringify(result.coverage));
    for (const name of ['loadGLTF', 'progressive', ...result.sizes.map((s) => `parts${s}`)]) {
      for (const view of ['far', 'low', 'close'])
        assert.equal(result[name][view].differ, 0, `${name}: the ${view} view differs from the pre-split reference`);
      assert.ok(result[name].parts > 1, `${name} split the primitive`);
    }
    writeFileSync(
      `test-results/gltf-pro-parts${compat ? '-compat' : ''}.json`,
      JSON.stringify({ hardware: browser.hardware, memory, ...result }, null, 2),
    );
  },
  () => browser.close(),
);
