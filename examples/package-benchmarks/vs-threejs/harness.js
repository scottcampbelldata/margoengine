// In-page measurement, identical for every engine. An engine module calls run(create): create(canvas, params, marks)
// builds the scene and returns {render(t), idle(): Promise, info(): {drawCalls, triangles}, gl?, device?}.
// render(t) does that frame's scene update and submits it; t is scene time in seconds (fixed 1/60 s per frame, so every
// engine shows the same camera path and part motion per frame regardless of its frame rate).
const q = new URLSearchParams(location.search);
export const params = {
  engine: q.get('engine'),
  scene: q.get('scene'),
  n: +(q.get('n') ?? 0),
  mode: q.get('mode') ?? 'mesh',
  move: +(q.get('move') ?? 0),
  warmup: +(q.get('warmup') ?? 60),
  frames: +(q.get('frames') ?? 300),
  gpuFrames: +(q.get('gpuFrames') ?? 60),
  serialFrames: +(q.get('serialFrames') ?? 30),
  maxPhaseMs: +(q.get('maxPhaseMs') ?? 20_000),
  diag: (q.get('diag') ?? '').split('+').filter(Boolean),
  dump: q.has('dump'),
};
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

// WebGPU: every device gets 'timestamp-query' when the adapter has it, and while `ts.on` every render/compute pass
// any engine begins gets begin/end timestamp writes. GPU time of a frame = sum of its pass durations. Same code path
// for Margo and three.js WebGPURenderer, so neither engine's own profiler is trusted.
let device;
const ts = { on: false, n: 0, cap: 2048, desc: [] };
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
  // ?dump: record every shader module and render pipeline (state that decides GPU cost) for side-by-side reading.
  if (params.dump) {
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
          vertexBuffers: d.vertex.buffers?.map(
            (b) => b && `${b.arrayStride}B ${b.stepMode ?? 'vertex'} x${b.attributes.length}`,
          ),
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
  // passMs[k]: durations of the k-th pass of each frame, described in passes[k]; span: first pass
  // begin to last pass end, so it also holds the gaps between passes (queue writes, copies, idle).
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
      const a = ts.n;
      app.render(next());
      batch.push([a, ts.n]);
      done++;
    } while (done < frames && ts.n + (batch.at(-1)[1] - batch.at(-1)[0]) <= ts.cap);
    ts.on = false;
    const n = ts.n,
      e = device.createCommandEncoder();
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
        zero++;
        continue;
      } // Dawn sometimes zeroes a batch; counted, not measured.
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

export async function run(create) {
  const result = { params, scriptStartMs: +scriptMs.toFixed(1), errors: [] };
  addEventListener('error', (e) => result.errors.push(String(e.message)));
  try {
    const canvas = document.querySelector('canvas'),
      marks = {};
    let frame = 0;
    const next = () => frame++ / 60;
    const app = await create(canvas, params, marks);
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
    // Warm-up, then throughput: requestAnimationFrame-driven like an app, vsync and the frame-rate cap off (run.mjs).
    const loop = async (frames, record) => {
      const cpu = [],
        interval = [];
      let last = 0;
      const start = performance.now();
      for (let i = 0; i < frames && performance.now() - start < params.maxPhaseMs; i++) {
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
    // fps counts frames until the GPU has finished them: with vsync and the cap off, requestAnimationFrame is not paced
    // by the GPU, so an engine with cheap submits queues hundreds of frames and its rAF rate (rafFps) overstates what
    // the GPU renders (three.js InstancedMesh at 50k boxes: ~970 rAF/s with 7.7 ms of GPU work per frame).
    await loop(params.warmup, false);
    await app.idle();
    const t0 = performance.now(),
      { cpu, interval } = await loop(params.frames, true),
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
      ? await webglTimes(app, params.gpuFrames, next)
      : await webgpuTimes(app, params.gpuFrames, next);
    // Serial frames: submit, then wait until the GPU is idle. Frame latency with no pipelining; the same wait for both
    // APIs (WebGPU onSubmittedWorkDone, WebGL a 1-pixel readPixels, which blocks until all prior work is done).
    const serial = [],
      start = performance.now();
    for (let i = 0; i < params.serialFrames && performance.now() - start < params.maxPhaseMs; i++) {
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
    result.gcExposed = !!globalThis.gc;
    result.info = app.info();
    if (globalThis.dumped) result.dumped = globalThis.dumped;
    result.resources = performance
      .getEntriesByType('resource')
      .map((r) => ({ name: new URL(r.name).pathname, bytes: r.encodedBodySize, ms: +r.duration.toFixed(1) }));
    // Final still frame at t = 0 for the side-by-side screenshot run.mjs takes.
    app.render(0);
    await app.idle();
    await raf();
  } catch (error) {
    result.error = String(error?.stack ?? error);
  }
  window.result = result;
}
