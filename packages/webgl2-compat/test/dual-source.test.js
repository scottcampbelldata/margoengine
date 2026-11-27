// Dual-source blending on the WebGL2 layer: WebGPU's 'dual-source-blending' feature where the context has
// WEBGL_blend_func_extended, @blend_src(1) emitted as draw buffer 0's second output (index 1, EXT_blend_func_extended)
// and WebGPU's validation without the feature. The draw itself is compared against native WebGPU in a browser
// (dual-source-browser.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_LIMITS } from '../dist/index.js';
import { createCompatGPU } from '../dist/device.js';
import { checkWGSL } from '../dist/wgsl.js';
import { translateWGSL } from '../dist/glsl.js';

const V =
  '@vertex fn v(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i), 0.0, 0.0, 1.0); }';
const DUAL = `enable dual_source_blending;
${V}
struct O { @location(0) @blend_src(0) c: vec4f, @location(0) @blend_src(1) t: vec4f }
@fragment fn f() -> O { return O(vec4f(0.25, 0.5, 0.75, 1.0), vec4f(0.5, 0.25, 1.0, 0.0)); }`;

function fakeContext(extensions) {
  const enums = Object.fromEntries(COMPAT_LIMITS.map((name, i) => [name, 0x1000 + i]));
  return {
    ...enums,
    FRAGMENT_SHADER: 0x8b30,
    HIGH_FLOAT: 0x8df2,
    HIGH_INT: 0x8df5,
    RENDERER: 0x1f01,
    VERSION: 0x1f02,
    SHADING_LANGUAGE_VERSION: 0x8b8c,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    checkFramebufferStatus: () => 0x8cd5,
    isContextLost: () => false,
    getExtension: (name) =>
      name === 'WEBGL_lose_context' ? { loseContext() {} } : extensions.includes(name) ? {} : null,
    getParameter: (p) => (p === 0x1f01 ? 'Stand-in renderer' : 4096),
    getShaderPrecisionFormat: (_s, type) =>
      type === 0x8df2 ? { precision: 23, rangeMin: 127, rangeMax: 127 } : { precision: 0, rangeMin: 31, rangeMax: 30 },
  };
}

test('dual-source-blending is a feature only where WEBGL_blend_func_extended backs it', async () => {
  const plain = await createCompatGPU({
    createContext: () => fakeContext(['EXT_color_buffer_float']),
  }).requestAdapter();
  assert.ok(!plain.features.has('dual-source-blending'));
  await assert.rejects(plain.requestDevice({ requiredFeatures: ['dual-source-blending'] }), TypeError);
  const rich = await createCompatGPU({
    createContext: () => fakeContext(['EXT_color_buffer_float', 'WEBGL_blend_func_extended']),
  }).requestAdapter();
  assert.ok(rich.features.has('dual-source-blending'));
});

test('@blend_src(1) is index 1 of draw buffer 0, behind EXT_blend_func_extended', () => {
  const f = translateWGSL({ vertex: { source: DUAL }, fragment: { source: DUAL } }).fragment;
  assert.match(f.source, /^#version 300 es\n#extension GL_EXT_blend_func_extended : require\n/);
  assert.match(f.source, /layout\(location = 0, index = 0\) out vec4 _o0;/);
  assert.match(f.source, /layout\(location = 0, index = 1\) out vec4 _o0s;/);
  assert.match(f.source, /_o0s = /);
  // The second source is no draw buffer: one output location for the targets.
  assert.deepEqual(
    f.outputs.map((o) => o.location),
    [0],
  );
  // A module with no @blend_src keeps the plain header.
  const plain = translateWGSL({
    vertex: { source: V },
    fragment: { source: `${V}\n@fragment fn f() -> @location(0) vec4f { return vec4f(1.0); }` },
  }).fragment;
  assert.doesNotMatch(plain.source, /#extension/);
});

test("@blend_src needs 'enable dual_source_blending;' (WGSL 12.3.1)", () => {
  assert.throws(
    () => checkWGSL(DUAL.replace('enable dual_source_blending;', '')),
    (e) => e.code === 'type' && /enable dual_source_blending/.test(e.message),
  );
});

test('without the feature the shader module and a src1 blend factor are validation errors, as on WebGPU', async () => {
  // A context that answers every call (the device sets GL state as it starts), with the enums the pipelines name.
  const context = fakeContext(['EXT_color_buffer_float', 'WEBGL_blend_func_extended']);
  ['DITHER', 'SCISSOR_TEST', 'CULL_FACE', 'TRIANGLES', 'CW', 'FRONT', 'BACK', 'ONE', 'ZERO', 'FUNC_ADD'].forEach(
    (name, i) => (context[name] = i + 1),
  );
  const gl = new Proxy(context, { get: (target, key) => (key in target ? target[key] : () => ({})) });
  const adapter = await createCompatGPU({ createContext: () => gl }).requestAdapter();
  const device = await adapter.requestDevice();
  try {
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code: DUAL });
    const shaderError = await device.popErrorScope();
    assert.match(shaderError?.message ?? '', /needs the device feature 'dual-source-blending'/);
    assert.ok(module.error);
    for (const blend of [
      { color: { srcFactor: 'one', dstFactor: 'src1' }, alpha: {} },
      { color: {}, alpha: { srcFactor: 'one-minus-src1-alpha', dstFactor: 'zero' } },
    ]) {
      device.pushErrorScope('validation');
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: {} },
        fragment: { module: {}, targets: [{ format: 'rgba8unorm', blend }] },
      });
      const error = await device.popErrorScope();
      assert.match(error?.message ?? '', /src1 blend factor needs the device feature 'dual-source-blending'/);
    }
  } finally {
    device.destroy();
  }
});
