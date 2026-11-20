/** A scalar or flattened vector, column-major matrix or fixed array uniform value. */
export type GLSLUniformValue = number | boolean | readonly (number | boolean)[];
/** A name the host provides to translated GLSL: the WGSL expression that reads it and its GLSL type. */
export interface GLSLHostName {
  readonly code: string;
  readonly type: string;
}
/** The level, bias, gradients or texel offset of a GLSL texture lookup, as WGSL expressions. */
export interface GLSLSampleOptions {
  readonly lod?: string;
  readonly bias?: string;
  readonly ddx?: string;
  readonly ddy?: string;
  readonly offset?: string;
  /** The depth reference of a shadow sampler's lookup (GLSL ES 3.00 8.8): the lookup compares it with the texel. */
  readonly compare?: string;
}
/**
 * What a host (a package that gives translated GLSL its surroundings) supplies to the GLSL front end:
 * the uniform values it freezes into constants, the coordinate convention, the names it provides,
 * the colour readers it maps to WGSL samplers and the WGSL that wraps the entry function.
 */
export interface GLSLHost {
  /** Uniform values snapshotted into WGSL constants. */
  readonly uniforms: Readonly<Record<string, GLSLUniformValue>>;
  /** GLSL UVs use a bottom-left origin; true flips y at every sample and at the entry. */
  readonly flipY: boolean;
  /** Names the host defines (a global with one of these names is not declared again, except gl_FragCoord). */
  readonly names: Readonly<Record<string, GLSLHostName>>;
  /** Maps a colour reader such as getFromColor to the WGSL texture it samples. */
  readonly colorReaders: Readonly<Record<string, string>>;
  /** WGSL placed before the user's functions (the storage behind gl_FragCoord). */
  readonly prologue: string;
  /** WGSL for the entry function that calls the translated one, given its WGSL name. */
  epilogue(entry: string): string;
  /** The GLSL function the host expects: its name, return type and parameter types. */
  readonly entry: { readonly name: string; readonly type: string; readonly params: readonly string[] };
  /**
   * WGSL that samples `texture` (a value of the GLSL sampler type `kind`) at `coords`, already y flipped when the
   * host flips. Without it a lookup reads the host's own `sample(texture, uv)`, the nearest texel of a 2D image.
   */
  readonly sample?: (texture: string, kind: string, coords: string, options: GLSLSampleOptions) => string;
  /** The WGSL sampler paired with texture `code` when a sampler is passed to a function. Default `code` + "s". */
  readonly samplerOf?: (code: string) => string;
  /** When set, a sampler argument also passes this u32 WGSL value (the lookup mode of texture `code`) after its sampler. */
  readonly samplerMode?: (code: string) => string;
  /** Window y points up, as GLSL's does, so dFdy is the negated WGSL dpdy. Default `flipY`. */
  readonly yUp?: boolean;
  /** Message for a missing entry function. */
  readonly missingEntry: string;
}
