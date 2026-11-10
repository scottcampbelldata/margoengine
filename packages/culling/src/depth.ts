/// <reference lib="esnext.disposable" preserve="true" />
import type { Engine, PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { viewSize } from '../../shared/view-rect.js';
import { Pyramid, depthKind, exactShader, levelTable } from './pyramid.js';
import { OccluderList, type OccluderInput } from './occluders.js';
import { common, computeShader, occlusionCode } from './shaders.js';
export type { OccluderInput, OccluderSource, OccluderContext } from './occluders.js';

/** WGSL declarations and conservative reversed-Z sphere test. Bind uniform at 0 and pyramid storage at 5. */
export const depthPyramidShader = common + '@group(0) @binding(5) var<storage,read> hiz:array<f32>;\n' + occlusionCode;

/** Current-frame occluder depth and Hi-Z, shared by optional GPU consumers. No previous-frame visibility. */
export class DepthPyramid {
  private readonly sources = new OccluderList();
  private device?: GPUDevice;
  private pyramid?: Pyramid;
  private table?: GPUBuffer;
  private data = new Float32Array(112);
  private words = new Uint32Array(this.data.buffer);
  private frame?: GPUBuffer;
  private dead = false;
  private samples = 0;
  /** Current depth uniform, valid after encode until release or device restoration. */
  get uniform(): GPUBuffer | undefined {
    return this.frame;
  }
  /** Current pyramid storage, valid after encode until resize or release. */
  get buffer(): GPUBuffer | undefined {
    return this.pyramid?.buffer;
  }
  /** Register real opaque geometry, a core mesh, glTF model, materials mesh or Terrain. */
  add(source: OccluderInput): this {
    this.sources.add(source);
    return this;
  }
  remove(source: OccluderInput): this {
    this.sources.remove(source);
    return this;
  }
  /** Render registered occluders for this camera, then reduce every pixel to farthest reversed depth. */
  encode(c: Extract<PassContext, { backend: 'webgpu' }>, engine: Engine): void {
    if (this.dead) throw new MargoError('disposed', 'DepthPyramid is disposed; create a new depth pyramid');
    const d = c.device;
    const samples = c.descriptor.multisample?.count ?? 1;
    if (d !== this.device || samples !== this.samples) {
      this.release();
      this.device = d;
      this.samples = samples;
      this.frame = d.createBuffer({ size: this.data.byteLength, usage: 64 | 8 });
      this.table = d.createBuffer({ size: 4096, usage: 64 | 8 });
      d.queue.writeBuffer(this.table, 0, levelTable());
      const module = d.createShaderModule({ code: computeShader(samples) });
      const pipeline = (entryPoint: string) =>
        d.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
      this.pyramid = new Pyramid(
        d,
        samples,
        { depth0: pipeline('depth0'), reduce: pipeline('reduce') },
        this.frame,
        this.table,
        this.words,
      );
    }
    const p = this.pyramid!,
      [width, height] = viewSize(c);
    if (width !== p.width || height !== p.height) p.resize(width, height);
    this.data.set(c.camera.matrix);
    this.words.set([width, height, p.levels, 0], 40);
    this.words[46] = depthKind(c.camera.matrix);
    d.queue.writeBuffer(this.frame!, 0, this.data as Float32Array<ArrayBuffer>);
    const pass = c.encoder.beginRenderPass(p.pass);
    // Clipped/custom vertex shaders cannot safely supply the exact occluder geometry.
    if (exactShader(c.shader)) this.sources.draw(pass, c, engine, samples);
    pass.end();
    const compute = c.encoder.beginComputePass();
    p.encode(compute, width, height);
    compute.end();
  }
  /** Free GPU state while retaining registered sources; encode recreates it on the next device. */
  release(): void {
    this.pyramid?.destroy();
    this.frame?.destroy();
    this.table?.destroy();
    this.sources.release();
    this.pyramid = this.frame = this.table = this.device = undefined;
  }
  dispose(): void {
    if (!this.dead) {
      this.release();
      this.dead = true;
    }
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
