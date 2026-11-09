import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWGSL, wgslTypeName } from '../dist/wgsl.js';

test('module private variables infer concrete store types from constant initializers', () => {
  const module = checkWGSL(`
    struct Pair { value: f32, flag: bool }
    var<private> enabled = true;
    var<private> count = 2;
    var<private> scale = 0.5;
    var<private> axis = vec3(1, 2, 3);
    var<private> pair = Pair(1.0, false);
    @fragment fn main() -> @location(0) vec4f {
      enabled = false;
      count += 1;
      return vec4f(scale + f32(count) + f32(axis.x) + pair.value);
    }`);
  assert.deepEqual(
    module.globals.map((g) => [g.name, wgslTypeName(g.type)]),
    [
      ['enabled', 'bool'],
      ['count', 'i32'],
      ['scale', 'f32'],
      ['axis', 'vec3<i32>'],
      ['pair', 'Pair'],
    ],
  );
  assert.deepEqual(
    module.globals.map((g) => g.init.value),
    [true, 2, 0.5, [1, 2, 3], [1, false]],
  );
});

test('private inference preserves initializer and address-space validation', () => {
  for (const source of [
    'var<private> missing;',
    'fn runtime() -> f32 { return 1.0; } var<private> value = runtime();',
    'var<workgroup> value = 1;',
    'var<private> value: bool = 1;',
  ])
    assert.throws(
      () => checkWGSL(source),
      (e) => e.code === 'type',
    );
});
