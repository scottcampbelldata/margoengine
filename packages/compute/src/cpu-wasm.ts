/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { CpuContext, cpuBound, cpuUniform, cpuView } from './cpu.js';
import { aborted, type WaitOptions } from './context.js';
import { promote, type DType } from './dtype.js';
import type { Node, Operand } from './expr.js';
import type { GpuArray } from './array.js';
import type { CpuRuntime } from './cpu-runtime.js';

const OPS = [
  'add',
  'sub',
  'mul',
  'div',
  'floorDiv',
  'mod',
  'pow',
  'minimum',
  'maximum',
  'clip',
  'atan2',
  'hypot',
  'neg',
  'abs',
  'sign',
  'square',
  'sqrt',
  'exp',
  'exp2',
  'log',
  'log2',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'degrees',
  'radians',
  'rsqrt',
  'reciprocal',
  'log1p',
  'expm1',
  'floor',
  'ceil',
  'trunc',
  'round',
  'lt',
  'le',
  'gt',
  'ge',
  'eq',
  'ne',
  'and',
  'or',
  'xor',
  'not',
  'isnan',
  'isinf',
  'isfinite',
  'bitAnd',
  'bitOr',
  'bitXor',
  'bitNot',
  'shiftLeft',
  'shiftRight',
  'popcount',
  'bitcast',
  'astype',
  'where',
];
const RUNS = [
  'leaf',
  'scalar',
  'index',
  'expr',
  'reduce',
  'arg',
  'scan',
  'segmented',
  'group',
  'order',
  'gather',
  'quantile',
  'unique',
  'take',
  'scatter',
  'compact',
  'histogram',
  'matmul',
  'fft.stockham',
  'convolve',
  'convolve2d',
  'sparse.spmv',
  'sparse.diagonal',
  'random',
];
const code = (t: DType): number => (t === 'i32' ? 1 : t === 'u32' ? 2 : 0);
interface Kernel {
  memory: WebAssembly.Memory;
  reserve(n: number): number;
  run(op: number): number;
  output(i: number): number;
  length(i: number): number;
  groups(): number;
  release(): void;
}
/** Execution counters count bridge calls and SIMD lane groups, never elapsed time. */
export interface CpuWasmWork {
  /** Number of completed Wasm dispatches. */
  readonly calls: number;
  /** Actual pairs of lanes executed by SIMD arithmetic. */
  readonly simdGroups: number;
}
class Runtime implements CpuRuntime {
  #kernel: Kernel | undefined;
  calls = 0;
  simdGroups = 0;
  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }
  run(name: string, inputs: readonly ArrayLike<number>[], params: readonly number[] = []): Float64Array[] {
    const op = RUNS.indexOf(name),
      kernel = this.#kernel;
    if (!kernel) throw fault('disposed', 'CPU Wasm runtime is disposed', 'compute');
    if (op < 0) throw fault('unsupported', `CPU Wasm does not support ${name}`, 'compute');
    const arrays = [params, ...inputs],
      n = 1 + arrays.reduce((s, a) => s + 1 + a.length, 0);
    if (n > 8_388_608)
      throw rangeError('CPU Wasm packet exceeds 8,388,608 f64 words; process smaller chunks', 'compute');
    const ptr = kernel.reserve(n);
    const packet = new Float64Array(kernel.memory.buffer, ptr, n);
    packet[0] = arrays.length;
    let at = 1;
    for (const a of arrays) {
      packet[at++] = a.length;
      packet.set(a, at);
      at += a.length;
    }
    this.calls++;
    const count = kernel.run(op);
    this.simdGroups += kernel.groups();
    return Array.from({ length: count }, (_, i) =>
      new Float64Array(kernel.memory.buffer, kernel.output(i), kernel.length(i)).slice(),
    );
  }
  values(operand: Operand): Float64Array {
    operand.context.check();
    const shape = operand.shape,
      n = operand.size;
    const visit = (node: Node): Float64Array => {
      if (node.kind === 'leaf') {
        const a = node.array;
        a.check(operand.context);
        const steps = shape.map((_, k) => {
          const d = k - shape.length + a.ndim;
          return d < 0 || a.shape[d] === 1 ? 0 : a.strides[d];
        });
        return this.run('leaf', [cpuView(a), shape, steps], [n, a.offset])[0];
      }
      if (node.kind === 'scalar') return this.run('scalar', [], [n, node.value, code(node.dtype)])[0];
      if (node.kind === 'index') return this.run('index', [], [n])[0];
      const types = node.args.map((a) => (a.kind === 'leaf' ? a.array.dtype : a.dtype));
      const t = types.reduce(promote),
        op = OPS.indexOf(node.op);
      if (op < 0) throw typeError(`Unknown element-wise operation ${node.op}`, 'compute');
      return this.run('expr', node.args.map(visit), [op, code(t), code(node.dtype), ...types.map(code)])[0];
    };
    return n ? visit(operand.node()) : new Float64Array(0);
  }
  kernel(label: string, r: Readonly<Record<string, unknown>>): void {
    const get = (key: string): Float64Array => {
      const b = cpuBound(r[key]);
      return Float64Array.from(b.data.subarray(b.offset));
    };
    const put = (key: string, v: Float64Array): void => {
      const b = cpuBound(r[key]);
      b.data.set(v, b.offset);
    };
    const params = (key: string, n: number) => {
      const v = cpuUniform(r[key]);
      return Array.from({ length: n }, (_, i) => v.getUint32(i * 4, true));
    };
    if (label === 'matmul') {
      const s = Array.from((r.shape as Uint32Array).subarray(0, 12));
      s.push(code((r.product as GpuArray).dtype), (r.product as GpuArray).size);
      put('product', this.run(label, [get('left'), get('right')], s)[0]);
    } else if (label === 'fft.stockham') {
      const out = this.run(label, [get('reIn'), get('imIn'), get('twiddle')], params('pass_', 4));
      put('reOut', out[0]);
      put('imOut', out[1]);
    } else if (label === 'convolve' || label === 'convolve2d') {
      put(
        'out',
        this.run(
          label,
          [get(label === 'convolve' ? 'signal' : 'image'), get('taps')],
          params('conv', label === 'convolve' ? 5 : 9),
        )[0],
      );
    } else if (label === 'sparse.spmv' || label === 'sparse.diagonal') {
      const inputs = ['rowPtr', 'colIdx', 'values', ...(label === 'sparse.spmv' ? ['x'] : [])].map(get);
      put(label === 'sparse.spmv' ? 'y' : 'd', this.run(label, inputs, params('shape', 1))[0]);
    } else if (label === 'random') {
      const v = cpuUniform(r.draw),
        p = params('draw', 8);
      p.push(v.getFloat32(32, true), v.getFloat32(36, true), v.getInt32(40, true));
      put('out', this.run(label, [], p)[0]);
    } else throw fault('unsupported', `The ${label} pass runs WGSL and needs a GPU`, 'compute');
  }
  dispose(): void {
    this.#kernel?.release();
    this.#kernel = undefined;
  }
}
/** CPU context backed by its own lazy Rust SIMD instance. Arrays remain ordinary owned host buffers. */
export class CpuWasmContext extends CpuContext {
  readonly #runtime: Runtime;
  /** @internal Use createCpuWasm. */
  constructor(runtime: Runtime) {
    super(runtime);
    this.#runtime = runtime;
  }
  /** Deterministic work since creation. */
  get work(): CpuWasmWork {
    return { calls: this.#runtime.calls, simdGroups: this.#runtime.simdGroups };
  }
}

/** Loads one private SIMD instance. No fetch, compilation or global changes occur on import. */
export async function createCpuWasm(options: WaitOptions = {}): Promise<CpuWasmContext> {
  aborted(options.signal);
  const url = new URL(/* @vite-ignore */ './cpu-kernel.wasm?no-inline', import.meta.url);
  try {
    let bytes: Uint8Array<ArrayBuffer>;
    if (url.protocol === 'file:') {
      url.search = '';
      const name = 'node:fs/promises';
      const fs = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
      bytes = await fs.readFile(url, { signal: options.signal });
    } else {
      const response = await fetch(url, { signal: options.signal });
      if (!response.ok) throw fault('failed', `CPU Wasm load failed: HTTP ${response.status}`, 'compute');
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    aborted(options.signal);
    const math = (op: number, a: number, b: number): number => {
      const name = OPS[op];
      if (name === 'exp2') return 2 ** a;
      if (name === 'rsqrt') return 1 / Math.sqrt(a);
      if (name === 'reciprocal') return 1 / a;
      return (Math as unknown as Record<string, (a: number, b: number) => number>)[name](a, b);
    };
    const { instance } = await WebAssembly.instantiate(bytes, { host: { math } });
    const runtime = new Runtime(instance.exports as unknown as Kernel);
    if (options.signal?.aborted) {
      runtime.dispose();
      aborted(options.signal);
    }
    return new CpuWasmContext(runtime);
  } catch (error) {
    aborted(options.signal);
    throw fault(
      'failed',
      `CPU Wasm initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      'compute',
    );
  }
}
