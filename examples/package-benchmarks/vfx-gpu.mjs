// GPU time of two @margoengine/vfx builds on the real GPU, alternating A/B, plus a pixel/state parity check.
// Snapshot a build first, e.g. `npm run build:packages` on the baseline commit, then copy packages/vfx/dist to
// test-results/vfx-base. Run on AC power with nothing else using the GPU:
//   node examples/package-benchmarks/vfx-gpu.mjs --a=test-results/vfx-base --b=packages/vfx/dist [--label=name]
//     [--capacities=100000,1000000] [--samples=1,4] [--rounds=16] [--frames=10] [--size=1432x768] [--parity-only]
//     [--scene=island|fill] (fill: 0.3 m particles in a 20 x 6 x 20 m box filling the view, fragment-bound)
// Light tier = 1x MSAA at DPR 1, full tier = 4x MSAA at DPR 1 (core caps 4x at DPR 1); 1432x768 is the laptop's
// maximized browser canvas. Rounds alternate A/B order; every rounds/4 rounds both effects are recreated (odd
// sessions create B first). --enable-webgpu-developer-features turns off Chrome's timestamp quantization. Particles use the Afterlight island options and camera; depth is cleared to far, so
// nothing occludes them (worst case). Writes examples/package-benchmarks/results/vfx-gpu-<label>.json.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, rmdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {openBrowser} from '../../scripts/browser.js';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const config = {a: arg('a', 'test-results/vfx-base'), b: arg('b', 'packages/vfx/dist'), label: arg('label', 'run'),
  capacities: arg('capacities', '100000,1000000').split(',').map(Number), samples: arg('samples', '1,4').split(',').map(Number),
  rounds: +arg('rounds', 16), frames: +arg('frames', 10), size: arg('size', '1432x768').split('x').map(Number), parityOnly: process.argv.includes('--parity-only'), scene: arg('scene', 'island')};
const power = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim() === 'True';
const lock = resolve(dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {encoding: 'utf8'}).trim()), 'test-results/gpu.lock');
for (;;) {try {mkdirSync(lock); break;} catch (e) {if (e.code !== 'EEXIST') throw e; console.log('GPU lock held, waiting'); await new Promise(r => setTimeout(r, 15000));}}
let browser;
try {
  const report = {recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8'}).trim(), config, acPowerBefore: power()};
  assert.ok(report.acPowerBefore, 'On battery: GPU timing is throttled, run on AC power');
  browser = await openBrowser({startPath: '/tests/modern-game.html', port: 5197, headless: false, args: ['--enable-webgpu-developer-features']});
  report.hardware = browser.hardware;
  await browser.page.addScriptTag({content: setup.toString()});
  report.parity = [];
  for (const samples of config.samples) {const row = await browser.page.evaluate(parity, {...config, a: '/' + config.a, b: '/' + config.b, samples}); report.parity.push(row); console.log(JSON.stringify(row));}
  if (!config.parityOnly) {
    report.timing = [];
    for (const capacity of config.capacities) for (const samples of config.samples) {
      const row = await browser.page.evaluate(timing, {...config, a: '/' + config.a, b: '/' + config.b, capacity, samples});
      report.timing.push(row); console.log(JSON.stringify({capacity, samples, summary: row.summary}));
    }
  }
  report.acPowerAfter = power();
  assert.ok(report.acPowerAfter, 'Power dropped to battery during the run; discard it');
  const out = resolve(import.meta.dirname, `results/vfx-gpu-${config.label}.json`);
  writeFileSync(out, JSON.stringify(report, null, 1) + '\n'); console.log('wrote', out);
} finally {await browser?.close(); rmdirSync(lock);}

/** Shared page setup: device, render targets, the island camera and a frame context for VFX.simulate/draw. */
async function setup({a, b, size: [width, height], scene}, samples) {
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Native adapter required');
  const device = await adapter.requestDevice({requiredFeatures: ['timestamp-query']}), errors = [];
  device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  const [A, B] = await Promise.all([import(a + '/index.js'), import(b + '/index.js')]), {Camera} = await import('/packages/core/dist/extension.js');
  const camera = new Camera({position: [-12, 5.62, 50.77], target: [-12, 2.31, 37], fov: 58, near: 0.15, far: 300}); camera.update(width / height, true);
  const target = (format, count, usage) => device.createTexture({size: [width, height], format, sampleCount: count, usage});
  const color = target('rgba16float', samples, GPUTextureUsage.RENDER_ATTACHMENT | (samples === 1 ? GPUTextureUsage.COPY_SRC : 0));
  const resolved = samples > 1 ? target('rgba16float', 1, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC) : color;
  const depth = target('depth32float', samples, GPUTextureUsage.RENDER_ATTACHMENT), colorView = color.createView(), depthView = depth.createView();
  const context = encoder => ({backend: 'webgpu', device, delta: 1 / 60, camera, width, height, format: 'rgba16float', color: colorView, depth: depthView,
    descriptor: {multisample: {count: samples}, depthStencil: {format: 'depth32float'}}, encoder});
  const clear = encoder => encoder.beginRenderPass({colorAttachments: [{view: colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0]}],
    depthStencilAttachment: {view: depthView, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0}}).end();
  const engine = {gpu: device, stats: {drawCalls: 0}, removePlugin() {}};
  const island = capacity => ({capacity, initialCount: capacity, rate: capacity / 20, position: [0, 4, 0], emissionExtent: [80, 3, 80], velocity: [0, 0.03, 0], gravity: [0, 0, 0],
    spread: 0.08, lifetime: [25, 45], size: 0.01, ground: 0.35, turbulence: 0.035, frequency: 0.22, color: [1, 0.85, 0.4, 0.5], intensity: 5,
    ...(scene === 'fill' ? {position: [-12, 3, 30], emissionExtent: [10, 3, 10], size: 0.3} : {})});
  const read = async (encode, bytes) => {
    const buffer = device.createBuffer({size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ}), encoder = device.createCommandEncoder();
    encode(encoder, buffer); device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const data = buffer.getMappedRange().slice(0); buffer.destroy(); return data;
  };
  const image = () => {const row = Math.ceil(width * 8 / 256) * 256;
    return read((encoder, buffer) => {
      if (samples > 1) encoder.beginRenderPass({colorAttachments: [{view: colorView, resolveTarget: resolved.createView(), loadOp: 'load', storeOp: 'store'}]}).end();
      encoder.copyTextureToBuffer({texture: resolved}, {buffer, bytesPerRow: row}, [width, height]);
    }, row * height).then(data => ({row: row / 2, pixels: new Uint16Array(data)}));};
  return {device, errors, modules: [A.VFX, B.VFX], camera, context, clear, engine, island, read, image, width, height,
    dispose() {for (const t of [color, resolved, depth]) t.destroy(); device.destroy();}};
}

/** Same particle records in A and B, one simulation step without births, then drawn in id order (canonical) or in the
 * order the atomics produced. State words are compared exactly except the angle (rotation.x), compared as the drawn angle. */
async function parity(config) {
  const s = await setup(config, config.samples), {device, width, height} = s, capacity = 200_000, records = new Float32Array(capacity * 16);
  const half = v => {const e = (v >> 10) & 31, m = v & 1023; return e === 31 ? NaN : e ? 2 ** (e - 15) * (1 + m / 1024) * (v >> 15 ? -1 : 1) : 2 ** -14 * (m / 1024) * (v >> 15 ? -1 : 1);};
  // Particles in front of the island camera, mixed sizes (0.01 to 1.5) so both sub-pixel and large billboards are covered.
  // Initial life equals remaining life (age 0), so a build that derives the angle from age matches one that accumulates it.
  for (let i = 0; i < capacity; i++) {const h = (i * 2654435761 >>> 0) / 4294967296, g = (i * 40503 % 65536) / 65536;
    records.set([-12 + (h - 0.5) * 60, 0.5 + g * 8, 38 - (i % 997) / 997 * 60, 10 + (i % 29), (g - 0.5) * 0.2, 0.03, (h - 0.5) * 0.2, i % 50 ? 0.01 + g * 0.05 : 0.2 + h * 1.3,
      g, 0.85 * h + 0.1, 0.4, 0.2 + 0.6 * h, (i % 31) * 0.19, (i % 7) * 0.3, 10 + (i % 29), 0], i * 16);}
  const toSplit = aos => {const out = new Float32Array(aos.length); for (let i = 0; i < capacity; i++) {out.set(aos.subarray(i * 16, i * 16 + 8), i * 8); out.set(aos.subarray(i * 16 + 8, i * 16 + 16), capacity * 8 + i * 8);} return out;};
  const fromSplit = soa => {const out = new Float32Array(soa.length); for (let i = 0; i < capacity; i++) {out.set(soa.subarray(i * 8, i * 8 + 8), i * 16); out.set(soa.subarray(capacity * 8 + i * 8, capacity * 8 + i * 8 + 8), i * 16 + 8);} return out;};
  const run = async (VFX, canonical) => {
    const e = new VFX({capacity, initialCount: 0, rate: 0, gravity: [0, -1, 0], turbulence: 0.2, frequency: 0.3, size: 0.01, ground: 0.35, angularVelocity: 0.5}); e.setup(s.engine);
    // Builds after the hot/cold split store position/life + velocity/size of every particle first, then colour + rotation.
    const {particles, alive, indirect} = e.gpuState, split = e.billboard.includes('array<vec4f>'); device.queue.writeBuffer(particles, 0, split ? toSplit(records) : records);
    let encoder = device.createCommandEncoder(); e.simulate(s.context(encoder)); device.queue.submit([encoder.finish()]);
    // Canonical order: the drawn ids sorted ascending (builds that cull draw a subset, counted in gpuState.visible).
    if (canonical) {const drawArgs = e.gpuState.visible ?? indirect, [list, args] = await Promise.all([s.read((en, b) => en.copyBufferToBuffer(alive, 0, b, 0, capacity * 4), capacity * 4),
      s.read((en, b) => en.copyBufferToBuffer(drawArgs, 0, b, 0, 20), 20)]);
      device.queue.writeBuffer(alive, 0, new Uint32Array(list).subarray(0, new Uint32Array(args)[1]).sort());}
    encoder = device.createCommandEncoder(); s.clear(encoder); e.draw(s.context(encoder)); device.queue.submit([encoder.finish()]);
    const [img, state, args, drawn] = await Promise.all([s.image(), s.read((en, buffer) => en.copyBufferToBuffer(particles, 0, buffer, 0, capacity * 64), capacity * 64),
      s.read((en, buffer) => en.copyBufferToBuffer(indirect, 0, buffer, 0, 20), 20), s.read((en, buffer) => en.copyBufferToBuffer(e.gpuState.visible ?? indirect, 0, buffer, 0, 20), 20)]);
    const aos = split ? fromSplit(new Float32Array(state)) : new Float32Array(state), angles = new Float32Array(capacity);
    // Rotation: split builds keep the birth angle and add angular velocity x age when drawing.
    for (let i = 0; i < capacity; i++) {const r = i * 16; angles[i] = split ? aos[r + 12] + aos[r + 13] * (aos[r + 14] - aos[r + 3]) : aos[r + 12]; aos[r + 12] = 0;}
    e.dispose(); return {img, words: new Uint32Array(aos.buffer), angles, args: [...new Uint32Array(args)], drawn: new Uint32Array(drawn)[1]};
  };
  const compare = (x, y) => {let pixels = 0, words = 0, maxDelta = 0, covered = 0, invalid = 0, sumDelta = 0, signed = 0, sumX = 0;
    for (let i = 0; i < x.words.length; i++) if (x.words[i] !== y.words[i]) words++;
    let maxAngleDelta = 0; for (let i = 0; i < capacity; i++) maxAngleDelta = Math.max(maxAngleDelta, Math.abs(x.angles[i] - y.angles[i]));
    for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {const at = r * x.img.row + c * 4; let changed = false; if (x.img.pixels[at + 3]) covered++;
      for (let k = 0; k < 4; k++) {const p = half(x.img.pixels[at + k]), q = half(y.img.pixels[at + k]); if (Number.isNaN(q) || !Number.isFinite(q)) invalid++;
        if (x.img.pixels[at + k] !== y.img.pixels[at + k]) {changed = true; const d = Math.abs(p - q); sumDelta += d; if (k < 3) signed += q - p; maxDelta = Math.max(maxDelta, d);}
        if (k < 3) sumX += p;}
      if (changed) pixels++;}
    return {changedStateWords: words, maxAngleDelta, changedPixels: pixels, coveredPixels: covered, invalidChannels: invalid, maxChannelDelta: maxDelta, meanDeltaPerChangedPixel: pixels ? sumDelta / pixels : 0, rgbSumA: sumX, signedSumBminusA: signed, liveCounts: [x.args[1], y.args[1]], drawnCounts: [x.drawn, y.drawn]};};
  try {
    const [A, B] = s.modules, a1 = await run(A, true), a2 = await run(A, true), b1 = await run(B, true), a3 = await run(A, false), a4 = await run(A, false), b2 = await run(B, false);
    return {capacity, width, height, samples: config.samples, canonicalOrder: {AA: compare(a1, a2), AB: compare(a1, b1)}, atomicOrder: {AA: compare(a3, a4), AB: compare(a3, b2)}, errors: s.errors};
  } finally {s.dispose();}
}

/** Alternating A/B frames on one device: per frame a simulate pass and a draw pass, each with timestamp queries. */
async function timing(config) {
  const s = await setup(config, config.samples), {device} = s, {frames, rounds} = config, slots = 16;
  const query = device.createQuerySet({type: 'timestamp', count: frames * slots}), resolve = device.createBuffer({size: frames * slots * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC});
  // Draw cost depends on where the buffers land and on the live-list order the atomics produced, so each session
  // creates fresh effects and odd sessions create B first.
  let effects = [];
  const create = session => {for (const e of effects) e.dispose(); effects = [];
    for (const v of session % 2 ? [1, 0] : [0, 1]) {const e = new s.modules[v](s.island(config.capacity)); e.setup(s.engine); effects[v] = e;}};
  const frame = (e, f) => {
    const encoder = device.createCommandEncoder(), passes = []; let next = f * slots;
    const timed = (kind, begin) => desc => {passes.push(kind); const at = next; next += 2; return begin({...desc, timestampWrites: {querySet: query, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1}});};
    const wrapped = {clearBuffer: (...x) => encoder.clearBuffer(...x), beginComputePass: timed('compute', d => encoder.beginComputePass(d)), beginRenderPass: timed('draw', d => encoder.beginRenderPass(d))};
    e.simulate(s.context(wrapped)); s.clear(encoder); e.draw(s.context(wrapped)); device.queue.submit([encoder.finish()]); return passes;
  };
  const block = async e => {
    const kinds = []; for (let f = 0; f < frames; f++) kinds.push(frame(e, f));
    const times = new BigUint64Array(await s.read((encoder, buffer) => {encoder.resolveQuerySet(query, 0, frames * slots, resolve, 0); encoder.copyBufferToBuffer(resolve, 0, buffer, 0, frames * slots * 8);}, frames * slots * 8));
    return kinds.map((list, f) => {const ms = {compute: 0, draw: 0}; list.forEach((kind, p) => {ms[kind] += Number(times[f * slots + p * 2 + 1] - times[f * slots + p * 2]) / 1e6;}); return ms;});
  };
  const median = v => {const x = v.slice().sort((p, q) => p - q), m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;};
  try {
    const blocks = [[], []], sessions = 4;
    for (let r = 0; r < rounds; r++) {
      if (r % (rounds / sessions) === 0) {create(r / (rounds / sessions)); for (let warm = 0; warm < 3; warm++) for (const e of effects) await block(e);}
      for (const v of r % 2 ? [1, 0] : [0, 1]) {const list = await block(effects[v]);
        blocks[v].push({compute: median(list.map(m => m.compute)), draw: median(list.map(m => m.draw)), total: median(list.map(m => m.compute + m.draw))});}
    }
    const live = await Promise.all(effects.map(e => s.read((en, buffer) => en.copyBufferToBuffer(e.gpuState.indirect, 0, buffer, 0, 20), 20).then(d => new Uint32Array(d)[1])));
    const stat = (v, key) => {const x = blocks[v].map(b => b[key]).sort((p, q) => p - q); return {median: median(x), min: x[0], max: x.at(-1)};};
    const summary = Object.fromEntries(['compute', 'draw', 'total'].map(key => [key, {A: stat(0, key), B: stat(1, key),
      pairedSavingMs: median(blocks[0].map((x, i) => x[key] - blocks[1][i][key])), bFasterRounds: blocks[0].filter((x, i) => blocks[1][i][key] < x[key]).length, rounds}]));
    return {capacity: config.capacity, samples: config.samples, width: s.width, height: s.height, framesPerBlock: frames, live, summary, blocks, errors: s.errors};
  } finally {for (const e of effects) e.dispose(); query.destroy(); resolve.destroy(); s.dispose();}
}
