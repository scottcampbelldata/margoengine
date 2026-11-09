// The compute runtime of the compatibility device (roadmap "Compute plan", milestone M5): it plans each compute
// pipeline (compute/analyze.ts), builds it for its tier, and runs dispatches on WebGL2. The device loads this module
// with the compute entry, the first time a page creates a compute pipeline. Written clean room from the W3C WebGPU
// and WGSL specifications and the Khronos WebGL 2.0 and OpenGL ES 3.0 specifications.
//
// - fragment: one draw of a full-target triangle per written texture and z slice; scissored to the dispatch.
// - scatter: one instanced point draw per target (a buffer is drawn as its "word texture", an R32UI texture with one
//   4-byte word per texel, filled from the buffer first and copied back into it after every draw of the dispatch).
//   Reads see the memory as it was before the dispatch, the WGSL result of an invocation that never reads its own
//   stores back (the analysis sends the others to the CPU).
// - cpu: the kernel runs in JavaScript on copies of the bound buffers (and of the textures it reads, read back from
//   the GPU); what it writes goes back afterwards.
import { fault } from '../../../shared/errors.js';
import type { BoundGroup, CompatComputePipeline, ComputeBuilt, ComputeRuntime } from '../device/compute.js';
import type { CompatDevice } from '../device/device.js';
import { CompatRenderPipeline, type Replayer } from '../device/render.js';
import {
  type Bound,
  CompatBindGroup,
  type CompatBuffer,
  CompatPipelineLayout,
  CompatTexture,
  CompatTextureView,
} from '../device/resources.js';
import { type ComputePlan, type ComputeTarget, planCompute } from './analyze.js';
import {
  type CPUBuffer,
  type CPULevel,
  type CPUSampler,
  type CPUTexture,
  H,
  runKernel,
  WorkBudgetExceeded,
} from './cpu.js';
import { emitCompute } from './glsl.js';
import { type CPUKernel, compileCPU, evalAllowed, useInterpreter } from './js.js';

interface Draw {
  readonly target: ComputeTarget;
  readonly pipeline: CompatRenderPipeline;
  /** The program's stage the dimensions are read from, then what `settle` reads once it has linked. */
  readonly stage: ReturnType<typeof emitCompute>['vertex'];
  cn: WebGLUniformLocation | null;
  ct: WebGLUniformLocation | null;
  dims: readonly { group: number; binding: number; location: WebGLUniformLocation }[];
}
interface GPUBuilt extends ComputeBuilt {
  readonly tier: 'fragment' | 'scatter';
  readonly plan: ComputePlan;
  readonly draws: readonly Draw[];
}
interface CPUBuilt extends ComputeBuilt {
  readonly tier: 'cpu';
  readonly plan: ComputePlan;
  readonly kernel: CPUKernel;
}

/** A buffer's word texture (R32UI, `width` words per row) and the RGBA32UI rows texture it is copied back through. */
interface Words {
  readonly texture: CompatTexture;
  readonly width: number;
  readonly height: number;
  version: number;
  rows: WebGLTexture | null;
  fbo: WebGLFramebuffer | null;
  destroy(): void;
}

const WORDS_WIDTH = 4096;

/** The runtime for one device. */
export async function computeRuntime(device: CompatDevice): Promise<ComputeRuntime> {
  // Only a page that forbids `new Function` downloads the interpreter.
  if (!evalAllowed()) useInterpreter((await import('./interpret.js')).interpretKernel);
  await device.loadReadback();
  return new Runtime(device);
}

class Runtime implements ComputeRuntime {
  private readonly gl: WebGL2RenderingContext;
  constructor(private readonly device: CompatDevice) {
    this.gl = device.gl;
  }

  build(p: CompatComputePipeline, deferred = false): ComputeBuilt {
    const ir = p.module.ir,
      entry = p.entry;
    if (!ir || !entry)
      throw new TypeError('The pipeline has no checked entry point; create it from a module that compiled');
    const plan = planCompute(ir, entry, p.constants);
    if (plan.tier === 'cpu') return { tier: 'cpu', plan, kernel: compileCPU(ir, entry, p.constants) } as CPUBuilt;
    try {
      return this.buildGPU(p, plan, deferred);
    } catch (error) {
      // What GLSL cannot express (f16 values in uniform buffers, say) runs on the CPU tier instead.
      if ((error as { code?: string }).code !== 'unsupported') throw error;
      const reason = (error as Error).message
        .replace(/; see .*/, '')
        .replace(/^WebGL2 compatibility cannot translate /, '');
      const cpu = { ...plan, tier: 'cpu' as const, reason: `GLSL ES 3.00 cannot express ${reason}` };
      return { tier: 'cpu', plan: cpu, kernel: compileCPU(ir, entry, p.constants) } as CPUBuilt;
    }
  }

  /** Checks a draw's link and reads its uniforms; before the driver has finished this waits for it. */
  private settle(d: Draw): void {
    const pipeline = d.pipeline;
    pipeline.finish();
    if (pipeline.failure || !pipeline.program)
      throw fault(
        'failed',
        `WebGL2 compatibility made a compute program WebGL2 refused (a bug: report it): ${pipeline.failure}`,
        'compatibility-layer',
      );
    const gl = this.gl,
      program = pipeline.program;
    d.cn = gl.getUniformLocation(program, '_cn');
    d.ct = gl.getUniformLocation(program, '_ct');
    d.dims = d.stage.dimensions.map((x) => ({
      group: x.group,
      binding: x.binding,
      location: gl.getUniformLocation(program, x.name) as WebGLUniformLocation,
    }));
  }

  private buildGPU(p: CompatComputePipeline, plan: ComputePlan, deferred: boolean): GPUBuilt {
    const ir = p.module.ir as NonNullable<CompatComputePipeline['module']['ir']>,
      entry = p.entry as NonNullable<CompatComputePipeline['entry']>;
    const layout = new CompatPipelineLayout({ bindGroupLayouts: p.layouts as never });
    const draws = plan.targets.map((target): Draw => {
      const glsl = emitCompute(ir, entry, plan.tier as 'fragment' | 'scatter', {
        constants: p.constants,
        workgroupSize: plan.workgroupSize,
        target,
        sharedStorage: p.shared,
        uniformBlockSize: this.device.adapter.capabilities.limits.MAX_UNIFORM_BLOCK_SIZE,
      });
      const format = target.kind === 'buffer' ? 'r32uint' : (target.format as GPUTextureFormat);
      const pipeline = new CompatRenderPipeline(
        this.device,
        {
          label: `${p.label || entry.name} (${plan.tier}: ${target.name})`,
          layout: layout as never,
          vertex: { module: null as never, buffers: [] },
          fragment: { module: null as never, targets: [{ format }] },
          primitive: { topology: plan.tier === 'scatter' ? 'point-list' : 'triangle-list' },
        },
        true,
        glsl,
      );
      const stage = plan.tier === 'fragment' ? glsl.fragment : glsl.vertex;
      return { target, pipeline, stage, cn: null, ct: null, dims: [] };
    });
    // ANGLE's Direct3D backend takes minutes on a large kernel: an async pipeline must not wait for it on this thread.
    if (deferred)
      return {
        tier: plan.tier,
        plan,
        draws,
        linked: Promise.all(draws.map((d) => d.pipeline.whenLinked().then(() => this.settle(d)))).then(() => undefined),
      } as GPUBuilt;
    for (const d of draws) this.settle(d);
    return { tier: plan.tier, plan, draws } as GPUBuilt;
  }

  dispatch(r: Replayer, p: CompatComputePipeline, groups: readonly BoundGroup[], count: readonly number[]): void {
    const built = p.built as GPUBuilt | CPUBuilt;
    for (const [i, layout] of p.layouts.entries())
      if (layout?.entries.length && !groups[i]) {
        this.device.validationError(`dispatchWorkgroups: no bind group is set at index ${i}`);
        return;
      }
    this.device.dispatches[built.tier]++;
    if (built.tier === 'cpu') this.runCPU(r, built, groups, count, p.label);
    else this.runGPU(r, built, groups, count);
  }

  private bound(groups: readonly BoundGroup[], group: number, binding: number): { bound: Bound; dynamic: number } {
    const g = groups[group],
      bound = g?.group.entries.get(binding);
    if (!g || !bound)
      throw new TypeError(
        `No resource is bound at @group(${group}) @binding(${binding}); bind one in the bind group set there`,
      );
    const di = g.group.layout.dynamic.indexOf(binding);
    return { bound, dynamic: di >= 0 ? (g.offsets[di] ?? 0) : 0 };
  }

  // ---------------------------------------------------------------- fragment and scatter tiers

  private runGPU(r: Replayer, built: GPUBuilt, groups: readonly BoundGroup[], count: readonly number[]): void {
    const gl = this.gl,
      [wx, wy, wz] = built.plan.workgroupSize,
      [nx, ny, nz] = count;
    // Storage textures the program both reads and writes are read from a copy taken before the dispatch.
    const used = groups.slice();
    const temporary: CompatTexture[] = [];
    const reads = built.draws[0]?.pipeline.textures ?? [];
    for (const d of built.draws) {
      if (
        d.target.kind !== 'texture' ||
        !reads.some((t) => t.group === d.target.group && t.binding === d.target.binding)
      )
        continue;
      const v = (this.bound(groups, d.target.group, d.target.binding).bound as { view: CompatTextureView }).view;
      const copy = this.snapshot(r, v);
      temporary.push(copy.texture);
      const g = used[d.target.group] as NonNullable<BoundGroup>;
      used[d.target.group] = { group: this.replace(g.group, d.target.binding, copy), offsets: g.offsets };
    }
    const words: { buffer: CompatBuffer; words: Words }[] = [];
    for (const d of built.draws) {
      const bind = () => used.forEach((g, i) => g && r.setBindGroup(i, g.group, [...g.offsets]));
      const dims = () => {
        for (const x of d.dims) {
          const v = (this.bound(groups, x.group, x.binding).bound as { view: CompatTextureView }).view;
          const [w, h, depth] = v.texture.levelSize(v.baseMipLevel);
          gl.uniform4i(x.location, w, h, v.texture.dimension === '3d' ? depth : v.arrayLayerCount, 1);
        }
      };
      if (d.target.kind === 'texture') {
        const v = (this.bound(groups, d.target.group, d.target.binding).bound as { view: CompatTextureView }).view,
          t = v.texture;
        const [w, h, depth] = t.levelSize(v.baseMipLevel);
        const is3d = t.dimension === '3d',
          layered = is3d || d.target.dimension === '2d_array';
        const slices = is3d ? depth : v.arrayLayerCount;
        // Fragment: one pass per z of the dispatch (a 2D target's every z draws into its one layer, in order);
        // scatter: one pass per layer of the target, each keeping the stores to it.
        const passes =
          built.tier === 'fragment' ? (layered ? Math.min(nz * wz, slices) : nz * wz) : layered ? slices : 1;
        for (let z = 0; z < passes; z++) {
          const slice = layered ? z : 0;
          const view = is3d
            ? v
            : new CompatTextureView(t, {
                dimension: '2d',
                format: v.format,
                baseMipLevel: v.baseMipLevel,
                mipLevelCount: 1,
                baseArrayLayer: v.baseArrayLayer + slice,
                arrayLayerCount: 1,
              });
          r.beginPass({
            colors: [
              { view, depthSlice: is3d ? slice : 0, clearValue: [0, 0, 0, 0], loadOp: 'load', storeOp: 'store' },
            ],
          });
          r.setPipeline(d.pipeline);
          bind();
          d.pipeline.onDraw = () => {
            gl.uniform4ui(d.cn, nx, ny, nz, z);
            gl.uniform4i(d.ct, w, h, slice, 0);
            dims();
          };
          if (built.tier === 'fragment') {
            r.setScissor(0, 0, Math.min(w, nx * wx), Math.min(h, ny * wy));
            r.draw(3, 1, 0, 0);
          } else r.draw(nx * ny * nz * wx * wy * wz, d.target.stores, 0, 0);
          r.endPass();
        }
        continue;
      }
      // A buffer: drawn as words into its word texture.
      const { bound, dynamic } = this.bound(groups, d.target.group, d.target.binding);
      const b = bound as Extract<Bound, { kind: 'buffer' }>;
      const ws = this.words(r, b.buffer);
      r.beginPass({
        colors: [
          {
            view: ws.texture.createView(),
            depthSlice: 0,
            clearValue: [0, 0, 0, 0],
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
      });
      r.setPipeline(d.pipeline);
      bind();
      d.pipeline.onDraw = () => {
        gl.uniform4ui(d.cn, nx, ny, nz, 0);
        gl.uniform4i(d.ct, ws.width, ws.height, 0, (b.offset + dynamic) >> 2);
        dims();
      };
      r.draw(nx * ny * nz * wx * wy * wz, d.target.stores, 0, 0);
      r.endPass();
      if (!words.some((x) => x.buffer === b.buffer)) words.push({ buffer: b.buffer, words: ws });
    }
    // Only now do buffers change: every draw above read the memory as it was before the dispatch.
    for (const { buffer, words: ws } of words) this.copyBack(r, buffer, ws);
    for (const t of temporary) t.destroy();
  }

  /** A copy of a view's level and layers, read in place of a storage texture the dispatch also writes. */
  private snapshot(r: Replayer, v: CompatTextureView): CompatTextureView {
    const t = v.texture,
      [w, h, depth] = t.levelSize(v.baseMipLevel);
    const layers = t.dimension === '3d' ? depth : v.arrayLayerCount;
    const copy = new CompatTexture(this.device, {
      size: [w, h, layers],
      dimension: t.dimension === '3d' ? '3d' : '2d',
      format: t.format,
      usage: 0x17,
      textureBindingViewDimension: v.dimension,
    } as GPUTextureDescriptor);
    r.copyTextureToTexture(
      { texture: t, mipLevel: v.baseMipLevel, origin: [0, 0, t.dimension === '3d' ? 0 : v.baseArrayLayer] } as never,
      { texture: copy, mipLevel: 0 } as never,
      [w, h, layers],
    );
    return copy.createView({ dimension: v.dimension });
  }

  /** A bind group like `group` with `view` at `binding`. */
  private replace(group: CompatBindGroup, binding: number, view: CompatTextureView): CompatBindGroup {
    const entries = [...group.entries].map(([b, x]) => ({
      binding: b,
      resource:
        b === binding
          ? view
          : x.kind === 'buffer'
            ? { buffer: x.buffer, offset: x.offset, size: x.size }
            : x.kind === 'sampler'
              ? x.sampler
              : x.view,
    }));
    return new CompatBindGroup(this.device, { layout: group.layout, entries } as never);
  }

  /** The word texture of a buffer, brought up to date with the buffer (on the GPU). */
  private words(_r: Replayer, buffer: CompatBuffer): Words {
    const gl = this.gl,
      device = this.device;
    if (buffer.readbacks.length) buffer.settle();
    let ws = buffer.computeState as Words | null;
    const count = Math.max(1, Math.ceil(buffer.size / 16) * 4);
    if (!ws) {
      const width = Math.min(WORDS_WIDTH, device.limits.maxTextureDimension2D),
        height = Math.ceil(count / width);
      const texture = new CompatTexture(device, {
        size: [width, height],
        format: 'r32uint',
        usage: 0x14,
        label: `${buffer.label} words`,
      });
      const created: Words = {
        texture,
        width,
        height,
        version: -1,
        rows: null,
        fbo: null,
        destroy: () => {
          texture.destroy();
          if (created.rows) {
            device.state.forgetTexture(created.rows);
            gl.deleteTexture(created.rows);
          }
          if (created.fbo) gl.deleteFramebuffer(created.fbo);
        },
      };
      buffer.computeState = ws = created;
    }
    if (ws.version !== buffer.version && buffer.gl) {
      device.state.scratch(gl.TEXTURE_2D, ws.texture.texture);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buffer.gl);
      const full = Math.floor(count / ws.width),
        rest = count - full * ws.width;
      if (full) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ws.width, full, gl.RED_INTEGER, gl.UNSIGNED_INT, 0);
      if (rest)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, full, rest, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, full * ws.width * 4);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      ws.texture.initialized = true;
      ws.version = buffer.version;
    }
    return ws;
  }

  /**
   * Copies a word texture back into its buffer on the GPU: four words per RGBA32UI texel through a draw, then
   * readPixels into the buffer as a pixel-pack buffer.
   */
  private copyBack(r: Replayer, buffer: CompatBuffer, ws: Words): void {
    const gl = this.gl,
      state = this.device.state;
    if (!buffer.gl) return;
    const w4 = ws.width / 4;
    if (!ws.rows) {
      ws.rows = gl.createTexture() as WebGLTexture;
      state.scratch(gl.TEXTURE_2D, ws.rows);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, w4, ws.height);
      ws.fbo = gl.createFramebuffer() as WebGLFramebuffer;
      state.bindDrawFramebuffer(ws.fbo);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ws.rows, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    }
    const h = r.helper(
      'words',
      'uniform highp usampler2D t;\nout highp uvec4 c;\nvoid main() { ivec2 p = ivec2(gl_FragCoord.xy); int x = p.x * 4; c = uvec4(texelFetch(t, ivec2(x, p.y), 0).x, texelFetch(t, ivec2(x + 1, p.y), 0).x, texelFetch(t, ivec2(x + 2, p.y), 0).x, texelFetch(t, ivec2(x + 3, p.y), 0).x); }',
    );
    state.bindDrawFramebuffer(ws.fbo);
    r.helperState(h, w4, ws.height);
    state.unit(0, gl.TEXTURE_2D, ws.texture.texture, this.device.loadSampler);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const texels = Math.ceil(buffer.size / 16),
      full = Math.floor(texels / w4),
      rest = texels - full * w4;
    state.bindReadFramebuffer(ws.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer.gl);
    if (full) gl.readPixels(0, 0, w4, full, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
    if (rest) gl.readPixels(0, full, rest, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, full * w4 * 16);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    state.bindReadFramebuffer(null);
    this.changed(buffer);
    ws.version = buffer.version;
  }

  /** Records that the GPU wrote a buffer: data textures refresh, the CPU copy and the index copy follow. */
  private changed(buffer: CompatBuffer): void {
    buffer.version++;
    if (buffer.shadow) buffer.shadowValid = false;
    if (buffer.element) {
      // WebGL keeps index data in its own buffer: bring it up to date from the GPU (a counted stall).
      const bytes = buffer.bytes();
      buffer.land(0, bytes.slice());
    }
  }

  // ---------------------------------------------------------------- CPU tier

  private runCPU(
    r: Replayer,
    built: CPUBuilt,
    groups: readonly BoundGroup[],
    count: readonly number[],
    label: string,
  ): void {
    const buffers = new Map<string, CPUBuffer>(),
      textures = new Map<string, CPUTexture>(),
      samplers = new Map<string, CPUSampler>();
    const writes: { buffer: CompatBuffer; offset: number; bytes: Uint8Array }[] = [];
    const written: { view: CompatTextureView; texture: CPUTexture & { cache: Map<number, CPULevel> } }[] = [];
    const targets = new Set(built.plan.targets.map((t) => `${t.group}:${t.binding}`));
    for (const [g, group] of groups.entries()) {
      if (!group) continue;
      for (const [binding, x] of group.group.entries) {
        const key = `${g}:${binding}`;
        const di = group.group.layout.dynamic.indexOf(binding),
          dynamic = di >= 0 ? (group.offsets[di] ?? 0) : 0;
        if (x.kind === 'buffer') {
          const all = x.buffer.bytes(),
            start = x.offset + dynamic;
          const bytes = all.slice(start, start + Math.min(x.size, x.buffer.size - start));
          buffers.set(key, { dv: new DataView(bytes.buffer), bytes });
          if (targets.has(key)) writes.push({ buffer: x.buffer, offset: start, bytes });
        } else if (x.kind === 'sampler') {
          const d = x.sampler.d;
          samplers.set(key, {
            mag: d.magFilter === 'linear',
            min: d.minFilter === 'linear',
            mip: d.mipmapFilter === 'linear',
            modes: [...x.sampler.modes.slice(0, 3)],
            lodMin: d.lodMinClamp ?? 0,
            lodMax: d.lodMaxClamp ?? 32,
          });
        } else {
          const t = this.cpuTexture(r, x.view, targets.has(key));
          textures.set(key, t);
          if (targets.has(key)) written.push({ view: x.view, texture: t });
        }
      }
    }
    const kernel = built.kernel.bind({ buffers, textures, samplers });
    H.work.left = this.device.cpuWorkBudget;
    try {
      runKernel(kernel, built.kernel.barriers, built.plan.workgroupSize, count);
    } catch (error) {
      if (!(error instanceof WorkBudgetExceeded)) throw error;
      // Like a GPU that resets a dispatch running too long: nothing it stored lands, and the page hears why.
      this.device.internalError(
        `A compute dispatch on the WebGL2 layer's CPU tier stopped at its work budget of ${this.device.cpuWorkBudget} ` +
          `invocations and loop iterations ('${label}', ${count.join(' x ')} workgroups): an endless loop, or more work ` +
          'than the CPU can do in one dispatch. Make the dispatch smaller, or raise cpuWorkBudget in install() or on the device',
      );
      return;
    } finally {
      H.work.left = Number.POSITIVE_INFINITY;
    }
    for (const w of writes) w.buffer.write(w.offset, w.bytes);
    for (const w of written) this.upload(r, w.view, w.texture);
  }

  /** A view as the CPU reads it: each level read back from the GPU when first used (a counted stall). */
  private cpuTexture(
    r: Replayer,
    view: CompatTextureView,
    storage: boolean,
  ): CPUTexture & { cache: Map<number, CPULevel> } {
    const t = view.texture,
      gl = this.gl,
      device = this.device;
    if (!t.primary) throw device.unsupported('reading a multisampled texture in a compute shader on the CPU');
    const is3d = t.dimension === '3d';
    const cache = new Map<number, CPULevel>();
    const kind = t.info.kind === 'uint' ? 'u' : t.info.kind === 'sint' ? 'i' : 'f';
    return {
      levels: view.mipLevelCount,
      layers: view.arrayLayerCount,
      dimension: view.dimension === '2d-array' ? '2d_array' : view.dimension,
      format: storage ? view.format : undefined,
      cache,
      level(l: number): CPULevel {
        let out = cache.get(l);
        if (out) return out;
        const level = view.baseMipLevel + l,
          [w, h, depth] = t.levelSize(level);
        const layers = is3d ? depth : view.arrayLayerCount;
        const data =
          kind === 'u'
            ? new Uint32Array(w * h * layers * 4)
            : kind === 'i'
              ? new Int32Array(w * h * layers * 4)
              : new Float32Array(w * h * layers * 4);
        const p = t.primary as NonNullable<CompatTexture['primary']>;
        for (let z = 0; z < layers; z++) {
          const layer = is3d ? z : view.baseArrayLayer + z;
          t.read(p, level, 1, is3d ? 0 : layer, 1, r.sync);
          const source = (r.device.readback as NonNullable<CompatDevice['readback']>).fetchInto(
            r,
            p,
            level,
            layer,
            0,
            0,
            w,
            h,
          );
          const slice = data.subarray(z * w * h * 4, (z + 1) * w * h * 4);
          const pixels = source.floatBits ? new Uint32Array(slice.buffer, slice.byteOffset, slice.length) : slice;
          gl.readPixels(0, 0, w, h, source.format, source.type, pixels);
          source.free?.();
          device.stalls++;
        }
        out = { w, h, d: layers, data };
        cache.set(l, out);
        return out;
      },
    };
  }

  /** Draws the texels a CPU kernel stored into a storage texture view (only those: a mask discards the rest). */
  private upload(r: Replayer, view: CompatTextureView, texture: CPUTexture & { cache: Map<number, CPULevel> }): void {
    const level = texture.cache.get(0);
    if (!level?.written) return;
    const gl = this.gl,
      state = this.device.state,
      t = view.texture,
      { w, h } = level;
    const kind = level.data instanceof Uint32Array ? 'u' : level.data instanceof Int32Array ? 'i' : '';
    const load = 'texelFetch(t, p, 0)';
    const stored = this.device.adapter.tierFormats?.store(load, view.format) ?? load;
    const helper = r.helper(
      `masked:${kind}:${stored}`,
      `uniform highp ${kind}sampler2D t;\nuniform highp sampler2D m;\nout highp ${kind}vec4 c;\nvoid main() { ivec2 p = ivec2(gl_FragCoord.xy); if (texelFetch(m, p, 0).r < 0.5) discard; c = ${stored}; }`,
    );
    const values = gl.createTexture() as WebGLTexture,
      mask = gl.createTexture() as WebGLTexture;
    for (let z = 0; z < level.d; z++) {
      const plane = level.written.subarray(z * w * h, (z + 1) * w * h);
      if (!plane.some((x) => x)) continue;
      state.scratch(gl.TEXTURE_2D, values);
      if (z === 0)
        gl.texStorage2D(gl.TEXTURE_2D, 1, kind === 'u' ? gl.RGBA32UI : kind === 'i' ? gl.RGBA32I : gl.RGBA32F, w, h);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        w,
        h,
        kind ? gl.RGBA_INTEGER : gl.RGBA,
        kind === 'u' ? gl.UNSIGNED_INT : kind === 'i' ? gl.INT : gl.FLOAT,
        level.data.subarray(z * w * h * 4, (z + 1) * w * h * 4),
      );
      state.scratch(gl.TEXTURE_2D, mask);
      if (z === 0) gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        w,
        h,
        gl.RED,
        gl.UNSIGNED_BYTE,
        plane.map((x) => (x ? 255 : 0)),
      );
      const is3d = t.dimension === '3d';
      const target = is3d
        ? view
        : new CompatTextureView(t, {
            dimension: '2d',
            format: view.format,
            baseMipLevel: view.baseMipLevel,
            mipLevelCount: 1,
            baseArrayLayer: view.baseArrayLayer + z,
            arrayLayerCount: 1,
          });
      r.beginPass({
        colors: [
          { view: target, depthSlice: is3d ? z : 0, clearValue: [0, 0, 0, 0], loadOp: 'load', storeOp: 'store' },
        ],
      });
      r.helperState(helper, w, h);
      gl.uniform1i(gl.getUniformLocation(helper.program, 'm'), 1);
      state.unit(0, gl.TEXTURE_2D, values, this.device.loadSampler);
      state.unit(1, gl.TEXTURE_2D, mask, this.device.loadSampler);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      r.endPass();
    }
    for (const x of [values, mask]) {
      state.forgetTexture(x);
      gl.deleteTexture(x);
    }
  }
}
