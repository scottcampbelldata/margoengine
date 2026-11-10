import type { Operand } from './expr.js';

/** @internal Optional execution engine. Host storage and validation stay in CpuContext. */
export interface CpuRuntime {
  values(operand: Operand): Float64Array;
  run(name: string, inputs: readonly ArrayLike<number>[], params?: readonly number[]): Float64Array[];
  kernel(label: string, resources: Readonly<Record<string, unknown>>): void;
  dispose(): void;
}
