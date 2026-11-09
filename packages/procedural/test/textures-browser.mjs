import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';
const dir = await mkdtemp(join(tmpdir(), 'margo-textures-'));
let browser, server;
try {
  await writeFile(join(dir, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(
    join(dir, 'main.js'),
    `import {createTextureBaker} from '@margoengine/procedural/textures'; window.createTextureBaker=createTextureBaker;`,
  );
  await build({
    root: dir,
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: { '@margoengine/procedural/textures': fileURLToPath(new URL('../dist/textures.js', import.meta.url)) },
    },
    build: { outDir: join(dir, 'dist') },
  });
  server = await preview({
    root: dir,
    configFile: false,
    logLevel: 'error',
    build: { outDir: join(dir, 'dist') },
    preview: { host: '127.0.0.1', port: 0 },
  });
  browser = await launchBrowser();
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.createTextureBaker === 'function');
  const reference = JSON.parse(
    await readFile(new URL('./fixtures/textures/structural-reference.json', import.meta.url), 'utf8'),
  );
  const result = await page.evaluate(async (reference) => {
    const adapter = await navigator.gpu.requestAdapter(),
      device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const baker = await window.createTextureBaker(device).catch((error) => {
        throw new Error(`${error.message}: ${error.cause?.message}`);
      }),
      cases = [];
    async function read(output) {
      const stride = Math.ceil((output.width * 4) / 256) * 256;
      const buffer = device.createBuffer({
        size: stride * output.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: output.texture }, { buffer, bytesPerRow: stride }, [
          output.width,
          output.height,
        ]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(buffer.getMappedRange()),
          pixels = [];
        for (let y = 0; y < output.height; y++)
          pixels.push(...mapped.subarray(y * stride, y * stride + output.width * 4));
        return pixels;
      } finally {
        buffer.destroy();
      }
    }
    for (const pattern of ['noise', 'bricks', 'tiles', 'wood', 'rust']) {
      const options = {
        pattern,
        width: 63,
        height: 47,
        seed: 0xffffffff,
        color: [1, 1, 1],
        secondary: [0, 0, 0],
        detail: 0.2,
      };
      const a = await baker.bake(options),
        pixels = await read(a);
      a.dispose();
      const tiled = await baker.bake({ ...options, offset: [1, -1] }),
        repeated = await read(tiled);
      tiled.dispose();
      const shift = await baker.bake({ ...options, offset: [-1 / 63, 0] }),
        shifted = await read(shift);
      shift.dispose();
      const shiftY = await baker.bake({ ...options, offset: [0, -1 / 47] }),
        shiftedY = await read(shiftY);
      shiftY.dispose();
      cases.push({ pattern, pixels, repeated, shifted, shiftedY });
    }
    const bonds = [];
    for (const pattern of ['bricks', 'tiles']) {
      const out = await baker.bake({
        pattern,
        width: 128,
        height: 128,
        repeat: [4, 8],
        grout: 0.08,
        detail: 0,
        stagger: reference.nearestRowOffsetPixels / reference.pitchPixels,
        color: [1, 1, 1],
        secondary: [0, 0, 0],
      });
      bonds.push({ pattern, pixels: await read(out) });
      out.dispose();
    }
    const maximum = await baker.bake({ pattern: 'noise', width: 2048, height: 16, repeat: [64, 64], seed: 0 });
    maximum.dispose();
    const controller = new AbortController(),
      reason = new Error('real in-flight abort');
    const aborted = baker.bake({ signal: controller.signal });
    controller.abort(reason);
    let cancelled = false;
    try {
      await aborted;
    } catch (error) {
      cancelled = error === reason;
    }
    if (!cancelled) throw new Error('Real bake lost abort reason');
    const beforeLoss = await device.popErrorScope();
    if (beforeLoss) throw new Error(beforeLoss.message);
    const inFlightLoss = baker.bake();
    device.destroy();
    let pendingLost = false;
    try {
      await inFlightLoss;
    } catch (error) {
      pendingLost = error.code === 'failed';
    }
    if (!pendingLost) throw new Error('In-flight lost bake did not fail with a code');
    await device.lost;
    let lost = false;
    try {
      await baker.bake();
    } catch (e) {
      lost = e.code === 'failed' && e.message.includes('https://margoengine.com/errors#procedural');
    }
    if (!lost) throw new Error('Lost device accepted bake');
    baker.dispose();
    const replacement = await (await navigator.gpu.requestAdapter()).requestDevice();
    const fresh = await window.createTextureBaker({ backend: 'webgpu', gpu: replacement });
    const out = await fresh.bake({ width: 16, height: 16 });
    out.dispose();
    const disposing = fresh.bake();
    fresh.dispose();
    let pendingDisposed = false;
    try {
      await disposing;
    } catch (error) {
      pendingDisposed = error.code === 'disposed';
    }
    if (!pendingDisposed) throw new Error('In-flight disposed bake did not fail');
    fresh.dispose();
    let disposed = false;
    try {
      await fresh.bake();
    } catch (e) {
      disposed = e.code === 'disposed';
    }
    if (!disposed) throw new Error('Disposed baker accepted bake');
    replacement.destroy();
    await replacement.lost;
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) throw new Error('WebGL2 missing');
    let unsupported = false;
    try {
      await window.createTextureBaker({ backend: 'webgl2', gpu: null });
    } catch (e) {
      unsupported = e.code === 'unsupported' && e.message.includes('https://margoengine.com/errors#procedural');
    }
    if (!unsupported) throw new Error('WebGL2 did not give linked refusal');
    gl.getExtension('WEBGL_lose_context').loseContext();
    return { cases, bonds, lost, unsupported };
  }, reference);
  function hash(x, y, seed) {
    let h = Math.imul(x, 1597334677) ^ Math.imul(y, 3812015801) ^ seed;
    h = Math.imul(h ^ (h >>> 16), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^ (h >>> 16)) >>> 8) / 16777215;
  }
  function noise(u, v, n) {
    const x = Math.floor(u * n),
      y = Math.floor(v * n),
      f = u * n - x,
      g = v * n - y;
    const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10),
      tx = smooth(f),
      ty = smooth(g),
      mix = (a, b, t) => a * (1 - t) + b * t;
    return mix(
      mix(hash(x % n, y % n, -1), hash((x + 1) % n, y % n, -1), tx),
      mix(hash(x % n, (y + 1) % n, -1), hash((x + 1) % n, (y + 1) % n, -1), tx),
      ty,
    );
  }
  let pixelChecks = 0,
    maxError = 0;
  for (const c of result.cases) {
    assert.deepEqual(c.pixels, c.repeated, 'integer tile translation is byte exact');
    const colours = new Set();
    for (let y = 0; y < 47; y++)
      for (let x = 0; x < 63; x++) {
        const u = (x + 0.5) / 63,
          v = (y + 0.5) / 47,
          n = (8 * noise(u, v, 4) + 4 * noise(u, v, 8) + 2 * noise(u, v, 16) + noise(u, v, 32)) / 15;
        let value = n;
        if (c.pattern === 'bricks' || c.pattern === 'tiles') {
          const shift = c.pattern === 'bricks' ? (Math.floor(v * 8) % 2) / 2 : 0,
            localX = (u * 4 + shift) % 1,
            localY = (v * 8) % 1;
          value = Math.min(localX, 1 - localX, localY, 1 - localY) >= 0.08 ? 1 - 0.2 * (1 - n) : 0;
        } else if (c.pattern === 'wood') value = 0.2 + 0.8 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (u * 4 + 0.2 * n)));
        else if (c.pattern === 'rust') {
          const t = Math.max(0, Math.min(1, (n - 0.31) / 0.38));
          value = t * t * (3 - 2 * t);
        }
        const i = (y * 63 + x) * 4,
          expected = Math.round(value * 255);
        colours.add(c.pixels[i]);
        for (let k = 0; k < 3; k++) {
          const error = Math.abs(c.pixels[i + k] - expected);
          assert.ok(error <= 1, `${c.pattern} ${x},${y}: ${error}`);
          maxError = Math.max(maxError, error);
          const previous = (y * 63 + ((x + 62) % 63)) * 4 + k;
          assert.ok(
            Math.abs(c.shifted[i + k] - c.pixels[previous]) <= 1,
            'one-texel phase crosses repeat seam continuously',
          );
          const above = (((y + 46) % 47) * 63 + x) * 4 + k;
          assert.ok(
            Math.abs(c.shiftedY[i + k] - c.pixels[above]) <= 1,
            'vertical phase crosses repeat seam continuously',
          );
          pixelChecks++;
        }
        assert.equal(c.pixels[i + 3], 255);
      }
    assert.ok(colours.size > 20, `${c.pattern} has material variation`);
  }
  // Figure 1(d) numerical measurements are from the actual downloaded source
  // raster. This checks a calibrated structural offset, not image reconstruction.
  for (const { pattern, pixels } of result.bonds) {
    function joints(row) {
      const y = row * 16 + 8,
        result = [];
      for (let x = 0; x < 128; x++)
        if (pixels[(y * 128 + x) * 4] === 0 && pixels[(y * 128 + ((x + 127) % 128)) * 4] === 255) {
          let length = 1;
          while (length < 128 && pixels[(y * 128 + ((x + length) % 128)) * 4] === 0) length++;
          result.push((x + (length - 1) / 2) % 128);
        }
      return result;
    }
    const first = joints(0),
      second = joints(1);
    assert.equal(first.length, 4);
    assert.equal(second.length, 4);
    const offset = Math.min(...second.map((x) => Math.min(Math.abs(x - first[0]), 128 - Math.abs(x - first[0])))) / 32;
    const expected = pattern === 'bricks' ? reference.nearestRowOffsetPixels / reference.pitchPixels : 0;
    assert.ok(Math.abs(offset - expected) <= reference.uncertaintyPixels / reference.pitchPixels + 0.5 / 32);
    for (let row = 0; row < 8; row++) {
      const y = row * 16 + 8,
        shift = pattern === 'bricks' ? (row % 2) * 32 * expected : 0;
      for (let column = 0; column < 4; column++) {
        const joint = Math.floor((column * 32 - shift + 128) % 128),
          center = (joint + 16) % 128;
        assert.equal(pixels[(y * 128 + joint) * 4], 0);
        assert.equal(pixels[(y * 128 + center) * 4], 255);
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      pixelChecks,
      maxError,
      externalReference: 'Lefebvre/Poulin 2000 Fig. 1(d), measured calibrated row offsets only',
      otherControls: 'STAND-IN',
      lost: result.lost,
      webgl2Refused: result.unsupported,
      errors,
    }),
  );
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(dir, { recursive: true, force: true });
}
