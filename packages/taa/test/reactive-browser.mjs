// Real-GPU check of TAA's reactive mask, built packages. Takes the GPU lock itself around the browser. A world-space plane
// of sine stripes 8 px across (drawn with the jittered camera, so TAA reprojects it as it would any surface) keeps the 3x3
// clamp wide open; a half-transparent white square that writes no velocity, as particles and splats do, crosses it
// 6 px a frame. Plain TAA leaves a bright trail where the square was; with the square's coverage in the reactive mask
// the trail is gone, and the square shows at once at full strength.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const release = await acquire({ owner: 'taa-reactive' });
const timer = setTimeout(() => {
  console.error('reactive-browser: timed out after 120 s');
  process.exit(1);
}, 120_000);
const server = await createServer({
  configFile: false,
  cacheDir: 'test-results/taa-reactive/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5373, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5373 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  await page.goto('http://127.0.0.1:5373/packages/taa/test/upscale-browser.html');
  await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { engineRuntime } = await import('/packages/core/dist/extension.js'),
      { TAA } = await import('/packages/taa/dist/index.js');
    document.querySelector('canvas').remove();
    const WIDTH = 320,
      HEIGHT = 240,
      SIZE = 48;
    // One rig per mode, side by side: its own canvas, engine, stripes, square and (reactive) mask.
    async function rig(id, reactive) {
      const canvas = Object.assign(document.createElement('canvas'), { id, width: WIDTH, height: HEIGHT });
      canvas.style.cssText = `display:block;width:${WIDTH}px;height:${HEIGHT}px`;
      document.body.append(canvas);
      const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 9], target: [0, 0, 0] } });
      engine.stop();
      const device = engine.gpu,
        gpuErrors = [];
      device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
      const camera = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        square = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        mask = device.createTexture({
          size: [WIDTH, HEIGHT],
          format: 'r8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
      const quad = `struct Square {rect:vec4f}
@group(0) @binding(0) var<uniform> s:Square;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let corner=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[i];
  let px=s.rect.xy+corner*s.rect.zw;return vec4f(px.x/${WIDTH}.0*2.0-1.0,1.0-px.y/${HEIGHT}.0*2.0,0,1);}`;
      const stripes = `@group(0) @binding(0) var<uniform> camera:mat4x4f;
struct Out {@builtin(position) clip:vec4f,@location(0) x:f32}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {
  let corner=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1))[i]*20.0;
  var o:Out;o.clip=camera*vec4f(corner,0,1);o.x=corner.x;return o;}
@fragment fn fragment(i:Out)->@location(0) vec4f {return vec4f(vec3f(0.4+0.38*sin(i.x*${((2 * Math.PI * HEIGHT) / 2 / Math.tan(Math.PI / 6) / 9 / 8).toFixed(5)})),1);}`;
      let pipelines;
      const make = (c) => {
        const multisample = c.descriptor.multisample,
          depthStencil = c.descriptor.depthStencil.format,
          module = (code) => device.createShaderModule({ code }),
          stripe = module(stripes),
          sq = module(quad + '\n@fragment fn fragment()->@location(0) vec4f {return vec4f(1,1,1,0.5);}'),
          cover = module(quad + '\n@fragment fn fragment()->@location(0) vec4f {return vec4f(1);}');
        const background = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: stripe, entryPoint: 'vertex' },
            fragment: { module: stripe, entryPoint: 'fragment', targets: [{ format: c.format }] },
            depthStencil: { format: depthStencil, depthWriteEnabled: true, depthCompare: 'always' },
            multisample,
          }),
          blend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: {} },
          particle = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: sq, entryPoint: 'vertex' },
            fragment: { module: sq, entryPoint: 'fragment', targets: [{ format: c.format, blend }] },
            multisample,
          }),
          coverage = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: cover, entryPoint: 'vertex' },
            fragment: { module: cover, entryPoint: 'fragment', targets: [{ format: 'r8unorm' }] },
          }),
          group = (p, buffer) =>
            device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }] });
        return {
          background,
          particle,
          coverage,
          backgroundGroup: group(background, camera),
          particleGroup: group(particle, square),
          coverageGroup: group(coverage, square),
          stencil: depthStencil.includes('stencil'),
        };
      };
      let x = 20,
        shown = false;
      engineRuntime(engine).use({
        name: 'reactive-fixture',
        setup() {},
        registerPasses(graph) {
          graph.add({
            name: 'reactive-fixture:stripes',
            order: 0.5,
            execute(c) {
              pipelines ??= make(c);
              device.queue.writeBuffer(camera, 0, new Float32Array(c.camera.matrix));
              const pass = c.encoder.beginRenderPass({
                colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
                depthStencilAttachment: {
                  view: c.depth,
                  depthLoadOp: 'load',
                  depthStoreOp: 'store',
                  ...(pipelines.stencil ? { stencilReadOnly: true } : {}),
                },
              });
              pass.setPipeline(pipelines.background);
              pass.setBindGroup(0, pipelines.backgroundGroup);
              pass.draw(6);
              pass.end();
            },
          });
          graph.add({
            name: 'reactive-fixture:square',
            order: 6,
            execute(c) {
              device.queue.writeBuffer(square, 0, new Float32Array([x, (HEIGHT - SIZE) / 2, shown ? SIZE : 0, SIZE]));
              const pass = c.encoder.beginRenderPass({
                colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }],
              });
              pass.setPipeline(pipelines.particle);
              pass.setBindGroup(0, pipelines.particleGroup);
              pass.draw(6);
              pass.end();
              const masked = c.encoder.beginRenderPass({
                colorAttachments: [{ view: mask.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
              });
              masked.setPipeline(pipelines.coverage);
              masked.setBindGroup(0, pipelines.coverageGroup);
              masked.draw(6);
              masked.end();
            },
          });
        },
      });
      TAA.attach(engine, { historyWeight: 0.9, ...(reactive ? { reactive: () => mask } : {}) });
      return {
        gpuErrors,
        async frames(n, step, show) {
          shown = show;
          for (let i = 0; i < n; i++) {
            x += step;
            engine.render({ delta: 1 / 60 });
          }
          await device.queue.onSubmittedWorkDone();
        },
      };
    }
    const rigs = { plain: await rig('plain', false), reactive: await rig('reactive', true) };
    window.t = {
      gpuErrors: () => [...rigs.plain.gpuErrors, ...rigs.reactive.gpuErrors],
      frames: (n, step, show) => Promise.all(Object.values(rigs).map((r) => r.frames(n, step, show))),
    };
  });
  const shot = async (id) => decodePNG(await page.locator('#' + id).screenshot());
  // Mean of red over the square's row band, in sRGB levels, for columns [from, to).
  const band = (image, from, to) => {
    let sum = 0,
      n = 0;
    for (let y = 96; y < 144; y++)
      for (let x = from; x < to; x++) {
        sum += image.data[(y * image.width + x) * 4];
        n++;
      }
    return sum / n;
  };

  // Converge on the stripes alone, then the square crosses: 20 frames of 6 px, from x = 20 to x = 140.
  await page.evaluate(() => window.t.frames(30, 0, false));
  const before = { plain: await shot('plain'), reactive: await shot('reactive') };
  await page.evaluate(() => window.t.frames(20, 6, true));
  const after = { plain: await shot('plain'), reactive: await shot('reactive') };
  // The trail: the 48 px the square covered over the last eight frames and has now left (x 92 to 140).
  // The square: where it is now (x 140 to 188); its half-white over the stripes is 0.5 + 0.5 * stripe in linear light.
  const report = {};
  for (const mode of ['plain', 'reactive']) {
    report[mode] = {
      trail: band(after[mode], 92, 140) - band(before[mode], 92, 140),
      square: band(after[mode], 144, 184) - band(before[mode], 144, 184),
      far: band(after[mode], 240, 300) - band(before[mode], 240, 300),
    };
  }
  console.log('mean brightening in sRGB levels', report);
  // M6 Mac mini, Metal: plain trail 19.4 levels, reactive -1.4; square 49.9 plain against 63.5 reactive. A pixel the
  // square left one frame ago keeps 0.9 of a history up to 0.27 brighter in linear light, so a plain trail of 10
  // levels or more is the ghost; a reactive pixel restarts from this frame's own sample, whose jitter error averages
  // out over the band.
  assert.ok(report.plain.trail > 10, `plain TAA leaves a trail (${report.plain.trail.toFixed(1)} levels)`);
  assert.ok(Math.abs(report.reactive.trail) < 3, `the reactive mask removes it (${report.reactive.trail.toFixed(1)})`);
  assert.ok(report.reactive.square > report.plain.square + 8, 'and the square shows at full strength at once');
  for (const mode of ['plain', 'reactive'])
    assert.ok(Math.abs(report[mode].far) < 2, `away from the square nothing changes (${mode} ${report[mode].far})`);
  assert.deepEqual(await page.evaluate(() => window.t.gpuErrors()), []);
  assert.deepEqual(errors, []);
  console.log('reactive mask check passed');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
  await release();
}
