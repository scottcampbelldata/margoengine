import test from 'node:test';
import assert from 'node:assert/strict';
import { fitsWCS, fitsGrid, volumeFromFITS } from '@margoengine/sciviz/fits';
import { mrcGrid } from '@margoengine/sciviz/mrc';

test('scientific grids retain zero singleton origins with orthogonal cell roundoff', { timeout: 1000 }, () => {
  const grid = mrcGrid({
    data: [1, 2, 3, 4],
    dims: [1, 2, 2],
    world: ([x, y, z]) => [x + Math.cos(Math.PI / 2) * y, y, z],
  });
  assert.deepEqual(grid.bounds, [0, 1, 0, 1, 0, 1]);
});

test('scientific grids preserve descending physical axes and volume sample order', { timeout: 1000 }, () => {
  for (const steps of [
    [-1, 2, 3],
    [1, -2, 3],
    [1, 2, -3],
    [-1, -2, -3],
  ]) {
    const wcs = fitsWCS(
        {
          CRPIX1: 1,
          CRPIX2: 1,
          CRPIX3: 1,
          CRVAL1: 10,
          CRVAL2: 20,
          CRVAL3: 30,
          CDELT1: steps[0],
          CDELT2: steps[1],
          CDELT3: steps[2],
        },
        3,
      ),
      image = { data: Float32Array.from({ length: 12 }, (_, i) => i), dims: [3, 2, 2], world: (p) => wcs.world(p) },
      grid = fitsGrid(image),
      expected = [10, 10 + 2 * steps[0], 20, 20 + steps[1], 30, 30 + steps[2]];
    assert.deepEqual(grid.bounds, expected);
    assert.deepEqual([...grid.data], [...image.data]);
    let options;
    const layer = {};
    assert.equal(
      volumeFromFITS(
        {
          volume(data, o) {
            assert.deepEqual(data, grid.data);
            options = o;
            return layer;
          },
        },
        image,
      ),
      layer,
    );
    assert.deepEqual(options.bounds, expected);
  }
});

test('scientific grids reject rotated, sheared, permuted and nonlinear sample transforms with a code', {
  timeout: 1000,
}, () => {
  for (const world of [
    ([x, y, z]) => [-y, x, z],
    ([x, y, z]) => [x + y / 2, y, z],
    ([x, y, z]) => [y, x, z],
    ([x, y, z]) => [x * x, y, z],
  ]) {
    const image = { data: new Float32Array(12), dims: [3, 2, 2], world };
    assert.throws(
      () => mrcGrid(image),
      (e) => e.code === 'unsupported' && /axis-aligned/.test(e.message),
    );
    let calls = 0;
    assert.throws(
      () =>
        volumeFromFITS(
          {
            volume() {
              calls++;
            },
          },
          image,
        ),
      (e) => e.code === 'unsupported',
    );
    assert.equal(calls, 0);
  }
});
