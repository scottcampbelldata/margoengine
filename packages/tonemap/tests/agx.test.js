// Re-derives every constant of the shared AgX transform (packages/shared/agx.js) from its sources: ITU-R BT.709 and
// BT.2020 primaries with D65, and Eary Chow's published AgX working-space parameters (primary rotations and insets).
import test from 'node:test';
import assert from 'node:assert/strict';
import { agx, agxShader } from '../../shared/agx.js';

const D65 = [0.3127, 0.329],
  BT709 = [
    [0.64, 0.33],
    [0.3, 0.6],
    [0.15, 0.06],
  ],
  BT2020 = [
    [0.708, 0.292],
    [0.17, 0.797],
    [0.131, 0.046],
  ];
const mul = (a, b) => a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
function inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = m.flat(),
    A = e * i - f * h,
    B = f * g - d * i,
    C = d * h - e * g,
    det = a * A + b * B + c * C;
  return [
    [A, c * h - b * i, b * f - c * e],
    [B, a * i - c * g, c * d - a * f],
    [C, b * g - a * h, a * e - b * d],
  ].map((r) => r.map((v) => v / det));
}
/** RGB to XYZ of chromaticity primaries [[x, y] x3] and white [x, y] (white maps to Y = 1). */
function toXYZ(primaries) {
  const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y],
    p = [0, 1, 2].map((r) => primaries.map((q) => xyz(q)[r]));
  const s = mul(
    inverse(p),
    xyz(D65).map((v) => [v]),
  ).map(([v]) => v);
  return p.map((row) => row.map((v, j) => v * s[j]));
}
/** AgX working space within Rec.2020: each primary's hue rotated about white (degrees, counter-clockwise in xy), carried to the Rec.2020 gamut boundary, then pulled toward white by `scale`. */
function workspace(rotate, scale) {
  return BT2020.map(([px, py], i) => {
    const a = (rotate[i] * Math.PI) / 180,
      ux = px - D65[0],
      uy = py - D65[1],
      dx = ux * Math.cos(a) - uy * Math.sin(a),
      dy = ux * Math.sin(a) + uy * Math.cos(a);
    let t = Infinity;
    for (let k = 0; k < 3; k++) {
      // where the ray from white along (dx, dy) leaves the triangle
      const [ax, ay] = BT2020[k],
        [bx, by] = BT2020[(k + 1) % 3],
        ex = bx - ax,
        ey = by - ay,
        den = dx * ey - dy * ex;
      const s = ((ax - D65[0]) * dy - (ay - D65[1]) * dx) / den,
        r = ((ax - D65[0]) * ey - (ay - D65[1]) * ex) / den;
      if (den && r > 0 && s >= 0 && s <= 1) t = Math.min(t, r);
    }
    return [D65[0] + (1 - scale[i]) * t * dx, D65[1] + (1 - scale[i]) * t * dy];
  });
}
const fromRec2020 = inverse(toXYZ(BT2020)),
  rec709To2020 = mul(fromRec2020, toXYZ(BT709));
const inset = mul(
  fromRec2020,
  toXYZ(workspace([2.13976149, -1.22827335, -3.05174246], [0.32965205, 0.28051336, 0.12475368])),
);
const outset = inverse(mul(fromRec2020, toXYZ(workspace([0, 0, 0], [0.32317438, 0.28325605, 0.0374326]))));
const toLinear709 = inverse(rec709To2020),
  weights = (primaries) => toXYZ(primaries)[1];
// The shader's matrices in order of appearance (WGSL mat3x3f is column-major), as row-major arrays.
const shaderMatrices = [...agxShader.matchAll(/mat3x3f\(((?:vec3f\([^)]*\),?){3})\)/g)].map(([, body]) => {
  const v = body
    .replaceAll('vec3f', '')
    .match(/-?[\d.]+(?:e-?\d+)?/g)
    .map(Number);
  return [0, 1, 2].map((r) => [0, 1, 2].map((c) => v[c * 3 + r]));
});
const close = (a, b, tolerance, label) =>
  a.flat().forEach((v, i) => assert.ok(Math.abs(v - b.flat()[i]) <= tolerance, `${label}: ${a} vs ${b}`));
const has = (value, tolerance, label) =>
  assert.ok(
    agxShader.match(/-?\d+\.\d+(?:e-?\d+)?/g).some((c) => Math.abs(Math.abs(Number(c)) - value) <= tolerance),
    `${label} ${value}`,
  );

// The AgX sigmoid, from its definition: on each side of the pivot (x0, y0) a hyperbola k h(s t / k),
// h(u) = u / (1 + u^p)^(1/p), whose slope at the pivot is s; k is chosen so the shoulder reaches (1, 1) and the toe
// (0, 0). Solving |y1 - y0| = k h(s |x1 - x0| / k) for k gives k = a ((a / b)^p - 1)^(-1/p), a = s |x1 - x0|,
// b = |y1 - y0|.
const below = 10,
  stops = 16.5, // -10 to +6.5 stops around grey 0.18
  x0 = below / stops,
  y0 = 0.18 ** (1 / 2.4), // grey before the 2.4 display power
  slope = 2.4,
  power = 1.5,
  k = (a, b) => a * ((a / b) ** power - 1) ** (-1 / power);

test('AgX matrices, luminance weights and curve constants are derived from their definitions', () => {
  assert.equal(shaderMatrices.length, 3);
  close(shaderMatrices[0], inset, 5e-8, 'AgX inset');
  close(shaderMatrices[1], rec709To2020, 5e-8, 'Rec.709 to Rec.2020');
  close(shaderMatrices[2], mul(toLinear709, outset), 2e-7, 'outset, then Rec.2020 to Rec.709');
  for (const m of [inset, outset, rec709To2020])
    m.forEach((row) => assert.ok(Math.abs(row[0] + row[1] + row[2] - 1) < 1e-12, 'white stays white'));
  for (const w of weights(BT2020)) has(w, 5e-8, 'Rec.2020 luminance weight');
  for (const w of weights(BT709)) has(w, 5e-8, 'Rec.709 luminance weight');
  has(1 / stops, 1e-15, 'log2 scale');
  has((below - Math.log2(0.18)) / stops, 1e-15, 'log2 offset');
  has(x0, 1e-15, "grey's log position");
  has(y0, 1e-15, "grey's curve value");
  has(k(slope * (1 - x0), 1 - y0), 1e-15, 'shoulder scale');
  has(k(slope * x0, y0), 1e-15, 'toe scale');
  // The WGSL is only compiled on a GPU: an unbalanced statement (an extra '(' once broke Bloom and Tonemap) fails here.
  for (const statement of agxShader.split(';'))
    assert.equal(statement.split('(').length, statement.split(')').length, 'unbalanced: ' + statement.trim());
});

const grey = (stopsFromGrey) => {
  const v = 0.18 * 2 ** stopsFromGrey;
  return agx([v, v, v]);
};
test('agx() keeps grey, runs from 0 at -10 stops to 1 at +6.5 stops, with slope 2.4 at grey', () => {
  for (const c of grey(0)) assert.ok(Math.abs(c - 0.18) < 1e-6, '18% grey stays 18% grey');
  for (const c of [...grey(-10), ...grey(-11), ...agx([0, 0, 0])]) assert.ok(c < 1e-12, 'black at -10 stops');
  for (const c of [...grey(6.5), ...grey(9)]) assert.ok(Math.abs(c - 1) < 1e-12, 'white at +6.5 stops');
  // Display-encoded grey (power 1/2.4) against the log position: slope 2.4 on both sides of grey.
  const encoded = (s) => grey(s)[1] ** (1 / 2.4);
  for (const side of [-1, 1]) {
    const d = 1e-6 * side;
    assert.ok(Math.abs((encoded(d * stops) - encoded(0)) / d - slope) < 1e-4, `slope 2.4 at grey (${side})`);
  }
  let previous = 0;
  for (let s = -12; s <= 8; s += 0.25) {
    const [r, g, b] = grey(s);
    assert.ok(Math.abs(r - g) < 1e-6 && Math.abs(g - b) < 1e-6, `neutral at ${s} stops`);
    assert.ok(g >= previous, `monotonic at ${s} stops`);
    previous = g;
  }
});

test('agx() handles channels above 1, negative channels, NaN and infinities, and writes into out', () => {
  const hot = agx([8, 0.05, 0.02]);
  assert.ok(hot.every((c) => c >= 0 && c <= 1));
  assert.ok(hot[1] > 0.2 && hot[2] > 0.2, 'a saturated highlight desaturates instead of clipping to pure red');
  for (const c of [
    [4, 2, 0.5],
    [1e6, 3, 0],
    [-0.1, 0.5, 0.2],
    [0.3, -0.02, 0.1],
    [-1, -1, -1],
  ])
    assert.ok(
      agx(c).every((v) => v >= 0 && v <= 1),
      `${c}`,
    );
  const black = (c) => agx(c).every((v) => v < 1e-12);
  assert.ok(black([Number.NaN, 0, 0]), 'NaN is black');
  assert.ok(black([Number.NEGATIVE_INFINITY, 1, 1]), '-Infinity is black');
  assert.deepEqual(agx([Number.POSITIVE_INFINITY, 0, 0]), [1, 1, 1], 'Infinity is white');
  const c = [0.5, 0.2, 0.1];
  assert.equal(agx(c, c), c, 'writes into out, which may be the input');
  assert.deepEqual(c, agx([0.5, 0.2, 0.1]));
});

// A small evaluator for the WGSL subset agxShader uses (scalars, vec3f, mat3x3f, let/var, if/else, return), so the
// generated shader text itself runs in Node and can be compared with agx().
function wgsl(source) {
  const tokens = source.match(/\d+\.\d+(?:e-?\d+)?|\d+e-?\d+|\d+|[A-Za-z_]\w*|->|&&|>=|<=|==|\S/g);
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected) => {
    const v = tokens[at++];
    if (expected !== undefined && v !== expected) throw new Error(`expected ${expected}, got ${v} at token ${at}`);
    return v;
  };
  // Scalars broadcast against vec3f (arrays of three numbers).
  const map = (f, ...a) =>
    a.some(Array.isArray) ? [0, 1, 2].map((i) => f(...a.map((v) => (Array.isArray(v) ? v[i] : v)))) : f(...a);
  const binary = {
    '+': (a, b) => a + b,
    '-': (a, b) => a - b,
    '/': (a, b) => a / b,
    '%': (a, b) => a % b,
    '>': (a, b) => a > b,
    '<': (a, b) => a < b,
    '>=': (a, b) => a >= b,
    '<=': (a, b) => a <= b,
    '==': (a, b) => a === b,
    '&&': (a, b) => a && b,
  };
  const precedence = { '&&': 1, '>': 2, '<': 2, '>=': 2, '<=': 2, '==': 2, '+': 3, '-': 3, '*': 4, '/': 4, '%': 4 };
  const times = (a, b) =>
    a?.columns
      ? [0, 1, 2].map((r) => a.columns.reduce((s, column, c) => s + column[r] * b[c], 0))
      : map((x, y) => x * y, a, b);
  const builtins = {
    vec3f: (...a) => (a.length === 1 ? [a[0], a[0], a[0]] : a),
    mat3x3f: (...columns) => ({ columns }),
    max: (a, b) => map(Math.max, a, b),
    min: (a, b) => map(Math.min, a, b),
    clamp: (a, l, h) => map((x, y, z) => Math.min(Math.max(x, y), z), a, l, h),
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    log2: (a) => map(Math.log2, a),
    pow: (a, b) => map((x, y) => x ** y, a, b),
    abs: (a) => map(Math.abs, a),
    sign: (a) => map(Math.sign, a),
    floor: (a) => map(Math.floor, a),
    fract: (a) => map((x) => x - Math.floor(x), a),
    select: (f, t, c) => map((x, y, z) => (z ? y : x), f, t, c),
  };
  const functions = {};
  const copy = (v) => (Array.isArray(v) ? [...v] : v);
  function expression(scope, minimum = 1) {
    let left = unary(scope);
    while (precedence[peek()] >= minimum) {
      const op = take(),
        right = expression(scope, precedence[op] + 1);
      left = op === '*' ? times(left, right) : map(binary[op], left, right);
    }
    return left;
  }
  function unary(scope) {
    if (peek() === '-') {
      take();
      return map((x) => -x, unary(scope));
    }
    const t = take();
    let value;
    if (t === '(') {
      value = expression(scope);
      take(')');
    } else if (/^\d/.test(t)) value = Number(t);
    else if (peek() === '(') {
      take('(');
      const args = [];
      while (peek() !== ')') {
        args.push(expression(scope));
        if (peek() === ',') take(',');
      }
      take(')');
      value = (builtins[t] ?? functions[t])(...args);
    } else value = scope[t];
    while (peek() === '.') {
      take('.');
      value = value['xyz'.indexOf(take())];
    }
    return value;
  }
  // Skips to the end of the current block (its '{' already taken).
  function skip() {
    for (let depth = 1; depth; ) {
      const t = take();
      if (t === '{') depth++;
      else if (t === '}') depth--;
    }
  }
  // Runs a block when `run` (else skips it); returns { value } once a statement returns.
  function block(scope, run) {
    take('{');
    if (!run) return skip();
    while (peek() !== '}') {
      const r = statement(scope);
      if (r) {
        skip();
        return r;
      }
    }
    take('}');
    return undefined;
  }
  function statement(scope) {
    const t = take();
    if (t === 'let' || t === 'var') {
      const name = take();
      take('=');
      scope[name] = copy(expression(scope));
      take(';');
      return undefined;
    }
    if (t === 'return') {
      const value = expression(scope);
      take(';');
      return { value };
    }
    if (t === 'if') {
      let done = false,
        result;
      for (let branch = true; branch; ) {
        take('(');
        const c = expression(scope);
        take(')');
        const r = block(scope, !done && c);
        result ??= r;
        done ||= c;
        branch = false;
        if (peek() === 'else') {
          take('else');
          if (peek() === 'if') {
            take('if');
            branch = true;
          } else result ??= block(scope, !done);
        }
      }
      return result;
    }
    let index = -1;
    if (peek() === '.') {
      take('.');
      index = 'xyz'.indexOf(take());
    }
    take('=');
    const v = expression(scope);
    take(';');
    if (index < 0) scope[t] = v;
    else scope[t][index] = v;
    return undefined;
  }
  while (at < tokens.length) {
    take('fn');
    const name = take(),
      params = [];
    take('(');
    while (peek() !== ')') {
      params.push(take());
      take(':');
      take();
      if (peek() === ',') take(',');
    }
    take(')');
    take('->');
    take();
    const start = at;
    block({}, false);
    functions[name] = (...args) => {
      const saved = at;
      at = start;
      const r = block(Object.fromEntries(params.map((p, i) => [p, copy(args[i])])), true);
      at = saved;
      return r.value;
    };
  }
  return functions;
}

test('the generated WGSL, evaluated in Node, gives the same colours as agx()', () => {
  const shader = wgsl(agxShader);
  let seed = 3;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const samples = [
    [0, 0, 0],
    [0.18, 0.18, 0.18],
    [8, 0.05, 0.02],
    [-0.1, 0.5, 0.2],
    [0.002, 0.18, 0.18],
    [100, 50, 1],
  ];
  for (let i = 0; i < 200; i++) samples.push([0, 1, 2].map(() => 2 ** (random() * 20 - 13)));
  for (const c of samples) {
    const a = agx(c),
      b = shader.agx(c);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `${c}: ${a} vs ${b}`);
  }
});

test('hue restoration moves saturated colours back toward their own hue', () => {
  // The same shader with restoration switched off, evaluated in Node, for comparison.
  const plain = wgsl(agxShader.replace(/fract\(f\.x\+0\.6\*/, 'fract(f.x+0.0*')).agx;
  assert.notEqual(plain, undefined);
  const hue = ([r, g, b]) => Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b);
  const gap = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  let restored = 0,
    unrestored = 0;
  for (let h = 0; h < 1; h += 1 / 24)
    for (const level of [0.05, 0.5, 4]) {
      const c = [0, 1, 2].map((i) => level * (0.05 + Math.max(0, Math.cos(2 * Math.PI * (h - i / 3)))));
      restored += gap(hue(agx(c)), hue(c));
      unrestored += gap(hue(plain(c)), hue(c));
    }
  assert.ok(
    restored < 0.8 * unrestored,
    `mean hue shift ${restored / 75} with restoration, ${unrestored / 75} without`,
  );
});
