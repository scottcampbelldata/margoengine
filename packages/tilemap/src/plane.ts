/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type PassContext } from '@margoengine/core/extension';
import { rangeError } from '../../shared/errors.js';
import { ObjectTileMap, type ObjectTileMapOptions } from './objects.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;

/** An ordered map embedded in a 3D scene. The active core camera projects the plane. */
export interface PlaneTileMapOptions extends Omit<ObjectTileMapOptions, 'target' | 'clear'> {
  /** Column-major affine map-pixels-to-world transform. Default XY plane, 16 pixels/metre, map y points down. */
  transform?: ArrayLike<number>;
  /** Write scene depth for nonzero-alpha texels. Default true; false for blended transparent planes. */
  depthWrite?: boolean;
  /** Test against scene depth. Default true; false draws over scene geometry. */
  depthTest?: boolean;
}

/** Draw all map layers on one transformed plane with perspective-correct texels and shared scene depth. */
export class PlaneTileMap extends ObjectTileMap {
  /** Column-major affine map-pixels-to-world transform, read each frame. Mutable elements. */
  readonly transform: Float32Array<ArrayBuffer>;
  /** Read each frame. Default true. */
  depthWrite: boolean;
  /** Read each frame. Default true. */
  depthTest: boolean;
  private readonly projected = new Float32Array(16);
  constructor(options: PlaneTileMapOptions) {
    super({ ...options, snap: options.snap ?? false, parallax: options.parallax ?? false });
    const transform = options.transform ?? [1 / 16, 0, 0, 0, 0, -1 / 16, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if (transform.length !== 16) throw rangeError('Plane transform needs sixteen affine values', 'tilemap-options');
    this.transform = Float32Array.from(transform);
    this.depthWrite = options.depthWrite ?? true;
    this.depthTest = options.depthTest ?? true;
    this.checkTransform();
  }
  /** Create and attach a plane map to the engine. */
  static override attach(instance: EngineKernel, options: PlaneTileMapOptions): PlaneTileMap {
    const map = new PlaneTileMap(options);
    engineRuntime(instance).use(map);
    return map;
  }
  protected override projection(c: Context, _width: number, _height: number): Float32Array<ArrayBuffer> {
    this.checkTransform();
    const camera = c.camera.matrix,
      model = this.transform,
      out = this.projected;
    for (let column = 0; column < 4; column++)
      for (let row = 0; row < 4; row++) {
        const at = column * 4;
        out[at + row] =
          camera[row] * model[at] +
          camera[4 + row] * model[at + 1] +
          camera[8 + row] * model[at + 2] +
          camera[12 + row] * model[at + 3];
        if (column < 2) out[at + row] *= this.camera.zoom;
      }
    return out;
  }
  protected override bounds(): undefined {
    return undefined;
  }
  protected override depth(c: Context): {
    attachment: GPURenderPassDepthStencilAttachment;
    state: GPUDepthStencilState;
  } {
    const format = c.descriptor.depthStencil?.format;
    if (!format) throw rangeError('PlaneTileMap needs a scene depth attachment', 'tilemap-options');
    return {
      attachment: {
        view: c.depth,
        depthLoadOp: 'load',
        depthStoreOp: 'store',
        ...(format.includes('stencil') ? ({ stencilLoadOp: 'load', stencilStoreOp: 'store' } as const) : {}),
      },
      state: { format, depthCompare: this.depthTest ? 'greater-equal' : 'always', depthWriteEnabled: this.depthWrite },
    };
  }
  private checkTransform(): void {
    const m = this.transform;
    if (
      !m.every(Number.isFinite) ||
      m[3] !== 0 ||
      m[7] !== 0 ||
      m[11] !== 0 ||
      m[15] !== 1 ||
      !(Math.hypot(m[1] * m[6] - m[2] * m[5], m[2] * m[4] - m[0] * m[6], m[0] * m[5] - m[1] * m[4]) > 0)
    )
      throw rangeError('Invalid plane transform; use finite affine values and independent map axes', 'tilemap-options');
  }
}
