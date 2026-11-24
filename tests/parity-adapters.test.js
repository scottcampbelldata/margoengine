// Margo's parity adapters (bench/scenes/parity/margo-*.js) build every case of the matrix. A builder that throws
// 'unsupported:' reports Margo missing in docs/whitepaper/perf-vs-threejs.md, so each one left must name its open entry
// in docs/known-bugs.md here. KB6250b: p-compute and p-color-grading threw although shader had the APIs they need.
// KB6250c: p-light-probe threw until environment's SHLight took nine RGB coefficients; none is left open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/** @type {Record<string, string>} */
const OPEN = {};

test('every Margo parity adapter builds its case, except those with an open known-bugs entry', () => {
  const refused = {};
  const dir = new URL('../bench/scenes/parity/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => /^margo-.*\.js$/.test(f))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    const builders = [...source.matchAll(/^ {2}async '([\w-]+)'\(/gm)];
    builders.forEach((m, i) => {
      const body = source.slice(m.index, builders[i + 1]?.index ?? source.length);
      if (/throw new Error\(\s*['`]unsupported:/.test(body)) refused[m[1]] = file;
    });
  }
  assert.deepEqual(Object.keys(refused).sort(), Object.keys(OPEN).sort(), JSON.stringify(refused));
  const known = readFileSync(new URL('../docs/known-bugs.md', import.meta.url), 'utf8');
  for (const id of Object.values(OPEN)) assert.ok(known.includes(id), `${id} in docs/known-bugs.md`);
});
