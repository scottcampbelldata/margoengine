import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';

// Uncap the headless compositor to measure the app's pacer rather than its ~31 Hz refresh limit.
const browser = await openBrowser({
  startPath: '/apps/showcase-night-citadel/index.html',
  args: process.env.BROWSER_ARGS
    ? JSON.parse(process.env.BROWSER_ARGS)
    : ['--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const { page } = browser,
  errors = [],
  warnings = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
  if (message.type() === 'warning') warnings.push(message.text());
});
async function moonFraming() {
  const framing = await page.evaluate(() => {
    const app = window.nightCitadel,
      m = app.camera.matrix,
      d = app.moon;
    const cw = m[3] * d[0] + m[7] * d[1] + m[11] * d[2];
    const width = innerWidth,
      height = innerHeight;
    const x =
      (((m[0] * d[0] + m[4] * d[1] + m[8] * d[2]) / cw) * 0.5 + 0.5) * width;
    const y =
      (0.5 - ((m[1] * d[0] + m[5] * d[1] + m[9] * d[2]) / cw) * 0.5) * height;
    const radius =
      (Math.tan(Math.asin(app.sky.uniformData[35])) * height) /
      (2 * Math.tan((app.camera.fov * Math.PI) / 360) * cw);
    const covered = ['.title', '.panel'].some((selector) => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    return { width, height, x, y, radius, covered };
  });
  assert(
    framing.x > framing.radius &&
      framing.x + framing.radius < framing.width &&
      framing.y > framing.radius &&
      framing.y + framing.radius < framing.height &&
      !framing.covered,
    `Opening moon is clipped or covered: ${JSON.stringify(framing)}`,
  );
  return framing;
}
try {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.waitForFunction(() => window.nightCitadel?.stats.frames > 10);
  assert(
    await page.locator('#status').isHidden(),
    'Showcase failed to initialize',
  );
  const visual = await page.evaluate(async () => {
    const app = window.nightCitadel,
      device = app.device,
      check = (ok, message) => {
        if (!ok) throw new Error(message);
      };
    document.querySelector('#orbit').checked = false;
    app.stop();
    device.pushErrorScope('validation');
    const shader = device.createShaderModule({
      code: `
      @group(0) @binding(0) var color:texture_2d<f32>;
      @group(0) @binding(1) var depth:texture_depth_2d;
      @group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
      @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
        let size=textureDimensions(color);if(id.x>=size.x||id.y>=size.y){return;}
        result[id.y*size.x+id.x]=vec4f(textureLoad(color,vec2i(id.xy),0).rgb,textureLoad(depth,vec2i(id.xy),0));
      }`,
    });
    const w = app.target.width,
      h = app.target.height,
      bytes = w * h * 16;
    const output = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const read = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: shader, entryPoint: 'main' },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: app.target.color.createView() },
        { binding: 1, resource: app.target.depth.createView() },
        { binding: 2, resource: { buffer: output } },
      ],
    });
    async function capture() {
      const first = app.stats.frames;
      app.start();
      await new Promise((resolve) => {
        function wait() {
          if (app.stats.frames >= first + 3) resolve();
          else requestAnimationFrame(wait);
        }
        requestAnimationFrame(wait);
      });
      app.stop();
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, read, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const image = new Float32Array(read.getMappedRange()).slice();
      read.unmap();
      return image;
    }
    function slider(id, value) {
      const input = document.getElementById(id);
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function difference(a, b, geometry) {
      let count = 0;
      for (let i = 0; i < a.length; i += 4)
        if (
          a[i + 3] > 0 === geometry &&
          Math.abs(a[i] - b[i]) +
            Math.abs(a[i + 1] - b[i + 1]) +
            Math.abs(a[i + 2] - b[i + 2]) >
            0.003
        )
          count++;
      return count;
    }
    function moonPixels(image) {
      const m = app.camera.matrix,
        x = app.eye[0] + app.moon[0] * 100,
        y = app.eye[1] + app.moon[1] * 100,
        z = app.eye[2] + app.moon[2] * 100;
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15],
        cx = (((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw) * 0.5 + 0.5) * w,
        cy = (0.5 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5) * h;
      let count = 0;
      for (let i = 0; i < image.length; i += 4) {
        const p = i / 4;
        if (
          Math.abs((p % w) - cx) < 80 &&
          Math.abs(Math.floor(p / w) - cy) < 80 &&
          !image[i + 3] &&
          image[i] > 0.3 &&
          image[i + 1] > 0.3
        )
          count++;
      }
      return count;
    }
    try {
      slider('glow', 0);
      slider('phase', 1);
      const full = await capture();
      slider('phase', 0);
      const half = await capture();
      slider('phase', -1);
      const dark = await capture();
      const phases = {
        full: moonPixels(full),
        half: moonPixels(half),
        new: moonPixels(dark),
      };
      check(
        phases.full > 500 &&
          phases.half / phases.full > 0.4 &&
          phases.half / phases.full < 0.6 &&
          phases.new === 0,
        `Lunar disc phases failed: ${JSON.stringify(phases)}`,
      );
      slider('phase', 1);
      slider('azimuth', 70);
      slider('elevation', 35);
      const moved = await capture();
      const highlights = difference(full, moved, true);
      check(
        highlights > 1000,
        'Moon rotation did not update geometry highlights',
      );
      const staged = app.sky.uniformData;
      for (let i = 0; i < 3; i++)
        check(
          Math.abs(staged[20 + i] - app.frameData[36 + i]) < 1e-6,
          'Sky and masonry moon directions diverged',
        );
      check(
        Math.abs(Math.hypot(...app.frameData.slice(36, 39)) - 1) < 1e-6,
        'Lunar light is not normalized',
      );
      const saved = app.frameData[30];
      app.frameData[30] = -2;
      const unshadowed = await capture();
      app.frameData[30] = saved;
      const shadows = difference(moved, unshadowed, true);
      check(shadows > 100, 'Lunar shadow map did not occlude surfaces');
      slider('azimuth', 215);
      slider('elevation', 24);
      slider('haze', 0);
      const clear = await capture();
      slider('haze', 1);
      const haze = await capture();
      const fogGeometry = difference(clear, haze, true),
        horizon = difference(clear, haze, false);
      check(
        fogGeometry > 1000 && horizon > 1000,
        'Haze controls did not affect sky and cliff',
      );
      slider('haze', 0.35);
      slider('phase', -1);
      slider('glow', 0);
      app.sky.setConfig({ starIntensity: 0 });
      const noStars = await capture();
      app.sky.setConfig({ starIntensity: 1, starTwinkleIntensity: 0 });
      const steady = await capture(),
        steadyAgain = await capture();
      check(
        difference(steady, steadyAgain, false) === 0,
        'Zero twinkle did not hold stars steady',
      );
      let stars = 0,
        belowHorizon = 0;
      const inv = app.inverse,
        eye = app.eye;
      for (let i = 0; i < steady.length; i += 4)
        if (!steady[i + 3] && steady[i] - noStars[i] > 0.001) {
          stars++;
          const pixel = i / 4,
            x = (2 * ((pixel % w) + 0.5)) / w - 1,
            y = 1 - (2 * (Math.floor(pixel / w) + 0.5)) / h;
          const hw = inv[3] * x + inv[7] * y + inv[15],
            rx = inv[0] * x + inv[4] * y + inv[12] - eye[0] * hw,
            ry = inv[1] * x + inv[5] * y + inv[13] - eye[1] * hw,
            rz = inv[2] * x + inv[6] * y + inv[14] - eye[2] * hw;
          if (ry / Math.hypot(rx, ry, rz) < 0.2588) belowHorizon++;
        }
      check(
        stars > 30 && belowHorizon === 0,
        'Stars failed the 15-degree haze cutoff',
      );
      slider('stars', 1);
      const twinkle = await capture();
      await new Promise((resolve) => setTimeout(resolve, 650));
      const twinkleAgain = await capture();
      const twinkling = difference(twinkle, twinkleAgain, false);
      check(twinkling > 10, 'Stars did not twinkle');
      slider('glow', 1.5);
      const glow = await capture();
      check(
        difference(twinkleAgain, glow, false) > 1000,
        'Lunar corona missing',
      );
      slider('phase', 0.85);
      slider('stars', 0.8);
      slider('glow', 0.65);
      const lanterns = app.batches.at(-1),
        unlit = lanterns.instances.slice();
      for (let i = 20; i < unlit.length; i += 24) unlit[i] = 0;
      device.queue.writeBuffer(app.buffers.at(-1), 0, unlit);
      const noLanternWash = await capture();
      device.queue.writeBuffer(app.buffers.at(-1), 0, lanterns.instances);
      const lanternWash = await capture();
      let warmPixels = 0;
      for (let i = 0; i < lanternWash.length; i += 4) {
        check(
          lanternWash[i + 3] === noLanternWash[i + 3],
          'Lantern wash changed scene depth',
        );
        if (
          lanternWash[i + 3] > 0 &&
          lanternWash[i] - noLanternWash[i] > 0.001 &&
          lanternWash[i] - noLanternWash[i] >
            lanternWash[i + 2] - noLanternWash[i + 2]
        )
          warmPixels++;
      }
      check(warmPixels > 100, 'Soft amber window wash missing from masonry');
      const diagnostics = (
        await Promise.all(
          [app.geometryModule, app.presentModule, shader].map((module) =>
            module.getCompilationInfo(),
          ),
        )
      ).flatMap((info) =>
        info.messages.map((message) => ({
          type: message.type,
          message: message.message,
        })),
      );
      check(diagnostics.length === 0, 'Shader compilation diagnostics present');
      check(
        (await device.popErrorScope()) === null,
        'WebGPU validation failed',
      );
      return {
        phases,
        highlights,
        shadows,
        fogGeometry,
        horizon,
        stars,
        starsBelow15Degrees: belowHorizon,
        twinkling,
        lanternWashPixels: warmPixels,
        diagnostics,
        drawCalls: app.stats.drawCalls,
        instances: app.stats.instances,
      };
    } finally {
      read.destroy();
      output.destroy();
      app.start();
    }
  });
  const framing = [await moonFraming()];
  await page.screenshot({ path: 'test-results/night-citadel.png' });

  const before = await page.evaluate(() =>
    Array.from(window.nightCitadel.motion.slice(0, 3)),
  );
  await page.mouse.move(650, 420);
  await page.mouse.down();
  await page.mouse.move(720, 450, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const drag = await page.evaluate(() => ({
    motion: Array.from(window.nightCitadel.motion.slice(0, 3)),
    orbit: document.querySelector('#orbit').checked,
  }));
  assert(
    Math.abs(drag.motion[0] - before[0]) > 0.02 && !drag.orbit,
    'Drag orbit failed',
  );
  await page.mouse.wheel(0, 150);
  await page.waitForTimeout(350);
  assert(
    await page.evaluate(
      (previous) => window.nightCitadel.motion[2] > previous,
      drag.motion[2],
    ),
    'Wheel zoom failed',
  );
  await page.locator('#scene').focus();
  const yaw = await page.evaluate(() => window.nightCitadel.motion[0]);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  assert(
    await page.evaluate(
      (previous) => window.nightCitadel.motion[0] < previous,
      yaw,
    ),
    'Keyboard orbit failed',
  );
  await page.locator('#reset').click();
  await page.locator('#orbit').check();
  const rate = [];
  for (const target of ['60', '120']) {
    await page.locator('#cadence').selectOption(target);
    await page.waitForTimeout(2200);
    rate.push({
      target: Number(target),
      ...(await page.evaluate(() => ({ ...window.nightCitadel.stats }))),
    });
  }
  assert(
    rate[0].fps >= 55 && rate[0].fps <= 65,
    `60 FPS pacer drifted: ${JSON.stringify(rate)}`,
  );
  assert(
    rate[1].fps >= 90 && rate[1].fps <= 130,
    `120 FPS target regressed below its headless baseline: ${JSON.stringify(rate)}`,
  );
  await page.locator('#cadence').selectOption('60');
  const resources = await page.evaluate(async () => {
    const app = window.nightCitadel,
      names = [
        'createBuffer',
        'createTexture',
        'createBindGroup',
        'createRenderPipeline',
        'createComputePipeline',
      ],
      counts = Object.fromEntries(names.map((name) => [name, 0])),
      originals = names.map((name) => app.device[name]);
    for (let i = 0; i < names.length; i++)
      app.device[names[i]] = function (...args) {
        counts[names[i]]++;
        return originals[i].apply(this, args);
      };
    const staging = app.frameData,
      inverse = app.inverse,
      batches = app.batches,
      first = app.stats.frames;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (let i = 0; i < names.length; i++) app.device[names[i]] = originals[i];
    if (
      app.frameData !== staging ||
      app.inverse !== inverse ||
      app.batches !== batches
    )
      throw new Error('Staging storage changed');
    return { counts, frames: app.stats.frames - first };
  });
  assert(resources.frames > 60);
  assert(
    Object.values(resources.counts).every((count) => count === 0),
    'Steady frames allocated GPU resources',
  );

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const heapBefore = await cdp.send('Runtime.getHeapUsage');
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 4096,
    includeObjectsCollectedByMinorGC: true,
    includeObjectsCollectedByMajorGC: true,
  });
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,v8,disabled-by-default-v8.gc',
    transferMode: 'ReturnAsStream',
  });
  const heap = [],
    orbitFrames = [];
  orbitFrames.push(
    await page.evaluate(() => [
      performance.now(),
      window.nightCitadel.stats.frames,
    ]),
  );
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    heap.push(await cdp.send('Runtime.getHeapUsage'));
    orbitFrames.push(
      await page.evaluate(() => [
        performance.now(),
        window.nightCitadel.stats.frames,
      ]),
    );
  }
  const complete = new Promise((resolve) =>
    cdp.once('Tracing.tracingComplete', resolve),
  );
  await cdp.send('Tracing.end');
  const { stream } = await complete;
  let trace = '';
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle: stream });
    trace += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  await cdp.send('HeapProfiler.collectGarbage');
  const heapAfter = await cdp.send('Runtime.getHeapUsage');
  const sites = [];
  function visit(node) {
    if (node.selfSize) sites.push({ bytes: node.selfSize, ...node.callFrame });
    for (const child of node.children) visit(child);
  }
  visit(profile.head);
  sites.sort((a, b) => b.bytes - a.bytes);
  const events = JSON.parse(trace).traceEvents,
    collections = events.filter(
      (event) =>
        ['MinorGC', 'MajorGC'].includes(event.name) && event.ph === 'X',
    );
  const memory = {
    seconds: 15,
    autoOrbit: await page.locator('#orbit').isChecked(),
    heapBefore,
    heapAfter,
    retainedHeapChange: heapAfter.usedSize - heapBefore.usedSize,
    heapMinimum: Math.min(...heap.map((h) => h.usedSize)),
    heapMaximum: Math.max(...heap.map((h) => h.usedSize)),
    collections: collections.map(({ name, dur }) => ({
      name,
      durationMs: dur / 1000,
    })),
    allocationSites: sites.slice(0, 20),
  };
  const firstOrbit = orbitFrames[0],
    lastOrbit = orbitFrames.at(-1);
  const sustainedRate = {
    seconds: (lastOrbit[0] - firstOrbit[0]) / 1000,
    frames: lastOrbit[1] - firstOrbit[1],
    fps:
      ((lastOrbit[1] - firstOrbit[1]) * 1000) / (lastOrbit[0] - firstOrbit[0]),
    windows: orbitFrames
      .slice(1)
      .map(
        (sample, i) =>
          ((sample[1] - orbitFrames[i][1]) * 1000) /
          (sample[0] - orbitFrames[i][0]),
      ),
  };
  assert(
    sustainedRate.fps >= 55 && sustainedRate.fps <= 65,
    `Continuous orbit cadence drifted: ${JSON.stringify(sustainedRate)}`,
  );
  assert(
    memory.autoOrbit,
    'Allocation profile did not exercise continuous orbit',
  );
  assert(
    memory.retainedHeapChange < 256 * 1024,
    'Retained heap grew during steady orbit',
  );
  await writeFile(
    'test-results/night-citadel-allocation.heapprofile',
    JSON.stringify(profile),
  );
  await writeFile('test-results/night-citadel-trace.json', trace);

  const resize = await page.evaluate(() => {
    const app = window.nightCitadel,
      oldColor = app.target.color,
      oldDepth = app.target.depth,
      oldShadow = app.shadow,
      names = [
        'createBuffer',
        'createTexture',
        'createBindGroup',
        'createRenderPipeline',
      ],
      counts = Object.fromEntries(names.map((name) => [name, 0])),
      originals = names.map((name) => app.device[name]);
    let destroyed = 0;
    const colorDestroy = oldColor.destroy.bind(oldColor),
      depthDestroy = oldDepth.destroy.bind(oldDepth);
    oldColor.destroy = () => {
      destroyed++;
      colorDestroy();
    };
    oldDepth.destroy = () => {
      destroyed++;
      depthDestroy();
    };
    for (let i = 0; i < names.length; i++)
      app.device[names[i]] = function (...args) {
        counts[names[i]]++;
        return originals[i].apply(this, args);
      };
    document.querySelector('#scene').style.width = '1000px';
    app.resize();
    for (let i = 0; i < names.length; i++) app.device[names[i]] = originals[i];
    return {
      counts,
      destroyed,
      shadowRetained: app.shadow === oldShadow,
      width: app.target.width,
    };
  });
  assert.deepEqual(resize.counts, {
    createBuffer: 0,
    createTexture: 2,
    createBindGroup: 1,
    createRenderPipeline: 0,
  });
  assert.equal(resize.destroyed, 2);
  assert(resize.shadowRetained);
  await page.evaluate(
    () => (document.querySelector('#scene').style.width = ''),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await page.locator('#orbit').uncheck();
  await page.locator('#reset').click();
  await page.waitForTimeout(100);
  await page.locator('details').evaluate((details) => (details.open = false));
  framing.push(await moonFraming());
  await page.screenshot({ path: 'test-results/night-citadel-mobile.png' });
  const radius = await page.evaluate(() => window.nightCitadel.motion[2]);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 140, y: 350, id: 1 },
      { x: 240, y: 350, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: 90, y: 350, id: 1 },
      { x: 290, y: 350, id: 2 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await page.waitForTimeout(200);
  assert(
    await page.evaluate(
      (previous) => window.nightCitadel.motion[2] < previous,
      radius,
    ),
    'Pinch zoom failed',
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth === innerWidth,
    ),
    'Mobile controls overflow horizontally',
  );
  await page.evaluate(() => window.nightCitadel.dispose());
  const frames = await page.evaluate(() => window.nightCitadel.stats.frames);
  await page.waitForTimeout(100);
  assert(
    await page.evaluate(
      (previous) =>
        window.nightCitadel.disposed &&
        window.nightCitadel.stats.frames === previous,
      frames,
    ),
    'Teardown left animation running',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  const report = {
    hardware: browser.hardware,
    visual,
    framing,
    rate,
    resources,
    memory,
    sustainedRate,
    resize,
    checks: [
      'moon and geometry highlights',
      'opening moon visible above the keep on desktop and mobile',
      'crisp lunar shadows',
      'soft amber lantern wash without depth writes',
      'lunar phases',
      'haze in sky and foreground',
      'steady and twinkling stars above 15 degrees',
      'drag, wheel, keyboard, pinch',
      '60/120 pacing with headless frame limiter disabled',
      '15-second orbit allocation sampling including collected objects',
      'resource-free steady frames',
      'resize without pipelines or buffer leaks',
      'mobile layout',
      'clean teardown',
    ],
    performanceLimit:
      '60/120 are requested presentation cadences; GPU load and browser/display refresh can lower actual FPS. WebGPU command handles and browser internals allocate.',
  };
  await writeFile(
    'test-results/night-citadel.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
