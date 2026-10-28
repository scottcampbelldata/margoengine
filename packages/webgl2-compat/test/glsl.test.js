// The GLSL ES 3.00 back end, in Node: names, literals, the shape of what it emits for each WGSL rule GLSL handles
// differently, and its refusals. The browser checks (glsl-corpus-browser, corpus-draw-browser, compat-browser-check)
// compile, draw and compare the output on a real GPU; these pin the translation choices those checks rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { glslFloat, glslName, translateStage, translateWGSL } from '../dist/glsl.js';

const V =
  '@vertex fn v(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i), 0.0, 0.0, 1.0); }';
/** The fragment shader GLSL of `body` inside `@fragment fn f(...) -> @location(0) vec4u`. */
function frag(prelude, body, params = '@builtin(position) p: vec4f') {
  const source = `${prelude}\n${V}\n@fragment fn f(${params}) -> @location(0) vec4u { ${body} }`;
  return translateWGSL({ vertex: { source }, fragment: { source } }).fragment.source;
}

test('names: an injective ASCII encoding with no double underscore and no GLSL keyword', () => {
  const names = ['a_b', 'a__b', 'a_ub', 'a___b', '_x', 'while', 'texture', 'main', 'gl_Position', 'café', 'x2'];
  const encoded = names.map((n) => glslName(n));
  assert.equal(new Set(encoded).size, names.length);
  for (const e of encoded) {
    assert.match(e, /^[A-Za-z0-9_]+$/);
    assert.ok(!e.includes('__'), e);
  }
  const glsl = frag('fn texture(x: u32) -> u32 { return x; }', 'let while_ = texture(1u); return vec4u(while_);');
  assert.match(glsl, /uint qtexture\(uint lx_\d+\)/);
});

test('float literals parse back to the same f32', () => {
  for (const v of [
    0, 1, -1, 0.1, 1e-7, 3.4028234663852886e38, 1.401298464324817e-45, 16777217, 0.30000001192092896, -2.5e-12,
  ]) {
    const text = glslFloat(v);
    assert.match(text, /[.e]/, text);
    assert.equal(Math.fround(Number(text)), Math.fround(v), text);
  }
  assert.equal(glslFloat(-0), '-0.0');
});

test('integer division and remainder go through helpers that follow WGSL; constant unsigned divisors stay direct', () => {
  const glsl = frag(
    '@group(0) @binding(0) var<uniform> u: vec4i;',
    'let a = u.x / u.y; let b = u.x % u.y; let c = u32(u.z) / u32(u.w); let d = u32(u.z) % 7u; let e = f32(u.x) % 2.5; return vec4u(u32(a), u32(b), c, d + u32(e));',
  );
  assert.match(glsl, /int _divi\(int a, int b\) \{ if \(b == 0\) return a;/);
  assert.match(glsl, /_modi\(/);
  assert.match(glsl, /_divu\(/);
  assert.match(glsl, / % 7u\)/);
  assert.match(glsl, /a - b \* trunc\(a \/ b\)/);
});

test('shifts by a runtime amount are masked to the bit width; conversions from float saturate', () => {
  const glsl = frag(
    '@group(0) @binding(0) var<uniform> u: vec4u;',
    'return vec4u(u.x << u.y, u.x >> 3u, u32(i32(bitcast<f32>(u.z))), u32(bitcast<f32>(u.w)));',
  );
  assert.match(glsl, /<< \(.* & 31u\)\)/);
  assert.match(glsl, />> 3u\)/);
  assert.match(glsl, /clamp\(.*-2147483648\.0, 2147483520\.0\)/);
  assert.match(glsl, /clamp\(.*0\.0, 4294967040\.0\)/);
});

test('uniform buffers are uvec4 rows read with static components (no dynamic vector index), in WGSL layout', () => {
  // Regression (2026-10-28): reads addressed by word let ANGLE's Direct3D back end emulate a dynamic vector index per
  // read; a large shader then failed to compile at its first draw and the context was lost.
  const glsl = frag(
    'struct L { color: vec3f, power: f32, m: mat2x2f } struct U { a: vec3f, b: f32, lights: array<L, 4>, n: mat3x2f }\n@group(0) @binding(0) var<uniform> u: U;',
    'let i = u32(p.x) % 4u; let l = u.lights[i]; return vec4u(bitcast<u32>(u.b), bitcast<u32>(l.power), bitcast<u32>(l.m[1].y), bitcast<u32>(u.n[2][1] + u.lights[2].color.z));',
  );
  assert.match(glsl, /layout\(std140\) uniform _Bf0_0 \{ highp uvec4 _uf0_0\[\d+\]; \};/);
  assert.doesNotMatch(glsl, /\[[^\]]*& 3\]/, 'a dynamic component index in a uniform read');
  assert.match(glsl, /uintBitsToFloat\(_uf0_0\[0\]\.w\)/, 'u.b: row 0, component w');
  // lights (L is 32 bytes: color, power, then a mat2x2f at 16) end at byte 144, where n starts; matCx2 columns are 8
  // bytes apart, so n[2] is at byte 160 (row 10, x and y).
  assert.match(glsl, /_uf0_0\[10\]\.y/);
  assert.match(glsl, /mat2\(uintBitsToFloat\(_uf0_0\[r\]\.xy\), uintBitsToFloat\(_uf0_0\[r\]\.zw\)\)/);
});

test('dynamic indexes are clamped into range; constant ones are kept', () => {
  const glsl = frag(
    '',
    'var a = array<u32, 5>(1u, 2u, 3u, 4u, 5u); let i = u32(p.x); a[i] = 7u; return vec4u(a[i], a[2], 0u, 0u);',
  );
  assert.match(glsl, /\[int\(min\(.*, uint\(5\) - 1u\)\)\]/);
  assert.match(glsl, /\[2\]/);
});

test('loops: for keeps its header; a continuing block runs on continue and break if leaves the loop', () => {
  const glsl = frag(
    '',
    'var n = 0u; for (var i = 0u; i < 8u; i++) { if (i == 2u) { continue; } n += i; } loop { n++; if (n > 40u) { continue; } continuing { n += 2u; break if n > 50u; } } return vec4u(n);',
  );
  assert.match(glsl, /for \(uint li_\d+ = 0u; \(li_\d+ < 8u\); li_\d+\+\+\)/);
  assert.match(glsl, /do \{[\s\S]*continue;[\s\S]*\} while \(false\);/);
  assert.match(glsl, /if \(\(ln_\d+ > 50u\)\) break;/);
});

test('switch clauses are scoped blocks that end in break; uint selectors take uint labels', () => {
  const glsl = frag(
    '',
    'var r = 0u; switch (u32(p.x)) { case 1u, 2u: { r = 3u; } default: { r = 4u; } } return vec4u(r);',
  );
  assert.match(glsl, /case 1u: case 2u: \{/);
  assert.match(glsl, /default: \{/);
  assert.match(glsl, /\} break;/);
});

test('pointer lets alias their variable; pointer parameters are inout', () => {
  // Regression (2026-10-28): a `let p = &a[1]` failed to translate ("a memory reference of kind 'address-of'").
  const glsl = frag(
    'fn bump(p: ptr<function, u32>) { *p = *p + 1u; }',
    'var a = array<u32, 3>(); let i = u32(p.x) % 3u; let q = &a[i]; *q = 5u; bump(&a[0]); bump(q); return vec4u(a[0], a[1], a[2], 0u);',
  );
  assert.match(glsl, /void qbump\(inout uint lp_\d+\)/);
  assert.match(glsl, /int _t\d+ = int\(min\(/, 'the alias index is evaluated once, at the let');
  assert.match(glsl, /la_\d+\[_t\d+\] = 5u;/);
});

test('a call of a function that may discard is evaluated into a temporary when nothing mutable comes first', () => {
  // Regression (2026-10-28): ANGLE's Direct3D back end could not build `return PickPixel(shade(i, front), id)` with
  // shade() discarding (selection's pick shader); the hoisted form builds.
  const source = `struct O { @location(0) c: vec4f, @location(1) id: u32 }
fn shade(x: f32) -> vec4f { if (x < 0.5) { discard; } return vec4f(x); }
${V}
@fragment fn f(@builtin(position) p: vec4f) -> O { return O(shade(p.x), 7u); }
@fragment fn g(@builtin(position) p: vec4f) -> O { var k = 1u; return O(vec4f(f32(k)) + shade(p.x), k); }`;
  const f = translateStage({ source, entryPoint: 'f' }, 'fragment').source;
  assert.match(f, /vec4 _t\d+ = qshade\(lp_\d+\.x\);\n\s+return qO\(_t\d+, 7u\);/);
  // A variable read before the call: the call stays in place, so a write by the call cannot change what was read.
  const g = translateStage({ source, entryPoint: 'g' }, 'fragment').source;
  assert.match(g, /return qO\(\(vec4\(float\(lk_\d+\)\) \+ qshade\(/);
});

test('packing rounds as WGSL specifies, with floor(0.5 + v), not GLSL round()', () => {
  const glsl = frag(
    '@group(0) @binding(0) var<uniform> u: vec4f;',
    'return vec4u(pack4x8snorm(u), pack4x8unorm(u), pack2x16snorm(u.xy), pack2x16unorm(u.zw));',
  );
  assert.match(glsl, /floor\(0\.5 \+ clamp\(v, -1\.0, 1\.0\) \* 127\.0\)/);
  assert.match(glsl, /floor\(0\.5 \+ clamp\(v, 0\.0, 1\.0\) \* 255\.0\)/);
});

test('entry points: vertex inputs by location, varyings by location, y flipped, base vertex as a uniform', () => {
  const source = `struct VO { @builtin(position) p: vec4f, @location(2) uv: vec2f, @location(5) @interpolate(flat) id: u32, @location(6) @interpolate(linear) s: f32 }
@vertex fn v(@location(0) pos: vec3f, @location(3) id: u32, @builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO { return VO(vec4f(pos, 1.0), pos.xy, id + vi + ii, 1.0); }
@fragment fn f(i: VO) -> @location(1) vec4f { return vec4f(i.uv, f32(i.id), i.s); }`;
  const { vertex, fragment } = translateWGSL({ vertex: { source }, fragment: { source } });
  assert.match(vertex.source, /layout\(location = 0\) in vec3 _a0;/);
  assert.match(vertex.source, /layout\(location = 3\) in uint _a3;/);
  assert.match(vertex.source, /flat out uint _v5;/);
  assert.match(vertex.source, /gl_Position = vec4\(_pos\.x, -_pos\.y, _pos\.z, _pos\.w\);/);
  assert.match(vertex.source, /_v6 = _r\.qs \* _pos\.w;/, 'linear interpolation through w');
  assert.match(fragment.source, /\(_v6 \* gl_FragCoord\.w\)/);
  assert.match(fragment.source, /layout\(location = 1\) out vec4 _o1;/);
  assert.equal(vertex.baseVertex, '_bv');
  assert.equal(vertex.baseInstance, '_bi');
  assert.deepEqual(
    vertex.inputs.map((x) => [x.location, x.kind]),
    [
      [0, 'float'],
      [3, 'uint'],
    ],
  );
  const noClip = translateWGSL({ vertex: { source }, fragment: { source }, clipControl: false }).vertex.source;
  assert.match(noClip, /gl_Position\.z = 2\.0 \* _pos\.z - _pos\.w;/);
});

test('textures: one combined sampler per texture and sampler pair; loads clamp; comparison samplers are shadow samplers', () => {
  const source = `@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var d: texture_depth_2d_array;
@group(0) @binding(3) var c: sampler_comparison;
fn sample(tt: texture_2d<f32>, ss: sampler, uv: vec2f) -> vec4f { return textureSample(tt, ss, uv); }
${V}
@fragment fn f(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return sample(t, s, p.xy) + textureLoad(t, vec2i(p.xy), 0) + textureSampleCompareLevel(d, c, p.xy, 1, 0.5) + f32(textureNumLevels(t));
}`;
  const f = translateWGSL({ vertex: { source }, fragment: { source } }).fragment;
  const types = f.textures.map((t) => `${t.glslType} ${t.binding}${t.sampler ? `/${t.sampler.binding}` : ''}`).sort();
  assert.deepEqual(types, ['sampler2D 0', 'sampler2D 0/1', 'sampler2DArrayShadow 2/3']);
  assert.match(f.source, /textureGrad\(_sf\d+, vec4\(.*float\(1\), 0\.5\), vec2\(0\.0\), vec2\(0\.0\)\)/);
  assert.match(f.source, /texelFetch\(t, clamp\(p, ivec2\(0\), s\), m\)/);
  assert.match(f.source, /precision highp sampler2DArrayShadow;/);
});

test('refusals are coded: storage buffers, compute stages and gather name what is missing', () => {
  const coded = (fn, re) =>
    assert.throws(fn, (e) => {
      assert.equal(e.name, 'MargoError');
      assert.equal(e.code, 'unsupported');
      assert.match(e.message, re);
      assert.match(e.message, /see https:\/\/margoengine\.com\/errors#compatibility-layer$/);
      return true;
    });
  coded(
    () => frag('@group(0) @binding(0) var<storage> b: array<u32>;', 'return vec4u(b[0]);'),
    /storage buffer 'b' \(storage buffers are milestone M4\)/,
  );
  coded(
    () => frag('@group(0) @binding(0) var<storage> b: array<u32>;', 'return vec4u(arrayLength(&b));'),
    /arrayLength/,
  );
  coded(
    () =>
      frag(
        '@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var s: sampler;',
        'return vec4u(textureGather(0, t, s, p.xy));',
      ),
    /textureGather\(\) \(GLSL ES 3\.00 has no gather\)/,
  );
  assert.throws(() => translateWGSL({}), TypeError);
  assert.throws(
    () => translateWGSL({ vertex: { source: V }, fragment: { source: V } }),
    /no fragment entry point|0 fragment entry points/,
  );
});

test('varyings must match: a fragment input the vertex stage does not write is an error', () => {
  const vs = '@vertex fn v() -> @builtin(position) vec4f { return vec4f(0.0); }';
  const fs = '@fragment fn f(@location(4) x: vec2f) -> @location(0) vec4f { return vec4f(x, 0.0, 1.0); }';
  assert.throws(
    () => translateWGSL({ vertex: { source: vs }, fragment: { source: fs } }),
    /reads @location\(4\), which the vertex stage does not write/,
  );
});

test('overrides take pipeline constants by name or id, else their default', () => {
  const source = `override scale: f32 = 2.0; @id(7) override on: bool = false; override count: u32;
${V}
@fragment fn f() -> @location(0) vec4u { var a: array<u32, 4>; a[0] = u32(scale); return vec4u(a[0], u32(on), count, 0u); }`;
  const f = translateWGSL({ vertex: { source }, fragment: { source, constants: { 7: 1, count: 3 } } }).fragment.source;
  assert.match(f, /const float qscale = 2\.0;/);
  assert.match(f, /const bool qon = true;/);
  assert.match(f, /const uint qcount = 3u;/);
});
