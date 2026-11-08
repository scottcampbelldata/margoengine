// Browser side of exact-check.mjs: unlit planes in front of an opaque wall, drawn through a chosen pass.
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';
import { Engine } from '../../../core/dist/index.js';
import { TransparentCanvas } from '../../../environment/dist/index.js';
import { Material, createMesh } from '../../../materials/dist/index.js';
import { planeGeometry } from '../../../geometry/dist/index.js';
import { PostStack, FXAA } from '../../../post/dist/index.js';
import { OIT } from '../../dist/index.js';
import { ExactOIT } from '../../dist/exact.js';
import { MomentOIT } from '../../dist/moments.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
let engine, canvas, pass;
let planes = [];
const plane = (color, z, opacity, { size = 1.6, tilt = 0, x = 0 } = {}) => {
  const mesh = createMesh(
    engine,
    planeGeometry(size, size),
    new Material({
      shading: 'basic',
      color,
      opacity,
      transparent: opacity < 1,
      doubleSided: true,
    }),
  );
  mesh.root.setPosition([x, 0, z]);
  if (opacity < 1) planes.push({ mesh, x, z });
  if (tilt) mesh.root.setRotation([0, tilt, 0]);
  return mesh;
};
const draw = async () => {
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
};
window.check = {
  errors,
  // {samples, mode:'exact'|'moment'|'weighted'|'sorted', depthRange, dense, layers, pool, order:[...indices], tilted, blocker, transparent, post}
  async build(o) {
    pass?.dispose();
    pass = undefined;
    planes = [];
    engine?.dispose();
    canvas?.remove();
    globalThis.margoLow = o.samples === 1 ? 1 : undefined;
    canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.style.cssText = 'width:256px;height:256px;display:block';
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      preserveDrawingBuffer: true,
      camera: { position: [0, 0, 4], target: [0, 0, 0], near: 0.05, far: 100 },
    });
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    if (o.transparent) TransparentCanvas.attach(engine);
    if (!o.transparent) plane([0.2, 0.2, 0.2], -1.5, 1, { size: 8 });
    const options = {};
    if (o.layers) options.layers = o.layers;
    if (o.pool) options.pool = o.pool;
    if (o.post) PostStack.attach(engine, [new FXAA()]);
    pass =
      o.mode === 'sorted'
        ? { add() {}, dispose() {} }
        : o.mode === 'weighted'
          ? OIT.attach(engine)
          : o.mode === 'moment'
            ? MomentOIT.attach(engine, o.depthRange ? { depthRange: o.depthRange } : {})
            : ExactOIT.attach(engine, options);
    const layers = [
      [[1, 0, 0], 0.6, 0.5],
      [[0, 1, 0], 0.3, 0.4],
      [[0, 0, 1], 0, 0.6],
      [[1, 1, 0], -0.3, 0.5],
    ];
    if (o.blocker) plane([1, 1, 1], 0.15, 1, { size: 1.6 });
    if (o.dense) {
      pass.add(plane([1, 0, 0], 0.6, 0.9));
      pass.add(plane([0, 1, 0], 0.3, 0.9));
    } else if (o.tilted) {
      // Two sheets that cross on the centre line: each is in front on one half, which no per-mesh order can draw.
      pass.add(plane([1, 0, 0], 0, 0.5, { tilt: 0.5 }));
      pass.add(plane([0, 0, 1], 0, 0.5, { tilt: -0.5 }));
    } else for (const i of o.order ?? [0, 1, 2, 3]) pass.add(plane(...layers[i]));
    // Multisampled, a GPU may run the list shader once per sample (Apple GPUs do), which can fill the starting list on
    // the first frames: draw until it has grown, as it does in a running scene.
    const grown = o.samples > 1 && pass.stats ? () => pass.stats.fragments > 0 && !pass.stats.dropped : undefined;
    await waitForPipelines(draw, grown && { ready: grown });
    return { width: canvas.width, height: canvas.height };
  },
  draw,
  // Moves the see-through planes towards the camera.
  async shift(by) {
    for (const { mesh, x, z } of planes) mesh.root.setPosition([x, 0, z + by]);
    await draw();
  },
  async fit() {
    pass.fit();
    await draw();
  },
  stats: () => pass.stats,
  // Runs MomentOIT's own WGSL in compute shaders (after a moment build): the moments of `layers` ([alpha, view depth]),
  // summed, rounded to half floats and then moved by up to one half-float step in each stored channel (3^n ways), as
  // another add order or another GPU's log would move them. Returns, per layer, the least and most transmittance in
  // front of it that those sums give.
  async recover(layers, [near, far]) {
    const device = engine.gpu,
      x = 2 / Math.log(far / near),
      uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Float32Array([x, -1 - x * Math.log(near), 0, 0]));
    // One workgroup per item, `items` of them, each writing `per` vec4f.
    const run = async (code, input, items, per) => {
      const count = items * per;
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code }), entryPoint: 'probe' },
      });
      const data = device.createBuffer({ size: input.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(data, 0, input);
      const out = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
        read = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        encoder = device.createCommandEncoder(),
        compute = encoder.beginComputePass();
      compute.setPipeline(pipeline);
      compute.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 120, resource: { buffer: uniform } },
            { binding: 0, resource: { buffer: data } },
            { binding: 1, resource: { buffer: out } },
          ],
        }),
      );
      compute.dispatchWorkgroups(Math.min(items, 65535), Math.ceil(items / 65535));
      compute.end();
      encoder.copyBufferToBuffer(out, 0, read, 0, count * 16);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = new Float32Array(read.getMappedRange().slice(0));
      for (const b of [data, out, read]) b.destroy();
      return values;
    };
    const io = /* wgsl */ `
@group(0) @binding(0) var<storage,read> probeIn:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> probeOut:array<vec4f>;
fn probeItem(g:vec3u)->u32 {return g.y*65535u+g.x;}`;
    // Each layer's moments and optical depth, from the moment pass's own code.
    const each = await run(
      pass.surface(0) +
        io +
        `@compute @workgroup_size(1) fn probe(@builtin(workgroup_id) g:vec3u) {
  let n=probeItem(g); if(n>=arrayLength(&probeIn)){return;}
  let l=probeIn[n]; let o=margoTransparentAt(vec4f(0.0,0.0,0.0,l.x),vec4f(0.0),l.y);
  probeOut[n*2u]=o.moments; probeOut[n*2u+1u]=o.optical;}`,
      new Float32Array(layers.flatMap(([alpha, depth]) => [alpha, depth, 0, 0])),
      layers.length,
      2,
    );
    // The sums as the targets hold them: every stored channel rounded to a half float. A channel no layer reaches stays 0.
    const stored = pass.targets[1].format === 'r16float' ? 5 : 8,
      sums = Array.from({ length: 8 }, (_, k) => {
        let sum = 0;
        for (let i = 0; i < layers.length; i++) sum += each[i * 8 + k];
        return k < stored ? Math.f16round(sum) : 0;
      }),
      moved = [...sums.keys()].filter((k) => sums[k] !== 0);
    // One half-float step either way from a value: 2^-10 of its power of two, at least the smallest normal's.
    const step = (v) => 2 ** (Math.max(Math.floor(Math.log2(Math.abs(v))), -14) - 10);
    const variants = [];
    for (let n = 0; n < 3 ** moved.length; n++) {
      const v = sums.slice();
      moved.forEach((k, i) => (v[k] += ((Math.floor(n / 3 ** i) % 3) - 1) * step(v[k])));
      variants.push(v);
    }
    const input = new Float32Array(variants.length * layers.length * 12);
    variants.forEach((v, n) =>
      layers.forEach(([, depth], i) => input.set([...v, depth, 0, 0, 0], (n * layers.length + i) * 12)),
    );
    // The transmittance in front of each layer, as the shading pass works it out from the stored sums.
    const t = await run(
      pass.shader.surface(0) +
        io +
        `@compute @workgroup_size(1) fn probe(@builtin(workgroup_id) g:vec3u) {
  let n=probeItem(g); if(n*3u>=arrayLength(&probeIn)){return;}
  probeOut[n]=vec4f(exp(-margoInFront(probeIn[n*3u],probeIn[n*3u+1u],margoWarp(probeIn[n*3u+2u].x))));}`,
      input,
      variants.length * layers.length,
      1,
    );
    uniform.destroy();
    return layers.map((_, i) => {
      const all = variants.map((_, n) => t[(n * layers.length + i) * 4]);
      return [Math.min(...all), Math.max(...all)];
    });
  },
  // Draws until the list has read back its count and grown, as it does over a few frames of a running scene.
  settle: () => waitForPipelines(draw, { ready: () => pass.stats.fragments > 0 && !pass.stats.dropped }),
  shot: () => canvas.toDataURL('image/png'),
};
window.ready = true;
