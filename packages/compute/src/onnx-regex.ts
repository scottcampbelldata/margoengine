// Full-string matching of RE2 syntax (the syntax ONNX RegexFullMatch names), written from the published syntax table
// https://pkg.go.dev/regexp/syntax and matched with a Thompson NFA, one state set per code point, so no pattern can
// backtrack: Ken Thompson, "Regular expression search algorithm", 1968, https://doi.org/10.1145/363347.363387, and
// Russ Cox, "Regular Expression Matching Can Be Simple And Fast", 2007, https://swtch.com/~rsc/regexp/regexp1.html.
// The platform's own RegExp only answers whether ONE code point belongs to a class or Unicode property.
import { typeError } from '../../shared/errors.js';

type Test = (code: number) => boolean;
type Anchor = 'text-start' | 'text-end' | 'line-start' | 'line-end' | 'word' | 'not-word';
type Node =
  | { op: 'char'; test: Test }
  | { op: 'anchor'; at: Anchor }
  | { op: 'sequence'; items: Node[] }
  | { op: 'either'; items: Node[] }
  | { op: 'repeat'; item: Node; min: number; max: number };
type Inst = { op: 'char'; test: Test } | { op: 'anchor'; at: Anchor } | { op: 'split'; to: number[] } | { op: 'match' };
interface Flags {
  i: boolean;
  m: boolean;
  s: boolean;
}

const MAX_INSTRUCTIONS = 100_000;
// ASCII-only classes, as [low, high] pairs.
const PERL: Record<string, string> = { d: '09', s: '\t\n\f\r  ', w: '09AZaz__' };
const ASCII: Record<string, string> = {
  alnum: '09AZaz',
  alpha: 'AZaz',
  ascii: '\0\x7f',
  blank: '\t\t  ',
  cntrl: '\0\x1f\x7f\x7f',
  digit: '09',
  graph: '!~',
  lower: 'az',
  print: ' ~',
  punct: '!/:@[`{~',
  space: '\t\r  ',
  upper: 'AZ',
  word: '09AZaz__',
  xdigit: '09AFaf',
};
const CONTROL: Record<string, number> = { a: 7, f: 12, t: 9, n: 10, r: 13, v: 11 };

const escaped = (code: number): string => `\\u{${code.toString(16)}}`;
function platform(body: string, negated: boolean, fold: boolean): Test {
  const expression = new RegExp(`^[${negated ? '^' : ''}${body}]$`, fold ? 'iu' : 'u');
  return (code) => expression.test(String.fromCodePoint(code));
}
function pairs(ranges: string): string {
  let body = '';
  for (let j = 0; j < ranges.length; j += 2)
    body += `${escaped(ranges.charCodeAt(j))}-${escaped(ranges.charCodeAt(j + 1))}`;
  return body;
}
const isWord = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

class Parser {
  readonly #p: readonly string[];
  #at = 0;
  #depth = 0;
  constructor(pattern: string) {
    this.#p = Array.from(pattern);
  }
  fail(what: string): never {
    throw typeError(`ONNX RegexFullMatch pattern ${what} at character ${this.#at}; use RE2 syntax`, 'compute');
  }
  #peek(ahead = 0): string | undefined {
    return this.#p[this.#at + ahead];
  }
  #next(): string {
    const c = this.#p[this.#at++];
    if (c === undefined) this.fail('ends early');
    return c;
  }
  #eat(text: string): boolean {
    if (!Array.from(text).every((c, j) => this.#peek(j) === c)) return false;
    this.#at += text.length;
    return true;
  }
  parse(): Node {
    const node = this.#either({ i: false, m: false, s: false });
    if (this.#at < this.#p.length) this.fail('has an unmatched )');
    return node;
  }
  #either(flags: Flags): Node {
    // (?flags) changes the flags for the rest of its group, alternatives included.
    const scope = { ...flags };
    const branches = [this.#sequence(scope)];
    while (this.#eat('|')) branches.push(this.#sequence(scope));
    return branches.length === 1 ? branches[0] : { op: 'either', items: branches };
  }
  #sequence(flags: Flags): Node {
    const items: Node[] = [];
    let repeated = true;
    while (this.#peek() !== undefined && this.#peek() !== '|' && this.#peek() !== ')') {
      const bounds = this.#bounds();
      if (bounds) {
        const item = items.pop();
        if (!item || repeated) this.fail('repeats nothing or repeats a repetition');
        items.push({ op: 'repeat', item, min: bounds[0], max: bounds[1] });
        // A trailing ? asks for the shortest match, which cannot change whether the whole string matches.
        this.#eat('?');
        repeated = true;
        continue;
      }
      repeated = false;
      if (this.#eat('\\Q')) {
        while (this.#peek() !== undefined && !this.#eat('\\E'))
          items.push(this.#literal(this.#next().codePointAt(0)!, flags));
        continue;
      }
      const atom = this.#atom(flags);
      if (atom) items.push(atom);
      else repeated = true;
    }
    return { op: 'sequence', items };
  }
  #bounds(): [number, number] | null {
    if (this.#eat('*')) return [0, Infinity];
    if (this.#eat('+')) return [1, Infinity];
    if (this.#eat('?')) return [0, 1];
    if (this.#peek() !== '{') return null;
    // A brace that is not a complete count is an ordinary character.
    const found = /^\{(\d+)(,(\d*))?\}/.exec(this.#p.slice(this.#at, this.#at + 24).join(''));
    if (!found) return null;
    const min = Number(found[1]);
    const max = found[2] === undefined ? min : found[3] === '' ? Infinity : Number(found[3]);
    if (min > 1000 || (max !== Infinity && max > 1000) || max < min)
      this.fail('has a repetition count outside 0..1000');
    this.#at += found[0].length;
    return [min, max];
  }
  #literal(code: number, flags: Flags): Node {
    return { op: 'char', test: flags.i ? platform(escaped(code), false, true) : (c) => c === code };
  }
  #atom(flags: Flags): Node | null {
    const c = this.#next();
    if (c === '.') {
      const all = flags.s;
      return { op: 'char', test: (code) => all || code !== 10 };
    }
    if (c === '^') return { op: 'anchor', at: flags.m ? 'line-start' : 'text-start' };
    if (c === '$') return { op: 'anchor', at: flags.m ? 'line-end' : 'text-end' };
    if (c === '(') return this.#group(flags);
    if (c === '[') return { op: 'char', test: this.#class(flags) };
    if (c === '\\') {
      if (this.#eat('A')) return { op: 'anchor', at: 'text-start' };
      if (this.#eat('z')) return { op: 'anchor', at: 'text-end' };
      if (this.#eat('b')) return { op: 'anchor', at: 'word' };
      if (this.#eat('B')) return { op: 'anchor', at: 'not-word' };
      const set = this.#set(flags);
      return set ? { op: 'char', test: set } : this.#literal(this.#escape(), flags);
    }
    return this.#literal(c.codePointAt(0)!, flags);
  }
  #group(flags: Flags): Node | null {
    if (++this.#depth > 200) this.fail('nests more than 200 groups');
    let inner = flags;
    if (this.#eat('?')) {
      if (this.#eat('P<') || (this.#peek() === '<' && !'=!'.includes(this.#peek(1) ?? '=') && this.#eat('<'))) {
        let name = '';
        while (this.#peek() !== '>') name += this.#next();
        this.#at++;
        if (!/^\w+$/.test(name)) this.fail('has a bad group name');
      } else {
        inner = { ...flags };
        let set = true;
        for (;;) {
          const f = this.#next();
          if (f === ':') break;
          if (f === ')') {
            Object.assign(flags, inner);
            this.#depth--;
            return null;
          }
          if (f === '-' && set) set = false;
          else if (f === 'i' || f === 'm' || f === 's') inner[f] = set;
          else if (f !== 'U') this.fail('has a group or flag RE2 does not support (no lookaround)');
        }
      }
    }
    const node = this.#either(inner);
    if (!this.#eat(')')) this.fail('has an unclosed group');
    this.#depth--;
    return node;
  }
  /** A \d, \s, \w or \p class after its backslash, or null. */
  #set(flags: Flags): Test | null {
    const c = this.#peek();
    if (c === undefined) this.fail('ends with a backslash');
    const perl = PERL[c.toLowerCase()];
    if (perl) {
      this.#at++;
      return platform(pairs(perl), c !== c.toLowerCase(), flags.i);
    }
    if (c !== 'p' && c !== 'P') return null;
    this.#at++;
    let name = this.#next();
    if (name === '{') {
      name = '';
      while (this.#peek() !== '}') name += this.#next();
      this.#at++;
    }
    if (!/^\w+$/.test(name)) this.fail('has a bad Unicode class name');
    for (const property of [name, `Script=${name}`])
      try {
        return platform(`\\p{${property}}`, c === 'P', flags.i);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    return this.fail(`names an unknown Unicode class ${name}`);
  }
  /** A single escaped code point after its backslash. */
  #escape(): number {
    const c = this.#next();
    if (c in CONTROL) return CONTROL[c];
    if (c === 'x') {
      let hex = '';
      if (this.#eat('{')) {
        while (this.#peek() !== '}') hex += this.#next();
        this.#at++;
      } else hex = this.#next() + this.#next();
      const code = /^[0-9a-f]+$/i.test(hex) ? parseInt(hex, 16) : Infinity;
      if (code > 0x10ffff) this.fail('has a bad hexadecimal escape');
      return code;
    }
    if (/[0-7]/.test(c)) {
      // A lone nonzero digit would be a backreference, which RE2 does not support.
      if (c !== '0' && !/[0-7]/.test(this.#peek() ?? '')) this.fail('uses a backreference');
      let digits = c;
      while (digits.length < 3 && /[0-7]/.test(this.#peek() ?? '')) digits += this.#next();
      return parseInt(digits, 8);
    }
    const code = c.codePointAt(0)!;
    if (code < 128 && !/[0-9A-Za-z]/.test(c)) return code;
    return this.fail(`has an unsupported escape \\${c}`);
  }
  #class(flags: Flags): Test {
    const negated = this.#eat('^');
    const tests: Test[] = [];
    let body = '';
    let first = true;
    while (first || this.#peek() !== ']') {
      first = false;
      if (this.#peek() === '[' && this.#peek(1) === ':') {
        const found = /^\[:(\^?)([a-z]+):\]/.exec(this.#p.slice(this.#at, this.#at + 12).join(''));
        if (found) {
          const ranges = ASCII[found[2]];
          if (!ranges) this.fail(`names an unknown ASCII class ${found[2]}`);
          this.#at += found[0].length;
          tests.push(platform(pairs(ranges), found[1] === '^', flags.i));
          continue;
        }
      }
      let low: number;
      if (this.#eat('\\')) {
        const set = this.#set(flags);
        if (set) {
          tests.push(set);
          continue;
        }
        low = this.#escape();
      } else low = this.#next().codePointAt(0)!;
      if (this.#peek() === '-' && this.#peek(1) !== ']' && this.#peek(1) !== undefined) {
        this.#at++;
        const high = this.#eat('\\') ? this.#escape() : this.#next().codePointAt(0)!;
        if (high < low) this.fail('has a reversed range');
        body += `${escaped(low)}-${escaped(high)}`;
      } else body += escaped(low);
    }
    this.#at++;
    if (body) tests.push(platform(body, false, flags.i));
    return (code) => tests.some((test) => test(code)) !== negated;
  }
}

/** True when a node emits no instruction; repeating it would only spin through nested counts. */
function silent(node: Node): boolean {
  if (node.op === 'sequence') return node.items.every(silent);
  return node.op === 'repeat' && (node.max === 0 || silent(node.item));
}
function emit(node: Node, program: Inst[]): void {
  const push = (inst: Inst): number => {
    if (program.length >= MAX_INSTRUCTIONS)
      throw typeError('ONNX RegexFullMatch pattern expands past 100000 instructions; lower its repetitions', 'compute');
    return program.push(inst) - 1;
  };
  if (node.op === 'char' || node.op === 'anchor') push(node);
  else if (node.op === 'sequence') for (const item of node.items) emit(item, program);
  else if (node.op === 'either') {
    const split: Inst = { op: 'split', to: [] };
    push(split);
    const ends: { op: 'split'; to: number[] }[] = [];
    for (const item of node.items) {
      split.to.push(program.length);
      emit(item, program);
      const end = { op: 'split' as const, to: [] as number[] };
      push(end);
      ends.push(end);
    }
    for (const end of ends) end.to.push(program.length);
  } else {
    if (silent(node)) return;
    for (let j = 0; j < node.min; j++) emit(node.item, program);
    if (node.max === Infinity) {
      const loop = { op: 'split' as const, to: [] as number[] };
      const at = push(loop);
      loop.to.push(program.length);
      emit(node.item, program);
      push({ op: 'split', to: [at] });
      loop.to.push(program.length);
    } else {
      const skips: { op: 'split'; to: number[] }[] = [];
      for (let j = node.min; j < node.max; j++) {
        const skip = { op: 'split' as const, to: [] as number[] };
        push(skip);
        skip.to.push(program.length);
        skips.push(skip);
        emit(node.item, program);
      }
      for (const skip of skips) skip.to.push(program.length);
    }
  }
}

/** Compiles an RE2 pattern into a test of whether the whole string matches it. */
export function fullMatcher(pattern: string): (text: string) => boolean {
  const program: Inst[] = [];
  emit(new Parser(pattern).parse(), program);
  program.push({ op: 'match' });
  return (text) => {
    const input = Array.from(text, (c) => c.codePointAt(0)!);
    const seen = new Int32Array(program.length).fill(-1);
    const holds = (at: Anchor, i: number): boolean => {
      if (at === 'text-start') return i === 0;
      if (at === 'text-end') return i === input.length;
      if (at === 'line-start') return i === 0 || input[i - 1] === 10;
      if (at === 'line-end') return i === input.length || input[i] === 10;
      const boundary = (i > 0 && isWord(input[i - 1])) !== (i < input.length && isWord(input[i]));
      return boundary === (at === 'word');
    };
    let states = [0];
    for (let i = 0; ; i++) {
      // Follow every empty transition once per position, collecting the states that consume a character.
      const waiting: { test: Test; next: number }[] = [];
      const stack = states;
      let matched = false;
      while (stack.length) {
        const pc = stack.pop()!;
        if (seen[pc] === i) continue;
        seen[pc] = i;
        const inst = program[pc];
        if (inst.op === 'split') stack.push(...inst.to);
        else if (inst.op === 'anchor') {
          if (holds(inst.at, i)) stack.push(pc + 1);
        } else if (inst.op === 'char') waiting.push({ test: inst.test, next: pc + 1 });
        else matched = true;
      }
      if (i === input.length) return matched;
      states = [];
      for (const { test, next } of waiting) if (test(input[i])) states.push(next);
      if (!states.length) return false;
    }
  };
}
