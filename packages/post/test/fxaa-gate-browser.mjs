// Real-GPU check (Rust engine port R14): FXAA's edge gate is continuous. A fixture pass draws isolated dots (every
// 8th pixel) one contrast step on either side of the gate (luma 40 + 12 and 40 + 13 of 255; the gate is 0.05, 12.75
// codes) into the frame FXAA captures. With a hard gate the dots under it pass untouched and the dots over it are
// blended three quarters of the way to their surroundings, so a one-code input change moved the output by about ten
// codes. The output may now move by at most one code. A strong dot (100 codes) is still blended as before, and a flat
// frame passes unchanged.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-fxaa-gate',
  5396,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { FXAA } = await import('/packages/post/dist/fxaa.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu' }),
        device = engine.gpu,
        values = new Float32Array(4),
        uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        code = `@group(0) @binding(0) var<uniform> u:vec4f;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let q=vec2u(p.xy)%8u;let v=select(u.x,u.y,all(q==vec2u(4u)));return vec4f(vec3f(v/255.0),1);
}`;
      engine.stop();
      let pipeline, group, key;
      engine.use({
        name: 'fxaa-fixture',
        setup() {},
        registerPasses(graph) {
          graph.add({
            name: 'fxaa-fixture',
            order: 49,
            execute(c) {
              if (c.backend !== 'webgpu') return;
              const k = `${c.format}:${c.descriptor.multisample?.count ?? 1}`;
              if (key !== k) {
                key = k;
                const module = device.createShaderModule({ code });
                pipeline = device.createRenderPipeline({
                  layout: 'auto',
                  vertex: { module, entryPoint: 'vertex' },
                  fragment: { module, entryPoint: 'fragment', targets: [{ format: c.format }] },
                  multisample: c.descriptor.multisample,
                });
                group = device.createBindGroup({
                  layout: pipeline.getBindGroupLayout(0),
                  entries: [{ binding: 0, resource: { buffer: uniform } }],
                });
              }
              const pass = c.encoder.beginRenderPass({
                colorAttachments: [{ view: c.color, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
              });
              pass.setPipeline(pipeline);
              pass.setBindGroup(0, group);
              pass.draw(3);
              pass.end();
            },
          });
        },
      });
      FXAA.attach(engine);
      window.t = { engine, device, uniform, values };
    });
    const frame = async (base, dot) => {
      await page.evaluate(
        ([base, dot]) => {
          const { engine, device, uniform, values } = window.t;
          values.set([base, dot, 0, 0]);
          device.queue.writeBuffer(uniform, 0, values);
          engine.render({ delta: 1 / 60 });
          return device.queue.onSubmittedWorkDone();
        },
        [base, dot],
      );
      return shot();
    };
    const dots = (img) => {
      const out = [];
      for (let y = 4; y < img.height - 4; y += 8)
        for (let x = 4; x < img.width - 4; x += 8) out.push(img.data[4 * (y * img.width + x)]);
      return out;
    };
    const below = await frame(40, 52),
      above = await frame(40, 53),
      strong = await frame(40, 140),
      flat = await frame(40, 40);
    await page.evaluate(() => window.t.engine.dispose());
    let step = 0;
    for (let i = 0; i < below.data.length; i += 4) step = Math.max(step, Math.abs(above.data[i] - below.data[i]));
    const strongDots = dots(strong),
      flatMax = Math.max(...Array.from({ length: flat.data.length / 4 }, (_, i) => Math.abs(flat.data[4 * i] - 40)));
    const r = {
      step,
      belowDot: dots(below)[0],
      aboveDot: dots(above)[0],
      strongDot: strongDots[0],
      strongSpread: Math.max(...strongDots) - Math.min(...strongDots),
      flatMax,
    };
    console.log(JSON.stringify(r));
    assert.ok(step <= 1, `a one-code change across the gate moves the output by at most one code (${step})`);
    // Dot 140 among 40: the sub-pixel shift is 0.75, so the fetch is a quarter dot, three quarters surround: 65.
    assert.ok(Math.abs(r.strongDot - 65) <= 1 && r.strongSpread <= 1, `a strong dot is blended as before (${r.strongDot})`);
    assert.equal(flatMax, 0, 'a flat frame passes unchanged');
  },
);
