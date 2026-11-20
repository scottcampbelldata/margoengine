// The shot tool's look checks (tools/shot/look.mjs, P4): checkShot of @margoengine/headless/look over the probes a
// manifest names, with the shot file's lookBounds, its report written beside manifest.json, and one console line per
// failing check. A probe that is mostly black under a flat grey band is crushed and flat, so it fails both by default
// and passes once lookBounds widens them; a probe with the camera's view-projection and a sky mask gets the horizon
// seam check, and one with no sky mask (an interior: the line runs across walls) does not. No browser and no GPU.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePNG } from '@margoengine/headless';
import { decodePNG } from '@margoengine/headless/compare';
import { LOOK_FILES, lookFailures, lookShot } from '../tools/shot/look.mjs';

const WIDTH = 192,
  HEIGHT = 320,
  // Rows 0 to GREY - 1 are a constant grey (flat, but not black), the rest black (crushed); the horizon of the
  // second test is the middle row, inside the black, so there is no seam there.
  GREY = 100;

async function shotFolder(lookBounds, probe = {}) {
  const out = mkdtempSync(join(tmpdir(), 'margo-shot-look-'));
  mkdirSync(join(out, 'probes'));
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < data.length; i += 4) {
    if (i / 4 < WIDTH * GREY) data.fill(128, i, i + 3);
    data[i + 3] = 255;
  }
  writeFileSync(join(out, 'probes/open.png'), await encodePNG({ width: WIDTH, height: HEIGHT, data }));
  if (probe.aovs?.sky) {
    // Sky above the middle row (the horizon of a level camera), as the shot tool writes it: 8-bit grey.
    const sky = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      if (i < (WIDTH * HEIGHT) / 2) sky.fill(255, i * 4, i * 4 + 3);
      sky[i * 4 + 3] = 255;
    }
    writeFileSync(join(out, probe.aovs.sky), await encodePNG({ width: WIDTH, height: HEIGHT, data: sky }));
  }
  return { out, manifest: { id: 'look-test', header: { lookBounds }, probes: { open: { frame: 0, file: 'probes/open.png', ...probe } } } };
}

test('lookShot writes look.md, look.json and look.png, and a crushed flat probe fails by default', async () => {
  const { out, manifest } = await shotFolder({});
  try {
    const report = await lookShot(out, manifest);
    assert.equal(report.pass, false);
    for (const name of LOOK_FILES) assert.ok(existsSync(join(out, name)), `no ${name}`);
    const json = JSON.parse(readFileSync(join(out, 'look.json'), 'utf8'));
    assert.equal(json.format, 'margo-look-report');
    assert.equal(json.pass, false);
    assert.match(readFileSync(join(out, 'look.md'), 'utf8'), /\| open \| crush \|/);
    const sheet = await decodePNG(readFileSync(join(out, 'look.png')));
    assert.ok(sheet.width > 0 && sheet.height > 0, 'an empty contact sheet');
    const failures = lookFailures(report);
    assert.ok(failures.some((line) => line.startsWith(`open crush: ${(100 * (HEIGHT - GREY)) / HEIGHT} %`)), failures.join('\n'));
    assert.ok(failures.some((line) => line.startsWith('open flat: ')), failures.join('\n'));
    // No view-projection, no horizon seam row: a check without its input is left out unless lookBounds asks for it.
    assert.ok(!report.json.probes[0].results.some((row) => row.check === 'horizonSeam'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the shot file's lookBounds reach the checks, and a probe's view-projection and sky mask run the horizon seam check", async () => {
  // A camera at the origin looking down -z (identity view) with a symmetric projection: the horizon is the middle row.
  const f = 1 / Math.tan(Math.PI / 6),
    aspect = WIDTH / HEIGHT,
    viewProjection = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, -1, -1, 0, 0, -0.1, 0];
  const { out, manifest } = await shotFolder({ crush: 100, flat: 100 }, { viewProjection, aovs: { sky: 'probes/open-sky.png' } });
  const interior = await shotFolder({ crush: 100, flat: 100 }, { viewProjection });
  try {
    // No sky mask: the line may run across walls, so no horizon seam row (Cabin Hearth's mantel failed at 15.8 codes).
    const inside = await lookShot(interior.out, interior.manifest);
    assert.ok(!inside.json.probes[0].results.some((row) => row.check === 'horizonSeam'));
    const report = await lookShot(out, manifest);
    assert.deepEqual(lookFailures(report), []);
    assert.equal(report.pass, true);
    const rows = report.json.probes[0].results;
    // A bound given as one number is the highest value, with no lowest (lookBound).
    assert.deepEqual(rows.find((row) => row.check === 'crush').bound, [-Infinity, 100]);
    const seam = rows.find((row) => row.check === 'horizonSeam');
    assert.ok(seam && seam.pass, JSON.stringify(seam));
    assert.equal(JSON.parse(readFileSync(join(out, 'look.json'), 'utf8')).pass, true);
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(interior.out, { recursive: true, force: true });
  }
});

test("a probe's own lookBounds replace the shot's for the checks it names, on that probe only", async () => {
  // The shot passes crush and flat; this probe's own crush bound (0 %) fails its 69 % of black, flat keeps the shot's.
  const { out, manifest } = await shotFolder({ crush: 100, flat: 100 }, { lookBounds: { crush: 0 } });
  try {
    manifest.probes.late = { frame: 0, file: 'probes/open.png' };
    const report = await lookShot(out, manifest),
      [open, late] = report.json.probes;
    assert.deepEqual(lookFailures(report), [`open crush: ${(100 * (HEIGHT - GREY)) / HEIGHT} %, bound -Infinity to 0`]);
    assert.deepEqual(open.results.find((row) => row.check === 'crush').bound, [-Infinity, 0]);
    assert.deepEqual(open.results.find((row) => row.check === 'flat').bound, [-Infinity, 100], "the shot's flat bound");
    assert.deepEqual(late.results.find((row) => row.check === 'crush').bound, [-Infinity, 100], 'the other probe keeps the shot bound');
    assert.equal(report.pass, false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a lookBounds name that no check has fails the look, naming it', async () => {
  const { out, manifest } = await shotFolder({ crush: 100, flat: 100, glare: 1 });
  try {
    const report = await lookShot(out, manifest);
    assert.equal(report.pass, false);
    assert.ok(lookFailures(report).some((line) => line.startsWith('open glare: needs a check named glare')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a probe whose sky mask holds no sky says skyClip measured 0 sky pixels (KB-HEARTH-CLIP1)', async () => {
  // An interior frame: its top half clips (a fire), and its sky mask says nothing of it is sky.
  const { out, manifest } = await shotFolder({ skyClip: 0.5 }, { aovs: { none: 'probes/open.sky.png' } });
  try {
    const frame = new Uint8Array(WIDTH * HEIGHT * 4).fill(255),
      none = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let i = 3; i < none.length; i += 4) none[i] = 255;
    writeFileSync(join(out, 'probes/open.png'), await encodePNG({ width: WIDTH, height: HEIGHT, data: frame }));
    writeFileSync(join(out, 'probes/open.sky.png'), await encodePNG({ width: WIDTH, height: HEIGHT, data: none }));
    manifest.probes.open.aovs = { sky: 'probes/open.sky.png' };
    const report = await lookShot(out, manifest),
      row = report.json.probes[0].results.find((result) => result.check === 'skyClip');
    assert.equal(row.value, 0);
    assert.equal(row.pass, true);
    assert.equal(row.empty, '0 sky pixels');
    assert.match(readFileSync(join(out, 'look.md'), 'utf8'), /\| open \| skyClip \| 0 % \| <= 0\.500 % \| pass \(measured 0 sky pixels\) \|/);
    // The same frame without the sky mask counts the whole frame, and it fails.
    delete manifest.probes.open.aovs;
    assert.equal((await lookShot(out, manifest)).json.probes[0].results.find((result) => result.check === 'skyClip').pass, false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('with no sky mask, skyClip measures inside the sky coverage and look.md says so (KB-HEARTH-CLIP1 part 2)', async () => {
  // The probe's grey band (rows 0 to GREY - 1) is 128, so nothing clips; make its top rows clip, as a flame would, and
  // give a coverage mask of the black rows only (the window), so the flame is not counted.
  const { out, manifest } = await shotFolder({ crush: 100, flat: 100, skyClip: 0.5 });
  try {
    const frame = await decodePNG(readFileSync(join(out, 'probes/open.png')));
    frame.data.fill(255, 0, WIDTH * 10 * 4);
    writeFileSync(join(out, 'probes/open.png'), await encodePNG(frame));
    const bare = (await lookShot(out, manifest)).json.probes[0].results.find((row) => row.check === 'skyClip');
    assert.equal(bare.mask, 'frame');
    assert.equal(bare.pass, false, 'over the whole frame the flame rows clip');
    const sky = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      if (i >= WIDTH * GREY) sky.fill(255, i * 4, i * 4 + 3);
      sky[i * 4 + 3] = 255;
    }
    writeFileSync(join(out, 'probes/open.sky-coverage.png'), await encodePNG({ width: WIDTH, height: HEIGHT, data: sky }));
    manifest.probes.open.aovs = { 'sky-coverage': 'probes/open.sky-coverage.png' };
    const report = await lookShot(out, manifest),
      row = report.json.probes[0].results.find((result) => result.check === 'skyClip');
    assert.equal(row.mask, 'sky-coverage');
    assert.equal(row.value, 0);
    assert.equal(row.detail.pixels, WIDTH * (HEIGHT - GREY));
    assert.match(readFileSync(join(out, 'look.md'), 'utf8'), /\nMasks:\n- skyClip inside `sky-coverage`, the pixels `@margoengine\/sky` drew \(no page sky mask\): open\n/);
    // lights and grain do not read it: the same rows as with no mask.
    for (const check of ['lights', 'grain'])
      assert.deepEqual(
        report.json.probes[0].results.find((result) => result.check === check),
        (await lookShot(out, { ...manifest, probes: { open: { ...manifest.probes.open, aovs: {} } } })).json.probes[0].results.find((result) => result.check === check),
        check,
      );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
