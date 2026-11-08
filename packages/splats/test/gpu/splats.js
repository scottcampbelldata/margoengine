// Browser side of check.mjs: a splat cloud (a synthetic red splat or a real capture) with meshes drawn before it (a
// materials plane, order 1) and after it (a test pass at order 5 that depth tests like any later mesh pass).
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';
import { Engine, box } from '../../../core/dist/index.js';
import { Material, createMesh } from '../../../materials/dist/index.js';
import { planeGeometry } from '../../../geometry/dist/index.js';
import { CameraProjection } from '../../../cameras/dist/index.js';
import { Splats } from '../../dist/index.js';
import { parsePly, transformSplats, mergeSplats, filterSplats } from '../../dist/data.js';
import { SplatSet } from '../../dist/set.js';
import { SplatLighting } from '../../dist/lighting.js';
import { Shadows } from '../../../shadows/dist/index.js';
import { SplatDepth } from '../../dist/depth.js';
import { SplatLod, buildSplatLod } from '../../dist/lod.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
let engine, canvas, extras = [];
const draw = async () => {
  engine.render({ delta: 1 / 60 });
  await engine.gpu.queue.onSubmittedWorkDone();
};
let capture;
async function loadCapture() {
  capture ??= parsePly(await (await fetch('/packages/splats/test/fixtures/raccoon-v2.ply')).arrayBuffer());
  return capture;
}
// A blue quad at world z (or, with `x`, a plane facing +x at that x) drawn at `order`, depth tested greater-equal and
// not written: what every later mesh pass does with the scene depth.
function later({ z = 0, x, size = 1.6, order = 5, color = [0, 0, 1, 1], at = [0, 0, 0] }) {
  const device = engine.gpu,
    vertices = device.createBuffer({ size: 64, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
    clip = new Float32Array(16),
    pipelines = new Map(),
    code = `@vertex fn v(@location(0) p:vec4f)->@builtin(position) vec4f {return p;}
@fragment fn f()->@location(0) vec4f {return vec4f(${color.join(',')});}`,
    module = device.createShaderModule({ code });
  const corners = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ].map(([a, b]) =>
    x === undefined ? [at[0] + a * size, at[1] + b * size, z] : [x, at[1] + a * size, at[2] + b * size],
  );
  const plugin = {
    name: 'later:' + extras.length,
    setup() {},
    registerPasses(graph) {
      graph.add({
        name: plugin.name,
        order,
        execute(c) {
          const m = c.camera.matrix;
          corners.forEach(([px, py, pz], i) => {
            for (let r = 0; r < 4; r++) clip[i * 4 + r] = m[r] * px + m[4 + r] * py + m[8 + r] * pz + m[12 + r];
          });
          device.queue.writeBuffer(vertices, 0, clip);
          const key = c.format + c.descriptor.depthStencil.format + c.descriptor.multisample?.count;
          let pipeline = pipelines.get(key);
          if (!pipeline)
            pipelines.set(
              key,
              (pipeline = device.createRenderPipeline({
                layout: 'auto',
                vertex: { module, entryPoint: 'v', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
                fragment: { module, entryPoint: 'f', targets: [{ format: c.format }] },
                primitive: { topology: 'triangle-strip' },
                multisample: c.descriptor.multisample,
                depthStencil: { format: c.descriptor.depthStencil.format, depthWriteEnabled: false, depthCompare: 'greater-equal' },
              })),
            );
          const stencil = c.descriptor.depthStencil.format.includes('stencil'),
            pass = c.encoder.beginRenderPass({
              colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
              depthStencilAttachment: { view: c.depth, depthReadOnly: true, ...(stencil ? { stencilReadOnly: true } : {}) },
            });
          pass.setPipeline(pipeline);
          pass.setVertexBuffer(0, vertices);
          pass.draw(4);
          pass.end();
        },
      });
    },
  };
  engine.use(plugin);
  extras.push(plugin);
}
window.check = {
  errors,
  // {samples, splatZ, opacity, depth, threshold, before: z, after: z, orthographic, capture, afterX, disposeDepth}
  async build(o) {
    engine?.dispose();
    canvas?.remove();
    extras = [];
    globalThis.margoLow = o.samples === 1 ? 1 : undefined;
    canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.style.cssText = 'width:256px;height:256px;display:block';
    let data,
      camera = { position: [0, 0, 4], target: [0, 0, 0], near: 0.05, far: 100 },
      at = [0, 0, 0];
    if (o.capture) {
      data = await loadCapture();
      const n = data.positions.length / 3,
        sum = [0, 0, 0];
      for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) sum[k] += data.positions[i * 3 + k];
      at = sum.map((s) => s / n);
      // The fixture is a thin slab across x: look at it along +x from 2.5 units away.
      camera = { position: [at[0] - 2.5, at[1], at[2]], target: at, near: 0.05, far: 100 };
    } else
      data = {
        positions: new Float32Array([0, 0, o.splatZ ?? 0]),
        covariances: new Float32Array([0.25, 0, 0, 0.25, 0, 0.01]),
        colors: new Float32Array([1, 0, 0, o.opacity ?? 0.95]),
      };
    engine = await Engine.create(canvas, { backend: 'webgpu', preserveDrawingBuffer: true, camera });
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    if (o.orthographic) CameraProjection.attach(engine).mode = 'orthographic';
    if (o.before !== undefined) {
      const wall = createMesh(engine, planeGeometry(1.6, 1.6), new Material({ shading: 'basic', color: [0.4, 0.4, 0.4] }));
      wall.root.setPosition([0, 0, o.before]);
    }
    const cloud = o.none ? undefined : Splats.attach(engine, data);
    const depth = o.depth && cloud ? SplatDepth.attach(engine, cloud, o.threshold === undefined ? {} : { threshold: o.threshold }) : undefined;
    if (o.after !== undefined) later({ z: o.after });
    if (o.afterX !== undefined) later({ x: at[0] + o.afterX, size: 3, at });
    if (o.disposeDepth) depth.dispose();
    if (o.disposeCloud) cloud.dispose();
    await waitForPipelines(draw);
  },
  async pixels() {
    const url = canvas.toDataURL('image/png');
    return url;
  },
};
// ./lod: a hierarchy built from the real capture, or a procedural stand-in of 16,777,216 splats streamed node by node.
const settle = async (lod) => {
  const done = lod.settled();
  let settled = false;
  done.then(() => (settled = true));
  for (let i = 0; i < 600 && !settled; i++) await draw();
  if (!settled) throw new Error('the hierarchy did not settle in 600 frames');
  await waitForPipelines(draw);
};
window.check.lod = async (o) => {
  engine?.dispose();
  canvas?.remove();
  extras = [];
  globalThis.margoLow = 1;
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'width:256px;height:256px;display:block';
  let source, camera;
  if (o.virtual) {
    // 256 leaves of 65,536 splats on a 16 x 16 grid of 4-unit tiles (y = 0), two inner levels above them; each node's
    // splats are generated when it loads.
    const nodes = [],
      side = 16,
      per = 65536;
    const make = (x0, z0, size, level) => {
      const at = nodes.length;
      nodes.push(undefined);
      const children = [];
      if (level < 2) {
        const step = size / 4;
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) children.push(make(x0 + a * step, z0 + b * step, step, level + 1));
      }
      nodes[at] = { center: [x0 + size / 2, 0, z0 + size / 2], radius: (size / 2) * Math.SQRT2, error: level < 2 ? size / 64 : 0, count: level < 2 ? 4096 : per, children };
      return at;
    };
    make(0, 0, side * 4, 0);
    source = {
      nodes,
      coefficients: 0,
      async load(index) {
        const n = nodes[index],
          count = n.count,
          grid = Math.sqrt(count),
          size = n.radius * Math.SQRT2,
          x0 = n.center[0] - size / 2,
          z0 = n.center[2] - size / 2,
          positions = new Float32Array(count * 3),
          covariances = new Float32Array(count * 6),
          colors = new Float32Array(count * 4),
          v = ((size / grid) * 0.6) ** 2;
        for (let i = 0; i < count; i++) {
          const x = x0 + ((i % grid) + 0.5) * (size / grid),
            z = z0 + (Math.floor(i / grid) + 0.5) * (size / grid);
          positions.set([x, 0, z], i * 3);
          covariances.set([v, 0, 0, v * 0.01, 0, v], i * 6);
          colors.set([0.5 + 0.5 * Math.sin(x), 0.5 + 0.5 * Math.cos(z), 0.5, 0.9], i * 4);
        }
        return { positions, covariances, colors };
      },
    };
    camera = { position: [8, 3, 8], target: [16, 0, 16], near: 0.05, far: 200 };
  } else {
    const data = await loadCapture(),
      n = data.positions.length / 3,
      sum = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) sum[k] += data.positions[i * 3 + k];
    const at = sum.map((s) => s / n);
    camera = { position: [at[0] - (o.distance ?? 2.5), at[1], at[2]], target: at, near: 0.05, far: 1000 };
    source = buildSplatLod(data, { leafSize: 1024 });
    if (o.plain) source = undefined;
    var plain = data;
  }
  engine = await Engine.create(canvas, { backend: 'webgpu', preserveDrawingBuffer: true, camera });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  if (!source) {
    Splats.attach(engine, plain);
    await waitForPipelines(draw);
    return { url: canvas.toDataURL('image/png') };
  }
  const lod = SplatLod.attach(engine, source, { budget: o.budget ?? 32768, maxError: o.maxError ?? 2 });
  await settle(lod);
  const result = {
    url: canvas.toDataURL('image/png'),
    selected: [...lod.selected],
    drawn: lod.drawn,
    total: source.nodes.reduce((s, n) => s + (n.children.length ? 0 : n.count), 0),
    leaves: lod.selected.filter((i) => !source.nodes[i].children.length).length,
    nodes: source.nodes.length,
    errors: lod.errors.map(String),
    capacity: lod.cloud.count,
  };
  if (o.reference) {
    // The pool as one plain cloud: hidden splats (as Splats.reserve makes them) with each drawn node at its placement.
    const n = lod.cloud.count,
      k = source.coefficients * 3,
      data = { positions: new Float32Array(n * 3), covariances: new Float32Array(n * 6), colors: new Float32Array(n * 4) },
      signal = new AbortController().signal;
    if (k) data.sphericalHarmonics = new Float32Array(n * k);
    for (let i = 0; i < n; i++) data.covariances[i * 6] = data.covariances[i * 6 + 3] = data.covariances[i * 6 + 5] = 1;
    for (const [node, first] of lod.placement) {
      const d = await source.load(node, signal);
      data.positions.set(d.positions, first * 3);
      data.covariances.set(d.covariances, first * 6);
      data.colors.set(d.colors, first * 4);
      if (k) data.sphericalHarmonics.set(d.sphericalHarmonics, first * k);
    }
    engine.dispose();
    canvas.remove();
    canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.style.cssText = 'width:256px;height:256px;display:block';
    engine = await Engine.create(canvas, { backend: 'webgpu', preserveDrawingBuffer: true, camera });
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    Splats.attach(engine, data);
    await waitForPipelines(draw);
    result.reference = canvas.toDataURL('image/png');
    result.coefficients = source.coefficients;
  }
  if (o.move) {
    engine.camera.position = o.move;
    await settle(lod);
    result.moved = { selected: [...lod.selected], drawn: lod.drawn, url: canvas.toDataURL('image/png') };
  }
  return result;
};
// ./set: two overlapping copies of the real capture (the second tinted green and moved 1 cm along the view) as two
// clouds, as one merged cloud, or as two members of one SplatSet.
window.check.set = async (o) => {
  engine?.dispose();
  canvas?.remove();
  extras = [];
  globalThis.margoLow = o.samples === 1 ? 1 : undefined;
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'width:256px;height:256px;display:block';
  const a = await loadCapture(),
    n = a.positions.length / 3,
    sum = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) sum[k] += a.positions[i * 3 + k];
  const at = sum.map((s) => s / n),
    move = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.01, 0.02, 0, 1],
    tint = { ...a, colors: a.colors.map((v, i) => (i % 4 === 3 ? v : i % 4 === 1 ? Math.min(1, v * 1.5 + 0.2) : v * 0.3)) },
    b = transformSplats(tint, move);
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    preserveDrawingBuffer: true,
    camera: { position: [at[0] - 2.5, at[1], at[2]], target: at, near: 0.05, far: 100 },
  });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  let info = {};
  if (o.mode === 'separate') {
    Splats.attach(engine, a);
    Splats.attach(engine, b);
  } else if (o.mode === 'merged') Splats.attach(engine, mergeSplats(a, b));
  else {
    const set = SplatSet.attach(engine, { capacity: 3 * n, coefficients: a.sphericalHarmonics ? a.sphericalHarmonics.length / n / 3 : 0 });
    // A placeholder first, removed again, so the first member goes into a freed range.
    set.add(a).remove();
    const first = set.add(a),
      second = o.moved ? set.add(tint) : set.add(b);
    if (o.moved) second.setMatrix(move);
    if (o.removed) {
      const third = set.add(b);
      third.remove();
    }
    info = { firsts: [first.first, second.first], used: set.used };
  }
  await waitForPipelines(draw);
  return { url: canvas.toDataURL('image/png'), ...info };
};
// ./lighting, relight: flat synthetic splats with known normals (and one round splat), read back after the relight
// pass, against core's diffuse terms computed in the check.
window.check.relight = async (o) => {
  engine?.dispose();
  canvas?.remove();
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'width:64px;height:64px;display:block';
  const normals = o.normals,
    n = normals.length,
    positions = new Float32Array(n * 3),
    covariances = new Float32Array(n * 6),
    colors = new Float32Array(n * 4);
  normals.forEach((nv, i) => {
    positions.set([(i % 4) * 0.3 - 0.45, Math.floor(i / 4) * 0.3 - 0.3, 0], i * 3);
    // Covariance 0.01 (I - nn^T) + 1e-6 nn^T: flat across the normal; a zero normal is a round splat.
    for (const [k, r, c] of [[0, 0, 0], [1, 0, 1], [2, 0, 2], [3, 1, 1], [4, 1, 2], [5, 2, 2]])
      covariances[i * 6 + k] = (r === c ? 0.01 : 0) - (0.01 - 1e-6) * nv[r] * nv[c];
    colors.set([0.2 + 0.1 * (i % 3), 0.5, 0.8 - 0.05 * i, 0.9], i * 4);
  });
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0], near: 0.05, far: 100 } });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  engine.lighting.direction.set(o.direction);
  engine.lighting.radiance.set(o.radiance);
  if (o.ambient) engine.lighting.ambient = new Float32Array(o.ambient);
  const cloud = Splats.attach(engine, { positions, covariances, colors });
  const lit = SplatLighting.attach(engine, cloud);
  lit.relight = o.relight ?? true;
  await waitForPipelines(draw);
  const d = engine.gpu,
    read = d.createBuffer({ size: n * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    e = d.createCommandEncoder();
  e.copyBufferToBuffer(cloud.gpuState.colors, 0, read, 0, n * 16);
  d.queue.submit([e.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const out = [...new Float32Array(read.getMappedRange())];
  read.destroy();
  return { colors: out, input: [...colors], positions: [...positions] };
};
// ./lighting, shadows: a grey ground lit by the sun and a splat cloud above it (a flat synthetic disc, or the real
// capture), seen from straight above; the sun comes in at a slant, so the cloud's shadow lands beside the cloud.
window.check.splatShadow = async (o) => {
  engine?.dispose();
  canvas?.remove();
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'width:256px;height:256px;display:block';
  let data;
  if (o.capture) {
    // The capture's 5 to 95 percent box on each axis (it has far floaters), cropped to that box and scaled to 1.2.
    const full = await loadCapture(),
      count = full.positions.length / 3,
      lo = [],
      hi = [];
    for (let k = 0; k < 3; k++) {
      const v = Array.from({ length: count }, (_, i) => full.positions[i * 3 + k]).sort((x, y) => x - y);
      lo.push(v[Math.floor(count * 0.05)]);
      hi.push(v[Math.floor(count * 0.95)]);
    }
    const a = filterSplats(full, (i) => [0, 1, 2].every((k) => full.positions[i * 3 + k] >= lo[k] && full.positions[i * 3 + k] <= hi[k]));
    const s = 1.2 / Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]),
      m = [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, (-s * (lo[0] + hi[0])) / 2, 1 - (s * (lo[1] + hi[1])) / 2, (-s * (lo[2] + hi[2])) / 2, 1];
    data = transformSplats(a, m);
  } else {
    const ring = [];
    for (let r = 0; r <= 0.15; r += 0.03) {
      const steps = Math.max(1, Math.round((2 * Math.PI * r) / 0.03));
      for (let t = 0; t < steps; t++) ring.push([r * Math.cos((t * 2 * Math.PI) / steps), r * Math.sin((t * 2 * Math.PI) / steps)]);
    }
    const count = ring.length;
    data = { positions: new Float32Array(count * 3), covariances: new Float32Array(count * 6), colors: new Float32Array(count * 4) };
    ring.forEach(([x, z], i) => {
      data.positions.set([x, 1, z], i * 3);
      data.covariances.set([0.0004, 0, 0, 1e-6, 0, 0.0004], i * 6);
      data.colors.set([0.9, 0.2, 0.2, 1], i * 4);
    });
  }
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    preserveDrawingBuffer: true,
    camera: { position: [0, 4, 0.001], target: [0, 0, 0], near: 0.05, far: 100 },
  });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  // Toward the sun: up and toward +x, so a shadow falls toward -x by 0.6 per unit of height.
  engine.lighting.direction.set([0.6, 1, 0, 3]);
  const ground = engine.createMesh().setGeometry(box()).setScale([4, 0.02, 4]).setPosition([0, -0.01, 0]);
  const shadows = Shadows.attach(engine, { resolution: 2048, filter: 'hard', bounds: { min: [-2, -0.1, -2], max: [2, 1.6, 2] } });
  shadows.add(ground, { static: true });
  const cloud = Splats.attach(engine, data);
  const lit = SplatLighting.attach(engine, cloud, { relight: false, threshold: o.threshold });
  if (o.cast) shadows.add(lit);
  await waitForPipelines(draw);
  return { url: canvas.toDataURL('image/png') };
};
window.ready = true;
