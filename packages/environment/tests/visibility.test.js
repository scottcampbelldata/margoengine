// CPU checks of the irradiance volume's `visibility` option (@margoengine/environment/probes): validation, the buffer
// layout, the header words the shaders read, and the CPU mirror's visibility weighting. The GPU depth reduction and
// the shaded result: tests/visibility-browser.js (npm run test:visibility:browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { LightProbes } from '../dist/probes.js';

const volume = { min: [-4, 0, -2], max: [4, 3, 2], counts: [4, 2, 2] };

test('visibility is a boolean option and adds 24 bins of two floats per probe after every other texel', () => {
  assert.throws(() => new LightProbes({ volume: { ...volume, visibility: 'yes' } }), TypeError);
  const plain = new LightProbes({ volume }),
    seen = new LightProbes({ volume: { ...volume, visibility: true } });
  assert.equal(seen.byteLength - plain.byteLength, 16 * 24 * 8);
  assert.equal(seen.volume.visibility, true);
  assert.equal(new LightProbes({ volume: { ...volume, visibility: false } }).byteLength, plain.byteLength);
});

// SHA-256 of LightProbes' shading declarations (pbr(2)) at bef64ee0a, main before visibility: without an environment
// and with one. A volume without `visibility` must give this exact text, so no other LightProbes user changes.
const MAIN_SHADING = {
  // probeRadiance blends its two levels by GGX alpha (KB-A3c): swapping the old roughness-linear probeRadiance back in
  // gives 7dac762f30886648606a951f80b2d3f0bc5f7798b279626c2a0407705cac9bd4 (plain) and
  // 9d7b8332c161cfd0bb9bbacb518a8dffc9e6af1297a5e8a7d11044dcf4b3bae3 (environment), the hashes pinned before. That
  // environment text was bef64ee0a's with IBL_WGSL's nine comment lines gone (KB-RM1); the old IBL_WGSL gave
  // 3d3107edd1c91e6866425ee516fea34f3ed9c055367fd6d36fc198ca7d56eeea. IBL_WGSL's iblPrefiltered then moved to the GGX
  // alpha mip blend (KB-A3e): its old one-line roughness-linear lookup back in gives
  // 48a522e352451c7779df65b6d492169404b572406f0ecc4efe520257dd513aa4 (environment), the hash pinned before.
  plain: 'a1169cea65852ccb4621169a86537239a78a6120baad6f5bd9eeef91451ff258',
  environment: '33856f29e650cc7d018543695418d193c8f6fe9bbe6e8250654446703c9751be',
};
const coreShader = readFileSync(new URL('../../core/src/shaders.ts', import.meta.url), 'utf8').split('`')[1];
function shading(environment, extra) {
  const device = mockGPU().device,
    stub = { device, disposed: false, version: 0, specularView: {}, sampler: {}, brdfLut: {}, shBuffer: {} };
  const probes = new LightProbes({
    environment: environment ? { ...stub, paramsBuffer: {}, restore: () => Promise.resolve() } : undefined,
    volume: { min: [-2, 0, -2], max: [2, 3, 2], counts: [2, 2, 2], ...extra },
  });
  probes.setup({ backend: 'webgpu', gpu: device, onError() {}, removePlugin() {} });
  return { declarations: probes.pbr(2).declarations, patched: probes.shader(coreShader, 0), zero: probes.pbr(0) };
}
const sha = (text) => createHash('sha256').update(text).digest('hex');

test("without visibility the shading WGSL is byte for byte main's; with it the visibility code is added", () => {
  for (const [name, environment] of [
    ['plain', false],
    ['environment', true],
  ]) {
    for (const extra of [{}, { visibility: false }, { sh: 1 }]) {
      const { declarations, patched, zero } = shading(environment, extra);
      assert.equal(sha(declarations), MAIN_SHADING[name], `${name} ${JSON.stringify(extra)}`);
      assert.ok(patched.startsWith(zero.declarations), 'the core patch carries the same declarations');
      assert.ok(!/probeBin|total/.test(declarations));
    }
    const seen = shading(environment, { visibility: true });
    assert.match(seen.declarations, /fn probeBin\(/);
    assert.match(seen.declarations, /if\(total>0\.0\)/);
    assert.ok(seen.patched.startsWith(seen.zero.declarations));
  }
});
