// The WGSL front end, one language feature at a time: tokens, template lists, every statement and declaration,
// types and layout, the Load Rule, abstract numbers, constant folding, built-ins, entry points; and for each rule a
// broken input that fails with the right code, line and column.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWGSL, parseWGSL, WGSLError, wgslAlignOf, wgslSizeOf, wgslTypeName } from '../dist/wgsl.js';

const FRAG = '@fragment fn main() -> @location(0) vec4f { return vec4f(1); }';
const ok = (src) => checkWGSL(src);
/** Fails with `code` at `line`:`column` and a message matching `re`. */
function bad(src, code, line, column, re) {
  assert.throws(
    () => checkWGSL(src),
    (e) => {
      assert.ok(e instanceof WGSLError, `expected WGSLError, got ${e}`);
      assert.equal(e.code, code, e.message);
      if (line !== undefined) assert.equal(e.line, line, `line: ${e.message}`);
      if (column !== undefined) assert.equal(e.column, column, `column: ${e.message}`);
      if (re) assert.match(e.message, re);
      assert.match(e.message, /see https:\/\/margoengine\.com\/errors#wgsl-(syntax|type|limit)$/);
      return true;
    },
  );
}
/** The type of `expr` inside a function body (after `prelude` at module scope). */
function typeOf(expr, prelude = '') {
  const m = ok(`${prelude}\nfn probe() { let x = ${expr}; }`);
  const fn = m.functions.find((f) => f.name === 'probe');
  return wgslTypeName(fn.body[0].local.type);
}
/** The folded value of a module-scope const. */
function constValue(expr, prelude = '') {
  const m = ok(`${prelude}\nconst probe = ${expr};`);
  const c = m.globals.find((g) => g.name === 'probe');
  return { value: c.value, type: wgslTypeName(c.type) };
}

test('comments: line, block and nested block comments; an unclosed one is a syntax error at its start', () => {
  ok(`// line\n/* block /* nested */ still comment */ ${FRAG}`);
  bad(`${FRAG}\n  /* open /* nested */`, 'syntax', 2, 3, /never closed/);
});

test('numeric literals: decimal, hex, floats, exponents, hex floats and suffixes', () => {
  assert.deepEqual(constValue('1'), { value: 1, type: 'abstract-int' });
  assert.deepEqual(constValue('0x1Fu'), { value: 31, type: 'u32' });
  assert.deepEqual(constValue('-7i'), { value: -7, type: 'i32' });
  assert.deepEqual(constValue('1.5'), { value: 1.5, type: 'abstract-float' });
  assert.deepEqual(constValue('.25f'), { value: 0.25, type: 'f32' });
  assert.deepEqual(constValue('1e3'), { value: 1000, type: 'abstract-float' });
  assert.deepEqual(constValue('2.f'), { value: 2, type: 'f32' });
  assert.deepEqual(constValue('0x1p4'), { value: 16, type: 'abstract-float' });
  assert.deepEqual(constValue('0x1.8p1'), { value: 3, type: 'abstract-float' });
  assert.deepEqual(constValue('0f'), { value: 0, type: 'f32' });
  assert.equal(constValue('0.1f').value, Math.fround(0.1));
  bad('const a = 012;', 'syntax', 1, 11, /leading zero/);
  bad('const a = 1x;', 'syntax', 1, 11, /Malformed number/);
  bad('const a = 3000000000i;', 'type', 1, 11, /does not fit in i32/);
  bad('const a = 1e39f;', 'type', 1, 11, /not a finite f32/);
});

test('identifiers: Unicode names, reserved words and double underscores', () => {
  ok(`const Δx = 1; const _a = 2; ${FRAG}`);
  bad('const mod = 1;', 'syntax', 1, 7, /reserved word/);
  bad('const __x = 1;', 'syntax', 1, 7, /two underscores/);
  bad('const fn = 1;', 'syntax', 1, 7, /keyword/);
});

test('template lists are told apart from comparisons and shifts', () => {
  assert.equal(typeOf('array<vec2<f32>, 2>()'), 'array<vec2<f32>, 2>');
  assert.equal(typeOf('vec2<i32>(1) >> vec2u(1)'), 'vec2<i32>');
  assert.equal(typeOf('a < b && c > d', 'const a = 1; const b = 2; const c = 3; const d = 1;'), 'bool');
  assert.equal(typeOf('select(1, 2, a<b)', 'const a = 1; const b = 2;'), 'i32');
  assert.equal(typeOf('(a<b) == (c>d)', 'const a = 1; const b = 2; const c = 3; const d = 1;'), 'bool');
  assert.equal(typeOf('1 << 2u'), 'i32');
  assert.equal(typeOf('a <= b', 'const a = 1; const b = 2;'), 'bool');
  ok('var<private> v: array<array<f32, 2>, 3>;\nfn f() { let x: vec2<f32>= vec2(1.0); }');
});

test('operator rules: no mixed bitwise chains, no chained comparisons, shifts take unary operands', () => {
  bad('const a = 1 & 2 | 3;', 'syntax', 1, 17, /parentheses/);
  bad('const a = 1 < 2 < 3;', 'syntax', 1, 17, /chained/);
  bad('const a = 1 << 2 + 3;', 'syntax', 1, 18, /parentheses/);
  bad('const a = true && false || true;', 'syntax', 1, 25, /parentheses/);
  assert.deepEqual(constValue('(1 & 3) | 4'), { value: 5, type: 'abstract-int' });
  assert.deepEqual(constValue('2 + 3 * 4 - 6 / 2'), { value: 11, type: 'abstract-int' });
  assert.deepEqual(constValue('-7 / 2'), { value: -3, type: 'abstract-int' });
  assert.deepEqual(constValue('-7 % 3'), { value: -1, type: 'abstract-int' });
});

test('scalar, vector and matrix types and their predeclared aliases', () => {
  assert.equal(typeOf('vec3f(1)'), 'vec3<f32>');
  assert.equal(typeOf('vec4i(1)'), 'vec4<i32>');
  assert.equal(typeOf('vec2u()'), 'vec2<u32>');
  assert.equal(typeOf('vec3(1, 2, 3)'), 'vec3<i32>');
  assert.equal(typeOf('vec3(1, 2.0, 3)'), 'vec3<f32>');
  assert.equal(typeOf('mat2x3f()'), 'mat2x3<f32>');
  assert.equal(typeOf('mat2x2(1.0, 0.0, 0.0, 1.0)'), 'mat2x2<f32>');
  assert.equal(typeOf('mat3x3<f32>(vec3f(1), vec3f(2), vec3f(3))'), 'mat3x3<f32>');
  assert.equal(typeOf('vec4(vec2(1.0), 2.0, 3.0)'), 'vec4<f32>');
  assert.equal(typeOf('vec4f(vec3f(1), 1)'), 'vec4<f32>');
  bad('fn f() { let x = vec3f(1, 2); }', 'type', 1, 18, /needs 3 components, got 2/);
  bad('fn f() { let x: vec3<bool> = vec3(1.0); }', 'type', 1, 30, /Expected vec3<bool>/);
  bad('fn f() { let x = mat2x2<i32>(); }', 'type', 1, 18, /f32 or f16/);
  bad('fn f() { let x: f16 = 1.0; }', 'type', 1, 17, /enable f16/);
  ok('enable f16;\nfn f() { let x: f16 = 1.0h; let y = vec2h(x); }');
});

test('conversions: value conversion between scalars and splat of vectors', () => {
  assert.deepEqual(constValue('i32(2.9)'), { value: 2, type: 'i32' });
  assert.deepEqual(constValue('i32(-2.9)'), { value: -2, type: 'i32' });
  assert.deepEqual(constValue('u32(-1i)'), { value: 4294967295, type: 'u32' });
  assert.deepEqual(constValue('i32(4294967295u)'), { value: -1, type: 'i32' });
  assert.deepEqual(constValue('f32(true)'), { value: 1, type: 'f32' });
  assert.deepEqual(constValue('bool(0)'), { value: false, type: 'bool' });
  assert.deepEqual(constValue('vec2<u32>(vec2i(-1, 2))'), { value: [4294967295, 2], type: 'vec2<u32>' });
  assert.deepEqual(constValue('bitcast<u32>(1.0f)'), { value: 0x3f800000, type: 'u32' });
  assert.deepEqual(constValue('bitcast<f32>(0x40000000u)'), { value: 2, type: 'f32' });
});

test('arrays: fixed size from a const, runtime size in storage, override size in workgroup memory', () => {
  const m = ok(`
    const N = 4u;
    override M: u32 = 8;
    struct Item { v: vec4f }
    @group(0) @binding(0) var<storage, read> items: array<Item>;
    var<workgroup> tile: array<f32, M>;
    var<private> fixed: array<i32, N>;
    @compute @workgroup_size(M) fn main() { tile[0] = items[0].v.x + f32(arrayLength(&items)) + f32(fixed[1]); }`);
  const g = Object.fromEntries(m.globals.map((x) => [x.name, x]));
  assert.equal(wgslTypeName(g.items.type), 'array<Item>');
  assert.equal(wgslTypeName(g.tile.type), 'array<f32, M>');
  assert.equal(wgslTypeName(g.fixed.type), 'array<i32, 4>');
  assert.equal(typeOf('array(1, 2, 3)'), 'array<i32, 3>');
  assert.equal(typeOf('array(1, 2.5)'), 'array<f32, 2>');
  bad('var<private> a: array<f32, 0>;', 'type', 1, 28, /1 or more/);
  bad('fn f() { var a: array<f32, 2>; let b = a[2]; }', 'type', 1, 42, /out of bounds/);
  bad('struct S { a: array<f32>, b: f32 }', 'type', 1, 15, /last member/);
});

test('struct layout follows the WGSL alignment and size rules, with @align and @size', () => {
  const m = ok(`
    struct A { a: f32, b: vec3f, c: vec2f, d: mat3x3f, e: array<vec3f, 2>, f: u32 }
    struct B { @align(16) x: f32, @size(12) y: f32, z: A }
    @group(0) @binding(0) var<uniform> u: B;
    ${FRAG}`);
  const a = m.structs.find((s) => s.name === 'A'),
    b = m.structs.find((s) => s.name === 'B');
  assert.deepEqual(
    a.members.map((x) => x.offset),
    [0, 16, 32, 48, 96, 128],
  );
  assert.equal(a.size, 144);
  assert.equal(a.align, 16);
  assert.deepEqual(
    b.members.map((x) => x.offset),
    [0, 4, 16],
  );
  assert.equal(b.size, 160);
  assert.equal(wgslAlignOf(a.members[3].type), 16);
  assert.equal(wgslSizeOf(a.members[3].type), 48);
  bad('struct S { @align(3) a: f32 }', 'type', 1, 12, /power of two/);
  bad('struct S { @size(2) a: f32 }', 'type', 1, 12, /smaller than f32/);
  bad('struct S { a: f32, a: i32 }', 'type', 1, 20, /two members named 'a'/);
  bad('struct S { s: S }', 'type', 1, 8, /refers to itself/);
});

test('atomics live in storage or workgroup memory and are used through the atomic built-ins', () => {
  ok(`
    struct Counters { hits: atomic<u32>, misses: atomic<i32> }
    @group(0) @binding(0) var<storage, read_write> counters: Counters;
    var<workgroup> local: atomic<u32>;
    @compute @workgroup_size(64) fn main() {
      let old = atomicAdd(&counters.hits, 1u);
      atomicStore(&local, old);
      let r = atomicCompareExchangeWeak(&counters.misses, 0, 1);
      if (r.exchanged) { atomicMax(&counters.misses, r.old_value); }
      _ = atomicLoad(&local);
    }`);
  bad('var<private> a: atomic<u32>;', 'type', 1, 17, /storage or workgroup/);
  bad(
    '@group(0) @binding(0) var<storage, read_write> c: atomic<u32>;\nfn f() { let x = c; }',
    'type',
    2,
    18,
    /atomicLoad/,
  );
  bad('@group(0) @binding(0) var<storage> c: atomic<u32>;\nfn f() { atomicAdd(&c, 1u); }', 'type', 2, 10, /read-only/);
});

test('textures, samplers and storage textures, with the texture built-ins', () => {
  ok(`
    @group(0) @binding(0) var color: texture_2d<f32>;
    @group(0) @binding(1) var layers: texture_2d_array<f32>;
    @group(0) @binding(2) var cube: texture_cube<f32>;
    @group(0) @binding(3) var depth: texture_depth_2d;
    @group(0) @binding(4) var shadow: texture_depth_2d_array;
    @group(0) @binding(5) var samp: sampler;
    @group(0) @binding(6) var cmp: sampler_comparison;
    @group(0) @binding(7) var ms: texture_multisampled_2d<f32>;
    @group(0) @binding(8) var volume: texture_3d<f32>;
    @group(0) @binding(9) var ids: texture_2d<u32>;
    @fragment fn main(@builtin(position) p: vec4f) -> @location(0) vec4f {
      let uv = p.xy / vec2f(textureDimensions(color));
      var c = textureSample(color, samp, uv) + textureSampleLevel(layers, samp, uv, 1, 0.0);
      c += textureSampleBias(cube, samp, vec3f(1), 0.5) + textureSampleGrad(color, samp, uv, vec2f(0), vec2f(0));
      c += textureGather(1, color, samp, uv) + textureGather(depth, samp, uv) + textureGatherCompare(depth, cmp, uv, 0.5);
      let s = textureSampleCompare(depth, cmp, uv, 0.5) + textureSampleCompareLevel(shadow, cmp, uv, 2, 0.5);
      let l = textureLoad(color, vec2i(p.xy), 0) + textureLoad(ms, vec2u(p.xy), 0) + textureSampleLevel(volume, samp, vec3f(uv, 0), 0);
      let d = textureLoad(depth, vec2i(0), 0) + f32(textureNumLevels(color) + textureNumLayers(layers) + textureNumSamples(ms));
      let n = textureLoad(ids, vec2i(0), 0).x;
      return c + l + vec4f(s + d + f32(n)) + textureSample(color, samp, uv, vec2i(1, -1));
    }`);
  ok(`
    @group(0) @binding(0) var out: texture_storage_2d<rgba16float, write>;
    @group(0) @binding(1) var acc: texture_storage_2d_array<r32uint, read_write>;
    @compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
      textureStore(out, id.xy, vec4f(1));
      let v = textureLoad(acc, id.xy, 0);
      textureStore(acc, id.xy, 0, v + vec4u(1));
    }`);
  bad(
    '@group(0) @binding(0) var t: texture_2d<f32>;\n@group(0) @binding(1) var s: sampler;\n@compute @workgroup_size(1) fn c() { _ = textureSample(t, s, vec2f(0)); }',
    'type',
    3,
    1,
    /fragment-only/,
  );
  bad(
    '@group(0) @binding(0) var t: texture_storage_2d<rgba8unorm, read>;\nfn f() { textureStore(t, vec2i(0), vec4f(0)); }',
    'type',
    2,
    10,
    /read-only/,
  );
  bad('@group(0) @binding(0) var t: texture_storage_2d<rgb8unorm, write>;', 'type', 1, 30, /<format, access>/);
  bad(
    '@group(0) @binding(0) var t: texture_2d<f32>;\nfn f() { let x = textureLoad(t, vec2f(0), 0); }',
    'type',
    2,
    18,
    /integer coordinates/,
  );
  bad('var t: texture_2d<f32>;', 'type', 1, 1, /@group and @binding/);
});

test('address spaces and access modes; the Load Rule; pointers and references', () => {
  const m = ok(`
    struct U { m: mat4x4f, tint: vec4f }
    @group(0) @binding(0) var<uniform> u: U;
    @group(0) @binding(1) var<storage, read_write> data: array<f32>;
    var<private> counter: i32 = 3;
    fn bump(p: ptr<function, i32>) { *p += 1; }
    fn first(p: ptr<storage, array<f32>, read_write>) -> f32 { return p[0] + (*p)[1]; }
    @compute @workgroup_size(1) fn main() {
      var local = counter;
      bump(&local);
      let p = &local;
      *p = *p * 2;
      data[0] = first(&data) + u.tint.x + u.m[1][2];
      counter++;
    }`);
  const v = m.globals.find((g) => g.name === 'data');
  assert.equal(v.space, 'storage');
  assert.equal(v.access, 'read_write');
  assert.equal(m.globals.find((g) => g.name === 'u').access, 'read');
  bad('@group(0) @binding(0) var<uniform> u: vec4f;\nfn f() { u = vec4f(0); }', 'type', 2, 10, /read-only/);
  bad('fn f() { let a = 1; a = 2; }', 'type', 1, 21, /Only variables/);
  bad('var<function> v: f32;', 'type', 1, 5, /'function' address space/);
  bad('var v: f32;', 'type', 1, 1, /needs an address space/);
  bad('fn f() { var<private> v: f32; }', 'type', 1, 14, /'function' address space/);
  bad('fn f() { var v: f32; let q = &v.x; }', 'type', 1, 33, /no members/);
  bad('fn f() { var v: vec2f; let q = &v.x; }', 'type', 1, 33, /vector component/);
  bad('@group(0) @binding(0) var<uniform> u: array<f32>;', 'type', 1, 39, /runtime-sized/);
  bad('@group(0) @binding(0) var<storage> s: bool;', 'type', 1, 39, /host-shareable/);
});

test('const, let, var and override: initializers, types, folding and @id', () => {
  const m = ok(`
    const SCALE = 2.0 * 3;
    const AXES = vec3(1, 0, 0) * 2;
    @id(7) override threshold: f32 = SCALE / 4.0;
    override enabled = true;
    ${FRAG}`);
  const g = Object.fromEntries(m.globals.map((x) => [x.name, x]));
  assert.equal(g.SCALE.value, 6);
  assert.equal(wgslTypeName(g.SCALE.type), 'abstract-float');
  assert.deepEqual(g.AXES.value, [2, 0, 0]);
  assert.equal(g.threshold.id, 7);
  assert.equal(g.threshold.init.value, 1.5);
  assert.equal(wgslTypeName(g.enabled.type), 'bool');
  assert.equal(typeOf('SCALE', 'const SCALE = 2.0;'), 'f32');
  bad('fn f() -> f32 { return 1.0; }\nconst c = f();', 'type', 2, 11, /constant expression/);
  bad('let x = 1;', 'syntax', 1, 1, /module scope/);
  bad('fn f() { let x; }', 'syntax', 1, 15, /initializer/);
  bad('override o: vec2f;', 'type', 1, 13, /scalar/);
  bad('const a = b; const b = a;', 'type', 1, 7, /depends on itself/);
  bad('fn f() { let x = 1; let x = 2; }', 'type', 1, 25, /already declared/);
  ok('fn f() { let x = 1; { let x = 2.0; } }');
});

test('control flow: if, switch, loop with continuing and break if, for, while, break, continue', () => {
  const m = ok(`
    fn f(n: i32) -> i32 {
      var total = 0;
      for (var i = 0; i < n; i++) { if i % 2 == 0 { continue; } total += i; }
      var j = 0u;
      while j < 4u { j += 1u; }
      loop {
        total -= 1;
        if total < 0 { break; }
        continuing { total -= 1; break if total < 10; }
      }
      switch n {
        case 1, 2: { return 1; }
        case 3, default: { total = 3; }
      }
      switch u32(n) { case 0u: {} default: { return 2; } }
      if n > 5 { return total; } else if n > 2 { return 0; } else { return -1; }
    }
    ${FRAG}`);
  const kinds = m.functions[0].body.map((s) => s.kind);
  assert.deepEqual(kinds, ['decl', 'for', 'decl', 'while', 'loop', 'switch', 'switch', 'if']);
  bad('fn f() { break; }', 'type', 1, 10, /inside a loop or switch/);
  bad('fn f() { continue; }', 'type', 1, 10, /inside a loop/);
  bad('fn f() { loop { continuing { return; } } }', 'type', 1, 30, /cannot return/);
  bad('fn f() { loop { continuing { break; } } }', 'type', 1, 30, /break if/);
  bad('fn f() { if (1) {} }', 'type', 1, 13, /must be bool/);
  bad('fn f(x: i32) { switch x { case 1: {} } }', 'type', 1, 16, /default/);
  bad('fn f(x: i32) { switch x { case 1, 1: {} default: {} } }', 'type', 1, 35, /twice/);
  bad('fn f(x: f32) { switch x { default: {} } }', 'type', 1, 23, /i32 or u32/);
  bad('fn f() { loop { break if true; } }', 'syntax', 1, 17, /continuing/);
});

test('functions: returns on every path, argument checks, no recursion, no calls to entry points', () => {
  ok('fn f(x: f32) -> f32 { if x > 0 { return 1.0; } else { return 2.0; } }');
  ok('fn f() -> i32 { loop { } }');
  ok('fn f(x: i32) -> i32 { switch x { default: { return 1; } } }');
  bad('fn f(x: f32) -> f32 { if x > 0 { return 1.0; } }', 'type', 1, 48, /every path/);
  bad('fn f() -> f32 { loop { break; } }', 'type', 1, 33, /every path/);
  bad('fn f() { return 1; }', 'type', 1, 17, /returns nothing/);
  bad('fn f() -> i32 { return; }', 'type', 1, 17, /must return/);
  bad('fn g(a: i32) {}\nfn f() { g(1, 2); }', 'type', 2, 10, /takes 1 argument, got 2/);
  bad('fn g(a: i32) {}\nfn f() { g(1.5); }', 'type', 2, 12, /Expected i32, got abstract-float/);
  bad('fn a() { b(); }\nfn b() { a(); }', 'type', 1, 1, /recursion/);
  bad(`${FRAG}\nfn f() { _ = main(); }`, 'type', 2, 14, /entry point/);
  bad('fn f() {}\nfn f() {}', 'type', 2, 4, /declared twice/);
  bad('fn f() { g(); }', 'type', 1, 10, /Unknown function 'g'/);
  bad('fn f() { let x = y; }', 'type', 1, 18, /Unknown name 'y'/);
});

test('built-in functions: overloads, abstract arguments and folding', () => {
  assert.equal(typeOf('max(1, 2.5)'), 'f32');
  assert.equal(typeOf('clamp(vec3f(2), vec3(0.0), vec3(1.0))'), 'vec3<f32>');
  assert.equal(typeOf('dot(vec3f(1), vec3f(2))'), 'f32');
  assert.equal(typeOf('length(vec2f(3, 4))'), 'f32');
  assert.equal(typeOf('mix(vec3f(0), vec3f(1), 0.5)'), 'vec3<f32>');
  assert.equal(typeOf('select(0, 1, true)'), 'i32');
  assert.equal(typeOf('select(vec2f(0), vec2f(1), vec2(true, false))'), 'vec2<f32>');
  assert.equal(typeOf('modf(1.5).whole'), 'f32');
  assert.equal(typeOf('frexp(vec2f(1)).exp'), 'vec2<i32>');
  assert.equal(typeOf('transpose(mat2x3f())'), 'mat3x2<f32>');
  assert.equal(typeOf('unpack4x8unorm(0u)'), 'vec4<f32>');
  assert.equal(typeOf('pack2x16float(vec2f(1))'), 'u32');
  assert.equal(typeOf('countOneBits(vec2u(3))'), 'vec2<u32>');
  assert.equal(typeOf('extractBits(5i, 0u, 2u)'), 'i32');
  assert.equal(typeOf('all(vec3(true))'), 'bool');
  assert.deepEqual(constValue('max(1, 2.5)'), { value: 2.5, type: 'abstract-float' });
  assert.deepEqual(constValue('clamp(5, 0, 3)'), { value: 3, type: 'abstract-int' });
  assert.deepEqual(constValue('cross(vec3(1.0, 0, 0), vec3(0.0, 1, 0))'), {
    value: [0, 0, 1],
    type: 'vec3<abstract-float>',
  });
  assert.deepEqual(constValue('round(2.5)'), { value: 2, type: 'abstract-float' });
  assert.deepEqual(constValue('round(3.5)'), { value: 4, type: 'abstract-float' });
  assert.equal(constValue('determinant(mat2x2(2.0, 0, 0, 3.0))').value, 6);
  assert.deepEqual(constValue('modf(-1.5)'), { value: [-0.5, -1], type: '__modf_result_abstract' });
  assert.deepEqual(constValue('frexp(12.0)'), { value: [0.75, 4], type: '__frexp_result_abstract' });
  assert.deepEqual(constValue('frexp(vec2(0.0, -0.25))').value, [
    [0, -0.5],
    [0, -1],
  ]);
  assert.equal(typeOf('frexp(1.5).exp'), 'i32');
  assert.equal(typeOf('modf(vec2(1.5))'), '__modf_result_vec2_f32');
  assert.deepEqual(constValue('reflect(vec2(1.0, -1.0), vec2(0.0, 1.0))').value, [1, 1]);
  assert.deepEqual(constValue('faceForward(vec2(1.0), vec2(0.0, 1.0), vec2(0.0, 1.0))').value, [-1, -1]);
  assert.equal(constValue('abs(-2147483647i - 1i)').value, -2147483648);
  assert.equal(typeOf('refract(vec2f(1), vec2f(0, 1), 0.5)'), 'vec2<f32>');
  bad('const a = sqrt(-1.0);', 'type', 1, 11, /not finite/);
  bad('fn f() { let x = dot(1.0, 2.0); }', 'type', 1, 18, /two vectors/);
  bad('fn f() { let x = cross(vec2f(1), vec2f(1)); }', 'type', 1, 18, /vec3/);
  bad('fn f() { let x = abs(); }', 'type', 1, 18, /takes 1 argument/);
  bad('fn f() { let x = max<f32>(1.0, 2.0); }', 'type', 1, 18, /template/);
  bad('fn f() { workgroupBarrier(); }\n@fragment fn m() { f(); }', 'type', 2, 1, /compute-only/);
});

test('operators: vector and matrix arithmetic, comparisons, bitwise, shifts and overflow', () => {
  assert.equal(typeOf('vec3f(1) * 2.0'), 'vec3<f32>');
  assert.equal(typeOf('2 * vec3f(1)'), 'vec3<f32>');
  assert.equal(typeOf('mat4x4f() * vec4f(1)'), 'vec4<f32>');
  assert.equal(typeOf('vec3f(1) * mat4x3f()'), 'vec4<f32>');
  assert.equal(typeOf('mat2x3f() * mat4x2f()'), 'mat4x3<f32>');
  assert.equal(typeOf('vec2f(1) < vec2f(2)'), 'vec2<bool>');
  assert.equal(typeOf('vec2u(1) & vec2u(3)'), 'vec2<u32>');
  assert.equal(typeOf('vec2u(1) << vec2u(3)'), 'vec2<u32>');
  assert.equal(typeOf('!vec2(true)'), 'vec2<bool>');
  assert.equal(typeOf('~1u'), 'u32');
  assert.deepEqual(constValue('mat2x2(1.0, 2, 3, 4) * vec2(1.0, 1)'), { value: [4, 6], type: 'vec2<abstract-float>' });
  assert.deepEqual(constValue('0xFFu ^ 0x0Fu'), { value: 0xf0, type: 'u32' });
  assert.deepEqual(constValue('1u << 31u'), { value: 2147483648, type: 'u32' });
  bad('const a = 2147483647i + 1i;', 'type', 1, 11, /does not fit in i32/);
  bad('const a = 1i / 0i;', 'type', 1, 11, /division by zero/);
  bad('const a = 1u << 32u;', 'type', 1, 17, /not less than 32/);
  bad('const a = 1 << -1;', 'type', 1, 11, /negative/);
  bad('const a = array<f32, 70000>();', 'limit', 1, 11, /over the 65536/);
  bad('const a = array<array<f32, 300>, 300>();', 'limit', 1, 11, /90000 values/);
  bad('fn f() { let x = -1u; }', 'type', 1, 18, /signed/);
  bad('fn f() { let x = vec2f(1) + vec3f(1); }', 'type', 1, 18, /cannot combine/);
  bad('fn f() { let x = true + 1; }', 'type', 1, 18, /cannot combine/);
  bad('fn f() { let x = vec2f(1) == 1.0; }', 'type', 1, 18, /cannot combine/);
});

test('swizzles and member access: read, write a single component, and mixed sets fail', () => {
  assert.equal(typeOf('vec4f(1).zyx'), 'vec3<f32>');
  assert.equal(typeOf('vec4f(1).rg'), 'vec2<f32>');
  assert.deepEqual(constValue('vec4(1, 2, 3, 4).wx'), { value: [4, 1], type: 'vec2<abstract-int>' });
  ok('fn f() { var v = vec3f(0); v.y = 1.0; v[2] = 2.0; }');
  bad('fn f() { let v = vec4f(1).xg; }', 'type', 1, 27, /swizzle/);
  bad('fn f() { let v = vec2f(1).z; }', 'type', 1, 27, /swizzle/);
  bad('struct S { a: f32 }\nfn f() { let s = S(1.0); let b = s.b; }', 'type', 2, 36, /no member 'b'/);
});

test('entry points: interfaces, built-in values, locations, interpolation and stage rules', () => {
  const m = ok(`
    struct VOut { @builtin(position) p: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) id: u32 }
    @vertex fn vs(@builtin(vertex_index) i: u32, @location(0) pos: vec3f) -> VOut {
      return VOut(vec4f(pos, 1), vec2f(0), i);
    }
    struct FOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }
    @fragment fn fs(v: VOut, @builtin(front_facing) front: bool) -> FOut { if !front { discard; } return FOut(vec4f(v.uv, 0, 1), 0.5); }
    @compute @workgroup_size(8, 4, 1) fn cs(@builtin(local_invocation_index) li: u32) {}`);
  assert.deepEqual(
    m.entryPoints.map((e) => [e.name, e.stage]),
    [
      ['vs', 'vertex'],
      ['fs', 'fragment'],
      ['cs', 'compute'],
    ],
  );
  assert.deepEqual(m.functions.find((f) => f.name === 'cs').workgroupSize, [8, 4, 1]);
  bad('@vertex fn v() -> @location(0) vec4f { return vec4f(0); }', 'type', 1, 12, /@builtin\(position\)/);
  bad('@compute fn c() {}', 'type', 1, 13, /@workgroup_size/);
  bad('@fragment fn f(x: vec4f) -> @location(0) vec4f { return x; }', 'type', 1, 16, /@location or @builtin/);
  bad(
    '@fragment fn f(@builtin(vertex_index) i: u32) -> @location(0) vec4f { return vec4f(0); }',
    'type',
    1,
    16,
    /not a fragment input/,
  );
  bad(
    '@vertex fn v(@builtin(vertex_index) i: f32) -> @builtin(position) vec4f { return vec4f(0); }',
    'type',
    1,
    14,
    /must have type u32/,
  );
  bad(
    '@vertex fn v() -> VOut { return VOut(); }\nstruct VOut { @builtin(position) p: vec4f, @location(0) n: i32 }',
    'type',
    1,
    19,
    /flat/,
  );
  bad('fn helper() { discard; }\n@compute @workgroup_size(1) fn c() { helper(); }', 'type', 2, 1, /fragment-only/);
  bad('var<workgroup> w: f32;\n@fragment fn f() -> @location(0) vec4f { return vec4f(w); }', 'type', 2, 1, /workgroup/);
  bad('@compute @workgroup_size(0) fn c() {}', 'type', 1, 26, /1 or more/);
});

test('resources: @group and @binding on resources only, and every entry point lists what it reaches', () => {
  const m = ok(`
    @group(0) @binding(0) var<uniform> a: vec4f;
    @group(1) @binding(3) var<storage, read> b: array<u32>;
    @group(0) @binding(1) var t: texture_2d<f32>;
    fn useB() -> u32 { return b[0]; }
    @fragment fn f() -> @location(0) vec4f { return a + vec4f(f32(useB())); }
    @compute @workgroup_size(1) fn c() { _ = textureLoad(t, vec2i(0), 0); }`);
  const names = (n) =>
    m.entryPoints
      .find((e) => e.name === n)
      .globals.map((g) => g.name)
      .sort();
  assert.deepEqual(names('f'), ['a', 'b']);
  assert.deepEqual(names('c'), ['t']);
  assert.deepEqual([m.globals[1].group, m.globals[1].binding], [1, 3]);
  bad('@group(0) @binding(0) var<private> p: f32;', 'type', 1, 1, /Only resources/);
  bad('@group(0) var<uniform> u: f32;', 'type', 1, 1, /@group and @binding/);
  bad('@binding(-1) @group(0) var<uniform> u: f32;', 'type', 1, 1, /0 or more/);
  const twice = '@group(0) @binding(0) var<uniform> a: f32;\n@group(0) @binding(0) var<uniform> b: f32;\n';
  bad(
    `${twice}@fragment fn f() -> @location(0) vec4f { return vec4f(a + b); }`,
    'type',
    3,
    1,
    /both at @group\(0\) @binding\(0\)/,
  );
  // Each entry point reaches one of them only, which WGSL allows.
  ok(
    `${twice}@fragment fn f() -> @location(0) vec4f { return vec4f(a); }\n@fragment fn g() -> @location(0) vec4f { return vec4f(b); }`,
  );
});

test('directives: enable, requires and diagnostic must come first', () => {
  const m = ok(
    `enable f16;\nrequires readonly_and_readwrite_storage_textures;\ndiagnostic(off, derivative_uniformity);\n${FRAG}`,
  );
  assert.deepEqual(m.enables, ['f16']);
  assert.deepEqual(m.requires, ['readonly_and_readwrite_storage_textures']);
  ok(`@diagnostic(off, derivative_uniformity) ${FRAG}`);
  bad(`${FRAG}\nenable f16;`, 'syntax', 2, 1, /before every declaration/);
});

test('const_assert at module and function scope', () => {
  ok(`const N = 4; const_assert N > 2; fn f() { const_assert N * 2 == 8; } ${FRAG}`);
  bad('const_assert 1 > 2;', 'type', 1, 14, /failed/);
  bad('fn f(x: i32) { const_assert x > 0; }', 'type', 1, 29, /constant bool/);
});

test('aliases resolve to their types, in any declaration order', () => {
  const m = ok(
    `alias Color = vec4<f32>; alias Palette = array<Color, 2>;\nfn f(p: Palette) -> Color { return p[1]; }\n${FRAG}`,
  );
  assert.equal(wgslTypeName(m.functions[0].returnType), 'vec4<f32>');
  ok(`fn f() -> Later { return Later(1.0); }\nstruct Later { v: f32 }`);
  bad('alias A = B; alias B = A;', 'type', 1, 7, /refers to itself/);
  bad('alias A = vec3<f32>; fn f() { let a = A; }', 'type', 1, 39, /type, not a value/);
});

test('positions are 1-based lines and columns in code points, after CRLF line breaks and astral characters', () => {
  bad('// \u{1F600}\r\nfn f() {\r\n  let x = nope;\r\n}', 'type', 3, 11, /Unknown name 'nope'/);
  bad('const s = 1; /* \u{1F600} */ const t = bad;', 'type', 1, 32);
});

test('parseWGSL keeps every declaration with spans; non-string input is a TypeError', () => {
  const ast = parseWGSL(`struct S { a: f32 }\n${FRAG}`);
  assert.deepEqual(
    ast.declarations.map((d) => d.kind),
    ['struct', 'fn'],
  );
  assert.equal(ast.declarations[1].start, 20);
  assert.throws(() => parseWGSL(42), TypeError);
  assert.throws(() => checkWGSL(undefined), TypeError);
});

test('extractBits and insertBits: a constant offset + count past 32 bits is a shader-creation error', () => {
  // Regression (found by the M2 semantics probe, 2026-10-28): the front end accepted insertBits(x, y, 30u, 8u), which
  // Chrome's WGSL compiler rejects as the specification requires; a runtime offset or count stays valid (clamped).
  bad(
    'fn f(x: u32) -> u32 { return insertBits(x, x, 30u, 8u); }',
    'type',
    1,
    47,
    /offset 30 \+ count 8 is more than 32 bits/,
  );
  bad('fn f(x: i32) -> i32 { return extractBits(x, 16u, 17u); }', 'type', 1, 45, /offset 16 \+ count 17/);
  ok(
    'fn f(x: u32, o: u32) -> u32 { return insertBits(x, x, o, 8u) + extractBits(x, 0u, 32u) + extractBits(x, o, 32u); }',
  );
});
