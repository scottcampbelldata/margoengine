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
import { SplatBrush } from '../../dist/brush.js';
import { SplatPicking } from '../../dist/pick.js';
import { Picking } from '../../../selection/dist/index.js';
import { SplatSequence, SplatSkin } from '../../dist/animate.js';
import { loadProgressiveSplats } from '../../dist/progressive.js';
import { parseKsplat, encodePly } from '../../dist/formats.js';
import { loadStreamedSog } from '../../dist/lod-sog.js';
import { encodeSog } from '../../dist/data.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
let engine,
  canvas,
  extras = [];
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
                vertex: {
                  module,
                  entryPoint: 'v',
                  buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
                },
                fragment: { module, entryPoint: 'f', targets: [{ format: c.format }] },
                primitive: { topology: 'triangle-strip' },
                multisample: c.descriptor.multisample,
                depthStencil: {
                  format: c.descriptor.depthStencil.format,
                  depthWriteEnabled: false,
                  depthCompare: 'greater-equal',
                },
              })),
            );
          const stencil = c.descriptor.depthStencil.format.includes('stencil'),
            pass = c.encoder.beginRenderPass({
              colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
              depthStencilAttachment: {
                view: c.depth,
                depthReadOnly: true,
                ...(stencil ? { stencilReadOnly: true } : {}),
              },
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
      data =
        o.ksplat === undefined
          ? await loadCapture()
          : parseKsplat(await (await fetch(`/packages/splats/test/fixtures/raccoon-${o.ksplat}.ksplat`)).arrayBuffer());
      if (o.plyExport) data = parsePly(encodePly(data));
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
      const wall = createMesh(
        engine,
        planeGeometry(1.6, 1.6),
        new Material({ shading: 'basic', color: [0.4, 0.4, 0.4] }),
      );
      wall.root.setPosition([0, 0, o.before]);
    }
    const cloud = o.none ? undefined : Splats.attach(engine, data);
    const depth =
      o.depth && cloud
        ? SplatDepth.attach(engine, cloud, o.threshold === undefined ? {} : { threshold: o.threshold })
        : undefined;
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
        for (let a = 0; a < 4; a++)
          for (let b = 0; b < 4; b++) children.push(make(x0 + a * step, z0 + b * step, step, level + 1));
      }
      nodes[at] = {
        center: [x0 + size / 2, 0, z0 + size / 2],
        radius: (size / 2) * Math.SQRT2,
        error: level < 2 ? size / 64 : 0,
        count: level < 2 ? 4096 : per,
        children,
      };
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
    if (o.streamed) {
      const archive = await encodeSog(data),
        view = new DataView(archive.buffer),
        files = new Map();
      for (let p = 0; view.getUint32(p, true) === 0x04034b50; ) {
        const size = view.getUint32(p + 18, true),
          length = view.getUint16(p + 26, true),
          extra = view.getUint16(p + 28, true),
          name = new TextDecoder().decode(archive.subarray(p + 30, p + 30 + length)),
          start = p + 30 + length + extra;
        files.set(name, archive.slice(start, start + size));
        p = start + size;
      }
      const half = Math.floor(n / 2),
        bound = { min: [-100, -100, -100], max: [100, 100, 100] },
        leaf = (offset, count) => ({
          bound,
          lods: { 0: { file: 0, offset, count }, 1: { file: 1, offset, count } },
          errors: [0, 1],
        }),
        manifest = {
          version: 1,
          lodLevels: 2,
          lodErrors: true,
          filenames: ['fine/meta.json', 'coarse/meta.json'],
          tree: { bound, children: [leaf(0, half), leaf(half, n - half)] },
        };
      source = await loadStreamedSog('https://sog.local/lod-meta.json', {
        fetch: async (url) => {
          const name = new URL(url).pathname.split('/').at(-1);
          return new Response(name === 'lod-meta.json' ? JSON.stringify(manifest) : files.get(name));
        },
      });
    }
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
      data = {
        positions: new Float32Array(n * 3),
        covariances: new Float32Array(n * 6),
        colors: new Float32Array(n * 4),
      },
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
window.check.sogV3 = async () => {
  engine?.dispose();
  canvas?.remove();
  globalThis.margoLow = 1;
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'width:128px;height:128px';
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    preserveDrawingBuffer: true,
    camera: { position: [0, 0, 3], target: [0, 0, 0] },
  });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const sh = new Float32Array(75);
  sh[20 * 3] = 0.2;
  const cloud = Splats.attach(engine, {
    positions: new Float32Array(3),
    covariances: new Float32Array([0.02, 0, 0, 0.02, 0, 0.02]),
    colors: new Float32Array([0.5, 0.5, 0.5, 1.5625]),
    sphericalHarmonics: sh,
  });
  await waitForPipelines(draw);
  const staging = engine.gpu.createBuffer({ size: 48, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    encoder = engine.gpu.createCommandEncoder();
  encoder.copyBufferToBuffer(cloud.gpuState.colors, 0, staging, 0, 16);
  encoder.copyBufferToBuffer(cloud.gpuState.ellipses, 0, staging, 16, 32);
  engine.gpu.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const values = [...new Float32Array(staging.getMappedRange())];
  staging.destroy();
  return values;
};
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
    tint = {
      ...a,
      colors: a.colors.map((v, i) => (i % 4 === 3 ? v : i % 4 === 1 ? Math.min(1, v * 1.5 + 0.2) : v * 0.3)),
    },
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
    const set = SplatSet.attach(engine, {
      capacity: 3 * n,
      coefficients: a.sphericalHarmonics ? a.sphericalHarmonics.length / n / 3 : 0,
    });
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
    for (const [k, r, c] of [
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 2],
      [3, 1, 1],
      [4, 1, 2],
      [5, 2, 2],
    ])
      covariances[i * 6 + k] = (r === c ? 0.01 : 0) - (0.01 - 1e-6) * nv[r] * nv[c];
    colors.set([0.2 + 0.1 * (i % 3), 0.5, 0.8 - 0.05 * i, 0.9], i * 4);
  });
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 3], target: [0, 0, 0], near: 0.05, far: 100 },
  });
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
    const a = filterSplats(full, (i) =>
      [0, 1, 2].every((k) => full.positions[i * 3 + k] >= lo[k] && full.positions[i * 3 + k] <= hi[k]),
    );
    const s = 1.2 / Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]),
      m = [
        s,
        0,
        0,
        0,
        0,
        s,
        0,
        0,
        0,
        0,
        s,
        0,
        (-s * (lo[0] + hi[0])) / 2,
        1 - (s * (lo[1] + hi[1])) / 2,
        (-s * (lo[2] + hi[2])) / 2,
        1,
      ];
    data = transformSplats(a, m);
  } else {
    const ring = [];
    for (let r = 0; r <= 0.15; r += 0.03) {
      const steps = Math.max(1, Math.round((2 * Math.PI * r) / 0.03));
      for (let t = 0; t < steps; t++)
        ring.push([r * Math.cos((t * 2 * Math.PI) / steps), r * Math.sin((t * 2 * Math.PI) / steps)]);
    }
    const count = ring.length;
    data = {
      positions: new Float32Array(count * 3),
      covariances: new Float32Array(count * 6),
      colors: new Float32Array(count * 4),
    };
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
  const shadows = Shadows.attach(engine, {
    resolution: 2048,
    filter: 'hard',
    bounds: { min: [-2, -0.1, -2], max: [2, 1.6, 2] },
  });
  shadows.add(ground, { static: true });
  const cloud = Splats.attach(engine, data);
  const lit = SplatLighting.attach(engine, cloud, { relight: false, threshold: o.threshold });
  if (o.cast) shadows.add(lit);
  await waitForPipelines(draw);
  return { url: canvas.toDataURL('image/png') };
};
// ./edit: an 8 x 8 grid of small red splats at z 0 (x and y from -0.7 to 0.7, none at 0), a blue splat in front of the
// grid splat at (0.1, 0.1) (index 64) and one behind it (65); or the real capture. Runs the brush steps of `o.steps`
// and returns each step's result, the pixel of a world point, and the image after the steps.
window.check.brush = async (o) => {
  engine?.dispose();
  canvas?.remove();
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'width:256px;height:256px;display:block';
  let data,
    camera = { position: [0, 0, 4], target: [0, 0, 0], near: 0.05, far: 100 };
  if (o.capture) {
    data = await loadCapture();
    const n = data.positions.length / 3,
      at = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) at[k] += data.positions[i * 3 + k] / n;
    camera = { position: [at[0] - 2.5, at[1], at[2]], target: at, near: 0.05, far: 100 };
  } else {
    const n = 66,
      sh = o.sh ? new Float32Array(n * 12) : undefined;
    data = {
      positions: new Float32Array(n * 3),
      covariances: new Float32Array(n * 6),
      colors: new Float32Array(n * 4),
    };
    for (let i = 0; i < n; i++) {
      const grid = i < 64,
        p = grid ? [-0.7 + (i % 8) * 0.2, -0.7 + Math.floor(i / 8) * 0.2, 0] : [0.1, 0.1, i === 64 ? 0.5 : -0.5];
      data.positions.set(p, i * 3);
      data.covariances.set([0.0009, 0, 0, 0.0009, 0, 0.0009], i * 6);
      data.colors.set(i === 64 ? [0, 0, 1, 0.95] : [1, 0, 0, 0.95], i * 4);
      // SH: DC of the same colour (c = 0.5 + 0.2820948 dc) and a band-1 term of 0.1 on every channel.
      if (sh) for (let k = 0; k < 12; k++) sh[i * 12 + k] = k < 3 ? (data.colors[i * 4 + k] - 0.5) / 0.2820948 : 0.1;
    }
    if (sh) data.sphericalHarmonics = sh;
  }
  engine = await Engine.create(canvas, { backend: 'webgpu', preserveDrawingBuffer: true, camera });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  let matrix;
  engine.use({
    name: 'matrix',
    setup() {},
    registerPasses(graph) {
      graph.add({ name: 'matrix', order: 0, execute: (c) => (matrix = c.camera.matrix.slice()) });
    },
  });
  const cloud = Splats.attach(engine, data),
    brush = SplatBrush.attach(engine, cloud);
  await waitForPipelines(draw);
  const [w, h] = brush.frame,
    pixel = (p) => {
      const c = [0, 1, 3].map((r) => matrix[r] * p[0] + matrix[4 + r] * p[1] + matrix[8 + r] * p[2] + matrix[12 + r]);
      return [((c[0] / c[2] + 1) / 2) * w, ((1 - c[1] / c[2]) / 2) * h];
    },
    out = [];
  for (const [op, ...args] of o.steps) {
    const a = args.map((v) => {
      if (v?.half) return { x: v.half === 'left' ? 0 : w / 2, y: 0, width: w / 2, height: h };
      if (!v?.world) return v;
      const [x, y] = pixel(v.world);
      return v.radius === undefined ? v.world : { x, y, radius: v.radius };
    });
    if (op === 'pick') out.push(await brush.pick(...pixel(a[0]), a[1]));
    else if (op === 'pickCentre') out.push(await brush.pick(w / 2, h / 2));
    else if (op === 'selectCentre') out.push(brush.select({ x: w / 2, y: h / 2, radius: a[0] }) === brush);
    else if (op === 'pickAt') out.push(await brush.pick(a[0], a[1]));
    else if (op === 'selection') out.push([...(await brush.selection())]);
    else if (op === 'commit') {
      const d = await brush.commit();
      out.push({ colors: [...d.colors], sh: d.sphericalHarmonics ? [...d.sphericalHarmonics] : null });
    } else if (op === 'draw') await draw();
    else if (op === 'select') out.push(brush.select(a[0], a[1]) === brush);
    else if (op === 'erase') out.push(brush.erase(a[0]) === brush);
    else if (op === 'paint') out.push(brush.paint(a[0], a[1], a[2]) === brush);
  }
  await draw();
  return {
    out,
    frame: [w, h],
    points: (o.points ?? []).map(pixel),
    input: [...data.colors],
    url: canvas.toDataURL('image/png'),
    count: cloud.count,
  };
};
// ./pick: the brush's grid (64 red splats at z 0, a blue one in front of the grid splat at (0.1, 0.1), index 64, one
// behind it, 65) with a plane mesh at z 0.25 over x and y from -0.05 to 0.45, picked through Picking. Each world point
// of `o.points` is picked with picking.pick and all of them with pickMany (a splat index, 'mesh', or -1 for nothing),
// and with engine.pick, which answers meshes ('cloud' for the stand-in). `o.erase`: the brush first erases the splat
// under the first point on the GPU.
window.check.splatPick = async (o) => {
  engine?.dispose();
  canvas?.remove();
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'width:256px;height:256px;display:block';
  const n = 66,
    data = {
      positions: new Float32Array(n * 3),
      covariances: new Float32Array(n * 6),
      colors: new Float32Array(n * 4),
    };
  for (let i = 0; i < n; i++) {
    const grid = i < 64;
    data.positions.set(
      grid ? [-0.7 + (i % 8) * 0.2, -0.7 + Math.floor(i / 8) * 0.2, 0] : [0.1, 0.1, i === 64 ? 0.5 : -0.5],
      i * 3,
    );
    data.covariances.set([0.0009, 0, 0, 0.0009, 0, 0.0009], i * 6);
    data.colors.set(i === 64 ? [0, 0, 1, 0.95] : [1, 0, 0, 0.95], i * 4);
  }
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    preserveDrawingBuffer: true,
    camera: { position: [0, 0, 4], target: [0, 0, 0], near: 0.05, far: 100 },
  });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  if (o.orthographic) CameraProjection.attach(engine).mode = 'orthographic';
  const plane = createMesh(engine, planeGeometry(0.5, 0.5), new Material({ shading: 'basic', color: [0.4, 0.4, 0.4] }));
  plane.root.setPosition([0.2, 0.2, 0.25]);
  const picking = Picking.attach(engine),
    cloud = Splats.attach(engine, data),
    overlay = SplatPicking.attach(picking, cloud, o.threshold === undefined ? {} : { threshold: o.threshold });
  let matrix;
  engine.use({
    name: 'matrix',
    setup() {},
    registerPasses(graph) {
      graph.add({ name: 'matrix', order: 0, execute: (c) => (matrix = c.camera.matrix.slice()) });
    },
  });
  await waitForPipelines(draw);
  const css = (p) => {
      const c = [0, 1, 3].map((r) => matrix[r] * p[0] + matrix[4 + r] * p[1] + matrix[8 + r] * p[2] + matrix[12 + r]);
      return [((c[0] / c[2] + 1) / 2) * canvas.clientWidth, ((1 - c[1] / c[2]) / 2) * canvas.clientHeight];
    },
    name = (hit) => {
      if (!hit) return -1;
      const splats = overlay.splatsOf(hit.mesh);
      if (!splats) return hit.splat === undefined ? 'mesh' : 'stray splat';
      return splats === cloud && hit.splats === cloud ? hit.splat : 'wrong cloud';
    },
    pixels = o.points.map(css),
    one = [];
  if (o.erase) {
    const brush = SplatBrush.attach(engine, cloud);
    await draw();
    const [w, h] = brush.frame;
    brush.select({
      x: (pixels[0][0] * w) / canvas.clientWidth,
      y: (pixels[0][1] * h) / canvas.clientHeight,
      radius: 1,
    });
    brush.erase('selection');
    await draw();
  }
  for (const [x, y] of pixels) one.push(name(await picking.pick(x, y)));
  const meshes = [];
  for (const [x, y] of pixels) {
    const mesh = await engine.pick(x, y);
    meshes.push(!mesh ? -1 : overlay.splatsOf(mesh) === cloud ? 'cloud' : 'mesh');
  }
  const many = (await picking.pickMany(pixels)).map(name);
  overlay.dispose();
  const after = [];
  for (const [x, y] of pixels) after.push(name(await picking.pick(x, y)));
  return { one, many, meshes, after };
};
// ./animate: three splats played as a two-frame sequence held at a time between the frames, or posed by a two-joint
// skin; returns the cloud read back after one drawn frame.
window.check.animate = async (o) => {
  engine?.dispose();
  canvas?.remove();
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'width:128px;height:128px;display:block';
  const frame = (dx, s, c) => ({
      positions: new Float32Array([-0.5 + dx, 0, 0, 0 + dx, 0.2, 0, 0.5 + dx, 0, 0]),
      covariances: new Float32Array([s, 0, 0, 0.001, 0, 0.001, s, 0, 0, 0.001, 0, 0.001, s, 0, 0, 0.001, 0, 0.001]),
      colors: new Float32Array([c, 0, 0, 0.9, c, 0, 0, 0.9, c, 0, 0, 0.5]),
    }),
    rest = frame(0, 0.004, 1);
  engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 3], target: [0, 0, 0] } });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const cloud = Splats.attach(engine, rest);
  if (o.sequence) {
    const sequence = SplatSequence.attach(engine, cloud, [rest, frame(0.4, 0.001, 0.2)], { fps: 10 });
    sequence.playing = false;
    sequence.time = o.sequence / 10;
  } else {
    const skin = SplatSkin.attach(engine, cloud, {
      joints: 2,
      indices: [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
      weights: [1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0],
    });
    skin.matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1], 0); // joint 0: move 1 along x
    skin.matrices.set([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 16); // joint 1: 90 degrees about z
  }
  await waitForPipelines(draw);
  await draw();
  const d = await cloud.read();
  return { positions: [...d.positions], covariances: [...d.covariances], colors: [...d.colors] };
};
// Anti-aliasing: three splats on the view axis (two of variance 1e-4 at distances 3 and 23, one of 1e-2 at 3), drawn
// with `antialias` off and on; returns each splat's projected opacity (ellipse centre w) both ways.
window.check.antialias = async () => {
  engine?.dispose();
  canvas?.remove();
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'width:128px;height:128px;display:block';
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 3], target: [0, 0, 0], far: 100 },
  });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const cloud = Splats.attach(engine, {
      positions: new Float32Array([0, 0, 0, 0, 0, -20, 0, 0, 0]),
      covariances: new Float32Array([1e-4, 0, 0, 1e-4, 0, 1e-4, 1e-4, 0, 0, 1e-4, 0, 1e-4, 1e-2, 0, 0, 1e-2, 0, 1e-2]),
      colors: new Float32Array([1, 1, 1, 0.9, 1, 1, 1, 0.9, 1, 1, 1, 0.9]),
    }),
    opacities = async () => {
      await draw();
      const d = engine.gpu,
        staging = d.createBuffer({ size: 3 * 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        e = d.createCommandEncoder();
      e.copyBufferToBuffer(cloud.gpuState.ellipses, 0, staging, 0, 3 * 32);
      d.queue.submit([e.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const f = new Float32Array(staging.getMappedRange().slice(0));
      staging.destroy();
      return [f[3], f[11], f[19]];
    };
  await waitForPipelines(draw);
  const off = await opacities();
  cloud.antialias = true;
  const on = await opacities();
  return { off, on, flag: cloud.antialias };
};
window.check.progressive = async () => {
  engine?.dispose();
  canvas?.remove();
  canvas = document.body.appendChild(document.createElement('canvas'));
  canvas.style.cssText = 'width:128px;height:128px;display:block';
  engine = await Engine.create(canvas, {
    backend: 'webgpu',
    preserveDrawingBuffer: true,
    camera: { position: [0, 0, 3], target: [0, 0, 0] },
  });
  engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const bytes = new Uint8Array(await (await fetch('/packages/splats/test/fixtures/raccoon-v2.splat')).arrayBuffer());
  let early;
  async function* network() {
    yield bytes.subarray(0, 4096);
    await waitForPipelines(draw);
    early = canvas.toDataURL();
    yield bytes.subarray(4096);
  }
  const cloud = await loadProgressiveSplats(engine, network(), { format: 'splat', count: 8385 });
  await waitForPipelines(draw);
  const result = await cloud.read();
  return {
    early,
    final: canvas.toDataURL(),
    count: result.positions.length / 3,
    visible: result.colors.filter((_, i) => i % 4 === 3 && result.colors[i] > 0).length,
  };
};
window.ready = true;
