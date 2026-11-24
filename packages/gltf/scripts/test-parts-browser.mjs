// Real-GPU scale check of split primitives: a 2237 x 2237-vertex height field (5,004,169 vertices, 9,999,392 triangles,
// one primitive, a 240 MB GLB) loads with no options through loadGLTF and loadGLTFProgressive, and with
// maxPartVertices 2^16, 2^18 and 2^20, natively and on the WebGL2 layer (--compat), in a far, a low and a close view.
//
// Exact check: each split draws exactly what a reference pre-split at export into the same parts, in the same order,
// draws. The test splits the field itself as parts.ts documents it (triangles in Morton order of their centroids, a
// 30-bit key over one cube scale, ties in source order; a part closes when a triangle's new vertices would pass the
// size) and writes each part as its own primitive. Per view the 4x multisample colour samples before the resolve
// (natively; the resolved canvas on the WebGL2 layer), the draws and the triangles submitted must be identical, and the
// loaded parts must hold the reference primitives' vertices and indices bit for bit. A mutation leg proves the check
// bites: the reference with one part dropped, with two parts' index lists swapped, or with one part drawn twice must
// each fail it.
// What a sample shows: which triangle won it, not lit shading. A shader patch (model.addLighting) writes a hash of the
// triangle's provoking vertex position, passed flat. On Apple's M-series GPU (Metal) interpolated outputs of a
// multi-million-triangle frame are not repeatable: the lit field drawn by the same command stream differed in 1
// low-view pixel in 1 of 20 frames, and by draw order in thousands (docs/known-bugs.md, "Apple M-series: multisample
// values of a multi-million-triangle frame depend on draw order"). The winning triangle is repeatable: a flat triangle
// id over all 9,999,392 triangles was exact in 20 repeats and in reversed draw order. So the exact comparison reads
// the winners, which any change to the parts' triangles, vertices or order of overlap moves. The independent check
// against the field pre-split into 20 row bands compares coverage only: which samples some triangle covered. It still
// catches a part dropped or moved. PARTS_SELF=<n> renders each order-matched reference n more times per view and fails
// on any sample that differs from its first frame (PARTS_LIT=1: with lit shading, for the diagnosis).
// The samples, not the resolved canvas, because the Radeon 680M's resolve rounds an exact .5 average by draw history
// (docs/work-lists/amd-gpu-hunt.md rows 8 and 39, Scott's ruling option a). The test also records the work counts
// (parts, draws, triangles submitted, parts and triangles CulledModels draws) and the Node prepare's peak ArrayBuffer
// bytes per input byte.
// The files are generated once into test-results/gltf-parts/ (git-ignored). Run from the repository root after
// building packages:
//   node scripts/run-with-timeout.mjs -- node packages/gltf/scripts/test-parts-browser.mjs [--compat]
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { runSuite } from '../../../scripts/support/shutdown.mjs';

const compat = process.argv.includes('--compat'),
  side = 2237,
  spacing = 0.01,
  dir = 'test-results/gltf-parts',
  // PART_SIZES narrows the part sizes for a diagnosis; the default 262,144 always runs (loadGLTF's reference).
  sizes = [...new Set([...(process.env.PART_SIZES ?? '65536,262144,1048576').split(',').map(Number), 262_144])];

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

// The order-matched references: the whole field's own arrays, split as parts.ts documents it (written from that
// description, not from parts.ts), each part one primitive of a .gltf whose .bin every mutation shares.
const material = {
    pbrMetallicRoughness: { baseColorFactor: [0.8, 0.5, 0.3, 1], metallicFactor: 0, roughnessFactor: 0.7 },
  },
  mutations = ['drop', 'swap', 'dup'],
  mutated = 262_144,
  orderedPath = (size, mutation) => `${dir}/field-${side}-parts${size}${mutation ? `-${mutation}` : ''}-v1.gltf`;
/** POSITION, NORMAL and index arrays of the one-primitive GLB, exactly as stored. */
function sourceArrays(file) {
  const data = readFileSync(file),
    jsonLength = data.readUInt32LE(12),
    doc = JSON.parse(data.subarray(20, 20 + jsonLength).toString()),
    bin = 20 + jsonLength + 8,
    view = (accessor, Type, width) => {
      const a = doc.accessors[accessor],
        v = doc.bufferViews[a.bufferView],
        bytes = data.subarray(bin + v.byteOffset, bin + v.byteOffset + a.count * width * 4);
      return new Type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    };
  const p = doc.meshes[0].primitives[0];
  return {
    positions: view(p.attributes.POSITION, Float32Array, 3),
    normals: view(p.attributes.NORMAL, Float32Array, 3),
    indices: view(p.indices, Uint32Array, 1),
  };
}
/** Triangles in Morton order of their centroids: one scale for all axes (the largest extent), 10 bits an axis, x high. */
function mortonTriangles(positions, indices) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], positions[i]);
    hi[i % 3] = Math.max(hi[i % 3], positions[i]);
  }
  const scale = 1023.999 / (Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1),
    n = indices.length / 3,
    keys = new Uint32Array(n),
    cell = new Uint32Array(3);
  for (let t = 0; t < n; t++) {
    for (let axis = 0; axis < 3; axis++) {
      const sum = positions[indices[t * 3] * 3 + axis] + positions[indices[t * 3 + 1] * 3 + axis];
      cell[axis] = ((sum + positions[indices[t * 3 + 2] * 3 + axis]) / 3 - lo[axis]) * scale;
    }
    let key = 0;
    for (let bit = 9; bit >= 0; bit--)
      key = key * 8 + ((cell[0] >> bit) & 1) * 4 + ((cell[1] >> bit) & 1) * 2 + ((cell[2] >> bit) & 1);
    keys[t] = key;
  }
  return Uint32Array.from({ length: n }, (_, t) => t).sort((a, b) => keys[a] - keys[b] || a - b);
}
/** Greedy parts over `order`: a part closes when a triangle's vertices not yet in it would take it past `max`. */
function splitParts(indices, order, count, max) {
  const local = new Int32Array(count).fill(-1),
    parts = [];
  let vertexMap = [],
    part = [];
  for (const t of order) {
    const corners = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    if (vertexMap.length + new Set(corners.filter((v) => local[v] < 0)).size > max) {
      parts.push({ vertexMap: Uint32Array.from(vertexMap), indices: Uint32Array.from(part) });
      for (const v of vertexMap) local[v] = -1;
      vertexMap = [];
      part = [];
    }
    for (const v of corners) {
      if (local[v] < 0) local[v] = vertexMap.push(v) - 1;
      part.push(local[v]);
    }
  }
  parts.push({ vertexMap: Uint32Array.from(vertexMap), indices: Uint32Array.from(part) });
  return parts;
}
/** Writes the parts as one .gltf (one primitive each) and its .bin, and for `mutated` the three mutated .gltf. */
function writeOrdered(size, parts, { positions, normals }) {
  const bin = `field-${side}-parts${size}-v1.bin`,
    views = [],
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
  for (const { vertexMap, indices } of parts) {
    const n = vertexMap.length,
      position = new Float32Array(n * 3),
      normal = new Float32Array(n * 3),
      lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k++)
      for (let axis = 0; axis < 3; axis++) {
        position[k * 3 + axis] = positions[vertexMap[k] * 3 + axis];
        normal[k * 3 + axis] = normals[vertexMap[k] * 3 + axis];
        lo[axis] = Math.min(lo[axis], position[k * 3 + axis]);
        hi[axis] = Math.max(hi[axis], position[k * 3 + axis]);
      }
    const base = accessors.length;
    accessors.push(
      { bufferView: add(position, 34962), componentType: 5126, count: n, type: 'VEC3', min: lo, max: hi },
      { bufferView: add(normal, 34962), componentType: 5126, count: n, type: 'VEC3' },
      { bufferView: add(indices, 34963), componentType: 5125, count: indices.length, type: 'SCALAR' },
    );
    primitives.push({ attributes: { POSITION: base, NORMAL: base + 1 }, indices: base + 2, material: 0 });
  }
  writeFileSync(`${dir}/${bin}`, Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
  const write = (file, list) =>
    writeFileSync(
      file,
      JSON.stringify({
        asset: { version: '2.0' },
        buffers: [{ uri: bin, byteLength: offset }],
        bufferViews: views,
        accessors,
        meshes: [{ primitives: list }],
        materials: [material],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
      }),
    );
  if (size === mutated) {
    const k = parts.length >> 1,
      sameIndices = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    // Two parts of one vertex count whose index lists differ: swapped, each stays valid glTF but is mis-indexed.
    let pair = null;
    for (let i = 0; i < parts.length && !pair; i++)
      for (let j = i + 1; j < parts.length && !pair; j++)
        if (parts[i].vertexMap.length === parts[j].vertexMap.length && !sameIndices(parts[i].indices, parts[j].indices))
          pair = [i, j];
    assert.ok(pair, 'two parts of one vertex count with different index lists to swap');
    const swapped = primitives.map((p) => ({ ...p }));
    [swapped[pair[0]].indices, swapped[pair[1]].indices] = [primitives[pair[1]].indices, primitives[pair[0]].indices];
    write(orderedPath(size, 'drop'), primitives.toSpliced(k, 1));
    write(orderedPath(size, 'swap'), swapped);
    write(orderedPath(size, 'dup'), primitives.toSpliced(k + 1, 0, { ...primitives[k] }));
  }
  // The unmutated .gltf last: its presence marks a complete set.
  write(orderedPath(size), primitives);
}
const ordered = {};
{
  let source = null,
    order = null;
  for (const size of sizes) {
    const files = [orderedPath(size), ...(size === mutated ? mutations.map((m) => orderedPath(size, m)) : [])];
    if (files.every((f) => existsSync(f))) continue;
    source ??= sourceArrays(whole);
    order ??= mortonTriangles(source.positions, source.indices);
    const parts = splitParts(source.indices, order, source.positions.length / 3, size);
    // The reference itself must hold every triangle exactly once.
    assert.equal(
      parts.reduce((n, p) => n + p.indices.length, 0),
      source.indices.length,
      `the ${size}-vertex reference holds every triangle`,
    );
    writeOrdered(size, parts, source);
  }
  for (const size of sizes)
    ordered[size] = JSON.parse(readFileSync(orderedPath(size), 'utf8')).meshes[0].primitives.length;
}

const browser = await openBrowser({ startPath: '/tests/modern-extension.html', port: 'free' });
await runSuite(
  async () => {
    const result = await browser.page.evaluate(
      async ({ whole, banded, ordered: orderedUrls, mutations, mutated, sizes, side, spacing, selfRepeat, lit }) => {
        const { EngineKernel } = await import('/packages/core/dist/index.js'),
          { engineRuntime } = await import('/packages/core/dist/extension.js'),
          { loadGLTF } = await import('/packages/gltf/dist/pbr.js'),
          { loadGLTFProgressive } = await import('/packages/gltf/dist/progressive.js'),
          { CulledModels } = await import('/packages/culling/dist/models.js'),
          ordered = (size, mutation) => orderedUrls[mutation ? `${size}-${mutation}` : size];
        // Natively: keep the canvas pass's 4x colour samples stored and readable (core discards them after the resolve).
        const multisampled = (d) =>
            d.sampleCount === 4 && !String(d.format).startsWith('depth') && !String(d.format).startsWith('stencil'),
          textureOfView = new WeakMap(),
          readable = new WeakSet();
        let samplesTexture = null;
        if (globalThis.GPUDevice && !globalThis.__margoCompat) {
          const createTexture = GPUDevice.prototype.createTexture,
            createView = GPUTexture.prototype.createView,
            beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
          GPUDevice.prototype.createTexture = function (d) {
            const texture = createTexture.call(
              this,
              multisampled(d) ? { ...d, usage: d.usage | GPUTextureUsage.TEXTURE_BINDING } : d,
            );
            if (multisampled(d)) readable.add(texture);
            return texture;
          };
          GPUTexture.prototype.createView = function (...args) {
            const view = createView.apply(this, args);
            textureOfView.set(view, this);
            return view;
          };
          GPUCommandEncoder.prototype.beginRenderPass = function (d) {
            for (const c of d.colorAttachments ?? []) {
              const texture = c?.resolveTarget && textureOfView.get(c.view);
              if (!texture || !readable.has(texture)) continue;
              c.storeOp = 'store';
              samplesTexture = texture;
            }
            return beginRenderPass.call(this, d);
          };
        }
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
        // Every sample of the last canvas pass as 8-bit rgb in a u32 (the canvas format is 8-bit, so this is exact).
        const readSamples = async () => {
          const texture = samplesTexture,
            n = texture.width * texture.height * 4,
            module = device.createShaderModule({
              code: `@group(0) @binding(0) var t: texture_multisampled_2d<f32>;
@group(0) @binding(1) var<storage, read_write> o: array<u32>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  let size = textureDimensions(t);
  if (g.x >= size.x || g.y >= size.y) { return; }
  for (var s = 0u; s < 4u; s++) {
    let c = vec3u(round(clamp(textureLoad(t, vec2i(g.xy), s).rgb, vec3f(0.0), vec3f(1.0)) * 255.0));
    o[(g.y * size.x + g.x) * 4u + s] = c.r | (c.g << 8u) | (c.b << 16u);
  }
}`,
            }),
            pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
            out = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
            back = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(
            0,
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: texture.createView() },
                { binding: 1, resource: { buffer: out } },
              ],
            }),
          );
          pass.dispatchWorkgroups(Math.ceil(texture.width / 8), Math.ceil(texture.height / 8));
          pass.end();
          encoder.copyBufferToBuffer(out, 0, back, 0, n * 4);
          device.queue.submit([encoder.finish()]);
          await back.mapAsync(GPUMapMode.READ);
          const data = new Uint32Array(back.getMappedRange().slice(0));
          back.unmap();
          out.destroy();
          back.destroy();
          return data;
        };
        const render = async (view) => {
          instance.camera.position = [...views[view].position];
          instance.camera.target = [...views[view].target];
          let texture;
          const original = context.getCurrentTexture.bind(context);
          context.getCurrentTexture = () => (texture = original());
          try {
            submitted = 0;
            samplesTexture = null;
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
            return { pixels, counts, samples: samplesTexture ? await readSamples() : null };
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
        // Pixels whose four samples differ (natively) or whose resolved rgb differs (the WebGL2 layer).
        const differ = (a, b) => {
          let n = 0;
          if (a.samples && b.samples) {
            for (let p = 0; p < a.samples.length; p += 4)
              for (let s = 0; s < 4; s++)
                if (a.samples[p + s] !== b.samples[p + s]) {
                  n++;
                  break;
                }
            return n;
          }
          const x = a.pixels,
            y = b.pixels;
          for (let i = 0; i < x.length; i += 4)
            if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) n++;
          return n;
        };
        // Pixels where a sample (natively) or the resolved pixel (the WebGL2 layer) is covered in one frame and shows
        // the empty scene in the other: coverage only, which the order of the draws does not change.
        const coverageDiffer = (a, b, empty) => {
          let n = 0;
          if (a.samples && b.samples) {
            const e = empty.samples;
            for (let p = 0; p < a.samples.length; p += 4)
              for (let s = 0; s < 4; s++)
                if ((a.samples[p + s] === e[p + s]) !== (b.samples[p + s] === e[p + s])) {
                  n++;
                  break;
                }
            return n;
          }
          const x = a.pixels,
            y = b.pixels,
            e = empty.pixels;
          for (let i = 0; i < x.length; i += 4) {
            const ex = x[i] === e[i] && x[i + 1] === e[i + 1] && x[i + 2] === e[i + 2],
              ey = y[i] === e[i] && y[i + 1] === e[i + 1] && y[i + 2] === e[i + 2];
            if (ex !== ey) n++;
          }
          return n;
        };
        const covered = (frame, empty) => {
          let n = 0;
          const x = frame.pixels,
            e = empty.pixels;
          for (let i = 0; i < x.length; i += 4)
            if (x[i] !== e[i] || x[i + 1] !== e[i + 1] || x[i + 2] !== e[i + 2]) n++;
          return n / (x.length / 4);
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
        // Each primitive's packed vertices and indices as FNV-1a hashes of their 32-bit words, and its part record.
        const fnv = (array) => {
          const words = new Uint32Array(array.buffer, array.byteOffset, array.length);
          let h = 0x811c9dc5;
          for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193);
          return h >>> 0;
        };
        const structure = (model) =>
          model.primitives.map((p) => ({
            vertices: p.vertices.length,
            indices: p.indices.length,
            hash: `${fnv(p.vertices)}:${fnv(p.indices)}`,
            part: p.part ? `${p.part.index}/${p.part.count}` : null,
          }));
        // The empty scene per view: what a sample no triangle covers holds.
        const empty = {};
        for (const view of Object.keys(views)) {
          await render(view);
          empty[view] = await render(view);
        }
        // Each sample shows which triangle won it, not lit shading: the colour is a hash of the triangle's provoking
        // vertex position, passed flat. Interpolated outputs are not repeatable on Apple's M-series GPU (the same command
        // stream drew 1 low-view pixel differently in 1 of 20 frames), while the winning triangle is (a flat triangle id
        // was exact in 20 repeats of all 9,999,392 triangles, in either draw order): docs/known-bugs.md, "Apple M-series".
        const flat = {
          shader: (code) => {
            const out = code
              .replace(/(struct Out \{[^}]*?)\n\}/, '$1, @location(13) @interpolate(flat) margoId:vec3f\n}')
              .replace('var o:Out; let p=f.model*vec4f(i.position.xyz,1);', '$&o.margoId=i.position.xyz;')
              .replace(
                '@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {',
                '$&return margoIdColour(i.margoId);',
              );
            if (!out.includes('o.margoId=') || !out.includes('return margoIdColour('))
              throw new Error('the flat triangle output no longer fits the gltf/pbr shader');
            return `fn margoIdColour(p:vec3f)->vec4f {
  let h=bitcast<vec3u>(p); var x=(h.x*0x9e3779b9u)^(h.y*0x85ebca6bu)^(h.z*0xc2b2ae35u);
  x=(x^(x>>16u))*0x7feb352du; x=(x^(x>>15u))*0x846ca68bu; x^=x>>16u;
  return vec4f(vec3f(f32(x&255u),f32((x>>8u)&255u),f32((x>>16u)&255u))/255.0,1.0);
}
${out}`;
          },
          bindings: () => [],
        };
        const runs = {};
        const measure = async (name, load, { culled = true } = {}) => {
          const model = await load();
          model.addLighting(flat);
          runs[name] = {
            parts: model.primitives.length,
            structure: structure(model),
            frames: await settle(model),
            culled: culled ? await culledCounts(model) : null,
          };
          model.dispose();
        };
        // A part size whose 80-byte vertices pass this device's storage binding is refused at upload by design.
        const fitting = sizes.filter((size) => size * 80 <= device.limits.maxStorageBufferBindingSize);
        if (selfRepeat) {
          const self = {};
          for (const size of fitting) {
            const model = await loadGLTF(instance, ordered(size), { maxPartVertices: size });
            if (!lit) model.addLighting(flat);
            const first = await settle(model);
            self[size] = Object.fromEntries(Object.keys(views).map((v) => [v, []]));
            for (let k = 0; k < selfRepeat; k++)
              for (const view of Object.keys(views)) self[size][view].push(differ(await render(view), first[view]));
            model.dispose();
          }
          instance.dispose();
          return { selfRepeat: self };
        }
        await measure('bands', () => loadGLTF(instance, banded));
        // The references load with their own part size, so none of their primitives splits again.
        for (const size of fitting)
          await measure(`reference${size}`, () => loadGLTF(instance, ordered(size), { maxPartVertices: size }));
        await measure('loadGLTF', () => loadGLTF(instance, whole));
        await measure('progressive', () => loadGLTFProgressive(instance, whole).complete);
        for (const size of fitting)
          await measure(`parts${size}`, () => loadGLTF(instance, whole, { maxPartVertices: size }));
        if (fitting.includes(mutated))
          for (const mutation of mutations)
            await measure(
              mutation,
              () => loadGLTF(instance, ordered(mutated, mutation), { maxPartVertices: mutated }),
              {
                culled: false,
              },
            );
        const bands = runs.bands.frames,
          out = {
            validation,
            backend: instance.backend,
            compare: bands.far.samples ? 'samples' : 'resolved',
            // Control: the far and close views' samples differ, so the comparison reads what the draws wrote.
            control: differ(bands.far, bands.close),
            sizes: fitting,
            limits: {
              maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
              maxBufferSize: device.limits.maxBufferSize,
            },
            coverage: Object.fromEntries(Object.keys(views).map((view) => [view, covered(bands[view], empty[view])])),
          };
        // Each split against its order-matched reference (exact), each mutated reference against the split it was
        // made for, and every run against the row bands (coverage).
        const referenceOf = (name) =>
          name.startsWith('parts')
            ? `reference${name.slice(5)}`
            : name === 'loadGLTF' || name === 'progressive'
              ? `reference${mutated}`
              : mutations.includes(name)
                ? `parts${mutated}`
                : null;
        for (const [name, run] of Object.entries(runs)) {
          const ref = runs[referenceOf(name)] ?? null,
            mine = run.structure.map((p) => p.hash).join(),
            theirs = ref?.structure.map((p) => p.hash).join();
          out[name] = {
            parts: run.parts,
            split: run.structure.filter((p) => p.part).length,
            partRecords: run.structure.every((p, k) => p.part === null || p.part === `${k}/${run.parts}`),
            sameData: ref ? mine === theirs : null,
            ...Object.fromEntries(
              Object.keys(views).map((view) => {
                const frame = run.frames[view],
                  reference = ref?.frames[view];
                return [
                  view,
                  {
                    ...frame.counts,
                    differ: reference ? differ(frame, reference) : null,
                    sameCounts: reference
                      ? frame.counts.draws === reference.counts.draws &&
                        frame.counts.triangles === reference.counts.triangles
                      : null,
                    coverageVsBands: coverageDiffer(frame, bands[view], empty[view]),
                    culled: run.culled?.[view] ?? null,
                    sameCulled:
                      run.culled && ref?.culled
                        ? JSON.stringify(run.culled[view]) === JSON.stringify(ref.culled[view])
                        : null,
                  },
                ];
              }),
            ),
          };
        }
        if (drawIndexed) Pass.drawIndexed = drawIndexed;
        instance.dispose();
        return out;
      },
      {
        whole: '/' + whole,
        banded: '/' + banded,
        ordered: Object.fromEntries(
          [
            ...sizes.map((size) => [size, orderedPath(size)]),
            ...mutations.map((m) => [`${mutated}-${m}`, orderedPath(mutated, m)]),
          ].map(([k, v]) => [k, '/' + v]),
        ),
        mutations,
        mutated,
        sizes,
        side,
        spacing,
        selfRepeat: Number(process.env.PARTS_SELF ?? 0),
        lit: process.env.PARTS_LIT === '1',
      },
    );
    if (result.selfRepeat) {
      console.log(JSON.stringify({ compat, selfRepeat: result.selfRepeat }));
      for (const [size, views] of Object.entries(result.selfRepeat))
        for (const [view, counts] of Object.entries(views))
          assert.ok(counts.every((n) => n === 0), `reference${size} ${view}: frames of the same stream differ (${counts})`);
      return;
    }
    console.log(JSON.stringify({ compat, memory, ...result }));
    assert.deepEqual(result.validation, []);
    // Natively the samples must be read: a silent fall back to the resolved canvas would hide a broken hook.
    assert.equal(
      result.compare,
      compatRun() ? 'resolved' : 'samples',
      'the views compare the multisample samples natively',
    );
    assert.ok(result.control > 1000, `the far and close views differ (${result.control} pixels)`);
    assert.ok(result.coverage.far > 0.2 && result.coverage.close > 0.98, JSON.stringify(result.coverage));
    const views = ['far', 'low', 'close'];
    for (const size of result.sizes) {
      const ref = result[`reference${size}`];
      assert.equal(ref.parts, ordered[size], `reference${size} loads its ${ordered[size]} primitives`);
      assert.equal(ref.split, 0, `reference${size}: no primitive split again`);
    }
    for (const name of ['loadGLTF', 'progressive', ...result.sizes.map((s) => `parts${s}`)]) {
      const run = result[name];
      assert.ok(
        run.parts > 1 && run.split === run.parts && run.partRecords,
        `${name} split the primitive into numbered parts`,
      );
      assert.equal(run.sameData, true, `${name}: the parts hold the order-matched reference's vertices and indices`);
      for (const view of views) {
        const v = run[view];
        assert.equal(v.differ, 0, `${name}: the ${view} view differs from the order-matched reference`);
        assert.ok(
          v.sameCounts && v.sameCulled,
          `${name}: the ${view} view's draws or triangles differ from the reference`,
        );
        assert.equal(v.coverageVsBands, 0, `${name}: the ${view} view's coverage differs from the row-band reference`);
      }
    }
    // The mutation leg: each mutated reference must fail the exact comparison (samples, draws or triangles).
    if (result.sizes.includes(262_144)) {
      const fails = (name) => views.some((view) => result[name][view].differ > 0 || !result[name][view].sameCounts);
      for (const name of ['drop', 'swap', 'dup'])
        assert.ok(fails(name), `the ${name} mutation fails the exact comparison`);
      assert.ok(
        views.some((view) => result.drop[view].differ > 0),
        'a dropped part changes the samples',
      );
      assert.ok(
        views.some((view) => result.swap[view].differ > 0),
        'swapped index lists change the samples',
      );
      assert.ok(
        views.some((view) => !result.dup[view].sameCounts),
        'a part drawn twice changes the draws',
      );
      // The coverage check against the row bands bites too: a dropped part leaves a hole.
      assert.ok(
        views.some((view) => result.drop[view].coverageVsBands > 0),
        'a dropped part changes the coverage',
      );
    }
    writeFileSync(
      `test-results/gltf-pbr-parts${compat ? '-compat' : ''}.json`,
      JSON.stringify({ hardware: browser.hardware, memory, ...result }, null, 2),
    );
  },
  () => browser.close(),
);
