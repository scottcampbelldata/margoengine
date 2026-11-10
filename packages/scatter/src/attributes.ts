import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { ScatterInstances, type ScatterBatch } from '@margoengine/scatter';
/** Initial per-instance data in the same order as a batch's transforms. */
export interface AttributeBatch extends ScatterBatch {
  /** Linear RGB, three floats per instance; default white. */
  colors?: Float32Array;
  /** Named scalar/vector values, tightly packed by the sizes in AttributeOptions. Default zero. */
  attributes?: Readonly<Record<string, Float32Array>>;
}
/** Fixed shader layout shared by every batch. */
export interface AttributeOptions {
  /** Custom names and float component counts (1..4). Declaration order defines data.custom indices. Default none. */
  attributes?: Readonly<Record<string, 1 | 2 | 3 | 4>>;
  /** WGSL defining fn scatterAppearance(position:vec3f,color:vec3f,data:ScatterAttributeData)->ScatterAppearance.
   * position is world space before wind. Result fields are position and color. Both colour and shadows use this function.
   * data.color is vec4f; data.custom is an array of vec4f when custom attributes exist. Default returns the inputs.
   */
  shader?: string;
}
interface Values {
  count: number;
  data: Float32Array;
  buffer?: GPUBuffer;
  groups: Map<GPURenderPipeline, GPUBindGroup>;
}
/** Fixed PBR batches with live colour and shader-consumed custom attributes, including shadow geometry. */
export class AttributedScatter extends ScatterInstances {
  private readonly source: { batches: readonly AttributeBatch[] };
  private readonly schema: readonly [string, number][];
  private readonly words: number;
  private readonly module: string;
  private readonly attributeValues: Values[] = [];
  constructor(generate: () => readonly AttributeBatch[], options: AttributeOptions = {}) {
    if (typeof generate !== 'function') throw new TypeError('Expected an attribute batch factory; pass a function');
    const source = { batches: [] as readonly AttributeBatch[] };
    super(() => {
      source.batches = generate();
      return source.batches;
    });
    this.source = source;
    this.schema = Object.entries(options.attributes ?? {});
    if (this.schema.some(([name, n]) => !name.length || ![1, 2, 3, 4].includes(n)))
      throw new RangeError('Attribute component counts must be 1..4; declare a nonempty name for each attribute');
    if (
      options.shader !== undefined &&
      (typeof options.shader !== 'string' || !/\bfn\s+scatterAppearance\s*\(/.test(options.shader))
    )
      throw new TypeError('Attribute shader must define fn scatterAppearance; pass WGSL with the documented signature');
    this.words = (1 + this.schema.length) * 4;
    this.module =
      `struct ScatterAttributeData {color:vec4f${this.schema.length ? `,custom:array<vec4f,${this.schema.length}>` : ''}}\nstruct ScatterAppearance {position:vec3f,color:vec3f}\n@group(1) @binding(0) var<storage,read> scatterAttributes:array<ScatterAttributeData>;\n` +
      (options.shader ??
        'fn scatterAppearance(position:vec3f,color:vec3f,data:ScatterAttributeData)->ScatterAppearance{return ScatterAppearance(position,color);}') +
      '\n';
  }
  static override attach(
    engine: EngineKernel,
    generate: () => readonly AttributeBatch[],
    options?: AttributeOptions,
  ): AttributedScatter {
    const scatter = new AttributedScatter(generate, options);
    engineRuntime(engine).use(scatter);
    return scatter;
  }
  /** Zero-based data.custom slot for a named attribute; throws for undeclared names. */
  attributeIndex(name: string): number {
    const slot = this.schema.findIndex(([key]) => key === name);
    if (slot < 0) throw new RangeError('Unknown instance attribute; declare the name in options.attributes');
    return slot;
  }
  override setup(engine: Engine): void {
    try {
      super.setup(engine);
      const d = engine.gpu!;
      for (let b = 0; b < this.source.batches.length; b++) {
        const batch = this.source.batches[b],
          count = batch.transforms.length / 16;
        let v = this.attributeValues[b];
        if (!v || v.count !== count) {
          const bytes = count * this.words * 4;
          if (bytes > Math.min(d.limits.maxBufferSize, d.limits.maxStorageBufferBindingSize))
            throw new RangeError('Instance attributes exceed the device buffer limit; split the batch');
          v = { count, data: new Float32Array(count * this.words), groups: new Map() };
          for (let i = 0; i < count; i++) v.data.set([1, 1, 1, 1], i * this.words);
          if (batch.colors) {
            this.validate(batch.colors, count * 3, true);
            for (let i = 0; i < count; i++) v.data.set(batch.colors.subarray(i * 3, i * 3 + 3), i * this.words);
          }
          for (const name of Object.keys(batch.attributes ?? {})) this.attributeIndex(name);
          this.schema.forEach(([name, size], k) => {
            const a = batch.attributes?.[name];
            if (a) {
              this.validate(a, count * size, false);
              for (let i = 0; i < count; i++)
                v.data.set(a.subarray(i * size, i * size + size), i * this.words + (k + 1) * 4);
            }
          });
          this.attributeValues[b] = v;
        }
        v.buffer = d.createBuffer({ size: v.data.byteLength, usage: 128 | 8 });
        d.queue.writeBuffer(v.buffer, 0, v.data as Float32Array<ArrayBuffer>);
      }
      this.attributeValues.length = this.source.batches.length;
    } catch (error) {
      this.release();
      throw error;
    }
  }
  private validate(value: ArrayLike<number>, length: number, positive: boolean): void {
    if (
      !value ||
      value.length !== length ||
      Array.from(value).some((v) => typeof v !== 'number' || !Number.isFinite(Math.fround(v)) || (positive && v < 0))
    )
      throw new RangeError(
        'Invalid instance values; supply the declared number of finite f32 components and nonnegative RGB',
      );
  }
  private row(index: number, batch: number): Values {
    if (this.disposed) throw new MargoError('disposed', 'AttributedScatter is disposed; create a new scatter');
    const v = this.attributeValues[batch];
    if (!Number.isInteger(batch) || !v || !Number.isInteger(index) || index < 0 || index >= v.count)
      throw new RangeError(
        'Instance index or batch is outside the uploaded range; attach first and use an existing instance',
      );
    return v;
  }
  /** Set one linear RGB tint without recreating geometry or GPU resources. Batch defaults to 0. */
  setColorAt(index: number, color: ArrayLike<number>, batch = 0): this {
    const v = this.row(index, batch);
    this.validate(color, 3, true);
    const at = index * this.words;
    v.data.set(Array.from(color), at);
    this.engine!.gpu!.queue.writeBuffer(v.buffer!, at * 4, v.data as Float32Array<ArrayBuffer>, at, 4);
    return this;
  }
  /** Read a copy of one linear RGB tint. */
  getColorAt(index: number, batch = 0): Float32Array {
    const v = this.row(index, batch);
    return v.data.slice(index * this.words, index * this.words + 3);
  }
  /** Set one scalar/vector custom value. Arrays contain exactly its declared number of components. */
  setAttributeAt(index: number, name: string, value: ArrayLike<number>, batch = 0): this {
    const k = this.attributeIndex(name),
      v = this.row(index, batch);
    this.validate(value, this.schema[k][1], false);
    const at = index * this.words + (k + 1) * 4;
    v.data.set(Array.from(value), at);
    this.engine!.gpu!.queue.writeBuffer(v.buffer!, at * 4, v.data as Float32Array<ArrayBuffer>, at, 4);
    return this;
  }
  /** Read a copy of a scalar/vector custom value. */
  getAttributeAt(index: number, name: string, batch = 0): Float32Array {
    const k = this.attributeIndex(name),
      v = this.row(index, batch),
      at = index * this.words + (k + 1) * 4;
    return v.data.slice(at, at + this.schema[k][1]);
  }
  protected override appearanceCode(code: string, shadow: boolean): string {
    const input = shadow ? ',@location(6) color:vec4f' : '';
    code = code.replace(/struct Input \{[^}]+\}/, (s) =>
      s.replace('}', `,@builtin(instance_index) scatterIndex:u32${input}}`),
    );
    const call =
      'let rowData=scatterAttributes[i.scatterIndex];let appearance=scatterAppearance(p.xyz,i.color.rgb*rowData.color.rgb,rowData);p=vec4f(appearance.position,1);';
    code = shadow
      ? code.replace(
          'var p=mat4x4f(i.a,i.b,i.c,i.d)*vec4f(i.p,1);',
          'var p=mat4x4f(i.a,i.b,i.c,i.d)*vec4f(i.p,1);' + call,
        )
      : code
          .replace('var p=model*vec4f(i.position,1);', 'var p=model*vec4f(i.position,1);' + call)
          .replace('o.color=i.color.rgb*i.vertexColor.rgb;', 'o.color=appearance.color*i.vertexColor.rgb;');
    return this.module + code;
  }
  protected override bindBatch(pass: GPURenderPassEncoder, batch: number, pipeline: GPURenderPipeline): void {
    const v = this.attributeValues[batch];
    let group = v.groups.get(pipeline);
    if (!group) {
      group = this.engine!.gpu!.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: v.buffer! } }],
      });
      v.groups.set(pipeline, group);
    }
    pass.setBindGroup(1, group);
  }
  protected override release(): void {
    super.release();
    for (const v of this.attributeValues) {
      v.buffer?.destroy();
      v.buffer = undefined;
      v.groups.clear();
    }
  }
}
