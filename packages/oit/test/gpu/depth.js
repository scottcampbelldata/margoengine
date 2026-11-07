// Browser side of depth-check.mjs: a see-through plane in front of a wall, inside a PostStack, with what reads depth.
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';
import { Engine } from '../../../core/dist/index.js';
import { Material, createMesh } from '../../../materials/dist/index.js';
import { planeGeometry } from '../../../geometry/dist/index.js';
import { PostStack, FXAA } from '../../../post/dist/index.js';
import { TAA } from '../../../taa/dist/index.js';
import { DOF } from '../../../dof/dist/index.js';
import { Picking } from '../../../selection/dist/index.js';
import { OIT } from '../../dist/index.js';
import { TransparentDepth } from '../../dist/depth.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
let engine, canvas, stack, glass, taa, depth, plane, picking;
const draw = async () => {
  engine.render({ delta: 1 / 60 });
  await engine.gpu.queue.onSubmittedWorkDone();
};
/** One texel of a depth texture, through a compute pass: such a format cannot always be copied out. */
async function depthAt(texture, x, y) {
  const device = engine.gpu,
    out = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({
    code: `@group(0) @binding(0) var d:texture_depth_2d;
@group(0) @binding(1) var<storage,read_write> o:array<f32>;
@compute @workgroup_size(1) fn main(){o[0]=textureLoad(d,vec2i(${x},${y}),0);}`,
  });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
    encoder = device.createCommandEncoder(),
    pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texture.createView({ aspect: 'depth-only' }) },
        { binding: 1, resource: { buffer: out } },
      ],
    }),
  );
  pass.dispatchWorkgroups(1);
  pass.end();
  encoder.copyBufferToBuffer(out, 0, read, 0, 16);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const value = new Float32Array(read.getMappedRange())[0];
  read.unmap();
  return value;
}
/** The velocity vector at a pixel: rg16float rows copied out. */
async function velocityAt(x, y) {
  const device = engine.gpu,
    texture = taa.velocity.texture,
    read = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture, origin: [x, y] }, { buffer: read, bytesPerRow: 256 }, [1, 1]);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const bits = new Uint16Array(read.getMappedRange().slice(0, 4));
  read.unmap();
  const half = (h) => {
    const sign = h >> 15 ? -1 : 1,
      e = (h >> 10) & 31,
      f = h & 1023;
    return sign * (e ? 2 ** (e - 15) * (1 + f / 1024) : 2 ** -14 * (f / 1024));
  };
  return [half(bits[0]), half(bits[1])];
}
window.check = {
  errors,
  // {samples, opacity, solid, write, threshold, oit, motion, dof, picking}
  async build(o) {
    glass?.dispose();
    taa?.dispose();
    engine?.dispose();
    canvas?.remove();
    glass = taa = picking = undefined;
    globalThis.margoLow = o.samples === 1 ? 1 : undefined;
    canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.style.cssText = 'width:256px;height:256px;display:block';
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      preserveDrawingBuffer: true,
      camera: { position: [0, 0, 4], target: [0, 0, 0], near: 0.05, far: 100 },
    });
    engine.stop();
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    createMesh(engine, planeGeometry(8, 8), new Material({ shading: 'basic', color: [0.1, 0.1, 0.1] })).root.setPosition([
      0, 0, -1.5,
    ]);
    plane = createMesh(
      engine,
      planeGeometry(1.2, 1.2),
      new Material(
        o.solid
          ? { shading: 'basic', color: [0.9, 0.9, 0.9] }
          : { shading: 'basic', color: [0.9, 0.9, 0.9], opacity: o.opacity ?? 0.5, transparent: true },
      ),
    );
    plane.root.setPosition([0, 0, 1]);
    const dof = o.dof ? new DOF({ focalDistance: 5.5, aperture: o.dof }) : undefined;
    stack = PostStack.attach(engine, [dof ?? new FXAA()]);
    if (o.motion) taa = TAA.attach(engine, { velocityOnly: true, depth: () => stack.depthTexture });
    if (o.oit) OIT.attach(engine).add(plane);
    if (o.write) {
      glass = TransparentDepth.attach(engine, o.threshold ? { threshold: o.threshold } : {});
      glass.add(plane);
      if (o.motion) taa.add(glass.velocity(plane));
    }
    if (o.picking) {
      picking = Picking.attach(engine);
      picking.add(plane);
    }
    await waitForPipelines(draw);
    return true;
  },
  depth: () => depthAt(stack.depthTexture, 128, 128),
  // Steps the plane along x each frame and reads the vector on it.
  async move(step) {
    for (const x of [step, step * 2]) {
      plane.root.setPosition([x, 0, 1]);
      await draw();
    }
    return velocityAt(128, 128);
  },
  async pick() {
    await draw();
    const hit = await picking.pick(128, 128);
    return hit?.mesh === plane.root || hit?.model === plane;
  },
  shot: () => canvas.toDataURL('image/png'),
};
window.ready = true;
