// Real-GPU checks for sphere-projected reflection probes and weighted blending (@margoengine/environment/probes):
// LightProbes' own shading declarations, compiled into a compute shader over a probe buffer holding its packed header
// and direction-coded texels (each level-0 texel stores its octahedral uv, so a sharp read returns the parallax
// direction's uv), give probeReflection equal to a CPU mirror (sphere and box fades, the far sphere hit and the box
// hit, front-to-back order or weighted normalisation) at random points and rays; and a real engine bakes and shades a
// room lit by overlapping sphere and box probes, weighted, with no GPU error.
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { LightProbes } from '../dist/probes.js';
import { assert, hardware } from './gpu-read.js';

const reflections = [
  { shape: 'sphere', position: [0, 1.5, 0], radius: 2, blend: 0.6 },
  { position: [3, 1, 0.5], min: [1, 0, -2], max: [5, 3, 2], blend: 0.5 },
  { shape: 'sphere', position: [2.5, 1, -0.5], radius: 1.2, blend: 0.4 },
];
const HEADER = 1088;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function oct(d) {
  const l = Math.max(Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]), 1e-20),
    a = d.map((x) => x / l);
  let q = [a[0], a[2]];
  if (a[1] < 0) q = [(1 - Math.abs(a[2])) * (a[0] >= 0 ? 1 : -1), (1 - Math.abs(a[0])) * (a[2] >= 0 ? 1 : -1)];
  return q.map((x) => x * 0.5 + 0.5);
}
// A sharp read of a direction-coded level: bilinear over texels holding their own centre uv.
const sharp = (uv, s) => uv.map((x) => (clamp(x * s - 0.5, 0, s - 1) + 0.5) / s);
// CPU mirror of probeReflection for the probes' stored records.
function mirror(probes, p, r, weighted, s) {
  const sum = [0, 0, 0];
  let left = 1,
    total = 0;
  const q = r.map((x) => x + (Math.abs(x) < 1e-6 ? 1e-6 : 0));
  probes.forEach((b, j) => {
    let w, hit;
    if (b.shape === 'sphere') {
      const o = p.map((x, i) => x - (b.min[i] + b.max[i]) / 2),
        R = b.radius;
      w = clamp(1 - (Math.hypot(...o) - R) / Math.max(b.blend, 1e-3), 0, 1) * (weighted ? 1 : left);
      if (w <= 0) return;
      const a = Math.max(dot(r, r), 1e-12),
        h = dot(o, r),
        t = Math.max((-h + Math.sqrt(Math.max(h * h - a * (dot(o, o) - R * R), 0))) / a, 0);
      hit = p.map((x, i) => x + r[i] * t);
    } else {
      const out = Math.max(...p.map((x, i) => Math.max(b.min[i] - x, x - b.max[i])));
      w = clamp(1 - out / Math.max(b.blend, 1e-3), 0, 1) * (weighted ? 1 : left);
      if (w <= 0) return;
      const t = Math.min(...q.map((x, i) => ((x > 0 ? b.max[i] : b.min[i]) - p[i]) / x));
      hit = p.map((x, i) => x + r[i] * Math.max(t, 0));
    }
    const d = hit.map((x, i) => x - b.position[i]),
      rad = [...sharp(oct(dot(d, d) > 1e-12 ? d : r), s), (j + 1) / 4];
    for (let c = 0; c < 3; c++) sum[c] += w * rad[c];
    if (weighted) total += w;
    else left -= w;
  });
  if (!weighted) return [...sum, 1 - left];
  return total > 1 ? [...sum.map((x) => x / total), 1] : [...sum, total];
}

window.runTests = async () => {
  const report = { checks: [] };
  const canvas = document.querySelector('#scene');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [6, 2, 4], target: [1.5, 1, 0], fov: 60 },
  });
  const runtime = engineRuntime(engine),
    device = runtime.gpu,
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

  // 1. probeReflection against the CPU mirror, both blend modes.
  const s = 16;
  let seed = 11;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const points = [];
  for (let n = 0; n < 512; n++) {
    const p = [-2.6 + random() * 8.2, -0.6 + random() * 4.2, -2.6 + random() * 5.2],
      z = random() * 2 - 1,
      phi = random() * 2 * Math.PI,
      k = Math.sqrt(1 - z * z);
    points.push(p, [k * Math.cos(phi), z, k * Math.sin(phi)]);
  }
  const outputs = {};
  for (const reflectionBlend of ['order', 'weighted']) {
    const probes = new LightProbes({ reflections, reflectionBlend, resolution: s });
    engine.use(probes);
    assert(runtime.sceneOf(probes) === runtime.scene, `${reflectionBlend}: the real scene owns the shader fixture`);
    const declarations = probes.pbr(0).declarations,
      binding = Number(/@group\(0\) @binding\((\d+)\) var<storage,read> probeData/.exec(declarations)[1]);
    // Its packed header, every probe marked baked, then level 0 of each probe direction-coded: (u, v, (j + 1) / 4).
    const bytes = new ArrayBuffer(probes.byteLength),
      header = new DataView(bytes);
    new Uint8Array(bytes).set(new Uint8Array(probes.header));
    const halves = new Float16Array(bytes, HEADER);
    probes.reflections.forEach((_, j) => {
      header.setUint32(64 + j * 64 + 60, 1, true);
      const base = probes.reflectionOffset(j);
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) halves.set([(x + 0.5) / s, (y + 0.5) / s, (j + 1) / 4, 0], (base + y * s + x) * 4);
    });
    const module = device.createShaderModule({
      code: `${declarations}
@group(1) @binding(0) var<storage,read> rays:array<vec4f>;
@group(1) @binding(1) var<storage,read_write> outputs:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  if(id.x>=arrayLength(&outputs)){return;} outputs[id.x]=probeReflection(rays[2*id.x].xyz,rays[2*id.x+1].xyz,0.0);
}`,
    });
    const count = points.length / 2,
      compute = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
      data = device.createBuffer({ size: bytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      input = device.createBuffer({ size: count * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
      output = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      read = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    device.queue.writeBuffer(data, 0, bytes);
    device.queue.writeBuffer(input, 0, new Float32Array(points.flatMap((v) => [...v, 0])));
    const encoder = device.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(compute);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: compute.getBindGroupLayout(0),
        entries: [{ binding, resource: { buffer: data } }],
      }),
    );
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
    for (const b of [data, input, output, read]) b.destroy();
    outputs[reflectionBlend] = got;
    // The CPU mirror reads f32 inputs, as the GPU does.
    const f32 = (v) => v.map(Math.fround);
    let worst = 0,
      overlapped = 0,
      spheres = 0;
    for (let n = 0; n < count; n++) {
      const p = f32(points[2 * n]),
        want = mirror(probes.reflections, p, f32(points[2 * n + 1]), reflectionBlend === 'weighted', s);
      for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(got[n * 4 + c] - want[c]));
      const inside = probes.reflections.map((b) =>
        b.shape === 'sphere'
          ? Math.hypot(...p.map((x, i) => x - b.position[i])) < b.radius
          : p.every((x, i) => x > b.min[i] && x < b.max[i]),
      );
      if (inside[0] || inside[2]) spheres++;
      if (inside.filter(Boolean).length > 1) overlapped++;
    }
    report[reflectionBlend] = { samples: count, worst, insideSpheres: spheres, overlapped };
    // f16 texels round the coded uv by under 2.5e-4; f32 against f64 maths adds under 1e-5 away from the clamps.
    assert(worst < 1e-3, `${reflectionBlend}: probeReflection differs from the CPU mirror by ${worst}`);
    assert(
      spheres > 30 && overlapped > 10,
      `${reflectionBlend}: too few samples in the spheres (${spheres}) or overlaps (${overlapped})`,
    );
    report.checks.push(`${reflectionBlend}: probeReflection equals the CPU mirror at ${count} random rays within 1e-3`);
    probes.dispose();
    assert(runtime.sceneOf(probes) === undefined, `${reflectionBlend}: disposal removes the real registration`);
  }

  // Where probes overlap, weighted blending mixes them where the order lets the first one win.
  let differ = 0;
  for (let n = 0; n < outputs.order.length / 4; n++)
    if ([0, 1, 2].some((c) => Math.abs(outputs.order[n * 4 + c] - outputs.weighted[n * 4 + c]) > 0.01)) differ++;
  report.differ = differ;
  assert(differ > 10, `weighted and order blending differ at only ${differ} rays`);
  report.checks.push(`weighted and order blending differ at ${differ} of the rays`);

  // 2. A real engine: a room lit by the same probes, weighted, baked and shaded with no GPU error.
  runtime.lighting.direction.set([0.3, 1, 0.2, 1]);
  runtime.lighting.radiance.set([2, 2, 2, 0.2]);
  const white = new PbrMaterial({ roughness: 0.2, metalness: 1, color: [0.9, 0.9, 0.9] });
  const add = (size, position) =>
    engine
      .createMesh()
      .setGeometry(box(...size))
      .setPosition(position)
      .setMaterial(white);
  add([8, 0.1, 5], [1.5, -0.05, 0]);
  add([0.6, 0.6, 0.6], [0, 0.3, 0]);
  add([0.6, 1.2, 0.6], [3, 0.6, 0.5]);
  const probes = LightProbes.attach(engine, { reflections, reflectionBlend: 'weighted', resolution: 16 });
  const frames = (n) => {
    for (let i = 0; i < n; i++) engine.render({ culling: false });
  };
  const done = probes.bake();
  frames(40);
  await done;
  frames(1);
  await device.queue.onSubmittedWorkDone();
  assert(probes.baked && errors.length === 0, `real engine: baked ${probes.baked}, errors ${errors.join('; ')}`);
  report.checks.push('a real engine bakes and shades sphere and box probes, weighted, with no GPU error');
  report.hardware = hardware(runtime.adapter ?? (await navigator.gpu.requestAdapter()));
  probes.dispose();
  engine.dispose();
  return report;
};
