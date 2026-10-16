// Diagnostic-only, fixed-work PBR upload-cache comparison. No runtime sources are changed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, mkdir, cp } from 'node:fs/promises';
import { resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '@playwright/test';

const arg = (name, fallback) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const root = resolve(arg('root', fileURLToPath(new URL('..', import.meta.url))));
const label = arg('label', 'pbr-locked-drag'),
  frames = Number(arg('frames', 1800)),
  warmup = Number(arg('warmup-frames', 1800));
const reflectionStride = Number(arg('reflection-stride', 4)),
  pointerStride = 2,
  port = Number(arg('port', 5263));
const order = arg('order', 'direct,cache,cache,direct').split(',');
assert.match(label, /^[a-z0-9-]+$/);
for (const n of [frames, warmup, reflectionStride, port]) assert.ok(Number.isSafeInteger(n) && n > 0);
assert.ok(frames <= 3600 && warmup <= 3600 && frames % reflectionStride === 0 && warmup % reflectionStride === 0);
assert.ok(order.length >= 2 && order.length <= 8 && order.every((v) => v === 'direct' || v === 'cache'));
const folder = resolve(root, 'test-results', label),
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(relative(root, folder), `test-results${sep}${label}`);
const reuseLabel = arg('reuse-snapshot', null);
if (reuseLabel) assert.match(reuseLabel, /^[a-z0-9-]+$/);
const reuseFolder = reuseLabel ? resolve(root, 'test-results', reuseLabel) : null;
assert.notEqual(reuseFolder, folder, 'Use a new report label when reusing a snapshot');
const reused = reuseFolder ? JSON.parse(await readFile(resolve(reuseFolder, 'report.json'), 'utf8')) : null;
if (reused)
  for (const [key, value] of Object.entries({ frames, warmup, reflectionStride, pointerStride }))
    assert.equal(reused[key], value, 'Frozen harness dimensions differ');
await mkdir(folder, { recursive: true });
const normalize = (path) => path.replaceAll('\\', '/'),
  sources = new Map(),
  used = new Map();
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.(?:[cm]?js|ts|wgsl|css|html|json)$/.test(path) && !path.endsWith('.d.ts'))
      sources.set(normalize(path), (await readFile(path, 'utf8')).replaceAll('\r\n', '\n'));
  }
}
if (!reused) {
  await collect(resolve(root, 'examples/skinning-ik'));
  for (const name of await readdir(resolve(root, 'packages'))) {
    if (name === 'shared') await collect(resolve(root, 'packages', name));
    else for (const directory of ['src', 'dist']) await collect(resolve(root, 'packages', name, directory));
  }
}
const mainPath = normalize(resolve(root, 'examples/skinning-ik/main.ts')),
  gltfPath = normalize(resolve(root, 'packages/gltf-pro/src/index.ts'));
const directSource = reused ? await readFile(resolve(reuseFolder, 'direct-source.ts'), 'utf8') : sources.get(gltfPath),
  cacheSource = await readFile(
    reused ? resolve(reuseFolder, 'cache-source.ts') : resolve(root, 'test-results/pbr-uniform-cache-rejected.ts'),
    'utf8',
  );
assert.ok(
  directSource &&
    !directSource.includes('function uploadDrawUniform(') &&
    cacheSource.includes('function uploadDrawUniform('),
);
await writeFile(resolve(folder, 'direct-source.ts'), directSource);
await writeFile(resolve(folder, 'cache-source.ts'), cacheSource);

const observer = `
import {PBRModel as LockedPBR} from '@margoengine/gltf-pro';
import {Animation as LockedAnimation} from '@margoengine/animation';
const lockedCounters=globalThis.__lockedCounters={pbrDraws:0,beauty:0,gbuffer:0,ambient:0,transparent:0,transmission:0,capture:0,primitiveDraws:0,deforms:0,unsafe:0};
const lockedDraw=LockedPBR.prototype.draw,lockedDeform=LockedAnimation.prototype.deform;
LockedPBR.prototype.draw=function(context,mode,color,depth){
  lockedCounters.pbrDraws++;lockedCounters[mode]++;
  const before=this.root.engine.stats.drawCalls,result=Reflect.apply(lockedDraw,this,arguments);
  lockedCounters.primitiveDraws+=this.root.engine.stats.drawCalls-before;return result;
};
LockedAnimation.prototype.deform=function(context){lockedCounters.deforms++;return Reflect.apply(lockedDeform,this,arguments);};
`;
const diagnostic = `
  const lockedOptions={delta:1/60},lockedTimes=new Float64Array(${frames}),lockedBakeTimes=new Float64Array(${frames / reflectionStride});
  let lockedMeasured=false,lockedCursor=0,lockedBakeCursor=0;
  const lockedSnapshot=()=>({frames:frameCount,animationFrames,poseUpdates,reflections:reflectionCount,
    attempts:probePoseReuse.counters.attempts,reused:probePoseReuse.counters.reused,fallback:probePoseReuse.counters.fallback,...lockedCounters});
  const lockedPose=()=>{const values=[];for(const n of [...model.nodes,...orb.nodes])for(const v of n.matrix)values.push(v);return values;};
  globalThis.__lockedDrag={
    nativeWriter:runtime.gpu.queue.writeBuffer,
    snapshot:lockedSnapshot,
    state:()=>({orb:[...worldPosition(orb.root)],camera:[...stage.engine.camera.position],target:[...stage.engine.camera.target],dragging:!!drag.dragging,pose:lockedPose(),reflectionBusy,error:error.textContent}),
    startMeasurement:()=>{lockedMeasured=true;lockedCursor=0;lockedBakeCursor=0;},
    finishMeasurement:()=>{lockedMeasured=false;return {callbacks:[...lockedTimes.subarray(0,lockedCursor)],bakes:[...lockedBakeTimes.subarray(0,lockedBakeCursor)]};},
    async step(reflect){
      await new Promise((done,failed)=>requestAnimationFrame(()=>{
        try{const start=performance.now();for(const callback of lockedCallbacks)callback(runtime,1/60);runtime.render(lockedOptions);
          if(lockedMeasured)lockedTimes[lockedCursor++]=performance.now()-start;done();}catch(error){failed(error);}
      }));
      if(reflect){if(reflectionBusy)throw new Error('Unexpected concurrent bake');reflectionFinalRequested=false;reflectionBusy=true;reflectionLast=performance.now();
        const start=performance.now();await captureReflection();if(lockedMeasured)lockedBakeTimes[lockedBakeCursor++]=performance.now()-start;}
      if(error.textContent)throw new Error(error.textContent);
    },
    async verifyUniform(){
      const r=model.resources.find(r=>r.values?.length),device=runtime.gpu,queue=device.queue;
      if(queue.writeBuffer!==this.nativeWriter||GPUQueue.prototype.writeBuffer!==this.nativeWriter)throw new Error('Native queue writer changed');
      if(Object.getPrototypeOf(queue)!==GPUQueue.prototype||Object.hasOwn(queue,'writeBuffer')||!Function.prototype.toString.call(this.nativeWriter).includes('[native code]'))throw new Error('Queue writer is not the native same-realm method');
      const expected=new Uint32Array(r.values.buffer,r.values.byteOffset,r.values.length).slice(),words=expected.length;
      const storage=device.createBuffer({size:expected.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:expected.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      device.pushErrorScope('validation');let mapped=false;
      try{
        const shader=device.createShaderModule({code:'struct Source{words:array<vec4u,'+(words/4)+'>};@group(0) @binding(0)var<uniform> source:Source;@group(0) @binding(1)var<storage,read_write> destination:array<u32>;@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){let i=id.x;if(i<arrayLength(&destination)){destination[i]=source.words[i/4u][i%4u];}}'});
        const pipeline=device.createComputePipeline({layout:'auto',compute:{module:shader,entryPoint:'main'}}),group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.uniform}},{binding:1,resource:{buffer:storage}}]});
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(words/64));pass.end();encoder.copyBufferToBuffer(storage,0,read,0,expected.byteLength);queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);mapped=true;const actual=new Uint32Array(read.getMappedRange());for(let i=0;i<words;i++)if(actual[i]!==expected[i])throw new Error('GPU uniform mismatch '+i);
        const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',actual))].map(v=>v.toString(16).padStart(2,'0')).join('');read.unmap();mapped=false;
        const error=await device.popErrorScope();if(error)throw new Error(error.message);return {words,hash,exact:true,nativeWriter:true};
      }finally{if(mapped)read.unmap();storage.destroy();read.destroy();}
    },
    drain:()=>runtime.gpu.queue.onSubmittedWorkDone()
  };
`;
let main = reused ? await readFile(resolve(reuseFolder, 'diagnostic-main.ts'), 'utf8') : sources.get(mainPath);
assert.ok(main);
function once(source, from, to) {
  assert.equal(source.split(from).length, 2, `Unique patch anchor ${from.slice(0, 80)}`);
  return source.replace(from, to);
}
if (!reused) {
  main = observer + '\n' + main;
  main = once(
    main,
    '  const runtime = engineRuntime(stage.engine);',
    `  const runtime = engineRuntime(stage.engine);
  const lockedCallbacks=new Set(),lockedOnFrame=runtime.onFrame;
  runtime.onFrame=function(callback){lockedCallbacks.add(callback);const off=Reflect.apply(lockedOnFrame,this,[callback]);return()=>{lockedCallbacks.delete(callback);off();};};`,
  );
  main = once(
    main,
    '  const queueFinalReflection = () => {',
    '  const queueFinalReflection = () => {\n    if(globalThis.__lockedDrag)return;',
  );
  main = once(
    main,
    '  const refresh = (): Promise<void> | undefined => {',
    '  const refresh = (): Promise<void> | undefined => {\n    if(globalThis.__lockedDrag)return;',
  );
  main = once(main, '  stage.engine.start();', '  stage.engine.stop();\n' + diagnostic);
  main = once(main, '  const timer = setInterval(() => {\n    void refresh();\n  }, 25);', '  const timer = 0;');
  main = once(
    main,
    '      if (!reusePose) probePoseReuse.accept(contact.safe && headAim.clearanceResolved);',
    '      if(!contact.safe||gripError>1e-5)lockedCounters.unsafe++;\n      if (!reusePose) probePoseReuse.accept(contact.safe && headAim.clearanceResolved);',
  );
}
sources.set(mainPath, main);
await writeFile(resolve(folder, 'diagnostic-main.ts'), main);

const report = {
  startedAt: new Date().toISOString(),
  root,
  frames,
  warmup,
  reflectionStride,
  pointerStride,
  order,
  method:
    'Frozen static bundles, fresh document per phase in one hardware browser, counterbalanced order. Trusted screen-space pointer command every two normal renders; exact fixed delta1/60; callbacks preserved; one awaited real six-face reflection bake every N normal renders (two extra zero-delta renders). Automatic engine RAF/reflection cadence/final refresh disabled only in diagnostic snapshot. Native GPUQueue.writeBuffer never wrapped. No forced GC/JIT flags. Heap sampling includes collected objects; sampler-handshake window and controlled work wall time are distinct. Callback time excludes reflection encoding/readback, reported separately. Allocation bytes/frame amortize the same fixed main/reflection workload and are not an isolated reflection cost.',
  directSHA256: sha(directSource),
  cacheSHA256: sha(cacheSource),
  sourceManifest: reused?.sourceManifest ?? {},
  bundles: reused?.bundles ?? {},
  reusedSnapshot: reuseFolder,
  phases: [],
  errors: [],
};
for (const variant of ['direct', 'cache']) {
  if (reused) {
    await cp(resolve(reuseFolder, variant), resolve(folder, variant), { recursive: true });
    continue;
  }
  const virtual = normalize(resolve(folder, `${variant}-entry.ts`)),
    modules = [];
  const plugin = {
    name: 'frozen-pbr-drag',
    enforce: 'pre',
    resolveId(source, importer) {
      if (/^@margoengine\/machinery(?:\/|$)/.test(source)) return '\0locked-no-cad';
      if (source === '@margoengine/gltf-pro') return virtual;
      if (importer === virtual && source.startsWith('.')) {
        const path = normalize(resolve(root, 'packages/gltf-pro/src', source));
        return sources.has(path)
          ? path
          : sources.has(path.replace(/\.js$/, '.ts'))
            ? path.replace(/\.js$/, '.ts')
            : null;
      }
    },
    load(id) {
      if (id === '\0locked-no-cad') return 'throw new Error("CAD is outside this diagnostic scene");';
      if (id === virtual) return variant === 'direct' ? directSource : cacheSource;
      const path = normalize(id.split('?')[0]);
      if (sources.has(path)) {
        used.set(path, sha(sources.get(path)));
        return sources.get(path);
      }
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) if (item.type === 'chunk') modules.push(...Object.keys(item.modules));
    },
  };
  const output = await build({
    configFile: false,
    root: resolve(root, 'examples'),
    base: './',
    publicDir: false,
    logLevel: 'error',
    plugins: [plugin],
    build: {
      outDir: resolve(folder, variant),
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: resolve(root, 'examples/skinning-ik.html'),
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });
  report.bundles[variant] = { modules: modules.map((p) => normalize(relative(root, p))), files: [] };
  assert.ok(!modules.some((p) => /node_modules[\\/]three[\\/]/.test(p)));
  for (const item of output.output ?? output[0].output)
    if (item.type === 'chunk')
      report.bundles[variant].files.push({ name: item.fileName, bytes: item.code.length, sha256: sha(item.code) });
}
for (const [path, hash] of used) report.sourceManifest[normalize(relative(root, path))] = hash;
await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    status: 'snapshot-built',
    folder,
    sourceFiles: used.size,
    bundles: Object.fromEntries(
      Object.entries(report.bundles).map(([key, value]) => [
        key,
        { modules: value.modules.length, files: value.files.length, main: value.files[0] },
      ]),
    ),
  }),
);
if (process.argv.includes('--prepare-only')) process.exit(0);

const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const server = createServer(async (req, res) => {
  try {
    const path = resolve(folder, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!path.startsWith(folder + sep)) throw new Error('Invalid path');
    const data = await readFile(path);
    res.writeHead(200, {
      'content-type': mime[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((done, fail) => {
  server.once('error', fail);
  server.listen(port, '127.0.0.1', done);
});
let browser;
const summary = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return {
    count: v.length,
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    p50: v[Math.floor(v.length * 0.5)],
    p95: v[Math.floor(v.length * 0.95)],
    p99: v[Math.floor(v.length * 0.99)],
    maximum: v.at(-1),
  };
};
function allocations(profile) {
  const sources = new Map();
  let bytes = 0;
  function visit(node, origin = '(browser/harness)') {
    if (node.callFrame.url) origin = node.callFrame.url;
    bytes += node.selfSize;
    sources.set(origin, (sources.get(origin) ?? 0) + node.selfSize);
    for (const child of node.children ?? []) visit(child, origin);
  }
  visit(profile.head);
  return {
    estimatedBytes: bytes,
    sources: [...sources].map(([url, bytes]) => ({ url, bytes })).sort((a, b) => b.bytes - a.bytes),
  };
}
function gcSummary(events) {
  const slices = events.filter((e) => e.ph === 'X' && /^(MinorGC|MajorGC)$/.test(e.name)),
    counts = { MinorGC: 0, MajorGC: 0 };
  for (const e of slices) counts[e.name]++;
  const merged = [];
  for (const e of slices.sort((a, b) => a.pid - b.pid || a.tid - b.tid || a.ts - b.ts || b.dur - a.dur)) {
    const prev = merged.at(-1);
    if (prev && prev.pid === e.pid && prev.tid === e.tid && e.ts <= prev.end)
      prev.end = Math.max(prev.end, e.ts + e.dur);
    else merged.push({ pid: e.pid, tid: e.tid, start: e.ts, end: e.ts + e.dur });
  }
  return {
    counts,
    pauseMs: merged.reduce((n, e) => n + (e.end - e.start) / 1000, 0),
    maximumPauseMs: Math.max(0, ...merged.map((e) => (e.end - e.start) / 1000)),
  };
}
function project(point, eye, target, bounds) {
  const f = target.map((v, i) => v - eye[i]),
    length = Math.hypot(...f);
  for (let i = 0; i < 3; i++) f[i] /= length;
  const right = [-f[2], 0, f[0]],
    rlen = Math.hypot(...right);
  for (let i = 0; i < 3; i++) right[i] /= rlen;
  const up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]],
    v = point.map((p, i) => p - eye[i]);
  const depth = v.reduce((n, x, i) => n + x * f[i], 0),
    x = v.reduce((n, x, i) => n + x * right[i], 0),
    y = v.reduce((n, x, i) => n + x * up[i], 0),
    tan = Math.tan((35 * Math.PI) / 360);
  return {
    x: bounds.x + bounds.width * (0.5 + x / ((2 * depth * tan * bounds.width) / bounds.height)),
    y: bounds.y + bounds.height * (0.5 - y / (2 * depth * tan)),
  };
}
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: [] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  let canonical, expectedWork, expectedPose;
  for (let phaseIndex = 0; phaseIndex < order.length; phaseIndex++) {
    const variant = order[phaseIndex],
      name = `${phaseIndex + 1}-${variant}`,
      page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', (e) => report.errors.push({ phase: name, message: e.stack ?? e.message }));
    console.log(JSON.stringify({ status: 'loading', name }));
    await page.goto(`http://127.0.0.1:${port}/${variant}/skinning-ik.html`);
    await page.waitForFunction(() => globalThis.__lockedDrag || document.querySelector('#error')?.textContent);
    assert.equal(await page.locator('#error').textContent(), '');
    if (!report.hardware)
      report.hardware = await page.evaluate(async () => {
        const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        return {
          info: {
            ...a.info,
            vendor: a.info.vendor,
            architecture: a.info.architecture,
            fallback: a.info.isFallbackAdapter ?? a.isFallbackAdapter ?? false,
          },
          userAgent: navigator.userAgent,
        };
      });
    assert.equal(report.hardware.info.fallback, false);
    await page.evaluate(() => {
      document.querySelector('#reset').click();
      for (const [id, value] of Object.entries({
        idle: false,
        'moving-light': false,
        look: true,
        reflections: true,
        'ik-enabled': true,
        'auto-ik': true,
        autopilot: false,
        follow: false,
        'show-rig': false,
      })) {
        const e = document.getElementById(id);
        e.checked = value;
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelector('[data-pose="back"]').click();
      document.querySelector('#view-room').click();
    });
    console.log(JSON.stringify({ status: 'settling', name }));
    for (let i = 0; i < 90; i++) await page.evaluate(() => __lockedDrag.step(false));
    const initial = await page.evaluate(() => __lockedDrag.state()),
      bounds = await page.locator('#viewport canvas').boundingBox();
    const path = {
      start: project(initial.orb, initial.camera, initial.target, bounds),
      end: project([0.08, 0.95, 0.025], initial.camera, initial.target, bounds),
      bounds,
    };
    if (!canonical) canonical = path;
    else assert.deepEqual(path, canonical, 'Starting projection/viewport changed');
    console.log(JSON.stringify({ status: 'starting-drag', name, path }));
    await page.mouse.move(path.start.x, path.start.y);
    await page.mouse.down();
    assert.equal(await page.evaluate(() => __lockedDrag.state().dragging), true);
    const commands = [];
    const run = async (count, offset) => {
      for (let i = 0; i < count; i++) {
        if (i % pointerStride === 0) {
          const frame = offset + i,
            fraction = (1 - Math.cos((2 * Math.PI * frame) / 144)) / 2,
            x = canonical.start.x + (canonical.end.x - canonical.start.x) * fraction,
            y = canonical.start.y + (canonical.end.y - canonical.start.y) * fraction;
          await page.mouse.move(x, y);
          if (offset === warmup) commands.push([frame, x, y]);
        }
        await page.evaluate((reflect) => __lockedDrag.step(reflect), (i + 1) % reflectionStride === 0);
      }
    };
    console.log(JSON.stringify({ status: 'warmup', name, frames: warmup, bakes: warmup / reflectionStride }));
    await run(warmup, 0);
    await page.evaluate(() => __lockedDrag.drain());
    const before = await page.evaluate(() => __lockedDrag.snapshot()),
      cdp = await context.newCDPSession(page),
      events = [];
    await cdp.send('HeapProfiler.enable');
    cdp.on('Tracing.dataCollected', ({ value }) => events.push(...value));
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,v8,disabled-by-default-v8.gc',
      transferMode: 'ReportEvents',
    });
    await page.evaluate(() => __lockedDrag.startMeasurement());
    const sampleStarted = performance.now();
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval: 4096,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    });
    const workStarted = performance.now();
    await run(frames, warmup);
    await page.evaluate(() => __lockedDrag.drain());
    const workMs = performance.now() - workStarted;
    const { profile } = await cdp.send('HeapProfiler.stopSampling'),
      samplingWindowMs = performance.now() - sampleStarted;
    const complete = new Promise((done) => cdp.once('Tracing.tracingComplete', done));
    await cdp.send('Tracing.end');
    await complete;
    const measured = await page.evaluate(() => __lockedDrag.finishMeasurement()),
      after = await page.evaluate(() => __lockedDrag.snapshot()),
      state = await page.evaluate(() => __lockedDrag.state());
    const work = Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
    assert.equal(work.animationFrames, frames);
    assert.equal(work.reflections, frames / reflectionStride);
    assert.equal(work.frames, frames + (2 * frames) / reflectionStride);
    assert.equal(work.unsafe, 0);
    assert.equal(state.reflectionBusy, false);
    assert.equal(state.error, '');
    if (!expectedWork) expectedWork = work;
    else assert.deepEqual(work, expectedWork, 'Actual render/bake/draw/deform work differs');
    const poseSHA256 = sha(new Float64Array(state.pose));
    if (!expectedPose) expectedPose = poseSHA256;
    else assert.equal(poseSHA256, expectedPose, 'Ending transforms differ');
    const uniform = await page.evaluate(() => __lockedDrag.verifyUniform()),
      allocation = allocations(profile),
      gc = gcSummary(events);
    allocation.MBps = allocation.estimatedBytes / samplingWindowMs / 1000;
    allocation.bytesPerNormalFrame = allocation.estimatedBytes / frames;
    const result = {
      name,
      variant,
      workMs,
      samplingWindowMs,
      work,
      allocation,
      gc,
      callbackMs: summary(measured.callbacks),
      bakeMs: summary(measured.bakes),
      poseSHA256,
      uniform,
      commandSHA256: sha(JSON.stringify(commands)),
    };
    report.phases.push(result);
    await writeFile(resolve(folder, `${name}.heapprofile`), JSON.stringify(profile));
    await writeFile(resolve(folder, `${name}.trace.json`), JSON.stringify({ traceEvents: events }));
    console.log(
      JSON.stringify({
        status: 'measured',
        ...result,
        allocation: { ...allocation, sources: allocation.sources.slice(0, 5) },
      }),
    );
    await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2));
    await page.mouse.up();
    await page.close();
  }
  assert.equal(report.errors.length, 0);
  assert.ok(report.phases.every((p) => p.commandSHA256 === report.phases[0].commandSHA256));
  report.identicalWork = true;
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.failure = error.stack ?? String(error);
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    report: resolve(folder, 'report.json'),
    identicalWork: report.identicalWork,
    errors: report.errors,
  }),
);
