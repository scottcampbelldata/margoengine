import test from 'node:test';
import assert from 'node:assert/strict';
import { exportCube } from '../dist/export-cube.js';
import { Grade } from '../dist/grade.js';
import { HueGrade } from '../dist/hue.js';
import { parseCube, Tonemap } from '../dist/index.js';
import { gpuHarness } from '../../../tests/support/postfx-gpu.js';

test('exportCube round trips identity at all supported dimensions with red varying fastest', () => {
  for (const size of [2, 3, 17, 33, 65]) {
    const text = exportCube(new Grade(), { size, title: 'Identity # RGB' }),
      lut = parseCube(text);
    assert.equal(lut.size, size);
    assert.deepEqual([...lut.domainMin], [0, 0, 0]);
    assert.deepEqual([...lut.domainMax], [1, 1, 1]);
    for (let b = 0, i = 0; b < size; b++)
      for (let g = 0; g < size; g++)
        for (let r = 0; r < size; r++, i += 4)
          assert.deepEqual(
            [...lut.data.slice(i, i + 4)],
            [Math.fround(r / (size - 1)), Math.fround(g / (size - 1)), Math.fround(b / (size - 1)), 1],
          );
  }
});

test('exportCube snapshots current wheels, master/channel curves, saturation and HueGrade', () => {
  const g = new Grade({
    curves: {
      master: [
        [0, 0.25],
        [1, 0.25],
      ],
      red: [
        [0, 0],
        [1, 0.5],
      ],
    },
  });
  let lut = parseCube(exportCube(g, { size: 2 }));
  assert.deepEqual([...lut.data.slice(0, 4)], [0.125, 0.25, 0.25, 1]);
  g.options.curves = undefined;
  g.options.shadows = [0.1, 0, 0];
  lut = parseCube(exportCube(g, { size: 2 }));
  assert.equal(lut.data[0], Math.fround(0.1));
  const hue = new HueGrade({ hueShift: 120 });
  const text = exportCube(hue, { size: 2 });
  hue.options.hueShift = 0;
  assert.deepEqual([...parseCube(text).data.slice(4, 8)], [0, 1, 0, 1]);
  assert.deepEqual([...parseCube(exportCube(hue, { size: 2 })).data.slice(4, 8)], [1, 0, 0, 1]);
  g.options.shadows = undefined;
  g.options.hueSaturation = [0, 0, 0, 0, 0, 0];
  lut = parseCube(exportCube(g, { size: 2 }));
  assert.equal(lut.data[4], lut.data[5]);
  assert.equal(lut.data[5], lut.data[6]);
  const h = gpuHarness(),
    effect = Tonemap.attach(h.engine, {});
  effect.setLUT(text);
  h.frame();
  effect.dispose();
});

test('exportCube rejects invalid headers and invalid live controls without mutating the grade', () => {
  const g = new Grade();
  for (const options of [
    { size: 1 },
    { size: 66 },
    { size: 2.5 },
    { size: NaN },
    { title: 'x"\nLUT_3D_SIZE 2' },
    { title: '\u0000' },
    { title: 'a'.repeat(1025) },
  ])
    assert.throws(() => exportCube(g, options), RangeError);
  assert.throws(() => exportCube(null), TypeError);
  g.options.shadows = [2, 0, 0];
  assert.throws(() => exportCube(g), RangeError);
  assert.deepEqual(g.options.shadows, [2, 0, 0]);
  assert.equal(parseCube(exportCube(new Grade())).size, 33);
});
