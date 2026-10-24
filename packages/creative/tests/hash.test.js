import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
// Exact JS twin of the WGSL PCG hash (Jarzynski and Olano, JCGT 9(3), 2020) used by the stars and the film grain.
const pcg = (v) => {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul((s >>> ((s >>> 28) + 4)) ^ s, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const starHash = (x, y, z) => (pcg((x + pcg((y + pcg(z >>> 0)) >>> 0)) >>> 0) >>> 8) / 16777216;

test('the star shader hashes integer cells with PCG', () => {
  const code = source('../src/shaders/stars.wgsl');
  assert.match(code, /let state = v \* 747796405u \+ 2891336453u;/);
  assert.match(code, /let word = \(\(state >> \(\(state >> 28u\) \+ 4u\)\) \^ state\) \* 277803737u;/);
  assert.match(code, /return f32\(pcg\(cell\.x \+ pcg\(cell\.y \+ pcg\(cell\.z\)\)\) >> 8u\) \/ 16777216\.0;/);
  assert.doesNotMatch(code, /fract\(sin|0\.1031|33\.33|43758/);
});

test('star cells: 0.2% lit, mean 0.5, the tint stream independent of the seed stream', () => {
  let count = 0,
    lit = 0,
    sum = 0,
    covariance = 0;
  for (let face = 0; face < 6; face++)
    for (let x = 0; x < 450; x++)
      for (let y = 0; y < 450; y++) {
        const seed = starHash(x, y, face),
          tint = starHash(x, y, face + 10);
        count++;
        sum += seed;
        if (seed > 0.998) lit++;
        covariance += (seed - 0.5) * (tint - 0.5);
      }
  assert.ok(Math.abs(lit / count - 0.002) < 0.0003, `lit ${lit / count}`);
  assert.ok(Math.abs(sum / count - 0.5) < 0.005, `mean ${sum / count}`);
  assert.ok(Math.abs((covariance / count) * 12) < 0.01, `stream correlation ${(covariance / count) * 12}`);
});

test('film grain is an integer hash of the pixel and the frame time, uniform in [-0.5, 0.5)', () => {
  const code = source('../src/post.ts');
  assert.match(
    code,
    /let noise=f32\(grainPcg\(id\.x\+grainPcg\(id\.y\+grainPcg\(bitcast<u32>\(f\.lens\.w\)\)\)\)>>8u\)\*5\.9604645e-8-0\.5;/,
  );
  assert.doesNotMatch(code, /43758|12\.9898/);
  const time = new Float32Array(1),
    bits = new Uint32Array(time.buffer);
  const grain = (x, y, t) => {
    time[0] = t;
    return (pcg((x + pcg((y + pcg(bits[0])) >>> 0)) >>> 0) >>> 8) / 16777216 - 0.5;
  };
  let sum = 0,
    squares = 0,
    changed = 0,
    min = 1,
    max = -1;
  const n = 256 * 256;
  for (let x = 0; x < 256; x++)
    for (let y = 0; y < 256; y++) {
      const a = grain(x, y, 1.25),
        b = grain(x, y, 1.25 + 1 / 60);
      sum += a;
      squares += a * a;
      min = Math.min(min, a);
      max = Math.max(max, a);
      if (a !== b) changed++;
    }
  assert.ok(min >= -0.5 && max < 0.5);
  assert.ok(Math.abs(sum / n) < 0.005, `mean ${sum / n}`);
  assert.ok(Math.abs(squares / n - 1 / 12) < 0.002, `variance ${squares / n}`);
  assert.ok(changed / n > 0.999, 'each frame draws a new pattern');
});
