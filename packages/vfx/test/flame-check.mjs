// Real-GPU proof of the flame settings of @margoengine/vfx/settings and of the flame volume of @margoengine/vfx/flame (run
// from the repository root after building packages; MARGO_COMPAT=1 for the WebGL2 layer):
//   node scripts/run-with-timeout.mjs -- node packages/vfx/test/flame-check.mjs [--only big,puff] [--dist /path] [--shot <dir>]
// `--dist` loads Flame from another build served under the repository (the proof that a bound fails on older code);
// every step runs and each failure is listed, then the run exits 1. See flame-check.html for what each step measures.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined),
  only = arg('--only')?.split(','),
  dist = arg('--dist'),
  url = 'http://127.0.0.1:5293/packages/vfx/test/flame-check.html' + (dist ? `?dist=${encodeURIComponent(dist)}` : ''),
  context = await openBrowser({ startPath: '/packages/vfx/test/flame-check.html', port: 5293 }),
  { page, hardware } = context,
  pageErrors = [],
  failures = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const near = (measured, expected, share) => Math.abs(measured - expected) <= share * expected;
async function step(name, run) {
  if (only && !only.includes(name)) return;
  try {
    await run();
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
try {
  console.log(
    'adapter',
    JSON.stringify(hardware.webgpu),
    hardware.compat ? '(WebGL2 compatibility)' : '',
    dist ? `Flame from ${dist}` : '',
  );
  await page.goto(url);
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  await step('defaults', async () => {
    const d = await page.evaluate(() => window.check.defaults());
    assert.deepEqual(d.errors, []);
    assert.equal(d.differing, 0, `the default rows change the frame: ${JSON.stringify(d)}`);
    assert.ok(d.lit > 100, `the fire shows: ${JSON.stringify(d)}`);
    console.log(`ok flame defaults frame exact; the fire covers ${d.lit} pixels`);
  });
  await step('scene', async () => {
    const r = await page.evaluate(() => window.check.scene());
    assert.deepEqual(r.errors, []);
    assert.ok(r.open > 500, `the flame shows over the captured depth: ${JSON.stringify(r)}`);
    assert.ok(r.hidden < 0.05 * r.open, `a wall in front hides it: ${JSON.stringify(r)}`);
    console.log(`ok flame over a captured depth in fog: ${r.open} flame pixels, ${r.hidden} behind a wall`);
  });
  await step('look', async () => {
    const l = await page.evaluate(() => window.check.look());
    assert.deepEqual(l.errors, []);
    assert.ok(l.differing > 200, `the animatedFeature look moves the frame: ${JSON.stringify(l)}`);
    assert.ok(l.litStyled > 100, `the styled fire still shows: ${JSON.stringify(l)}`);
    console.log(`ok flame look: ${l.differing} values differ, lit ${l.litPlain} -> ${l.litStyled}`);
  });
  await step('live', async () => {
    const live = await page.evaluate(() => window.check.live());
    assert.deepEqual(live.errors, []);
    assert.deepEqual(
      live.made,
      { pipelines: 0, buffers: 0, textures: 0 },
      `60 frames of every row made GPU objects: ${JSON.stringify(live)}`,
    );
    console.log(`ok hearth flame settings: ${live.rows} live rows for 60 frames made no pipeline, buffer or texture`);
  });
  await step('big', async () => {
    for (const [peak, rows] of [
      [0.5, false],
      [1, false],
      [1, true],
    ]) {
      const b = await page.evaluate(([p, r]) => window.check.big(p, r), [peak, rows]);
      assert.deepEqual(b.errors, []);
      assert.ok(b.lit > 1500, `an 8 m flame fills the frame: ${JSON.stringify(b)}`);
      assert.ok(
        b.top <= b.limit + 1,
        `no pixel over the stated peak ${peak} (channel ${b.limit}): the brightest is ${b.top}`,
      );
      assert.equal(
        b.white,
        0,
        `no pixel blows out to white (15 frames, ${rows ? 'every row at its hottest' : 'default rows'}): ${JSON.stringify(b)}`,
      );
      if (!rows) {
        const [r, g, bl] = b.core;
        assert.ok(b.top >= b.limit - 16, `the core reaches the peak (channel ${b.limit}): the brightest is ${b.top}`);
        assert.ok(
          g >= 0.75 * r && bl < r,
          `the core reads yellow-white, not orange or white: ${JSON.stringify(b.core)}`,
        );
      }
      console.log(
        `ok large flame at peak ${peak}${rows ? ', every row at its hottest' : ''}: ${b.lit} pixels, brightest ${b.top} of ${b.limit}, core ${b.core}, no white`,
      );
    }
  });
  await step('puff', async () => {
    const p = await page.evaluate(() => window.check.puff());
    assert.deepEqual(p.errors, []);
    assert.ok(
      near(p.measured, p.expected, 0.15),
      `the flame puffs at 1.5 D^(-1/2) = ${p.expected.toFixed(3)} Hz (Cetegen and Ahmed 1993): measured ${p.measured.toFixed(3)} Hz`,
    );
    console.log(`ok puffing ${p.measured.toFixed(3)} Hz against Cetegen and Ahmed's ${p.expected.toFixed(3)} Hz`);
  });
  await step('height', async () => {
    const h = await page.evaluate(() => window.check.height());
    assert.deepEqual(h.errors, []);
    assert.ok(
      near(h.height, h.expected, 0.15),
      `flame shows half the time up to Heskestad's ${h.expected.toFixed(2)} m: measured ${h.height.toFixed(2)} m`,
    );
    console.log(`ok mean flame height ${h.height.toFixed(2)} m against Heskestad's ${h.expected.toFixed(2)} m`);
  });
  await step('lights', async () => {
    const l = await page.evaluate(() => window.check.lights());
    assert.deepEqual(l.errors, []);
    assert.ok(l.count >= 1, `the flame makes lights: ${JSON.stringify(l)}`);
    assert.ok(l.groundLit > l.groundDark + 6, `the flame lights the ground in front of it: ${JSON.stringify(l)}`);
    assert.ok(l.lightSwing > 0.2 && l.groundSwing > 2, `the light flickers on the ground: ${JSON.stringify(l)}`);
    assert.ok(
      near(l.flicker, l.expected, 0.15),
      `the light flickers at the puffing frequency ${l.expected.toFixed(3)} Hz: ${l.flicker.toFixed(3)} Hz`,
    );
    console.log(
      `ok flame light: ground ${l.groundDark.toFixed(1)} -> ${l.groundLit.toFixed(1)}, swing ${(100 * l.lightSwing).toFixed(0)}%, flicker ${l.flicker.toFixed(3)} Hz`,
    );
  });
  await step('rows', async () => {
    const r = await page.evaluate(() => window.check.rows());
    assert.deepEqual(r.errors, []);
    assert.deepEqual(
      r.made,
      { pipelines: 0, buffers: 0, textures: 0 },
      `90 frames of every row on a Flame and a large Fire made GPU objects: ${JSON.stringify(r)}`,
    );
    console.log(`ok ${r.rows} flame rows on a lit Flame and Fire for 90 frames made no pipeline, buffer or texture`);
  });
  await step('fire', async () => {
    const f = await page.evaluate(() => window.check.fire());
    assert.deepEqual(f.errors, []);
    assert.ok(
      f.lit > 1500 && f.white === 0 && f.length === 10,
      `a 10 m Fire shows and does not blow out: ${JSON.stringify(f)}`,
    );
    console.log(`ok Fire flameLength 10: ${f.lit} pixels, brightest channel ${f.top}, no white`);
  });
  await step('front', async () => {
    const fr = await page.evaluate(() => window.check.front());
    assert.deepEqual(fr.errors, []);
    assert.deepEqual(
      fr.made,
      { pipelines: 0, buffers: 0, textures: 0 },
      `a moving front made GPU objects: ${JSON.stringify(fr)}`,
    );
    assert.equal(fr.pool, 8);
    assert.ok(fr.maxLength > 3 && fr.houses > 3, `the volumes took lengths from the fire: ${JSON.stringify(fr)}`);
    assert.ok(fr.lit > 300 && fr.white === 0, `the front draws flames: ${JSON.stringify(fr)}`);
    assert.ok(fr.litLights > 0, `the front's flames give light: ${JSON.stringify(fr)}`);
    console.log(
      `ok fire front: ${fr.pool} volumes for 150 frames made no pipeline, buffer or texture; front ${fr.maxLength.toFixed(1)} m, houses ${fr.houses.toFixed(1)} m, ${fr.litLights} lights on, ${fr.lit} pixels`,
    );
  });
  // KB-FLAME-LOOK2: the large-flame look against USFS photos of house and crown fires. Bounds sit between the old
  // build (--dist of a27c64b8a3: 8.5 px edges, detail 0.056, one slab with a 5 px foot) and this one; `graded` pins the
  // flame under the animatedFeature bloom and tonemap at flames.peak 4.
  await step('edges', async () => {
    const e = await page.evaluate(() => window.check.edges());
    assert.deepEqual(e.errors, []);
    assert.ok(e.crossings > 300, `the flame has edges to measure: ${JSON.stringify(e)}`);
    assert.ok(
      e.width <= 6.5,
      `tongue edges cross from 10% to 60% within 6.5 px (a blurred rim took 8.5): ${e.width.toFixed(2)} px`,
    );
    assert.ok(
      e.detail >= 0.1,
      `the tongues carry fine wisps (mean |Laplacian| over mean at least 0.1; the soft flame had 0.056): ${e.detail.toFixed(3)}`,
    );
    console.log(
      `ok flame edges: ${e.width.toFixed(2)} px from 10% to 60%, detail ${e.detail.toFixed(3)} (${e.crossings} crossings)`,
    );
  });
  await step('grazing', async () => {
    const g = await page.evaluate(() => window.check.grazing());
    assert.deepEqual(g.errors, []);
    assert.ok(g.lit > 2000, `the end-on front shows: ${JSON.stringify(g)}`);
    assert.equal(g.differing, 0, `a frame drawn again at the same clock is the same picture: ${JSON.stringify(g)}`);
    console.log(`ok grazing front: ${g.lit} pixels, the same picture at the same clock`);
  });
  await step('crown', async () => {
    const c = await page.evaluate(() => window.check.crown());
    assert.deepEqual(c.errors, []);
    assert.ok(
      c.runs >= 2,
      `a crown fire shows separate torching trees low down, not one slab: ${c.runs.toFixed(1)} columns`,
    );
    assert.ok(
      c.spread >= 8,
      `its foot is ragged (the lowest flame row varies by at least 8 px; the slab's by 5): ${c.spread.toFixed(1)} px`,
    );
    console.log(
      `ok crown fire: foot spread ${c.spread.toFixed(1)} px, ${c.runs.toFixed(1)} columns, height ${c.height.toFixed(0)} px`,
    );
  });
  await step('graded', async () => {
    const g = await page.evaluate(() => window.check.graded());
    assert.deepEqual(g.errors, []);
    const [r, gr, b] = g.glow.core;
    assert.ok(
      g.glow.lit >= 1.25 * g.plain.lit,
      `the animatedFeature bloom makes the core glow (lit pixels up at least 25%): ${g.plain.lit} -> ${g.glow.lit}`,
    );
    assert.ok(
      Math.max(r, gr, b) >= 210 && gr >= 0.75 * r && b < r,
      `the graded core is a bright yellow-white: ${g.glow.core}`,
    );
    assert.equal(g.glow.white, 0, `no pixel turns white under bloom and tonemap: ${JSON.stringify(g.glow)}`);
    console.log(
      `ok animatedFeature graded: lit ${g.plain.lit} -> ${g.glow.lit} with bloom, core ${g.glow.core}, no white`,
    );
  });
  await step('shadow', async () => {
    const r = await page.evaluate(() => window.check.shadow());
    assert.deepEqual(r.errors, [], 'no GPU error');
    assert.deepEqual(r.lights, [4, 1], 'one shadowed light');
    assert.ok(r.open > r.shadowed + 20, `the wall stops the shadowed fire's light: ${JSON.stringify(r)}`);
    console.log(
      `ok fire shadow: ground behind the wall ${r.open.toFixed(1)} unshadowed, ${r.shadowed.toFixed(1)} shadowed`,
    );
  });
  await step('veil', async () => {
    const v = await page.evaluate(() => window.check.veil());
    assert.deepEqual(v.errors, []);
    assert.ok(
      v.own.smoke && !v.behind.smoke,
      `a fire with a flame length stands a smoke column by default: ${JSON.stringify(v)}`,
    );
    assert.ok(v.own.clear > 2000 && v.behind.clear > 2000, `the house fire shows: ${JSON.stringify(v)}`);
    assert.ok(
      v.own.smoked >= 0.9 * v.own.clear,
      `its smoke leaves the flame as bright (at least 90% of the bright pixels): ${v.own.clear} -> ${v.own.smoked}`,
    );
    assert.ok(
      v.behind.smoked >= 0.95 * v.behind.clear,
      `a dark smoke column behind the flame does not cover it (at least 95%): ${v.behind.clear} -> ${v.behind.smoked}`,
    );
    console.log(
      `ok smoke over a house fire: bright pixels ${v.own.clear} -> ${v.own.smoked} under its own column, ${v.behind.clear} -> ${v.behind.smoked} with a dark column behind`,
    );
  });
  await step('stand', async () => {
    const r = await page.evaluate(() => window.check.stand());
    assert.deepEqual(r.errors, []);
    assert.ok(r.level > 300, `the level line shows: ${JSON.stringify(r)}`);
    assert.ok(
      r.slope >= 0.8 * r.level,
      `a line on a 30 percent slope stands on it (flame pixels at least 0.8 of level): ${JSON.stringify(r)}`,
    );
    console.log(`ok flames stand on the slope: ${r.level} flame pixels level, ${r.slope} on the slope`);
  });
  await step('glow', async () => {
    const r = await page.evaluate(() => window.check.glow());
    assert.deepEqual(r.errors, []);
    assert.ok(
      r.on.ground > r.off.ground + 3,
      `the flame lights the ground around it with no lights given: ${JSON.stringify(r)}`,
    );
    assert.ok(r.on.air > r.off.air + 1, `the air over the flame glows: ${JSON.stringify(r)}`);
    console.log(
      `ok flame glow: ground ${r.off.ground.toFixed(1)} -> ${r.on.ground.toFixed(1)}, air ${r.off.air.toFixed(1)} -> ${r.on.air.toFixed(1)}`,
    );
  });
  await step('order', async () => {
    const r = await page.evaluate(() => window.check.order());
    assert.deepEqual(r.errors, []);
    assert.ok(r.clear > 1000, `the flame shows: ${JSON.stringify(r)}`);
    assert.ok(r.front <= 0.7 * r.clear, `a dark column in front of the flame covers it: ${JSON.stringify(r)}`);
    assert.ok(r.behind >= 0.95 * r.clear, `a dark column behind the flame does not: ${JSON.stringify(r)}`);
    console.log(
      `ok draw order: flame pixels ${r.clear} clear, ${r.front} behind a column in front, ${r.behind} with one behind`,
    );
  });
  // --shot <folder> also saves a picture of each large flame (for a person to judge; not a check).
  const folder = arg('--shot');
  if (folder) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(folder, { recursive: true });
    for (const kind of ['house', 'crown', 'grazing', 'front'])
      writeFileSync(
        `${folder}/flame-${kind}${hardware.compat ? '-compat' : ''}.png`,
        Buffer.from(await page.evaluate((k) => window.check.shot(k), kind), 'base64'),
      );
    console.log(`pictures saved in ${folder}`);
  }
  if (pageErrors.length) {
    failures.push('page errors');
    console.log(`FAIL page errors: ${JSON.stringify(pageErrors)}`);
  }
  if (failures.length) {
    console.log(`flame check failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else console.log('flame check passed');
} finally {
  await context.close();
}
