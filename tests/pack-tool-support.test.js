import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findPythonIn, requireRevision } from '../scripts/web-demos/pack-tool-support.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const support = fileURLToPath(new URL('../scripts/web-demos/pack-tool-support.mjs', import.meta.url));

test('resolveMargoPackages resolves a known package and a subpath from a checkout', () => {
  const script = `import {resolveMargoPackages} from ${JSON.stringify(pathToFileURL(support).href)};
resolveMargoPackages(${JSON.stringify(root)});
const math = await import('@margoengine/math/quat');
const bad = await import('@margoengine/math/not-an-entry').then(() => 'resolved', (e) => e.message);
console.log(JSON.stringify({ quat: typeof math.axisAngleToQuaternion, bad }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(out.quat, 'function');
  assert.match(out.bad, /not exported by packages\/math/);
});

test('requireRevision accepts HEAD and names a different revision', () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  requireRevision(root, head);
  assert.throws(() => requireRevision(root, '0'.repeat(40)), /Unexpected Margo checkout/);
});

test('findPythonIn uses the checkout finder and throws the caller message when none is found', async () => {
  const python = await findPythonIn(root, 'no python');
  assert.equal(typeof python, 'string');
});

for (const tool of [
  'demos/character-course/source/tools/pack-course-kernel.mjs',
  'demos/the-guard/source/tools/pack-rita.mjs',
  'demos/the-planner/source/tools/sample-cmu-walk.mjs',
]) {
  test(`${tool} starts and reports its argument error`, () => {
    const run = spawnSync(process.execPath, [resolve(root, tool)], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Pass (the|a built public) Margo checkout/);
  });
}
