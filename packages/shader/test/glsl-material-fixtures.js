// Whole GLSL programs for ShaderMaterial, each drawn by the browser's own WebGL compiler (WebGL 1 for GLSL ES 1.00,
// WebGL 2 for 3.00: the oracle) and by ShaderMaterial on WebGPU and on the WebGL2 layer, in test/glsl-material-check.mjs.
// Every edge lies on a pixel boundary of the 32 x 32 target (MSAA off), so coverage is equal by rule. They hold no
// undefined behaviour (Lecoeur, Mohsin and Donaldson, PLDI 2023): no division by zero, no value that turns at a pixel
// centre (nearest texels and depth crossings sit between centres), highp throughout, flat values constant per
// primitive (GL takes the last vertex, WebGPU the first). The CPU test pins each program's WGSL.
const quad = (x0 = -1, y0 = -1, x1 = 1, y1 = 1, z = [0, 0, 0, 0]) => ({
  position: [x0, y0, z[0], x1, y0, z[1], x1, y1, z[2], x0, y1, z[3]],
  index: [0, 1, 2, 0, 2, 3],
});
const flat2 = (q) => q.position.filter((_, i) => i % 3 !== 2);
const full = quad();
const uvOf = (p) => p.map((v) => v * 0.5 + 0.5);
// Two quads in one mesh: the left half wound counter-clockwise (front), the right half clockwise (back).
const left = flat2(quad(-1, -1, 0, 1)),
  right = flat2(quad(0, -1, 1, 1));
const rightCW = [right[0], right[1], right[6], right[7], right[4], right[5], right[2], right[3]];

export const programFixtures = [
  {
    name: 'ES 3.00 uniforms of every scalar, vector and matrix type',
    vertex: `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
uniform mat4 lift;
void main() { vUv = uv; gl_Position = lift * vec4(position, 0.0, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 color;
uniform float f; uniform vec2 f2; uniform vec3 f3; uniform vec4 f4;
uniform int i; uniform ivec2 i2; uniform uint u; uniform uvec3 u3;
uniform bool b; uniform bvec2 b2; uniform mat2 m2; uniform mat3 m3;
void main() {
  vec2 p = m2 * vUv;
  vec3 q = m3 * vec3(vUv, 1.0);
  float r = f * p.x + f2.x * float(i) / 8.0 + (b ? 0.125 : 0.0);
  float g = f3.y * q.y + float(i2.y) / 16.0 + (b2.y ? 0.0625 : 0.0) + f4.w * 0.25;
  float bl = float(u) / 8.0 + float(u3.z) / 32.0 + f2.y * q.z * 0.25 + f4.x * vUv.x;
  color = vec4(clamp(vec3(r, g, bl), 0.0, 1.0), 1.0);
}`,
    attributes: { position: { size: 2, data: flat2(full) }, uv: { size: 2, data: uvOf(flat2(full)) } },
    index: full.index,
    uniforms: {
      lift: ['mat4', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.25, 1]],
      f: ['float', 0.5, 0.75],
      f2: ['vec2', [0.25, 0.5], [0.5, 1]],
      f3: ['vec3', [0, 0.5, 0], [0, 0.25, 0]],
      f4: ['vec4', [0.25, 0, 0, 0.5], [0.5, 0, 0, 1]],
      i: ['int', 2, 3],
      i2: ['ivec2', [0, 3], [0, 5]],
      u: ['uint', 1, 2],
      u3: ['uvec3', [0, 0, 4], [0, 0, 8]],
      b: ['bool', true, false],
      b2: ['bvec2', [false, true], [true, false]],
      m2: ['mat2', [0.5, 0.25, 0, 1], [1, 0, 0.5, 0.5]],
      m3: ['mat3', [1, 0, 0, 0, 0.5, 0, 0.25, 0.125, 1], [0.5, 0, 0, 0.25, 1, 0, 0, 0, 0.5]],
    },
  },
  {
    name: 'ES 1.00 attributes, varyings, texture2D, gl_FragColor and a perspective w',
    vertex: `attribute vec2 position;
attribute vec2 uv;
attribute float w;
varying vec2 vUv;
varying float vShade;
uniform float t;
void main() { vUv = uv; vShade = uv.x * uv.y + t; gl_Position = vec4(position * w, 0.0, w); }`,
    fragment: `precision highp float;
varying vec2 vUv;
varying float vShade;
uniform sampler2D map;
uniform vec3 tint;
void main() {
  vec4 c = texture2D(map, vUv);
  gl_FragColor = vec4(mix(c.rgb, tint, 0.25) * 0.75 + vec3(vShade * 0.25), 1.0);
}`,
    attributes: { position: { size: 2, data: flat2(full) }, uv: { size: 2, data: uvOf(flat2(full)) }, w: { size: 1, data: [1, 2, 4, 1.5] } },
    index: full.index,
    uniforms: { t: ['float', 0.25, 0.5], tint: ['vec3', [1, 0.5, 0], [0, 0.25, 1]] },
    texture: { name: 'map', filter: 'linear' },
    flipY: true,
  },
  {
    name: 'gl_FragCoord, gl_FrontFacing, dFdx and dFdy on both faces',
    vertex: `#version 300 es
in vec2 position;
out vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 color;
void main() {
  vec2 c = fract(gl_FragCoord.xy / 8.0);
  vec2 d = vec2(dFdx(vUv.x), dFdy(vUv.y)) * 16.0;
  color = vec4(c.x * 0.5 + d.x * 0.5, c.y * 0.5 + d.y * 0.5, gl_FrontFacing ? 1.0 : 0.25 + gl_FragCoord.w * 0.25, 1.0);
}`,
    attributes: { position: { size: 2, data: [...left, ...rightCW] } },
    index: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
    uniforms: {},
    cull: 'none',
  },
  {
    name: 'depth: gl_FragCoord.z, gl_FragDepth and the depth test with a flat varying',
    vertex: `#version 300 es
in vec3 position;
in float layer;
out vec2 vUv;
flat out int vLayer;
void main() { vUv = position.xy * 0.5 + 0.5; vLayer = int(layer); gl_Position = vec4(position, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
flat in int vLayer;
out vec4 color;
void main() {
  if (vLayer == 0) {
    gl_FragDepth = vUv.y * 0.75 + 0.1;
    color = vec4(gl_FragCoord.z, 0.0, 1.0, 1.0);
  } else {
    gl_FragDepth = gl_FragCoord.z;
    color = vec4(0.0, gl_FragCoord.z, 0.25, 1.0);
  }
}`,
    attributes: {
      position: { size: 3, data: [...quad(-1, -1, 1, 1, [-0.5, 0.5, 0.5, -0.5]).position, ...quad().position] },
      layer: { size: 1, data: [0, 0, 0, 0, 1, 1, 1, 1] },
    },
    index: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
    uniforms: {},
    depth: true,
  },
  {
    name: 'discard and defines',
    vertex: `#version 300 es
in vec2 position;
out vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 color;
void main() {
#ifdef CHECKER
  if (mod(floor(gl_FragCoord.x / 4.0) + floor(gl_FragCoord.y / 4.0), 2.0) > 0.5) discard;
#endif
#if LEVEL > 1
  color = vec4(vUv, 0.75, 1.0);
#else
  color = vec4(vUv.yx, 0.25, 1.0);
#endif
}`,
    attributes: { position: { size: 2, data: flat2(full) } },
    index: full.index,
    uniforms: {},
    defines: [{ CHECKER: true, LEVEL: 2 }, { LEVEL: 1 }],
  },
  {
    name: 'a vertex-stage lookup and a uniform both stages share',
    vertex: `#version 300 es
in vec2 position;
out vec3 vColor;
out vec2 vUv;
uniform sampler2D map;
uniform float gain;
void main() {
  vUv = position * 0.5 + 0.5;
  vColor = textureLod(map, vec2(0.3, 0.6), 0.0).rgb * gain;
  gl_Position = vec4(position, 0.0, 1.0);
}`,
    fragment: `#version 300 es
precision highp float;
in vec3 vColor;
in vec2 vUv;
uniform sampler2D map;
uniform float gain;
out vec4 color;
void main() { color = vec4(texture(map, vUv).rgb * 0.5 + vColor * 0.5 * gain, 1.0); }`,
    attributes: { position: { size: 2, data: flat2(full) } },
    index: full.index,
    uniforms: { gain: ['float', 1, 0.5] },
    texture: { name: 'map', filter: 'nearest' },
    flipY: false,
  },
  {
    name: 'ES 3.00 attribute widths and absent attributes',
    vertex: `#version 300 es
in vec4 position;
in vec3 normal;
in vec4 extra;
out vec4 v;
void main() { v = vec4(normal + vec3(0.25), extra.w * 0.5) + vec4(position.zw, 0.0, 0.0); gl_Position = position; }`,
    fragment: `#version 300 es
precision highp float;
in vec4 v;
out vec4 color;
void main() { color = vec4(v.rgb, 1.0) * vec4(1.0, 1.0, v.a * 2.0, 1.0); }`,
    attributes: { position: { size: 2, data: flat2(full) } },
    index: full.index,
    uniforms: {},
  },
  {
    name: 'ES 1.00 gl_FragData, mat3 and int uniforms, a loop and a helper taking a sampler',
    vertex: `attribute vec2 position;
varying vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`,
    fragment: `precision highp float;
varying vec2 vUv;
uniform sampler2D map;
uniform mat3 basis;
uniform int steps;
vec4 tap(sampler2D s, vec2 p) { return texture2D(s, p); }
void main() {
  vec3 q = basis * vec3(vUv, 1.0);
  float acc = 0.0;
  for (int k = 0; k < 4; k++) { if (k >= steps) break; acc += 0.125; }
  gl_FragData[0] = vec4(tap(map, vUv).rg * 0.5 + q.xy * 0.25, acc, 1.0);
}`,
    attributes: { position: { size: 2, data: flat2(full) } },
    index: full.index,
    uniforms: { basis: ['mat3', [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 0, 1, 0, 0, 0.5, 0.25, 1]], steps: ['int', 2, 4] },
    texture: { name: 'map', filter: 'nearest' },
    flipY: true,
  },
];

/** An 8 x 8 RGBA image, rows from the first in memory: smooth ramps with a step per texel. */
export function programImage() {
  const bytes = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) bytes.set([x * 32 + 8, y * 32 + 16, ((x + y) % 4) * 64 + 24, 255], (y * 8 + x) * 4);
  return bytes;
}
