// `@margoengine/scatter/clearing-map` without a GPU: the shader edits, the options and the binding entries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scatterCullShader } from '../dist/index.js';
import { ScatterClearingMap, clearingMap, clearingMapCode } from '../dist/clearing-map.js';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };

const world = { bounds: [-8, -8, 8, 8], follow: true, densityMap: () => undefined };

test('the distribute shader reads the map by each instance key; without thinning it is unchanged', () => {
  const source = clearingMap(() => undefined);
  for (const [options, key] of [
    [{}, 'i'],
    [world, 'key'],
    [{ ...world, clumps: { size: 2, cover: 0.5 }, clearings: [{ center: [0, 0], radius: 1 }] }, 'key'],
  ]) {
    const plain = scatterCullShader(options),
      thinned = scatterCullShader({ ...options, thinning: source });
    assert.ok(!plain.includes('clearingAt'), 'no map code without thinning');
    assert.ok(thinned.includes(`hash((${key}*7u+6u)^0x7c3a21f5u)<clearing.look.x*open`));
    assert.ok(thinned.includes('scale*shrink*stand'));
    assert.ok(thinned.includes('@group(0) @binding(12) var clearingTexture'));
    assert.ok(thinned.indexOf('fn clearingAt') < thinned.indexOf('@compute'));
  }
  assert.throws(() => clearingMapCode('@compute fn main(){}', 'i'), { code: 'unsupported' });
});

test('the look is checked and kept', () => {
  assert.throws(() => clearingMap(), TypeError);
  const source = new ScatterClearingMap(() => undefined, { thin: 2 });
  assert.deepEqual(source.look, { thin: 2, shorten: 0.6, reach: 0.25 });
  for (const look of [{ thin: -1 }, { thin: 9 }, { shorten: 1.1 }, { reach: NaN }, { reach: 11 }])
    assert.throws(() => source.set({ shorten: 0.1, ...look }), RangeError, JSON.stringify(look));
  assert.equal(source.look.shorten, 0.6, 'a refused set changes nothing');
});

test('entries stay the same array until the map texture changes, and the uniform follows the map', () => {
  const written = [],
    freed = [],
    texture = (name) => ({ createView: () => name, destroy: () => freed.push(name) }),
    device = {
      createBuffer: () => ({ destroy: () => freed.push('buffer') }),
      createTexture: () => texture('empty'),
      queue: { writeBuffer: (_b, _o, data) => written.push([...data]), writeTexture() {} },
    };
  let map;
  const source = clearingMap(() => map);
  const none = source.entries(device);
  assert.equal(none[0].resource, 'empty');
  assert.deepEqual(written.at(-1), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(source.entries(device), none);
  map = { texture: texture('mask'), bounds: [10, 20, 18, 36] };
  const held = source.entries(device);
  assert.notEqual(held, none);
  assert.equal(held[0].resource, 'mask');
  assert.deepEqual(written.at(-1).slice(0, 4), [10, 20, 0.125, 0.0625]);
  assert.ok(Math.abs(written.at(-1)[4] - 1.4) < 1e-6);
  map = { ...map, bounds: [0, 0, 8, 16] };
  assert.equal(source.entries(device), held, 'a moved rectangle keeps the bind group');
  assert.deepEqual(written.at(-1).slice(0, 2), [0, 0]);
  map = { ...map, bounds: [0, 0, 0, 16] };
  assert.throws(() => source.entries(device), RangeError);
  source.dispose();
  source.dispose();
  assert.deepEqual(freed, ['buffer', 'empty'], "the map's texture is borrowed");
  assert.throws(() => source.entries(device), { code: 'disposed' });
});
