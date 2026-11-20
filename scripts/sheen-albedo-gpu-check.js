// Real-GPU check of the sheen albedo table (materialLobesSheenAlbedo, fitted by scripts/sheen-albedo-fit.mjs).
//  1. The shipped WGSL compiles without messages or validation errors and, run in a compute shader, matches the
//     numerically integrated albedo of our own sheen BRDF within the table's measured error.
//  2. A lit sphere with sheen at several roughness values is drawn with the shipped albedo and with the previous one,
//     the closed form the table replaced (pinned in scripts/sheen-albedo-fit.mjs), swapped into the CURRENT shader
//     in place of that one function; the pixel change is measured and bounded. Later sheen changes elsewhere in the
//     shader reach both pictures alike, so the comparison stays one of the albedo alone.
//  3. Sheen off is exact. With no lobes both pages compile one program and must match bit for bit. A black sheen
//     (alone, and over specular) is drawn at every sheen roughness by one compiled program, only the material data
//     changing, and every draw must match the first bit for bit: the albedo and the lobe both depend on the
//     roughness, so any part of them that reached the picture would move it. Black sheen is not compared across the
//     shipped and the previous page: they compile different programs, and WGSL lets each fuse or reassociate f32
//     operations its own way (15.7.5; only an @invariant position is the same across programs, 12.10), so terms
//     that never touch the albedo may round one binary16 step apart (Apple silicon, the WebGL2 layer).
// node scripts/run-with-timeout.mjs -- node scripts/sheen-albedo-gpu-check.js [--reference=<rev>]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import {
  closedFormAlbedoCommit,
  closedFormAlbedoWGSL,
  sheenAlbedo,
  shippedAlbedo,
  validationGrid,
} from './sheen-albedo-fit.mjs';
import { materialLobes } from '../packages/materials/dist/index.js';

const port = 5309,
  path = 'packages/shared/sheen.js',
  name = 'materialLobesSheenAlbedo',
  // The albedo function with its module-scope table when it has one (the table since 2026-11-15).
  pattern =
    /(?:const materialLobesSheenAlbedoTable=array<f32,256>\([^)]*\);\n)?fn materialLobesSheenAlbedo\(mu:f32,roughness:f32\)->f32 \{[\s\S]*?\n\}/,
  // scripts/sheen-albedo-fit.mjs measured at most 0.04109 against min(E, 1) on its validation grid, which this
  // check samples (every third point).
  fitTolerance = 0.0411,
  // Largest linear change from the previous albedo, 0.0632 at sheen roughness 1, measured on an NVIDIA Ampere adapter.
  renderTolerance = 0.065;

/**
 * The previous albedo WGSL. By default the closed form the table replaced, pinned in scripts/sheen-albedo-fit.mjs
 * (closedFormAlbedoWGSL, from the parent of closedFormAlbedoCommit), never derived from the history of
 * packages/shared/sheen.js: a later sheen change to that file must neither move the reference nor make it equal the
 * shipped fit. --reference=<rev> compares against shared/sheen.js at another revision instead.
 */
async function previousFit() {
  const requested = process.argv.find((arg) => arg.startsWith('--reference='))?.slice(12);
  let revision = `${closedFormAlbedoCommit.slice(0, 9)}^ (closed form, pinned)`,
    source = closedFormAlbedoWGSL(name);
  if (requested) {
    const file = execFileSync('git', ['show', `${requested}:${path}`], { encoding: 'utf8' }).replaceAll('\r\n', '\n'),
      module = await import('data:text/javascript,' + encodeURIComponent(file));
    [revision, source] = [requested, module.sheenAlbedoWGSL(name)];
  }
  const text = pattern.exec(source)?.[0];
  assert.ok(text, `No ${name} in ${revision}`);
  return { revision, text };
}

/** The shipped WGSL, and its evaluation in double precision for the GPU-versus-JavaScript comparison. */
function shippedInJavaScript() {
  const text = pattern.exec(materialLobes({ sheen: { colorFactor: [1, 1, 1] } }).declarations)?.[0];
  assert.ok(text, `${name} is missing from the built package`);
  return { text, evaluate: shippedAlbedo() };
}

function compare(a, b) {
  let max = 0,
    sum = 0,
    changed = 0,
    pixels = 0,
    max8 = 0;
  const srgb8 = (v) => {
    const c = Math.min(1, Math.max(0, v));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  };
  for (let p = 0; p < a.alpha.length; p++) {
    if (a.alpha[p] === 0 && b.alpha[p] === 0) continue;
    pixels++;
    let moved = false;
    for (let c = 0; c < 3; c++) {
      const i = p * 3 + c,
        delta = Math.abs(a.rgb[i] - b.rgb[i]);
      max = Math.max(max, delta);
      sum += delta;
      moved ||= delta > 0;
      max8 = Math.max(max8, Math.abs(srgb8(a.rgb[i]) - srgb8(b.rgb[i])));
    }
    changed += +moved;
  }
  return { max, mean: sum / (3 * Math.max(pixels, 1)), changed, pixels, maxSRGB8: max8 };
}

let browser;
try {
  await mkdir('test-results/sheen-albedo', { recursive: true });
  const previous = await previousFit(),
    shipped = shippedInJavaScript(),
    report = { reference: previous.revision, checks: [], failures: [] },
    fail = (message) => report.failures.push(message);
  assert.notEqual(previous.text, shipped.text, `${previous.revision} is the shipped fit`);
  browser = await openBrowser({ startPath: '/tests/sheen-albedo.html', port });
  const page = browser.page,
    pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  report.hardware = browser.hardware.webgpu;

  // 1. The function alone on the GPU, against the numerical albedo (level 4 tanh-sinh, error < 1e-7).
  const points = validationGrid().filter((_, i) => i % 3 === 0),
    integrated = points.map(([mu, r]) => Math.min(1, sheenAlbedo(mu, r, 4)));
  async function evaluate(reference) {
    await page.goto(`http://127.0.0.1:${port}/tests/sheen-albedo.html`);
    await page.waitForFunction(() => window.sheenAlbedoFixture);
    if (reference) await page.evaluate((text) => window.sheenAlbedoFixture.setReference(text), reference);
    return page.evaluate((p) => window.sheenAlbedoFixture.evaluate(p), points);
  }
  const statistics = (values, expected) => {
    let max = 0,
      sum = 0,
      at;
    values.forEach((v, i) => {
      const d = Math.abs(v - expected[i]);
      sum += d;
      if (d > max) [max, at] = [d, points[i]];
    });
    return { max, mean: sum / values.length, at };
  };
  for (const [label, reference] of [
    ['shipped', undefined],
    ['previous', previous.text],
  ]) {
    const result = await evaluate(reference),
      versusIntegral = statistics(result.values, integrated),
      check = { name: `${label} WGSL albedo on the GPU`, points: points.length, versusIntegral, ...result };
    delete check.values;
    if (result.messages.length) fail(`${label} WGSL compilation messages: ${result.messages.join('; ')}`);
    if (result.validation) fail(`${label} WGSL validation error: ${result.validation}`);
    if (!reference) {
      check.versusJavaScript = statistics(
        result.values,
        points.map(([mu, r]) => shipped.evaluate(mu, r)),
      );
      if (versusIntegral.max > fitTolerance)
        fail(`shipped fit differs from the integrated albedo by ${versusIntegral.max} > ${fitTolerance}`);
      if (check.versusJavaScript.max > 1e-5)
        fail(`GPU and JavaScript evaluations of the shipped fit differ by ${check.versusJavaScript.max}`);
    }
    report.checks.push(check);
  }

  // 2. Rendered spheres, shipped fit against the previous one, each in a freshly loaded page.
  const sheenColor = [0.9, 0.7, 0.5],
    scenes = [
      ['no lobes', {}, false],
      ...[0, 0.25, 0.5, 0.75, 1].map((roughness) => [
        `sheen roughness ${roughness}`,
        { lobes: { sheen: { colorFactor: sheenColor, roughnessFactor: roughness } } },
        true,
      ]),
    ],
    // 3. Sheen off in one program: black sheen at each roughness, only the factors differing between draws.
    blackRoughness = [0.5, 0, 0.25, 0.75, 1],
    blackPrograms = [
      ['black sheen', (roughness) => ({ sheen: { colorFactor: [0, 0, 0], roughnessFactor: roughness } })],
      [
        'black sheen with specular',
        (roughness) => ({
          sheen: { colorFactor: [0, 0, 0], roughnessFactor: roughness },
          specular: { factor: 0.6, colorFactor: [1, 0.8, 0.6] },
        }),
      ],
    ];
  async function renderAll(reference) {
    await page.goto(`http://127.0.0.1:${port}/tests/sheen-albedo.html`);
    await page.waitForFunction(() => window.sheenAlbedoFixture);
    if (reference) await page.evaluate((text) => window.sheenAlbedoFixture.setReference(text), reference);
    const fixture = (method, argument) =>
        page.evaluate(([m, a]) => window.sheenAlbedoFixture[m](a), [method, argument]),
      images = [],
      black = [];
    for (const [, scene] of scenes) images.push(await fixture('render', scene));
    for (const [name, lobes] of blackPrograms) {
      const draws = [];
      let compiled;
      for (const roughness of blackRoughness) {
        const image = await fixture('render', { lobes: lobes(roughness) });
        if (!draws.length) compiled = await fixture('counts');
        draws.push({ roughness, image });
      }
      const after = await fixture('counts');
      // Every draw after the first must reuse its shader modules and pipelines.
      black.push({
        name,
        draws,
        compiled: { modules: after.modules - compiled.modules, pipelines: after.pipelines - compiled.pipelines },
      });
    }
    const state = await page.evaluate(() => ({
      counts: window.sheenAlbedoFixture.counts(),
      errors: window.sheenAlbedoFixture.errors,
    }));
    return { images, black, ...state };
  }
  const current = await renderAll(),
    before = await renderAll(previous.text);
  report.shaderModules = { shipped: current.counts, previous: before.counts };
  if (!current.counts.shippedModules) fail('No rendered shader module contained the shipped albedo function');
  if (!before.counts.replaced) fail('The previous fit was not substituted into any rendered shader module');
  for (const [label, run] of [
    ['shipped', current],
    ['previous', before],
  ])
    if (run.errors.length) fail(`${label} page GPU errors: ${run.errors.join('; ')}`);
  const sheenOff = current.images[0];
  scenes.forEach(([name, , sheenOn], i) => {
    const change = compare(current.images[i], before.images[i]),
      check = { name: `${name}: shipped against previous fit`, ...change };
    if (change.pixels < 1000) fail(`${name}: the sphere covers only ${change.pixels} pixels`);
    if (!sheenOn && change.max !== 0) fail(`${name}: sheen off changed ${change.changed} pixels (max ${change.max})`);
    if (sheenOn) {
      // At roughness 0 the lobe and its albedo vanish outside a sub-pixel grazing rim, so that case is only reported.
      check.sheenEffect = compare(current.images[i], sheenOff).max;
      if (check.sheenEffect < 0.01 && !name.endsWith(' 0')) fail(`${name}: sheen had no visible effect`);
      if (change.max > renderTolerance) fail(`${name}: pixels moved by ${change.max} from the previous fit`);
    }
    report.checks.push(check);
  });
  for (const [label, run] of [
    ['shipped', current],
    ['previous', before],
  ])
    for (const { name, draws, compiled } of run.black) {
      const [first, ...rest] = draws,
        check = { name: `${name}, ${label} fit: one program, roughness ${blackRoughness.join(', ')}`, compiled };
      if (compiled.modules || compiled.pipelines)
        fail(
          `${name}, ${label} fit: changing the sheen roughness compiled ${compiled.modules} shader modules and ${compiled.pipelines} pipelines`,
        );
      check.draws = rest.map(({ roughness, image }) => {
        const change = compare(image, first.image);
        if (change.pixels < 1000) fail(`${name}, ${label} fit: the sphere covers only ${change.pixels} pixels`);
        if (change.max !== 0)
          fail(
            `${name}, ${label} fit: sheen roughness ${roughness} against ${first.roughness} changed ${change.changed} pixels (max ${change.max})`,
          );
        return { roughness, against: first.roughness, ...change };
      });
      report.checks.push(check);
    }
  assert.deepEqual(pageErrors, [], 'Unexpected page errors');
  await writeFile('test-results/sheen-albedo/gpu.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(report.failures, [], 'Sheen albedo GPU check failed');
} finally {
  await browser?.page.evaluate(() => window.sheenAlbedoFixture?.dispose()).catch(() => {});
  await browser?.close();
}
