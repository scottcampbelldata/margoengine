// Fuzz and property tests of the WGSL front end. Fuzz: random token soup, mutated corpus shaders and nesting bombs
// either check or fail with a WGSLError whose code, line, column and offset agree; nothing else may escape, and every
// case ends quickly. Properties: constant folding of i32, u32 and f32 operators matches a reference evaluator, struct
// layouts keep the alignment rules, comments and line breaks change nothing, and randomly built typed expressions get
// the type they were built for. Seeded, so a failure repeats; the seed and the source are in the message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWGSL, parseWGSL, WGSLError, wgslAlignOf, wgslSizeOf } from '../dist/wgsl.js';
import { readCorpus } from './corpus/store.mjs';

/** mulberry32: a small public-domain PRNG, seeded so every run draws the same cases. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  return { next, int, pick: (list) => list[int(list.length)] };
}

const CODES = new Set(['syntax', 'type', 'limit']);
const BREAKS = new Set([10, 11, 12, 13, 0x85, 0x2028, 0x2029]);

/** Line and column of an offset, computed independently of the front end (WGSL line breaks, CR LF once). */
function position(text, offset) {
  let line = 1,
    start = 0;
  for (let i = 0; i < offset; i++) {
    const c = text.charCodeAt(i);
    if (c === 13 && text.charCodeAt(i + 1) === 10) continue;
    if (BREAKS.has(c)) {
      line++;
      start = i + 1;
    }
  }
  return { line, column: [...text.slice(start, offset)].length + 1 };
}

/** Checks `source`; it must pass or throw a well-formed WGSLError. Returns 'ok' or the error code. */
function contract(source, what) {
  const t0 = performance.now();
  let outcome = 'ok';
  try {
    checkWGSL(source);
  } catch (error) {
    if (!(error instanceof WGSLError))
      assert.fail(`${what}: threw ${error?.name}: ${error?.message}\n--- source ---\n${source.slice(0, 2000)}`);
    assert.ok(CODES.has(error.code), `${what}: unknown code ${error.code}`);
    assert.ok(error.offset >= 0 && error.offset <= source.length, `${what}: offset ${error.offset} outside the source`);
    const at = position(source, error.offset);
    assert.deepEqual({ line: error.line, column: error.column }, at, `${what}: position of ${error.message}`);
    assert.match(
      error.message,
      /\(line \d+, column \d+\); see https:\/\/margoengine\.com\/errors#wgsl-(syntax|type|limit)$/,
    );
    outcome = error.code;
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `${what}: took ${Math.round(ms)} ms`);
  return outcome;
}

const VOCABULARY = [
  ...'fn var let const override struct alias return if else loop continuing break continue for while switch case default discard true false enable requires diagnostic const_assert'.split(
    ' ',
  ),
  ...'@ ( ) { } [ ] < > <= >= == != = + - * / % & | ^ ~ ! && || << >> += -= <<= ++ -- -> , . : ; _'.split(' '),
  ...'vertex fragment compute workgroup_size group binding location builtin position interpolate flat id align size'.split(
    ' ',
  ),
  ...'f32 i32 u32 bool f16 vec2 vec3f vec4<f32> mat4x4f mat2x3<f32> array array<f32,4> ptr atomic<u32> texture_2d<f32> sampler texture_storage_2d<rgba8unorm,write>'.split(
    ' ',
  ),
  ...'private storage uniform workgroup function read read_write x y z main a b S'.split(' '),
  ...'1 0u 7i 2.5 1e3 .5f 0x1f 0x1p4 1.0h 4294967296u 1e40f 012 1x'.split(' '),
  ...'textureSample textureLoad select max dot atomicAdd arrayLength bitcast<u32> modf workgroupBarrier'.split(' '),
  'mod',
  '__x',
  'Δ',
  '/*',
  '*/',
  '//',
  '\n',
  '\r\n',
  ' ',
  '#',
  '"',
  '\u{1F600}',
];

test('random token soup: passes or fails with a coded, positioned error', { timeout: 60_000 }, () => {
  const r = rng(0x5eed);
  const seen = { ok: 0, syntax: 0, type: 0, limit: 0 };
  for (let i = 0; i < 3000; i++) {
    const n = 1 + r.int(48),
      parts = Array.from({ length: n }, () => r.pick(VOCABULARY));
    const soup = parts.join(r.next() < 0.3 ? '' : ' ');
    // A third go in bare, the rest inside a function or an entry point so the checker sees statements.
    const wrap = r.int(3);
    const source =
      wrap === 0 ? soup : wrap === 1 ? `fn f() { ${soup} }` : `@compute @workgroup_size(1) fn main() { ${soup}\n}`;
    seen[contract(source, `soup case ${i}`)]++;
  }
  assert.ok(seen.syntax > 0 && seen.ok > 0, JSON.stringify(seen));
});

const ATOMS = [
  'a',
  'b',
  'v',
  'm',
  'arr',
  's',
  'i',
  'x',
  '1',
  '2u',
  '-3i',
  '2.5',
  '0.5f',
  'true',
  '*p',
  'arrayLength(&buf)',
  'textureLoad(t, vec2i(0), 0)',
  'buf[i]',
  'nope',
];
const POSTFIX = ['.x', '.xy', '.zyx', '.q', '.y', '[0]', '[i]', '[5]'];
const BINARY = ['+', '-', '*', '/', '%', '<', '==', '!=', '&&', '||', '&', '|', '<<', '>>'];
const CALLS = [
  'vec3f',
  'vec2',
  'f32',
  'i32',
  'u32',
  'select',
  'max',
  'dot',
  'mix',
  'S',
  'array',
  'mat2x2f',
  'bitcast<u32>',
  'abs',
  'clamp',
  'f',
];

/** A random expression that is usually well formed but rarely well typed. */
function randomExpr(r, depth) {
  if (depth <= 0 || r.next() < 0.3) return r.pick(ATOMS) + (r.next() < 0.2 ? r.pick(POSTFIX) : '');
  switch (r.int(4)) {
    case 0:
      return `(${randomExpr(r, depth - 1)} ${r.pick(BINARY)} ${randomExpr(r, depth - 1)})`;
    case 1:
      return `${r.pick(['-', '!', '~'])}${randomExpr(r, depth - 1)}`;
    case 2:
      return `${r.pick(CALLS)}(${Array.from({ length: r.int(4) }, () => randomExpr(r, depth - 1)).join(', ')})`;
    default:
      return `(${randomExpr(r, depth - 1)})${r.pick(POSTFIX)}`;
  }
}

test('random expressions in a typed context reach the checker: they pass or fail with coded errors', {
  timeout: 60_000,
}, () => {
  const r = rng(0xe59);
  const seen = { ok: 0, syntax: 0, type: 0, limit: 0 };
  for (let i = 0; i < 3000; i++) {
    // One in ten loses or gains a token, so the parser's error paths run inside real statements too.
    const expr = () => {
      const e = randomExpr(r, 4);
      if (r.next() > 0.1) return e;
      const at = r.int(e.length);
      return e.slice(0, at) + (r.next() < 0.5 ? '' : ` ${r.pick(BINARY)} `) + e.slice(at + 1);
    };
    const source = `struct S { x: f32, y: vec2u }
@group(0) @binding(0) var<storage, read_write> buf: array<u32>;
@group(0) @binding(1) var t: texture_2d<f32>;
fn f(a: i32, b: f32, v: vec3f, m: mat2x2f, arr: array<i32, 4>, s: S, i: u32, p: ptr<function, f32>) -> f32 {
  let x = ${expr()};
  var y = ${expr()};
  if ${expr()} { y = ${expr()}; }
  return ${expr()};
}`;
    seen[contract(source, `expression case ${i}`)]++;
  }
  assert.ok(seen.type > 100 && seen.syntax > 100, JSON.stringify(seen));
});

const corpus = readCorpus().modules;

const EXTREMES = [
  '4294967296u',
  '2147483648i',
  '1e400',
  '1e39f',
  '0x',
  '-0i',
  '99999999999999999999',
  '0.0h',
  '1.',
  '0x1p',
];

/** One random edit of a source text. */
function mutate(source, r) {
  const at = r.int(source.length + 1),
    lines = source.split('\n');
  switch (r.int(8)) {
    case 0:
      return source.slice(0, at) + source.slice(at + 1 + r.int(20));
    case 1:
      return `${source.slice(0, at)} ${r.pick(VOCABULARY)} ${source.slice(at)}`;
    case 2: {
      const i = r.int(lines.length);
      lines.splice(i, 0, lines[i]);
      return lines.join('\n');
    }
    case 3: {
      const numbers = [...source.matchAll(/\b\d+(\.\d+)?[iuf]?\b/g)];
      if (!numbers.length) return source;
      const m = r.pick(numbers);
      return source.slice(0, m.index) + r.pick(EXTREMES) + source.slice(m.index + m[0].length);
    }
    case 4:
      return source.slice(0, at);
    case 5: {
      const i = r.int(lines.length),
        j = r.int(lines.length);
      [lines[i], lines[j]] = [lines[j], lines[i]];
      return lines.join('\n');
    }
    case 6: {
      const names = [...source.matchAll(/\b[A-Za-z_]\w*\b/g)];
      if (names.length < 2) return source;
      const m = r.pick(names);
      return source.slice(0, m.index) + r.pick(names)[0] + source.slice(m.index + m[0].length);
    }
    default: {
      const brackets = [...source.matchAll(/[{}()[\]<>]/g)];
      if (!brackets.length) return source;
      const m = r.pick(brackets);
      return source.slice(0, m.index) + source.slice(m.index + 1);
    }
  }
}

test('mutated corpus shaders: every edit passes or fails with a coded, positioned error', { timeout: 120_000 }, () => {
  const r = rng(0xc0ffee);
  let failed = 0;
  for (const m of corpus) {
    // Large modules get fewer mutations so the test stays a few seconds long.
    const rounds = m.bytes > 20_000 ? 1 : 3;
    for (let k = 0; k < rounds; k++) {
      let source = m.code;
      for (let edits = 1 + r.int(3); edits > 0; edits--) source = mutate(source, r);
      if (contract(source, `corpus ${m.key} (${m.package}) mutation ${k}`) !== 'ok') failed++;
    }
  }
  assert.ok(failed > corpus.length, `only ${failed} mutations were rejected; the mutations are too weak`);
});

test('nesting bombs and oversized input fail with limit or syntax errors, never a stack overflow', {
  timeout: 60_000,
}, () => {
  const deep = 100_000;
  const cases = {
    parentheses: `const a = ${'('.repeat(deep)}1${')'.repeat(deep)};`,
    blocks: `fn f() { ${'{'.repeat(deep)}${'}'.repeat(deep)} }`,
    unary: `const a = ${'-'.repeat(deep)}1;`,
    negations: `const a = ${'!'.repeat(deep)}true;`,
    sum: `const a = ${'1 + '.repeat(deep)}1;`,
    indexes: `fn f() { var a: array<f32, 1>; let x = a${'[0]'.repeat(deep)}; }`,
    members: `fn f() { let v = vec4f(1)${'.x'.repeat(deep)}; }`,
    templates: `alias A = ${'array<'.repeat(deep)}f32${'>'.repeat(deep)};`,
    ifs: `fn f() { ${'if true { '.repeat(deep)}${'} '.repeat(deep)} }`,
    calls: `const a = ${'abs('.repeat(deep)}1${')'.repeat(deep)};`,
    comments: `${'/*'.repeat(deep)}`,
    long: `const a = 1;${' '.repeat(4 * 1024 * 1024)}`,
  };
  for (const [name, source] of Object.entries(cases)) {
    const code = contract(source, name);
    assert.ok(code === 'limit' || code === 'syntax' || code === 'type', `${name}: ${code}`);
  }
  assert.equal(contract(cases.parentheses, 'parentheses'), 'limit');
  assert.equal(contract(cases.long, 'long'), 'limit');
  // Nesting inside the limits still checks.
  assert.equal(contract(`const a = ${'('.repeat(100)}1${')'.repeat(100)};`, 'shallow'), 'ok');
});

/** The folded value of `expr`, or the error code. */
function fold(expr) {
  try {
    return { value: checkWGSL(`const probe = ${expr};`).globals[0].value };
  } catch (error) {
    if (!(error instanceof WGSLError)) throw error;
    return { code: error.code, message: error.message };
  }
}

const I32_MIN = -(2n ** 31n),
  I32_MAX = 2n ** 31n - 1n,
  U32_MAX = 2n ** 32n - 1n;

/** Reference integer semantics for constant expressions (WGSL section 8.7): undefined means a creation error. */
function reference(op, a, b, signed) {
  const lo = signed ? I32_MIN : 0n,
    hi = signed ? I32_MAX : U32_MAX,
    fits = (x) => (x >= lo && x <= hi ? x : undefined),
    wrap = (x) => (signed ? BigInt.asIntN(32, x) : BigInt.asUintN(32, x));
  switch (op) {
    case '+':
      return fits(a + b);
    case '-':
      return fits(a - b);
    case '*':
      return fits(a * b);
    case '/':
      return b === 0n ? undefined : fits(a / b); // BigInt division truncates toward zero
    case '%':
      return b === 0n || (signed && a === I32_MIN && b === -1n) ? undefined : a % b;
    case '&':
      return wrap(a & b);
    case '|':
      return wrap(a | b);
    case '^':
      return wrap(a ^ b);
    case '<<':
      return b >= 32n ? undefined : fits(a << b);
    case '>>':
      return b >= 32n ? undefined : a >> b; // arithmetic for i32; a is non-negative for u32
    case '<':
      return a < b;
    case '==':
      return a === b;
  }
}

/** An integer drawn to hit the edges often: 0, plus or minus 1, the limits, powers of two and random values. */
function integer(r, signed) {
  const edges = signed
    ? [0n, 1n, -1n, 2n, I32_MIN, I32_MAX, -(2n ** 16n), 2n ** 30n]
    : [0n, 1n, 2n, U32_MAX, 2n ** 31n, 65535n];
  if (r.next() < 0.4) return r.pick(edges);
  const bits = 1 + r.int(32);
  const x = BigInt(Math.floor(r.next() * 2 ** bits));
  return signed ? BigInt.asIntN(32, x) : BigInt.asUintN(32, x);
}

test('i32 and u32 constant folding matches a reference evaluator, overflow and division by zero included', () => {
  const r = rng(0x1234);
  for (let i = 0; i < 3000; i++) {
    const signed = r.next() < 0.5,
      op = r.pick(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '<', '==']),
      shift = op === '<<' || op === '>>',
      a = integer(r, signed),
      b = shift ? BigInt(r.int(34)) : integer(r, signed);
    const lit = (x, s) => (x < 0n ? `(${x}${s})` : `${x}${s}`);
    // i32 literals cannot spell -2^31 directly; write it as (-2147483647i - 1i).
    const spell = (x, s) => (x === I32_MIN ? '(-2147483647i - 1i)' : lit(x, s));
    const expr = `${spell(a, signed ? 'i' : 'u')} ${op} ${shift ? `${b}u` : spell(b, signed ? 'i' : 'u')}`;
    const want = reference(op, a, b, signed),
      got = fold(expr);
    if (want === undefined) assert.equal(got.code, 'type', `${expr} should fail, gave ${JSON.stringify(got)}`);
    else
      assert.deepEqual(
        got,
        { value: typeof want === 'boolean' ? want : Number(want) },
        `${expr}: ${got.message ?? ''}`,
      );
  }
});

test('f32 constant folding rounds like IEEE single precision and rejects non-finite results', () => {
  const r = rng(0xf32);
  const f32 = new Float32Array(1);
  const draw = () => {
    if (r.next() < 0.2)
      return Math.fround(r.pick([0, 1, -1, 0.5, 3.4028234663852886e38, 1.1754943508222875e-38, 1e-45]));
    f32[0] = (r.next() - 0.5) * 2 ** (r.int(60) - 30);
    return f32[0];
  };
  for (let i = 0; i < 2000; i++) {
    const a = draw(),
      b = draw(),
      op = r.pick(['+', '-', '*', '/']);
    const lit = (x) => (x < 0 ? `(-${-x}f)` : `${x}f`);
    const exact = { '+': a + b, '-': a - b, '*': a * b, '/': a / b }[op],
      want = Math.fround(exact),
      got = fold(`${lit(a)} ${op} ${lit(b)}`);
    if (!Number.isFinite(want)) assert.equal(got.code, 'type', `${a} ${op} ${b}`);
    else
      assert.ok(
        Object.is(got.value, want) || (got.value === 0 && want === 0),
        `${a} ${op} ${b}: ${got.value} vs ${want}`,
      );
  }
});

test('struct layouts: members aligned and in order, sizes rounded to the struct alignment', () => {
  const r = rng(0x57);
  const pool = [
    'f32',
    'u32',
    'vec2f',
    'vec3f',
    'vec4f',
    'mat2x2f',
    'mat3x3f',
    'mat4x3f',
    'array<f32, 3>',
    'array<vec3f, 2>',
    'atomic<u32>',
  ];
  for (let i = 0; i < 300; i++) {
    const inner = Array.from({ length: 1 + r.int(3) }, (_, k) => `i${k}: ${r.pick(pool)}`).join(', ');
    const members = Array.from({ length: 1 + r.int(6) }, (_, k) => {
      const type = r.next() < 0.2 ? 'Inner' : r.pick(pool);
      const align = r.next() < 0.15 ? `@align(${2 ** (4 + r.int(3))}) ` : '';
      // Every pool type is at most 64 bytes; Inner may be larger, so it keeps its own size.
      const size = type !== 'Inner' && r.next() < 0.1 ? `@size(${64 + 4 * r.int(8)}) ` : '';
      return `${align}${size}m${k}: ${type}`;
    });
    const source = `struct Inner { ${inner} }\nstruct S { ${members.join(', ')} }\n@group(0) @binding(0) var<storage, read_write> s: S;\n@compute @workgroup_size(1) fn main() { _ = &s; }`;
    const m = checkWGSL(source),
      s = m.structs.find((x) => x.name === 'S');
    let end = 0,
      align = 1;
    for (const x of s.members) {
      assert.equal(x.offset % x.align, 0, `${source}: ${x.name} at ${x.offset} is not ${x.align}-aligned`);
      assert.ok(x.offset >= end, `${source}: ${x.name} overlaps the member before it`);
      assert.ok(x.size >= wgslSizeOf(x.type) && x.align >= wgslAlignOf(x.type));
      end = x.offset + x.size;
      align = Math.max(align, x.align);
    }
    assert.equal(s.align, align);
    assert.equal(s.size % s.align, 0);
    assert.ok(s.size >= end && s.size - end < s.align, source);
  }
});

/** The tree without source positions, for comparing parses of differently spaced text. */
const shape = (ast) =>
  JSON.stringify(ast, (k, v) =>
    k === 'start' || k === 'end' || k === 'nameStart' || k === 'memberStart' ? undefined : v,
  );

test('comments and line breaks between tokens change neither the tree nor the checked module', () => {
  const r = rng(0xc0de);
  for (let i = 0; i < 60; i++) {
    const m = corpus[r.int(corpus.length)];
    // A line break is never inside a token, and a block comment there is outside any line comment, so this keeps
    // the token stream.
    const spaced = m.code.replace(/\n/g, () => (r.next() < 0.5 ? '\n/* inserted /* nested */ */\t\n' : '\r\n'));
    assert.equal(shape(parseWGSL(spaced)), shape(parseWGSL(m.code)), m.key);
    const a = checkWGSL(m.code),
      b = checkWGSL(spaced);
    assert.deepEqual(
      b.entryPoints.map((e) => [e.name, e.stage, e.globals.map((g) => g.name)]),
      a.entryPoints.map((e) => [e.name, e.stage, e.globals.map((g) => g.name)]),
    );
  }
});

const SCALARS = ['f32', 'i32', 'u32', 'bool'];
const vecType = (n, e) => (n === 1 ? e : `vec${n}<${e}>`);

/** A random expression of WGSL type `vecType(n, e)`, over the parameters `p_<n>_<e>` so nothing folds. */
function expression(r, n, e, depth) {
  const leaf = () => `p_${n}_${e}`;
  if (depth <= 0 || r.next() < 0.2) return leaf();
  const sub = (nn = n, ee = e) => expression(r, nn, ee, depth - 1);
  const numeric = e !== 'bool';
  const choices = [];
  if (numeric)
    choices.push(() => `(${sub()} ${r.pick(e === 'f32' ? ['+', '-', '*', '/'] : ['+', '-', '*'])} ${sub()})`);
  if (numeric && n > 1)
    choices.push(
      () => `(${sub()} * ${sub(1)})`,
      () => `(${sub(1)} - ${sub()})`,
    );
  if (e === 'i32' || e === 'u32') choices.push(() => `(${sub()} ${r.pick(['&', '|', '^'])} ${sub()})`);
  if (e === 'bool' && n === 1) {
    const t = r.pick(['f32', 'i32', 'u32']);
    choices.push(
      () => `(${expression(r, 1, t, depth - 1)} ${r.pick(['<', '>=', '==', '!='])} ${expression(r, 1, t, depth - 1)})`,
    );
    choices.push(() => `${r.pick(['all', 'any'])}(${sub(2 + r.int(3))})`);
    choices.push(
      () => `(${sub()} && ${sub()})`,
      () => `!${sub()}`,
    );
  }
  if (e === 'bool' && n > 1) {
    const t = r.pick(['f32', 'i32', 'u32']);
    choices.push(() => `(${expression(r, n, t, depth - 1)} < ${expression(r, n, t, depth - 1)})`);
  }
  if (n > 1) {
    choices.push(() => `vec${n}<${e}>(${sub(1)})`);
    choices.push(() => `vec${n}(${[...Array(n)].map(() => sub(1)).join(', ')})`);
    choices.push(() => `${sub(4)}.${'xyzw'.slice(0, n).split('').reverse().join('')}`);
  } else {
    choices.push(() => `${sub(2 + r.int(3))}.${r.pick(['x', 'y', 'r', 'g'])}`);
    if (e !== 'bool')
      choices.push(() => `${e}(${expression(r, 1, r.pick(SCALARS.filter((s) => s !== 'bool')), depth - 1)})`);
  }
  choices.push(() => `select(${sub()}, ${sub()}, ${expression(r, r.next() < 0.5 ? 1 : n, 'bool', depth - 1)})`);
  if (numeric)
    choices.push(
      () => `${r.pick(['max', 'min'])}(${sub()}, ${sub()})`,
      () => `clamp(${sub()}, ${sub()}, ${sub()})`,
    );
  if (e === 'f32' && n === 1)
    choices.push(() => `dot(${expression(r, 3, 'f32', depth - 1)}, ${expression(r, 3, 'f32', depth - 1)})`);
  if (e === 'f32') choices.push(() => `${r.pick(['abs', 'floor', 'sqrt', 'fract'])}(${sub()})`);
  return r.pick(choices)();
}

test('randomly built typed expressions check to the type they were built for', () => {
  const r = rng(0x7e57);
  const params = [];
  for (const e of SCALARS) for (let n = 1; n <= 4; n++) params.push(`p_${n}_${e}: ${vecType(n, e)}`);
  for (let i = 0; i < 400; i++) {
    const n = 1 + r.int(4),
      e = r.pick(SCALARS),
      expr = expression(r, n, e, 4);
    const source = `fn probe(${params.join(', ')}) { let x = ${expr}; }`;
    let m;
    try {
      m = checkWGSL(source);
    } catch (error) {
      assert.fail(`${expr}\n  should be ${vecType(n, e)}: ${error.message}`);
    }
    const t = m.functions[0].body[0].local.type;
    const name = t.kind === 'scalar' ? t.name : `vec${t.size}<${t.element.name}>`;
    assert.equal(name, vecType(n, e), expr);
  }
});
