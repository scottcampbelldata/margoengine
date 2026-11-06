// @margoengine/webgl2-compat/compute: compute shaders on WebGL2 (roadmap milestone M5). The device loads this entry
// by itself the first time a page creates a compute pipeline, so a render-only page never downloads it; import it
// directly only to plan or run compute shaders outside a device (tools, tests). Written clean room from the W3C WGSL
// and WebGPU specifications. Nothing runs at import time.
import { checkWGSL } from './wgsl.js';
import type { IRModule } from './wgsl/ir.js';
import { type ComputePlan, planCompute as plan } from './compute/analyze.js';
import { fault } from '../../shared/errors.js';
import { type CPUBuffer, H, runKernel, WorkBudgetExceeded } from './compute/cpu.js';
import { compileCPU, useInterpreter } from './compute/js.js';

export type { ComputePlan, ComputeTarget, ComputeTier } from './compute/analyze.js';
/** The WGSL front end's types, under the names its own entry gives them (the IR this entry's types refer to). */
export type * from './wgsl.js';

/** A compute entry point to plan or run: WGSL source or a checked module, the entry point and its constants. */
export interface ComputeStage {
  /** WGSL source; checked here. Pass `module` instead to reuse a checked module. */
  readonly source?: string;
  /** A module from `checkWGSL`. */
  readonly module?: IRModule;
  /** Entry point name. Default: the module's only compute entry point. */
  readonly entryPoint?: string;
  /** Pipeline-overridable constants by name or `@id`, as in WebGPU's `GPUProgrammableStage.constants`. */
  readonly constants?: Readonly<Record<string, number | boolean>>;
}

function resolve(stage: ComputeStage) {
  const module = stage.module ?? (typeof stage.source === 'string' ? checkWGSL(stage.source) : undefined);
  if (!module) throw new TypeError('A compute stage needs its WGSL source or checked module: { source }');
  const candidates = module.entryPoints.filter((e) => e.stage === 'compute');
  const entry =
    stage.entryPoint === undefined
      ? candidates.length === 1
        ? candidates[0]
        : undefined
      : candidates.find((e) => e.name === stage.entryPoint);
  if (!entry)
    throw new TypeError(
      stage.entryPoint === undefined
        ? `The module has ${candidates.length} compute entry points; name one with entryPoint`
        : `The module has no compute entry point '${stage.entryPoint}'; pass the name of one it declares`,
    );
  return { module, entry };
}

/**
 * How the WebGL2 layer runs a compute entry point: `fragment` (each invocation writes only its own texel of storage
 * textures: a draw per texture), `scatter` (a bounded number of stores anywhere: an instanced point draw per
 * buffer or texture it writes) or `cpu` (atomics, workgroup memory, barriers or unbounded stores: JavaScript).
 * @param stage The module and entry point.
 * @returns The tier, the workgroup size, what it writes and why it is not on a faster tier.
 * @throws {WGSLError} when the source does not check. MargoError code `unsupported` for what no tier runs
 *   (subgroups). TypeError for a missing or ambiguous entry point.
 */
export function planCompute(stage: ComputeStage): ComputePlan {
  const { module, entry } = resolve(stage);
  return plan(module, entry, stage.constants);
}

/** Options for {@link runComputeOnCPU}. */
export interface CPUDispatch extends ComputeStage {
  /** Workgroup counts in x, y and z. */
  readonly workgroups: readonly [number, number?, number?];
  /**
   * Buffer bindings by `"group:binding"`: the bytes the shader reads and writes in place (uniform and storage
   * buffers alike; give each binding its own bytes).
   */
  readonly buffers: ReadonlyMap<string, ArrayBufferView>;
  /**
   * Stop after this many invocations plus loop iterations, so an endless loop cannot hold the caller. What the kernel
   * stored so far stays in the buffers. Default: no limit.
   */
  readonly workBudget?: number;
}

/**
 * Fetches the CPU tier's interpreter, so {@link runComputeOnCPU} also runs on a page whose Content-Security-Policy
 * forbids JavaScript compiled at run time. A page that allows it needs no call; the device loads its own.
 */
export async function loadInterpreter(): Promise<void> {
  useInterpreter((await import('./compute/interpret.js')).interpretKernel);
}

/**
 * Runs a compute entry point on the CPU, exactly as the layer's CPU tier does: one invocation at a time, f32
 * arithmetic rounded as an f32 GPU rounds it, atomics as plain read-modify-writes, and every invocation of a
 * workgroup run to each barrier before any goes on. Buffers only (textures need a device).
 * @param dispatch The entry point, workgroup counts and buffer bindings.
 * Where the Content-Security-Policy forbids JavaScript compiled at run time, await {@link loadInterpreter} first.
 * @throws As {@link planCompute}; MargoError code `unsupported` for WGSL the CPU tier cannot run (textures, cube
 *   sampling) or on such a page without the interpreter; MargoError code `failed` past `workBudget`.
 */
export function runComputeOnCPU(dispatch: CPUDispatch): void {
  const { module, entry } = resolve(dispatch);
  const p = plan(module, entry, dispatch.constants);
  const kernel = compileCPU(module, entry, dispatch.constants);
  const buffers = new Map<string, CPUBuffer>();
  for (const [key, view] of dispatch.buffers) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    buffers.set(key, { dv: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes });
  }
  const [x, y = 1, z = 1] = dispatch.workgroups;
  H.work.left = dispatch.workBudget ?? Number.POSITIVE_INFINITY;
  try {
    runKernel(kernel.bind({ buffers, textures: new Map(), samplers: new Map() }), kernel.barriers, p.workgroupSize, [
      x,
      y,
      z,
    ]);
  } catch (error) {
    if (error instanceof WorkBudgetExceeded)
      throw fault(
        'failed',
        `A compute dispatch on the CPU stopped at its work budget of ${dispatch.workBudget} invocations and loop iterations`,
        'compatibility-layer',
      );
    throw error;
  } finally {
    H.work.left = Number.POSITIVE_INFINITY;
  }
}
