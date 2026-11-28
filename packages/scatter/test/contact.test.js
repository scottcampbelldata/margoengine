// `base` and `skyOcclusion` values and shader edits (the pixels are contact.browser.mjs's).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { occludeAmbient } from '../../shared/occlude-ambient.js';
import { contactStages, contactValues } from '../src/contact.ts';

const lit = (statement) =>
  `struct Output {@location(0) position:vec3f,@location(3) material:vec4f}
@group(1) @binding(1) var<uniform> material:array<vec4f,7>;
@vertex fn vertex(@location(0) p:vec3f)->Output {var o:Output;return o;
}
@fragment fn fragment(i:Output,@builtin(front_facing) facing:bool)->@location(0) vec4f {
 ${statement}let linear=i.color*frame.radiance.w*frame.ambient.rgb+margoAmbient;return vec4f(linear,1);}`;

test('every ambient term takes the factor: the flat one, a hemisphere light and a sky', () => {
  assert.equal(occludeAmbient('x*frame.ambient.rgb;', 'k'), 'x*(frame.ambient.rgb*k);');
  assert.equal(occludeAmbient('a+margoAmbient;', 'k'), 'a+margoAmbient*k;');
  assert.equal(occludeAmbient('a*margoSkyLight(n);', 'k'), 'a*margoSkyLight(n)*k;');
  assert.equal(occludeAmbient('let margoAmbient=skyLighting(n);', 'k'), 'let margoAmbient=skyLighting(n);');
});

test('a mesh patch that writes i.color still writes a variable beside the contact stages', () => {
  const code = contactStages(lit('i.color=i.color*0.5;'), 5);
  assert.match(code, /fn fragment\(varyings:Output,/);
  assert.match(code, /var i=varyings;/);
  assert.ok(code.indexOf('var i=varyings;') < code.indexOf('i.color=mix(i.color,i.contactTint.rgb'));
  assert.ok(code.indexOf('i.color=mix(') < code.indexOf('i.color=i.color*0.5;'), 'the patch reads the tinted colour');
  assert.match(code, /\(frame\.ambient\.rgb\*contactSky\)\+margoAmbient\*contactSky/);
  assert.match(code, /material:array<vec4f,9>/);
  assert.match(code, /@location\(5\) contact:vec4f,@location\(6\) @interpolate\(flat\) contactTint:vec4f/);
});

test('contactValues is undefined without either option and rejects values out of range', () => {
  assert.equal(contactValues(undefined, undefined), undefined);
  const values = [...contactValues({ height: 0.25, tint: [0.1, 0.2, 0.3] }, { depth: 1, height: 8 })];
  assert.deepEqual(
    values.map((v) => +v.toFixed(3)),
    [0.1, 0.2, 0.3, 0.7, 0.25, 0.5, 1, 8],
  );
  for (const [base, sky] of [
    [{ height: 0 }],
    [{ height: 1, shade: 2 }],
    [{ height: 1, tint: [0, 0] }],
    [undefined, { depth: -1, height: 1 }],
    [undefined, { depth: 1, height: 0 }],
  ])
    assert.throws(() => contactValues(base, sky), RangeError);
  assert.throws(() => contactValues(null), TypeError);
  assert.throws(() => contactStages('fn nothing(){}', 0), TypeError);
});
