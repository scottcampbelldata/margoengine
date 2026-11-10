import { fault } from '../../shared/errors.js';
import { GLSLParser, type Expression } from './glsl-parser.js';
interface Macro {
  params?: string[];
  body: string;
}
/** Minimal C-style GLSL preprocessing, including function macros and conditional compilation. */
export function preprocessGLSL(source: string): string {
  const macros = new Map<string, Macro>([
    ['GL_ES', { body: '1' }],
    ['__VERSION__', { body: '100' }],
  ]);
  const expand = (input: string): string => {
    let output = input;
    for (let round = 0; round < 64; round++) {
      let changed = false;
      output = output.replace(/\b[A-Za-z_]\w*\b/g, (name, offset: number, whole: string) => {
        const macro = macros.get(name);
        if (!macro || macro.params) return name;
        // Function macros are expanded separately with balanced arguments.
        if (whole[offset - 1] === '#') return name;
        if (macro.body !== name) changed = true;
        return macro.body;
      });
      for (const [name, macro] of macros) {
        if (!macro.params) continue;
        const re = new RegExp('\\b' + name + '\\s*\\(', 'g');
        let m: RegExpExecArray | null;
        while ((m = re.exec(output))) {
          let level = 1,
            end = re.lastIndex,
            start = end;
          const args: string[] = [];
          for (; end < output.length && level; end++) {
            const c = output[end];
            if (c === '(') level++;
            else if (c === ')') {
              if (--level === 0) args.push(output.slice(start, end));
            } else if (c === ',' && level === 1) {
              args.push(output.slice(start, end));
              start = end + 1;
            }
          }
          if (args.length === 1 && args[0]!.trim() === '' && macro.params.length === 0) args.length = 0;
          if (level || args.length !== macro.params.length)
            throw fault('failed', `GLSL macro ${name} has invalid arguments; correct its invocation`);
          const body = macro.body.replace(/\b[A-Za-z_]\w*\b/g, (id) => {
            const index = macro.params!.indexOf(id);
            return index < 0 ? id : args[index]!;
          });
          output = output.slice(0, m.index) + body + output.slice(end);
          re.lastIndex = m.index + body.length;
          changed = true;
        }
      }
      if (output.length > 262144)
        throw fault('failed', 'Expanded GLSL is too large; reduce macro expansion below 262144 code units');
      if (!changed) return output;
    }
    throw fault('failed', 'GLSL macro expansion is recursive or too deep; reduce macro nesting below 64');
  };
  const evaluate = (e: Expression): number => {
    const args = e.args.map(evaluate),
      a = args[0] ?? 0,
      b = args[1] ?? 0;
    if (e.op === 'literal') return Number(e.value.replace(/[uU]$/, ''));
    if (e.op === 'name') return 0;
    if (e.op === 'conditional') return a ? args[1]! : args[2]!;
    if (e.op === 'prefix') return e.value === '!' ? +!a : e.value === '-' ? -a : e.value === '~' ? ~a : a;
    switch (e.value) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return Math.trunc(a / b);
      case '%':
        return a % b;
      case '==':
        return +(a === b);
      case '!=':
        return +(a !== b);
      case '<':
        return +(a < b);
      case '>':
        return +(a > b);
      case '<=':
        return +(a <= b);
      case '>=':
        return +(a >= b);
      case '&&':
        return +(!!a && !!b);
      case '||':
        return +(!!a || !!b);
      case '&':
        return a & b;
      case '|':
        return a | b;
      case '^':
        return a ^ b;
      case '<<':
        return a << b;
      case '>>':
        return a >> b;
      default:
        throw fault('failed', 'Invalid GLSL preprocessor condition; use an integer constant expression');
    }
  };
  const condition = (text: string) => {
    const expression = expand(
      text.replace(/\bdefined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))/g, (_all, a: string, b: string) =>
        macros.has(a ?? b) ? '1' : '0',
      ),
    );
    const program = new GLSLParser('const int condition=' + expression + ';').parse();
    return !!evaluate(program.globals[0]!.init!);
  };
  const stack: { parent: boolean; taken: boolean; active: boolean }[] = [];
  let active = true;
  const out: string[] = [];
  // Comments are blanked before preprocessing so macro names and directives inside them have no effect.
  source = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\\\r?\n/g, '');
  for (const line of source.split(/\r?\n/)) {
    const m = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
    if (!m) {
      out.push(active ? expand(line) : '');
      continue;
    }
    const directive = m[1]!,
      text = m[2]!.trim();
    if (['if', 'ifdef', 'ifndef'].includes(directive)) {
      const yes: boolean =
        active && (directive === 'if' ? condition(text) : directive === 'ifdef' ? macros.has(text) : !macros.has(text));
      stack.push({ parent: active, taken: yes, active: yes });
      active = yes;
      continue;
    }
    if (directive === 'else' || directive === 'elif') {
      const top = stack.at(-1);
      if (!top) throw fault('failed', 'GLSL conditional has no matching #if; correct the directives');
      top.active = top.parent && !top.taken && (directive === 'else' || condition(text));
      top.taken ||= top.active;
      active = top.active;
      continue;
    }
    if (directive === 'endif') {
      const top = stack.pop();
      if (!top) throw fault('failed', 'GLSL #endif has no matching #if; correct the directives');
      active = top.parent;
      continue;
    }
    if (!active) continue;
    if (directive === 'define') {
      const definition = /^([A-Za-z_]\w*)(?:\(([^)]*)\))?\s*(.*)$/.exec(text);
      if (!definition) throw fault('failed', 'Invalid GLSL #define; supply a name and replacement');
      macros.set(definition[1]!, {
        params:
          definition[2] === undefined
            ? undefined
            : definition[2].trim()
              ? definition[2].split(',').map((x) => x.trim())
              : [],
        body: definition[3]!,
      });
      continue;
    }
    if (directive === 'undef') {
      macros.delete(text);
      continue;
    }
    if (directive === 'version') {
      if (text !== '100')
        throw fault(
          'unsupported',
          'GLSL transition import accepts GLSL ES 1.00; use #version 100 or remove the directive',
        );
      continue;
    }
    if (['line', 'pragma', 'extension'].includes(directive)) continue;
    throw fault('failed', `GLSL #${directive} is invalid in this transition; correct its preprocessing directives`);
  }
  if (stack.length) throw fault('failed', 'Unclosed GLSL preprocessor conditional; add the matching #endif');
  return out.join('\n');
}
