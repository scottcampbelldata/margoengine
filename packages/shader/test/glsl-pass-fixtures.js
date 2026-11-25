// Full-screen GLSL programs for test/glsl-pass-check.mjs: each runs as a ShaderPass in a PostStack and as GLSL in the
// browser's own WebGL over the same input image (the oracle). Original programs in the three web conventions'
// spellings (docs/porting-glsl.md): `tDiffuse` and `vUv`, `textureSampler` and `vUV`, `uColorBuffer` and `vUv0`.
export const passFixtures = [
  {
    name: 'tDiffuse and vUv with the supplied vertex stage, a live uniform',
    fragment: `uniform sampler2D tDiffuse;
uniform float amount;
varying vec2 vUv;
void main() { vec4 c = texture2D(tDiffuse, vUv); gl_FragColor = vec4(mix(c.rgb, 1.0 - c.rgb, amount) * vec3(vUv, 1.0), 1.0); }`,
    uniforms: { amount: ['float', 0.25, 0.75] },
  },
  {
    name: 'its own vertex stage with projectionMatrix and modelViewMatrix',
    vertex: `varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragment: `precision highp float;
uniform sampler2D tDiffuse;
uniform vec3 tint;
varying vec2 vUv;
void main() { vec4 c = texture2D(tDiffuse, vec2(1.0 - vUv.x, vUv.y)); gl_FragColor = vec4(c.bgr * tint, 1.0); }`,
    uniforms: { tint: ['vec3', [1, 0.5, 0.25], [0.25, 1, 0.5]] },
    oracle: {
      vertex:
        'uniform mat4 projectionMatrix;\nuniform mat4 modelViewMatrix;\nattribute vec3 position;\nattribute vec2 uv;\n',
    },
    identity: ['projectionMatrix', 'modelViewMatrix'],
  },
  {
    name: 'GLSL ES 3.00 with textureSampler and vUV',
    fragment: `#version 300 es
precision highp float;
uniform sampler2D textureSampler;
uniform vec2 offset;
in vec2 vUV;
out vec4 color;
void main() { vec4 c = texture(textureSampler, vUV); color = vec4(fract(c.rgb * 2.0 + vec3(offset, 0.5)), 1.0); }`,
    uniforms: { offset: ['vec2', [0.125, 0.375], [0.5, 0.25]] },
  },
  {
    name: 'uColorBuffer and vUv0 with a vec2 position attribute',
    vertex: `attribute vec2 aPosition;
varying vec2 vUv0;
void main() { vUv0 = aPosition * 0.5 + 0.5; gl_Position = vec4(aPosition, 0.0, 1.0); }`,
    fragment: `precision highp float;
uniform sampler2D uColorBuffer;
uniform float gain;
varying vec2 vUv0;
void main() { gl_FragColor = vec4(texture2D(uColorBuffer, vUv0).rgb * gain, 1.0); }`,
    attributes: { aPosition: 'position' },
    uniforms: { gain: ['float', 0.5, 1.25] },
  },
  {
    name: 'a pass-through returns its input',
    fragment: `uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`,
    uniforms: {},
  },
  {
    name: 'gl_FragCoord with no input',
    fragment: `precision highp float;
uniform float shift;
void main() { gl_FragColor = vec4(gl_FragCoord.xy / 32.0, shift, 1.0); }`,
    uniforms: { shift: ['float', 0.25, 0.5] },
  },
];
// The first stage of every check: an image with a different value at each pixel, so a flipped or shifted lookup shows,
// and no value on a wrap or a rounding edge.
export const passGenerator = {
  fragment: `precision highp float;
void main() { vec2 p = gl_FragCoord.xy; gl_FragColor = vec4(p.x / 32.0, p.y / 48.0 + p.x / 128.0, 1.0 - (p.x + p.y) / 64.0, 1.0); }`,
};
