import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' });
const errors = [];
browser.page.on('pageerror', (e) => errors.push(e.message));
try {
  const result = await browser.page.evaluate(async () => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { invertMatrixStable } = await import('/packages/math/dist/mat4.js');
    const { underwaterOptics } = await import('/packages/water/src/underwater-optics.ts');
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 0, 0], target: [0, 0, -1], near: 0.1, far: 100 },
    });
    engine.render({ delta: 0 });
    const d = engine.gpu;
    d.pushErrorScope('validation');
    const width = 128,
      height = 96;
    const u = new Float32Array(96);
    u.set(engine.camera.matrix);
    invertMatrixStable(engine.camera.matrix, u.subarray(16, 32), new Float64Array(52));
    u.set([0, 0, width, height], 56);
    u[77] = 100;
    u[84] = 512;
    u[85] = 0.05;
    const uniform = d.createBuffer({ size: u.byteLength, usage: 72 });
    d.queue.writeBuffer(uniform, 0, u);
    const opaque = d.createTexture({ size: [width, height], format: 'rgba32float', usage: 20 });
    const depth = d.createTexture({ size: [width, height], format: 'depth32float', usage: 20 });
    const declarations = `@group(0) @binding(0) var<uniform> u:array<vec4f,24>;
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var opaque:texture_2d<f32>;
@group(0) @binding(3) var environment:texture_2d<f32>;
@group(0) @binding(4) var skySampler:sampler;
fn unproject(xy:vec2f,z:f32)->vec3f {let q=mat4x4f(u[4],u[5],u[6],u[7])*vec4f(xy,z,1);return q.xyz/q.w;}`;
    const module = d.createShaderModule({
      code:
        declarations +
        underwaterOptics +
        `
struct Ray {origin:vec4f,direction:vec4f}
@group(0) @binding(5) var<storage,read> rays:array<Ray>;
@group(0) @binding(6) var<storage,read_write> out:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x<arrayLength(&rays)){out[id.x]=trace(rays[id.x].origin.xyz,rays[id.x].direction.xyz);}}
`,
    });
    const pipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const read = async (output, encoder) => {
      const staging = d.createBuffer({ size: output.size, usage: 9 });
      encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
      d.queue.submit([encoder.finish()]);
      await staging.mapAsync(1);
      const data = new Float32Array(staging.getMappedRange().slice(0));
      staging.destroy();
      return data;
    };
    const reports = [];
    for (const [sx, sy, hole] of [
      [0, 0, false],
      [0.35, -0.2, false],
      [-0.4, 0.3, false],
      [0.2, 0.1, true],
    ]) {
      const draw = d.createShaderModule({
        code:
          declarations +
          `
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
struct Sample {@location(0) color:vec4f,@builtin(frag_depth) z:f32}
@fragment fn fragment(@builtin(position) at:vec4f)->Sample {
 let xy=at.xy/vec2f(${width},${height})*vec2f(2,-2)+vec2f(-1,1);let r=unproject(xy,0.0001);
 let t=-10.0/(r.z-(${sx})*r.x-(${sy})*r.y);let p=r*t;
 ${hole ? 'if(abs(p.x)<1.2&&abs(p.y)<1.2){discard;}' : ''}
 let clip=mat4x4f(u[0],u[1],u[2],u[3])*vec4f(p,1);
 return Sample(vec4f(at.xy/vec2f(${width},${height}),0.25,1),clip.z/clip.w);
}`,
      });
      const raster = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module: draw, entryPoint: 'vertex' },
        fragment: { module: draw, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
      });
      const rays = [],
        expected = [];
      // Analytic world-space intersections, independent of depth reconstruction and GPU tracing.
      for (const origin of [
        [0, 0, -2],
        [-2, 1, -3],
        [4, -1, -4],
      ])
        for (let y = -4; y <= 4; y++)
          for (let x = -5; x <= 5; x++) {
            const target = [x * 0.45, y * 0.35, -10 + sx * x * 0.45 + sy * y * 0.35];
            const delta = target.map((v, k) => v - origin[k]);
            const length = Math.hypot(...delta);
            const ray = delta.map((v) => v / length);
            const clip = [0, 1, 2, 3].map(
              (r) => u[r] * target[0] + u[4 + r] * target[1] + u[8 + r] * target[2] + u[12 + r],
            );
            const pixel = [((clip[0] / clip[3]) * 0.5 + 0.5) * width, ((-clip[1] / clip[3]) * 0.5 + 0.5) * height];
            if (pixel.some((v, k) => v < 2 || v >= [width - 2, height - 2][k])) continue;
            if (
              (hole && Math.abs(Math.abs(target[0]) - 1.2) < 0.2) ||
              (hole && Math.abs(Math.abs(target[1]) - 1.2) < 0.2)
            )
              continue;
            rays.push(...origin, 0, ...ray, 0);
            expected.push({ length, pixel, hit: !hole || Math.abs(target[0]) >= 1.2 || Math.abs(target[1]) >= 1.2 });
          }
      const input = d.createBuffer({ size: rays.length * 4, usage: 136 });
      d.queue.writeBuffer(input, 0, new Float32Array(rays));
      const output = d.createBuffer({ size: expected.length * 16, usage: 132 });
      const encoder = d.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: opaque.createView(), loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: {
          view: depth.createView(),
          depthLoadOp: 'clear',
          depthClearValue: 0,
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(raster);
      pass.setBindGroup(
        0,
        d.createBindGroup({
          layout: raster.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniform } }],
        }),
      );
      pass.draw(3);
      pass.end();
      const compute = encoder.beginComputePass();
      compute.setPipeline(pipeline);
      compute.setBindGroup(
        0,
        d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: depth.createView() },
            { binding: 2, resource: opaque.createView() },
            { binding: 5, resource: { buffer: input } },
            { binding: 6, resource: { buffer: output } },
          ],
        }),
      );
      compute.dispatchWorkgroups(Math.ceil(expected.length / 64));
      compute.end();
      const data = await read(output, encoder);
      let missing = 0,
        falseHits = 0,
        distanceError = 0,
        pixelError = 0;
      expected.forEach((e, i) => {
        const a = data.subarray(i * 4, i * 4 + 4);
        if (e.hit && a[3] < 0) missing++;
        else if (!e.hit && a[3] >= 0) falseHits++;
        else if (e.hit) {
          distanceError = Math.max(distanceError, Math.abs(e.length - a[3]));
          pixelError = Math.max(
            pixelError,
            Math.abs(a[0] * width - 0.5 - Math.floor(e.pixel[0])),
            Math.abs(a[1] * height - 0.5 - Math.floor(e.pixel[1])),
          );
        }
      });
      reports.push({ sx, sy, hole, rays: expected.length, missing, falseHits, distanceError, pixelError });
      input.destroy();
      output.destroy();
    }
    // Sun shaft focusing: the production sunDrift and sunFocus against rays traced in double precision. A crest
    // (h = -A x^2) is a converging lens, so 1/|J| exceeds 1 under it; a trough spreads the light.
    const focusModule = d.createShaderModule({
      code:
        declarations +
        underwaterOptics +
        `
struct Case {a:vec4f,b:vec4f,c:vec4f,sun:vec4f,step:vec4f}
@group(0) @binding(5) var<storage,read> cases:array<Case>;
@group(0) @binding(6) var<storage,read_write> out:array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x<arrayLength(&cases)){let k=cases[id.x];
 let s=sunDrift(k.a.xyz,k.sun.xyz,k.sun.w);out[id.x]=vec4f(s,sunFocus(s,sunDrift(k.b.xyz,k.sun.xyz,k.sun.w),sunDrift(k.c.xyz,k.sun.xyz,k.sun.w),k.step.x,k.step.y),0);}}
`,
    });
    const focusPipeline = d.createComputePipeline({ layout: 'auto', compute: { module: focusModule, entryPoint: 'main' } });
    const unit = (v) => v.map((x) => x / Math.hypot(...v));
    const drift = (n, toSun, ior) => {
      const i = toSun.map((x) => -x),
        eta = 1 / ior,
        c = -(n[0] * i[0] + n[1] * i[1] + n[2] * i[2]),
        k = 1 - eta * eta * (1 - c * c);
      const t = k < 0 ? [0, -1, 0] : unit(i.map((x, j) => eta * x + (eta * c - Math.sqrt(k)) * n[j]));
      return [t[0] / Math.max(-t[1], 0.05), t[2] / Math.max(-t[1], 0.05)];
    };
    const cases = [],
      truth = [];
    for (const [A, toSun] of [
      [0.2, [0, 1, 0]],
      [-0.2, [0, 1, 0]],
      [0.15, unit([0.3, 1, 0.2])],
      [-0.1, unit([-0.4, 1, 0.1])],
    ])
      for (const x of [-0.5, 0, 0.75])
        for (const z of [1, 2, 4]) {
          // Surface h(x, w) = -A (x^2 + w^2 / 2); normal (-dh/dx, 1, -dh/dw).
          const h = 0.25,
            normal = (px, pw) => unit([2 * A * px, 1, A * pw]),
            ior = 1.333;
          const a = normal(x, 0.3),
            b = normal(x + h, 0.3),
            c = normal(x, 0.3 + h);
          cases.push(...a, 0, ...b, 0, ...c, 0, ...toSun, ior, h, z, 0, 0);
          // Traced: where each ray lands at depth z, and the area ratio of the landed cell.
          const land = (n, px, pw) => {
            const s = drift(n, toSun, ior);
            return [px + z * s[0], pw + z * s[1]];
          };
          const p0 = land(a, x, 0.3),
            px = land(b, x + h, 0.3),
            pw = land(c, x, 0.3 + h);
          const j = ((px[0] - p0[0]) * (pw[1] - p0[1]) - (px[1] - p0[1]) * (pw[0] - p0[0])) / (h * h);
          truth.push({ A, x, z, focus: Math.min(1 / Math.max(Math.abs(j), 0.1), 10) });
        }
    const caseBuffer = d.createBuffer({ size: cases.length * 4, usage: 136 });
    d.queue.writeBuffer(caseBuffer, 0, new Float32Array(cases));
    const focusOut = d.createBuffer({ size: truth.length * 16, usage: 132 });
    const focusEncoder = d.createCommandEncoder();
    const focusPass = focusEncoder.beginComputePass();
    focusPass.setPipeline(focusPipeline);
    focusPass.setBindGroup(
      0,
      d.createBindGroup({
        layout: focusPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 5, resource: { buffer: caseBuffer } },
          { binding: 6, resource: { buffer: focusOut } },
        ],
      }),
    );
    focusPass.dispatchWorkgroups(Math.ceil(truth.length / 64));
    focusPass.end();
    const focusData = await read(focusOut, focusEncoder);
    let focusError = 0,
      crestUnderOne = 0,
      troughOverOne = 0;
    truth.forEach((t, i) => {
      const f = focusData[i * 4 + 2];
      focusError = Math.max(focusError, Math.abs(f - t.focus) / t.focus);
      if (t.A > 0 && f <= 1) crestUnderOne++;
      if (t.A < 0 && f >= 1) troughOverOne++;
    });
    caseBuffer.destroy();
    focusOut.destroy();
    const focus = { cases: truth.length, focusError, crestUnderOne, troughOverOne };
    const validation = await d.popErrorScope();
    engine.dispose();
    return { reports, focus, validation: validation?.message };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert.equal(result.validation, undefined);
  for (const r of result.reports) {
    assert.equal(r.missing, 0, JSON.stringify(r));
    assert.equal(r.falseHits, 0, JSON.stringify(r));
    assert.ok(r.distanceError < 0.001, JSON.stringify(r));
    assert.ok(r.pixelError <= 1, JSON.stringify(r));
  }
  assert.ok(result.focus.focusError < 1e-4, `sun focus matches traced rays: ${JSON.stringify(result.focus)}`);
  assert.equal(result.focus.crestUnderOne, 0, 'a crest focuses sunlight (1/|J| > 1)');
  assert.equal(result.focus.troughOverOne, 0, 'a trough spreads sunlight (1/|J| < 1)');
  await mkdir('test-results', { recursive: true });
  await writeFile(
    `test-results/water-underwater-optics-${process.argv.includes('--compat') ? 'compat' : 'webgpu'}.json`,
    JSON.stringify(result, null, 2),
  );
} finally {
  await browser.close();
}
