import test from 'node:test';
import assert from 'node:assert/strict';
import { night } from '../dist/night.js';
import { clouds } from '../dist/clouds.js';

// Exact JS twin of the WGSL PCG hash (Jarzynski and Olano, JCGT 9(3), 2020) in the night shader.
const pcg = (v) => {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const hash21 = (x, y) => (pcg((x >>> 0) + pcg(y >>> 0)) >>> 8) / 16777216;

test('the star-cell hash is the integer PCG hash, not a float or sine hash', () => {
  const code = night.wgsl;
  assert.match(code, /fn nightPcg\(v:u32\)->u32 \{let s=v\*747796405u\+2891336453u;/);
  assert.match(code, /\*277803737u;return \(w>>22u\)\^w;\}/);
  assert.match(
    code,
    /fn hash21\(p:vec2f\)->f32 \{let c=bitcast<vec2u>\(vec2i\(p\)\);return f32\(nightPcg\(c\.x\+nightPcg\(c\.y\)\)>>8u\)\*5\.9604645e-8;\}/,
  );
  assert.doesNotMatch(code, /fract\(sin|0\.1031|43758/);
  assert.equal(code.split('hash21(').length - 1, 2, 'one declaration and the one caller');
});

test('star cells over +-400: 2.5% stars, mean 0.5, decorrelated twinkle phases', () => {
  let count = 0,
    stars = 0,
    sum = 0,
    max = 0,
    neighbour = 0;
  const phases = [];
  for (let x = -400; x <= 400; x++)
    for (let y = -400; y <= 400; y++) {
      const r = hash21(x, y);
      count++;
      sum += r;
      max = Math.max(max, r);
      if (r > 0.975) {
        stars++;
        phases.push((r * 613.7) % 1);
      }
      neighbour += (r - 0.5) * (hash21(x + 1, y) - 0.5);
    }
  assert.ok(max < 1);
  assert.ok(Math.abs(stars / count - 0.025) < 0.001, `star fraction ${stars / count}`);
  assert.ok(Math.abs(sum / count - 0.5) < 0.005, `mean ${sum / count}`);
  // Neighbour correlation: uniform variance is 1/12; independent cells keep the covariance near 0.
  assert.ok(Math.abs((neighbour / count) * 12) < 0.01, `neighbour correlation ${(neighbour / count) * 12}`);
  // The phases of the stars fill 0..1 evenly (10 bins within 15% of their share).
  const bins = new Array(10).fill(0);
  for (const p of phases) bins[Math.floor(p * 10)]++;
  for (const b of bins) assert.ok(Math.abs(b / phases.length - 0.1) < 0.015, `phase bins ${bins}`);
});

test('cloud octaves turn by a fixed non-right angle with a near-2 lacunarity that also scales the footprint', () => {
  const code = clouds.wgsl;
  assert.equal(code.match(/fn cloudOctaves\(p:vec2f,footprint:f32,first:u32,last:u32\)->f32/g)?.length, 1);
  const m = /mat2x2f\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)\*q/.exec(code);
  assert.ok(m, 'octave transform');
  const [a, b, c, d] = m.slice(1).map(Number);
  assert.ok(Math.abs(a - d) < 1e-9 && Math.abs(b + c) < 1e-9, 'a scaled rotation');
  const scale = Math.hypot(a, b),
    angle = (Math.atan2(b, a) * 180) / Math.PI;
  const lacunarity = Number(/cells\*=([\d.]+)/.exec(code)[1]);
  assert.ok(Math.abs(scale - lacunarity) < 1e-4, `scale ${scale} vs footprint ${lacunarity}`);
  assert.ok(lacunarity >= 1.9 && lacunarity <= 2.2 && Math.abs(lacunarity - 2) > 0.05);
  assert.ok(angle > 20 && angle < 70 && Math.abs(angle - 36.87) > 5, `angle ${angle}`);
  assert.match(code, /smoothstep\(0\.35,1\.0,cells\)/);
  assert.match(code, /weight\*=0\.5/);
});
