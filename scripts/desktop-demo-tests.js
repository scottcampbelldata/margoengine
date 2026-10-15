// Recheck the bundled production demos on a hardware desktop GPU.
// DEMO_BASE_URL=https://margoengine.com node scripts/desktop-demo-tests.js
// Without DEMO_BASE_URL, preview the already-built site/dist; this script never builds.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {preview} from 'vite';
import {decodePNG} from '../tests/support/png.js';
import {installDemoLoadAudit} from './demo-load-audit.js';

const demos = [
  {name: 'citadel', path: '/night-citadel/', range: ['azimuth', 'azimuth-value']},
  {name: 'afterlight', path: '/gameplay-sandbox/', range: ['wave', 'wave-value']},
  {name: 'helmet', path: '/demos/flight-helmet.html'},
  {name: 'character', path: '/demos/character-animation.html'},
  {name: 'robot', path: '/demos/robot-expressive.html'},
  {name: 'meadow', path: '/demos/windy-meadow.html', range: ['strength', 'strength-value']},
  {name: 'earth', path: '/demos/earth/', range: ['sun', 'sun-value']},
];
const viewport = {width: 1440, height: 900}, resizedViewport = {width: 1280, height: 800};
const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
const headless = process.env.DEMO_HEADLESS !== 'false';
const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : [];
const output = resolve('test-results');
await mkdir(output, {recursive: true});
let server, browser;

// Collect allocations and validation errors before application modules execute.
function installDesktopAudit() {
  const audit = window.desktopDemoAudit = {
    textures: [], pipelines: [], adapters: [], devices: new Set(), live: new Map(),
    errors: [], submissions: 0, canvasPasses: 0, resolves: 0, destroyedDevices: 0,
  };
  addEventListener('unhandledrejection', event => {
    audit.errors.push('Unhandled rejection: ' + (event.reason?.message ?? String(event.reason)));
  });
  if (!globalThis.GPUAdapter) {audit.errors.push('WebGPU is unavailable'); return;}
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...parameters) {
    const info = this.info;
    audit.adapters.push({
      vendor: info?.vendor, architecture: info?.architecture, description: info?.description,
      fallback: info?.isFallbackAdapter ?? this.isFallbackAdapter ?? null,
    });
    const device = await requestDevice.apply(this, parameters);
    audit.devices.add(device);
    device.addEventListener('uncapturederror', event => audit.errors.push(event.error.message));
    const destroy = device.destroy.bind(device);
    let destroyed = false;
    device.destroy = () => {
      if (!destroyed) {destroyed = true; audit.destroyedDevices++;}
      return destroy();
    };
    return device;
  };
  for (const method of ['createBuffer', 'createTexture']) {
    const create = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(descriptor) {
      const resource = create.call(this, descriptor);
      const metadata = {kind: method === 'createTexture' ? 'texture' : 'buffer', label: descriptor.label ?? ''};
      if (method === 'createTexture') {
        const size = descriptor.size;
        Object.assign(metadata, {
          samples: descriptor.sampleCount ?? 1, format: descriptor.format,
          width: size.width ?? size[0], height: size.height ?? size[1] ?? 1,
        });
        audit.textures.push(metadata);
      }
      audit.live.set(resource, metadata);
      const destroy = resource.destroy.bind(resource);
      resource.destroy = () => {audit.live.delete(resource); return destroy();};
      return resource;
    };
  }
  for (const method of ['createRenderPipeline', 'createRenderPipelineAsync']) {
    const create = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(descriptor) {
      audit.pipelines.push({samples: descriptor.multisample?.count ?? 1, label: descriptor.label ?? ''});
      return create.call(this, descriptor);
    };
  }
  const canvasTextures = new WeakSet(), canvasViews = new WeakSet();
  const currentTexture = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function(...parameters) {
    const texture = currentTexture.apply(this, parameters);
    canvasTextures.add(texture);
    return texture;
  };
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(...parameters) {
    const view = createView.apply(this, parameters);
    if (canvasTextures.has(this)) canvasViews.add(view);
    return view;
  };
  const beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function(descriptor) {
    for (const attachment of descriptor.colorAttachments) if (attachment) {
      if (canvasViews.has(attachment.view) || canvasViews.has(attachment.resolveTarget)) audit.canvasPasses++;
      if (attachment.resolveTarget) audit.resolves++;
    }
    return beginRenderPass.call(this, descriptor);
  };
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function(...parameters) {
    audit.submissions++;
    return submit.apply(this, parameters);
  };
}

const density = page => page.evaluate(() => {
  const canvas = document.querySelector('canvas'), audit = window.desktopDemoAudit;
  return {
    deviceDpr: devicePixelRatio, viewport: [innerWidth, innerHeight],
    visualScale: visualViewport?.scale ?? 1, rootZoom: getComputedStyle(document.documentElement).zoom,
    css: [canvas.clientWidth, canvas.clientHeight], buffer: [canvas.width, canvas.height],
    effectiveDpr: [canvas.width / canvas.clientWidth, canvas.height / canvas.clientHeight],
    multisampledTextures: audit.textures.filter(texture => texture.samples === 4).length,
    liveMultisampledTextures: [...audit.live.values()].filter(resource => resource.kind === 'texture' && resource.samples === 4).length,
    currentSceneAttachments: [...audit.live.values()].filter(resource => resource.kind === 'texture' && resource.samples === 4 && resource.width === canvas.width && resource.height === canvas.height).length,
    multisampledPipelines: audit.pipelines.filter(pipeline => pipeline.samples === 4).length,
    resolves: audit.resolves, adapters: audit.adapters,
    typography: [...document.querySelectorAll('h1, button')].slice(0, 5).map(element => ({
      tag: element.tagName, fontSize: getComputedStyle(element).fontSize,
      cssWidth: element.getBoundingClientRect().width,
    })),
  };
});

function assertDensity(state, expectedViewport, name) {
  assert.equal(state.deviceDpr, 2, name + ' must retain native device DPR');
  assert.deepEqual(state.viewport, [expectedViewport.width, expectedViewport.height], name + ' CSS viewport changed');
  assert.equal(state.visualScale, 1, name + ' page scale changed');
  assert.ok(state.rootZoom === '1' || state.rootZoom === 'normal', name + ' root CSS zoom changed');
  assert.ok(state.css.every(size => size > 0), name + ' has an empty canvas');
  assert.deepEqual(state.buffer, state.css, name + ' must use DPR 1 backing dimensions');
  assert.deepEqual(state.effectiveDpr, [1, 1], name + ' must cap drawing DPR at 1');
  assert.ok(state.multisampledTextures > 0, name + ' lost 4x scene attachments');
  assert.ok(state.liveMultisampledTextures > 0, name + ' has no live 4x textures');
  assert.ok(state.currentSceneAttachments >= 2, name + ' has no 4x color/depth attachments at the current canvas dimensions');
  assert.ok(state.multisampledPipelines > 0, name + ' lost 4x scene pipelines');
  assert.ok(state.resolves > 0, name + ' never resolved multisampled color');
  assert.ok(state.adapters.length > 0, name + ' did not create a WebGPU device');
  for (const adapter of state.adapters) {
    assert.equal(adapter.fallback, false, name + ' must use a hardware GPU');
    assert.doesNotMatch(adapter.description ?? '', /swiftshader|software|llvmpipe|WARP/i, name + ' selected software rendering');
  }
}

async function canvasImage(page, path) {
  const bytes = await page.locator('canvas').first().screenshot({
    path, scale: 'css', style: 'body * {visibility:hidden!important} #scene, #viewport > canvas {visibility:visible!important}',
  });
  const {width, height, data} = await decodePNG(bytes);
  const background = data.subarray(0, 3);
  let subjectPixels = 0, sampledPixels = 0;
  for (let y = Math.floor(height * 0.2); y < height * 0.8; y++) {
    for (let x = Math.floor(width * 0.15); x < width * 0.85; x++) {
      const offset = (y * width + x) * 4;
      if (Math.abs(data[offset] - background[0]) + Math.abs(data[offset + 1] - background[1]) + Math.abs(data[offset + 2] - background[2]) > 30) subjectPixels++;
      sampledPixels++;
    }
  }
  assert.ok(subjectPixels > 2000, 'Only a blank/background canvas appeared: ' + path);
  return {width, height, subjectPixels, sampledPixels};
}

async function checkControls(page, demo) {
  if (demo.range) {
    const [inputId, outputId] = demo.range;
    const change = await page.evaluate(([inputId, outputId]) => {
      const input = document.getElementById(inputId), output = document.getElementById(outputId);
      const before = output.value ?? output.textContent, original = input.value;
      const step = Number(input.step) || 1, maximum = Number(input.max), minimum = Number(input.min);
      input.value = String(input.valueAsNumber + step <= maximum ? input.valueAsNumber + step : input.valueAsNumber - step);
      if (input.valueAsNumber < minimum) throw new Error('Invalid control range');
      input.dispatchEvent(new Event('input', {bubbles: true}));
      const after = output.value ?? output.textContent;
      input.value = original;
      input.dispatchEvent(new Event('input', {bubbles: true}));
      return {control: inputId, before, after, restored: output.value ?? output.textContent};
    }, demo.range);
    assert.notEqual(change.after, change.before, demo.name + ' control output did not respond');
    assert.equal(change.restored, change.before, demo.name + ' control did not restore');
    return change;
  }
  if (demo.name === 'helmet') {
    const toggle = page.locator('#ssao'), initial = await toggle.isChecked();
    assert.ok(await toggle.isEnabled(), 'Helmet SSAO control is disabled');
    await toggle.setChecked(!initial);
    assert.equal(await toggle.isChecked(), !initial);
    await toggle.setChecked(initial);
    return {control: 'ssao', toggled: true, restored: true};
  }
  const pause = page.locator('#pause'), initial = await pause.getAttribute('aria-pressed');
  await pause.click();
  assert.notEqual(await pause.getAttribute('aria-pressed'), initial, demo.name + ' animation pause did not respond');
  await pause.click();
  assert.equal(await pause.getAttribute('aria-pressed'), initial);
  assert.ok(await page.locator('#clip').isEnabled(), demo.name + ' clips are unavailable');
  assert.ok(await page.locator('#expression').isEnabled(), demo.name + ' facial expressions are unavailable');
  return {control: 'animation pause', toggled: true, restored: true};
}

// Native browser callback pacing is evidence, not a hardware/display FPS promise.
function nativeCadence(durationMs) {
  return new Promise(resolve => {
    const audit = window.desktopDemoAudit, start = performance.now();
    const submissions = audit.submissions, canvasPasses = audit.canvasPasses, timestamps = [];
    let frame;
    const observe = time => {timestamps.push(time); frame = requestAnimationFrame(observe);};
    frame = requestAnimationFrame(observe);
    setTimeout(() => {
      cancelAnimationFrame(frame);
      const elapsedMs = performance.now() - start;
      const intervals = timestamps.slice(1).map((time, index) => time - timestamps[index]).sort((a, b) => a - b);
      resolve({
        elapsedMs, callbacks: timestamps.length,
        callbackRateHz: timestamps.length > 1 ? (timestamps.length - 1) * 1000 / (timestamps.at(-1) - timestamps[0]) : 0,
        medianIntervalMs: intervals.length ? intervals[Math.floor(intervals.length / 2)] : null,
        p95IntervalMs: intervals.length ? intervals[Math.floor((intervals.length - 1) * 0.95)] : null,
        submissions: audit.submissions - submissions, canvasPasses: audit.canvasPasses - canvasPasses,
        note: 'Native callbacks and canvas passes; no FPS threshold or physical-display guarantee.',
      });
    }, durationMs);
  });
}

try {
  if (!process.env.DEMO_BASE_URL) server = await preview({
    configFile: false, root: 'site', build: {outDir: 'dist'}, logLevel: 'error',
    preview: {host: '127.0.0.1', port: 0},
  });
  const baseUrl = process.env.DEMO_BASE_URL ?? server.resolvedUrls.local[0];
  const label = (process.env.DEMO_REPORT_LABEL ?? (server ? 'local' : new URL(baseUrl).hostname)).replace(/[^a-z0-9_-]+/gi, '-');
  const prefix = 'desktop-demos-' + label, reportPath = resolve(output, prefix + '.json');
  const report = {
    baseUrl, browser: channel, headless, launchArgs: args, viewport, deviceScaleFactor: 2,
    recordedAt: new Date().toISOString(), results: [],
  };
  browser = await chromium.launch({channel: channel === 'bundled' ? undefined : channel, headless, args});
  report.browserVersion = browser.version();
  for (const demo of demos) {
    const result = {name: demo.name, path: demo.path, url: new URL(demo.path, baseUrl).href, errors: [], networkErrors: []};
    const context = await browser.newContext({viewport, deviceScaleFactor: 2, reducedMotion: 'no-preference'});
    let page;
    try {
      page = await context.newPage();
      page.setDefaultTimeout(60000);
      page.on('pageerror', error => result.errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error' || message.type() === 'warning' && /validation|Error while|Invalid (?:usage|pipeline|texture|buffer)/i.test(message.text())) result.errors.push(message.text());
      });
      page.on('response', response => {if (response.status() >= 400) result.networkErrors.push({url: response.url(), status: response.status()});});
      page.on('requestfailed', request => result.networkErrors.push({url: request.url(), error: request.failure()?.errorText}));
      await page.addInitScript(installDesktopAudit);
      await page.addInitScript(installDemoLoadAudit);
      const response = await page.goto(result.url, {waitUntil: 'domcontentloaded'});
      assert.ok(response?.ok(), demo.name + ' page request failed');
      await page.waitForFunction(() => window.demoLoad?.firstFrame > 0 && window.demoLoad?.ready > 0);
      result.initial = await density(page);
      assertDensity(result.initial, viewport, demo.name);
      assert.equal(await page.locator('#error, #error-message').allTextContents().then(values => values.join('').trim()), '', demo.name + ' displays an error');
      result.load = await page.evaluate(() => ({...window.demoLoad}));
      const uiPath = resolve(output, prefix + '-' + demo.name + '-ui.png');
      const ui = await decodePNG(await page.screenshot({path: uiPath, scale: 'device'}));
      assert.equal(ui.width, viewport.width * 2, demo.name + ' DOM screenshot lost native density');
      result.uiScreenshot = uiPath;
      const scenePath = resolve(output, prefix + '-' + demo.name + '-scene.png');
      result.scene = await canvasImage(page, scenePath);
      result.sceneScreenshot = scenePath;
      result.cadence = await page.evaluate(nativeCadence, 3000);
      result.controls = await checkControls(page, demo);
      await page.setViewportSize(resizedViewport);
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas');
        return innerWidth === 1280 && innerHeight === 800 && canvas.width === canvas.clientWidth && canvas.height === canvas.clientHeight;
      });
      result.resized = await density(page);
      assertDensity(result.resized, resizedViewport, demo.name + ' resized');
      assert.notDeepEqual(result.resized.css, result.initial.css, demo.name + ' canvas ignored resize');
      await page.locator('canvas').first().focus();
      await page.keyboard.down('ArrowRight');
      try {await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));}
      finally {await page.keyboard.up('ArrowRight');}
      result.keyboard = {key: 'ArrowRight', focusedCanvas: await page.evaluate(() => document.activeElement === document.querySelector('canvas'))};
      assert.ok(result.keyboard.focusedCanvas, demo.name + ' canvas cannot receive keyboard input');
      const resizedPath = resolve(output, prefix + '-' + demo.name + '-resized.png');
      result.resizedScene = await canvasImage(page, resizedPath);
      result.resizedScreenshot = resizedPath;
      result.resources = await page.evaluate(() => ({
        textures: desktopDemoAudit.textures, pipelines: desktopDemoAudit.pipelines,
        liveBeforeDispose: desktopDemoAudit.live.size,
        loadedResources: performance.getEntriesByType('resource').map(resource => ({url: resource.name, bytes: resource.transferSize})),
      }));
      result.cleanup = await page.evaluate(async () => {
        const audit = desktopDemoAudit;
        await Promise.all([...audit.devices].map(device => device.queue.onSubmittedWorkDone()));
        dispatchEvent(new Event('pagehide'));
        await new Promise(resolve => setTimeout(resolve, 0));
        return {live: audit.live.size, remaining: [...audit.live.values()], destroyedDevices: audit.destroyedDevices, errors: audit.errors};
      });
      assert.equal(result.cleanup.live, 0, demo.name + ' leaked GPU buffers/textures after pagehide');
      assert.ok(result.cleanup.destroyedDevices > 0, demo.name + ' did not release its WebGPU device');
      assert.deepEqual(result.cleanup.errors, [], demo.name + ' reported GPU errors or unhandled rejections');
      assert.deepEqual(result.errors, [], demo.name + ' reported browser errors');
      assert.deepEqual(result.networkErrors, [], demo.name + ' failed to load an asset');
      result.passed = true;
      console.log(demo.name + ': DPR 1 / 4x MSAA, rendered controls/resize/cleanup passed; native callback cadence ' + result.cadence.callbackRateHz.toFixed(1) + ' Hz');
    } catch (error) {
      result.passed = false;
      result.failure = error.stack ?? String(error);
      if (page && !page.isClosed()) {
        try {
          result.diagnostics = await page.evaluate(() => ({
            gpuErrors: window.desktopDemoAudit?.errors,
            load: window.demoLoad,
            status: document.querySelector('#status')?.textContent,
            error: document.querySelector('#error, #error-message')?.textContent,
          }));
        } catch (diagnosticError) {result.diagnostics = {failure: diagnosticError.message};}
      }
      process.exitCode = 1;
      console.error(demo.name + ': ' + error.message);
    } finally {
      await context.close();
      report.results.push(result);
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    }
  }
  console.log(reportPath);
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
