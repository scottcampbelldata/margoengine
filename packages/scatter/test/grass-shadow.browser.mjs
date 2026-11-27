// Real-GPU proof (run from the repository root after building packages; --compat or MARGO_COMPAT=1 for the WebGL2
// compatibility layer):
//   node scripts/run-with-timeout.mjs --max=10 -- node packages/scatter/test/grass-shadow.browser.mjs
// GrassScatter's shadow pass builds the same blades as its colour pass, in Shadows and in VirtualShadows. The shadow is
// read from the picture, as the floor pixels that darken when `shadows.add(grass)` is called:
// 1. One upright blade, h tall and tapering to a point, under a sun 45 degrees up: its shadow reaches h along the floor
//    and narrows as the blade does, sqrt(1 - d / h) of its root width at distance d (the blade's spine climbs as
//    h (1 - (1 - t)^2) while its width falls as 1 - t). The ring mesh the pose starts from is a straight band of one
//    width, so a pass that skipped the pose would not narrow.
// 2. Twice the height casts twice as far.
// 3. Sixteen blades a clump shade far more floor than one.
// 4. A wind across the sun's way bends the blade, and its shadow bends with it: the shadow lies where the sun throws the
//    blade's posed spine (read back from the GPU), far from where it lay without wind.
// 5. The middle and far rings, which GrassScatter draws by coverage, each cast their own ring mesh: from 1 m to 3 m
//    out the far ring's one segment narrows in a straight line, (1 - 3/4) / (1 - 1/4) = 0.333, and the middle ring's two
//    (bent at half height, 3 m up) to 0.5 / (1 - 1/6) = 0.6. Thin blades there still shade about the near ring's area.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { runSuite, watchExit } from '../../../scripts/support/shutdown.mjs';
import { decodePNG } from '../../../tests/support/png.js';

const context = await openBrowser({ startPath: '/packages/scatter/test/grass-shadow.html', port: 'free' }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const luma = (image, k) => 0.2126 * image.data[k * 4] + 0.7152 * image.data[k * 4 + 1] + 0.0722 * image.data[k * 4 + 2];
const frame = async (grass, cast, wind, time, lod) => {
  const errors = await page.evaluate(
    ([g, c, w, t, l]) => window.check.show(g, c, w ?? undefined, t ?? undefined, l ?? undefined),
    [grass, cast, wind, time, lod],
  );
  assert.deepEqual(errors, [], JSON.stringify({ grass, cast, wind, time }));
  const png = await page.locator('canvas').screenshot();
  return { png, image: await decodePNG(png) };
};
/** The shadow the grass casts: its pixel mask, read at floor points, and its area in pixels. */
const shadow = async (grass, keep, wind, time, lod) => {
  const lit = await frame(grass, false, wind, time, lod),
    cast = await frame(grass, true, wind, time, lod);
  if (keep) await writeFile(`test-results/${keep}.png`, cast.png);
  const { width, height } = lit.image,
    mask = new Uint8Array(width * height);
  let area = 0,
    brighter = 0;
  for (let k = 0; k < mask.length; k++) {
    const before = luma(lit.image, k),
      after = luma(cast.image, k);
    if (before > 40 && after < 0.75 * before) {
      mask[k] = 1;
      area++;
    }
    if (after > before + 8) brighter++;
  }
  assert.ok(brighter < 20, `casting a shadow brightens nothing (${brighter} pixels)`);
  // The camera looks straight down, so the floor maps onto the picture affinely.
  const [o, x, z] = await page.evaluate(() =>
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
    ].map((p) => window.check.pixel(p)),
  );
  const at = (px, pz) => {
    const u = o[0] + px * (x[0] - o[0]) + pz * (z[0] - o[0]),
      v = o[1] + px * (x[1] - o[1]) + pz * (z[1] - o[1]);
    return mask[Math.floor(v * height) * width + Math.floor(u * width)] === 1;
  };
  /** Metres of the floor line `distance` from the root, away from the sun, that lie in shadow. */
  const across = (distance) => {
    let hit = 0;
    for (let pz = -3; pz <= 3; pz += 0.01) if (at(-distance, pz)) hit++;
    return hit * 0.01;
  };
  /** The middle, in z, of the shadow on that line. */
  const middle = (distance) => {
    let sum = 0,
      hit = 0;
    for (let pz = -3; pz <= 3; pz += 0.01)
      if (at(-distance, pz)) {
        sum += pz;
        hit++;
      }
    return sum / hit;
  };
  let reach = 0;
  for (let d = 0.05; d <= 7; d += 0.05) if (across(d) > 0) reach = d;
  return { area, across, middle, reach };
};

/**
 * Where the sun throws the posed blade's spine at `distance` from the root: z at x = -distance. The strip's vertices
 * come in pairs from root to tip, and a point (x, y, z) shades the floor at (x - y, 0, z).
 */
function thrown(vertices, distance) {
  const spine = [];
  for (let i = 0; i + 1 < vertices.length; i += 2) {
    const [x, y, z] = vertices[i].map((v, axis) => (v + vertices[i + 1][axis]) / 2);
    spine.push([x - y, z]);
  }
  for (let i = 1; i < spine.length; i++) {
    const [x0, z0] = spine[i - 1],
      [x1, z1] = spine[i];
    if (x0 >= -distance && x1 < -distance) return z0 + ((z1 - z0) * (-distance - x0)) / (x1 - x0);
  }
  return Number.NaN;
}

const check = async (kind) => {
  await page.evaluate((k) => window.check.use(k), kind);
  const blade = {
      blades: 1,
      width: 1.5,
      heightVariance: 0,
      radius: 0,
      lean: 0,
      round: 0,
      segments: [16, 16, 16],
    },
    low = await shadow({ ...blade, height: 2 }, `grass-shadow-${kind}-blade-2m`),
    tall = await shadow({ ...blade, height: 4 }, `grass-shadow-${kind}-blade-4m`),
    near = tall.across(1),
    far = tall.across(3),
    narrowing = far / near,
    expected = Math.sqrt(1 / 3);
  const many = await shadow({ ...blade, height: 2, width: 0.15, radius: 1, blades: 16 }, `grass-shadow-${kind}-16`),
    one = await shadow({ ...blade, height: 2, width: 0.15, radius: 1, blades: 1 });
  // The wind blows along +Z, across the sun's way; the time is the one of these with the largest bend, found from the
  // posed blade.
  const windy = { ...blade, height: 4, width: 0.6 },
    wind = [0, 1, 1];
  let time = 0,
    posed;
  for (const t of [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]) {
    await frame(windy, false, wind, t);
    const vertices = await page.evaluate(() => window.check.posed());
    if (!posed || Math.abs(thrown(vertices, 2.5)) > Math.abs(thrown(posed, 2.5))) [time, posed] = [t, vertices];
  }
  const still = await shadow(windy),
    bent = await shadow(windy, `grass-shadow-${kind}-wind`, wind, time),
    at = [1.5, 2, 2.5].map((d) => ({
      d,
      still: still.middle(d),
      bent: bent.middle(d),
      thrown: thrown(posed, d),
    }));
  // Rings: the near one has 16 segments here, the middle one two and the far one a single segment.
  const ringed = { ...blade, height: 4, segments: [16, 2, 1] },
    thin = { ...blade, height: 2, width: 0.08, radius: 1, blades: 48, segments: [16, 3, 3] },
    rings = [];
  for (const [ring, lod] of [
    [1, [5, 60, 80]],
    [2, [5, 8, 80]],
  ]) {
    const wide = await shadow(ringed, `grass-shadow-${kind}-ring${ring}`, undefined, undefined, lod),
      field = await shadow(thin, `grass-shadow-${kind}-thin${ring}`, undefined, undefined, lod);
    rings.push({
      ring,
      reach: +wide.reach.toFixed(2),
      narrowing: +(wide.across(3) / wide.across(1)).toFixed(3),
      thin: field.area,
    });
  }
  const nearThin = (await shadow(thin, `grass-shadow-${kind}-thin0`)).area;
  const results = {
    rings,
    nearThin,
    reach: [low.reach, tall.reach].map((v) => +v.toFixed(2)),
    across: [near, far].map((v) => +v.toFixed(2)),
    narrowing: +narrowing.toFixed(3),
    area: { one: one.area, sixteen: many.area },
    wind: { time, at: at.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, +v.toFixed(2)]))) },
  };
  console.log(kind, JSON.stringify(results));
  assert.ok(near > 0.25, `${kind}: the blade's shadow has width 1 m out (${near} m)`);
  // The blade is a point at its tip, so the last of its shadow is under a pixel wide.
  assert.ok(tall.reach > 3.4 && tall.reach <= 4.15, `${kind}: a 4 m blade casts about 4 m (${tall.reach})`);
  assert.ok(low.reach > 1.7 && low.reach <= 2.15, `${kind}: a 2 m blade casts about 2 m (${low.reach})`);
  assert.ok(
    Math.abs(narrowing - expected) < 0.1,
    `${kind}: width 3 m out over width 1 m out is ${narrowing}, the blade's own ${expected.toFixed(3)}`,
  );
  assert.ok(one.area > 20 && many.area > 4 * one.area, `${kind}: 16 blades shade ${many.area} pixels, one ${one.area}`);
  for (const { ring, reach, narrowing: ringNarrowing, thin: area } of rings) {
    assert.ok(reach > 3.4 && reach <= 4.15, `${kind}: ring ${ring} casts the 4 m blade about 4 m (${reach})`);
    // A pixel on each edge widens the thin far end, so the measured ratios sit a little high: the two are told apart.
    assert.ok(
      ring === 2 ? ringNarrowing > 0.25 && ringNarrowing < 0.48 : ringNarrowing > 0.52 && ringNarrowing < 0.72,
      `${kind}: ring ${ring} narrows by its own mesh (${ring === 2 ? 0.333 : 0.6}), not ${ringNarrowing}`,
    );
    assert.ok(
      area > 0.6 * nearThin && area < 1.6 * nearThin,
      `${kind}: thin blades in ring ${ring} shade ${area} pixels, in the near ring ${nearThin}`,
    );
  }
  const last = at.at(-1),
    moved = last.thrown - last.still;
  assert.ok(Math.abs(moved) > 0.3, `${kind}: the wind moves the shadow ${moved} m`);
  for (const row of at)
    assert.ok(
      Math.abs(row.bent - row.thrown) < 0.12,
      `${kind}: ${row.d} m out the shadow lies at ${row.bent}, the posed blade throws it to ${row.thrown}`,
    );
  return results;
};

await runSuite(
  async () => {
    console.log('adapter', JSON.stringify(hardware.webgpu));
    await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const results = { shadows: await check('shadows'), virtual: await check('virtual') };
    assert.deepEqual(pageErrors, []);
    console.log('ok scatter grass shadows', JSON.stringify(results));
  },
  () => context.close(),
);
watchExit();
