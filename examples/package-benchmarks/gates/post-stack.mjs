// Post full-stack gate (HANDOFF item 0) and the SSAO-with-IBL cost. Real GPU, serial, under the GPU lock, on AC power.
// From the repository root after `npm run build:packages`:
//   node examples/package-benchmarks/gates/post-stack.mjs [--rounds=8] [--frames=120]
// Scene: DamagedHelmet (gltf-pro) + core boxes on a floor, environment IBL from a procedural HDR sky, 1280x720, DPR 1,
// core's default 4x MSAA. Every render/compute pass of a frame is timestamped; gpuMs is the sum of pass durations.
// 1. Visuals: no post vs PostStack [SSAO, DOF, Bloom, Tonemap, FXAA] vs the stack minus each effect. Asserts no
//    black/NaN frame and that removing any one effect changes the image. Screenshots: test-results/gates-post-*.png.
// 2. Per-effect GPU cost in the full stack: time of the passes each effect's code begins (stack = capture/compose).
// 3. SSAO alone with and without EnvironmentLighting (the ambient replay re-runs the full lit shader with IBL on).
// Writes examples/package-benchmarks/results/gates-post-stack.json.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
import {acPower} from '../cad/power.mjs';

const arg = (name, fallback) => +(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const rounds = arg('rounds', 8), frames = arg('frames', 120);
const lock = resolve(dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {encoding: 'utf8'}).trim()), 'test-results/gpu.lock');
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (;;) {try {mkdirSync(lock); break;} catch (e) {if (e.code !== 'EEXIST') throw e; console.log('gpu.lock held, waiting'); await sleep(15_000);}}
const all = ['ssao', 'dof', 'bloom', 'tonemap', 'fxaa'];
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8'}).trim(), acPowerBefore: acPower(), rounds, frames, scene: 'DamagedHelmet + 11 core boxes, 1280x720 DPR 1, core 4x MSAA', visuals: {}, timing: {}, effectCostMs: {}, ssaoIbl: {}};
let context;
try {
  assert.notEqual(report.acPowerBefore, false, 'On battery');
  context = await openBrowser({startPath: '/examples/package-benchmarks/gates/post-stack.html', port: 5241, args: ['--enable-webgpu-developer-features']});
  const {page, hardware} = context, pageErrors = [];
  page.setDefaultTimeout(120_000);
  page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if ((m.type() === 'error' || m.type() === 'warning') && !/powerPreference option is currently ignored/.test(m.text())) pageErrors.push(m.text());});
  report.hardware = hardware; console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, {timeout: 60_000});

  // 1. Visuals
  const stats = image => {let black = 0, sum = 0; const n = image.width * image.height; for (let i = 0; i < n * 4; i += 4) {const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2]; if (r + g + b === 0) black++; sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;} return {blackFraction: +(black / n).toFixed(5), meanLuma: +(sum / n).toFixed(2)};};
  const diff = (a, b) => {let s = 0, changed = 0; for (let i = 0; i < a.data.length; i += 4) {const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]); s += d; if (d > 6) changed++;} const n = a.width * a.height; return {meanAbsDiff: +(s / n / 3).toFixed(3), changedFraction: +(changed / n).toFixed(5)};};
  const shoot = async (name, config) => {
    const r = await page.evaluate(c => window.bench.setup(c), config); assert.deepEqual(r.errors, [], name); assert.ok(r.timestamps, 'timestamp-query');
    assert.deepEqual((await page.evaluate(() => window.bench.render())).errors, [], name);
    const png = await page.locator('canvas').screenshot({path: `test-results/gates-post-${name}.png`}); return decodePNG(png);
  };
  const images = {none: await shoot('none', {env: true}), full: await shoot('full', {env: true, effects: all})};
  for (const name of all) images[`no-${name}`] = await shoot(`no-${name}`, {env: true, effects: all.filter(e => e !== name)});
  for (const [name, image] of Object.entries(images)) report.visuals[name] = {...stats(image), vsFull: name === 'full' ? undefined : diff(image, images.full)};
  console.log('visuals', JSON.stringify(report.visuals));
  for (const [name, v] of Object.entries(report.visuals)) {assert.ok(v.meanLuma > 20, `${name}: frame is black`); assert.ok(v.blackFraction <= report.visuals.none.blackFraction + 0.001, `${name}: black (NaN) pixels`);}
  for (const name of all) assert.ok(report.visuals[`no-${name}`].vsFull.changedFraction > 0.001, `${name} has no visible effect`);

  // 2 + 3. Timing, alternating rounds. Each effect's cost is the GPU time of the passes its own code began (tagged in
  // the page), measured in the same frames as everything else, so clock changes between configurations cancel out.
  const configs = {none: {env: true}, full: {env: true, effects: all}, 'alone:none': {mode: 'alone'}, 'alone:ssao': {mode: 'alone', effects: ['ssao']}, 'alone:env': {mode: 'alone', env: true}, 'alone:env+ssao': {mode: 'alone', env: true, effects: ['ssao']}};
  const samples = Object.fromEntries(Object.keys(configs).map(k => [k, {frame: [], owners: {}}]));
  for (let round = 0; round < rounds; round++) {
    const order = Object.keys(configs); if (round % 2) order.reverse();
    for (const name of order) {
      if (acPower() === false) throw new Error('On battery mid-run');
      const s = await page.evaluate(c => window.bench.setup(c), configs[name]); assert.deepEqual(s.errors, [], name);
      const m = await page.evaluate(f => window.bench.measure(f), frames); assert.deepEqual(m.errors, [], name); assert.ok(!m.error, m.error); report.zeroFrames = (report.zeroFrames ?? 0) + m.zeroFrames;
      samples[name].frame.push(m.gpuMs.median); for (const [k, v] of Object.entries(m.ownerMs)) (samples[name].owners[k] ??= []).push(v);
      if (round === 0) report.timing[name] = {passes: m.passes, cpuMs: m.cpuMs, spanMs: m.spanMs};
    }
    console.log('round', round + 1, JSON.stringify({full: samples.full.owners && Object.fromEntries(Object.entries(samples.full.owners).map(([k, v]) => [k, v.at(-1)])), ssao: samples['alone:ssao'].owners.ssao?.at(-1), envSsao: samples['alone:env+ssao'].owners.ssao?.at(-1)}));
  }
  const median = a => {const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;};
  const round3 = v => +v.toFixed(3);
  for (const [name, v] of Object.entries(samples)) Object.assign(report.timing[name], {gpuMsMedian: round3(median(v.frame)), gpuMsPerRound: v.frame, ownerMsMedian: Object.fromEntries(Object.entries(v.owners).map(([k, x]) => [k, round3(median(x))])), ownerMsPerRound: v.owners});
  const own = report.timing.full.ownerMsMedian;
  report.effectCostMs = {...Object.fromEntries([...all, 'stack'].map(n => [n, own[n] ?? 0])), postTotal: round3([...all, 'stack'].reduce((t, n) => t + (own[n] ?? 0), 0)), sceneInFull: own.scene, frameFull: report.timing.full.gpuMsMedian, frameNoPost: report.timing.none.gpuMsMedian};
  const ssao = name => report.timing[name].ownerMsMedian.ssao;
  report.ssaoIbl = {ssaoWithoutIbl: ssao('alone:ssao'), ssaoWithIbl: ssao('alone:env+ssao'), replayExtraMs: round3(ssao('alone:env+ssao') - ssao('alone:ssao')), frames: {none: report.timing['alone:none'].gpuMsMedian, ssao: report.timing['alone:ssao'].gpuMsMedian, env: report.timing['alone:env'].gpuMsMedian, envSsao: report.timing['alone:env+ssao'].gpuMsMedian}};
  console.log('effect cost (ms, own passes, median of round medians)', JSON.stringify(report.effectCostMs));
  console.log('ssao + ibl (ms)', JSON.stringify(report.ssaoIbl));
  await page.evaluate(() => window.bench.teardown());
  assert.deepEqual(pageErrors, []);
  report.acPowerAfter = acPower(); assert.notEqual(report.acPowerAfter, false, 'Ended on battery: discard this run');
  writeFileSync('examples/package-benchmarks/results/gates-post-stack.json', JSON.stringify(report, null, 1));
  console.log('post stack gate passed; wrote examples/package-benchmarks/results/gates-post-stack.json');
} finally {await context?.close(); rmSync(lock, {recursive: true, force: true});}
