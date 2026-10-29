// Bug 62: `check:quickstart` took the no-shadow and no-texture reference pictures after a fixed 1.2 s, and on a slower
// GPU (an Intel Arc laptop) they were completely blank. Pictures are now taken when the scene shows, and a page that
// never draws fails with a message that names what was missing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { describeHardware, hardwareLine, waitForPicture } from '../scripts/support/scene-ready.mjs';

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
