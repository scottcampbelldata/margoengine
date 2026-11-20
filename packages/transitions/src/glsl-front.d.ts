// Types of the GLSL front end in packages/shader/src/glsl, kept in step with host.ts there.
export type GLSLUniformValue = number | boolean | readonly (number | boolean)[];
export interface GLSLHostName {
  readonly code: string;
  readonly type: string;
}
export interface GLSLSampleOptions {
  readonly lod?: string;
  readonly bias?: string;
  readonly ddx?: string;
  readonly ddy?: string;
  readonly offset?: string;
}
export interface GLSLHost {
  readonly uniforms: Readonly<Record<string, GLSLUniformValue>>;
  readonly flipY: boolean;
  readonly names: Readonly<Record<string, GLSLHostName>>;
  readonly colorReaders: Readonly<Record<string, string>>;
  readonly prologue: string;
  epilogue(entry: string): string;
  readonly entry: { readonly name: string; readonly type: string; readonly params: readonly string[] };
  readonly sample?: (texture: string, kind: string, coords: string, options: GLSLSampleOptions) => string;
  readonly samplerOf?: (code: string) => string;
  readonly yUp?: boolean;
  readonly missingEntry: string;
}
export interface GLSLSourceInfo {
  version: 100 | 300;
}
/** A parsed GLSL translation unit; opaque to hosts. */
export interface GLSLProgram {
  readonly _glslProgram: never;
}
export declare class GLSLParser {
  constructor(source: string, subject?: string);
  parse(): GLSLProgram;
}
export declare class GLSLEmitter {
  constructor(program: GLSLProgram, host: GLSLHost, version?: 100 | 300);
  emit(): string;
}
export declare function preprocessGLSL(source: string, info?: GLSLSourceInfo): string;
