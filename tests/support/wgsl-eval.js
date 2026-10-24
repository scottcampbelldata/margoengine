// A small interpreter for the scalar/vector subset of WGSL that the engine's closed-form shading helpers use (let, var,
// if/else, return, +=, vector constructors and swizzles, mat3x3f * vec3f, and the math builtins below), in double
// precision. Tests run the shipped WGSL text through it to compare it with independent references without a GPU.
// Unsupported syntax throws, so a helper outside the subset fails loudly instead of being evaluated wrongly.

const SYMBOLS = ['->', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', ...'(){}[],;.:=+-*/<>!'];

function tokenize(text) {
  const tokens = [],
    source = text.replace(/\/\/[^\n]*/g, '');
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fiu]?/.exec(source.slice(i));
    if (number) {
      tokens.push({ kind: 'number', value: parseFloat(number[0]) });
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_]\w*/.exec(source.slice(i));
    if (word) {
      tokens.push({ kind: 'word', value: word[0] });
      i += word[0].length;
      continue;
    }
    const symbol = SYMBOLS.find((s) => source.startsWith(s, i));
    if (!symbol) throw new SyntaxError(`wgsl-eval: unexpected character ${c}`);
    tokens.push({ kind: 'symbol', value: symbol });
    i += symbol.length;
  }
  return tokens;
}

const isVector = Array.isArray;
const lanes = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
function zip(a, b, f) {
  if (isVector(a) && isVector(b)) {
    if (a.length !== b.length) throw new TypeError('wgsl-eval: vector size mismatch');
    return a.map((v, i) => f(v, b[i]));
  }
  if (isVector(a)) return a.map((v) => f(v, b));
  if (isVector(b)) return b.map((v) => f(a, v));
  return f(a, b);
}
const map = (a, f) => (isVector(a) ? a.map(f) : f(a));
const constructor =
  (size) =>
  (...args) => {
    const flat = args.flat();
    return flat.length === 1 ? new Array(size).fill(flat[0]) : flat;
  };
const builtins = {
  vec2f: constructor(2),
  vec3f: constructor(3),
  vec4f: constructor(4),
  f32: (v) => v,
  mat3x3f: (...v) => ({ columns: [v.slice(0, 3), v.slice(3, 6), v.slice(6, 9)] }),
  cos: (v) => map(v, Math.cos),
  sin: (v) => map(v, Math.sin),
  exp: (v) => map(v, Math.exp),
  exp2: (v) => map(v, (x) => 2 ** x),
  sqrt: (v) => map(v, Math.sqrt),
  abs: (v) => map(v, Math.abs),
  pow: (a, b) => zip(a, b, (x, y) => x ** y),
  min: (a, b) => zip(a, b, Math.min),
  max: (a, b) => zip(a, b, Math.max),
  clamp: (v, lo, hi) => zip(zip(v, lo, Math.max), hi, Math.min),
  mix: (a, b, t) => binary['+'](a, binary['*'](binary['-'](b, a), t)),
  select: (f, t, c) => (isVector(c) ? c.map((k, i) => (k ? t : f)[i] ?? (k ? t : f)) : c ? t : f),
  dot: (a, b) => a.reduce((s, v, i) => s + v * b[i], 0),
  length: (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0)),
  normalize: (a) => {
    const l = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
    return a.map((v) => v / l);
  },
  any: (a) => (isVector(a) ? a.some(Boolean) : !!a),
  all: (a) => (isVector(a) ? a.every(Boolean) : !!a),
};
const binary = {
  '+': (a, b) => zip(a, b, (x, y) => x + y),
  '-': (a, b) => zip(a, b, (x, y) => x - y),
  '*': (a, b) =>
    a && a.columns
      ? [0, 1, 2].map((r) => a.columns.reduce((s, col, c) => s + col[r] * b[c], 0))
      : zip(a, b, (x, y) => x * y),
  '/': (a, b) => zip(a, b, (x, y) => x / y),
  '<': (a, b) => zip(a, b, (x, y) => x < y),
  '>': (a, b) => zip(a, b, (x, y) => x > y),
  '<=': (a, b) => zip(a, b, (x, y) => x <= y),
  '>=': (a, b) => zip(a, b, (x, y) => x >= y),
  '==': (a, b) => zip(a, b, (x, y) => x === y),
  '!=': (a, b) => zip(a, b, (x, y) => x !== y),
};
const precedence = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
};

class Return {
  constructor(value) {
    this.value = value;
  }
}

/**
 * Parses every `fn` in `text`; returns `{ call(name, ...args) }` evaluating them in double precision. `globals` holds
 * module-scope values the functions read (uniform structs as plain objects of numbers and arrays).
 */
export function wgslModule(text, globals = {}) {
  const tokens = tokenize(text),
    functions = {};
  let p = 0;
  const peek = (value) => tokens[p] && tokens[p].value === value;
  const expect = (value) => {
    if (!peek(value)) throw new SyntaxError(`wgsl-eval: expected ${value} at ${tokens[p]?.value}`);
    return tokens[p++];
  };
  const skipType = () => {
    // A type name, possibly with template arguments: f32, vec3f, array<f32,4>.
    p++;
    if (peek('<')) {
      let depth = 0;
      do {
        if (peek('<')) depth++;
        if (peek('>')) depth--;
        p++;
      } while (depth > 0);
    }
  };
  function primary() {
    const t = tokens[p++];
    if (t.kind === 'number') return { kind: 'number', value: t.value };
    if (t.value === '(') {
      const e = expression(0);
      expect(')');
      return e;
    }
    if (t.value === '-' || t.value === '!') return { kind: 'unary', op: t.value, arg: postfix(primary()) };
    if (t.kind === 'word') {
      if (t.value === 'true' || t.value === 'false') return { kind: 'number', value: t.value === 'true' };
      if (peek('(')) {
        p++;
        const args = [];
        while (!peek(')')) {
          args.push(expression(0));
          if (peek(',')) p++;
        }
        p++;
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'name', name: t.value };
    }
    throw new SyntaxError(`wgsl-eval: unexpected ${t.value}`);
  }
  function postfix(e) {
    while (peek('.')) {
      p++;
      e = { kind: 'member', target: e, lanes: tokens[p++].value };
    }
    return e;
  }
  function expression(min) {
    let left = postfix(primary());
    for (;;) {
      const op = tokens[p]?.value,
        level = precedence[op];
      if (!level || level <= min) return left;
      p++;
      left = { kind: 'binary', op, left, right: expression(level) };
    }
  }
  function block() {
    expect('{');
    const body = [];
    while (!peek('}')) body.push(statement());
    p++;
    return body;
  }
  function statement() {
    if (peek('let') || peek('var')) {
      p++;
      const name = tokens[p++].value;
      if (peek(':')) {
        p++;
        skipType();
      }
      let value;
      if (peek('=')) {
        p++;
        value = expression(0);
      }
      expect(';');
      return { kind: 'let', name, value };
    }
    if (peek('return')) {
      p++;
      const value = expression(0);
      expect(';');
      return { kind: 'return', value };
    }
    if (peek('if')) {
      p++;
      const test = expression(0),
        then = block();
      let otherwise = [];
      if (peek('else')) {
        p++;
        otherwise = peek('if') ? [statement()] : block();
      }
      return { kind: 'if', test, then, otherwise };
    }
    const target = postfix(primary()),
      op = tokens[p++].value;
    if (!['=', '+=', '-=', '*=', '/='].includes(op)) throw new SyntaxError(`wgsl-eval: unsupported statement ${op}`);
    const value = expression(0);
    expect(';');
    return { kind: 'assign', target, op, value };
  }
  while (p < tokens.length) {
    if (!peek('fn')) throw new SyntaxError(`wgsl-eval: only functions are supported, found ${tokens[p].value}`);
    p++;
    const name = tokens[p++].value,
      params = [];
    expect('(');
    while (!peek(')')) {
      params.push(tokens[p++].value);
      expect(':');
      skipType();
      if (peek(',')) p++;
    }
    p++;
    if (peek('->')) {
      p++;
      skipType();
    }
    functions[name] = { params, body: block() };
  }

  function evaluate(e, scope) {
    switch (e.kind) {
      case 'number':
        return e.value;
      case 'name':
        if (!(e.name in scope)) throw new ReferenceError(`wgsl-eval: ${e.name} is not defined`);
        return scope[e.name];
      case 'unary': {
        const v = evaluate(e.arg, scope);
        return e.op === '-' ? map(v, (x) => -x) : map(v, (x) => !x);
      }
      case 'member': {
        const v = evaluate(e.target, scope);
        // Struct fields (plain objects passed in as arguments or globals), else vector lanes and swizzles.
        if (!isVector(v) && v && typeof v === 'object' && e.lanes in v) return v[e.lanes];
        const picked = [...e.lanes].map((l) => v[lanes[l]]);
        return picked.length === 1 ? picked[0] : picked;
      }
      case 'binary':
        if (e.op === '&&') return evaluate(e.left, scope) && evaluate(e.right, scope);
        if (e.op === '||') return evaluate(e.left, scope) || evaluate(e.right, scope);
        return binary[e.op](evaluate(e.left, scope), evaluate(e.right, scope));
      case 'call': {
        const args = e.args.map((a) => evaluate(a, scope));
        if (functions[e.name]) return call(e.name, ...args);
        if (builtins[e.name]) return builtins[e.name](...args);
        throw new ReferenceError(`wgsl-eval: unknown function ${e.name}`);
      }
    }
    throw new Error(`wgsl-eval: bad node ${e.kind}`);
  }
  function run(body, scope) {
    for (const s of body) {
      if (s.kind === 'let') scope[s.name] = s.value === undefined ? 0 : evaluate(s.value, scope);
      else if (s.kind === 'return') throw new Return(evaluate(s.value, scope));
      else if (s.kind === 'if') run(evaluate(s.test, scope) ? s.then : s.otherwise, scope);
      else {
        const value = evaluate(s.value, scope),
          apply = (old) => (s.op === '=' ? value : binary[s.op[0]](old, value));
        if (s.target.kind === 'name') scope[s.target.name] = apply(scope[s.target.name]);
        else if (s.target.kind === 'member' && s.target.target.kind === 'name' && s.target.lanes.length === 1) {
          const vector = [...scope[s.target.target.name]],
            lane = lanes[s.target.lanes];
          vector[lane] = apply(vector[lane]);
          scope[s.target.target.name] = vector;
        } else throw new SyntaxError('wgsl-eval: unsupported assignment target');
      }
    }
  }
  function call(name, ...args) {
    const fn = functions[name];
    if (!fn) throw new ReferenceError(`wgsl-eval: no function ${name}`);
    const scope = Object.assign(
      Object.create(null),
      globals,
      Object.fromEntries(fn.params.map((n, i) => [n, args[i]])),
    );
    try {
      run(fn.body, scope);
    } catch (result) {
      if (result instanceof Return) return result.value;
      throw result;
    }
    throw new Error(`wgsl-eval: ${name} did not return`);
  }
  return { call, names: Object.keys(functions) };
}

/** The text of `fn <name>(...)...{...}` in `source` (braces balanced), or undefined. */
export function wgslFunction(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return undefined;
}
