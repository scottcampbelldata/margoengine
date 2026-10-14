import {EngineKernel, box, PbrMaterial} from '../../packages/core/dist/index.js';
import {Stats} from '../../packages/stats/dist/index.js';
import {withGPUTiming, restoreTimingSetup} from './gpu-timing.js';
import {submitPrincipalScene} from '../../packages/shared/demo-frame.js';
import {createWorkloadForPage} from './factory-loading.js';

const demos = {
  ecs: {sizes: [1000, 10000, 20000], initial: 10000, load: () => import('./ecs.js')},
  fsm: {sizes: [100, 1000, 5000], initial: 1000, load: () => import('./fsm.js')},
  tween: {sizes: [100, 1000, 2500], initial: 1000, load: () => import('./tween.js')},
  net: {sizes: [64, 256, 1024], initial: 256, load: () => import('./net.js')},
  bvh: {sizes: [64, 256, 1024], initial: 256, label: 'Rays per frame', load: () => import('./bvh.js')},
  splines: {sizes: [96, 384, 1536], initial: 384, label: 'Curve samples + followers', load: () => import('./splines.js')},
  navmesh: {sizes: [48, 96, 160], initial: 96, label: 'Agents + 32 polygon markers', load: () => import('./navmesh.js')},
  wfc: {sizes: [64, 256, 1024], initial: 64, label: 'Generated cells', load: () => import('./wfc.js')},
  navigation: {sizes: [96, 128, 256], initial: 128, label: '72 floor markers + path agents', load: () => import('./navigation.js')},
  physics: {sizes: [80, 272, 528], initial: 80, label: 'Dynamic bodies + 16 ray hits', load: () => import('./physics.js')},
  road: {sizes: [136, 520, 1032], initial: 136, label: 'Road cross-section markers', load: () => import('./road.js')},
  gizmo: {sizes: [4, 16, 64], initial: 16, label: 'Selectable actors', load: () => import('./gizmo.js')},
  inspector: {sizes: [4, 16, 64], initial: 16, label: 'Inspectable actors', load: () => import('./inspector.js')},
  labels: {sizes: [4, 16, 64], initial: 16, label: 'Mesh labels + one CSS3D card', load: () => import('./labels.js')},
  html: {sizes: [4, 16, 64], initial: 16, label: 'Cubes with two depth anchors each', load: () => import('./html.js')},
  loaders: {sizes: [1, 4, 9], initial: 4, label: 'PLY model parses per batch', load: () => import('./loaders.js')},
  exporters: {sizes: [1, 4, 9], initial: 4, label: 'Four-format export jobs per batch', load: () => import('./exporters.js')},
  'usdz-export': {sizes: [1, 4, 9], initial: 4, label: 'USDZ round trips per batch', load: () => import('./usdz-export.js')},
  decoders: {sizes: [1, 4, 9], initial: 4, label: 'Draco jobs per two-worker batch', load: () => import('./decoders.js')},
  ifc: {sizes: [1, 4, 9], initial: 4, label: 'IFC wall parses per batch', load: () => import('./ifc.js')},
  fbx: {sizes: [1, 4, 9], initial: 4, label: 'Static FBX conversions per batch', load: () => import('./fbx.js')},
  points: {sizes: [1, 4, 9], initial: 4, label: '397-point clouds + sprite markers', load: () => import('./points.js')},
  toon: {sizes: [1, 4, 9], initial: 4, label: 'Stepped-shading + hull models', load: () => import('./toon.js')},
  transitions: {sizes: [1, 4, 9], initial: 4, label: 'Models in each captured scene', load: () => import('./transitions.js')},
  animator: {sizes: [1, 2, 4], initial: 1, label: 'Skinned robot models', load: () => import('./animator.js')},
  taa: {sizes: [1, 2, 4], initial: 1, label: 'Temporal animated robot models', load: () => import('./taa.js')},
  text: {sizes: [4, 16, 64], initial: 16, label: 'Text blocks + depth anchors', load: () => import('./text.js')},
  splats: {sizes: [1, 4, 9], initial: 4, label: '397-Gaussian bunny groups', load: () => import('./splats.js')},
  audio: {sizes: [1, 4, 9], initial: 4, label: 'Positional audio emitters', load: () => import('./audio.js')},
  video: {sizes: [1, 4, 9], initial: 4, label: 'External video surfaces', load: () => import('./video.js')},
  blender: {sizes: [1, 4, 9], initial: 4, label: 'Textured .margo fixture models', load: () => import('./blender.js')}
};
const element = id => document.getElementById(id), canvas = element('scene'), select = element('package'), count = element('count'), button = element('run');
const timing = element('gpu-timing');
const requested = new URLSearchParams(location.search).get('package'); if (Object.hasOwn(demos, requested)) select.value = requested;
const cpu = new Float64Array(120), rendering = new Float64Array(120);
const captured = new Float64Array(4096 * 4), lifecycle = new AbortController();
let capturedFrames = 0, readiness = {}, generation = 0;
let engine, stats, workload, meshes = [], colors, previous = 0, frame = 0, frames = 0, sampleCount = 0, sampleIndex = 0, cpuTotal = 0, renderTotal = 0, running = false, busy = false, pageDisposed = false;
const materials = ['#82d9ba', '#e6bb79', '#a8a3e6', '#e9908c'].map(color => new PbrMaterial({color, roughness: 0.65}));

function pause(message = 'Paused. Press Run to resume measurement.') {
  workload?.pause?.();
  running = false; cancelAnimationFrame(frame); frame = previous = 0;
  button.textContent = 'Run'; button.setAttribute('aria-pressed', 'false'); element('status').textContent = message;
}
function run() {
  if (!engine || busy || running || pageDisposed) return;
  running = true; previous = 0; button.textContent = 'Pause'; button.setAttribute('aria-pressed', 'true');
  element('status').textContent = `Running @margoengine/${select.value}. Target: 60 FPS.`; frame = requestAnimationFrame(tick);
}
function paint() {
  const points = workload.points;
  for (let i = 0; i < meshes.length; i++) {
    meshes[i].position.set(points[i * 4], points[i * 4 + 1], points[i * 4 + 2]);
    if (workload.yaw) meshes[i].rotation.y = workload.yaw[i];
    const color = points[i * 4 + 3]; if (colors[i] !== color) {meshes[i].setMaterial(materials[color]); colors[i] = color;}
  }
}
function tick(now) {
  if (!running) return;
  const interval = previous ? now - previous : 0, delta = Math.min(0.1, interval / 1000); previous = now;
  try {
    const start = performance.now(); workload.step(delta); const ready = performance.now();
    paint(); engine.render({delta, culling: false}); const end = performance.now();
    cpuTotal += ready - start - cpu[sampleIndex]; renderTotal += end - ready - rendering[sampleIndex];
    cpu[sampleIndex] = ready - start; rendering[sampleIndex] = end - ready;
    sampleIndex = (sampleIndex + 1) % cpu.length; sampleCount = Math.min(cpu.length, sampleCount + 1); frames++;
    if (capturedFrames < 4096) {const offset = capturedFrames++ * 4; captured[offset] = now; captured[offset + 1] = interval; captured[offset + 2] = ready - start; captured[offset + 3] = end - ready;}
    if (running) frame = requestAnimationFrame(tick);
  } catch (error) {pause(`Measurement stopped: ${error.message ?? String(error)}`);}
}
function result({samples = false} = {}) {
  const passTimes = stats?.gpuPassMilliseconds;
  return {package: `@margoengine/${select.value}`, running, frames, targetFps: 60,
    fps: stats?.sampleCount ? stats.fps : null, frameMilliseconds: stats?.sampleCount ? stats.frameTime : null,
    workloadCpuMilliseconds: sampleCount ? cpuTotal / sampleCount : null, renderCpuMilliseconds: sampleCount ? renderTotal / sampleCount : null,
    actors: meshes.length, renderedObjects: workload?.renderedObjects ?? meshes.length,
    expectedEngineVisible: workload?.expectedEngineVisible ?? workload?.renderedObjects ?? meshes.length,
    visible: engine?.stats.visible ?? 0, draws: stats?.drawCalls ?? 0, backend: engine?.backend,
    canvas: [canvas.width, canvas.height], gpuTimingEnabled: timing.checked, gpuTimingSupported: timestampSupport(), gpuPassMilliseconds: stats?.gpuTime ?? null,
    gpuProfilePassCount: stats?.gpuPassCount ?? 0, gpuProfileSpanMilliseconds: stats?.gpuElapsedMilliseconds ?? null,
    gpuProfilePassMilliseconds: passTimes ? Array.from(passTimes.subarray(0, stats.gpuPassCount)) : null,
    readiness: {...readiness}, generation, capturedFrames, captureTruncated: frames > capturedFrames,
    samples: samples ? Array.from(captured.subarray(0, capturedFrames * 4)) : undefined, workload: workload?.details(), ui: workload?.interaction?.()};
}
function timestampSupport() {
  try {return engine?.backend === 'webgpu' && !!canvas.getContext('webgpu')?.getConfiguration()?.device.features.has('timestamp-query');} catch {return false;}
}
function refresh() {
  element('fps-placeholder').hidden = !!stats?.sampleCount; if (stats) stats.element.hidden = !stats.sampleCount;
  element('workload-cpu').textContent = sampleCount ? `${(cpuTotal / sampleCount).toFixed(3)} ms` : '—';
  element('render-cpu').textContent = sampleCount ? `${(renderTotal / sampleCount).toFixed(3)} ms` : '—';
  element('visible').textContent = engine ? engine.stats.visible.toLocaleString() : '—';
  element('backend').textContent = engine ? `${engine.backend} · ${canvas.width} × ${canvas.height} backing pixels` : 'Waiting for the engine';
  element('gpu-status').textContent = !timing.checked ? 'GPU timing is off. FPS is measured without timestamp queries.' : !engine ? 'GPU timing is waiting for the engine.' :
    !timestampSupport() ? 'GPU timing is unavailable on the active device or backend. After device restoration, toggle GPU timing off and on to rebuild.' :
    stats.gpuTime === null ? 'GPU timing is warming up. Press Run to collect a supported timestamp sample.' : 'GPU timing reports the sum of sampled pass execution. FPS includes instrumentation overhead.';
  element('counts').textContent = workload ? Object.entries(workload.details()).map(([key, value]) => `${key}: ${value}`).join(' · ') : '';
}
function sizes() {
  element('count-label').textContent = demos[select.value].label ?? 'Workload size';
  count.replaceChildren(...demos[select.value].sizes.map(size => {const option = document.createElement('option'); option.value = size; option.textContent = size.toLocaleString(); return option;}));
  count.value = demos[select.value].initial;
}
async function load() {
  if (pageDisposed) return;
  pause('Loading the selected workload…'); busy = true; button.disabled = select.disabled = count.disabled = timing.disabled = true;
  workload?.dispose?.(); engine?.dispose(); engine = stats = workload = undefined; meshes = [];
  element('package-ui').replaceChildren(); element('package-ui').hidden = true;
  cpu.fill(0); rendering.fill(0); cpuTotal = renderTotal = frames = sampleCount = sampleIndex = capturedFrames = 0;
  readiness = {loadStarted: performance.now()}; generation++;
  try {
    const module = await demos[select.value].load(); if (pageDisposed) return;
    readiness.moduleLoaded = performance.now();
    workload = await createWorkloadForPage(module, Number(count.value), lifecycle.signal);
    if (pageDisposed) {workload.dispose?.(); workload = undefined; return;}
    readiness.workloadConstructed = performance.now();
    element('description').textContent = workload.description;
    const capacity = workload.capacity ?? Number(count.value);
    if (!Number.isSafeInteger(capacity) || capacity < Number(count.value) || capacity > 100000) throw new RangeError('Invalid workload transform capacity');
    const created = await withGPUTiming(timing.checked, () => EngineKernel.create(canvas, {capacity, camera: {position: [0, 20, 25], target: [0, 0, 0], fov: 45, far: 1000}}));
    if (pageDisposed) {created.dispose(); return;} engine = created;
    readiness.engineCreated = performance.now();
    engine.onError = error => pause(`Engine stopped: ${error.message ?? String(error)}`);
    stats = Stats.attach(engine, {parent: element('stats'), profiling: timing.checked}); stats.element.hidden = true; stats.element.style.position = 'static'; stats.element.style.width = '100%'; stats.element.style.border = '0'; stats.element.style.padding = '0'; stats.element.style.background = 'transparent';
    const geometry = box(0.22, 0.22, 0.22); colors = new Int8Array(Number(count.value)).fill(-1);
    for (let i = 0; i < Number(count.value); i++) meshes.push(engine.createMesh().setGeometry(geometry));
    fit();
    workload.step(0); paint();
    readiness.mountStarted = performance.now();
    await workload.mount?.({engine, meshes, parent: element('package-ui'), stage: canvas.parentElement, render: preview});
    if (pageDisposed) return;
    readiness.mountCompleted = performance.now();
    fit(); readiness.principalObjects = workload.renderedObjects ?? meshes.length; readiness.assembled = performance.now();
    const queue = engine.backend === 'webgpu' ? canvas.getContext('webgpu').getConfiguration().device.queue : undefined;
    Object.assign(readiness, await submitPrincipalScene(() => engine.render({delta: 0, culling: false}), queue, {signal: lifecycle.signal}));
    if (pageDisposed) return;
    element('status').textContent = `Ready: @margoengine/${select.value}, ${meshes.length.toLocaleString()} actors. Press Run.`;
  } catch (error) {element('status').textContent = `Could not load the workload: ${error.message ?? String(error)}`; engine?.dispose(); workload?.dispose?.(); engine = stats = workload = undefined;}
  finally {busy = false; select.disabled = count.disabled = timing.disabled = false; button.disabled = !engine; refresh(); if (engine && !pageDisposed) workload.afterReady?.();}
}
function fit() {
  if (!engine || !meshes.length || pageDisposed) return;
  const extent = Math.ceil(Math.sqrt(meshes.length)) * 0.2 + 0.35;
  engine.camera.fitToBoundingBox(workload.bounds?.min ?? [-extent, 0, -extent], workload.bounds?.max ?? [extent, 1.3, extent], {aspect: canvas.clientWidth / canvas.clientHeight, duration: 0, padding: 1.1});
  if (!running && !busy) {paint(); engine.render({delta: 0, culling: false});}
}
function preview() {if (!running && !busy && engine && !pageDisposed) {workload.step(0); paint(); engine.render({delta: 0, culling: false}); return true;} return false;}
button.addEventListener('click', () => running ? pause() : run());
select.addEventListener('change', () => {sizes(); void load();}); count.addEventListener('change', () => {void load();});
timing.addEventListener('change', () => {void load();});
document.addEventListener('visibilitychange', () => {if (document.hidden && running) pause('Paused while the page is hidden. Press Run to continue.');});
const timer = setInterval(refresh, 250);
const resize = new ResizeObserver(fit); resize.observe(canvas);
addEventListener('pagehide', event => {pause(); restoreTimingSetup(); if (!event.persisted) {pageDisposed = true; lifecycle.abort(); clearInterval(timer); resize.disconnect(); workload?.dispose?.(); engine?.dispose();}});
window.packageBenchmark = {run, pause, result}; sizes(); void load();
