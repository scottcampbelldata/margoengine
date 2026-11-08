import test from 'node:test';
import assert from 'node:assert/strict';
import { SplatBrush, brushShader } from '../dist/brush.js';
import { Splats } from '../dist/index.js';

test('SplatBrush checks its cloud and refuses work before a frame, after dispose and on WebGL', async () => {
  assert.throws(() => new SplatBrush({}), TypeError);
  const brush = new SplatBrush(Splats.reserve(4));
  assert.deepEqual(brush.frame, [0, 0], 'no frame drawn yet');
  assert.throws(() => brush.select('all'), { code: 'disposed' }, 'not attached');
  assert.throws(() => brush.select('all', 'toggle'), RangeError);
  assert.throws(() => brush.paint('all', [1, 0]), RangeError, 'an RGB colour');
  assert.throws(() => brush.paint('all', [1, 0, 2]), RangeError, 'colour 0 to 1');
  assert.throws(() => brush.paint('all', [1, 0, 0], 1.5), RangeError, 'strength 0 to 1');
  await assert.rejects(brush.pick(1, 1, 2), RangeError, 'threshold 0 to 1');
  assert.throws(() => new SplatBrush(Splats.reserve(4)).setup({}), { code: 'unsupported' });
  brush.dispose();
  brush[Symbol.dispose]();
  assert.throws(() => brush.setup({ gpu: {} }), { code: 'disposed' });
});

test('Splats.read returns the data of an unattached cloud, as written', async () => {
  const cloud = Splats.reserve(2, 4);
  cloud.write(1, {
    positions: new Float32Array([1, 2, 3]),
    covariances: new Float32Array([1, 0.1, 0, 2, 0, 3]),
    colors: new Float32Array([0.5, 0.25, 0.75, 0.8]),
    sphericalHarmonics: new Float32Array(12).fill(0.125),
  });
  const data = await cloud.read();
  assert.deepEqual([...data.positions], [0, 0, 0, 1, 2, 3]);
  assert.deepEqual([...data.covariances].map((v) => Math.fround(v)), [1, 0, 0, 1, 0, 1, 1, 0.1, 0, 2, 0, 3].map(Math.fround));
  assert.deepEqual([...data.colors], [0, 0, 0, 0, 0.5, 0.25, 0.75, Math.fround(0.8)]);
  assert.equal(data.sphericalHarmonics.length, 24);
  assert.equal(data.sphericalHarmonics[23], 0.125);
  assert.equal((await Splats.reserve(1).read()).sphericalHarmonics, undefined, 'no SH without SH');
  const gone = Splats.reserve(1);
  gone.dispose();
  await assert.rejects(gone.read(), { code: 'disposed' });
});

test('the brush shader orders depth keys and keeps the SH convention', () => {
  assert.match(brushShader, /select\(bits\^0x80000000u,~bits,\(bits>>31u\)==1u\)/, 'negative depths sort below positive');
  assert.match(brushShader, /0\.2820947918/, 'DC term of the 3DGS colour');
  assert.match(brushShader, /positions\[i\]\.w=0;colors\[i\]\.a=0;/, 'erase hides as Splats.clear');
});
