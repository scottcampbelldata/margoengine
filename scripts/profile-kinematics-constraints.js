import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {openBrowser} from './browser.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const startedAt = new Date().toISOString();
const sourceSHA256 = {};
for (const path of ['packages/kinematics-constraints/dist/index.js', 'examples/kinematics-constraints.html', 'scripts/profile-kinematics-constraints.js']) {
  sourceSHA256[path] = createHash('sha256').update(await readFile(path)).digest('hex');
}
const argument = (name, fallback) => Number(process.argv.find(value => value.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const durationMs = argument('duration-ms', 12000);
const burstSolves = argument('solves', 100000);
const warmupSolves = argument('warmup', 10000);
const solvesPerFrame = argument('solves-per-frame', 16);
const samplingInterval = argument('sampling-interval', 4096);
const sampleAllocations = !process.argv.includes('--gc-only');
const label = process.argv.find(value => value.startsWith('--label='))?.slice(8) ?? '';
assert.ok(!label || /^[a-z0-9-]+$/.test(label), '--label must contain lowercase letters, numbers or hyphens');
for (const [name, value] of Object.entries({durationMs, burstSolves, warmupSolves, solvesPerFrame, samplingInterval})) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
}

// Match the software-adapter browser test unless the caller supplies BROWSER_ARGS.
const softwareArgs = ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--use-angle=d3d11-warp'];
const args = process.env.BROWSER_ARGS ? JSON.parse(process.env.BROWSER_ARGS) : softwareArgs;
const app = await openBrowser({startPath: '/tests/modern.html', port: 5208, args,
  aliases: {'@margoengine/kinematics-constraints': resolve('packages/kinematics-constraints/dist/index.js')},
});
const page = app.page, cdp = await page.context().newCDPSession(page);
const baseURL = new URL(page.url()).origin;
const prefix = `test-results/kinematics-constraints-profile${label ? '-' + label : ''}${sampleAllocations ? '' : '-gc-only'}`;
const errors = [], phases = [];
page.on('pageerror', error => errors.push(error.stack ?? error.message));

function allocationSummary(profile) {
  const sites = [], totals = {solver: 0, callerCallback: 0, engine: 0, demo: 0, harnessOrBrowser: 0};
  let withSolverInStack = 0;
  function visit(node, ancestors) {
    const frame = node.callFrame;
    const stack = ancestors.concat({...frame, lineNumber: frame.lineNumber + 1, columnNumber: frame.columnNumber + 1});
    if (node.selfSize) {
      const solverIndex = stack.findLastIndex(item => /\/packages\/kinematics-constraints\//.test(item.url));
      const source = stack.findLast(item => /\/packages\/(kinematics-constraints|core|margoengine)\/|\/examples\/kinematics-constraints\.html/.test(item.url));
      const callback = solverIndex >= 0 && stack.slice(solverIndex + 1).some(item => /evaluateElbow/.test(item.functionName) || /\/examples\/kinematics-constraints\.html/.test(item.url));
      const category = callback ? 'callerCallback' : source && /\/packages\/kinematics-constraints\//.test(source.url) ? 'solver'
        : source && /\/examples\/kinematics-constraints\.html/.test(source.url) ? 'demo'
          : source ? 'engine' : 'harnessOrBrowser';
      if (solverIndex >= 0) withSolverInStack += node.selfSize;
      totals[category] += node.selfSize;
      sites.push({estimatedBytes: node.selfSize, category, functionName: frame.functionName || '(anonymous)',
        url: frame.url, lineNumber: frame.lineNumber + 1, columnNumber: frame.columnNumber + 1, stack});
    }
    for (const child of node.children) visit(child, stack);
  }
  visit(profile.head, []);
  sites.sort((a, b) => b.estimatedBytes - a.estimatedBytes);
  return {estimatedBytes: sites.reduce((total, site) => total + site.estimatedBytes, 0), estimatedBytesByStackCategory: totals,
    estimatedBytesWithSolverInStack: withSolverInStack,
    sites: sites.slice(0, 40), solverSites: sites.filter(site => site.category === 'solver').slice(0, 30)};
}

async function profilePhase(name, scope, run) {
  await cdp.send('HeapProfiler.collectGarbage');
  const before = await cdp.send('Runtime.getHeapUsage');
  const beforeMetrics = await cdp.send('Performance.getMetrics');
  const events = [], heap = [];
  const collect = ({value}) => events.push(...value);
  cdp.on('Tracing.dataCollected', collect);
  if (sampleAllocations) await cdp.send('HeapProfiler.startSampling', {samplingInterval,
    includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true});
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,v8,disabled-by-default-v8.gc,disabled-by-default-devtools.timeline.memory',
    options: 'record-as-much-as-possible', transferMode: 'ReportEvents',
  });
  const start = performance.now();
  let finished = false, result;
  const poll = (async () => {
    while (!finished) {
      const usage = await cdp.send('Runtime.getHeapUsage');
      heap.push({elapsedMs: performance.now() - start, ...usage});
      await delay(250);
    }
  })();
  try {result = await run();}
  finally {
    finished = true;
    await poll;
    const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end'); await complete;
    cdp.off('Tracing.dataCollected', collect);
  }
  const elapsedMs = performance.now() - start;
  const profile = sampleAllocations ? (await cdp.send('HeapProfiler.stopSampling')).profile : null;
  const after = await cdp.send('Runtime.getHeapUsage');
  const afterMetrics = await cdp.send('Performance.getMetrics');
  // Forced collections are outside the capture window and its natural-GC counts.
  await cdp.send('HeapProfiler.collectGarbage');
  const afterCollection = await cdp.send('Runtime.getHeapUsage');
  const sizes = [before.usedSize, ...heap.map(sample => sample.usedSize), after.usedSize];
  const gc = events.filter(event => event.ph === 'X' && /^(MinorGC|MajorGC)$/.test(event.name));
  const gcDetails = events.filter(event => event.ph === 'X' && (/^(MinorGC|MajorGC)$/.test(event.name) || /^V8\.GC_/.test(event.name)));
  const gcEventNames = {};
  for (const event of gcDetails) gcEventNames[event.name] = (gcEventNames[event.name] ?? 0) + 1;
  const metrics = {};
  for (const item of afterMetrics.metrics) {
    const previous = beforeMetrics.metrics.find(metric => metric.name === item.name);
    if (previous && /Duration|Count/.test(item.name)) metrics[item.name] = item.value - previous.value;
  }
  const allocations = profile ? allocationSummary(profile) : null;
  if (allocations) {
    allocations.estimatedBytesPerSolve = result?.solves ? allocations.estimatedBytes / result.solves : null;
    allocations.estimatedSolverStackBytesPerSolve = result?.solves ? allocations.estimatedBytesWithSolverInStack / result.solves : null;
    allocations.estimatedBytesPerObservedFrame = result?.frames ? allocations.estimatedBytes / result.frames : null;
    allocations.estimatedBytesPerTrustedMove = result?.trustedMoves ? allocations.estimatedBytes / result.trustedMoves : null;
  }
  const report = {
    name, scope, elapsedMs, result, samplingIntervalBytes: sampleAllocations ? samplingInterval : null,
    heap: {before, after, afterForcedCollection: afterCollection, samples: heap,
      minimumUsedBytes: Math.min(...sizes), maximumUsedBytes: Math.max(...sizes), rangeBytes: Math.max(...sizes) - Math.min(...sizes),
      endMinusStartBytes: after.usedSize - before.usedSize, retainedDeltaAfterForcedCollectionBytes: afterCollection.usedSize - before.usedSize},
    garbageCollection: {minorMajorEvents: gc.length, minorMajorPauseMs: gc.reduce((total, event) => total + (event.dur ?? 0) / 1000, 0),
      anyDetailedGCEvents: gcDetails.length, eventNames: gcEventNames},
    allocations, performanceMetricDeltas: metrics,
    observedCriteria: {exactlyFlatMeasuredHeap: Math.max(...sizes) === Math.min(...sizes), zeroGCEvents: gcDetails.length === 0,
      zeroSampledBytesWithSolverInStack: allocations ? allocations.estimatedBytesWithSolverInStack === 0 : null},
    artifacts: {trace: resolve(`${prefix}-${name}.trace.json`), allocations: profile ? resolve(`${prefix}-${name}.heapprofile`) : null},
  };
  await writeFile(`${prefix}-${name}.trace.json`, JSON.stringify({traceEvents: events}));
  if (profile) await writeFile(`${prefix}-${name}.heapprofile`, JSON.stringify(profile));
  phases.push(report);
  console.log(JSON.stringify({phase: name, elapsedMs, result, heapRangeBytes: report.heap.rangeBytes,
    retainedDeltaBytes: report.heap.retainedDeltaAfterForcedCollectionBytes,
    gc: report.garbageCollection, allocationBytesByStack: allocations?.estimatedBytesByStackCategory ?? null}));
  return report;
}

try {
  await cdp.send('Performance.enable');
  // The fixture and demo use prebuilt package modules. Suppress only the dev
  // server's hot-reload client so editor writes cannot reload a capture window.
  await page.route('**/@vite/client', route => route.fulfill({contentType: 'application/javascript', body: '// Hot reload disabled during profiling.\n'}));
  // A minimal same-origin page avoids the renderer, HUD, and demo RAF entirely.
  await page.route('**/__kinematics_profile__.html', route => route.fulfill({contentType: 'text/html',
    body: '<!doctype html><html><meta charset="utf-8"><title>Kinematics solver profile fixture</title><body>Solver-only allocation fixture</body></html>'}));
  await page.goto(`${baseURL}/__kinematics_profile__.html`);
  await page.evaluate(async () => {
    const {AvoidanceSolver, CapsuleVolume, SolveStatus} = await import('/packages/kinematics-constraints/dist/index.js');
    const root = new Float32Array([0.48, 1.25, 0]), raw = new Float32Array([0.9, 0.7, 0.14]);
    const hand = new Float32Array(raw), elbow = new Float32Array(3), statuses = new Uint32Array(4);
    const upper = 0.55, lower = 0.52;
    const volume = new CapsuleVolume({start: [0, 0.45, 0], end: [0, 1.2, 0], radius: 0.32});
    const solver = new AvoidanceSolver([volume], {minClearance: 0.008, complianceMargin: 0.003,
      targetRadius: 0.055, damping: 0.12, maxIterations: 24});
    const options = {swivelSpeedLimit: Math.PI, reachMargin: 0.015, foldMargin: 0.015, searchBudget: 128};
    // This fixture's dimensions are bounded scene units; fixed arithmetic keeps
    // caller callback allocations separate from variadic builtin behavior.
    function length3(x, y, z) {return Math.sqrt(x * x + y * y + z * z);}
    function evaluateElbow(root, target, angle, out) {
      let ax = target[0] - root[0], ay = target[1] - root[1], az = target[2] - root[2];
      const distance = length3(ax, ay, az); ax /= distance; ay /= distance; az /= distance;
      let bx = ay * ax, by = -1 + ay * ay, bz = ay * az;
      let length = length3(bx, by, bz);
      if (length < 1e-6) {bx = -az * ax; by = -az * ay; bz = 1 - az * az; length = length3(bx, by, bz);}
      bx /= length; by /= length; bz /= length;
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      const along = (upper * upper + distance * distance - lower * lower) / (2 * distance);
      const height = Math.sqrt(Math.max(0, upper * upper - along * along)), cosine = Math.cos(angle), sine = Math.sin(angle);
      out[0] = root[0] + ax * along + height * (bx * cosine + cx * sine);
      out[1] = root[1] + ay * along + height * (by * cosine + cy * sine);
      out[2] = root[2] + az * along + height * (bz * cosine + cz * sine);
    }
    let frame = 0, solves = 0, last, minimumClearance = Infinity;
    function runSolverBatch(count) {
      for (let i = 0; i < count; i++) {
        const time = frame++ * 0.007;
        raw[0] = 0.5 + 0.4 * Math.cos(time); raw[1] = 0.8 + 0.2 * Math.sin(time); raw[2] = 0.14;
        last = solver.solve(root, hand, raw, upper, lower, 0.065, 0.055, 1 / 60, evaluateElbow, options);
        statuses[last.status]++; solves++;
        if (last.status === SolveStatus.Success && last.resolved) {
          hand.set(last.target); elbow.set(last.elbow); minimumClearance = Math.min(minimumClearance, last.clearance);
        }
      }
      return solves;
    }
    function snapshot() {return {solves, statuses: Array.from(statuses), minimumAcceptedClearance: minimumClearance, lastStatus: last.status};}
    function resetCounters() {solves = 0; statuses.fill(0); minimumClearance = Infinity;}
    function runSolverFrames(milliseconds, perFrame) {
      return new Promise(resolve => {
        const started = performance.now(); let frames = 0;
        function solverProfileFrame() {
          runSolverBatch(perFrame); frames++;
          if (performance.now() - started < milliseconds) requestAnimationFrame(solverProfileFrame);
          else resolve({...snapshot(), frames, durationMs: performance.now() - started});
        }
        requestAnimationFrame(solverProfileFrame);
      });
    }
    window.kinematicsProfile = {runSolverBatch, snapshot, resetCounters, runSolverFrames};
  });
  await page.evaluate(count => {window.kinematicsProfile.runSolverBatch(count); window.kinematicsProfile.resetCounters();}, warmupSolves);
  const burst = await profilePhase('solver-burst',
    'Warmed synchronous solver + caller-owned analytical IK callback, target updates and success copies; no renderer, HUD, or per-solve harness objects.',
    () => page.evaluate(count => {window.kinematicsProfile.runSolverBatch(count); return window.kinematicsProfile.snapshot();}, burstSolves));
  assert.equal(burst.result.solves, burstSolves);
  await page.evaluate(() => window.kinematicsProfile.resetCounters());
  await profilePhase('solver-continuous',
    'Same warmed solver fixture driven by requestAnimationFrame; renderer and HUD absent. RAF/Promise/CDP/result-marshalling allocations remain observable as harness overhead.',
    () => page.evaluate(({durationMs, solvesPerFrame}) => window.kinematicsProfile.runSolverFrames(durationMs, solvesPerFrame), {durationMs, solvesPerFrame}));

  await page.goto(`${baseURL}/examples/kinematics-constraints.html`);
  await page.waitForFunction(() => window.kinematicsDemo || document.querySelector('#error')?.textContent);
  assert.equal(await page.locator('#error').textContent(), '');
  await page.evaluate(() => {
    const demo = window.kinematicsDemo;
    function runDemoSweep(milliseconds) {
      return new Promise(resolve => {
        const counts = new Uint32Array(4), started = performance.now(); let frames = 0, accepted = 0, minimumClearance = Infinity;
        function demoProfileFrame() {
          const seconds = (performance.now() - started) / 1000;
          // Programmatic drag-equivalent target input. The existing engine RAF
          // performs solving, transforms, rendering, cursor and HUD work.
          demo.setTarget(0.5 + 0.4 * Math.cos(seconds * 0.7), 0.8 + 0.2 * Math.sin(seconds * 0.7), 0.14);
          const result = demo.result; counts[result.status]++; frames++;
          if (result.resolved) accepted++;
          minimumClearance = Math.min(minimumClearance, demo.clearance);
          if (performance.now() - started < milliseconds) requestAnimationFrame(demoProfileFrame);
          else resolve({frames, observedSuccessfulFrames: accepted, statuses: Array.from(counts), minimumAcceptedClearance: minimumClearance,
            durationMs: performance.now() - started, finalTarget: Array.from(demo.currentHand), backend: document.querySelector('#backend').textContent});
        }
        requestAnimationFrame(demoProfileFrame);
      });
    }
    window.kinematicsProfile = {runDemoSweep};
  });
  // Warm the complete page through moving targets before opening its capture.
  await page.evaluate(() => window.kinematicsProfile.runDemoSweep(2000));
  const demo = await profilePhase('demo-continuous-drag',
    'Complete rendered page with RAF-driven setTarget inputs: solver, transform adapters, engine/WebGPU, cursor and DOM HUD. Not a pointer-event dispatch test.',
    () => page.evaluate(milliseconds => window.kinematicsProfile.runDemoSweep(milliseconds), durationMs));
  assert.ok(demo.result.frames > 1, 'Rendered target sweep did not advance');
  assert.ok(demo.result.minimumAcceptedClearance >= 0.008 - 1e-6, 'Accepted pose lost clearance');
  await page.evaluate(() => {
    const demo = window.kinematicsDemo, canvas = document.querySelector('canvas'), statuses = new Uint32Array(4);
    let moves = 0, trusted = 0, frames = 0, active = false, minimumClearance = Infinity;
    function countPointerDrag(event) {
      moves++; if (event.isTrusted) trusted++;
    }
    function recordPointerFrame() {
      if (!active) return;
      frames++;
      statuses[demo.result.status]++;
      minimumClearance = Math.min(minimumClearance, demo.clearance);
      requestAnimationFrame(recordPointerFrame);
    }
    canvas.addEventListener('pointermove', countPointerDrag);
    window.kinematicsPointerProfile = {begin() {active = true; requestAnimationFrame(recordPointerFrame);},
      snapshot() {active = false; return {moves, trustedMoves: trusted, frames, statuses: Array.from(statuses), minimumAcceptedClearance: minimumClearance};},
      dispose() {active = false; canvas.removeEventListener('pointermove', countPointerDrag);}};
  });
  const rect = await page.locator('canvas').boundingBox();
  assert.ok(rect);
  const pointer = await profilePhase('demo-trusted-pointer-drag',
    'Complete rendered page with trusted CDP mouse input through its real pointer handlers; includes input-event, engine, cursor, HUD and solver allocations.',
    async () => {
      await page.evaluate(() => window.kinematicsPointerProfile.begin());
      const started = performance.now(), x = rect.x + rect.width * 0.5, y = rect.y + rect.height * 0.5;
      await cdp.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1});
      while (performance.now() - started < durationMs) {
        const seconds = (performance.now() - started) / 1000;
        await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved',
          x: x + rect.width * 0.18 * Math.sin(seconds * 0.8), y: y + rect.height * 0.1 * Math.cos(seconds * 0.8), button: 'left', buttons: 1});
        await delay(32);
      }
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1});
      return page.evaluate(() => window.kinematicsPointerProfile.snapshot());
    });
  assert.ok(pointer.result.moves > 1, 'Trusted pointer drag did not advance');
  assert.equal(pointer.result.moves, pointer.result.trustedMoves, 'Pointer moves were not trusted browser events');
  assert.ok(pointer.result.minimumAcceptedClearance >= 0.008 - 1e-6, 'Accepted pose lost clearance during pointer drag');
  await page.evaluate(() => window.kinematicsPointerProfile.dispose());
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(error.stack ?? String(error));
  throw error;
} finally {
  const report = {startedAt, finishedAt: new Date().toISOString(), sourceSHA256, hardware: app.hardware,
    parameters: {durationMs, burstSolves, warmupSolves, solvesPerFrame, samplingInterval, allocationSampling: sampleAllocations}, phases, errors,
    interpretation: [
      'Allocation sampling includes objects subsequently collected by minor/major GC; estimated bytes and absent samples cannot prove exact zero allocation.',
      'Solver-stack totals include caller IK callbacks and native builtin allocations invoked through package frames. Source categories separately identify caller callbacks, package, demo and engine leaf frames; inspect recorded stacks for responsibility.',
      'Heap-size polling, V8 optimization, CDP evaluation/result marshalling and profiler activity can change the measured heap independently of retained solver objects.',
      'Forced collections occur before/after each trace and are excluded from natural GC counts. A small post-GC delta is not by itself a leak.',
      'Full-page rendering/HUD allocation and GC are reported independently; this script does not assert that the entire page has zero allocation or zero GC.',
      'Pages are served by the repository Vite development server, with its hot-reload client disabled during captures. This is not a production static-server timing benchmark.',
      '--gc-only repeats the same workloads without allocation sampling to separate its overhead from heap/GC/cadence observations.',
      'Software GPU rendering and profiling overhead make these timings unsuitable as a hardware performance promise.',
    ]};
  await writeFile(`${prefix}.json`, JSON.stringify(report, null, 2));
  await app.close();
}
