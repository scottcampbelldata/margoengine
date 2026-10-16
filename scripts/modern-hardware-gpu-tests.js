import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';

const vendor = process.env.GPU_VENDOR;
const allocations = process.argv.includes('--allocations');
assert.ok(['nvidia', 'amd'].includes(vendor), 'Select a physical GPU with GPU_VENDOR and BROWSER_ARGS');
const output = `test-results/hardware-${vendor}`;
await mkdir(output, { recursive: true });
const browser = await openBrowser({ startPath: '/tests/modern-wrapper.html', headless: false }),
  { page, hardware } = browser;
const cdp = await page.context().newCDPSession(page),
  errors = [],
  checks = [],
  profiles = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error' || /ValidationError|Invalid .*Pipeline|Error while parsing/.test(message.text()))
    errors.push(message.text());
});
await page.addInitScript(() => {
  window.hardwareErrors = [];
  window.addEventListener('unhandledrejection', (event) => window.hardwareErrors.push(String(event.reason)));
  const gpu = navigator.gpu;
  if (gpu) {
    const request = gpu.requestAdapter.bind(gpu);
    window.adapters = [];
    gpu.requestAdapter = async (options) => {
      const adapter = await request(options);
      window.adapters.push({
        options,
        vendor: adapter?.info.vendor,
        fallback: adapter?.info.isFallbackAdapter ?? adapter?.isFallbackAdapter,
      });
      return adapter;
    };
  }
});
const percentile = (values, p) => values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1];
try {
  await page.reload();
  await page.waitForFunction(() => window.wrapper);
  await page.bringToFront();
  // Hold the DevTools focused-page condition while the editor covers the test window.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const images = [];
  for (const backend of ['webgpu', 'webgl2']) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 640,
      height: 480,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const identity = await page.evaluate(async (backend) => {
      const { webglRenderer } = await import('/packages/webgl/dist/index.js');
      document.body.style.margin = '0';
      const host = document.createElement('div');
      host.style.cssText = 'width:100vw;height:100vh';
      document.body.append(host);
      const app = await window.wrapper.createStage(host, {
        backend,
        fallback: webglRenderer,
        autoStart: false,
        onError: (error) => window.hardwareErrors.push(String(error)),
      });
      // Exercise borrowed-canvas-sized collapse below the owned canvas's 150px minimum.
      app.canvas.style.minHeight = '0';
      const orb = app.sphere({ color: '#84d6bd', roughness: 0.25, scale: [1, 0.85, 1] });
      orb.rotation.z = 0.4;
      const gl = backend === 'webgl2' ? app.canvas.getContext('webgl2') : null,
        debug = gl?.getExtension('WEBGL_debug_renderer_info');
      window.hardwareScene = { host, app, orb };
      return {
        backend: app.engine.backend,
        webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        adapter: window.adapters?.at(-1),
        deviceVendor: app.engine.gpu?.adapterInfo?.vendor ?? null,
      };
    }, backend);
    assert.equal(identity.backend, backend);
    if (backend === 'webgpu') {
      assert.equal(identity.adapter.vendor, vendor);
      assert.equal(identity.adapter.fallback, false);
      if (identity.deviceVendor) assert.equal(identity.deviceVendor, vendor);
    } else assert.ok(identity.webglRenderer.toLowerCase().includes(vendor));
    await page.evaluate(async () => {
      const e = window.hardwareScene.app.engine;
      e.render();
      await e.gpu?.queue.onSubmittedWorkDone();
    });
    images.push(await decodePNG(await page.locator('canvas').screenshot({ path: `${output}/${backend}-parity.png` })));
    const before = await page.evaluate(() => [...window.hardwareScene.app.engine.camera.position]);
    await page.mouse.move(320, 240);
    await page.mouse.down();
    await page.mouse.move(370, 260, { steps: 8 });
    await page.mouse.up();
    assert.notDeepEqual(await page.evaluate(() => [...window.hardwareScene.app.engine.camera.position]), before);
    await page.evaluate(() => {
      const e = window.hardwareScene.app.engine;
      e.camera.position = [0, 0, 4];
      e.camera.target = [0, 0, 0];
      const tracked = new WeakSet(),
        counts = { created: 0, destroyed: 0, alive: 0, peak: 0, invalid: 0 };
      if (e.gpu) {
        const create = GPUDevice.prototype.createTexture,
          destroy = GPUTexture.prototype.destroy;
        GPUDevice.prototype.createTexture = function (descriptor) {
          const size = descriptor.size,
            width = size.width ?? size[0],
            height = size.height ?? size[1] ?? 1;
          if (width < 1 || height < 1) counts.invalid++;
          const texture = create.call(this, descriptor);
          if (descriptor.format.startsWith('depth')) {
            tracked.add(texture);
            counts.created++;
            counts.alive++;
            counts.peak = Math.max(counts.peak, counts.alive);
          }
          return texture;
        };
        GPUTexture.prototype.destroy = function () {
          if (tracked.delete(this)) {
            counts.destroyed++;
            counts.alive--;
          }
          return destroy.call(this);
        };
        window.restoreTextures = () => {
          GPUDevice.prototype.createTexture = create;
          GPUTexture.prototype.destroy = destroy;
        };
      }
      window.depthCounts = counts;
      e.start();
    });
    const resize = [];
    for (const factor of [1, 1.5, 2])
      for (const [width, height] of [
        [321, 213],
        [900, 450],
        [211, 601],
        [1, 1],
        [800, 600],
      ]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: factor,
          mobile: false,
        });
        await page.waitForFunction(
          ({ width, height, factor }) => {
            const c = window.hardwareScene.app.canvas,
              dpr = Math.min(factor, 1);
            return c.width === Math.round(width * dpr) && c.height === Math.round(height * dpr);
          },
          { width, height, factor },
        );
        const sample = await page.evaluate(() => {
          const { app } = window.hardwareScene,
            c = app.canvas,
            m = app.engine.camera.matrix;
          return {
            css: [c.clientWidth, c.clientHeight],
            pixels: [c.width, c.height],
            dpr: devicePixelRatio,
            projectionAspect: m[5] / m[0],
            depth: { ...window.depthCounts },
          };
        });
        assert.ok(Math.abs(sample.projectionAspect - sample.pixels[0] / sample.pixels[1]) < 1e-4);
        assert.equal(sample.depth.invalid, 0);
        assert.ok(sample.depth.alive <= 1);
        resize.push(sample);
      }
    const collapsed = await page.evaluate(async () => {
      const s = window.hardwareScene;
      s.host.style.width = '0px';
      s.host.style.height = '0px';
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        css: [s.app.canvas.clientWidth, s.app.canvas.clientHeight],
        pixels: [s.app.canvas.width, s.app.canvas.height],
        depth: { ...window.depthCounts },
      };
    });
    assert.deepEqual(collapsed.css, [0, 0]);
    assert.ok(collapsed.pixels.every((value) => value > 0));
    assert.equal(collapsed.depth.invalid, 0);
    await page.evaluate(() => {
      const s = window.hardwareScene;
      s.host.style.width = '100vw';
      s.host.style.height = '100vh';
      s.app.engine.stop();
      s.app.dispose();
      s.host.remove();
      window.restoreTextures?.();
      delete window.restoreTextures;
    });
    const depth = await page.evaluate(() => window.depthCounts);
    assert.equal(depth.alive, 0);
    checks.push({
      name: `${backend}: hardware identity, orbit, DPR/rapid resize/zero-area collapse, depth texture retirement`,
      identity,
      resize,
      collapsed,
      depth,
    });
  }
  assert.equal(images[0].width, images[1].width);
  assert.equal(images[0].height, images[1].height);
  let total = 0,
    compared = 0,
    max = 0;
  for (let i = 0; i < images[0].data.length; i += 4) {
    if (images.every((image) => image.data[i + 1] > 80 && image.data[i + 1] > image.data[i] + 10))
      for (let c = 0; c < 3; c++) {
        const error = Math.abs(images[0].data[i + c] - images[1].data[i + c]);
        total += error;
        max = Math.max(max, error);
        compared++;
      }
  }
  assert.ok(compared > 1500);
  assert.ok(total / compared < 3, 'Backend orb shading differs');
  checks.push({
    name: 'WebGPU/WebGL2 sphere shading parity',
    comparedColorChannels: compared,
    meanAbsoluteChannelDifference: total / compared,
    maxChannelDifference: max,
  });
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  });
  const fallback = await page.evaluate(async () => {
    const { webglRenderer } = await import('/packages/webgl/dist/index.js');
    const c = document.createElement('canvas');
    c.style.cssText = 'width:320px;height:240px';
    document.body.append(c);
    const app = await window.wrapper.createStage(c, { backend: 'auto', fallback: webglRenderer, autoStart: false });
    app.sphere();
    app.engine.render();
    window.fallback = app;
    return { backend: app.engine.backend, reason: app.engine.fallbackReason };
  });
  assert.equal(fallback.backend, 'webgl2');
  const fallbackImage = await decodePNG(
    await page.locator('canvas').screenshot({ path: `${output}/auto-fallback.png` }),
  );
  let fallbackPixels = 0;
  for (let i = 0; i < fallbackImage.data.length; i += 4)
    if (fallbackImage.data[i] + fallbackImage.data[i + 1] + fallbackImage.data[i + 2] > 100) fallbackPixels++;
  assert.ok(fallbackPixels > 500);
  checks.push({ name: 'Automatic fallback with WebGPU unavailable', ...fallback, coloredPixels: fallbackPixels });
  await page.evaluate(() => {
    const c = window.fallback.canvas;
    window.fallback.dispose();
    c.remove();
    delete navigator.gpu;
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const backend of ['webgpu', 'webgl2']) {
    console.log(`${vendor}/${backend}: recording 30 seconds of continuous rotation`);
    await page.evaluate(async (backend) => {
      const { webglRenderer } = await import('/packages/webgl/dist/index.js');
      const host = document.createElement('div');
      host.style.cssText = 'width:100vw;height:100vh';
      document.body.append(host);
      const app = await window.wrapper.createStage(host, {
        backend,
        fallback: webglRenderer,
        onError: (error) => window.hardwareErrors.push(String(error)),
      });
      const orb = app.sphere({ color: '#84d6bd', roughness: 0.25, scale: [1, 0.85, 1] });
      const profile = { active: false, count: 0, times: new Float64Array(8192), visible: new Uint8Array(8192) };
      app.onTick((delta) => {
        orb.rotation.z += delta;
        if (profile.active) {
          profile.times[profile.count] = performance.now();
          profile.visible[profile.count++] = +(document.visibilityState === 'visible');
        }
      });
      window.hardwareScene = { app, host, orb };
      window.orbProfile = profile;
    }, backend);
    await page.waitForTimeout(3000);
    assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
    await cdp.send('HeapProfiler.collectGarbage');
    const events = [],
      heap = [],
      collect = ({ value }) => events.push(...value);
    cdp.on('Tracing.dataCollected', collect);
    if (allocations)
      await cdp.send('HeapProfiler.startSampling', {
        samplingInterval: 16384,
        includeObjectsCollectedByMinorGC: true,
        includeObjectsCollectedByMajorGC: true,
      });
    await cdp.send('Tracing.start', {
      categories:
        'devtools.timeline,disabled-by-default-devtools.timeline,v8,disabled-by-default-v8.gc,disabled-by-default-devtools.timeline.frame,disabled-by-default-devtools.timeline.memory',
      options: 'record-as-much-as-possible',
      transferMode: 'ReportEvents',
    });
    const started = performance.now();
    await page.evaluate(() => {
      window.orbProfile.active = true;
    });
    try {
      while (performance.now() - started < 30000) {
        const usage = await cdp.send('Runtime.getHeapUsage');
        heap.push({ elapsedMs: performance.now() - started, used: usage.usedSize, total: usage.totalSize });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      await page.evaluate(() => {
        window.orbProfile.active = false;
      });
      const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end');
      await done;
      cdp.off('Tracing.dataCollected', collect);
    }
    const profile = allocations
      ? (await cdp.send('HeapProfiler.stopSampling')).profile
      : { head: { selfSize: 0, children: [] } };
    const times = await page.evaluate(() => Array.from(window.orbProfile.times.subarray(0, window.orbProfile.count))),
      intervals = times.slice(1).map((time, index) => time - times[index]);
    assert.ok(times.length > 1, 'Rotation stopped during capture');
    const nominal = 1000 / 60,
      stalls = intervals.filter((time) => time > nominal * 1.5),
      gc = events.filter((event) => event.ph === 'X' && /^(MinorGC|MajorGC)$/.test(event.name)),
      longTasks = events.filter((event) => event.ph === 'X' && event.name === 'RunTask' && event.dur > 50000);
    const sites = [];
    function visit(node) {
      if (node.selfSize) sites.push({ estimatedBytes: node.selfSize, ...node.callFrame });
      for (const child of node.children) visit(child);
    }
    visit(profile.head);
    const bytes = sites.reduce((sum, site) => sum + site.estimatedBytes, 0),
      sizes = heap.map((sample) => sample.used),
      name = `${output}/${backend}${allocations ? '-allocations' : ''}`;
    await writeFile(`${name}.trace.json`, JSON.stringify({ traceEvents: events }));
    if (allocations) await writeFile(`${name}.heapprofile`, JSON.stringify(profile));
    profiles.push({
      backend,
      durationMs: performance.now() - started,
      frames: times.length,
      observedHz: 1000 / percentile(intervals, 0.5),
      medianIntervalMs: percentile(intervals, 0.5),
      p95IntervalMs: percentile(intervals, 0.95),
      maxIntervalMs: Math.max(...intervals),
      gapsOver25Ms: stalls.length,
      estimatedMissed60HzRefreshes: intervals.reduce(
        (sum, time) => sum + Math.max(0, Math.round(time / nominal) - 1),
        0,
      ),
      gcSweeps: gc.length,
      gcPauseMs: gc.reduce((sum, event) => sum + event.dur / 1000, 0),
      longTasksOver50Ms: longTasks.length,
      heapMinBytes: Math.min(...sizes),
      heapMaxBytes: Math.max(...sizes),
      heapRangeBytes: Math.max(...sizes) - Math.min(...sizes),
      sampledAllocationEstimateBytes: bytes,
      sampledAllocationEstimateBytesPerFrame: bytes / times.length,
      samplingIntervalBytes: 16384,
      allocationSites: sites.toSorted((a, b) => b.estimatedBytes - a.estimatedBytes).slice(0, 12),
      heap,
      trace: resolve(`${name}.trace.json`),
      allocationProfile: resolve(`${name}.heapprofile`),
      note: 'Headed Chromium, foreground page, 60 Hz attached display, emulated DPR=1. Heap allocation sampling includes collected objects and adds profiling overhead; estimates cannot prove exact zero bytes/frame. Callback gaps are not a compositor dropped-frame counter.',
    });
    const recorded = profiles.at(-1);
    recorded.samplingIntervalBytes = allocations ? 16384 : null;
    recorded.sampledAllocationEstimateBytes = allocations ? bytes : null;
    recorded.sampledAllocationEstimateBytesPerFrame = allocations ? bytes / times.length : null;
    recorded.allocationProfile = allocations ? resolve(`${name}.heapprofile`) : null;
    recorded.note = allocations
      ? recorded.note
      : 'Headed Chromium, foreground page, 60 Hz attached display, emulated DPR=1. Performance/GC trace and heap-size polling; allocation sampling disabled to measure cadence separately. Callback gaps are not a compositor dropped-frame counter.';
    recorded.hiddenFrames = await page.evaluate(
      () => Array.from(window.orbProfile.visible.subarray(0, window.orbProfile.count)).filter((value) => !value).length,
    );
    recorded.focusEmulated = true;
    recorded.captureWindowDurationMs = times.at(-1) - times[0];
    recorded.effectiveFramesPerSecond = ((times.length - 1) * 1000) / recorded.captureWindowDurationMs;
    recorded.requestedCriteria = {
      flatHeap: recorded.heapRangeBytes === 0,
      zeroGC: gc.length === 0,
      noCallbackGapsOver25Ms: stalls.length === 0,
    };
    console.log(JSON.stringify(recorded, (_, value) => (Array.isArray(value) && value === heap ? undefined : value)));
    await page.evaluate(() => {
      const s = window.hardwareScene;
      s.app.dispose();
      s.host.remove();
    });
  }
  const unhandled = await page.evaluate(() => window.hardwareErrors);
  assert.deepEqual(unhandled, []);
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(error.stack ?? String(error));
  throw error;
} finally {
  await writeFile(
    `${output}/validation${allocations ? '-allocations' : ''}.json`,
    JSON.stringify({ hardware, checks, profiles, errors }, null, 2),
  );
  await browser.close();
}
