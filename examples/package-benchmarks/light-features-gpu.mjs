// Real-GPU check of the lighting features added with the three.js parity work (GPU lock, after npm run build:packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node examples/package-benchmarks/light-features-gpu.mjs
// Every lit pixel of a grey Lambert floor (BRDF base / pi) is compared, at ~900 pixel centres per scene, with the analytic
// value pushed through Margo's display transform (PBR Neutral + sRGB, packages/shared/display.js), within 3/255:
// 1. inverse square and cone: a spot (decay 2, unlimited range, smooth edge) and a point light, base/pi n.l I cone / d^2;
// 2. an extra directional light (@margoengine/clustered/directional): base/pi n.l E;
// 3. IES table lookup (@margoengine/clustered/ies): a point light shaped by an asymmetric profile, the exact profile value;
// 4. projector UVs (@margoengine/clustered/projector): a spot projecting a gradient image, the colour at the UV that
//    localShadowMatrix gives (test/projector-reference.js), bilinear;
// 5. hemisphere gradient (@margoengine/environment HemisphereLight): a Lambert sphere and a core box lit by it alone,
//    base x mix(ground, sky, 0.5 + 0.5 n.y) from the analytic sphere normal and the box's face normals;
// 6. units (@margoengine/clustered/units): an 800 lm spot's centre pixel at base/pi x candelaToLux(lumensToCandela(...)).
// Writes results/light-features-gpu.json and the frames to test-results/light-features-*.png.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openBrowser } from '../../scripts/browser.js';
import { decodePNG } from '../../tests/support/png.js';
import { parseIES, iesCandela } from '../../packages/clustered/dist/ies.js';
import { lumensToCandela, candelaToLux, exposureFromEV100 } from '../../packages/clustered/dist/units.js';
import { iesFile, range } from '../../packages/clustered/test/ies-reference.js';
import { projectorColor, image } from '../../packages/clustered/test/projector-reference.js';

const base = 0.6,
  tolerance = 3;
// Margo's display transform on max(color, 0): Khronos PBR Neutral, then the sRGB encoding (packages/shared/display.js).
function shown(input) {
  const c = input.map((v) => Math.max(0, v)),
    x = Math.min(...c),
    offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  let v = c.map((value) => value - offset);
  const peak = Math.max(...v);
  if (peak >= 0.76) {
    const next = 1 - (0.24 * 0.24) / (peak + 0.24 - 0.76),
      g = 1 - 1 / (0.15 * (peak - next) + 1);
    v = v.map((value) => (value * next) / peak).map((value) => value + (next - value) * g);
  }
  return v.map((value) => Math.round(255 * (value >= 0.0031308 ? 1.055 * value ** (1 / 2.4) - 0.055 : value * 12.92)));
}
const pixel = (img, [x, y]) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const sub = (a, b) => a.map((v, k) => v - b[k]),
  dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len = (a) => Math.hypot(...a),
  grey = (v) => [v, v, v];
const smooth = (x, lo, hi) => {
  if (hi <= lo) return x >= lo ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
/** Radiance at floor point p (normal +y) from a clustered light of decay 2 and unlimited range, before any profile. */
function local(light, p) {
  const delta = sub(light.position, p),
    d = len(delta),
    l = delta.map((v) => v / d),
    nl = Math.max(0, l[1]);
  let cone = 1;
  if (light.direction) {
    const dir = light.direction.map((v) => v / len(light.direction)),
      outer = light.angle ?? light.outerAngle,
      inner = light.angle !== undefined ? light.angle * (1 - (light.penumbra ?? 0)) : (light.innerAngle ?? 0);
    cone = smooth(-dot(l, dir), Math.cos(outer), Math.cos(inner));
  }
  return { value: ((base / Math.PI) * nl * light.intensity * cone) / Math.max(d * d, 0.01), l };
}

const context = await openBrowser({ startPath: '/LICENSE', port: 5264 }),
  { page, hardware } = context,
  pageErrors = [];
await page.goto('http://127.0.0.1:5264/examples/package-benchmarks/light-features.html', { timeout: 300000 });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const report = {
  benchmark: 'light-features-gpu',
  recordedAt: new Date().toISOString(),
  hardware: hardware.webgpu,
  browser: hardware.browserName + ' ' + hardware.browserVersion,
  resolution: [640, 480],
  tolerance,
  checks: [],
};
try {
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const grid = [];
  for (let y = 10; y < 480; y += 16) for (let x = 10; x < 640; x += 20) grid.push([x, y]);
  const rays = await page.evaluate((p) => window.check.unproject(p), grid);
  const shot = async (name, scene) => {
    const result = await page.evaluate((s) => window.check.render(s), scene);
    assert.equal(result.error, null, name);
    assert.deepEqual(result.errors, [], name);
    return decodePNG(await page.locator('canvas').screenshot({ path: `test-results/light-features-${name}.png` }));
  };
  // Compares every sample whose expectation `expect(ray)` returns (linear RGB, or null to skip).
  const compare = async (name, scene, expect, minLit = 60) => {
    const img = await shot(name, scene);
    let worst = 0,
      lit = 0,
      samples = 0,
      at = null;
    rays.forEach((ray, i) => {
      const want = expect(ray);
      if (!want) return;
      samples++;
      const expected = shown(want),
        got = pixel(img, grid[i]),
        diff = Math.max(...got.map((g, k) => Math.abs(g - expected[k])));
      if (diff > worst) {
        worst = diff;
        at = { pixel: grid[i], got, expected };
      }
      if (Math.max(...expected) > 20) lit++;
    });
    const row = { check: name, samples, lit, maxDiff: worst, ...(worst > tolerance ? { worstAt: at } : {}) };
    report.checks.push(row);
    console.log(JSON.stringify(row));
    assert.ok(lit >= minLit, `${name}: only ${lit} lit samples`);
    assert.ok(
      worst <= tolerance,
      `${name}: GPU differs from the analytic value by ${worst}/255 at ${JSON.stringify(at)}`,
    );
  };
  const floor = (fn) => (ray) => (Math.abs(ray.floor[0]) < 19 && Math.abs(ray.floor[2]) < 19 ? fn(ray.floor) : null);

  // 1. Inverse square and cone.
  const spot = {
      position: [0.4, 3, -0.3],
      range: 0,
      decay: 2,
      direction: [0.2, -1, 0.1],
      angle: 0.7,
      penumbra: 0.4,
      intensity: 14,
    },
    point = { position: [1.5, 2, -1], range: 0, decay: 2, intensity: 6 };
  await compare(
    'spot',
    { clustered: [spot] },
    floor((p) => grey(local(spot, p).value)),
  );
  await compare(
    'point',
    { clustered: [point] },
    floor((p) => grey(local(point, p).value)),
  );
  // 2. Directional: uniform over the floor.
  const sun = { direction: [0.3, -1, 0.2], intensity: 1.2 },
    nl = 1 / len(sun.direction);
  await compare(
    'directional',
    { directional: [sun] },
    floor(() => grey((base / Math.PI) * nl * sun.intensity)),
    100,
  );
  // 3. IES: a downlight brighter toward horizontal angle 0 (+x), cos^2 falloff to 60 degrees.
  const text = iesFile(range(0, 90, 2.5), range(0, 180, 15), (t, phi) =>
      t <= 60 ? 900 * Math.cos((t * Math.PI) / 180) ** 2 * (1 + 0.5 * Math.cos((phi * Math.PI) / 180)) : 0,
    ),
    profile = parseIES(text),
    profiled = { position: [0.3, 2.5, -0.2], range: 0, decay: 2, intensity: 20 };
  await compare(
    'ies',
    { clustered: [profiled], ies: text },
    floor((p) => {
      const { value, l } = local(profiled, p),
        d = l.map((v) => -v),
        theta = (Math.acos(Math.min(1, -d[1])) * 180) / Math.PI,
        phi = (Math.atan2(-d[2], d[0]) * 180) / Math.PI;
      // Skip the cutoff ring (60 to 62.5 degrees), where the 1-degree grid and the file's 2.5-degree samples differ most.
      if (Math.abs(theta - 61.25) < 2.5) return null;
      return grey(value * (iesCandela(profile, theta, phi) / profile.peak));
    }),
  );
  // 4. Projector: a 16 x 16 gradient (red across, green down) from a spot pointing nearly straight down.
  const slide = image(16, 16, (x, y) => [
      Math.round(((x + 0.5) / 16) * 255),
      Math.round(((y + 0.5) / 16) * 255),
      128,
      255,
    ]),
    projector = {
      position: [0, 3, 0],
      range: 0,
      decay: 2,
      direction: [0.05, -1, 0.1],
      outerAngle: 0.6,
      innerAngle: 0.6,
      intensity: 18,
    };
  const unitDirection = projector.direction.map((v) => v / len(projector.direction));
  await compare(
    'projector',
    { clustered: [projector], projector: { width: 16, height: 16, data: [...slide.data] } },
    floor((p) => {
      const { value, l } = local(projector, p);
      if (Math.abs(-dot(l, unitDirection) - Math.cos(0.6)) < 0.01) return null; // the hard cone edge
      return projectorColor({ ...projector, direction: unitDirection }, p, { image: slide }).map((v) => value * v);
    }),
  );
  // 5. Hemisphere: the sphere (centre (-1.2, 1, 0), radius 1) and the box (centre (1.4, 0.6, 0), half size 0.6).
  const sky = [0.3, 0.42, 0.6],
    ground = [0.25, 0.12, 0.05],
    hemi = (n) => sky.map((s, k) => base * (ground[k] + (s - ground[k]) * Math.min(1, Math.max(0, n[1] * 0.5 + 0.5))));
  const sphere = (ray) => {
    const c = [-1.2, 1, 0],
      o = sub(ray.origin, c),
      b = dot(o, ray.direction),
      disc = b * b - (dot(o, o) - 1);
    if (disc <= 0) return null;
    const t = -b - Math.sqrt(disc),
      n = sub(
        ray.origin.map((v, k) => v + ray.direction[k] * t),
        c,
      );
    // Skip the silhouette, where the tessellated sphere and the analytic one differ.
    return -dot(n, ray.direction) > 0.3 ? { t, n } : null;
  };
  const cube = (ray) => {
    const c = [1.4, 0.6, 0],
      h = 0.6;
    let best = null;
    for (let axis = 0; axis < 3; axis++)
      for (const side of [-1, 1]) {
        const t = (c[axis] + side * h - ray.origin[axis]) / ray.direction[axis];
        if (!(t > 0)) continue;
        const q = ray.origin.map((v, k) => v + ray.direction[k] * t);
        if ([0, 1, 2].some((k) => k !== axis && Math.abs(q[k] - c[k]) > h)) continue;
        // The nearest face hit; `edge` when it lands near an edge (antialiasing and the neighbouring face).
        const edge = [0, 1, 2].some((k) => k !== axis && Math.abs(q[k] - c[k]) > h - 0.06);
        if (!best || t < best.t) best = { t, edge, n: [0, 1, 2].map((k) => (k === axis ? side : 0)) };
      }
    return best;
  };
  await compare(
    'hemisphere',
    { objects: 'shapes', hemisphere: { sky, ground, intensity: 1 } },
    (ray) => {
      const a = sphere(ray),
        b = cube(ray),
        hit = a && (!b || a.t < b.t) ? a : b;
      return hit && !hit.edge ? hemi(hit.n) : null;
    },
    40,
  );
  // 6. Units: 800 lm in a spot cone, straight down from 3 m, seen at EV100 6.5 (Clustered.intensityScale): the pixel
  // nearest the floor centre against base/pi x lux x exposure.
  const cone = { outerAngle: 0.5, innerAngle: 0.3 },
    rated = {
      position: [0, 3, 0],
      range: 0,
      decay: 2,
      direction: [0, -1, 0],
      ...cone,
      intensity: lumensToCandela(800, cone),
    },
    lux = candelaToLux(rated.intensity, 3),
    exposure = exposureFromEV100(6.5),
    img = await shot('units', { clustered: [rated], scale: exposure });
  let best = null;
  rays.forEach((ray, i) => {
    const r = Math.hypot(ray.floor[0], ray.floor[2]);
    if (!best || r < best.r) best = { r, i, p: ray.floor };
  });
  const want = shown(grey(local(rated, best.p).value * exposure)),
    got = pixel(img, grid[best.i]);
  const units = {
    check: 'units',
    lumens: 800,
    candela: +rated.intensity.toFixed(3),
    lux: +lux.toFixed(3),
    ev100: 6.5,
    exposure: +exposure.toFixed(6),
    pixel: grid[best.i],
    offCentre: +best.r.toFixed(3),
    got,
    expected: want,
    atCentre: shown(grey((base / Math.PI) * lux * exposure)),
    maxDiff: Math.max(...got.map((g, k) => Math.abs(g - want[k]))),
  };
  report.checks.push(units);
  console.log(JSON.stringify(units));
  assert.ok(units.maxDiff <= tolerance, 'units: centre pixel');
  assert.deepEqual(pageErrors, []);
} finally {
  await context.close();
}
await writeFile(
  resolve(import.meta.dirname, 'results/light-features-gpu.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log('light features GPU check passed');
