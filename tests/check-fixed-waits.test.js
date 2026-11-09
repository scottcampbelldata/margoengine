// scripts/check-fixed-waits.mjs: what counts as a fixed wait in a GPU or browser check, and which files it reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedWaits, isCheckFile, scan } from '../scripts/check-fixed-waits.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

// Regression (2026-11-07): tests/modern-xr-passes.ts drew one reference render per eye in `for (let i = 0; i < 2; i++)
// { const view = eyes()[i]; engine.render(...) }`, and the check read that walk over two eyes as a two-frame wait.
test('a counted loop that reads a list item by its counter walks the list; recording each frame does not', () => {
  assert.deepEqual(
    kinds('for (let i = 0; i < 2; i++) {\n  const view = eyes()[i];\n  engine.render({ views: [cam(view)] });\n}'),
    [],
  );
  assert.deepEqual(kinds('for (let e = 0; e < 2; e++) engine.render({ views: [views.at(e)] });'), []);
  assert.deepEqual(kinds('for (let i = 0; i < 20; i++) { engine.render(); times[i] = now(); }'), ['1:frames']);
  assert.deepEqual(kinds('for (let i = 0; i < 20; i++) { engine.render(); seen[i] += 1; }'), ['1:frames']);
  assert.deepEqual(kinds('for (let i = 0; i < 20; i++) { engine.render(); log(i); }'), ['1:frames']);
  assert.deepEqual(kinds('for (let i = 0; i < 20; i++) { engine.render(); if (list[j] === i) break; }'), ['1:frames']);
});

test('a sleep of 50 ms or more is a fixed wait; a short poll interval is not', () => {
  assert.deepEqual(kinds('await page.waitForTimeout(500);'), ['1:ms']);
  assert.deepEqual(kinds('await new Promise((r) => setTimeout(r, 300));'), ['1:ms']);
  assert.deepEqual(kinds('await new Promise((resolve) => setTimeout(() => resolve(), 100));'), ['1:ms']);
  assert.deepEqual(kinds('while (!ok()) await new Promise((r) => setTimeout(r, 10));'), []);
  assert.deepEqual(kinds('setTimeout(() => controller.abort(), 5000);'), []);
});

test('a bitmask filter enumerates distinct feature inputs, while recording a mask still waits', () => {
  assert.deepEqual(
    kinds('for(let mask=0;mask<32;mask++){ const selected=factories.filter((_,i)=>mask&(1<<i)); await render(selected); }'),
    [],
  );
  for (const body of [
    'log(mask & (1 << i)); await render();',
    'const selected=factories.filter((mask,i)=>mask&(1<<i)); await render(selected);',
    'const selected=factories.filter((_,i)=>other&(1<<i)); await render(selected);',
    'const selected=factories.filter((_,i)=>mask&(1<<other)); await render(selected);',
    'const ignored=factories.filter((_,i)=>mask&(1<<i)); await render();',
  ]) assert.deepEqual(kinds(`for(let mask=0;mask<32;mask++){ ${body} }`), ['1:frames']);
});

// Regression (2026-10-31): these were invisible to the check, and each one failed under a loaded 8-way run.
test("a unit test's sleep helper, and a promise raced against a time, are fixed waits", () => {
  assert.deepEqual(kinds('await sleep(500);\nassert.equal(alive(pid), false);'), ['1:ms']);
  assert.deepEqual(kinds('await wait(200);'), ['1:ms']);
  assert.deepEqual(kinds('await delay(1_500);'), ['1:ms']);
  assert.deepEqual(kinds("assert.equal(await settled(next, 2000), 'got');"), ['1:ms']);
  assert.deepEqual(kinds("assert.equal(await settled(take(old, 'x'), 1000), 'got');"), ['1:ms']);
  assert.deepEqual(kinds('while (!ok()) await sleep(10);'), []);
  assert.deepEqual(kinds('await handle.wait(path);'), []);
  assert.deepEqual(kinds('await sleep(500); // fixed-wait: nothing may start in this time'), []);
});

test('a fixed-wait: comment with a reason, on the line or the line above, allows it', () => {
  assert.deepEqual(kinds('await page.waitForTimeout(500); // fixed-wait: the debounce under test is 400 ms'), []);
  assert.deepEqual(kinds('// fixed-wait: warm-up before timing\nfor (let i = 0; i < 5; i++) engine.render();'), []);
  assert.deepEqual(kinds('// fixed-wait:\nfor (let i = 0; i < 5; i++) engine.render();'), ['2:frames']);
});

// Regression (2026-10-31): tests/catalog.test.js passed an async predicate, so its clipboard wait ended at once and a
// loaded run read the previous copy. Playwright does not await a predicate; a promise is truthy.
test('an async waitForFunction predicate never waits, and no comment allows it', () => {
  assert.deepEqual(kinds('await page.waitForFunction(async () => ready());'), ['1:async predicate']);
  assert.deepEqual(kinds('page.waitForFunction(\n  async (want) => (await read()) === want,\n  want,\n);'), [
    '1:async predicate',
  ]);
  assert.deepEqual(kinds('await page.waitForFunction(async function () { return ready(); });'), ['1:async predicate']);
  assert.deepEqual(kinds('// fixed-wait: reason\nawait page.waitForFunction(async () => ready());'), [
    '2:async predicate',
  ]);
  assert.deepEqual(kinds('await page.waitForFunction(() => window.ready);'), []);
  assert.deepEqual(kinds('await page.waitForFunction((want) => window.written.at(-1) === want, want);'), []);
});

test('the check reads test folders, unit tests too, and the browser drivers in scripts/, not benchmarks or builds', () => {
  assert.ok(isCheckFile('packages/voxel/tests/bevel-browser-check.html'));
  assert.ok(isCheckFile('packages/sky/test/browser-check.html'));
  assert.ok(isCheckFile('scripts/modern-browser-tests.js'));
  assert.ok(!isCheckFile('packages/voxel/src/render.ts'));
  assert.ok(isCheckFile('packages/voxel/tests/mesher.test.js'));
  assert.ok(isCheckFile('tests/gpu-lock-limits.test.js'));
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
    if (existsSync(new URL(`../${file}`, import.meta.url)))
      assert.ok(
        (found[file]?.length ?? 0) >= count,
        `${file} has fewer fixed waits than its baseline (${count}): run node scripts/check-fixed-waits.mjs --update`,
      );
});

test('a wait in a git-ignored scratch build is not scanned; a tracked one is', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'fixed-waits-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const put = (file) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), 'await page.waitForTimeout(300);\n');
  };
  put('.lane/tests/scratch.test.js');
  put('tests/tracked.test.js');
  writeFileSync(join(repo, '.gitignore'), '.lane/\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.gitignore', 'tests');
  assert.deepEqual(Object.keys(scan(repo)), ['tests/tracked.test.js']);
});
