/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { CulledInstances, type CulledBatch, type CulledInstancesOptions } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

/** A {@link CulledBatch} that can hold more parts than it starts with. */
export interface CulledPartsBatch extends CulledBatch {
  /** Column-major affine world matrices, 16 floats per instance. May be empty when `capacity` is set. */
  transforms: Float32Array;
  /**
   * Parts this batch can hold at once, for {@link CulledParts.addParts}. Fixed; each free slot costs its 96-byte record
   * and one test per frame. Default: the parts in `transforms`, so nothing can be added.
   */
  capacity?: number;
}
/** One part: its batch, and its index inside that batch. */
export interface CulledPart {
  batch: number;
  index: number;
}

// Caster and id draws of the whole part list: hidden and free slots collapse to a point outside clip space.
const partInput =
  'struct Input {@builtin(instance_index) n:u32,@location(0) p:vec3f,@location(2) a:vec4f,@location(3) b:vec4f,@location(4) c:vec4f,@location(5) d:vec4f,@location(6) factors:vec4f,@location(7) hidden:u32}\nconst away=vec4f(2.0,2.0,2.0,1.0);\n';
/** Depth-only caster draw for @margoengine/shadows' cascade passes. */
const partsShadowShader =
  partInput +
  `
@group(0) @binding(0) var<uniform> light:mat4x4f;
@vertex fn vertex(i:Input)->@builtin(position) vec4f {
  if(i.hidden!=0u){return away;}
  return light*mat4x4f(i.a,i.b,i.c,i.d)*vec4f(i.p,1);
}
`;
/** One id per part (its flat slot) into a 1x1 r32uint target, with core's single-sided rule. */
const partsPickShader =
  partInput +
  `
@group(0) @binding(0) var<uniform> camera:mat4x4f;
struct Output {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) id:u32,@location(1) @interpolate(flat) side:vec2f}
@vertex fn vertex(i:Input)->Output {
  let m=mat4x4f(i.a,i.b,i.c,i.d);var o:Output;o.clip=away;
  if(i.hidden==0u){o.clip=camera*m*vec4f(i.p,1);}
  o.id=i.n;o.side=vec2f(sign(dot(m[0].xyz,cross(m[1].xyz,m[2].xyz))),i.factors.z);return o;
}
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) u32 {
  if(front!=(i.side.x>0.0)&&i.side.y<0.5){discard;}
  return i.id;
}
`;

// The whole part list as instance data, for the caster and id draws: a part's record and its hidden word.
const partLayouts: GPUVertexBufferLayout[] = [
  { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  {
    arrayStride: 96,
    stepMode: 'instance',
    attributes: [
      ...[2, 3, 4, 5].map((shaderLocation, i) => ({
        shaderLocation,
        offset: i * 16,
        format: 'float32x4' as const,
      })),
      { shaderLocation: 6, offset: 80, format: 'float32x4' },
    ],
  },
  { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 7, offset: 0, format: 'uint32' }] },
];
const FREE = 2; // A slot's word in `hidden`: 0 shown, 1 hidden by setVisible, 2 holds no part.

// The root class sees one part per slot, so spare slots start as identity matrices that the constructor marks free.
function reserve(batches: readonly CulledPartsBatch[]): readonly CulledBatch[] {
  if (!Array.isArray(batches)) return batches;
  return batches.map((b: CulledPartsBatch) => {
    if (b?.capacity === undefined || !(b.transforms instanceof Float32Array) || b.transforms.length % 16) return b;
    const parts = b.transforms.length / 16;
    if (!Number.isInteger(b.capacity) || b.capacity < parts)
      throw new RangeError('Invalid culled batch capacity; pass a whole number no smaller than its part count');
    const transforms = new Float32Array(b.capacity * 16);
    transforms.set(b.transforms);
    for (let i = parts; i < b.capacity; i++) for (let k = 0; k < 16; k += 5) transforms[i * 16 + k] = 1;
    return { ...b, transforms };
  });
}

/**
 * {@link CulledInstances} with picking, a part hierarchy, shadow casting and streaming, for scenes that use them; the
 * plain class stays smaller without them. Everything else, culling included, is the same.
 */
export class CulledParts extends CulledInstances {
  /** Bumped when a part changes, for `shadows.add(parts, {static: true})`: the cached still map re-renders. */
  shadowVersion = 0;
  private live = 0;
  // Per batch, the free indices inside it, the lowest last.
  private readonly free: number[][];
  // Allocated by the first setParent. Per slot: the parent's slot or -1, and the matrix relative to that parent.
  private parents?: Int32Array;
  private locals?: Float32Array;
  private children?: Map<number, number[]>;
  private readonly product = new Float32Array(16);
  private shadow?: { pipeline: GPURenderPipeline; uniforms: GPUBuffer[]; groups: GPUBindGroup[] };
  private picker?: {
    pipeline: GPURenderPipeline;
    uniform: GPUBuffer;
    ids: GPUTexture;
    depth: GPUTexture;
    group: GPUBindGroup;
    descriptor: GPURenderPassDescriptor;
  };
  private picking?: Promise<CulledPart | null>;

  /** Same as `engine.use(new CulledParts(...))`; returns the CulledParts. */
  static override attach(
    engine: EngineKernel,
    batches: readonly CulledPartsBatch[],
    options?: CulledInstancesOptions,
  ): CulledParts {
    const value = new CulledParts(batches, options);
    engine.use(value);
    return value;
  }
  constructor(batches: readonly CulledPartsBatch[], options?: CulledInstancesOptions) {
    super(reserve(batches), options);
    this.free = batches.map((b, batch) => {
      const parts = b.transforms.length / 16,
        free: number[] = [];
      for (let i = (b.capacity ?? parts) - 1; i >= parts; i--) {
        this.hidden[this.starts[batch] + i] = FREE;
        free.push(i);
      }
      this.live += parts;
      return free;
    });
  }
  /** Parts alive now, hidden ones included. */
  override get count(): number {
    return this.live;
  }
  override setTransform(batch: number, index: number, matrix: ArrayLike<number>): void {
    this.place(this.index(batch, index), matrix);
  }
  /**
   * Makes a part follow another: from now on its matrix (the one it has, and each later {@link setTransform}) is relative
   * to `parent`, and moving the parent moves the whole subtree, one record write per part there. `null` detaches it,
   * keeping its world position. A parent may be hidden, which makes it a plain group node.
   * @throws RangeError for a part not alive or a parent inside the part's own subtree.
   */
  setParent(batch: number, index: number, parent: CulledPart | null): void {
    const i = this.index(batch, index),
      p = parent ? this.index(parent.batch, parent.index) : -1;
    const parents = (this.parents ??= new Int32Array(this.slots).fill(-1)),
      locals = (this.locals ??= new Float32Array(this.slots * 16)),
      children = (this.children ??= new Map());
    for (let a = p; a >= 0; a = parents[a])
      if (a === i) throw new RangeError("Invalid culled parent; pick a part outside this part's own subtree");
    const old = parents[i];
    if (old >= 0) this.unlink(i, old);
    else if (p >= 0) locals.set(this.records.subarray(i * 24, i * 24 + 16), i * 16);
    parents[i] = p;
    if (p >= 0) {
      const list = children.get(p);
      if (list) list.push(i);
      else children.set(p, [i]);
      this.place(i, locals.subarray(i * 16, i * 16 + 16));
    }
  }
  /** Writes a part's world matrix into `out` (default a new array) and returns it. */
  getWorldMatrix(batch: number, index: number, out: number[] | Float32Array = new Float32Array(16)): typeof out {
    const at = this.index(batch, index) * 24;
    for (let k = 0; k < 16; k++) out[k] = this.records[at + k];
    return out;
  }
  /**
   * Adds parts to a batch's free slots, shown, without touching the rest: one upload per changed range with the next
   * frame, as for {@link setTransform}. Returns each new part's index inside the batch.
   * @throws RangeError when the batch has too few free slots; reserve them with {@link CulledBatch.capacity}.
   */
  addParts(batch: number, transforms: Float32Array): number[] {
    const free = this.free[batch];
    if (!free) throw new RangeError('Invalid culled batch index; pass a batch index from 0 up to the batch count');
    if (!(transforms instanceof Float32Array) || transforms.length % 16)
      throw new TypeError('Invalid culled parts; pass a Float32Array of 16-float matrices');
    const n = transforms.length / 16;
    if (n > free.length)
      throw new RangeError(
        `Culled batch ${batch} has ${free.length} free slots for ${n} parts; set a larger capacity on the batch`,
      );
    for (let k = 0; k < n; k++) this.determinant(transforms.subarray(k * 16, k * 16 + 16));
    const added: number[] = [];
    for (let k = 0; k < n; k++) {
      const index = free.pop()!,
        i = this.starts[batch] + index;
      this.show(i, 0);
      this.place(i, transforms.subarray(k * 16, k * 16 + 16));
      added.push(index);
    }
    this.live += n;
    return added;
  }
  /**
   * Removes parts, freeing their slots for {@link addParts}; other parts keep their indices. Detaches each from its parent.
   * @throws RangeError for a part not alive, listed twice, or still the parent of a part that is not removed with it.
   */
  removeParts(batch: number, indices: readonly number[]): void {
    const slots = indices.map((index) => this.index(batch, index)),
      gone = new Set(slots);
    if (gone.size !== slots.length) throw new RangeError('Invalid culled parts; list each part to remove once');
    for (const i of slots)
      if (this.children?.get(i)?.some((child) => !gone.has(child)))
        throw new RangeError('Culled part still has children; detach them with setParent or remove them too');
    slots.forEach((i, k) => {
      const parent = this.parents?.[i] ?? -1;
      if (parent >= 0) this.unlink(i, parent);
      if (this.parents) this.parents[i] = -1;
      this.flips[batch] -= this.flipped[i];
      this.flipped[i] = 0;
      this.show(i, FREE);
      this.free[batch].push(indices[k]);
    });
    this.live -= slots.length;
  }
  /**
   * The shown part under CSS pixel (x, y) through the engine camera, or null. Other drawing does not count: to find what
   * is nearest overall, compare with `engine.pick`. A GPU readback of one draw of every shown part (culled ones can
   * never be the answer) into a 1x1 id target; overlapping calls run one after another. Follows core's single-sided rule.
   */
  pick(x: number, y: number): Promise<CulledPart | null> {
    if (!this.engine || !this.device)
      return Promise.reject(new MargoError('state', 'CulledInstances is not attached; attach it to an engine first'));
    if (!Number.isFinite(x) || !Number.isFinite(y))
      return Promise.reject(new RangeError('Invalid pick; pass finite CSS pixels'));
    const run = (this.picking ?? Promise.resolve(null)).then(
      () => this.pickNow(x, y),
      () => this.pickNow(x, y),
    );
    this.picking = run;
    return run;
  }
  /**
   * Draws every shown part into one shadow cascade (the `ShadowSource` contract of @margoengine/shadows:
   * `shadows.add(parts)`). Parts outside the camera view still cast, so this does not use the camera's culled list.
   */
  drawShadow({
    context,
    pass,
    matrix,
    cascade,
  }: {
    context: { device: GPUDevice };
    pass: GPURenderPassEncoder;
    matrix: Float32Array;
    cascade: number;
  }): void {
    const d = context.device;
    if (!this.device) return;
    const s = (this.shadow ??= (() => {
      const module = d.createShaderModule({ code: partsShadowShader }),
        pipeline = d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex', buffers: partLayouts },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
        }),
        uniforms: GPUBuffer[] = [],
        groups: GPUBindGroup[] = [];
      for (let i = 0; i < 4; i++) {
        const buffer = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        uniforms.push(buffer);
        groups.push(this.bind(pipeline, [[0, { buffer }]]));
      }
      return { pipeline, uniforms, groups };
    })());
    this.flush(d);
    d.queue.writeBuffer(s.uniforms[cascade], 0, matrix as Float32Array<ArrayBuffer>);
    pass.setPipeline(s.pipeline);
    pass.setBindGroup(0, s.groups[cascade]);
    this.drawParts(pass);
  }

  // One draw per batch of all its slots: firstInstance is the flat slot, so instance_index names the part.
  private drawParts(pass: GPURenderPassEncoder): void {
    pass.setVertexBuffer(1, this.buffers.records);
    pass.setVertexBuffer(2, this.buffers.hidden);
    this.batches.forEach((batch, i) => {
      const g = this.geometryBuffers.get(batch.geometry)!,
        table = this.table;
      pass.setVertexBuffer(0, g.vertex);
      pass.setIndexBuffer(g.index, 'uint32');
      pass.drawIndexed(batch.geometry.indices.length, table[i * 4 + 1] - table[i * 4], 0, 0, table[i * 4]);
    });
  }
  private async pickNow(x: number, y: number): Promise<CulledPart | null> {
    const engine = this.engine,
      d = this.device;
    if (!engine || !d) return null;
    const canvas = engine.canvas,
      w = canvas.clientWidth || canvas.width,
      h = canvas.clientHeight || canvas.height;
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const t = (this.picker ??= (() => {
      const module = d.createShaderModule({ code: partsPickShader }),
        pipeline = d.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex', buffers: partLayouts },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: 'r32uint' }] },
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
        }),
        uniform = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        ids = d.createTexture({ size: [1, 1], format: 'r32uint', usage: 16 | 1 }),
        depth = d.createTexture({ size: [1, 1], format: 'depth32float', usage: 16 });
      return {
        pipeline,
        uniform,
        ids,
        depth,
        group: this.bind(pipeline, [[0, { buffer: uniform }]]),
        descriptor: {
          colorAttachments: [
            { view: ids.createView(), clearValue: [4294967295, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
          ],
          depthStencilAttachment: {
            view: depth.createView(),
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'discard',
          },
        } as GPURenderPassDescriptor,
      };
    })());
    // The camera matrix scaled and offset so the picked device pixel fills the 1x1 target.
    const camera = engine.camera.matrix,
      matrix = this.product,
      px = Math.floor((x * canvas.width) / w) + 0.5,
      py = Math.floor((y * canvas.height) / h) + 0.5;
    for (let c = 0; c < 4; c++) {
      const wc = camera[c * 4 + 3];
      matrix[c * 4] = camera[c * 4] * canvas.width - (2 * px - canvas.width) * wc;
      matrix[c * 4 + 1] = camera[c * 4 + 1] * canvas.height + (2 * py - canvas.height) * wc;
      matrix[c * 4 + 2] = camera[c * 4 + 2];
      matrix[c * 4 + 3] = wc;
    }
    d.queue.writeBuffer(t.uniform, 0, matrix as Float32Array<ArrayBuffer>);
    this.flush(d);
    const read = d.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = d.createCommandEncoder(),
        pass = encoder.beginRenderPass(t.descriptor);
      pass.setPipeline(t.pipeline);
      pass.setBindGroup(0, t.group);
      this.drawParts(pass);
      pass.end();
      encoder.copyTextureToBuffer({ texture: t.ids }, { buffer: read }, [1, 1]);
      d.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const id = new Uint32Array(read.getMappedRange().slice(0))[0];
      read.unmap();
      if (id >= this.slots || this.hidden[id]) return null;
      const batch = this.batchOf[id];
      return { batch, index: id - this.starts[batch] };
    } finally {
      read.destroy();
    }
  }
  private unlink(i: number, parent: number): void {
    const list = this.children!.get(parent)!;
    list.splice(list.indexOf(i), 1);
    if (!list.length) this.children!.delete(parent);
  }
  protected override show(i: number, word: number): void {
    super.show(i, word);
    this.shadowVersion++;
  }
  // A part's own matrix (relative to its parent, if it has one), then the world matrices of its subtree, parents first.
  private place(i: number, matrix: ArrayLike<number>): void {
    const parent = this.parents?.[i] ?? -1;
    if (parent >= 0) {
      this.write(i, this.fold(parent, matrix, 0));
      this.locals!.set(matrix, i * 16);
    } else this.write(i, matrix);
    this.dirty(i);
    this.shadowVersion++;
    const below = this.children?.get(i);
    if (!below) return;
    const stack = [...below];
    while (stack.length) {
      const k = stack.pop()!;
      this.write(k, this.fold(this.parents![k], this.locals!, k * 16));
      this.dirty(k);
      const more = this.children!.get(k);
      if (more) stack.push(...more);
    }
  }
  // The world matrix of `parent` times the 16 values of `m` from `at`, in a shared scratch array.
  private fold(parent: number, m: ArrayLike<number>, at: number): Float32Array {
    const a = this.records,
      p = parent * 24,
      out = this.product;
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++)
        out[c * 4 + r] =
          a[p + r] * m[at + c * 4] +
          a[p + 4 + r] * m[at + c * 4 + 1] +
          a[p + 8 + r] * m[at + c * 4 + 2] +
          a[p + 12 + r] * m[at + c * 4 + 3];
    return out;
  }
  protected override index(batch: number, index: number): number {
    const i = super.index(batch, index);
    if (this.hidden[i] === FREE)
      throw new RangeError('Invalid culled instance; pass a batch index and an instance index inside that batch');
    return i;
  }
  protected override release(): void {
    for (const buffer of this.shadow?.uniforms ?? []) buffer.destroy();
    this.picker?.uniform.destroy();
    this.picker?.ids.destroy();
    this.picker?.depth.destroy();
    this.shadow = this.picker = undefined;
    super.release();
  }
}
