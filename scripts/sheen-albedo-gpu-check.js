// Real-GPU check of the sheen albedo fit (materialLobesSheenAlbedo, derived by scripts/sheen-albedo-fit.mjs).
//  1. The shipped WGSL compiles without messages or validation errors and, run in a compute shader, matches the
//     numerically integrated albedo of our own sheen BRDF within the fit's measured error.
//  2. A lit sphere with sheen at several roughness values is drawn with the shipped fit and with the previous fit
//     (its function body read from git, never stored in the tree); the pixel change is measured and bounded.
//  3. With sheen off (no lobes, lobes with black sheen, black sheen plus specular) the pixels are bit-identical.
// node scripts/gpu-lock.mjs run --owner=sheen-albedo -- node scripts/sheen-albedo-gpu-check.js [--reference=<rev>]
// In a worktree outside .claude/worktrees, set MARGO_GPU_LOCK to the main checkout's test-results/gpu.lock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { sheenAlbedo, validationGrid } from './sheen-albedo-fit.mjs';
import { materialLobes } from '../packages/materials/dist/index.js';

const port = 5309,
  path = 'packages/materials/src/lobe-shader.ts',
  pattern = /fn materialLobesSheenAlbedo\(mu:f32,roughness:f32\)->f32 \{[\s\S]*?\n\}/,
  // The fit script measured 0.0109 against min(E, 1) on its validation grid.
  fitTolerance = 0.015,
  // Largest linear change from the previous fit measured on an NVIDIA Ampere adapter: 0.1016 (roughness 0.25, at the
  // rim, where the previous fit gave about half of our BRDF's grazing albedo). The bound keeps that change explained.
  renderTolerance = 0.12;

/** The previous fit: the parent of the commit that introduced this fit, or HEAD before that commit exists. */
function previousFit() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).replaceAll('\r\n', '\n'),
    requested = process.argv.find((arg) => arg.startsWith('--reference='))?.slice(12),
    introduced = git('log', '-n', '1', '--format=%H', '-S', 'fit by scripts/sheen-albedo-fit.mjs', '--', path).trim(),
    revision = requested ?? (introduced ? introduced + '^' : 'HEAD'),
    text = pattern.exec(git('show', `${revision}:${path}`))?.[0];
  assert.ok(text, `No materialLobesSheenAlbedo in ${revision}:${path}`);
  return { revision, text };
}

/** The shipped WGSL function, evaluated in double precision for the GPU-versus-JavaScript comparison. */
function shippedInJavaScript() {
  const text = pattern.exec(materialLobes({ sheen: { colorFactor: [1, 1, 1] } }).declarations)?.[0];
  assert.ok(text, 'materialLobesSheenAlbedo is missing from the built package');
  const body = text
    .slice(text.indexOf('{') + 1, text.lastIndexOf('}'))
    .replace(/\blet\b/g, 'const')
    .replace(/\bvec4f\(/g, 'vec4(');
  return {
    text,
    evaluate: new Function('vec4', 'dot', 'max', 'exp', 'clamp', `return (mu, roughness) => {${body}};`)(
      (...v) => v,
      (a, b) => a.reduce((s, v, i) => s + v * b[i], 0),
      Math.max,
      Math.exp,
      (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    ),
  };
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

const release = await acquire({ owner: 'sheen-albedo-gpu-check' });
let browser;
try {
  await mkdir('test-results/sheen-albedo', { recursive: true });
  const previous = previousFit(),
    shipped = shippedInJavaScript(),
    report = { reference: previous.revision, checks: [], failures: [] },
    fail = (message) => report.failures.push(message);
  assert.notEqual(previous.text, shipped.text, `${previous.revision} already has the shipped fit; pass --reference`);
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

  // 2 and 3. Rendered spheres, shipped fit against the previous one, each in a freshly loaded page.
  const sheenColor = [0.9, 0.7, 0.5],
    scenes = [
      ['no lobes', {}, false],
      ['lobes with black sheen', { lobes: { sheen: { colorFactor: [0, 0, 0], roughnessFactor: 0.5 } } }, false],
      [
        'black sheen with specular',
        { lobes: { sheen: { colorFactor: [0, 0, 0] }, specular: { factor: 0.6, colorFactor: [1, 0.8, 0.6] } } },
        false,
      ],
      ...[0, 0.25, 0.5, 0.75, 1].map((roughness) => [
        `sheen roughness ${roughness}`,
        { lobes: { sheen: { colorFactor: sheenColor, roughnessFactor: roughness } } },
        true,
      ]),
    ];
  async function renderAll(reference) {
    await page.goto(`http://127.0.0.1:${port}/tests/sheen-albedo.html`);
    await page.waitForFunction(() => window.sheenAlbedoFixture);
    if (reference) await page.evaluate((text) => window.sheenAlbedoFixture.setReference(text), reference);
    const images = [];
    for (const [, scene] of scenes) images.push(await page.evaluate((s) => window.sheenAlbedoFixture.render(s), scene));
    const state = await page.evaluate(() => ({
      counts: window.sheenAlbedoFixture.counts(),
      errors: window.sheenAlbedoFixture.errors,
    }));
    return { images, ...state };
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
  assert.deepEqual(pageErrors, [], 'Unexpected page errors');
  await writeFile('test-results/sheen-albedo/gpu.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(report.failures, [], 'Sheen albedo GPU check failed');
} finally {
  await browser?.page.evaluate(() => window.sheenAlbedoFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
