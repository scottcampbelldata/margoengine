// @margoengine/voxel-edit/shaders off the GPU: the brush source, the presets and argument checks. The GPU runs are in
// shaders-browser-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { brushSource, brushes, ShaderBrush } from '../dist/shaders.js';

test('a brush compiles to the prelude, the user code and the entry point', () => {
  const code = 'fn brush(p: vec3<i32>, value: u32) -> u32 { return value; }',
    source = brushSource(code);
  assert.ok(source.includes(code));
  assert.ok(source.indexOf('fn cell(') < source.indexOf(code));
  assert.ok(source.indexOf(code) < source.indexOf('fn brush_main('));
  for (const name of ['grid_size', 'inside', 'cell_index', 'face_offset', 'param', 'pass_number', 'hash', 'noise'])
    assert.match(source, new RegExp(`\\bfn ${name}\\(`));
  assert.deepEqual(Object.keys(brushes).sort(), ['erode', 'grow', 'noise', 'smooth']);
  for (const preset of Object.values(brushes))
    assert.match(brushSource(preset), /fn brush\(p: vec3<i32>, value: u32\) -> u32/);
});

test('bad code and devices are refused with a fix', async () => {
  for (const code of [undefined, 42, 'fn other() {}'])
    assert.throws(
      () => brushSource(code),
      (e) => e instanceof TypeError && /; pass one$/.test(e.message),
    );
  await assert.rejects(
    ShaderBrush.create(null, brushes.grow),
    (e) => e instanceof TypeError && /; pass /.test(e.message),
  );
  await assert.rejects(ShaderBrush.create({}, brushes.grow), TypeError);
});
