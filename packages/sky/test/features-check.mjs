// Real-GPU proof of the newer optional sky entries (run from the repository root after building packages, one GPU job
// at a time): node packages/sky/test/features-check.mjs [name...]
// Each page compiles its entry's shaders on the browser's WebGPU and reads back Bloom's HDR scene capture; the bounds
// below are what each feature must do, not a picture match.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const checks = {
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
    assert.equal(
      r.noDepth.pillar.changed,
      0,
      `without depth the clouds covered geometry: ${JSON.stringify(r.noDepth)}`,
    );
    assert.ok(r.noDepth.sky.changed > r.noDepth.sky.total * 0.2, `without depth: ${JSON.stringify(r.noDepth)}`);
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
          mie = (0.003996 + 0.00444) * 0.5 * Math.exp(-h / 1.2),
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
    // Sleet is the rain drawn alone and the snow drawn alone: where only one of them touched the frame, sleet matches
    // it, and it touches nothing either leaves alone.
    assert.ok(r.rainOnly > 100 && r.snowOnly > 100, `both kinds drawn: ${JSON.stringify(r)}`);
    // A flake too faint to move the bare frame by a half-float step can still tip the rain's own value by one step
    // (2^-10 relative, the 10-bit mantissa of the HDR target): no pixel may differ by more, and few by that.
    assert.ok(r.worst <= 2 ** -10, `sleet off by more than one half-float step: ${JSON.stringify(r)}`);
    assert.ok(
      r.rainMismatch + r.snowMismatch <= 0.01 * (r.rainOnly + r.snowOnly),
      `too many steps: ${JSON.stringify(r)}`,
    );
    assert.equal(r.extra, 0, `sleet drew elsewhere: ${JSON.stringify(r)}`);
    console.log(
      `ok sleet ${samples}x: ${r.rainOnly} rain and ${r.snowOnly} snow pixels match each kind alone (${r.rainMismatch + r.snowMismatch} by one half-float step)`,
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
  assert.ok(
    snowGain / sandGain > 2.25 && snowGain / sandGain < 2.25 * 1.2,
    `snow against sand ${snowGain / sandGain}`,
  );
  // A red ground (0.9, 0.1, 0.1) lifts red as much as snow does and blue less than sand does.
  assert.ok(Math.abs(r.red.horizon[0] - r.snow.horizon[0]) < 1e-3 * r.snow.horizon[0], `red ${show(r.red.horizon)}`);
  assert.ok(r.red.horizon[2] < r.sand.horizon[2], `red ground blue ${show(r.red.horizon)}`);
  console.log(
    `ok albedo ${samples}x: snow lifts the horizon ${(100 * gain(r.snow, r.black, 'horizon', 1)).toFixed(1)}% and 40 degrees up ${(100 * gain(r.snow, r.black, 'high', 1)).toFixed(1)}% (green)`,
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
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(checks);
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
      await page.goto(`http://127.0.0.1:5213/packages/sky/test/${name}-check.html${samples === 1 ? '?samples=1' : ''}`);
      await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
      assert.equal(await page.evaluate(() => window.check.samples()), samples);
      report.results[`${name} ${samples}x`] = await checks[name](page, samples);
    }
  }
  assert.deepEqual(pageErrors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/sky-features-check.json', JSON.stringify(report, null, 1));
  console.log('sky features check passed');
} finally {
  await context.close();
}
