import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openBrowser } from '../../../scripts/browser.js';

mkdirSync(new URL('../../../test-results/', import.meta.url), { recursive: true });
const context = await openBrowser({ startPath: '/packages/webgl2-compat/test/tiers.html', port: 'free' });
const errors = [];
const report = { status: 'running', tiers: [] };
const reportURL = new URL('../../../test-results/batch-273-tiers.json', import.meta.url);
context.page.on('pageerror', (error) => errors.push(error.message));
try {
  await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  for (const tier of ['full', 'half-float', 'ldr']) {
    const result = await context.page.evaluate((tier) => window.check.probe(tier), tier);
    report.tiers.push(result);
    writeFileSync(reportURL, JSON.stringify(report, null, 2) + '\n');
    assert.equal(result.tier, tier);
    assert.deepEqual(result.errors, [], `${tier}: validation errors`);
    assert.equal(result.gl, 0, `${tier}: GL error`);
    assert.equal(result.dither, false, `${tier}: no implicit GL dithering`);
    const expected = tier === 'ldr' ? [0, Math.fround(64 / 255), Math.fround(128 / 255), 1] : [-2, 0.25, 0.5, 4];
    for (const key of ['upload', 'copy', 'crossUsage', 'array', 'view', 'fragment', 'cpu'])
      assert.deepEqual(result[key], Array.from({ length: 4 }, () => expected).flat(), `${tier}: ${key}`);
    // On LDR, MSAA and blending write UNORM8, whose values are sampled as float32.
    assert.deepEqual(result.msaa, Array.from({ length: 4 }, () => expected).flat(), `${tier}: MSAA`);
    const blend = tier === 'ldr' ? result.blendOracle.map((byte) => Math.fround(byte / 255)) : Array(16).fill(0.5);
    assert.deepEqual(result.blended, blend, `${tier}: blend matches independent physical-format oracle exactly`);
    assert.ok(
      result.blendOracle.every((byte) => byte === result.blendOracle[0]),
      'equal channels and fragments',
    );
    assert.ok(
      [127, 128].includes(result.blendOracle[0]),
      'oracle stores one of the two exact neighbouring UNORM8 values',
    );
    assert.deepEqual(
      result.sample,
      [...new Float32Array([0.12345679104328156, -123456, 987654, 0.00000012345679])],
      `${tier}: sample precision`,
    );
    assert.equal(result.samplePhysical, 'rgba32float');
    for (let face = 0; face < 6; face++)
      assert.deepEqual(
        result.cube[face],
        Array.from({ length: 4 }, (_, pixel) => [-2 - face, 2 + face, (pixel + 1) / 16, 0.5]).flat(),
        `${tier}: sample-only cube face ${face} retains exact float32 values and texel orientation`,
      );
    const cubeView = Array.from({ length: 4 }, (_, pixel) => [-5, 5, (pixel + 1) / 16, 0.5]).flat();
    assert.deepEqual(
      result.cubeView,
      tier === 'ldr'
        ? cubeView.map((value) => Math.fround(Math.round(Math.max(0, Math.min(1, value)) * 255) / 255))
        : cubeView,
      `${tier}: sample-only cube face as a 2D view`,
    );
    assert.ok(result.dispatches.fragment > 0, `${tier}: fragment compute actually ran`);
    assert.ok(result.dispatches.cpu > 0, `${tier}: CPU compute actually ran`);
    // Sample-only RGBA32F allocations are allowed; renderbuffers must always use a supported physical target.
    const forbidden =
      tier === 'ldr'
        ? [0x8814, 0x881a, 0x822e, 0x8230, 0x822d, 0x822f, 0x8c3a]
        : tier === 'half-float'
          ? [0x8814, 0x822e, 0x8230, 0x8c3a]
          : [];
    assert.ok(
      result.allocations
        .filter((a) => a.name === 'renderbufferStorageMultisample')
        .every((a) => !forbidden.includes(a.internal)),
      `${tier}: MSAA allocations`,
    );
    for (const [format, report] of Object.entries(result.formats)) {
      const prefix =
        format.startsWith('rgba') || format === 'rg11b10ufloat' ? 'rgba' : format.startsWith('rg') ? 'rg' : 'r';
      assert.equal(
        report.physical,
        tier === 'full' ? format : `${prefix}${tier === 'half-float' ? '16float' : '8unorm'}`,
      );
      const channels = prefix === 'r' ? 1 : prefix === 'rg' ? 2 : 4;
      const half = tier === 'ldr' ? [0, 0x3404, 0x3804, 0x3c00] : [0xc000, 0x3400, 0x3800, 0x4400];
      const encoded =
        format === 'rg11b10ufloat'
          ? new Uint32Array([(0x340 << 11) | (0x1c0 << 22)])
          : format.includes('32')
            ? new Float32Array(expected.slice(0, channels))
            : new Uint16Array(half.slice(0, channels));
      const texel = [...new Uint8Array(encoded.buffer)];
      assert.deepEqual(
        report.bytes,
        Array.from({ length: 4 }, () => texel).flat(),
        `${tier}: ${format} exact logical copy bytes`,
      );
    }
    console.log(
      `${tier}: seven target formats, upload, copy, sampling, mip/layer view, MSAA, blend and two compute tiers passed`,
    );
  }
  assert.deepEqual(errors, []);
  report.status = 'passed';
  writeFileSync(reportURL, JSON.stringify(report, null, 2) + '\n');
} finally {
  await context.close();
}
