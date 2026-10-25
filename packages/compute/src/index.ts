/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/compute: GPU compute without the WebGPU boilerplate, NumPy style. Optional and tree-shakable; adds
// nothing to core. Shares an engine's device when given one, otherwise opens a headless device of its own.
export { createCompute, ComputeContext } from './context.js';
export type { ArrayOptions, BindingResource, CreateComputeOptions, PassTiming, WaitOptions } from './context.js';
export { GpuArray } from './array.js';
export type { ReadOptions, SliceSpec } from './array.js';
export { Expr, Operand, where, broadcastShapes } from './expr.js';
export type { AxisOptions, OperandLike } from './expr.js';
export { Kernel, BoundKernel } from './kernel.js';
export type { RunOptions } from './kernel.js';
export type { DType, TypedArrayFor, Float16ArrayLike } from './dtype.js';
export type { ScanOptions } from './scan.js';
export type { SortOptions } from './sort.js';
export type { TakeOptions } from './select.js';
export type { Histogram, HistogramOptions } from './histogram.js';
export type { Operator } from './shaders.js';
export { reflectWGSL, encode } from './wgsl.js';
export type { BindingInfo, EntryPointInfo, HostValue, ModuleInfo, TypeLayout } from './wgsl.js';
