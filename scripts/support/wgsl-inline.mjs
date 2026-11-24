// How much code a shader compiler that inlines every call and unrolls every loop it can count makes of one WGSL entry
// point (KB-COMPAT-FXCTIME1). Direct3D's HLSL compiler (fxc, which ANGLE's WebGL2 calls on Windows) does both: an HLSL
// function is inline by default, so each call site is a copy of the callee's whole call tree, and a `for` loop with a
// count it can work out is unrolled unless the source forbids it. Five corpus kernels took it 46 to 98 s each to link.
// A call-graph walk counts the copies; a call inside a `for` loop whose start and bound are constants counts once per
// trip. Loops whose bound the program reads at run time (a uniform, a buffer word) count once, as fxc keeps them.
// Sources: Microsoft, "Function Declaration Syntax" (HLSL `inline` is the default),
// https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-function-syntax ; Microsoft, "for
// Statement" (`unroll` copies the body, `loop` keeps flow control; with neither the compiler unrolls when it can count),
// https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-for .

/** Loops of more trips than this count once: fxc keeps long loops as loops. */
export const UNROLL_LIMIT = 64;

const strip = (code) => code.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** The index of the bracket that closes the one at `open`. */
function closing(text, open) {
  const pair = { '{': '}', '(': ')' }[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++;
    else if (text[i] === pair && --depth === 0) return i;
  }
  return text.length - 1;
}

/** Module-scope constants with a whole-number value: `const N = 8u;`, `const M = N - 1u;`. */
function constants(text) {
  const out = new Map();
  for (const m of text.matchAll(/(?:^|\n)\s*const\s+([A-Za-z_]\w*)\s*(?::\s*\w+\s*)?=\s*([^;]+);/g)) {
    const expression = m[2]
      .trim()
      .replace(/\b(\d+)[ui]\b/g, '$1')
      .replace(/[A-Za-z_]\w*/g, (name) => (out.has(name) ? `(${out.get(name)})` : '#'));
    // Whole numbers, + - * and brackets only: anything else (floats, calls, unknown names) is not a loop bound.
    if (/^[\d\s+\-*()]+$/.test(expression) && /\d/.test(expression)) {
      const value = Function(`return (${expression});`)();
      if (Number.isSafeInteger(value)) out.set(m[1], value);
    }
  }
  return out;
}

/** The trip count of a `for` header when its start and bound are constants, else 1. */
function trips(header, known, limit) {
  const [init = '', condition = ''] = header.split(';');
  const value = (s) => {
    const t = s.trim().replace(/^(\d+)[ui]?$/, '$1');
    return /^\d+$/.test(t) ? Number(t) : known.has(t) ? known.get(t) : undefined;
  };
  const start = /=\s*([^=]+)$/.exec(init)?.[1];
  const bound = /^\s*[A-Za-z_]\w*\s*(<=?)\s*([A-Za-z_]\w*|\d+[ui]?)\s*(?:&&|$)/.exec(condition);
  const from = start === undefined ? undefined : value(start),
    to = bound ? value(bound[2]) : undefined;
  if (from === undefined || to === undefined) return 1;
  const n = to - from + (bound[1] === '<=' ? 1 : 0);
  return n > 1 && n <= limit ? n : 1;
}

/** The functions of a WGSL source: name to body text, and the calls in each with how many times each loop runs it. */
export function wgslCallGraph(code, { unrollLimit = UNROLL_LIMIT } = {}) {
  const text = strip(code),
    known = constants(text),
    bodies = new Map();
  for (const m of text.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g)) {
    const open = text.indexOf('{', m.index);
    bodies.set(m[1], { start: open, body: text.slice(open, closing(text, open) + 1) });
  }
  const calls = new Map();
  for (const [name, { body }] of bodies) {
    // Countable loops in this body: their brace ranges and trip counts.
    const loops = [];
    for (const m of body.matchAll(/\bfor\s*\(/g)) {
      const open = m.index + m[0].length - 1,
        close = closing(body, open),
        brace = body.indexOf('{', close);
      loops.push({ from: brace, to: closing(body, brace), trips: trips(body.slice(open + 1, close), known, unrollLimit) });
    }
    const sites = new Map();
    for (const callee of bodies.keys()) {
      if (callee === name) continue;
      for (const m of body.matchAll(new RegExp(`(?<![\\w.])${callee}\\s*\\(`, 'g'))) {
        const times = loops.filter((l) => m.index > l.from && m.index < l.to).reduce((a, l) => a * l.trips, 1);
        sites.set(callee, (sites.get(callee) ?? 0) + times);
      }
    }
    calls.set(name, sites);
  }
  return { bodies, calls };
}

/**
 * The copies of each function an inline-everything, unroll-what-it-can-count compiler makes for one entry point, and
 * the characters of function body they add up to.
 * @param {string} code WGSL source.
 * @param {string} entry Entry point name.
 * @returns {{ copies: Map<string, number>, size: number }}
 */
export function inlinedCopies(code, entry, options) {
  const { bodies, calls } = wgslCallGraph(code, options);
  if (!bodies.has(entry)) throw new TypeError(`no function '${entry}' in the source`);
  const copies = new Map();
  const walk = (name, times, depth) => {
    if (depth > 64) throw new RangeError(`'${name}' recurses, which WGSL forbids`);
    copies.set(name, (copies.get(name) ?? 0) + times);
    for (const [callee, n] of calls.get(name) ?? []) walk(callee, times * n, depth + 1);
  };
  walk(entry, 1, 0);
  let size = 0;
  for (const [name, n] of copies) size += n * bodies.get(name).body.length;
  return { copies, size };
}
