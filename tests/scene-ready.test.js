// Bug 62: `check:quickstart` took the no-shadow and no-texture reference pictures after a fixed 1.2 s, and on a slower
// GPU (an Intel Arc laptop) they were completely blank. Pictures are now taken when the scene shows, and a page that
// never draws fails with a message that names what was missing.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  describeHardware,
  dumpEvidence,
  hardwareLine,
  settleOneAtATime,
  waitForPicture,
} from '../scripts/support/scene-ready.mjs';

const blank = { lum: new Float32Array([0, 0]), drawn: false },
  drawn = { lum: new Float32Array([5, 9]), drawn: true };

/** A page whose picture stays blank for `slow` shots, as a GPU still compiling its pipelines does. */
function slowPage(slow, problems = []) {
  let shots = 0;
  return { problems, shoot: async () => (shots++ < slow ? blank : drawn), shots: () => shots };
}
const options = (page, extra = {}) => ({
  label: 'the no-shadow page',
  shoot: page.shoot,
  pixels: async (picture) => picture,
  ready: (shot) => (shot.drawn ? true : 'the ball is not drawn'),
  intervalMs: 0,
  ...extra,
});

test('a blank picture is not taken as the reference: the wait ends only when the scene shows', async () => {
  const page = slowPage(7),
    shot = await waitForPicture(page, options(page));
  assert.equal(shot, drawn);
  assert.equal(page.shots(), 8, 'seven blank shots were refused, the eighth was kept');
});

test('a frozen scene must also stop changing: two equal pictures in a row', async () => {
  let n = 0;
  const frames = [
    blank,
    { lum: new Float32Array([1, 1]), drawn: true },
    { lum: new Float32Array([2, 2]), drawn: true },
  ];
  const page = { shoot: async () => frames[Math.min(n++, 2)] },
    shot = await waitForPicture(page, options(page, { stable: true }));
  assert.equal(shot, frames[2]);
  assert.equal(n, 4, 'blank, changing, then two equal shots');
});

test('a page that never draws fails naming the page, what was missing and what the page logged', async () => {
  const page = slowPage(Infinity, ['console error: device lost']);
  let clock = 0;
  await assert.rejects(
    waitForPicture(page, options(page, { timeoutMs: 5000, now: () => (clock += 1000) })),
    (error) => {
      assert.match(error.message, /the no-shadow page was not ready after \d+ s: the ball is not drawn/);
      assert.match(error.message, /console error: device lost/);
      return true;
    },
  );
});

// The Intel Arc startup hang (2026-10-30): the 4th live WebGPU page never started, the check said only "the ball is
// not drawn" after 120 s and left no evidence. A hung page now leaves a screenshot and its state, in bounded time.
test('a hung page leaves a screenshot and its state, and fails by name within its limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scene-ready-'));
  try {
    const page = {
      problems: [],
      url: () => 'http://127.0.0.1:5173/notexture.html',
      shoot: async () => blank,
      evaluate: async () => ({
        visibilityState: 'visible',
        canvases: [{ width: 300, height: 150, clientWidth: 1280, clientHeight: 720 }],
        rafTicksPerSecond: 60,
        status: 'Loading',
        webgpu: true,
      }),
    };
    const started = Date.now();
    await assert.rejects(
      waitForPicture(page, {
        ...options(page, { label: 'the no-texture page', timeoutMs: 200, intervalMs: 10 }),
        shoot: async () => Buffer.from('png bytes'),
        pixels: async () => blank,
        evidenceDir: dir,
      }),
      (error) => {
        assert.match(error.message, /the no-texture page was not ready after \d+ s: the ball is not drawn/);
        assert.match(error.message, /evidence in .*failed-the-no-texture-page\.json/);
        return true;
      },
    );
    // wall-clock: the 200 ms limit ended it; the page never gets ready, so without it this waits for ever.
    assert.ok(Date.now() - started < 15_000, 'the wait and the dump end near the limit');
    const evidence = JSON.parse(readFileSync(join(dir, 'failed-the-no-texture-page.json'), 'utf8'));
    assert.equal(evidence.visibilityState, 'visible');
    assert.deepEqual([evidence.canvases[0].width, evidence.canvases[0].height], [300, 150]);
    assert.equal(evidence.rafTicksPerSecond, 60);
    assert.match(evidence.reason, /the ball is not drawn/);
    assert.equal(readFileSync(join(dir, 'failed-the-no-texture-page.png'), 'utf8'), 'png bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the dump itself is bounded: a page that answers nothing still gets a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scene-ready-'));
  try {
    const never = () => new Promise(() => {});
    const page = { problems: ['console warning: x'], evaluate: never },
      started = Date.now(),
      file = await dumpEvidence(page, { dir, name: 'stuck', shoot: never, reason: 'test', stepMs: 50 });
    // wall-clock: the 50 ms step limit ended each read; the page never answers.
    assert.ok(Date.now() - started < 15_000);
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    assert.match(evidence.screenshot, /no screenshot within 50 ms/);
    assert.match(evidence.probe, /did not answer within 50 ms/);
    assert.deepEqual(evidence.problems, ['console warning: x']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reference pages are opened, settled and closed one at a time, in order, also on a failure', async () => {
  const log = [];
  let alive = 0;
  const open = async (name) => {
    alive++;
    log.push(`open ${name} (${alive} alive)`);
    return { name };
  };
  const close = async (page) => {
    alive--;
    log.push(`close ${page.name}`);
  };
  const results = await settleOneAtATime(['frozen', 'noshadow', 'notexture'], {
    open,
    close,
    settle: async (page) => `${page.name} shot`,
  });
  assert.deepEqual(results, ['frozen shot', 'noshadow shot', 'notexture shot']);
  assert.deepEqual(log, [
    'open frozen (1 alive)',
    'close frozen',
    'open noshadow (1 alive)',
    'close noshadow',
    'open notexture (1 alive)',
    'close notexture',
  ]);
  log.length = 0;
  await assert.rejects(
    settleOneAtATime(['frozen', 'noshadow'], {
      open,
      close,
      settle: async (page) => {
        throw new Error(`${page.name} hung`);
      },
    }),
    /frozen hung/,
  );
  assert.deepEqual(log, ['open frozen (1 alive)', 'close frozen'], 'the failing page is closed; no later one opens');
  assert.equal(alive, 0);
});

test('check:quickstart settles its reference pages one at a time and closes them', () => {
  const source = readFileSync(new URL('../scripts/quickstart-timing.mjs', import.meta.url), 'utf8');
  assert.match(source, /await settleOneAtATime\(/);
  assert.doesNotMatch(source, /off = await open\(/, 'the reference pages are not opened together');
  assert.match(source, /evidenceDir: shotDir/);
});

test('the report names the hardware: processor, memory and the adapter the page was given', async () => {
  const page = {
      evaluate: async () => ({
        vendor: 'intel',
        architecture: 'xe-lpg',
        device: '',
        description: 'Intel(R) Arc(TM) 140V',
        fallback: false,
      }),
    },
    hardware = await describeHardware(page);
  assert.equal(hardware.adapter.vendor, 'intel');
  assert.ok(hardware.logicalCores > 0 && hardware.memoryGB > 0 && hardware.cpu.length > 0);
  assert.match(
    hardwareLine(hardware),
    /WebGPU adapter intel xe-lpg Intel\(R\) Arc\(TM\) 140V \(software fallback: false\)/,
  );
  assert.match(hardwareLine({ ...hardware, adapter: null }), /no WebGPU adapter/);
});

test('check:quickstart waits on the picture and states its hardware; its 300 s gate is unchanged', () => {
  const source = readFileSync(new URL('../scripts/quickstart-timing.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /waitForTimeout/, 'no fixed sleep as a readiness wait');
  assert.doesNotMatch(source, /settle\(\w+, \d+/, 'settle takes a label and a condition, not milliseconds');
  assert.match(source, /Number\(arg\('max', 300\)\)/);
  assert.match(source, /hardwareLine\(sizes\.hardware\)/);
});
