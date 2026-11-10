import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
const dir = fileURLToPath(new URL('../../../test-results/batch230-pbr-browser/', import.meta.url));
await mkdir(dir, { recursive: true });
await writeFile(dir + '/index.html', '<script type="module" src="/main.js"></script>');
const path = (p) => fileURLToPath(new URL(p, import.meta.url)).replaceAll('\\', '/');
await writeFile(
  dir + '/main.js',
  `import {createPBRTextureBaker} from '${path('../dist/textures-pbr.js')}';import {createCompatGPU} from '${path('../../webgl2-compat/dist/device.js')}';window.make=createPBRTextureBaker;window.compat=createCompatGPU;`,
);
let browser, server;
try {
  await build({ root: dir, configFile: false, logLevel: 'error', build: { outDir: dir + '/dist' } });
  server = await preview({
    root: dir,
    configFile: false,
    logLevel: 'error',
    build: { outDir: dir + '/dist' },
    preview: { host: '127.0.0.1', port: 0 },
  });
  browser = await launchBrowser();
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'log') console.log(m.text());
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.make);
  const result = await page.evaluate(async () => {
    const cases = [];
    for (const route of ['webgpu', 'webgl2-compat']) {
      const gpu = route === 'webgpu' ? navigator.gpu : window.compat(),
        adapter = await gpu.requestAdapter();
      if (!adapter) throw new Error(route + ' adapter missing');
      const device = await adapter.requestDevice();
      device.pushErrorScope('validation');
      const baker = await window.make(device).catch((e) => {
        throw new Error(e.message + ' ' + e.cause?.message);
      });
      async function read(texture, w, h, level = 0) {
        const stride = Math.ceil((w * 4) / 256) * 256,
          buffer = device.createBuffer({ size: stride * h, usage: 1 | 8 }),
          encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture, mipLevel: level }, { buffer, bytesPerRow: stride }, [w, h]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(1);
        const data = new Uint8Array(buffer.getMappedRange()),
          pixels = [];
        for (let y = 0; y < h; y++) pixels.push(...data.subarray(y * stride, y * stride + w * 4));
        buffer.unmap();
        buffer.destroy();
        return pixels;
      }
      for (const pattern of [
        'noise',
        'bricks',
        'tiles',
        'wood',
        'rust',
        'marble',
        'cloud',
        'grass',
        'fire',
        'starfield',
        'road',
      ]) {
        console.log(route + ' ' + pattern);
        const output = await baker.bake({
            pattern,
            width: 63,
            height: 47,
            seed: 73,
            color: [1, 1, 1],
            secondary: [0, 0, 0],
            heightScale: 1,
            normalStrength: 0.1,
            roughness: 0.5,
            roughnessVariation: 0.5,
          }),
          maps = {};
        for (const name of ['albedo', 'normal', 'roughness', 'height']) {
          let w = 63,
            h = 47;
          maps[name] = [];
          for (let level = 0; level < output.mipLevelCount; level++) {
            maps[name].push({ w, h, pixels: await read(output[name], w, h, level) });
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
          }
        }
        const repeated = await baker.bake({
          pattern,
          width: 63,
          height: 47,
          seed: 73,
          color: [1, 1, 1],
          secondary: [0, 0, 0],
          heightScale: 1,
          normalStrength: 0.1,
          roughness: 0.5,
          roughnessVariation: 0.5,
          offset: [1, -1],
          mipmaps: false,
        });
        cases.push({ route, pattern, maps, repeated: await read(repeated.albedo, 63, 47) });
        repeated.dispose();
        output.dispose();
      }
      const flat = await baker.bake({ width: 16, height: 16, normalStrength: 0 });
      const flatPixels = await read(flat.normal, 16, 16);
      if (flatPixels.some((x, i) => x !== [128, 128, 255, 255][i % 4]))
        throw new Error(
          'Flat normal is not +Z: ' +
            flatPixels.slice(0, 16) +
            ' pending validation: ' +
            (await device.popErrorScope())?.message,
        );
      flat.dispose();
      const controller = new AbortController(),
        pending = baker.bake({ signal: controller.signal });
      controller.abort('cancel');
      let cancelled = false;
      try {
        await pending;
      } catch (e) {
        cancelled = e === 'cancel';
      }
      if (!cancelled) throw new Error('Abort failed');
      const animatedA = await baker.bake({ pattern: 'fire', time: 0, width: 32, height: 32, mipmaps: false }),
        animatedB = await baker.bake({ pattern: 'fire', time: 1, width: 32, height: 32, mipmaps: false });
      const a = await read(animatedA.albedo, 32, 32),
        b = await read(animatedB.albedo, 32, 32);
      if (a.every((x, i) => x === b[i])) throw new Error('Time has no effect');
      baker.dispose();
      await device.queue.onSubmittedWorkDone();
      const error = await device.popErrorScope();
      if (error) throw new Error(route + ': ' + error.message);
      device.destroy();
    }
    return cases;
  });
  let mipChecks = 0,
    maxBackendError = 0;
  for (const c of result) {
    assert.equal(c.maps.albedo.length, 6);
    assert.deepEqual(c.maps.albedo[0].pixels, c.repeated, 'integer UV phase is identical');
    assert.ok(
      new Set(c.maps.albedo[0].pixels.filter((_, i) => i % 4 === 0)).size > 1,
      c.route + ' ' + c.pattern + ' variation',
    );
    const h = c.maps.height[0].pixels,
      albedo = c.maps.albedo[0].pixels,
      rough = c.maps.roughness[0].pixels;
    for (let i = 0; i < h.length; i += 4) {
      assert.ok(Math.abs(h[i] - albedo[i]) <= 1);
      assert.ok(Math.abs(rough[i] - Math.round(127.5 + (h[i] / 255 - 0.5) * 127.5)) <= 1);
    }
    for (const [name, levels] of Object.entries(c.maps)) {
      for (let level = 0; level < levels.length; level++) {
        const out = levels[level];
        assert.ok(out.pixels.every((x, i) => i % 4 !== 3 || x === 255));
        if (name === 'normal')
          for (let i = 0; i < out.pixels.length; i += 4)
            assert.ok(Math.abs(Math.hypot(...out.pixels.slice(i, i + 3).map((x) => x / 127.5 - 1)) - 1) < 0.012);
        if (!level) continue;
        const src = levels[level - 1];
        for (let y = 0; y < out.h; y++)
          for (let x = 0; x < out.w; x++) {
            const lo = [(x * src.w) / out.w, (y * src.h) / out.h],
              hi = [((x + 1) * src.w) / out.w, ((y + 1) * src.h) / out.h],
              sum = [0, 0, 0];
            let weight = 0;
            for (let sy = Math.floor(lo[1]); sy < Math.ceil(hi[1]); sy++)
              for (let sx = Math.floor(lo[0]); sx < Math.ceil(hi[0]); sx++) {
                const area =
                  (Math.min(hi[0], sx + 1) - Math.max(lo[0], sx)) * (Math.min(hi[1], sy + 1) - Math.max(lo[1], sy));
                weight += area;
                for (let k = 0; k < 3; k++) {
                  const v = src.pixels[(sy * src.w + sx) * 4 + k];
                  sum[k] += (name === 'normal' ? v / 127.5 - 1 : v / 255) * area;
                }
              }
            let expected = sum.map((x) => x / weight);
            if (name === 'normal') {
              const length = Math.hypot(...expected);
              expected = expected.map((x) => (x / length) * 0.5 + 0.5);
            }
            for (let k = 0; k < 3; k++) {
              assert.ok(
                Math.abs(out.pixels[(y * out.w + x) * 4 + k] - Math.round(expected[k] * 255)) <= 1,
                `${c.route} ${c.pattern} ${name} mip${level} ${x},${y}`,
              );
              mipChecks++;
            }
          }
      }
    }
  }
  for (let i = 0; i < 11; i++)
    for (const name of ['albedo', 'normal', 'roughness', 'height'])
      for (let level = 0; level < 6; level++) {
        const a = result[i].maps[name][level].pixels,
          b = result[i + 11].maps[name][level].pixels;
        for (let k = 0; k < a.length; k++) {
          const error = Math.abs(a[k] - b[k]);
          maxBackendError = Math.max(maxBackendError, error);
          assert.ok(error <= 1, `${result[i].pattern} ${name} mip${level} backend error ${error}`);
        }
      }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ patterns: 11, routes: ['webgpu', 'webgl2-compat'], mipChecks, maxBackendError, errors }),
  );
} finally {
  await closeAll({ browser, servers: [server] });
}
