// Explicitly authorized GPU diagnostic. Source Vite, unchanged scene commands.
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {installStartupApiTrace} from './support/afterlight-startup-api-trace.js';
import {installDemoLoadAudit} from './demo-load-audit.js';

function installResourceAudit() {
  const buffers = [], textures = [], devices = [], deviceRows = new WeakMap();
  const track = (method, rows) => {
    const create = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function (...args) {
      const value = create.apply(this, args), row = {resource: value, destroyed: 0}; rows.push(row);
      const destroy = value.destroy;
      value.destroy = function (...args) {row.destroyed++; return destroy.apply(this, args);};
      return value;
    };
  };
  track('createBuffer', buffers); track('createTexture', textures);
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = function (...args) {
    return request.apply(this, args).then(device => {const row = {resource: device, destroyed: 0}; deviceRows.set(device, row); devices.push(row); return device;});
  };
  const destroy = GPUDevice.prototype.destroy;
  GPUDevice.prototype.destroy = function (...args) {const row = deviceRows.get(this); if (row) row.destroyed++; return destroy.apply(this, args);};
  const summary = rows => ({created: rows.length, destroyed: rows.filter(row => row.destroyed > 0).length, alive: rows.filter(row => !row.destroyed).length,
    duplicateDestroyCalls: rows.reduce((total, row) => total + Math.max(0, row.destroyed - 1), 0)});
  window.startupResourceAudit = () => ({buffers: summary(buffers), textures: summary(textures), devices: summary(devices)});
}

const sourcePath = resolve('examples/gameplay-sandbox/src/main.ts'), source = await readFile(sourcePath, 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
if (!process.argv.includes('--run')) {
  console.log(JSON.stringify({prepared: true, sourceSha256, command: 'node scripts/trace-afterlight-startup.js --run',
    needsExclusiveGpuSlot: true, constructionOrShaderChanges: false})); process.exit(0);
}
const root = resolve('examples/gameplay-sandbox'), results = [], errors = [];
let server, browser, serverClosed = false, browserClosed = false;
await mkdir('test-results', {recursive: true});
const reportPath = resolve(`test-results/afterlight-startup-api-trace-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.json`);
const report = {capturedAt: new Date().toISOString(), sourceSha256, profile: {sourceVite: true, headless: true, browser: 'Edge',
  viewport: [1432, 768], deviceScaleFactor: 2, reducedMotion: true, networkThrottle: false, cpuThrottle: false, physicalMobile: false,
  contexts: ['first-fresh-browser-context', 'second-fresh-context-same-browser-caches'], exclusiveGpuSlotRequired: true},
  limits: 'Instrumented native API CPU/queue callback wall times, not GPU execution durations. Caller stacks and resource audits add overhead. Existing render/load-audit waits are traced; no diagnostic waits or GPU commands/queries are added. Source Vite includes transform/import costs and is not hosted/cold-download acceptance.', results, errors};
try {
  server = await createServer({root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'error', server: {host: '127.0.0.1', port: 5231, strictPort: true}});
  await server.listen();
  browser = await chromium.launch({channel: 'msedge', headless: true});
  for (const mode of report.profile.contexts) {
    const context = await browser.newContext({viewport: {width: 1432, height: 768}, deviceScaleFactor: 2});
    let release, heldRequest = false, page, contextClosed = false, row;
    const held = new Promise(resolve => {release = resolve;});
    try {
      page = await context.newPage(); const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      // One initialization item makes wrapper order explicit.
      await page.addInitScript({content: `(${installStartupApiTrace.toString()})();(${installResourceAudit.toString()})();(${installDemoLoadAudit.toString()})();`});
      await page.emulateMedia({reducedMotion: 'reduce'});
      await page.route(url => url.pathname.includes('/src/landscape-details.'), async route => {heldRequest = true; await held; await route.continue().catch(() => {});});
      await page.goto('http://127.0.0.1:5231/', {waitUntil: 'domcontentloaded'});
      await page.waitForFunction(() => window.afterlightStartup?.phase === 'principal' && window.demoLoad?.principalScenePresentedOpportunity > 0, null, {timeout: 60000});
      row = await page.evaluate(() => {
        const startup = afterlightStartup, trace = startupApiTrace.stop();
        const scene = {phase: startup.phase, batches: startup.settlement.scatter.batches.length, terrainTriangles: startup.landscape.mesh.geometry.indices.length / 3,
          explorerParts: startup.character.parts.length, geometryMeshes: [...startup.engine.meshes.values()].filter(mesh => mesh.geometry).length,
          waterSegments: startup.water.options.segments, spray: startup.water.options.spray, heightmapReady: !!startup.landscape.heightmap(), detailsAttached: !!startup.details,
          readiness: startup.readiness, audit: {...demoLoad}, canvas: [startup.engine.canvas.width, startup.engine.canvas.height], browser: navigator.userAgent, resourcesBeforeDispose: startupResourceAudit()};
        dispatchEvent(new PageTransitionEvent('pagehide'));
        return {scene, trace, disposed: startup.engine.disposed, resourcesAfterDispose: startupResourceAudit(), publishedLate: !!window.sandbox};
      });
      row.mode = mode; row.heldDetailRequest = heldRequest; row.pageErrors = pageErrors;
      results.push(row);
      assert.equal(row.scene.phase, 'principal'); assert.equal(row.scene.batches, 12); assert.equal(row.scene.terrainTriangles, 73728);
      assert.equal(row.scene.explorerParts, 14); assert.equal(row.scene.geometryMeshes, 15); assert.equal(row.scene.waterSegments, 256);
      assert.equal(row.scene.spray, true); assert.equal(row.scene.heightmapReady, true); assert.equal(row.scene.detailsAttached, false);
      assert.equal(row.heldDetailRequest, true); assert.equal(row.disposed, true); assert.equal(row.publishedLate, false); assert.deepEqual(pageErrors, []);
      assert.equal(row.trace.droppedEvents, 0); assert.ok(row.trace.submissions.length >= 2);
      const adapter = row.trace.events.find(event => event.method === 'requestAdapter:ready')?.adapter;
      assert.equal(adapter?.fallback, false, 'Native-hardware diagnostic cannot use a fallback adapter');
      assert.equal(row.resourcesAfterDispose.buffers.alive, 0); assert.equal(row.resourcesAfterDispose.textures.alive, 0); assert.equal(row.resourcesAfterDispose.devices.alive, 0);
      const cpuByMethod = {};
      for (const event of row.trace.events) if (event.end !== undefined) {
        const group = cpuByMethod[event.method] ??= {calls: 0, totalMs: 0, maxMs: 0}; const duration = event.end - event.start;
        group.calls++; group.totalMs += duration; group.maxMs = Math.max(group.maxMs, duration);
      }
      const lastPrincipalSubmission = row.trace.submissions.findLast(submission => submission.end <= row.scene.readiness.principalSceneSubmitted);
      assert.ok(lastPrincipalSubmission);
      const reflectionIds = new Set(row.trace.pipelines.filter(pipeline => pipeline.compute?.entry === 'reflectSky').map(pipeline => pipeline.id));
      const principalPasses = lastPrincipalSubmission.commandIds.flatMap(id => row.trace.commands[id]?.passIds ?? []).map(id => row.trace.passes[id]);
      const reflectionDispatchPasses = principalPasses.filter(pass => pass.dispatches.length && pass.pipelineIds.some(id => reflectionIds.has(id))).length;
      assert.ok(reflectionDispatchPasses > 0, 'Principal water must have a computed sky reflection in its own submitted chain');
      row.summary = {adapter, cpuByMethod, principalSubmissionId: lastPrincipalSubmission.id, submissions: row.trace.submissions.map(submission => ({...submission,
        passCount: submission.commandIds.reduce((count, id) => count + (row.trace.commands[id]?.passIds.length ?? 0), 0)})), waits: row.trace.waits,
        markers: row.scene.readiness, reflectionDispatchPasses, note: 'Wait completion callbacks can be delayed by main-thread/driver scheduling; subtracting callback timestamps does not isolate hardware raster duration.'};
    } finally {
      release();
      if (page && !page.isClosed()) await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide'))).catch(() => {});
      await context.close(); contextClosed = true;
      if (row) row.contextClosed = contextClosed;
    }
  }
} catch (error) {errors.push(error.stack ?? String(error)); throw error;}
finally {
  if (browser) {await browser.close(); browserClosed = true;}
  if (server) {await server.close(); serverClosed = true;}
  report.closed = {browserClosed, serverClosed}; report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve('test-results/afterlight-startup-api-trace.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({reportPath, results: results.map(row => ({mode: row.mode, summary: row.summary, resourcesAfterDispose: row.resourcesAfterDispose, contextClosed: row.contextClosed})), errors, closed: report.closed}, null, 2));
}
