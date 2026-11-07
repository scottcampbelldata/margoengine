// Browser side of check.mjs: a splat cloud (a synthetic red splat or a real capture) with meshes drawn before it (a
// materials plane, order 1) and after it (a test pass at order 5 that depth tests like any later mesh pass).
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';
import { Engine } from '../../../core/dist/index.js';
import { Material, createMesh } from '../../../materials/dist/index.js';
import { planeGeometry } from '../../../geometry/dist/index.js';
import { CameraProjection } from '../../../cameras/dist/index.js';
import { Splats } from '../../dist/index.js';
import { parsePly } from '../../dist/data.js';
import { SplatDepth } from '../../dist/depth.js';

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
window.ready = true;
