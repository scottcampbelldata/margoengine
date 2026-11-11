// Compute pipelines and passes of the compatibility device (W3C WebGPU specification sections 11 and 16). This part
// stays small and in the device: the default bind group layouts come from the checked WGSL at once, so
// getBindGroupLayout works synchronously, while the planning, translation and running of compute (the tiers of the
// roadmap's compute plan) load lazily with the compute entry, the first time a page creates a compute pipeline. A
// render-only page never downloads them.
import type { IREntryPoint, IRGlobalVar } from '../wgsl/ir.js';
import { sizeOf, type TextureType } from '../wgsl/types.js';
import type { CompatDevice } from './device.js';
import {
  type CompatBindGroup,
  CompatBindGroupLayout,
  type CompatBuffer,
  type CompatPipelineLayout,
  type CompatShaderModule,
  type LayoutEntry,
  type Uses,
} from './resources.js';
import type { Replayer } from './render.js';

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

/** The default ("auto") bind group layouts of a compute entry point, from the resources it reaches. */
function autoLayouts(entry: IREntryPoint): CompatBindGroupLayout[] {
  const groups: LayoutEntry[][] = [];
  for (const g of entry.globals) {
    if (g.kind !== 'var' || g.group === undefined || g.binding === undefined) continue;
    const v = g as IRGlobalVar,
      list = (groups[v.group as number] ??= []);
    const base = { binding: v.binding as number, visibility: 4 };
    if (v.space === 'uniform' || v.space === 'storage')
      list.push({
        ...base,
        buffer: {
          type: v.space === 'uniform' ? 'uniform' : v.access === 'read' ? 'read-only-storage' : 'storage',
          hasDynamicOffset: false,
          minBindingSize: sizeOf(v.type),
        },
      });
    else if (v.type.kind === 'sampler')
      list.push({ ...base, sampler: { type: v.type.comparison ? 'comparison' : 'filtering' } });
    else if (v.type.kind === 'texture') {
      const t = v.type as TextureType,
        viewDimension = t.dimension.replace('_', '-');
      if (t.shape === 'storage')
        list.push({
          ...base,
          storageTexture: { format: t.format as string, access: STORAGE_ACCESS[t.access ?? 'write'], viewDimension },
        });
      else if (t.shape === 'external') list.push({ ...base, externalTexture: {} });
      else
        list.push({
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
        });
    }
  }
  const out: CompatBindGroupLayout[] = [];
  for (let i = 0; i < Math.max(groups.length, 1); i++) {
    const layout = new CompatBindGroupLayout({ entries: [] });
    (layout as { entries: readonly LayoutEntry[] }).entries = (groups[i] ?? []).sort((a, b) => a.binding - b.binding);
    out.push(layout);
  }
  return out;
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

/** A GPUComputePassEncoder: records dispatches with the pipeline and bind groups current at each. */
export class CompatComputePassEncoder {
  private pipeline: CompatComputePipeline | null = null;
  private groups: BoundGroup[] = [];
  constructor(
    private readonly ops: ((r: Replayer) => void)[],
    private readonly device: CompatDevice,
    public label: string,
    /** The command buffer's list of what it uses. */
    private readonly uses: Uses = [],
  ) {}

  setPipeline(pipeline: CompatComputePipeline): void {
    this.pipeline = pipeline;
  }
  setBindGroup(
    index: number,
    group: CompatBindGroup | null,
    offsets?: Iterable<number> | Uint32Array,
    start = 0,
    length?: number,
  ): void {
    const list = offsets ? [...(offsets as Iterable<number>)] : [];
    const dynamic = offsets instanceof Uint32Array ? list.slice(start, start + (length ?? list.length - start)) : list;
    // An invalid group (its error was reported at createBindGroup) binds nothing, so the dispatch is skipped.
    this.groups[index] = group && !group.invalid ? { group, offsets: dynamic } : null;
    if (group) this.uses.push(group.uses);
  }
  dispatchWorkgroups(x: number, y = 1, z = 1): void {
    this.record(() => [x, y, z]);
  }
  dispatchWorkgroupsIndirect(buffer: CompatBuffer, offset: number): void {
    this.uses.push(buffer);
    this.record((r) => [...new Uint32Array(r.indirect(buffer, offset, 12))]);
  }
  private record(count: (r: Replayer) => number[]): void {
    const pipeline = this.pipeline,
      groups = [...this.groups];
    if (!pipeline) {
      this.device.validationError('dispatchWorkgroups without a compute pipeline; call setPipeline first');
      return;
    }
    this.ops.push((r) => r.dispatch(pipeline, groups, count(r)));
  }
  end(): void {}
  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}
}
