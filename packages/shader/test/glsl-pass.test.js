import test from 'node:test';
import assert from 'node:assert/strict';
import { ShaderPass, fullscreenVertex } from '../dist/glsl-pass.js';
import { passFixtures, passGenerator } from './glsl-pass-fixtures.js';
import { checkWGSL } from '../../webgl2-compat/dist/wgsl.js';

test('a pass without a vertex stage gets the full-screen triangle with the coordinate varyings its fragment reads', () => {
  assert.equal(
    fullscreenVertex('uniform sampler2D tDiffuse;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = texture2D(tDiffuse, vUv); }'),
    'attribute vec3 position;\nattribute vec2 uv;\nvarying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }\n',
  );
  assert.equal(
    fullscreenVertex('#version 300 es\nprecision highp float;\nin highp vec2 vUV;\nout vec4 c;\nvoid main() { c = vec4(vUV, 0.0, 1.0); }'),
    '#version 300 es\nin vec3 position;\nin vec2 uv;\nout vec2 vUV;\nvoid main() { vUV = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }\n',
  );
  assert.match(fullscreenVertex('void main() { gl_FragColor = vec4(1.0); }', 300), /^#version 300 es\nin vec3 position;\nin vec2 uv;\nvoid main\(\) \{ gl_Position/);
});

test('the input sampler is found by each convention name, named, or none', () => {
  const frag = (name, uv = 'vUv') => `uniform sampler2D ${name};\nvarying vec2 ${uv};\nvoid main() { gl_FragColor = texture2D(${name}, ${uv}); }`;
  assert.equal(new ShaderPass({ fragmentShader: frag('tDiffuse') }).input, 'tDiffuse');
  assert.equal(new ShaderPass({ fragmentShader: frag('textureSampler', 'vUV') }).input, 'textureSampler');
  assert.equal(new ShaderPass({ fragmentShader: frag('uColorBuffer', 'vUv0') }).input, 'uColorBuffer');
  assert.equal(new ShaderPass({ fragmentShader: frag('scene') }, { input: 'scene' }).input, 'scene');
  assert.equal(new ShaderPass({ fragmentShader: passGenerator.fragment }).input, null);
  assert.throws(() => new ShaderPass({ fragmentShader: passGenerator.fragment }, { input: 'tDiffuse' }), { code: 'failed' });
  assert.throws(() => new ShaderPass({}), TypeError);
  assert.throws(() => new ShaderPass({ fragmentShader: frag('tDiffuse') }, { kind: 'display' }), TypeError);
});

test('every fixture translates to WGSL the layer accepts, and its uniforms stay live', () => {
  for (const f of [...passFixtures, passGenerator]) {
    const uniforms = Object.fromEntries(Object.entries(f.uniforms ?? {}).map(([k, [, v]]) => [k, { value: v }]));
    const pass = new ShaderPass({ vertexShader: f.vertex, fragmentShader: f.fragment, uniforms }, { attributes: f.attributes });
    for (const stage of ['vertex', 'fragment']) {
      const code = pass.material.code(stage, pass['mesh']);
      assert.doesNotThrow(() => checkWGSL(code), `${f.name ?? 'generator'} ${stage}`);
    }
    for (const k of Object.keys(uniforms)) assert.equal(pass.uniforms[k], uniforms[k], 'the given {value} object is the live one');
    pass.dispose();
  }
});

test('an ldr pass writes display colour as returned, an hdr pass linear light through the display transform', () => {
  const fragmentShader = 'uniform sampler2D tDiffuse;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = texture2D(tDiffuse, vUv); }';
  const ldr = new ShaderPass({ fragmentShader }),
    hdr = new ShaderPass({ fragmentShader }, { kind: 'hdr' });
  assert.equal(ldr.kind, 'ldr');
  assert.match(hdr.material.code('fragment'), /margoDisplay\(/);
  assert.doesNotMatch(ldr.material.code('fragment').split('@fragment')[1], /margoDisplay\(/);
  assert.equal(ldr.material.blending, 'none', 'a pass replaces its output');
  assert.equal(ldr.material.side, 'double');
});

test('a ShaderPass runs only inside a PostStack, once, and not after dispose', () => {
  const pass = new ShaderPass({ fragmentShader: passGenerator.fragment });
  assert.throws(() => pass.setup({ gpu: {} }), { code: 'state' });
  const stage = pass['joinStack']({});
  assert.equal(stage.kind, 'ldr');
  assert.throws(() => pass['joinStack']({}), { code: 'attached' });
  pass.dispose();
  assert.throws(() => new ShaderPass({ fragmentShader: passGenerator.fragment })['joinStack'].call(pass, {}), { code: 'disposed' });
});
