import { fault } from '../../shared/errors.js';

/** Parsed, inert math syntax. No macros, HTML or executable expansion. */
export interface MathNode {
  readonly kind: string;
  readonly text?: string;
  readonly children: readonly MathNode[];
}
const node = (kind: string, children: readonly MathNode[] = [], text?: string): MathNode => ({ kind, children, text });
const symbols: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ϵ',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'ϕ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  times: '×',
  cdot: '⋅',
  pm: '±',
  mp: '∓',
  div: '÷',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  equiv: '≡',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  sum: '∑',
  prod: '∏',
  int: '∫',
  oint: '∮',
  in: '∈',
  notin: '∉',
  subset: '⊂',
  subseteq: '⊆',
  cup: '∪',
  cap: '∩',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  Rightarrow: '⇒',
  langle: '⟨',
  rangle: '⟩',
  lbrace: '{',
  rbrace: '}',
  vert: '|',
  Vert: '‖',
  ldots: '…',
  cdots: '⋯',
  hbar: 'ℏ',
  ell: 'ℓ',
};
const operators = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'lim', 'min', 'max', 'det', 'sup', 'inf']);
const accents = new Set(['hat', 'widehat', 'bar', 'overline', 'underline', 'vec', 'dot', 'ddot', 'tilde', 'widetilde']);
const environments = new Set(['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'cases', 'aligned']);
function fail(message: string): never {
  throw fault('unsupported', message, 'sciviz');
}

/** TeX math subset, bounded to 16384 characters and 64 levels. Unsupported commands fail explicitly. */
export function parseMath(source: string): MathNode {
  if (typeof source !== 'string' || source.length > 16384) fail('Math must be a string of at most 16384 characters.');
  const tokens = source.replace(/^\$\$?([\s\S]*?)\$\$?$/, '$1').match(/\\[a-zA-Z]+|\\[^a-zA-Z]|\s+|[^\s]/gu) ?? [];
  let i = 0,
    depth = 0;
  const peek = () => {
    while (/^\s+$/.test(tokens[i] ?? '')) i++;
    return tokens[i];
  };
  const argument = (): MathNode => {
    if (++depth > 64) fail('Math nesting exceeds 64 levels.');
    const t = peek();
    if (!t || ['}', '^', '_', '&', '\\\\', '\\end'].includes(t)) fail('Expected a math argument.');
    i++;
    let out: MathNode;
    if (t === '{') {
      out = row('}');
      if (peek() !== '}') fail('Unclosed group.');
      i++;
    } else if (t === '\\frac' || t === '\\dfrac' || t === '\\tfrac') out = node('frac', [argument(), argument()]);
    else if (t === '\\sqrt') {
      let index: MathNode | undefined;
      if (peek() === '[') {
        i++;
        index = row(']');
        if (peek() !== ']') fail('Unclosed root index.');
        i++;
      }
      const base = argument();
      out = node('root', index ? [base, index] : [base]);
    } else if (t === '\\begin') {
      const name = rawGroup();
      if (!environments.has(name)) fail(`Unsupported environment ${name}.`);
      const rows: MathNode[] = [];
      let cells: MathNode[] = [];
      for (;;) {
        cells.push(row('&', '\\\\', '\\end'));
        const sep = peek();
        i++;
        if (sep === '&') continue;
        rows.push(node('tr', cells));
        cells = [];
        if (sep === '\\end') {
          if (rawGroup() !== name) fail('Mismatched environment.');
          break;
        }
        if (sep !== '\\\\') fail('Unclosed matrix.');
      }
      out = node('matrix', rows, name);
    } else if (t === '\\text' || t === '\\mathrm' || t === '\\operatorname') out = node('text', [], rawGroup());
    else if (t === '\\left' || t === '\\right') {
      const d = peek();
      if (!d) fail('Expected delimiter.');
      i++;
      out = node('delimiter', [], d === '.' ? '' : (symbols[d.replace(/^\\/, '')] ?? d));
    } else if (t.startsWith('\\')) {
      const cmd = t.slice(1);
      if (accents.has(cmd)) out = node('accent', [argument()], cmd);
      else if (symbols[cmd]) out = node('mo', [], symbols[cmd]);
      else if (operators.has(cmd)) out = node('operator', [], cmd);
      else if ([',', ':', ';', '!', 'quad', 'qquad', ' '].includes(cmd)) out = node('space', [], cmd);
      else if (['{', '}', '_', '%', '#', '&', '$'].includes(cmd)) out = node('mo', [], cmd);
      else fail(`Unsupported math command ${t}.`);
    } else out = node(/[0-9.]/.test(t) ? 'mn' : /[\p{L}]/u.test(t) ? 'mi' : 'mo', [], t === '-' ? '−' : t);
    depth--;
    return out;
  };
  const rawGroup = (): string => {
    if (peek() !== '{') fail('Expected braced text.');
    i++;
    let text = '';
    while (i < tokens.length && tokens[i] !== '}') {
      if (tokens[i] === '{' || tokens[i].startsWith('\\')) fail('Nested commands are not supported in text.');
      text += tokens[i++];
    }
    if (tokens[i++] !== '}') fail('Unclosed text.');
    return text;
  };
  const row = (...ends: string[]): MathNode => {
    const children: MathNode[] = [];
    while (peek() && !ends.includes(peek()!)) {
      if (peek() === '}') fail('Unexpected closing brace.');
      let base = argument();
      let sub: MathNode | undefined, sup: MathNode | undefined;
      while (peek() === '_' || peek() === '^') {
        const op = tokens[i++];
        const value = argument();
        if (op === '_') {
          if (sub) fail('Duplicate subscript.');
          sub = value;
        } else {
          if (sup) fail('Duplicate superscript.');
          sup = value;
        }
      }
      if (sub || sup) base = node('scripts', [base, sub ?? node('row'), sup ?? node('row')]);
      children.push(base);
    }
    return node('row', children);
  };
  return row();
}

export const mathXML = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Accessible native MathML; input is escaped, never inserted as markup. */
export function mathML(source: string, display = false): string {
  const emit = (n: MathNode): string => {
    const c = n.children.map(emit).join('');
    switch (n.kind) {
      case 'row':
        return `<mrow>${c}</mrow>`;
      case 'frac':
        return `<mfrac>${c}</mfrac>`;
      case 'root':
        return n.children.length === 2 ? `<mroot>${c}</mroot>` : `<msqrt>${c}</msqrt>`;
      case 'scripts':
        return `<msubsup>${c}</msubsup>`;
      case 'matrix': {
        const pairs: Record<string, string[]> = {
          pmatrix: ['(', ')'],
          bmatrix: ['[', ']'],
          Bmatrix: ['{', '}'],
          vmatrix: ['|', '|'],
          Vmatrix: ['‖', '‖'],
          cases: ['{', ''],
        };
        const p = pairs[n.text!] ?? ['', ''];
        return `<mrow><mo stretchy="true">${mathXML(p[0])}</mo><mtable>${c}</mtable><mo stretchy="true">${mathXML(p[1])}</mo></mrow>`;
      }
      case 'tr':
        return `<mtr>${n.children.map((x) => `<mtd>${emit(x)}</mtd>`).join('')}</mtr>`;
      case 'accent': {
        const marks: Record<string, string> = {
          hat: '^',
          widehat: '^',
          bar: '¯',
          overline: '¯',
          underline: '_',
          vec: '→',
          dot: '˙',
          ddot: '¨',
          tilde: '~',
          widetilde: '~',
        };
        const tag = n.text === 'underline' ? 'munder' : 'mover';
        return `<${tag} accent="true">${c}<mo stretchy="true">${marks[n.text!]}</mo></${tag}>`;
      }
      case 'space':
        return `<mspace width="${n.text === 'qquad' ? 2 : n.text === 'quad' ? 1 : n.text === '!' ? -0.167 : 0.167}em"/>`;
      default: {
        const tag = n.kind === 'text' ? 'mtext' : n.kind === 'operator' || n.kind === 'delimiter' ? 'mo' : n.kind;
        return `<${tag}>${mathXML(n.text ?? '')}</${tag}>`;
      }
    }
  };
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${display ? 'block' : 'inline'}" aria-label="${mathXML(source)}">${emit(parseMath(source))}</math>`;
}
