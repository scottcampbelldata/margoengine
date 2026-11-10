/// <reference lib="esnext.disposable" preserve="true" />
import type { Figure, PickResult, Layer } from './figure.js';
import type { MeshLayer } from './grids.js';
import type { Engine } from '@margoengine/core/extension';
import { invertMatrix, multiplyMatrices } from '@margoengine/math/mat4';
import { fault, rangeError } from '../../shared/errors.js';
import { pickVisible } from './pick-visibility.js';
import { pointPickWGSL, cellPickWGSL, surfacePickWGSL, volumePickWGSL, meshPickWGSL } from './pick-gpu-shaders.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; VERTEX: number; COPY_SRC: number; MAP_READ: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
declare const GPUMapMode: { READ: number };

/** A GPU hit. Surface indices name cells (not the CPU ray picker's nearest sample); volumes name voxels. */
export interface GpuPickResult extends PickResult {
  /** Original reversed-Z depth, independent of the query's point-distance ranking. */
  readonly depth: number;
  /** No projection of the layer's items is performed on the CPU. */
  readonly kind: 'point' | 'cell' | 'volume';
}

/** Per-query options, in CSS pixels. */
export interface GpuPickOptions {
  /** Point search radius. Default 8; exact centre distance wins and exact ties use depth. */
  readonly radius?: number;
  /** First-hit per-step opacity threshold, greater than zero and at most one. Default 0.002. */
  readonly opacityThreshold?: number;
  /** Cancellation includes waiting for an earlier pick and GPU readback. */
  readonly signal?: AbortSignal;
  /** Hard deadline in milliseconds. Default 30000. */
  readonly timeout?: number;
}

interface RecordGPU {
  kind: 'point' | 'rect' | 'surface' | 'volume' | 'mesh';
  uniform: GPUBuffer;
  vertices?: GPUBuffer;
  source?: ArrayLike<number>;
  count: number;
}

const isMesh = (layer: Layer): layer is Layer & MeshLayer =>
  'pickGeometry' in layer && typeof layer.pickGeometry === 'function';

/**
 * Optional one-pixel integer ID pass for every scatter point, chart/surface cell and volume first hit.
 * IDs are full u32 indices, independent of the drawing point budget. CPU `figure.pick()` is unchanged.
 * CPU-backed point/rectangle arrays upload once; call invalidate after mutating them. Live surface buffers and
 * volume textures are borrowed. Native WebGPU and the full WebGL2 compatibility backend are supported.
 */
export class GpuPicking {
  readonly #figure: Figure;
  #device?: GPUDevice;
  #color?: GPUTexture;
  #depth?: GPUTexture;
  #read?: GPUBuffer;
  #records = new Map<Layer, RecordGPU>();
  #pipelines = new Map<string, GPURenderPipeline>();
  #disposed = false;
  #tail: Promise<unknown> = Promise.resolve();
  #hover?: () => void;
  readonly #lifetime = new AbortController();

  /** Creates the picker without allocating GPU resources or changing hover. */
  constructor(figure: Figure) {
    this.#figure = figure;
    if (!figure.renderer.device)
      throw fault('unsupported', 'GPU picking needs WebGPU or createFallbackFigure', 'sciviz');
  }

  /** Invalidates a cached CPU input after an in-place edit; omitted layer clears every cached input. */
  invalidate(layer?: Layer): void {
    const entries = layer ? [[layer, this.#records.get(layer)] as const] : [...this.#records];
    for (const [owner, record] of entries) {
      record?.uniform.destroy();
      record?.vertices?.destroy();
      this.#records.delete(owner);
    }
  }

  /** Uses GPU picks for the figure's existing hover events and tooltip. Removing restores CPU hover. */
  attachHover(options: Omit<GpuPickOptions, 'signal'> = {}): () => void {
    this.#check();
    this.#hover?.();
    const remove = this.#figure.setHoverPicker((x, y) => this.pick(x, y, options));
    this.#hover = remove;
    return remove;
  }

  /**
   * Picks under CSS (x,y) with a bounded 256-byte readback. Calls serialize without sharing mapped buffers.
   * Rejects on cancellation, timeout, disposal or device loss; call again after the engine restores its device.
   */
  pick(x: number, y: number, options: GpuPickOptions = {}): Promise<GpuPickResult | null> {
    const radius = options.radius ?? 8,
      threshold = options.opacityThreshold ?? 0.002,
      timeout = options.timeout ?? 30000;
    if (
      ![x, y, radius, threshold, timeout].every(Number.isFinite) ||
      radius < 0 ||
      threshold <= 0 ||
      threshold > 1 ||
      timeout <= 0
    )
      return Promise.reject(
        rangeError('Use finite coordinates, radius >= 0, opacityThreshold in (0,1], timeout > 0', 'sciviz'),
      );
    const signal = AbortSignal.any([
      this.#lifetime.signal,
      AbortSignal.timeout(Math.ceil(timeout)),
      ...(options.signal ? [options.signal] : []),
    ]);
    const pending = this.#tail.then(() => {
      signal.throwIfAborted();
      this.#check();
      return this.#pick(x, y, radius, threshold, signal);
    });
    // A failed request is observed by its caller; it must not poison subsequent requests.
    this.#tail = pending.then(
      () => {},
      () => {},
    );
    return waitFor(pending, signal);
  }

  #check(): void {
    if (this.#disposed) throw fault('disposed', 'Create a new GpuPicking after disposal', 'sciviz');
  }

  #clear(): void {
    this.invalidate();
    this.#color?.destroy();
    this.#depth?.destroy();
    this.#read?.destroy();
    this.#pipelines.clear();
  }

  #ensure(device: GPUDevice): void {
    if (this.#device === device) return;
    this.#clear();
    this.#device = device;
    this.#color = device.createTexture({
      size: [1, 1],
      format: 'rgba32uint',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.#depth = device.createTexture({
      size: [1, 1],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#read = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  #record(layer: Layer): RecordGPU | undefined {
    let kind: RecordGPU['kind'], source: Float32Array | undefined, count: number;
    if ('kind' in layer && (layer.kind === 'scatter' || layer.kind === 'line')) {
      kind = 'point';
      source = layer.kind === 'scatter' ? layer.cloud.positions : layer.positions;
      count = source.length / 3;
    } else if ('rects' in layer) {
      kind = 'rect';
      source = layer.rects;
      count = layer.values.length;
    } else if (isMesh(layer)) {
      kind = 'mesh';
      const geometry = layer.pickGeometry();
      if (!geometry) return;
      count = geometry.count;
    } else if ('pickHeights' in layer) {
      kind = 'surface';
      count = (layer.nx - 1) * (layer.ny - 1);
      if (!layer.pickHeights()) return;
    } else if ('resources' in layer && 'dims' in layer && 'classificationUniforms' in layer) {
      if (!layer.valid) return;
      kind = 'volume';
      count = layer.dims[0] * layer.dims[1] * layer.dims[2];
      if (count > 0x100000000)
        throw rangeError('GPU picking supports at most 2^32 voxels per layer; split the volume', 'sciviz');
    } else return;
    const cached = this.#records.get(layer);
    if (cached && cached.source === source) { cached.count = count; return cached; }
    this.invalidate(layer);
    const device = this.#device!,
      uniform = device.createBuffer({ size: 320, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const record: RecordGPU = { kind, uniform, count, source };
    if (source) {
      if (source.byteLength > device.limits.maxBufferSize) {
        uniform.destroy();
        throw rangeError('GPU pick input exceeds maxBufferSize; split it into multiple layers', 'sciviz');
      }
      record.vertices = device.createBuffer({
        size: Math.max(16, source.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(record.vertices, 0, source as Float32Array<ArrayBuffer>);
    }
    this.#records.set(layer, record);
    return record;
  }

  #pipeline(kind: RecordGPU['kind']): GPURenderPipeline {
    let pipeline = this.#pipelines.get(kind);
    if (pipeline) return pipeline;
    const device = this.#device!,
      entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ];
    if (kind === 'surface' || kind === 'mesh')
      entries.push({ binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } });
    if (kind === 'volume')
      entries.push(
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      );
    const layout = device.createBindGroupLayout({ entries });
    const module = device.createShaderModule({
      code: {
        point: pointPickWGSL,
        rect: cellPickWGSL,
        surface: surfacePickWGSL,
        volume: volumePickWGSL,
        mesh: meshPickWGSL,
      }[kind],
      label: `sciviz pick ${kind}`,
    });
    const buffers: GPUVertexBufferLayout[] =
      kind === 'point' || kind === 'rect'
        ? [
            {
              arrayStride: kind === 'point' ? 12 : 16,
              stepMode: 'instance',
              attributes: [{ shaderLocation: 0, offset: 0, format: kind === 'point' ? 'float32x3' : 'float32x4' }],
            },
          ]
        : [];
    pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vertex', buffers },
      fragment: { module, entryPoint: 'fragment', targets: [{ format: 'rgba32uint' }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater-equal' },
    });
    this.#pipelines.set(kind, pipeline);
    return pipeline;
  }

  async #pick(
    x: number,
    y: number,
    radius: number,
    threshold: number,
    signal: AbortSignal,
  ): Promise<GpuPickResult | null> {
    const fig = this.#figure;
    await waitFor(fig.ready(), signal);
    signal.throwIfAborted();
    const device = fig.renderer.device!;
    this.#ensure(device);
    const canvas = (fig.engine as unknown as Engine).canvas;
    const width = canvas.clientWidth || canvas.width,
      height = canvas.clientHeight || canvas.height;
    const area = fig.plotArea;
    if (
      x < 0 ||
      y < 0 ||
      x >= width ||
      y >= height ||
      (fig.is2d && (x < area.x || x > area.x + area.width || y < area.y || y > area.y + area.height))
    )
      return null;
    const layers = fig.layers;
    for (const owner of this.#records.keys()) if (!layers.includes(owner)) this.invalidate(owner);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: this.#color!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      depthStencilAttachment: {
        view: this.#depth!.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
      },
    });
    const matrices = new Map<number, Float32Array>();
    for (let k = 0; k < layers.length; k++) {
      const layer = layers[k];
      if (!pickVisible(layer)) continue;
      const record = this.#record(layer);
      if (!record || !record.count) continue;
      const v = new Float32Array(80),
        u = new Uint32Array(v.buffer),
        matrix = new Float32Array(16);
      const volume = record.kind === 'volume' && 'classificationUniforms' in layer ? layer : undefined;
      multiplyMatrices(fig.engine.camera.matrix, volume ? volume.model : fig.model, matrix);
      const inverse = invertMatrix(matrix);
      if (!inverse) continue;
      matrices.set(k, matrix);
      v.set(matrix);
      v.set(inverse, 16);
      v.set([width, height, (x / width) * 2 - 1, 1 - (y / height) * 2], 32);
      v.set([radius, threshold, 1.5, 1], 36);
      u[44] = k + 1;
      if (record.kind === 'surface' && 'pickHeights' in layer) {
        u.set([layer.nx, layer.ny], 40);
        v.set(
          [
            layer.x[0],
            (layer.x[1] - layer.x[0]) / (layer.nx - 1),
            layer.y[0],
            (layer.y[1] - layer.y[0]) / (layer.ny - 1),
          ],
          48,
        );
      }
      if (record.kind === 'rect') v[76] = fig.is2d ? -0.5 : 0;
      const pipeline = this.#pipeline(record.kind),
        entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: record.uniform } }];
      if (record.kind === 'surface' && 'pickHeights' in layer)
        entries.push({ binding: 1, resource: { buffer: layer.pickHeights()! } });
      if (record.kind === 'mesh' && isMesh(layer)) {
        const geometry = layer.pickGeometry()!;
        record.count = geometry.count;
        v[76] = geometry.opacity;
        v[77] = geometry.scalarOpacity ? 1 : 0;
        entries.push({ binding: 1, resource: { buffer: geometry.buffer } });
      }
      if (volume) {
        const { data, transfer, sampler } = volume.resources(),
          c = volume.classificationUniforms();
        u.set([...volume.dims, volume.clip.length], 40);
        v[38] = volume.quality;
        v[39] = volume.density;
        v.set([...volume.range, c[0], c[1]], 52);
        volume.clip.forEach((p, j) => v.set([...p.normal, p.offset], 56 + j * 4));
        v.set([c[4], c[5], c[6], c[2]], 72);
        v[77] = c[3];
        if (
          !(volume.quality > 0) ||
          !Number.isFinite(volume.quality) ||
          !(volume.density >= 0) ||
          !Number.isFinite(volume.density)
        )
          throw rangeError('Use finite positive volume quality and nonnegative density before picking', 'sciviz');
        entries.push(
          { binding: 1, resource: data.createView({ dimension: '3d' }) },
          { binding: 2, resource: transfer.createView() },
          { binding: 3, resource: sampler },
        );
      }
      device.queue.writeBuffer(record.uniform, 0, v);
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      if (record.vertices) pass.setVertexBuffer(0, record.vertices);
      if (record.kind === 'point') pass.draw(3, record.count);
      else if (record.kind === 'rect') pass.draw(6, record.count);
      else pass.draw(record.kind === 'surface' ? record.count * 6 : record.kind === 'mesh' ? record.count : 3);
    }
    pass.end();
    encoder.copyTextureToBuffer({ texture: this.#color! }, { buffer: this.#read!, bytesPerRow: 256 }, [1, 1]);
    signal.throwIfAborted();
    device.queue.submit([encoder.finish()]);
    const read = this.#read!;
    // A mapping is always completed or cancelled before another pick reuses the buffer.
    const abort = () => read.unmap();
    signal.addEventListener('abort', abort, { once: true });
    try {
      await waitFor(read.mapAsync(GPUMapMode.READ), signal);
      signal.throwIfAborted();
      const id = new Uint32Array(read.getMappedRange()),
        f = new Float32Array(id.buffer, id.byteOffset, 4);
      if (!id[0]) return null;
      const layer = layers[id[0] - 1],
        index = id[1],
        depth = f[2],
        value = f[3];
      if (!fig.layers.includes(layer)) return null;
      const record = this.#records.get(layer);
      if (!record) return null;
      let position: number[];
      if (record.kind === 'point' && record.source)
        position = [record.source[index * 3], record.source[index * 3 + 1], record.source[index * 3 + 2]];
      else {
        const inv = invertMatrix(matrices.get(id[0] - 1)!)!,
          nx = (x / width) * 2 - 1,
          ny = 1 - (y / height) * 2;
        const w = inv[3] * nx + inv[7] * ny + inv[11] * depth + inv[15];
        position = [0, 1, 2].map((j) => (inv[j] * nx + inv[4 + j] * ny + inv[8 + j] * depth + inv[12 + j]) / w);
        if (record.kind === 'volume' && 'bounds' in layer)
          position = position.map((a, j) => layer.bounds[j * 2] + a * (layer.bounds[j * 2 + 1] - layer.bounds[j * 2]));
      }
      if (record.kind !== 'volume') position = position.map((a, j) => fig.axisScales[j].inverse(a));
      const dataValue = 'values' in layer ? layer.values?.[index] : undefined;
      const cellIndex = record.kind === 'mesh' && isMesh(layer) ? layer.pickGeometry()?.cells[index] : index;
      return {
        layer: layer as PickResult['layer'],
        index: cellIndex ?? index,
        x: position[0],
        y: position[1],
        z: position[2],
        value: record.kind === 'surface' || record.kind === 'volume' || record.kind === 'mesh' ? value : dataValue,
        depth,
        kind: record.kind === 'volume' ? 'volume' : record.kind === 'point' ? 'point' : 'cell',
      };
    } finally {
      signal.removeEventListener('abort', abort);
      read.unmap();
    }
  }

  /** Restores CPU hover, cancels pending requests and frees all owned resources. Borrowed layer data stays alive. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#hover?.();
    this.#lifetime.abort(fault('disposed', 'Create a new GpuPicking after disposal', 'sciviz'));
    this.#clear();
  }

  /** Same as dispose, for using. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
