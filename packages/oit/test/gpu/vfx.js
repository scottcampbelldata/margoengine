// Browser side of vfx-check.mjs: one red effect (particle, splat, point or sprite) and a blue glass plane before a grey
// wall, through an order-independent pass or their own draws.
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';
import { Engine } from '../../../core/dist/index.js';
import { Material, createMesh } from '../../../materials/dist/index.js';
import { planeGeometry } from '../../../geometry/dist/index.js';
import { CameraProjection } from '../../../cameras/dist/index.js';
import { DepthTexture } from '../../../post/dist/depth.js';
import { VFX } from '../../../vfx/dist/index.js';
import { Splats } from '../../../splats/dist/index.js';
import { PointsPlugin, PointCloud, SpriteBatch } from '../../../points/dist/index.js';
import { OIT } from '../../dist/index.js';
import { ExactOIT } from '../../dist/exact.js';
import { MomentOIT } from '../../dist/moments.js';
import { addEffect } from '../../dist/vfx.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const fog = { color: [0.2, 0.7, 0.2], near: 0, far: 12 };
const passes = {
  oit: () => OIT.attach(engine),
  blending: () => OIT.attach(engine, { blending: true }),
  moments: () => MomentOIT.attach(engine),
  ranged: () => MomentOIT.attach(engine, { depthRange: [3, 6] }),
  exact: () => ExactOIT.attach(engine),
};
const material = (o) => ({
  color: [1, 0, 0],
  opacity: 0.8,
  transparent: true,
  fog: !!o.fog,
  blending: o.additive ? 'additive' : 'normal',
});
const makers = {
  vfx(o, z) {
    const soft = o.soft ? DepthTexture.attach(engine) : undefined,
      effect = VFX.attach(engine, {
        capacity: 4,
        initialCount: 1,
        rate: 0,
        position: [0, 0, z],
        velocity: [0, 0, 0],
        spread: 0,
        gravity: [0, 0, 0],
        color: [1, 0, 0, 0.8],
        size: 2,
        lifetime: [1e6, 1e6],
        turbulence: 0,
        ground: -100,
        ...(o.texture
          ? { texture: { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) } }
          : {}),
        ...(soft ? { softness: 0.01, depth: () => soft.texture } : {}),
      });
    if (o.fog) effect.setFog(fog);
    return effect;
  },
  splats(o, z) {
    const zs = o.pair ? [z, z - 0.4] : [z],
      order = o.swapped ? [...zs].reverse() : zs,
      colors = order.flatMap((at) => (at === z ? [1, 0, 0, 0.8] : [0, 1, 0, 0.6])),
      effect = Splats.attach(engine, {
        positions: new Float32Array(order.flatMap((at) => [0, 0, at])),
        covariances: new Float32Array(order.flatMap(() => [0.25, 0, 0, 0.25, 0, 0.01])),
        colors: new Float32Array(colors),
      });
    if (o.fog) effect.setFog(fog);
    return effect;
  },
  cloud(o, z) {
    const effect = PointsPlugin.attach(engine);
    if (o.fog) effect.setFog(fog);
    effect.add(
      new PointCloud({
        positions: new Float32Array([0, 0, z]),
        material: { ...material(o), size: 120, shading: o.sphere ? 'sphere' : 'flat', shape: o.sphere ? 'round' : 'square' },
      }),
    );
    return effect;
  },
  sprite(o, z) {
    const effect = PointsPlugin.attach(engine);
    if (o.fog) effect.setFog(fog);
    effect.add(new SpriteBatch({ material: material(o) })).add({ position: [0, 0, z], size: 2 });
    return effect;
  },
};
let engine, canvas, pass, effect, release, probe;
const draw = async () => {
  engine.render({ delta: 1 / 60 });
  await engine.gpu.queue.onSubmittedWorkDone();
};
// A hook of the test's own: writes the view depth each effect hands the pass into a float target.
function probeDepth(target) {
  const device = engine.gpu,
    uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
  let context, encoderPass;
  const hook = {
    targets: [{ format: 'r32float' }],
    layout: [{ binding: 120, visibility: 2, buffer: {} }],
    surface: (group) => `struct MargoTransparent {@location(0) value:vec4f}
@group(${group}) @binding(120) var<uniform> margoProbe:vec4f;
fn margoTransparentAt(color:vec4f,clip:vec4f,depth:f32)->MargoTransparent {var o:MargoTransparent;o.value=vec4f(depth+margoProbe.x);return o;}
`,
    bindings: () => [{ binding: 120, resource: { buffer: uniform } }],
    begin: () =>
      (encoderPass ??= context.encoder.beginRenderPass({
        colorAttachments: [{ view: probe.createView(), clearValue: [-1, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: context.depth, depthReadOnly: true, stencilReadOnly: true },
      })),
  };
  target.setTransparency(hook);
  engine.use({
    name: 'probe',
    setup() {},
    registerPasses(graph) {
      graph.add({
        name: 'probe',
        order: 8,
        execute(c) {
          context = c;
          encoderPass = undefined;
          if (probe?.width !== c.width || probe?.height !== c.height)
            probe = device.createTexture({
              size: [c.width, c.height],
              format: 'r32float',
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            });
          target.drawTransparent(c, hook);
          encoderPass?.end();
        },
      });
    },
  });
}
window.check = {
  errors,
  // {samples, kind, mode, z, glass, fog, soft, texture, sphere, additive, pair, swapped, orthographic, probe}
  async build(o) {
    release = undefined;
    pass?.dispose();
    pass = undefined;
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
    if (o.orthographic) CameraProjection.attach(engine).mode = 'orthographic';
    const wall = createMesh(engine, planeGeometry(8, 8), new Material({ shading: 'basic', color: [0.4, 0.4, 0.4] }));
    wall.root.setPosition([0, 0, -1.5]);
    const glass =
      o.glass &&
      createMesh(
        engine,
        planeGeometry(1.6, 1.6),
        new Material({ shading: 'basic', color: [0, 0, 1], opacity: 0.5, transparent: true }),
      );
    effect = o.kind ? makers[o.kind](o, o.z ?? 0.5) : undefined;
    probe = undefined;
    if (o.probe) probeDepth(effect);
    else if (o.mode) {
      pass = passes[o.mode]();
      if (glass) pass.add(glass);
      if (effect) release = addEffect(pass, effect);
    }
    await waitForPipelines(draw);
  },
  async remove() {
    release();
    await waitForPipelines(draw);
  },
  // Disposing an effect or the pass leaves the other drawing, with no error.
  async disposeEffect() {
    effect.dispose();
    await waitForPipelines(draw);
    return pass.effects.size;
  },
  async disposePass() {
    pass.dispose();
    pass = undefined;
    await waitForPipelines(draw);
  },
  async depth() {
    const device = engine.gpu,
      read = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: probe, origin: [probe.width / 2, probe.height / 2] },
      { buffer: read, bytesPerRow: 256 },
      [1, 1],
    );
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    return new Float32Array(read.getMappedRange())[0];
  },
  shot: () => canvas.toDataURL('image/png'),
};
window.ready = true;
