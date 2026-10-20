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
