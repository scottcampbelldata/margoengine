// KB-SKY-ENVBELOW1 on a real GPU (run from the repository root after building packages):
//   node scripts/run-with-timeout.mjs -- node packages/sky/test/environment-below-check.mjs   (MARGO_COMPAT=1 for WebGL2)
// Under a full overcast deck the sky's reflection map (64 x 32, v from the zenith down, the horizon between rows 15 and
// 16) must hold the deck just below the horizon as it does just above, not the clear sky: the clouds were handed the
// ray below the horizon, which meets the ground, and gave back the cloudless horizon (row 16 warm and 1.6 times the
// deck's luminance). A clear day keeps its clear horizon below it, and far below it the ground's dark colour.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';


const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
const { page } = browser;
const rows = (coverage) =>
  page.evaluate(async (coverage) => {
    const { EngineKernel } = await import('/packages/core/dist/index.js');
    const { Sky } = await import('/packages/sky/dist/index.js');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:320px;height:200px';
    document.body.append(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      capacity: 4,
      camera: { position: [0, 2, 6], target: [0, 2, -18], near: 0.1, far: 300 },
    });
    const sky = Sky.attach(engine, { hours: 11, clouds: { coverage, depth: 30 } });
    void sky.reflectionTexture;
    for (let i = 0; i < 4; i++) engine.render({ delta: 1 / 30 });
    const d = engine.gpu;
    await d.queue.onSubmittedWorkDone();
    const tex = sky.reflectionTexture,
      size = tex.width * tex.height * 16,
      buf = d.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      read = d.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      module = d.createShaderModule({
        code: `@group(0) @binding(0) var t:texture_2d<f32>; @group(0) @binding(1) var<storage,read_write> o:array<vec4f>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){let s=textureDimensions(t);
if(id.x>=s.x||id.y>=s.y){return;} o[id.y*s.x+id.x]=textureLoad(t,vec2i(id.xy),0);}`,
      }),
      pipeline = d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }),
      e = d.createCommandEncoder(),
      c = e.beginComputePass();
    c.setPipeline(pipeline);
    c.setBindGroup(
      0,
      d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: { buffer: buf } },
        ],
      }),
    );
    c.dispatchWorkgroups(Math.ceil(tex.width / 8), Math.ceil(tex.height / 8));
    c.end();
    e.copyBufferToBuffer(buf, 0, read, 0, size);
    d.queue.submit([e.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(read.getMappedRange().slice(0)),
      mean = (y) => {
        const m = [0, 0, 0];
        for (let x = 0; x < tex.width; x++) for (let k = 0; k < 3; k++) m[k] += f[(y * tex.width + x) * 4 + k] / tex.width;
        return m;
      };
    const out = { width: tex.width, height: tex.height, rows: {} };
    for (let y = 0; y < tex.height; y++) out.rows[y] = mean(y);
    engine.dispose?.();
    canvas.remove();
    return out;
  }, coverage);
try {
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b,
    warmth = ([r, , b]) => r / b;
  const overcast = await rows(1),
    clear = await rows(0),
    h = overcast.height / 2;
  assert.equal(overcast.width, 64);
  const above = overcast.rows[h - 1],
    below = overcast.rows[h];
  console.log('overcast above', above.map((v) => v.toFixed(4)), 'below', below.map((v) => v.toFixed(4)));
  console.log('clear above', clear.rows[h - 1].map((v) => v.toFixed(4)), 'below', clear.rows[h].map((v) => v.toFixed(4)));
  // Just below the horizon the deck, as just above: no brighter, and no warmer than it (the clear horizon was 1.6
  // times the deck and red over blue 2.0 against 1.0).
  assert.ok(luma(below) <= luma(above) * 1.05, `overcast below ${luma(below)} brighter than above ${luma(above)}`);
  assert.ok(warmth(below) < warmth(above) * 1.1, `overcast below warmer: ${warmth(below)} against ${warmth(above)}`);
  // The clear day is unchanged in kind: its horizon below the horizon is brighter than the deck's, and far below the
  // horizon both maps hold the ground's dark colour.
  assert.ok(luma(clear.rows[h]) > luma(below), 'the clear horizon below the horizon is brighter than the deck');
  for (const map of [overcast, clear]) assert.ok(luma(map.rows[map.height - 4]) < 0.02, 'ground far below');
  console.log('environment-below-check passed');
} finally {
  await closeAll({ browser });
}
