// Regression (KB6016c, 2026-11-11): core's GGX D wrote its denominator as nh^2 (a2 - 1) + 1. In float32, 1 - nh^2 sits a
// few float steps from 0 near the peak of a narrow lobe while a2 is about 1e-6 at roughness 0.03, so the rounding of nh
// alone moved D by tens of percent on smooth surfaces. The denominator is now |n x h|^2 + a2 nh^2 (the same quantity by
// the Lagrange identity, Walter et al. 2007 eq. 33), whose cross product keeps its relative precision. This suite runs
// core's own D statements, cut from packages/core/src/shaders.ts, in a compute shader on the GPU (WebGPU, and the WebGL2
// layer under MARGO_COMPAT=1) and compares them with an f64 D of the same float32 vectors.
//   node scripts/run-with-timeout.mjs -- node packages/core/tests/ggx-precision.browser.mjs
//   (or `npm run test:gpu` in packages/core)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';
import { fileURLToPath } from 'node:url';

// core's test:gpu runs in packages/core; the page and the dev server are the repository root's.
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

const source = readFileSync(new URL('../src/shaders.ts', import.meta.url), 'utf8'),
  statements = /let a2=a\*a;(.*?)let g=/s.exec(source)?.[1];
assert.ok(statements?.includes('let d='), "core's D statements are found between `let a2=a*a;` and `let g=`");

// Cases: a unit normal in a spread of directions, and a half vector tilted from it by theta, with tan^2 theta a multiple
// of a2 (inside the lobe, where D is large), all rounded to float32 as the shader receives them.
const f = Math.fround,
  cases = [];
for (const roughness of [0.03, 0.05, 0.1]) {
  const a2 = (roughness * roughness) ** 2;
  for (let k = 0; k < 64; k++) {
    const z = 1 - (2 * (k + 0.5)) / 64,
      phi = k * 2.399963,
      r = Math.sqrt(1 - z * z),
      n = [r * Math.cos(phi), r * Math.sin(phi), z];
    // A unit tangent of n.
    const t0 = Math.abs(n[2]) < 0.9 ? [-n[1], n[0], 0] : [0, -n[2], n[1]],
      tl = Math.hypot(...t0),
      t = t0.map((c) => c / tl);
    for (const spread of [0.25, 1, 4]) {
      const theta = Math.atan(Math.sqrt(spread * a2)),
        h = n.map((c, i) => Math.cos(theta) * c + Math.sin(theta) * t[i]);
      cases.push({ a2: f(a2), n: n.map(f), h: h.map(f), roughness });
    }
    // Half vectors facing away (dot(n, h) < 0, so the shader's nh is 0): D is a2 / pi there, as the nh^2 (a2 - 1) + 1
    // form gave; the bare |n x h|^2 + a2 nh^2 fell to 0 as h turned to -n.
    for (const back of [2, 2.8, 3.1]) {
      const h = n.map((c, i) => Math.cos(back) * c + Math.sin(back) * t[i]);
      cases.push({ a2: f(a2), n: n.map(f), h: h.map(f), roughness });
    }
  }
}

// f64 D of the float32 inputs: the angle between n and h from their exact cross and dot products, with the shader's
// clamp of nh to 0 where h faces away.
const reference = ({ a2, n, h }) => {
  const c = [n[1] * h[2] - n[2] * h[1], n[2] * h[0] - n[0] * h[2], n[0] * h[1] - n[1] * h[0]],
    nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2],
    hh = h[0] * h[0] + h[1] * h[1] + h[2] * h[2],
    dot = (n[0] * h[0] + n[1] * h[1] + n[2] * h[2]) / Math.sqrt(nn * hh),
    sin2 = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]) / (nn * hh),
    q = dot > 0 ? sin2 + a2 * dot * dot : 1;
  return a2 / (Math.PI * q * q);
};

const code = `@group(0) @binding(0) var<storage,read> cases:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> result:array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
  let i=id.x;if(i>=arrayLength(&result)){return;}
  let n=cases[2u*i].xyz;let a2=cases[2u*i].w;let h=cases[2u*i+1u].xyz;
  let nh=clamp(dot(n,h),0.0,1.0);
  ${statements}
  result[i]=d;
}`;

const browser = await openBrowser({ startPath: '/tests/wgsl-check.html', port: 5347 });
try {
  const data = cases.flatMap(({ a2, n, h }) => [...n, a2, ...h, 0]);
  const got = await browser.page.evaluate(
    async ({ code, data, count }) => {
      const adapter = await navigator.gpu.requestAdapter(),
        device = await adapter.requestDevice(),
        input = device.createBuffer({ size: data.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
        output = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
        read = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(input, 0, new Float32Array(data));
      const pipeline = await device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code, label: 'core-ggx-d' }), entryPoint: 'main' },
        }),
        group = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: input } },
            { binding: 1, resource: { buffer: output } },
          ],
        }),
        encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(count / 64));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, read, 0, count * 4);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const values = [...new Float32Array(read.getMappedRange())];
      device.destroy();
      return values;
    },
    { code, data, count: cases.length },
  );
  const worst = {};
  cases.forEach((c, i) => {
    const want = reference(c),
      error = Math.abs(got[i] - want) / want;
    if (!(error <= (worst[c.roughness]?.error ?? -1))) worst[c.roughness] = { error, got: got[i], want };
  });
  console.log(JSON.stringify({ worst }));
  // Float32 rounding of the cross product's components leaves about 1e-4 of D; the cancelling form was off by more
  // than 10 % at roughness 0.03.
  for (const [roughness, w] of Object.entries(worst))
    assert.ok(w.error < 0.002, `core GGX D at roughness ${roughness}: relative error ${w.error} (${w.got} vs ${w.want})`);
  console.log(`core GGX D matches f64 within 0.2 % at roughness 0.03, 0.05 and 0.1 over ${cases.length} cases`);
} finally {
  await browser.close();
}
