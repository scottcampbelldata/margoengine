// Functional source test; native cold-load and frame-budget measurements are separate.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { installDemoLoadAudit } from './demo-load-audit.js';

await mkdir('test-results', { recursive: true });
const root = resolve('examples/gameplay-sandbox');
const server = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5198, strictPort: true },
});
await server.listen();
let browser, hardware;
const results = [];
try {
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true });
  for (const mode of ['desktop-default', 'desktop-controls', 'android-layout', 'failed-detail', 'pagehide']) {
    const mobile = mode === 'android-layout';
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1432, height: 768 },
      deviceScaleFactor: mobile ? 3 : 2,
      isMobile: mobile,
      hasTouch: mobile,
      ...(mobile
        ? {
            userAgent:
              'Mozilla/5.0 (Linux; Android 15; Test layout) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36',
          }
        : {}),
    });
    try {
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(installDemoLoadAudit);
      await page.addInitScript(() => {
        const pipelines = new WeakMap(),
          selected = new WeakMap();
        window.afterlightReflectionDispatches = 0;
        const create = GPUDevice.prototype.createComputePipeline;
        GPUDevice.prototype.createComputePipeline = function (descriptor) {
          const pipeline = create.call(this, descriptor);
          pipelines.set(pipeline, descriptor.compute.entryPoint);
          return pipeline;
        };
        const bind = GPUComputePassEncoder.prototype.setPipeline;
        GPUComputePassEncoder.prototype.setPipeline = function (pipeline) {
          const value = bind.call(this, pipeline);
          selected.set(this, pipelines.get(pipeline));
          return value;
        };
        const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
        GPUComputePassEncoder.prototype.dispatchWorkgroups = function (...counts) {
          const value = dispatch.apply(this, counts);
          if (selected.get(this) === 'reflectSky') window.afterlightReflectionDispatches++;
          return value;
        };
      });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      let release,
        requested = false;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(
        (url) => url.pathname.includes('/src/landscape-details.'),
        async (route) => {
          requested = true;
          await held;
          if (mode === 'failed-detail') await route.abort('failed');
          else await route.continue();
        },
      );
      await page.goto('http://127.0.0.1:5198/');
      await page.waitForFunction(() => window.afterlightStartup?.phase === 'principal', null, { timeout: 60000 });
      await page.waitForFunction(() => window.demoLoad.principalScenePresentedOpportunity > 0);
      hardware ??= await page.evaluate(async () => {
        const adapter = await navigator.gpu.requestAdapter();
        return {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          fallback: adapter.info.isFallbackAdapter,
          browser: navigator.userAgent,
        };
      });
      const principal = await page.evaluate(() => {
        const s = afterlightStartup;
        window.initialAfterlightHeightmap = s.landscape.heightmap();
        return {
          readiness: s.readiness,
          loadAudit: { ...demoLoad },
          batches: s.settlement.scatter.batches.length,
          trees: s.settlement.scatter.batches
            .filter((b) => b.name.includes('canopy'))
            .reduce((n, b) => n + b.instances, 0),
          terrainTriangles: s.landscape.mesh.geometry.indices.length / 3,
          explorerParts: s.character.parts.length,
          geometryMeshes: [...s.engine.meshes.values()].filter((m) => m.geometry).length,
          waterSegments: s.water.options.segments,
          spray: s.water.options.spray,
          reflectionDispatches: window.afterlightReflectionDispatches,
          heightmapReady: !!initialAfterlightHeightmap,
          shadowsAttached: !!s.shadows.owner,
          detailAttached: !!s.details,
          particlesSelected: document.querySelector('#particles').value,
          controlsEnabled: !document.querySelector('#controls').disabled,
          paused: document.querySelector('#pause').getAttribute('aria-pressed') === 'true',
        };
      });
      assert.equal(principal.batches, 12);
      assert.equal(principal.trees, 10);
      assert.equal(principal.explorerParts, 14);
      assert.equal(principal.geometryMeshes, 15);
      assert.equal(principal.terrainTriangles, mobile ? 18_432 : 73_728);
      assert.equal(principal.waterSegments, mobile ? 64 : 256);
      assert.equal(principal.spray, true);
      await writeFile(
        `test-results/afterlight-first-reflection-${mode}.json`,
        JSON.stringify(principal, null, 2) + '\n',
      );
      assert.ok(
        principal.reflectionDispatches > 0,
        'The complete principal water must include its computed sky reflection',
      );
      assert.equal(principal.heightmapReady, true);
      assert.equal(principal.shadowsAttached, false);
      assert.equal(principal.detailAttached, false);
      assert.equal(principal.controlsEnabled, true);
      assert.equal(principal.paused, true);
      assert.equal(principal.particlesSelected, mobile ? '100000' : '1000000');
      assert.ok(principal.readiness.principalSceneSubmitted > 0);
      assert.ok(principal.readiness.principalSceneGpuComplete >= principal.readiness.principalSceneSubmitted);
      assert.ok(
        principal.readiness.principalScenePresentedOpportunity >= principal.readiness.principalSceneGpuComplete,
      );
      assert.equal(
        principal.loadAudit.ready,
        0,
        'Late complete-detail readiness must stay distinct from the principal world',
      );
      assert.equal(
        principal.loadAudit.principalScenePresentedOpportunity,
        principal.readiness.principalScenePresentedOpportunity,
      );
      assert.ok(requested, 'Secondary module must start fetching only after the complete principal scene');
      if (mode === 'desktop-controls') {
        await page.selectOption('#particles', '0');
        await page.check('#wireframe');
        await page.locator('#sun').evaluate((element) => {
          element.value = '12';
          element.dispatchEvent(new Event('input'));
        });
        await page.locator('#wave').evaluate((element) => {
          element.value = '0.5';
          element.dispatchEvent(new Event('input'));
        });
      }
      if (mode === 'pagehide') await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
      release();
      if (mode === 'pagehide') {
        await page.waitForTimeout(150);
        const final = await page.evaluate(() => ({
          disposed: afterlightStartup.engine.disposed,
          detailAttached: !!afterlightStartup.details,
          shadowDisposed: (() => {
            try {
              afterlightStartup.shadows.add(afterlightStartup.landscape.mesh);
              return false;
            } catch {
              return true;
            }
          })(),
          publishedLate: !!window.sandbox,
        }));
        assert.deepEqual(final, { disposed: true, detailAttached: false, shadowDisposed: true, publishedLate: false });
        results.push({ mode, principal, final });
      } else {
        await page.waitForFunction(() => !!window.sandbox, null, { timeout: 60000 });
        const final = await page.evaluate(() => {
          const s = sandbox,
            d = afterlightStartup;
          return {
            phase: d.phase,
            disposed: s.engine.disposed,
            terrainSame: d.landscape.heightmap() === initialAfterlightHeightmap,
            grass: d.details?.grass.count,
            fieldstones: d.details?.fieldstones.count,
            particles: s.particles?.capacity ?? 0,
            shadowResolution: s.shadows.options.resolution,
            shadowAttached: !!s.shadows.owner,
            wireframe: d.details?.wireframe.visible,
            hours: s.sky.options.hours,
            wave: document.querySelector('#wave').value,
            camera: Array.from(s.engine.camera.position),
            paused: document.querySelector('#pause').getAttribute('aria-pressed') === 'true',
          };
        });
        assert.equal(final.disposed, false);
        assert.equal(final.terrainSame, true);
        assert.equal(final.paused, true);
        if (mode === 'failed-detail') {
          assert.equal(final.phase, 'detail-failed');
          assert.equal(final.grass, undefined);
          assert.equal(final.particles, 0);
          assert.equal(final.shadowAttached, false);
          assert.ok((await page.locator('#status').textContent()).includes('World ready'));
        } else {
          assert.equal(final.phase, 'complete');
          assert.equal(final.grass, mobile ? 25_000 : 110_000);
          assert.equal(final.fieldstones, 950);
          assert.equal(final.particles, mode === 'desktop-controls' ? 0 : mobile ? 100_000 : 1_000_000);
          assert.equal(final.shadowResolution, mobile ? 512 : 1024);
          assert.equal(final.shadowAttached, true);
          assert.equal(final.wireframe, mode === 'desktop-controls');
          assert.equal(final.hours, mode === 'desktop-controls' ? 12 : 17.57);
          assert.equal(final.wave, mode === 'desktop-controls' ? '0.5' : '0.35');
        }
        await page.evaluate(() => sandbox.dispose());
        assert.equal(await page.evaluate(() => afterlightStartup.engine.disposed), true);
        results.push({ mode, principal, final });
      }
      assert.deepEqual(errors, [], mode + ' emitted a browser exception');
      console.log(
        JSON.stringify({ mode, principalMs: principal.readiness.principalScenePresentedOpportunity, checks: 'passed' }),
      );
    } finally {
      await context.close();
    }
  }
  await writeFile(
    'test-results/afterlight-streaming.json',
    JSON.stringify({ hardware, headless: true, results }, null, 2) + '\n',
  );
} finally {
  await browser?.close();
  await server.close();
}
