// A small CPU evaluator for the straight-line WGSL these tests run: `fn` declarations, let/var, assignment, if/else,
// return, and scalar/vector arithmetic rounded to f32 after every operation. Matrices are arrays of four columns.
// It exists so tests execute the shader text itself instead of a hand-written JavaScript copy of it.

const f32 = Math.fround;
const isVec = (v) => Array.isArray(v) && !Array.isArray(v[0]);
const map2 = (a, b, op) => {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => op(x, b[i]));
  if (Array.isArray(a)) return a.map((x) => op(x, b));
  if (Array.isArray(b)) return b.map((y) => op(a, y));
  return op(a, b);
};
const map1 = (a, op) => (Array.isArray(a) ? a.map(op) : op(a));
const dot = (a, b) => f32(a.reduce((sum, x, i) => f32(sum + f32(x * b[i])), 0));
const length = (a) => (Array.isArray(a) ? f32(Math.sqrt(dot(a, a))) : Math.abs(a));
const flat = (args) => args.flatMap((a) => (Array.isArray(a) ? a : [a]));
const vector =
  (n, round) =>
  (...args) => {
    const v = flat(args);
    return (v.length === 1 ? Array(n).fill(v[0]) : v).map(round);
  };
const toInt = (x) => Math.trunc(x);
const swizzle = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };

const builtins = {
  vec2f: vector(2, f32),
  vec3f: vector(3, f32),
  vec4f: vector(4, f32),
  vec2i: vector(2, toInt),
  f32: (x) => f32(x),
  floor: (a) => map1(a, Math.floor),
  abs: (a) => map1(a, Math.abs),
  log2: (a) => map1(a, (x) => f32(Math.log2(x))),
  inverseSqrt: (a) => map1(a, (x) => f32(1 / Math.sqrt(x))),
  min: (a, b) => map2(a, b, Math.min),
  max: (a, b) => map2(a, b, Math.max),
  clamp: (a, lo, hi) => map2(map2(a, lo, Math.max), hi, Math.min),
  pow: (a, b) => map2(a, b, (x, y) => f32(x ** y)),
  mix: (a, b, t) =>
    map2(
      map2(a, b, (x, y) => [x, y]),
      t,
      ([x, y], s) => f32(x + f32(f32(y - x) * s)),
    ),
  select: (no, yes, c) => (Array.isArray(c) ? c.map((k, i) => (k ? at(yes, i) : at(no, i))) : c ? yes : no),
  dot,
  length,
  normalize: (a) => a.map((x) => f32(x / length(a))),
  cross: (a, b) => [f32(a[1] * b[2] - a[2] * b[1]), f32(a[2] * b[0] - a[0] * b[2]), f32(a[0] * b[1] - a[1] * b[0])],
  faceForward: (n, i, r) => (dot(r, i) < 0 ? n : n.map((x) => -x)),
  refract: (i, n, eta) => {
    const c = dot(n, i),
      k = f32(1 - eta * eta * (1 - c * c));
    if (k < 0) return i.map(() => 0);
    return i.map((x, j) => f32(eta * x - (eta * c + Math.sqrt(k)) * n[j]));
  },
};
const at = (v, i) => (Array.isArray(v) ? v[i] : v);

function tokenize(source) {
  const tokens = [],
    pattern =
      /\s+|\/\/[^\n]*|(\d+\.\d*(?:e[+-]?\d+)?|\d*\.\d+(?:e[+-]?\d+)?|\d+[ui]?)|([A-Za-z_]\w*)|(->|&&|\|\||==|!=|<=|>=|[-+*/<>(){}[\],.;:=!&_|@])/gy;
  let m;
  while (pattern.lastIndex < source.length && (m = pattern.exec(source)))
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number.parseFloat(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2] });
    else if (m[3] !== undefined) tokens.push({ t: 'op', v: m[3] });
  if (pattern.lastIndex < source.length)
    throw new SyntaxError('WGSL subset: cannot read ' + source.slice(pattern.lastIndex, 40));
  return tokens;
}

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
function binary(op, a, b) {
  switch (op) {
    case '+':
      return map2(a, b, (x, y) => f32(x + y));
    case '-':
      return map2(a, b, (x, y) => f32(x - y));
    case '/':
      return map2(a, b, (x, y) => f32(x / y));
    case '*':
      if (Array.isArray(a) && Array.isArray(a[0]))
        return b.map((_, row) =>
          dot(
            a.map((col) => col[row]),
            b,
          ),
        );
      return map2(a, b, (x, y) => f32(x * y));
    case '<':
      return map2(a, b, (x, y) => x < y);
    case '>':
      return map2(a, b, (x, y) => x > y);
    case '<=':
      return map2(a, b, (x, y) => x <= y);
    case '>=':
      return map2(a, b, (x, y) => x >= y);
    case '==':
      return map2(a, b, (x, y) => x === y);
    case '!=':
      return map2(a, b, (x, y) => x !== y);
    case '&&':
      return a && b;
    case '||':
      return a || b;
  }
  throw new SyntaxError('WGSL subset: operator ' + op);
}

/** Parses WGSL text (functions only; other module lines are skipped) and returns a caller of its functions. */
export function wgslModule(source, environment = {}) {
  const tokens = tokenize(source),
    functions = {},
    // Module-scope var<private> values, shared by every call.
    globals = {};
  let p = 0;
  const peek = (v) => tokens[p]?.v === v,
    take = (v) => {
      if (v !== undefined && tokens[p]?.v !== v)
        throw new SyntaxError(`WGSL subset: expected ${v}, got ${tokens[p]?.v}`);
      return tokens[p++];
    };
  // Expressions are parsed to closures over a scope.
  function primary() {
    const token = take();
    let node;
    if (token.t === 'num') node = () => token.v;
    else if (token.v === '(') {
      node = expression();
      take(')');
    } else if (token.v === '-') {
      const inner = postfix(primary());
      return (s) => map1(inner(s), (x) => f32(-x));
    } else if (token.v === '!') {
      const inner = postfix(primary());
      return (s) => !inner(s);
    } else if (token.t === 'id') {
      const name = token.v;
      if (name === 'true' || name === 'false') node = () => name === 'true';
      else if (peek('(')) {
        take('(');
        const args = [];
        while (!peek(')')) {
          args.push(expression());
          if (peek(',')) take(',');
        }
        take(')');
        node = (s) => {
          const values = args.map((a) => a(s));
          if (functions[name]) return call(name, values);
          const fn = environment[name] ?? builtins[name];
          if (!fn) throw new ReferenceError('WGSL subset: no function ' + name);
          return fn(...values);
        };
      } else
        node = (s) => {
          if (name in s) return s[name];
          if (name in globals) return globals[name];
          if (name in environment) return environment[name];
          throw new ReferenceError('WGSL subset: no value ' + name);
        };
    } else throw new SyntaxError('WGSL subset: unexpected ' + token.v);
    return postfix(node);
  }
  function postfix(node) {
    for (;;) {
      if (peek('.')) {
        take('.');
        const member = take().v,
          inner = node;
        node = (s) => {
          const v = inner(s);
          if (!Array.isArray(v)) return v[member];
          const picked = [...member].map((c) => v[swizzle[c]]);
          return picked.length === 1 ? picked[0] : picked;
        };
      } else if (peek('[')) {
        take('[');
        const index = expression(),
          inner = node;
        take(']');
        node = (s) => inner(s)[index(s)];
      } else return node;
    }
  }
  function expression(min = 1) {
    let left = primary();
    for (;;) {
      const op = tokens[p]?.v,
        level = precedence[op];
      if (!level || level < min) return left;
      take();
      const right = expression(level + 1),
        l = left;
      left = (s) => binary(op, l(s), right(s));
    }
  }
  // Statements are closures returning { value } when they return.
  function block() {
    take('{');
    const list = [];
    while (!peek('}')) list.push(statement());
    take('}');
    return (s) => {
      for (const run of list) {
        const out = run(s);
        if (out) return out;
      }
    };
  }
  function statement() {
    if (peek('{')) return block();
    if (peek('let') || peek('var')) {
      take();
      const name = take().v;
      if (peek(':')) {
        take(':');
        take();
      }
      let value = () => undefined;
      if (peek('=')) {
        take('=');
        value = expression();
      }
      take(';');
      return (s) => {
        s[name] = value(s);
      };
    }
    if (peek('return')) {
      take();
      const value = peek(';') ? () => undefined : expression();
      take(';');
      return (s) => ({ value: value(s) });
    }
    if (peek('if')) {
      take();
      const condition = expression(),
        yes = statement();
      let no = () => undefined;
      if (peek('else')) {
        take();
        no = statement();
      }
      return (s) => (condition(s) ? yes(s) : no(s));
    }
    if (peek('_')) {
      take('_');
      take('=');
      expression();
      take(';');
      return () => undefined;
    }
    // Assignment to a name or a name's component.
    const name = take().v;
    let component;
    if (peek('.')) {
      take('.');
      component = take().v;
    }
    take('=');
    const value = expression();
    take(';');
    return (s) => {
      const target = name in s || !(name in globals) ? s : globals;
      if (component === undefined) target[name] = value(s);
      else target[name] = target[name].map((x, i) => (i === swizzle[component] ? value(s) : x));
    };
  }
  function call(name, values) {
    const { params, body } = functions[name],
      scope = {};
    params.forEach((param, i) => {
      scope[param] = values[i];
    });
    return body(scope)?.value;
  }
  while (p < tokens.length) {
    if (peek('var') && tokens[p + 1]?.v === '<') {
      // var<private> name:type = value;
      take('var');
      while (!peek('>')) take();
      take('>');
      const name = take().v;
      take(':');
      take();
      let value;
      if (peek('=')) {
        take('=');
        value = expression()({});
      }
      take(';');
      globals[name] = value;
      continue;
    }
    if (!peek('fn')) {
      p++;
      continue;
    }
    take('fn');
    const name = take().v,
      params = [];
    take('(');
    while (!peek(')')) {
      // Parameter attributes such as @builtin(position) carry no value here.
      while (peek('@')) {
        take('@');
        take();
        if (peek('(')) while (take().v !== ')');
      }
      params.push(take().v);
      take(':');
      take();
      if (peek('<')) while (!peek('>')) take();
      if (peek('>')) take('>');
      if (peek(',')) take(',');
    }
    take(')');
    if (peek('->')) {
      take('->');
      // Return type, after any attributes; a templated type is skipped to its closing '>'.
      while (!peek('{')) take();
    }
    functions[name] = { params, body: block() };
  }
  return {
    names: Object.keys(functions),
    call: (name, ...args) => call(name, args),
    /** Runs loose statements (no `fn` around them) with `scope` and returns what they return. */
    run(statements, scope = {}) {
      tokens.length = 0;
      tokens.push(...tokenize('{' + statements + '}'));
      p = 0;
      return block()(scope)?.value;
    },
  };
}
