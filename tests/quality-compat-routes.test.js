// KB-COMPAT-READY1: the quality step compat-routes fails on a package that loads a WebGL2 route with loadCompatRoute
// and gives callers no `ready` promise and no recorded proof of identical frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compatRouteProblems } from '../scripts/quality/compat-routes.js';

const fixture = (files, record) => {
  const root = mkdtempSync(join(tmpdir(), 'compat-routes-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  mkdirSync(join(root, 'scripts/quality'), { recursive: true });
  writeFileSync(join(root, 'scripts/quality/compat-route-proofs.json'), JSON.stringify(record));
  return root;
};
const load = "loadCompatRoute(d, () => import('./compat.js'))?.then((m) => (this.route = m));\n";

test('compat-routes: a route without ready or proof fails; ready, routeSettled, a proof or an owed entry pass', () => {
  const root = fixture(
    {
      'packages/bare/src/index.ts': load,
      'packages/getter/src/index.ts': load + 'get ready() { return this.r; }\n',
      'packages/settled/src/feature.ts': 'const r = loadCompatRoute(d, l);\nconst ready = routeSettled(r);\n',
      'packages/proved/src/index.ts': load,
      'packages/proved/test/same.test.js': '',
      'packages/owed/src/index.ts': load,
      'packages/plain/src/index.ts': "import { loadCompatRoute } from '../../shared/compat.js';\n",
      'packages/shared/compat.js': 'export function loadCompatRoute(device, load) {}\n',
    },
    {
      proofs: { 'packages/proved/src/index.ts': { test: 'packages/proved/test/same.test.js' } },
      owed: ['packages/owed/src/index.ts'],
    },
  );
  try {
    const problems = compatRouteProblems(root);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /^packages\/bare\/src\/index\.ts: loads a WebGL2 route .* no `ready` promise/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compat-routes: the record only shrinks and names real files and tests', () => {
  const root = fixture(
    {
      'packages/fixed/src/index.ts': load + 'get ready() {}\n',
      'packages/proved/src/index.ts': load,
    },
    {
      proofs: { 'packages/proved/src/index.ts': { test: 'packages/proved/test/missing.test.js' } },
      owed: ['packages/fixed/src/index.ts', 'packages/gone/src/index.ts'],
    },
  );
  try {
    const problems = compatRouteProblems(root).sort();
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.match(problems[0], /fixed\/src\/index\.ts: has its ready promise now; remove it from "owed"/);
    assert.match(problems[1], /gone\/src\/index\.ts: listed in compat-route-proofs\.json but loads no route/);
    assert.match(problems[2], /proved\/src\/index\.ts: its proof test .*missing\.test\.js does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compat-routes: the repository passes', () => {
  assert.deepEqual(compatRouteProblems(join(import.meta.dirname, '..')), []);
});
