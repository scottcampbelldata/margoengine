// The display transform for a premultiplied canvas (packages/shared/display.js, KB-POST-ALPHARIM1). The GPU proof is
// packages/post/test/alpha-rim-browser.mjs; this pins the shader rewrite every post effect goes through.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

// KB-WATER-ALPHARIM1: water's, post caustics' and the lens drops' composites kept the scene's alpha and encoded the
// premultiplied colour, so each drew the rim. Any source that writes `toDisplay(c)` beside a sampled alpha must build
// through displayFor, itself or in every module that compiles its shader.
test('every display shader that keeps a sampled alpha is built through displayFor, in every package', () => {
  const compiledBy = {
      'dof/shaders.ts': ['dof/index.ts'],
      'post/caustics-shader.ts': ['post/caustics.ts', 'water/caustics.ts'],
      'post/shaders.ts': ['post/ssao.ts'],
      'water/liquid-shaders.ts': ['water/liquid.ts'],
    },
    keepsAlpha = /toDisplay\((?:[^()]|\([^()]*\))*\)(?:' : '[\w.]+')?\}?,\s*\w+\.a\)/,
    packages = new URL('../../', import.meta.url),
    source = (name) => {
      const [owner, ...rest] = name.split('/');
      return readFileSync(new URL(`${owner}/src/${rest.join('/')}`, packages), 'utf8');
    },
    found = [];
  for (const owner of readdirSync(packages)) {
    const folder = new URL(`${owner}/src/`, packages);
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder, { recursive: true })) {
      const name = `${owner}/${String(file).replaceAll('\\', '/')}`;
      if (!name.endsWith('.ts') || !keepsAlpha.test(source(name))) continue;
      found.push(name);
      for (const compiler of compiledBy[name] ?? [name])
        assert.match(source(compiler), /displayFor\(/, `${compiler} compiles ${name} without displayFor`);
    }
  }
  for (const name of Object.keys(compiledBy)) assert.ok(found.includes(name), `${name}: the scan no longer sees it`);
  assert.ok(found.includes('water/underwater.ts') && found.length > 12, found.join(', '));
});
