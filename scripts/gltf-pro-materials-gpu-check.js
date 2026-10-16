// Real-adapter check of gltf-pro's extended materials (HANDOFF 5w.e/f): every feature permutation of the extended
// shader, the worst-case texture plan and the transmissive variant compile and build pipelines (all entry points) with
// shadows, clustered lights + LocalShadows and environment IBL composed (fog adds no bindings), with zero WebGPU
// validation errors; and the WGSL thin-film Fresnel and direct-light BRDF (isotropic and anisotropic, iridescence, transmission, diffuse
// transmission) match the CPU reference written from the Khronos specs (tests/support/khr-brdf.js) on the GPU.
// Run from the repository root after `npm run build:packages`, with the GPU lock held:
//   node scripts/gpu-lock.mjs run --owner=<id> -- node scripts/gltf-pro-materials-gpu-check.js
// Writes examples/package-benchmarks/results/gltf-pro-materials-gpu.json (a correctness check: no timing, no quiet gate).
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { direct, iridescentFresnel, vec } from '../tests/support/khr-brdf.js';

// Deterministic cases: a small LCG so every run checks the same inputs.
let seed = 12345;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const unitAbove = (n) => {
  for (;;) {
    const d = vec.normalize([random() * 2 - 1, random() * 2 - 1, random() * 2 - 1]);
    if (vec.dot(d, n) > 0.05) return d;
  }
};
const iridescenceCases = Array.from({ length: 64 }, () => ({
  f0: [0.02 + random() * 0.9, 0.02 + random() * 0.9, 0.02 + random() * 0.9],
  c: 0.05 + random() * 0.95,
  thickness: 50 + random() * 900,
  film: 1 + random() * 1.5,
}));
const directCases = Array.from({ length: 96 }, (_, k) => {
  const n = [0, 0, 1],
    t = vec.normalize([1, random() - 0.5, 0]),
    v = unitAbove(n),
    back = k % 4 === 3;
  const l = back ? vec.scale(unitAbove(n), -1) : unitAbove(n);
  return {
    base: [random(), random(), random()],
    metal: k % 3 === 0 ? 1 : random() * 0.3,
    roughness: 0.1 + random() * 0.85,
    f0: [0.04, 0.04, 0.04],
    transmission: k % 5 === 0 ? random() : 0,
    n,
    t: vec.normalize([t[0], t[1], 0]),
    anisotropy: k % 2 ? random() : 0,
    iridescence: { factor: k % 6 < 2 ? random() : 0, fresnel: [random(), random(), random()] },
    diffuseTransmission: { factor: k % 4 >= 2 ? random() : 0, color: [random(), random(), random()] },
    v,
    l,
  };
});

const browser = await openBrowser({ startPath: '/examples/khronos-gallery.html?model=BoxVertexColors', port: 5241 }),
  { page, hardware } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.waitForSelector('body[data-ready]', { timeout: 120000 });
  const result = await page.evaluate(
    async ({ iridescenceCases, directCases }) => {
      const shader = await import('/packages/gltf-pro/src/shader.ts'),
        { lightPBR } = await import('/packages/shared/pbr-hooks.js');
      const { Shadows } = await import('/packages/shadows/dist/index.js'),
        { Clustered } = await import('/packages/clustered/dist/index.js');
      const { LocalShadows } = await import('/packages/clustered/dist/shadows.js'),
        { EnvironmentLighting } = await import('/packages/environment/dist/index.js');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }),
        device = await adapter.requestDevice(),
        messages = [];
      device.addEventListener('uncapturederror', (event) => messages.push(event.error.message));
      const clustered = new Clustered({ grid: [4, 3, 2] });
      clustered.shadow = new LocalShadows({ lights: clustered });
      const ibl = new EnvironmentLighting({
        device,
        disposed: false,
        version: 0,
        specularView: {},
        sampler: {},
        brdfLut: {},
        shBuffer: {},
        paramsBuffer: {},
        restore: () => Promise.resolve(),
      });
      const effects = [new Shadows({ resolution: 64 }).pbr(2), clustered.pbr(2), ibl.pbr(2)];
      const variants = [];
      for (let k = 0; k < 8; k++) {
        const features = { iridescence: !!(k & 1), anisotropy: !!(k & 2), diffuseTransmission: !!(k & 4) };
        variants.push([
          'extended ' + JSON.stringify(features),
          shader.extendedShader(shader.extendedPlan([], features)),
        ]);
      }
      const all = { iridescence: true, anisotropy: true, diffuseTransmission: true };
      variants.push(
        [
          'extended worst case',
          shader.extendedShader(
            shader.extendedPlan(
              Array.from({ length: 18 }, (_, k) => ({ index: k })),
              all,
            ),
          ),
        ],
        ['transmissive', shader.transmissiveShader()],
      );
      const compiled = [];
      for (const [name, base] of variants)
        for (const lit of [false, true]) {
          const code = lit ? effects.reduce(lightPBR, base) : base,
            module = device.createShaderModule({ code });
          const info = await module.getCompilationInfo(),
            problems = info.messages
              .filter((m) => m.type === 'error')
              .map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
          const entries = [
            'fragment',
            'gbuffer',
            'ambientFragment',
            ...(code.includes('fn margoTint(') ? ['margoTint'] : []),
          ];
          device.pushErrorScope('validation');
          for (const entryPoint of entries)
            device.createRenderPipeline({
              layout: 'auto',
              vertex: {
                module,
                entryPoint: 'vertex',
                buffers: [
                  {
                    arrayStride: 80,
                    attributes: Array.from({ length: 5 }, (_, i) => ({
                      shaderLocation: i,
                      offset: i * 16,
                      format: 'float32x4',
                    })),
                  },
                ],
              },
              fragment: { module, entryPoint, targets: [{ format: 'rgba16float' }] },
              multisample: { count: 4 },
              depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
            });
          const error = await device.popErrorScope();
          compiled.push({
            name: name + (lit ? ' + shadows, clustered, LocalShadows, IBL' : ''),
            textures: (code.match(/var\s*\w+\s*:\s*texture_(?!storage)/g) ?? []).length,
            problems,
            pipeline: error?.message ?? null,
          });
        }
      // The BRDF functions on the GPU, one invocation per case.
      const surface = shader.extendedShader(shader.extendedPlan([], all)).match(/struct Surface \{[^}]*\}/)[0];
      const run = async (code, input, count) => {
        const module = device.createShaderModule({ code }),
          pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
        const data = device.createBuffer({
          size: input.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(data, 0, input);
        const out = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
          read = device.createBuffer({ size: count * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: data } },
              { binding: 1, resource: { buffer: out } },
            ],
          }),
        );
        pass.dispatchWorkgroups(count);
        pass.end();
        encoder.copyBufferToBuffer(out, 0, read, 0, count * 16);
        device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Float32Array(read.getMappedRange().slice(0)));
        read.unmap();
        return values;
      };
      const io =
        '@group(0) @binding(0) var<storage,read> input:array<f32>;\n@group(0) @binding(1) var<storage,read_write> output:array<vec4f>;\n';
      const irid = await run(
        `${io}${shader.iridescenceWgsl}@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
  let k=id.x*8; output[id.x]=vec4f(margoIridescence(vec3f(input[k],input[k+1],input[k+2]),input[k+3],input[k+4],input[k+5]),0);
}`,
        new Float32Array(iridescenceCases.flatMap((c) => [...c.f0, c.c, c.thickness, c.film, 0, 0])),
        iridescenceCases.length,
      );
      const pack = (c) => [
        ...c.base,
        c.metal,
        c.roughness,
        ...c.f0,
        c.transmission,
        ...c.n,
        ...c.t,
        c.anisotropy,
        c.iridescence.factor,
        ...c.iridescence.fresnel,
        c.diffuseTransmission.factor,
        ...c.diffuseTransmission.color,
        ...c.v,
        ...c.l,
        0,
        0,
      ];
      const directOn = (anisotropic) =>
        run(
          `${io}${surface}\n${shader.directWgsl(anisotropic)}@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
  let k=id.x*32; var s:Surface; s.base=vec4f(input[k],input[k+1],input[k+2],1); s.metal=input[k+3]; s.roughness=input[k+4]; s.f0=vec3f(input[k+5],input[k+6],input[k+7]); s.tr=input[k+8];
  s.n=vec3f(input[k+9],input[k+10],input[k+11]); s.at=vec4f(input[k+12],input[k+13],input[k+14],input[k+15]); s.ir=vec4f(input[k+17],input[k+18],input[k+19],input[k+16]);
  s.dt=vec4f(input[k+21],input[k+22],input[k+23],input[k+20]);
  output[id.x]=vec4f(margoDirect(s,vec3f(input[k+24],input[k+25],input[k+26]),vec3f(input[k+27],input[k+28],input[k+29])),0);
}`,
          new Float32Array(directCases.filter((c) => anisotropic === c.anisotropy > 0).flatMap(pack)),
          directCases.filter((c) => anisotropic === c.anisotropy > 0).length,
        );
      const directIso = await directOn(false),
        directAniso = await directOn(true);
      return { compiled, irid, directIso, directAniso, messages };
    },
    { iridescenceCases, directCases },
  );

  const worst = (gpu, cpu) =>
    cpu.reduce((m, v, i) => Math.max(m, Math.abs(gpu[i] - v) / Math.max(Math.abs(v), 0.05)), 0);
  const iridescence = worst(
    result.irid.filter((_, i) => i % 4 < 3),
    iridescenceCases.flatMap((c) => iridescentFresnel(c.f0, c.c, c.thickness, c.film)),
  );
  const groups = [false, true].map((anisotropic) => directCases.filter((c) => anisotropic === c.anisotropy > 0));
  const directError = [result.directIso, result.directAniso].map((gpu, g) =>
    worst(
      gpu.filter((_, i) => i % 4 < 3),
      groups[g].flatMap((c) => direct(c, c.v, c.l)),
    ),
  );
  const report = {
    hardware: hardware.webgpu,
    permutations: result.compiled,
    worstRelativeError: { iridescence, directIsotropic: directError[0], directAnisotropic: directError[1] },
    cases: { iridescence: iridescenceCases.length, direct: directCases.length },
    gpuErrors: result.messages,
    pageErrors: errors,
  };
  console.log(JSON.stringify(report, null, 1));
  await writeFile(
    'examples/package-benchmarks/results/gltf-pro-materials-gpu.json',
    JSON.stringify({ date: new Date().toISOString(), ...report }, null, 1) + '\n',
  );
  for (const p of result.compiled) {
    assert.deepEqual(p.problems, [], p.name);
    assert.equal(p.pipeline, null, p.name);
    assert.ok(p.textures <= 16, `${p.name}: ${p.textures} sampled textures`);
  }
  assert.deepEqual(result.messages, []);
  assert.deepEqual(errors, []);
  // f32 on the GPU against doubles: relative to max(|value|, 0.05).
  assert.ok(iridescence < 2e-3, `thin-film Fresnel differs from the spec reference by ${iridescence}`);
  assert.ok(
    directError.every((e) => e < 2e-3),
    `direct BRDF differs from the spec reference by ${directError}`,
  );
  console.log('gltf-pro extended materials: real-GPU check passed');
} finally {
  await browser.close();
}
