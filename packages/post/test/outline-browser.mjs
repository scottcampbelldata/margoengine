import { compatRun, compatShim } from '../../../scripts/support/compat-shim.js';
// Real-GPU check of Outline on a cube, built packages. Takes the GPU lock itself around the browser.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { createServer } from 'vite';
import { listenWhenFree } from '../../../scripts/browser.js';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const release = await acquire({ owner: 'post-outline' });
const timer = setTimeout(() => {
  console.error('outline-browser: timed out after 120 s');
  process.exit(1);
}, 120_000);
const server = await createServer({
  configFile: false,
  cacheDir: 'test-results/post-outline/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5343, strictPort: true, watch: null },
  logLevel: 'error',
});
await listenWhenFree(() => server.listen(), { port: 5343 });
const browser = await launchBrowser({ headless: true });
try {
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  if (compatRun()) await page.addInitScript(compatShim);
  await page.goto('http://127.0.0.1:5343/packages/post/test/outline-browser.html');
  const result = await page.evaluate(async () => {
    const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
      { PostStack } = await import('/packages/post/dist/stack.js'),
      { Outline } = await import('/packages/post/dist/outline.js'),
      { SceneTargets } = await import('/packages/post/dist/mrt.js');
    const canvas = document.querySelector('canvas'),
      engine = await Engine.create(canvas, {
        backend: 'webgpu',
        camera: { position: [2.2, 1.6, 3.4], target: [0, 0, 0] },
      }),
      device = engine.gpu,
      errors = [];
    engine.stop();
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    engine
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setMaterial(new PbrMaterial({ color: '#ffffff' }));
    const targets = SceneTargets.attach(engine, { outputs: { normal: 'normal' } });
    let width = 0,
      height = 0,
      read,
      readView,
      mask;
    const code = `@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
@group(0) @binding(0) var image:texture_2d<f32>;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {return textureLoad(image,vec2i(p.xy),0);}`;
    const copy = (c, input, view, format, multisample) => {
      const module = device.createShaderModule({ code }),
        pipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
          multisample,
        }),
        pass = c.encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: input }] }),
      );
      pass.draw(3);
      pass.end();
    };
    // Last LDR stage: copies what Outline wrote into a readable texture, and on to the canvas.
    const probe = {
      name: 'probe',
      setup() {},
      dispose() {},
      joinStack: () => ({
        kind: 'ldr',
        render(c, input, output) {
          if (width !== c.width || height !== c.height) {
            width = c.width;
            height = c.height;
            read = device.createTexture({
              size: [width, height],
              format: 'rgba8unorm',
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            });
            readView = read.createView();
          }
          copy(c, input, readView, 'rgba8unorm', { count: 1 });
          copy(c, input, output.view, output.format, output.multisample);
        },
      }),
    };
    const outline = new Outline({ color: [1, 0, 0, 1] });
    PostStack.attach(engine, [outline, probe]);
    const count = async () => {
      device.pushErrorScope('validation');
      engine.render({ delta: 1 / 60 });
      const scope = await device.popErrorScope();
      if (scope) errors.push(scope.message);
      const bytesPerRow = (width * 4 + 255) & ~255,
        buffer = device.createBuffer({
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: read }, { buffer, bytesPerRow }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(buffer.getMappedRange());
      let lines = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = y * bytesPerRow + x * 4;
          if (bytes[i] > 200 && bytes[i + 1] < 60 && bytes[i + 2] < 60) lines++;
        }
      buffer.destroy();
      return lines;
    };
    const depthOnly = await count();
    outline.options.normal = () => targets.texture('normal');
    const withNormals = await count();
    outline.options.width = 3;
    const wide = await count();
    outline.options.width = 1;
    outline.options.enabled = false;
    const off = await count();
    outline.options.enabled = true;
    mask = device.createTexture({
      size: [width, height],
      format: 'r8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    outline.options.mask = () => mask; // all zero: nothing is marked
    const unmarked = await count();
    device.queue.writeTexture(
      { texture: mask },
      new Uint8Array(((width + 255) & ~255) * height).fill(255),
      { bytesPerRow: (width + 255) & ~255 },
      [width, height],
    );
    const marked = await count();
    outline.options.maskId = 0.5; // 255 is not the id
    const otherId = await count();
    engine.dispose();
    return { depthOnly, withNormals, wide, off, unmarked, marked, otherId, errors };
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  assert.ok(result.depthOnly > 100, `silhouette draws a line: ${result.depthOnly}`);
  assert.ok(result.withNormals > result.depthOnly, 'normals add the cube creases');
  assert.ok(result.wide > result.withNormals * 1.5, 'width widens the line');
  assert.equal(result.off, 0, 'disabled passes the frame through');
  assert.equal(result.unmarked, 0, 'an empty mask draws no line');
  assert.equal(result.marked, result.withNormals, 'a full mask draws every line');
  assert.equal(result.otherId, 0, 'maskId picks one value');
} finally {
  clearTimeout(timer);
  await closeAll({ browser, servers: [server] });
  await release();
}
