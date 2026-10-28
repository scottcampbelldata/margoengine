// The typed IR the WGSL front end produces: every name resolved to its declaration, every expression typed (memory
// references explicit, the Load Rule as `load` nodes, abstract numbers materialized), constant expressions folded
// into `value`, and every node keeping its source span. The GLSL back end (milestone M2) reads only this.
import type { Span } from './ast.js';
import type { AccessMode, AddressSpace, StructType, Type } from './types.js';

/**
 * A constant value: a number or boolean for a scalar, an array of components for a vector, of columns for a
 * matrix, of elements for an array and of members (in order) for a struct.
 */
export type ConstValue = number | boolean | readonly ConstValue[];

/** Entry-point input and output attributes of a parameter, return value or struct member. */
export interface IOAttributes {
  readonly location?: number;
  readonly builtin?: string;
  readonly interpolate?: readonly string[];
  readonly invariant?: boolean;
  readonly blendSrc?: number;
}

/** A module-scope `var`: a resource (`group`/`binding`) or private or workgroup memory. */
export interface IRGlobalVar extends Span {
  readonly kind: 'var';
  readonly name: string;
  readonly type: Type;
  readonly space: AddressSpace;
  readonly access: AccessMode;
  readonly group?: number;
  readonly binding?: number;
  readonly init?: IRExpr;
}
/** A module-scope `const`: always folded. */
export interface IRGlobalConst extends Span {
  readonly kind: 'const';
  readonly name: string;
  readonly type: Type;
  readonly value: ConstValue;
}
/** A pipeline-overridable constant. `id` is its `@id`; `init` its default, if any. */
export interface IROverride extends Span {
  readonly kind: 'override';
  readonly name: string;
  readonly type: Type;
  readonly id?: number;
  readonly init?: IRExpr;
}
/** A function parameter. */
export interface IRParam extends Span {
  readonly kind: 'param';
  readonly name: string;
  readonly type: Type;
  readonly io: IOAttributes;
}
/** A function-scope `let`, `var` or `const`. */
export interface IRLocal extends Span {
  readonly kind: 'let' | 'local-var' | 'local-const';
  readonly name: string;
  readonly type: Type;
  readonly init?: IRExpr;
  /** For `local-const`. */
  readonly value?: ConstValue;
}
/** Anything a name can resolve to as a value. */
export type IRValueDeclaration = IRGlobalVar | IRGlobalConst | IROverride | IRParam | IRLocal;

/** Expression node kinds. */
export type IRExpr = Span & {
  readonly type: Type;
  /** The folded value when the expression is a constant expression. */
  readonly value?: ConstValue;
} & (
    | { readonly kind: 'literal' }
    | { readonly kind: 'name'; readonly decl: IRValueDeclaration }
    | { readonly kind: 'load'; readonly ref: IRExpr }
    | { readonly kind: 'construct'; readonly args: readonly IRExpr[] }
    | { readonly kind: 'convert'; readonly arg: IRExpr }
    | { readonly kind: 'bitcast'; readonly arg: IRExpr }
    | { readonly kind: 'call'; readonly fn: IRFunction; readonly args: readonly IRExpr[] }
    | { readonly kind: 'builtin'; readonly name: string; readonly args: readonly IRExpr[] }
    | { readonly kind: 'member'; readonly object: IRExpr; readonly member: string; readonly index: number }
    | { readonly kind: 'swizzle'; readonly object: IRExpr; readonly components: readonly number[] }
    | { readonly kind: 'index'; readonly object: IRExpr; readonly index: IRExpr }
    | { readonly kind: 'unary'; readonly op: '-' | '!' | '~'; readonly operand: IRExpr }
    | { readonly kind: 'binary'; readonly op: string; readonly left: IRExpr; readonly right: IRExpr }
    | { readonly kind: 'address-of'; readonly ref: IRExpr }
    | { readonly kind: 'deref'; readonly pointer: IRExpr }
  );

/** Statement node kinds. */
export type IRStmt = Span &
  (
    | { readonly kind: 'block'; readonly body: readonly IRStmt[] }
    | { readonly kind: 'decl'; readonly local: IRLocal }
    | { readonly kind: 'assign'; readonly op: string; readonly lhs: IRExpr | null; readonly rhs: IRExpr }
    | { readonly kind: 'increment'; readonly op: '++' | '--'; readonly lhs: IRExpr }
    | { readonly kind: 'call'; readonly call: IRExpr }
    | {
        readonly kind: 'if';
        readonly condition: IRExpr;
        readonly then: readonly IRStmt[];
        readonly else?: readonly IRStmt[];
      }
    | {
        readonly kind: 'switch';
        readonly selector: IRExpr;
        readonly clauses: readonly {
          readonly selectors: readonly (number | null)[];
          readonly body: readonly IRStmt[];
        }[];
      }
    | {
        readonly kind: 'loop';
        readonly body: readonly IRStmt[];
        readonly continuing?: readonly IRStmt[];
        readonly breakIf?: IRExpr;
      }
    | {
        readonly kind: 'for';
        readonly init?: IRStmt;
        readonly condition?: IRExpr;
        readonly update?: IRStmt;
        readonly body: readonly IRStmt[];
      }
    | { readonly kind: 'while'; readonly condition: IRExpr; readonly body: readonly IRStmt[] }
    | { readonly kind: 'break' | 'continue' | 'discard' }
    | { readonly kind: 'return'; readonly value?: IRExpr }
  );

/** Shader stages. */
export type ShaderStage = 'vertex' | 'fragment' | 'compute';

/** A function, with what it reaches (for per-entry-point resource lists). */
export interface IRFunction extends Span {
  readonly name: string;
  readonly params: readonly IRParam[];
  readonly returnType: Type;
  readonly returnIO: IOAttributes;
  readonly body: readonly IRStmt[];
  /** The entry-point stage, for `@vertex`, `@fragment` and `@compute` functions. */
  readonly stage?: ShaderStage;
  /** `@workgroup_size(x, y, z)` of a compute entry point: numbers, or expressions over overrides. */
  readonly workgroupSize?: readonly (number | IRExpr)[];
  /** Functions this one calls directly. */
  readonly calls: ReadonlySet<IRFunction>;
  /** IRModule-scope variables and overrides it names directly. */
  readonly uses: ReadonlySet<IRGlobalVar | IROverride>;
  /** Stages its built-ins (derivatives, barriers, implicit-LOD sampling) or `discard` limit it to. */
  readonly stages: ReadonlySet<'fragment' | 'compute'>;
}

/** The resources and memory an entry point reaches through its call graph. */
export interface IREntryPoint {
  readonly name: string;
  readonly stage: ShaderStage;
  readonly function: IRFunction;
  readonly globals: readonly (IRGlobalVar | IROverride)[];
}

/** A checked module. */
export interface IRModule {
  readonly enables: readonly string[];
  readonly requires: readonly string[];
  readonly structs: readonly StructType[];
  readonly globals: readonly (IRGlobalVar | IRGlobalConst | IROverride)[];
  readonly functions: readonly IRFunction[];
  readonly entryPoints: readonly IREntryPoint[];
  /** 1-based line and column of a source offset (spans are offsets). */
  locate(offset: number): { line: number; column: number };
}
