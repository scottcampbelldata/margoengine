// tilesHeightQuery: the height of the drawn tiles straight below a place, through the renderer's frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { WGS84_A, degToRad } from '@margoengine/math/geo';
import { tilesHeightQuery } from '../dist/height.js';

const canvas = {
  width: 8,
  height: 8,
  clientWidth: 8,
  clientHeight: 8,
  getContext: () => null,
  addEventListener() {},
  removeEventListener() {},
};
const engine = async () =>
  new Runtime(
    canvas,
    await TransformStore.create(16),
    { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 1], target: [0, 0, 0] },
    null,
  );
// The engine's Y-up view of ECEF, as a renderer with frame 'local' far from the origin would give.
const frame = { toWorld: (p) => [p[0], p[2], -p[1]] };

test('the height of a drawn tile below a place; undefined off it and with nothing drawn', async () => {
  const e = await engine(),
    // A 300 m tall slab standing on the ellipsoid at longitude 0, latitude 0 (ECEF +X is up there).
    slab = e
      .createMesh()
      .setGeometry(box())
      .setPosition([WGS84_A + 150, 0, 0])
      .setScale([300, 4000, 4000]),
    selected = [{ renderable: { model: slab } }],
    renderer = { ...frame, last: { selected } },
    heightAt = tilesHeightQuery(e, renderer);
  const h = heightAt(0, 0);
  // Float32 vertex positions at the Earth's radius: about half a metre.
  assert.ok(Math.abs(h - 300) < 1, `height ${h}`);
  assert.equal(heightAt(degToRad(1), 0), undefined, 'no tile there');
  selected.length = 0;
  assert.equal(heightAt(0, 0), undefined, 'nothing drawn');
  assert.equal(heightAt(Number.NaN, 0), undefined);
  assert.throws(() => tilesHeightQuery(e, renderer, { bottom: -1 }), RangeError);
});
