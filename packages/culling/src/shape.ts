import type { PassContext } from '@margoengine/core/extension';
/** @internal Optional package-local shape extension; absent from ordinary sphere cullers. */
export interface CullShape {
  shader(code: string, matrix: string): string;
  write(target: Float32Array, offset: number, vertices: Float32Array, stride: number, padding?: number): void;
  /**
   * The test on the CPU (the WebGL2 layer's route, src/compat.ts), per instance per frame: called unbound, so it uses
   * no `this`, and it must allocate nothing.
   */
  cpu(
    records: Float32Array,
    at: number,
    vertices: Float32Array,
    stride: number,
    padding: number,
    frame: Float32Array,
  ): boolean;
  prepare(context: PassContext, occlusion: boolean): void;
}
