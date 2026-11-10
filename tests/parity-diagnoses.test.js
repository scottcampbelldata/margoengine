import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SCENES, caseId } from '../bench/scenes/catalog.js';
import { parityCases } from '../bench/scenes/parity.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
test('slower matrix rows retain a diagnosis and the one-call inventory retains every engine/case', () => {
  const matrix = readFileSync(new URL('../docs/whitepaper/perf-vs-threejs.md', import.meta.url), 'utf8');
  const causes = read('bench/parity-causes.json');
  for (const line of matrix.split('\n')) {
    const c = line.split('|').map((s) => s.trim());
    if (/^\d+\.\d+$/.test(c[1]) && c[4] === 'slower') {
      assert.ok(c[6], `Undiagnosed slower row ${c[1]}`);
      assert.ok(causes[c[1]], `No canonical cause for ${c[1]}`);
    }
  }
  const inventory = read('docs/whitepaper/results/bp-159-preflight.json');
  const expected = parityCases(SCENES).flatMap((c) =>
    ['margo', 'three-webgpu-parity', 'three-webgl-parity'].map((e) => `${caseId(c.scene, c.params)}@${e}`),
  );
  assert.deepEqual(
    inventory.cases.map((c) => `${c.id}@${c.engine}`),
    expected,
  );
  for (const c of inventory.cases) {
    if (c.status === 'ok') assert.equal(c.calls, 1);
    if (c.status === 'error') assert.ok(c.errors.length);
    assert.equal(c.metrics, undefined);
    assert.equal(c.throughput, undefined);
  }
});

test('retained CPU profiles contain one operation and portable call paths without timing records', () => {
  const profiles = read('docs/whitepaper/results/bp-159-task-profiles.json');
  assert.equal(profiles.records.length, 8);
  for (const r of profiles.records) {
    assert.equal(r.calls, 1);
    assert.ok(r.output);
    assert.ok(r.samples.length);
    assert.equal(r.startTime, undefined);
    assert.equal(r.endTime, undefined);
    for (const s of r.samples) {
      assert.ok(s.samples > 0);
      assert.ok(!s.url.startsWith('file:'), s.url);
      assert.equal(s.timeDeltas, undefined);
    }
  }
});
