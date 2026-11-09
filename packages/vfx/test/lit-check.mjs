// Real-GPU check of lit particles in a real engine (run from the repository root after building packages, one GPU job
// at a time): node scripts/gpu-lock.mjs run --owner=<id> -- node packages/vfx/test/lit-check.mjs
// A grey particle 2 units across, seen from z = 10, must show at its centre and at a quarter and a half of its radius:
// - under ambient 1 alone, its own colour times its opacity;
// - lit by a Clustered point light at (0, 0, 2), the clustered BRDF (GGX at roughness 1, no metal, Fresnel F0 0.04)
//   on the ball's normal and surface point, computed here;
// - lit by the sun from +x through Shadows, the wrap-lit sun term when the caster is far away, and nothing where a slab
//   at x = 3 stands between the sun and the ball;
// - both together in an ExactOIT pass, the same as without it (the pass's group 1, the lights' group 2).
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

const context = await openBrowser({ startPath: '/packages/vfx/test/lit-check.html', port: 5291 }),
  { page } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const base = 0.5,
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  unit = (a) => a.map((v) => v / Math.hypot(...a));
// The ball at the pixel `dx` right of the centre (pixel centres, half a pixel off the axes): normal = surface point.
const ball = (dx, radius, c) => {
  const u = (Math.floor(c + dx) + 0.5 - c) / radius,
    v = -0.5 / radius,
    r = u * u + v * v,
    z = Math.sqrt(1 - r);
  return { n: [u, v, z], alpha: (1 - r) * (1 - r) };
};
// The point light: clustered's GGX with Fresnel at roughness 1, metal 0, F0 0.04, F90 1, falloff fade^2 / d^2.
const pointLight = ({ n, alpha }) => {
  const delta = [-n[0], -n[1], 2 - n[2]],
    d = Math.hypot(...delta),
    l = delta.map((x) => x / d),
    v = unit([-n[0], -n[1], 10 - n[2]]),
    h = unit(v.map((x, i) => x + l[i])),
    nl = Math.max(0, dot(n, l)),
    nv = Math.min(1, Math.max(1e-4, dot(n, v))),
    vh = Math.max(0, dot(v, h)),
    D = 1 / Math.PI,
    G = ((2 * nv) / (nv + 1)) * ((2 * nl) / Math.max(nl + 1, 1e-4)),
    F = 0.04 + 0.96 * (1 - vh) ** 5,
    fade = Math.min(1, Math.max(0, 1 - (d / 20) ** 4)) ** 2,
    light = (((1 - F) * base) / Math.PI + (D * G * F) / Math.max(4 * nl * nv, 1e-4)) * nl * 2 * (fade / d ** 2);
  return 255 * Math.min(1, light) * alpha;
};
// The sun from +x at intensity pi, wrap 0.5: base x max(0, (n.x + 0.5) / 1.5).
const sun = ({ n, alpha }) => 255 * base * Math.max(0, (n[0] + 0.5) / 1.5) * alpha;
try {
  await page
    .waitForFunction(() => window.ready, null, { timeout: 60000 })
    .catch((error) => {
      throw new Error(`the page did not start: ${pageErrors.join('; ') || error.message}`);
    });
  if (compatRun()) {
    const refused = await page.evaluate(async () => {
      try {
        await window.check({ lights: true, shadows: true, caster: 'slab', oit: true });
        return null;
      } catch (error) {
        return { code: error.code, message: error.message };
      }
    });
    assert.equal(refused?.code, 'unsupported', 'ExactOIT refuses the compatibility device before shader creation');
    assert.match(refused.message, /ExactOIT needs storage buffers in fragment shaders; use OIT/);
  }
  for (const [options, want] of [
    [{ ambient: 1 }, ({ alpha }) => 255 * base * alpha],
    [{ lights: true }, pointLight],
    [{ shadows: true, caster: 'away' }, sun],
    [{ shadows: true, caster: 'slab' }, () => 0],
    [{ lights: true, shadows: true, caster: 'slab' }, pointLight],
    [{ lights: true, shadows: true, caster: 'slab', oit: compatRun() ? 'weighted' : true }, pointLight],
  ]) {
    const name = `lit ${JSON.stringify(options)}`,
      r = await page.evaluate((o) => window.check(o), options);
    assert.equal(r.error, null, name);
    assert.deepEqual(r.errors, [], name);
    const c = r.c,
      expected = [0, r.radius / 4, r.radius / 2].map((dx) => want(ball(dx, r.radius, c)));
    r.pixels.forEach((rgb, k) => {
      for (const got of rgb)
        assert.ok(
          Math.abs(got - expected[k]) <= 3,
          `${name}: pixel ${k} is ${rgb}, expected ${expected[k].toFixed(1)} in each channel`,
        );
    });
    console.log(`ok ${name}: ${r.pixels.map((p) => p[0]).join(', ')} (expected ${expected.map((e) => e.toFixed(1))})`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('vfx lit check passed');
} finally {
  await context.close();
}
