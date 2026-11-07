// Browser side of real-check.mjs: a Khronos sample model through each order-independent pass, seen from around it.
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';
import { Engine } from '../../../core/dist/index.js';
import {
  Environment,
  EnvironmentBackground,
  EnvironmentLighting,
  loadEnvironmentImage,
} from '../../../environment/dist/index.js';
import { loadGLTF } from '../../../gltf-pro/dist/index.js';
import { extendedMaterials } from '../../../gltf-pro/dist/extended.js';
import { PostStack, FXAA } from '../../../post/dist/index.js';
import { VFX } from '../../../vfx/dist/index.js';
import { OIT } from '../../dist/index.js';
import { ExactOIT } from '../../dist/exact.js';
import { MomentOIT } from '../../dist/moments.js';
import { TransparentDepth } from '../../dist/depth.js';
import { addEffect } from '../../dist/vfx.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
const passes = {
  oit: () => OIT.attach(engine),
  blending: () => OIT.attach(engine, { blending: true }),
  moments: () => MomentOIT.attach(engine),
  exact: () => ExactOIT.attach(engine),
};
let engine, canvas, pass, stack, model, centre, radius, taken;
const draw = async () => {
  engine.render({ delta: 1 / 60 });
  await engine.gpu.queue.onSubmittedWorkDone();
};
window.check = {
  errors,
  // {samples, url, mode, depth, particles}
  async build(o) {
    pass?.dispose();
    pass = undefined;
    engine?.dispose();
    canvas?.remove();
    globalThis.margoLow = o.samples === 1 ? 1 : undefined;
    canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.style.cssText = 'width:384px;height:384px;display:block';
    engine = await Engine.create(canvas, { backend: 'webgpu', preserveDrawingBuffer: true });
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const environment = await Environment.attach(
      engine,
      await loadEnvironmentImage('/examples/assets/skinning-ik-workshop.hdr'),
    );
    EnvironmentBackground.attach(engine, environment, { exposure: 1, blur: 0 });
    stack = PostStack.attach(engine, [new FXAA()]);
    model = await loadGLTF(engine, o.url, { materials: extendedMaterials });
    EnvironmentLighting.attach(engine, environment).add(model);
    const b = model.bounds;
    centre = [0, 1, 2].map((k) => (b[k] + b[k + 3]) / 2);
    radius = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
    engine.camera.near = radius / 100;
    engine.camera.far = radius * 20;
    taken = 0;
    if (o.mode) {
      pass = passes[o.mode]();
      const begin = pass.begin.bind(pass);
      pass.begin = () => {
        taken++;
        return begin();
      };
      pass.add(model);
      // A cloud of particles through the middle of the model: some in front of its parts, some behind.
      if (o.particles)
        addEffect(
          pass,
          VFX.attach(engine, {
            capacity: 64,
            initialCount: 64,
            rate: 0,
            position: centre,
            velocity: [0, 0, 0],
            spread: 0,
            gravity: [0, 0, 0],
            emissionExtent: [radius / 2, radius / 2, radius / 2],
            color: [1, 0.4, 0.1, 0.8],
            size: radius / 4,
            lifetime: [1e6, 1e6],
            turbulence: 0,
            ground: -1e6,
          }),
        );
    }
    if (o.depth) TransparentDepth.attach(engine).add(model);
    await window.check.turn(0);
    return { transparent: model.tintPrimitives.length, primitives: model.primitives.length, radius };
  },
  /** Moves the camera round the model; `taken` counts draws that reached the pass. */
  async turn(angle) {
    const a = (angle * Math.PI) / 180;
    engine.camera.target = centre;
    engine.camera.position = [
      centre[0] + Math.sin(a) * radius * 2.2,
      centre[1] + radius * 0.5,
      centre[2] + Math.cos(a) * radius * 2.2,
    ];
    await waitForPipelines(draw);
    return taken;
  },
  /** The scene depth, one float per pixel, through a compute pass: such a format cannot always be copied out. */
  async depth() {
    const device = engine.gpu,
      texture = stack.depthTexture,
      { width, height } = texture,
      size = width * height * 4,
      out = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      read = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: {
          module: device.createShaderModule({
            code: `@group(0) @binding(0) var d:texture_depth_2d;
@group(0) @binding(1) var<storage,read_write> o:array<f32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3u){
  if(g.x<${width}u&&g.y<${height}u){o[g.y*${width}u+g.x]=textureLoad(d,vec2i(g.xy),0);}
}`,
          }),
          entryPoint: 'main',
        },
      }),
      encoder = device.createCommandEncoder(),
      compute = encoder.beginComputePass();
    compute.setPipeline(pipeline);
    compute.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ aspect: 'depth-only' }) },
          { binding: 1, resource: { buffer: out } },
        ],
      }),
    );
    compute.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    compute.end();
    encoder.copyBufferToBuffer(out, 0, read, 0, size);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    return [...new Float32Array(read.getMappedRange())];
  },
  shot: () => canvas.toDataURL('image/png'),
};
window.ready = true;
