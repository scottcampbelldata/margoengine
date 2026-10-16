import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { transformWithOxc } from 'vite';
import { openBrowser } from './browser.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const numberArgument = (name, fallback) =>
  Number(process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const durationMs = numberArgument('duration-ms', 6000),
  samplingInterval = numberArgument('sampling-interval', 4096);
const warmupMs = numberArgument('warmup-ms', 1500);
const port = numberArgument('port', 5223),
  sampleAllocations = !process.argv.includes('--gc-only');
const label = process.argv.find((value) => value.startsWith('--label='))?.slice(8) ?? 'baseline';
const sceneURL = process.argv.find((value) => value.startsWith('--scene-url='))?.slice(12);
if (sceneURL) {
  const url = new URL(sceneURL);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'Profile a local preview');
}
const pairedTargets = [
  { name: 'gltf', module: '/packages/gltf-pro/dist/index.js', exportName: 'PBRModel', methods: ['draw'] },
  {
    name: 'animator',
    module: '/packages/animator/dist/index.js',
    exportName: 'Animator',
    methods: ['onPreUpdate', 'sample', 'clip'],
  },
  { name: 'animation', module: '/packages/animation/dist/index.js', exportName: 'Animation', methods: ['deform'] },
  { name: 'quaternion', module: '/packages/core/dist/extension.js', exportName: 'Mesh', methods: ['setQuaternion'] },
  { name: 'stats', module: '/packages/stats/dist/index.js', exportName: 'GPUProfiler', methods: ['read'] },
  {
    name: 'shadows',
    module: '/packages/shadows/dist/index.js',
    exportName: 'Shadows',
    methods: ['validate', 'fitBounds'],
  },
].flatMap((target) => {
  const flag = `--${target.name}-baseline=`,
    path = process.argv.find((value) => value.startsWith(flag))?.slice(flag.length);
  return path ? [{ ...target, path: '/' + path.replaceAll('\\', '/').replace(/^\//, '') }] : [];
});
assert.ok(pairedTargets.length <= 1, 'Pair one implementation at a time to keep attribution independent');
const paired = pairedTargets[0];
const hudBaselinePath = process.argv.find((value) => value.startsWith('--hud-baseline='))?.slice(15);
const hudBaselineSource = hudBaselinePath ? await readFile(hudBaselinePath, 'utf8') : null;
const mainBaselinePath = process.argv.find((value) => value.startsWith('--main-baseline='))?.slice(16);
const mainBaselineSource = mainBaselinePath ? await readFile(mainBaselinePath, 'utf8') : null;
const auditBaselinePath = process.argv.find((value) => value.startsWith('--gpu-audit-baseline='))?.slice(21);
const auditBaselineSource = auditBaselinePath ? await readFile(auditBaselinePath, 'utf8') : null;
const headBaselinePath = process.argv.find((value) => value.startsWith('--head-baseline='))?.slice(16);
const headBaselineSource = headBaselinePath ? await readFile(headBaselinePath, 'utf8') : null;
async function baselineModule(source, filename) {
  if (!source) return null;
  const { code } = await transformWithOxc(source, filename, { target: 'es2022' });
  return code.replace(/(\bfrom\s+)(['"])([^'"]+)\2/g, (_, prefix, quote, specifier) => {
    if (specifier.startsWith('.'))
      return prefix + JSON.stringify(/\.[a-z]+$/i.test(specifier) ? specifier : specifier + '.ts');
    const file = fileURLToPath(import.meta.resolve(specifier)),
      local = relative(process.cwd(), file).replaceAll('\\', '/');
    return prefix + JSON.stringify(local.startsWith('..') ? '/@fs/' + file.replaceAll('\\', '/') : '/' + local);
  });
}
const hudBaselineCode = await baselineModule(hudBaselineSource, 'performance-hud.ts');
const mainBaselineCode = await baselineModule(mainBaselineSource, 'main.ts');
const auditBaselineCode = await baselineModule(auditBaselineSource, 'gpu-audit.ts');
const headBaselineCode = await baselineModule(headBaselineSource, 'head-aim.ts');
const pageBaselines = [
  mainBaselineCode
    ? { name: 'main', path: mainBaselinePath, pattern: '**/examples/skinning-ik/main.ts*', code: mainBaselineCode }
    : null,
  hudBaselineCode
    ? {
        name: 'hud',
        path: hudBaselinePath,
        pattern: '**/examples/skinning-ik/performance-hud.ts*',
        code: hudBaselineCode,
      }
    : null,
  auditBaselineCode
    ? {
        name: 'gpu-audit',
        path: auditBaselinePath,
        pattern: '**/examples/skinning-ik/gpu-audit.ts*',
        code: auditBaselineCode,
      }
    : null,
  headBaselineCode
    ? { name: 'head', path: headBaselinePath, pattern: '**/examples/skinning-ik/head-aim.ts*', code: headBaselineCode }
    : null,
].filter(Boolean);
assert.ok(pageBaselines.length <= 1, 'Pair one page module at a time');
assert.ok(!(paired && pageBaselines.length), 'Pair page reloads separately from method swaps');
const pageBaseline = pageBaselines[0] ?? null;
assert.ok(!sceneURL || (!paired && !pageBaseline), 'Production preview captures cannot swap development modules');
const pageBaselineRoute = (route) => route.fulfill({ contentType: 'application/javascript', body: pageBaseline.code });
const selected = process.argv
  .find((value) => value.startsWith('--phases='))
  ?.slice(9)
  .split(',');
const includes = (name) => !selected || selected.includes(name);
const phaseNames = ['default', 'idle-off', 'reflections-off', 'tracking-off', 'hud-expanded', 'torso-pointer-drag'];
assert.ok(!selected || selected.every((name) => phaseNames.includes(name)), '--phases contains an unknown phase');
assert.ok(!paired || includes('default'), 'Paired implementation capture requires the default phase');
assert.match(label, /^[a-z0-9-]+$/);
for (const value of [durationMs, samplingInterval, warmupMs, port]) assert.ok(Number.isSafeInteger(value) && value > 0);
const prefix = `test-results/skinning-ik-profile-${label}${sampleAllocations ? '' : '-gc-only'}`;
const sourceSHA256 = {};
for (const path of [
  'examples/skinning-ik/main.ts',
  'examples/skinning-ik/diagnostics.ts',
  'examples/skinning-ik/body-ik.ts',
  'examples/skinning-ik/performance-hud.ts',
  'examples/skinning-ik/arm-controls.ts',
  'examples/skinning-ik/arm-control-route.ts',
  'examples/skinning-ik/probe-pose-reuse.ts',
  'examples/skinning-ik/head-aim.ts',
  'examples/skinning-ik/torso-aim.ts',
  'examples/skinning-ik/target-motion.ts',
  'examples/skinning-ik/gpu-audit.ts',
  'examples/skinning-ik/arm-head-clearance.ts',
  'examples/skinning-ik/arm-head-shape.ts',
  'examples/skinning-ik/body-head-shape.ts',
  'examples/skinning-ik/head-aim-shape.ts',
  'packages/animator/src/index.ts',
  'packages/animator/dist/index.js',
  'packages/animation/src/index.ts',
  'packages/animation/dist/index.js',
  'packages/core/src/renderer.ts',
  'packages/core/dist/renderer.js',
  'packages/core/src/engine.ts',
  'packages/core/dist/engine.js',
  'packages/stats/src/index.ts',
  'packages/stats/src/profiler.ts',
  'packages/stats/dist/index.js',
  'packages/environment/src/probes.ts',
  'packages/environment/dist/probes.js',
  'packages/shadows/src/index.ts',
  'packages/shadows/dist/index.js',
  'examples/skinning-ik/rig-ik.ts',
  'examples/skinning-ik/body-distance.ts',
  'examples/skinning-ik/rig-scratch.ts',
  'examples/skinning-ik/norm.ts',
  'packages/shared/view.js',
  'packages/shared/pbr-hooks.js',
  'packages/gltf-pro/src/index.ts',
  'packages/gltf-pro/dist/index.js',
  'packages/kinematics-constraints/dist/index.js',
  'scripts/profile-skinning-ik.js',
]) {
  sourceSHA256[path] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
if (paired)
  sourceSHA256[paired.path] = createHash('sha256')
    .update(await readFile(paired.path.slice(1)))
    .digest('hex');
if (hudBaselinePath) sourceSHA256[hudBaselinePath] = createHash('sha256').update(hudBaselineSource).digest('hex');
if (mainBaselinePath) sourceSHA256[mainBaselinePath] = createHash('sha256').update(mainBaselineSource).digest('hex');
if (auditBaselinePath) sourceSHA256[auditBaselinePath] = createHash('sha256').update(auditBaselineSource).digest('hex');
if (headBaselinePath) sourceSHA256[headBaselinePath] = createHash('sha256').update(headBaselineSource).digest('hex');
if (sceneURL) {
  const path = 'test-results/skinning-ik-site/build-report.json',
    contents = await readFile(path);
  sourceSHA256[path] = createHash('sha256').update(contents).digest('hex');
  const served = await fetch(new URL('build-report.json', sceneURL));
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await served.arrayBuffer()))
      .digest('hex'),
    sourceSHA256[path],
    'Preview must serve the currently recorded standalone build',
  );
  for (const file of JSON.parse(contents).javascriptFiles) {
    const bundle = 'test-results/skinning-ik-site/' + file.path;
    sourceSHA256[bundle] = createHash('sha256')
      .update(await readFile(bundle))
      .digest('hex');
    assert.equal(sourceSHA256[bundle], file.sha256, 'Standalone bundle differs from its build report');
  }
}
const app = await openBrowser({
  startPath: '/tests/modern.html',
  channel: 'msedge',
  args: [],
  port,
  aliases: { '@margoengine/kinematics-constraints': resolve('packages/kinematics-constraints/dist/index.js') },
});
const page = app.page,
  cdp = await page.context().newCDPSession(page),
  errors = [];
page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
const report = {
  startedAt: new Date().toISOString(),
  hardware: app.hardware,
  sourceSHA256,
  durationMs,
  warmupMs,
  sceneURL: sceneURL ?? null,
  samplingInterval: sampleAllocations ? samplingInterval : null,
  pairedImplementation:
    paired ??
    (pageBaseline ? { name: pageBaseline.name, path: pageBaseline.path, strategy: 'fresh scene reload' } : null),
  hudBaselinePath: hudBaselinePath ?? null,
  mainBaselinePath: mainBaselinePath ?? null,
  auditBaselinePath: auditBaselinePath ?? null,
  headBaselinePath: headBaselinePath ?? null,
  errors,
  phases: [],
  method:
    'Normal running scene, no forced garbage collection. Heap sampling includes objects later collected by minor/major GC. Sampled bytes are statistical allocation estimates; heap range is not an allocation rate. Tracing and sampling can affect timing. Matched one-toggle phases reset to defaults; drag explicitly disables idle/light/look motion.',
};
// Serialize only on demand. Legacy comparison mode reuses its published string;
// Playwright's recursive object serializer would otherwise create another tree.
const metrics = async () =>
  JSON.parse(
    (
      await cdp.send('Runtime.evaluate', {
        expression: "document.querySelector('#viewport').dataset.metrics ?? document.querySelector('#viewport').readWorkshopDiagnostics('metrics')",
        returnByValue: true,
      })
    ).result.value,
  );
async function readyScene() {
  await page.waitForFunction(
    () => document.querySelector('#viewport').dataset.ready === 'true' || document.querySelector('#error').textContent,
  );
  assert.equal(await page.locator('#error').textContent(), '');
  assert.equal(
    await page.locator('#viewport').getAttribute('data-constraint-solver'),
    '@margoengine/kinematics-constraints',
  );
  await page.waitForFunction(() => typeof document.querySelector('#viewport').readWorkshopDiagnostics === 'function');
}

function allocationSummary(profile) {
  const sites = [],
    ancestors = new Map(),
    sources = new Map();
  function visit(node, preceding) {
    const frame = {
      ...node.callFrame,
      lineNumber: node.callFrame.lineNumber + 1,
      columnNumber: node.callFrame.columnNumber + 1,
    };
    const stack = preceding.concat(frame);
    if (node.selfSize) {
      sites.push({ estimatedBytes: node.selfSize, ...frame, stack });
      const seen = new Set();
      for (const item of stack) {
        const key = `${item.functionName}|${item.url}|${item.lineNumber}|${item.columnNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = ancestors.get(key) ?? { ...item, estimatedInclusiveBytes: 0 };
        entry.estimatedInclusiveBytes += node.selfSize;
        ancestors.set(key, entry);
      }
      const origin = stack.findLast((item) => /\/examples\/|\/packages\/|\/test-results\/|\/assets\/[^/]+\.js/.test(item.url));
      const path = origin ? new URL(origin.url).pathname : '(browser or profiling harness)';
      sources.set(path, (sources.get(path) ?? 0) + node.selfSize);
    }
    for (const child of node.children) visit(child, stack);
  }
  visit(profile.head, []);
  sites.sort((a, b) => b.estimatedBytes - a.estimatedBytes);
  return {
    estimatedBytes: sites.reduce((sum, site) => sum + site.estimatedBytes, 0),
    byInnermostSource: [...sources]
      .map(([path, estimatedBytes]) => ({ path, estimatedBytes }))
      .sort((a, b) => b.estimatedBytes - a.estimatedBytes),
    leaves: sites,
    ancestors: [...ancestors.values()].sort((a, b) => b.estimatedInclusiveBytes - a.estimatedInclusiveBytes),
  };
}

async function phase(name, conditions, action = () => delay(durationMs)) {
  const before = await cdp.send('Runtime.getHeapUsage'),
    appBefore = await metrics();
  const beforePerformance = await cdp.send('Performance.getMetrics');
  const events = [],
    samples = [],
    collect = ({ value }) => events.push(...value);
  cdp.on('Tracing.dataCollected', collect);
  if (sampleAllocations)
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    });
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,v8,disabled-by-default-v8.gc,disabled-by-default-devtools.timeline.memory',
    options: 'record-as-much-as-possible',
    transferMode: 'ReportEvents',
  });
  const start = performance.now();
  let done = false,
    actionResult;
  const poll = (async () => {
    while (!done) {
      const usage = await cdp.send('Runtime.getHeapUsage');
      const state = await metrics();
      samples.push({
        elapsedMs: performance.now() - start,
        ...usage,
        frameMs: state.performance.frameMs,
        p95Ms: state.performance.p95Ms,
        safe: state.arm.safe,
        gripError: state.gripError,
        bodyContact: state.arm.bodyContact,
        orb: state.orb,
        elbow: state.arm.elbow,
      });
      await delay(250);
    }
  })();
  try {
    actionResult = await action();
  } finally {
    done = true;
    await poll;
    const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    await complete;
    cdp.off('Tracing.dataCollected', collect);
  }
  const elapsedMs = performance.now() - start;
  const profile = sampleAllocations ? (await cdp.send('HeapProfiler.stopSampling')).profile : null;
  const after = await cdp.send('Runtime.getHeapUsage'),
    appAfter = await metrics();
  const afterPerformance = await cdp.send('Performance.getMetrics');
  const gc = events.filter((event) => event.ph === 'X' && /^(MinorGC|MajorGC)$/.test(event.name));
  const gcNames = {};
  for (const event of gc) gcNames[event.name] = (gcNames[event.name] ?? 0) + 1;
  // Union overlapping top-level GC slices per thread. Nested phases are not
  // additional pauses; background task duration is not a mutator pause either.
  const intervals = gc
    .map((event) => ({ pid: event.pid, tid: event.tid, start: event.ts, end: event.ts + (event.dur ?? 0) }))
    .sort((a, b) => a.pid - b.pid || a.tid - b.tid || a.start - b.start || b.end - a.end);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && previous.pid === interval.pid && previous.tid === interval.tid && interval.start <= previous.end)
      previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  const allocation = profile ? allocationSummary(profile) : null;
  const sizes = [before.usedSize, after.usedSize, ...samples.map((value) => value.usedSize)];
  const performanceMetricDeltas = {};
  for (const item of afterPerformance.metrics) {
    const previous = beforePerformance.metrics.find((value) => value.name === item.name);
    if (previous && /Duration|Count/.test(item.name)) performanceMetricDeltas[item.name] = item.value - previous.value;
  }
  const entry = {
    name,
    conditions,
    elapsedMs,
    actionResult,
    before: appBefore,
    after: appAfter,
    work: Object.fromEntries(
      ['frames', 'animationFrames', 'poseUpdates', 'reflections'].map((key) => [key, appAfter[key] - appBefore[key]]),
    ),
    heap: { before, after, minimumUsedBytes: Math.min(...sizes), maximumUsedBytes: Math.max(...sizes), samples },
    allocation,
    naturalGC: {
      counts: gcNames,
      pauseMs: merged.reduce((sum, value) => sum + (value.end - value.start) / 1000, 0),
      maximumPauseMs: merged.reduce((maximum, value) => Math.max(maximum, (value.end - value.start) / 1000), 0),
      intervals: merged,
    },
    performanceMetricDeltas,
    artifacts: {
      trace: resolve(`${prefix}-${name}.trace.json`),
      heapProfile: profile ? resolve(`${prefix}-${name}.heapprofile`) : null,
    },
  };
  if (allocation) {
    allocation.estimatedBytesPerSecond = allocation.estimatedBytes / (elapsedMs / 1000);
    allocation.estimatedBytesPerRealFrame = allocation.estimatedBytes / entry.work.animationFrames;
  }
  await writeFile(`${prefix}-${name}.trace.json`, JSON.stringify({ traceEvents: events }));
  if (profile) await writeFile(`${prefix}-${name}.heapprofile`, JSON.stringify(profile));
  report.phases.push(entry);
  await writeFile(`${prefix}.json`, JSON.stringify(report, null, 2));
  assert.ok(
    samples.every((value) => value.safe && value.gripError < 1e-5),
    `${name}: presented pose failed safety or held-orb check`,
  );
  console.log(
    JSON.stringify({
      phase: name,
      elapsedMs,
      work: entry.work,
      estimatedBytes: allocation?.estimatedBytes,
      estimatedBytesPerSecond: allocation?.estimatedBytesPerSecond,
      naturalGC: entry.naturalGC,
      sources: allocation?.byInnermostSource.slice(0, 10),
      topLeaves: allocation?.leaves.slice(0, 8).map(({ stack, ...site }) => site),
      topAncestors: allocation?.ancestors.filter((site) => /\/examples\//.test(site.url)).slice(0, 12),
    }),
  );
}

async function defaults(changes = {}) {
  await page.locator('#reset').click();
  const normalized = await page.evaluate(() =>
    ['x', 'y', 'z'].map((axis) => {
      const input = document.querySelector(`#target-${axis}`);
      return { min: input.min, max: input.max, value: input.valueAsNumber };
    }),
  );
  assert.ok(
    normalized.every(
      (input) => Number(input.min) === 0 && Number(input.max) === 1 && Math.abs(input.value - 0.5) < 1e-6,
    ),
    'Reset must restore the three normalized independent tracks to authored Home',
  );
  await page.evaluate((changes) => {
    const values = {
      idle: true,
      'moving-light': true,
      look: true,
      reflections: true,
      'ik-enabled': true,
      'auto-ik': true,
      follow: false,
      autopilot: false,
      'show-rig': false,
      ...changes,
    };
    for (const [id, checked] of Object.entries(values)) {
      const input = document.getElementById(id);
      input.checked = checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const toggle = document.querySelector('[aria-controls="workshop-performance-panel"]');
    if (toggle?.getAttribute('aria-expanded') === 'true') toggle.click();
  }, changes);
  await delay(warmupMs);
}
function project(point, eye, target, bounds) {
  const f = target.map((value, i) => value - eye[i]),
    length = Math.hypot(...f);
  for (let i = 0; i < 3; i++) f[i] /= length;
  const rLength = Math.hypot(f[0], f[2]),
    r = [-f[2] / rLength, 0, f[0] / rLength];
  const u = [-r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1]],
    p = point.map((value, i) => value - eye[i]);
  const dot = (vector) => p.reduce((sum, value, i) => sum + value * vector[i], 0),
    depth = dot(f),
    tangent = Math.tan((35 * Math.PI) / 360);
  return {
    x: bounds.x + bounds.width * (0.5 + (dot(r) / ((depth * tangent * bounds.width) / bounds.height)) * 0.5),
    y: bounds.y + bounds.height * (0.5 - (dot(u) / (depth * tangent)) * 0.5),
  };
}

try {
  assert.match(app.hardware.userAgent, /Edg\//, 'Use hardware Edge');
  assert.equal(app.hardware.webgpu?.fallback, false);
  assert.doesNotMatch(app.hardware.webglRenderer ?? '', /swiftshader|warp|llvmpipe/i);
  await cdp.send('Performance.enable');
  await page.route('**/@vite/client', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '// HMR disabled during allocation capture.\n' }),
  );
  if (pageBaseline) await page.route(pageBaseline.pattern, pageBaselineRoute);
  await page.goto(sceneURL ?? new URL('/examples/skinning-ik.html', page.url()).href);
  await readyScene();
  console.log('Scene modules are loaded with HMR disabled; capture uses this frozen page.');
  if (includes('default')) {
    if (pageBaseline) {
      try {
        for (const variant of ['baseline', 'candidate', 'baseline-repeat']) {
          if (variant === 'candidate') await page.unroute(pageBaseline.pattern, pageBaselineRoute);
          if (variant === 'baseline-repeat') await page.route(pageBaseline.pattern, pageBaselineRoute);
          if (variant !== 'baseline') {
            await page.reload();
            await readyScene();
          }
          await defaults();
          await delay(1000);
          await phase(
            'default-' + variant,
            `Fresh scene reload, paired ${pageBaseline.name} module: ${variant}. Same current dependencies, default controls and callbacks remain active.`,
          );
        }
      } finally {
        await page.unroute(pageBaseline.pattern, pageBaselineRoute);
        await page.reload();
        await readyScene();
      }
    } else if (paired) {
      await page.evaluate(async (target) => {
        const current = await import(target.module),
          old = await import(target.path);
        const prototype = current[target.exportName]?.prototype,
          baseline = old[target.exportName]?.prototype;
        if (!prototype || !baseline) throw new Error('Paired modules must export ' + target.exportName);
        const variants = { prototype, candidate: {}, baseline: {}, methods: target.methods };
        for (const method of target.methods) {
          if (typeof prototype[method] !== 'function' || typeof baseline[method] !== 'function')
            throw new Error('Missing paired method: ' + method);
          variants.candidate[method] = prototype[method];
          variants.baseline[method] = baseline[method];
        }
        window.skinningProfileVariants = variants;
      }, paired);
      try {
        for (const [name, variant] of [
          ['default-baseline', 'baseline'],
          ['default-candidate', 'candidate'],
          ['default-baseline-repeat', 'baseline'],
        ]) {
          await page.evaluate((variant) => {
            const variants = window.skinningProfileVariants;
            for (const method of variants.methods) variants.prototype[method] = variants[variant][method];
          }, variant);
          await defaults();
          await delay(1000);
          await phase(
            name,
            `Same frozen scene and model objects, paired ${paired.name} implementation (${paired.methods.join(', ')}): ${variant}. Default controls and callbacks remain active.`,
          );
        }
      } finally {
        await page.evaluate(() => {
          const variants = window.skinningProfileVariants;
          for (const method of variants.methods) variants.prototype[method] = variants.candidate[method];
          delete window.skinningProfileVariants;
        });
      }
    } else {
      await defaults();
      await phase(
        'default',
        'Reset defaults: idle, moving light, head look, auto IK, reflections on; performance panel collapsed.',
      );
    }
  }
  if (includes('idle-off')) {
    await defaults({ idle: false });
    await phase('idle-off', 'Only idle animation disabled relative to default.');
  }
  if (includes('reflections-off')) {
    await defaults({ reflections: false });
    await phase('reflections-off', 'Only reflection updates disabled relative to default.');
  }
  if (includes('tracking-off')) {
    await defaults({ look: false });
    await phase('tracking-off', 'Only head tracking disabled relative to default.');
  }
  if (includes('hud-expanded')) {
    await defaults();
    await page.locator('[aria-controls="workshop-performance-panel"]').click();
    await delay(500);
    await phase(
      'hud-expanded',
      'Only performance panel expanded relative to default; graphs and profiling remain attached in all phases.',
    );
  }
  if (includes('torso-pointer-drag')) {
    await defaults({ idle: false, 'moving-light': false, look: false });
    if (!(await page.locator('details.advanced').evaluate((element) => element.open)))
      await page.locator('details.advanced > summary').click();
    await page.locator('[data-pose="back"]').click();
    await page.locator('#view-room').click();
    await delay(1500);
    const dragBefore = await metrics(),
      bounds = await page.locator('#viewport canvas').boundingBox();
    const start = project(dragBefore.orb, dragBefore.camera, dragBefore.cameraTarget, bounds),
      end = project([0.08, 0.95, 0.025], dragBefore.camera, dragBefore.cameraTarget, bounds);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#viewport').dataset.metrics ?? document.querySelector('#viewport').readWorkshopDiagnostics('metrics')).dragging, null, {
      timeout: 3000,
    });
    await phase(
      'torso-pointer-drag',
      'Actual trusted pointer drag from Behind through the torso and back; idle, moving light and head look off, reflections and auto IK on.',
      async () => {
        const startTime = performance.now();
        let moves = 0;
        while (performance.now() - startTime < durationMs) {
          const t = (performance.now() - startTime) / 2400,
            a = (1 - Math.cos(2 * Math.PI * t)) / 2;
          await page.mouse.move(start.x + (end.x - start.x) * a, start.y + (end.y - start.y) * a);
          moves++;
          await delay(32);
        }
        return { trustedMoves: moves };
      },
    );
    await page.mouse.up();
  }
  assert.deepEqual(errors, []);
  report.sourceChanges = [];
  for (const [path, hash] of Object.entries(sourceSHA256)) {
    const actual = createHash('sha256')
      .update(await readFile(path.startsWith('/') ? path.slice(1) : path))
      .digest('hex');
    if (actual !== hash) report.sourceChanges.push(path);
  }
  assert.deepEqual(
    report.sourceChanges,
    [],
    'Source changed during capture; repeat before claiming a matched measurement',
  );
  console.log(JSON.stringify({ report: resolve(`${prefix}.json`), hardware: app.hardware, errors }));
} finally {
  await writeFile(`${prefix}.json`, JSON.stringify(report, null, 2));
  await app.close();
}
