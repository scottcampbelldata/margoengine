import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { VFX as VFXBase, type VFXOptions } from './base.js';
import { obstacles } from './obstacles.js';
import { wrap } from './wrap.js';
import { sort } from './sort.js';
import { textureFeature } from './texture.js';
import { curves } from './curves.js';
import { emitter } from './emitter.js';
import { soft } from './soft.js';
import { ribbons } from './ribbons.js';
import { mesh } from './mesh.js';
import { events } from './events.js';
import { lit } from './lit.js';
import { depthCollide } from './depth-collide.js';
import { stretch } from './stretch.js';
import { fields } from './fields.js';
import { skinned } from './skinned.js';
import { flipbook } from './flipbook.js';
export type {
  VFXOptions,
  VFXObstacle,
  VFXTexture,
  VFXCurves,
  VFXEmitter,
  ParticleAtlas,
  VFXFeatures,
  FogLike,
  VFXRibbons,
  VFXMeshParticles,
  VFXEvents,
  VFXLit,
  VFXLightSource,
  VFXDepthCollide,
  VFXStretch,
  VFXFields,
  VFXAttractor,
  VFXVectorField,
  VFXSkinned,
  VFXSkinnedPrimitive,
  VFXFlipbook,
} from './base.js';
const features = {
  obstacles,
  wrap,
  sort,
  texture: textureFeature,
  curves,
  emitter,
  soft,
  ribbons,
  mesh,
  events,
  lit,
  depthCollide,
  stretch,
  fields,
  skinned,
  flipbook,
};
/**
 * GPU particles with every optional feature (obstacles, wrap, sort, texture, curves, emitter, soft, ribbons, mesh, events, lit, depthCollide, stretch, fields, skinned, flipbook). Effects that use none of them load
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
