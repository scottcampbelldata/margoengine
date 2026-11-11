// A/B benchmark scripts once read only a package's entry file from the baseline commit and its sibling modules from
// the working tree (benchmark-net, benchmark-road), or refused any baseline whose siblings had changed since
// (benchmark-bvh). Baselines now come whole from one commit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { baselineSource, sourceClosure } from '../scripts/lib/baseline-source.mjs';

const show = (spec) => execFileSync('git', ['show', spec], { encoding: 'utf8' });
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

test('baselineSource serves every src module of the package from the commit, with overrides', () => {
  const plugin = baselineSource({ commit: head, packageName: 'road', overrides: { 'index.ts': 'export {};' } });
  const windowsId = ['C:', 'repo', 'packages', 'road', 'src', 'frame.ts'].join(String.fromCharCode(92));
  assert.equal(plugin.load(windowsId), show(`${head}:packages/road/src/frame.ts`));
  assert.equal(plugin.load('/repo/packages/road/src/index.ts?x'), 'export {};');
  assert.equal(plugin.load('/repo/packages/net/src/index.ts'), undefined);
  assert.equal(plugin.load('/repo/packages/road/dist/index.js'), undefined);
});

test('sourceClosure follows relative imports only', async () => {
  const files = await sourceClosure('bvh.ts', (name) => show(`${head}:packages/bvh/src/${name}`));
  assert.ok(files.has('bvh.ts') && files.has('build.ts') && files.has('math.ts'));
  assert.ok(!files.has('lines.ts'), 'lines.ts imports packages/shared and is not part of MeshBVH');
});

test('the A/B benchmark scripts build their baselines from one commit', () => {
  const read = (name) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
  for (const name of ['benchmark-net.js', 'benchmark-road.js']) assert.match(read(name), /baselineModules\(\{ commit/);
  const bvh = read('benchmark-bvh.js');
  assert.match(bvh, /sourceClosure\('bvh\.ts'/);
  assert.doesNotMatch(bvh, /Benchmark expects unchanged/);
});
