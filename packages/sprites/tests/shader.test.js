// Node checks of @margoengine/sprites/shader and the params a shaded layer packs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packSprites, Sprite, SPRITE_FLOATS, SpriteLayer } from '../dist/index.js';
import { dissolveShader, flashShader, outlineShader, paletteShader, spriteShader } from '../dist/shader.js';

const atlas = { width: 16, height: 16, data: new Uint8Array(1024) };
const camera = { x: 0, y: 0, zoom: 1 };

test('spriteShader wants a WGSL fn effect and returns a frozen shader', () => {
  const shader = spriteShader('fn effect(c:vec4f,s:SpriteInput)->vec4f{return c;}');
  assert.ok(Object.isFrozen(shader));
  for (const bad of ['', 'fn other(){}', 42, undefined]) assert.throws(() => spriteShader(bad), TypeError);
});

test('presets bake their options as WGSL constants and check them', () => {
  assert.match(flashShader('#ff0000').code, /mix\(c\.rgb,vec3f\(1,0,0\),s\.params\.x\)/);
  assert.match(outlineShader({ width: 2 }).code, /for\(var y=-2;y<=2;y\+\+\)/);
  for (const width of [0, 5, 1.5]) assert.throws(() => outlineShader({ width }), RangeError);
  assert.throws(() => dissolveShader({ band: 2 }), RangeError);
  assert.match(paletteShader(['#ff0000'], ['#0000ff']).code, /vec3f\(1,0,0\)/);
  assert.throws(() => paletteShader([], []), RangeError);
  assert.throws(() => paletteShader(['#000'], []), RangeError);
  assert.throws(() => paletteShader(Array(17).fill(0), Array(17).fill(0)), RangeError);
});

test('a stride of 16 packs each sprite params after its 12 floats, zeros by default', () => {
  const data = new Float32Array(32);
  const { count } = packSprites(
    [new Sprite({ params: [1, 2, 3, 4] }), new Sprite()],
    data,
    camera,
    16,
    16,
    true,
    SPRITE_FLOATS + 4,
  );
  assert.equal(count, 2);
  assert.deepEqual([...data.subarray(12, 16)], [1, 2, 3, 4]);
  assert.deepEqual([...data.subarray(28, 32)], [0, 0, 0, 0]);
  assert.throws(() => packSprites([new Sprite({ params: [NaN, 0, 0, 0] })], data, camera, 16, 16, true, 16), {
    message: /Invalid sprite params/,
  });
  // Without a shader the layout stays 12 floats and params are not read.
  const plain = new Float32Array(12);
  assert.equal(packSprites([new Sprite({ params: [NaN, 0, 0, 0] })], plain, camera, 16, 16).count, 1);
});

test('a layer takes a shader made by spriteShader and runs its time on', () => {
  assert.throws(() => new SpriteLayer({ atlas, shader: { code: 'nothing' } }), TypeError);
  const layer = new SpriteLayer({ atlas, shader: flashShader() });
  assert.equal(layer.time, 0);
  layer.onPreUpdate(0.25);
  layer.onPreUpdate(0);
  assert.equal(layer.time, 0.25);
});
