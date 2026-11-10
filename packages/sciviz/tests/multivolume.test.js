// CPU checks of the multivolume entry: the component split is exact, and bad input is refused before any GPU work.
import assert from 'node:assert/strict';
import test from 'node:test';
import { componentChannels, multiVolume } from '../dist/multivolume.js';

const dims = [2, 2, 2];
// A figure stand-in: every refusal below must happen before the renderer or device is touched.
const figure = { renderer: {}, addLayer() { throw new Error('a refused layer must not be added'); } };
const channel = (extra = {}) => ({ data: new Float32Array(8), dims, ...extra });

test('componentChannels splits interleaved tuples exactly and keeps per-channel options', () => {
  const data = Float64Array.from({ length: 24 }, (_, i) => i);
  const channels = componentChannels(data, 3, dims, [{ colormap: 'viridis' }, {}, { range: [0, 30] }]);
  assert.equal(channels.length, 3);
  for (let k = 0; k < 3; k++) {
    assert.deepEqual(Array.from(channels[k].data), Array.from({ length: 8 }, (_, i) => i * 3 + k));
    assert.deepEqual(channels[k].dims, dims);
  }
  assert.equal(channels[0].colormap, 'viridis');
  assert.deepEqual(channels[2].range, [0, 30]);
  // NaN survives the split, so the shader can skip it as missing.
  assert.ok(Number.isNaN(componentChannels([NaN, 1, 2, 3, 4, 5, 6, 7], 1, dims)[0].data[0]));
});

test('componentChannels refuses component counts outside 1 to 4 and wrong lengths', () => {
  for (const k of [0, 5, 1.5, NaN]) assert.throws(() => componentChannels(new Float32Array(8 * 4), k, dims), RangeError);
  assert.throws(() => componentChannels(new Float32Array(15), 2, dims), RangeError);
});

test('multiVolume refuses bad figures, channel counts, shapes, bounds, ranges and options', () => {
  assert.throws(() => multiVolume(undefined, [channel()]), TypeError);
  assert.throws(() => multiVolume({}, [channel()]), TypeError);
  for (const channels of [[], Array.from({ length: 5 }, () => channel()), 'not an array'])
    assert.throws(() => multiVolume(figure, channels), RangeError);
  const bad = [
    channel({ dims: [1, 2, 2], data: new Float32Array(4) }),
    channel({ dims: [2, 2, 2.5] }),
    channel({ dims: [2049, 2, 2] }),
    channel({ data: new Float32Array(7) }),
    channel({ bounds: [0, 1, 0, 1, 1, 0] }),
    channel({ bounds: [0, 1, 0, 1, 0, Infinity] }),
    channel({ bounds: [0, 1, 0, 1] }),
    channel({ range: [1, 1] }),
    channel({ range: [0, NaN] }),
  ];
  for (const c of bad) assert.throws(() => multiVolume(figure, [channel(), c]), RangeError, JSON.stringify({ ...c, data: c.data.length }));
  for (const options of [{ density: -1 }, { density: NaN }, { quality: 0 }, { quality: Infinity }])
    assert.throws(() => multiVolume(figure, [channel()], options), RangeError);
});
