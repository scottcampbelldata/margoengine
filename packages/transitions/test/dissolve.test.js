import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
// Exact JS twin of the dissolve threshold: PCG (Jarzynski and Olano, JCGT 9(3), 2020) nested over the pixel.
const pcg = (v) => {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const threshold = (x, y) => (pcg((x + pcg(y)) >>> 0) >>> 8) / 16777216;

test('dissolve thresholds come from an integer hash of the pixel', () => {
  assert.match(
    code,
    /fn dissolveThreshold\(pixel:vec2u\)->f32 \{return f32\(dissolvePcg\(pixel\.x\+dissolvePcg\(pixel\.y\)\)>>8u\)\*5\.9604645e-8;\}/,
  );
  assert.match(code, /edge=dissolveThreshold\(vec2u\(i\.uv\*vec2f\(textureDimensions\(after\)\)\)\);/);
  assert.doesNotMatch(code, /43758|12\.9898/);
});

test('dissolve thresholds are uniform in [0, 1) with no structure between neighbours', () => {
  const bins = new Array(16).fill(0);
  let covariance = 0,
    n = 0;
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++) {
      const t = threshold(x, y);
      assert.ok(t >= 0 && t < 1);
      bins[Math.floor(t * 16)]++;
      covariance += (t - 0.5) * (threshold(x + 1, y) - 0.5) + (t - 0.5) * (threshold(x, y + 1) - 0.5);
      n++;
    }
  for (const b of bins) assert.ok(Math.abs(b / n - 1 / 16) < 0.003, `bins ${bins}`);
  assert.ok(Math.abs((covariance / (2 * n)) * 12) < 0.01, 'neighbour correlation');
});
