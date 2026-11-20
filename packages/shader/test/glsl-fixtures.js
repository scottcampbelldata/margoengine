// GLSL functions for glslFn: each takes (vec2 uv, float t) and, when `texture` is set, a sampler2D third. They hold no
// undefined behaviour (Lecoeur, Mohsin and Donaldson, PLDI 2023): no negative %, no edge0 >= edge1 in smoothstep, no
// discontinuity near a pixel centre, highp throughout, and the one implicit lookup in a branch reads a one-level
// image with nearest filtering, so its level of detail cannot change the result. The native WebGL2 compiler runs each
// as written in test/glsl-check.mjs (the oracle); the CPU test pins their WGSL.
export const glslFixtures = [
  {
    name: 'mix and swizzle',
    source: `vec4 tint(vec2 uv, float t) { vec3 c = vec3(uv, 0.25); return vec4(mix(c, c.bgr, t), 1.0); }`,
  },
  {
    name: 'integers, bit operators and a falling switch',
    source: `#version 300 es
precision highp float;
precision highp int;
vec4 bits(vec2 uv, float t) {
  uint x = uint(uv.x * 255.0) ^ (uint(uv.y * 255.0) << 1u);
  int k = int(x & 3u);
  float r = 0.0;
  switch (k) {
    case 0: r = 0.1; break;
    case 1: r = 0.4;
    case 2: r += 0.3; break;
    default: r = 0.9;
  }
  float g = float((x >> 2u) & 15u) / 15.0;
  float b = float(~x & 7u) / 7.0;
  return vec4(r, mix(g, 1.0 - g, t), b, 1.0);
}`,
  },
  {
    name: 'loops, structs, out parameters and matrices',
    source: `#version 300 es
precision highp float;
struct Ring { vec2 centre; float radius; };
void polar(vec2 p, out float angle, inout float len) { angle = atan(p.y, p.x); len += length(p); }
float ring(Ring r, vec2 p) {
  float a;
  float l = 0.0;
  polar(p - r.centre, a, l);
  return (1.0 - smoothstep(r.radius - 0.05, r.radius, l)) * (0.5 + 0.5 * cos(a * 3.0));
}
vec4 rings(vec2 uv, float t) {
  float acc = 0.0;
  int i = 0;
  do { acc += ring(Ring(vec2(0.3 + 0.2 * float(i), 0.5), 0.15 + 0.05 * t), uv); i++; } while (i < 3);
  mat2 m = inverse(mat2(2.0, 1.0, 1.0, 3.0));
  vec2 q = m * uv;
  mat3 o = outerProduct(vec3(uv, 1.0), vec3(0.5, 0.25, t));
  float s = 0.0;
  for (int k = 0; k < 3; k++) { if (k == 1) continue; s += o[k][k]; }
  return vec4(clamp(acc, 0.0, 1.0), sin(q.x * 6.0) * 0.5 + 0.5, s * 0.5, 1.0);
}`,
  },
  {
    name: 'texture, textureLod, texelFetch and textureSize',
    texture: true,
    source: `#version 300 es
precision highp float;
vec4 lookup(vec2 uv, float t, sampler2D img) {
  vec2 cell = (floor(uv * 8.0) + 0.5) / 8.0;
  vec4 c = textureLod(img, cell, 0.0);
  ivec2 size = textureSize(img, 0);
  vec4 d = texelFetch(img, ivec2(cell * vec2(size)), 0);
  if (uv.x > 0.5) c = texture(img, cell.yx);
  return vec4(c.rg, mix(d.b, c.a, t), 1.0);
}`,
  },
  {
    name: 'GLSL ES 1.00: constants, ternaries, logic and mod',
    source: `#version 100
precision highp float;
const float K = 0.75;
float wave(float x) { return x > K ? 1.0 - x : x * (1.0 / K); }
vec4 legacy(vec2 uv, float t) {
  bool a = uv.x > 0.25 && uv.y < 0.75;
  bool b = !(uv.x > 0.8) || t > 0.5;
  float m = mod(uv.x * 7.0, 1.0);
  return vec4(a ? wave(uv.y) : 0.2, b ? m : 0.0, float(a == b), 1.0);
}`,
  },
];
/** The 8 x 8 RGBA8 image the texture fixture reads, rows from the first: every texel distinct. */
export const fixtureImage = () => {
  const bytes = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) bytes.set([x * 32 + 16, y * 32 + 16, (x * 5 + y * 3) % 8 * 32, 255 - x * 8 - y * 16], (y * 8 + x) * 4);
  return bytes;
};
