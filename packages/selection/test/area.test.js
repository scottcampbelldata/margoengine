import assert from 'node:assert/strict';
import test from 'node:test';
import { AreaPicking } from '../dist/area.js';
test('area queries validate shapes and allocation budgets before touching the GPU', async () => {
  for (const maxPixels of [0, -1, NaN, Infinity, 1.1]) assert.throws(() => new AreaPicking({ maxPixels }), RangeError);
  const picker = new AreaPicking();
  assert.throws(() => picker.rect({ x: 0, y: 0, width: NaN, height: 1 }), RangeError);
  await assert.rejects(
    picker.polygon([
      [0, 0],
      [1, 1],
    ]),
    RangeError,
  );
  const controller = new AbortController();
  controller.abort('cancelled');
  await assert.rejects(
    picker.polygon(
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      undefined,
      controller.signal,
    ),
    (e) => e === 'cancelled',
  );
  picker.dispose();
  await assert.rejects(picker.rect({ x: 0, y: 0, width: 1, height: 1 }), /disposed/);
});

test('area layers option scopes the query view; a view with its own layers wins', async () => {
  for (const layers of [-1, 1.5, 2 ** 32, NaN]) assert.throws(() => new AreaPicking({ layers }), RangeError);
  const seen = [];
  class Probe extends AreaPicking {
    get queryEngine() {
      return { gpu: {}, canvas: { clientWidth: 100, clientHeight: 100, width: 100, height: 100 } };
    }
    async queryContext(x, y, view) {
      seen.push(view);
    }
  }
  const triangle = [
    [0, 0],
    [50, 0],
    [0, 50],
  ];
  await new Probe({ layers: 2 }).polygon(triangle);
  await new Probe({ layers: 2 }).polygon(triangle, { viewport: [0, 0, 1, 1], layers: 4 });
  await new Probe().polygon(triangle);
  assert.equal(seen[0].layers, 2, 'the option fills in the mask');
  assert.equal(seen[1].layers, 4, 'an explicit view mask wins');
  assert.equal(seen[2], undefined, 'no option, no view: the camera decides');
});
