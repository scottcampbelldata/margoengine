// HANDOFF 5g.c, real browser. From the repository root after `npm run build:packages`:
//   node examples/package-benchmarks/progressive/run.mjs [--rounds=4] [--profiles=broadband,4g] [--diagnostic] [--output=path.json]
// Serves the models from a local server with a shared bandwidth limit and round-trip latency (HTTP range support on, no
// caching), so the page's fetches, range requests and worker fetches all see the same throttled link. For each model and
// loader (loadGLTF, loadGLTFInWorker, loadGLTFProgressive) progressive.html records time to the first frame showing the
// model, time to interactive (from then on no frame gap over 50 ms), time to complete and the longest frame gap while
// the engine renders every frame and the camera orbits the model. Round 0 is discarded; medians of the rest. Then one
// untimed progressive load per model is screenshotted at `ready` and at `complete` (test-results/progressive-*.png).
// Requires AC power before and after. Takes the GPU lock through scripts/gpu-lock.mjs (`acquire`: owner.json, released
// only by its owner) only while a browser session runs (one per link profile, one for the screenshots); the quiet gate
// runs before each, outside the lock. --diagnostic skips the quiet gate and labels the results. --owner=<agent id>.
// Writes examples/package-benchmarks/results/progressive-gltf.json.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {openBrowser} from '../../../scripts/browser.js';
import {waitForQuiet} from '../../../scripts/quiet-gate.mjs';
import {acquire} from '../../../scripts/gpu-lock.mjs';
import {decodePNG} from '../../../tests/support/png.js';
import {bigGLB} from '../../../tests/support/big-glb.js';
import {acPower} from '../cad/power.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const rounds = +arg('rounds', 4), diagnostic = process.argv.includes('--diagnostic');
const median = values => {const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const files = {
  '/damaged-helmet.glb': readFileSync('examples/assets/damaged-helmet.glb'),
  '/generated-40mb.glb': bigGLB({segments: 400, meshes: 5}),            // 5 x 160,801 vertices, 960,000 indices each
  '/assembly-2000-parts.glb': bigGLB({segments: 10, meshes: 2000, lattice: 13}), // 2,000 nodes, each its own 121-vertex mesh
};
// Link profiles. Each applies to all requests together (one shared link), like a real connection.
const profiles = {broadband: {mbps: 50, rttMs: 40}, '4g': {mbps: 10, rttMs: 100}};
const plan = Object.fromEntries(Object.entries({broadband: Object.keys(files), '4g': ['/damaged-helmet.glb', '/assembly-2000-parts.glb']}).filter(([p]) => arg('profiles', 'broadband,4g').split(',').includes(p)));

function throttledServer() {
  const link = {mbps: 50, rttMs: 40, next: 0, bytes: 0, requests: 0, ranged: 0};
  const server = createServer(async (request, response) => {
    const cors = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'range', 'access-control-expose-headers': 'content-range, content-length', 'cache-control': 'no-store'};
    if (request.method === 'OPTIONS') {response.writeHead(204, cors); response.end(); return;}
    const body = files[new URL(request.url, 'http://x').pathname];
    if (!body) {response.writeHead(404, cors); response.end(); return;}
    let closed = false; response.on('close', () => {closed = true;});
    await sleep(link.rttMs);
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? ''), lo = range ? +range[1] : 0, hi = range ? Math.min(range[2] ? +range[2] : body.length - 1, body.length - 1) : body.length - 1;
    link.requests++; if (range) link.ranged++;
    response.writeHead(range ? 206 : 200, {...cors, 'content-type': 'model/gltf-binary', 'content-length': hi - lo + 1, ...range ? {'content-range': `bytes ${lo}-${hi}/${body.length}`} : {}});
    const rate = link.mbps * 1e6 / 8 / 1000; // bytes per ms, shared by every response
    for (let at = lo; at <= hi && !closed; at += 16384) {
      const chunk = body.subarray(at, Math.min(hi + 1, at + 16384)), now = performance.now();
      // Timer oversleep is paid back (up to 50 ms of credit) so the link keeps its rate; an idle link earns no credit.
      link.next = Math.max(link.next, now - 50) + chunk.length / rate; if (link.next - now > 1) await sleep(link.next - now);
      if (!response.write(chunk)) await once(response, 'drain'); link.bytes += chunk.length;
    }
    response.end();
  });
  return {server, link};
}

mkdirSync('test-results', {recursive: true});
const owner = arg('owner', 'gltf-pro progressive benchmark') + ` (progressive/run.mjs in ${process.cwd()})`;
const output = arg('output', 'examples/package-benchmarks/results/progressive-gltf.json'), pageErrors = [];
const report = {date: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {encoding: 'utf8'}).trim(), label: diagnostic ? 'diagnostic (no quiet gate)' : 'quiet-gated', acPowerBefore: acPower(),
  files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])), profiles, rounds, machine: [], runs: [], medians: {}, screenshots: {}};
async function withBrowser(work) {
  if (!diagnostic) report.machine.push(await waitForQuiet());
  const release = await acquire({owner, poll: 60_000});
  let context;
  try {
    assert.notEqual(acPower(), false, 'On battery');
    context = await openBrowser({startPath: '/examples/package-benchmarks/progressive/progressive.html', port: 5254});
    const {page, hardware} = context;
    page.setDefaultTimeout(600_000); page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error') pageErrors.push(m.text());});
    report.hardware = hardware;
    await page.waitForFunction(() => window.ready, null, {timeout: 60_000});
    await work(page);
    assert.notEqual(acPower(), false, 'Lost AC power during the run');
    writeFileSync(output, JSON.stringify({...report, partial: true}, null, 1)); // a later session's failure keeps this one
  } finally {await context?.close(); release();}
}
const {server, link} = throttledServer();
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  assert.notEqual(report.acPowerBefore, false, 'On battery');
  const modes = ['plain', 'worker', 'progressive'];
  for (const [profile, paths] of Object.entries(plan)) await withBrowser(async page => {
    Object.assign(link, profiles[profile]);
    for (let round = 0; round <= rounds; round++) for (const path of paths) for (const mode of round % 2 ? [...modes].reverse() : modes) {
      link.bytes = link.requests = link.ranged = 0;
      const run = await page.evaluate(([url, m]) => window.bench.run(url, m), [origin + path, mode]);
      Object.assign(run, {profile, path, round, bytesServed: link.bytes, requests: link.requests, rangeRequests: link.ranged});
      assert.deepEqual(run.errors, [], `${profile} ${path} ${mode}`); report.runs.push(run);
      console.log(JSON.stringify(run));
    }
    for (const path of paths) for (const mode of modes) {
      const runs = report.runs.filter(r => r.profile === profile && r.path === path && r.mode === mode && r.round > 0);
      if (runs.length) report.medians[`${profile} ${path} ${mode}`] = Object.fromEntries(['firstVisibleMs', 'interactiveMs', 'completeMs', 'maxFrameGapMs', 'longestTaskMs', 'totalBlockingTimeMs', 'bytesServed', 'requests'].map(k => [k, +median(runs.map(r => r[k])).toFixed(1)]));
    }
  });
  // Untimed: what the user sees at `ready` (boxes) and at `complete` (full model), on the broadband link.
  await withBrowser(async page => {
    Object.assign(link, profiles.broadband);
    for (const path of Object.keys(files)) {
      const name = path.slice(1, -4), shots = {};
      await page.evaluate(url => window.bench.run(url, 'progressive', {hold: true}), origin + path);
      for (const stage of ['ready', 'complete']) {
        if (stage === 'complete') await page.evaluate(() => window.bench.finish());
        const file = `test-results/progressive-${name}-${stage}.png`, image = await decodePNG(await page.locator('canvas').screenshot({path: file}));
        let drawn = 0; const d = image.data; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) drawn++;
        shots[stage] = {file, drawnFraction: +(drawn / (image.width * image.height)).toFixed(4)};
      }
      shots.errors = await page.evaluate(() => window.bench.close());
      report.screenshots[path] = shots; console.log(path, JSON.stringify(shots));
    }
  });
  report.pageErrors = pageErrors; console.table(report.medians);
  report.acPowerAfter = acPower();
  assert.notEqual(report.acPowerAfter, false, 'Lost AC power during the run');
  writeFileSync(output, JSON.stringify(report, null, 1));
  console.log(`wrote ${output}; AC before/after`, report.acPowerBefore, report.acPowerAfter);
} finally {server.close();}
