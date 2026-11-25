// GLSL programs that read structs, arrays, uniform blocks, sampler arrays, integer and shadow samplers, sized points,
// flat varyings and wireframes, drawn by the browser's own WebGL compiler (the oracle) and by ShaderMaterial on WebGPU
// and on the WebGL2 layer in test/glsl-material-check.mjs. As in test/glsl-material-fixtures.js every edge lies on a
// pixel boundary (lines run through pixel centres), no lookup or index turns at a pixel centre, and nothing is
// undefined (Lecoeur, Mohsin and Donaldson, PLDI 2023). `values` holds the first and the changed uniform values by
// name; the oracle sets each leaf GL lists (`rig.fill[0].color`) from the program's own tables.
const full = [-1, -1, 1, -1, 1, 1, -1, 1];
const quadIndex = [0, 1, 2, 0, 2, 3];
const xyz = (p) => p.flatMap((v, i) => (i % 2 ? [v, 0] : [v]));

/** An 8 x 8 image per seed, rows from the first in memory. */
export function dataImage(seed) {
  const bytes = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      bytes.set(
        [(x * 29 + seed * 40) % 256, (y * 31 + 16) % 256, ((x + 2 * y + seed) % 5) * 60 + 8, 255],
        (y * 8 + x) * 4,
      );
  return bytes;
}
/** 8 x 8 unsigned integer texels (rgba8uint). */
export function countImage() {
  const bytes = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) bytes.set([x * 30 + 5, y * 31 + 3, (x * 7 + y * 13) % 200, 1], (y * 8 + x) * 4);
  return bytes;
}
/** 8 x 8 depths (depth16unorm) from 20000 to 41000 in steps of 3000, none within 767 of the 0.5 reference. */
export function depthImage() {
  const words = new Uint16Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) words[y * 8 + x] = 20000 + ((x * 5 + y * 3) % 8) * 3000;
  return words;
}
const light = (color, power, on, spin) => ({ color, power, on, spin });

export const dataFixtures = [
  {
    name: 'structs, arrays of structs, scalar and vector arrays, a non-square matrix and uniform blocks',
    vertex: `#version 300 es
in vec2 position;
out vec2 vUv;
uniform vec2 shift[2];
void main() { vUv = position * 0.5 + 0.5 + shift[1]; gl_Position = vec4(position, 0.0, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 color;
struct Light { vec3 color; float power; bool on; mat2 spin; };
struct Rig { Light key; Light fill[2]; float weights[3]; };
uniform Rig rig;
uniform float gains[4];
uniform vec2 offsets[2];
uniform ivec2 steps[2];
uniform vec4 palette[3];
uniform mat2x3 skew;
uniform Tone { vec3 lift; float scale; } tone;
uniform Plain { float bias; };
vec3 shade(Light l, vec2 p) { return l.on ? l.color * l.power * (l.spin * p).x : vec3(0.0); }
void main() {
  vec2 p = vUv + offsets[0] * 0.5 + offsets[1] * 0.25;
  vec3 c = shade(rig.key, p) + shade(rig.fill[0], p) * 0.5 + shade(rig.fill[1], p) * 0.25;
  vec2 q = min(vUv, vec2(0.999));
  int k = int(q.x * 2.99);
  c += vec3(rig.weights[k]) * 0.25 + palette[k].rgb * 0.25 + vec3(gains[int(q.y * 3.99)]) * 0.125;
  c += skew * vec2(0.25, 0.5) * 0.25 + vec3(float(steps[1].y)) / 64.0;
  color = vec4(clamp(c * tone.scale + tone.lift + vec3(bias), 0.0, 1.0), 1.0);
}`,
    // GL sets a block's members from a buffer; the oracle reads the same values as a struct and plain uniforms.
    oracle: {
      replace: [
        [
          'uniform Tone { vec3 lift; float scale; } tone;',
          'struct Tone { vec3 lift; float scale; };\nuniform Tone tone;',
        ],
        ['uniform Plain { float bias; };', 'uniform float bias;'],
      ],
    },
    attributes: { position: { size: 2, data: full } },
    index: quadIndex,
    uniforms: {},
    values: [
      {
        shift: [
          [0, 0],
          [0.03125, 0],
        ],
        rig: {
          key: light([0.5, 0.25, 0.125], 1, true, [1, 0, 0, 1]),
          fill: [light([0, 0.5, 0], 0.5, true, [0, 1, 1, 0]), light([0, 0, 1], 1, false, [1, 0, 0, 1])],
          weights: [0.25, 0.5, 1],
        },
        gains: [0.25, 0.5, 0.75, 1],
        offsets: [0.125, 0.25, 0.375, -0.125],
        steps: [
          [1, 2],
          [3, 4],
        ],
        palette: [
          [1, 0, 0, 1],
          [0, 1, 0, 1],
          [0, 0, 1, 1],
        ],
        skew: [1, 0, 0, 0, 1, 0],
        tone: { lift: [0.0625, 0.0625, 0.0625], scale: 0.75 },
        bias: 0.0625,
      },
      {
        shift: [
          [0, 0],
          [0, 0.0625],
        ],
        rig: {
          key: light([0.25, 0.5, 0.75], 0.5, true, [0, 1, 1, 0]),
          fill: [light([0.5, 0, 0], 1, false, [1, 0, 0, 1]), light([0, 0.25, 0.5], 1, true, [0.5, 0, 0, 0.5])],
          weights: [1, 0.5, 0],
        },
        gains: [1, 0.75, 0.5, 0.25],
        offsets: [
          [0, 0.125],
          [0.25, 0],
        ],
        steps: [
          [0, 0],
          [5, 8],
        ],
        palette: [0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0, 1],
        skew: [0, 0.5, 0, 0.5, 0, 0.25],
        tone: { lift: [0, 0, 0.125], scale: 1 },
        bias: 0,
      },
    ],
  },
  {
    name: 'ES 3.00 sampler array, integer sampler with texelFetch and a shadow sampler',
    vertex: `#version 300 es
in vec2 position;
out vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2DShadow;
in vec2 vUv;
out vec4 color;
uniform sampler2D maps[2];
uniform usampler2D counts;
uniform sampler2DShadow depth;
void main() {
  vec4 a = texture(maps[0], vUv), b = texture(maps[1], vUv.yx);
  uvec4 n = texture(counts, vUv);
  float lit = texture(depth, vec3(vUv, 0.5));
  uvec4 m = texelFetch(counts, ivec2(vUv * 8.0), 0);
  color = vec4(a.r * 0.5 + b.g * 0.5, float(n.g) / 255.0, lit * 0.5 + float(m.b) / 512.0, 1.0);
}`,
    attributes: { position: { size: 2, data: full } },
    index: quadIndex,
    uniforms: {},
    textures: [
      { uniform: 'maps', index: 0, kind: 'rgba8', seed: 1 },
      { uniform: 'maps', index: 1, kind: 'rgba8', seed: 2 },
      { uniform: 'counts', kind: 'rgba8ui' },
      { uniform: 'depth', kind: 'depth16' },
    ],
    flipY: true,
  },
  {
    name: 'ES 1.00 sampler array read with a loop index',
    vertex: `attribute vec2 position;
varying vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`,
    fragment: `precision highp float;
varying vec2 vUv;
uniform sampler2D maps[3];
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 3; i++) acc += texture2D(maps[i], vUv) * (0.25 + 0.125 * float(i));
  gl_FragColor = vec4(acc.rgb * 0.75, 1.0);
}`,
    attributes: { position: { size: 2, data: full } },
    index: quadIndex,
    uniforms: {},
    textures: [
      { uniform: 'maps', index: 0, kind: 'rgba8', seed: 0 },
      { uniform: 'maps', index: 1, kind: 'rgba8', seed: 3 },
      { uniform: 'maps', index: 2, kind: 'rgba8', seed: 5 },
    ],
    flipY: false,
  },
  {
    name: 'sized points with gl_PointCoord and a texture',
    vertex: `#version 300 es
in vec2 position;
in float size;
in vec3 tint;
flat out vec3 vTint;
void main() { vTint = tint; gl_PointSize = size; gl_Position = vec4(position, 0.0, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
flat in vec3 vTint;
uniform sampler2D map;
out vec4 color;
void main() { vec4 t = texture(map, gl_PointCoord); color = vec4(vTint * 0.5 + t.rgb * 0.5 * vec3(gl_PointCoord, 1.0), 1.0); }`,
    // Centres on pixel corners, sizes 8 and 16, so every square ends on pixel boundaries and no texel edge meets a centre.
    geometry: { positions: xyz([-0.5, -0.5, 0.5, 0.25, 0.25, -0.625]) },
    meshAttributes: { size: [8, 16, 8], tint: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    attributes: {
      position: { size: 2, data: [-0.5, -0.5, 0.5, 0.25, 0.25, -0.625] },
      size: { size: 1, data: [8, 16, 8] },
      tint: { size: 3, data: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    },
    topology: 'point-list',
    uniforms: {},
    textures: [{ uniform: 'map', kind: 'rgba8', seed: 4 }],
    flipY: true,
  },
  {
    name: 'flat varyings take the last vertex of each triangle of a list',
    vertex: `#version 300 es
in vec3 position;
in vec3 tint;
flat out vec3 vTint;
out float vShade;
void main() { vTint = tint; vShade = position.x * 0.25 + 0.5; gl_Position = vec4(position, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
flat in vec3 vTint;
in float vShade;
out vec4 color;
void main() { color = vec4(vTint * vShade, 1.0); }`,
    // The diagonal from (0, 0) to (31, 32) in pixels meets no pixel centre.
    geometry: { positions: xyz([-1, -1, 0.9375, -1, 0.9375, 1, -1, 1]), indices: quadIndex },
    meshAttributes: { tint: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0] },
    attributes: {
      position: { size: 3, data: xyz([-1, -1, 0.9375, -1, 0.9375, 1, -1, 1]) },
      tint: { size: 3, data: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0] },
    },
    index: quadIndex,
    uniforms: {},
  },
  {
    name: 'flat varyings take the last vertex of each triangle of a strip',
    vertex: `#version 300 es
in vec3 position;
in vec3 tint;
flat out vec3 vTint;
void main() { vTint = tint; gl_Position = vec4(position, 1.0); }`,
    fragment: `#version 300 es
precision highp float;
flat in vec3 vTint;
out vec4 color;
void main() { color = vec4(vTint, 1.0); }`,
    geometry: { positions: xyz([-1, -1, 0.9375, -1, -1, 1, 0.9375, 1]) },
    meshAttributes: { tint: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0] },
    attributes: {
      position: { size: 3, data: xyz([-1, -1, 0.9375, -1, -1, 1, 0.9375, 1]) },
      tint: { size: 3, data: [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0] },
    },
    topology: 'triangle-strip',
    cull: 'none',
    uniforms: {},
  },
  {
    name: 'a wireframe draws each edge of the triangles once',
    vertex: `attribute vec2 position;
varying vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`,
    fragment: `precision highp float;
varying vec2 vUv;
void main() { gl_FragColor = vec4(vUv, 0.5, 1.0); }`,
    // Corners on pixel centres (4.5 and 27.5 pixels), so the edges and the diagonal run through centres.
    attributes: {
      position: { size: 2, data: [-0.71875, -0.71875, 0.71875, -0.71875, 0.71875, 0.71875, -0.71875, 0.71875] },
    },
    index: quadIndex,
    uniforms: {},
    options: { wireframe: true },
  },
];
