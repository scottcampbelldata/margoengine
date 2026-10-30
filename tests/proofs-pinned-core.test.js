// Bug 6 (2026-10-27): nine pinned proofs (`npm run proofs`) failed against today's core. A pinned run built the old
// package sources at their claim commits but gave both sides today's @margoengine/core and its shader text, which old
// post, environment and tonemap sources patch by search and replace, so their stories threw on the first frame ("story
// must exercise the GPU", "fog requires the standard core PBR shader"). When the claims were made, both sides ran on the
// core of the claim commit. compare.js `coreAt(pin)` now builds core at the pin, and every package the proof builds
// after it imports that core. These tests pin that down with HEAD as the pin, which every clone holds, and check that
// the nightly job runs the pinned proofs (only --current ran in any check before, so the failures went unnoticed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { nightlySteps, pinnedProofsCommand } from '../scripts/nightly-full.mjs';
import { machineProfile } from '../scripts/support/machine-profile.mjs';

const root = resolve(import.meta.dirname, '..'),
  compare = pathToFileURL(join(root, 'examples/package-benchmarks/proofs/compare.js')).href;

/** Runs `body` as an ES module after `import * as proof from compare.js`; returns its status and output. */
function script(body) {
  const dir = mkdtempSync(join(tmpdir(), 'margo-pinned-core-'));
  try {
    const file = join(dir, 'pinned.mjs');
    writeFileSync(file, `import * as proof from ${JSON.stringify(compare)};\n${body}\n`);
    const run = spawnSync(process.execPath, [file], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5 * 60_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, PROOFS_NO_WRITE: '1', PROOFS_GOLDEN: '', PROOFS_GOLDEN_CAPTURE: '' },
    });
    return { status: run.status, out: `${run.stdout}\n${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a pinned run's packages import @margoengine/core built at the pin, not today's", () => {
  const run = script(`
    const pin = proof.commit('HEAD'),
      core = await proof.coreAt(pin);
    if (typeof core.wgsl !== 'string' || !core.wgsl.includes('@fragment')) throw new Error('no core shader at the pin');
    if (typeof core.Engine !== 'function') throw new Error('no Engine at the pin');
    const code = (await proof.bundle('post', 'src/index.ts', pin)).map((chunk) => chunk.code).join('\\n');
    const imports = [...code.matchAll(/from\\s*["']([^"']+)["']/g)].map((match) => match[1]);
    console.log(JSON.stringify(imports.filter((id) => id.includes('core'))));
    const post = await proof.load('post', 'src/index.ts', pin);
    if (typeof post.PostStack !== 'function') throw new Error('post at the pin did not load against the pinned core');
  `);
  assert.equal(run.status, 0, run.out.slice(-3000));
  const imports = JSON.parse(run.out.match(/^\[.*\]$/m)?.[0] ?? '[]');
  assert.ok(imports.length > 0, `post imports core:\n${run.out.slice(-2000)}`);
  for (const id of imports) {
    assert.doesNotMatch(id, /^@margoengine\/core/, "a bare core import would load today's core");
    assert.match(id, /^file:.*\/test-results\/proofs-tmp\/core-[0-9a-f]{12}-\d+\/(index|extension)\.js$/);
  }
});

test('coreAt() after a package was built fails, so one story never mixes two cores', () => {
  const run = script(`
    const pin = proof.commit('HEAD');
    await proof.bundle('post', 'src/index.ts', pin);
    await proof.coreAt(pin);
  `);
  assert.notEqual(run.status, 0);
  assert.match(run.out, /coreAt\(\) must come before the proof builds any package/);
});

test('the nightly job runs the pinned proofs after the full check, alone under the GPU lock', () => {
  const [, args] = pinnedProofsCommand();
  assert.deepEqual(args.slice(0, 4), ['scripts/gpu-lock.mjs', 'run', '--owner=nightly-proofs', '--exclusive']);
  assert.deepEqual(args.slice(-3), ['npm', 'run', 'proofs']);
  // The default (workstation) profile's nightly plan: the full check, then the pinned proofs.
  const { steps } = nightlySteps(machineProfile({}));
  assert.deepEqual(
    steps.map((step) => step.label),
    ['full check:merge', 'pinned proofs'],
  );
  assert.deepEqual(steps[1].command, pinnedProofsCommand());
});

// The stand-in device made 15 new closures for every begin*Pass (since 66d1cb30), about 19 µs a frame in splats' timed
// story, paid by both sides: splats' pinned speed-up (2.34x when recorded) measured 0.99-1.05x and failed under load.
test("the stand-in device's passes are new objects sharing one set of methods", async () => {
  const { mockGPU } = await import(
    pathToFileURL(join(root, 'examples/package-benchmarks/proofs/gpu-recorder.js')).href
  );
  const { device } = mockGPU(),
    encoder = device.createCommandEncoder(),
    a = encoder.beginRenderPass({}),
    b = encoder.beginComputePass({});
  assert.notEqual(a, b);
  assert.equal(a.draw, b.draw);
  assert.equal(a.dispatchWorkgroups, b.dispatchWorkgroups);
});
