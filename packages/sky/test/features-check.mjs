// Real-GPU proof of the newer optional sky entries (run from the repository root after building packages, one GPU job
// at a time): node packages/sky/test/features-check.mjs [name...]
// Each page compiles its entry's shaders on the browser's WebGPU and reads back Bloom's HDR scene capture; the bounds
// below are what each feature must do, not a picture match.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
const TABLE_TOLERANCE = 0.005;
// The cloud sheet's bounds (sheet-check.html, 2026-11-26 on the workstation): with the adiabatic profile steps 0.0004
// and spread 0.53; the flat stains before it measured steps 0.0050 and spread 0.43.
const SHEET_STEPS_MAX = 0.0015;
const SHEET_SPREAD_MIN = 0.48;
const checks = {
  // Rain shafts under a deck (rain; rain-shaft-check.html): optical depth against the CPU twin's integral.
  async 'rain-shaft'(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    const s = JSON.stringify(r);
    // Each ray's optical depth is the CPU integral of Marshall and Palmer's extinction of the twin's rate: within 5% on
    // average and summed, in still air, in wind (the trail), for a moving cell after 60 s and drawn by two linked layers.
    for (const k of ['still', 'wind', 'moved', 'split']) {
      const c = r[k];
      assert.ok(c.pixels > 100 && c.peak > 0.5, `${k}: the shaft is in view (${s})`);
      assert.ok(c.meanError < 0.05 && Math.abs(c.ratio - 1) < 0.05, `${k}: depth is the CPU integral (${s})`);
      assert.ok(c.thin < 0.01, `${k}: thin rain is the CPU transmittance within 0.01 (${s})`);
    }
    assert.ok(r.wind.mid < 0.5 * r.still.mid, `the wind carries the shaft out of the still-air line of sight (${s})`);
    assert.ok(r.miss.pixels === 0 && r.miss.thin < 0.01 && r.miss.mean > 0.99, `a ray beside the cell is clear (${s})`);
    assert.ok(r.empty.mean > 0.01 && r.empty.differing === 0, `no cells: the frame bit for bit (${s})`);
    assert.ok(r.lamps.dark === 0 && r.lamps.lit > 1e-4, `a city under the shaft lights it by night (${s})`);
    assert.ok(r.day > 1e-3, `by day the shaft is lit (${s})`);
    assert.ok(r.streaks.opacity > 0.2 && r.streaks.contrast > 0.08, `streaks break the shaft into curtains (${s})`);
    console.log(`ok rain-shaft ${samples}x: ${s}`);
    return r;
  },
  // Low scud under a rain deck (type 'scud' with above; scud-check.html).
  async scud(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    const s = JSON.stringify(r);
    // From the gap between the layers looking up, the scud under the camera leaves the deck's frame bit for bit.
    assert.ok(r.gap.deck > 0.1, `the deck is in the view (${s})`);
    assert.equal(r.gap.differing, 0, `the deck alone and with scud under the camera, bit for bit (${s})`);
    assert.equal(r.gap.mistDiffering, 0, `the same with the deck's mist (${s})`);
    // Looking down from the gap the scud is there, the deck alone draws nothing below the camera.
    assert.equal(r.down.deck, 0, `the deck draws nothing below the camera (${s})`);
    assert.ok(r.down.share > 0.1, `the scud shows in its altitude band (${s})`);
    // The covered share (opacity over 0.1) follows coverage, and the torn edges: per covered pixel at least twice the
    // edge of a cumulus layer at the same height and scale covering no more of the sky.
    for (const c of r.cover.scud) assert.ok(Math.abs(c.share - c.coverage) < 0.1, `covered share follows coverage (${s})`);
    assert.ok(r.cover.cumulus[0].share <= r.cover.scud[0].share + 0.02, `matched shares (${s})`);
    assert.ok(r.cover.scud[0].edge >= 2 * r.cover.cumulus[0].edge, `ragged edges at cover 0.2 (${s})`);
    assert.ok(r.cover.scud[1].edge >= 2 * r.cover.cumulus[1].edge, `ragged edges at cover 0.35 (${s})`);
    // The scud moves with its wind: the time-0 frame from a camera moved by wind times time matches best.
    assert.ok(r.drift.wind < r.drift.half && r.drift.wind < r.drift.double, `the shapes move at the wind (${s})`);
    assert.ok(r.drift.wind < 0.6 * r.drift.still, `the shapes moved (${s})`);
    assert.ok(r.lamps.toward > 3 * r.lamps.away, `by night the scud is brightest toward the city (${s})`);
    assert.ok(r.pannus.pixels > 1000 && r.pannus.scud < 0.95 * r.pannus.deck, `pannus is darker than the base (${s})`);
    // In the mist each scud pixel is its clear-air light times exp(-k s) to its base.
    assert.ok(r.mist.pixels > 1000 && r.mist.meanError < 0.01 && r.mist.worst < 0.02, `mist dims the scud (${s})`);
    console.log(`ok scud ${samples}x: ${s}`);
    return r;
  },
  // The cloud base lit from below by lit ground and the mist under it (groundLights and mist; ground-light-check.html).
  async 'ground-light'(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    const s = JSON.stringify(r);
    assert.ok(r.dark.mean < 0.05 * r.overhead.mean, `no sun, no sky light, no ground light: a black deck (${s})`);
    assert.ok(r.toward.mean > 4 * r.away.mean, `the deck is brightest toward the city (${s})`);
    assert.ok(r.overhead.spread > 0.15, `the lit base shows its structure, gaps darker (${s})`);
    assert.ok(r.toward.warm > 3 && r.toward.warm < 4.4, `the base takes the light's colour, red over blue 4 (${s})`);
    assert.ok(r.mistToward.mean > 2 * r.mistAway.mean, `the low mist glows toward the city (${s})`);
    assert.ok(r.mistToward.mean > r.clearToward.mean, `the mist adds its light over the low sky (${s})`);
    // One law for one light: a disc wider than the sky lights the deck as the even light from below does.
    assert.ok(Math.abs(r.wide.mean / r.uniform.mean - 1) < 0.02, `a wide disc is the even ground light (${s})`);
    console.log(`ok ground-light ${samples}x: ${s}`);
    return r;
  },
  // The broken cloud sheet thins to its rims and shades within (KB-SKY-HOLES-KH1; sheet-check.html).
  async sheet(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.ok(r.cloud > 0.1 && r.cloud < 0.9, `coverage 0.4 shows broken cloud: ${JSON.stringify(r)}`);
    assert.ok(
      r.steps < SHEET_STEPS_MAX,
      `the elements thin toward their rims, with no hard edge: ${JSON.stringify(r)}`,
    );
    assert.ok(r.spread > SHEET_SPREAD_MIN, `the elements shade within, not flat stains: ${JSON.stringify(r)}`);
    console.log(`ok sheet ${samples}x: ${JSON.stringify(r)}`);
    return r;
  },
  async weather(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    assert.ok(r.rainChanged > 200, `rain changed ${r.rainChanged} of ${r.pixels} pixels`);
    assert.ok(r.snowChanged > 200, `snow changed ${r.snowChanged} of ${r.pixels} pixels`);
    assert.equal(r.afterNone, 0, 'precipitation none draws nothing');
    assert.equal(r.dry, 0, 'intensity 0 draws nothing');
    assert.ok(r.flashGain > 0, `the flash lit the frame: ${JSON.stringify(r)}`);
    assert.equal(r.afterFlash, 0, 'the frame returns to dry after the flash');
    // Rain over the sky under TAA (2026-11-13: once the sky kept history for the volumetric clouds, TAA averaged the
    // streaks over it away): the mean brightness the streaks add over the dark sky, in sRGB levels, with the weather's
    // reactive mask that TAA reads by itself (no wiring, KB-TAA-PARTICLEMASK1) and with the mask off. Without the fix
    // both are the plain one.
    await page.evaluate(() => window.taaRain.frames(40));
    assert.deepEqual(await page.evaluate(() => window.taaRain.masks()), { plainTaa: false, maskedTaa: true });
    const streaks = {};
    for (const id of ['plain', 'masked']) {
      const image = await decodePNG(await page.locator(`#rain-taa-${id}`).screenshot());
      const levels = [];
      for (let i = 0; i < image.data.length; i += 4)
        levels.push((image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3);
      const sky = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.2)];
      let lift = 0;
      for (const level of levels) lift += Math.max(0, level - sky - 2);
      streaks[id] = lift / levels.length;
    }
    r.taaStreaks = streaks;
    assert.deepEqual(await page.evaluate(() => window.taaRain.errors()), []);
    assert.ok(streaks.masked > 0.3, `the rain shows over the sky under TAA with the mask (${JSON.stringify(streaks)})`);
    assert.ok(
      streaks.masked > 2 * streaks.plain,
      `the mask keeps the streaks TAA averages away (${JSON.stringify(streaks)})`,
    );
    console.log(
      `ok weather ${samples}x: rain ${r.rainChanged}, snow ${r.snowChanged}, lightning and dry reset; TAA streaks ${JSON.stringify(streaks)}`,
    );
    return r;
  },
  // Lightning that lights with no wiring (elements plan step 7; lightning-link-check.html).
  async 'lightning-link'(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    const near = (a, b) => Math.abs(a - b) <= 0.02 * Math.max(a, b, 1e-6);
    assert.ok(
      r.light.intensity > 0 && r.light.shadow,
      `the held flash lists a shadowed light: ${JSON.stringify(r.light)}`,
    );
    assert.ok(r.light.group.includes('lightning'), 'the weather made its own light group');
    assert.equal(r.deckFlash, true, 'the deck took the flash');
    assert.ok(
      r.lit.ground > 1.5 * r.dark.ground + 1e-4,
      `the ground flashes: ${JSON.stringify({ dark: r.dark, lit: r.lit })}`,
    );
    assert.ok(
      r.lit.deck > 1.2 * r.dark.deck + 1e-4,
      `the deck lights from inside: ${JSON.stringify({ dark: r.dark, lit: r.lit })}`,
    );
    assert.ok(
      near(r.noLights.ground, r.dark.ground),
      `link.lights false leaves the ground: ${JSON.stringify(r.noLights)}`,
    );
    assert.ok(r.noLights.deck > 1.2 * r.dark.deck + 1e-4, 'link.lights false still lights the deck');
    assert.ok(
      near(r.off.ground, r.dark.ground) && near(r.off.deck, r.dark.deck),
      `link false changes nothing: ${JSON.stringify(r.off)}`,
    );
    assert.equal(r.offFlash, true, 'link false takes the flash out of the deck');
    // The settings rows through applySkySettings (the sky re-applied at its defaults, so compared with rows.base, the same
    // frame with no flash): a light scale of 0 puts the ground's light out, a deck scale of 0 the deck's, null hands back.
    const w = r.rows;
    assert.ok(
      w.full.ground > 1.5 * w.base.ground && w.full.deck > 1.2 * w.base.deck,
      `rows at their defaults flash: ${JSON.stringify(w)}`,
    );
    assert.ok(
      w.lightOff.ground < 0.5 * w.full.ground && w.lightOff.deck > 1.2 * w.base.deck,
      `lightning.light.scale 0: ${JSON.stringify(w)}`,
    );
    assert.ok(
      w.cloudOff.deck < 0.7 * w.full.deck && w.cloudOff.ground > 1.5 * w.base.ground,
      `lightning.cloud.scale 0: ${JSON.stringify(w)}`,
    );
    assert.equal(w.noShadowMap, null, 'lightning.light.shadow off asks for no map');
    assert.ok(w.noShadow.ground > 1.5 * w.base.ground, `lightning.light.shadow off still lights: ${JSON.stringify(w)}`);
    assert.ok(
      near(w.handedBack.ground, w.full.ground) && near(w.handedBack.deck, w.full.deck),
      `the defaults give the lit frame back: ${JSON.stringify(w)}`,
    );
    console.log(`ok lightning-link ${samples}x: ${JSON.stringify({ dark: r.dark, lit: r.lit, noLights: r.noLights })}`);
    return r;
  },
  // The drawn bolt and the light along its channel (lightning-bolt-check.html).
  async 'lightning-bolt'(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    await mkdir('test-results', { recursive: true });
    await page.locator('canvas').screenshot({ path: `test-results/lightning-bolt-${samples}x.png` });
    assert.equal(r.none.bright, 0, `no bolt without a flash: ${JSON.stringify(r.none)}`);
    assert.ok(r.bolt.bright > 40 && r.bolt.max > 20, `the bolt is drawn bright: ${JSON.stringify(r.bolt)}`);
    assert.ok(r.bolt.rows > 0.2 * r.bolt.h, `it runs down a good part of the frame: ${JSON.stringify(r.bolt)}`);
    assert.ok(
      r.bolt.bright < 0.1 * r.bolt.h * r.bolt.h * 1.78,
      `it is a thin line, not a wash: ${JSON.stringify(r.bolt)}`,
    );
    assert.ok(
      r.again.bright === r.bolt.bright && r.again.rows === r.bolt.rows && Math.abs(r.again.sum / r.bolt.sum - 1) < 1e-4,
      `the same held flash draws the same frame: ${JSON.stringify({ again: r.again, bolt: r.bolt })}`,
    );
    assert.ok(
      r.dim.sum < r.bolt.sum && r.dim.max < r.bolt.max,
      `a dimmer flash is dimmer: ${JSON.stringify({ dim: r.dim, bolt: r.bolt })}`,
    );
    assert.equal(r.off.bright, 0, `bolt.scale 0 draws no bolt: ${JSON.stringify(r.off)}`);
    assert.ok(
      r.coreOnly.sum < r.bolt.sum && r.bolt.sum > r.off.sum,
      `glow 0 leaves the core alone: ${JSON.stringify({ core: r.coreOnly, bolt: r.bolt })}`,
    );
    assert.ok(
      r.wideGlow.sum > r.bolt.sum,
      `a wider glow lights more of the frame: ${JSON.stringify({ wide: r.wideGlow, bolt: r.bolt })}`,
    );
    assert.ok(
      r.fat.bright > r.bolt.bright,
      `a wider core covers more pixels: ${JSON.stringify({ fat: r.fat, bolt: r.bolt })}`,
    );
    assert.ok(
      r.forked.bright > r.plain.bright,
      `branching adds forks: ${JSON.stringify({ forked: r.forked, plain: r.plain })}`,
    );
    assert.ok(
      r.hidden.bright < 0.05 * r.shown.bright + 1,
      `a hill in front hides the bolt: ${JSON.stringify({ hidden: r.hidden, shown: r.shown })}`,
    );
    assert.equal(r.rowOff.bright, 0, 'the scale row 0 draws no bolt');
    assert.ok(
      r.rowOn.bright > 40,
      `the rows at their defaults draw a bolt (the panel's seed and cloud base, so another one): ${JSON.stringify(r.rowOn)}`,
    );
    // The ground is lit by the lights along the channel, differently from one point light 700 m up, and by the one
    // light of a single segment (the mean of the channel) differently again.
    assert.ok(
      r.groundLine > 1.2 * r.groundDark,
      `the lights along the channel light the ground: ${JSON.stringify({ line: r.groundLine, dark: r.groundDark })}`,
    );
    assert.ok(
      r.groundPoint > 1.2 * r.groundDark,
      `the point light still lights it: ${JSON.stringify({ point: r.groundPoint, dark: r.groundDark })}`,
    );
    assert.ok(
      Math.abs(r.groundLine - r.groundPoint) > 0.01 * r.groundPoint,
      `the line is another light: ${JSON.stringify({ line: r.groundLine, point: r.groundPoint })}`,
    );
    assert.ok(
      Math.abs(r.groundOne - r.groundLine) > 0.003 * r.groundLine,
      `one segment is not three: ${JSON.stringify({ one: r.groundOne, three: r.groundLine })}`,
    );
    console.log(
      `ok lightning-bolt ${samples}x: ${JSON.stringify({ bolt: r.bolt, hidden: r.hidden.bright, ground: { dark: r.groundDark, line: r.groundLine, point: r.groundPoint } })}`,
    );
    return r;
  },
  // The channel's light scattered in the air, drawn against its CPU twin (lightning-glow-check.html).
  async 'lightning-glow'(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.validation, null);
    assert.deepEqual(r.errors, []);
    await mkdir('test-results', { recursive: true });
    await page.locator('canvas').screenshot({ path: `test-results/lightning-glow-${samples}x.png` });
    for (const name of ['open', 'hill', 'mist']) {
      const c = r[name],
        detail = `${name}: ${JSON.stringify(c)}`;
      assert.ok(c.worst < 0.03 && c.mean < 0.005, `the drawn glow is the CPU's: ${detail}`);
      assert.ok(Math.abs(c.total - 1) < 0.005, detail);
      assert.ok(c.piecesGap < 0.1, `24 pieces draw nearly what 64 do: ${detail}`);
    }
    assert.ok(r.open.kinds.sky > 20 && r.open.kinds.ground > 5, JSON.stringify(r.open.kinds));
    assert.ok(r.hill.kinds.hill > 50, JSON.stringify(r.hill.kinds));
    assert.ok(r.open.means.sky > 0.005, `the sky glows about the channel: ${JSON.stringify(r.open.means)}`);
    assert.ok(r.hill.means.hill < 0.4 * r.open.means.sky, `a hill cuts the glow: ${JSON.stringify(r.hill.means)}`);
    assert.ok(Math.abs(r.twice - 2) < 0.01, `strength 2 doubles it: ${r.twice}`);
    assert.ok(r.dark < 1e-4, `no flash, no glow: ${r.dark}`);
    console.log(`ok lightning-glow ${samples}x: ${JSON.stringify({ open: r.open, hill: r.hill, mist: r.mist })}`);
    return r;
  },
  // The clouds' bounds (elements plan step 6; cloud-bounds-check.html).
  async 'cloud-bounds'(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    // The step cap (150 m near the camera, steps growing with distance) leaves less sampling error on a low view across
    // the layer than even steps of the same count, both against a 256-step march (RTX A6000: 0.00174 against 0.00189).
    assert.ok(r.grain.capped < r.grain.even, `grain: ${JSON.stringify(r.grain)}`);
    // temporal 'auto': with a plugin named as TAA is in the scene still frames move; without, they are identical.
    assert.ok(r.temporal.taa > 0 && r.temporal.none === 0, `temporal auto: ${JSON.stringify(r.temporal)}`);
    // The sun under an overcast deck: the engine light is cloudDeckTransmittance of clear (exact up to f32);
    // dimLight false and dispose give the clear sun back.
    const d = r.deck;
    assert.ok(d.want > 0.2 && d.want < 0.7, `deck share: ${JSON.stringify(d)}`);
    assert.ok(Math.abs(d.light / d.want - 1) < 1e-4, `engine light under the deck: ${JSON.stringify(d)}`);
    assert.ok(Math.abs(d.undimmed - 1) < 1e-6 && Math.abs(d.restored - 1) < 1e-6, `undimmed: ${JSON.stringify(d)}`);
    // Each light reaches the scene once (KB-CLOUD-DECKLIGHT1; before the fix 0.93 of clear): the deck's light in the
    // scene's light map leaves out the sun the dimmed engine light already carries, so the block's sunlit top under a
    // stratus deck is the deck share of its clear level within 25% (RTX A6000: 0.53 against 0.44).
    assert.ok(Math.abs(d.block / d.want - 1) < 0.25, `block under the deck: ${JSON.stringify(d)}`);
    // Two-stream (KB-CLOUD-DECKLIGHT1; before the fix the base of thick cloud was near black, its radiance 0.067 of the
    // top's at tau 20): a full deck over a black ground with the sun overhead passes down, as diffuse light plus the
    // direct beam through its thin columns, the two-stream transmission cloudTransmission of its own columns (`want`,
    // the independent column approximation of Cahalan et al. 1994 over the base-shape field its light takes; the noise
    // leaves columns from near 0 to about twice the nominal depth, so it passes more than a plane deck of the mean),
    // and sends up the rest, each within 25% at nominal optical depths 5, 20 and 80; the two add up to the sun's
    // irradiance (the cloud neither makes nor loses light) within 15%. RTX A6000: 0.68, 0.45, 0.22 down against 0.75,
    // 0.45, 0.19.
    for (const t of r.twoStream) {
      assert.ok(
        Math.abs((t.down + t.direct) / t.want - 1) < 0.25,
        `two-stream down at tau ${t.tau}: ${JSON.stringify(t)}`,
      );
      assert.ok(Math.abs(t.up / (1 - t.want) - 1) < 0.25, `two-stream up at tau ${t.tau}: ${JSON.stringify(t)}`);
      assert.ok(Math.abs(t.sum - 1) < 0.15, `two-stream energy at tau ${t.tau}: ${JSON.stringify(t)}`);
    }
    // The moon disc outshines the deck it lights.
    assert.ok(r.moon.up > 0 && r.moon.disc > r.moon.cloud && r.moon.cloud > 0, `moon: ${JSON.stringify(r.moon)}`);
    console.log(
      `ok cloud-bounds ${samples}x: ${JSON.stringify({ grain: r.grain, deck: d, twoStream: r.twoStream, moon: r.moon })}`,
    );
    return r;
  },
  // A tornado (tornado-check.html): rays deep in the CPU funnel show lit cloud, rays that come near nothing stay black;
  // nothing before the shader loads; rope and wedge widths match the CPU's; the funnel follows its path; a weak
  // vortex's funnel hangs aloft over clear ground.
  async tornado(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    console.log(`  tornado ${samples}x ${JSON.stringify(r)}`);
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    assert.equal(r.loadedBefore, false, 'the shader is not in the entry');
    assert.equal(r.beforeReady, 0, 'nothing draws before the shader has loaded');
    for (const name of ['strong', 'wedge', 'weak']) {
      const v = r[name];
      assert.ok(v.clear > 50 && v.clearMax < 1e-4, `${name}: rays that miss the storm stay black ${JSON.stringify(v)}`);
      if (name !== 'weak')
        assert.ok(v.solid > 20 && v.solidP10 > 0.01, `${name}: the funnel is drawn and lit ${JSON.stringify(v)}`);
    }
    const near = (row, cpu, name) =>
      assert.ok(
        Math.abs(row.width - cpu) <= Math.max(2.5, 0.25 * cpu),
        `${name} funnel ${row.width} px wide, CPU ${cpu.toFixed(1)} px`,
      );
    near(r.strongRow, r.strongCpu, 'strong');
    near(r.wedgeRow, r.wedgeCpu, 'wedge');
    assert.ok(
      r.wedgeRow.width > 3 * Math.max(1, r.ropeRow.width),
      `a wedge is wider than a rope: ${JSON.stringify([r.ropeRow, r.wedgeRow])}`,
    );
    assert.ok(Math.abs(r.moved - 400) < 60, `the funnel followed its path 400 m: ${r.moved}`);
    assert.ok(r.weakBottom > 100, `a weak funnel hangs aloft: bottom ${r.weakBottom}`);
    assert.ok(
      r.weakGround < 1e-4 && r.weakAloft > 0.01,
      `clear ground under a funnel aloft: ${r.weakGround}, ${r.weakAloft}`,
    );
    console.log(`ok tornado ${samples}x`);
    return r;
  },
  // A hurricane's clouds (hurricane-check.html): every pixel whose ray the CPU storm field says crosses no cloud stays
  // black, every pixel whose ray crosses solid eyewall or band shows cloud, from the air and from sea level in the eye.
  async hurricane(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    console.log(`  hurricane ${samples}x ${JSON.stringify(r)}`);
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    for (const name of ['air', 'high', 'wall']) {
      const v = r[name];
      assert.ok(v.solid > 50, `${name}: solid cloud pixels ${JSON.stringify(v)}`);
      // Clear rays show nothing: the eye from above and the gaps between the bands are black.
      if (v.clear) assert.ok(v.clearMax < 1e-4, `${name}: clear pixels lit ${JSON.stringify(v)}`);
      // Solid cloud is lit: nine in ten of its pixels well above black.
      assert.ok(v.solidP10 > 0.02, `${name}: solid cloud dark ${JSON.stringify(v)}`);
    }
    assert.ok(r.air.clear > 50, `the eye and the gaps between the bands from the air: ${JSON.stringify(r.air)}`);
    // The haze follows the air the ray crosses: from 90 km up, through near-empty air, the cloud keeps at least 80
    // percent of its light from 40 km (with the old haze by distance alone, exp(-t / 40 km), it kept about a quarter).
    assert.ok(
      r.high.solidMean > 0.8 * r.air.solidMean,
      `haze from 90 km: ${r.high.solidMean} against ${r.air.solidMean}`,
    );
    // From sea level in the eye the sky straight up is clear (no solid ray), and the stadium wall stands low around it.
    assert.equal(r.up.solid, 0);
    assert.ok(r.up.clear > 500 && r.up.clearMax < 1e-4, `the sky up from the eye: ${JSON.stringify(r.up)}`);
    // The eye moves with the storm: 6 km east in 600 s at 10 m/s, its dark centre within 1.5 km of that.
    const [x0, z0] = r.eyeBefore,
      [x1, z1] = r.eyeAfter;
    assert.ok(Math.hypot(x0, z0) < 1500, `eye at the centre: ${r.eyeBefore}`);
    assert.ok(
      Math.abs(x1 - x0 - 6000) < 1500 && Math.abs(z1 - z0) < 1500,
      `the eye moved: ${r.eyeBefore} to ${r.eyeAfter}`,
    );
    return r;
  },
  async volumetric(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    for (const name of ['ground', 'inside', 'above']) {
      const v = r[name];
      // Coverage 0 draws nothing at all.
      assert.equal(v.zero, 0, `${name}: coverage 0 changed ${v.zero} pixels`);
      // The default coverage (0.5) fills a good part of the view with cloud; from inside or above the layer, nearly all of it.
      const least = name === 'ground' ? 0.2 : 0.6;
      assert.ok(v.shown.changed > v.shown.total * least, `${name}: clouds drew ${JSON.stringify(v.shown)}`);
      // A minute of wind and evolution moves and changes the clouds.
      assert.ok(v.evolved.changed > v.shown.changed * 0.05, `${name}: a minute later ${JSON.stringify(v.evolved)}`);
    }
    // The pillar 30 m away is in front of every cloud (the base is 1,500 m up): not one of its pixels changes.
    assert.ok(r.pillar.total > 50, `pillar mask ${JSON.stringify(r.pillar)}`);
    assert.equal(r.pillar.changed, 0, `clouds drew over the near pillar: ${JSON.stringify(r.pillar)}`);
    // The block 160 m ahead of a camera inside dense cloud is veiled by the cloud in between.
    assert.ok(r.block.changed > r.block.total * 0.9, `cloud in front of the block: ${JSON.stringify(r.block)}`);
    assert.equal(r.automaticDepth.same, 0, 'automatic cloud depth matches the explicit live capture');
    assert.equal(r.automaticDepth.override, 0, 'an explicit unavailable depth leaves the foreground block clear');
    assert.equal(
      r.noDepth.pillar.changed,
      0,
      `without depth the clouds covered geometry: ${JSON.stringify(r.noDepth)}`,
    );
    assert.ok(r.noDepth.sky.changed > r.noDepth.sky.total * 0.2, `without depth: ${JSON.stringify(r.noDepth)}`);
    // A lightning flash inside the layer lights the clouds round it (a fifth of the view or more, brighter overall);
    // intensity 0 changes nothing, and an invalid flash throws (TypeError for a bad position, RangeError for a bad value).
    assert.equal(r.flash.off, 0, `a flash of intensity 0 changed ${r.flash.off} pixels`);
    assert.ok(r.flash.lit.changed > r.flash.lit.total * 0.2 && r.flash.gain > 1.2, `flash: ${JSON.stringify(r.flash)}`);
    assert.equal(r.flash.thrown, 3, `invalid flashes accepted: ${3 - r.flash.thrown}`);
    // The deck in the sky's environment (docs/known-bugs.md, 2026-11-13; before the fix the map and the scene light
    // never changed with the clouds): the reflection map is the sky through the deck plus the deck's light, texel for
    // texel (half-float rounding, 1 in 500); the dense deck (coverage 0.9) covers much of the upper half and changes
    // most of it, the half below the horizon (no cloud from the ground) stays as it was; a flash in the deck brightens
    // the map and, through the scene's sky light, the pillar; coverage 0 and dispose give the map back exactly.
    const e = r.environment;
    assert.ok(e.opacity > 0.3 && e.changed > 64 * 16 * 0.3, `deck in the map: ${JSON.stringify(e)}`);
    assert.equal(e.lowerChanged, 0, `below the horizon: ${JSON.stringify(e)}`);
    assert.ok(e.upper.flash > e.upper.clouds * 1.2, `flash in the map: ${JSON.stringify(e.upper)}`);
    assert.notEqual(
      e.pillar.clouds,
      e.pillar.clear,
      `the deck left the scene light alone: ${JSON.stringify(e.pillar)}`,
    );
    assert.ok(e.pillar.flash > e.pillar.clouds * 1.05, `flash in the scene light: ${JSON.stringify(e.pillar)}`);
    assert.ok(e.layered, `the clouds gave the sky no layer: ${JSON.stringify(e)}`);
    // Moonlight through the deck (2026-11-13, before the fix the moon lit every sample alike: one ratio for any
    // density): under a bright moon the thick deck's light per unit opacity is well below the thin veil's.
    const m = r.moonlit;
    assert.ok(m.moon[3] > 1 && m.thin.alpha > 0 && m.thick.alpha > m.thin.alpha, `moonlit decks: ${JSON.stringify(m)}`);
    assert.ok(m.thick.ratio < m.thin.ratio * 0.7, `the moon does not shade the deck: ${JSON.stringify(m)}`);
    // The moon glows through a thin veil (2026-11-13, before the fix a flat disc: the broad 0.8 lobe alone gives the
    // deck near the moon little more light than 6 to 8 degrees out).
    const g = r.glow;
    assert.ok(g.outer > 0 && g.inner > g.outer * 2.5, `no glow round the moon: ${JSON.stringify(g)}`);
    // Temporal starts (2026-11-13, before the fix the option did nothing): still frames move and their mean is smoother
    // than one frame; without the option still frames are identical.
    const t = r.temporal;
    assert.equal(t.off.moved, 0, `still frames moved without temporal: ${JSON.stringify(t)}`);
    assert.ok(t.on.moved > 50 && t.on.mean < t.on.one * 0.8, `temporal starts: ${JSON.stringify(t)}`);
    assert.ok(e.composite < 0.002, `map is not sky over deck: ${JSON.stringify(e)}`);
    assert.ok(e.zeroCleared && e.disposedCleared, `layer left behind: ${JSON.stringify(e)}`);
    console.log(
      `ok volumetric ${samples}x: ground ${r.ground.shown.changed}/${r.ground.shown.total}, inside ${r.inside.shown.changed}, above ${r.above.shown.changed}; frame ${r.ground.ms.toFixed(1)} / ${r.inside.ms.toFixed(1)} / ${r.above.ms.toFixed(1)} ms (diagnostic)`,
    );
    return r;
  },
  async 'cloud-shadows'(page, samples) {
    const points = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 8; j++) points.push([i * 310 - 800, j * 290 - 1000]);
    // The view toward the sun weighs cloud at distance t by exp(-t / 40 km) (the haze); along this sun (y = 0.960) the
    // layer from 1,500 to 2,500 m lies 1,562 to 2,604 m away, so the seen opacity is the shadow's times 0.937 to 0.962.
    const low = Math.exp(-2604 / 40000),
      high = Math.exp(-1562 / 40000),
      error = (shadows, views) =>
        views.reduce((sum, v, i) => sum + Math.abs(v.opacity - ((1 - shadows[i].shadow) * (low + high)) / 2), 0) /
        views.length;
    const first = await page.evaluate((p) => window.check.read(p), points);
    assert.equal(first.error, null);
    assert.deepEqual(first.errors, []);
    const shaded = first.points.filter((p) => p.shadow < 0.5).length,
      open = first.points.filter((p) => p.shadow > 0.9).length;
    assert.ok(shaded >= 5 && open >= 5, `shadow and light both on the ground: ${shaded} shaded, ${open} open`);
    for (const [i, p] of first.points.entries()) {
      assert.ok(p.open > 0.1 && p.background < 0.5, `point ${i} reads: ${JSON.stringify(p)}`);
      // Beyond the haze, the two marches differ only in sampling (24 midpoint samples toward the sun against 64 jittered
      // view steps): 0.05 allows that on a cloud edge, some eight times the largest difference measured (0.006).
      assert.ok(
        p.opacity >= (1 - p.shadow) * low - 0.05 && p.opacity <= (1 - p.shadow) * high + 0.05,
        `point ${i}: seen opacity ${p.opacity.toFixed(3)}, shadow ${p.shadow.toFixed(3)}`,
      );
    }
    const matched = error(first.points, first.points);
    assert.ok(matched < 0.01, `mean difference ${matched}`);
    // Move the clouds 1,500 m: the old shadows no longer match the clouds now seen, the new shadows do.
    await page.evaluate(() => window.check.advance(1500));
    const second = await page.evaluate((p) => window.check.read(p), points),
      stale = error(first.points, second.points),
      moved = error(second.points, second.points);
    assert.ok(moved < 0.01 && stale > matched * 10, `matched ${matched}, moved ${moved}, stale ${stale}`);
    console.log(
      `ok cloud-shadows ${samples}x: ${shaded} shaded and ${open} open of ${points.length}; mean difference ${matched.toFixed(4)}, after 1,500 m ${moved.toFixed(4)}, stale shadows ${stale.toFixed(4)}`,
    );
    return { first, second, matched, moved, stale };
  },
  async aerial(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    // Beer-Lambert along the same ray on the CPU: Rayleigh, Mie (times 0.5, the sky's turbidity 2) and ozone from Hillaire
    // 2020 Table 1, 20,000 steps from 10 m up at the pair's elevation over the planet's curve.
    const transmittance = (distance, elevation) => {
      const R = 6360,
        r0 = R + 0.01,
        n = 20000,
        dt = distance / 1000 / n,
        sin = Math.sin((elevation * Math.PI) / 180),
        out = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) * dt,
          h = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * sin) - R,
          mie = (0.003996 + 0.000444) * 0.5 * Math.exp(-h / 1.2),
          ozone = Math.max(0, 1 - Math.abs(h - 25) / 15);
        [0.005802, 0.013558, 0.0331].forEach(
          (b, c) => (out[c] += (b * Math.exp(-h / 8) + mie + [0.00065, 0.001881, 0.000085][c] * ozone) * dt),
        );
      }
      return out.map((v) => Math.exp(-v));
    };
    // The GPU volume takes two midpoint steps per slice and interpolates linearly between slices; 0.015 is 2.5 times the
    // largest difference measured (0.0058, blue at 40 km).
    const rows = ['near', 'mid', 'far'].map((name) => ({
      name,
      ...r[name],
      cpu: transmittance(r[name].distance, r[name].elevation),
    }));
    for (const row of rows) {
      assert.ok(row.skySame, `${row.name}: the sky pixel changed`);
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(row.transmittance[c] - row.cpu[c]) < 0.015,
          `${row.name} channel ${c}: GPU transmittance ${row.transmittance[c]} against ${row.cpu[c]} on the CPU`,
        );
    }
    const [near, mid, far] = rows;
    for (let c = 0; c < 3; c++) {
      assert.ok(
        near.transmittance[c] > mid.transmittance[c] && mid.transmittance[c] > far.transmittance[c],
        'farther fades more',
      );
      assert.ok(
        near.inscatter[c] < mid.inscatter[c] && mid.inscatter[c] < far.inscatter[c],
        'farther takes more of the air',
      );
    }
    // Mountains go blue: the light the air adds is bluest, and blue is what it takes away most.
    for (const row of [mid, far]) {
      assert.ok(
        row.inscatter[2] > row.inscatter[1] && row.inscatter[1] > row.inscatter[0],
        `${row.name} air is not blue: ${row.inscatter}`,
      );
      assert.ok(row.transmittance[2] < row.transmittance[0], `${row.name}: blue must fade first`);
    }
    const show = (v) => v.map((x) => x.toFixed(4)).join(', ');
    for (const row of rows)
      console.log(
        `ok aerial ${samples}x ${row.name} (${row.distance / 1000} km): transmittance ${show(row.transmittance)} (CPU ${show(row.cpu)}), air ${show(row.inscatter)}`,
      );
    return r;
  },
  async shafts(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    const show = (v) => v.map((x) => x.toFixed(4)).join(', ');
    console.log(
      `  shafts ${samples}x open at 2, 8, 15, 25 degrees: ${show(r.open.angles)}; frame ${r.open.ms.toFixed(1)} ms (diagnostic)`,
    );
    console.log(`  shafts ${samples}x hole ${JSON.stringify(r.hole)}; linear ${JSON.stringify(r.linear)}`);
    for (const [name, v] of Object.entries(r.clouds))
      console.log(`  shafts ${samples}x ${name}: centre ${v.centre.toFixed(4)}, ring ${show(v.ring)}`);
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    // Open sky: light is added everywhere around the sun, falling with the angle from it (the forward phase).
    const [a2, a8, a15, a25] = r.open.angles;
    assert.ok(a25 > 0 && a15 > a25 && a8 > a15 && a2 > a8, `open sky: ${show(r.open.angles)}`);
    // The added light is linear in the intensity, to the half-float rounding of the scene (bound per value in the page).
    assert.ok(r.linear.lit > 10000 && r.linear.off === 0, `linear: ${JSON.stringify(r.linear)}`);
    assert.equal(r.zero, 0, 'intensity 0 changed pixels');
    assert.equal(r.behind, 0, 'the sun behind the camera changed pixels');
    // Behind the panel the light comes only through its hole: the pixel beyond the hole on the sun's line gains light,
    // those as far from the sun on lines that cross only the panel gain exactly nothing.
    const h = r.hole;
    assert.ok(h.hole > 0 && h.beyond > 0.1 * h.openBeyond, `hole: ${JSON.stringify(h)}`);
    assert.equal(h.left, 0, `left of the sun: ${JSON.stringify(h)}`);
    assert.equal(h.below, 0, `below the sun: ${JSON.stringify(h)}`);
    // Clouds: overcast leaves under a twentieth of the clear sky's shafts beside the sun; broken cloud spreads the
    // light around a ring 12 degrees out at least three times as far as the clear sky, which holds it even.
    const spread = (v) =>
      (Math.max(...v.ring) - Math.min(...v.ring)) / (v.ring.reduce((a, b) => a + b) / v.ring.length);
    const { clear, broken, overcast } = r.clouds;
    assert.ok(
      clear.centre > 0 && overcast.centre < clear.centre / 20,
      `overcast ${overcast.centre} against clear ${clear.centre}`,
    );
    assert.ok(
      spread(clear) < 0.2 && spread(broken) > Math.max(1, 3 * spread(clear)),
      `ring spread clear ${spread(clear)}, broken ${spread(broken)}`,
    );
    console.log(
      `ok shafts ${samples}x: open sky by angle, linear, behind, hole, clouds (spread ${spread(clear).toFixed(3)} clear, ${spread(broken).toFixed(3)} broken)`,
    );
    return r;
  },
  async 'weather-fx'(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    console.log(
      `  weather-fx ${samples}x half ${JSON.stringify(r.half)}; map ${JSON.stringify(r.map)}; splashes ${JSON.stringify(r.splashes)} under the roof ${JSON.stringify(r.splashesHalf)}; lens open ${r.open}, roofed ${r.roofed}`,
    );
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    // Half the view under a roof: without the effects rain falls in both halves; with them not one pixel of the
    // covered half changes, and rain still falls in the open half.
    assert.ok(r.half.without.left > 50 && r.half.without.right > 50, `rain without cover: ${JSON.stringify(r.half)}`);
    assert.equal(r.half.with.left, 0, `rain under the roof: ${JSON.stringify(r.half)}`);
    assert.ok(r.half.with.right > 50, `rain in the open: ${JSON.stringify(r.half)}`);
    // The cover map holds the roof's top and the ground's: depth32float over 1,021 m keeps heights to a few
    // millimetres (2^-24 of the range is 6e-5 m); 0.01 m allows the rasterizer's depth interpolation.
    assert.ok(r.map.checked > 1000 && r.map.worst < 0.01, `cover map: ${JSON.stringify(r.map)}`);
    // Splashes change ground pixels in the open, none under the roof.
    assert.ok(r.splashes.left + r.splashes.right > 100, `splashes: ${JSON.stringify(r.splashes)}`);
    assert.equal(r.splashesHalf.left, 0, `splashes under the roof: ${JSON.stringify(r.splashesHalf)}`);
    assert.ok(r.splashesHalf.right > 50, `splashes beside the roof: ${JSON.stringify(r.splashesHalf)}`);
    // Ten seconds in the open rain put drops on the lens; ten under a roof leave it dry.
    assert.ok(r.open > 500, `lens in the open: ${r.open}`);
    assert.equal(r.roofed, 0, `lens under a roof: ${r.roofed}`);
    console.log(`ok weather-fx ${samples}x: cover, map, splashes, lens`);
    return r;
  },
  async sleet(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    console.log(`  sleet ${samples}x ${JSON.stringify(r)}`);
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    // Sleet is the rain drawn alone and the snow drawn alone: where only one of them draws (its particles' coverage,
    // read at a million times their brightness), sleet matches it, and it touches nothing either leaves alone. Where a
    // flake too faint to move the frame lies over a streak (or a faint streak over a flake), the blend's rounding may
    // take one step: the RTX A6000 rounds to nearest and AMD RDNA2 toward zero (KB-GPU-PRECHECKS1).
    assert.ok(r.rainOnly > 100 && r.snowOnly > 100, `both kinds drawn: ${JSON.stringify(r)}`);
    // A flake too faint to move the bare frame by a half-float step can still tip the rain's own value by one step
    // (2^-10 relative, the 10-bit mantissa of the HDR target): no pixel may differ by more, and few by that.
    assert.ok(r.worst <= 2 ** -10, `sleet off by more than one half-float step: ${JSON.stringify(r)}`);
    assert.ok(r.rainUnderFlake > 100, `rain under faint flakes compared: ${JSON.stringify(r)}`);
    assert.ok(r.worstFaint <= 2 ** -10, `sleet under a faint particle off by more than one step: ${JSON.stringify(r)}`);
    assert.ok(
      r.rainMismatch + r.snowMismatch + r.faint <= 0.01 * (r.rainOnly + r.snowOnly),
      `too many steps: ${JSON.stringify(r)}`,
    );
    assert.equal(r.extra, 0, `sleet drew elsewhere: ${JSON.stringify(r)}`);
    // Before KB-SKY-STREAKCENTROID1, 7 pixels at 4x went below 0: a streak's uv, interpolated at a pixel centre outside
    // the streak, gave it a negative alpha.
    assert.equal(r.negative, 0, `the precipitation drove the frame below 0: ${JSON.stringify(r)}`);
    console.log(
      `ok sleet ${samples}x: ${r.rainOnly} rain and ${r.snowOnly} snow pixels match each kind alone (${r.rainMismatch + r.snowMismatch + r.faint} by one half-float step)`,
    );
    return r;
  },
  async astro(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    console.log(`  astro ${samples}x ${JSON.stringify(r)}`);
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    // Each bright, isolated catalogue star's light is centred where skyMatrix, its proper motion and the refraction put
    // it: the centroid of a Gaussian of sigma 1 px sampled at pixel centres is within 0.01 px of its centre, so 0.1 px
    // leaves room for half-float storage. Its summed light is brightness x 10^(-0.4 m) x the night (7.5 or more for a
    // star to magnitude 4 at brightness 200): the sky lost under it is a sky channel times its alpha, 1/64 of its
    // brightest channel on this float target (under 0.1%), and rounding each of the 169 pixels to half floats in both
    // frames moves the sum by at most 2^-11 x (2 x 169 x 0.3 + 7.5) = 0.053 (0.71%) for a sky under 0.3: 1%.
    assert.ok(r.stars.measured >= 10, `stars measured: ${JSON.stringify(r.stars)}`);
    assert.ok(r.stars.skyMax < 0.3, `sky under the stars: ${JSON.stringify(r.stars)}`);
    assert.ok(r.stars.worst < 0.1, `star off its place: ${JSON.stringify(r.stars)}`);
    assert.ok(r.stars.energyWorst < 0.01, `star light: ${JSON.stringify(r.stars)}`);
    // Nothing below the horizon, beyond a point's 4 px reach; stars above it.
    assert.ok(r.horizon.above > 0 && r.horizon.below === 0, `horizon: ${JSON.stringify(r.horizon)}`);
    // By day, none.
    assert.equal(r.day.drawn, 0, `day: ${JSON.stringify(r.day)}`);
    // The moon's light leans toward the sun: within 10 degrees on screen, at a date where the sky's old fixed side was
    // more than 45 degrees away.
    assert.ok(r.moon.angle < 10 && r.moon.offset > 1, `moon: ${JSON.stringify(r.moon)}`);
    console.log(
      `ok astro ${samples}x: ${r.stars.measured} stars within ${r.stars.worst.toFixed(3)} px and ${(100 * r.stars.energyWorst).toFixed(1)}% light, horizon, day, moon limb ${r.moon.angle.toFixed(1)} deg`,
    );
    return r;
  },
  async hillaire(page, samples) {
    const r = await page.evaluate(() => window.check.run());
    const show = (v) => v.map((x) => x.toPrecision(4)).join(', ');
    for (const name of [
      'noon',
      'sunset',
      'antisolar',
      'twilight',
      'twilightNoOzone',
      'ground',
      'limb',
      'space',
      'under',
      'over',
    ])
      console.log(`  hillaire ${samples}x ${name}: ${show(r[name])}`);
    console.log(
      `  hillaire ${samples}x disc ${show(r.disc.centre)} beside ${show(r.disc.beside)}; frame ${r.disc.ms.toFixed(1)} ms, orbit ${r.orbitMs.toFixed(1)} ms (diagnostic)`,
    );
    assert.equal(r.error, null);
    assert.deepEqual(r.errors, []);
    const [noonR, noonG, noonB] = r.noon,
      [setR, setG, setB] = r.sunset;
    // Rayleigh scattering goes as the inverse fourth power of wavelength: the day sky away from the sun is blue.
    assert.ok(noonB > noonG && noonG > noonR, `noon sky not blue: ${show(r.noon)}`);
    // Near a low sun the long path has taken the blue out: orange, brighter than the sky opposite.
    assert.ok(setR > setG && setG > setB && setR > r.antisolar[0], `sunset not orange: ${show(r.sunset)}`);
    // Twilight, sun below the horizon: ozone absorbs green (1.881e-3 /km) and red (0.650e-3) far more than blue
    // (0.085e-3), so with it the zenith is bluer against red and green than without it (Hulburt 1953).
    const ratio = (v, c) => v[2] / v[c];
    for (const c of [0, 1])
      assert.ok(
        ratio(r.twilight, c) > ratio(r.twilightNoOzone, c),
        `ozone: ${show(r.twilight)} against ${show(r.twilightNoOzone)}`,
      );
    // A nearly closed conservative atmosphere: its multiple scattering table (32 x 32 RGB) and its sky are finite.
    console.log(
      `  hillaire ${samples}x closed: sky ${show(r.closed.sky)}; table nonfinite ${r.closed.nonfinite}, largest ${r.closed.largest}; red by altitude row ${r.closed.rows.map((v) => v.toPrecision(3)).join(' ')}`,
    );
    assert.equal(r.closed.nonfinite, 0, 'nonfinite multiple scattering in a nearly closed atmosphere');
    assert.ok(r.closed.sky.every(Number.isFinite), `closed sky ${show(r.closed.sky)}`);
    // Earth's transmittance table against the CPU march: 40 midpoint steps hold it within 0.002 of 4,000.
    for (const t of r.transmittance) {
      console.log(`  hillaire ${samples}x transmittance (${t.i}, ${t.j}): gpu ${show(t.gpu)}, cpu ${show(t.cpu)}`);
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(t.gpu[c] - t.cpu[c]) < 0.005,
          `transmittance texel (${t.i}, ${t.j}): ${show(t.gpu)} against ${show(t.cpu)}`,
        );
    }
    // Earth's multiple scattering table holds, at each texel, Psi at the (r, mu) the lookup reads it for.
    for (const t of r.table) {
      console.log(
        `  hillaire ${samples}x table (${t.i}, ${t.j}): gpu ${show(t.gpu)}, cpu at the lookup's (r, mu) ${show(t.edge)}, at the texel centre ${show(t.centre)}`,
      );
      for (let c = 0; c < 3; c++)
        assert.ok(
          Math.abs(t.gpu[c] - t.edge[c]) <= TABLE_TOLERANCE * t.edge[c],
          `multiple scattering texel (${t.i}, ${t.j}): ${show(t.gpu)} against ${show(t.edge)}`,
        );
    }
    // From 1,000 km: the sunlit ground shows, the limb is blue, and space beyond the air is black.
    assert.ok(
      r.ground.every((v) => v > 0.1),
      `ground from orbit ${show(r.ground)}`,
    );
    assert.ok(r.limb[2] > r.limb[1] && r.limb[1] > r.limb[0] && r.limb[2] > 0, `limb ${show(r.limb)}`);
    assert.deepEqual(r.space, [0, 0, 0]);
    // The same ray from 99 km (the sky-view table) and 101 km (the per-pixel march) agree: 1 km more of thin air
    // changes it little. Measured 0.0005; 0.02 holds forty times that.
    for (let c = 0; c < 3; c++)
      assert.ok(
        Math.abs(r.under[c] - r.over[c]) < 0.02 * r.under[c],
        `across the top: ${show(r.under)} against ${show(r.over)}`,
      );
    // The disc: its true radiance (about 3e5) is held at the largest half float, far above the sky beside it.
    assert.ok(
      r.disc.centre.every((v) => v === 65504),
      `disc ${show(r.disc.centre)}`,
    );
    assert.ok(
      r.disc.beside.every((v) => v > 0 && v < 10),
      `beside the disc ${show(r.disc.beside)}`,
    );
    // Geometry is left as it was; the sky above it changes.
    assert.deepEqual(r.pillar.withSky, r.pillar.bare, 'the sky drew over the pillar');
    assert.notDeepEqual(r.pillar.skyPixel[0], r.pillar.skyPixel[1], 'the sky did not draw');
    console.log(`ok hillaire ${samples}x: noon, sunset, twilight ozone, orbit, table against march, disc and depth`);
    return r;
  },
};
// The look and atmosphere options (look-check.html): each moves the sky the way it says, under both day models where it
// applies, and set with nothing moved or cleared again the frame is the physical sky's, pixel for pixel.
checks.look = async (page, samples) => {
  const r = await page.evaluate(() => window.check.run());
  assert.equal(r.error, null);
  assert.deepEqual(r.errors, []);
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
    show = (k) => JSON.stringify(r[k]);
  for (const model of ['preetham', 'bruneton']) {
    const plain = r[model],
      at = (name) => r[model + name];
    assert.equal(at('NeutralDiff'), 0, `${model}: look {} and atmosphere {} draw the physical sky`);
    assert.equal(at('BackDiff'), 0, `${model}: cleared, the frame is the plain one again`);
    // Zenith tint: green up high at the same luminance, the horizon nearly untouched.
    const z = at('Zenith');
    assert.ok(
      z.high[1] > 2 * z.high[0] && z.high[1] > 2 * z.high[2],
      `${model} zenith green: ${show(model + 'Zenith')}`,
    );
    assert.ok(Math.abs(lum(z.high) / lum(plain.high) - 1) < 0.05, `${model} zenith keeps its luminance`);
    assert.ok(Math.abs(lum(z.horizon) / lum(plain.horizon) - 1) < 0.05, `${model} zenith tint spares the horizon`);
    // Horizon tint: red at the horizon at the same luminance, the high sky untouched.
    const h = at('Horizon');
    assert.ok(h.horizon[0] > 3 * h.horizon[1], `${model} horizon red: ${show(model + 'Horizon')}`);
    assert.ok(Math.abs(lum(h.horizon) / lum(plain.horizon) - 1) < 0.02, `${model} horizon keeps its luminance`);
    assert.ok(
      Math.abs(h.high[2] - plain.high[2]) < 0.01 * plain.high[2] + 0.002,
      `${model} horizon tint spares the zenith`,
    );
    // Gradient at strength 1: the sky is the gradient, orange (2, 1, 0) at the horizon to purple (1, 0, 2) overhead.
    const g = at('Gradient');
    assert.ok(
      g.horizon[0] > 1.8 && g.horizon[2] < 0.2,
      `${model} gradient horizon orange: ${show(model + 'Gradient')}`,
    );
    assert.ok(g.high[2] > g.high[1] && g.high[0] > g.high[1], `${model} gradient purple overhead`);
    // Glow adds light most at the horizon.
    const gl = at('Glow');
    assert.ok(gl.horizon[0] - plain.horizon[0] > 1 && gl.high[0] - plain.high[0] < 0.1, `${model} glow at the horizon`);
    // The sun above the air: twice as strong is about twice the day sky; orange sun, orange sky.
    const si = at('SunIntensity'),
      sc = at('SunColor');
    assert.ok(
      Math.abs(lum(si.mid) / lum(plain.mid) - 2) < 0.05,
      `${model} sunIntensity 2 doubles the sky: ${show(model + 'SunIntensity')}`,
    );
    assert.ok(
      sc.mid[2] < 0.3 * plain.mid[2] && Math.abs(sc.mid[0] - plain.mid[0]) < 0.01,
      `${model} sunColor tints the sky`,
    );
  }
  // KB-SKY-NIGHTPALL1: the low layer leaves the day frame exact; at night it takes the sky and its clouds down by
  // t^(1 / sin e) (the high band 60 to 80 degrees up, the horizon band 0 to 8, floored at 3) and its glow shows in front.
  assert.equal(r.dayLayerDiff, 0, 'by day layerTransmittance leaves the frame exact');
  // KB-SKY-FIREDAY1: a fire spot on the layer lights the day sky too, in the fire's colour (0 before the fix).
  assert.ok(
    r.dayFireRise[0] > 0.004 && r.dayFireRise[0] > r.dayFireRise[1] && r.dayFireRise[1] > r.dayFireRise[2],
    `the fires' light on the layer by day: ${JSON.stringify(r.dayFireRise)}`,
  );
  // KB-SKY-HAZEGLOW1: a far ground the fog hides fully takes the sky's own colour over it, the fires' glow on the haze
  // included (the ground stood up to tens of percent lighter than the sky before the fix).
  assert.ok(
    r.hazeGlow.glow > 0.01 && r.hazeGlow.worst < 0.005,
    `the haze's fire glow in the sky as on the hazed ground: ${JSON.stringify(r.hazeGlow)}`,
  );
  // KB-SKY-NIGHTRIDGE1: by night a far ground the fog hides fully takes the sky over it, the layer and its glow included
  // (the ground took the night sky above the layer before the fix).
  assert.ok(
    r.nightRidge.level > 0.001 && r.nightRidge.worst < 0.005,
    `the hazed ground meets the night sky over it: ${JSON.stringify(r.nightRidge)}`,
  );
  const np = r.nightPlain,
    ratio = (a, k) => lum(a[k]) / lum(np[k]);
  assert.ok(lum(np.high) > 0, 'the night sky draws');
  const half = ratio(r.nightHalf, 'high');
  // The high band's corners sit lower than its centre column, but every pixel of it is above 45 degrees.
  assert.ok(half > 0.5 ** Math.SQRT2 && half < 0.5, `half through, high: ${half}`);
  assert.ok(ratio(r.nightHalf, 'horizon') < 0.5 ** 5, `half through, horizon: ${ratio(r.nightHalf, 'horizon')}`);
  assert.ok(ratio(r.nightPall, 'all') < 1e-4, `the pall puts the night out: ${show('nightPall')}`);
  const glow = r.nightGlow.mid;
  assert.ok(glow[0] > 1.5 * glow[1] && glow[1] > 1.5 * glow[2], `the pall glows its own colour: ${show('nightGlow')}`);
  assert.ok(Math.abs(lum(r.nightGlow.high) / lum(r.nightGlow.horizon) - 1) < 0.02, 'the glow is even over the dome');
  // KB-SKY-PALLFALLOFF1: a spot straight over the eye lights the layer its colour overhead and falls off to the
  // horizon (60 to 80 degrees up r is 180 to 580 m, (1e6 / (1e6 + r^2))^1.5 at least 0.63; 0 to 8 degrees at most
  // 0.0066); a sight of 500 m holds a low ray there, at 0.7 of the spot; two spots add.
  const fire = r.nightFire;
  assert.ok(
    fire.high[0] > 1.5 * fire.high[1] && fire.high[1] > 1.5 * fire.high[2],
    `the fire glow's colour: ${show('nightFire')}`,
  );
  assert.ok(lum(fire.high) > 0.6 * lum(r.nightGlow.high), `overhead near its full light: ${show('nightFire')}`);
  assert.ok(lum(fire.horizon) < 0.1 * lum(fire.high), `falls off toward the horizon: ${show('nightFire')}`);
  assert.ok(
    lum(r.nightFireSight.horizon) > 0.6 * lum(r.nightGlow.horizon),
    `the sight holds a low ray near: ${show('nightFireSight')}`,
  );
  assert.ok(Math.abs(lum(r.nightFireTwo.high) / lum(fire.high) - 2) < 0.04, `two spots add: ${show('nightFireTwo')}`);
  // The haze 2 km ahead of the eye, its spot 500 m wide under that point: with 2 / density = 2 km its light is the
  // exact mean along the whole path, 500 / sqrt(500^2 + 2000^2); with 2 / density = 1 km the mean over the near half,
  // 500 (2000 / sqrt(500^2 + 2000^2) - 1000 / sqrt(500^2 + 1000^2)) / 1000; each times the fog's opacity.
  const whole = 500 / Math.hypot(500, 2000),
    nearHalf = 0.5 * (2000 / Math.hypot(500, 2000) - 1000 / Math.hypot(500, 1000));
  for (const [name, mean, opacity] of [
    ['hazeFire', whole, 1 - Math.exp(-4)],
    ['hazeNear', nearHalf, 1 - Math.exp(-16)],
  ])
    for (let i = 0; i < 3; i++) {
      const added = r[name][i] - r[name + 'Without'][i],
        want = [0.8, 0.4, 0.2][i] * mean * opacity;
      assert.ok(Math.abs(added - want) < 0.006, `${name} channel ${i}: ${added} for ${want}`);
    }
  assert.ok(r.hazeAside[0] - r.hazeAsideWithout[0] < 0.01, `the haze falls off away from the fire: ${r.hazeAside}`);
  // The height falloff: the GPU's share of the fog is the CPU twin's, far under the same-density-everywhere share.
  const hf = r.heightFog;
  assert.ok(Math.abs(hf.share - hf.want) < 0.01 && hf.share < 0.3 * hf.even, `the height fog: ${JSON.stringify(hf)}`);
  assert.ok(lum(r.nightCloud.all) > 0, 'the night clouds draw');
  assert.ok(
    lum(r.nightCloudPall.all) < 1e-4 * lum(r.nightCloud.all),
    `clouds above the pall go out: ${show('nightCloudPall')}`,
  );
  const b = r.bruneton;
  // The air under the Bruneton model: a green Rayleigh spectrum, thin and thick air, heavy and coloured haze, ozone.
  assert.ok(r.rayleighGreen.high[1] > 2.5 * r.rayleighGreen.high[2], `green Rayleigh: ${show('rayleighGreen')}`);
  assert.ok(lum(r.rayleighNone.high) < 0.2 * lum(b.high), `thin air is dark: ${show('rayleighNone')}`);
  assert.ok(
    r.rayleighThick.horizon[2] < 0.5 * b.horizon[2] && r.rayleighThick.high[0] > 2 * b.high[0],
    'thick air: a yellow horizon, a paler zenith',
  );
  assert.ok(r.mieHaze.mid[0] / r.mieHaze.mid[2] > b.mid[0] / b.mid[2], `haze whitens the sky: ${show('mieHaze')}`);
  assert.ok(
    r.mieRed.horizon[2] < 0.8 * r.mieHaze.horizon[2] && r.mieRed.horizon[0] >= r.mieHaze.horizon[0] * 0.99,
    `red dust eats blue: ${show('mieRed')}`,
  );
  assert.ok(
    r.ozone.high[1] < 0.7 * b.high[1] && r.ozone.high[2] > 0.9 * b.high[2],
    `ozone takes green and red: ${show('ozone')}`,
  );
  const wide = r.mieForwardShape,
    tight = r.mieForwardTightShape;
  assert.ok(
    tight.near > 2 * wide.near && tight.far < wide.far,
    `a high asymmetry tightens the glow round the sun: ${show('mieForwardTightShape')} against ${show('mieForwardShape')}`,
  );
  // The disc: four times the radius covers many times the pixels; a red disc keeps its red and loses green and blue.
  assert.ok(r.disc.big > 4 * r.disc.plain && r.disc.plain > 0, `disc pixels ${show('disc')}`);
  assert.ok(
    r.sunPeak.red[1] < 0.3 * r.sunPeak.plain[1] && r.sunPeak.red[0] >= 0.99 * r.sunPeak.plain[0],
    `red disc ${show('sunPeak')}`,
  );
  // Clouds: a red tint, and density 0.2 thins them toward the clear sky.
  assert.ok(
    r.cloudRed.high[1] < 0.6 * r.cloudPlain.high[1] && r.cloudRed.high[0] === r.cloudPlain.high[0],
    `cloud colour ${show('cloudRed')}`,
  );
  assert.ok(
    lum(r.cloudThin.high) < lum(r.cloudPlain.high) && lum(r.cloudThin.high) > lum(r.cloudClear.high),
    `cloud density ${show('cloudThin')}`,
  );
  // Ground tint below the horizon only.
  assert.ok(
    r.groundTint.horizon[2] > 3 * r.groundTint.horizon[0] && r.groundTint.high[2] === r.groundPlain.high[2],
    `ground tint ${show('groundTint')}`,
  );
  console.log(
    `ok look ${samples}x: neutral and cleared frames exact under both models; zenith ${show('brunetonZenith')}; green Rayleigh ${show('rayleighGreen')}`,
  );
  return r;
};
checks.albedo = async (page, samples) => {
  const r = await page.evaluate(() => window.check.run());
  const show = (v) => v.map((x) => x.toPrecision(4)).join(', ');
  for (const name of ['plain', 'black', 'sand', 'snow', 'red', 'back'])
    console.log(`  albedo ${samples}x ${name}: horizon ${show(r[name].horizon)}, 40 degrees up ${show(r[name].high)}`);
  assert.equal(r.error, null);
  assert.deepEqual(r.errors, []);
  // Albedo 0 is the sky without the option, to the bit, before and after a brighter ground.
  assert.deepEqual(r.black, r.plain);
  assert.deepEqual(r.back, r.plain);
  const gain = (a, b, at, c) => a[at][c] / b[at][c] - 1;
  for (let c = 0; c < 3; c++) {
    // A brighter ground brightens the sky: sand more than none, snow more than sand.
    for (const at of ['horizon', 'high'])
      assert.ok(
        r.snow[at][c] > r.sand[at][c] && r.sand[at][c] > r.black[at][c],
        `channel ${c} ${at}: ${show(r.black[at])} / ${show(r.sand[at])} / ${show(r.snow[at])}`,
      );
    // Most near the horizon, where the line of sight crosses the most air lit from below.
    assert.ok(
      gain(r.snow, r.black, 'horizon', c) > gain(r.snow, r.black, 'high', c),
      `channel ${c}: horizon gain ${gain(r.snow, r.black, 'horizon', c)}, high ${gain(r.snow, r.black, 'high', c)}`,
    );
  }
  // Size of the effect, 90 degrees from a sun 30 degrees up: snow at albedo 0.9 sends up radiance 0.9 / pi x E x 0.5 x
  // T (about 0.12 E), and air lit by that lower half sphere scatters 0.5 of it toward the eye (the phase function
  // integrates to 1), as much as the sun's own single scattering at 90 degrees (3 / (16 pi) E, 0.06 E). So the horizon
  // about doubles; 1.5x to 3x holds that with the orders of light that follow. Measured green +113%.
  const snowGain = gain(r.snow, r.black, 'horizon', 1),
    sandGain = gain(r.sand, r.black, 'horizon', 1);
  assert.ok(snowGain > 0.5 && snowGain < 2, `snow horizon gain ${snowGain}`);
  // Nearly linear in the albedo (0.9 / 0.4 = 2.25), a little more because light bounces between the ground and the
  // air again; clear air sends little back down, so less than 20% more. Measured 2.31.
  assert.ok(snowGain / sandGain > 2.25 && snowGain / sandGain < 2.25 * 1.2, `snow against sand ${snowGain / sandGain}`);
  // A red ground (0.9, 0.1, 0.1) lifts red as much as snow does and blue less than sand does.
  assert.ok(Math.abs(r.red.horizon[0] - r.snow.horizon[0]) < 1e-3 * r.snow.horizon[0], `red ${show(r.red.horizon)}`);
  assert.ok(r.red.horizon[2] < r.sand.horizon[2], `red ground blue ${show(r.red.horizon)}`);
  console.log(
    `ok albedo ${samples}x: snow lifts the horizon ${(100 * gain(r.snow, r.black, 'horizon', 1)).toFixed(1)}% and 40 degrees up ${(100 * gain(r.snow, r.black, 'high', 1)).toFixed(1)}% (green)`,
  );
  return r;
};
// The coverage record (KB-HEARTH-CLIP1 part 2): under a PostStack, 0 behind the wall and 1 over the open sky, at the
// scene target's size, the HDR scene unchanged by it, and released when the option is cleared and on dispose.
checks.coverage = async (page, samples) => {
  const r = await page.evaluate(() => window.check.run());
  assert.equal(r.error, null);
  assert.deepEqual(r.errors, []);
  assert.equal(r.before, true, 'no coverage texture without the option');
  assert.equal(r.format, 'r8unorm');
  assert.deepEqual(r.size, r.target, 'the record is the size of the scene target');
  assert.equal(r.differing, 0, `the record changed ${r.differing} HDR scene values`);
  assert.ok(r.wall > 1000 && r.open > 1000, JSON.stringify(r));
  assert.equal(r.wallSet, 0, `${r.wallSet} of ${r.wall} pixels behind the wall counted as sky`);
  assert.equal(r.openSet, r.open, `${r.open - r.openSet} of ${r.open} open sky pixels not counted`);
  assert.ok(r.share > 0.45 && r.share < 0.55, `sky share ${r.share}`);
  assert.equal(r.same, true, 'the record is kept from frame to frame at one size');
  assert.equal(r.cleared, true, 'clearing the option drops the record');
  assert.equal(r.disposed, true, 'dispose drops the record');
  console.log(
    `ok coverage ${samples}x: sky share ${r.share.toFixed(4)}, wall 0 of ${r.wall}, open ${r.openSet} of ${r.open}`,
  );
  return r;
};
checks.presets = async (page, samples) => {
  const r = await page.evaluate(() => window.check.run());
  const show = (v) => v.map((x) => x.toPrecision(4)).join(', ');
  for (const name of ['earth', 'mars', 'storm'])
    console.log(`  presets ${samples}x ${name}: away ${show(r[name].away)}, near the sun ${show(r[name].near)}`);
  assert.equal(r.error, null);
  assert.deepEqual(r.errors, []);
  // The Earth preset is the default sky, to the bit.
  assert.deepEqual(r.earth.away, r.plain.away);
  // Earth's day sky is blue: Rayleigh scattering goes as 1 / lambda^4.
  const [er, eg, eb] = r.earth.away;
  assert.ok(eb > eg && eg > er, `earth ${show(r.earth.away)}`);
  // Mars's is butterscotch: its air is 58 times thinner, so the dust, which absorbs blue (single scattering albedo
  // 0.90) more than red (0.975), colours the sky; red leads green leads blue.
  for (const name of ['mars', 'storm']) {
    const [mr, mg, mb] = r[name].away;
    assert.ok(mr > mg && mg > mb, `${name} ${show(r[name].away)}`);
  }
  // Dust scatters forward (g 0.67): beside the sun the Martian sky is many times brighter than 90 degrees away,
  // more so than Earth's clear air. Measured on this GPU in the presets log.
  const glow = (name) => r[name].near[0] / r[name].away[0];
  assert.ok(glow('mars') > glow('earth') && glow('mars') > 3, `glow mars ${glow('mars')}, earth ${glow('earth')}`);
  // A dust storm (optical depth 3) turns the sky redder still than a clear day's.
  const redness = (v) => v[0] / v[2];
  assert.ok(redness(r.storm.away) > redness(r.mars.away), `storm ${show(r.storm.away)}, clear ${show(r.mars.away)}`);
  console.log(
    `ok presets ${samples}x: earth blue, mars red over blue ${redness(r.mars.away).toFixed(2)}, storm ${redness(r.storm.away).toFixed(2)}; glow beside the sun mars ${glow('mars').toFixed(1)}, earth ${glow('earth').toFixed(1)}`,
  );
  return r;
};
// The settings table (settings-check.html, displayed 8-bit frames through Tonemap and Grade): written at their defaults
// the values leave the frame exact, and every row moves the frame from a base state where each control shows (the
// bruneton sky, the sun 15 degrees up ahead, a half cloud sheet, fog on the pillars, tints, glow and a gradient
// partway). The time rows (timeScale, clouds.speed) hold the frame at 0 and move it as time passes. Every named look
// draws, differs from the default sky and raises no error.
const settingsBase = {
  // The sky draws in the engine light's units (KB-SKY-SANDGREY1): under the page's sun of 1 the frame meters a displayed
  // log-average luminance of 0.018, every row judged in the bottom of the 8-bit range (look.zenithStrength, a tint at
  // the same luminance, moved no pixel by 2 levels). Three stops meter it at 0.29, as the frame was before (0.30).
  'tonemap.exposure': 3,
  'sun.mode': 'angles',
  'sun.azimuth': 90,
  'sun.elevation': 15,
  timeScale: 0,
  model: 'bruneton',
  'clouds.coverage': 0.5,
  'clouds.speed': 0,
  'look.zenithStrength': 0.5,
  'look.horizonStrength': 0.5,
  'look.groundStrength': 0.5,
  'look.glowStrength': 0.5,
  'look.gradientStrength': 0.3,
  'look.sunDiscSize': 3,
};
// The hurricane rows' base: a compact storm 30 km east of the camera, so the eye, the eyewall and the bands are all in
// the view (the camera faces +X) and the layer is overhead.
const hurricaneBase = {
  'volumetric.type': 'hurricane',
  'hurricane.centerX': 30000,
  'hurricane.maxWindRadius': 8000,
  'hurricane.eyewallWidth': 6000,
  'hurricane.bandStart': 20000,
  'hurricane.bandWidth': 5000,
  'hurricane.extent': 80000,
};
// The tornado rows' base: the settings page's tornado 3 km east of the camera (its centre row keeps it there).
const tornadoBase = { 'tornado.centerX': 3000 };
// The tornado rows that set only the weather it makes (wind, gusts, rain, updraft) or act over time (its motion, its
// spin-up and its death) show in no still frame at time 0: tornado.test.js proves them through the options they write.
const TORNADO_UNSEEN = new Set(
  ['speed', 'heading', 'inflow', 'updraft', 'gustFactor', 'rainMax', 'liftoff', 'spinUp'].map((k) => `tornado.${k}`),
);
const HURRICANE_UNSEEN = new Set(
  [
    'speed',
    'heading',
    'pressureDrop',
    'holland',
    'latitude',
    'surfaceFactor',
    'inflow',
    'gustFactor',
    'rainMax',
    'rainExtent',
    'flowPeriod',
    'swirl',
    'bandDrift',
  ].map((k) => `hurricane.${k}`),
);
// A value away from v within [lo, hi]: 30% of the way to the farther end.
const away = (v, lo, hi) => (hi - v >= v - lo ? v + 0.3 * (hi - v) : v - 0.3 * (v - lo));
function moved(s, base) {
  const v = s.name in base ? base[s.name] : s.default;
  if (s.kind === 'number') return away(v, s.min, s.max);
  if (s.kind === 'choice') return s.choices.find((x) => x !== v);
  if (s.kind === 'gradient')
    return [
      { elevation: -90, color: [0, 0, 0] },
      { elevation: 0, color: [1, 0, 0] },
      { elevation: 90, color: [0, 0, 1] },
    ];
  if (v === null) return [1, 0, 1];
  // A colour: the first channel toward its top, the third toward its bottom.
  return v.map((x, i) => (i === 0 ? x + 0.3 * (s.max - x) : i === 2 ? x - 0.3 * (x - s.min) : x));
}
// The glow beside the sun in a displayed frame of settings-check.html (the camera at [0, 2, 0] facing +X 12 degrees up,
// vertical field of view 80 degrees): the mean level of the pixels within 2 degrees of the sun's elevation, binned by
// whole degrees of angle from the sun. The sun at 40 degrees is above every pillar.
function glowProfile({ width: W, height: H, data }, azimuth, elevation) {
  const rad = Math.PI / 180,
    t = Math.tan(40 * rad),
    forward = [Math.cos(12 * rad), Math.sin(12 * rad), 0],
    up = [-Math.sin(12 * rad), Math.cos(12 * rad), 0],
    sun = [
      Math.sin(azimuth * rad) * Math.cos(elevation * rad),
      Math.sin(elevation * rad),
      Math.cos(azimuth * rad) * Math.cos(elevation * rad),
    ],
    sums = [],
    counts = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = (((x + 0.5) / W) * 2 - 1) * t * (W / H),
        sy = (1 - ((y + 0.5) / H) * 2) * t,
        d = [forward[0] + up[0] * sy, forward[1] + up[1] * sy, sx],
        n = Math.hypot(...d);
      if (Math.abs(Math.asin(d[1] / n) / rad - elevation) > 2) continue;
      const k = Math.floor(Math.acos(Math.min(1, (d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2]) / n)) / rad),
        p = (y * W + x) * 4;
      sums[k] = (sums[k] ?? 0) + (data[p] + data[p + 1] + data[p + 2]) / 3;
      counts[k] = (counts[k] ?? 0) + 1;
    }
  return sums.map((s, k) => s / counts[k]);
}
checks.settings = async (page, samples) => {
  const { SKY_SETTINGS, SKY_LIVE_SETTINGS, SKY_LOOKS, skySettingDefaults } = await import('../dist/settings.js'),
    apply = (name, values, deltas) => page.evaluate(([n, v, d]) => window.check.apply(n, v, d), [name, values, deltas]),
    diff = (a, b) => page.evaluate(([x, y]) => window.check.diff(x, y), [a, b]),
    rows = {},
    looks = {};
  await apply('plain', null);
  await apply('defaults', {});
  const exact = await diff('defaults', 'plain');
  assert.equal(exact.max, 0, `the defaults written leave the frame exact: ${JSON.stringify(exact)}`);
  // The clock moves the sun only under sun.mode 'clock'; the glow's sunward gathering shows away from the sun, so that
  // row puts the sun 50 degrees left of the view and gathers fully.
  const context = {
      hours: { 'sun.mode': 'clock' },
      timeScale: { 'sun.mode': 'clock' },
      'look.glowSunward': { 'sun.azimuth': 40 },
      'volumetric.evolution': { 'volumetric.evolution': 0 },
      // The deck's depth shows only under the overcast deck, past 80 percent cover (KB-SKY-OVERCAST1).
      'clouds.depth': { 'clouds.coverage': 1 },
      // The eye's floor cloud shows from under it: the camera in the eye.
      'hurricane.eyeCloud': { 'hurricane.centerX': 2000 },
      'hurricane.outerEyewallStrength': { 'hurricane.outerEyewall': 15000 },
      // The decay shapes only the Rankine vortex.
      'tornado.decay': { 'tornado.profile': 'rankine' },
      // The low layer's transmittance takes down only the night's share of the sky (KB-SKY-NIGHTPALL1): by day it
      // leaves the frame exact, so its row shows with the sun below the horizon.
      'atmosphere.layerTransmittance': { 'sun.elevation': -12 },
      // The haze's base height shows only with a height falloff.
      'fog.base': { 'fog.scaleHeight': 20 },
      // The haze's light below the eye shows on the ground the fog covers below the horizon (KB-SKY-HAZEBELOW1): fog
      // thick enough to cover the ground a few degrees down.
      'fog.lightDecay': { 'fog.density': 0.05 },
    },
    // The weather's rows are null by default (follow the weather; with none given, the plain layer): a value each.
    chosen = {
      'look.glowSunward': 1,
      'volumetric.coverage': 0.8,
      'volumetric.bottom': 800,
      'volumetric.top': 6000,
      'volumetric.density': 0.08,
      // The view reaches the layer about 7 km out, so a shorter march shows where a longer one does not.
      'volumetric.maxDistance': 2000,
      // The storm's sizes stay in order (eye inside the bands inside the extent) under the compact base.
      'hurricane.eyeRadius': 8000,
      'hurricane.maxWindRadius': 12000,
      'hurricane.bandStart': 30000,
      'hurricane.outerEyewall': 15000,
      // Away from the camera's view line: the centre row moves the funnel across the view.
      'tornado.centerX': 3600,
      'tornado.centerZ': 600,
      'tornado.debrisHeight': 700,
      'tornado.touchdown': 0,
      // The base's turn rate (wind over radius) shows in a still frame only as the angle it has turned by the check's
      // clock: at 35.5 m/s (the row's mid value) that moved 7 pixels by at most 3 levels, and 2 once the cloud sheet's
      // rims thinned (KB-SKY-HOLES-KH1). The row's top, 60 m/s, turns it far enough to see.
      'tornado.mesocycloneWind': 60,
      'fog.lightDecay': [2, 2, 2],
      // The pillars stand about 20 m: a scale height near that thins the haze across them (the row's mid value, about
      // 5 km, leaves the low air as it was).
      'fog.scaleHeight': 20,
      'fog.base': 30,
    },
    running = { timeScale: 0.5, 'clouds.speed': 40, 'volumetric.evolution': 20 };
  const cloudsOn = (on) => page.evaluate((v) => window.check.clouds(v), on);
  for (const s of SKY_SETTINGS) {
    // The wind rows show only while the clouds drift: their own pass below.
    if (s.name === 'volumetric.windDirection' || s.name === 'volumetric.windSpeed') continue;
    // The lightning rows write a Weather's options: lightning-link-check.html proves them on the lit frame.
    if (s.group === 'lightning') continue;
    // The hurricane rows that set the storm's wind and rain (the weather it makes) or move and turn its cloud over time
    // show in no still frame: hurricane.test.js proves the wind, rain and settings, features-check hurricane the motion.
    if (HURRICANE_UNSEEN.has(s.name) || TORNADO_UNSEEN.has(s.name)) continue;
    // fireSight limits only the fires' light on the layer (atmosphere.fireSpots, a scene's data with no row), so it
    // shows in no frame of this page: look.test.js proves what it writes and how far each ray takes the spots.
    if (s.name === 'atmosphere.fireSight') continue;
    const base = {
      ...settingsBase,
      ...(s.group === 'hurricane' ? hurricaneBase : {}),
      ...(s.group === 'tornado' ? tornadoBase : {}),
      ...context[s.name],
    };
    // The volumetric.* rows write a VolumetricClouds, attached for them alone (its default layer over the base sky).
    await cloudsOn(s.group === 'volumetric' || s.group === 'hurricane');
    await page.evaluate((v) => window.check.tornado(v), s.group === 'tornado');
    if (s.name in running) {
      // Held at 0, two frames 2 s apart are the same; at the moved value they differ. Two still frames first: the
      // clouds' deck reaches the scene light one frame after it is drawn.
      await apply('heldA', base, [0, 0]);
      await apply('heldB', null, [1, 1]);
      await apply('runA', { ...base, [s.name]: running[s.name] }, [0, 0]);
      await apply('runB', null, [1, 1]);
      const held = await diff('heldB', 'heldA'),
        run = await diff('runB', 'runA');
      rows[s.name] = { value: running[s.name], held, run };
      assert.equal(held.max, 0, `${s.name} 0 holds the frame: ${JSON.stringify(held)}`);
      assert.ok(run.changed >= 4, `${s.name} moves the frame over time: ${JSON.stringify(run)}`);
      continue;
    }
    const value = chosen[s.name] ?? moved(s, base);
    await apply('base', base);
    await apply('moved', { ...base, [s.name]: value });
    const d = await diff('moved', 'base');
    rows[s.name] = { value, ...d };
    assert.ok(d.changed >= 4, `${s.name} = ${JSON.stringify(value)} changes the frame: ${JSON.stringify(d)}`);
  }
  // The wind direction: at speed 20 two frames 2 s apart, drifting toward +Z or toward +X, differ; at speed 0 they do not.
  await cloudsOn(true);
  const windFrame = async (name, speed, direction) => {
    const base = {
      ...settingsBase,
      'volumetric.evolution': 0,
      'volumetric.windSpeed': speed,
      'volumetric.windDirection': direction,
    };
    await apply(`${name}A`, base, [0, 0]);
    await apply(`${name}B`, null, [1, 1]);
    return diff(`${name}B`, `${name}A`);
  };
  const still = await windFrame('windStill', 0, 90),
    toZ = await windFrame('windZ', 20, 0),
    toX = await windFrame('windX', 20, 90);
  assert.equal(still.max, 0, `speed 0 holds the frame whatever the direction: ${JSON.stringify(still)}`);
  assert.ok(toZ.changed >= 4 && toX.changed >= 4, `the clouds drift: ${JSON.stringify({ toZ, toX })}`);
  const dirs = await diff('windZB', 'windXB');
  assert.ok(dirs.changed >= 4, `the direction moves the drift: ${JSON.stringify(dirs)}`);
  rows['volumetric.windSpeed'] = { value: 20, ...toZ };
  rows['volumetric.windDirection'] = { value: 90, ...dirs };
  await cloudsOn(false);
  for (const [name, values] of Object.entries(SKY_LOOKS)) {
    await apply(name, values);
    looks[name] = await diff(name, 'defaults');
    // natural is today's defaults: the very sky drawn with no settings.
    if (name === 'natural')
      assert.equal(looks[name].changed, 0, `look natural draws the default sky: ${JSON.stringify(looks[name])}`);
    else
      assert.ok(
        looks[name].changed > 1000,
        `look ${name} differs from the default sky: ${JSON.stringify(looks[name])}`,
      );
  }
  // Live rows (R2): after one warm-up frame, writing every live row each frame for 60 frames, each swept between two
  // values away from its default (30% to 100% of the way to its moved value), makes no pipeline, buffer or texture, and
  // the last frame is what writing those values once draws. Away from the default matters: the air block, the ground
  // albedo passes and Tonemap's and Grade's colour programs compile the first time a value leaves its default, and again
  // on the way back, so a shot keeps those rows away from their defaults.
  // The sweep draws the hurricane layer, so its rows key a storm whose sizes stay in order all the way.
  const sweepBase = {
      ...settingsBase,
      ...hurricaneBase,
      ...tornadoBase,
      'hurricane.eyeRadius': 8000,
      // The tornado's derived rows hold a value to sweep from (null is the tornado's own rule).
      'tornado.debrisHeight': 350,
      'tornado.updraft': 38,
      'tornado.touchdown': 0,
      'tornado.liftoff': 600,
      'clouds.speed': 0,
      timeScale: 0,
      'volumetric.evolution': 0,
      'volumetric.coverage': 0.5,
      'volumetric.bottom': 1500,
      'volumetric.top': 4000,
      'volumetric.density': 0.04,
      'volumetric.windSpeed': 10,
      'volumetric.windDirection': 20,
    },
    sweepValue = (s, t) => {
      const from = sweepBase[s.name] ?? s.default ?? [1, 1, 1],
        to = moved(s, sweepBase);
      const k = 0.3 + 0.7 * t;
      if (s.kind === 'number') return from + (to - from) * k;
      if (s.kind === 'color') return from.map((x, i) => x + (to[i] - x) * k);
      return t < 0.5 ? from : to;
    },
    sweepAt = (frame) =>
      Object.fromEntries(
        SKY_LIVE_SETTINGS.filter(
          (s) =>
            s.group !== 'lightning' &&
            s.name !== 'timeScale' &&
            s.name !== 'clouds.speed' &&
            s.name !== 'volumetric.evolution' &&
            s.name !== 'volumetric.windSpeed',
        ).map((s) => [s.name, sweepValue(s, frame / 59)]),
      );
  await cloudsOn(true);
  await page.evaluate(() => window.check.tornado(true));
  await apply('warm', { ...sweepBase, ...sweepAt(0) });
  const before = await page.evaluate(() => window.check.counts());
  for (let frame = 0; frame < 60; frame++) await apply('sweep', { ...sweepBase, ...sweepAt(frame) }, [0]);
  const after = await page.evaluate(() => window.check.counts());
  assert.deepEqual(after, before, `60 frames of every live row made GPU objects: ${JSON.stringify({ before, after })}`);
  await apply('once', { ...sweepBase, ...sweepAt(59) }, [0]);
  const once = await diff('sweep', 'once');
  await cloudsOn(false);
  await page.evaluate(() => window.check.tornado(false));
  assert.equal(once.max, 0, `the sweep's last frame is what writing its values once draws: ${JSON.stringify(once)}`);
  // KB-SKY-NU-EDGE1: the plain Bruneton glow round the sun fades without an edge. With the Mie phase baked into the 8
  // nu samples of the table, the glow was a straight ramp to 44 degrees, then a break: the slope per degree went from
  // about -7 to -1.4 levels at once (a change of 5.7). Kept without its phase, single scattering is smooth in nu and
  // the slope changes by about 1 level per degree at most (8-bit noise); the bound is 2.5, from 8 to 58 degrees.
  await apply('glow', {
    ...skySettingDefaults(),
    // The page metered as the rows' base is (settingsBase): the sky in the engine light's units is 3 stops darker.
    'tonemap.exposure': settingsBase['tonemap.exposure'],
    'sun.mode': 'angles',
    'sun.azimuth': 60,
    'sun.elevation': 40,
    timeScale: 0,
    model: 'bruneton',
    turbidity: 6,
  });
  const profile = glowProfile(await page.evaluate(() => window.check.pixels('glow')), 60, 40);
  let edge = { change: 0, at: -1 };
  for (let k = 8; k <= 57; k++) {
    const change = Math.abs(profile[k + 1] - 2 * profile[k] + profile[k - 1]);
    if (!(change <= edge.change)) edge = { change, at: k };
  }
  assert.ok(profile[8] > profile[58] + 20, `the glow is brighter near the sun: ${profile[8]} and ${profile[58]}`);
  assert.ok(
    edge.change < 2.5,
    `the glow round the sun has an edge: ${JSON.stringify(edge)} in ${profile.map(Math.round)}`,
  );
  assert.deepEqual(await page.evaluate(() => window.check.errors()), []);
  const quiet = Object.entries(rows)
    .map(([k, v]) => [k, v.changed ?? v.run.changed])
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3);
  console.log(
    `ok settings ${samples}x: defaults exact; ${SKY_LIVE_SETTINGS.length} live rows made no GPU object in 60 frames and draw as once; ${Object.keys(rows).length} rows move the frame (fewest pixels ${JSON.stringify(quiet)}); ${Object.keys(looks).length} looks draw; glow slope changes at most ${edge.change.toFixed(2)} a degree (${edge.at})`,
  );
  return { rows, looks, glow: { profile, edge } };
};
// The overcast deck (KB-SKY-OVERCAST1, overcast-check.html): the cloud sheet at full cover under a sun 45 degrees up,
// in the linear HDR scene target, against overcastDeck (the CPU twin) for each pixel's ray, in three views (away from
// the sun, toward it, along the horizon). Before the deck the sheet left holes of clear sky (pixels far below the
// deck), the sun's disc and an orange glow round it showing through, and its far edge the clear sky's horizon.
checks.overcast = async (page, samples) => {
  const r = {};
  for (const [tag, depth, model] of [
    ['default', undefined, 'preetham'],
    ['60', 60, 'preetham'],
    ['bruneton', undefined, 'bruneton'],
  ]) {
    const run = await page.evaluate(([d, m]) => window.check.run({ coverage: 1, depth: d, model: m }), [depth, model]);
    // The Bruneton deck is in its own sun units, 20 x the zenith transmittance over 4 pi x 0.55 (about 2.6).
    if (model === 'bruneton') assert.ok(run.units > 2.5 && run.units < 2.7, `Bruneton units ${run.units}`);
    assert.equal(run.error, null);
    assert.deepEqual(run.errors, []);
    for (const [name, v] of Object.entries(run.views)) {
      console.log(
        `  overcast ${samples}x depth ${tag} ${name}: ${v.pixels} px, luminance over the deck's min ${v.min.toFixed(4)} p01 ${v.p01.toFixed(4)} mean ${v.mean.toFixed(4)} max ${v.max.toFixed(4)}, warm ${v.warm.toFixed(4)}`,
      );
      assert.ok(v.pixels > 5000, `${name}: ${v.pixels} sky pixels`);
      // No holes and no disc: every pixel within the deck's gentle variation (DECK_VARIATION 0.12) of its gradation.
      assert.ok(v.min > 0.86 && v.max < 1.14, `${name} depth ${tag}: ${v.min} to ${v.max}`);
      // The two-stream light: the mean within 4 percent of the CIE gradation of T E / pi.
      assert.ok(Math.abs(v.mean - 1) < 0.04, `${name} depth ${tag}: mean ${v.mean}`);
      // No orange glow toward the sun: red over blue within 1 percent of the deck's own.
      assert.ok(v.warm < 1.01, `${name} depth ${tag}: red over blue ${v.warm} of the deck's`);
    }
    r[tag] = run;
  }
  console.log(
    `ok overcast ${samples}x: even deck, no holes, no disc, two-stream light at depth 20 and 60 and under Bruneton`,
  );
  return r;
};
// Named cases, each with its own hard limit: test:gpu runs the checks in groups of at most three (one browser each), so
// no single command carries all twelve at both sample counts (KB1042h: the monolithic run passed every value check
// but outlived its 98 s bound).
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(checks);
for (const name of names) if (!checks[name]) throw new Error(`unknown sky feature check ${name}`);
const CASE_LIMIT_MS = 60000;
const limited = (label, work) => {
  let timer;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sky feature check ${label} passed its ${CASE_LIMIT_MS} ms limit`)),
        CASE_LIMIT_MS,
      );
    }),
  ]);
};
const context = await openBrowser({ startPath: '/packages/sky/test/volumetric-check.html', port: 5213 }),
  { page, hardware } = context,
  pageErrors = [],
  report = { hardware, results: {} };
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
try {
  console.log('adapter', JSON.stringify(hardware.webgpu));
  for (const name of names) {
    for (const samples of [4, 1]) {
      report.results[`${name} ${samples}x`] = await limited(
        `${name} ${samples}x`,
        (async () => {
          await page.goto(
            `http://127.0.0.1:5213/packages/sky/test/${name}-check.html${samples === 1 ? '?samples=1' : ''}`,
          );
          await page.waitForFunction(() => window.ready, null, { timeout: CASE_LIMIT_MS });
          assert.equal(await page.evaluate(() => window.check.samples()), samples);
          return checks[name](page, samples);
        })(),
      );
    }
  }
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  // A MARGO_COMPAT=1 run keeps its own report, so the native and WebGL2-layer numbers can be read side by side.
  await writeFile(
    `test-results/sky-features-check-${names.join('-')}${hardware.compat ? '-compat' : ''}.json`,
    JSON.stringify(report, null, 1),
  );
  console.log(`sky features check passed: ${names.join(', ')}`);
} finally {
  await context.close();
}
