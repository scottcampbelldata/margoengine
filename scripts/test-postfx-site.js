import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { preview } from 'vite';
import { chromium } from '@playwright/test';
import { decodePNG } from '../tests/support/png.js';
import { installDemoLoadAudit } from './demo-load-audit.js';

await mkdir('test-results', { recursive: true });
const snapshot = await mkdtemp(resolve('test-results/postfx-site-'));
await cp('site/dist', snapshot, { recursive: true });
const server = await preview({
    configFile: false,
    root: snapshot,
    build: { outDir: '.' },
    logLevel: 'error',
    preview: { host: '127.0.0.1', port: 0 },
  }),
  origin = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  channel: 'msedge',
  headless: false,
  args: [
    '--start-maximized',
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
});
const report = {
    recordedAt: new Date().toISOString(),
    snapshot,
    browserVersion: browser.version(),
    note: 'Built actual dist-package demos; Android layout uses the Windows Intel GPU. Functional/load evidence is not physical Android or cold hosted acceptance.',
    cases: [],
  },
  save = () => writeFile('test-results/postfx-immediate-use-site.json', JSON.stringify(report, null, 2) + '\n');
const identity = [];
for (let b = 0; b < 33; b++)
  for (let g = 0; g < 33; g++) for (let r = 0; r < 33; r++) identity.push(`${1 - r / 32} ${1 - g / 32} ${1 - b / 32}`);
const lut = Buffer.from('LUT_3D_SIZE 33\n' + identity.join('\n') + '\n');
async function scene(name, profile, abort = false) {
  const context = await browser.newContext(profile.options),
    page = await context.newPage(),
    errors = [],
    record = { name, profile: profile.name, abort };
  report.cases.push(record);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await context.addInitScript(installDemoLoadAudit);
  await context.addInitScript(() => {
    const devices = [],
      validation = [],
      request = GPUAdapter.prototype.requestDevice;
    let release,
      started = false,
      held = false;
    window.holdPostfxDevice = () => {
      held = true;
    };
    window.releasePostfxDevice = () => release?.();
    GPUAdapter.prototype.requestDevice = async function (...args) {
      started = true;
      if (held) await new Promise((resolve) => (release = resolve));
      const device = await request.apply(this, args),
        entry = {
          destroyed: false,
          buffers: [],
          textures: [],
          queries: 0,
          submits: 0,
          adapter: {
            vendor: this.info.vendor,
            architecture: this.info.architecture,
            fallback: this.info.isFallbackAdapter ?? this.isFallbackAdapter ?? null,
          },
        };
      devices.push(entry);
      for (const [method, field] of [
        ['createBuffer', 'buffers'],
        ['createTexture', 'textures'],
      ]) {
        const create = device[method];
        device[method] = function (descriptor) {
          const resource = create.call(this, descriptor),
            item = { size: descriptor.size, usage: descriptor.usage, destroyCalls: 0 };
          entry[field].push(item);
          const destroy = resource.destroy;
          resource.destroy = function () {
            item.destroyCalls++;
            return destroy.call(this);
          };
          return resource;
        };
      }
      const destroy = device.destroy;
      device.destroy = function () {
        entry.destroyed = true;
        return destroy.call(this);
      };
      const query = device.createQuerySet;
      device.createQuerySet = function (descriptor) {
        entry.queries++;
        return query.call(this, descriptor);
      };
      const submit = device.queue.submit;
      device.queue.submit = function (...values) {
        entry.submits++;
        return submit.apply(this, values);
      };
      device.addEventListener('uncapturederror', (event) => validation.push(event.error.message));
      return device;
    };
    window.postfxSiteObservation = () => ({ devices, validation, started, held });
  });
  if (abort) await page.addInitScript(() => window.holdPostfxDevice());
  try {
    await page.goto(origin + 'demos/' + name + '/');
    await page.bringToFront();
    if (abort) {
      await page.waitForFunction(() => window.postfxSiteObservation().started);
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
      await page.evaluate(() => window.releasePostfxDevice());
      await page.waitForFunction(
        () =>
          window.postfxSiteObservation().devices.length > 0 &&
          window.postfxSiteObservation().devices.every((device) => device.destroyed),
      );
      assert.equal(
        await page.evaluate((name) => !!window[name + 'Demo'], name),
        false,
        'Closed startup published a late demo',
      );
    } else {
      await page.waitForFunction(
        (name) => window[name + 'Demo']?.readiness.principalScenePresentedOpportunity > 0,
        name,
      );
      const value = await page.evaluate((name) => {
        const demo = window[name + 'Demo'];
        return {
          readiness: demo.readiness,
          principalObjects: demo.principalObjects,
          stats: demo.stage.engine.stats,
          load: window.demoLoad,
          observation: window.postfxSiteObservation(),
        };
      }, name);
      record.initial = value;
      assert.equal(value.principalObjects, name === 'dof' ? 16 : 6);
      assert.equal(value.stats.visible, value.principalObjects);
      assert.ok(value.load.draws > 0);
      assert.equal(value.readiness.correlation, 'identified-webgpu-submit');
      assert.ok(
        value.readiness.principalSceneSubmitted <= value.readiness.principalSceneGpuComplete &&
          value.readiness.principalSceneGpuComplete <= value.readiness.principalScenePresentedOpportunity,
      );
      assert.equal(value.load.principalScenePresentedOpportunity, value.readiness.principalScenePresentedOpportunity);
      assert.deepEqual(value.observation.validation, []);
      assert.equal(value.observation.devices[0].adapter.vendor, 'intel');
      assert.equal(value.observation.devices[0].adapter.fallback, false);
      const path = `test-results/postfx-${name}-${profile.name}.png`,
        original = await page.locator('#viewport').screenshot({ path }),
        decoded = await decodePNG(original),
        colors = new Set();
      for (let i = 0; i < decoded.data.length; i += 64)
        colors.add((decoded.data[i] << 16) | (decoded.data[i + 1] << 8) | decoded.data[i + 2]);
      assert.ok(colors.size > 8, 'Actual effect demo is blank');
      record.image = { path, width: decoded.width, height: decoded.height, colors: colors.size };
      const settled = () =>
        page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (name === 'dof') {
        await page.locator('#focus').fill('4');
        await page.locator('#focus').dispatchEvent('input');
        assert.equal(await page.evaluate(() => window.dofDemo.effect.options.focalDistance), 4);
        await page.locator('#enabled').uncheck();
        await settled();
        assert.equal(await page.evaluate(() => window.dofDemo.effect.enabled), false);
        assert.notDeepEqual(
          (await decodePNG(await page.locator('#viewport').screenshot())).data,
          decoded.data,
          'Actual DOF toggle did not change pixels',
        );
        await page.locator('#length').fill('100');
        await page.locator('#length').dispatchEvent('input');
        await page.locator('#aperture').fill('2');
        await page.locator('#aperture').dispatchEvent('input');
        assert.equal(await page.evaluate(() => window.dofDemo.effect.options.focalLength), 0.1);
        assert.equal(await page.evaluate(() => window.dofDemo.effect.options.aperture), 2);
        await page.locator('#enabled').check();
      } else {
        await page.locator('#curve').selectOption('neutral');
        await page.locator('#exposure').fill('2');
        await page.locator('#exposure').dispatchEvent('input');
        await page.locator('#contrast').fill('0.8');
        await page.locator('#contrast').dispatchEvent('input');
        await settled();
        assert.deepEqual(
          await page.evaluate(() => [
            window.tonemapDemo.effect.options.curve,
            window.tonemapDemo.effect.options.exposure,
            window.tonemapDemo.effect.options.contrast,
          ]),
          ['neutral', 2, 0.8],
        );
        assert.notDeepEqual(
          (await decodePNG(await page.locator('#viewport').screenshot())).data,
          decoded.data,
          'Actual color controls did not change pixels',
        );
        await page.locator('#lut').setInputFiles({ name: 'invert.cube', mimeType: 'text/plain', buffer: lut });
        await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('LUT loaded'));
        assert.equal(await page.evaluate(() => window.tonemapDemo.effect.lut.data.length), 33 * 33 * 33 * 4);
        await page.locator('#clear-lut').click();
        assert.equal(await page.evaluate(() => window.tonemapDemo.effect.lut), undefined);
        await page
          .locator('#lut')
          .setInputFiles({ name: 'invalid.cube', mimeType: 'text/plain', buffer: Buffer.from('LUT_3D_SIZE 2\n') });
        await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('LUT rejected'));
        await page.evaluate(() => {
          window.finishPostfxFileRead = undefined;
          const text = File.prototype.text;
          File.prototype.text = function () {
            return this.name === 'held.cube'
              ? new Promise((resolve) => (window.finishPostfxFileRead = () => resolve('LUT_3D_SIZE 2\n')))
              : text.call(this);
          };
        });
        await page
          .locator('#lut')
          .setInputFiles({ name: 'held.cube', mimeType: 'text/plain', buffer: Buffer.from('held') });
        await page.waitForFunction(() => !!window.finishPostfxFileRead);
        await page.locator('#clear-lut').click();
        await page.evaluate(() => window.finishPostfxFileRead());
        await settled();
        assert.equal(
          await page.locator('#status').textContent(),
          'LUT cleared',
          'Late file read replaced a later clear choice',
        );
      }
      await page.setViewportSize({ width: profile.name === 'native' ? 1000 : 360, height: 780 });
      await settled();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(
        await page.evaluate((name) => window[name + 'Demo'].stage.engine.stats.visible, name),
        value.principalObjects,
      );
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    }
    record.closed = await page.evaluate(() => window.postfxSiteObservation());
    assert.deepEqual(record.closed.validation, []);
    assert.ok(record.closed.devices.every((device) => device.destroyed && device.queries === 0));
    for (const device of record.closed.devices)
      for (const resource of [...device.buffers, ...device.textures]) assert.equal(resource.destroyCalls, 1);
    record.errors = errors;
    assert.deepEqual(errors, []);
    await save();
  } catch (error) {
    record.failure = error.stack;
    record.errors = errors;
    try {
      record.failed = await page.evaluate(() => ({
        load: window.demoLoad,
        observation: window.postfxSiteObservation(),
        status: document.getElementById('status')?.textContent,
      }));
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    } catch {}
    await save();
    throw error;
  } finally {
    await context.close();
  }
}
try {
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
          'Mozilla/5.0 (Linux; Android 14; Test layout) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36',
      },
    },
  ];
  for (const profile of profiles) for (const name of ['dof', 'tonemap']) await scene(name, profile);
  for (const name of ['dof', 'tonemap']) await scene(name, profiles[0], true);
  report.completedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      cases: report.cases.length,
      errors: report.cases.reduce((n, c) => n + c.errors.length + c.closed.validation.length, 0),
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
