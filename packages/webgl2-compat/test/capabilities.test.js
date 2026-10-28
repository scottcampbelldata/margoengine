// webgl2Capabilities and probeWebGL2 on stand-in contexts: the tier rules (EXT_color_buffer_float and highp are
// required for `full`), what `missing` names, limits read by enum, and that the probe releases its context.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPAT_EXTENSIONS,
  COMPAT_LIMITS,
  REQUIRED_EXTENSIONS,
  probeWebGL2,
  webgl2Capabilities,
} from '../dist/index.js';

/** A stand-in WebGL2 context with the given extensions and highp support. */
function fakeContext({ extensions = [], highp = true, limits = {} } = {}) {
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  const values = new Map(COMPAT_LIMITS.map((name, i) => [0x1000 + i, limits[name] ?? 16 + i]));
  const asked = [];
  return {
    ...enums,
    FRAGMENT_SHADER: 0x8b30,
    HIGH_FLOAT: 0x8df2,
    HIGH_INT: 0x8df5,
    RENDERER: 0x1f01,
    VERSION: 0x1f02,
    SHADING_LANGUAGE_VERSION: 0x8b8c,
    asked,
    lost: false,
    getExtension(name) {
      asked.push(name);
      if (name === 'WEBGL_lose_context') return { loseContext: () => (this.lost = true) };
      return extensions.includes(name) ? {} : null;
    },
    getParameter(p) {
      if (p === 0x1f01) return 'Stand-in renderer';
      if (p === 0x1f02) return 'WebGL 2.0';
      if (p === 0x8b8c) return 'WebGL GLSL ES 3.00';
      return values.get(p) ?? null;
    },
    getShaderPrecisionFormat(_shader, type) {
      if (!highp) return { precision: 0, rangeMin: 0, rangeMax: 0 };
      return type === 0x8df2
        ? { precision: 23, rangeMin: 127, rangeMax: 127 }
        : { precision: 0, rangeMin: 31, rangeMax: 30 };
    },
  };
}

test('full tier needs EXT_color_buffer_float and highp fragment shaders', () => {
  const caps = webgl2Capabilities(fakeContext({ extensions: ['EXT_color_buffer_float', 'EXT_clip_control'] }));
  assert.equal(caps.tier, 'full');
  assert.equal(caps.supported, true);
  assert.deepEqual(caps.missing, []);
  assert.equal(caps.extensions.EXT_clip_control, true);
  assert.equal(caps.extensions.OES_draw_buffers_indexed, false);
  assert.equal(caps.renderer, 'Stand-in renderer');
  assert.deepEqual(REQUIRED_EXTENSIONS, ['EXT_color_buffer_float']);
});

test('half-float and ldr tiers are below the minimum and say what is missing', () => {
  const half = webgl2Capabilities(fakeContext({ extensions: ['EXT_color_buffer_half_float'] }));
  assert.equal(half.tier, 'half-float');
  assert.equal(half.supported, false);
  assert.deepEqual(half.missing, ['EXT_color_buffer_float']);
  const ldr = webgl2Capabilities(fakeContext());
  assert.equal(ldr.tier, 'ldr');
  // Without highp the context is ldr even with float targets.
  const mediump = webgl2Capabilities(fakeContext({ extensions: ['EXT_color_buffer_float'], highp: false }));
  assert.equal(mediump.tier, 'ldr');
  assert.deepEqual(mediump.missing, ['highp-fragment']);
});

test('the reported highp int range is [-2^31, 2^31) as getShaderPrecisionFormat spells it (rangeMin 31, rangeMax 30)', () => {
  // Regression: the first version wanted rangeMax 31 and rated every real browser ldr.
  assert.equal(webgl2Capabilities(fakeContext({ extensions: ['EXT_color_buffer_float'] })).highpFragment, true);
});

test('every listed limit is read through its enum', () => {
  const caps = webgl2Capabilities(fakeContext({ limits: { MAX_TEXTURE_SIZE: 16384, MAX_DRAW_BUFFERS: 8 } }));
  assert.equal(caps.limits.MAX_TEXTURE_SIZE, 16384);
  assert.equal(caps.limits.MAX_DRAW_BUFFERS, 8);
  assert.deepEqual(Object.keys(caps.limits), [...COMPAT_LIMITS]);
  assert.deepEqual(Object.keys(caps.extensions), [...COMPAT_EXTENSIONS]);
});

test('a non-context argument is a TypeError that names the fix', () => {
  assert.throws(
    () => webgl2Capabilities({}),
    (e) => e instanceof TypeError && /getContext\("webgl2"\)/.test(e.message),
  );
  assert.throws(() => webgl2Capabilities(null), TypeError);
});

test('probeWebGL2 asks for antialias: false, reads the context and loses it', () => {
  const gl = fakeContext({ extensions: ['EXT_color_buffer_float'] });
  let attributes;
  const caps = probeWebGL2({ canvas: { getContext: (_type, a) => ((attributes = a), gl) } });
  assert.equal(caps.tier, 'full');
  assert.equal(attributes.antialias, false);
  assert.equal(gl.lost, true);
});

test('probeWebGL2 resolves null without WebGL2, and names the fix outside a browser', () => {
  assert.equal(probeWebGL2({ canvas: { getContext: () => null } }), null);
  if (typeof OffscreenCanvas !== 'function' && typeof document !== 'object')
    assert.throws(
      () => probeWebGL2(),
      (e) => e instanceof TypeError && /pass \{canvas\}/.test(e.message),
    );
});
