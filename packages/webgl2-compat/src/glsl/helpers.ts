// GLSL ES 3.00 helper functions for WGSL semantics GLSL leaves undefined or lacks (W3C WGSL specification sections
// 8.7 and 17; Khronos GLSL ES 3.00 specification sections 5.9 and 8): integer division and remainder that WGSL defines
// for zero and for the most negative value, the float remainder WGSL takes from trunc, saturating float to integer
// conversion, and the bit and packing built-ins GLSL ES 3.00 does not have. Each helper is emitted once, only when a
// shader needs it; `deps` lists helpers it calls. Scalar versions only: vector calls are built per component.

/** One helper: its GLSL source and the helpers it calls. */
interface Helper {
  readonly source: string;
  readonly deps?: readonly string[];
}

export const HELPERS: Readonly<Record<string, Helper>> = {
  // WGSL: e1 / 0 is e1; the most negative value / -1 is itself. Truncating division on magnitudes (GLSL ES leaves
  // signed division of negative operands unspecified).
  _divi: {
    source: `int _divi(int a, int b) { if (b == 0) return a; uint q = uint(a < 0 ? -a : a) / uint(b < 0 ? -b : b); return (a < 0) != (b < 0) ? -int(q) : int(q); }`,
  },
  _modi: {
    source: `int _modi(int a, int b) { if (b == 0) return 0; uint r = uint(a < 0 ? -a : a) % uint(b < 0 ? -b : b); return a < 0 ? -int(r) : int(r); }`,
  },
  _divu: { source: `uint _divu(uint a, uint b) { return b == 0u ? a : a / b; }` },
  _modu: { source: `uint _modu(uint a, uint b) { return b == 0u ? 0u : a % b; }` },
  // WGSL's float remainder truncates (x - y * trunc(x / y)); GLSL's mod floors.
  _fmod: { source: `float _fmod(float a, float b) { return a - b * trunc(a / b); }` },
  // Conversions saturate in WGSL (the largest f32 below 2^31 is 2147483520, below 2^32 4294967040).
  _f2i: { source: `int _f2i(float x) { return int(clamp(x, -2147483648.0, 2147483520.0)); }` },
  _f2u: { source: `uint _f2u(float x) { return uint(clamp(x, 0.0, 4294967040.0)); }` },
  _cob: {
    source: `uint _cob(uint x) { x = x - ((x >> 1u) & 0x55555555u); x = (x & 0x33333333u) + ((x >> 2u) & 0x33333333u); return (((x + (x >> 4u)) & 0x0F0F0F0Fu) * 0x01010101u) >> 24u; }`,
  },
  _clz: {
    source: `uint _clz(uint x) { if (x == 0u) return 32u; uint n = 0u; if ((x & 0xFFFF0000u) == 0u) { n += 16u; x <<= 16u; } if ((x & 0xFF000000u) == 0u) { n += 8u; x <<= 8u; } if ((x & 0xF0000000u) == 0u) { n += 4u; x <<= 4u; } if ((x & 0xC0000000u) == 0u) { n += 2u; x <<= 2u; } if ((x & 0x80000000u) == 0u) n += 1u; return n; }`,
  },
  _ctz: { source: `uint _ctz(uint x) { return x == 0u ? 32u : 31u - _clz(x & (~x + 1u)); }`, deps: ['_clz'] },
  _flbu: { source: `uint _flbu(uint x) { return x == 0u ? 0xFFFFFFFFu : 31u - _clz(x); }`, deps: ['_clz'] },
  _flbi: {
    source: `int _flbi(int x) { uint u = uint(x < 0 ? ~x : x); return u == 0u ? -1 : int(31u - _clz(u)); }`,
    deps: ['_clz'],
  },
  _ftbu: { source: `uint _ftbu(uint x) { return x == 0u ? 0xFFFFFFFFu : _ctz(x); }`, deps: ['_ctz'] },
  _ftbi: { source: `int _ftbi(int x) { return x == 0 ? -1 : int(_ctz(uint(x))); }`, deps: ['_ctz'] },
  _rev: {
    source: `uint _rev(uint x) { x = ((x >> 1u) & 0x55555555u) | ((x & 0x55555555u) << 1u); x = ((x >> 2u) & 0x33333333u) | ((x & 0x33333333u) << 2u); x = ((x >> 4u) & 0x0F0F0F0Fu) | ((x & 0x0F0F0F0Fu) << 4u); x = ((x >> 8u) & 0x00FF00FFu) | ((x & 0x00FF00FFu) << 8u); return (x >> 16u) | (x << 16u); }`,
  },
  _extu: {
    source: `uint _extu(uint e, uint offset, uint count) { uint o = min(offset, 32u); uint c = min(count, 32u - o); if (c == 0u) return 0u; return (e >> o) & (c == 32u ? 0xFFFFFFFFu : ((1u << c) - 1u)); }`,
  },
  _exti: {
    source: `int _exti(int e, uint offset, uint count) { uint o = min(offset, 32u); uint c = min(count, 32u - o); if (c == 0u) return 0; return int(uint(e) << (32u - o - c)) >> (32u - c); }`,
  },
  _insu: {
    source: `uint _insu(uint e, uint n, uint offset, uint count) { uint o = min(offset, 32u); uint c = min(count, 32u - o); if (c == 0u) return e; uint m = (c == 32u ? 0xFFFFFFFFu : ((1u << c) - 1u)) << o; return (e & ~m) | ((n << o) & m); }`,
  },
  _ldexp: { source: `float _ldexp(float x, int e) { int h = e / 2; return x * exp2(float(h)) * exp2(float(e - h)); }` },
  _q16: { source: `float _q16(float x) { return unpackHalf2x16(packHalf2x16(vec2(x, 0.0))).x; }` },
  // WGSL packs round with floor(0.5 + v); GLSL's round() may go either way at a half.
  _p4x8u: {
    source: `uint _p4x8u(vec4 v) { uvec4 u = uvec4(floor(0.5 + clamp(v, 0.0, 1.0) * 255.0)); return u.x | (u.y << 8u) | (u.z << 16u) | (u.w << 24u); }`,
  },
  _p4x8s: {
    source: `uint _p4x8s(vec4 v) { uvec4 u = uvec4(ivec4(floor(0.5 + clamp(v, -1.0, 1.0) * 127.0))) & 0xFFu; return u.x | (u.y << 8u) | (u.z << 16u) | (u.w << 24u); }`,
  },
  _u4x8u: {
    source: `vec4 _u4x8u(uint u) { return vec4(uvec4(u, u >> 8u, u >> 16u, u >> 24u) & 0xFFu) / 255.0; }`,
  },
  _u4x8s: {
    source: `vec4 _u4x8s(uint u) { return max(vec4(ivec4(int(u << 24u) >> 24, int(u << 16u) >> 24, int(u << 8u) >> 24, int(u) >> 24)) / 127.0, -1.0); }`,
  },
  _p2x16u: {
    source: `uint _p2x16u(vec2 v) { uvec2 u = uvec2(floor(0.5 + clamp(v, 0.0, 1.0) * 65535.0)); return u.x | (u.y << 16u); }`,
  },
  _p2x16s: {
    source: `uint _p2x16s(vec2 v) { uvec2 u = uvec2(ivec2(floor(0.5 + clamp(v, -1.0, 1.0) * 32767.0))) & 0xFFFFu; return u.x | (u.y << 16u); }`,
  },
  _p4i8: {
    source: `uint _p4i8(ivec4 v) { uvec4 u = uvec4(v) & 0xFFu; return u.x | (u.y << 8u) | (u.z << 16u) | (u.w << 24u); }`,
  },
  _p4u8: {
    source: `uint _p4u8(uvec4 v) { uvec4 u = v & 0xFFu; return u.x | (u.y << 8u) | (u.z << 16u) | (u.w << 24u); }`,
  },
  _p4i8c: { source: `uint _p4i8c(ivec4 v) { return _p4i8(clamp(v, -128, 127)); }`, deps: ['_p4i8'] },
  _p4u8c: { source: `uint _p4u8c(uvec4 v) { return _p4u8(min(v, 255u)); }`, deps: ['_p4u8'] },
  _u4i8: {
    source: `ivec4 _u4i8(uint u) { return ivec4(int(u << 24u) >> 24, int(u << 16u) >> 24, int(u << 8u) >> 24, int(u) >> 24); }`,
  },
  _u4u8: { source: `uvec4 _u4u8(uint u) { return uvec4(u, u >> 8u, u >> 16u, u >> 24u) & 0xFFu; }` },
  _d4u8: {
    source: `uint _d4u8(uint a, uint b) { uvec4 x = _u4u8(a), y = _u4u8(b); return x.x * y.x + x.y * y.y + x.z * y.z + x.w * y.w; }`,
    deps: ['_u4u8'],
  },
  _d4i8: {
    source: `int _d4i8(uint a, uint b) { ivec4 x = _u4i8(a), y = _u4i8(b); return x.x * y.x + x.y * y.y + x.z * y.z + x.w * y.w; }`,
    deps: ['_u4i8'],
  },
};
