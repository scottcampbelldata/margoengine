// Run under scripts/gpu-lock.mjs. Original deterministic HDR fixture, not a borrowed asset/reference image.
import assert from 'node:assert/strict';
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
const server = await createServer({
  configFile: false,
  cacheDir: 'test-results/post-image/vite-cache',
  optimizeDeps: { noDiscovery: true },
  server: { host: '127.0.0.1', port: 5341, strictPort: true, watch: null },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true }),
  page = await browser.newPage(),
  errors = [];
const context = {
  close: async () => {
    await browser.close();
    await server.close();
  },
};
await page.goto('http://127.0.0.1:5341/packages/post/test/image-browser.html');
const hardware = await page.evaluate(async () => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  return {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    fallback: adapter.info.isFallbackAdapter ?? adapter.isFallbackAdapter,
    userAgent: navigator.userAgent,
  };
});
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  const result = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js'),
      { ImagePost } = await import('/packages/post/dist/image.js');
    const canvas = document.querySelector('canvas'),
      engine = await Engine.create(canvas, { backend: 'webgpu', capacity: 1 }),
      device = engine.gpu,
      errors = [];
    engine.onError = (error) => errors.push(String(error));
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const width = 128,
      height = 96,
      pixels = width * height,
      color = new Float32Array(pixels * 3),
      packed = new Float32Array(pixels * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x,
          bright = x >= 55 && x < 73 && y >= 37 && y < 59,
          values = bright ? [12, 6, 1] : [0.015625, 0.03125, 0.0625];
        color.set(values, i * 3);
        packed.set([...values, 1], i * 4);
      }
    const output = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      }),
      depth = device.createTexture({
        size: [width, height],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      readback = device.createBuffer({
        size: width * height * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
      source = device.createBuffer({
        size: packed.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
      uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(source, 0, packed);
    const fixtureShader = `
      @group(0) @binding(0) var<storage,read> colors:array<vec4f>;
      @group(0) @binding(1) var<uniform> settings:vec4f;
      @vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
      @fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
        let i=u32(p.y)*128u+u32(p.x);let t=settings.y*length((p.xy-vec2f(64,48))/(0.2238*96.0));let gain=exp2(settings.x)/((1.0+t*t)*(1.0+t*t));return vec4f(colors[i].rgb*gain,1);
      }`;
    const module = device.createShaderModule({ code: fixtureShader }),
      fixturePipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba16float' }] },
      }),
      fixtureGroup = device.createBindGroup({
        layout: fixturePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: source } },
          { binding: 1, resource: { buffer: uniform } },
        ],
      });
    engine.use({
      name: 'original-hdr-fixture',
      setup() {},
      registerPasses(graph) {
        graph.add({
          name: 'fixture-target',
          order: -100,
          execute(c) {
            c.color = output.createView();
            c.depth = depth.createView();
            c.format = 'rgba8unorm';
            c.descriptor = {
              ...c.descriptor,
              multisample: { count: 1 },
              fragment: { ...c.descriptor.fragment, targets: [{ format: 'rgba8unorm' }] },
              depthStencil: { ...c.descriptor.depthStencil, format: 'depth32float' },
            };
          },
        });
        graph.add({
          name: 'fixture-linear-hdr',
          order: 20,
          execute(c) {
            const pass = c.encoder.beginRenderPass({
              colorAttachments: [{ view: c.color, loadOp: 'clear', storeOp: 'store' }],
            });
            pass.setPipeline(fixturePipeline);
            pass.setBindGroup(0, fixtureGroup);
            pass.draw(3);
            pass.end();
          },
        });
        graph.add({
          name: 'fixture-readback',
          order: 40,
          execute(c) {
            c.encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: width * 4 }, [
              width,
              height,
            ]);
          },
        });
      },
    });
    const effect = ImagePost.attach(engine, { bloom: { strength: 1.3, threshold: 1, radius: 0.7 } }),
      results = [],
      pngs = [];
    const difference = (a, b) => {
      let max = 0,
        differing = 0;
      for (let i = 0; i < a.length; i++) {
        const delta = Math.abs(a[i] - b[i]);
        max = Math.max(max, delta);
        if (delta) differing++;
      }
      return { max, differing };
    };
    const decode = async (blob) => {
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }),
        ctx = new OffscreenCanvas(width, height).getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return ctx.getImageData(0, 0, width, height).data;
    };
    const image = { width, height, color };
    for (const [toneMapping, gamma, exposure, vignette] of [
      ['neutral', undefined, 0, 0],
      ['linear', 2.2, 1, 0.1],
      ['aces-narkowicz', 2.2, -1, 0.3],
    ]) {
      const options = { bloom: { strength: 1.3, threshold: 1, radius: 0.7 }, toneMapping, gamma, exposure, vignette };
      effect.setOptions(options);
      device.queue.writeBuffer(uniform, 0, new Float32Array([exposure, vignette, 0, 0]));
      engine.render();
      await readback.mapAsync(GPUMapMode.READ);
      const preview = new Uint8Array(readback.getMappedRange()).slice();
      readback.unmap();
      const exported = await effect.renderImage(image),
        png = await effect.capture(image),
        decoded = await decode(png);
      results.push({
        toneMapping,
        gamma,
        exposure,
        vignette,
        previewVsExport: difference(preview, exported.data),
        pngVsPixels: difference(decoded, exported.data),
        bytes: png.size,
      });
      pngs.push({ name: `${toneMapping}.png`, bytes: Array.from(new Uint8Array(await png.arrayBuffer())) });
    }
    effect.setOptions({ bloom: { strength: 0 }, toneMapping: 'linear' });
    const noBloom = await effect.renderImage(image);
    effect.setOptions({ bloom: { strength: 1.3, threshold: 1, radius: 0.7 }, toneMapping: 'linear' });
    const bloom = await effect.renderImage(image);
    const near = (48 * width + 51) * 4,
      far = (2 * width + 2) * 4,
      glowGain = bloom.data[near] - noBloom.data[near],
      farGain = bloom.data[far] - noBloom.data[far];
    const cancelled = new AbortController(),
      pending = effect.renderImage(image, { signal: cancelled.signal });
    let blocked = false;
    try {
      effect.setOptions({});
    } catch {
      blocked = true;
    }
    cancelled.abort(new DOMException('Fixture cancellation', 'AbortError'));
    let cancelledName;
    try {
      await pending;
    } catch (error) {
      cancelledName = error.name;
    }
    const afterCancel = await effect.renderImage(image);
    const alpha = new Float32Array(pixels);
    alpha.fill(1);
    for (let y = 0; y < height; y++) for (let x = 0; x < 32; x++) alpha[y * width + x] = 0;
    const transparentColor = color.slice();
    for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) transparentColor[i * 3 + c] *= alpha[i];
    effect.setOptions({ bloom: { strength: 0 }, toneMapping: 'linear' });
    const transparent = await effect.renderImage({ width, height, color: transparentColor, alpha }),
      alphaRange = [
        Math.min(...transparent.data.filter((_, i) => i % 4 === 3)),
        Math.max(...transparent.data.filter((_, i) => i % 4 === 3)),
      ];
    const oddWidth = 37,
      oddHeight = 23,
      oddColor = new Float32Array(oddWidth * oddHeight * 3),
      oddExpected = new Uint8ClampedArray(oddWidth * oddHeight * 4);
    for (let y = 0; y < oddHeight; y++)
      for (let x = 0; x < oddWidth; x++) {
        const i = y * oddWidth + x;
        oddColor.set([(x % 8) / 8, (y % 8) / 8, 0.5], i * 3);
        oddExpected.set([Math.round(((x % 8) / 8) * 255), Math.round(((y % 8) / 8) * 255), 128, 255], i * 4);
      }
    effect.setOptions({ bloom: { strength: 0 }, toneMapping: 'linear', gamma: 1 });
    const odd = await effect.renderImage({ width: oddWidth, height: oddHeight, color: oddColor }),
      oddRows = difference(odd.data, oddExpected);
    oddRows.samples = Array.from(odd.data, (value, index) => ({ index, value, expected: oddExpected[index] }))
      .filter((item) => item.value !== item.expected)
      .slice(0, 12);
    effect.dispose();
    for (const resource of [output, depth, readback, source, uniform]) resource.destroy();
    engine.dispose();
    return {
      results,
      pngs,
      glowGain,
      farGain,
      blocked,
      cancelledName,
      afterCancelMatches: difference(afterCancel.data, bloom.data),
      alphaRange,
      oddRows,
      errors,
    };
  });
  for (const item of result.results) {
    assert.ok(item.previewVsExport.max <= 1, `${item.toneMapping} preview/export ${JSON.stringify(item)}`);
    assert.equal(item.pngVsPixels.max, 0, 'PNG decode retains RGBA pixels');
    assert.ok(item.bytes > 100);
  }
  assert.ok(result.glowGain > 8, `bright source must bloom into its surround: ${result.glowGain}`);
  assert.ok(result.glowGain > result.farGain, 'glow is local to original bright source');
  assert.equal(result.blocked, true);
  assert.equal(result.cancelledName, 'AbortError');
  assert.equal(result.afterCancelMatches.max, 0);
  assert.deepEqual(result.alphaRange, [0, 255]);
  // The existing rgba16float Bloom intermediate / UNORM store can round a half-intensity swatch one level down.
  // Whole-pixel/row offsets in the stepped ramp differ by at least 31 levels, so this still detects padding errors.
  assert.ok(result.oddRows.max <= 1, `odd-width readback removes GPU row padding: ${JSON.stringify(result.oddRows)}`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(errors, []);
  await mkdir('test-results/post-image', { recursive: true });
  const files = [];
  for (const image of result.pngs) {
    const bytes = Buffer.from(image.bytes),
      path = `test-results/post-image/${image.name}`;
    await writeFile(path, bytes);
    files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  delete result.pngs;
  const artifacts = [];
  for (const name of (await readdir('packages/post/dist')).filter((name) => name.endsWith('.js')).sort()) {
    const path = `packages/post/dist/${name}`;
    artifacts.push({
      path,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    });
  }
  const report = { passed: true, date: new Date().toISOString(), hardware, ...result, files, artifacts };
  await writeFile('test-results/post-image/report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
}
