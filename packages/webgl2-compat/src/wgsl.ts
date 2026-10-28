// @margoengine/webgl2-compat/wgsl: the WGSL front end of the compatibility layer (roadmap milestone M1): lexer,
// parser, resolver and type checker, producing a typed IR with source positions. Written clean room from the W3C
// WGSL specification. Nothing runs at import time; the root entry never imports this one.
import { check } from './wgsl/check.js';
import { SourceMap } from './wgsl/errors.js';
import type { IRModule } from './wgsl/ir.js';
import { parse } from './wgsl/parser.js';
import type { ModuleAst } from './wgsl/ast.js';

export type {
  AliasDecl,
  AssignStmt,
  Attribute,
  BinaryExpr,
  BinaryOp,
  CallExpr,
  CallStmt,
  CompoundStmt,
  ConstAssert,
  DeclStmt,
  Directive,
  Expr as WGSLExpr,
  ForStmt,
  FunctionDecl,
  GlobalDecl,
  GlobalValue,
  IdentExpr,
  IfStmt,
  IncrementStmt,
  IndexExpr,
  JumpStmt,
  LiteralExpr,
  LoopStmt,
  Member as WGSLMember,
  MemberExpr,
  ModuleAst,
  ParenExpr,
  ReturnStmt,
  Span,
  Stmt,
  StructDecl,
  SwitchClause,
  SwitchStmt,
  UnaryExpr,
  UnaryOp,
  ValueDecl,
  WhileStmt,
} from './wgsl/ast.js';
export type {
  ConstValue,
  IOAttributes,
  IREntryPoint,
  IRExpr,
  IRFunction,
  IRGlobalConst,
  IRGlobalVar,
  IRLocal,
  IRModule,
  IROverride,
  IRParam,
  IRStmt,
  IRValueDeclaration,
  ShaderStage as WGSLShaderStage,
} from './wgsl/ir.js';
export type {
  AccessMode,
  AddressSpace,
  ArrayType,
  AtomicType,
  MatrixType,
  PointerType,
  SamplerType,
  ScalarName,
  ScalarType as WGSLScalarType,
  StructMember,
  StructType,
  TextureDimension as WGSLTextureDimension,
  TextureType,
  Type as WGSLType,
  VectorType,
  VoidType,
} from './wgsl/types.js';
export { WGSL_HELP, WGSL_LIMITS, WGSLError, type WGSLErrorCode } from './wgsl/errors.js';
export { typeName as wgslTypeName, alignOf as wgslAlignOf, sizeOf as wgslSizeOf } from './wgsl/types.js';

/**
 * Parses WGSL source into a syntax tree, without resolving names or types.
 * @param source WGSL text.
 * @returns The syntax tree; every node has `start` and `end` offsets.
 * @throws {WGSLError} code `syntax` for text that is not WGSL, `limit` past {@link WGSL_LIMITS}.
 */
export function parseWGSL(source: string): ModuleAst {
  if (typeof source !== 'string') throw new TypeError('parseWGSL needs WGSL source text (a string)');
  return parse(source);
}

/**
 * Parses and checks WGSL source: names resolved, types checked, constants folded, entry points and their resources
 * listed. The result is the typed IR the GLSL back end reads.
 * @param source WGSL text.
 * @returns The checked module; `locate(offset)` turns any node's `start` into a line and column.
 * @throws {WGSLError} code `syntax`, `type` or `limit`, with the line and column of the fault.
 */
export function checkWGSL(source: string): IRModule {
  if (typeof source !== 'string') throw new TypeError('checkWGSL needs WGSL source text (a string)');
  const map = new SourceMap(source);
  return check(parse(source, map), map);
}
