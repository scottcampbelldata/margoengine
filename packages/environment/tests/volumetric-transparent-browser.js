// Real-GPU checks for fogged transparents (`VolumetricFog.add`, @margoengine/environment/volumetric): the hook's
// margoTransparentAt, compiled from the fog's own declarations and bound to its live uniform and integrated volume,
// equals a CPU mirror (unproject the fragment, read the volume where the composite would, c T + L with the display
// transform) at froxel centres across the grid; a skipped frame passes colours through; and a transparent drawable
// added to a fog in a real engine draws in the fog's pass with no GPU error and leaves it when removed.
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { VolumetricFog } from '../dist/volumetric.js';
import { pbrNeutral } from '../../shared/display.js';
import { assert, hardware, invert, readTexture } from './gpu-read.js';

const grid = [16, 12, 32],
  range = 40;
const srgb = (x) => (x >= 0.0031308 ? 1.055 * x ** (1 / 2.4) - 0.055 : x * 12.92);
const mul = (m, v) => [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);

window.runTests = async () => {
  const report = { checks: [] };
  const canvas = document.querySelector('#scene');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 1, 6], target: [0, 1, 0], fov: 60, near: 0.1, far: 100 },
  });
  const runtime = engineRuntime(engine),
    device = runtime.gpu,
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  runtime.lighting.direction.set([0, 1, 0, 0]);
  runtime.lighting.radiance.set([0, 0, 0, 0]);
  const depth = device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const fog = VolumetricFog.attach(engine, {
    density: 0.08,
    heightFalloff: 0.3,
    color: [1, 0.8, 0.6],
    ambient: [1.5, 1.5, 1.6],
    anisotropy: 0,
    temporal: 0,
    grid,
    range,
    depth: () => depth,
  });

  // A real transparent drawable through the hook: a full-screen triangle of one colour at reversed-Z depth 0.5.
  let pipeline,
    draws = 0;
  const effect = {
    setTransparency: (hook, released) => {
      effect.hook = hook;
      effect.released = released;
      return () => (effect.hook = undefined);
    },
    drawTransparent(c, hook) {
      if (!pipeline) {
        const module = device.createShaderModule({
          code: `${hook.surface(0)}
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0.5,1);}
@fragment fn transparent(@builtin(position) p:vec4f)->MargoTransparent {return margoTransparentAt(vec4f(0.2,0.4,0.9,0.5),p,0.0);}`,
        });
        pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'transparent', targets: [...hook.targets] },
          depthStencil: { format: c.descriptor.depthStencil.format, depthWriteEnabled: false, depthCompare: 'always' },
          multisample: { count: c.descriptor.multisample?.count ?? 1 },
        });
      }
      const pass = hook.begin();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: hook.bindings() }),
      );
      pass.draw(3);
      draws++;
    },
  };
  const remove = fog.add(effect);
  engine.render();
  await device.queue.onSubmittedWorkDone();
  assert(errors.length === 0 && draws === 1, `real engine: ${draws} draws, errors ${errors.join('; ')}`);
  report.checks.push('a transparent drawable added to the fog draws in its pass in a real engine with no GPU error');

  // 1. margoTransparentAt against the CPU mirror, through the fog's own bindings (uniform, volume, sampler).
  const volume = await readTexture(device, fog.texture),
    m = engine.camera.matrix,
    inverse = invert(m, new Float64Array(16)),
    unproject = (x, y, z) => {
      const p = mul(inverse, [x, y, z, 1]);
      return [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
    },
    w = Math.hypot(m[3] - m[2], m[7] - m[6], m[11] - m[10]),
    plane = [0, 1, 2, 3].map((i) => (m[i * 4 + 3] - m[i * 4 + 2]) / w);
  const inputs = [],
    want = [];
  let seed = 7;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  for (let k = 3; k < grid[2]; k += 4)
    for (let j = 1; j < grid[1]; j += 3)
      for (let i = 0; i < grid[0]; i += 3) {
        // The far edge of slice k at froxel (i, j)'s centre: where the integrated volume stores texel (i, j, k).
        const u = (i + 0.5) / grid[0],
          v = (j + 0.5) / grid[1],
          ndc = [u * 2 - 1, 1 - v * 2],
          n = unproject(ndc[0], ndc[1], 1),
          d = unproject(ndc[0], ndc[1], 0.5).map((x, a) => x - n[a]),
          t = range * ((k + 1) / grid[2]) ** 2,
          s = t / (d[0] * plane[0] + d[1] * plane[1] + d[2] * plane[2]),
          clip = mul(m, [n[0] + d[0] * s, n[1] + d[1] * s, n[2] + d[2] * s, 1]),
          color = [random(), random(), random(), random()];
        inputs.push(...color, u * canvas.width, v * canvas.height, clip[2] / clip[3], 1);
        const [r, g, b, a] = volume.at(k, i, j),
          opacity = 1 - Math.exp(-a),
          light =
            opacity > 0
              ? pbrNeutral([r / opacity, g / opacity, b / opacity]).map((x) => srgb(Math.max(0, x)) * opacity)
              : [r, g, b];
        want.push(...color.slice(0, 3).map((x, c) => x * (1 - opacity) + light[c]), color[3]);
      }
  const count = want.length / 4;
  const run = async () => {
    const module = device.createShaderModule({
      code: `${fog.surface(0)}
@group(1) @binding(0) var<storage,read> inputs:array<vec4f>;
@group(1) @binding(1) var<storage,read_write> outputs:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=arrayLength(&outputs)){return;} outputs[id.x]=margoTransparentAt(inputs[2*id.x],inputs[2*id.x+1],0.0).color;
}`,
    });
    const compute = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
      input = device.createBuffer({ size: inputs.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      output = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      read = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    device.queue.writeBuffer(input, 0, new Float32Array(inputs));
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(compute);
    pass.setBindGroup(0, device.createBindGroup({ layout: compute.getBindGroupLayout(0), entries: fog.bindings() }));
    pass.setBindGroup(
      1,
      device.createBindGroup({
        layout: compute.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(count / 64));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, read, 0, count * 16);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const got = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    for (const b of [input, output, read]) b.destroy();
    return got;
  };
  let got = await run(),
    worst = 0,
    fogged = 0;
  for (let i = 0; i < want.length; i++) {
    worst = Math.max(worst, Math.abs(got[i] - want[i]));
    if (i % 4 !== 3) fogged = Math.max(fogged, Math.abs(want[i] - inputs[(i >> 2) * 8 + (i % 4)]));
  }
  report.samples = count;
  report.worst = worst;
  report.fogMoved = fogged;
  // f32 unprojection puts the lookup within about 1e-4 of a slice centre; across a slice the volume changes by under
  // 0.05, so the interpolation costs under 1e-5, below the 8-bit output step the fog is drawn into (1 / 255).
  assert(fogged > 0.1, `the fog changes the colours by ${fogged}`);
  assert(worst < 1e-3, `margoTransparentAt differs from the CPU mirror by ${worst}`);
  report.checks.push(`margoTransparentAt equals the CPU mirror at ${count} froxel centres within 1e-3`);

  // 2. A frame the fog skips: colours pass through unchanged.
  fog.options.enabled = false;
  engine.render();
  got = await run();
  let through = 0;
  for (let i = 0; i < count * 4; i++)
    through = Math.max(through, Math.abs(got[i] - Math.fround(inputs[(i >> 2) * 8 + (i % 4)])));
  // The inputs reach the GPU as f32: compared after the same rounding, they must come back bit for bit.
  assert(through === 0, `a skipped frame changes colours by ${through}`);
  report.checks.push('a frame the fog skips passes colours through exactly');
  fog.options.enabled = true;

  remove();
  engine.render();
  await device.queue.onSubmittedWorkDone();
  assert(draws === 2 && effect.hook === undefined && errors.length === 0, `after remove: ${draws} draws, ${errors}`);
  report.checks.push('the remover gives the draw back');

  // 3. Multiple scattering (`multipleScattering`): uniform white-lit fog, no shadows, isotropic phase. Each froxel's
  // source per unit extinction is albedo * (ambient + sun / 4 pi) / (1 - f) with f = min(albedo (1 - exp(-sigma R)),
  // 0.95), and the integration telescopes, so the stored light is that times 1 - exp(-optical depth) in every froxel.
  runtime.lighting.direction.set([0.3, 0.8, 0.5, 1]);
  runtime.lighting.radiance.set([2, 1.8, 1.6, 0]);
  Object.assign(fog.options, { heightFalloff: 0, anisotropy: 0, temporal: 0 });
  const sigma = fog.options.density,
    albedo = fog.options.color,
    ambient = fog.options.ambient,
    sunColor = [2, 1.8, 1.6];
  const scattered = async (distance) => {
    fog.options.multipleScattering = distance;
    engine.render();
    await device.queue.onSubmittedWorkDone();
    const read = await readTexture(device, fog.texture),
      f = albedo.map((c) => Math.min(c * (1 - Math.exp(-sigma * distance)), 0.95));
    let worst = 0;
    for (let k = 0; k < grid[2]; k++)
      for (let j = 0; j < grid[1]; j++)
        for (let i = 0; i < grid[0]; i++) {
          const texel = read.at(k, i, j),
            opacity = 1 - Math.exp(-texel[3]);
          for (let c = 0; c < 3; c++) {
            const expected = ((albedo[c] * (ambient[c] + sunColor[c] / (4 * Math.PI))) / (1 - f[c])) * opacity;
            worst = Math.max(worst, Math.abs(texel[c] - expected) / expected);
          }
        }
    return { read, worst, f };
  };
  const single = await scattered(0),
    thick = await scattered(25);
  // rgba16float keeps 11 significant bits (relative step 4.9e-4): the froxel source, its extinction and the stored sum
  // are each rounded once, and the optical depth the check reads back once more, so four steps bound it (under 2e-3).
  assert(single.worst < 2e-3, `single scattering differs from the closed form by ${single.worst}`);
  assert(thick.worst < 2e-3, `multiple scattering differs from the closed form by ${thick.worst}`);
  const near = single.read.at(grid[2] - 1, 8, 6),
    far = thick.read.at(grid[2] - 1, 8, 6),
    gain = [0, 1, 2].map((c) => far[c] / near[c]);
  assert(
    gain.every((g, c) => Math.abs(g - 1 / (1 - thick.f[c])) < 2e-3 * g) && Math.min(...gain) > 2,
    `multiple scattering brightens thick fog by ${gain}, f ${thick.f}`,
  );
  report.multipleScattering = { singleWorst: single.worst, multipleWorst: thick.worst, gain };
  report.checks.push(
    `multiple scattering matches the closed form albedo (ambient + sun / 4 pi) / (1 - f) in all ${grid.join(' x ')} froxels within 2e-3 and brightens thick fog ${gain.map((g) => g.toFixed(2)).join(', ')} times`,
  );
  fog.options.multipleScattering = 0;
  engine.render();
  await device.queue.onSubmittedWorkDone();
  assert(errors.length === 0, `multiple scattering: GPU errors ${errors.join('; ')}`);
  report.hardware = hardware(runtime.adapter ?? (await navigator.gpu.requestAdapter()));
  fog.dispose();
  engine.dispose();
  return report;
};
