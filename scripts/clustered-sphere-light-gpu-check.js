// Real-GPU check of sphere lights (`PointLight.radius`, @margoengine/clustered): Karis 2013's representative point and
// energy normalisation ("Real Shading in Unreal Engine 4", sphere lights, eq. 10, 11 and 14). A sphere of intensity I
// and radius r has radiance I / (pi r^2), so the reflection of it in a metal of F0 is at most F0 I / (pi r^2). The
// production clusterLighting WGSL (fixture tests/clustered-shadow-browser.ts, `probe`) shades a metal floor under one
// light, seen along the light's mirror direction (v and l mirror at the centre, h = n) from straight above and at 45, 70
// and 85 degrees, at distances from a quarter of the radius to 40 radii and roughness 0 to 0.6, and:
// - no point of the floor, in any channel, exceeds F I / (pi r^2), F the Fresnel of the centre (F0 seen from above; a
//   point light at the same place exceeds it by far: that is the Cabin Hearth kettle's highlight, 0.15 m from a fire
//   point);
// - the centre equals the closed form G F I / (4 pi alpha_x alpha_y (n.v) d^2), alpha_x = max(min(alpha + s, 1), s),
//   alpha_y the same of s / (n.v), s = r / (2 d) (from above: F0 I / (4 pi alpha'^2 d^2), Karis's alpha');
// - diffuse: a Lambert plane at any tilt and distance, inside the sphere too, receives the sphere's irradiance (the cap
//   form factor of Snyder 1996, horizon included) and never more than pi L = I / r^2 (KB-FIRE-WALLHOT1);
// - a light of radius 0 shades bit for bit as a light with no radius, alone and beside a sized light;
// - the core shader compiles with the sized light records, with no WGSL error or warning, and @margoengine/environment's
//   VolumetricFog, which reads the same records, builds and runs its froxel pass over them without a validation error.
// node scripts/run-with-timeout.mjs -- node scripts/clustered-sphere-light-gpu-check.js (MARGO_COMPAT=1: WebGL2 layer)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { compatRun } from './support/compat-shim.js';
import { capFormFactor } from '../packages/clustered/test/sphere-irradiance-reference.js';

const folder = 'test-results/clustered-sphere-light',
  INTENSITY = 4.5,
  copper = [0.955, 0.638, 0.538],
  eye = [0, 1000, 0],
  // Float32 rounding of the shader's own arithmetic, relative.
  ROUNDING = 1e-4;
let browser;
try {
  await mkdir(folder, { recursive: true });
  browser = await openBrowser({ startPath: '/tests/clustered-shadow.html', port: 5323 });
  const page = browser.page,
    pageErrors = [],
    checks = [],
    failures = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => window.clusteredShadowFixture);
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  const call = (name, ...args) =>
    page.evaluate(({ name, args }) => window.clusteredShadowFixture[name](...args), { name, args });
  function check(name, ok, detail) {
    checks.push({ name, ok, ...detail });
    if (!ok) failures.push(`${name}: ${JSON.stringify(detail)}`);
  }
  /** Floor points (normal up) around the centre, out to `reach` in x and z. */
  const floor = (reach) => {
    const points = [];
    for (let i = -8; i <= 8; i++)
      for (let k = -8; k <= 8; k++) points.push([(i / 8) * reach, 0, (k / 8) * reach, 0, 1, 0]);
    return points;
  };
  async function shade(lights, roughness, points, view = eye) {
    await call('scene', { meshes: ['floor'], local: false, points: lights });
    await call('render', 1);
    return call('probe', points, { base: copper, roughness, metal: 1, eye: view });
  }
  const results = [];
  for (const degrees of [0, 45, 70, 85])
    for (const radius of [0.155, 0.02])
      for (const ratio of [0.25, 0.5, 1, 1.5, 2, 4, 10, 40])
        for (const roughness of [0, 0.1, 0.32, 0.6]) {
          const d = radius * ratio,
            c = Math.cos((degrees * Math.PI) / 180),
            s = Math.sin((degrees * Math.PI) / 180),
            light = { position: [-d * s, d * c, 0], range: 0, intensity: INTENSITY, radius },
            view = [1000 * s, 1000 * c, 0],
            reach = Math.max(radius, d) * 2,
            points = floor(reach).map((p) => [p[0] / c, 0, p[2], 0, 1, 0]),
            values = await shade([light], roughness, points, view),
            fresnel = copper.map((f) => f + (1 - f) * (1 - c) ** 5),
            bound = fresnel.map((f) => (f * INTENSITY) / (Math.PI * radius * radius));
          let worst = 0;
          values.forEach((rgb) => rgb.forEach((v, k) => (worst = Math.max(worst, v / bound[k]))));
          const a = Math.max(roughness, 0.045) ** 2,
            a2 = a * a,
            spread = radius / (2 * d),
            ax = Math.max(Math.min(a + spread, 1), spread),
            ay = Math.max(Math.min(a + spread / c, 1), spread / c),
            g = c / Math.sqrt(a2 + (1 - a2) * c * c),
            centre = values[(points.length - 1) / 2],
            expected = fresnel.map(
              (f) => (g * f * INTENSITY) / (4 * Math.PI * ax * ay * c * Math.max(d * d, 2 ** -12)),
            ),
            error = Math.max(...centre.map((v, k) => Math.abs(v / expected[k] - 1))),
            row = {
              degrees,
              radius,
              distance: +d.toFixed(5),
              roughness,
              peakOverBound: +worst.toFixed(5),
              centreError: error,
            };
          if (ratio === 1 && roughness === 0 && degrees === 0) {
            const pointPeak = await shade([{ ...light, radius: 0 }], roughness, points, view);
            row.pointLightOverBound = +Math.max(...pointPeak.flatMap((rgb) => rgb.map((v, c) => v / bound[c]))).toFixed(
              1,
            );
            check(
              `r ${radius}: a point light at d = r exceeds the sphere's bound (what the radius fixes)`,
              row.pointLightOverBound > 10,
              row,
            );
          }
          results.push(row);
          const label = `${degrees} deg, r ${radius} d ${row.distance} roughness ${roughness}`;
          check(`${label}: peak <= F I / (pi r^2)`, worst <= 1 + ROUNDING, row);
          check(`${label}: centre = G F I / (4 pi alpha_x alpha_y (n.v) d^2)`, error <= 1e-3, row);
        }
  // Diffuse (KB-FIRE-WALLHOT1): a white Lambert surface with no specular (F0 = F90 = 0), radiance = I E / pi, E the
  // sphere's irradiance per unit intensity (packages/clustered/test/sphere-irradiance-reference.js: the cap form factor
  // of Snyder 1996, horizon included, the hemisphere inside the sphere). Planes through floor points, tilted from 0 to
  // 170 degrees off the light, at distances from a tenth of the radius to 10 radii: each equals the closed form, and
  // none exceeds the bound I / (pi r^2) (E at most pi L = I / r^2). A point light at a tenth of the radius exceeds it
  // 100 times (the Cabin Hearth firebox back, 0.09 m from spheres of 0.634 m; 1.6 times at r 0.02, where the falloff's
  // own 2^-12 floor caps it).
  const diffuse = [];
  for (const radius of [0.634, 0.155, 0.02])
    for (const ratio of [0.1, 0.25, 0.5, 0.9, 1, 1.1, 2, 4, 10]) {
      const d = radius * ratio,
        light = { position: [0, d, 0], range: 0, intensity: INTENSITY, radius },
        points = [],
        expected = [];
      for (const along of [0, 0.3, 0.7])
        for (let degrees = 0; degrees <= 170; degrees += 10) {
          const x = along * d,
            tilt = Math.atan2(x, d) + (degrees * Math.PI) / 180,
            normal = [-Math.sin(tilt), Math.cos(tilt), 0],
            distance = Math.hypot(x, d),
            c = (-normal[0] * x + normal[1] * d) / distance,
            // At the sphere's surface the cap's x = cot sigma = sqrt(d^2 / r^2 - 1) has an infinite slope in d, so one
            // float32 step of the distance moves a grazing plane's E: the closed form is taken over d (1 +- 2^-21).
            at = (distance) => {
              const s2 = Math.min((radius * radius) / (distance * distance), 1),
                floor2 = Math.max(distance * distance, 2 ** -12),
                inside = distance < radius ? floor2 / (radius * radius) : 1;
              return ((INTENSITY / Math.PI) * (capFormFactor(c, s2) / (Math.PI * s2)) * inside) / floor2;
            },
            range = [at(distance), at(distance * (1 - 2 ** -21)), at(distance * (1 + 2 ** -21))];
          points.push([x, 0, 0, ...normal]);
          expected.push([Math.min(...range), Math.max(...range)]);
        }
      const surface = { base: [1, 1, 1], roughness: 0.5, metal: 0, eye: [0, 1000, 0], specular: false },
        bound = INTENSITY / (Math.PI * radius * radius);
      await call('scene', { meshes: ['floor'], local: false, points: [light] });
      await call('render', 1);
      const values = await call('probe', points, surface);
      let error = 0,
        worst = 0;
      values.forEach((rgb, i) => {
        worst = Math.max(worst, rgb[0] / bound);
        // Relative where the cap is well up, against a thousandth of the bound where it sets (float32 cap terms).
        const [lo, hi] = expected[i],
          off = rgb[0] < lo ? lo - rgb[0] : rgb[0] > hi ? rgb[0] - hi : 0;
        error = Math.max(error, off / Math.max(lo, 1e-3 * bound));
      });
      const row = { radius, distance: +d.toFixed(5), peakOverBound: +worst.toFixed(5), error: +error.toExponential(2) };
      if (ratio === 0.1) {
        await call('scene', { meshes: ['floor'], local: false, points: [{ ...light, radius: 0 }] });
        await call('render', 1);
        row.pointLightOverBound = +((await call('probe', points.slice(0, 1), surface))[0][0] / bound).toFixed(1);
        check(
          `diffuse r ${radius}: a point light at a tenth of the radius exceeds the sphere's bound`,
          row.pointLightOverBound > 1,
          row,
        );
      }
      diffuse.push(row);
      check(`diffuse r ${radius} d ${row.distance}: E <= pi L = I / r^2`, worst <= 1 + ROUNDING, row);
      check(
        `diffuse r ${radius} d ${row.distance}: E = the sphere's cap form factor, horizon included`,
        error <= 1e-4,
        row,
      );
    }
  // Radius 0 is a point light, bit for bit: alone, and in a list where another light has a radius (the sized shader
  // and 20-float records), with that light out of range of the probed points.
  const plain = { position: [0.2, 0.6, -0.1], range: 4, intensity: INTENSITY, color: [1, 0.7, 0.4] },
    far = { position: [30, 2, 0], range: 1, intensity: 2, radius: 0.1 },
    points = floor(1).map((p, i) => [p[0], 0, p[2], Math.sin(i) * 0.3, 1, Math.cos(i) * 0.3]),
    same = (a, b) => a.every((rgb, i) => rgb.every((v, c) => Object.is(v, b[i][c])));
  for (const roughness of [0.05, 0.5]) {
    const base = await shade([plain], roughness, points),
      zero = await shade([{ ...plain, radius: 0 }], roughness, points),
      mixed = await shade([{ ...plain, radius: 0 }, far], roughness, points);
    check(`roughness ${roughness}: radius 0 shades as no radius, bit for bit`, same(base, zero), {});
    let ulps = 0;
    const f = new Float32Array(2),
      u = new Int32Array(f.buffer);
    base.forEach((rgb, i) =>
      rgb.forEach((v, c) => {
        f[0] = v;
        f[1] = mixed[i][c];
        ulps = Math.max(ulps, Math.abs(u[0] - u[1]));
      }),
    );
    check(`roughness ${roughness}: radius 0 beside a sized light shades as before, bit for bit`, ulps === 0, { ulps });
  }
  // The core lit shader with the sized records compiles cleanly.
  await call('scene', { meshes: ['floor'], local: false, points: [plain, far] });
  const rendered = await call('render', 1);
  check('the core shader holds the sized records', rendered.shader.includes('params:vec4f,size:vec4f}'), {});
  const compiled = await call('compile');
  check('WGSL compiles without errors or warnings', !compiled.core.length && !compiled.probe.length, compiled);
  // VolumetricFog's froxel shader over the sized records, on its own engine (Tonemap capture, Clustered).
  const fog = await page
    .evaluate(
      async (lights) => {
        const { EngineKernel } = await import('/packages/core/dist/index.js'),
          { engineRuntime } = await import('/packages/core/dist/extension.js'),
          { Tonemap } = await import('/packages/tonemap/dist/index.js'),
          { VolumetricFog } = await import('/packages/environment/dist/volumetric.js'),
          { Clustered } = await import('/packages/clustered/dist/index.js');
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'width:64px;height:64px';
        document.body.append(canvas);
        const instance = await EngineKernel.create(canvas, {
            backend: 'webgpu',
            camera: { position: [0, 2, 6], target: [0, 1, 0] },
          }),
          gpu = engineRuntime(instance).gpu,
          create = gpu.createShaderModule.bind(gpu),
          codes = [];
        instance.stop();
        gpu.createShaderModule = (descriptor) => {
          if (descriptor.code.includes('fn inject')) codes.push(descriptor.code);
          return create(descriptor);
        };
        gpu.pushErrorScope('validation');
        Tonemap.attach(instance);
        const clustered = Clustered.attach(instance);
        clustered.setLights(lights);
        VolumetricFog.attach(instance, { lights: clustered });
        instance.render();
        await gpu.queue.onSubmittedWorkDone();
        const validation = await gpu.popErrorScope(),
          module = codes.length ? gpu.createShaderModule({ code: codes[0] }) : undefined,
          messages = module ? (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error') : [];
        instance.dispose();
        canvas.remove();
        return {
          modules: codes.length,
          sized: codes.some((code) => code.includes('params:vec4f,size:vec4f}')),
          validation: validation?.message ?? null,
          errors: messages.map((m) => m.message),
        };
      },
      [{ ...plain, position: [0, 1.5, 0], radius: 0.2 }, plain],
    )
    .catch((error) => ({ error: String(error) }));
  check(
    'VolumetricFog builds and runs over the sized light records',
    fog.modules > 0 && fog.sized && !fog.validation && !fog.errors?.length && !fog.error,
    fog,
  );
  check('no page errors', pageErrors.length === 0, { pageErrors });
  const fixtureErrors = await page.evaluate(() => window.clusteredShadowFixture.errors);
  check('no GPU validation or engine errors', fixtureErrors.length === 0, { fixtureErrors });
  const worst = results.reduce((w, r) => Math.max(w, r.peakOverBound), 0),
    report = `${folder}/gpu${compatRun() ? '-compat' : ''}.json`;
  await writeFile(
    report,
    JSON.stringify({ hardware: browser.hardware, worst, results, diffuse, checks, failures }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        hardware: browser.hardware.webgpu,
        worst,
        pointLight: results.filter((r) => r.pointLightOverBound),
        diffuse,
        failures,
        report,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(failures, [], 'Clustered sphere light GPU checks failed');
} finally {
  await browser?.page.evaluate(() => window.clusteredShadowFixture?.dispose()).catch(() => {});
  await browser?.close();
}
