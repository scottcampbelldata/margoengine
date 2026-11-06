// Real-GPU checks of the optional material features (features.html draws, this judges the numbers).
// Run from the repository root after `npm run build:packages`: node packages/materials/test/features-browser.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const only = process.argv[2],
  release = await acquire({ owner: 'materials-features' });
const context = await openBrowser({ startPath: '/packages/materials/test/features.html', port: 5271 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const check = (name, ...args) => page.evaluate(([n, a]) => window.check[n](...a), [name, args]);
const near = (a, b, label, tolerance = 0.02) =>
  a.forEach((v, k) => assert.ok(Math.abs(v - b[k]) <= tolerance, `${label}: ${a} should be ${b}`));
const jobs = {
  async lobes() {
    const run = async (o) => {
      const r = await page.evaluate((v) => window.check.lobe(v), o);
      assert.deepEqual(r.errors, [], JSON.stringify(o));
      return r.color;
    };
    const luma = (c) => c[0] + c[1] + c[2];
    // The same light as the sun and as each clustered kind: every lobe answers them alike at the quad's middle, and
    // without the hook it does not, which is the gap this closes.
    for (const surface of ['coat', 'sheen', 'film', 'grain']) {
      const sun = await run({ surface, light: 'sun' });
      assert.ok(luma(sun) > 0.05, `${surface} shows: ${sun}`);
      for (const light of ['directional', 'point', 'spot']) {
        const plain = await run({ surface, light }),
          lit = await run({ surface, light, lobes: true });
        near(lit, sun, `${surface} under a clustered ${light} light`, 0.02);
        const gap = plain.reduce((sum, v, k) => sum + Math.abs(v - sun[k]), 0);
        assert.ok(gap > 0.03, `${surface} under a ${light} light without the hook: ${plain} against ${sun}`);
        console.log(`lobes ${surface} ${light}: sun ${sun}, plain ${plain}, lit ${lit}`);
      }
    }
    // The coat under an area light, against the coat's GGX summed over the panel here, apart from the shader's fitted
    // table. The tone curve takes 0.04 off above 0.08 and is 6.25 x^2 below it; the base under the coat keeps 96%.
    const [dark] = await run({ surface: 'coat', light: 'area' }),
      [coated] = await run({ surface: 'coat', light: 'area', lobes: true }),
      panelCoat = () => {
        const unit = (v) => v.map((x) => x / Math.hypot(...v)),
          dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
          cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
          centre = [0.6, 0.4, 2],
          facing = unit(centre),
          right = unit(cross([0, 1, 0], facing)),
          up = cross(facing, right),
          a2 = 0.3 ** 4,
          steps = 200;
        let sum = 0;
        for (let i = 0; i < steps; i++)
          for (let j = 0; j < steps; j++) {
            const a = (i + 0.5) / steps - 0.5,
              b = (j + 0.5) / steps - 0.5,
              p = centre.map((x, k) => x + a * right[k] + b * up[k]),
              l = unit(p),
              nl = l[2],
              nh = unit([l[0], l[1], l[2] + 1])[2],
              d = a2 / (Math.PI * (nh * nh * (a2 - 1) + 1) ** 2),
              g = (2 / (1 + 1)) * ((2 * nl) / (nl + Math.sqrt(a2 + (1 - a2) * nl * nl)));
            sum += ((d * g) / 4) * (dot(l, facing) / dot(p, p) / steps ** 2);
          }
        return 0.04 * sum * dot(centre, centre) * 16;
      },
      under = 0.96 * Math.sqrt(dark / 6.25),
      seen = coated + 0.04 - under,
      want = panelCoat();
    assert.ok(Math.abs(seen / want - 1) < 0.1, `coat under an area light: ${seen}, summed ${want}`);
    console.log(`lobes coat area: ${seen} against ${want}`);
    const all = await page.evaluate(() => window.check.lobeAll());
    assert.deepEqual(all.errors, []);
    assert.ok(luma(all.on) > 0.05 && all.on.every(Number.isFinite), `${all.on}`);
    assert.ok(all.on.some((v, k) => Math.abs(v - all.off[k]) > 0.01), `lobes off: ${all.on} -> ${all.off}`);
    near(all.back, all.on, 'lobes back on', 0.001);
    for (const [surface, plainSurface] of [['film', 'plainFilm'], ['grain', 'plainGrain']]) {
      const seen = await page.evaluate((s) => window.check.lobeEnv(s), surface),
        plain = await page.evaluate((s) => window.check.lobeEnv(s), plainSurface);
      assert.deepEqual([...seen.errors, ...plain.errors], []);
      const change = seen.grid.reduce((sum, v, k) => sum + Math.abs(v - plain.grid[k]), 0) / seen.grid.length;
      assert.ok(change > 0.005, `${surface} reads the envMap: ${change}, ${plain.color} -> ${seen.color}`);
      console.log(`lobes ${surface} on an envMap: ${change}, ${plain.color} -> ${seen.color}`);
      // The film tints the map as it tints the sun's highlight: green over blue over red at this thickness.
      if (surface === 'film') assert.ok(seen.color[1] > seen.color[2] && seen.color[2] > seen.color[0], `${seen.color}`);
    }
  },
  async prefilter() {
    const r = await page.evaluate(() => window.check.prefilter());
    assert.deepEqual(r.errors, []);
    assert.ok(Math.abs(r.boxMirror - r.filteredMirror) < 0.02, `mirror: ${r.boxMirror} against ${r.filteredMirror}`);
    // Only +Z is lit, so a box filter stays at 1 while GGX reads the lobe's share on that face, integrated here apart
    // from the shader. With three mips, roughness 0.5 and 1 land exactly on a level.
    const faceShare = (roughness) => {
      const a2 = roughness ** 4;
      let onFace = 0,
        all = 0;
      for (let i = 0; i < 1000; i++)
        for (let j = 0; j < 200; j++) {
          const u = (i + 0.5) / 1000,
            phi = ((j + 0.5) / 200) * 2 * Math.PI,
            c = Math.sqrt((1 - u) / (1 + (a2 - 1) * u)),
            s = Math.sqrt(1 - c * c),
            l = [2 * c * s * Math.cos(phi), 2 * c * s * Math.sin(phi), 2 * c * c - 1];
          if (l[2] <= 0) continue;
          all += l[2];
          if (Math.abs(l[0]) <= l[2] && Math.abs(l[1]) <= l[2]) onFace += l[2];
        }
      return onFace / all;
    };
    for (const [level, roughness, box, filtered] of [[0, 0.5, r.boxHalf, r.filteredHalf], [1, 1, r.boxFull, r.filteredFull]]) {
      const share = faceShare(roughness);
      assert.ok(Math.abs(r.levels[level] - share) < 0.02, `level of roughness ${roughness}: ${r.levels[level]}, GGX share ${share}`);
      // PBR Neutral takes 0.04 off every value in this range before the canvas; the pixels must agree with the level.
      const seen = (filtered + 0.04) / (box + 0.04);
      assert.ok(Math.abs(seen - r.levels[level]) < 0.02, `drawn at roughness ${roughness}: ${seen} against ${r.levels[level]}`);
    }
    assert.ok(Math.abs(r.flatBox - r.flatFiltered) < 0.02, `a flat sky keeps its light: ${r.flatBox} against ${r.flatFiltered}`);
    assert.equal(r.size, 32);
    assert.ok(r.mips >= 2);
    assert.ok(Math.abs(r.restored - r.filteredMirror) < 0.02, `restored: ${r.restored}`);
    // Harmonic rows 1, 2 and 3 are y, z and x, three numbers each: each lit half must land on its own side.
    const row = (sh, k, c) => sh[k * 3 + c];
    assert.ok(row(r.left, 2, 0) > 0, 'the left half of +X lies towards +Z');
    assert.ok(row(r.top, 1, 0) > 0, 'the top half of +Z lies towards +Y');
    assert.ok(row(r.sided, 3, 0) > 0 && row(r.sided, 3, 1) < 0, 'red +X, green -X');
    assert.ok(row(r.sided, 1, 2) > 0 && row(r.sided, 1, 1) < 0, 'blue +Y, yellow -Y');
    console.log(`prefilter: levels hold ${r.levels} of the bright face at roughness 0.5, 1; ${r.mips} mips`);
    const source = (kind) => page.evaluate((k) => window.check.prefilterSource(k), kind);
    // A real sky from one KTX2 file, transcoded to a compressed format; an equirectangular image; float faces over 1.
    const sky = await source('ktx2'),
      ramp = await source('equirect'),
      hdr = await source('float');
    assert.deepEqual([...sky.errors, ...ramp.errors, ...hdr.errors], []);
    assert.notEqual(sky.format, 'rgba8unorm');
    assert.ok(sky.spread > 0.02 && ramp.spread > 0.02, `the views vary: ${sky.spread}, ${ramp.spread}`);
    assert.ok(sky.difference < 0.01, `the KTX2 sky stays itself: ${sky.difference}`);
    assert.ok(ramp.difference < 0.01, `the equirectangular image stays itself: ${ramp.difference}`);
    assert.equal(hdr.red, 4, 'float faces keep values over 1');
    console.log(`prefilter sources: KTX2 ${sky.format} ${sky.difference} of ${sky.spread}, equirect ${ramp.difference} of ${ramp.spread}`);
  },
  async coverage() {
    const run = (o) => page.evaluate((v) => window.check.coverage(v), o);
    for (const kind of ['unlit', 'lit']) {
      const hard = await run({ on: false, kind }),
        soft = await run({ on: true, kind });
      assert.deepEqual([...hard.errors, ...soft.errors], [], kind);
      assert.ok(soft.part > 4 * Math.max(1, hard.part), `${kind}: ${soft.part} part-covered pixels against ${hard.part}`);
      assert.ok(Math.abs(soft.lit - hard.lit) < 0.01, `${kind}: the edge stays put, ${soft.lit} against ${hard.lit}`);
      console.log(`coverage ${kind}: part-covered pixels ${hard.part} -> ${soft.part}, lit ${hard.lit} -> ${soft.lit}`);
    }
    const plain = await run({ on: false, exact: true }),
      flagged = await run({ on: true, exact: true });
    assert.deepEqual([...plain.errors, ...flagged.errors], []);
    assert.equal(flagged.part, plain.part, 'one sample: the plain test');
    assert.equal(flagged.lit, plain.lit, 'one sample: the plain test');
    const blended = await run({ on: true, transparent: true }),
      blendedOff = await run({ on: false, transparent: true });
    assert.deepEqual([...blended.errors, ...blendedOff.errors], []);
    assert.equal(blended.lit, blendedOff.lit, 'a blended material ignores it');
    const live = await page.evaluate(() => window.check.coverageLive());
    assert.deepEqual(live.errors, []);
    assert.ok(live.after > 4 * Math.max(1, live.before), `live: ${live.before} -> ${live.after}`);
  },
  async mips() {
    const run = async (o) => {
      const r = await page.evaluate((v) => window.check.mips(v), o);
      assert.deepEqual(r.errors, [], JSON.stringify(o));
      return r.color;
    };
    const red = [1, 0, 0],
      green = [0, 1, 0],
      blue = [0, 0, 1],
      white = [1, 1, 1];
    // The quad is about 177 pixels across, so 64 texels times `repeats` set the level: 2.8 is level 0.
    near(await run({ repeats: 2, levels: 4 }), red, 'level 0');
    near(await run({ repeats: 5, levels: 4 }), green, 'level 1');
    near(await run({ repeats: 10, levels: 4 }), blue, 'level 2');
    near(await run({ repeats: 20, levels: 4 }), white, 'level 3');
    near(await run({ repeats: 80, levels: 4 }), white, 'past the chain the last level stays');
    near(await run({ repeats: 20, levels: 2 }), green, 'a short chain stops at its last level');
    near(await run({ repeats: 5, levels: 4, canvas: true }), green, 'canvas levels');
    near(await run({ repeats: 5, levels: 4, format: 'rgba16float' }), [0, 0.5, 0], 'half floats');
    console.log('mips: each level shows at its own density, short chains stop, canvases and half floats work');
  },
  async layered() {
    const run = async (kind) => {
      const out = await page.evaluate((k) => window.check.layeredCheck(k), kind);
      for (const r of Array.isArray(out) ? out : [out]) assert.deepEqual(r.errors, [], kind);
      return out;
    };
    const blue = [0, 0, 1],
      red = [1, 0, 0],
      green = [0, 1, 0];
    let r = await run('mask');
    near(r.left, blue, 'mask keeps the material where it is black');
    near(r.right, red, 'mask shows the layer where it is white');
    r = await run('packed');
    near(r.left, blue, 'channel g of a packed mask');
    near(r.right, red, 'channel g of a packed mask');
    r = await run('opacity');
    near(r.left, [0.25, 0, 0.75], 'opacity mixes in linear light');
    r = await run('order');
    near(r.left, red, 'lower layer');
    near(r.right, green, 'upper layer covers the lower one');
    r = await run('vertex');
    assert.ok(r.left[0] < r.right[0], `vertex weight ramps: ${r.left} to ${r.right}`);
    near([r.left[0] + r.left[2], r.right[0] + r.right[2]], [1, 1], 'colours no longer tint: the two layers add to one');
    const [low, mid, high] = await run('height');
    near(low.left, blue, 'height at weight 0');
    near(low.right, blue, 'height at weight 0');
    near(mid.left, blue, 'low ground stays under at weight 0.5');
    near(mid.right, red, 'high ground shows first at weight 0.5');
    near(high.left, red, 'height at weight 1');
    near(high.right, red, 'height at weight 1');
    r = await run('array');
    near(r.left, green, 'layer 1 of the array');
    r = await run('shared');
    assert.equal(r.slots, 1, 'one texture used twice takes one slot');
    near(r.left, blue, 'shared mask');
    near(r.right, [0.5, 0.5, 0], 'shared mask');
    r = await run('tiling');
    assert.equal(r.steps, 7, 'tiling 4 draws four black and white pairs');
    r = await run('detail');
    near(r.grey, [0.5, 0.5, 0.5], 'grey detail leaves the surface', 0.02);
    near(r.dark, [0.25, 0.25, 0.25], 'detail darkens', 0.02);
    near(r.half, [0.375, 0.375, 0.375], 'strength halves it', 0.02);
    r = await run('surface');
    near(r.left, [0.8, 0, 0], 'surface numbers under the mask', 0.01);
    near(r.right, [0.25, 1, 0], 'layer roughness and metalness', 0.01);
    r = await run('normal');
    near(r.left, [0.5, 0.5, 1], 'normal under the mask', 0.02);
    assert.ok(r.right[0] > 0.9 && r.right[2] < 0.6, `layer normal points to +x: ${r.right}`);
    assert.ok(Math.abs(r.detail[1] - 0.5) > 0.3 && r.detail[0] < 0.55, `detail normal tilts along green: ${r.detail}`);
    assert.equal(Math.sign(r.detail[1] - 0.5), Math.sign(r.plain[1] - 0.5), `detail green as a normal map's: ${r.detail}, ${r.plain}`);
    r = await run('live');
    near(r.before, blue, 'live opacity 0');
    near(r.after, red, 'live opacity 1');
    console.log('layered: masks, packed channel, order, vertex, height, array, tiling, detail, surface, normals, live');
  },
  async alphaHash() {
    for (const instanced of [false, true])
      for (const alpha of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const { coverage, errors } = await check('hashCoverage', alpha, instanced);
        console.log(JSON.stringify({ label: 'hash coverage', instanced, alpha, coverage }));
        assert.deepEqual(errors, []);
        // 16,384 pixels: a binomial's standard deviation is 0.004 at most; correlated cells widen it.
        assert.ok(Math.abs(coverage - alpha) < 0.02, `alpha ${alpha} covers ${coverage}`);
      }
    const { same, errors } = await check('hashStable');
    console.log(JSON.stringify({ label: 'hash stays on the surface', same }));
    assert.deepEqual(errors, []);
    assert.ok(same > 0.99, `only ${same} of the pattern moved with the surface`);
    const off = await check('hashTAA', false),
      strict = await check('hashTAA', true),
      on = await check('hashTAA', 'stochastic');
    console.log(JSON.stringify({ label: 'hash and TAA', off, strict, on }));
    assert.deepEqual(off.errors, []);
    assert.deepEqual(on.errors, []);
    assert.ok(Math.abs(on.mean - off.mean) < 0.05, 'TAA keeps the mean');
    assert.ok(on.pixelSpread < off.pixelSpread * 0.7, `TAA leaves grain ${on.pixelSpread} of ${off.pixelSpread}`);
  },
  async ktx2() {
    for (const [name, kind, images] of [
      ['cube-uastc-zstd', 'cube', 6],
      ['array-uastc', 'array', 3],
      ['cube-etc1s', 'cube', 6],
    ]) {
      const got = await check('ktx2', name, kind);
      console.log(JSON.stringify({ label: `ktx2 ${name}`, ...got }));
      assert.deepEqual(got.errors, []);
      assert.equal(got.instance, true);
      assert.equal(got.images, images);
      assert.equal(got.depth, images);
      assert.equal(got.same, true, 'the GPU copy holds the decoded texels of every level');
      assert.equal(got.compressedLayers, images);
      assert.notEqual(got.format.replace('-srgb', ''), 'rgba8unorm');
      // The drawn colour against the four middle texels, mixed (8-bit output, 8-bit interpolation weights).
      for (const { got: shown, want } of got.shown)
        shown.forEach((v, c) => assert.ok(Math.abs(v - want[c]) <= 3, `${name}: drew ${shown}, texels mix to ${want}`));
    }
    const native = await check('ktx2Native');
    console.log(JSON.stringify({ label: 'ktx2 native', ...native }));
    assert.deepEqual(native.errors, []);
    assert.equal(native.instance, true);
    assert.ok(native.centre.some((v) => v > 0), 'the stored file lights the surface');
    assert.match(native.refused, /cube arrays have no material slot/);
  },
  async objectNormal() {
    const s = Math.SQRT1_2,
      wide = Math.hypot(0.5, 1);
    const want = {
      plain: [0, 0, 1],
      turned: [s, 0, s],
      sideways: [1, 0, 0],
      stretched: [0.5 / wide, 0, 1 / wide],
      mirrored: [-s, 0, s],
      instanced: [s, 0, s],
      zUp: [0, s, s],
      halfScale: [s, 0, s],
    };
    for (const [name, normal] of Object.entries(want)) {
      const got = await check('objectNormal', name);
      console.log(JSON.stringify({ label: `object normal ${name}`, ...got, want: normal.map((v) => +v.toFixed(2)) }));
      assert.deepEqual(got.errors, []);
      // 8-bit output: 2 / 255 per step, and an 8-bit map.
      got.normal.forEach((v, k) => assert.ok(Math.abs(v - normal[k]) < 0.03, `${name}: ${got.normal}`));
    }
  },
};
let failed = false;
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
  for (const [name, run] of Object.entries(jobs)) {
    if (only && only !== name) continue;
    await run();
    console.log(`ok ${name}`);
  }
  assert.deepEqual(pageErrors, []);
} catch (error) {
  failed = true;
  console.error(error);
  console.error(pageErrors);
} finally {
  await context.close();
  await release();
}
process.exit(failed ? 1 : 0);
