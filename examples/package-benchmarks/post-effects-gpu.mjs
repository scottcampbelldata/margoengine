// Real-GPU checks of post's newer effects against closed forms (post-effects.html). Run after npm run build:packages,
// holding the GPU lock:  node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/post-effects-gpu.mjs [--only=gtao]
// Each section writes examples/package-benchmarks/results/<section>-gpu.json; frames go to test-results/post-*.png.
//
// gtao: GTAO's occlusion of the ambient light (linear: the frame with GTAO over the frame with it disabled, direct light
//   off) against the cosine-weighted visibility of a point on a floor where a plane through it closes the hemisphere to
//   a wedge of angle b: (1 - cos b) / 2, so 0.5 at a 90-degree crease, 0.25 at 60 and 0.75 at 120 degrees, and 1 on the
//   open floor. Perspective 4x and 1x, orthographic; GTAO.attach alone leaves the open floor unchanged; in a stack with
//   SSR and Bloom and under TAA no errors and no NaN.
// ssgi: one bounce, ambient light only (ambient 1, direct light off), a white floor before a red 4 x 2 m wall. Where a
//   ray from the floor hits the wall, SSGI swaps the floor's ambient light (1, 1, 1) for the wall's (1, 0, 0), so the
//   floor keeps red and loses green in proportion to the share of its cosine-weighted hemisphere the wall covers: the
//   form factor F from a floor point to the wall rectangle, integrated here. Measured as 1 - green(on) / green(off),
//   against F at 5 cm to 2 m from the wall; red stays (ratio 1). Core floor 4x and 1x, a gltf-pro floor added to SSGI
//   and SSR (one capture hook, shared), orthographic; with GTAO, SSR and TAA no errors and no NaN.
// motion: a white box before a dark wall, ambient light only. A rigid motion of r pixels of blur radius (half the motion
//   over the open shutter) turns the frame into its box average along the motion, 2r wide: measured as coverage of the
//   box along its centre row (linear light) against the unblurred frame filtered with that box. Uniform 40 px/frame
//   motion from a velocity texture (HDR stage, 4x and 1x); a box moving 40 px/frame under TAA (taa.velocity, blurred
//   after TAA's resolve); TAA's resolved frame is identical with and without MotionBlur (no blurred frame in its history);
//   at rest under TAA the velocity texture equals taa.velocity.jitter everywhere and MotionBlur changes nothing.
// flare: the flare (frame with LensFlare minus without, linear) peaks at the sun's projected pixel; it is mirror-
//   symmetric about the line from the sun through the screen centre, with its ghosts on that line; a box over the sun
//   hides it exactly (no change); a box whose edge splits the occlusion disc leaves exactly the share of the disc's
//   depth samples that see past it (counted from the frame without the flare); behind the camera or with strength 0
//   nothing; orthographic: the peak at the projected pixel; in a stack with SSR and Bloom and alone, no errors.
// ssr-surfaces: SSR on terrain and water added with ssr.add. A red box above the surface appears in it inside the
//   planar mirror of the box through y = 0 (the surface's own depth: water's in SSR's depth, not the seabed's) and at the
//   mirrored centre (within 6 px; 16 px on water, whose ripples bend it); on water the reflection replaces the water's sky reflection instead of adding to it (green falls
//   at the mirrored centre). 4x and 1x; no black (NaN) pixels.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { openBrowser } from '../../scripts/browser.js';
import { decodePNG } from '../../tests/support/png.js';

const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',');
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const context = await openBrowser({
    startPath: '/examples/package-benchmarks/post-effects.html',
    port: 5253,
    args: ['--enable-webgpu-developer-features'],
  }),
  { page, hardware } = context,
  pageErrors = [];
page.setDefaultTimeout(120_000);
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const header = () => ({
  date: new Date().toISOString(),
  commit,
  gpu: hardware.webgpu,
  browser: hardware.browserName + ' ' + hardware.browserVersion,
});
const run = async (config) => {
  const info = await page.evaluate((c) => window.check.run(c), config);
  assert.deepEqual(info.errors, [], JSON.stringify(config));
  return info;
};
const set = async (name, values) =>
  assert.deepEqual((await page.evaluate((a) => window.check.set(...a), [name, values])).errors, []);
/** The probe's linear float frame: {width, height, at(x, y) -> [r, g, b, a]}. */
async function read() {
  const r = await page.evaluate(() => window.check.read());
  assert.deepEqual(r.errors, []);
  const bytes = Buffer.from(r.data, 'base64'),
    floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
    stride = r.row / 4;
  return {
    width: r.width,
    height: r.height,
    at: (x, y) => {
      const i = Math.round(y) * stride + Math.round(x) * 4;
      return [floats[i], floats[i + 1], floats[i + 2], floats[i + 3]];
    },
    nan: () => {
      let n = 0;
      for (let y = 0; y < r.height; y++)
        for (let x = 0; x < r.width * 4; x++) if (!Number.isFinite(floats[y * stride + x])) n++;
      return n;
    },
  };
}
const grab = async (name) =>
  decodePNG(await page.locator('canvas').screenshot({ path: `test-results/post-${name}.png` }));
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const round = (v, n = 3) => +v.toFixed(n);
// Form factor from a floor point (normal +y) at distance d in front of a wall rectangle (normal +z) of the given width
// (centred on x) and height: (1 / pi) * integral of cos * cos / r^2 over the rectangle, by the midpoint rule.
function formFactor(x0, d, width, height, n = 400) {
  let sum = 0;
  const dx = width / n,
    dy = height / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = -width / 2 + (i + 0.5) * dx - x0,
        y = (j + 0.5) * dy,
        r2 = x * x + y * y + d * d;
      sum += ((y * d) / (r2 * r2)) * dx * dy;
    }
  return sum / Math.PI;
}
const srgb = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
/** Coverage of the white box along a row: (v - background) / (box - background). */
const coverage = (row) => {
  const lo = Math.min(...row),
    hi = Math.max(...row);
  return row.map((v) => (v - lo) / (hi - lo));
};
/** A row filtered with a box of radius r pixels (pixel u overlaps [-r, r] by clamp(r + 0.5 - |u|, 0, 1)). */
const boxFilter = (row, r) =>
  row.map((_, x) => {
    let sum = 0,
      total = 0;
    for (let u = -Math.ceil(r + 0.5); u <= Math.ceil(r + 0.5); u++) {
      const w = Math.max(0, Math.min(1, r + 0.5 - Math.abs(u)));
      sum += row[Math.min(row.length - 1, Math.max(0, x + u))] * w;
      total += w;
    }
    return sum / total;
  });
/** Largest |measured - expected| over the pixels where either is between 0.02 and 0.98 (the ramps). */
function rampError(measured, expected) {
  let worst = 0,
    count = 0;
  for (let x = 0; x < measured.length; x++)
    if (Math.max(measured[x], expected[x]) > 0.02 && Math.min(measured[x], expected[x]) < 0.98) {
      worst = Math.max(worst, Math.abs(measured[x] - expected[x]));
      count++;
    }
  return { worst: round(worst), pixels: count };
}
const sections = {
  async gtao() {
    const report = { ...header(), checks: {} },
      gtao = { radius: 2, slices: 4, steps: 8 };
    for (const [name, config] of Object.entries({
      'persp-4x': {},
      'persp-1x': { samples: 1 },
      'ortho-4x': { camera: 'ortho' },
    })) {
      const info = await run({ ...config, stack: [['gtao', gtao]] }),
        on = await read();
      await set('gtao', { enabled: false });
      const off = await read();
      const ao = (p) => on.at(...p)[0] / off.at(...p)[0];
      const creases = info.creases.map((c) => {
        const near = c.profile.slice(0, 2).map((p) => ao(p.pixel)),
          along = c.pixels.map((p) => [p[0], p[1] + 2]).map(ao);
        return {
          wedgeDegrees: round((c.wedge * 180) / Math.PI, 1),
          expected: round(c.expected),
          measured: round(median(near)),
          alongCrease: along.map((v) => round(v)),
          profile: c.profile.map((p) => ({ d: p.d, ao: round(ao(p.pixel)) })),
        };
      });
      const open = info.open.map(ao);
      report.checks[name] = { creases, open: open.map((v) => round(v)), nan: on.nan() };
      console.log(name, JSON.stringify(report.checks[name]));
      assert.equal(on.nan(), 0, `${name}: NaN in the GTAO frame`);
      for (const v of open) assert.ok(Math.abs(v - 1) < 0.03, `${name}: open floor occluded (${v})`);
      for (const c of creases) {
        assert.ok(
          Math.abs(c.measured - c.expected) < 0.07,
          `${name}: ${c.wedgeDegrees} degree crease ${c.measured}, closed form ${c.expected}`,
        );
        assert.ok(c.profile.at(-1).ao > c.measured + 0.1, `${name}: occlusion does not fall off with distance`);
      }
    }
    // Alone (its own one-effect stack, tone mapped like SSAO alone): the open floor is unchanged, the crease darker.
    const info = await run({ alone: gtao, probe: false, light: true }),
      lit = await grab('gtao-alone-on');
    await set('gtao', { enabled: false });
    const unlit = await grab('gtao-alone-off'),
      byte = (img, [x, y]) => img.data[(Math.round(y) * img.width + Math.round(x)) * 4 + 1];
    const openDiff = Math.max(...info.open.map((p) => Math.abs(byte(lit, p) - byte(unlit, p)))),
      crease = info.creases[0].profile[0].pixel;
    report.checks.alone = { openDiff, creaseOn: byte(lit, crease), creaseOff: byte(unlit, crease) };
    console.log('alone', JSON.stringify(report.checks.alone));
    assert.ok(openDiff <= 1, 'GTAO alone changed the open floor');
    assert.ok(byte(lit, crease) < byte(unlit, crease) - 4, 'GTAO alone did not darken the crease');
    // Combined: SSR and Bloom after it, and TAA around the stack.
    for (const [name, config] of Object.entries({
      'gtao+ssr+bloom': {
        stack: [
          ['gtao', gtao],
          ['ssr', {}],
          ['bloom', { strength: 0.3 }],
        ],
        light: true,
      },
      'taa': { stack: [['gtao', gtao]], taa: true, frames: 12, light: true },
    })) {
      await run(config);
      const frame = await read();
      report.checks[name] = { nan: frame.nan() };
      assert.equal(frame.nan(), 0, `${name}: NaN`);
    }
    return report;
  },
  async motion() {
    const report = { ...header(), checks: {} },
      blur = { shutter: 0.5, samples: 32, maxBlur: 32 },
      radius = (40 * blur.shutter) / 2;
    // 1. Uniform motion from a velocity texture: the HDR stage in the stack.
    for (const [name, config] of Object.entries({ 'uniform-4x': {}, 'uniform-1x': { samples: 1 } })) {
      const info = await run({ scene: 'moving', vectors: [40, 0], stack: [['motion', blur]], ...config }),
        on = await read();
      await set('motion', { enabled: false });
      const off = await read(),
        row = (f) => Array.from({ length: f.width }, (_, x) => f.at(x, info.boxRow)[1]);
      const measured = coverage(row(on)),
        expected = boxFilter(coverage(row(off)), radius);
      report.checks[name] = { radius, ...rampError(measured, expected), nan: on.nan() };
      console.log(name, JSON.stringify(report.checks[name]));
      assert.equal(on.nan(), 0);
      assert.ok(report.checks[name].pixels >= 3 * radius, `${name}: no ramp`);
      assert.ok(
        report.checks[name].worst < 0.08,
        `${name}: blur is not the shutter's box (${report.checks[name].worst})`,
      );
    }
    // 2. A box moving 40 px per frame under TAA: blurred after TAA, TAA's history untouched.
    const probe = await run({ scene: 'moving' }),
      speed = 40 / probe.pixelsPerMetre,
      moving = (enabled) => ({
        scene: 'moving',
        speed,
        taa: true,
        vectors: 'taa',
        probe: false,
        frames: 12,
        stack: [['motion', { ...blur, enabled }]],
      });
    const decode = async (texture) => {
      const r = await page.evaluate((w) => window.check.texture(w), texture);
      assert.deepEqual(r.errors, []);
      const b = Buffer.from(r.data, 'base64');
      return { ...r, values: new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) };
    };
    const blurred = await run(moving(true)),
      shot = await grab('motion-taa-on'),
      resolvedOn = await decode('resolved');
    await run(moving(false));
    const sharp = await grab('motion-taa-off'),
      resolvedOff = await decode('resolved');
    let history = 0;
    for (let i = 0; i < resolvedOn.values.length; i++)
      history = Math.max(history, Math.abs(resolvedOn.values[i] - resolvedOff.values[i]));
    const line = (img) =>
      Array.from({ length: img.width }, (_, x) => srgb(img.data[(blurred.boxRow * img.width + x) * 4 + 1]));
    const taaRamp = rampError(coverage(line(shot)), boxFilter(coverage(line(sharp)), radius));
    report.checks['taa-moving'] = { pixelsPerFrame: 40, radius, ...taaRamp, historyMaxDiff: history };
    console.log('taa-moving', JSON.stringify(report.checks['taa-moving']));
    assert.equal(history, 0, "MotionBlur changed TAA's resolved frame (history)");
    assert.ok(taaRamp.pixels >= 3 * radius && taaRamp.worst < 0.12, `taa-moving: blur ramp off (${taaRamp.worst})`);
    // 3. At rest under TAA: velocity = jitter everywhere, so nothing blurs.
    // Two runs to the same frame: TAA's own edge pixels change from frame to frame.
    const rest = (enabled) => ({
      scene: 'moving',
      taa: true,
      vectors: 'taa',
      probe: false,
      frames: 12,
      stack: [['motion', { ...blur, enabled }]],
    });
    await run(rest(true));
    const still = await grab('motion-rest-on'),
      velocity = await decode('velocity');
    await run(rest(false));
    const plain = await grab('motion-rest-off');
    let residual = 0,
      diff = 0;
    for (let i = 0; i < velocity.width * velocity.height; i++)
      for (let c = 0; c < 2; c++)
        residual = Math.max(residual, Math.abs(velocity.values[i * 4 + c] - velocity.jitter[c]));
    for (let i = 0; i < still.data.length; i++) diff = Math.max(diff, Math.abs(still.data[i] - plain.data[i]));
    report.checks.rest = {
      jitterPixels: velocity.jitter.map((v, i) => round(v * [velocity.width, velocity.height][i], 3)),
      velocityMinusJitter: residual,
      frameDiff: diff,
    };
    console.log('rest', JSON.stringify(report.checks.rest));
    assert.ok(Math.hypot(...velocity.jitter) > 0, 'the jitter difference is zero: the check proves nothing');
    assert.ok(residual < 2e-5, `velocity at rest is not the published jitter (${residual})`);
    assert.ok(diff <= 1, `MotionBlur changed a frame at rest (${diff})`);
    // 4. Alone (its own stack) and with GTAO, SSR, Bloom under TAA.
    await run({ scene: 'moving', vectors: [40, 0], probe: false, alone: blur, aloneEffect: 'motion' });
    await run({
      scene: 'moving',
      speed,
      taa: true,
      vectors: 'taa',
      frames: 12,
      light: true,
      stack: [
        ['gtao', {}],
        ['ssr', {}],
        ['motion', blur],
        ['bloom', { strength: 0.3 }],
      ],
    });
    const all = await read();
    report.checks.combined = { nan: all.nan() };
    assert.equal(all.nan(), 0);
    return report;
  },
  async flare() {
    const report = { ...header(), checks: {} },
      flare = { intensity: 1, occlusionRadius: 12 },
      sunPixel = [300, 280];
    const added = async (config) => {
      const info = await run({ scene: 'sun', stack: [['flare', flare]], ...config }),
        on = await read();
      await set('flare', { enabled: false });
      const off = await read();
      let energy = 0,
        peak = -1,
        at = null;
      const diff = (x, y) => on.at(x, y)[1] - off.at(x, y)[1];
      for (let y = 0; y < on.height; y++)
        for (let x = 0; x < on.width; x++) {
          const d = diff(x, y);
          energy += d;
          if (d > peak) {
            peak = d;
            at = [x, y];
          }
        }
      return { info, on, off, diff, energy, peak, at };
    };
    const open = await added({ sunPixel });
    const [sx, sy] = open.info.sun.pixel,
      cx = open.on.width / 2,
      cy = open.on.height / 2,
      len = Math.hypot(sx - cx, sy - cy),
      ux = (sx - cx) / len,
      uy = (sy - cy) / len;
    // Mirror symmetry about the sun-centre line: the flare-weighted mean signed distance from it.
    let moment = 0,
      weight = 0;
    for (let y = 0; y < open.on.height; y++)
      for (let x = 0; x < open.on.width; x++) {
        const d = Math.max(0, open.diff(x, y));
        moment += d * ((x + 0.5 - cx) * -uy + (y + 0.5 - cy) * ux);
        weight += d;
      }
    // Ghost centres (fractions of sun - centre, radii as fractions of the height) from the shader: brighter at each
    // centre than two radii off the line on either side.
    const ghosts = [
      [-0.25, 0.05],
      [-0.55, 0.03],
      [-0.85, 0.08],
      [-1.15, 0.04],
    ].map(([k, r]) => {
      const gx = cx + k * (sx - cx),
        gy = cy + k * (sy - cy),
        off = 2 * r * open.on.height;
      return {
        k,
        centre: round(open.diff(gx, gy), 4),
        aside: round(Math.max(open.diff(gx - uy * off, gy + ux * off), open.diff(gx + uy * off, gy - ux * off)), 4),
      };
    });
    report.checks.open = {
      sunPixel: open.info.sun.pixel.map((v) => round(v, 2)),
      peakAt: open.at,
      energy: round(open.energy, 2),
      symmetryOffsetPixels: round(moment / weight, 3),
      ghosts,
    };
    console.log('open', JSON.stringify(report.checks.open));
    assert.ok(Math.hypot(open.at[0] + 0.5 - sx, open.at[1] + 0.5 - sy) <= 1.5, 'flare peak away from the sun');
    assert.ok(Math.abs(moment / weight) < 0.5, 'flare not symmetric about the sun-centre line');
    for (const g of ghosts) assert.ok(g.centre > 2 * g.aside && g.centre > 0, `no ghost at ${g.k} of sun - centre`);
    // Fully covered: nothing; half covered: exactly the share of disc samples that see past the box.
    const full = await added({ sunPixel, occluder: 'full' });
    const half = await added({ sunPixel, occluder: 'half' });
    let open64 = 0,
      count = 0;
    const background = half.off.at(2, 2)[1],
      box = half.off.at(half.info.sun.pixel[0] + 3 * flare.occlusionRadius, half.info.sun.pixel[1])[1];
    const r = flare.occlusionRadius,
      [hx, hy] = half.info.sun.pixel;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const ox = (x + 0.5) / 4 - 1,
          oy = (y + 0.5) / 4 - 1;
        if (ox * ox + oy * oy > 1) continue;
        count++;
        // Background (the clear colour, a corner pixel) or the dark box (inside it, right of the sun)?
        const v = half.off.at(Math.floor(hx + ox * r), Math.floor(hy + oy * r))[1];
        if (Math.abs(v - background) < Math.abs(v - box)) open64++;
      }
    report.checks.occlusion = {
      full: round(full.energy, 4),
      half: round(half.energy / open.energy, 4),
      expectedHalf: round(open64 / count, 4),
    };
    console.log('occlusion', JSON.stringify(report.checks.occlusion));
    assert.equal(full.energy, 0, 'a covered sun still flares');
    assert.ok(open64 > 0 && open64 < count, 'the half occluder misses the disc');
    assert.ok(Math.abs(half.energy / open.energy - open64 / count) < 0.01, 'partial occlusion off its share');
    // Behind the camera, and with strength 0.
    const behind = await added({ sunDirection: [0, 0, 1] }),
      down = await added({ sunPixel, sunStrength: 0 });
    report.checks.hidden = { behind: behind.energy, strengthZero: down.energy };
    assert.equal(behind.energy, 0);
    assert.equal(down.energy, 0);
    // Orthographic: the peak at the sun's projection there too.
    const ortho = await added({ camera: 'ortho', sunDirection: [0.02, 0.025, -1] });
    report.checks.ortho = { sunPixel: ortho.info.sun.pixel.map((v) => round(v, 2)), peakAt: ortho.at };
    console.log('ortho', JSON.stringify(report.checks.ortho));
    assert.ok(
      Math.hypot(ortho.at[0] + 0.5 - ortho.info.sun.pixel[0], ortho.at[1] + 0.5 - ortho.info.sun.pixel[1]) <= 1.5,
    );
    await run({
      scene: 'sun',
      sunPixel,
      stack: [
        ['ssr', {}],
        ['flare', flare],
        ['bloom', { strength: 0.3 }],
      ],
    });
    await run({ scene: 'sun', sunPixel, probe: false, alone: flare, aloneEffect: 'flare' });
    return report;
  },
  async 'ssr-surfaces'() {
    const report = { ...header(), checks: {} };
    for (const [name, config] of Object.entries({
      'terrain-4x': { surface: 'terrain' },
      'terrain-1x': { surface: 'terrain', samples: 1 },
      'water-4x': { surface: 'water' },
      'water-1x': { surface: 'water', samples: 1 },
    })) {
      const info = await run({ scene: 'reflect', stack: [['ssr', {}]], probe: false, light: true, ...config }),
        on = await grab(`ssr-${name}-on`);
      await set('ssr', { enabled: false });
      const off = await grab(`ssr-${name}-off`),
        px = (img, x, y) => {
          const i = (y * img.width + x) * 4;
          return [img.data[i], img.data[i + 1], img.data[i + 2]];
        };
      let red = 0,
        outside = 0,
        black = 0;
      // Water's ripples bend its reflection by up to a few pixels more than a flat mirror would.
      const [x0, y0, x1, y1] = info.mirror,
        margin = config.surface === 'water' ? 16 : 6;
      for (let y = 0; y < on.height; y++)
        for (let x = 0; x < on.width; x++) {
          const a = px(on, x, y),
            b = px(off, x, y);
          if (a[0] + a[1] + a[2] === 0 && b[0] + b[1] + b[2] > 0) black++;
          // Reflected red: red minus green grew by more than 20 with SSR.
          if (a[0] - a[1] - (b[0] - b[1]) > 20) {
            red++;
            if (x < x0 - margin || x > x1 + margin || y < y0 - margin || y > y1 + margin) outside++;
          }
        }
      const [cx, cy] = info.center,
        centreOn = px(on, cx, cy),
        centreOff = px(off, cx, cy);
      report.checks[name] = {
        mirror: info.mirror,
        redPixels: red,
        redOutsideMirror: outside,
        black,
        centreOn,
        centreOff,
      };
      console.log(name, JSON.stringify(report.checks[name]));
      assert.equal(black, 0, `${name}: SSR introduced black pixels`);
      assert.ok(red > 200, `${name}: no reflection`);
      assert.ok(outside <= Math.max(8, red * 0.02), `${name}: reflection outside the planar mirror (${outside})`);
      assert.ok(centreOn[0] - centreOn[1] - (centreOff[0] - centreOff[1]) > 20, `${name}: mirrored centre not red`);
      // Without replacement the box's light would add to the sky the water reflects: green could not fall.
      if (config.surface === 'water')
        assert.ok(centreOn[1] < centreOff[1] - 3, `${name}: the water's sky reflection was added to, not replaced`);
    }
    return report;
  },
  async ssgi() {
    const report = { ...header(), checks: {} },
      ssgi = { rays: 8, maxDistance: 20, steps: 64 };
    for (const [name, config] of Object.entries({
      'core-4x': {},
      'core-1x': { samples: 1 },
      'gltf-floor': {
        floor: 'gltf',
        stack: [
          ['ssgi', ssgi],
          ['ssr', {}],
        ],
      },
      'ortho-4x': { camera: 'ortho' },
    })) {
      const info = await run({ scene: 'wall', stack: [['ssgi', ssgi]], ...config }),
        on = await read();
      await set('ssgi', { enabled: false });
      const off = await read();
      const rows = info.floor.map(({ x, d, pixel }) => {
        const a = on.at(...pixel),
          b = off.at(...pixel);
        return {
          x,
          d,
          expected: round(formFactor(x, d, info.wall.width, info.wall.height)),
          measured: round(1 - a[1] / b[1]),
          red: round(a[0] / b[0]),
        };
      });
      report.checks[name] = { floor: rows, nan: on.nan() };
      console.log(name, JSON.stringify(report.checks[name]));
      assert.equal(on.nan(), 0, `${name}: NaN`);
      for (const r of rows) {
        assert.ok(
          Math.abs(r.measured - r.expected) < 0.06,
          `${name}: floor at x ${r.x}, ${r.d} m: ${r.measured}, form factor ${r.expected}`,
        );
        assert.ok(Math.abs(r.red - 1) < 0.03, `${name}: red changed (${r.red})`);
      }
    }
    for (const [name, config] of Object.entries({
      'gtao+ssgi+ssr+taa': {
        scene: 'wall',
        floor: 'gltf',
        stack: [
          ['gtao', {}],
          ['ssgi', {}],
          ['ssr', {}],
        ],
        taa: true,
        frames: 12,
        light: true,
      },
      'alone': { scene: 'wall', light: true, probe: false, alone: {}, aloneEffect: 'ssgi' },
    })) {
      await run(config);
      if (config.probe !== false) {
        const frame = await read();
        report.checks[name] = { nan: frame.nan() };
        assert.equal(frame.nan(), 0, `${name}: NaN`);
      } else report.checks[name] = { errors: 0 };
    }
    return report;
  },
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  for (const [name, section] of Object.entries(sections)) {
    if (only && !only.includes(name)) continue;
    const report = await section();
    await page.evaluate(() => window.check.teardown());
    assert.deepEqual(pageErrors, []);
    writeFileSync(`examples/package-benchmarks/results/${name}-gpu.json`, JSON.stringify(report, null, 1) + '\n');
    console.log(`${name}: passed; wrote examples/package-benchmarks/results/${name}-gpu.json`);
  }
} finally {
  await context.close();
}
