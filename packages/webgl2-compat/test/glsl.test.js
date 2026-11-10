// The GLSL ES 3.00 back end, in Node: names, literals, the shape of what it emits for each WGSL rule GLSL handles
// differently, and its refusals. The browser checks (glsl-corpus-browser, corpus-draw-browser, compat-browser-check)
// compile, draw and compare the output on a real GPU; these pin the translation choices those checks rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { glslFloat, glslName, translateStage, translateWGSL } from '../dist/glsl.js';

const V =
  '@vertex fn v(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i), 0.0, 0.0, 1.0); }';

for (const [dimension, coords, offset] of [
  ['1d', 'p.x*0.123', '1'],
  ['2d', 'p.xy*0.123', 'vec2i(1)'],
  ['2d_array', 'p.xy*0.123, 0', 'vec2i(1)'],
  ['3d', 'p.xyz*0.123', 'vec3i(1)'],
  ['cube', 'p.xyz', undefined],
])
  for (const bias of [undefined, '0.0', '-1.25', '1.25'])
    for (const shifted of offset ? [false, true] : [false]) {
      test(`implicit ${dimension} sampling bias=${bias} offset=${shifted} keeps hardware footprint selection`, () => {
        const call = bias === undefined ? 'textureSample' : 'textureSampleBias';
        const source = `${V}\n@group(0) @binding(0) var t:texture_${dimension}<f32>; @group(0) @binding(1) var s:sampler;
    @fragment fn f(@builtin(position) p:vec4f)->@location(0) vec4f {return ${call}(t,s,${coords}${bias === undefined ? '' : `,${bias}`}${shifted ? `,${offset}` : ''});}`;
        const f = translateWGSL({ vertex: { source }, fragment: { source } }).fragment;
        assert.equal(f.textures.length, 1);
        assert.equal(f.textures[0].mipFilter, undefined);
        assert.match(f.source, shifted ? /textureOffset\(/ : /texture\(/);
        assert.doesNotMatch(f.source, /log2\(|textureLod\(/);
      });
    }

for (const [dimension, coords, offset] of [
  ['2d', 'p.xy*0.123', 'vec2i(1)'],
  ['2d_array', 'p.xy*0.123, 0', 'vec2i(1)'],
  ['3d', 'p.xyz*0.123', 'vec3i(1)'],
])
  for (const shifted of [false, true])
    test(`explicit-gradient ${dimension} sampling offset=${shifted} keeps hardware footprint selection`, () => {
      // A float LOD estimate disagreed with the sampler's snapped LOD next to an integer level, so materials
      // stochasticTiling (gradients from dpdx and dpdy) differed from a plain textureSample read on compat only.
      const d = dimension === '3d' ? 'vec3f' : 'vec2f',
        uv = coords.split(',')[0];
      const source = `${V}\n@group(0) @binding(0) var t:texture_${dimension}<f32>; @group(0) @binding(1) var s:sampler;
    @fragment fn f(@builtin(position) p:vec4f)->@location(0) vec4f {let d:${d}=${uv};return textureSampleGrad(t,s,${coords},dpdx(d),dpdy(d)${shifted ? `,${offset}` : ''});}`;
      const f = translateWGSL({ vertex: { source }, fragment: { source } }).fragment;
      assert.equal(f.textures.length, 1);
      assert.equal(f.textures[0].mipFilter, undefined);
      assert.match(f.source, shifted ? /textureGradOffset\(/ : /textureGrad\(/);
      assert.doesNotMatch(f.source, /log2\(|textureLod\(/);
    });

for (const [dimension, coords, offset] of [
  ['2d', 'uv', 'vec2i(1,-1)'],
  ['2d_array', 'uv, 1', 'vec2i(1,-1)'],
])
  for (const [dx, dy] of [
    ['dpdx', 'dpdy'],
    ['dpdxFine', 'dpdyCoarse'],
  ])
    for (const shifted of [false, true])
      test(`textureSampleGrad ${dimension} with ${dx}/${dy} of its own coordinate offset=${shifted} samples implicitly`, () => {
        // Regression (M6 Mac mini, 2026-11-10): ANGLE Metal's textureGrad(c, dFdx(c), dFdy(c)) chose LOD 1.77 where
        // native Metal's textureSampleGrad(c, dpdx(c), dpdy(c)) equals textureSample (LOD 1.86); bias-browser.mjs.
        const source = `${V}\n@group(0) @binding(0) var t:texture_${dimension}<f32>; @group(0) @binding(1) var s:sampler;
    @fragment fn f(@builtin(position) p:vec4f)->@location(0) vec4f {let uv=vec2f(0.173,0.124)*p.x+vec2f(-0.063,0.186)*p.y;
      return textureSampleGrad(t,s,${coords},${dx}(uv),${dy}(uv)${shifted ? `,${offset}` : ''});}`;
        const f = translateWGSL({ vertex: { source }, fragment: { source } }).fragment.source;
        assert.match(f, shifted ? /textureOffset\(/ : /texture\(/);
        assert.doesNotMatch(f, /textureGrad|dFdx|dFdy/);
      });

test('textureSampleGrad keeps explicit gradients that are not the derivatives of its own coordinate', () => {
  for (const [grad, why] of [
    ['vec2f(0.173,0.124),vec2f(-0.063,0.186)', 'constant gradients'],
    ['dpdx(uv),dpdy(uv*2.0)', 'derivatives of another expression'],
    ['dpdy(uv),dpdx(uv)', 'swapped derivatives'],
    ['dpdx(w),dpdy(w)', 'a var read twice'],
    ['dpdx(uv)*2.0,dpdy(uv)', 'scaled derivatives'],
  ]) {
    const source = `${V}\n@group(0) @binding(0) var t:texture_2d<f32>; @group(0) @binding(1) var s:sampler;
    @fragment fn f(@builtin(position) p:vec4f)->@location(0) vec4f {let uv=p.xy*0.123;var w=uv;
      return textureSampleGrad(t,s,${grad.startsWith('dpdx(w)') ? 'w' : 'uv'},${grad});}`;
    const f = translateWGSL({ vertex: { source }, fragment: { source } }).fragment.source;
    assert.match(f, /textureGrad\(/, why);
  }
});

test('isotropic sampling carries the live sampler mip state and blends integer-level samples', () => {
  const source = `${V}\n@group(0) @binding(0) var t:texture_2d<f32>; @group(0) @binding(1) var s:sampler;
    @fragment fn f(@builtin(position) p:vec4f)->@location(0) vec4f {return textureSampleLevel(t,s,p.xy,2.125);}`;
  const f = translateWGSL({ vertex: { source }, fragment: { source } }).fragment;
  assert.equal(f.textures.length, 1, 'no extra texture unit');
  assert.ok(f.textures[0].mipFilter);
  assert.ok(f.textures[0].levels);
  assert.match(f.source, /float a = floor\(z\)/);
  assert.match(f.source, /mix\(textureLod\(t, p, a\), textureLod\(t, p, min\(a \+ 1\.0/);
  assert.match(f.source, /clamp\(clamp\(l, f\.y, f\.z\)/);
});

test('mip LOD calculation consumes each argument once and keeps sampling lazy', () => {
  // WGSL 9.3: argument values are evaluated once before control enters the called function.
  // https://www.w3.org/TR/WGSL/#function-call-expression
  for (const mode of ['implicit', 'bias', 'level', 'grad', 'lazy', 'discard']) {
    const call =
      mode === 'implicit'
        ? 'textureSample(t,s,coords())'
        : mode === 'bias'
          ? 'textureSampleBias(t,s,coords(),level())'
          : mode === 'grad'
            ? 'textureSampleGrad(t,s,coords(),dx(),dy())'
            : 'textureSampleLevel(t,s,coords(),level())';
    const source = `${V}
      @group(0) @binding(0) var t:texture_2d<f32>; @group(0) @binding(1) var s:sampler;
      var<private> count:u32;
      fn coords()->vec2f {${mode === 'discard' ? 'if(count==100u){discard;}' : ''}count++;return vec2f(0.5);}
      fn level()->f32 {count+=10u;return 2.125;}
      fn dx()->vec2f {count+=100u;return vec2f(0.25,0);}
      fn dy()->vec2f {count+=1000u;return vec2f(0,0.25);}
      @fragment fn f()->@location(0) vec4f {${mode === 'lazy' ? `let color=false && ${call}.r>0.0;return vec4f(f32(count));` : `let color=${call};return vec4f(color.r,f32(count),0,1);`}}`;
    const glsl = translateWGSL({ vertex: { source }, fragment: { source } }).fragment.source;
    const body = glsl.match(/vec4 qf\([^)]*\) \{([\s\S]*?)\n\}/)[1];
    for (const fn of ['coords', ...(mode === 'implicit' ? [] : mode === 'grad' ? ['dx', 'dy'] : ['level'])])
      assert.equal(body.match(new RegExp(`q${fn}\\(`, 'g'))?.length, 1, `${mode}: ${fn} evaluated once`);
    if (mode === 'lazy') assert.match(body, /false && [^;]*qcoords\(/, 'argument stays in the lazy operand');
  }
});
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

test('the largest f32 prints as a decimal at or below it, so a strict GLSL parser does not overflow it (R5)', () => {
  // '3.4028235e+38' (the shortest round trip) is above FLT_MAX as a decimal: ANGLE on Metal read it as infinity, and
  // scatter/interact's overflow guard (vec3f(3.4028234663852886e38) - abs(m)) then skipped every cell whose sign
  // differed from the interactor's (scatter test:browser:interact under --compat: stamp off by 0.976).
  const max = 3.4028234663852886e38;
  for (const v of [max, -max]) {
    const text = glslFloat(v);
    assert.ok(Math.abs(Number(text)) <= max, text);
    assert.equal(Math.fround(Number(text)), v, text);
  }
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
  assert.match(
    f.source,
    /textureGrad\(_sf\d+, vec4\(.*float\(clamp\(int\(1\), 0, 65535\)\), 0\.5\), vec2\(0\.0\), vec2\(0\.0\)\)/,
  );
  assert.match(f.source, /texelFetch\(t, clamp\(p, ivec2\(0\), s\), m\)/);
  assert.match(f.source, /precision highp sampler2DArrayShadow;/);
});

test('array layers clamp as integers: a u32 near 2^32 picks the last layer, not layer 0 (WGSL clamps array_index)', () => {
  const source = `@group(0) @binding(0) var t: texture_2d_array<f32>;
@group(0) @binding(1) var s: sampler;
${V}
@fragment fn f(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return textureSampleLevel(t, s, p.xy, 4294967295u, 0.0) + textureSampleLevel(t, s, p.xy, -1, 0.0) + textureGather(0, t, s, p.xy, 4294967295u);
}`;
  const f = translateWGSL({ vertex: { source }, fragment: { source } }).fragment.source;
  // float(4294967295u) is 2^32, which the driver's own float-to-int clamp overflows (layer 0 on Metal through ANGLE).
  assert.match(f, /vec3\([^;]*, float\(int\(min\(4294967295u, 65535u\)\)\)\)/);
  assert.match(f, /float\(clamp\(int\(\(-1\)\), 0, 65535\)\)/);
  assert.match(f, /, int\(min\(4294967295u, 65535u\)\), ivec2\(0\)/);
  assert.doesNotMatch(f, /float\(4294967295u\)|int\(4294967295u\)/);
});

test('refusals are coded: storage buffers, compute stages and cube gathers name what is missing', () => {
  const coded = (fn, re) =>
    assert.throws(fn, (e) => {
      assert.equal(e.name, 'MargoError');
      assert.equal(e.code, 'unsupported');
      assert.match(e.message, re);
      assert.match(e.message, /see https:\/\/margoengine\.com\/errors#compatibility-layer$/);
      return true;
    });
  coded(
    () => frag('@group(0) @binding(0) var<storage, read_write> b: array<u32>;', 'b[0] = 1u; return vec4u(b[1]);'),
    /a write to storage buffer 'b' in a render stage \(WebGL2 render shaders cannot write buffers\)/,
  );
  coded(
    () =>
      frag(
        '@group(0) @binding(0) var t: texture_cube<f32>; @group(0) @binding(1) var s: sampler;',
        'return vec4u(textureGather(0, t, s, p.xyz));',
      ),
    /textureGather on a cube texture \(GLSL ES 3\.00 cannot fetch texels of cube maps\)/,
  );
  assert.throws(() => translateWGSL({}), TypeError);
  assert.throws(
    () => translateWGSL({ vertex: { source: V }, fragment: { source: V } }),
    /no fragment entry point|0 fragment entry points/,
  );
});

test('gather fetches the four footprint texels in WGSL order with the sampler address modes from a uniform', () => {
  const source = `@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var d: texture_depth_2d_array; @group(0) @binding(3) var c: sampler_comparison;
${V}
@fragment fn f(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return textureGather(2, t, s, p.xy, vec2i(1, -1)) + textureGatherCompare(d, c, p.xy, 3, 0.5);
}`;
  const g = translateWGSL({ vertex: { source }, fragment: { source } }).fragment;
  const [plain, cmp] = g.textures;
  assert.deepEqual(plain.gather, { name: `${plain.name}m`, group: 0, binding: 1 });
  assert.equal(plain.sampler, undefined, 'the texture is fetched, not sampled');
  assert.equal(cmp.glslType, 'sampler2DArray', 'the comparison is made by hand on a plain sampler');
  assert.deepEqual(cmp.gather, { name: `${cmp.name}m`, group: 0, binding: 3 });
  assert.match(g.source, new RegExp(`uniform highp ivec4 ${plain.name}m;`));
  // x: (u0, v1), y: (u1, v1), z: (u1, v0), w: (u0, v0), component z of each.
  assert.match(
    g.source,
    /vec4\(texelFetch\(t, ivec2\(x0, y1\), 0\)\.z, texelFetch\(t, ivec2\(x1, y1\), 0\)\.z, texelFetch\(t, ivec2\(x1, y0\), 0\)\.z, texelFetch\(t, ivec2\(x0, y0\), 0\)\.z\)/,
  );
  assert.match(g.source, /ivec3\(x0, y1, a\), 0\)\.x, m\.w\)/);
  assert.match(g.source, /return k < n \? k : p - 1 - k;/, 'mirror-repeat');
});

test('a uniform buffer larger than a uniform block of the context reads from its own data texture', () => {
  // ANGLE's Metal back end holds 16 KiB per block; WebGPU promises 64 KiB (voxel-pathtracer's 32 KiB material table).
  const source = `@group(0) @binding(1) var<uniform> big: array<vec4f, 2048>;
@group(0) @binding(2) var<uniform> small: vec4f;
${V}
@fragment fn f(@builtin(position) p: vec4f) -> @location(0) vec4f { return big[u32(p.x)] + small; }`;
  const fits = translateWGSL({ vertex: { source }, fragment: { source } }).fragment;
  assert.deepEqual(
    fits.uniforms.map((u) => u.binding),
    [1, 2],
  );
  assert.equal(fits.storage.length, 0);
  const g = translateWGSL({
    vertex: { source },
    fragment: { source },
    uniformBlockSize: 16384,
    sharedStorage: () => true,
  }).fragment;
  assert.deepEqual(
    g.uniforms.map((u) => u.binding),
    [2],
  );
  assert.deepEqual(
    g.storage.map(({ group, binding, minSize, uniform, shared }) => ({ group, binding, minSize, uniform, shared })),
    [{ group: 0, binding: 1, minSize: 32768, uniform: true, shared: false }],
  );
  assert.doesNotMatch(g.source, /uniform _Bf0_1/);
  assert.match(g.source, /uniform highp usampler2D _df0_1;/);
});

test('storage buffers are read through a data texture: rows clamped into the binding, arrayLength from its size', () => {
  const source = `struct P { a: vec4f, b: vec2f, n: u32 }
struct S { count: u32, items: array<P> }
@group(1) @binding(2) var<storage, read> s: S;
@group(0) @binding(0) var<storage> w: array<f32>;
${V}
@fragment fn f(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let i = u32(p.x);
  return s.items[i].a + vec4f(s.items[i].b, f32(arrayLength(&s.items)), w[i]) + f32(s.count + s.items[2].n);
}`;
  const g = translateWGSL({ vertex: { source }, fragment: { source } }).fragment;
  assert.deepEqual(
    g.storage.map(({ group, binding, minSize, access }) => ({ group, binding, minSize, access })),
    [
      { group: 1, binding: 2, minSize: 48, access: 'read' },
      { group: 0, binding: 0, minSize: 4, access: 'read' },
    ],
  );
  const [b] = g.storage;
  assert.match(g.source, new RegExp(`uniform highp usampler2D ${b.texture};`));
  // The row fetch clamps into the binding (info.y bytes) and adds its first row (info.x), width 1 << info.z.
  assert.match(
    g.source,
    /uvec4 _rf1_2\(int r\) \{ r = clamp\(r, 0, max\(\(\(_if1_2\.y \+ 15\) >> 4\) - 1, 0\)\) \+ _if1_2\.x; return texelFetch\(_df1_2, ivec2\(r & \(\(1 << _if1_2\.z\) - 1\), r >> _if1_2\.z\), 0\); \}/,
  );
  // arrayLength: (binding size - offset of items) / stride 32; the index into items is clamped to it.
  assert.match(g.source, /uint\(max\(\(_if1_2\.y - 16\) \/ 32, 0\)\)/);
  assert.match(g.source, /min\(.*uint\(max\(\(_if1_2\.y - 16\) \/ 32, 0\)\) - 1u\)/);
  assert.equal(g.uniforms.length, 0, 'no uniform blocks');
  // w[i] is a word with a dynamic component: selected with static swizzles, never v[o & 3] (ANGLE's Direct3D back end
  // emulates a dynamic vector index per use, and a shader with many failed at its first draw).
  assert.doesNotMatch(g.source, /\[o & 3\]/);
  assert.match(
    g.source,
    /int c = o & 3; return uintBitsToFloat\(\(c < 2 \? \(c == 0 \? v\.x : v\.y\) : \(c == 2 \? v\.z : v\.w\)\)\);/,
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
