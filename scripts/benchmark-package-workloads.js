import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePNG } from '../tests/support/png.js';

const defaults = {
  ecs: 10000,
  fsm: 1000,
  tween: 1000,
  net: 256,
  bvh: 256,
  splines: 384,
  navmesh: 96,
  wfc: 64,
  navigation: 128,
  physics: 80,
  road: 136,
  gizmo: 16,
  inspector: 16,
  labels: 16,
  html: 16,
  loaders: 4,
  exporters: 4,
  'usdz-export': 4,
  decoders: 4,
  ifc: 4,
  fbx: 4,
  points: 4,
  toon: 4,
  transitions: 4,
  animator: 1,
  taa: 1,
  text: 16,
  splats: 4,
  audio: 4,
  video: 4,
  blender: 4,
};
const assetPackages = ['loaders', 'exporters', 'usdz-export', 'decoders', 'ifc', 'fbx'];
const flags = [
  '--start-maximized',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];
const distribution = (values) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b),
    percentile = (fraction) => sorted[Math.ceil((sorted.length - 1) * fraction)];
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
};

/** Summarize actual render callbacks; gaps stay unclipped and pause intervals are excluded. */
export function summarize(samples, start, end) {
  assert.equal(samples.length % 4, 0, 'Incomplete sample row');
  const rows = [];
  for (let i = 0; i < samples.length; i += 4) {
    const row = samples.slice(i, i + 4);
    assert.ok(row.every(Number.isFinite) && row.slice(1).every((value) => value >= 0), 'Invalid timing sample');
    if (row[0] >= start && row[0] <= end && row[1] > 0 && row[0] - row[1] >= start) rows.push(row);
  }
  const elapsed = rows.length ? rows.at(-1)[0] - (rows[0][0] - rows[0][1]) : 0;
  return {
    callbacks: rows.length,
    measuredMilliseconds: elapsed,
    callbackHz: elapsed > 0 ? (rows.length * 1000) / elapsed : null,
    intervalMilliseconds: distribution(rows.map((row) => row[1])),
    workloadCpuMilliseconds: distribution(rows.map((row) => row[2])),
    renderCpuMilliseconds: distribution(rows.map((row) => row[3])),
    intervalsAbove60HzBudget: rows.filter((row) => row[1] > 1000 / 60 + 0.2).length,
  };
}

/** Preserve neighboring native callback rows around misses; CPU work belongs to that row's callback, not its preceding gap. */
export function missedFrameRows(samples, start, end) {
  summarize(samples, start, end); // Validate the same rows used by the target gate.
  const selected = new Set();
  for (let i = 0; i < samples.length; i += 4) {
    if (
      samples[i] >= start &&
      samples[i] <= end &&
      samples[i + 1] > 1000 / 60 + 0.2 &&
      samples[i] - samples[i + 1] >= start
    ) {
      for (const offset of [i - 4, i, i + 4]) if (offset >= 0 && offset < samples.length) selected.add(offset);
    }
  }
  return [...selected]
    .sort((a, b) => a - b)
    .map((i) => ({
      callbackAt: samples[i],
      intervalMilliseconds: samples[i + 1],
      workloadCpuMilliseconds: samples[i + 2],
      renderCpuMilliseconds: samples[i + 3],
    }));
}

async function runBenchmarks() {
  const { openBrowser } = await import('./browser.js');
  const packages = (process.env.WORKLOAD_PACKAGES ?? 'ecs,fsm,tween,net').split(',');
  assert.ok(packages.length && packages.every((name) => Object.hasOwn(defaults, name)), 'Unknown workload package');
  const duration = Number(process.env.WORKLOAD_DURATION_MS ?? 2500),
    warmup = Number(process.env.WORKLOAD_WARMUP_MS ?? 750);
  assert.ok(duration >= 1000 && duration <= 30000 && warmup >= 250 && warmup <= 5000, 'Invalid measurement duration');
  const prefix = process.env.WORKLOAD_REPORT_PREFIX ?? 'package-workload-benchmarks';
  assert.match(prefix, /^[a-zA-Z0-9-]{1,64}$/, 'Invalid report prefix');
  const trace = process.env.WORKLOAD_TRACE === '1';
  assert.ok(
    process.env.WORKLOAD_TRACE === undefined || ['0', '1'].includes(process.env.WORKLOAD_TRACE),
    'Invalid trace flag',
  );
  const profiles = [
    { name: 'native-windows-edge', options: { viewport: null } },
    {
      name: 'android-layout-emulation-on-intel',
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
  const requestedProfiles = process.env.WORKLOAD_PROFILES?.split(',');
  if (requestedProfiles)
    assert.ok(
      requestedProfiles.every((name) => profiles.some((profile) => profile.name === name)),
      'Unknown profile',
    );
  const bytes = [];
  for (const path of [...new Set(['core', 'stats', ...packages])]
    .map((name) => `packages/${name}/dist/index.js`)
    .concat(
      packages.map((name) => `examples/package-benchmarks/${name}.js`),
      [
        'examples/package-benchmarks/main.js',
        'examples/package-benchmarks/gpu-timing.js',
        'examples/package-benchmarks/factory-loading.js',
        'examples/package-benchmarks/ui-scene.js',
        'examples/package-benchmarks/asset-scene.js',
        'packages/shared/demo-frame.js',
      ],
    )) {
    const content = await readFile(path);
    bytes.push({
      path,
      bytes: content.length,
      gzipBytes: gzipSync(content).length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  const launchArgs = packages.includes('audio') ? [...flags, '--mute-audio'] : flags;
  const browser = await openBrowser({
    headless: false,
    args: launchArgs,
    startPath: '/tests/modern-game.html',
    port: 5199,
  });
  const origin = new URL(browser.page.url()).origin,
    instance = browser.page.context().browser();
  const report = {
    recordedAt: new Date().toISOString(),
    hardware: browser.hardware,
    launchArgs,
    duration,
    warmup,
    bytes,
    traceEnabled: trace,
    interpretation:
      'Foreground-throughput render callbacks, not displayed frames. Android layout/DPR uses this same Intel laptop GPU. Local Vite startup is not a cold production or physical-phone result. Optional timing measures pass execution and includes profiler overhead.',
    cases: [],
  };
  await mkdir('test-results', { recursive: true });
  const save = () => writeFile(`test-results/${prefix}.json`, JSON.stringify(report, null, 2) + '\n');
  try {
    await browser.page.context().close();
    for (const profile of profiles.filter((value) => !requestedProfiles || requestedProfiles.includes(value.name)))
      for (const name of packages) {
        const context = await instance.newContext({ ...profile.options, reducedMotion: 'no-preference' });
        await context.addInitScript(
          ({ trace, observeWorkers }) => {
            const devices = [],
              errors = [],
              states = [],
              workers = [],
              longTasks = [],
              original = GPUAdapter.prototype.requestDevice;
            if (trace) performance.setResourceTimingBufferSize(512);
            let observer;
            if (trace && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
              const collect = (entries) => {
                for (const entry of entries)
                  if (longTasks.length < 512)
                    longTasks.push({ at: entry.startTime, duration: entry.duration, name: entry.name });
              };
              observer = new PerformanceObserver((list) => collect(list.getEntries()));
              observer.observe({ type: 'longtask', buffered: true });
              addEventListener(
                'pagehide',
                () => {
                  collect(observer.takeRecords());
                  observer.disconnect();
                },
                { once: true },
              );
            }
            if (observeWorkers) {
              const OriginalWorker = Worker;
              globalThis.Worker = class ObservedWorker extends OriginalWorker {
                constructor(url, options) {
                  super(url, options);
                  const item = { url: String(url), name: options?.name ?? null, messages: 0, terminated: 0 };
                  workers.push(item);
                  const post = this.postMessage,
                    terminate = this.terminate;
                  this.postMessage = function (...args) {
                    const result = post.apply(this, args);
                    item.messages++;
                    return result;
                  };
                  this.terminate = function (...args) {
                    item.terminated++;
                    return terminate.apply(this, args);
                  };
                }
              };
            }
            const state = () => {
              if (states.length < 64)
                states.push({
                  at: performance.now(),
                  visibility: document.visibilityState,
                  focus: document.hasFocus(),
                });
            };
            addEventListener('focus', state);
            addEventListener('blur', state);
            document.addEventListener('visibilitychange', state);
            state();
            async function observed(...args) {
              const device = await original.apply(this, args),
                info = this.info,
                item = {
                  destroyed: false,
                  submits: 0,
                  queries: 0,
                  externalVideoImports: 0,
                  invalidVideoSources: 0,
                  features: Array.from(device.features),
                  adapter: {
                    vendor: info.vendor,
                    architecture: info.architecture,
                    device: info.device,
                    description: info.description,
                    fallback: info.isFallbackAdapter ?? this.isFallbackAdapter ?? null,
                  },
                };
              devices.push(item);
              const submit = device.queue.submit,
                destroy = device.destroy,
                query = device.createQuerySet;
              if (trace) {
                item.gpuApiCalls = [];
                item.firstSubmissions = [];
                for (const method of [
                  'createShaderModule',
                  'createComputePipeline',
                  'createRenderPipeline',
                  'createComputePipelineAsync',
                  'createRenderPipelineAsync',
                ]) {
                  const create = device[method];
                  device[method] = function (descriptor) {
                    const at = performance.now(),
                      call = {
                        method,
                        at,
                        label: descriptor.label ?? null,
                        entryPoint: descriptor.compute?.entryPoint ?? descriptor.fragment?.entryPoint ?? null,
                        sampleCount: descriptor.multisample?.count ?? null,
                        formats: descriptor.fragment?.targets?.map((target) => target?.format ?? null) ?? null,
                        shaderCharacters: method === 'createShaderModule' ? descriptor.code.length : null,
                      };
                    if (item.gpuApiCalls.length < 256) item.gpuApiCalls.push(call);
                    try {
                      const result = create.call(this, descriptor);
                      call.synchronousMilliseconds = performance.now() - at;
                      if (result instanceof Promise)
                        result.then(
                          () => {
                            call.completedAt = performance.now();
                          },
                          (error) => {
                            call.error = String(error.message ?? error);
                            call.completedAt = performance.now();
                          },
                        );
                      return result;
                    } catch (error) {
                      call.error = String(error.message ?? error);
                      call.synchronousMilliseconds = performance.now() - at;
                      throw error;
                    }
                  };
                }
              }
              device.queue.submit = function (...values) {
                const at = trace ? performance.now() : 0,
                  result = submit.apply(this, values);
                item.submits++;
                if (trace && item.firstSubmissions.length < 16)
                  item.firstSubmissions.push({
                    at,
                    synchronousMilliseconds: performance.now() - at,
                    commandBuffers: values[0].length,
                  });
                return result;
              };
              device.destroy = function (...values) {
                item.destroyed = true;
                return destroy.apply(this, values);
              };
              device.createQuerySet = function (...values) {
                const result = query.apply(this, values);
                item.queries++;
                return result;
              };
              const importExternal = device.importExternalTexture;
              device.importExternalTexture = function (descriptor) {
                const result = importExternal.call(this, descriptor);
                if (descriptor.source instanceof HTMLVideoElement) {
                  item.externalVideoImports++;
                  if (descriptor.source.readyState < 2 || !descriptor.source.videoWidth) item.invalidVideoSources++;
                }
                return result;
              };
              device.addEventListener('uncapturederror', (event) => {
                if (errors.length < 32) errors.push(event.error.message);
              });
              return device;
            }
            GPUAdapter.prototype.requestDevice = observed;
            window.workloadTestObservation = () => ({
              devices,
              errors,
              states,
              workers,
              hookRestored: GPUAdapter.prototype.requestDevice === observed,
              visibility: document.visibilityState,
              focus: document.hasFocus(),
              dpr: devicePixelRatio,
              viewport: [innerWidth, innerHeight],
              bodyOverflow: document.documentElement.scrollWidth > innerWidth,
              trace: trace
                ? {
                    longTasks: longTasks.slice(),
                    longTaskCapacity: 512,
                    navigation: performance.getEntriesByType('navigation').map((entry) => ({
                      started: entry.startTime,
                      responseStarted: entry.responseStart,
                      responseEnded: entry.responseEnd,
                      domContentLoaded: entry.domContentLoadedEventEnd,
                    })),
                    resourceCapacity: 256,
                    resourcesTruncated: performance.getEntriesByType('resource').length > 256,
                    resources: performance
                      .getEntriesByType('resource')
                      .slice(0, 256)
                      .map((entry) => ({
                        url: entry.name,
                        initiator: entry.initiatorType,
                        started: entry.startTime,
                        requestStarted: entry.requestStart,
                        responseStarted: entry.responseStart,
                        responseEnded: entry.responseEnd,
                        duration: entry.duration,
                        transferBytes: entry.transferSize,
                        encodedBytes: entry.encodedBodySize,
                        decodedBytes: entry.decodedBodySize,
                      })),
                  }
                : undefined,
            });
          },
          { trace, observeWorkers: name === 'decoders' },
        );
        const page = await context.newPage(),
          errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        const record = { profile: profile.name, package: name, expectedActors: defaults[name], runs: [] };
        report.cases.push(record);
        try {
          await page.goto(`${origin}/examples/package-benchmarks/index.html?package=${name}`);
          await page.bringToFront();
          const ready = async () => {
            await page.waitForFunction(
              () =>
                !document.getElementById('run').disabled &&
                window.packageBenchmark?.result().readiness.principalScenePresentedOpportunity > 0,
            );
            if (name === 'html')
              await page.waitForFunction(() => !window.packageBenchmark.result().workload.previewSettling);
            const value = await page.evaluate(() => window.packageBenchmark.result()),
              r = value.readiness;
            assert.equal(value.backend, 'webgpu');
            assert.equal(value.visible, value.expectedEngineVisible);
            assert.equal(r.principalObjects, value.renderedObjects);
            assert.ok(value.draws > 0);
            assert.equal(r.correlation, 'identified-webgpu-submit');
            assert.ok(
              r.assembled <= r.principalSceneSubmitted &&
                r.principalSceneSubmitted <= r.principalSceneGpuComplete &&
                r.principalSceneGpuComplete <= r.principalScenePresentedOpportunity,
            );
            return value;
          };
          const initial = await ready();
          assert.equal(initial.actors, defaults[name]);
          record.initialReadiness = initial.readiness;
          record.initialWorkload = initial.workload;
          if (trace) record.initialObservation = await page.evaluate(() => window.workloadTestObservation());
          record.initialSceneWithin1000ms = initial.readiness.principalScenePresentedOpportunity <= 1000;
          const imagePath = `test-results/${prefix}-${profile.name}-${name}.png`,
            png = await page.locator('#scene').screenshot({ path: imagePath }),
            decoded = await decodePNG(png),
            colors = new Set();
          for (
            let i = 0, step = Math.max(4, Math.floor(decoded.data.length / 20000 / 4) * 4);
            i < decoded.data.length;
            i += step
          )
            colors.add((decoded.data[i] << 16) | (decoded.data[i + 1] << 8) | decoded.data[i + 2]);
          assert.ok(colors.size > 8, 'Principal scene canvas is blank');
          record.initialScreenshot = {
            path: imagePath,
            width: decoded.width,
            height: decoded.height,
            sampledColors: colors.size,
          };
          if (['gizmo', 'inspector', 'labels', 'html'].includes(name)) {
            record.packageScreenshots = {
              stage: `test-results/${prefix}-${profile.name}-${name}-stage.png`,
              controls: `test-results/${prefix}-${profile.name}-${name}-controls.png`,
            };
            await page.locator('.stage').screenshot({ path: record.packageScreenshots.stage });
            await page.locator('#package-ui').screenshot({ path: record.packageScreenshots.controls });
          }
          for (const [index, enabled] of [false, true, true, false].entries()) {
            if (index) {
              const oldGeneration = await page.evaluate(() => window.packageBenchmark.result().generation);
              if ((await page.locator('#gpu-timing').isChecked()) !== enabled)
                await page.locator('#gpu-timing').setChecked(enabled);
              else await page.locator('#count').dispatchEvent('change');
              await page.waitForFunction(
                (previous) => window.packageBenchmark.result().generation > previous,
                oldGeneration,
              );
              await ready();
            }
            if (name === 'audio') {
              await page.locator('[data-ui-audio]').click();
              await page.waitForFunction(
                () =>
                  window.packageBenchmark.result().workload.enabled &&
                  window.packageBenchmark.result().workload.contextState === 'running',
              );
            }
            await page.locator('#run').focus();
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => window.packageBenchmark.result().running);
            await page.waitForTimeout(warmup);
            const start = await page.evaluate(() => ({
              at: performance.now(),
              value: window.packageBenchmark.result(),
              observation: window.workloadTestObservation(),
            }));
            await page.waitForTimeout(duration);
            const end = await page.evaluate(() => ({
              at: performance.now(),
              value: window.packageBenchmark.result({ samples: true }),
              observation: window.workloadTestObservation(),
            }));
            assert.ok(end.value.running && end.value.frames > start.value.frames, 'Workload did not advance');
            assert.equal(end.value.visible, end.value.expectedEngineVisible);
            assert.equal(end.value.actors, defaults[name]);
            assert.equal(end.value.gpuTimingEnabled, enabled);
            if (assetPackages.includes(name)) {
              const details = end.value.workload;
              assert.equal(details.jobError, null);
              assert.ok(details.completedJobs > defaults[name], 'Real asset jobs did not repeat');
              assert.equal(details.models, defaults[name]);
              assert.ok(details.sourceBytes > 0);
              if (name === 'loaders') {
                assert.equal(details.verticesPerModel, 855);
                assert.equal(details.trianglesPerModel, 1689);
              }
              if (['exporters', 'usdz-export'].includes(name)) {
                assert.equal(details.sourceVertices, 502);
                assert.equal(details.sourceTriangles, 1000);
              }
              if (name === 'exporters') {
                for (const key of ['glbBytes', 'plyBytes', 'objCharacters']) assert.ok(details[key] > 0);
                assert.equal(details.stlBytes, 84 + 1000 * 50);
              }
              if (name === 'usdz-export') assert.ok(details.outputBytes > 1000);
              if (name === 'decoders') {
                assert.equal(details.verticesPerModel, 406);
                assert.equal(details.trianglesPerModel, 682);
                assert.equal(details.workerLimit, 2);
                const active = end.observation.workers.filter((worker) => worker.terminated === 0);
                assert.equal(active.length, 2);
                assert.ok(
                  active.every((worker) => worker.name === 'margoengine-decoder' && worker.messages > 0),
                  'Actual two-worker Draco pool was not used',
                );
              }
              if (name === 'ifc') {
                assert.equal(details.schema, 'IFC4');
                assert.equal(details.trianglesPerModel, 12);
                assert.equal(details.productsPerModel, 1);
                assert.equal(details.firstExpressID, 25);
                assert.equal(details.firstProductName, 'Test wall');
                details.sourceExtentsMeters
                  .toSorted((a, b) => a - b)
                  .forEach((value, index) => assert.ok(Math.abs(value - [0.2, 3, 4][index]) < 1e-5));
              }
              if (name === 'fbx') {
                assert.equal(details.verticesPerModel, 3);
                assert.equal(details.trianglesPerModel, 1);
                assert.ok(details.glbBytes > 0);
              }
            }
            if (name === 'points') {
              assert.equal(end.value.workload.inputPoints, defaults[name] * 397);
              assert.ok(end.value.workload.pointDraws > 0 && end.value.workload.pointDrawCalls > 0);
              assert.equal(end.value.workload.sprites, defaults[name]);
              assert.ok(end.value.workload.positionUpdates > start.value.workload.positionUpdates);
            }
            if (name === 'transitions')
              assert.ok(
                end.value.workload.sceneSwitches > start.value.workload.sceneSwitches,
                'Actual scene transitions did not repeat',
              );
            if (name === 'animator') {
              assert.equal(end.value.workload.animatorControllers, defaults[name]);
              assert.equal(end.value.workload.registeredWaveLayers, defaults[name]);
              assert.equal(end.value.workload.pbrPrimitives, defaults[name] * 19);
              assert.ok(
                end.value.workload.transitions > start.value.workload.transitions,
                'Actual animator transitions did not advance',
              );
            }
            if (name === 'taa') {
              assert.equal(end.value.workload.registeredVelocityModels, defaults[name]);
              assert.equal(end.value.workload.pbrPrimitives, defaults[name] * 19);
              assert.equal(end.value.workload.taaEnabled, true);
            }
            if (name === 'text') {
              assert.equal(end.value.workload.textBlocks, defaults[name]);
              assert.ok(end.value.workload.glyphsDrawn > 0 && end.value.workload.textDrawCalls > 0);
              assert.ok(
                end.value.workload.textUpdates > start.value.workload.textUpdates,
                'Actual text strings did not update',
              );
            }
            if (name === 'splats') {
              assert.equal(end.value.workload.splats, defaults[name] * 397);
              assert.equal(end.value.workload.independentSorts, 1);
              assert.equal(end.value.workload.cameraOrbit, true);
            }
            if (name === 'blender') {
              assert.equal(end.value.workload.models, defaults[name]);
              assert.equal(end.value.workload.primitives, defaults[name] * 2);
              assert.ok(
                end.value.workload.decodedJobs > start.value.workload.decodedJobs,
                'Actual .margo decode work did not repeat',
              );
            }
            if (name === 'audio') {
              assert.equal(end.value.workload.contextState, 'running');
              assert.equal(end.value.workload.playingSources, defaults[name]);
              assert.ok(
                end.value.workload.contextSeconds > start.value.workload.contextSeconds,
                'Actual AudioContext timeline did not advance',
              );
              assert.ok(
                end.value.workload.analyserReads > start.value.workload.analyserReads &&
                  end.value.workload.averageFrequencyByte > 0,
              );
              assert.notEqual(
                end.value.workload.firstSourceX,
                start.value.workload.firstSourceX,
                'Package-owned positional panner did not follow its moving emitter',
              );
              assert.equal(end.value.workload.playbackError, null);
            }
            if (name === 'video') {
              assert.equal(end.value.workload.surfaces, defaults[name]);
              assert.equal(end.value.workload.sourceReady, true);
              assert.ok(end.value.workload.receivedFrames > start.value.workload.receivedFrames);
              assert.equal(end.value.workload.sourceError, null);
            }
            assert.equal(end.observation.hookRestored, true);
            assert.equal(end.observation.errors.length, 0);
            assert.equal(errors.length, 0);
            if (enabled && end.value.gpuTimingSupported)
              assert.ok(
                end.value.gpuProfilePassCount > 0 &&
                  Number.isFinite(end.value.gpuPassMilliseconds) &&
                  end.value.gpuPassMilliseconds >= 0,
                'Supported profiler never completed a sample',
              );
            if (enabled && end.value.gpuTimingSupported) {
              assert.equal(end.value.gpuProfilePassMilliseconds.length, end.value.gpuProfilePassCount);
              assert.ok(end.value.gpuProfilePassMilliseconds.every((value) => Number.isFinite(value) && value >= 0));
              assert.ok(
                Math.abs(
                  end.value.gpuProfilePassMilliseconds.reduce((sum, value) => sum + value, 0) -
                    end.value.gpuPassMilliseconds,
                ) < 1e-8,
              );
            }
            if (!enabled) assert.equal(end.value.gpuPassMilliseconds, null);
            assert.equal(end.observation.devices.at(-1).queries, enabled && end.value.gpuTimingSupported ? 1 : 0);
            assert.equal(end.value.captureTruncated, false);
            assert.equal(end.observation.visibility, 'visible');
            const hidden = end.observation.states.some(
              (state) => state.at >= start.at && state.at <= end.at && state.visibility !== 'visible',
            );
            assert.equal(hidden, false, 'Hidden measurement is invalid');
            const summary = summarize(end.value.samples, start.at, end.at);
            assert.ok(summary.callbacks > 10);
            if (name === 'video') {
              const imported =
                end.observation.devices.at(-1).externalVideoImports -
                start.observation.devices.at(-1).externalVideoImports;
              assert.ok(
                imported >= summary.callbacks * defaults[name],
                'Actual Video external-texture imports did not accompany rendered callbacks',
              );
              assert.equal(end.observation.devices.at(-1).invalidVideoSources, 0);
              if (enabled && end.value.gpuTimingSupported)
                assert.ok(
                  end.value.gpuProfilePassCount >= defaults[name] + 1,
                  'Actual Video render passes were absent from the GPU trace',
                );
            }
            const { samples, ...measurements } = end.value;
            record.runs.push({
              index,
              timing: enabled,
              start: start.at,
              end: end.at,
              summary,
              measurements,
              observation: end.observation,
              missedFrameRows: trace ? missedFrameRows(end.value.samples, start.at, end.at) : undefined,
            });
            console.log(
              JSON.stringify({
                profile: profile.name,
                package: name,
                timing: enabled,
                hz: summary.callbackHz,
                cpu: summary.renderCpuMilliseconds.mean,
                gpu: end.value.gpuPassMilliseconds,
              }),
            );
            await save();
            await page.locator('#run').focus();
            await page.keyboard.press('Space');
            await page.waitForFunction(() => !window.packageBenchmark.result().running);
            const paused = await page.evaluate(() => ({
              frames: window.packageBenchmark.result().frames,
              submits: window.workloadTestObservation().devices.reduce((sum, item) => sum + item.submits, 0),
            }));
            await page.waitForTimeout(150);
            assert.deepEqual(
              await page.evaluate(() => ({
                frames: window.packageBenchmark.result().frames,
                submits: window.workloadTestObservation().devices.reduce((sum, item) => sum + item.submits, 0),
              })),
              paused,
            );
          }
          record.packageInteractionChecks = await checkInteractions(page, name);
          const before = await page.evaluate(() => window.packageBenchmark.result()),
            alternate = await page.locator('#count option').first().getAttribute('value');
          await page.locator('#count').selectOption(alternate);
          await ready();
          assert.equal(await page.evaluate(() => window.packageBenchmark.result().actors), Number(alternate));
          assert.ok(
            await page.evaluate(() =>
              window
                .workloadTestObservation()
                .devices.slice(0, -1)
                .every((device) => device.destroyed),
            ),
          );
          await page.setViewportSize(
            profile.options.viewport ? { width: 360, height: 780 } : { width: 1280, height: 850 },
          );
          await page.waitForFunction(
            (previous) => window.packageBenchmark.result().canvas.some((value, i) => value !== previous[i]),
            before.canvas,
          );
          assert.equal(
            await page.evaluate(() => {
              const value = window.packageBenchmark.result();
              return value.visible === value.expectedEngineVisible;
            }),
            true,
          );
          record.uiChecks = {
            keyboardRunPause: true,
            pausedFramesAndSubmitsStable: true,
            countRebuildAndOldDeviceDisposal: true,
            resizeBackingAndRenderedActorContinuity: true,
            horizontalOverflow: await page.evaluate(() => window.workloadTestObservation().bodyOverflow),
          };
          assert.equal(record.uiChecks.horizontalOverflow, false);
          await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
          const closed = await page.evaluate(() => ({
            result: window.packageBenchmark.result(),
            observation: window.workloadTestObservation(),
          }));
          assert.equal(closed.result.running, false);
          assert.equal(closed.observation.hookRestored, true);
          assert.ok(closed.observation.devices.every((device) => device.destroyed));
          assert.equal(
            await page.locator('[data-margoengine-labels], [data-margo-inspector], #package-ui .ui-tools').count(),
            0,
            'Package DOM survived disposal',
          );
          await page.waitForTimeout(100);
          assert.equal(await page.evaluate(() => window.packageBenchmark.result().frames), closed.result.frames);
          if (name === 'audio') {
            const retired = await page.evaluate(() => window.packageBenchmark.result().workload);
            assert.equal(retired.contextState, 'closed');
            assert.equal(retired.playingSources, 0);
            record.mediaCleanup = { ownedAudioContextClosed: true, loopSourcesRetired: true };
          }
          if (name === 'video') {
            const retired = await page.evaluate(() => window.packageBenchmark.result().workload);
            assert.equal(retired.sourcePaused, true);
            assert.equal(retired.sourceEnabled, false);
            assert.equal(retired.sourceAttached, false);
            assert.equal(retired.sourceTrackState, 'ended');
            record.mediaCleanup = { generatedSourceStopped: true, externalSurfaceOwnershipRetired: true };
          }
          if (name === 'decoders') {
            assert.ok(closed.observation.workers.length > 0);
            assert.ok(
              closed.observation.workers.every((worker) => worker.terminated === 1),
              'Owned Draco worker survived disposal or terminated twice',
            );
            record.decoderCleanup = { ownedWorkersTerminatedExactlyOnce: closed.observation.workers.length };
          }
          record.uiChecks.terminalPagehideCleanup = true;
          record.errors = [...errors, ...closed.observation.errors];
          assert.equal(record.errors.length, 0);
          const off = record.runs.filter((run) => !run.timing),
            on = record.runs.filter((run) => run.timing);
          const mean = (values, select) => values.reduce((sum, value) => sum + select(value), 0) / values.length;
          record.timingComparison = {
            offCallbackHz: mean(off, (run) => run.summary.callbackHz),
            onCallbackHz: mean(on, (run) => run.summary.callbackHz),
            offRenderCpuMilliseconds: mean(off, (run) => run.summary.renderCpuMilliseconds.mean),
            onRenderCpuMilliseconds: mean(on, (run) => run.summary.renderCpuMilliseconds.mean),
            note: 'Two runs per mode in OFF/ON/ON/OFF order; refresh-limited cadence and brief sampling cannot establish a universal overhead bound.',
          };
          record.localTargetAcceptance = {
            principalSceneWithin1000ms: record.initialSceneWithin1000ms,
            bothUnprofiledMeansAtLeast60Hz: off.every((run) => run.summary.callbackHz >= 60 - 1e-7),
            allUnprofiledIntervalsWithin60HzBudget: off.every((run) => run.summary.intervalsAbove60HzBudget === 0),
            note: 'Strict local target uses unprofiled render callbacks, with 0.2 ms timestamp tolerance; no physical displayed-frame, physical-phone or cold-hosted proof.',
          };
          record.localTargetAcceptance.pass =
            record.localTargetAcceptance.principalSceneWithin1000ms &&
            record.localTargetAcceptance.bothUnprofiledMeansAtLeast60Hz &&
            record.localTargetAcceptance.allUnprofiledIntervalsWithin60HzBudget;
          await save();
        } catch (error) {
          record.failure = error.stack;
          record.errors = errors.slice();
          try {
            record.failedObservation = await page.evaluate(() => ({
              benchmark: window.packageBenchmark?.result(),
              gpu: window.workloadTestObservation?.(),
            }));
          } catch (observationError) {
            record.observationFailure = observationError.message;
          }
          await save();
          throw error;
        } finally {
          await context.close();
        }
      }
    report.completedAt = new Date().toISOString();
    report.localTargetMisses = report.cases
      .filter((record) => !record.localTargetAcceptance?.pass)
      .map((record) => ({
        profile: record.profile,
        package: record.package,
        acceptance: record.localTargetAcceptance,
      }));
    await save();
    assert.equal(
      report.localTargetMisses.length,
      0,
      'One or more local package workloads missed the 1000 ms / steady 60 Hz target; full evidence was saved',
    );
  } finally {
    await browser.close();
  }
}

async function checkInteractions(page, name) {
  const value = () => page.evaluate(() => window.packageBenchmark.result()),
    result = {};
  if (name === 'animator') {
    await page.locator('[data-ui-animator-rest]').click();
    assert.equal((await value()).workload.activeMoveControllers, 0);
    await page.locator('[data-ui-animator-wave]').click();
    assert.equal((await value()).workload.waveWeight, 0.3);
    await page.locator('[data-ui-animator-speed]').selectOption('1');
    assert.equal((await value()).workload.automaticTransitions, false);
    await page.locator('[data-ui-animator-rest]').click();
    assert.equal((await value()).workload.activeMoveControllers, defaults.animator);
    await page.locator('[data-ui-animator-wave]').click();
    assert.equal((await value()).workload.waveWeight, 0);
    return { realBlendStateAndMaskedLayerControls: true };
  }
  if (name === 'taa') {
    const before = (await value()).workload.manualHistoryResets;
    await page.locator('[data-ui-taa-reset]').click();
    assert.equal((await value()).workload.manualHistoryResets, before + 1);
    await page.locator('[data-ui-taa-weight]').selectOption('0.7');
    assert.equal((await value()).workload.historyWeight, 0.7);
    await page.locator('[data-ui-taa]').click();
    assert.equal((await value()).workload.taaEnabled, false);
    assert.equal((await value()).workload.registeredVelocityModels, 0);
    await page.locator('[data-ui-taa]').click();
    assert.equal((await value()).workload.taaEnabled, true);
    assert.equal((await value()).workload.registeredVelocityModels, defaults.taa);
    return { realTemporalSourceAndHistoryControls: true };
  }
  if (name === 'text') {
    await page.locator('[data-ui-text-outline]').click();
    assert.equal((await value()).workload.outlined, false);
    await page.locator('[data-ui-text-outline]').click();
    assert.equal((await value()).workload.outlined, true);
    return { realGlyphOutlineAndShadowControls: true };
  }
  if (name === 'splats') {
    await page.locator('[data-ui-splats-sh]').click();
    assert.equal((await value()).workload.viewDependentColor, true);
    await page.locator('[data-ui-splats-orbit]').click();
    assert.equal((await value()).workload.cameraOrbit, false);
    await page.locator('[data-ui-splats-orbit]').click();
    assert.equal((await value()).workload.cameraOrbit, true);
    await page.locator('[data-ui-splats-sh]').click();
    assert.equal((await value()).workload.viewDependentColor, false);
    return { realGaussianSphericalHarmonicsAndOrbitControls: true };
  }
  if (name === 'audio') {
    assert.equal((await value()).workload.enabled, false);
    await page.locator('[data-ui-audio]').click();
    await page.waitForFunction(
      () =>
        window.packageBenchmark.result().workload.enabled &&
        window.packageBenchmark.result().workload.contextState === 'running',
    );
    await page.locator('[data-ui-audio]').click();
    await page.waitForFunction(
      () =>
        !window.packageBenchmark.result().workload.enabled &&
        window.packageBenchmark.result().workload.contextState === 'suspended',
    );
    return { explicitActualAudioResumeAndSuspend: true };
  }
  if (name === 'video') {
    await page.locator('[data-ui-video]').click();
    assert.equal((await value()).workload.sourceEnabled, false);
    assert.equal((await value()).workload.sourcePaused, true);
    await page.locator('[data-ui-video]').click();
    await page.waitForFunction(
      () =>
        window.packageBenchmark.result().workload.sourceEnabled &&
        !window.packageBenchmark.result().workload.sourcePaused,
    );
    return { actualGeneratedStreamPauseAndResume: true };
  }
  if (name === 'points') {
    await page.locator('[data-ui-actor]').selectOption('2');
    await page.locator('[data-ui-edl]').click();
    assert.equal((await value()).workload.edl, true);
    await page.locator('#scene').scrollIntoViewIfNeeded();
    const before = await value(),
      box = await page.locator('#scene').boundingBox();
    assert.ok(before.ui && box, 'Actual drawn point was not pickable');
    await page.mouse.click(box.x + before.ui.pointX, box.y + before.ui.pointY);
    assert.ok(Number.isInteger((await value()).workload.lastPickedIndex));
    await page.locator('[data-ui-edl]').click();
    assert.equal((await value()).workload.edl, false);
    return { actualPointPickAndEdl: true };
  }
  if (name === 'toon') {
    const shaded = await page.locator('#scene').screenshot();
    await page.locator('[data-ui-toon]').click();
    assert.equal((await value()).workload.enabled, false);
    assert.notDeepEqual(await page.locator('#scene').screenshot(), shaded, 'Actual toon toggle did not change pixels');
    await page.locator('[data-ui-toon]').click();
    assert.equal((await value()).workload.enabled, true);
    return { actualToonAndHullToggle: true };
  }
  if (name === 'transitions') {
    const before = await value(),
      outgoing = await page.locator('#scene').screenshot();
    await page.locator('[data-ui-transition]').click();
    assert.equal((await value()).workload.sceneSwitches, before.workload.sceneSwitches + 1);
    assert.equal((await value()).workload.progress, 0);
    await page.waitForTimeout(100);
    assert.equal((await value()).workload.progress, 0);
    await page.locator('#run').click();
    await page.waitForFunction(() => window.packageBenchmark.result().workload.progress >= 1);
    await page.locator('#run').click();
    assert.notDeepEqual(
      await page.locator('#scene').screenshot(),
      outgoing,
      'Captured transition did not show the changed scene',
    );
    return { actualCapturedSceneTransitionAndPausedProgress: true };
  }
  if (!['gizmo', 'inspector', 'labels', 'html'].includes(name)) return null;
  await page.locator('[data-ui-actor]').selectOption('2');
  assert.equal((await value()).workload.selectedActor, 2);
  result.actorSelection = true;
  if (name === 'gizmo') {
    await page.locator('[data-ui-mode]').selectOption('scale');
    assert.equal((await value()).workload.mode, 'scale');
    await page.locator('[data-ui-mode]').selectOption('translate');
    await page.locator('#scene').scrollIntoViewIfNeeded();
    const before = await value(),
      box = await page.locator('#scene').boundingBox();
    assert.ok(before.ui && box, 'Real X handle was not hit-testable');
    const x = box.x + before.ui.handleX,
      y = box.y + before.ui.handleY;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 70, y + 15, { steps: 6 });
    await page.mouse.up();
    const after = await value();
    assert.ok(after.workload.objectChanges > before.workload.objectChanges);
    assert.notEqual(after.workload.selectedX, before.workload.selectedX);
    await page.locator('[data-ui-reset]').click();
    assert.equal((await value()).workload.selectedX, before.workload.selectedX);
    result.actualPointerDragAndReset = true;
  } else if (name === 'inspector') {
    const x = page.locator('[data-margo-inspector] [data-property="position.x"]');
    await x.fill('1.25');
    await x.press('Tab');
    assert.equal((await value()).workload.selectedX, 1.25);
    const visible = page.locator('[data-margo-inspector] [data-property="visible"]');
    await visible.setChecked(false);
    assert.equal((await value()).visible, 15);
    await visible.setChecked(true);
    assert.equal((await value()).visible, 16);
    await page.locator('[data-margo-inspector] [data-property="bounds"]').setChecked(false);
    assert.equal((await value()).workload.boundsEnabled, false);
    await page.locator('[data-margo-inspector] [data-property="bounds"]').setChecked(true);
    result.actualPropertiesVisibilityAndBounds = true;
  } else if (name === 'labels') {
    await page.locator('.world-label').nth(2).click();
    assert.equal((await value()).workload.selectedActor, 3);
    const before = (await value()).workload.labelsOnScreen;
    await page.locator('[data-ui-toggle]').click();
    assert.equal((await value()).workload.labelsOnScreen, before - 1);
    await page.locator('[data-ui-toggle]').click();
    await page.locator('[data-ui-readd]').click();
    assert.equal((await value()).workload.registeredElements, 16);
    await page.locator('[data-ui-readd]').click();
    assert.equal((await value()).workload.registeredElements, 17);
    result.actualLabelClickToggleAndOwnership = true;
  } else {
    await page.waitForFunction(() => {
      const w = window.packageBenchmark.result().workload;
      return w.depthAvailable && w.probesOnScreen === 0 && w.labelsOnScreen > 0;
    });
    const frames = (await value()).frames;
    await page.locator('[data-ui-depth]').click();
    await page.waitForFunction(() => window.packageBenchmark.result().workload.probesOnScreen > 0);
    await page.waitForFunction(() => !window.packageBenchmark.result().workload.previewSettling);
    assert.equal((await value()).frames, frames);
    assert.equal((await value()).running, false);
    await page.locator('[data-ui-depth]').click();
    await page.waitForFunction(() => {
      const w = window.packageBenchmark.result().workload;
      return !w.previewSettling && w.probesOnScreen === 0;
    });
    result.actualRenderedDepthHidesInsideAndShowsAboveWhilePaused = true;
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runBenchmarks();
