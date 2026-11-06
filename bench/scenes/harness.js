// In-page measurement, identical for every engine (Margo's ./margo.js and any engine served from engine-bench). The
// page (./page.js) imports this module before the engine, so the WebGPU wrappers below see every device, pass and
// allocation the engine makes, and no engine's own profiler is trusted.
// An engine module exports create(canvas, {scene, params, data}, marks) and returns
//   {render(t), idle(): Promise, info?(): {drawCalls, triangles, note}, gl?: WebGL2RenderingContext, samples?}
// render(t) applies that frame's scene update and submits it; t is scene time in seconds (a fixed 1/60 s per frame, so
// every engine shows the same camera path and motion per frame whatever its frame rate). marks.createMs (engine or
// device creation) and marks.buildMs (scene build or model load) are the engine's to fill.
import { SCENES, sceneParams } from './catalog.js';

const q = new URLSearchParams(location.search),
  numeric = (v) => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
const passed = Object.fromEntries([...q].map(([k, v]) => [k, numeric(v)]));
/** Harness options (frame counts and limits) with their defaults; everything else in the query is a scene parameter. */
export const options = {
  engine: String(passed.engine ?? 'margo'),
  scene: String(passed.scene ?? 'boxes'),
  warmup: passed.warmup ?? 60,
  frames: passed.frames ?? 300,
  gpuFrames: passed.gpuFrames ?? 60,
  serialFrames: passed.serialFrames ?? 30,
  maxPhaseMs: passed.maxPhaseMs ?? 20_000,
  // Task scenes: calls thrown away after the cold call, then measured calls (harness.js runTask).
  taskWarmup: passed.taskWarmup ?? 3,
  taskIterations: passed.taskIterations ?? 30,
  // The folder the scenes' models load from (the repository's examples/assets when the CLI serves the page).
  assets: String(passed.assets ?? '/examples/assets/'),
  dump: q.has('dump'),
};
const harnessKeys = new Set([...Object.keys(options), 'run']);
export const params = sceneParams(
  options.scene,
  Object.fromEntries(Object.entries(passed).filter(([k]) => !harnessKeys.has(k))),
);
const scriptMs = performance.now();

const stat = (values) => {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b),
    at = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p))],
    r = (x) => +x.toFixed(3);
  return {
    n: v.length,
    median: r(at(0.5)),
    p95: r(at(0.95)),
    min: r(v[0]),
    max: r(v.at(-1)),
    mean: r(v.reduce((a, b) => a + b, 0) / v.length),
  };
};
const raf = () => new Promise((r) => requestAnimationFrame(r));
const resources = () =>
  performance.getEntriesByType('resource').map((r) => ({
    name: new URL(r.name).pathname,
    bytes: r.encodedBodySize,
    transfer: r.transferSize,
    ms: +r.duration.toFixed(1),
  }));

// WebGPU: every device gets 'timestamp-query' when the adapter has it, and while `ts.on` every render/compute pass gets
// begin/end timestamp writes. GPU time of a frame = sum of its pass durations. Live GPU memory = bytes of buffers and
// textures created and not yet destroyed (texture bytes from size, format, mips and samples).
let device;
const ts = { on: false, n: 0, cap: 2048, desc: [] },
  memory = { live: new Map(), bytes: 0, peak: 0 };
const texel = (format) =>
  /32float|32uint|32sint/.test(format)
    ? /^rgba/.test(format)
      ? 16
      : /^rg/.test(format)
        ? 8
        : 4
    : /16float|16uint|16sint|16unorm/.test(format)
      ? /^rgba/.test(format)
        ? 8
        : /^rg/.test(format)
          ? 4
          : 2
      : /^(r8|stencil8)/.test(format)
        ? 1
        : /^rg8/.test(format)
          ? 2
          : /^(bc1|bc4|etc2-rgb8|eac-r11)/.test(format)
            ? 0.5
            : /^(bc|astc|etc|eac)/.test(format)
              ? 1
              : /depth32float-stencil8/.test(format)
                ? 5
                : 4;
const track = (object, bytes) => {
  memory.live.set(object, bytes);
  memory.bytes += bytes;
  memory.peak = Math.max(memory.peak, memory.bytes);
};
if (globalThis.GPUAdapter) {
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (d = {}) {
    const features = [...(d.requiredFeatures ?? [])];
    if (this.features.has('timestamp-query') && !features.includes('timestamp-query'))
      d = { ...d, requiredFeatures: [...features, 'timestamp-query'] };
    return (device = await request.call(this, d));
  };
  for (const kind of ['beginRenderPass', 'beginComputePass']) {
    const begin = GPUCommandEncoder.prototype[kind];
    GPUCommandEncoder.prototype[kind] = function (d = {}) {
      if (ts.on && !d.timestampWrites && ts.n < ts.cap) {
        const c = d.colorAttachments?.[0];
        ts.desc[ts.n] =
          `${kind.slice(5, -4)} ${d.label ?? ''}${d.depthStencilAttachment ? ' +depth' : ''}${c?.resolveTarget ? ' +resolve' : ''}${c ? ` ${c.loadOp}/${c.storeOp}` : ''}`;
        const at = ts.n++ * 2;
        d = { ...d, timestampWrites: { querySet: ts.set, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1 } };
      }
      return begin.call(this, d);
    };
  }
  const createBuffer = GPUDevice.prototype.createBuffer,
    createTexture = GPUDevice.prototype.createTexture,
    destroyBuffer = GPUBuffer.prototype.destroy,
    destroyTexture = GPUTexture.prototype.destroy;
  GPUDevice.prototype.createBuffer = function (d) {
    const b = createBuffer.call(this, d);
    track(b, d.size);
    return b;
  };
  GPUDevice.prototype.createTexture = function (d) {
    const t = createTexture.call(this, d),
      [w, h = 1, layers = 1] = Array.isArray(d.size)
        ? d.size
        : [d.size.width, d.size.height, d.size.depthOrArrayLayers];
    let bytes = 0;
    for (let m = 0; m < (d.mipLevelCount ?? 1); m++)
      bytes += Math.max(1, w >> m) * Math.max(1, h >> m) * (d.dimension === '3d' ? Math.max(1, layers >> m) : layers);
    track(t, Math.round(bytes * texel(d.format) * (d.sampleCount ?? 1)));
    return t;
  };
  const release = (object) => {
    memory.bytes -= memory.live.get(object) ?? 0;
    memory.live.delete(object);
  };
  GPUBuffer.prototype.destroy = function () {
    release(this);
    return destroyBuffer.call(this);
  };
  GPUTexture.prototype.destroy = function () {
    release(this);
    return destroyTexture.call(this);
  };
  // ?dump: record every shader module and render pipeline (state that decides GPU cost) for side-by-side reading.
  if (options.dump) {
    const shaders = new Map(),
      pipelines = [];
    globalThis.dumped = { shaders: [], pipelines };
    const module = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (d) {
      const m = module.call(this, d);
      shaders.set(m, globalThis.dumped.shaders.push(d.code) - 1);
      return m;
    };
    for (const kind of ['createRenderPipeline', 'createRenderPipelineAsync']) {
      const create = GPUDevice.prototype[kind];
      GPUDevice.prototype[kind] = function (d) {
        pipelines.push({
          vertexShader: shaders.get(d.vertex.module),
          fragmentShader: d.fragment && shaders.get(d.fragment.module),
          cullMode: d.primitive?.cullMode ?? 'none',
          topology: d.primitive?.topology ?? 'triangle-list',
          depth:
            d.depthStencil &&
            `${d.depthStencil.format} ${d.depthStencil.depthCompare} write=${d.depthStencil.depthWriteEnabled}`,
          samples: d.multisample?.count ?? 1,
          targets: d.fragment?.targets.map((t) => `${t.format}${t.blend ? ' blend' : ''}`),
        });
        return create.call(this, d);
      };
    }
  }
}

async function webgpuTimes(app, frames, next) {
  if (!device?.features.has('timestamp-query')) return null;
  ts.set ??= device.createQuerySet({ type: 'timestamp', count: ts.cap * 2 });
  const resolve = device.createBuffer({
      size: ts.cap * 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    }),
    read = device.createBuffer({ size: ts.cap * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  // passMs[k]: durations of the k-th pass of each frame, described in passes[k]; span: first pass begin to last pass
  // end, so it also holds the gaps between passes (queue writes, copies, idle).
  const sums = [],
    passes = new Set(),
    perPass = [],
    spans = [];
  let done = 0,
    zero = 0;
  while (done < frames) {
    const batch = [];
    ts.n = 0;
    ts.on = true;
    do {
      // One browser frame per rendered frame, as in the throughput loop: some engines (three.js WebGPU node chains)
      // advance their per-frame state only once per animation frame and would otherwise redraw a cached result.
      await raf();
      const a = ts.n;
      app.render(next());
      batch.push([a, ts.n]);
      done++;
    } while (done < frames && ts.n + (batch.at(-1)[1] - batch.at(-1)[0]) <= ts.cap);
    ts.on = false;
    const n = ts.n;
    if (!n) break; // the engine began no passes (or not through this device)
    const e = device.createCommandEncoder();
    e.resolveQuerySet(ts.set, 0, n * 2, resolve, 0);
    e.copyBufferToBuffer(resolve, 0, read, 0, n * 16);
    device.queue.submit([e.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const t = new BigUint64Array(read.getMappedRange().slice(0, n * 16));
    read.unmap();
    for (const [a, b] of batch) {
      let sum = 0n;
      for (let i = a; i < b; i++) if (t[2 * i + 1] > t[2 * i]) sum += t[2 * i + 1] - t[2 * i];
      passes.add(b - a);
      if (sum === 0n) {
        zero++; // Dawn sometimes zeroes a batch; counted, not measured.
        continue;
      }
      sums.push(Number(sum) / 1e6);
      for (let i = a; i < b; i++)
        (perPass[i - a] ??= []).push(t[2 * i + 1] > t[2 * i] ? Number(t[2 * i + 1] - t[2 * i]) / 1e6 : 0);
      if (t[2 * b - 1] > t[2 * a]) spans.push(Number(t[2 * b - 1] - t[2 * a]) / 1e6);
    }
  }
  resolve.destroy();
  read.destroy();
  return {
    method: 'timestamp-query, sum of pass durations',
    gpuMs: stat(sums),
    spanMs: stat(spans),
    passMs: perPass.map(stat),
    passes: ts.desc.slice(0, perPass.length),
    zeroFrames: zero,
    passesPerFrame: [...passes],
  };
}

// WebGL2: EXT_disjoint_timer_query_webgl2 TIME_ELAPSED around the whole render call, when the browser exposes it.
async function webglTimes(app, frames, next) {
  const gl = app.gl,
    ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return { method: 'EXT_disjoint_timer_query_webgl2 unavailable', gpuMs: null };
  const queries = [];
  for (let i = 0; i < frames; i++) {
    const query = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    app.render(next());
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    queries.push(query);
    await raf();
  }
  const times = [];
  let disjoint = false;
  for (const query of queries) {
    for (let w = 0; w < 600 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); w++) await raf();
    disjoint ||= gl.getParameter(ext.GPU_DISJOINT_EXT);
    if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE))
      times.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
    gl.deleteQuery(query);
  }
  return { method: 'EXT_disjoint_timer_query_webgl2 TIME_ELAPSED', gpuMs: disjoint ? null : stat(times), disjoint };
}

/**
 * A task scene (kind: 'task' in the catalog): no frames, one job timed per call. `app.task(i)` does the job once (may
 * return a promise); the first call is timed alone (coldMs), then taskWarmup calls are thrown away and up to
 * taskIterations calls (within maxPhaseMs) are measured. `app.output?.()` describes what the job produced (counts,
 * bounds), so engines can be checked for doing the same job. `app.gpuTimes?.(calls)` may resolve the GPU milliseconds
 * of that many further calls (timestamp queries), recorded as task.gpuMs.
 */
async function runTask(app, result) {
  const call = async (i) => {
    const a = performance.now();
    await app.task(i);
    return performance.now() - a;
  };
  result.task = { coldMs: +(await call(0)).toFixed(3) };
  for (let i = 1; i <= options.taskWarmup; i++) await call(i);
  const times = [],
    start = performance.now();
  for (let i = 0; i < options.taskIterations && performance.now() - start < options.maxPhaseMs; i++)
    times.push(await call(options.taskWarmup + 1 + i));
  result.task.ms = stat(times);
  // GPU time per call, from the engine's own timestamp queries when it has them (compute tasks): measured after the
  // wall-clock calls, so profiling never slows those down.
  if (app.gpuTimes) result.task.gpuMs = stat(await app.gpuTimes(Math.max(5, times.length)));
  result.task.output = (await app.output?.()) ?? null;
}

/** Runs one measurement of `create` (an engine's scene builder) and leaves the result on window.result. */
export async function run(create) {
  const result = {
    engine: options.engine,
    scene: options.scene,
    params,
    options,
    scriptStartMs: +scriptMs.toFixed(1),
    errors: [],
  };
  addEventListener('error', (e) => result.errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => result.errors.push(String(e.reason?.message ?? e.reason)));
  try {
    const canvas = document.querySelector('canvas'),
      marks = {};
    let frame = 0;
    const next = () => frame++ / 60;
    const data = await SCENES[options.scene].data(params, { assets: options.assets });
    const app = await create(canvas, { scene: options.scene, params, data }, marks);
    if (SCENES[options.scene].kind === 'task') {
      Object.assign(result, { createMs: marks.createMs, buildMs: marks.buildMs });
      await runTask(app, result);
      result.loadMs = +performance.now().toFixed(1);
      if (globalThis.gc) gc();
      result.jsHeapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 2 ** 20).toFixed(2) : null;
      result.info = app.info?.() ?? {};
      result.resources = resources();
      result.jsBytes = result.resources.filter((r) => r.name.endsWith('.js')).reduce((n, r) => n + r.bytes, 0);
      window.result = result;
      if (parent !== window) parent.postMessage({ type: 'margo-bench-result', result }, location.origin);
      return;
    }
    const s = performance.now();
    app.render(next());
    await app.idle();
    Object.assign(result, {
      createMs: marks.createMs,
      buildMs: marks.buildMs,
      firstFrameMs: +(performance.now() - s).toFixed(1),
      loadMs: +performance.now().toFixed(1),
      canvas: [canvas.width, canvas.height],
      samples: app.samples,
    });
    // Warm-up, then throughput: requestAnimationFrame-driven like an app (the CLI turns vsync and the frame cap off).
    const loop = async (frames, record) => {
      const cpu = [],
        interval = [];
      let last = 0;
      const start = performance.now();
      for (let i = 0; i < frames && performance.now() - start < options.maxPhaseMs; i++) {
        const now = await raf(),
          a = performance.now();
        app.render(next());
        const b = performance.now();
        if (record) {
          cpu.push(b - a);
          if (last) interval.push(now - last);
        }
        last = now;
      }
      return { cpu, interval };
    };
    // fps counts frames until the GPU has finished them: with vsync off, requestAnimationFrame is not paced by the GPU,
    // so an engine with cheap submits queues frames and its rAF rate (rafFps) overstates what the GPU renders.
    await loop(options.warmup, false);
    await app.idle();
    const t0 = performance.now(),
      { cpu, interval } = await loop(options.frames, true),
      iv = stat(interval);
    await app.idle();
    result.throughput = {
      frames: cpu.length,
      cpuMs: stat(cpu),
      intervalMs: iv,
      fps: +((cpu.length * 1000) / (performance.now() - t0)).toFixed(1),
      rafFps: iv ? +(1000 / iv.median).toFixed(1) : null,
    };
    result.gpu = app.gl
      ? await webglTimes(app, options.gpuFrames, next)
      : await webgpuTimes(app, options.gpuFrames, next);
    // Serial frames: submit, then wait until the GPU is idle. Frame latency with no pipelining.
    const serial = [],
      start = performance.now();
    for (let i = 0; i < options.serialFrames && performance.now() - start < options.maxPhaseMs; i++) {
      await raf();
      const a = performance.now();
      app.render(next());
      await app.idle();
      serial.push(performance.now() - a);
    }
    result.serialFrameMs = stat(serial);
    if (globalThis.gc) {
      gc();
      gc();
    }
    result.jsHeapMB = performance.memory ? +(performance.memory.usedJSHeapSize / 2 ** 20).toFixed(2) : null;
    result.gpuMemory = device
      ? { liveMB: +(memory.bytes / 2 ** 20).toFixed(2), peakMB: +(memory.peak / 2 ** 20).toFixed(2) }
      : null;
    result.gcExposed = !!globalThis.gc;
    result.info = app.info?.() ?? {};
    if (globalThis.dumped) result.dumped = globalThis.dumped;
    result.resources = resources();
    result.jsBytes = result.resources.filter((r) => r.name.endsWith('.js')).reduce((s, r) => s + r.bytes, 0);
    // Final still frame at t = 0 for a screenshot, one frame step after the frame before it: motion vectors come from
    // the last two frames, so a jump from wherever the timed loop stopped would blur by that engine's own jump.
    app.render(1 / 60);
    app.render(0);
    await app.idle();
    await raf();
  } catch (error) {
    result.error = String(error?.stack ?? error);
  }
  window.result = result;
  if (parent !== window) parent.postMessage({ type: 'margo-bench-result', result }, location.origin);
}
