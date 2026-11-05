// The WebGPU side of BiomeWorld backends 'gpu' and 'auto' with a device: option and domain checks, row bands that fit
// the device, device loss, the per-tile CPU fallback of 'auto', and the kernels (exact region upsampling feeding the
// shared field loop, classification planes feeding the shared selection rules). A world loads this entry with import()
// only when it may compute on a device, so the root entry and the worker file hold none of it.
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { assemble, classified, wideNames } from './assemble.js';
import type { Classifier, ClassifyInput, ZoneClassifier } from './classify.js';
import type { TileFrame } from './fields.js';
import { divFloor } from './fixed.js';
import { classifyGPU } from './gpu-classify-inputs.js';
import { rectFieldsGPU } from './gpu-fields.js';
import { worldGPU } from './gpu-placement-flow-internal.js';
import type { RasterLayer } from './layers.js';

// The flow and placement kernels of a backend 'gpu' world: /hydrology and /placement load them through this entry by
// package name, so neither entry nor the worker file (which swaps this entry for an empty stub) holds GPU code.
export { hydrologyGPU } from './gpu-flow.js';
export { placeTileGPU } from './gpu-placement.js';

/** One request's revision of the world: every band of the request reads it, whatever updates come meanwhile. */
export interface GpuRequest {
  readonly frame: TileFrame;
  readonly classifier: Classifier;
  readonly kind: 'envelopes' | ZoneClassifier;
  /** Global cell of the first cell, and the rectangle in cells. */
  readonly gx: number;
  readonly gz: number;
  readonly width: number;
  readonly depth: number;
  readonly names: readonly string[];
  /** The classification grid over `wide` (fields of the band with a 1-cell margin) of `rows` rows from global row `gz`. */
  input(wide: ReadonlyMap<string, RasterLayer>, gz: number, rows: number): ClassifyInput;
}

/** What {@link GpuTiles.of} reads of the world options. */
export interface GpuOptions {
  readonly backend?: 'auto' | 'gpu' | 'cpu';
  readonly device?: GPUDevice;
  readonly workers?: number | false;
}

const deviceLoss = new WeakMap<GPUDevice, { controllers: Set<AbortController>; lost: boolean }>();
const lostError = () => fault('failed', 'BiomeWorld GPU device lost; recreate the WebGPU device', 'biomes');

/**
 * One world's device: the checks, bands, loss and fallback of its tiles. `BiomeWorld` makes and owns it; an app never
 * calls it (pass `backend` and `device` to `BiomeWorld.create` instead).
 */
export class GpuTiles {
  /** The caller-owned device; never destroyed here. */
  readonly device: GPUDevice;
  readonly #abort = new AbortController();
  readonly #cells: number;
  readonly #corners: readonly [number, number];
  /** Backend 'auto': what the device cannot do is made on the CPU, with the same bytes, instead of rejecting. */
  readonly #fallback: boolean;

  private constructor(device: GPUDevice, cells: number, corners: readonly [number, number], fallback: boolean) {
    this.device = device;
    this.#cells = cells;
    this.#corners = corners;
    this.#fallback = fallback;
  }

  /**
   * The device tiles of a world with these options, or undefined for the CPU. Backend 'gpu' needs a device and no
   * workers; backend 'auto' uses a GPUDevice when one is given and the world fits it, and the CPU otherwise. `size` is
   * in metres, `cells` the tile cells per side.
   * @throws TypeError for backend 'gpu' without a GPUDevice; RangeError for its workers or region axes.
   */
  static of(
    options: GpuOptions,
    size: readonly [number, number],
    regionResolution: number,
    cells: number,
  ): GpuTiles | undefined {
    const { backend = 'auto', device, workers } = options,
      gpu = backend === 'gpu',
      corners = size.map((v) => divFloor(v, regionResolution) + 1) as [number, number],
      miss = (error: Error): undefined => {
        if (gpu) throw error;
        return undefined;
      };
    if (backend === 'cpu') return undefined;
    if (
      !device ||
      typeof device !== 'object' ||
      typeof device.createBuffer !== 'function' ||
      typeof device.createShaderModule !== 'function' ||
      !device.queue ||
      typeof device.lost?.then !== 'function'
    )
      return miss(typeError("BiomeWorld backend 'gpu' requires the device option (a GPUDevice)", 'biomes'));
    if (workers && workers > 0)
      return miss(rangeError("BiomeWorld backend 'gpu' runs on this thread; pass workers: 0", 'biomes'));
    if (corners.some((v) => v > 32768))
      return miss(
        rangeError(
          "BiomeWorld backend 'gpu' allows at most 32768 region corners per axis; use a larger regionResolution or smaller size",
          'biomes',
        ),
      );
    return new GpuTiles(device, cells, corners, !gpu);
  }

  /**
   * Sends `world`'s object placement and `hydrologyOfAsync` to this device too, for backend 'gpu' only: 'auto' keeps
   * them on the CPU, since neither has a per-tile CPU fallback. They reject once the device is lost or the world is
   * disposed.
   */
  route(world: object): void {
    if (!this.#fallback) worldGPU.set(world, { device: this.device, signal: this.#abort.signal });
  }

  /** Starts watching for device loss (one reaction per device, shared by its worlds). */
  watch(): void {
    let state = deviceLoss.get(this.device);
    if (!state) {
      const loss = { controllers: new Set<AbortController>(), lost: false };
      deviceLoss.set(this.device, (state = loss));
      void this.device.lost.then(() => {
        loss.lost = true;
        for (const active of loss.controllers) active.abort(lostError());
        loss.controllers.clear();
      });
    }
    if (state.lost) this.#abort.abort(lostError());
    else state.controllers.add(this.#abort);
  }

  /** Throws the loss (or the disposal) once the device is lost; backend 'auto' goes on with the CPU instead. */
  live(): void {
    if (!this.#fallback) this.#abort.signal.throwIfAborted();
  }

  /**
   * Checks that tiles of this state fit the device: the bands of classifier `c`, and the region corner `height` (mm).
   * Backend 'auto' returns false instead of throwing (the world then makes its tiles on the CPU).
   * @throws RangeError that names the bound and the fix.
   */
  fits(c?: Classifier, kind: 'envelopes' | ZoneClassifier = 'envelopes', height?: ArrayLike<number>): boolean {
    try {
      if (c) this.#bandDepth(c, kind);
      for (let i = 0; height && i < height.length; i++)
        if (Math.abs(height[i]) > 1073741824)
          throw rangeError(
            "BiomeWorld backend 'gpu' heights must be within +/-1073741824 mm; rescale the height source or use backend 'cpu'",
            'biomes',
          );
      return true;
    } catch (error) {
      if (this.#fallback) return false;
      throw error;
    }
  }

  /** Largest tile band whose wide fields and classification planes fit the device. */
  #bandDepth(c: Classifier, kind: 'envelopes' | ZoneClassifier): number {
    const cells = this.#cells,
      limits = this.device.limits,
      limit = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
    if (5 * this.#corners[0] * this.#corners[1] * 4 > limit)
      throw rangeError(
        "BiomeWorld backend 'gpu' packed region exceeds device buffer limits; use a smaller size or larger regionResolution",
        'biomes',
      );
    const n = cells + 2,
      slots = c.inputs.length,
      planes = slots + (c.score ? 0 : c.ids.length),
      // divFloor(x, 0) is x: a classifier with no planes is not bounded by them.
      rows = Math.min(
        divFloor(limit, n * Math.max(24, 8 * planes)),
        divFloor(0x7fffffff, planes * n),
        limits.maxComputeWorkgroupsPerDimension * 8,
      ),
      depth = Math.min(cells, rows - 2),
      table = 4 * (2 * slots + c.ids.length + 1 + 4 * c.envelopes.slot.length);
    if (
      depth < 1 ||
      table > limit ||
      limits.maxBufferSize < 32 ||
      [Math.ceil(n / 8), slots, c.score ? 1 : c.ids.length].some((v) => v > limits.maxComputeWorkgroupsPerDimension) ||
      (kind !== 'envelopes' && !kind.perCell && depth < cells)
    )
      throw rangeError(
        "BiomeWorld backend 'gpu' tile row and margins exceed device limits, where a non-perCell zone scorer needs a full tile; use fewer biomes or classifier inputs, smaller tileSize, larger resolution, or backend 'cpu'",
        'biomes',
      );
    return depth;
  }

  /**
   * The layers of a request, in device bands joined row by row: fields and classification on the device, the shared
   * CPU tails in between. Disposal, device loss, the caller's cancellation and GPU failures reject; errors of shared
   * CPU callbacks keep their identity. `live` throws when the world is disposed. Backend 'auto' makes the request with
   * `cpu` (the same bytes) when the device fails on it or is lost; cancellation and disposal still reject.
   */
  async layers(
    r: GpuRequest,
    caller?: AbortSignal,
    live?: () => void,
    cpu?: () => Map<string, RasterLayer>,
  ): Promise<Map<string, RasterLayer>> {
    const fallback = this.#fallback && cpu,
      onCpu = () => {
        caller?.throwIfAborted();
        live?.();
        return cpu!();
      };
    if (fallback && this.#abort.signal.aborted) return onCpu();
    const signal = caller ? AbortSignal.any([caller, this.#abort.signal]) : this.#abort.signal,
      { frame, classifier: c, gx, width, depth, names } = r,
      device = this.device,
      check = () => {
        signal.throwIfAborted();
        live?.();
      },
      band = async (gz: number, rows: number) => {
        check();
        const fields = (x: number, z: number, w: number, d: number, wanted: readonly string[]) =>
          rectFieldsGPU(device, frame, x, z, w, d, wanted, { temporary: false, signal });
        if (!classified(names)) return fields(gx, gz, width, rows, names);
        // Classification blurs over a 1-cell margin: compute the fields one cell wider, classify, then crop.
        const wide = await fields(gx - 1, gz - 1, width + 2, rows + 2, wideNames(names, c)),
          ids = new Uint8Array(width * rows * 4),
          weights = new Uint8Array(width * rows * 4);
        check();
        await classifyGPU(device, c, r.input(wide, gz, rows), ids, weights, { signal });
        check();
        return assemble(names, wide, ids, weights, width, rows);
      };
    try {
      const step = this.#bandDepth(c, r.kind);
      if (depth <= step) {
        const layers = await band(r.gz, depth);
        check();
        return layers;
      }
      const layers = new Map<string, RasterLayer>();
      for (let row = 0; row < depth; row += step) {
        const part = await band(r.gz + row, Math.min(step, depth - row));
        check();
        for (const [name, layer] of part) {
          let out = layers.get(name);
          if (!out) {
            const Type = layer.data.constructor as new (length: number) => RasterLayer['data'];
            out = { ...layer, depth, data: new Type(divFloor(layer.data.length, layer.depth) * depth) };
            layers.set(name, out);
          }
          out.data.set(layer.data, divFloor(row * layer.data.length, layer.depth));
        }
      }
      check();
      return layers;
    } catch (error) {
      // Kernels wrap device errors (and the loss) as MargoError 'failed'; shared CPU callbacks keep their exceptions.
      const reason = signal.aborted ? signal.reason : error;
      if (fallback && reason?.name === 'MargoError' && reason.code === 'failed') return onCpu();
      throw reason;
    }
  }

  /** Stops watching the device and rejects work in flight with `reason`; the device itself stays the caller's. */
  dispose(reason?: unknown): void {
    deviceLoss.get(this.device)?.controllers.delete(this.#abort);
    if (reason !== undefined) this.#abort.abort(reason);
  }

  /** Lets `using tiles = ...` stop the watch at the end of a block. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
