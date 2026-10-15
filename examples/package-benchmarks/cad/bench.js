// Browser side of the CAD benchmark. Driven by run.mjs; window.cad.run(config) returns one result object.
import {Engine} from '../../../packages/core/dist/index.js';
import {Stats} from '../../../packages/stats/dist/index.js';
import {loadCAD} from '../../../packages/machinery/dist/cad.js';
import {withGPUTiming} from '../gpu-timing.js';
import {buildAssembly, ENTITIES_PER_MODULE} from './assembly.js';

const now = () => performance.now(), frame = () => new Promise(r => requestAnimationFrame(r));
const stat = values => {const v = [...values].sort((a, b) => a - b), at = q => v[Math.min(v.length - 1, Math.floor(v.length * q))];return v.length ? {n: v.length, median: +at(0.5).toFixed(4), p95: +at(0.95).toFixed(4), max: +v.at(-1).toFixed(4), mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4)} : null;};
const time = (fn, reps = 1) => {const t = now();for (let i = 0; i < reps; i++) fn(i);return (now() - t) / reps;};
const mb = bytes => +(bytes / 2 ** 20).toFixed(2);
// machinery is loaded by URL so run.mjs can point a run at another build (--machinery=/path/to/dist) for before/after.
const machinery = (base, file) => import(/* @vite-ignore */ `${base}/${file}.js`);

const edgeCpu = [];
async function run({machineryBase = '/packages/machinery/dist', modules, frames = 240, warmup = 60, pick = true, bvh = true, explode = true, edges = false, view = 'overview', low = false, still = false, move = 0}) {
  if (low) globalThis.margoLow = 1;
  const canvas = document.getElementById('view'), result = {modules, crossOriginIsolated, msaa: low ? 1 : 4, view, still, move};
  const capacity = modules * ENTITIES_PER_MODULE + Math.ceil(modules / 32) + 1;
  let t = now();const engine = await withGPUTiming(true, () => Engine.create(canvas, {capacity, camera: {fov: 45, near: 0.05, far: 2000}}));result.engineCreateMs = now() - t;
  const errors = [];engine.gpu.addEventListener('uncapturederror', e => errors.push(e.error.message));
  t = now();const assembly = buildAssembly(engine, modules);result.buildMs = now() - t;
  result.parts = assembly.parts.length;result.groups = assembly.groups.length;result.entities = assembly.parts.length + assembly.groups.length;result.capacity = capacity;
  const shapes = Object.entries(assembly.geometries).map(([name, g]) => ({name, triangles: g.indices.length / 3, vertices: g.vertices.length / 6}));
  result.shapes = shapes;result.triangles = assembly.parts.reduce((sum, p) => sum + p.geometry.indices.length / 3, 0);
  if (edges) {const {FeatureEdges} = await machinery(machineryBase, 'edges');t = now();const plugin = new FeatureEdges({angle: 30, width: 1.5});engine.use(plugin);result.edgesSetupMs = now() - t;result.edgeSegments = plugin.stats;const draw = plugin.draw.bind(plugin);plugin.draw = c => {const s = now();draw(c);edgeCpu.push(now() - s);};}
  const r = assembly.extent * (view === 'close' ? 0.12 : 0.75), aim = view === 'close' ? [0, 0, 0] : [0, 0, 0];
  const orbit = a => {engine.camera.position = [Math.cos(a) * r, r * (view === 'close' ? 0.5 : 0.65), Math.sin(a) * r];engine.camera.target = aim;};orbit(0);
  // First frame: pipeline compile, instance storage growth and first uploads.
  t = now();engine.render();await engine.gpu.queue.onSubmittedWorkDone();result.firstFrameMs = now() - t;result.loadToFirstFrameMs = result.engineCreateMs + result.buildMs + result.firstFrameMs;
  // Kernel alone: transform + hierarchy + cull, no rendering. Same planes as the frame.
  const {AssemblyBVH} = await machinery(machineryBase, 'spatial'), {ExplodedView} = await machinery(machineryBase, 'exploded');
  const store = engine.store;store.planes.set(engine.camera.planes);
  for (let i = 0; i < 10; i++) store.tick(true);
  const tickCull = [], tickNoCull = [];for (let i = 0; i < 60; i++) {tickCull.push(time(() => store.tick(true)));tickNoCull.push(time(() => store.tick(false)));}
  result.kernel = {tickCullMs: stat(tickCull), tickNoCullMs: stat(tickNoCull), perPartNs: +(stat(tickCull).median * 1e6 / result.entities).toFixed(1)};
  // Frame loop with the real engine; wrap render, the kernel tick and the renderer to split CPU time.
  const stats = new Stats({profiling: true});engine.use(stats);
  const renderer = engine.renderer, rawRender = engine.render.bind(engine), rawTick = store.tick.bind(store), rawSubmit = renderer.render.bind(renderer);
  let tickMs = 0, submitMs = 0;const cpu = [], kernel = [], submit = [], collect = [], intervals = [], gpu = [], passes = [];
  store.tick = c => {const s = now();rawTick(c);tickMs = now() - s;};renderer.render = (...a) => {const s = now();rawSubmit(...a);submitMs = now() - s;};
  let frameNo = 0, last = 0, lastGpu = null, angle = 0, done, started = now();const finished = new Promise(res => done = res);
  engine.render = o => {const s = now();rawRender(o);const total = now() - s;frameNo++;
    if (frameNo > warmup) {cpu.push(total);kernel.push(tickMs);submit.push(submitMs);collect.push(total - tickMs - submitMs);if (last) intervals.push(s - last);
      if (stats.gpuTime !== null && stats.gpuTime !== lastGpu) {gpu.push(stats.gpuTime);passes.push(Array.from(stats.gpuPassMilliseconds.subarray(0, stats.gpuPassCount)));lastGpu = stats.gpuTime;}}
    last = s;if (frameNo >= warmup + frames && (gpu.length >= 12 || s - started > 45_000)) done();};
  // --still: fixed camera. --move=0.01: every 1/move-th part bobs each frame (the "1% of parts move" case).
  const movers = move ? assembly.parts.filter((_, i) => i % Math.round(1 / move) === 0).map(p => [p, p.position.y]) : [];result.movers = movers.length;
  engine.onFrame((_, delta) => {if (!still) {angle += delta * 0.3;orbit(angle);}const dy = 0.002 * Math.sin(frameNo * 0.2);for (const [p, y] of movers) p.position.y = y + dy;});
  engine.start();await finished;engine.stop();
  result.frame = {cpuMs: stat(cpu), kernelMs: stat(kernel), collectMs: stat(collect), submitMs: stat(submit), intervalMs: stat(intervals), fps: +(1000 / stat(intervals).median).toFixed(1), gpuMs: stat(gpu), drawCalls: stats.drawCalls, visible: engine.stats.visible};
  result.frame.edgesCpuMs = stat(edgeCpu.slice(warmup));result.edgesFirstDrawMs = edgeCpu[0] ?? null;result.frame.gpuPassMedianMs = passes.length ? passes[0].map((_, i) => stat(passes.map(p => p[i] ?? 0)).median) : null;
  engine.render = rawRender;store.tick = rawTick;renderer.render = rawSubmit;engine.removePlugin('stats');
  // Serial frames: wait for the GPU after each submit, so the GPU tail is not hidden by pipelining (timestamp sums are unreliable when frames queue).
  const isolated = async n => {const c = [], g = [];for (let i = 0; i < n; i++) {angle += 0.05;orbit(angle);const s = now();engine.render();const m = now();await engine.gpu.queue.onSubmittedWorkDone();c.push(m - s);g.push(now() - m);}return {cpuMs: stat(c), gpuTailMs: stat(g), frameMs: stat(c.map((v, i) => v + g[i]))};};
  result.isolated = await isolated(30);if (edges) {engine.removePlugin('feature-edges');result.isolatedNoEdges = await isolated(30);}
  if (pick) {const picks = [];let hits = 0;for (let i = 0; i < 12; i++) {const s = now();const hit = await engine.pick(canvas.clientWidth / 2 + (i % 4) * 7, canvas.clientHeight / 2 + (i >> 2) * 7);picks.push(now() - s);if (hit) hits++;}result.enginePick = {ms: stat(picks.slice(2)), first: picks[0], hits};}
  if (bvh) {
    try {
      t = now();const index = await AssemblyBVH.create(assembly.parts);const createMs = now() - t;
      const rebuildMs = time(() => index.rebuild(), 3), eye = engine.camera.position, target = [0, 0, 0], rays = [];let hits = 0;
      for (let i = 0; i < 200; i++) {const d = [target[0] - eye[0] + (i % 20 - 10) * 0.05, target[1] - eye[1], target[2] - eye[2] + (Math.floor(i / 20) - 5) * 0.05];const s = now();if (index.raycast([...eye], d)) hits++;rays.push(now() - s);}
      result.assemblyBVH = {createMs, rebuildMs, raycastMs: stat(rays), hits};index.dispose();
    } catch (error) {result.assemblyBVH = {error: String(error.message ?? error)};}
  }
  if (explode) {
    const offsets = assembly.parts.map(p => {const m = p.matrix;return {node: p, offset: [m[12] * 0.3, 0.05 + (p.name === 'bolt' ? 0.1 : 0), m[14] * 0.3]};});
    t = now();const view = new ExplodedView(offsets);engine.use(view);const setupMs = now() - t;
    const animate = [], still = [];for (let i = 0; i < 40; i++) {view.amount = (i % 10) / 10;animate.push(time(() => view.onPreUpdate(0)));}
    for (let i = 0; i < 40; i++) still.push(time(() => view.onPreUpdate(0)));
    const frameMs = [];for (let i = 0; i < 30; i++) {view.amount = i / 30;const s = now();engine.render();frameMs.push(now() - s);}
    result.explodedView = {setupMs, animatingMs: stat(animate), unchangedMs: stat(still), renderWhileAnimatingMs: stat(frameMs)};engine.removePlugin('exploded-view');
  }
  // Instance storage: the CPU staging array and the GPU buffer have the same size (24 floats per slot).
  const instanceBytes = Object.values(assembly.geometries).reduce((s, g) => s + engine.geometryBuffers(g).instance.size, 0), geometryBytes = Object.values(assembly.geometries).reduce((sum, g) => sum + g.vertices.byteLength + g.indices.byteLength, 0);
  result.memory = {jsHeapMB: performance.memory ? mb(performance.memory.usedJSHeapSize) : null, kernelWasmMB: mb(engine.store.matrices.buffer.byteLength), instanceStagingMB: mb(instanceBytes), gpuInstanceMB: mb(instanceBytes), geometryMB: mb(geometryBytes), msaaTargetsMB: mb(canvas.width * canvas.height * (low ? 0 : 4 * 4 + 4 * 5))};
  const one = assembly.parts.at(-1);result.removeOneMeshMs = time(() => one.dispose());
  result.errors = errors;return result;
}

async function step({url, format}) {
  const canvas = document.getElementById('view'), engine = await Engine.create(canvas, {capacity: 4096}), marks = [];const start = now();
  try {
    const model = await loadCAD(engine, url, {format, onProgress: p => marks.push([p, now() - start])});const total = now() - start;
    const at = p => marks.find(m => m[0] >= p)?.[1] ?? null;
    let triangles = 0;const unique = new Set();for (const m of model.meshes) {triangles += m.geometry.indices.length / 3;unique.add(m.geometry);}
    return {url, format, totalMs: total, workerStartMs: at(0), occtReadyMs: at(10), tessellatedMs: at(50), meshes: model.meshes.length, uniqueGeometries: unique.size, triangles};
  } finally {engine.dispose();}
}

// Still frame for a visual check: one zone close up with feature edges, optionally orthographic.
async function view({modules = 64, ortho = false} = {}) {
  const engine = await Engine.create(document.getElementById('view'), {capacity: modules * ENTITIES_PER_MODULE + 8, camera: {fov: 35, position: [1.6, 1.3, 2.2], target: [0, 0, 0], near: 0.02, far: 100}});
  buildAssembly(engine, modules);const {FeatureEdges} = await machinery('/packages/machinery/dist', 'edges');engine.use(new FeatureEdges());
  if (ortho) {const {CameraProjection} = await import(/* @vite-ignore */ '/packages/cameras/dist/index.js');engine.use(new CameraProjection({mode: 'orthographic', height: 2}));}
  engine.render();await engine.gpu.queue.onSubmittedWorkDone();engine.render();await engine.gpu.queue.onSubmittedWorkDone();return true;
}

window.cad = {run, step, view};window.ready = true;
