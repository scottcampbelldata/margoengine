import { header } from './examples.js';

const types = new Set(['float', 'vec2', 'vec3', 'vec4']);
const functions = new Set([
  ...types, 'abs', 'acos', 'asin', 'atan', 'ceil', 'clamp', 'cos', 'cross', 'distance', 'dot',
  'exp', 'exp2', 'floor', 'fract', 'inversesqrt', 'length', 'log', 'log2', 'max', 'min',
  'mix', 'mod', 'normalize', 'pow', 'reflect', 'sign', 'sin', 'smoothstep', 'sqrt', 'step', 'tan',
]);
const reserved = new Set(['void', 'main', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'discard', 'return', 'break', 'continue', 'true', 'false']);
const program = /^\s*(?:#version[ \t]+300[ \t]+es[ \t]*\n\s*)?(?:precision\s+(?:lowp|mediump|highp)\s+float\s*;\s*)?in\s+vec2\s+uv\s*;\s*uniform\s+float\s+phase\s*;\s*out\s+vec4\s+color\s*;\s*void\s+main\s*\(\s*(?:void\s*)?\)\s*\{([\s\S]*)\}\s*$/;
const declaration = /^(?:(float|vec[234])\s+)?([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/;
const identifier = /^[A-Za-z_]\w*$/;
const swizzle = /^(?:[xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/;
const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const tokenPattern = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*|\+\+|--|[^\s]/g;

function diagnostic(line, message) {
  return new Error('Line ' + line + ' · ' + message);
}

function inspect(expression, names, line, budget) {
  const tokens = expression.match(tokenPattern) ?? [];
  if (tokens.length > budget) throw diagnostic(line, 'Use at most 800 expression tokens.');
  let depth = 0;
  for (const [i, token] of tokens.entries()) {
    if (token === '(') {
      if (++depth > 12) throw diagnostic(line, 'Limit nesting to 12 parentheses.');
    } else if (token === ')') {
      if (--depth < 0) throw diagnostic(line, 'Check the parentheses.');
    } else if (identifier.test(token)) {
      if (tokens[i - 1] === '.' && swizzle.test(token)) continue;
      if (functions.has(token) && tokens[i + 1] === '(') continue;
      if (names.has(token) && tokens[i + 1] !== '(') continue;
      throw diagnostic(line, '“' + token + '” is unavailable here. Use an input, a declared variable or a GLSL math function.');
    } else if (!numeric.test(token) && !['+', '-', '*', '/', '.', ','].includes(token)) {
      throw diagnostic(line, 'Use arithmetic and math functions in expressions.');
    }
  }
  if (depth !== 0) throw diagnostic(line, 'Check the parentheses.');
  return tokens.length;
}

export function prepareFragment(source) {
  if (source.length > 4500) throw new Error('Use at most 4,500 characters.');
  const clean = source.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, comment => comment.replace(/[^\n]/g, ' '));
  const full = program.exec(clean);
  if (!full && /[#{}]/.test(clean)) {
    throw new Error('Use the displayed GLSL inputs and output, or paste only the statements inside main.');
  }
  const body = full ? full[1] : clean;
  const pieces = body.split(';');
  if (pieces.pop().trim()) throw new Error('End each statement with a semicolon.');
  if (pieces.length > 36) throw new Error('Use at most 36 statements.');
  const names = new Set(['uv', 'phase']);
  let line = full ? clean.slice(0, clean.indexOf('{')).split('\n').length : 1;
  let remaining = 800;
  let writes = 0;
  for (const piece of pieces) {
    const statementLine = line + (piece.match(/^\s*/)?.[0].match(/\n/g)?.length ?? 0);
    line += piece.match(/\n/g)?.length ?? 0;
    const statement = declaration.exec(piece.trim());
    if (!statement) throw diagnostic(statementLine, 'Use a simple declaration or assignment.');
    const [, type, name, value] = statement;
    if (type) {
      if (!types.has(type) || names.has(name) || functions.has(name) || reserved.has(name) ||
          name === 'color' || name.startsWith('gl_') || name.includes('__')) {
        throw diagnostic(statementLine, 'Choose a new local variable name.');
      }
    } else if (name === 'color') {
      writes++;
    } else if (name === 'uv' || name === 'phase' || !names.has(name)) {
      throw diagnostic(statementLine, 'Declare a local variable before assigning to it.');
    }
    remaining -= inspect(value, names, statementLine, remaining);
    if (type) names.add(name);
  }
  if (writes !== 1) throw new Error('Write one vec4 to color to display your result.');
  return full ? clean : header + '\n' + clean + '\n}';
}
