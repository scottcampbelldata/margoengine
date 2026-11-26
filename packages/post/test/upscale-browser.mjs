// Real-GPU check of SpatialUpscale, built packages (WebGPU, or the WebGL2 layer with --compat). A fixture pass draws a
// known 8-bit pattern (a vertical step, a diagonal edge, a one-texel line, a ramp) at render size inside the capture;
// the upscaled, sharpened frame must match the CPU twin (test/upscale-math.js) within 2 codes at scale 0.5 and 0.67,
// stay flat on a flat frame and stay inside the input's range at sharpen 0.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';

await postBrowser(
  'post-upscale' + (compatRun() ? '-compat' : ''),
  compatRun() ? 5535 : 5534,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js'),
        { SpatialUpscale } = await import('/packages/post/dist/upscale.js'),
        math = await import('/packages/post/test/upscale-math.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, { backend: 'webgpu' }),
        device = engine.gpu,
        uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        values = new Float32Array(4);
      // The pattern in 255ths: flat when u.x is 1, else the four features.
      const pattern = (x, y, flat) => {
        if (flat) return 90;
        if (y < 20) return x < 37 ? 30 : 220;
        if (y < 50) return x + (y - 20) < 60 ? 200 : 40;
        if (y < 80) return x === 40 ? 230 : 50;
        return Math.min(255, 20 + x);
      };
      const code = `@group(0) @binding(0) var<uniform> u:vec4f;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let x=i32(p.x);let y=i32(p.y);var v=90;
 if(u.x<0.5){if(y<20){v=select(220,30,x<37);}else if(y<50){v=select(40,200,x+(y-20)<60);}else if(y<80){v=select(50,230,x==40);}else{v=min(255,20+x);}}
 return vec4f(vec3f(f32(v)/255.0),1);
}`;
      engine.stop();
      let pipeline, group, key, size;
      engine.use({
        name: 'upscale-fixture',
        setup() {},
        registerPasses(graph) {
          graph.add({
            name: 'upscale-fixture',
            order: 30,
            execute(c) {
              if (c.backend !== 'webgpu') return;
              size = [c.width, c.height, c.format];
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
      const effect = SpatialUpscale.attach(engine);
      const expected = (flat, sharpen) => {
        const [w, h] = size,
          src = new Float32Array(w * h * 4);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const v = pattern(x, y, flat) / 255;
            src.set([v, v, v, 1], 4 * (y * w + x));
          }
        const up = math.easu(src, w, h, canvas.width, canvas.height);
        return Array.from(
          math.rcas(up, canvas.width, canvas.height, sharpen).filter((_, i) => i % 4 === 0),
          (v) => Math.round(v * 255),
        );
      };
      window.t = { engine, effect, uniform, values, device, expected, size: () => size };
    });
    const frame = async (scale, sharpen, flat) => {
      const run = await page.evaluate(
        async ([scale, sharpen, flat]) => {
          const { engine, effect, uniform, values, device } = window.t;
          Object.assign(effect.options, { scale, sharpen });
          values.set([flat ? 1 : 0, 0, 0, 0]);
          device.queue.writeBuffer(uniform, 0, values);
          engine.render({ delta: 1 / 60 });
          await device.queue.onSubmittedWorkDone();
          return { size: window.t.size(), expected: window.t.expected(flat, sharpen) };
        },
        [scale, sharpen, flat],
      );
      const img = await shot();
      let worst = 0,
        at = -1;
      for (let i = 0; i < run.expected.length; i++) {
        const d = Math.abs(img.data[4 * i] - run.expected[i]);
        if (d > worst) [worst, at] = [d, i];
      }
      const red = Array.from({ length: img.width * img.height }, (_, i) => img.data[4 * i]);
      return { worst, at, size: run.size, red, width: img.width };
    };
    const half = await frame(0.5, 0.8, false),
      third = await frame(0.67, 0.8, false),
      soft = await frame(0.5, 0, false),
      flat = await frame(0.5, 0.8, true);
    await page.evaluate(() => {
      window.t.effect.dispose();
      window.t.engine.dispose();
    });
    console.log(
      JSON.stringify({
        half: [half.worst, half.at, half.size],
        third: [third.worst, third.at, third.size],
        soft: soft.worst,
        flat: flat.worst,
      }),
    );
    assert.deepEqual(half.size.slice(0, 2), [160, 120], 'scale 0.5 renders the scene at half size');
    assert.deepEqual(third.size.slice(0, 2), [214, 161], 'scale 0.67 renders the scene at 0.67 size');
    assert.ok(!/srgb|float/.test(half.size[2]), `the check compares display-encoded values (${half.size[2]})`);
    assert.ok(half.worst <= 2, `scale 0.5 matches the CPU twin within 2 codes (${half.worst} at ${half.at})`);
    assert.ok(third.worst <= 2, `scale 0.67 matches the CPU twin within 2 codes (${third.worst} at ${third.at})`);
    assert.ok(soft.worst <= 2, `sharpen 0 matches the CPU twin within 2 codes (${soft.worst})`);
    assert.ok(
      soft.red.every((v) => v >= 20 && v <= 230),
      'sharpen 0 stays inside the input range (deringing)',
    );
    assert.ok(
      flat.red.every((v) => Math.abs(v - 90) <= 1),
      'a flat frame stays flat',
    );
    // The step at render x 36.5: output 73 (render 36.25) is sharper than bilinear, which gives 30 + 190 * 0.25 = 77.5.
    const row = 10 * half.width;
    assert.ok(half.red[row + 73] < 70, `the step's dark side stays dark (${half.red[row + 73]})`);
  },
);
