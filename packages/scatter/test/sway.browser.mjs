// Real-GPU proof of KB-LOOK-TV-SHIMMER1 (bounded wind sway), on WebGPU and, with --compat, the WebGL2 compatibility
// layer. The pose functions a drawn Scatter compiles (`velocityParts().poseSource`) pose the top of a 25 m plant and of a
// 0.3 m plant every 0.05 s for 60 s, at full bend strength and wind speeds 0, 5.4, 20 and 40 m/s. Physical bars, not
// fitted to the code:
// - the top moves at most min(0.4 H, 2 m) from rest (a conifer's top moves a fraction of a metre to a metre or two in a
//   gale; Peltola et al. 1993 found the dynamic bending at most the static load's);
// - the 25 m plant's top never moves faster than 5 m/s, and its strongest sway frequency stays within 0.1 to 1 Hz
//   (measured conifer sway, Moore and Maguire 2004; Jackson et al. 2019) whatever the wind;
// - the 0.3 m plant still thrashes with the wind clock: a gale's 1 s puts its top within 1 percent of its reach of where
//   17.2 / 5.4 s of a wind with no speed does;
// - the stem keeps its length within 1 percent, and the offset is 0 at the root and grows with height.
// Before the fix the 25 m top swung 24 m at about 120 m/s and swayed at 2 Hz in a 40 m/s wind.
// Run from the repository root after building packages, through scripts/run-with-timeout.mjs.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const SAMPLES = 1200,
  STEP = 0.05;
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-game.html' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await page.evaluate(
    async ([samples, step]) => {
      const { Engine, box } = await import('/packages/core/dist/index.js');
      const { Scatter, windClockRate, swayTip } = await import('/packages/scatter/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      document.body.replaceChildren(canvas);
      const engine = await Engine.create(canvas, { camera: { position: [0, 3, 9], target: [0, 0.5, 0] } });
      engine.stop();
      const d = engine.gpu;
      // A drawn Scatter: its frame values carry the sway, and its pose source is what every pass compiles.
      const field = Scatter.attach(engine, box(0.2, 2, 0.2), { count: 4, area: [4, 4], wind: [1, 0, 1, 20] });
      await field.ready;
      engine.render({ delta: 0.5 });
      await d.queue.onSubmittedWorkDone();
      const parts = field.velocityParts();
      const frame = Array.from(parts.values.subarray(84, 88));
      const code =
        parts.poseSource +
        `
struct Probe {plant:vec4f,wind:vec4f}
@group(0) @binding(0) var<uniform> u:Probe;
@group(0) @binding(1) var<storage,read_write> out:array<vec4f>;
fn tipAt(h:f32,t:f32)->vec3f {
 let sway=vec4f(u.plant.x,u.plant.y,t,u.wind.w);let wind=vec4f(u.wind.xy,u.wind.z,t*u.wind.w);
 return scatterPose(vec3f(0,h,0),vec3f(1,0,0),vec4f(0,0,0,1),vec4f(0),vec4f(0),vec4f(0),vec3f(0,0,1e4),wind,0.0,sway).world;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=${samples}u){return;}let t=f32(id.x)*${step};let top=u.plant.x;
 var length=0.0;var last=tipAt(0.0,t);
 for(var k=1u;k<=64u;k++){let next=tipAt(top*f32(k)/64.0,t);length+=distance(next,last);last=next;}
 out[id.x]=vec4f(last.x,last.y,last.z,length);
}`;
      const module = d.createShaderModule({ code });
      const pipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const run = async (top, speed, strength = 1) => {
        const uniform = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
          out = d.createBuffer({ size: samples * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
          read = d.createBuffer({ size: samples * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        d.queue.writeBuffer(
          uniform,
          0,
          new Float32Array([top, 1.2, 0, 0, Math.SQRT1_2, Math.SQRT1_2, strength, windClockRate(speed)]),
        );
        const encoder = d.createCommandEncoder(),
          pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(
          0,
          d.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: { buffer: out } },
            ],
          }),
        );
        pass.dispatchWorkgroups(Math.ceil(samples / 64));
        pass.end();
        encoder.copyBufferToBuffer(out, 0, read, 0, samples * 16);
        d.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Float32Array(read.getMappedRange().slice(0)));
        read.unmap();
        for (const b of [uniform, out, read]) b.destroy();
        return values;
      };
      const runs = {};
      for (const top of [25, 0.3])
        for (const speed of [0, 5.4, 20, 40]) runs[`${top}:${speed}`] = await run(top, speed);
      field.dispose();
      engine.dispose();
      return { frame, rate20: windClockRate(20), runs, tips: [swayTip(25), swayTip(0.3)] };
    },
    [SAMPLES, STEP],
  );
  // The frame values: the box's top (1), the 1.2 m reach, the calm clock (0.5 s) and the clock rate of 20 m/s.
  assert.deepEqual(result.frame, [1, 1.2, 0.5, result.rate20].map(Math.fround));
  const offset = (s, i) => Math.hypot(s[i * 4], s[i * 4 + 2]);
  const peakHz = (s) => {
    let best = 0,
      at = 0;
    const n = s.length / 4,
      x = Array.from({ length: n }, (_, i) => s[i * 4] + s[i * 4 + 2]);
    const mean = x.reduce((a, b) => a + b, 0) / n;
    for (let k = 1; k < n / 2; k++) {
      let re = 0,
        im = 0;
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * k * i) / n;
        re += (x[i] - mean) * Math.cos(a);
        im -= (x[i] - mean) * Math.sin(a);
      }
      if (re * re + im * im > best) [best, at] = [re * re + im * im, k / (n * STEP)];
    }
    return at;
  };
  for (const [key, s] of Object.entries(result.runs)) {
    const top = Number(key.split(':')[0]);
    let most = 0,
      fastest = 0;
    for (let i = 0; i < SAMPLES; i++) {
      most = Math.max(most, offset(s, i));
      assert.ok(Math.abs(s[i * 4 + 3] / top - 1) < 0.01, `${key}: the stem keeps its length (${s[i * 4 + 3]} m)`);
      if (i)
        fastest = Math.max(
          fastest,
          Math.hypot(s[i * 4] - s[i * 4 - 4], s[i * 4 + 1] - s[i * 4 - 3], s[i * 4 + 2] - s[i * 4 - 2]) / STEP,
        );
    }
    assert.ok(most <= Math.min(0.4 * top, 2), `${key}: the top moves ${most} m, at most min(0.4 H, 2 m)`);
    assert.ok(most > 0.25 * result.tips[top === 25 ? 0 : 1], `${key}: the plant still sways (${most} m)`);
    if (top === 25) {
      assert.ok(fastest <= 5, `${key}: the 25 m top moves at most 5 m/s (${fastest} m/s)`);
      const hz = peakHz(s);
      assert.ok(hz >= 0.1 && hz <= 1, `${key}: the 25 m plant sways at its own 0.1 to 1 Hz (${hz} Hz)`);
    }
    console.log(`sway ${key}: top within ${most.toFixed(3)} m, fastest ${fastest.toFixed(2)} m/s`);
  }
  // The blade thrashes with the wind clock: 1 s of a 20 m/s wind (sample 20) against the same wind clock, 3.7 s, of a
  // wind with no speed, read between its samples by linear interpolation.
  const calm = result.runs['0.3:0'],
    gale = result.runs['0.3:20'],
    rate = result.rate20,
    at = rate / STEP,
    i0 = Math.floor(at),
    f = at - i0,
    calmX = calm[i0 * 4] * (1 - f) + calm[(i0 + 1) * 4] * f;
  assert.ok(
    Math.abs(gale[20 * 4] - calmX) <= 0.01 * result.tips[1],
    `the blade's top after 1 s of 20 m/s (${gale[20 * 4]}) is where 3.7 s of no speed has it (${calmX})`,
  );
  assert.deepEqual(errors, []);
} finally {
  await closeAll({ browser });
}
