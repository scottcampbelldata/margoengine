// The WGSL syntax tree, as the parser builds it (grammar of the W3C WGSL specification, section 16). Every node
// carries `start` and `end` offsets into the source; SourceMap turns them into lines and columns. Types are written
// as expressions in WGSL (`vec3<f32>`, `array<Light, 4>`), so a type is an `IdentExpr` with template arguments.

/** Source span: offsets in UTF-16 code units, `end` exclusive. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** `@name` or `@name(args)`. */
export interface Attribute extends Span {
  readonly name: string;
  readonly args: readonly Expr[];
}

/** A name, with template arguments when written (`vec3<f32>`, `ptr<function, i32>`, `light`). */
export interface IdentExpr extends Span {
  readonly kind: 'ident';
  readonly name: string;
  readonly template?: readonly Expr[];
}

/** `true`, `false`, `1`, `2u`, `1.5f`, `0x1p4`: `value` is the source text. */
export interface LiteralExpr extends Span {
  readonly kind: 'literal';
  readonly type: 'bool' | 'int' | 'float';
  readonly value: string;
}

/** A call of a function, a type constructor or a conversion: `f(a)`, `vec3<f32>(1)`, `array(1, 2)`. */
export interface CallExpr extends Span {
  readonly kind: 'call';
  readonly callee: IdentExpr;
  readonly args: readonly Expr[];
}

/** `(e)`. */
export interface ParenExpr extends Span {
  readonly kind: 'paren';
  readonly expr: Expr;
}

/** `e.name`: a struct member or a swizzle. */
export interface MemberExpr extends Span {
  readonly kind: 'member';
  readonly object: Expr;
  readonly member: string;
  readonly memberStart: number;
}

/** `e[i]`. */
export interface IndexExpr extends Span {
  readonly kind: 'index';
  readonly object: Expr;
  readonly index: Expr;
}

/** Prefix operators. */
export type UnaryOp = '-' | '!' | '~' | '*' | '&';

/** `-e`, `!e`, `~e`, `*p`, `&v`. */
export interface UnaryExpr extends Span {
  readonly kind: 'unary';
  readonly op: UnaryOp;
  readonly operand: Expr;
}

/** Binary operators. */
export type BinaryOp =
  | '||'
  | '&&'
  | '|'
  | '&'
  | '^'
  | '=='
  | '!='
  | '<'
  | '>'
  | '<='
  | '>='
  | '<<'
  | '>>'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%';

/** `a op b`. */
export interface BinaryExpr extends Span {
  readonly kind: 'binary';
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

/** Any expression. */
export type Expr = IdentExpr | LiteralExpr | CallExpr | ParenExpr | MemberExpr | IndexExpr | UnaryExpr | BinaryExpr;

/** `let`, `var`, `const` or `override`: the parts each may have. */
export interface ValueDecl extends Span {
  readonly kind: 'let' | 'var' | 'const' | 'override';
  readonly name: string;
  readonly nameStart: number;
  /** `var<storage, read_write>`: address space and access mode, as written. */
  readonly template?: readonly Expr[];
  readonly type?: Expr;
  readonly init?: Expr;
  readonly attributes: readonly Attribute[];
}

/** `{ ... }`. */
export interface CompoundStmt extends Span {
  readonly kind: 'compound';
  readonly body: readonly Stmt[];
  readonly attributes: readonly Attribute[];
}

/** `return;` or `return e;`. */
export interface ReturnStmt extends Span {
  readonly kind: 'return';
  readonly value?: Expr;
}

/** `if c {..} else if .. else {..}`. */
export interface IfStmt extends Span {
  readonly kind: 'if';
  readonly condition: Expr;
  readonly then: CompoundStmt;
  readonly else?: CompoundStmt | IfStmt;
  readonly attributes: readonly Attribute[];
}

/** One `case a, b:` or `default:` clause; `null` in `selectors` is `default`. */
export interface SwitchClause extends Span {
  readonly selectors: readonly (Expr | null)[];
  readonly body: CompoundStmt;
}

/** `switch e { ... }`. */
export interface SwitchStmt extends Span {
  readonly kind: 'switch';
  readonly selector: Expr;
  readonly clauses: readonly SwitchClause[];
  readonly attributes: readonly Attribute[];
}

/** `loop { ... continuing { ... break if c; } }`. */
export interface LoopStmt extends Span {
  readonly kind: 'loop';
  readonly body: CompoundStmt;
  readonly continuing?: { readonly body: CompoundStmt; readonly breakIf?: Expr } & Span;
  readonly attributes: readonly Attribute[];
}

/** `for (init; condition; update) { ... }`. */
export interface ForStmt extends Span {
  readonly kind: 'for';
  readonly init?: Stmt;
  readonly condition?: Expr;
  readonly update?: Stmt;
  readonly body: CompoundStmt;
  readonly attributes: readonly Attribute[];
}

/** `while c { ... }`. */
export interface WhileStmt extends Span {
  readonly kind: 'while';
  readonly condition: Expr;
  readonly body: CompoundStmt;
  readonly attributes: readonly Attribute[];
}

/** `break;`, `continue;`, `discard;`. */
export interface JumpStmt extends Span {
  readonly kind: 'break' | 'continue' | 'discard';
}

/** A `let`, `var` or `const` in a function body. */
export interface DeclStmt extends Span {
  readonly kind: 'decl';
  readonly decl: ValueDecl;
}

/** `lhs = rhs;`, `lhs += rhs;`, `_ = rhs;` (`lhs` null for `_`). */
export interface AssignStmt extends Span {
  readonly kind: 'assign';
  readonly op: '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>=';
  readonly lhs: Expr | null;
  readonly rhs: Expr;
}

/** `lhs++;`, `lhs--;`. */
export interface IncrementStmt extends Span {
  readonly kind: 'increment';
  readonly op: '++' | '--';
  readonly lhs: Expr;
}

/** `f(a);`. */
export interface CallStmt extends Span {
  readonly kind: 'call';
  readonly call: CallExpr;
}

/** `const_assert e;` */
export interface ConstAssert extends Span {
  readonly kind: 'const_assert';
  readonly expr: Expr;
}

/** Any statement. */
export type Stmt =
  | CompoundStmt
  | ReturnStmt
  | IfStmt
  | SwitchStmt
  | LoopStmt
  | ForStmt
  | WhileStmt
  | JumpStmt
  | DeclStmt
  | AssignStmt
  | IncrementStmt
  | CallStmt
  | ConstAssert;

/** `name: type` with attributes: a struct member or a function parameter. */
export interface Member extends Span {
  readonly name: string;
  readonly nameStart: number;
  readonly type: Expr;
  readonly attributes: readonly Attribute[];
}

/** `struct Name { ... }`. */
export interface StructDecl extends Span {
  readonly kind: 'struct';
  readonly name: string;
  readonly nameStart: number;
  readonly members: readonly Member[];
}

/** `alias Name = type;`. */
export interface AliasDecl extends Span {
  readonly kind: 'alias';
  readonly name: string;
  readonly nameStart: number;
  readonly type: Expr;
}

/** `fn name(params) -> type { ... }` with attributes. */
export interface FunctionDecl extends Span {
  readonly kind: 'fn';
  readonly name: string;
  readonly nameStart: number;
  readonly params: readonly Member[];
  readonly returnType?: Expr;
  readonly returnAttributes: readonly Attribute[];
  readonly body: CompoundStmt;
  readonly attributes: readonly Attribute[];
}

/** A module-scope `var`, `const` or `override`. */
export interface GlobalValue extends Span {
  readonly kind: 'global';
  readonly decl: ValueDecl;
}

/** Any module-scope declaration. */
export type GlobalDecl = StructDecl | AliasDecl | FunctionDecl | GlobalValue | ConstAssert;

/** `enable`, `requires` or `diagnostic` at the top of a module. */
export interface Directive extends Span {
  readonly kind: 'enable' | 'requires' | 'diagnostic';
  /** Extension or feature names; for `diagnostic`, the severity then the rule name. */
  readonly names: readonly string[];
}

/** A parsed module. */
export interface ModuleAst {
  readonly directives: readonly Directive[];
  readonly declarations: readonly GlobalDecl[];
}
