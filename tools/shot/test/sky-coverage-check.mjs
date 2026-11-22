// `npm run test:shot` part 2 (WebGPU): the sky coverage mask on the real shots of
// KB-HEARTH-CLIP1, rendered once at 270 x 480 with every frame up to the last probe drawn, as the full shot draws it.
// - cabin-hearth-kettle: before the coverage, skyClip counted the whole frame, so the flames and the kettle's glint
//   failed it at every probe (1.29, 2.16 and 4.78 % on the A6000 at full size). Its probes look at the hearth with no
//   sky in view: each gets `sky-coverage` with 0 sky pixels, so not one clipped pixel is counted, while the whole frame
//   still clips (the check is not vacuous).
// - cabin-window-snow: the sky over the cabin is a part of the frame, neither none nor all of it.
// - orrery-dolly: the page has no sky, so no coverage, and skyClip and lights read the whole frame as before.
// Needs `npm run build:packages` first.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodePNG } from '@margoengine/headless/compare';
import { checkProbe, skyClip } from '@margoengine/headless/look';
import { parseShot } from '../shot-file.mjs';
import { shoot } from '../render.mjs';
import { lookShot } from '../look.mjs';

const root = resolve(import.meta.dirname, '../../..');
process.chdir(root);
const quiet = () => {};

async function render(id) {
  const json = JSON.parse(readFileSync(join(root, 'tools/shot/shots', `${id}.json`), 'utf8'));
  json.shot = { ...json.shot, id: `${id}-small`, size: [270, 480], supersample: 1 };
  const file = parseShot(json),
    out = join(root, 'test-results', 'shots', `${id}-sky-coverage`);
  rmSync(out, { recursive: true, force: true });
  const manifest = await shoot(file, { out, runs: 1, log: quiet });
  const report = await lookShot(out, manifest),
    probes = {};
  for (const [name, probe] of Object.entries(manifest.probes)) {
    const frame = await decodePNG(readFileSync(join(out, probe.file))),
      sky = probe.aovs?.['sky-coverage'] ? await decodePNG(readFileSync(join(out, probe.aovs['sky-coverage']))) : null;
    let share = 0;
    if (sky) for (let i = 0; i < sky.data.length; i += 4) share += sky.data[i] / 255;
    probes[name] = {
      frame,
      share: sky ? share / (sky.width * sky.height) : null,
      whole: skyClip(frame),
      rows: report.json.probes.find((p) => p.name === name).results,
    };
  }
  return { manifest, report, probes };
}
const row = (rows, check) => rows.find((r) => r.check === check);

{
  const { manifest, probes } = await render('cabin-hearth-kettle');
  assert.equal(manifest.skyCoverage, true, 'the cabin page has a sky, so its probes get sky-coverage');
  for (const [name, p] of Object.entries(probes)) {
    const clip = row(p.rows, 'skyClip');
    assert.ok(p.whole.detail.clipped > 0, `${name}: the flames and the glint clip somewhere in the frame`);
    assert.equal(clip.mask, 'sky-coverage', name);
    assert.equal(p.share, 0, `${name}: the hearth probes have no sky in view`);
    assert.equal(clip.detail.clipped ?? 0, 0, `${name}: clipped pixels counted as sky`);
    assert.equal(clip.pass, true, `${name}: ${JSON.stringify(clip)}`);
  }
  console.log(
    `ok kettle: whole frame clips ${Object.entries(probes)
      .map(([n, p]) => `${n} ${p.whole.value.toFixed(2)} %`)
      .join(', ')}; 0 sky pixels counted`,
  );
}
{
  const { manifest, probes } = await render('cabin-window-snow');
  assert.equal(manifest.skyCoverage, true);
  for (const [name, p] of Object.entries(probes)) {
    assert.ok(p.share > 0.05 && p.share < 0.3, `${name}: sky share ${p.share}`);
    const clip = row(p.rows, 'skyClip');
    assert.equal(clip.mask, 'sky-coverage', name);
    assert.ok(clip.detail.pixels > 0 && clip.pass, `${name}: ${JSON.stringify(clip)}`);
  }
  console.log(
    `ok window-snow: sky share ${Object.entries(probes)
      .map(([n, p]) => `${n} ${(100 * p.share).toFixed(1)} %`)
      .join(', ')}`,
  );
}
{
  const { manifest, probes } = await render('orrery-dolly');
  assert.equal(manifest.skyCoverage, false, 'the orrery has no sky');
  for (const [name, p] of Object.entries(probes)) {
    assert.equal(p.share, null, name);
    // The same rows as the checks over the bare frame with the shot's bounds: nothing changed for a page with no sky.
    const bare = checkProbe({ name, frame: p.frame }, manifest.header.lookBounds);
    for (const check of ['skyClip', 'lights']) {
      const { mask: _, ...measured } = row(p.rows, check),
        { mask: __, ...expected } = row(bare, check);
      assert.deepEqual(measured, expected, `${name} ${check}`);
    }
    assert.equal(row(p.rows, 'skyClip').mask, 'frame', name);
  }
  console.log(
    `ok orrery: no sky coverage; lights ${Object.values(probes)
      .map((p) => row(p.rows, 'lights').value)
      .join(', ')}`,
  );
}
console.log('shot tool sky coverage check passed');
