import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { decodePNG } from '../tests/support/png.js';

const flags = [
  '--start-maximized',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];
const main = await readFile('examples/package-benchmarks/main.js', 'utf8'),
  gltf = await readFile('packages/gltf-pro/dist/index.js', 'utf8'),
  usage = 'GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE';
assert.equal(gltf.split(usage).length, 2, 'Expected exactly one central PBR vertex allocation');
assert.equal(main.split('readiness.workloadConstructed = performance.now();').length, 2);
assert.equal(main.split('engine = created;').length, 2);
const exposed = main
  .replace(
    'readiness.workloadConstructed = performance.now();',
    'window.storageFixtureWorkload = workload; readiness.workloadConstructed = performance.now();',
  )
  .replace('engine = created;', 'engine = created; window.storageFixtureEngine = engine;');
await mkdir('test-results', { recursive: true });
const browser = await openBrowser({ headless: false, args: flags, port: 5198, startPath: '/tests/modern-game.html' }),
  instance = browser.page.context().browser(),
  origin = new URL(browser.page.url()).origin;
const report = {
  recordedAt: new Date().toISOString(),
  hardware: browser.hardware,
  note: 'Actual WebGPU functional/pixel integration; source-module test hooks only expose existing engine/workload and restore the old buffer usage for non-TAA parity. Android layout uses this Intel laptop, not a physical phone.',
  cases: [],
};
const save = () => writeFile('test-results/taa-pbr-storage-integration.json', JSON.stringify(report, null, 2) + '\n');
async function scene(profile, name, { oldUsage = false, attach = false, restore = false } = {}) {
  const context = await instance.newContext(profile.options),
    page = await context.newPage(),
    errors = [],
    record = { profile: profile.name, name, oldUsage, attach, restore };
  report.cases.push(record);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await context.addInitScript(() => {
    const devices = [],
      validation = [],
      request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await request.apply(this, args),
        item = { destroyed: false, buffers: [], textures: [], queries: 0, samples: [] };
      devices.push(item);
      for (const [method, field] of [
        ['createBuffer', 'buffers'],
        ['createTexture', 'textures'],
      ]) {
        const create = device[method];
        device[method] = function (descriptor) {
          const resource = create.call(this, descriptor),
            entry = { size: descriptor.size, usage: descriptor.usage, destroyed: false, destroyCalls: 0 };
          item[field].push(entry);
          const destroy = resource.destroy;
          resource.destroy = function () {
            entry.destroyed = true;
            entry.destroyCalls++;
            return destroy.call(this);
          };
          return resource;
        };
      }
      const pipeline = device.createRenderPipeline;
      device.createRenderPipeline = function (descriptor) {
        const result = pipeline.call(this, descriptor);
        item.samples.push(descriptor.multisample?.count ?? 1);
        return result;
      };
      const query = device.createQuerySet;
      device.createQuerySet = function (descriptor) {
        item.queries++;
        return query.call(this, descriptor);
      };
      const destroy = device.destroy;
      device.destroy = function () {
        item.destroyed = true;
        return destroy.call(this);
      };
      device.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
      return device;
    };
    window.storageFixtureObservation = () => ({ devices, validation });
  });
  await page.route('**/examples/package-benchmarks/main.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: exposed }),
  );
  if (oldUsage)
    await page.route('**/packages/gltf-pro/dist/index.js', async (route) => {
      const response = await route.fetch(),
        body = await response.text();
      assert.equal(body.split(usage).length, 2);
      await route.fulfill({ response, body: body.replace(usage, 'GPUBufferUsage.VERTEX') });
    });
  try {
    await page.goto(`${origin}/examples/package-benchmarks/index.html?package=${name}`);
    await page.bringToFront();
    await page.waitForFunction(
      () =>
        !document.getElementById('run').disabled &&
        window.packageBenchmark?.result().readiness.principalScenePresentedOpportunity > 0,
    );
    if (attach)
      await page.evaluate(async () => {
        const { TAA } = await import('/packages/taa/dist/index.js'),
          effect = TAA.attach(window.storageFixtureEngine);
        window.storageFixtureWorkload.models.forEach((model) => effect.add(model));
      });
    const render = () =>
      page.evaluate(() => {
        for (let i = 0; i < 8; i++) window.storageFixtureEngine.render({ delta: 0, culling: false });
      });
    await render();
    await page.evaluate(async () => {
      await window.storageFixtureEngine.gpu.queue.onSubmittedWorkDone();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const snapshot = () =>
      page.evaluate(() => {
        const workload = window.storageFixtureWorkload,
          engine = window.storageFixtureEngine,
          model = workload.models[0],
          deformed = new Set(model.primitives.map((primitive) => primitive.deformed).filter(Boolean));
        return {
          benchmark: window.packageBenchmark.result(),
          sources: workload.models.flatMap((model) =>
            model.shadowPrimitives.map((primitive) => ({
              usage: primitive.vertex.usage,
              size: primitive.vertex.size,
              deformed: deformed.has(primitive.vertex),
            })),
          ),
          camera: Array.from(engine.camera.matrix),
          observation: window.storageFixtureObservation(),
        };
      });
    record.initial = await snapshot();
    assert.equal(record.initial.benchmark.visible, record.initial.benchmark.expectedEngineVisible);
    assert.equal(record.initial.sources.length, record.initial.benchmark.renderedObjects);
    assert.equal(errors.length, 0);
    assert.deepEqual(record.initial.observation.validation, []);
    if (!oldUsage)
      assert.ok(
        record.initial.sources.every((source) => (source.usage & 168) === 168),
        'PBR source lost VERTEX/COPY_DST/STORAGE',
      );
    else
      assert.ok(
        record.initial.sources.some((source) => (source.usage & 128) === 0),
        'Old-usage baseline did not actually remove storage capability',
      );
    if (name === 'taa') {
      assert.ok(record.initial.sources.some((source) => source.deformed));
      assert.ok(record.initial.sources.some((source) => !source.deformed));
    }
    const path = `test-results/taa-pbr-storage-${profile.name}-${name}-${oldUsage ? 'original' : 'fixed'}.png`,
      png = await page.locator('#scene').screenshot({ path }),
      decoded = await decodePNG(png),
      colors = new Set();
    for (let i = 0; i < decoded.data.length; i += 64)
      colors.add((decoded.data[i] << 16) | (decoded.data[i + 1] << 8) | decoded.data[i + 2]);
    assert.ok(colors.size > 8, 'Actual package image is blank');
    record.image = { path, width: decoded.width, height: decoded.height, colors: colors.size };
    if (restore) {
      await page.evaluate(() => window.storageFixtureEngine.rebootDevice());
      await render();
      await page.evaluate(() => window.storageFixtureEngine.gpu.queue.onSubmittedWorkDone());
      record.restored = await snapshot();
      assert.equal(record.restored.benchmark.visible, record.initial.benchmark.visible);
      assert.deepEqual(record.restored.camera, record.initial.camera);
      assert.ok(record.restored.sources.every((source) => (source.usage & 168) === 168));
      assert.equal(record.restored.observation.devices.length, 2);
      assert.equal(record.restored.observation.devices[0].destroyed, true);
      assert.ok(record.restored.observation.devices[0].buffers.every((resource) => resource.destroyed));
      assert.deepEqual(record.restored.observation.validation, []);
    }
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    record.closed = await page.evaluate(() => window.storageFixtureObservation());
    assert.deepEqual(record.closed.validation, []);
    assert.ok(record.closed.devices.every((device) => device.destroyed && device.queries === 0));
    for (const device of record.closed.devices)
      for (const resource of [...device.buffers, ...device.textures])
        assert.equal(resource.destroyCalls, 1, 'Owned resource was not destroyed exactly once');
    record.errors = errors;
    assert.deepEqual(errors, []);
    await save();
    return decoded;
  } catch (error) {
    record.failure = error.stack;
    record.errors = errors;
    try {
      record.failedObservation = await page.evaluate(() => window.storageFixtureObservation());
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
      record.failedCleanup = await page.evaluate(() => window.storageFixtureObservation());
    } catch {}
    await save();
    throw error;
  } finally {
    await context.close();
  }
}
try {
  await browser.page.context().close();
  const profiles = [
    { name: 'native', options: { viewport: null } },
    {
      name: 'android-layout-on-intel',
      options: {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36',
      },
    },
  ];
  for (const profile of profiles) {
    for (const name of ['animator', 'blender']) {
      const original = await scene(profile, name, { oldUsage: true }),
        fixed = await scene(profile, name);
      assert.equal(fixed.width, original.width);
      assert.equal(fixed.height, original.height);
      assert.deepEqual(fixed.data, original.data, 'Existing non-TAA image changed when adding the storage usage flag');
      report.cases.at(-1).exactOriginalUsageImageParity = true;
      await save();
    }
    await scene(profile, 'taa', { restore: true });
    await scene(profile, 'blender', { attach: true, restore: true });
  }
  report.completedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      cases: report.cases.length,
      validationErrors: report.cases.reduce((n, c) => n + c.closed.validation.length, 0),
      ownedResourcesDestroyed: report.cases.reduce(
        (n, c) => n + c.closed.devices.reduce((n, d) => n + d.buffers.length + d.textures.length, 0),
        0,
      ),
    }),
  );
} finally {
  await browser.close();
}
