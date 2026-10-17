import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';

const release = await acquire({ owner: 'tonemap-lut-sizes-gpu-check' }),
  output = 'test-results/tonemap-lut-sizes',
  report = { checks: [], failures: [], captures: [] },
  sizes = [2, 16, 17, 32, 33, 64, 65],
  clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
let browser,
  samples = 4;
function check(name, actual, expected) {
  report.checks.push({ name, samples, actual, expected });
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    report.failures.push(`${samples}x ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
function close(name, actual, expected, tolerance) {
  const error = Math.max(
    ...actual.flatMap((rgba, index) => rgba.map((value, channel) => Math.abs(value - expected[index][channel]))),
  );
  report.checks.push({ name, samples, maxError: error, tolerance });
  if (!(error <= tolerance)) report.failures.push(`${samples}x ${name}: maximum error ${error} exceeds ${tolerance}`);
}
// The CPU oracle enumerates the eight surrounding lattice points and their weights.
// It never imports the WGSL, parser, uploader, or interpolation implementation.
function table(r, g, b, variant = 0, parsed = false) {
  const values = variant
    ? [0.1 + 0.5 * g * g + 0.2 * b, 0.03 + 0.7 * b * b + 0.1 * r * g, 0.02 + 0.6 * r * r + 0.25 * g * b]
    : [
        -0.08 + 0.9 * r * r + 0.3 * g * b,
        0.02 + 0.6 * g * g + 0.2 * r * b + 0.05 * r,
        -0.03 + 0.75 * b * b + 0.22 * r * g,
      ];
  return values.map((value) => Math.fround(parsed ? Number(value.toFixed(6)) : value));
}
function trilinear(color, config, domainMin, domainMax) {
  const size = config.size ?? 33,
    lattice = color.map(
      (value, channel) => clamp((value - domainMin[channel]) / (domainMax[channel] - domainMin[channel])) * (size - 1),
    ),
    lo = lattice.map(Math.floor),
    fraction = lattice.map((value, channel) => value - lo[channel]),
    result = [0, 0, 0];
  for (let corner = 0; corner < 8; corner++) {
    const coordinates = lo.map((value, channel) => Math.min(size - 1, value + ((corner >> channel) & 1))),
      weight = fraction.reduce((value, part, channel) => value * ((corner >> channel) & 1 ? part : 1 - part), 1),
      value = table(...coordinates.map((coordinate) => coordinate / (size - 1)), config.variant, config.parsed);
    for (let channel = 0; channel < 3; channel++) result[channel] += weight * value[channel];
  }
  return result;
}
function neutral(input, white) {
  const smallest = Math.min(...input),
    offset = smallest < 0.08 ? smallest - 6.25 * smallest ** 2 : 0.04,
    color = input.map((value) => value - offset),
    peak = Math.max(...color);
  if (peak < 0.76) return color;
  const newPeak = white - (white - 0.76) ** 2 / (peak + white - 1.52),
    desaturation = 1 - 1 / (0.15 * (peak - newPeak) + 1);
  return color.map((value) => ((value * newPeak) / peak) * (1 - desaturation) + newPeak * desaturation);
}
function reference(rgba, config, domainMin, domainMax) {
  let hdr = rgba.slice(0, 3);
  if (config.output && config.p3) {
    const p3 = [
      0.822462 * hdr[0] + 0.177538 * hdr[1],
      0.033194 * hdr[0] + 0.966806 * hdr[1],
      0.017083 * hdr[0] + 0.072397 * hdr[1] + 0.91052 * hdr[2],
    ].map((value) => Math.max(0, value));
    hdr = [
      1.22494 * p3[0] - 0.22494 * p3[1],
      -0.042057 * p3[0] + 1.042057 * p3[1],
      -0.019638 * p3[0] - 0.078636 * p3[1] + 1.098274 * p3[2],
    ];
  }
  const white = config.output ? (config.peak ?? 4) : 1,
    positive = hdr.map((value) => Math.max(0, value)),
    maximum = Math.max(...positive);
  let color = neutral(positive, white).map((value) => clamp(value, 0, white));
  if (!config.noLUT) {
    const graded = trilinear(
      config.output ? color.map((value) => Math.min(value, 1)) : color,
      config,
      domainMin,
      domainMax,
    );
    color = graded.map((value, channel) => value + (config.output ? Math.max(color[channel] - 1, 0) : 0));
  }
  color = color.map((value) => clamp(value, 0, white));
  if (config.output && maximum > 0) {
    const strength = Math.max(...color) / maximum;
    color = color.map((value, channel) => value + Math.min(hdr[channel], 0) * strength);
  }
  return {
    image: [
      ...color.map((value) => {
        const v = clamp(value);
        return v < 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
      }),
      rgba[3],
    ],
    excess: [...color.map((value) => value - clamp(value)), 0],
  };
}
try {
  await mkdir(output, { recursive: true });
  const baseline = await readFile(output + '/gpu-red.json', 'utf8').then(JSON.parse, () => undefined);
  browser = await openBrowser({ startPath: '/tests/tonemap-lut-sizes.html', port: 5222 });
  report.hardware = browser.hardware;
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical GPU required');
  const page = browser.page,
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => window.lutSizeFixture);
  const context = await page.evaluate(() => ({
      sources: window.lutSizeFixture.sources,
      domainMin: window.lutSizeFixture.domainMin,
      domainMax: window.lutSizeFixture.domainMax,
    })),
    min = context.domainMin.map(Math.fround),
    max = context.domainMax.map(Math.fround);
  function verify(label, config, actual) {
    report.captures.push({ label, config, samples, ...actual });
    check(label + ' accepted', actual.accepted ?? true, true);
    if (actual.accepted === false) return actual;
    check(label + ' actual sample count', actual.sampleCount, samples);
    const expected = context.sources.map((rgba) => reference(rgba, config, min, max));
    close(
      label + ' CPU trilinear/neutral/encoding reference',
      actual.image.pixels,
      expected.map((value) => value.image),
      0.0015,
    );
    if (config.output)
      close(
        label + ' ColorOutput excess HDR/P3 CPU reference',
        actual.excess.pixels,
        expected.map((value) => value.excess),
        0.004,
      );
    check(label + ' GPU LUT dimensions', actual.lastLUT.size, [
      config.size ?? 33,
      config.size ?? 33,
      config.size ?? 33,
    ]);
    check(label + ' GPU LUT format', actual.lastLUT.format, 'rgba32float');
    if (!config.noLUT) {
      check(label + ' red-fastest row layout', actual.lastLUT.bytesPerRow, (config.size ?? 33) * 16);
      check(label + ' image row layout', actual.lastLUT.rowsPerImage, config.size ?? 33);
      check(label + ' upload extent', actual.lastLUT.extent, actual.lastLUT.size);
    }
    if (['no-lut-external', 'legacy33-external', 'legacy33-hdr-p3'].includes(label)) {
      const before = baseline?.captures.find((capture) => capture.label === label && capture.samples === samples);
      if (before) {
        check(label + ' preserves old33/no-LUT exact shader text', actual.shaderHash, before.shaderHash);
        check(label + ' preserves old33/no-LUT exact attachment', actual.image.hash, before.image.hash);
      }
    }
    return actual;
  }
  async function render(label, config) {
    return verify(label, config, await page.evaluate((config) => window.lutSizeFixture.render(config), config));
  }
  for (samples of [4, 1]) {
    if (samples === 1) {
      await page.evaluate(() => window.lutSizeFixture.dispose());
      await page.goto('http://127.0.0.1:5222/tests/tonemap-lut-sizes.html?samples=1');
      await page.waitForFunction(() => window.lutSizeFixture);
    }
    await render('no-lut-external', { noLUT: true });
    await render('legacy33-external', { size: 33, legacy: true });
    await render('legacy33-hdr-p3', { size: 33, legacy: true, output: true, p3: true });
    for (const size of sizes) {
      const config = { size },
        actual = await render('external-size-' + size, config);
      if (actual.accepted) {
        const steady = await page.evaluate(() => window.lutSizeFixture.steady());
        check('unchanged size ' + size + ' output stable', steady.image.hash, actual.image.hash);
        for (const resource of ['textures', 'buffers', 'groups', 'pipelines', 'uploads'])
          check('unchanged size ' + size + ' reuses ' + resource, steady.allocations[resource], 0);
      }
      await render('hdr-p3-size-' + size, { size, output: true, p3: true });
    }
    for (const [path, size] of [
      ['standalone', 17],
      ['standalone', 65],
      ['stack', 2],
      ['stack', 64],
    ])
      await render(path + '-size-' + size, { path, size });
    for (const size of [2, 17, 65]) await render('parsed-size-' + size, { size, parsed: true });
    await render('hdr-srgb-size16', { size: 16, output: true, p3: false });
    const start = await render('replacement-start', { size: 2 });
    if (start.accepted) {
      for (const config of [
        { size: 65, mutate: true },
        { size: 17, mutate: false, variant: 1 },
        { size: 33, legacy: true, variant: 0 },
        { size: 33, noLUT: true },
      ])
        verify(
          'replacement-' + config.size + '-' + !!config.noLUT,
          config,
          await page.evaluate((config) => window.lutSizeFixture.replace(config), config),
        );
      const config = { size: 17, mutate: true },
        before = await render('restore-start', config),
        restored = await page.evaluate(() => window.lutSizeFixture.restore());
      check('restoration actually replaces the device', restored.changedDevice, true);
      check('restoration preserves snapshotted variable LUT pixels', restored.image.hash, before.image.hash);
    }
    check('GPU validation and engine errors', await page.evaluate(() => window.lutSizeFixture.errors), []);
  }
  check('page errors', errors, []);
  assert.deepEqual(report.failures, [], 'Variable LUT size GPU comparisons failed');
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(output + '/gpu.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        hardware: report.hardware?.webgpu,
        checks: report.checks.length,
        captures: report.captures.length,
        failures: report.failures,
        error: report.error,
        report: output + '/gpu.json',
      },
      null,
      2,
    ),
  );
  await browser?.page.evaluate(() => window.lutSizeFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
