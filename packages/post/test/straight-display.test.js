// The display transform for a premultiplied canvas (packages/shared/display.js, KB-POST-ALPHARIM1). The GPU proof is
// packages/post/test/alpha-rim-browser.mjs; this pins the shader rewrite every post effect goes through.
import assert from 'node:assert/strict';
import test from 'node:test';
import { displayFor, displayShader, premultipliedCanvas, straightDisplay } from '../../shared/display.js';

const MARK = Symbol.for('margoengine.premultiplied-canvas');
const opaque = { canvas: {} },
  clear = { canvas: { [MARK]: true } };

test('only a canvas TransparentCanvas marks premultiplied is premultiplied', () => {
  assert.equal(premultipliedCanvas(clear), true);
  assert.equal(premultipliedCanvas(opaque), false);
  assert.equal(premultipliedCanvas({ canvas: { [MARK]: false } }), false);
  assert.equal(premultipliedCanvas(undefined), false);
});

test('an opaque canvas, or a shader with no display transform, keeps the same code', () => {
  const code = `${displayShader}fn f(c:vec3f,s:vec4f)->vec4f {return vec4f(toDisplay(c),s.a);}`;
  assert.equal(displayFor(opaque, code), code);
  assert.equal(displayFor(undefined, code), code);
  const linear = 'fn f(c:vec3f,s:vec4f)->vec4f {return vec4f(c,s.a);}';
  assert.equal(displayFor(clear, linear), linear);
});

test('every display output post writes encodes the straight colour on a premultiplied canvas', () => {
  for (const [line, colour, alpha] of [
    ['return vec4f(toDisplay(c),s.a);', 'c', 's.a'],
    ['return vec4f(toDisplay(c.rgb),c.a);', 'c.rgb', 'c.a'],
    ['return vec4f(toDisplay(linear.rgb),linear.a);', 'linear.rgb', 'linear.a'],
    ['s=vec4f(toDisplay(s.rgb),s.a);', 's.rgb', 's.a'],
    ['return vec4f(toDisplay(max(c,vec3f(0))*exp2(u.w)),now.a);', 'max(c,vec3f(0))*exp2(u.w)', 'now.a'],
    ['fn out(c:vec3f,a:f32)->vec4f {return vec4f(toDisplay(c),a);}', 'c', 'a'],
  ]) {
    const out = displayFor(clear, `${displayShader}${line}`);
    assert.ok(out.includes(`vec4f(toDisplayStraight(${colour},${alpha}),${alpha})`), line);
    assert.ok(!/vec4f\(toDisplay\(/.test(out), `${line}: no output left on the premultiplied colour`);
    assert.ok(out.includes('fn toDisplayStraight(c:vec3f,a:f32)->vec3f'), line);
  }
});

test('a display shader with no output it can convert throws instead of keeping the rim', () => {
  assert.throws(() => straightDisplay(`${displayShader}let d=toDisplay(c);`), RangeError);
  // Code that calls toDisplayStraight itself (Bloom, SelectiveBloom) only gains the function.
  const own = `${displayShader}let d=toDisplayStraight(c,s.a);`;
  assert.ok(straightDisplay(own).startsWith(own));
});

test('the straight transform divides partly covered pixels only', () => {
  const fn = straightDisplay(`${displayShader}return vec4f(toDisplay(c),s.a);`).split('fn toDisplayStraight')[1];
  assert.match(fn, /if\(a>0\.0&&a<1\.0\)\{return toDisplay\(c\/a\)\*a;\}return toDisplay\(c\);/);
});
