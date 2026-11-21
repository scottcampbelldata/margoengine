// A reference or payload to an ancestor or a descendant of a site on its way up is a cycle. Each stage in
// `fixtures/namespace-cycles.json` is ours, and the prims and values there are what OpenUSD 26.11 (usd-core from PyPI,
// run where it lives, its source never read) composed: it reports each such arc as a cycle ("CANNOT reference") and
// composes the prim without it. Margo checked only for the same site, so `/M/a` referencing `/M` brought `/M/a` back
// under itself one prim deeper each time and never finished; `through-another-layer` reaches `l2.usda /M` again from
// `l2.usda /M/a` by way of `l1.usda /X`. Composition runs in a worker, so a stage that never finishes fails the test
// at its time limit instead of holding the run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { differences } from './openusd-differences.js';

const stages = JSON.parse(readFileSync(new URL('./fixtures/namespace-cycles.json', import.meta.url), 'utf8'));
const compose = `
  const { parentPort, workerData } = require('node:worker_threads');
  import(workerData.module).then(async ({ composeUSDFiles }) => {
    const encoder = new TextEncoder();
    const { specs, issues } = await composeUSDFiles('root.usda', (id) => {
      const text = workerData.files[id.replace(/^\\.\\//, '')];
      return text === undefined ? undefined : encoder.encode(text);
    });
    parentPort.postMessage({ specs, issues });
  });
`;
/** The composed stage, or a failure once `ms` pass. */
function composed(files, ms) {
  const module = new URL('../dist/compose.js', import.meta.url).href;
  const worker = new Worker(compose, { eval: true, workerData: { files, module } });
  let timer;
  return Promise.race([
    new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`composition did not finish within ${ms} ms`)), ms);
    }),
  ]).finally(() => {
    clearTimeout(timer);
    worker.terminate();
  });
}

for (const [name, { files, prims }] of Object.entries(stages))
  test(`an arc to an ancestor or descendant of its site is a cycle, as OpenUSD composes it: ${name}`, async () => {
    const { specs, issues } = await composed(files, 10_000);
    assert.deepEqual(differences(specs, { prims }), [], name);
    assert.ok(
      issues.some((i) => i.code === 'cycle'),
      `${name} reports the cycle`,
    );
  });
