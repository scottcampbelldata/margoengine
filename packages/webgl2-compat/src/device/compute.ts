// Compute pipelines and passes of the compatibility device (W3C WebGPU specification sections 11 and 16). This part
// stays small and in the device: the default bind group layouts come from the checked WGSL at once, so
// getBindGroupLayout works synchronously, while the planning, translation and running of compute (the tiers of the
// roadmap's compute plan) load lazily with the compute entry, before `requestDevice` answers. A
// (KB-COMPAT-FIRSTTASK1: loaded on first use, the first compute submit waited in the queue).
import { constantOf } from '../wgsl/override-value.js';
import type { IREntryPoint, IRExpr, IRFunction, IRGlobalVar, IRModule } from '../wgsl/ir.js';
import { sizeOf, type TextureType } from '../wgsl/types.js';
import type { CompatDevice } from './device.js';
import {
  type CompatBindGroup,
  CompatBindGroupLayout,
  type CompatBuffer,
  type CompatPipelineLayout,
  type CompatShaderModule,
  type LayoutEntry,
} from './resources.js';
import type { Replayer } from './render.js';
import { OP, type Tape, type TapePool } from './tape.js';

/** What the compute entry builds for a pipeline (opaque to the device). */
export interface ComputeBuilt {
  readonly tier: string;
  /** With a deferred build of a GPU tier: resolves once every program has linked. */
  readonly linked?: Promise<void>;
}

/** The part of the compute entry the device calls (compute/runtime.ts). */
export interface ComputeRuntime {
  /** Plans and translates a pipeline; throws MargoError code `unsupported` for what no tier can run. */
  build(pipeline: CompatComputePipeline, deferred?: boolean): ComputeBuilt;
  /** Runs one dispatch with the bind groups bound at the time it was recorded. */
  dispatch(r: Replayer, pipeline: CompatComputePipeline, groups: readonly BoundGroup[], count: readonly number[]): void;
}

/** A bind group set on a compute pass, with its dynamic offsets. */
export type BoundGroup = { readonly group: CompatBindGroup; readonly offsets: readonly number[] } | null;

const STORAGE_ACCESS: Record<string, string> = { write: 'write-only', read: 'read-only', read_write: 'read-write' };

/**
 * The layout entry WebGPU's default pipeline layout makes for a resource an entry point statically uses (WebGPU "default
 * pipeline layout": its binding type follows the variable's address space and type), with the given stage visibility.
 */
export function layoutEntry(v: IRGlobalVar, visibility: number): LayoutEntry | null {
  const base = { binding: v.binding as number, visibility };
  if (v.space === 'uniform' || v.space === 'storage')
    return {
      ...base,
      buffer: {
        type: v.space === 'uniform' ? 'uniform' : v.access === 'read' ? 'read-only-storage' : 'storage',
        hasDynamicOffset: false,
        minBindingSize: sizeOf(v.type),
      },
    };
  if (v.type.kind === 'sampler') return { ...base, sampler: { type: v.type.comparison ? 'comparison' : 'filtering' } };
  if (v.type.kind !== 'texture') return null;
  const t = v.type as TextureType,
    viewDimension = t.dimension.replace('_', '-');
  if (t.shape === 'storage')
    return {
      ...base,
      storageTexture: { format: t.format as string, access: STORAGE_ACCESS[t.access ?? 'write'], viewDimension },
    };
  if (t.shape === 'external') return { ...base, externalTexture: {} };
  return {
    ...base,
    texture: {
      sampleType:
        t.shape === 'depth' || t.shape === 'depth_multisampled'
          ? 'depth'
          : t.sampled?.name === 'i32'
            ? 'sint'
            : t.sampled?.name === 'u32'
              ? 'uint'
              : 'float',
      viewDimension,
      multisampled: t.shape === 'multisampled' || t.shape === 'depth_multisampled',
    },
  };
}

/** The default ("auto") bind group layouts of a compute entry point, from the resources it reaches. */
function autoLayouts(entry: IREntryPoint): CompatBindGroupLayout[] {
  const groups: LayoutEntry[][] = [];
  for (const g of entry.globals) {
    if (g.kind !== 'var' || g.group === undefined || g.binding === undefined) continue;
    const e = layoutEntry(g as IRGlobalVar, 4);
    if (e) (groups[g.group as number] ??= []).push(e);
  }
  const out: CompatBindGroupLayout[] = [];
  for (let i = 0; i < Math.max(groups.length, 1); i++) {
    const layout = new CompatBindGroupLayout({ entries: [] });
    (layout as { entries: readonly LayoutEntry[] }).entries = (groups[i] ?? []).sort((a, b) => a.binding - b.binding);
    out.push(layout);
  }
  return out;
}

/**
 * Why WebGPU refuses an entry point's workgroup on a device (WebGPU "createComputePipeline": each `@workgroup_size`
 * dimension, their product and the workgroup variables' bytes against the device's limits), or null. A dimension with
 * no value here is left to the compute planner; an override-sized array counts the length its override resolves to.
 */
function workgroupFailure(
  entry: IREntryPoint,
  declared: IRModule['globals'],
  constants: Readonly<Record<string, number | boolean>>,
  limits: Readonly<Record<string, number>>,
): string | null {
  const fn: IRFunction = entry.function;
  const over = (what: string, value: number, limit: string) =>
    value > limits[limit] ? `${what} of '${fn.name}' exceeds ${limit} (${limits[limit]}): ${value}` : null;
  let invocations = 1;
  for (let i = 0; i < 3; i++) {
    const v = fn.workgroupSize?.[i] ?? 1;
    const n = typeof v === 'number' ? v : constantOf(v, constants);
    if (n === undefined) return null;
    const axis = 'XYZ'[i];
    const failure = over(`@workgroup_size ${axis.toLowerCase()}`, n, `maxComputeWorkgroupSize${axis}`);
    if (failure) return failure;
    invocations *= n;
  }
  let bytes = 0;
  for (const g of entry.globals) {
    if (g.kind !== 'var' || g.space !== 'workgroup') continue;
    const t = (g as IRGlobalVar).type;
    let size = sizeOf(t);
    // sizeOf counts an override-sized array as one element.
    if (t.kind === 'array' && typeof t.count === 'object') {
      const name = t.count.override;
      const decl = declared.find((o) => o.kind === 'override' && o.name === name);
      const length = decl && constantOf({ kind: 'name', decl } as unknown as IRExpr, constants);
      if (length !== undefined) size *= length;
    }
    bytes += Math.ceil(size / 16) * 16;
  }
  return (
    over('the invocations per workgroup', invocations, 'maxComputeInvocationsPerWorkgroup') ??
    over('the workgroup storage bytes', bytes, 'maxComputeWorkgroupStorageSize')
  );
}

/** A GPUComputePipeline: the checked entry point, its bind group layouts and (once built) how it runs. */
export class CompatComputePipeline {
  label: string;
  readonly module: CompatShaderModule;
  readonly entry: IREntryPoint | null = null;
  readonly constants: Readonly<Record<string, number | boolean>>;
  readonly layouts: readonly (CompatBindGroupLayout | null)[];
  /** Whether the layout was given (its dynamic-offset bindings keep their own data textures). */
  readonly explicit: CompatPipelineLayout | null;
  /** Set when the pipeline cannot run: the message of its error. */
  failure: string | null = null;
  built: ComputeBuilt | null = null;

  constructor(
    readonly device: CompatDevice,
    descriptor: GPUComputePipelineDescriptor,
  ) {
    this.label = descriptor.label ?? '';
    this.module = descriptor.compute.module as unknown as CompatShaderModule;
    this.constants = (descriptor.compute.constants ?? {}) as Record<string, number>;
    this.explicit = descriptor.layout !== 'auto' ? (descriptor.layout as unknown as CompatPipelineLayout) : null;
    const ir = this.module.ir;
    if (!ir) {
      this.failure = `createComputePipeline${this.label ? ` '${this.label}'` : ''}: its shader module failed to compile`;
      device.validationError(this.failure);
      this.layouts = [];
      return;
    }
    const name = descriptor.compute.entryPoint;
    const candidates = ir.entryPoints.filter((e) => e.stage === 'compute');
    const entry =
      name === undefined
        ? candidates.length === 1
          ? candidates[0]
          : undefined
        : candidates.find((e) => e.name === name);
    if (!entry) {
      this.failure = `createComputePipeline: the module has no compute entry point ${name === undefined ? '(or more than one: name it with entryPoint)' : `'${name}'`}`;
      device.validationError(this.failure);
      this.layouts = [];
      return;
    }
    this.entry = entry;
    this.layouts = this.explicit ? [...this.explicit.bindGroupLayouts] : autoLayouts(entry);
    const workgroup = workgroupFailure(entry, ir.globals, this.constants, device.limits);
    if (workgroup) {
      this.failure = `createComputePipeline${this.label ? ` '${this.label}'` : ''}: ${workgroup}; use a smaller workgroup`;
      device.validationError(this.failure);
      return;
    }
    // Count the complete layout, including unused explicit bindings, across all groups.
    // CPU execution is an implementation route, not permission to exceed the device's contract.
    const counts = new Map<string, number>();
    for (const layout of this.layouts)
      for (const binding of layout?.entries ?? []) {
        if (!(binding.visibility & 4)) continue;
        const limit = binding.buffer
          ? binding.buffer.type === 'uniform'
            ? 'maxUniformBuffersPerShaderStage'
            : 'maxStorageBuffersPerShaderStage'
          : binding.storageTexture
            ? 'maxStorageTexturesPerShaderStage'
            : binding.texture
              ? 'maxSampledTexturesPerShaderStage'
              : binding.sampler
                ? 'maxSamplersPerShaderStage'
                : null;
        if (limit) counts.set(limit, (counts.get(limit) ?? 0) + 1);
        if (binding.externalTexture)
          for (const [limit, slots] of [
            ['maxSampledTexturesPerShaderStage', 4],
            ['maxSamplersPerShaderStage', 1],
            ['maxUniformBuffersPerShaderStage', 1],
          ] as const)
            counts.set(limit, (counts.get(limit) ?? 0) + slots);
      }
    if (this.layouts.length > device.limits.maxBindGroups) counts.set('maxBindGroups', this.layouts.length);
    for (const [limit, count] of counts)
      if (count > device.limits[limit]) {
        this.failure = `createComputePipeline: ${count} bindings exceed ${limit} (${device.limits[limit]}); use fewer bindings or request a supported higher device limit`;
        device.validationError(this.failure);
        return;
      }
  }

  getBindGroupLayout(index: number): CompatBindGroupLayout {
    return this.layouts[index] ?? new CompatBindGroupLayout({ entries: [] });
  }

  /** True when a storage binding reads from its bind group's shared data texture (no dynamic offset). */
  readonly shared = (group: number, binding: number): boolean =>
    !this.explicit?.bindGroupLayouts[group]?.entries.find((e) => e.binding === binding)?.buffer?.hasDynamicOffset;

  /** As {@link ready}, leaving the link to the driver's own thread: nothing here waits for it. */
  async readyAsync(): Promise<void> {
    if (this.built || this.failure || !this.entry) return;
    const built = (this.device.computeRuntime as ComputeRuntime).build(this, true);
    await built.linked;
    this.built = built;
  }

  /** Builds the pipeline with the loaded compute runtime (once); false when it cannot run. */
  ready(): boolean {
    if (this.built) return true;
    if (this.failure || !this.entry) return false;
    const runtime = this.device.computeRuntime;
    if (!runtime) return false;
    this.built = runtime.build(this);
    return true;
  }
}

/** A GPUComputePassEncoder: records the pass's pipeline, bind groups and dispatches on the command buffer's tape. */
export class CompatComputePassEncoder {
  /** The label: '' (the prototype's) unless one is given, so an unlabelled one, which a frame makes many of, has one field fewer. */
  declare label: string;
  constructor(
    /**
     * The command buffer's tape: the commands and what they use go onto it, and it holds whether this pass has set a
     * pipeline and reaches the device (its pool's), so the pass encoder WebGPU hands back per pass is one field.
     */
    private readonly tape: Tape,
    label: string,
  ) {
    if (label) this.label = label;
    tape.computePipeline = false;
    tape.op(OP.COMPUTE_BEGIN);
  }

  setPipeline(pipeline: CompatComputePipeline): void {
    this.tape.computePipeline = true;
    this.tape.obj(OP.COMPUTE_PIPELINE, pipeline);
  }
  setBindGroup(
    index: number,
    group: CompatBindGroup | null,
    offsets?: Iterable<number> | Uint32Array,
    start = 0,
    length?: number,
  ): void {
    if (group) this.tape.use(group.uses);
    // An invalid group (its error was reported at createBindGroup) binds nothing, so the dispatch is skipped (the
    // replay's bindCompute checks it).
    if (!offsets) this.tape.bindGroup(index, group, undefined, 0, 0, OP.COMPUTE_BIND);
    else if (offsets instanceof Uint32Array)
      this.tape.bindGroup(index, group, offsets, start, length ?? offsets.length - start, OP.COMPUTE_BIND);
    else if (Array.isArray(offsets)) this.tape.bindGroup(index, group, offsets, 0, offsets.length, OP.COMPUTE_BIND);
    else {
      const list = [...offsets];
      this.tape.bindGroup(index, group, list, 0, list.length, OP.COMPUTE_BIND);
    }
  }
  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    if (!this.tape.computePipeline) return this.noPipeline();
    this.tape.n3(OP.DISPATCH, x, y, z);
  }
  dispatchWorkgroupsIndirect(buffer: CompatBuffer, offset: number): void {
    if (!this.tape.computePipeline) return this.noPipeline();
    this.tape.use(buffer);
    this.tape.objNum(OP.DISPATCH_INDIRECT, buffer, offset);
  }
  private noPipeline(): void {
    (this.tape.pool as TapePool).device.validationError(
      'dispatchWorkgroups without a compute pipeline; call setPipeline first',
    );
  }
  end(): void {}
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}
}
CompatComputePassEncoder.prototype.label = '';
