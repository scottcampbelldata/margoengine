// Programs that read the engine's values under each convention's names (builtins), built with shaderMesh, for
// test/glsl-material-check.mjs. The oracle (the browser's own WebGL compile) declares those names itself, as the
// convention's documentation says its renderer does, and is given the same matrices computed here in double precision
// from the same camera: view from the look-at basis, GL's perspective projection, normal matrices as inverse
// transposes. A quad larger than the view fills every pixel, so no edge decides a pixel; the instanced and the
// full-screen programs keep their edges on pixel boundaries (MSAA off). No undefined behaviour (Lecoeur 2023).
const camera = { position: [0.4, 0.3, 3], target: [0, 0, 0], fov: 60, near: 0.5, far: 20 };
// A 10 x 10 quad around the origin, facing +z, with normals and uvs.
const big = {
  positions: [-5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
// Column-major: a turn of a about y, then a move of (tx, ty, tz).
const turn = (a, tx = 0, ty = 0, tz = 0) => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, tx, ty, tz, 1];
const oracleOf = (g, map) => Object.fromEntries(Object.entries(map).map(([name, [stream, size]]) => [name, { size, data: g[stream] }]));
const prefix = {
  vertex:
    'uniform mat4 modelMatrix;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\nuniform mat4 viewMatrix;\nuniform mat3 normalMatrix;\nuniform vec3 cameraPosition;\nuniform bool isOrthographic;\n',
  fragment: 'precision highp float;\nuniform mat4 viewMatrix;\nuniform vec3 cameraPosition;\nuniform bool isOrthographic;\n',
};
// The display transform the built-in chunks and outputColorSpace 'linear' stand for, written out in GLSL for the
// oracle: Khronos PBR Neutral (2024) then the sRGB encoding (IEC 61966-2-1).
const display = `vec3 oracleNeutral(vec3 c) {
  float x = min(c.r, min(c.g, c.b));
  c -= x < 0.08 ? x - 6.25 * x * x : 0.04;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < 0.76) return c;
  float d = 0.24;
  float newPeak = 1.0 - d * d / (peak + d - 0.76);
  c *= newPeak / peak;
  float g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
  return mix(c, vec3(newPeak), g);
}
vec3 oracleSRGB(vec3 x) {
  return mix(x * 12.92, 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), x));
}
`;
const screen = { positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], uvs: [0, 0, 1, 0, 1, 1, 0, 1], indices: [0, 1, 2, 0, 2, 3] };

export const builtinFixtures = [
  {
    name: "'modelViewMatrix', GLSL ES 1.00, undeclared names, a model matrix and the default colour",
    vertex: `varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
varying vec3 vWorld;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vUv = uv;
  vColor = color;
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragment: `precision highp float;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
varying vec3 vWorld;
uniform float gain;
void main() {
  vec3 toEye = normalize(cameraPosition - vWorld);
  vec3 seen = (viewMatrix * vec4(toEye, 0.0)).xyz;
  gl_FragColor = vec4(gain * (vColor * 0.25 + vec3(vUv, 0.0) * 0.5 + abs(vNormal) * 0.125 + abs(seen) * (isOrthographic ? 0.0 : 0.125)), 1.0);
}`,
    oracle: { vertex: prefix.vertex + 'attribute vec3 position;\nattribute vec3 normal;\nattribute vec2 uv;\nattribute vec3 color;\n', fragment: prefix.fragment },
    camera,
    matrix: turn(0.35, 0.1, -0.05, -0.5),
    geometry: big,
    attributes: oracleOf(big, { position: ['positions', 3], normal: ['normals', 3], uv: ['uvs', 2] }),
    generic: { color: [1, 1, 1] },
    engine: ['modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix', 'normalMatrix', 'cameraPosition', 'isOrthographic'],
    index: big.indices,
    uniforms: { gain: ['float', 1, 0.75] },
  },
  {
    name: "'worldViewProjection', GLSL ES 3.00, declared names, uv2 and a vec4 colour",
    vertex: `#version 300 es
in vec3 position;
in vec2 uv2;
in vec4 color;
uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;
uniform mat4 worldView;
uniform mat4 worldViewProjection;
out vec2 vUv;
out vec4 vColor;
out float vDepth;
void main() {
  vUv = uv2;
  vColor = color;
  vDepth = -(worldView * vec4(position, 1.0)).z;
  vec4 a = worldViewProjection * vec4(position, 1.0);
  vec4 b = projection * view * world * vec4(position, 1.0);
  gl_Position = mix(a, b, 0.5);
}`,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in float vDepth;
uniform float gain;
out vec4 outColor;
void main() { outColor = vec4(gain * (vColor.rgb * 0.5 + vec3(vUv, fract(vDepth)) * 0.5), 1.0); }`,
    camera,
    matrix: turn(-0.3, 0, 0.1, -1),
    geometry: { ...big, uvs1: big.uvs.map((v) => 1 - v), colors: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1] },
    attributes: {
      position: { size: 3, data: big.positions },
      uv2: { size: 2, data: big.uvs.map((v) => 1 - v) },
      color: { size: 4, data: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1] },
    },
    engine: ['world', 'view', 'projection', 'worldView', 'worldViewProjection'],
    index: big.indices,
    uniforms: { gain: ['float', 1, 0.5] },
  },
  {
    name: "'matrix_model', GLSL ES 3.00, camera and screen values, and an attribute map",
    vertex: `#version 300 es
in vec3 vertex_position;
in vec3 vertex_normal;
in vec2 aUv0;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform mat3 matrix_normal;
uniform mat4 matrix_viewInverse;
uniform mat3 matrix_view3;
out vec2 vUv;
out vec3 vNormal;
out vec3 vEye;
void main() {
  vUv = aUv0;
  vNormal = matrix_view3 * normalize(matrix_normal * vertex_normal);
  vEye = matrix_viewInverse[3].xyz - (matrix_model * vec4(vertex_position, 1.0)).xyz;
  gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
}`,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vNormal;
in vec3 vEye;
uniform vec3 view_position;
uniform vec4 camera_params;
uniform vec4 screen_size;
uniform mat4 matrix_projection;
uniform float gain;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy * screen_size.zw;
  float s = camera_params.x * 10.0 + camera_params.y / 40.0 + camera_params.z * 0.25 + camera_params.w + matrix_projection[1][1] * 0.1;
  outColor = vec4(gain * vec3(p.x * 0.5 + vUv.x * 0.25, abs(vNormal.z) * 0.5 + p.y * 0.25, length(vEye - view_position) * 0.05 + s * 0.1), 1.0);
}`,
    options: { attributes: { aUv0: 'uv' } },
    camera,
    matrix: turn(0.2, 0, 0, -0.25),
    geometry: big,
    attributes: oracleOf(big, { vertex_position: ['positions', 3], vertex_normal: ['normals', 3], aUv0: ['uvs', 2] }),
    engine: ['matrix_model', 'matrix_viewProjection', 'matrix_normal', 'matrix_viewInverse', 'matrix_view3', 'view_position', 'camera_params', 'screen_size', 'matrix_projection'],
    index: big.indices,
    uniforms: { gain: ['float', 1, 0.5] },
  },
  {
    name: 'instancing: instanceMatrix and instanceColor over four instances, GLSL ES 3.00 undeclared names',
    vertex: `#version 300 es
out vec3 vColor;
out vec2 vUv;
void main() {
  vColor = instanceColor;
  vUv = uv;
  gl_Position = instanceMatrix * vec4(position, 1.0);
}`,
    fragment: `#version 300 es
precision highp float;
in vec3 vColor;
in vec2 vUv;
uniform float gain;
out vec4 outColor;
void main() { outColor = vec4(gain * (vColor * 0.75 + vec3(vUv, 0.0) * 0.25), 1.0); }`,
    oracle: { vertex: '#version 300 es\nin vec3 position;\nin vec2 uv;\nin mat4 instanceMatrix;\nin vec3 instanceColor;\n' },
    geometry: screen,
    instances: {
      instanceMatrix: [-0.5, -0.5, 0.5, 0.5].flatMap((x, i) => [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, x, i % 2 ? 0.5 : -0.5, 0, 1]),
      instanceColor: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0],
    },
    attributes: oracleOf(screen, { position: ['positions', 3], uv: ['uvs', 2] }),
    instanced: 4,
    index: screen.indices,
    uniforms: { gain: ['float', 1, 0.5] },
  },
  {
    name: 'includes: a caller include, tonemapping_fragment and colorspace_fragment',
    vertex: `attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
    fragment: `precision highp float;
#include <ramp>
varying vec2 vUv;
uniform float exposure;
void main() {
  gl_FragColor = vec4(ramp(vUv) * exposure, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    oracle: {
      replace: [
        ['#include <ramp>', 'vec3 ramp(vec2 p) { return vec3(p.x * 2.0, p.y * 1.5, (1.0 - p.x) * 0.25); }\n' + display],
        ['#include <tonemapping_fragment>', 'gl_FragColor.rgb = oracleNeutral(max(gl_FragColor.rgb, vec3(0.0)));'],
        ['#include <colorspace_fragment>', 'gl_FragColor.rgb = oracleSRGB(max(gl_FragColor.rgb, vec3(0.0)));'],
      ],
    },
    options: { builtins: false, includes: { ramp: 'vec3 ramp(vec2 p) { return vec3(p.x * 2.0, p.y * 1.5, (1.0 - p.x) * 0.25); }' } },
    geometry: screen,
    attributes: oracleOf(screen, { position: ['positions', 3], uv: ['uvs', 2] }),
    index: screen.indices,
    uniforms: { exposure: ['float', 1, 0.6] },
  },
  {
    name: "outputColorSpace 'linear': linear light through the display transform",
    vertex: `#version 300 es
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
in vec2 vUv;
uniform float exposure;
out vec4 outColor;
void main() { outColor = vec4(vec3(vUv.x * 1.8, vUv.y * 0.9, 0.05) * exposure, 1.0); }`,
    oracle: {
      replace: [
        ['out vec4 outColor;', 'out vec4 outColor;\n' + display],
        ['* exposure, 1.0); }', '* exposure, 1.0); outColor.rgb = oracleSRGB(oracleNeutral(max(outColor.rgb, vec3(0.0)))); }'],
      ],
    },
    options: { builtins: false, outputColorSpace: 'linear' },
    geometry: screen,
    attributes: oracleOf(screen, { position: ['positions', 3], uv: ['uvs', 2] }),
    index: screen.indices,
    uniforms: { exposure: ['float', 1, 2] },
  },
];
