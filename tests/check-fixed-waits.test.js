// scripts/check-fixed-waits.mjs: what counts as a fixed wait in a GPU or browser check, and which files it reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedWaits, isCheckFile, scan } from '../scripts/check-fixed-waits.mjs';
import { readFileSync } from 'node:fs';

const kinds = (source) => fixedWaits(source).map((w) => `${w.line}:${w.kind}`);

test('a counted loop of frames is a fixed wait; a frame loop that waits for a condition is not', () => {
  assert.deepEqual(kinds('for (let i = 0; i < 20; i++) { engine.render({ delta: 0 }); await done(); }'), ['1:frames']);
  assert.deepEqual(kinds('for(let i=0;i<3;i++){engine.render({delta:0});await d.queue.onSubmittedWorkDone();}'), [
    '1:frames',
  ]);
  assert.deepEqual(kinds('const frames=async(n)=>{};\nfor (let k = 0; k < 4; k++)\n  await frames(1);'), ['2:frames']);
  // A condition, one frame, a loop that does not draw, a nested loop over data, a delta that steps time, a timing.
  assert.deepEqual(kinds('for (let i = 0; i < 4000 && !ready(); i++) engine.render();'), []);
  assert.deepEqual(kinds('for (let i = 0; i < 1; i++) engine.render();'), []);
  assert.deepEqual(kinds('for (let i = 0; i < 9; i++) sum += i;\nengine.render();'), []);
  assert.deepEqual(kinds('for(let y=0;y<4;y++)for(let x=0;x<8;x++){world.addChunk(x,y,0);}\nengine.render();'), []);
  assert.deepEqual(kinds('for (let i = 0; i < 300; i++) engine.render({ delta: 1 / 60 });'), []);
  assert.deepEqual(kinds('for (let i = 0; i < 20; i++) { const t = performance.now(); engine.render(); }'), []);
});

test('a sleep of 50 ms or more is a fixed wait; a short poll interval is not', () => {
  assert.deepEqual(kinds('await page.waitForTimeout(500);'), ['1:ms']);
  assert.deepEqual(kinds('await new Promise((r) => setTimeout(r, 300));'), ['1:ms']);
  assert.deepEqual(kinds('await new Promise((resolve) => setTimeout(() => resolve(), 100));'), ['1:ms']);
  assert.deepEqual(kinds('while (!ok()) await new Promise((r) => setTimeout(r, 10));'), []);
  assert.deepEqual(kinds('setTimeout(() => controller.abort(), 5000);'), []);
});

test('a fixed-wait: comment with a reason, on the line or the line above, allows it', () => {
  assert.deepEqual(kinds('await page.waitForTimeout(500); // fixed-wait: the debounce under test is 400 ms'), []);
  assert.deepEqual(kinds('// fixed-wait: warm-up before timing\nfor (let i = 0; i < 5; i++) engine.render();'), []);
  assert.deepEqual(kinds('// fixed-wait:\nfor (let i = 0; i < 5; i++) engine.render();'), ['2:frames']);
});

test('the check reads test folders and the browser drivers in scripts/, not benchmarks or builds', () => {
  assert.ok(isCheckFile('packages/voxel/tests/bevel-browser-check.html'));
  assert.ok(isCheckFile('packages/sky/test/browser-check.html'));
  assert.ok(isCheckFile('scripts/modern-browser-tests.js'));
  assert.ok(!isCheckFile('packages/voxel/src/render.ts'));
  assert.ok(!isCheckFile('packages/voxel/tests/mesher.test.js'));
  assert.ok(!isCheckFile('bench/cli.mjs'));
  assert.ok(!isCheckFile('scripts/benchmark-vfx-island.js'));
  assert.ok(!isCheckFile('packages/voxel/dist/tests/x.js'));
});

// This is the gate (npm run verify runs the unit tests): a new fixed wait fails it, and so does a removed one until
// `node scripts/check-fixed-waits.mjs --update` lowers the baseline.
test('every GPU and browser check has exactly the fixed waits its baseline counts', () => {
  const baseline = JSON.parse(readFileSync(new URL('../scripts/fixed-waits-baseline.json', import.meta.url), 'utf8')),
    found = scan();
  for (const [file, waits] of Object.entries(found))
    assert.ok(
      waits.length <= (baseline.files[file] ?? 0),
      `${file} has a new fixed wait; wait for readiness (scripts/support/gpu-ready.js) or mark it // fixed-wait: <reason>: ${waits.map((w) => `${w.line} ${w.text}`).join('; ')}`,
    );
  for (const [file, count] of Object.entries(baseline.files))
    assert.ok(
      (found[file]?.length ?? 0) >= count,
      `${file} has fewer fixed waits than its baseline (${count}): run node scripts/check-fixed-waits.mjs --update`,
    );
});
