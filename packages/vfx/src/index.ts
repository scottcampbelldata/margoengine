import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { VFX as VFXBase, type VFXOptions } from './base.js';
import { obstacles } from './obstacles.js';
import { wrap } from './wrap.js';
import { sort } from './sort.js';
import { textureFeature } from './texture.js';
export type { VFXOptions, VFXObstacle, VFXTexture, VFXFeatures } from './base.js';
const features = { obstacles, wrap, sort, texture: textureFeature };
/**
 * GPU particles with every optional feature (obstacles, wrap, sort, texture). Effects that use none of them load
 * less with `VFX` from `@margoengine/vfx/base`, adding only the feature entries they use.
 */
export class VFX extends VFXBase {
  constructor(options: VFXOptions = {}) {
    super(options, features);
  }
  static override attach(instance: EngineKernel, options: VFXOptions = {}): VFX {
    const effect = new VFX(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
}
