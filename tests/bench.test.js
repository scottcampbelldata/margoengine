import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { frameIntervals, metricRecord, summarize, worsening } from '../bench/lib/stats.mjs';
import { compare, markdown, html } from '../bench/lib/results.mjs';
import { SCENES, STANDARD, caseId, sceneParams } from '../bench/scenes/catalog.js';
import { OPT_IN, SUITES, loadSuite } from '../bench/suites/index.mjs';

test('bench statistics: median, nearest-rank p95, relative spread, noise', () => {
  assert.deepEqual(summarize([5, 1, 3, 2, 4]), { n: 5, median: 3, p95: 5, min: 1, max: 5, mean: 3, spread: 1.3333 });
  assert.equal(summarize([2, 4]).median, 3);
  assert.equal(summarize([]).median, null);
  assert.equal(metricRecord({ unit: 'ms' }, [10, 10.5, 10.2], 0.1).noisy, false);
  assert.equal(metricRecord({ unit: 'ms' }, [10, 13, 10.2], 0.1).noisy, true);
  assert.equal(metricRecord({ unit: 'B', exact: true }, [10, 13], 0.1).noisy, false);
  assert.equal(worsening(10, 11, 'lower'), 0.1);
  assert.equal(worsening(10, 11, 'higher'), -0.1);
  assert.deepEqual(frameIntervals([0, 1, 3, 6, 10]), { mean: 2.5, p95: 4, p99: 4, duration: 10 });
  assert.throws(() => frameIntervals([2, 1]), RangeError);
  assert.throws(() => frameIntervals([Number.NaN, 2]), RangeError);
});

const run = (machine, metrics) => ({
  id: `run-${machine}-${Object.values(metrics)[0].median}`,
  label: 'dev',
  date: '2026-10-24T00:00:00Z',
  valid: true,
  invalid: [],
  options: { runs: 5, warmup: 1, noise: 0.1 },
  env: {
    machine,
    host: { cpu: 'cpu', cores: 1, memoryGB: 1, os: 'test', osRelease: '0', osVersion: '0', node: 'v0' },
    gpu: [{ name: 'gpu', driver: '1' }],
    engine: { name: 'margo', version: '1.0.0', commit: 'abc' },
  },
  gate: null,
  suites: { render: { title: 'Render', status: 'ok', cases: { boxes: { metrics } } } },
});
const metric = (median, spread = 0.02, extra = {}) => ({ unit: 'ms', better: 'lower', median, spread, n: 5, ...extra });

test('bench comparison: regressions past the threshold and the spread fail, noise and other machines do not', () => {
  const base = run('m1', { cpuMs: metric(10), gzip: metric(1000, 0, { exact: true, unit: 'B' }) });
  let c = compare(run('m1', { cpuMs: metric(11), gzip: metric(1000, 0, { exact: true, unit: 'B' }) }), base, {
    threshold: 0.05,
  });
  assert.equal(c.rows.find((r) => r.metric === 'cpuMs').status, 'regression');
  assert.equal(c.rows.find((r) => r.metric === 'gzip').status, 'same');
  // Worse by 10%, but the run's own spread is 20%: noise, not a regression.
  c = compare(run('m1', { cpuMs: metric(11, 0.2) }), base, { threshold: 0.05 });
  assert.equal(c.rows[0].status, 'same');
  c = compare(run('m1', { cpuMs: metric(8) }), base, { threshold: 0.05 });
  assert.equal(c.rows[0].status, 'improvement');
  // Another machine: timings are shown, not judged; bytes still are.
  c = compare(run('m2', { cpuMs: metric(20), gzip: metric(1100, 0, { exact: true, unit: 'B' }) }), base, {
    threshold: 0.05,
  });
  assert.equal(c.rows.find((r) => r.metric === 'cpuMs').status, 'not judged');
  assert.equal(c.rows.find((r) => r.metric === 'gzip').status, 'regression');
  const current = { ...run('m1', { cpuMs: metric(11) }), compare: c };
  assert.match(markdown(current), /\| boxes \| cpuMs \(ms\) \| 11\.0 \|/);
  assert.match(html(current), /<title>Margo benchmark /);
});

test('bench scenes: every standard case names a scene, ids are stable, data is deterministic', async () => {
  for (const [suite, list] of Object.entries(STANDARD))
    for (const { scene, params } of list) {
      assert.ok(SCENES[scene], `${suite}: ${scene}`);
      assert.match(caseId(scene, params), /^[a-z0-9-]+$/);
    }
  assert.equal(caseId('boxes', { n: 100_000, mode: 'instanced', move: 1 }), 'boxes-100000-instanced-moving');
  assert.equal(caseId('gltf', { model: 'flight-helmet' }), 'gltf-flight-helmet');
  assert.equal(caseId('boxes', { n: 10_000, views: 4 }), 'boxes-10000-views4');
  assert.deepEqual(sceneParams('boxes', { n: 5 }), { n: 5, mode: 'mesh', move: 0, views: 1 });
  const env = { assets: '/a/' };
  for (const scene of ['boxes', 'materials', 'lights', 'shadows', 'post', 'startup', 'gltf', 'helmet', 'react']) {
    const p = sceneParams(scene, scene === 'boxes' || scene === 'react' ? { n: 64 } : {});
    const a = await SCENES[scene].data(p, env),
      b = await SCENES[scene].data(p, env);
    assert.deepEqual(JSON.stringify(a), JSON.stringify(b), scene);
  }
  assert.equal((await SCENES.lights.data(sceneParams('lights'), env)).lights.length, 64);
  // Data scenes: deterministic inputs, and a work size for every compute task (the throughput metric divides by it).
  for (const scene of Object.keys(SCENES).filter((s) => SCENES[s].suite === 'data')) {
    const p = sceneParams(scene, { n: scene === 'viz-volume' ? 4 : 16 });
    assert.deepEqual(
      JSON.stringify(await SCENES[scene].data(p, env)),
      JSON.stringify(await SCENES[scene].data(p, env)),
    );
    if (SCENES[scene].kind === 'task') assert.ok(SCENES[scene].work(p).amount > 0, scene);
  }
  assert.deepEqual(SCENES['compute-matmul'].work({ n: 10 }), { amount: 2000, unit: 'GFLOP/s', scale: 1e9 });
  assert.equal((await SCENES.gltf.data(sceneParams('gltf'), env)).url, '/a/scifi-helmet.glb');
});

test('bench suites: every suite loads and lists its cases', async () => {
  for (const name of [...SUITES, ...OPT_IN]) {
    const suite = await loadSuite(name);
    assert.equal(suite.name, name);
    assert.ok(['none', 'cpu', 'gpu'].includes(suite.uses), name);
  }
  const out = execFileSync(process.execPath, ['bench/cli.mjs', '--list', 'math', 'render'], { encoding: 'utf8' });
  assert.match(out, /transforms-100k/);
  assert.match(out, /boxes-10000/);
});
