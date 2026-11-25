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
function fakeContext({ extensions = [], highp = true, limits = {}, renderer = 'Stand-in renderer' } = {}) {
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
      if (p === 0x1f01) return renderer;
      if (p === 0x9246) return 'Unmasked GPU';
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

// Bug (bug sweep L3, Firefox reruns): asking for WEBGL_debug_renderer_info prints a deprecation warning in Firefox, whose
// RENDERER already names the GPU, so every Firefox page on the layer failed its no-warnings check. The layer asks for
// the extension only where RENDERER is masked.
test('the unmasked renderer is asked for only where RENDERER is masked', () => {
  const named = fakeContext({ extensions: ['WEBGL_debug_renderer_info'], renderer: 'ANGLE (NVIDIA RTX A6000)' });
  assert.equal(webgl2Capabilities(named).renderer, 'ANGLE (NVIDIA RTX A6000)');
  assert.equal(named.asked.includes('WEBGL_debug_renderer_info'), false);
  const masked = fakeContext({ extensions: ['WEBGL_debug_renderer_info'], renderer: 'WebKit WebGL' });
  assert.equal(webgl2Capabilities(masked).renderer, 'Unmasked GPU');
  assert.equal(webgl2Capabilities(fakeContext({ renderer: 'WebKit WebGL' })).renderer, 'WebKit WebGL');
});

/**
 * A stand-in that reports highp ints as Firefox on macOS does (24, 24) and draws the measurement shader: `words` are
 * what its readPixels returns, and every binding it is given is recorded so the test can check they are put back.
 */
function shortIntContext(words, { drawable = true } = {}) {
  const gl = fakeContext({ extensions: ['EXT_color_buffer_float'] }),
    base = gl.getShaderPrecisionFormat.bind(gl),
    state = new Map([
      [0x8ca6, 'user-draw-fb'],
      [0x8caa, 'user-read-fb'],
      [0x8b8d, 'user-program'],
      [0x85b5, 'user-vao'],
      [0x8069, 'user-texture'],
      [0x88ed, 'user-pack'],
      [0x0ba2, [1, 2, 3, 4]],
      [0x0c23, [true, false, true, false]],
    ]),
    enabled = new Set([0x0c11]),
    deleted = [];
  gl.getShaderPrecisionFormat = (shader, type) =>
    type === 0x8df5 ? { precision: 0, rangeMin: 24, rangeMax: 24 } : base(shader, type);
  if (!drawable) return gl;
  const param = gl.getParameter.bind(gl);
  let id = 0;
  const object = (kind) => () => `${kind}${++id}`;
  Object.assign(gl, {
    state,
    enabled,
    deleted,
    getParameter: (p) => (state.has(p) ? state.get(p) : param(p)),
    createShader: object('shader'),
    createProgram: object('program'),
    createTexture: object('texture'),
    createFramebuffer: object('framebuffer'),
    createVertexArray: object('vao'),
    shaderSource() {},
    compileShader() {},
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getUniformLocation: () => 'u',
    uniform4ui() {},
    texStorage2D() {},
    framebufferTexture2D() {},
    checkFramebufferStatus: () => 0x8cd5,
    drawArrays() {},
    readPixels: (_x, _y, _w, _h, _format, _type, out) => out.set(words),
    bindFramebuffer: (target, fb) => {
      if (target !== 0x8d40) state.set(target === 0x8ca9 ? 0x8ca6 : 0x8caa, fb);
    },
    useProgram: (p) => state.set(0x8b8d, p),
    bindVertexArray: (v) => state.set(0x85b5, v),
    bindTexture: (_t, tex) => state.set(0x8069, tex),
    bindBuffer: (_t, b) => state.set(0x88ed, b),
    viewport: (...v) => state.set(0x0ba2, v),
    colorMask: (...m) => state.set(0x0c23, m),
    isEnabled: (cap) => enabled.has(cap),
    enable: (cap) => enabled.add(cap),
    disable: (cap) => enabled.delete(cap),
    deleteShader: (o) => deleted.push(o),
    deleteProgram: (o) => deleted.push(o),
    deleteTexture: (o) => deleted.push(o),
    deleteFramebuffer: (o) => deleted.push(o),
    deleteVertexArray: (o) => deleted.push(o),
  });
  return gl;
}

test('a short highp int report (Firefox on macOS: 24, 24) is measured: exact 32-bit arithmetic reaches full tier', () => {
  // GLSL ES 3.00 4.1.3: highp ints are 32-bit two's complement and wrap. The probe's words for its inputs
  // (0x9e3779b9, 0x80000001, 16, 7), worked in JS with Math.imul and >>> 0.
  const gl = shortIntContext([3238976083, 2654463870, 2147483651, 766958446]),
    before = new Map(gl.state),
    caps = webgl2Capabilities(gl);
  assert.equal(caps.highpFragment, true);
  assert.equal(caps.tier, 'full');
  assert.deepEqual(caps.missing, []);
  // The caller's context is left as it was: every binding and state put back, every probe object deleted.
  assert.deepEqual(new Map(gl.state), before);
  assert.deepEqual([...gl.enabled], [0x0c11]);
  assert.equal(gl.deleted.length, 6);
});

test('a short highp int report stays refused when the measurement is wrong or cannot run', () => {
  // 24-bit ints: the multiply's high byte lost.
  for (const words of [
    [3238976083 & 0xffffff, 2654463870, 2147483651, 766958446],
    [0, 0, 0, 0],
  ]) {
    const caps = webgl2Capabilities(shortIntContext(words));
    assert.equal(caps.highpFragment, false);
    assert.deepEqual(caps.missing, ['highp-fragment']);
  }
  assert.equal(webgl2Capabilities(shortIntContext([], { drawable: false })).highpFragment, false);
});
