import { invalid, type ParseBudget } from './document.js';
import type { FBXNode, FBXValue } from './document.js';

interface Token {
  kind: 'word' | 'string' | 'punctuation' | 'newline' | 'end';
  value: string;
}
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const integer = /^[+-]?\d+$/;
const intArrays = new Set([
  'PolygonVertexIndex',
  'Indexes',
  'NormalsIndex',
  'UVIndex',
  'ColorIndex',
  'Materials',
  'KeyAttrFlags',
  'KeyAttrRefCount',
]);

export function parseASCII(bytes: Uint8Array, budget: ParseBudget): { roots: FBXNode[]; version: number } {
  budget.reserve(bytes.length * 2);
  budget.work(bytes.length);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalid('invalid ASCII encoding');
  }
  let cursor = 0,
    lookahead: Token | undefined;
  function lex(): Token {
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === ' ' || char === '\t' || char === '\ufeff') {
        cursor++;
        continue;
      }
      if (char === ';') {
        while (cursor < text.length && text[cursor] !== '\r' && text[cursor] !== '\n') cursor++;
        continue;
      }
      if (char === '\n' || char === '\r') {
        cursor++;
        if (char === '\r' && text[cursor] === '\n') cursor++;
        return { kind: 'newline', value: '\n' };
      }
      if (':,{}*'.includes(char)) {
        cursor++;
        return { kind: 'punctuation', value: char };
      }
      if (char === '"') {
        cursor++;
        let value = '',
          start = cursor;
        while (cursor < text.length) {
          const next = text[cursor++];
          if (next === '"') {
            value += text.slice(start, cursor - 1);
            return { kind: 'string', value };
          }
          if (next === '\\' && (text[cursor] === '"' || text[cursor] === '\\')) {
            value += text.slice(start, cursor - 1) + text[cursor++];
            start = cursor;
          }
        }
        invalid('unterminated string');
      }
      const start = cursor;
      while (cursor < text.length && !/[\s:,{}*;"\ufeff]/.test(text[cursor])) cursor++;
      if (cursor === start) invalid('unexpected ASCII character');
      return { kind: 'word', value: text.slice(start, cursor) };
    }
    return { kind: 'end', value: '' };
  }
  function peek(): Token {
    return (lookahead ??= lex());
  }
  function take(): Token {
    budget.work();
    const value = peek();
    lookahead = undefined;
    return value;
  }
  function expect(value: string): void {
    if (take().value !== value) invalid(`expected ${value}`);
  }
  function lines(): void {
    while (peek().kind === 'newline') take();
  }
  function scalar(token: Token): FBXValue {
    if (token.kind === 'string') {
      budget.reserve(token.value.length * 2);
      return token.value;
    }
    if (token.kind !== 'word') invalid('expected property value');
    if (!numeric.test(token.value)) return token.value;
    if (integer.test(token.value)) {
      if (token.value.length > 32) invalid('integer outside int64 range');
      const exact = BigInt(token.value);
      if (exact < -0x8000000000000000n || exact > 0x7fffffffffffffffn) invalid('integer outside int64 range');
      if (exact < BigInt(Number.MIN_SAFE_INTEGER) || exact > BigInt(Number.MAX_SAFE_INTEGER)) return exact;
    }
    const value = Number(token.value);
    if (!Number.isFinite(value)) invalid('non-finite number');
    return value;
  }
  function readArray(name: string): FBXValue {
    expect('*');
    const declared = take();
    if (declared.kind !== 'word' || !/^\d+$/.test(declared.value)) invalid('invalid array count');
    const count = Number(declared.value);
    if (!Number.isSafeInteger(count)) invalid('unsafe array count');
    const wide = name === 'KeyTime',
      ints = intArrays.has(name),
      width = ints ? 4 : 8;
    budget.array(count * width);
    budget.work(count);
    const result = wide ? new BigInt64Array(count) : ints ? new Int32Array(count) : new Float64Array(count);
    lines();
    expect('{');
    lines();
    expect('a');
    expect(':');
    let index = 0,
      comma = false;
    while (true) {
      lines();
      const token = peek();
      if (token.value === '}') {
        take();
        break;
      }
      if (token.value === ',') {
        if (!comma) invalid('unexpected array comma');
        take();
        comma = false;
        continue;
      }
      if (comma) invalid('missing array comma');
      if (index >= count) invalid('array count mismatch');
      const value = scalar(take());
      if (result instanceof BigInt64Array) {
        if (typeof value === 'bigint') result[index] = value;
        else if (typeof value === 'number' && Number.isSafeInteger(value)) result[index] = BigInt(value);
        else invalid('invalid int64 array value');
      } else {
        if (typeof value !== 'number' || !Number.isFinite(value)) invalid('invalid numeric array value');
        if (ints && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647))
          invalid('invalid int32 array value');
        result[index] = value;
      }
      index++;
      comma = true;
    }
    if (index !== count) invalid('array count mismatch');
    return result;
  }
  function node(depth: number): FBXNode {
    budget.node(depth);
    const name = take();
    if (name.kind !== 'word' && name.kind !== 'string') invalid('expected node name');
    budget.reserve(name.value.length * 2);
    expect(':');
    const properties: FBXValue[] = [],
      children: FBXNode[] = [];
    let comma = false;
    while (true) {
      const token = peek();
      if (token.kind === 'newline') {
        lines();
        // A comma continues a property list, and an opening brace can be on
        // the following line. Other newlines terminate this node's values.
        if ((properties.length && !comma) || peek().value === '{') continue;
        break;
      }
      if (token.kind === 'end' || token.value === '}') break;
      if (token.value === '{') {
        take();
        lines();
        while (peek().value !== '}') {
          if (peek().kind === 'end') invalid('unterminated node');
          children.push(node(depth + 1));
          lines();
        }
        take();
        return { name: name.value, properties, children };
      }
      if (token.value === ',') {
        if (!comma) invalid('unexpected property comma');
        take();
        comma = false;
        continue;
      }
      if (comma) invalid('missing property comma');
      budget.property();
      properties.push(token.value === '*' ? readArray(name.value) : scalar(take()));
      comma = true;
    }
    if (!comma && properties.length) invalid('missing property after comma');
    return { name: name.value, properties, children };
  }
  const roots: FBXNode[] = [];
  lines();
  while (peek().kind !== 'end') {
    roots.push(node(0));
    lines();
  }
  if (!roots.some((root) => root.name === 'Objects' || root.name === 'FBXHeaderExtension'))
    invalid('missing FBX document');
  const header = roots
    .find((root) => root.name === 'FBXHeaderExtension')
    ?.children.find((child) => child.name === 'FBXVersion')?.properties[0];
  if (header !== undefined && (typeof header !== 'number' || !Number.isInteger(header)))
    invalid('invalid ASCII version');
  const comment = /^\s*;\s*FBX\s+(\d+)\.(\d+)\.(\d+)/i.exec(text);
  const version =
    typeof header === 'number'
      ? header
      : comment
        ? Number(comment[1]) * 1000 + Number(comment[2]) * 100 + Number(comment[3]) * 10
        : 7400;
  return { roots, version };
}
