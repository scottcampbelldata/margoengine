// Real-GPU check of @margoengine/splats entries, run from the repository root after building packages (takes a GPU
// slot itself): node packages/splats/test/gpu/check.mjs
// ./depth: meshes drawn before a cloud hide the splats behind them (the cloud's own depth test), and with SplatDepth a
// cloud hides what later passes draw behind it, on a synthetic splat and on a real capture (raccoon, Niantic SPZ sample).
// ./set: two overlapping copies of the capture sorted as one set draw what one merged cloud draws; as two clouds they do not.
// ./lighting: relit colours match core's diffuse terms; a synthetic disc and the real capture shadow a ground mesh.
// ./edit: GPU picks take the nearest splat; select, erase and paint change exactly the region's splats, read back.
// ./pick: Picking answers the nearest of splats and meshes in one depth test, with engine.pick and pickMany.
// Root antialias: projected opacities scale by s / (s + 0.3) for an isotropic splat of screen variance s.
// ./animate: a sequence held between two frames draws their mix; a skin moves and turns splats and their covariances.
// ./data: the browser's own WebP decoder reads the SOG writer's lossless WebP images back exactly.
// ./lod: a hierarchy of the real capture fully refined draws as the plain cloud; a 16.7 M-splat stand-in streams in a 2 M budget.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../../scripts/browser.js';
import { acquire } from '../../../../scripts/gpu-lock.mjs';
import { decodePNG } from '../../../../tests/support/png.js';
import { encodeWebpLossless } from '../../src/webp.ts';
import { checkStreamedSog } from './lod-sog-check.mjs';
import { checkModifiers } from './modify-check.mjs';

const release = await acquire({ owner: 'splats-gpu' });
const context = await openBrowser({ startPath: '/packages/splats/test/gpu/splats.html', port: 'free' }),
  { page } = context;
const report = {};
try {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  await page
    .waitForFunction(() => window.ready, null, { timeout: 30000 })
    .catch((error) => {
      throw new Error(`the page did not start: ${pageErrors.join('; ') || error.message}`);
    });
  const image = async (o) => {
    await page.evaluate((options) => window.check.build(options), o);
    const url = await page.evaluate(() => window.check.pixels());
    return decodePNG(Buffer.from(url.split(',')[1], 'base64'));
  };
  const centre = (img) => {
    const at = (img.height / 2) * img.width * 4 + img.width * 2;
    return [...img.data.subarray(at, at + 3)];
  };
  const shot = async (o) => centre(await image(o));
  const blue = [0, 0, 255];

  // ./depth, synthetic: one red splat at z 0 (opacity 0.95, sigma 0.5), meshes at z 0.5 (in front) or -0.5 (behind).
  for (const samples of [1, 4])
    for (const orthographic of [false, true]) {
      const tag = `${samples}x${orthographic ? ' orthographic' : ''}`,
        o = { samples, orthographic },
        alone = await shot(o),
        background = await shot({ ...o, none: true });
      assert.ok(alone[0] > background[0] + 100, `${tag}: the splat shows, ${alone} over ${background}`);
      // Before the cloud: the plane in front hides the splat, with or without SplatDepth; behind, the splat is on top.
      const wallFront = await shot({ ...o, before: 0.5, none: true });
      for (const depth of [false, true]) {
        assert.deepEqual(
          await shot({ ...o, before: 0.5, depth }),
          wallFront,
          `${tag} depth ${depth}: plane in front hides the splat`,
        );
        const over = await shot({ ...o, before: -0.5, depth });
        assert.ok(over[0] - over[1] > 150, `${tag} depth ${depth}: the splat covers the plane behind it, ${over}`);
      }
      // After the cloud: without SplatDepth a later quad behind the splat draws over it; with it the splat hides the quad
      // exactly (the same pixels as the splat alone), and a later quad in front still draws.
      const behindOff = await shot({ ...o, after: -0.5 }),
        behindOn = await shot({ ...o, after: -0.5, depth: true }),
        frontOn = await shot({ ...o, after: 0.5, depth: true });
      report[`depth ${tag}`] = { alone, behindOff, behindOn, frontOn };
      assert.deepEqual(behindOff, blue, `${tag}: without depth the later quad covers the splat`);
      assert.deepEqual(behindOn, alone, `${tag}: with depth the splat hides the later quad behind it`);
      assert.deepEqual(frontOn, blue, `${tag}: a later quad in front of the splat still draws`);
      // Opacity is capped at 0.99, so threshold 1 writes nothing; a disposed SplatDepth writes nothing either; a splat
      // of opacity 0.4 stays under the default threshold 0.5 and writes nothing, and writes at threshold 0.3.
      assert.deepEqual(await shot({ ...o, after: -0.5, depth: true, threshold: 1 }), blue, `${tag}: threshold 1`);
      assert.deepEqual(await shot({ ...o, after: -0.5, depth: true, disposeDepth: true }), blue, `${tag}: disposed`);
      assert.deepEqual(
        await shot({ ...o, after: -0.5, depth: true, opacity: 0.4 }),
        blue,
        `${tag}: opacity 0.4 under 0.5`,
      );
      assert.deepEqual(
        await shot({ ...o, after: -0.5, depth: true, opacity: 0.4, threshold: 0.3 }),
        await shot({ ...o, opacity: 0.4 }),
        `${tag}: opacity 0.4 over threshold 0.3`,
      );
      // A disposed cloud leaves SplatDepth with nothing to write and no error.
      assert.deepEqual(
        await shot({ ...o, after: -0.5, depth: true, disposeCloud: true }),
        blue,
        `${tag}: disposed cloud`,
      );
    }

  // ./depth, real capture: a later plane behind the raccoon slab. Off, it covers every pixel; on, every pixel is either
  // the plane or exactly what the capture draws alone, and the capture hides the plane where it is solid.
  for (const samples of [1, 4]) {
    const alone = await image({ samples, capture: true }),
      off = await image({ samples, capture: true, afterX: 0.4 }),
      on = await image({ samples, capture: true, afterX: 0.4, depth: true }),
      front = await image({ samples, capture: true, afterX: -0.4, depth: true });
    let covered = 0,
      hidden = 0,
      offBlue = 0,
      frontBlue = 0,
      mixed = 0;
    const px = alone.width * alone.height;
    for (let i = 0; i < px; i++) {
      const a = alone.data.subarray(i * 4, i * 4 + 3),
        n = on.data.subarray(i * 4, i * 4 + 3),
        isBlue = (d) => d[0] === 0 && d[1] === 0 && d[2] === 255;
      if (a[0] + a[1] + a[2] > 30) covered++;
      if (isBlue(off.data.subarray(i * 4, i * 4 + 3))) offBlue++;
      if (isBlue(front.data.subarray(i * 4, i * 4 + 3))) frontBlue++;
      if (isBlue(n)) continue;
      if (n[0] === a[0] && n[1] === a[1] && n[2] === a[2]) hidden++;
      else mixed++;
    }
    report[`depth capture ${samples}x`] = { pixels: px, covered, hidden, offBlue, frontBlue, mixed };
    assert.equal(offBlue, px, `${samples}x: without depth the plane covers the capture`);
    assert.equal(frontBlue, px, `${samples}x: a plane in front of the capture is never hidden`);
    // MSAA can resolve an edge sample of the plane into a capture pixel; at 1x every pixel is one or the other.
    if (samples === 1) assert.equal(mixed, 0, '1x: each pixel is the plane or the capture alone');
    assert.ok(hidden > covered * 0.25, `${samples}x: the capture hides the plane where solid, ${hidden} of ${covered}`);
  }
  // ./lod, real capture: a hierarchy of 1,024-splat nodes. Fully refined (maxError 0) it draws every leaf, the whole
  // capture, as the plain cloud does; far away it draws the root alone.
  {
    const lod = (o) => page.evaluate((options) => window.check.lod(options), o),
      decode = async (url) => decodePNG(Buffer.from(url.split(',')[1], 'base64'));
    const plain = await decode((await lod({ plain: true })).url),
      full = await lod({ maxError: 0, reference: true }),
      reference = await decode(full.reference),
      fullImage = await decode(full.url),
      far = await lod({ distance: 400 });
    let differ = 0,
      most = 0;
    for (let i = 0; i < plain.data.length; i++) {
      const d = Math.abs(plain.data[i] - fullImage.data[i]);
      if (d) differ++;
      most = Math.max(most, d);
    }
    report['lod capture'] = {
      full: { ...full, url: undefined, reference: undefined },
      far: { ...far, url: undefined },
      differ,
      most,
    };
    assert.deepEqual(full.errors, [], 'no load failed');
    assert.equal(full.drawn, full.total, 'maxError 0 draws every leaf splat');
    assert.equal(full.leaves, full.selected.length, 'maxError 0 draws leaves only');
    // After streaming swapped nodes in and out of the slots, the pool draws exactly what one plain cloud of the same
    // splats in the same order draws: no splat of a coarser node is left behind and none is missing.
    let apart = 0;
    for (let i = 0; i < reference.data.length; i++) if (reference.data[i] !== fullImage.data[i]) apart++;
    report['lod capture'].apart = apart;
    assert.equal(apart, 0, `the streamed pool draws as a plain cloud of its splats, ${apart} channels apart`);
    // Against the capture in its own order the splats are the same, but equal sort keys (exact float depth ties, many
    // in a thin slab seen edge on) blend in another order where they overlap: reported, and under 1% of channels.
    assert.ok(differ < plain.data.length / 100, `under 1% of channels differ from the capture's own order, ${differ}`);
    assert.deepEqual(far.selected, [0], 'far away the root alone is drawn');
    assert.ok(far.drawn <= 1024, `the root holds at most a node of splats, ${far.drawn}`);
  }
  // ./lod, stand-in hierarchy of 16,777,216 leaf splats (5.6 times the 3,000,000 cap of one cloud): a 2,097,152 budget
  // streams a cut that never exceeds it, refines near the camera and swaps as the camera moves.
  {
    const big = await page.evaluate(() => window.check.lod({ virtual: true, budget: 2097152, move: [56, 3, 56] }));
    report['lod stand-in'] = { ...big, url: undefined, moved: { ...big.moved, url: undefined } };
    assert.equal(big.total, 16777216);
    assert.deepEqual(big.errors, []);
    assert.ok(
      big.drawn <= 2097152 && big.moved.drawn <= 2097152,
      `within the budget: ${big.drawn}, ${big.moved.drawn}`,
    );
    assert.ok(big.leaves > 0, 'leaves near the camera are drawn');
    assert.notDeepEqual(big.selected, big.moved.selected, 'a moved camera streams another cut');
  }
  // ./set: two clouds sort apart, so the one drawn last covers the other where they overlap; a SplatSet sorts them as
  // one, so it draws what the merged cloud (the same splats in the same order) draws, pixel for pixel.
  for (const samples of [1, 4]) {
    const run = async (o) => {
      const r = await page.evaluate((options) => window.check.set(options), { samples, ...o });
      return { ...r, image: await decodePNG(Buffer.from(r.url.split(',')[1], 'base64')) };
    };
    const compare = (x, y) => {
      let differ = 0,
        far = 0;
      for (let i = 0; i < x.data.length; i++) {
        const d = Math.abs(x.data[i] - y.data[i]);
        if (d) differ++;
        if (d > 8) far++;
      }
      return { differ, far };
    };
    const merged = await run({ mode: 'merged' }),
      separate = await run({ mode: 'separate' }),
      set = await run({ mode: 'set' }),
      moved = await run({ mode: 'set', moved: true, removed: true });
    const apart = compare(separate.image, merged.image),
      together = compare(set.image, merged.image),
      after = compare(moved.image, merged.image);
    report[`set ${samples}x`] = {
      apart,
      together,
      after,
      firsts: set.firsts,
      used: set.used,
      channels: merged.image.data.length,
    };
    assert.ok(
      apart.far > 100,
      `${samples}x: separate clouds blend in the wrong order, ${apart.far} channels off by more than 8`,
    );
    assert.equal(together.differ, 0, `${samples}x: the set draws the merged cloud, ${together.differ} channels apart`);
    assert.equal(
      after.differ,
      0,
      `${samples}x: setMatrix and a removed member leave the same picture, ${after.differ} apart`,
    );
    assert.deepEqual(set.firsts, [0, set.used / 2], 'the freed placeholder range is reused, members in add order');
  }
  // ./lighting, relight: every splat's colour after the pass is its colour times core's diffuse terms, with the normal
  // its flat axis turned to the camera; a round splat takes the view direction; relight false leaves it as it was.
  {
    const normals = [
      [0, 0, 1],
      [0, 0, -1],
      [1, 0, 0],
      [0, 1, 0],
      [0.6, 0.8, 0],
      [0, 0.6, -0.8],
      [0.48, 0.6, 0.64],
      [0, 0, 0],
    ];
    const o = { normals, direction: [0.3, 0.5, 0.8, 3], radiance: [1, 0.9, 0.8, 0.2], ambient: [0.5, 0.6, 1] };
    const r = await page.evaluate((options) => window.check.relight(options), o);
    const off = await page.evaluate((options) => window.check.relight(options), { ...o, relight: false });
    const l = o.direction.slice(0, 3),
      ll = Math.hypot(...l);
    let worst = 0;
    normals.forEach((nv, i) => {
      const p = r.positions.slice(i * 3, i * 3 + 3),
        eye = [-p[0], -p[1], 3 - p[2]],
        el = Math.hypot(...eye);
      let n = Math.hypot(...nv) ? nv : eye.map((v) => v / el);
      if (n[0] * eye[0] + n[1] * eye[1] + n[2] * eye[2] < 0) n = n.map((v) => -v);
      const nl = Math.max(0, (n[0] * l[0] + n[1] * l[1] + n[2] * l[2]) / ll);
      for (let k = 0; k < 3; k++) {
        const want =
          r.input[i * 4 + k] * ((o.radiance[k] * o.direction[3] * nl) / Math.PI + o.radiance[3] * o.ambient[k]);
        worst = Math.max(worst, Math.abs(r.colors[i * 4 + k] - want));
        assert.equal(off.colors[i * 4 + k], Math.fround(r.input[i * 4 + k]), 'relight false keeps the colour');
      }
      assert.equal(r.colors[i * 4 + 3], Math.fround(r.input[i * 4 + 3]), 'opacity is kept');
    });
    report['lighting relight'] = { worst };
    // float32 maths on colours below 2: the flat axis of a 1e-6 to 0.01 covariance is good to about 1e-3 radian.
    assert.ok(worst < 2e-3, `relit colours match core's diffuse terms, worst ${worst}`);
  }
  // ./lighting, shadows: with the cloud added to Shadows, the ground beside it darkens where its shadow falls; without,
  // the ground there is as lit as everywhere else. Pixels far from the cloud and its shadow do not change.
  for (const capture of [false, true]) {
    const shot = async (cast) =>
      decodePNG(
        Buffer.from(
          (await page.evaluate((o) => window.check.splatShadow(o), { cast, capture })).url.split(',')[1],
          'base64',
        ),
      );
    const off = await shot(false),
      on = await shot(true);
    const changed = [];
    let darker = 0,
      brighter = 0,
      cx = 0,
      cy = 0;
    for (let i = 0; i < off.data.length; i += 4) {
      const d = off.data[i] + off.data[i + 1] + off.data[i + 2] - (on.data[i] + on.data[i + 1] + on.data[i + 2]),
        x = (i / 4) % off.width,
        y = Math.floor(i / 4 / off.width);
      if (d) changed.push([x, y]);
      if (d < -3) brighter++;
      if (d > 30) {
        darker++;
        cx += x;
        cy += y;
      }
    }
    cx /= darker || 1;
    cy /= darker || 1;
    const offset = Math.hypot(cx - off.width / 2, cy - off.height / 2),
      spread = Math.max(...changed.map(([x, y]) => Math.hypot(x - cx, y - cy)));
    report[`lighting shadow ${capture ? 'capture' : 'disc'}`] = {
      darker,
      brighter,
      changed: changed.length,
      offset,
      spread,
    };
    // The capture (8,385 splats) is a thin figure: its shadow is a line drawing, not a filled shape.
    assert.ok(
      darker > (capture ? 60 : 200),
      `${capture ? 'the capture' : 'the disc'} shadows the ground: ${darker} pixels darker`,
    );
    assert.equal(brighter, 0, 'casting never lightens a pixel');
    // The sun is 31 degrees off vertical, so the shadow sits beside the cloud (at the centre) and nothing else changes.
    assert.ok(offset > 10, `the shadow lands beside the cloud, ${offset} px from it`);
    assert.ok(spread < 80, `only the shadow changes, ${spread} px across`);
  }
  // ./edit, synthetic grid: picking takes the nearest splat at a pixel (64, in front of 36 and 65), honours the
  // threshold and finds nothing on the background; erase, select (replace, add, subtract) and paint change exactly the
  // splats whose projected centres are in the region, on the GPU, and commit reads them back.
  {
    const near = [0.1, 0.1, 0.5],
      grid = (i) => [-0.7 + (i % 8) * 0.2, -0.7 + Math.floor(i / 8) * 0.2, 0],
      steps = [
        ['pick', near],
        ['pick', near, 0.99],
        ['pickAt', 2, 2],
        ['pick', grid(0)],
        ['erase', { world: near, radius: 0.5 }],
        ['draw'],
        ['pick', near],
        ['select', { half: 'left' }],
        ['select', { world: grid(36), radius: 4 }, 'add'],
        ['select', { world: grid(0), radius: 4 }, 'subtract'],
        ['selection'],
        ['erase', 'selection'],
        ['paint', { half: 'right' }, [0, 1, 0], 1],
        ['commit'],
      ];
    const r = await page.evaluate((o) => window.check.brush(o), { steps, points: [grid(1), grid(7), grid(0)] }),
      [nearest, strict, background, corner, , behind, , , , selected, , , committed] = r.out;
    report['edit picks'] = { nearest, strict, background, corner, behind, frame: r.frame };
    assert.equal(nearest, 64, 'the pick takes the nearest splat at the pixel, not the lowest index');
    assert.equal(strict, -1, 'no splat reaches opacity 0.99 at the pixel');
    assert.equal(background, -1, 'nothing at the corner');
    assert.equal(corner, 0, 'the corner splat');
    assert.equal(behind, 36, 'after erasing the front splat the grid splat behind it is nearest');
    const left = Array.from({ length: 64 }, (_, i) => i).filter((i) => i % 8 < 4 && i !== 0);
    assert.deepEqual(
      selected,
      [...left, 36, 65].sort((a, b) => a - b),
      'select replace, add and subtract',
    );
    for (let i = 0; i < 66; i++) {
      const got = committed.colors.slice(i * 4, i * 4 + 4),
        erased = i === 64 || selected.includes(i),
        green = !erased && i < 64 && i % 8 >= 4;
      const want = erased
        ? [...r.input.slice(i * 4, i * 4 + 3), 0]
        : green
          ? [0, 1, 0, r.input[i * 4 + 3]]
          : r.input.slice(i * 4, i * 4 + 4);
      assert.deepEqual(got, want.map(Math.fround), `splat ${i} after erase and paint`);
    }
    const img = await decodePNG(Buffer.from(r.url.split(',')[1], 'base64')),
      at = ([x, y]) => [
        ...img.data.subarray(
          (Math.floor(y) * img.width + Math.floor(x)) * 4,
          (Math.floor(y) * img.width + Math.floor(x)) * 4 + 3,
        ),
      ];
    const [gone, painted, kept] = r.points.map(at);
    report['edit image'] = { gone, painted, kept };
    assert.ok(
      gone[0] < 40 && painted[1] > 150 && painted[0] < 60 && kept[0] > 150,
      `erased, painted and kept splats draw so: ${gone} ${painted} ${kept}`,
    );
  }
  // ./edit, SH cloud: paint sets the DC term to the blended colour and fades the higher bands by the strength.
  {
    const r = await page.evaluate((o) => window.check.brush(o), {
        sh: true,
        steps: [['paint', 'all', [0, 0, 1], 0.5], ['commit']],
      }),
      { colors, sh } = r.out[1];
    let worst = 0;
    for (let i = 0; i < 66; i++)
      for (let k = 0; k < 3; k++) {
        const c = r.input[i * 4 + k],
          want = c + (k === 2 ? 1 - c : -c) * 0.5;
        worst = Math.max(
          worst,
          Math.abs(colors[i * 4 + k] - want),
          Math.abs(0.5 + 0.2820947918 * sh[i * 12 + k] - want),
        );
        for (let j = 1; j < 4; j++) worst = Math.max(worst, Math.abs(sh[i * 12 + j * 3 + k] - 0.05));
      }
    report['edit sh'] = { worst };
    assert.ok(worst < 1e-5, `SH paint matches the formula, worst ${worst}`);
  }
  // ./edit, real capture: a pick at the centre finds a splat; a brush there erases what it selects, and only that.
  {
    const r = await page.evaluate((o) => window.check.brush(o), {
        capture: true,
        steps: [['pickCentre'], ['selectCentre', 12], ['selection'], ['erase', 'selection'], ['commit']],
      }),
      [index, , selected, , committed] = r.out;
    let wrong = 0;
    for (let i = 0; i < r.input.length / 4; i++) {
      const want = selected.includes(i) ? 0 : r.input[i * 4 + 3];
      if (committed.colors[i * 4 + 3] !== Math.fround(want)) wrong++;
    }
    report['edit capture'] = { index, selected: selected.length, wrong };
    assert.ok(index >= 0, 'a splat at the centre of the capture');
    assert.ok(
      selected.length > 20 && selected.length < r.input.length / 8,
      `the brush selects a patch: ${selected.length}`,
    );
    assert.equal(wrong, 0, 'exactly the selected splats are erased');
  }
  // Root `antialias` (Mip-Splatting's 2D filter): off, every splat keeps opacity 0.9; on, an isotropic splat of screen
  // variance s keeps 0.9 s / (s + 0.3). From the two ratios of the same splat at distances 3 and 23, s falls with the
  // square of the distance (23/3)^2, so the filter follows the projected size; a splat about 4 px across (s near 14)
  // keeps 0.95 of its opacity or more.
  {
    const r = await page.evaluate(() => window.check.antialias()),
      ratio = r.on.map((v, i) => v / r.off[i]),
      s = ratio.map((t) => (0.3 * t) / (1 - t));
    report.antialias = { off: r.off, on: r.on, variances: s };
    for (const v of r.off) assert.ok(Math.abs(v - 0.9) < 1e-6, `off keeps opacity: ${v}`);
    assert.ok(r.flag === true);
    assert.ok(ratio[1] < ratio[0] && ratio[1] < 0.5, `the far splat fades: ${ratio}`);
    assert.ok(Math.abs(s[0] / s[1] / (23 / 3) ** 2 - 1) < 1e-3, `screen variance falls with distance squared: ${s}`);
    assert.ok(Math.abs(s[2] / s[0] - 100) < 0.1, `and grows with the world variance: ${s}`);
    assert.ok(ratio[2] > 0.95, `a large splat keeps its opacity: ${ratio[2]}`);
  }
  // ./animate: a two-frame sequence at 30% of the way mixes centres, covariances and colours; a skin with joint 0
  // moving 1 along x and joint 1 turning 90 degrees about z poses each splat by its blended matrix, A S A^T.
  {
    const r = await page.evaluate((o) => window.check.animate(o), { sequence: 0.3 }),
      close = (a, b, what) =>
        a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-5, `${what} ${i}: ${v} against ${b[i]}`));
    close(r.positions, [-0.38, 0, 0, 0.12, 0.2, 0, 0.62, 0, 0], 'sequence centre');
    close(r.covariances.slice(0, 6), [0.0031, 0, 0, 0.001, 0, 0.001], 'sequence covariance');
    close(r.colors.slice(0, 4), [0.76, 0, 0, 0.9], 'sequence colour');
    const s = await page.evaluate((o) => window.check.animate(o), {});
    // Splat 1 at (0, 0.2) turns to (-0.2, 0); its long x axis (0.004) becomes y. Splat 2 takes the half-half blend:
    // centre (0.5, 0) to (0.75, 0.25), linear part [[0.5, -0.5], [0.5, 0.5]].
    close(s.positions, [0.5, 0, 0, -0.2, 0, 0, 0.75, 0.25, 0], 'skin centre');
    close(s.covariances.slice(0, 6), [0.004, 0, 0, 0.001, 0, 0.001], 'skin translate keeps the covariance');
    close(s.covariances.slice(6, 12), [0.001, 0, 0, 0.004, 0, 0.001], 'skin rotation turns the covariance');
    close(s.covariances.slice(12, 18), [0.00125, 0.00075, 0, 0.00125, 0, 0.001], 'skin blend');
    close(s.colors, [1, 0, 0, 0.9, 1, 0, 0, 0.9, 1, 0, 0, 0.5], 'skin keeps colours');
    report.animate = { sequence: r.positions.slice(0, 3), skin: s.positions };
  }
  // ./data: the SOG writer's WebP images decode in the browser (createImageBitmap, then a WebGPU texture without
  // premultiplication or colour conversion) to the exact pixels written, alpha included.
  {
    let seed = 11;
    const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 2 ** 24,
      images = [
        [61, 23, () => random() * 256],
        [64, 64, (i) => (i % 4 === 3 ? 255 : -Math.log(random() + 1e-9) * 6)],
        [7, 5, (i) => (i % 4 === 3 ? 252 + (i % 3) : 128)],
      ].map(([width, height, fill]) => {
        const pixels = Uint8Array.from({ length: width * height * 4 }, (_, i) => Math.min(255, Math.floor(fill(i))));
        return { width, height, pixels: [...pixels], file: [...encodeWebpLossless(pixels, width, height)] };
      });
    const wrong = await page.evaluate(async (list) => {
      const device = await (await navigator.gpu.requestAdapter()).requestDevice(),
        out = [];
      for (const { width, height, pixels, file } of list) {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(file)], { type: 'image/webp' }), {
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
          }),
          texture = device.createTexture({
            size: [width, height],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
          }),
          row = Math.ceil((width * 4) / 256) * 256,
          buffer = device.createBuffer({
            size: row * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: false }, [
          width,
          height,
        ]);
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [width, height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const got = new Uint8Array(buffer.getMappedRange());
        let bad = 0;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width * 4; x++) if (got[y * row + x] !== pixels[y * width * 4 + x]) bad++;
        out.push([bitmap.width, bitmap.height, bad]);
      }
      return out;
    }, images);
    report['data webp'] = wrong;
    images.forEach(({ width, height }, i) =>
      assert.deepEqual(wrong[i], [width, height, 0], `WebP ${width} x ${height}`),
    );
  }
  // ./pick: one depth test with meshes. The front splat beats the plane behind it, the plane beats the grid splat
  // behind it, a gap and the background miss; pickMany answers what engine.pick answers; a threshold over the splats'
  // opacity lets the plane through; a splat erased on the GPU is gone; after dispose only meshes answer. Perspective
  // and orthographic.
  {
    const points = [
      [0.1, 0.1, 0.5],
      [0.3, 0.3, 0],
      [-0.7, -0.7, 0],
      [-0.6, -0.6, 0],
    ];
    for (const orthographic of [false, true]) {
      const tag = orthographic ? 'orthographic' : 'perspective',
        r = await page.evaluate((o) => window.check.splatPick(o), { points, orthographic }),
        strict = await page.evaluate((o) => window.check.splatPick(o), { points, orthographic, threshold: 0.99 }),
        erased = await page.evaluate((o) => window.check.splatPick(o), { points, orthographic, erase: true });
      report[`pick ${tag}`] = { ...r, strict: strict.one, erased: erased.one };
      assert.deepEqual(r.one, [64, 'mesh', 0, -1], `${tag}: picking.pick takes the nearest of splats and meshes`);
      assert.deepEqual(
        r.meshes,
        ['cloud', 'mesh', 'cloud', -1],
        `${tag}: engine.pick answers the stand-in mesh for a splat`,
      );
      assert.deepEqual(r.many, r.one, `${tag}: pickMany answers as picking.pick`);
      assert.deepEqual(r.after, ['mesh', 'mesh', -1, -1], `${tag}: after dispose the splats are not picked`);
      assert.deepEqual(
        strict.one,
        ['mesh', 'mesh', -1, -1],
        `${tag}: no splat reaches opacity 0.99, so the plane is hit`,
      );
      assert.deepEqual(
        erased.one,
        ['mesh', 'mesh', 0, -1],
        `${tag}: a splat the brush erased on the GPU is not picked`,
      );
    }
  }
  const streamed = await page.evaluate(() => window.check.progressive());
  const earlyImage = await decodePNG(Buffer.from(streamed.early.split(',')[1], 'base64'));
  assert.equal(streamed.count, 8385);
  assert.equal(streamed.visible, 8385);
  assert.notEqual(streamed.early, streamed.final, 'later bytes visibly refine the streamed real capture');
  assert.ok(
    earlyImage.data.some((v, i) => i % 4 !== 3 && v > 10),
    'partial capture draws before the remaining network bytes',
  );
  report.progressive = { count: streamed.count, visible: streamed.visible };
  await checkStreamedSog(page);
  await checkModifiers(page);
  const errors = await page.evaluate(() => window.check.errors);
  console.log(JSON.stringify(report));
  assert.deepEqual(errors.concat(pageErrors), [], 'no GPU or shader errors');
  console.log('splats GPU check passed');
} finally {
  await context.close();
  release();
}
