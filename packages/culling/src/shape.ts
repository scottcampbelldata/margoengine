import type { PassContext } from '@margoengine/core/extension';
/** @internal Optional package-local shape extension; absent from ordinary sphere cullers. */
export interface CullShape {
  shader(code: string, matrix: string): string;
  write(target: Float32Array, offset: number, vertices: Float32Array, stride: number, padding?: number): void;
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
