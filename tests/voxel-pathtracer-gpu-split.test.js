// The voxel path tracer's GPU browser check runs as five package scripts, each inside its own time limit on an Intel
// Arc 140V, where the one old script ran past 900 s in the denoise caustics reference with eight cases still to go.
// These tests keep the split honest: every case the check knows runs in exactly one of the scripts, no script runs the
// whole check with no case named, every script is planned by scripts/gpu-package-tests.mjs with its own limit, and every
// one runs in check:merge whenever the package is affected.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { plan } from '../scripts/gpu-package-tests.mjs';
import { analyse, buildFootprints, loadWorkspaces } from '../scripts/support/affected-gpu.mjs';
import { testLimitMs } from '../scripts/support/run-limited.mjs';

const root = join(import.meta.dirname, '..'),
  dir = 'packages/voxel-pathtracer',
  pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')),
  CHECK = 'node packages/voxel-pathtracer/tests/browser-check.mjs';

/** The scripts that split the check, in run order. A missing one, or one more, fails below. */
const SPLIT = [
  'test:gpu',
  'test:gpu:denoise',
  'test:gpu:denoise-materials',
  'test:gpu:denoise-caustics',
  'test:gpu:viewport',
];

// Every case browser-check.mjs runs with no case named: each `wanted('<case>')`, without the two opt-in ones.
const source = readFileSync(join(root, dir, 'tests/browser-check.mjs'), 'utf8'),
  cases = [...new Set([...source.matchAll(/wanted\('([\w-]+)'\)/g)].map((m) => m[1]))].filter(
    (n) => n !== 'pictures' && n !== 'timing',
  );

/** [{ script, cases, flags }] for each package script that runs browser-check.mjs. */
const checkScripts = () =>
  Object.entries(pkg.scripts)
    .filter(([, command]) => command.includes(CHECK))
    .map(([script, command]) => {
      const words = command
        .slice(command.indexOf(CHECK) + CHECK.length)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      return {
        script,
        cases: words.filter((w) => !w.startsWith('--')),
        flags: words.filter((w) => w.startsWith('--')),
      };
    });

test('the case list is read from the check itself and holds every known case', () => {
  for (const name of ['agx', 'convergence', 'denoise-materials', 'denoise-caustics', 'denoisehistory', 'native4k'])
    assert.ok(cases.includes(name), `${name} is a case`);
  assert.ok(cases.length >= 36, `${cases.length} cases`);
});

test('the split scripts name every case exactly once, and nothing else', () => {
  const split = checkScripts().filter((s) => SPLIT.includes(s.script));
  assert.deepEqual(
    split.map((s) => s.script).sort(),
    [...SPLIT].sort(),
    `${dir}/package.json must have each split script`,
  );
  const named = split.flatMap((s) => s.cases);
  assert.deepEqual(
    named.filter((n, i) => named.indexOf(n) !== i),
    [],
    'no case runs in two split scripts',
  );
  assert.deepEqual([...named].sort(), [...cases].sort(), 'the union of the split scripts is the whole case list');
  // Only the results file differs between them: no flag that changes what a case does (samples, delays, errors).
  for (const s of split) assert.deepEqual(s.flags, [`--report=${s.script.replace(/^test:gpu:?/, '') || 'base'}`]);
});

test('no package script runs the whole check with no case named', () => {
  for (const s of checkScripts())
    assert.ok(s.cases.length > 0, `${s.script} runs every case in one script, past the Arc's time limit`);
  // The variants (slow compile, spec maths) run one case each with their flag; they are extra runs, not the split.
  for (const s of checkScripts().filter((x) => !SPLIT.includes(x.script))) assert.equal(s.cases.length, 1, s.script);
});

test('every split script is planned by gpu-package-tests with its own time limit', () => {
  const planned = plan().filter((t) => t.dir === 'voxel-pathtracer');
  for (const script of SPLIT) {
    const t = planned.find((p) => p.script === script);
    assert.ok(t, `gpu-package-tests plans voxel-pathtracer ${script}`);
    const minutes = pkg.margo.gpuTestTimeoutMinutes[script];
    assert.ok(minutes > 0, `margo.gpuTestTimeoutMinutes sets ${script}`);
    assert.equal(testLimitMs(t.minutes, {}), minutes * 60_000);
    assert.equal(t.steps, undefined, `${script} is already a short step`);
  }
});

test('check:merge runs every split script whenever the package is affected', () => {
  const workspaces = loadWorkspaces(root),
    tests = plan(),
    scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts,
    footprints = buildFootprints({ root, workspaces, tests, scripts });
  for (const file of [`${dir}/src/index.ts`, `${dir}/tests/browser-check.html`, 'packages/math/src/index.ts']) {
    const { hits } = analyse({ files: [file], workspaces, footprints });
    for (const script of SPLIT) assert.ok(hits.includes(`gpu/voxel-pathtracer/${script}`), `${file}: ${script}`);
  }
});
