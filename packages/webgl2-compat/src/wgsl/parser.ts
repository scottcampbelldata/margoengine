// WGSL parser: recursive descent over the grammar of the W3C WGSL specification (section 16), including its
// operator rules (no mixing of `&`, `|` and `^` without parentheses, no chained comparisons, shifts of unary
// operands only). Nesting is bounded by WGSL_LIMITS.depth, so hostile input fails with a coded error, never a stack
// overflow.
import type {
  Attribute,
  BinaryOp,
  CallExpr,
  CompoundStmt,
  Directive,
  Expr,
  GlobalDecl,
  IdentExpr,
  IfStmt,
  Member,
  ModuleAst,
  Stmt,
  SwitchClause,
  ValueDecl,
} from './ast.js';
import { SourceMap, WGSL_LIMITS, type WGSLError } from './errors.js';
import { type Token, tokenize } from './tokens.js';

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
const RELATIONAL = new Set(['==', '!=', '<', '>', '<=', '>=']);

/** Parses WGSL source into a syntax tree. Throws {@link WGSLError} (code `syntax` or `limit`) on bad input. */
export function parse(text: string, map: SourceMap = new SourceMap(text)): ModuleAst {
  return new Parser(tokenize(text, map), map).module();
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly map: SourceMap,
  ) {}

  // ---- token helpers ----
  private get t(): Token {
    return this.tokens[this.i];
  }
  private peek(n = 1): Token {
    return this.tokens[Math.min(this.i + n, this.tokens.length - 1)];
  }
  private is(value: string, token: Token = this.t): boolean {
    return (token.kind === 'punct' || token.kind === 'keyword') && token.value === value && !token.template;
  }
  private isTemplateStart(token: Token = this.t): boolean {
    return token.kind === 'punct' && token.value === '<' && token.template === true;
  }
  private eat(value: string): boolean {
    if (!this.is(value)) return false;
    this.i++;
    return true;
  }
  private fail(detail: string, token: Token = this.t): WGSLError {
    return this.map.error('syntax', detail, token.start);
  }
  private describe(token: Token): string {
    return token.kind === 'eof' ? 'the end of the source' : `'${token.value}'`;
  }
  private expect(value: string, what?: string): Token {
    const token = this.t;
    if (!this.is(value)) throw this.fail(`Expected '${value}'${what ? ` ${what}` : ''}, found ${this.describe(token)}`);
    this.i++;
    return token;
  }
  private ident(what: string): Token {
    const token = this.t;
    if (token.kind !== 'ident')
      throw this.fail(
        token.kind === 'keyword'
          ? `Expected ${what}, found the keyword '${token.value}'; keywords cannot be names`
          : `Expected ${what}, found ${this.describe(token)}`,
      );
    this.i++;
    return token;
  }
  private enter(): void {
    if (++this.depth > WGSL_LIMITS.depth)
      throw this.map.error(
        'limit',
        `WGSL nesting is deeper than ${WGSL_LIMITS.depth} levels; flatten the code`,
        this.t.start,
      );
  }
  private leave(): void {
    this.depth--;
  }
  private last(): number {
    return this.tokens[this.i - 1].end;
  }

  /** In expression position, WGSL's context-aware lookahead makes `--` two minus tokens. */
  private takeNegation(): void {
    const token = this.t;
    // Consume the first minus and retain the second at this cursor. No shifting of the token array.
    this.tokens[this.i] = { ...token, value: '-', start: token.start + 1 };
  }

  // ---- module ----
  module(): ModuleAst {
    const directives: Directive[] = [];
    while (this.is('enable') || this.is('requires') || this.is('diagnostic')) {
      const start = this.t.start,
        kind = this.t.value as Directive['kind'];
      this.i++;
      const names: string[] = [];
      if (kind === 'diagnostic') names.push(...this.diagnosticControl());
      else
        do {
          if (this.is(';')) break;
          names.push(this.ident(`an extension name after '${kind}'`).value);
        } while (this.eat(','));
      this.expect(';', `after the ${kind} directive`);
      directives.push({ kind, names, start, end: this.last() });
    }
    const declarations: GlobalDecl[] = [];
    while (this.t.kind !== 'eof') {
      if (this.eat(';')) continue;
      if (this.is('enable') || this.is('requires') || this.is('diagnostic')) {
        throw this.fail(`'${this.t.value}' directives must come before every declaration; move it to the top`);
      }
      declarations.push(this.globalDecl());
    }
    return { directives, declarations };
  }

  private diagnosticControl(): string[] {
    this.expect('(', "after 'diagnostic'");
    const severity = this.ident('a severity (error, warning, info, off)').value;
    this.expect(',');
    let rule = this.ident('a diagnostic rule name').value;
    if (this.eat('.')) rule += `.${this.ident('a diagnostic rule name').value}`;
    this.eat(',');
    this.expect(')', 'to close the diagnostic control');
    return [severity, rule];
  }

  private attributes(): Attribute[] {
    const out: Attribute[] = [];
    while (this.is('@')) {
      const start = this.t.start;
      this.i++;
      const token = this.t;
      // `@const` and `@diagnostic(...)`: attribute names may be keywords.
      if (token.kind !== 'ident' && token.kind !== 'keyword') throw this.fail(`Expected an attribute name after '@'`);
      this.i++;
      const args: Expr[] = [];
      if (token.value === 'diagnostic') {
        this.diagnosticControl();
      } else if (this.eat('(')) {
        while (!this.is(')')) {
          args.push(this.expression());
          if (!this.eat(',')) break;
        }
        this.expect(')', `to close @${token.value}(`);
      }
      out.push({ name: token.value, args, start, end: this.last() });
    }
    return out;
  }

  private globalDecl(): GlobalDecl {
    const attributes = this.attributes(),
      start = attributes[0]?.start ?? this.t.start;
    const t = this.t;
    if (this.is('fn')) return this.functionDecl(attributes, start);
    if (this.is('var') || this.is('override') || this.is('const')) {
      const decl = this.valueDecl(attributes, start);
      this.expect(';', `after the ${decl.kind} declaration`);
      return { kind: 'global', decl, start, end: this.last() };
    }
    if (attributes.length) throw this.fail(`Attributes cannot apply to ${this.describe(t)}`, t);
    if (this.is('struct')) {
      this.i++;
      const name = this.ident('a struct name');
      this.expect('{', 'to open the struct body');
      const members: Member[] = [];
      while (!this.is('}')) {
        members.push(this.member('a struct member name'));
        if (!this.eat(',')) break;
      }
      this.expect('}', 'to close the struct body (members are separated by commas)');
      return { kind: 'struct', name: name.value, nameStart: name.start, members, start, end: this.last() };
    }
    if (this.is('alias')) {
      this.i++;
      const name = this.ident('an alias name');
      this.expect('=', 'after the alias name');
      const type = this.typeSpecifier();
      this.expect(';', 'after the alias');
      return { kind: 'alias', name: name.value, nameStart: name.start, type, start, end: this.last() };
    }
    if (this.is('const_assert')) {
      this.i++;
      const expr = this.expression();
      this.expect(';', 'after const_assert');
      return { kind: 'const_assert', expr, start, end: this.last() };
    }
    if (this.is('let'))
      throw this.fail("'let' is not allowed at module scope; use 'const' (or 'override' for a pipeline constant)");
    throw this.fail(`Expected a declaration (fn, var, const, override, struct, alias), found ${this.describe(t)}`);
  }

  private member(what: string): Member {
    const attributes = this.attributes(),
      name = this.ident(what);
    this.expect(':', `after '${name.value}'`);
    const type = this.typeSpecifier();
    return {
      name: name.value,
      nameStart: name.start,
      type,
      attributes,
      start: attributes[0]?.start ?? name.start,
      end: this.last(),
    };
  }

  private functionDecl(attributes: Attribute[], start: number): GlobalDecl {
    this.expect('fn');
    const name = this.ident('a function name');
    this.expect('(', `after the function name '${name.value}'`);
    const params: Member[] = [];
    while (!this.is(')')) {
      params.push(this.member('a parameter name'));
      if (!this.eat(',')) break;
    }
    this.expect(')', 'to close the parameter list');
    let returnType: Expr | undefined,
      returnAttributes: Attribute[] = [];
    if (this.eat('->')) {
      returnAttributes = this.attributes();
      returnType = this.typeSpecifier();
    }
    const body = this.compound();
    return {
      kind: 'fn',
      name: name.value,
      nameStart: name.start,
      params,
      returnType,
      returnAttributes,
      body,
      attributes,
      start,
      end: this.last(),
    };
  }

  /** `var<...> name: T = e`, `let name = e`, `const name: T = e`, `override name: T = e` (no `;`). */
  private valueDecl(attributes: Attribute[], start: number): ValueDecl {
    const kind = this.t.value as ValueDecl['kind'];
    this.i++;
    let template: Expr[] | undefined;
    if (kind === 'var' && this.isTemplateStart()) template = this.templateList();
    const name = this.ident(`a name after '${kind}'`);
    let type: Expr | undefined, init: Expr | undefined;
    if (this.eat(':')) type = this.typeSpecifier();
    if (this.eat('=')) init = this.expression();
    if ((kind === 'let' || kind === 'const') && !init)
      throw this.fail(`'${kind} ${name.value}' needs an initializer ('= value')`);
    return { kind, name: name.value, nameStart: name.start, template, type, init, attributes, start, end: this.last() };
  }

  private templateList(): Expr[] {
    const open = this.t;
    if (!this.isTemplateStart()) throw this.fail(`Expected a template list '<...>', found ${this.describe(open)}`);
    this.i++;
    const args: Expr[] = [];
    this.enter();
    while (!(this.t.kind === 'punct' && this.t.value === '>' && this.t.template)) {
      args.push(this.expression());
      if (!this.eat(',')) break;
    }
    this.leave();
    if (!(this.t.kind === 'punct' && this.t.value === '>' && this.t.template))
      throw this.fail(`Expected '>' to close the template list, found ${this.describe(this.t)}`);
    this.i++;
    return args;
  }

  /** A type: an identifier with an optional template list. */
  private typeSpecifier(): IdentExpr {
    const token = this.t;
    if (token.kind !== 'ident') throw this.fail(`Expected a type, found ${this.describe(token)}`);
    this.i++;
    const template = this.isTemplateStart() ? this.templateList() : undefined;
    return { kind: 'ident', name: token.value, template, start: token.start, end: this.last() };
  }

  // ---- statements ----
  private compound(attributes: Attribute[] = this.attributes()): CompoundStmt {
    const start = attributes[0]?.start ?? this.t.start;
    this.expect('{', 'to open a block');
    this.enter();
    const body: Stmt[] = [];
    while (!this.is('}')) {
      if (this.t.kind === 'eof') throw this.fail("Expected '}' to close the block, found the end of the source");
      const s = this.statement();
      if (s) body.push(s);
    }
    this.leave();
    this.i++;
    return { kind: 'compound', body, attributes, start, end: this.last() };
  }

  private statement(): Stmt | undefined {
    if (this.eat(';')) return undefined;
    this.enter();
    try {
      const attributes = this.attributes(),
        start = attributes[0]?.start ?? this.t.start,
        t = this.t;
      if (this.is('{')) return this.compound(attributes);
      if (this.is('if')) return this.ifStmt(attributes, start);
      if (this.is('switch')) return this.switchStmt(attributes, start);
      if (this.is('loop')) return this.loopStmt(attributes, start);
      if (this.is('for')) return this.forStmt(attributes, start);
      if (this.is('while')) {
        this.i++;
        const condition = this.expression();
        const body = this.compound();
        return { kind: 'while', condition, body, attributes, start, end: this.last() };
      }
      if (attributes.length) throw this.fail(`Attributes cannot apply to this statement`, t);
      let s: Stmt;
      if (this.is('return')) {
        this.i++;
        const value = this.is(';') ? undefined : this.expression();
        s = { kind: 'return', value, start, end: this.last() };
      } else if (this.is('break') || this.is('continue') || this.is('discard')) {
        this.i++;
        if (t.value === 'break' && this.is('if'))
          throw this.fail("'break if' may only end a continuing block; use 'if c { break; }' here", t);
        s = { kind: t.value as 'break' | 'continue' | 'discard', start, end: this.last() };
      } else if (this.is('const_assert')) {
        this.i++;
        s = { kind: 'const_assert', expr: this.expression(), start, end: this.last() };
      } else s = this.simpleStatement();
      this.expect(';', 'to end the statement');
      return s;
    } finally {
      this.leave();
    }
  }

  /** Declarations, assignments, increments and calls: the statements a `for` header may hold too. */
  private simpleStatement(): Stmt {
    const start = this.t.start;
    if (this.is('let') || this.is('var') || this.is('const')) {
      const decl = this.valueDecl([], start);
      return { kind: 'decl', decl, start, end: this.last() };
    }
    if (this.t.kind === 'punct' && this.t.value === '_') {
      this.i++;
      this.expect('=', "after '_'");
      const rhs = this.expression();
      return { kind: 'assign', op: '=', lhs: null, rhs, start, end: this.last() };
    }
    const lhs = this.unary();
    if (lhs.kind === 'call' && (this.is(';') || this.is(')')))
      return { kind: 'call', call: lhs, start, end: this.last() };
    if (this.is('++') || this.is('--')) {
      const op = this.t.value as '++' | '--';
      this.i++;
      return { kind: 'increment', op, lhs, start, end: this.last() };
    }
    if (this.t.kind === 'punct' && !this.t.template && ASSIGN_OPS.has(this.t.value)) {
      const op = this.t.value as '=';
      this.i++;
      const rhs = this.expression();
      return { kind: 'assign', op, lhs, rhs, start, end: this.last() };
    }
    throw this.fail(`Expected an assignment, an increment or a function call, found ${this.describe(this.t)}`);
  }

  private ifStmt(attributes: Attribute[], start: number): IfStmt {
    this.expect('if');
    const condition = this.expression(),
      then = this.compound();
    let otherwise: CompoundStmt | IfStmt | undefined;
    if (this.eat('else')) {
      if (this.is('if')) otherwise = this.ifStmt([], this.t.start);
      else otherwise = this.compound();
    }
    return { kind: 'if', condition, then, else: otherwise, attributes, start, end: this.last() };
  }

  private switchStmt(attributes: Attribute[], start: number): Stmt {
    this.expect('switch');
    const selector = this.expression();
    this.attributes();
    this.expect('{', 'to open the switch body');
    const clauses: SwitchClause[] = [];
    while (!this.is('}')) {
      const clauseStart = this.t.start,
        selectors: (Expr | null)[] = [];
      if (this.eat('default')) {
        selectors.push(null);
        this.eat(':');
      } else if (this.eat('case')) {
        do {
          if (this.is(':') || this.is('{')) break;
          if (this.eat('default')) selectors.push(null);
          else selectors.push(this.expression());
        } while (this.eat(','));
        if (!selectors.length) throw this.fail("Expected a case selector after 'case'");
        this.eat(':');
      } else throw this.fail(`Expected 'case' or 'default' in the switch body, found ${this.describe(this.t)}`);
      const body = this.compound();
      clauses.push({ selectors, body, start: clauseStart, end: this.last() });
    }
    this.i++;
    return { kind: 'switch', selector, clauses, attributes, start, end: this.last() };
  }

  private loopStmt(attributes: Attribute[], start: number): Stmt {
    this.expect('loop');
    const bodyAttributes = this.attributes(),
      bodyStart = this.t.start;
    this.expect('{', 'to open the loop body');
    this.enter();
    const statements: Stmt[] = [];
    let continuing: { body: CompoundStmt; breakIf?: Expr; start: number; end: number } | undefined;
    while (!this.is('}')) {
      if (this.t.kind === 'eof') throw this.fail("Expected '}' to close the loop, found the end of the source");
      if (this.is('continuing')) {
        const cStart = this.t.start;
        this.i++;
        const cAttributes = this.attributes(),
          cBodyStart = this.t.start;
        this.expect('{', 'to open the continuing block');
        this.enter();
        const body: Stmt[] = [];
        let breakIf: Expr | undefined;
        while (!this.is('}')) {
          if ((this.t as Token).kind === 'eof') throw this.fail("Expected '}' to close the continuing block");
          if (this.is('break') && this.is('if', this.peek())) {
            this.i += 2;
            breakIf = this.expression();
            this.expect(';', "after 'break if'");
            if (!this.is('}')) throw this.fail("'break if' must be the last statement of the continuing block");
            break;
          }
          const s = this.statement();
          if (s) body.push(s);
        }
        this.leave();
        this.expect('}');
        continuing = {
          body: { kind: 'compound', body, attributes: cAttributes, start: cBodyStart, end: this.last() },
          breakIf,
          start: cStart,
          end: this.last(),
        };
        if (!this.is('}')) throw this.fail('The continuing block must be the last thing in the loop body');
        break;
      }
      const s = this.statement();
      if (s) statements.push(s);
    }
    this.leave();
    this.expect('}', 'to close the loop body');
    return {
      kind: 'loop',
      body: { kind: 'compound', body: statements, attributes: bodyAttributes, start: bodyStart, end: this.last() },
      continuing,
      attributes,
      start,
      end: this.last(),
    };
  }

  private forStmt(attributes: Attribute[], start: number): Stmt {
    this.expect('for');
    this.expect('(', "after 'for'");
    const init = this.is(';') ? undefined : this.simpleStatement();
    this.expect(';', 'after the for initializer');
    const condition = this.is(';') ? undefined : this.expression();
    this.expect(';', 'after the for condition');
    const update = this.is(')') ? undefined : this.simpleStatement();
    if (update?.kind === 'decl') throw this.fail('A for update cannot declare a variable', this.tokens[this.i - 1]);
    this.expect(')', 'to close the for header');
    const body = this.compound();
    return { kind: 'for', init, condition, update, body, attributes, start, end: this.last() };
  }

  // ---- expressions ----
  /** expression: relational, short-circuit (`||`, `&&`) or bitwise chains, per the WGSL grammar. */
  expression(): Expr {
    this.enter();
    try {
      const start = this.t.start;
      const first = this.unary();
      // A bitwise chain of unary operands: `a & b & c`, `a | b`, `a ^ b`; never mixed.
      if (this.is('&') || this.is('|') || this.is('^')) {
        const op = this.t.value as BinaryOp;
        let left: Expr = first;
        while (this.is(op)) {
          this.i++;
          left = { kind: 'binary', op, left, right: this.unary(), start, end: this.last() };
        }
        if (this.is('&') || this.is('|') || this.is('^') || this.is('&&') || this.is('||'))
          throw this.fail(`Mixing '${op}' with '${this.t.value}' needs parentheses`);
        if (
          this.t.kind === 'punct' &&
          !this.t.template &&
          (RELATIONAL.has(this.t.value) || ['+', '-', '*', '/', '%', '<<', '>>'].includes(this.t.value))
        )
          throw this.fail(`'${op}' and '${this.t.value}' need parentheses to combine`);
        return left;
      }
      let left = this.relationalRest(first, start);
      if (this.is('&&') || this.is('||')) {
        const op = this.t.value as BinaryOp;
        while (this.is(op)) {
          this.i++;
          const operandStart = this.t.start;
          left = {
            kind: 'binary',
            op,
            left,
            right: this.relationalRest(this.unary(), operandStart),
            start,
            end: this.last(),
          };
        }
        if (this.is('&&') || this.is('||')) throw this.fail(`Mixing '${op}' with '${this.t.value}' needs parentheses`);
      }
      return left;
    } finally {
      this.leave();
    }
  }

  /** relational_expression, given its first unary operand. */
  private relationalRest(first: Expr, start: number): Expr {
    const left = this.shiftRest(first, start);
    if (this.t.kind === 'punct' && !this.t.template && RELATIONAL.has(this.t.value)) {
      const op = this.t.value as BinaryOp;
      this.i++;
      const rightStart = this.t.start,
        right = this.shiftRest(this.unary(), rightStart);
      if (this.t.kind === 'punct' && !this.t.template && RELATIONAL.has(this.t.value))
        throw this.fail(`Comparisons cannot be chained ('${op}' then '${this.t.value}'); use && between them`);
      return { kind: 'binary', op, left, right, start, end: this.last() };
    }
    return left;
  }

  /** shift_expression: `unary << unary`, `unary >> unary`, or an additive expression. */
  private shiftRest(first: Expr, start: number): Expr {
    if (this.is('<<') || this.is('>>')) {
      const op = this.t.value as BinaryOp;
      this.i++;
      const right = this.unary();
      if (this.t.kind === 'punct' && !this.t.template && ['<<', '>>', '+', '-', '*', '/', '%'].includes(this.t.value))
        throw this.fail(`'${op}' and '${this.t.value}' need parentheses to combine`);
      return { kind: 'binary', op, left: first, right, start, end: this.last() };
    }
    let left = this.multiplicativeRest(first, start);
    while (this.is('+') || this.is('-') || this.is('--')) {
      const op = this.is('--') ? '-' : (this.t.value as BinaryOp);
      if (this.is('--')) this.takeNegation();
      else this.i++;
      const rightStart = this.t.start;
      left = {
        kind: 'binary',
        op,
        left,
        right: this.multiplicativeRest(this.unary(), rightStart),
        start,
        end: this.last(),
      };
    }
    return left;
  }

  private multiplicativeRest(first: Expr, start: number): Expr {
    let left = first;
    while (this.is('*') || this.is('/') || this.is('%')) {
      const op = this.t.value as BinaryOp;
      this.i++;
      left = { kind: 'binary', op, left, right: this.unary(), start, end: this.last() };
    }
    return left;
  }

  private unary(): Expr {
    const t = this.t;
    if (
      t.kind === 'punct' &&
      (t.value === '-' || t.value === '--' || t.value === '!' || t.value === '~' || t.value === '*' || t.value === '&')
    ) {
      if (t.value === '--') this.takeNegation();
      else this.i++;
      this.enter();
      const operand = this.unary();
      this.leave();
      return { kind: 'unary', op: t.value === '--' ? '-' : t.value, operand, start: t.start, end: this.last() };
    }
    if (t.kind === 'punct' && t.value === '&&') {
      // `&&x` is `&(&x)` in unary position.
      this.i++;
      this.enter();
      const operand = this.unary();
      this.leave();
      const inner = { kind: 'unary' as const, op: '&' as const, operand, start: t.start + 1, end: this.last() };
      return { kind: 'unary', op: '&', operand: inner, start: t.start, end: this.last() };
    }
    return this.postfix(this.primary());
  }

  private postfix(base: Expr): Expr {
    let e = base;
    for (;;) {
      if (this.is('.')) {
        this.i++;
        const name = this.t;
        if (name.kind !== 'ident') throw this.fail(`Expected a member name after '.', found ${this.describe(name)}`);
        this.i++;
        e = {
          kind: 'member',
          object: e,
          member: name.value,
          memberStart: name.start,
          start: base.start,
          end: name.end,
        };
      } else if (this.is('[')) {
        this.i++;
        const index = this.expression();
        this.expect(']', 'to close the index');
        e = { kind: 'index', object: e, index, start: base.start, end: this.last() };
      } else return e;
    }
  }

  private primary(): Expr {
    const t = this.t;
    if (t.kind === 'int' || t.kind === 'float') {
      this.i++;
      return { kind: 'literal', type: t.kind, value: t.value, start: t.start, end: t.end };
    }
    if (this.is('true') || this.is('false')) {
      this.i++;
      return { kind: 'literal', type: 'bool', value: t.value, start: t.start, end: t.end };
    }
    if (this.is('(')) {
      this.i++;
      const expr = this.expression();
      this.expect(')', 'to close the parenthesis');
      return { kind: 'paren', expr, start: t.start, end: this.last() };
    }
    if (t.kind === 'ident') {
      this.i++;
      const template = this.isTemplateStart() ? this.templateList() : undefined,
        callee: IdentExpr = { kind: 'ident', name: t.value, template, start: t.start, end: this.last() };
      if (this.is('(')) return this.call(callee);
      return callee;
    }
    if (t.kind === 'keyword') throw this.fail(`Expected an expression, found the keyword '${t.value}'`);
    throw this.fail(`Expected an expression, found ${this.describe(t)}`);
  }

  private call(callee: IdentExpr): CallExpr {
    this.expect('(');
    this.enter();
    const args: Expr[] = [];
    while (!this.is(')')) {
      args.push(this.expression());
      if (!this.eat(',')) break;
    }
    this.leave();
    this.expect(')', `to close the arguments of '${callee.name}'`);
    return { kind: 'call', callee, args, start: callee.start, end: this.last() };
  }
}
