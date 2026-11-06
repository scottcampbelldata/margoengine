/// <reference lib="esnext.disposable" preserve="true" />
import type { GLTFPrimitive, GLTFMesh, GLTFNode, GLTFMaterial, GLTFTextureInfo } from '../../shared/gltf.js';
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
  type Mesh,
} from '@margoengine/core/extension';
import { invertMatrixStable, multiplyMatrices } from '@margoengine/math/mat4';
import { splitTRS } from '@margoengine/math/quat';
import { pipelineGroup } from './group.js';
import { viewMatrix } from '../../shared/view.js';
import { applyView, inView } from '../../shared/view-rect.js';
import { attenuationPower } from '../../shared/attenuation.js';
import { beginDraw, currentFrame, endDraw, recording, retire } from '../../shared/frame-resources.js';
import { acquireUniform, flushUniforms, type UniformSlot } from './uniform-arena.js';
import {
  deviceDraws,
  derivationLimit,
  drawGroup,
  objectId,
  sameFrame,
  sameLighting,
  structureFlags,
  type DeviceDraws,
  type DrawDerivation,
  type DrawFrame,
} from './draw-memo.js';
import { viewBinding, viewFloats, viewPipelines } from './view-uniform.js';
import {
  BatchInstances,
  BatchKind,
  BatchRows,
  batchKind,
  type BatchGroups,
  type BatchState,
  type RowsState,
} from './draw-batch.js';
import { rowsPerBinding, rowsShader } from './instanced-shader.js';
import { vertexInputs } from './vertex-inputs.js';
import { Cleanup } from '../../shared/cleanup.js';
import type { PBRSource } from '../../shared/pbr-source.js';
import { setMeshSource, clearMeshSource, type MeshSource } from '../../shared/mesh-source.js';
import { margoError } from '../../shared/errors.js';
import { shadowPrimitivesInto } from '../../shared/shadow-source.js';
import { primitiveAfterOpaque } from '../../shared/material-routing.js';
import { hiddenInTree } from '../../shared/visibility.js';
import { validatePreparedGeometry, checkPreparedVertices } from '../../shared/prepared-geometry.js';
import {
  GLTFAsset,
  checkDocument,
  container,
  loadAsset,
  closeImages,
  retainImages,
  entry,
  integer,
  overBudget,
  downloadLimit,
  decodeKTX2Images,
  type GLTFImage,
  type AssetOptions,
  type GLTFDecoderHooks,
  type GLTFExtendedMaterials,
} from './asset.js';
import { withMaterials } from './default-materials.js';
import {
  pbrShader,
  extendedPBRShader,
  physicalShader,
  factorPhysicalShader,
  transmissiveShader,
  transparentPBR,
  capturePBR,
  transmissionPBR,
  texturedTintPBR,
  surfaceTintPBR,
  compactTests,
  viewShader,
  type ExtendedPlan,
  type PBRLighting,
  type PBRTransparency,
  type PBRCapture,
  type PBRTransmission,
} from './shader.js';
import { lightPBR } from '../../shared/pbr-hooks.js';
export type { PBRLighting, PBRTransparency, PBRCapture, PBRTransmission, ExtendedPlan } from './shader.js';
import { createKTX2Texture, getBytesPerRow } from '@margoengine/decoders/texture';
import type { TranscodedKTX2Result } from '@margoengine/decoders';
import { generateMipmaps } from '../../shared/mipmaps.js';
import {
  prepareMaterialExtension,
  materialExtensionShader,
  materialExtensionSurface,
  materialExtensionAmbientShader,
  coatedAmbient,
  bindMaterialExtension,
  type MaterialExtension,
  type MaterialExtensionResource,
} from './material-extension.js';
import type { GLTFLoadOptions as CompressionOptions } from './compression.js';
import { hasDraco } from './draco-state.js';
import {
  textureCoordinates,
  coordinateExtension,
  coordinateShader,
  type CoordinateExtension,
} from './texture-coordinates.js';
import { deviceRenderer, type PBRDeviceRenderer, type PBRDeformationRenderer } from './replica.js';
import { backSideShader } from './side-shader.js';
import {
  validateRenderState,
  renderStateKey,
  pipelineDepthState,
  applyStencilReference,
  asymmetricStencilFaces,
} from './render-state.js';
export type { PBRDeviceRenderer, PBRDeformationRenderer } from './replica.js';
// Type only: PBRInstances and the EXT_mesh_gpu_instancing reader load with @margoengine/gltf-pro/instancing.
import type { PBRInstances } from './instancing.js';
import { packed, packPrimitive } from './pack.js';
import { buildStaticBatches, type StaticBatch } from './coalesce.js';
// Progressive sets this on the asset until real vertices and instances replace the placeholder boxes.
const deferStaticBatches = Symbol.for('margoengine.gltf-pro.defer-static-batches');
interface StaticBatchDeferral {
  commit?: () => void;
}
import { occlusionShader } from './occlusion.js';
import { sectionState, sectionShader } from '../../shared/section.js';
export { GLTFAsset, closeImages } from './asset.js';
export type { GLTFDocument } from './asset.js';
export type { GLTFImage, KTX2Image } from './asset.js';
export { textureCoordinates } from './texture-coordinates.js';
import type { TextureTransform } from './texture-coordinates.js';
export type { TextureTransform } from './texture-coordinates.js';

export type { MaterialExtension, MaterialExtensionTexture } from './material-extension.js';

/**
 * Mip pipelines per device and format. They are the same for every model, so they are made once: kept per model,
 * each of p-morph's 100 cloneModel copies compiled its own two (200 shader modules, a 300 ms first frame).
 */
const mipCaches = new WeakMap<GPUDevice, Map<unknown, unknown>>();
function mipPipelines(device: GPUDevice): Map<unknown, unknown> {
  let cache = mipCaches.get(device);
  if (!cache) mipCaches.set(device, (cache = new Map()));
  return cache;
}
declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  VERTEX: number;
  INDEX: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };
/** KHR_lights_punctual light on a scene node, as data. Intensity is candela (point, spot) or lux (directional); the light points down the node's -Z. */
export interface GLTFLight {
  node: Mesh;
  nodeIndex: number;
  type: 'directional' | 'point' | 'spot';
  color: number[];
  intensity: number;
  range?: number;
  innerConeAngle?: number;
  outerConeAngle?: number;
  name?: string;
}
/** glTF camera on a scene node, as data; the camera looks down the node's -Z. */
export interface GLTFCamera {
  node: Mesh;
  nodeIndex: number;
  type: 'perspective' | 'orthographic';
  perspective?: { yfov: number; znear: number; zfar?: number; aspectRatio?: number };
  orthographic?: { xmag: number; ymag: number; znear: number; zfar: number };
  name?: string;
}
/** One object of `PBRModel.lods`, read from a node's `MSFT_lod` extension. */
export interface GLTFLOD {
  /** The node that carries the extension: the finest level, and the object's place in the scene. */
  node: Mesh;
  /** Every level, finest first: `node`, then its `MSFT_lod` ids. All but the first start hidden. */
  levels: Mesh[];
  /**
   * The node's `extras.MSFT_screencoverage`, when it has them, decreasing: entry `i` is the screen coverage below which
   * level `i` gives way to the next. An extra last entry hides the object below it.
   */
  screenCoverage?: number[];
}
/** A node's glTF `extras` object (Blender: the object's custom properties, exported with Include > Custom Properties) and a copy of its world matrix (column-major, translation in 12-14). */
export interface GLTFNodeExtras {
  node: Mesh;
  nodeIndex: number;
  name: string;
  extras: Record<string, unknown>;
  matrix: Float32Array;
}
/** Point or spot light shaped for @margoengine/clustered `setLights`. */
export interface GLTFClusteredLight {
  position: [number, number, number];
  range: number;
  color: [number, number, number];
  intensity: number;
  direction?: [number, number, number];
  outerAngle?: number;
  innerAngle?: number;
}
/** What `applyGLTFLights` uses of @margoengine/clustered's `Clustered` (structural, so gltf-pro does not import it). */
export interface GLTFLightReceiver {
  setLights(lights: GLTFClusteredLight[]): unknown;
  add(model: PBRModel): () => void;
}
/**
 * Options of loadGLTF: asset limits and fetch options, plus the Draco, meshopt and KTX2 decoders and an AbortSignal.
 */
export type GLTFLoadOptions = Omit<AssetOptions, 'buffers'> & CompressionOptions;
const srgbMaps = [0, 4, 9, 12, 17],
  normalMaps = [2, 7],
  blended = (m: PBRMaterial) => m.settings[0] === 2 || (!!m.tint && !m.extension?.replacesPhysical),
  // Drawn after the opaque phase: blended, or its extension asks for the opaque capture (`afterOpaque`). A static
  // batch holds no such part (pose() checks every part), whatever its shared material says.
  late = (r: DrawResource) => blended(r.primitive.material) || (!r.batch && primitiveAfterOpaque(r.primitive));
// An extended material's binding plan, by material object (progressive loading swaps in copies with fewer maps) and
// features object (a materials mesh's record follows the Material it draws, whose features can change).
const plans = new WeakMap<object, ExtendedPlan & { from: object }>();
const planOf = (m: PBRMaterial, x: GLTFExtendedMaterials): ExtendedPlan => {
  let plan = plans.get(m);
  if (plan?.from !== m.extended) plans.set(m, (plan = { ...x.plan(m.maps, m.extended!), from: m.extended! }));
  return plan!;
};
// Map slot i of resource material m gets its own texture and sampler: base slots always; extension slots of extended
// materials only when bound, once per shared glTF texture.
const ownSlot = (m: PBRMaterial, i: number, x?: GLTFExtendedMaterials) => {
  if (!m.extended || i < 5) return true;
  const slots = planOf(m, x!).slots,
    j = slots[i];
  return j >= 0 && slots.indexOf(j) === i;
};
// What a transparency hook takes over: plain alpha blending (transmission tints and custom render state keep the sorted path).
const separable = (m: PBRMaterial) => m.settings[0] === 2 && !m.tint && !m.renderState,
  transmits = (m: PBRMaterial) => !!m.tint && !m.renderState && !m.extension?.replacesPhysical,
  /** A loaded material's tint draw reads the surface; a shading hook's material has its own tint. */
  surfaceTint = (m: PBRMaterial) => !!m.attenuation && !m.shading;
// Names the material + effects combination instead of an invalid pipeline when the shader declares more sampled textures or
// samplers than the device allows per stage (WebGPU's default and guaranteed minimum is 16 of each; README "Texture bindings").
// ponytail: counts declarations, not per-stage use, so a texture read only in the vertex stage still counts.
function checkLimits(device: GPUDevice, code: string, combination: () => string[]): void {
  for (const [kind, pattern, limit] of [
    ['sampled textures', /var\s*\w+\s*:\s*texture_(?!storage)/g, device.limits?.maxSampledTexturesPerShaderStage ?? 16],
    ['samplers', /var\s*\w+\s*:\s*sampler/g, device.limits?.maxSamplersPerShaderStage ?? 16],
  ] as const) {
    const count = code.match(pattern)?.length ?? 0;
    if (count > limit)
      throw new RangeError(
        `gltf-pro: ${combination().join(' + ')} needs ${count} ${kind} per shader stage; this device allows ${limit}`,
      );
  }
}
export type { GLTFDecoderHooks, GLTFCompressedImage, GLTFExtendedMaterials } from './asset.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; RENDER_ATTACHMENT: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** Narrow encoding hook for optional GPU deformation consumers. */
export type PBRDeformationContext = Pick<Context, 'backend' | 'device' | 'encoder'>;
/** The triangles of one node for picking: its vertices, indices, sidedness and world matrix. */
export interface PBRPickingGeometry {
  node: Mesh;
  vertices: Float32Array;
  indices: Uint32Array;
  doubleSided: boolean;
  side?: MaterialSide;
  matrix: Float32Array;
  /**
   * Index of the primitive in `model.primitives`, captured when the query started (before any GPU readback). Absent
   * for point and line primitives, which `model.primitives` does not list.
   */
  primitiveIndex?: number;
  /** glTF node index of the primitive, captured with `primitiveIndex`. Absent for a primitive with no glTF node. */
  nodeIndex?: number;
}
const opaquePasses = new WeakMap<Context, Set<PBRModel>>();
/** The derivation of this call or run for `m` with these primitive inputs, if one was derived (draw-memo.ts). */
function findDerivation(
  list: DrawDerivation[] | undefined,
  frame: DrawFrame,
  source: MaterialExtension | undefined,
  inst: object | undefined,
  topology: GPUPrimitiveTopology | undefined,
  sign: number,
): DrawDerivation | undefined {
  if (list)
    for (let i = 0; i < list.length; i++) {
      const value = list[i];
      if (
        value.frame === frame &&
        value.source === source &&
        value.instances === inst &&
        value.topology === topology &&
        value.sign === sign &&
        value.extension === undefined
      )
        return value;
    }
  return undefined;
}
/**
 * `findDerivation`, else a complete derivation from an earlier call or frame under an equal context whose record still
 * reports the same `shading.version` (draw-memo.ts): nothing it was derived from changed, so it serves `frame` as it is.
 */
function steadyDerivation(
  list: DrawDerivation[] | undefined,
  frame: DrawFrame,
  source: MaterialExtension | undefined,
  inst: object | undefined,
  topology: GPUPrimitiveTopology | undefined,
  sign: number,
  m: PBRMaterial,
): DrawDerivation | undefined {
  const found = findDerivation(list, frame, source, inst, topology, sign),
    shading = m.shading;
  if (found || !list || !shading || frame.lighting.length || source || m.extension) return found;
  const version = shading.version;
  if (version === undefined || version !== version) return undefined;
  for (let i = 0; i < list.length; i++) {
    const value = list[i];
    if (
      value.version === version &&
      value.complete &&
      value.shading === shading &&
      value.source === source &&
      value.instances === inst &&
      value.topology === topology &&
      value.sign === sign &&
      value.extension === undefined &&
      sameFrame(value.frame, frame)
    ) {
      value.frame = frame;
      return value;
    }
  }
  return undefined;
}
/** What a run's short path (`PBRModel.joinRun`) checked once for its pass context. */
interface QuickRun {
  c: Context;
  section: GPUBuffer | undefined;
  draws: DeviceDraws;
  /** A caller-owned opaque phase is open (`beginOpaquePass`): draws take the full path. */
  opaque: boolean;
  /** The run's view block matched the camera, lights and target since the last full draw. */
  viewChecked: boolean;
  /** The last derivation context, and the model inputs it was made for. */
  frame: DrawFrame | undefined;
  lighting: readonly LightingEffect[] | undefined;
  oit: object | undefined;
  hook: object | undefined;
  hooks: GLTFExtendedMaterials | undefined;
}
/** A run's last view block (see `PBRDrawRun.view`). */
interface RunView {
  data: Float32Array;
  format: GPUTextureFormat | undefined;
  at: GPUBufferBinding | undefined;
}
const noLighting: readonly LightingEffect[] = Object.freeze([]);
/** Transmission's tint group 2: `effect`'s entries for the `tint` pipeline's layout (kept from `d` while the same). */
function tintGroup(
  d: DrawDerivation | undefined,
  tint: GPURenderPipeline | undefined,
  mapped: boolean,
  effect: DrawDerivation['effect'],
  device: GPUDevice,
): DrawDerivation['tintEffect'] {
  if (!tint || !mapped || !effect) return undefined;
  const kept = d?.tintEffect;
  return kept && kept.entries === effect.entries && d!.tint === tint
    ? kept
    : {
        entries: effect.entries,
        group: pipelineGroup(device, tint, 2, effect.entries),
      };
}
/** A node matrix without an inverse (a zero scale) leaves the draw no normal matrix. */
function singular(): never {
  throw new RangeError('Singular PBR transform: give the mesh a nonzero scale on every axis');
}
const tintable = new Map<string, boolean>();
const count = (code: string, text: string): number => code.split(text).length - 1;
/**
 * True when finished shader `code` reads the base colour (`f.base`) and the interpolated vertex colour only as the
 * product `f.base*i.color`: then base colour b with tint 1 draws exactly as base 1 with the vertex colour times b, and
 * a batch may carry several materials' base colours as instance tints (`foldable`).
 */
function tintableCode(code: string): boolean {
  let value = tintable.get(code);
  if (value === undefined) {
    if (tintable.size >= 256) tintable.clear();
    const products = count(code, '*f.base*i.color');
    value =
      products > 0 &&
      count(code, 'f.base') === products &&
      count(code, 'i.color') === products + count(code, 'o.color=i.color');
    tintable.set(code, value);
  }
  return value;
}
/** Whether a finished shader reads the model rows only in the instanced vertex stage (see `derive`), by shader. */
const modelFreeCode = new Map<string, boolean>();
// Global, not per model: draws nest (a callback may draw), and one stack serves every model.
const scratchStack: DrawScratch[] = [];
let scratchDepth = 0;
/** True when view block `data` holds `camera`'s matrix and position and `lighting`'s rows (the view rows match too). */
function sameView(
  data: Float32Array,
  camera: Context['camera'],
  lighting: { direction: ArrayLike<number>; radiance: ArrayLike<number> },
): boolean {
  const matrix = camera.matrix,
    position = camera.position,
    direction = lighting.direction,
    radiance = lighting.radiance;
  for (let i = 0; i < 16; i++) if (data[i] !== Math.fround(matrix[i])) return false;
  for (let i = 0; i < 3; i++) if (data[32 + i] !== Math.fround(position[i])) return false;
  for (let i = 0; i < 4; i++)
    if (data[36 + i] !== Math.fround(direction[i]) || data[40 + i] !== Math.fround(radiance[i])) return false;
  return true;
}
/** Draws of a run gathered into one instanced draw (draw-batch.ts). */
interface PendingBatch {
  model: PBRModel;
  /** The first draw's resource: its buffers, groups and batch state serve the batch. */
  owner: DrawResource;
  d: DrawDerivation;
  c: Context;
  view: object;
  viewAt: GPUBufferBinding;
  members: DrawResource[];
  /** Each member's model. */
  models: PBRModel[];
  /** Each member's node, read for its matrix when the batch draws (not through its resource and primitive again). */
  nodes: Mesh[];
  /** Each member's derivation. */
  ds: DrawDerivation[];
  /** True once a member of another material record folded in (`foldable`): instance tints carry the base colours. */
  folded: boolean;
  /**
   * True once a member of another material record joined by its draw group (`DrawDerivation.group`): each instance
   * reads its own uniform block (`BatchKind.rows`).
   */
  rows: boolean;
  /** The run's blended-batch count when this batch began: an opaque draw joins only a batch begun after the last one. */
  fence: number;
}
/**
 * True when draws of derivation `b` may join a batch of derivation `a` (another material record) and draw exactly as
 * their own draws: the same context, pipeline inputs and uniform rows but for the base colour (76-79), which then goes
 * in the instance tint (the instanced vertex stage multiplies the vertex colour by it). Node rows (16-47) and the
 * determinant (97) are each draw's own. `drawBatch` checks the pipelines and group 2 bindings as it draws.
 */
function foldable(run: PBRDrawRun, a: DrawDerivation, b: DrawDerivation): boolean {
  let known = run.folds.get(a);
  const memo = known?.get(b);
  if (memo !== undefined) return memo;
  let result =
    a.frame === b.frame &&
    a.sign === b.sign &&
    a.topology === b.topology &&
    a.instances === b.instances &&
    a.source === b.source &&
    a.floatCount === b.floatCount &&
    a.compact === b.compact &&
    a.replacesTextures === b.replacesTextures &&
    a.extension === undefined &&
    b.extension === undefined &&
    !a.tinted &&
    !b.tinted &&
    a.blend === b.blend &&
    renderStateKey(a.state) === renderStateKey(b.state);
  const x = a.block,
    y = b.block;
  for (let i = 0; result && i < x.length; i++)
    if ((i < 16 || i >= 48) && (i < 76 || i >= 80) && i !== 97 && !Object.is(x[i], y[i])) result = false;
  if (!known) run.folds.set(a, (known = new Map()));
  known.set(b, result);
  return result;
}
/** True when two derivations' group 2 hold the same resources. */
function sameEffect(a: DrawDerivation['effect'], b: DrawDerivation['effect']): boolean {
  if (a === b) return true;
  if (!a || !b || a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i++) {
    const x = a.entries[i],
      y = b.entries[i],
      p = x.resource,
      q = y.resource;
    if (
      x.binding !== y.binding ||
      !(
        p === q ||
        ('buffer' in p && 'buffer' in q && p.buffer === q.buffer && p.offset === q.offset && p.size === q.size)
      )
    )
      return false;
  }
  return true;
}
/** True when `a` and `b` hold the same values. */
function sameValues(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
/**
 * True when draws of derivation `b` (another material record) may join a batch led by derivation `a` with each instance
 * reading its own uniform block (`BatchKind.rows`): the same draw group (pipeline and group 2 resources), context,
 * handedness and topology. `drawBatch` checks the rows variants as it draws (`rowsFit`).
 */
const rowsJoin = (a: DrawDerivation, b: DrawDerivation): boolean =>
  b.group !== undefined &&
  a.group === b.group &&
  a.frame === b.frame &&
  a.sign === b.sign &&
  a.topology === b.topology &&
  a.blend === b.blend;
/** Adds `r`'s draw to its batch in `run` (a new one when none matches), in first-draw order (draw-batch.ts). */
function joinBatch(
  run: PBRDrawRun,
  model: PBRModel,
  r: DrawResource,
  d: DrawDerivation,
  c: Context,
  viewAt: GPUBufferBinding,
): void {
  const view = c.view ?? c,
    p = r.primitive;
  if (d.blend) {
    // Blended draws keep their order: one joins only the batch drawn last, of its own derivation, one it folds into, or
    // one of its draw group.
    const last = run.pending[run.pending.length - 1];
    if (
      last?.d.blend &&
      last.view === view &&
      last.viewAt === viewAt &&
      last.owner.primitive.vertices === p.vertices &&
      last.owner.primitive.indices === p.indices
    ) {
      const fold = last.d === d || (!last.rows && foldable(run, last.d, d));
      if (fold || rowsJoin(last.d, d)) {
        if (last.d !== d) {
          last.folded = true;
          if (!fold) last.rows = true;
        }
        push(last, model, r, d);
        return;
      }
    }
    run.fence++;
    const batch = newBatch(run, model, r, d, c, view, viewAt);
    run.pending.push(batch);
    push(batch, model, r, d);
    return;
  }
  // Most draws join the batch the previous draw of their derivation joined in this run (kept on the derivation: a map
  // lookup per draw cost more than the rest of the join).
  let batch = d.joinedRun === run ? (d.joined as PendingBatch | undefined) : undefined;
  if (
    batch &&
    batch.fence === run.fence &&
    batch.view === view &&
    batch.viewAt === viewAt &&
    batch.owner.primitive.vertices === p.vertices &&
    batch.owner.primitive.indices === p.indices
  ) {
    push(batch, model, r, d);
    return;
  }
  // Else a batch of its derivation, or of its draw group (other material records, each instance reading its own rows).
  batch = undefined;
  const key = d.group ?? d;
  let list = run.batches.get(key);
  if (list)
    for (let i = 0; i < list.length; i++) {
      const value = list[i],
        q = value.owner.primitive;
      if (
        value.fence === run.fence &&
        value.view === view &&
        value.viewAt === viewAt &&
        q.vertices === p.vertices &&
        q.indices === p.indices &&
        (value.d === d || rowsJoin(value.d, d))
      ) {
        batch = value;
        if (value.d !== d) batch.rows = batch.folded = true;
        break;
      }
    }
  if (!batch) {
    batch = newBatch(run, model, r, d, c, view, viewAt);
    if (!list) run.batches.set(key, (list = []));
    list.push(batch);
    run.pending.push(batch);
  }
  d.joined = batch;
  d.joinedRun = run;
  push(batch, model, r, d);
}
/** Adds member `r` (of `model`, derivation `d`) to `batch`. */
function push(batch: PendingBatch, model: PBRModel, r: DrawResource, d: DrawDerivation): void {
  batch.members.push(r);
  batch.models.push(model);
  batch.nodes.push(r.primitive.node);
  batch.ds.push(d);
}
/** A batch record for `r`'s draw: the run's spare one (kept with its member arrays, so a steady frame allocates none). */
function newBatch(
  run: PBRDrawRun,
  model: PBRModel,
  r: DrawResource,
  d: DrawDerivation,
  c: Context,
  view: object,
  viewAt: GPUBufferBinding,
): PendingBatch {
  const batch = run.spare.pop();
  if (!batch)
    return {
      model,
      owner: r,
      d,
      c,
      view,
      viewAt,
      members: [],
      models: [],
      nodes: [],
      ds: [],
      folded: false,
      rows: false,
      fence: run.fence,
    };
  batch.model = model;
  batch.owner = r;
  batch.d = d;
  batch.c = c;
  batch.view = view;
  batch.viewAt = viewAt;
  batch.folded = batch.rows = false;
  batch.fence = run.fence;
  return batch;
}
/** Draws `run`'s pending batches into its pass, in first-draw order. */
function flushBatches(run: PBRDrawRun): void {
  const pending = run.pending;
  if (!pending.length) return;
  try {
    for (let i = 0; i < pending.length; i++) {
      const batch = pending[i];
      if (!batch.model.disposed) batch.model.drawBatch(batch, run);
    }
  } finally {
    for (let i = 0; i < pending.length; i++) {
      const batch = pending[i],
        ds = batch.ds;
      // Every member's derivation may point at the batch (`joinBatch`): a spare record must not take their draws.
      for (let k = 0; k < ds.length; k++) if (ds[k].joined === batch) ds[k].joined = ds[k].joinedRun = undefined;
      batch.members.length = batch.models.length = batch.nodes.length = ds.length = 0;
      batch.model = batch.c = batch.view = batch.viewAt = batch.owner = batch.d = undefined!;
      run.spare.push(batch);
    }
    pending.length = 0;
    for (const list of run.batches.values()) list.length = 0;
    run.batches.clear();
  }
}
/**
 * True when `r` can join an instanced batch of its run: a draw of the node's triangles or (wireframe) their edges
 * without its own instances, deformation, extension or transmission tint, an invertible node, and no texture of its own
 * in group 1 (the batch binds the first draw's group 1, so only default or replaced textures, which every such draw
 * holds alike). Blended draws batch only with the draws next to them in order (`joinBatch`).
 */
function batchable(d: DrawDerivation, r: DrawResource, det: number): boolean {
  const p = r.primitive;
  return (
    !p.instances &&
    !p.deformed &&
    !p.topology &&
    !r.batch &&
    !r.mergedInto &&
    !d.tinted &&
    d.extension === undefined &&
    det !== 0 &&
    Number.isFinite(det) &&
    (d.replacesTextures || !p.material.maps.some(Boolean))
  );
}
/** What a pass has bound: draws on it set a pipeline, group or buffer only when it differs. */
interface PassBindings {
  pass: GPURenderPassEncoder | undefined;
  pipeline?: GPURenderPipeline;
  groups: (GPUBindGroup | undefined)[];
  vertex?: GPUBuffer;
  vertexOffset?: number;
  instances?: GPUBuffer;
  index?: GPUBuffer;
}
function resetBindings(bound: PassBindings, pass: GPURenderPassEncoder | undefined): void {
  bound.pass = pass;
  bound.pipeline = bound.vertex = bound.instances = bound.index = undefined;
  bound.groups.fill(undefined);
}
function setPipeline(bound: PassBindings, pipeline: GPURenderPipeline): void {
  if (bound.pipeline !== pipeline) bound.pass!.setPipeline((bound.pipeline = pipeline));
}
function setGroup(bound: PassBindings, index: number, group: GPUBindGroup): void {
  if (bound.groups[index] !== group) bound.pass!.setBindGroup(index, (bound.groups[index] = group));
}
function setBuffers(
  bound: PassBindings,
  vertex: GPUBuffer,
  instances: GPUBuffer | undefined,
  index: GPUBuffer,
  offset = 0,
): void {
  const pass = bound.pass!;
  // No offset argument at a buffer's start: the call stays the one it always was.
  if (bound.vertex !== vertex || bound.vertexOffset !== offset)
    pass.setVertexBuffer(0, (bound.vertex = vertex), (bound.vertexOffset = offset) || undefined);
  if (instances && bound.instances !== instances) pass.setVertexBuffer(1, (bound.instances = instances));
  if (bound.index !== index) pass.setIndexBuffer((bound.index = index), 'uint32');
}
/**
 * The draw context of one `draw()` call: the run's equal one when the run has it (so draws of different models share
 * derivations), else a new one.
 */
function drawFrame(
  run: PBRDrawRun | undefined,
  mode: string,
  depthCompare: GPUCompareFunction | undefined,
  c: Context,
  section: GPUBuffer | undefined,
  oit: object | undefined,
  hook: object | undefined,
  hooks: GLTFExtendedMaterials | false | undefined,
  lighting: readonly LightingEffect[],
): DrawFrame {
  // The run's last context, when this call's inputs are the same objects (the common case: one context, no lighting).
  const last = run?.lastFrame;
  if (
    last &&
    last.lighting === lighting &&
    run!.lastContext === c &&
    run!.lastDescriptor === c.descriptor &&
    last.mode === mode &&
    last.depthCompare === depthCompare &&
    last.format === c.format &&
    last.section === section &&
    last.oit === oit &&
    last.hook === hook &&
    last.hooks === (hooks || undefined) &&
    last.samples === c.descriptor.multisample?.count &&
    last.depthFormat === c.descriptor.depthStencil!.format
  )
    return last;
  const frame = matchFrame(run, mode, depthCompare, c, section, oit, hook, hooks, lighting);
  if (run) {
    run.lastFrame = frame;
    run.lastContext = c;
    run.lastDescriptor = c.descriptor;
  }
  return frame;
}
function matchFrame(
  run: PBRDrawRun | undefined,
  mode: string,
  depthCompare: GPUCompareFunction | undefined,
  c: Context,
  section: GPUBuffer | undefined,
  oit: object | undefined,
  hook: object | undefined,
  hooks: GLTFExtendedMaterials | false | undefined,
  lighting: readonly LightingEffect[],
): DrawFrame {
  const samples = c.descriptor.multisample?.count,
    depthFormat = c.descriptor.depthStencil!.format,
    extended = hooks || undefined;
  if (run)
    for (let i = 0; i < run.frames.length; i++) {
      const frame = run.frames[i];
      if (
        frame.mode === mode &&
        frame.depthCompare === depthCompare &&
        frame.format === c.format &&
        frame.samples === samples &&
        frame.depthFormat === depthFormat &&
        frame.section === section &&
        frame.oit === oit &&
        frame.hook === hook &&
        frame.hooks === extended &&
        sameLighting(frame.lighting, lighting)
      )
        return frame;
    }
  const frame: DrawFrame = {
    mode,
    depthCompare,
    format: c.format,
    samples,
    depthFormat,
    section,
    oit,
    hook,
    hooks: extended,
    lighting,
  };
  if (run && run.frames.length < 16) run.frames.push(frame);
  return frame;
}
/**
 * A run of `PBRModel.draw` calls that share one render pass and one uniform upload (pass it as the last argument of
 * each `draw`, then call `end()`). Without a run every draw begins and ends its own pass and uploads its own uniforms.
 */
export class PBRDrawRun {
  /** The pass the run's draws continue, once one began; `end()` closes it. */
  pass?: GPURenderPassEncoder;
  /** @internal The draw contexts of the run's draws (draw-memo.ts); draws under an equal one share derivations. */
  readonly frames: DrawFrame[] = [];
  /** @internal The last of them, and the pass context and descriptor it was matched for. */
  lastFrame?: DrawFrame;
  lastContext?: Context;
  lastDescriptor?: unknown;
  /** @internal What the run's draws bound on `pass`, so they set only what changes. */
  readonly bindings: PassBindings = { pass: undefined, groups: [undefined, undefined, undefined, undefined] };
  /** @internal The device the run's draws record on; `end()` uploads their uniform changes there. */
  device?: GPUDevice;
  /** @internal The view block the run's draws bound last and the camera, lights and target it holds. */
  readonly view: RunView = { data: new Float32Array(viewFloats), format: undefined, at: undefined };
  /** @internal Draws waiting to draw as instanced batches (draw-batch.ts), in first-draw order, and by derivation. */
  readonly pending: PendingBatch[] = [];
  /** @internal Drawn batch records, emptied, for the run's next batches. */
  readonly spare: PendingBatch[] = [];
  readonly batches = new Map<object, PendingBatch[]>();
  /** @internal Blended batches begun so far (`PendingBatch.fence`), and which derivations fold together this frame. */
  fence = 0;
  readonly folds = new Map<DrawDerivation, Map<DrawDerivation, boolean>>();
  /** @internal What `draw` checked once for the run's context: its section binding and device caches. */
  private quick?: QuickRun;
  /** @internal The run's context with its section binding and device caches, for draws that join batches. */
  quickFor(c: Context): QuickRun {
    let quick = this.quick;
    if (quick?.c !== c)
      this.quick = quick = {
        c,
        section: sectionState(c)?.buffer,
        draws: deviceDraws(c.device),
        opaque: !!opaquePasses.get(c),
        viewChecked: false,
        frame: undefined,
        lighting: undefined,
        oit: undefined,
        hook: undefined,
        hooks: undefined,
      };
    return quick;
  }
  /**
   * Ends the shared pass and uploads the draws' uniform changes. Safe to call twice; the run can then carry the next
   * frame's draws (nothing derived for this frame carries over).
   */
  end(): void {
    const pass = this.pass;
    try {
      flushBatches(this);
    } finally {
      this.pass = undefined;
      this.frames.length = 0;
      this.lastFrame = this.lastContext = this.lastDescriptor = undefined;
      this.pending.length = 0;
      this.batches.clear();
      this.folds.clear();
      this.view.at = this.view.format = undefined;
      this.quick = undefined;
      resetBindings(this.bindings, undefined);
      try {
        pass?.end();
      } finally {
        if (this.device) flushUniforms(this.device);
      }
    }
  }
}
/**
 * The models drawing through one frame graph, in segments: models whose passes were added one right after another
 * (nothing else added or removed in the graph in between), so their passes sit next to each other in its order.
 */
interface ModelGraph {
  /** The graph revision just after the last model's pass was added. */
  revision: number;
  segment: PBRModel[];
  segments: WeakMap<PBRModel, PBRModel[]>;
  run: PBRDrawRun;
}
const modelGraphs = new WeakMap<FrameGraph, ModelGraph>();
const modelGraph = (): ModelGraph => ({ revision: -1, segment: [], segments: new WeakMap(), run: new PBRDrawRun() });
// A symbol keeps separately bundled optional consumers interoperable without
// importing the loader or attaching a second drawable core Geometry.
const cpuSource = Symbol.for('margoengine.pbr-source.v1');
/** Which faces a material draws: 'front', 'back' or 'double'. */
export type MaterialSide = 'front' | 'back' | 'double';
const sideOf = (m: PBRMaterial): MaterialSide =>
  m.side ?? (m.settings[2] === 2 ? 'back' : m.settings[2] >= 0.5 ? 'double' : 'front');
const sideFlag = (side: MaterialSide): number => (side === 'double' ? 1 : side === 'back' ? 2 : 0);
/**
 * What composes a compact material's shader and pipeline beyond `structureFlags`, for a record with no shading hook or
 * extension: a normal map on UV1 and a wireframe draw. -1 when a map has a KHR_texture_transform, whose coordinate
 * extension is per resource and composes each frame.
 */
function plainShape(m: PBRMaterial, v: Float32Array, wireframe: unknown): number {
  const { maps } = m;
  for (let i = 0; i < maps.length; i++) if (maps[i]?.extensions?.KHR_texture_transform !== undefined) return -1;
  return +(!!maps[2] && v[94] === 1) + +!!wireframe * 2;
}
/**
 * A glTF PBR material as the model draws it: base colour, factors, emission, settings, side and optional extension.
 */
export interface PBRMaterial extends GLTFMaterial {
  base: number[];
  factors: number[];
  emission: number[];
  settings: number[];
  /** Live triangle face selection. Legacy structural materials may supply only settings[2]. */
  side?: MaterialSide;
  /** Draw each triangle's three edges as one-pixel lines (default false), read live. Picking retains triangles. */
  wireframe?: boolean;
  maps: (GLTFTextureInfo | undefined)[];
  uvt?: number[];
  ext?: number[];
  /** KHR_materials_dispersion strength, finite and non-negative (default 0); read live each draw. */
  dispersion?: number;
  physical?: number[];
  extended?: Omit<ExtendedPlan, 'slots'>;
  tint?: number[];
  /** Volume attenuation at the thickness factor, for a tint draw that reads the rest from the surface (surfaceTintPBR). */
  attenuation?: number[];
  volume?: number[];
  renderState?: PBRRenderState;
  extension?: MaterialExtension;
  /** Per-material surface shader and bindings, composed before model-wide lighting effects. */
  shading?: PBRMaterialShading;
  /**
   * Vertex displacement the shading applies (`@margoengine/materials` displacementMap), for shadow casters to apply
   * too: the materials feature uniform, the map's view and its sampler (shared/displacement.js `displacedDepth`).
   */
  displacement?: { readonly buffer: GPUBuffer; readonly view: GPUTextureView; readonly sampler: GPUSampler };
  /**
   * Clipping planes the shading applies (`@margoengine/materials` clippingPlanes with clipShadows), for shadow casters
   * to clip too: a uniform of up to 6 world planes in the scene `section` binding's layout (plane count in settings.x).
   */
  clip?: GPUBufferBinding;
  /** The same planes for passes that follow the surface and not its shadow: picking and TAA velocity. */
  surfaceClip?: GPUBufferBinding;
  /**
   * The cut-out a material draws from its own maps (`@margoengine/materials` map and alphaMap with alphaTest), for shadow
   * casters to cut alike in place of `maps[0]`: the map's view and sampler, its UV set and affine rows, and an opacity map
   * if any (the materials feature uniform, its view and sampler). Absent for anything uncut, which draws as ever.
   */
  castMask?: {
    readonly view: GPUTextureView;
    readonly sampler: GPUSampler;
    readonly texCoord: 0 | 1;
    readonly transform: Float32Array;
    readonly opacity?: { readonly buffer: GPUBuffer; readonly view: GPUTextureView; readonly sampler: GPUSampler };
  };
  /** The same mask for picking, which a blended material's holes also pass through. Absent draws as ever. */
  pickMask?: PBRMaterial['castMask'];
  /** False when the material's colour pass reads white for vertex colours (`@margoengine/materials` `vertexColors`). */
  vertexAlpha?: boolean;
  /** Use the retained UV-transform frame layout for constructed optional materials. */
  extendedFrame?: boolean;
}
/** One drawn glTF primitive: its node, CPU vertices and indices, source definition, material and morph weights. */
export interface PBRPrimitive {
  node: Mesh;
  nodeIndex: number;
  vertices: Float32Array;
  indices: Uint32Array;
  definition: GLTFPrimitive;
  material: PBRMaterial;
  weights: Float32Array;
  targetNames: string[];
  /** Overrides the material's shared extension when supplied. Attach after loading. */
  extension?: MaterialExtension;
  /**
   * The current deformed (skinned or morphed) vertices, written each frame by a deformer such as `@margoengine/animation`;
   * the primitive's 80-byte vertices start `deformedOffset` bytes into it. Unset: draw the bind-pose `buffers.vertex`.
   */
  deformed?: GPUBuffer;
  /**
   * Byte offset of this primitive's first vertex in `deformed`, a multiple of 256 (a storage-binding offset). Default 0.
   * Deformers that pack many primitives into one buffer set it; read `vertices.byteLength` bytes from there.
   */
  deformedOffset?: number;
  /** Draw once per instance (node space) in one instanced draw, see `PBRInstances` (@margoengine/gltf-pro/instancing); set for EXT_mesh_gpu_instancing nodes when `decoders.instancing` is passed. */
  instances?: PBRInstances;
  /** The 80-byte-stride vertex and uint32 index buffers while the model is set up on a device (for picking and outlines). */
  buffers?: { vertex: GPUBuffer; index: GPUBuffer };
  /** Set for glTF POINTS (`point-list`) and LINES, LINE_LOOP, LINE_STRIP (`line-list`, as index pairs); absent for triangles. */
  topology?: 'point-list' | 'line-list';
}
/** Packed geometry: 20 floats per vertex and uint32 indices; `topology` as on PBRPrimitive (absent: a triangle list). */
export interface PreparedGeometry {
  vertices: Float32Array;
  indices: Uint32Array;
  topology?: 'point-list' | 'line-list';
}
/**
 * Optional beauty-pass pipeline overrides, set as `primitive.material.renderState` (shared by every primitive using
 * that material). Unset fields keep gltf-pro's defaults; `blend: null` turns blending off. The state is part of the
 * pipeline cache key, so treat it as fixed (replace the object to change it). G-buffer and ambient passes ignore it.
 */
export interface PBRRenderState {
  blend?: GPUBlendState | null;
  depthWrite?: boolean;
  depthCompare?: GPUCompareFunction;
  /** Native WebGPU polygon bias, applied before the reverse-Z depth test. Ignored for points and lines. */
  depthBias?: number;
  depthBiasSlopeScale?: number;
  depthBiasClamp?: number;
  /** Native preserves literal WebGPU bias. Away makes positive bias recede in reverse-Z and forward-Z device views. */
  depthBiasMode?: 'native' | 'away';
  /** Native raster front/back faces, including reflected winding, as defined by WebGPU. */
  stencilFront?: GPUStencilFaceState;
  stencilBack?: GPUStencilFaceState;
  stencilReadMask?: number;
  stencilWriteMask?: number;
  /** Live per-draw reference; changing only this value preserves the pipeline. */
  stencilReference?: number;
  /** False disables color writes while depth and stencil still run. */
  colorWrite?: boolean;
}
export { validatePreparedGeometry };
function preparedPrimitive(
  asset: GLTFAsset,
  p: GLTFPrimitive,
  data: PreparedGeometry,
  node: Mesh,
  nodeIndex: number,
  materials: PBRMaterial[],
  checked: Set<PreparedGeometry>,
): PBRPrimitive {
  if (!checked.has(data)) {
    validatePreparedGeometry(data);
    checked.add(data);
  }
  const { vertices, indices } = data;
  if ((p.mode ?? 4) !== 4 || p.targets || p.extensions) throw new TypeError('Prepared PBR requires static triangles');
  const m = p.material === undefined ? material() : materials[integer(p.material, 'material')];
  if (!m) throw new TypeError('Missing prepared PBR material; this is a loader bug, report it with the file');
  for (const map of m.maps)
    if (map) {
      if (integer(map.texCoord ?? 0, 'texture coordinate') > 1) throw new RangeError('Invalid prepared PBR UV set');
      entry(asset.doc.textures, map.index, 'texture');
    }
  return {
    node,
    nodeIndex,
    vertices,
    indices,
    definition: p,
    material: m,
    weights: new Float32Array(0),
    targetNames: [],
  };
}
interface DrawResource {
  primitive: PBRPrimitive;
  device: GPUDevice;
  vertex: GPUBuffer;
  index: GPUBuffer;
  wireframe?: { index: GPUBuffer; count: number };
  /** This draw's uniform block: a window of the device's uniform arena (`uniform-arena.ts`). */
  uniform: UniformSlot;
  volume?: GPUBuffer;
  /** Float32 copy of `material.volume`, reused so a transmission draw does not allocate. */
  volumeData?: Float32Array;
  /** Buffer that `volumeData` was last written to. A new buffer uploads again. */
  volumeWritten?: GPUBuffer;
  values: Float32Array;
  groups: Map<GPURenderPipeline, DrawGroups>;
  /**
   * Group 0 for another view block or a copy of `uniform` (a draw repeated with other values in a frame), by uniform
   * buffer, view block and pipeline; cleared with `groups`.
   */
  copies?: Map<GPUBuffer, Map<GPUBufferBinding | undefined, Map<GPURenderPipeline, GPUBindGroup>>>;
  sectionBuffer?: GPUBuffer;
  views: GPUTextureView[];
  samplers: GPUSampler[];
  replacesTextures?: boolean;
  extension?: MaterialExtensionResource;
  coordinates?: CoordinateExtension;
  /** Set on a static part while its material batch can replace it. */
  mergedInto?: DrawResource;
  /** Set on the one resource that draws a material batch. */
  batch?: StaticBatch;
  /** Set once `writeGeometry` rewrote this primitive: shadows then redraw it every frame instead of caching it. */
  edited?: boolean;
  /** Instanced batches this resource leads (draw-batch.ts), by derivation and view. */
  batchStates?: Map<DrawDerivation, BatchState[]>;
  /** Rows batches this resource leads (`BatchKind.rows`), by rows-variant derivation and view. */
  rowStates?: Map<DrawDerivation, RowsState[]>;
  /** The node matrix this draw's normal rows were last derived for, then those rows (see `PBRModel.nodeRows`). */
  nodeCache?: Float32Array;
}
interface ShadowCasterRecord {
  primitive: PBRPrimitive;
  node: Mesh;
  vertex: GPUBuffer;
  /** Byte offset and size of the primitive's vertices in `vertex` (a deformer's shared buffer). */
  vertexOffset: number;
  vertexSize: number;
  index: GPUBuffer;
  count: number;
  /** Absent for triangles; line-list when the material draws triangle edges. */
  topology?: 'line-list';
  stride: number;
  alphaTexture: GPUTextureView;
  alphaSampler: GPUSampler;
  alpha: number;
  cutoff: number;
  texCoord: 0 | 1;
  alphaTransform?: Float32Array;
  instances?: PBRInstances;
  displacement?: PBRMaterial['displacement'];
  opacity?: NonNullable<PBRMaterial['castMask']>['opacity'];
  /** False keeps vertex alpha out of the cut-out, as the colour pass does. Set only on a primitive that cuts. */
  vertexAlpha?: boolean;
  clip?: GPUBufferBinding;
  surfaceClip?: GPUBufferBinding;
  dynamic: boolean;
}
// Keep the original triangle buffer for queries and exports. Duplicate shared
// edges deliberately: transparent triangle wireframes blend each edge twice.
/**
 * The line-list indices of triangle list `triangles`' edges, each edge once, in first-seen order. An edge two triangles
 * share was listed twice (a b, b c, c a per triangle): a closed mesh drew every line twice, twice the vertex and line
 * work for the same picture.
 */
function wireframeEdges(triangles: ArrayLike<number>): Uint32Array {
  const out = new Uint32Array(triangles.length * 2),
    seen = new Set<number | string>();
  let vertices = 0;
  for (let i = 0; i < triangles.length; i++) if (triangles[i] >= vertices) vertices = triangles[i] + 1;
  // A number key while lo * vertices + hi stays exact (2^53), else a string.
  const exact = vertices <= 2 ** 26;
  let j = 0;
  const edge = (a: number, b: number) => {
    const lo = a < b ? a : b,
      hi = a < b ? b : a,
      key = exact ? lo * vertices + hi : lo + ',' + hi;
    if (seen.has(key)) return;
    seen.add(key);
    out[j++] = a;
    out[j++] = b;
  };
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const a = triangles[i],
      b = triangles[i + 1],
      c = triangles[i + 2];
    edge(a, b);
    edge(b, c);
    edge(c, a);
  }
  return out.slice(0, j);
}
function wireframeIndices(r: DrawResource): DrawResource['wireframe'] {
  const p = r.primitive,
    flag = p.material.wireframe;
  if (flag !== undefined && typeof flag !== 'boolean')
    throw new TypeError('PBR material wireframe must be a boolean; set wireframe to true or false');
  if (!flag || p.topology) return;
  if (r.wireframe) return r.wireframe;
  if (p.indices.byteLength * 2 > r.device.limits.maxBufferSize)
    throw new RangeError('PBR wireframe buffer exceeds the device limit; split the geometry into smaller meshes');
  const indices = wireframeEdges(p.indices),
    size = Math.max(4, indices.byteLength);
  const index = r.device.createBuffer({ size, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  try {
    r.device.queue.writeBuffer(index, 0, indices);
  } catch (error) {
    index.destroy();
    throw error;
  }
  return (r.wireframe = { index, count: indices.length });
}
/** The level nodes of a node's `MSFT_lod`; none without the extension. */
function lodIds(def: GLTFNode, id: number, count: number): number[] {
  const lod = (def?.extensions as { MSFT_lod?: { ids?: unknown } } | undefined)?.MSFT_lod;
  if (lod === undefined) return [];
  const ids = lod?.ids;
  if (
    !Array.isArray(ids) ||
    ids.some((level) => !Number.isInteger(level) || level < 0 || level >= count || level === id)
  )
    throw new TypeError(`glTF node ${id} MSFT_lod ids must be other nodes of the file; re-export it`);
  return ids;
}
function fillShadow(r: DrawResource, value: ShadowCasterRecord): void {
  const p = r.primitive,
    m = p.material,
    wireframe = wireframeIndices(r),
    coordinates = m.maps[0] ? textureCoordinates(m.maps[0]) : undefined;
  value.primitive = p;
  value.node = p.node;
  value.vertex = p.deformed ?? r.vertex;
  value.vertexOffset = p.deformed ? (p.deformedOffset ?? 0) : 0;
  value.vertexSize = p.vertices.byteLength;
  value.index = wireframe?.index ?? r.index;
  value.count = wireframe?.count ?? p.indices.length;
  if (wireframe) value.topology = 'line-list';
  else delete value.topology;
  value.stride = 80;
  const mask = m.castMask;
  value.alphaTexture = mask ? mask.view : r.views[0];
  value.alphaSampler = mask ? mask.sampler : r.samplers[0];
  value.alpha = m.base[3];
  value.cutoff = m.settings[0] === 1 ? m.settings[1] : 0;
  value.texCoord = mask ? mask.texCoord : m.maps[0] ? textureCoordinates(m.maps[0]).texCoord : 0;
  if (mask) value.alphaTransform = mask.transform;
  else if (m.maps[0]?.extensions?.KHR_texture_transform) value.alphaTransform = coordinates?.transform;
  else delete value.alphaTransform;
  const opacity = mask?.opacity;
  if (opacity) value.opacity = opacity;
  else delete value.opacity;
  if (m.vertexAlpha === false && value.cutoff > 0) value.vertexAlpha = false;
  else delete value.vertexAlpha;
  value.instances = p.instances;
  const displacement = m.displacement,
    clip = m.clip;
  if (displacement) value.displacement = displacement;
  else delete value.displacement;
  if (clip) value.clip = clip;
  else delete value.clip;
  const surfaceClip = m.surfaceClip;
  if (surfaceClip) value.surfaceClip = surfaceClip;
  else delete value.surfaceClip;
  // ponytail: edited geometry stays a dynamic caster after its first write; add a geometry revision to the shadow
  // still-hash if edited static levels need the cached atlas back. Displaced casters redraw too (live scale and bias).
  value.dynamic =
    !r.batch &&
    (!!r.edited ||
      !!displacement ||
      !!opacity ||
      !!clip ||
      p.definition.attributes?.JOINTS_0 !== undefined ||
      !!p.definition.targets?.length ||
      !!p.instances ||
      !!p.deformed);
}
// Remember the complete existing pipeline key per draw mode. The shader and
// every mutable state field are still read each draw, but unchanged materials
// need not build the same chain of temporary strings for every primitive.
// Keep cold descriptor callbacks outside draw's per-primitive lexical scope.
// Otherwise their captured material/resource locals require a fresh context
// even when every pipeline and bind group is already cached.
function checkDrawLimits(
  device: GPUDevice,
  code: string,
  m: PBRMaterial,
  transmission: boolean,
  lighting: Set<LightingEffect>,
): void {
  checkLimits(device, code, () => [
    m.extended ? 'extended material' : m.physical ? 'physical material' : 'material',
    ...(transmission ? ['transmission'] : []),
    ...[...lighting].flatMap((effect) => {
      const value = effect as { name?: string; shadow?: { name?: string } };
      return [value.name ?? 'shader patch', ...(value.shadow?.name ? [value.shadow.name] : [])];
    }),
  ]);
}
/** A draw's groups 0 and 1 for one pipeline; `view` is the view block group 0 binds. */
type DrawGroups = GPUBindGroup[] & { view?: GPUBufferBinding };
// Group 0: the draw's uniform (its arena slot, or a copy for a repeat draw), volume, section and view block.
function frameGroup(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  r: DrawResource,
  transmission: boolean,
  section: GPUBuffer | undefined,
  view: GPUBufferBinding | undefined,
  uniform: GPUBufferBinding = r.uniform.binding,
): GPUBindGroup {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: uniform },
      ...(view && viewPipelines.has(pipeline) ? [{ binding: 3, resource: view }] : []),
      ...(transmission
        ? [
            {
              binding: 1,
              resource: {
                buffer: (r.volume ??= device.createBuffer({
                  size: 16,
                  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                })),
              },
            },
          ]
        : []),
      ...(section ? [{ binding: 2, resource: { buffer: section } }] : []),
    ],
  });
}
/**
 * Group 0 of a batch draw of `pipeline` with uniform binding `uniform` and view block `view`, cached in `groups`. The view
 * block is part of the key: a batch state serves other views too (a view made anew each frame takes a free state, and
 * views with the same rows share one), and each must bind its own camera.
 */
function batchGroup(
  groups: BatchGroups,
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  r: DrawResource,
  section: GPUBuffer | undefined,
  view: GPUBufferBinding,
  uniform: GPUBufferBinding,
): GPUBindGroup {
  let byUniform = groups.get(pipeline);
  if (!byUniform) groups.set(pipeline, (byUniform = new Map()));
  let byView = byUniform.get(uniform);
  if (!byView) byUniform.set(uniform, (byView = new Map()));
  let group = byView.get(view);
  if (!group) byView.set(view, (group = frameGroup(device, pipeline, r, false, section, view, uniform)));
  return group;
}
// Group 0 for a uniform copy or another view block, cached so steady multi-view frames create no groups.
function copyGroup(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  r: DrawResource,
  transmission: boolean,
  section: GPUBuffer | undefined,
  uniform: GPUBufferBinding,
  view: GPUBufferBinding | undefined,
): GPUBindGroup {
  let byView = (r.copies ??= new Map()).get(uniform.buffer);
  if (!byView) r.copies.set(uniform.buffer, (byView = new Map()));
  let byPipeline = byView.get(view);
  if (!byPipeline) byView.set(view, (byPipeline = new Map()));
  let group = byPipeline.get(pipeline);
  if (!group) byPipeline.set(pipeline, (group = frameGroup(device, pipeline, r, transmission, section, view, uniform)));
  return group;
}
function createDrawGroups(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  r: DrawResource,
  m: PBRMaterial,
  transmission: boolean,
  hooks: GLTFExtendedMaterials | undefined,
  section: GPUBuffer | undefined,
  view: GPUBufferBinding | undefined,
): DrawGroups {
  const groups: DrawGroups = [
    frameGroup(device, pipeline, r, transmission, section, view),
    textureGroup(device, pipeline, r, m, hooks),
  ];
  groups.view = view;
  return groups;
}
/** Group 1 of a draw of `pipeline`: `r`'s material textures and samplers. */
function textureGroup(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  r: DrawResource,
  m: PBRMaterial,
  hooks: GLTFExtendedMaterials | undefined,
): GPUBindGroup {
  return pipelineGroup(
    device,
    pipeline,
    1,
    r.views.flatMap((view, i) => {
      const binding = i < 5 || !m.extended ? i * 2 : 10 + planOf(m, hooks!).slots[i] * 2;
      return view && (!(r.primitive.extension ?? m.extension)?.replacesPhysical || i < 5)
        ? [
            { binding, resource: view },
            { binding: binding + 1, resource: r.samplers[i] },
          ]
        : [];
    }),
  );
}
interface DrawScratch {
  context?: Context;
  /** Set by `PBRModel.compile`: derivations stop at the pipeline and compile it here, by key, off the frame. */
  compiling?: Map<string, Promise<unknown>>;
  /** A batch's member matrices, tints (folded batches) and uniform values (draw-batch.ts). */
  matrices: ArrayLike<number>[];
  tints: ArrayLike<number>[];
  /** A rows batch's member uniform blocks and their derivations' versions (draw-batch.ts `BatchRows`). */
  blocks: Float32Array[];
  versions: number[];
  /** The material records a folded batch's check (`PBRModel.folds`) has seen. */
  checked: Set<PBRMaterial>;
  batchValues: Float32Array;
  /** This call's view block (view-uniform.ts). */
  viewData: Float32Array;
  /** What this call bound on its pass (a call without a run). */
  bound: PassBindings;
  /** This invocation's camera: a nested draw (probe face, second view) may change the context's camera meanwhile. */
  projection: Float32Array;
  view: Float32Array;
  eye: Float32Array;
  resources: DrawResource[];
  effects: LightingEffect[];
  entries: GPUBindGroupEntry[];
  color: GPURenderPassColorAttachment;
  depth: GPURenderPassDepthStencilAttachment;
  descriptor: GPURenderPassDescriptor;
  compare: (a: DrawResource, b: DrawResource) => number;
  code: string;
  ambient: boolean;
  effectCount: number;
  liveBatches: Map<StaticBatch, boolean>;
  blendDistance: Map<DrawResource, number>;
}
/** Begins the render pass of `draw`, which stays open for the draws after it. */
function openPass(c: Context, scratch: DrawScratch, color: GPUTextureView, depth: GPUTextureView, closing: unknown) {
  const stencil = c.descriptor.depthStencil!.format.includes('stencil'),
    target = scratch.depth,
    attachment = scratch.color;
  attachment.view = color;
  target.view = depth;
  if (attachment.resolveTarget) attachment.resolveTarget = undefined;
  attachment.loadOp = target.depthLoadOp = 'load';
  attachment.storeOp = target.depthStoreOp = 'store';
  target.stencilLoadOp = stencil ? 'load' : undefined;
  target.stencilStoreOp = stencil ? 'store' : undefined;
  // A run in the graph's last pass is one render pass and resolves the frame; a queue draws its blends in a later one.
  c.attach?.(attachment, target, !!closing && !opaquePasses.get(c));
  return c.encoder.beginRenderPass(scratch.descriptor);
}
function createDrawScratch(color: GPUTextureView, depth: GPUTextureView): DrawScratch {
  const attachment: GPURenderPassColorAttachment = { view: color, loadOp: 'load', storeOp: 'store' };
  const depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: depth,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
  };
  const scratch: DrawScratch = {
    matrices: [],
    tints: [],
    blocks: [],
    versions: [],
    checked: new Set(),
    batchValues: new Float32Array(0),
    viewData: new Float32Array(viewFloats),
    bound: { pass: undefined, groups: [undefined, undefined, undefined, undefined] },
    projection: new Float32Array(16),
    view: new Float32Array(16),
    eye: new Float32Array(3),
    resources: [],
    effects: [],
    entries: [],
    color: attachment,
    depth: depthAttachment,
    code: '',
    ambient: false,
    effectCount: 0,
    liveBatches: new Map(),
    blendDistance: new Map(),
    descriptor: { colorAttachments: [attachment], depthStencilAttachment: depthAttachment },
    compare(a, b) {
      const blendA = late(a),
        blendB = late(b);
      if (blendA !== blendB) return +blendA - +blendB;
      if (!blendA) return 0;
      const distances = scratch.blendDistance;
      return distances.get(b)! - distances.get(a)!;
    },
  };
  return scratch;
}
function patchDrawLighting(this: DrawScratch, effect: LightingEffect): void {
  if (effect.pbr) {
    const hooks = effect.pbr(2);
    if (hooks) {
      this.code = lightPBR(this.code, hooks);
      this.ambient ||= !!hooks.ambient;
    }
  } else this.code = effect.shader!(this.code, 2);
}
function snapshotDrawLighting(this: DrawScratch, effect: LightingEffect): void {
  this.effects[this.effectCount++] = effect;
}
/** A lighting or shading effect for `addLighting`: `pbr` hooks (lighting; preferred) or a `shader` text patch (materials, LOD baking). */
export interface LightingEffect {
  readonly owner?: Engine;
  pbr?(group: number): PBRLighting | undefined;
  shader?(source: string, group: number): string;
  bindings(): GPUBindGroupEntry[];
}
/** Per-material shader that may replace native textures and supply a texture-dependent transmission tint. */
export interface PBRMaterialShading extends LightingEffect {
  readonly replacesTextures?: boolean;
  readonly texturedTint?: boolean;
  /**
   * Rewrites the shader once the model's lighting effects are composed in (`shader` runs before them): Lambert and Phong
   * materials give clustered lights their own BRDF there. Return `code` itself to leave it unchanged.
   */
  lit?(code: string): string;
  /**
   * A number that stays the same while `shader()` and `lit()` would return the same text for the same input code;
   * undefined or NaN when that is not known. While it, the record's structure and the draw context stay the same, a
   * draw keeps last frame's shader and pipeline instead of composing them again (with no lighting effects on the
   * model); the uniform rows are read and `bindings()` runs every frame as before.
   */
  readonly shaderRevision?: number;
  /**
   * A number that changes whenever anything the record, `shader()`, `lit()` or `bindings()` reads changes; undefined
   * or NaN when that is not known. While it stays the same (and so does the draw context, with no lighting effects on
   * the model), a draw reuses last frame's derivation whole: its uniform rows, shader, pipeline and group 2, without
   * reading the record or calling `bindings()` again (draw-memo.ts).
   */
  readonly version?: number;
}
function uploadCompressedImage(
  device: GPUDevice,
  image: Exclude<GLTFImage, ImageBitmap | undefined | import('./asset.js').KTX2Image>,
  srgb: boolean,
): GPUTexture {
  const formats: Record<string, TranscodedKTX2Result['target']> = {
    'rgba8unorm': 'rgba8',
    'bc7-rgba-unorm': 'bc7',
    'astc-4x4-unorm': 'astc-4x4',
    'etc2-rgba8unorm': 'etc2',
  };
  const base = image.format.replace(/-srgb$/, ''),
    target = formats[base];
  if (!target)
    throw new TypeError(
      'Unsupported KTX2 texture format ' + image.format + '; transcode to a format the device supports',
    );
  const format = (base + (srgb ? '-srgb' : '')) as GPUTextureFormat;
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    !image.mipmaps.length ||
    image.mipmaps.length > Math.floor(Math.log2(Math.max(image.width, image.height))) + 1
  )
    throw new RangeError(
      'Invalid compressed image dimensions; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  const block = target === 'rgba8' ? 1 : 4;
  const mipmaps = image.mipmaps.map((m, level) => {
    const width = Math.max(1, image.width >> level),
      height = Math.max(1, image.height >> level),
      byteLength = getBytesPerRow(format, width) * Math.ceil(height / block);
    if (m.width !== width || m.height !== height || !(m.data instanceof Uint8Array) || m.data.byteLength !== byteLength)
      throw new RangeError(
        'Invalid compressed image mip; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
      );
    return { ...m, byteLength };
  });
  return createKTX2Texture(device, { ...image, format, target, srgb, hasAlpha: true, mipmaps });
}
let modelId = 0;
const vector = (value: unknown, size: number, label: string, min = -Infinity, max = Infinity): number[] => {
  if (
    !Array.isArray(value) ||
    value.length !== size ||
    value.some((v) => typeof v !== 'number' || !Number.isFinite(Math.fround(v)) || v < min || v > max)
  )
    throw new TypeError('Invalid glTF ' + label + '; re-export the file and check it with the glTF Validator');
  return value;
};
const scalar = (v: unknown, min: number, max: number, label: string) => vector([v], 1, label, min, max)[0];
/** UV offset, scale and rotation (radians), with KHR_texture_transform semantics: uv' = offset * rotation * scale * uv. */
/** One map's two uniform rows (offset*rotation*scale) as gltf-pro's shader reads them; the first row's w holds the UV set. */
export function textureTransform(x: TextureTransform = {}, texCoord = 0): number[] {
  const [ox, oy] = vector(x.offset ?? [0, 0], 2, 'texture offset'),
    [sx, sy] = vector(x.scale ?? [1, 1], 2, 'texture scale'),
    r = scalar(x.rotation ?? 0, -Infinity, Infinity, 'texture rotation'),
    c = Math.cos(r),
    s = Math.sin(r);
  return [c * sx, s * sy, ox, texCoord, -s * sx, c * sy, oy, 0];
}
// `extended`: decoders.materials (@margoengine/gltf-pro/extended), which reads iridescence, anisotropy and diffuse
// transmission; without it they are ignored, as glTF allows for an optional extension.
function material(def: GLTFMaterial = {}, extended?: GLTFExtendedMaterials): PBRMaterial {
  const p = def.pbrMetallicRoughness ?? {},
    alpha = def.alphaMode ?? 'OPAQUE',
    // Imported physical lobes are optional: the newest default leaves their metadata for MaterialInstallation.
    e = extended
      ? (def.extensions ?? {})
      : {
          KHR_materials_unlit: def.extensions?.KHR_materials_unlit,
          KHR_materials_emissive_strength: def.extensions?.KHR_materials_emissive_strength,
        };
  if (!['OPAQUE', 'MASK', 'BLEND'].includes(alpha))
    throw new TypeError(
      'Invalid glTF alpha mode; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  if (def.doubleSided !== undefined && typeof def.doubleSided !== 'boolean')
    throw new TypeError(
      'Invalid glTF doubleSided; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  const cc = e.KHR_materials_clearcoat,
    tr = e.KHR_materials_transmission,
    sh = e.KHR_materials_sheen,
    sp = e.KHR_materials_specular,
    vo = e.KHR_materials_volume,
    dispersion = def.extensions?.KHR_materials_dispersion?.dispersion;
  const base = vector(p.baseColorFactor ?? [1, 1, 1, 1], 4, 'base color', 0, 1),
    transmission = scalar(tr?.transmissionFactor ?? 0, 0, 1, 'transmission'),
    strength = scalar(e.KHR_materials_emissive_strength?.emissiveStrength ?? 1, 0, Infinity, 'emissive strength');
  const attenuation = vector(vo?.attenuationColor ?? [1, 1, 1], 3, 'attenuation color', 0, 1),
    thickness = scalar(vo?.thicknessFactor ?? 0, 0, Infinity, 'thickness'),
    distance =
      vo?.attenuationDistance === undefined
        ? Infinity
        : scalar(vo.attenuationDistance, Number.MIN_VALUE, Infinity, 'attenuation distance'),
    depth = thickness / distance;
  // Extended materials: thin film, anisotropy or diffuse transmission in use (factor > 0); maps 13-17 and three more uniform rows.
  const x = extended?.parse(e),
    physical = !!(x || cc || tr || sh || sp || vo || e.KHR_materials_ior || e.KHR_materials_dispersion);
  const maps = [
    p.baseColorTexture,
    p.metallicRoughnessTexture,
    def.normalTexture,
    def.occlusionTexture,
    def.emissiveTexture,
    ...(physical
      ? [
          cc?.clearcoatTexture,
          cc?.clearcoatRoughnessTexture,
          cc?.clearcoatNormalTexture,
          tr?.transmissionTexture,
          sh?.sheenColorTexture,
          sh?.sheenRoughnessTexture,
          sp?.specularTexture,
          sp?.specularColorTexture,
        ]
      : []),
    ...(x ? x.maps : []),
  ].map((t) =>
    t?.extensions?.KHR_texture_transform === undefined ? t : { ...t, texCoord: textureCoordinates(t).texCoord },
  );
  return {
    ...def,
    base,
    factors: [
      scalar(p.roughnessFactor ?? 1, 0, 1, 'roughness'),
      scalar(p.metallicFactor ?? 1, 0, 1, 'metallic'),
      scalar(def.normalTexture?.scale ?? 1, -Infinity, Infinity, 'normal scale'),
      scalar(def.occlusionTexture?.strength ?? 1, 0, 1, 'occlusion strength'),
    ],
    emission: vector(def.emissiveFactor ?? [0, 0, 0], 3, 'emissive', 0, 1).map((v) => v * strength),
    settings: [
      ['OPAQUE', 'MASK', 'BLEND'].indexOf(alpha),
      scalar(def.alphaCutoff ?? 0.5, 0, Infinity, 'alpha cutoff'),
      +(def.doubleSided ?? false),
      0,
    ],
    get side(): MaterialSide {
      return this.settings[2] === 2 ? 'back' : this.settings[2] >= 0.5 ? 'double' : 'front';
    },
    set side(value: MaterialSide) {
      if (!['front', 'back', 'double'].includes(value))
        throw new TypeError('Invalid material side; use front, back or double');
      this.settings[2] = sideFlag(value);
    },
    maps,
    // KHR_texture_transform per map as two rows of offset*rotation*scale; the first row's w holds the UV set.
    uvt: maps.flatMap((t) =>
      textureTransform((t?.extensions?.KHR_texture_transform ?? {}) as TextureTransform, t?.texCoord ?? 0),
    ),
    ext: [+!!e.KHR_materials_unlit, scalar(e.KHR_materials_ior?.ior ?? 1.5, 0, Infinity, 'ior'), 0, 0],
    dispersion: scalar(dispersion === undefined ? 0 : dispersion, 0, Infinity, 'dispersion'),
    physical: physical
      ? [
          scalar(cc?.clearcoatFactor ?? 0, 0, 1, 'clearcoat'),
          scalar(cc?.clearcoatRoughnessFactor ?? 0, 0, 1, 'clearcoat roughness'),
          scalar(cc?.clearcoatNormalTexture?.scale ?? 1, -Infinity, Infinity, 'clearcoat normal scale'),
          transmission,
          ...vector(sp?.specularColorFactor ?? [1, 1, 1], 3, 'specular color', 0),
          scalar(sp?.specularFactor ?? 1, 0, 1, 'specular'),
          ...vector(sh?.sheenColorFactor ?? [0, 0, 0], 3, 'sheen color', 0, 1),
          scalar(sh?.sheenRoughnessFactor ?? 0, 0, 1, 'sheen roughness'),
          ...(x ? x.rows : []),
        ]
      : undefined,
    extended: x?.features,
    // Transmission blends the background by this per-material tint (base color, Beer-Lambert volume attenuation at thicknessFactor).
    tint: transmission
      ? base.slice(0, 3).map((v, i) => v * transmission * attenuationPower(attenuation[i], depth))
      : undefined,
    attenuation: transmission ? attenuation.map((c) => attenuationPower(c, depth)) : undefined,
    // Transmission hook only: thickness (mesh space) and transmittance per world unit, attenuationColor^(1/attenuationDistance).
    volume: transmission ? [thickness, ...attenuation.map((c) => attenuationPower(c, 1 / distance))] : undefined,
  };
}
/** Main-thread packings per asset and primitive definition, kept as long as the asset is. */
const assetPacks = new WeakMap<GLTFAsset, WeakMap<object, PreparedGeometry>>();
/**
 * Vertex and index GPU buffers by device, asset and CPU array, counted by the models holding them: models of one asset
 * (cloneModel copies) share its packed arrays and baked static batches, so they upload each array once. A model writes
 * a counted buffer in place only while no other model holds it (writeGeometry gives it its own otherwise), and the last
 * one to let go retires it. Models of different assets never share buffers, even for one array.
 */
interface SharedBuffer {
  buffer: GPUBuffer;
  data: object;
  usage: number;
  users: number;
  map: WeakMap<object, SharedBuffer>;
}
interface SharedTexture {
  texture: GPUTexture;
  key: string;
  users: number;
  map: Map<string, SharedTexture>;
}
const sharedBuffers = new WeakMap<GPUDevice, WeakMap<GLTFAsset, WeakMap<object, SharedBuffer>>>(),
  // Textures per device, decoded image and format: models holding one image (cloneModel copies) upload and mip it
  // once. The 1 x 1 stand-in maps are held by the asset instead, per slot.
  sharedTextures = new WeakMap<GPUDevice, WeakMap<object, Map<string, SharedTexture>>>(),
  textureShares = new WeakMap<GPUTexture, SharedTexture>(),
  bufferShares = new WeakMap<GPUBuffer, SharedBuffer>(),
  // A material map's default view per texture and its sampler per device and state: both immutable, so every slot,
  // primitive and model shares them (each was a native call per map slot of every primitive of every model).
  textureViews = new WeakMap<GPUTexture, GPUTextureView>(),
  deviceSamplers = new WeakMap<GPUDevice, Map<string, GPUSampler>>();
/**
 * Whether a model may write `buffer` in place: no other model counts on it. Its array's entry is forgotten then, so a
 * later copy of the old array uploads that array instead of reading the new contents.
 */
function ownBuffer(buffer: GPUBuffer): boolean {
  const share = bufferShares.get(buffer);
  if (!share) return true;
  if (share.users > 1) return false;
  forget(share);
  return true;
}
function forget(share: SharedBuffer): void {
  bufferShares.delete(share.buffer);
  if (share.map.get(share.data) === share) share.map.delete(share.data);
}
/** Lets go of a vertex or index buffer: retires it unless another model still counts on it. */
function dropBuffer(device: GPUDevice, buffer: GPUBuffer): void {
  const share = bufferShares.get(buffer);
  if (share && --share.users > 0) return;
  if (share) forget(share);
  retire(device, buffer);
}
/** The map of textures made from `holder` on `device`. */
function texturesOf(device: GPUDevice, holder: object): Map<string, SharedTexture> {
  let holders = sharedTextures.get(device);
  if (!holders) sharedTextures.set(device, (holders = new WeakMap()));
  let map = holders.get(holder);
  if (!map) holders.set(holder, (map = new Map()));
  return map;
}
/** Lets go of a material texture: retires it unless another model still counts on it. */
function dropTexture(device: GPUDevice, texture: GPUTexture): void {
  const share = textureShares.get(texture);
  if (share && --share.users > 0) return;
  if (share) {
    textureShares.delete(texture);
    share.map.delete(share.key);
  }
  retire(device, texture);
}
function primitive(
  asset: GLTFAsset,
  p: GLTFPrimitive,
  node: Mesh,
  nodeIndex: number,
  mesh: GLTFMesh,
  materials: PBRMaterial[],
  packs: Map<object, PreparedGeometry>,
): PBRPrimitive {
  // Packing depends only on the primitive definition, so nodes sharing a mesh share its arrays (and GPU buffers, keyed by array).
  // Models of one asset (cloneModel copies) share the arrays too: packing is a pure function of the definition.
  let shared = assetPacks.get(asset);
  if (!shared) assetPacks.set(asset, (shared = new WeakMap()));
  let g = packed.get(p) ?? packs.get(p) ?? shared.get(p);
  if (!g) {
    g = packPrimitive(asset, p);
    shared.set(p, g);
  }
  packs.set(p, g);
  const { vertices, indices } = g;
  const m = fit(
    asset,
    p,
    p.material === undefined ? material() : materials[integer(p.material, 'material')],
    !!g.topology,
  );
  const targets = p.targets ?? [];
  if (!Array.isArray(targets))
    throw new TypeError(
      'Invalid morph targets; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  const weights = vector(
    asset.doc.nodes![nodeIndex].weights ?? mesh.weights ?? Array(targets.length).fill(0),
    targets.length,
    'morph weights',
  );
  const made: PBRPrimitive = {
    node,
    nodeIndex,
    vertices,
    indices,
    definition: p,
    material: m,
    weights: Float32Array.from(weights),
    targetNames: targets.map(
      (_: unknown, i: number) =>
        (mesh.extras as { targetNames?: string[] } | null | undefined)?.targetNames?.[i] ?? 'Target ' + i,
    ),
  };
  if (g.topology) made.topology = g.topology;
  return made;
}
// Material `m` as primitive `p` draws it: every map must name a texture and a UV set the primitive has. glTF 2.0 3.9.2:
// points and lines without NORMAL are rendered without lighting (here: the base colour, as KHR_materials_unlit).
function fit(asset: GLTFAsset, p: GLTFPrimitive, m: PBRMaterial, pointsOrLines: boolean): PBRMaterial {
  if (!m)
    throw new TypeError(
      'Missing glTF material; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
    );
  const a = p.attributes ?? {};
  for (const map of m.maps)
    if (map) {
      const set = integer(map.texCoord ?? 0, 'texture coordinate');
      if (set > 1 || a[set === 0 ? 'TEXCOORD_0' : 'TEXCOORD_1'] === undefined)
        throw margoError(
          'failed',
          'Material requires available TEXCOORD_0 or TEXCOORD_1; add the attribute or remove the texture',
        );
      entry(asset.doc.textures, map.index, 'texture');
    }
  return pointsOrLines && a.NORMAL === undefined
    ? Object.defineProperty({ ...m, ext: [1, ...m.ext!.slice(1)] }, 'side', Object.getOwnPropertyDescriptor(m, 'side')!)
    : m;
}
function transform(node: Mesh, def: GLTFNode): void {
  if (def.matrix !== undefined) {
    const m = vector(def.matrix, 16, 'matrix');
    if (def.translation || def.rotation || def.scale || m[3] || m[7] || m[11] || m[15] !== 1)
      throw new TypeError(
        'Invalid glTF affine matrix; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
      );
    const trs = splitTRS(m);
    if (typeof trs === 'string')
      throw trs === 'singular' ? new RangeError('Singular glTF matrix') : new Error('Sheared matrices are unsupported');
    node.setPosition(trs[0]).setScale(trs[2]).setQuaternion(trs[1]);
  } else
    node
      .setPosition((def.translation ?? [0, 0, 0]) as [number, number, number])
      .setScale((def.scale ?? [1, 1, 1]) as [number, number, number])
      .setQuaternion(def.rotation ?? [0, 0, 0, 1]);
}

function nodeVisible(engine: Engine, node: Mesh): boolean {
  return !hiddenInTree(engine.store, node.id);
}
/**
 * A glTF model attached to an engine as a plugin: its nodes, materials, variants, animation targets and picking data. Dispose it to release the GPU resources.
 */
export class PBRModel implements EnginePlugin {
  /** Optional scene-wide opaque phase, used by caller-owned color captures. */
  static beginOpaquePass(context: Context): void {
    opaquePasses.set(context, new Set());
  }
  static cancelOpaquePass(context: Context): void {
    opaquePasses.delete(context);
  }
  static endOpaquePass(context: Context): void {
    const models = opaquePasses.get(context);
    opaquePasses.delete(context);
    for (const model of models ?? []) model.draw(context, 'beauty', context.color, context.depth, 'blend');
  }
  readonly name = 'gltf-pro:' + modelId++;
  readonly root: Mesh;
  readonly nodes: Mesh[] = [];
  readonly primitives: PBRPrimitive[] = [];
  /** Installed by optional deformation packages; does not advance animation time. */
  prepareDeformation?: (context: PBRDeformationContext) => void;
  /** Optional isolated deformation kernels for another rendering device. */
  createDeformationRenderer?: (model: PBRModel, device: GPUDevice) => PBRDeformationRenderer;
  readonly lights: GLTFLight[] = [];
  /** The file's `MSFT_lod` objects; `LOD.fromModel` from `@margoengine/lod` drives them. Empty without the extension. */
  readonly lods: GLTFLOD[] = [];
  readonly cameras: GLTFCamera[] = [];
  /**
   * glTF POINTS, LINES, LINE_LOOP and LINE_STRIP primitives (`topology` set), drawn in the beauty pass only: no shadows,
   * SSAO, SSR or transparency hook. Kept out of `primitives`, which picking, BVH, outlines, walk collisions and exporters
   * read as triangles. Empty for `@margoengine/gltf-pro/progressive` loads, which leave points and lines out.
   */
  readonly pointsAndLines: PBRPrimitive[] = [];
  /** KHR_materials_variants names in file order (empty without the extension); `selectVariant` takes a name or its index. */
  readonly variants: readonly string[];
  private readonly materials: PBRMaterial[];
  private readonly defaults = new Map<PBRPrimitive, PBRMaterial>();
  disposed = false;
  private readonly created: Mesh[] = [];
  private resources: DrawResource[] = [];
  private textures: GPUTexture[] = [];
  private readonly gpuCache = new Map<unknown, GPUBuffer | GPUTexture | GPURenderPipeline>();
  private readonly inverse = new Float32Array(16);
  private readonly workspace = new Float64Array(52);
  /** Material batches baked once. Device restore uploads them again and keeps the same nodes. */
  private staticBatches?: StaticBatch[];
  /** Primitives drawn from another primitive's buffer pair (see `shareBuffers`), each mapped to the pair's owner. */
  private readonly bufferSources = new Map<PBRPrimitive, PBRPrimitive>();
  private relative?: Float32Array;
  private engine: Engine;
  private readonly cleanupCallbacks = new Set<() => void>();
  private readonly lighting = new Set<LightingEffect>();
  /** `lighting` in order, a new array on every change (draw-memo.ts compares derivation contexts by it). */
  private lightingList: readonly LightingEffect[] = noLighting;
  private readonly replays = new Map<string, string>();
  private gpuRevision = 0;
  /** Pose answers for one shadow-primitive write. Draw calls keep their own map on the scratch. */
  private shadowBatchLive?: Map<StaticBatch, boolean>;
  private transparency?: PBRTransparency;
  private capture?: PBRCapture;
  private transmission?: PBRTransmission;
  constructor(
    instance: EngineKernel,
    readonly asset: GLTFAsset,
    private readonly images: readonly GLTFImage[] = [],
    prepared?: readonly (readonly PreparedGeometry[])[],
  ) {
    this.engine = engineRuntime(instance);
    Object.defineProperty(this, shadowPrimitivesInto, { value: PBRModel.prototype.writeShadowPrimitives });
    const doc = asset.doc,
      defs = doc.nodes ?? [],
      parents = new Int32Array(defs.length).fill(-1),
      materials = (this.materials = (doc.materials ?? []).map((def) =>
        material(def, asset.hooks.materials || undefined),
      ));
    const variants = doc.extensions?.KHR_materials_variants?.variants ?? [];
    if (!Array.isArray(variants) || variants.some((v) => typeof v?.name !== 'string'))
      throw new TypeError(
        'Invalid glTF material variants; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
      );
    this.variants = variants.map((v) => v.name);
    defs.forEach((def, id) => {
      if (!def || (def.children !== undefined && !Array.isArray(def.children)))
        throw new TypeError(
          'Invalid glTF node; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
        );
      const visibility = def.extensions?.KHR_node_visibility;
      if (
        visibility !== undefined &&
        (!visibility ||
          typeof visibility !== 'object' ||
          Array.isArray(visibility) ||
          (visibility.visible !== undefined && typeof visibility.visible !== 'boolean'))
      )
        throw new TypeError(`glTF node ${id} KHR_node_visibility must be an object with an optional boolean visible`);
      for (const child of def.children ?? []) {
        const c = integer(child, 'child');
        if (c >= defs.length || parents[c] !== -1 || c === id)
          throw new TypeError('Invalid glTF hierarchy; give each node one parent and valid child indices');
        parents[c] = id;
      }
    });
    // A level sits under the finest level's parent: its own transform applies in the same space.
    defs.forEach((def, id) => {
      for (const level of lodIds(def, id, defs.length)) if (parents[level] === -1) parents[level] = parents[id];
    });
    for (let i = 0; i < defs.length; i++) {
      let depth = 0;
      for (let p = i; p !== -1; p = parents[p])
        if (++depth > 62)
          throw new RangeError('glTF hierarchy cycle or depth limit; remove the cycle or flatten the nodes');
    }
    const roots = doc.scenes
      ? (entry(doc.scenes, doc.scene ?? 0, 'scene').nodes ?? [])
      : defs.map((_: unknown, i: number) => i).filter((i: number) => parents[i] === -1);
    if (
      !Array.isArray(roots) ||
      new Set(roots).size !== roots.length ||
      roots.some((i) => parents[integer(i, 'scene root')] !== -1)
    )
      throw new TypeError(
        'Invalid scene roots; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
      );
    const active = new Set<number>(),
      visit = (id: number) => {
        entry(defs, id, 'node');
        active.add(id);
        for (const c of defs[id].children ?? []) visit(c);
        for (const level of lodIds(defs[id], id, defs.length)) if (!active.has(level)) visit(level);
      };
    for (const id of roots) visit(id);
    try {
      this.root = this.engine.createMesh();
      this.created.push(this.root);
      for (let i = 0; i < defs.length; i++) {
        const node = this.engine.createMesh();
        this.nodes.push(node);
        this.created.push(node);
        node.name = defs[i].name ?? '';
        node.visible = defs[i].extensions?.KHR_node_visibility?.visible ?? true;
        transform(node, defs[i]);
      }
      for (let i = 0; i < defs.length; i++)
        this.nodes[i].setParent(parents[i] < 0 ? this.root : this.nodes[parents[i]]);
      for (const i of active) {
        const ids = lodIds(defs[i], i, defs.length);
        if (!ids.length) continue;
        const coverage = (defs[i].extras as { MSFT_screencoverage?: number[] } | undefined)?.MSFT_screencoverage;
        if (
          coverage !== undefined &&
          (!Array.isArray(coverage) ||
            coverage.length > ids.length + 1 ||
            coverage.some((v, k) => !(v > 0 && v <= 1) || (k > 0 && v >= coverage[k - 1])))
        )
          throw new TypeError(
            `glTF node ${i} MSFT_screencoverage must hold decreasing numbers from 0 to 1, at most one per level; re-export the file`,
          );
        for (const level of ids) this.nodes[level].visible = false;
        this.lods.push({
          node: this.nodes[i],
          levels: [this.nodes[i], ...ids.map((level) => this.nodes[level])],
          ...(coverage ? { screenCoverage: [...coverage] } : {}),
        });
      }
      for (const i of active) {
        const d = defs[i],
          light = d.extensions?.KHR_lights_punctual;
        if (light) {
          const def = entry(doc.extensions?.KHR_lights_punctual?.lights, light.light, 'light'),
            spot =
              def.type === 'spot'
                ? {
                    innerConeAngle: scalar(def.spot?.innerConeAngle ?? 0, 0, Math.PI / 2, 'spot cone'),
                    outerConeAngle: scalar(def.spot?.outerConeAngle ?? Math.PI / 4, 0, Math.PI / 2, 'spot cone'),
                  }
                : {};
          if (
            !['directional', 'point', 'spot'].includes(def.type) ||
            (def.range !== undefined && !(def.range > 0)) ||
            spot.innerConeAngle! >= spot.outerConeAngle!
          )
            throw new TypeError(
              'Invalid glTF light; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
            );
          this.lights.push({
            ...def,
            ...spot,
            color: vector(def.color ?? [1, 1, 1], 3, 'light color', 0),
            intensity: scalar(def.intensity ?? 1, 0, Infinity, 'light intensity'),
            node: this.nodes[i],
            nodeIndex: i,
          });
        }
        if (d.camera !== undefined) {
          const def = entry(doc.cameras, d.camera, 'camera');
          if (!['perspective', 'orthographic'].includes(def.type) || typeof def[def.type] !== 'object')
            throw new TypeError(
              'Invalid glTF camera; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
            );
          this.cameras.push({ ...def, node: this.nodes[i], nodeIndex: i });
        }
      }
      let geometryBytes = 0;
      const checked = new Set<PreparedGeometry>(),
        packs = new Map<object, PreparedGeometry>(),
        counted = new Set<Float32Array | Uint32Array>(),
        reader = asset.hooks.instancing;
      // Like a missing draco/ktx2 decoder: a required extension without its reader fails, a used-only one falls back (each mesh once).
      if (!reader && doc.extensionsRequired?.includes('EXT_mesh_gpu_instancing'))
        throw margoError(
          'unsupported',
          'Required glTF extensions are unsupported: EXT_mesh_gpu_instancing (pass decoders.instancing from @margoengine/gltf-pro/instancing)',
        );
      for (const i of active)
        if (defs[i].mesh !== undefined) {
          const mesh = entry(doc.meshes, defs[i].mesh, 'mesh');
          if (!Array.isArray(mesh.primitives) || !mesh.primitives.length)
            throw new TypeError(
              'Missing primitives; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
            );
          if (prepared && prepared[defs[i].mesh]?.length !== mesh.primitives.length)
            throw new TypeError('Missing prepared PBR primitives; this is a loader bug, report it with the file');
          const gpu = defs[i].extensions?.EXT_mesh_gpu_instancing,
            instances = gpu && reader?.read(asset, gpu);
          for (let j = 0; j < mesh.primitives.length; j++) {
            const p = mesh.primitives[j];
            // ponytail: progressive's placeholders are triangle boxes, so it leaves points and lines out; stream them if CAD edges need it.
            if (!prepared && (p?.mode ?? 4) < 4 && packed.has(p) && !packed.get(p)!.topology) continue;
            const made: PBRPrimitive = prepared
              ? preparedPrimitive(asset, p, prepared[defs[i].mesh][j], this.nodes[i], i, materials, checked)
              : primitive(asset, p, this.nodes[i], i, mesh, materials, packs);
            for (const data of [made.vertices, made.indices])
              if (!counted.has(data)) {
                geometryBytes += data.byteLength;
                counted.add(data);
              }
            if (geometryBytes > asset.maxBytes * 4)
              throw overBudget('Decoded glTF geometry exceeds byte budget', asset.maxBytes * 4);
            if (instances) made.instances = instances;
            (made.topology ? this.pointsAndLines : this.primitives).push(made);
          }
        }
      if (!this.primitives.length && !this.pointsAndLines.length)
        throw margoError('failed', 'glTF contains no renderable meshes; add a mesh with triangle primitives');
      const source: PBRSource = this;
      for (const node of this.created) Object.defineProperty(node, cpuSource, { value: source, configurable: true });
      for (const node of new Set(this.primitives.map((p) => p.node))) {
        const model = this,
          primitives = this.primitives.filter((p) => p.node === node);
        const source: MeshSource = {
          model,
          node,
          primitives,
          stride: 80,
          skinned: primitives.some((p) => doc.nodes?.[p.nodeIndex]?.skin !== undefined),
          morphed: primitives.some((p) => !!p.definition.targets?.length),
          get bounds() {
            const out = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
            for (const p of primitives)
              for (let i = 0; i < p.vertices.length; i += 20)
                for (let axis = 0; axis < 3; axis++) {
                  out[axis] = Math.min(out[axis], p.vertices[i + axis]);
                  out[axis + 3] = Math.max(out[axis + 3], p.vertices[i + axis]);
                }
            return out;
          },
          get draws() {
            return model.pickingPrimitives.filter((p) => p.node === node);
          },
          get shadowPrimitives() {
            return model.nodeShadowPrimitives(node);
          },
          get tintPrimitives() {
            return model.tintPrimitives.filter((p) => p.node === node);
          },
          prepareDeformation(context) {
            model.prepareDeformation?.(context);
          },
          async readPickingGeometry() {
            return (await model.readPickingGeometry()).filter((p) => p.node === node);
          },
        };
        setMeshSource(node, source);
      }
      const deferral = (asset as GLTFAsset & { [deferStaticBatches]?: StaticBatchDeferral })[deferStaticBatches];
      if (deferral) deferral.commit = () => this.commitStaticBatches();
    } catch (error) {
      for (const node of this.created.reverse()) {
        clearMeshSource(node);
        Reflect.deleteProperty(node, cpuSource);
        node.dispose();
      }
      throw error;
    }
  }
  /** Current node transforms applied to bind-pose CPU positions. Does not perform GPU readback. */
  get bounds(): Float32Array {
    if (this.disposed) throw margoError('disposed', 'PBRModel is disposed; load the model again');
    this.engine.store.tick(false);
    const out = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (const p of this.pointsAndLines.length ? [...this.primitives, ...this.pointsAndLines] : this.primitives) {
      if (p.instances) {
        p.instances.bounds(p.node.matrix, p.vertices, out);
        continue;
      }
      if (this.engine.meshes.get(p.node.id) !== p.node) continue;
      const m = p.node.matrix,
        v = p.vertices;
      for (let i = 0; i < v.length; i += 20)
        for (let axis = 0; axis < 3; axis++) {
          const n = m[axis] * v[i] + m[axis + 4] * v[i + 1] + m[axis + 8] * v[i + 2] + m[axis + 12];
          out[axis] = Math.min(out[axis], n);
          out[axis + 3] = Math.max(out[axis + 3], n);
        }
    }
    if (!Number.isFinite(out[0])) throw margoError('state', 'No geometry; load a model with triangle meshes first');
    return out;
  }
  /** Borrowed GPU buffers, preserving one record per primitive and current deformation. */
  get raw() {
    return this.pickingPrimitives.filter((p) => this.engine.meshes.get(p.node.id) === p.node);
  }
  private bufferUpload(device: GPUDevice): (data: Float32Array | Uint32Array, usage: number) => GPUBuffer {
    const cache = this.gpuCache;
    let assets = sharedBuffers.get(device);
    if (!assets) sharedBuffers.set(device, (assets = new WeakMap()));
    let shared = assets.get(this.asset);
    if (!shared) assets.set(this.asset, (shared = new WeakMap()));
    const map = shared;
    return (data, usage) => {
      const existing = cache.get(data) as GPUBuffer | undefined;
      if (existing) return existing;
      // Another model on this device uploaded the same array: count this one in (cloneModel copies upload nothing).
      const share = map.get(data);
      if (share && share.usage === usage) {
        share.users++;
        cache.set(data, share.buffer);
        return share.buffer;
      }
      if (data.byteLength > device.limits.maxBufferSize)
        throw new RangeError(
          'PBR buffer exceeds device limit; load a smaller model, or reduce its textures and meshes',
        );
      const b = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      try {
        device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
      } catch (e) {
        b.destroy();
        throw e;
      }
      const entry = { buffer: b, data, usage, users: 1, map };
      map.set(data, entry);
      bufferShares.set(b, entry);
      cache.set(data, b);
      return b;
    };
  }
  /** Lets go of one of this model's vertex or index buffers and forgets every cache key that names it. */
  private dropBuffer(device: GPUDevice, buffer: GPUBuffer): void {
    for (const [key, value] of this.gpuCache) if (value === buffer) this.gpuCache.delete(key);
    dropBuffer(device, buffer);
  }
  setup(engine: Engine, device = engine.gpu): void {
    if (engine !== this.engine || this.disposed)
      throw margoError('attached', 'PBRModel belongs to another engine or is disposed; load it into this engine');
    if (!device) throw margoError('unsupported', 'PBRModel requires WebGPU; use a browser that supports it');
    const mipSampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const upload = this.bufferUpload(device);
    for (const p of this.pointsAndLines.length ? [...this.primitives, ...this.pointsAndLines] : this.primitives) {
      const r: DrawResource = {
        primitive: p,
        device,
        vertex: undefined!,
        index: undefined!,
        uniform: undefined!,
        values: undefined!,
        groups: new Map(),
        views: [],
        samplers: [],
      };
      this.resources.push(r);
      // A shared primitive uploads its source's arrays, so the cache hands both the same pair again after a restore.
      const from = this.bufferSources?.get(p) ?? p;
      r.vertex = upload(from.vertices, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
      r.index = upload(from.indices, GPUBufferUsage.INDEX);
      p.buffers = { vertex: r.vertex, index: r.index };
      this.bindMaterial(r, device, mipSampler);
    }
    this.installBatches(device, mipSampler, upload);
  }
  /**
   * Points `target` at `source`'s vertex and index GPU buffers and frees the pair `target` used, so identical shapes
   * draw from one pair. Both must be triangle primitives of this model with
   * equal vertices and indices, neither skinned nor morphed; their CPU arrays, materials and nodes stay separate, and
   * the sharing survives a device restore. Returns false, changing nothing, when they do not qualify or the model is
   * still streaming.
   */
  shareBuffers(target: PBRPrimitive, source: PBRPrimitive): boolean {
    const host = this.asset as GLTFAsset & { [deferStaticBatches]?: StaticBatchDeferral };
    if (this.disposed || target === source || host[deferStaticBatches]) return false;
    for (const p of [target, source])
      if (
        !this.primitives.includes(p) ||
        p.topology ||
        p.deformed ||
        p.definition.targets?.length ||
        p.definition.attributes?.JOINTS_0 !== undefined ||
        this.asset.doc.nodes?.[p.nodeIndex]?.skin !== undefined
      )
        return false;
    const a = target.vertices,
      b = source.vertices,
      i = target.indices,
      j = source.indices;
    if (a.length !== b.length || i.length !== j.length) return false;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
    for (let k = 0; k < i.length; k++) if (i[k] !== j[k]) return false;
    const root = this.bufferSources.get(source) ?? source;
    if (root === target) return false;
    for (const [shared, from] of this.bufferSources) if (from === target) this.bufferSources.set(shared, root);
    this.bufferSources.set(target, root);
    const from = this.resources.find((r) => r.primitive === root && !r.batch),
      to = this.resources.find((r) => r.primitive === target && !r.batch);
    if (!from || !to || to.vertex === from.vertex) return true;
    const old = [to.vertex, to.index];
    for (const r of this.resources)
      if (!r.batch && r.vertex === old[0]) {
        r.vertex = from.vertex;
        r.index = from.index;
        r.primitive.buffers = { vertex: from.vertex, index: from.index };
      }
    for (const buffer of old)
      if (!this.resources.some((r) => r.vertex === buffer || r.index === buffer)) this.dropBuffer(to.device, buffer);
    return true;
  }
  /**
   * Replaces the geometry of every triangle primitive in place: `geometry[i]` becomes `primitives[i]`'s vertices and
   * indices (`PreparedGeometry` layout), keeping nodes, materials, instances and plugin registrations. A GPU buffer is
   * rewritten when the new data fits it and reallocated at twice its size (or the data size) otherwise, so repeated
   * edits stop allocating. With `range` (vertex units) only those vertices differ from the current ones: the vertex
   * count and the index contents stay the same (the arrays may be new objects, which refreshes identity-keyed caches
   * such as BVHs) and only the range's bytes upload. CPU readers (bounds, BVH, worldTriangles, exporters) see the new
   * arrays at once. Static material batches are retired, and edited primitives cast shadows as dynamic from then on.
   * Renderers from `createRenderer` keep the geometry they were created with.
   */
  writeGeometry(
    geometry: readonly PreparedGeometry[],
    range?: { readonly start: number; readonly count: number },
  ): void {
    if (this.disposed) throw margoError('disposed', 'PBRModel is disposed; create a new model');
    const list = this.primitives,
      max = this.resources[0]?.device.limits.maxBufferSize ?? Infinity,
      shared = new Set(this.bufferSources.values());
    if (!Array.isArray(geometry) || geometry.length !== list.length)
      throw new RangeError('PBR geometry needs one entry per primitive; pass model.primitives.length entries');
    for (let i = 0; i < list.length; i++) {
      const p = list[i],
        g = geometry[i];
      if (p.deformed)
        throw new TypeError(
          'PBR geometry writes need an undeformed primitive; dispose its Skin or other deformer, write, then attach it again',
        );
      if (
        p.definition.targets?.length ||
        p.definition.attributes?.JOINTS_0 !== undefined ||
        this.bufferSources.has(p) ||
        shared.has(p)
      )
        throw new TypeError('PBR geometry writes need unskinned, unmorphed, unshared primitives; recreate the model');
      if (!range) validatePreparedGeometry(g);
      else if (
        !(g?.vertices instanceof Float32Array) ||
        !(g.indices instanceof Uint32Array) ||
        g.vertices.length !== p.vertices.length ||
        g.indices.length !== p.indices.length
      )
        throw new RangeError('A ranged PBR geometry write keeps the vertex and index counts; omit the range to resize');
      if (g.topology) throw new TypeError('PBR geometry writes take triangle lists; remove topology');
      if (g.vertices.byteLength > max || g.indices.byteLength > max)
        throw new RangeError('PBR buffer exceeds device limit; split the geometry into smaller meshes');
    }
    if (range) {
      const { start, count } = range,
        total = list[0].vertices.length / 20;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(count) ||
        start < 0 ||
        count < 1 ||
        start + count > total
      )
        throw new RangeError(
          'PBR geometry range must be whole vertices inside the mesh; pass start >= 0 and count >= 1',
        );
      for (const vertices of new Set(geometry.map((g) => g.vertices)))
        checkPreparedVertices(vertices, start, start + count);
    }
    this.retireBatches();
    const written = new Map<Float32Array | Uint32Array, GPUBuffer>(),
      claimed = new Set<GPUBuffer>(),
      dropped = new Set<GPUBuffer>();
    // Points and lines may share a triangle primitive's buffers; they keep their contents.
    for (const r of this.resources)
      if (!list.includes(r.primitive)) for (const b of [r.vertex, r.index]) claimed.add(b);
    // Each new array gets one buffer: its own old one when it fits and no other array took it, else a larger one.
    const device = this.resources[0]?.device,
      midFrame = !!device && recording(device);
    const place = (
      r: DrawResource,
      from: GPUBuffer,
      data: Float32Array | Uint32Array,
      usage: number,
      part?: number[],
    ) => {
      let to = written.get(data);
      if (!to) {
        const fits = part || data.byteLength <= from.size;
        // Mid-frame, earlier draws (this model's, shadows') keep the old contents: the new data takes a new buffer.
        // So does a buffer other models draw from (ownBuffer, last: it forgets the old array's entry).
        if (!claimed.has(from) && fits && !midFrame && ownBuffer(from)) {
          if (!part) r.device.queue.writeBuffer(from, 0, data as Float32Array<ArrayBuffer>);
          else if (part[1])
            r.device.queue.writeBuffer(from, part[0] * 4, data as Float32Array<ArrayBuffer>, part[0], part[1]);
          to = from;
        } else {
          to = r.device.createBuffer({
            size: Math.min(max, Math.max(data.byteLength, fits ? from.size : from.size * 2)),
            usage: usage | GPUBufferUsage.COPY_DST,
          });
          r.device.queue.writeBuffer(to, 0, data as Float32Array<ArrayBuffer>);
        }
        written.set(data, to);
        claimed.add(to);
      }
      if (to !== from) dropped.add(from);
      return to;
    };
    for (const r of this.resources) {
      const i = list.indexOf(r.primitive);
      if (i < 0) continue;
      const p = r.primitive,
        g = geometry[i];
      r.vertex = place(
        r,
        r.vertex,
        g.vertices,
        GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
        range && [range.start * 20, range.count * 20],
      );
      r.index = place(r, r.index, g.indices, GPUBufferUsage.INDEX, range && [0, 0]);
      if (!range && r.wireframe) {
        dropped.add(r.wireframe.index);
        r.wireframe = undefined;
      }
      p.buffers = { vertex: r.vertex, index: r.index };
      r.edited = true;
    }
    for (const buffer of dropped)
      if (!this.resources.some((r) => r.vertex === buffer || r.index === buffer)) dropBuffer(device!, buffer);
    for (let i = 0; i < list.length; i++) {
      for (const data of [list[i].vertices, list[i].indices]) if (!written.has(data)) this.gpuCache.delete(data);
      list[i].vertices = geometry[i].vertices;
      list[i].indices = geometry[i].indices;
    }
    for (const [data, buffer] of written) this.gpuCache.set(data, buffer);
  }
  /** Drops every static material batch for good: its parts draw individually from their own, now editable, buffers. */
  private retireBatches(): void {
    if (!this.staticBatches?.length) return;
    for (const r of this.resources)
      if (r.batch) {
        for (const b of [r.vertex, r.index]) this.dropBuffer(r.device, b);
        for (const b of [r.wireframe?.index, r.uniform, r.extension?.uniform, r.volume]) retire(r.device, b);
      }
    this.resources = this.resources.filter((r) => !r.batch);
    for (const r of this.resources) r.mergedInto = undefined;
    this.staticBatches = [];
  }
  /** Bakes static same-material triangles once the asset's geometry and instances are final. */
  private commitStaticBatches(): void {
    const host = this.asset as GLTFAsset & { [deferStaticBatches]?: StaticBatchDeferral };
    delete host[deferStaticBatches];
    if (this.disposed || this.staticBatches !== undefined) return;
    const device = this.engine.gpu;
    if (!device) throw margoError('unsupported', 'PBRModel requires WebGPU; use a browser that supports it');
    this.installBatches(
      device,
      device.createSampler({ minFilter: 'linear', magFilter: 'linear' }),
      this.bufferUpload(device),
    );
  }
  /** Bakes static same-material triangles once, after world matrices exist, and uploads that mesh on each device. */
  private installBatches(
    device: GPUDevice,
    mipSampler: GPUSampler,
    upload: (data: Float32Array | Uint32Array, usage: number) => GPUBuffer,
  ): void {
    // Streaming setup runs on placeholder boxes, and each arrived chunk borrows this model as its prototype.
    const host = this.asset as GLTFAsset & { [deferStaticBatches]?: StaticBatchDeferral };
    if (host[deferStaticBatches] || !Object.hasOwn(this, 'engine')) return;
    if (this.staticBatches === undefined) {
      this.engine.store.tick(false);
      this.staticBatches = buildStaticBatches(this.primitives, this.root, () => {
        const node = this.engine.createMesh(this.root);
        this.created.push(node);
        return node;
      });
      // No tick for the batch nodes: a tick runs every mesh of the engine, and the next one publishes them (`pose`).
    }
    if (this.resources.some((r) => r.batch)) return;
    const byPrimitive = new Map(this.resources.map((r) => [r.primitive, r]));
    for (const batch of this.staticBatches) {
      const p = batch.primitive,
        r: DrawResource = {
          primitive: p,
          device,
          vertex: undefined!,
          index: undefined!,
          uniform: undefined!,
          values: undefined!,
          groups: new Map(),
          views: [],
          samplers: [],
          batch,
        };
      this.resources.push(r);
      r.vertex = upload(p.vertices, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
      r.index = upload(p.indices, GPUBufferUsage.INDEX);
      p.buffers = { vertex: r.vertex, index: r.index };
      this.bindMaterial(r, device, mipSampler);
      for (const part of batch.parts) {
        const held = byPrimitive.get(part.primitive);
        if (held) held.mergedInto = r;
      }
    }
  }
  /** True while every baked part still has the captured root-relative pose, material and visibility, and is in `context`'s view. */
  private pose(batch: StaticBatch, context?: Context): boolean {
    this.relative ??= new Float32Array(16);
    // A batch node sits at the root. It differs only before its first tick, which every engine frame and pick has run
    // by now: this serves a draw made without one (`frameGraph.execute`).
    const root = this.root.matrix,
      own = batch.node.matrix;
    for (let c = 0; c < 16; c++)
      if (own[c] !== root[c]) {
        this.engine.store.tick(false);
        break;
      }
    if (!invertMatrixStable(root, this.inverse, this.workspace)) return false;
    const relative = this.relative;
    for (let i = 0; i < batch.parts.length; i++) {
      const part = batch.parts[i],
        primitive = part.primitive;
      if (
        primitive.material !== batch.material ||
        (context && !inView(context, primitive.node)) ||
        primitiveAfterOpaque(primitive) ||
        primitive.deformed ||
        primitive.instances ||
        primitive.topology ||
        primitive.vertices !== part.vertices ||
        primitive.indices !== part.indices
      )
        return false;
      if (!nodeVisible(this.engine, primitive.node)) return false;
      multiplyMatrices(this.inverse, primitive.node.matrix, relative);
      const stamp = part.stamp;
      for (let c = 0; c < 16; c++) if (relative[c] !== stamp[c]) return false;
    }
    return true;
  }
  /** Per-node casters stay individual so `shadows.add(node)` still finds that node's triangles. */
  private nodeShadowPrimitives(node: Mesh): ShadowCasterRecord[] {
    const out: ShadowCasterRecord[] = [];
    for (let i = 0; i < this.resources.length; i++) {
      const r = this.resources[i];
      if (
        r.batch ||
        r.primitive.node !== node ||
        r.primitive.material.settings[0] === 2 ||
        r.primitive.topology ||
        primitiveAfterOpaque(r.primitive)
      )
        continue;
      const value = {} as ShadowCasterRecord;
      fillShadow(r, value);
      out.push(value);
    }
    return out;
  }
  // The material's uniform buffer (880 bytes, 1088 for extended materials), textures and samplers; again after a variant switch.
  private bindMaterial(r: DrawResource, device: GPUDevice, mipSampler: GPUSampler): void {
    const m = r.primitive.material,
      floats =
        !(r.primitive.extension ?? m.extension)?.replacesPhysical && (m.extendedFrame || m.physical || m.ext?.[0])
          ? m.extended
            ? 272
            : 220
          : 100,
      cache = this.gpuCache;
    if (r.values?.length !== floats) {
      retire(r.device, r.uniform);
      r.values = new Float32Array(floats);
      r.uniform = acquireUniform(device, floats);
    }
    r.views = [];
    r.samplers = [];
    r.groups.clear();
    r.copies?.clear();
    r.replacesTextures = !!m.shading?.replacesTextures;
    if (r.replacesTextures) return;
    for (let i = 0; i < m.maps.length; i++) {
      if (!ownSlot(m, i, this.asset.hooks.materials || undefined)) {
        r.views.push(undefined!);
        r.samplers.push(undefined!);
        continue;
      }
      const map = m.maps[i],
        def = map ? entry(this.asset.doc.textures, map.index, 'texture') : null;
      // KHR_texture_basisu, EXT_texture_webp and EXT_texture_avif sources win when decoded; otherwise the fallback source.
      const source = def
          ? ((['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'] as const)
              .map((k) => def.extensions?.[k]?.source)
              .find((s) => s !== undefined && this.images[s]) ?? integer(def.source, 'image'))
          : -1,
        image = this.images[source];
      if (def && !image)
        throw new TypeError('Missing decoded glTF image; this is a loader bug, report it with the file');
      const compressed = image && 'ktx2' in image ? image.ktx2 : image && 'mipmaps' in image ? image : undefined,
        format = compressed
          ? ((compressed.format.replace(/-srgb$/, '') + (srgbMaps.includes(i) ? '-srgb' : '')) as GPUTextureFormat)
          : srgbMaps.includes(i)
            ? 'rgba8unorm-srgb'
            : 'rgba8unorm',
        size = image ? [image.width, image.height] : [1, 1];
      if (size.some((n) => n > device.limits.maxTextureDimension2D))
        throw new RangeError('Image exceeds device limit; load a smaller model, or reduce its textures and meshes');
      const key = image ? source + ':' + format : 'default:' + i;
      let texture = cache.get(key) as GPUTexture | undefined;
      const shares = texture ? undefined : texturesOf(device, image ?? this.asset),
        shareKey = image ? format : key,
        share = shares?.get(shareKey);
      if (share) {
        // Another model on this device holds the same image: count this one in (cloneModel copies upload nothing).
        share.users++;
        texture = share.texture;
        this.textures.push(texture);
        cache.set(key, texture);
      }
      const hold = (made: GPUTexture) => {
        const held = { texture: made, key: shareKey, users: 1, map: shares! };
        shares!.set(shareKey, held);
        textureShares.set(made, held);
        this.textures.push(made);
        cache.set(key, made);
      };
      if (!texture && compressed) {
        texture = uploadCompressedImage(device, compressed, srgbMaps.includes(i));
        hold(texture);
      }
      if (!texture) {
        const levels = compressed
          ? compressed.mipmaps.length
          : image
            ? Math.floor(Math.log2(Math.max(...size))) + 1
            : 1;
        texture = device.createTexture({
          size,
          format,
          mipLevelCount: levels,
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            (compressed ? 0 : GPUTextureUsage.RENDER_ATTACHMENT),
        });
        hold(texture);
        // Transcoded mips upload as-is: rgba8 rows, or 16-byte 4x4 blocks (BC7, ASTC 4x4, ETC2 RGBA8).
        if (image) device.queue.copyExternalImageToTexture({ source: image as ImageBitmap }, { texture }, size);
        else
          device.queue.writeTexture(
            { texture },
            new Uint8Array(normalMaps.includes(i) ? [128, 128, 255, 255] : [255, 255, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1],
          );
        if (!compressed) generateMipmaps(device, texture, levels, mipPipelines(device), mipSampler);
      }
      let view = textureViews.get(texture);
      if (!view) textureViews.set(texture, (view = texture.createView()));
      r.views.push(view);
      const s = def?.sampler === undefined ? {} : entry(this.asset.doc.samplers, def.sampler, 'sampler');
      const wrap = (v: unknown) => {
        if (v === undefined || v === 10497) return 'repeat';
        if (v === 33071) return 'clamp-to-edge';
        if (v === 33648) return 'mirror-repeat';
        throw new TypeError('Invalid texture wrapping; use a glTF sampler constant');
      };
      if (
        (s.magFilter !== undefined && ![9728, 9729].includes(s.magFilter)) ||
        (s.minFilter !== undefined && ![9728, 9729, 9984, 9985, 9986, 9987].includes(s.minFilter!))
      )
        throw new TypeError('Invalid texture filter; use a glTF sampler constant');
      const state: GPUSamplerDescriptor = {
          addressModeU: wrap(s.wrapS),
          addressModeV: wrap(s.wrapT),
          magFilter: s.magFilter === 9728 ? 'nearest' : 'linear',
          minFilter: [9728, 9984, 9986].includes(s.minFilter!) ? 'nearest' : 'linear',
          mipmapFilter: [9984, 9985].includes(s.minFilter!) ? 'nearest' : 'linear',
          lodMaxClamp: [9728, 9729].includes(s.minFilter!) ? 0 : 32,
        },
        samplerKey = Object.values(state).join();
      let samplers = deviceSamplers.get(device);
      if (!samplers) deviceSamplers.set(device, (samplers = new Map()));
      let sampler = samplers.get(samplerKey);
      if (!sampler) samplers.set(samplerKey, (sampler = device.createSampler(state)));
      r.samplers.push(sampler);
    }
  }
  registerPasses(graph: FrameGraph): void {
    let models = modelGraphs.get(graph);
    if (!models) modelGraphs.set(graph, (models = modelGraph()));
    // Next to the previous model's pass only if nothing else entered or left the graph since it was added.
    if (models.revision !== graph.revision) models.segment = [];
    const own = models;
    graph.add({
      name: this.name,
      order: 1,
      joins: true,
      execute: (c) => {
        if (c.backend === 'webgpu') this.drawSegment(c, own);
      },
    });
    models.segment.push(this);
    models.segments.set(this, models.segment);
    models.revision = graph.revision;
  }
  /**
   * Models whose passes follow one another in the frame graph draw as one run (one render pass, shared batches), in
   * graph order, at the first one's pass; the others' passes then draw nothing. A model whose neighbours are other
   * passes draws on its own, as before. (A render pass per model stored and reloaded the multisampled colour and depth
   * each time: 100 models, 100 passes and 1.2 ms of GPU time.)
   */
  private drawSegment(c: Context, models: ModelGraph): void {
    const segment = models.segments.get(this);
    let live = 0,
      head: PBRModel | undefined;
    if (segment) for (const model of segment) if (!model.disposed && live++ === 0) head = model;
    if (live < 2) return this.draw(c, 'beauty', c.color, c.depth);
    if (head !== this) return;
    const run = models.run;
    try {
      for (const model of segment!)
        if (!model.disposed) model.draw(c, 'beauty', c.color, c.depth, 'all', undefined, run);
    } finally {
      run.end();
    }
  }
  /**
   * This model's decoded images for another model of the same asset (`new PBRModel(engine, asset, images)`), which then
   * holds them too: each closes with its last holder, and the two share the GPU textures made from them. Pass them to
   * `closeImages` if no model ends up holding them.
   */
  shareImages(): GLTFImage[] {
    if (this.disposed) throw margoError('disposed', 'PBRModel is disposed; load the model again');
    retainImages(this.images);
    return [...this.images];
  }
  /** Lets go of one of this model's material textures and forgets its cache key. */
  private dropTexture(device: GPUDevice, key: string, texture: GPUTexture): void {
    this.gpuCache.delete(key);
    this.textures.splice(this.textures.indexOf(texture), 1);
    dropTexture(device, texture);
  }
  /**
   * Compiles the render pipelines of this model's beauty draws without blocking, so its first frame finds them ready.
   * Call it once the scene's lights and effects are set: a change that alters a shader afterwards compiles on the draw
   * as before, so calling this is never needed for correctness. Off WebGPU it does nothing. Pipelines of batched
   * textureless meshes compile on their first draw. Rejects with the GPU's error if a pipeline fails.
   */
  async compile(): Promise<void> {
    if (this.disposed) throw margoError('disposed', 'PBRModel is disposed; load the model again');
    const target = this.engine.renderTarget,
      device = this.engine.gpu;
    if (!target || !device) return;
    const c = {
        device,
        format: target.format,
        descriptor: { multisample: { count: target.samples }, depthStencil: { format: target.depthFormat } },
      } as unknown as Context,
      compiling = new Map<string, Promise<unknown>>(),
      scratch = createDrawScratch(undefined!, undefined!),
      draws = deviceDraws(device),
      frame = drawFrame(
        undefined,
        'beauty',
        undefined,
        c,
        undefined,
        this.transparency,
        this.capture,
        this.asset.hooks.materials,
        this.lightingList,
      );
    scratch.compiling = compiling;
    scratch.context = c;
    for (const r of this.resources) {
      const p = r.primitive,
        m = p.material;
      if (p.topology || r.batch || r.mergedInto) continue;
      if ((this.transparency && separable(m)) || (this.transmission && transmits(m))) continue;
      if (!p.instances && !p.deformed && !m.shading?.replacesTextures && !m.maps.some(Boolean)) continue;
      p.node.check();
      const a = p.node.matrix,
        det =
          a[0] * (a[5] * a[10] - a[6] * a[9]) -
          a[4] * (a[1] * a[10] - a[2] * a[9]) +
          a[8] * (a[1] * a[6] - a[2] * a[5]);
      if (det === 0 || !Number.isFinite(det)) continue;
      const wireframe = wireframeIndices(r);
      this.derive(
        undefined,
        frame,
        draws,
        c,
        'beauty',
        scratch,
        r,
        wireframe ? 'line-list' : undefined,
        wireframe,
        Math.sign(det),
        undefined,
        p.instances,
      );
    }
    await Promise.all(compiling.values());
  }
  /** Borrow a decoded image for optional material packages; the model owns its lifetime. */
  image(index: number): Exclude<GLTFImage, undefined> {
    if (this.disposed) throw margoError('disposed', 'PBRModel is disposed; load the model again');
    const image = this.images[integer(index, 'image')];
    if (!image) throw new TypeError('Missing decoded glTF image; this is a loader bug, report it with the file');
    return image;
  }
  /** Upload a retained image; the caller owns and destroys the returned texture. */
  uploadImage(index: number, device: GPUDevice, srgb = false): GPUTexture {
    const image = this.image(index);
    if ('ktx2' in image || 'mipmaps' in image)
      return uploadCompressedImage(device, 'ktx2' in image ? image.ktx2 : image, srgb);
    const size = [image.width, image.height],
      texture = device.createTexture({
        size,
        format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
    try {
      device.queue.copyExternalImageToTexture({ source: image }, { texture }, size);
      return texture;
    } catch (error) {
      texture.destroy();
      throw error;
    }
  }
  addLighting(effect: LightingEffect): () => void {
    if (
      this.disposed ||
      !effect ||
      typeof (effect.pbr ?? effect.shader) !== 'function' ||
      typeof effect.bindings !== 'function'
    )
      throw new TypeError('Invalid PBR lighting effect; pass the effect made by createLighting for this engine');
    if (effect.owner && effect.owner !== this.engine)
      throw margoError('attached', 'PBR lighting belongs to another engine; create it with this engine');
    this.lighting.add(effect);
    this.lightingList = [...this.lighting];
    return () => {
      this.lighting.delete(effect);
      this.lightingList = this.lighting.size ? [...this.lighting] : noLighting;
    };
  }
  /** Hands this model's BLEND primitives to a transparency hook (README "Transparency hook"); returns a remover that restores sorted blending. */
  setTransparency(hook: PBRTransparency): () => void {
    if (
      this.disposed ||
      !hook ||
      typeof hook.declarations !== 'function' ||
      typeof hook.bindings !== 'function' ||
      typeof hook.begin !== 'function' ||
      !Array.isArray(hook.targets)
    )
      throw new TypeError('Invalid PBR transparency hook; pass a function, or null to remove the hook');
    this.transparency = hook;
    return () => {
      if (this.transparency === hook) this.transparency = undefined;
    };
  }
  /** Lets a capture hook (README "Capture hook"; SSR's `ssr.add(model)`) draw this model's materials with `draw(c, 'capture', ...)`; returns a remover. */
  setCapture(hook: PBRCapture): () => void {
    if (
      this.disposed ||
      !hook ||
      typeof hook.declarations !== 'function' ||
      typeof hook.begin !== 'function' ||
      !Array.isArray(hook.targets)
    )
      throw new TypeError('Invalid PBR capture hook; pass a function, or null to remove the hook');
    this.capture = hook;
    return () => {
      if (this.capture === hook) this.capture = undefined;
    };
  }
  /** Hands this model's transmission primitives to a transmission hook (README "Transmission hook"); returns a remover that restores the tinted blend. */
  setTransmission(hook: PBRTransmission): () => void {
    if (
      this.disposed ||
      !hook ||
      typeof hook.declarations !== 'function' ||
      typeof hook.bindings !== 'function' ||
      typeof hook.begin !== 'function' ||
      !Array.isArray(hook.targets)
    )
      throw new TypeError('Invalid PBR transmission hook; pass a function, or null to remove the hook');
    this.transmission = hook;
    return () => {
      if (this.transmission === hook) this.transmission = undefined;
    };
  }
  /**
   * Shows a KHR_materials_variants variant (a name from `variants` or its index): every primitive with a mapping for it draws
   * that material, the others their own (the glTF fallback); `undefined` restores every primitive's own material. A variant's
   * textures upload on first use and stay cached. With `@margoengine/gltf-pro/progressive`, call it after `complete`.
   */
  selectVariant(variant?: string | number): void {
    const index = typeof variant === 'string' ? this.variants.indexOf(variant) : (variant ?? -1);
    if (
      this.disposed ||
      (variant !== undefined && !(Number.isInteger(index) && index >= 0 && index < this.variants.length))
    )
      throw new RangeError(
        `selectVariant: the model has no material variant ${variant}; pass an index below the variant count`,
      );
    // Every material is resolved (and validated) before any primitive changes.
    const changes: [PBRPrimitive, PBRMaterial][] = [];
    for (const p of [...this.primitives, ...this.pointsAndLines]) {
      const mappings = p.definition.extensions?.KHR_materials_variants?.mappings;
      if (mappings === undefined) continue;
      if (!Array.isArray(mappings))
        throw new TypeError(
          'Invalid glTF material variant mappings; the file is not valid glTF 2.0, re-export it and check it with the glTF Validator',
        );
      const own = this.defaults.get(p) ?? p.material,
        hit = mappings.find((m) => Array.isArray(m?.variants) && m.variants.includes(index));
      const m = hit
        ? fit(this.asset, p.definition, this.materials[integer(hit.material, 'material')], !!p.topology)
        : own;
      if (m !== p.material) changes.push([p, m]);
    }
    const device = this.engine.gpu,
      resources = new Map(this.resources.map((r) => [r.primitive, r]));
    let mipSampler: GPUSampler | undefined;
    for (const [p, m] of changes) {
      if (!this.defaults.has(p)) this.defaults.set(p, p.material);
      p.material = m;
      const r = resources.get(p);
      if (r && device)
        this.bindMaterial(
          r,
          device,
          (mipSampler ??= device.createSampler({ minFilter: 'linear', magFilter: 'linear' })),
        );
    }
  }
  get shadowPrimitives(): ShadowCasterRecord[] {
    const out: ShadowCasterRecord[] = [];
    this.writeShadowPrimitives(out);
    return out;
  }
  /**
   * Transmissive and blended primitives for coloured shadows (`Shadows` `colored`), with the light each lets through:
   * the transmission tint, or the base colour weighed by alpha.
   */
  get tintPrimitives(): (ShadowCasterRecord & { tint: readonly number[] })[] {
    const out: (ShadowCasterRecord & { tint: readonly number[] })[] = [];
    for (let i = 0; i < this.resources.length; i++) {
      const r = this.resources[i],
        p = r.primitive,
        m = p.material;
      if (p.topology || (m.settings[0] !== 2 && !primitiveAfterOpaque(p))) continue;
      const record = {} as ShadowCasterRecord & { tint: readonly number[] };
      fillShadow(r, record);
      record.tint = m.tint ?? [0, 1, 2].map((k) => 1 - m.base[3] * (1 - m.base[k]));
      out.push(record);
    }
    return out;
  }
  /** Borrowed current draw buffers; picking never substitutes bind-pose geometry. */
  get pickingPrimitives() {
    if (this.disposed) return [];
    return this.resources
      .filter((r) => !r.batch)
      .map((r) => {
        const m = r.primitive.material,
          mask = m.pickMask,
          cutoff = m.settings[0] === 1 ? m.settings[1] : m.settings[0] === 2 ? 0.001 : 0;
        return {
          primitive: r.primitive,
          node: r.primitive.node,
          vertex: r.primitive.deformed ?? r.vertex,
          vertexOffset: r.primitive.deformed ? (r.primitive.deformedOffset ?? 0) : 0,
          index: r.index,
          count: r.primitive.indices.length,
          stride: 80 as const,
          alphaTexture: mask ? mask.view : r.views[0],
          alphaSampler: mask ? mask.sampler : r.samplers[0],
          alpha: m.base[3],
          cutoff,
          side: sideOf(m),
          doubleSided: sideOf(m) === 'double',
          texCoord: (mask ? mask.texCoord : m.maps[0] ? textureCoordinates(m.maps[0]).texCoord : 0) as 0 | 1,
          ...(mask
            ? { alphaTransform: mask.transform }
            : m.maps[0]?.extensions?.KHR_texture_transform
              ? { alphaTransform: textureCoordinates(m.maps[0]).transform }
              : {}),
          ...(mask?.opacity ? { opacity: mask.opacity } : {}),
          ...(m.vertexAlpha === false && cutoff > 0 ? { vertexAlpha: false } : {}),
          ...(m.displacement ? { displacement: m.displacement } : {}),
          ...(m.surfaceClip ? { clip: m.surfaceClip } : {}),
        };
      });
  }
  /** Explicit CPU-query snapshot. Only deformed geometry incurs GPU readback. */
  async readPickingGeometry(): Promise<readonly PBRPickingGeometry[]> {
    const device = this.engine.gpu,
      revision = this.gpuRevision;
    if (this.disposed || this.engine.disposed || !device) return [];
    this.engine.store.tick(false);
    // Identity is captured now: snapshots can be filtered, primitives can share a node and the list can change while
    // mapAsync is pending, so neither the node nor a snapshot's position may stand in for it.
    const primitiveIndices = new Map(this.primitives.map((primitive, index) => [primitive, index]));
    const records = this.resources
      .filter((resource) => !resource.batch)
      .map((resource) => ({
        resource,
        primitive: resource.primitive,
        primitiveIndex: primitiveIndices.get(resource.primitive),
        nodeIndex: resource.primitive.nodeIndex,
        deformed: resource.primitive.deformed,
        deformedOffset: resource.primitive.deformedOffset ?? 0,
        matrix: resource.primitive.node.matrix.slice(),
        vertices: resource.primitive.deformed ? undefined : resource.primitive.vertices.slice(),
        indices: resource.primitive.indices.slice(),
        side: sideOf(resource.primitive.material),
        doubleSided: sideOf(resource.primitive.material) === 'double',
        read: undefined as GPUBuffer | undefined,
      }));
    try {
      if (this.prepareDeformation || records.some((record) => record.deformed)) {
        const encoder = device.createCommandEncoder();
        this.prepareDeformation?.({ backend: 'webgpu', device, encoder });
        for (const record of records)
          if (record.deformed) {
            if (!(record.deformed.usage & GPUBufferUsage.COPY_SRC))
              throw new TypeError('Deformed picking snapshots require COPY_SRC buffers');
            const size = record.primitive.vertices.byteLength;
            if (size > device.limits.maxBufferSize)
              throw new RangeError(
                'Picking snapshot exceeds device buffer limit; load a smaller model, or reduce its textures and meshes',
              );
            record.read = device.createBuffer({
              label: 'PBR picking snapshot',
              size,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            encoder.copyBufferToBuffer(record.deformed, record.deformedOffset, record.read, 0, size);
          }
        device.queue.submit([encoder.finish()]);
        await Promise.all(
          records.filter((record) => record.read).map((record) => record.read!.mapAsync(GPUMapMode.READ)),
        );
      }
      if (
        this.disposed ||
        this.engine.disposed ||
        this.engine.gpu !== device ||
        revision !== this.gpuRevision ||
        records.some(
          (record) =>
            record.primitive.deformed !== record.deformed ||
            (record.deformed && (record.primitive.deformedOffset ?? 0) !== record.deformedOffset),
        )
      )
        return [];
      return records
        .filter((record) => this.engine.meshes.get(record.primitive.node.id) === record.primitive.node)
        .map((record) => ({
          node: record.primitive.node,
          matrix: record.matrix,
          vertices: record.read ? new Float32Array(record.read.getMappedRange()).slice() : record.vertices!,
          indices: record.indices,
          doubleSided: record.doubleSided,
          side: record.side,
          ...(record.primitiveIndex === undefined ? {} : { primitiveIndex: record.primitiveIndex }),
          // Merged static batches mark "no glTF node" with -1; report no identity rather than an invented one.
          ...(record.nodeIndex >= 0 ? { nodeIndex: record.nodeIndex } : {}),
        }));
    } catch (error) {
      if (
        this.disposed ||
        this.engine.disposed ||
        this.engine.gpu !== device ||
        revision !== this.gpuRevision ||
        records.some(
          (record) =>
            record.primitive.deformed !== record.deformed ||
            (record.deformed && (record.primitive.deformedOffset ?? 0) !== record.deformedOffset),
        )
      )
        return [];
      throw error;
    } finally {
      for (const { read } of records)
        if (read) {
          if (read.mapState === 'mapped') read.unmap();
          read.destroy();
        }
    }
  }
  // The public getter remains a fresh snapshot. Shadows owns this writer's
  // storage and never exposes it to callers or another shadow renderer.
  private writeShadowPrimitives(out: ShadowCasterRecord[]): boolean {
    if (lookupShadowGetter.call(this, 'shadowPrimitives') !== publicShadowGetter) return false;
    const live = (this.shadowBatchLive ??= new Map<StaticBatch, boolean>());
    live.clear();
    const shown = (batch: StaticBatch) => {
      let value = live.get(batch);
      if (value === undefined) live.set(batch, (value = this.pose(batch)));
      return value;
    };
    let count = 0;
    for (let i = 0; i < this.resources.length; i++) {
      const r = this.resources[i],
        p = r.primitive;
      if (p.material.settings[0] === 2 || p.topology || primitiveAfterOpaque(p)) continue;
      if (r.batch ? !shown(r.batch) : !!(r.mergedInto?.batch && shown(r.mergedInto.batch))) continue;
      fillShadow(r, (out[count] ??= {} as ShadowCasterRecord));
      count++;
    }
    out.length = count;
    return true;
  }
  /** `transparent` draws only the BLEND primitives a transparency hook took over (`setTransparency`), into its pass; `transmission`
   * those a transmission hook took over (`setTransmission`); `capture` the opaque and MASK ones into the capture hook's pass
   * (`setCapture`); for these `color`/`depth` are unused.
   *
   * `carry` is a `PBRDrawRun`: draws that pass the same run share one render pass instead of each beginning one
   * (a pass stores and reloads the multisampled colour and depth), blended draws included; a blended primitive drawn
   * without a run ends the pass around itself. Call
   * `carry.end()` after the last draw, before anything else records on `c.encoder`. */
  draw(
    c: Context,
    mode: 'beauty' | 'gbuffer' | 'ambient' | 'transparent' | 'transmission' | 'capture' | 'occlusion',
    color: GPUTextureView,
    depth: GPUTextureView,
    phase: 'all' | 'opaque' | 'blend' = 'all',
    external?: { pass: GPURenderPassEncoder; view: ArrayLike<number>; depthCompare: GPUCompareFunction },
    carry?: PBRDrawRun,
  ): void {
    // A run's later draws of a one-primitive model that joins an instanced batch skip the set-up below (joinRun).
    if (carry && !external && mode === 'beauty' && carry.pass && carry.view.at && carry.view.format === c.format) {
      const quick = carry.quickFor(c);
      if (!quick.opaque && this.joinRun(c, carry, phase, quick, carry.view.at)) return;
      // A full draw may run callbacks that move the camera or change the lights: check the view block again after it.
      quick.viewChecked = false;
    }
    const transmission = mode === 'transmission',
      oit = transmission ? this.transmission : this.transparency,
      through = mode === 'transparent' || transmission,
      hook = this.capture,
      capture = mode === 'capture',
      section = sectionState(c)?.buffer;
    if (this.disposed || (through && !oit) || (capture && !hook)) return;
    const pending = mode === 'beauty' ? opaquePasses.get(c) : undefined;
    if (pending) {
      // Explicit blend calls carry the queue's back-to-front order, independently of the earlier opaque phase.
      if (phase === 'blend') pending.delete(this);
      pending.add(this);
      if (phase === 'blend') return;
      phase = 'opaque';
    }
    const closing = mode === 'beauty' && carry,
      scratch = (scratchStack[scratchDepth] ??= createDrawScratch(color, depth)),
      camera = c.camera,
      lighting = this.engine.lighting;
    scratch.eye.set(camera.position);
    // The view block every draw of this call binds (view-uniform.ts): camera, view, eye, light, radiance, HDR flag;
    // bound on the call's first draw, so a call that draws nothing holds no view block. A run's later calls under the
    // same camera, lights and target reuse the run's block.
    const viewData = scratch.viewData,
      runView = carry && !external ? carry.view : undefined;
    let viewAt: GPUBufferBinding | undefined;
    if (runView?.at && runView.format === c.format && sameView(runView.data, camera, lighting)) viewAt = runView.at;
    else {
      viewData.set(camera.matrix);
      if (external) viewData.set(external.view, 16);
      else viewMatrix(scratch.view, camera), viewData.set(scratch.view, 16);
      viewData.set(scratch.eye, 32);
      viewData[35] = 0;
      viewData.set(lighting.direction, 36);
      viewData.set(lighting.radiance, 40);
      viewData[44] = +(c.format === 'rgba16float');
    }
    scratchDepth++;
    // Resources a callback releases during this draw stay valid until the frame is submitted.
    beginDraw(c.device, c.view ?? c);
    scratch.context = c;
    const draws = deviceDraws(c.device),
      run = carry && !external ? carry : undefined,
      // The state already set on the pass: a run's pass is the run's alone, so its draws skip what is already bound.
      bound = run ? run.bindings : scratch.bound;
    let frame = drawFrame(
      run,
      mode,
      external?.depthCompare,
      c,
      section,
      oit,
      hook,
      this.asset.hooks.materials,
      this.lightingList,
    );
    if (!run) resetBindings(bound, undefined);
    if (carry) carry.device = c.device;
    let pass: GPURenderPassEncoder | undefined = external?.pass ?? carry?.pass,
      shared: GPURenderPassEncoder | undefined;
    try {
      let resources = this.resources;
      if (!through && !capture) {
        resources = scratch.resources;
        const source = this.resources;
        let sort = false;
        for (let i = 0; i < source.length; i++) {
          resources[i] = source[i];
          sort ||= late(source[i]);
        }
        resources.length = source.length;
        // Sorting an all-opaque list only returns the original stable order.
        // Preserve a snapshot for hooks while avoiding V8's sort workspace.
        // Distances are filled once; the comparator used to call hypot twice per pair. One primitive needs no sort.
        if (sort && resources.length > 1) {
          const position = scratch.eye,
            distances = scratch.blendDistance;
          distances.clear();
          for (let i = 0; i < resources.length; i++) {
            const resource = resources[i];
            if (!late(resource)) continue;
            const matrix = resource.primitive.node.matrix;
            distances.set(
              resource,
              Math.hypot(position[0] - matrix[12], position[1] - matrix[13], position[2] - matrix[14]),
            );
          }
          resources.sort(scratch.compare);
        }
      }
      const liveBatches = scratch.liveBatches;
      if (liveBatches.size) liveBatches.clear();
      const batchLive = (batch: StaticBatch) => {
        let value = liveBatches.get(batch);
        if (value === undefined)
          liveBatches.set(
            batch,
            (value = (mode !== 'beauty' || !asymmetricStencilFaces(batch.material.renderState)) && this.pose(batch, c)),
          );
        return value;
      };
      for (let resourceIndex = 0; resourceIndex < resources.length; resourceIndex++) {
        const r = resources[resourceIndex];
        if (r.batch ? !batchLive(r.batch) : !!(r.mergedInto?.batch && batchLive(r.mergedInto.batch))) continue;
        const p = r.primitive,
          m = p.material,
          node = p.node,
          inst = p.instances,
          // Drawn in the beauty pass after the opaque capture, keeping its authored alpha mode.
          deferred = !r.batch && primitiveAfterOpaque(p);
        // A batch was checked part by part against the view's layers in pose().
        if (!r.batch && !inView(c, node)) continue;
        if (
          p.topology
            ? mode !== 'beauty'
            : through
              ? deferred || !(transmission ? transmits(m) : separable(m))
              : capture
                ? deferred || blended(m) || m.ext![0]
                : mode === 'beauty' && !deferred && ((oit && separable(m)) || (!!this.transmission && transmits(m)))
        )
          continue;
        if (phase !== 'all' && (blended(m) || deferred) !== (phase === 'blend')) continue;
        node.check();
        if (!nodeVisible(this.engine, node) || (inst && !inst.count)) continue;
        const wireframe = wireframeIndices(r),
          topology = p.topology ?? (wireframe ? 'line-list' : undefined),
          index = wireframe?.index ?? r.index,
          count = wireframe?.count ?? p.indices.length;
        const instances = inst?.upload(c.device);
        const a = node.matrix,
          det =
            a[0] * (a[5] * a[10] - a[6] * a[9]) -
            a[4] * (a[1] * a[10] - a[2] * a[9]) +
            a[8] * (a[1] * a[6] - a[2] * a[5]),
          sign = Math.sign(det),
          source = p.extension;
        // A callback of an earlier primitive may have added or removed a lighting effect.
        if (!sameLighting(frame.lighting, this.lightingList))
          frame = drawFrame(
            run,
            mode,
            external?.depthCompare,
            c,
            section,
            oit,
            hook,
            this.asset.hooks.materials,
            this.lightingList,
          );
        // Another primitive with this material record already derived the shader, pipeline and uniform rows for this
        // call or run: reuse them (draw-memo.ts). Material extensions keep per-resource state and derive their own.
        let d = steadyDerivation(draws.derivations.get(m), frame, source, inst, topology, sign, m);
        const hit = d !== undefined;
        const batching = !!run && mode === 'beauty';
        if (!d)
          d = this.derivation(
            draws,
            m,
            frame,
            source,
            topology,
            sign,
            c,
            mode,
            scratch,
            r,
            wireframe,
            external,
            inst,
            !batching,
          );
        // A run draws meshes that differ only in their node matrix as one instanced draw (draw-batch.ts).
        if (batching && batchable(d, r, det)) {
          if (!pass) {
            run.pass = pass = openPass(c, scratch, color, depth, closing);
            applyView(pass, c);
          }
          if (!viewAt) {
            viewAt = viewBinding(c.device, viewData, c.view ?? c, undefined);
            runView!.at = viewAt;
            runView!.format = c.format;
            runView!.data.set(viewData);
          }
          joinBatch(run, this, r, d, c, viewAt);
          continue;
        }
        // Batches recorded so far draw before this draw, which may end the pass or depend on what they drew.
        if (run?.pending.length) {
          if (pass) run.pass = pass;
          flushBatches(run);
        }
        // A derivation made for a batch lacks the pipeline and lighting group of a draw of its own.
        if (!d.complete)
          d = this.derivation(draws, m, frame, source, topology, sign, c, mode, scratch, r, wireframe, external, inst);
        else if (hit) {
          if (r.values.length !== d.floatCount || r.replacesTextures !== d.replacesTextures)
            this.bindMaterial(r, c.device, c.device.createSampler({ minFilter: 'linear', magFilter: 'linear' }));
          r.coordinates = undefined;
          if (r.extension) {
            retire(r.device, r.extension.uniform);
            r.extension = undefined;
          }
          const v = r.values;
          v.set(d.block);
          this.nodeRows(r, a, v);
          v[97] = sign;
        }
        const { pipeline, blend, state, extension, effectBindings } = d;
        const uniform = r.uniform.write(r.values, c.view ?? c);
        if (r.sectionBuffer !== section) {
          r.groups.clear();
          r.copies?.clear();
          r.sectionBuffer = section;
        }
        if (!viewAt) {
          viewAt = viewBinding(c.device, viewData, c.view ?? c, external && this);
          if (runView) {
            runView.at = viewAt;
            runView.format = c.format;
            runView.data.set(viewData);
          }
        }
        let groups = r.groups.get(pipeline);
        if (!groups) {
          groups = createDrawGroups(c.device, pipeline, r, m, transmission, frame.hooks, section, viewAt);
          r.groups.set(pipeline, groups);
        }
        let frameBindings = groups[0];
        if (uniform || groups.view !== viewAt)
          frameBindings = copyGroup(c.device, pipeline, r, transmission, section, uniform ?? r.uniform.binding, viewAt);
        let target: GPURenderPassEncoder;
        if (through || capture) target = shared ??= (through ? oit! : hook!).begin();
        else {
          // A blended primitive drawn on its own ends the pass around itself. A run's blended draws continue its pass:
          // a pass per blended mesh stores and reloads the multisampled colour and depth each time (2,000 blended
          // meshes: 2,000 passes a frame).
          if (!external && !carry && blend && mode !== 'gbuffer') {
            pass?.end();
            pass = undefined;
          }
          if (!pass) {
            pass = openPass(c, scratch, color, depth, closing);
            applyView(pass, c);
          }
          target = pass;
        }
        if (transmission) {
          const source = m.volume!;
          let data = r.volumeData;
          if (!data || data.length !== source.length) r.volumeData = data = new Float32Array(source.length);
          // Compare rounded values. A JS number such as 0.1 is not bit-identical to its float32 store.
          let changed = r.volumeWritten !== r.volume;
          if (!changed) for (let i = 0; i < source.length; i++) if (data[i] !== Math.fround(source[i])) changed = true;
          if (changed) {
            data.set(source);
            c.device.queue.writeBuffer(r.volume!, 0, data);
            r.volumeWritten = r.volume;
          }
        }
        // A callback above (lighting, instancing, transparency hooks) may have disposed this model or its node.
        if (this.disposed) break;
        if (this.engine.meshes.get(node.id) !== node) continue;
        if (bound.pass !== target) resetBindings(bound, target);
        const vertex = p.deformed ?? r.vertex,
          vertexOffset = p.deformed ? (p.deformedOffset ?? 0) : 0;
        // Transmission first multiplies the background, then adds the lit surface.
        if (d.tint) {
          const tint = d.tint,
            mappedTint = d.mappedTint;
          let tintGroups = r.groups.get(tint);
          if (!tintGroups) {
            if (mappedTint) tintGroups = createDrawGroups(c.device, tint, r, m, false, frame.hooks, section, viewAt);
            else {
              tintGroups = [frameGroup(c.device, tint, r, false, section, viewAt)];
              tintGroups.view = viewAt;
            }
            r.groups.set(tint, tintGroups);
          }
          const tintFrame =
            uniform || tintGroups.view !== viewAt
              ? copyGroup(c.device, tint, r, false, section, uniform ?? r.uniform.binding, viewAt)
              : tintGroups[0];
          setPipeline(bound, tint);
          setGroup(bound, 0, tintFrame);
          if (mappedTint) {
            setGroup(bound, 1, tintGroups[1]);
            if (effectBindings) setGroup(bound, 2, d.tintEffect!.group);
            if (extension) {
              bindMaterialExtension(c.device, target, tint, r.extension!, effectBindings);
              bound.groups[2] = bound.groups[3] = undefined;
            }
          }
          setBuffers(bound, vertex, instances, index, vertexOffset);
          applyStencilReference(target, state);
          if (inst) target.drawIndexed(count, inst.count);
          else target.drawIndexed(count);
        }
        setPipeline(bound, pipeline);
        setGroup(bound, 0, frameBindings);
        setGroup(bound, 1, groups[1]);
        if (d.effect) setGroup(bound, 2, d.effect.group);
        if (extension) {
          bindMaterialExtension(c.device, target, pipeline, r.extension!, effectBindings);
          bound.groups[2] = bound.groups[3] = undefined;
        }
        setBuffers(bound, vertex, instances, index, vertexOffset);
        // A preceding material may have changed the reference on this shared pass.
        applyStencilReference(target, state);
        if (inst) target.drawIndexed(count, inst.count);
        else target.drawIndexed(count);
        if (!external && !carry && blend && mode !== 'gbuffer' && !through && !capture) {
          pass!.end();
          pass = undefined;
        }
        if ((mode === 'beauty' || through) && !external) {
          this.engine.stats.visible += inst ? inst.count : 1;
          this.engine.stats.drawCalls++;
        }
      }
    } catch (error) {
      if (!external)
        try {
          if (!external) pass?.end();
        } catch {}
      if (carry) carry.pass = undefined;
      throw error;
    } finally {
      endDraw(c.device);
      scratchDepth--;
      scratch.context = undefined;
      scratch.code = '';
      // Release callback-owned references while retaining array capacity.
      for (let i = 0; i < scratch.effects.length; i++) scratch.effects[i] = undefined!;
      for (let i = 0; i < scratch.entries.length; i++) scratch.entries[i] = undefined!;
      scratch.color.view = scratch.depth.view = undefined!;
      if (scratch.liveBatches.size) scratch.liveBatches.clear();
      if (scratch.blendDistance.size) scratch.blendDistance.clear();
    }
    if (carry && !external) carry.pass = pass;
    else if (!external) pass?.end();
    if (!carry) flushUniforms(c.device);
  }
  /**
   * The derivation of `r`'s draw under `frame`, derived now (draw-memo.ts) into the entry of the same context from an
   * earlier call or frame, if any, so its GPU objects are reused; it fills `r.values` completely.
   */
  private derivation(
    draws: DeviceDraws,
    m: PBRMaterial,
    frame: DrawFrame,
    source: MaterialExtension | undefined,
    topology: GPUPrimitiveTopology | undefined,
    sign: number,
    c: Context,
    mode: 'beauty' | 'gbuffer' | 'ambient' | 'transparent' | 'transmission' | 'capture' | 'occlusion',
    scratch: DrawScratch,
    r: DrawResource,
    wireframe: DrawResource['wireframe'],
    external: { pass: GPURenderPassEncoder; view: ArrayLike<number>; depthCompare: GPUCompareFunction } | undefined,
    inst: PBRInstances | BatchKind | undefined,
    build = true,
  ): DrawDerivation {
    let list = draws.derivations.get(m),
      at = -1;
    if (list)
      for (let i = 0; i < list.length; i++) {
        const value = list[i];
        if (
          value.source === source &&
          value.instances === inst &&
          value.topology === topology &&
          value.sign === sign &&
          sameFrame(value.frame, frame)
        ) {
          at = i;
          break;
        }
      }
    const d = this.derive(
      at >= 0 ? list![at] : undefined,
      frame,
      draws,
      c,
      mode,
      scratch,
      r,
      topology,
      wireframe,
      sign,
      external,
      inst,
      build,
    );
    if (!list) draws.derivations.set(m, (list = []));
    if (at < 0) {
      if (list.length < derivationLimit) list.length++;
      at = list.length - 1;
    }
    for (let i = at; i > 0; i--) list[i] = list[i - 1];
    list[0] = d;
    return d;
  }
  /**
   * @internal `draw()`'s short path in a run: when this model is one opaque primitive whose draw joins an instanced
   * batch of `run` under the run's current view block and an existing derivation, adds it (or skips it when hidden)
   * and returns true; returns false for everything else, which `draw()` handles.
   */
  joinRun(
    c: Context,
    run: PBRDrawRun,
    phase: 'all' | 'opaque' | 'blend',
    quick: QuickRun,
    viewAt: GPUBufferBinding,
  ): boolean {
    const resources = this.resources;
    if (this.disposed || resources.length !== 1 || this.staticBatches?.length) return false;
    const r = resources[0],
      p = r.primitive,
      m = p.material,
      node = p.node;
    if (r.batch || r.mergedInto || p.instances || p.topology || primitiveAfterOpaque(p)) return false;
    const oit = this.transparency;
    if ((oit && separable(m)) || (this.transmission && transmits(m))) return false;
    if (phase !== 'all' && blended(m) !== (phase === 'blend')) return false;
    // The run's view block holds the camera, lights and target only while they are unchanged; nothing but a full
    // draw (its callbacks) can change them during a run, so one check serves the draws until the next full draw.
    if (!quick.viewChecked) {
      if (!sameView(run.view.data, c.camera, this.engine.lighting)) return false;
      quick.viewChecked = true;
    }
    if (!inView(c, node)) return true;
    node.check();
    if (!nodeVisible(this.engine, node)) return true;
    // The derivation context: the last one when this model's lighting and hooks are the same objects.
    const lighting = this.lightingList,
      hook = this.capture,
      hooks = this.asset.hooks.materials || undefined;
    let frame = quick.frame;
    if (!frame || quick.lighting !== lighting || quick.oit !== oit || quick.hook !== hook || quick.hooks !== hooks) {
      frame = drawFrame(run, 'beauty', undefined, c, quick.section, oit, hook, hooks, lighting);
      quick.frame = frame;
      quick.lighting = lighting;
      quick.oit = oit;
      quick.hook = hook;
      quick.hooks = hooks;
    }
    const a = node.matrix,
      det =
        a[0] * (a[5] * a[10] - a[6] * a[9]) - a[4] * (a[1] * a[10] - a[2] * a[9]) + a[8] * (a[1] * a[6] - a[2] * a[5]),
      d = steadyDerivation(
        quick.draws.derivations.get(m),
        frame,
        p.extension,
        undefined,
        wireframeIndices(r) ? 'line-list' : undefined,
        Math.sign(det),
        m,
      );
    if (!d || !batchable(d, r, det)) return false;
    joinBatch(run, this, r, d, c, viewAt);
    return true;
  }
  /**
   * @internal Draws `batch` (draw-batch.ts) into `run`'s pass: one mesh as its own draw, exactly as without a run;
   * several as one instanced draw of the instanced variant of their derivation, with a batch uniform (identity model
   * rows) and their world matrices as instance rows.
   */
  drawBatch(batch: PendingBatch, run: PBRDrawRun): void {
    const { owner: r, d, c, members, viewAt, view } = batch,
      pass = run.pass!,
      bound = run.bindings,
      device = c.device,
      p = r.primitive,
      m = p.material,
      // A wireframe batch draws the members' edges (line-list, the owner's edge indices: the geometry is shared).
      topology = d.topology,
      wireframe = topology ? wireframeIndices(r) : undefined,
      count = wireframe?.count ?? p.indices.length,
      frame = d.frame,
      section = frame.section;
    if (bound.pass !== pass) resetBindings(bound, pass);
    // Every member counts as drawn, as a draw of its own did (counted here rather than once per member).
    this.engine.stats.visible += members.length;
    beginDraw(device, view);
    const scratch = (scratchStack[scratchDepth] ??= createDrawScratch(c.color, c.depth));
    scratchDepth++;
    try {
      if (members.length === 1) {
        this.drawOwn(r, batch, run, scratch);
        return;
      }
      if (r.values.length !== d.floatCount || r.replacesTextures !== d.replacesTextures)
        this.bindMaterial(r, device, device.createSampler({ minFilter: 'linear', magFilter: 'linear' }));
      if (batch.rows) {
        this.drawRows(batch, run, scratch);
        return;
      }
      // The instanced variant: one per material, context and handedness, shared by every batch of the material.
      const kind = batchKind(d.sign < 0),
        draws = deviceDraws(device),
        derived =
          steadyDerivation(draws.derivations.get(m), frame, p.extension, kind, topology, 1, m) ??
          this.derivation(
            draws,
            m,
            frame,
            p.extension,
            topology,
            1,
            c,
            'beauty',
            scratch,
            r,
            wireframe,
            undefined,
            kind,
          ),
        pipeline = derived.pipeline;
      // Members of other material records (folded in) need the same pipeline and group 2 and a shader that reads the
      // base colour only as the vertex colour's factor; then each takes its own base colour as its instance tint.
      if (!derived.modelFree || (batch.folded && !this.folds(batch, derived, kind, topology, scratch, draws))) {
        // The shader reads the model rows itself (or a folded member differs): each mesh draws on its own, as
        // without a run, in order.
        for (let i = 0; i < members.length; i++)
          if (!batch.models[i].disposed) batch.models[i].drawOwn(members[i], batch, run, scratch);
        return;
      }
      const tints = batch.folded ? scratch.tints : undefined;
      if (tints) {
        for (let i = 0; i < members.length; i++) tints[i] = members[i].primitive.material.base;
        tints.length = members.length;
      }
      if (r.sectionBuffer !== section) {
        r.groups.clear();
        r.copies?.clear();
        r.sectionBuffer = section;
      }
      let groups = r.groups.get(pipeline);
      if (!groups) {
        groups = createDrawGroups(device, pipeline, r, m, false, frame.hooks, section, viewAt);
        r.groups.set(pipeline, groups);
      }
      let frameBindings: GPUBindGroup, instances: GPUBuffer;
      {
        // The batch's GPU state, as a draw's own uniform: a later draw from the same view replaces its rows; another view
        // of the same frame (a viewport, a probe face) takes another state, so the earlier draws keep theirs until
        // submit. A view keeps its state frame after frame.
        // Blended batches change their first member as the sort order changes: their states stay with the derivation,
        // one per batch drawn in a frame.
        const states = d.blend ? undefined : (r.batchStates ??= new Map());
        let list = states ? states.get(d) : (d.blendStates ??= []);
        if (states && !list) {
          // Derivations come and go with contexts: keep the states of the last few.
          if (states.size >= 8)
            for (const [key, old] of states) {
              for (const value of old) {
                retire(device, value.uniform);
                value.instances.destroy(device);
              }
              states.delete(key);
              break;
            }
          states.set(d, (list = []));
        }
        // The batch's uniform: the material rows with identity model rows (world = instance row).
        const v =
          scratch.batchValues.length === derived.floatCount
            ? scratch.batchValues
            : (scratch.batchValues = new Float32Array(derived.floatCount));
        v.set(derived.block);
        v.fill(0, 16, 48);
        v[16] = v[21] = v[26] = v[31] = v[32] = v[37] = v[42] = v[47] = 1;
        v[97] = 1;
        if (tints) v[76] = v[77] = v[78] = v[79] = 1;
        const matrices = scratch.matrices,
          nodes = batch.nodes;
        for (let i = 0; i < nodes.length; i++) matrices[i] = nodes[i].matrix;
        matrices.length = members.length;
        // Which state: this view's own; else, in a frame another view already drew this batch in, that view's state
        // when it holds the same rows and uniform (nothing to keep apart); else one no view drew this frame; else a new one.
        const now = currentFrame(device, view);
        let state: BatchState | undefined,
          mine: BatchState | undefined,
          equal: BatchState | undefined,
          free: BatchState | undefined;
        for (const value of list!) {
          if (!states) {
            if (value.frame !== now) {
              free = value;
              break;
            }
          } else if (value.view === view) mine = value;
          else if (value.frame === now) {
            if (
              !equal &&
              value.uniform.floats === v.length &&
              value.instances.holds(matrices, tints) &&
              sameValues(value.uniform.contents, v)
            )
              equal = value;
          } else free ??= value;
        }
        state = mine ?? equal ?? free;
        if (!state)
          list!.push(
            (state = {
              instances: new BatchInstances(),
              uniform: acquireUniform(device, derived.floatCount),
              groups: new Map(),
              frame: now,
              view,
            }),
          );
        if (state !== equal) {
          state.frame = now;
          state.view = view;
        }
        instances = state.instances.write(device, matrices, tints);
        for (let i = 0; i < matrices.length; i++) matrices[i] = undefined!;
        if (tints) for (let i = 0; i < tints.length; i++) tints[i] = undefined!;
        if (state.uniform.floats !== derived.floatCount) {
          retire(device, state.uniform);
          state.uniform = acquireUniform(device, derived.floatCount);
          state.groups.clear();
        }
        const uniform = state.uniform.write(v, view) ?? state.uniform.binding;
        frameBindings = batchGroup(state.groups, device, pipeline, r, section, viewAt, uniform);
      }
      setPipeline(bound, pipeline);
      setGroup(bound, 0, frameBindings);
      setGroup(bound, 1, groups[1]);
      if (derived.effect) setGroup(bound, 2, derived.effect.group);
      setBuffers(bound, r.vertex, instances, wireframe?.index ?? r.index);
      applyStencilReference(pass, derived.state);
      pass.drawIndexed(count, members.length);
      this.engine.stats.drawCalls++;
    } finally {
      endDraw(device);
      scratchDepth--;
      scratch.checked.clear();
      scratch.code = '';
      for (let i = 0; i < scratch.effects.length; i++) scratch.effects[i] = undefined!;
      for (let i = 0; i < scratch.entries.length; i++) scratch.entries[i] = undefined!;
    }
  }
  /**
   * @internal Draws rows batch `batch` (draw-batch.ts `BatchKind.rows`): meshes of several material records of one draw
   * group as instanced draws of the leading member's rows variant, each instance reading its own uniform block (its
   * material's rows, with its world matrix as its instance row), one draw per `rowsPerBinding` instances. When any
   * member's rows variant would not draw as the leader's does (`rowsFit`), every member draws on its own, in order.
   */
  private drawRows(batch: PendingBatch, run: PBRDrawRun, scratch: DrawScratch): void {
    const { owner: r, d, c, members, viewAt, view, ds } = batch,
      device = c.device,
      p = r.primitive,
      m = p.material,
      topology = d.topology,
      wireframe = topology ? wireframeIndices(r) : undefined,
      count = wireframe?.count ?? p.indices.length,
      frame = d.frame,
      section = frame.section,
      bound = run.bindings,
      pass = run.pass!,
      kind = batchKind(d.sign < 0, true),
      draws = deviceDraws(device),
      derived =
        steadyDerivation(draws.derivations.get(m), frame, p.extension, kind, topology, 1, m) ??
        this.derivation(draws, m, frame, p.extension, topology, 1, c, 'beauty', scratch, r, wireframe, undefined, kind),
      pipeline = derived.pipeline;
    if (!derived.modelFree || !this.rowsFit(batch, derived, kind, scratch, draws)) {
      for (let i = 0; i < members.length; i++)
        if (!batch.models[i].disposed) batch.models[i].drawOwn(members[i], batch, run, scratch);
      return;
    }
    // The batch's GPU state, kept like a plain batch's (`drawBatch`): per view on the leading resource, per drawn batch
    // on the derivation for blended ones.
    const now = currentFrame(device, view),
      states = d.blend ? undefined : (r.rowStates ??= new Map());
    let list = states ? states.get(derived) : (derived.blendRows ??= []);
    if (states && !list) {
      if (states.size >= 8)
        for (const [key, old] of states) {
          for (const value of old) {
            value.rows.destroy(device);
            value.instances.destroy(device);
          }
          states.delete(key);
          break;
        }
      states.set(derived, (list = []));
    }
    let state: RowsState | undefined, free: RowsState | undefined;
    for (const value of list!) {
      if (states && value.view === view) {
        state = value;
        break;
      }
      if (value.frame !== now) free ??= value;
    }
    state ??= free;
    if (!state)
      list!.push(
        (state = {
          instances: new BatchInstances(),
          rows: new BatchRows(),
          groups: new Map(),
          textures: new Map(),
          frame: now,
          view,
        }),
      );
    state.frame = now;
    state.view = view;
    const matrices = scratch.matrices,
      blocks = scratch.blocks,
      versions = scratch.versions,
      nodes = batch.nodes;
    for (let i = 0; i < nodes.length; i++) {
      matrices[i] = nodes[i].matrix;
      blocks[i] = ds[i].block;
      versions[i] = ds[i].version ?? Number.NaN;
    }
    matrices.length = blocks.length = versions.length = members.length;
    const instances = state.instances.write(device, matrices),
      perBinding = rowsPerBinding(derived.floatCount),
      rows = state.rows;
    rows.write(device, blocks, ds, versions, derived.floatCount, perBinding);
    for (let i = 0; i < members.length; i++) matrices[i] = blocks[i] = undefined!;
    if (state.texturesOf !== r.views) {
      state.textures.clear();
      state.texturesOf = r.views;
    }
    let textures = state.textures.get(pipeline);
    if (!textures) state.textures.set(pipeline, (textures = textureGroup(device, pipeline, r, m, frame.hooks)));
    setPipeline(bound, pipeline);
    setGroup(bound, 1, textures);
    if (derived.effect) setGroup(bound, 2, derived.effect.group);
    setBuffers(bound, r.vertex, instances, wireframe?.index ?? r.index);
    applyStencilReference(pass, derived.state);
    for (let start = 0, k = 0; start < members.length; start += perBinding, k++) {
      setGroup(bound, 0, batchGroup(state.groups, device, pipeline, r, section, viewAt, rows.bindings[k]));
      pass.drawIndexed(count, Math.min(perBinding, members.length - start), 0, 0, start);
      this.engine.stats.drawCalls++;
    }
  }
  /**
   * @internal True when every member of rows batch `batch` draws as the leader's rows variant `derived` would draw it:
   * its own material's rows variant has the same pipeline, group 2 resources and uniform size, and reads the model rows
   * only in the instanced vertex stage. Kept on each member's derivation while both versions stay the same.
   */
  private rowsFit(
    batch: PendingBatch,
    derived: DrawDerivation,
    kind: BatchKind,
    scratch: DrawScratch,
    draws: DeviceDraws,
  ): boolean {
    const ds = batch.ds,
      lead = batch.d,
      topology = lead.topology;
    for (let i = 0; i < ds.length; i++) {
      const d = ds[i];
      if (d === lead) continue;
      if (d.rowsOf === derived && d.rowsAt === d.version && d.rowsOfAt === derived.version) {
        if (!d.rowsOk) return false;
        continue;
      }
      const model = batch.models[i];
      if (model.disposed) return false;
      const r = batch.members[i],
        p = r.primitive,
        m = p.material,
        own =
          steadyDerivation(draws.derivations.get(m), lead.frame, p.extension, kind, topology, 1, m) ??
          model.derivation(
            draws,
            m,
            lead.frame,
            p.extension,
            topology,
            1,
            batch.c,
            'beauty',
            scratch,
            r,
            topology ? wireframeIndices(r) : undefined,
            undefined,
            kind,
          ),
        ok =
          own.pipeline === derived.pipeline &&
          own.modelFree &&
          own.floatCount === derived.floatCount &&
          own.block.length === d.block.length &&
          sameEffect(own.effect, derived.effect);
      d.rowsOf = derived;
      d.rowsAt = d.version;
      d.rowsOfAt = derived.version;
      d.rowsOk = ok;
      if (!ok) return false;
    }
    return true;
  }
  /**
   * @internal True when every member of folded `batch` draws as the owner's instanced variant `derived` would draw
   * it: its own material's instanced variant has the same pipeline, group 2 entries and shader (`tintable`).
   */
  private folds(
    batch: PendingBatch,
    derived: DrawDerivation,
    kind: BatchKind,
    topology: GPUPrimitiveTopology | undefined,
    scratch: DrawScratch,
    draws: DeviceDraws,
  ): boolean {
    if (!derived.tintable) return false;
    // Each material record is checked once (members of a few materials interleave in sort order).
    const checked = scratch.checked;
    checked.clear();
    checked.add(batch.owner.primitive.material);
    for (let i = 0; i < batch.members.length; i++) {
      const r = batch.members[i],
        p = r.primitive,
        m = p.material;
      if (checked.has(m)) continue;
      checked.add(m);
      const model = batch.models[i];
      if (model.disposed) return false;
      const own =
        steadyDerivation(draws.derivations.get(m), batch.d.frame, p.extension, kind, topology, 1, m) ??
        model.derivation(
          draws,
          m,
          batch.d.frame,
          p.extension,
          topology,
          1,
          batch.c,
          'beauty',
          scratch,
          r,
          topology ? wireframeIndices(r) : undefined,
          undefined,
          kind,
        );
      if (own.pipeline !== derived.pipeline || !own.modelFree || !sameEffect(own.effect, derived.effect)) return false;
    }
    return true;
  }
  /** @internal Draws batch member `r` as its own draw (its material's shader reads the model rows; see `drawBatch`). */
  drawOwn(r: DrawResource, batch: PendingBatch, run: PBRDrawRun, scratch: DrawScratch): void {
    const { c, viewAt, view } = batch,
      frame = batch.d.frame,
      device = c.device,
      p = r.primitive,
      m = p.material,
      a = p.node.matrix,
      section = frame.section,
      bound = run.bindings,
      pass = run.pass!,
      sign = Math.sign(
        a[0] * (a[5] * a[10] - a[6] * a[9]) - a[4] * (a[1] * a[10] - a[2] * a[9]) + a[8] * (a[1] * a[6] - a[2] * a[5]),
      ),
      draws = deviceDraws(device);
    const topology = batch.d.topology,
      wireframe = topology ? wireframeIndices(r) : undefined;
    let d = steadyDerivation(draws.derivations.get(m), frame, p.extension, undefined, topology, sign, m);
    if (!d?.complete)
      d = this.derivation(
        draws,
        m,
        frame,
        p.extension,
        topology,
        sign,
        c,
        'beauty',
        scratch,
        r,
        wireframe,
        undefined,
        undefined,
      );
    else if (r.values.length !== d.floatCount || r.replacesTextures !== d.replacesTextures)
      this.bindMaterial(r, device, device.createSampler({ minFilter: 'linear', magFilter: 'linear' }));
    const v = r.values;
    v.set(d.block);
    this.nodeRows(r, a, v);
    v[97] = sign;
    const uniform = r.uniform.write(v, view),
      pipeline = d.pipeline;
    if (r.sectionBuffer !== section) {
      r.groups.clear();
      r.copies?.clear();
      r.sectionBuffer = section;
    }
    let groups = r.groups.get(pipeline);
    if (!groups) {
      groups = createDrawGroups(device, pipeline, r, m, false, frame.hooks, section, viewAt);
      r.groups.set(pipeline, groups);
    }
    setPipeline(bound, pipeline);
    setGroup(
      bound,
      0,
      uniform || groups.view !== viewAt
        ? copyGroup(device, pipeline, r, false, section, uniform ?? r.uniform.binding, viewAt)
        : groups[0],
    );
    setGroup(bound, 1, groups[1]);
    if (d.effect) setGroup(bound, 2, d.effect.group);
    setBuffers(bound, r.vertex, undefined, wireframe?.index ?? r.index);
    applyStencilReference(pass, d.state);
    pass.drawIndexed(wireframe?.count ?? p.indices.length);
    this.engine.stats.drawCalls++;
  }
  /**
   * Derives what draws of `r`'s material record share under `frame` (draw-memo.ts): the shader, pipeline, lighting
   * group and uniform rows. It fills `r.values` completely (node rows included) and returns the derivation, reusing
   * `d`'s GPU objects when their inputs compare equal.
   */
  private derive(
    d: DrawDerivation | undefined,
    frame: DrawFrame,
    draws: DeviceDraws,
    c: Context,
    mode: 'beauty' | 'gbuffer' | 'ambient' | 'transparent' | 'transmission' | 'capture' | 'occlusion',
    scratch: DrawScratch,
    r: DrawResource,
    topology: GPUPrimitiveTopology | undefined,
    wireframe: DrawResource['wireframe'],
    sign: number,
    external: { pass: GPURenderPassEncoder; view: ArrayLike<number>; depthCompare: GPUCompareFunction } | undefined,
    inst: PBRInstances | BatchKind | undefined = r.primitive.instances,
    build = true,
  ): DrawDerivation {
    const p = r.primitive,
      m = p.material,
      node = p.node,
      transmission = mode === 'transmission',
      oit = transmission ? this.transmission : this.transparency,
      through = mode === 'transparent' || transmission,
      hook = this.capture,
      capture = mode === 'capture',
      section = frame.section,
      shading = m.shading,
      // Read before anything else of the record: an edit made while this derives shows next frame.
      version = shading?.version;
    // Steady (draw-memo.ts): the record reports the version `d` was made complete at, so its rows, shader, pipeline
    // and group 2 all still hold; only this resource's state and node rows are its own.
    if (
      d?.complete &&
      version !== undefined &&
      version === d.version &&
      d.shading === shading &&
      !frame.lighting.length &&
      !through &&
      !capture &&
      !(p.extension ?? m.extension)
    ) {
      if (r.values.length !== d.floatCount || r.replacesTextures !== d.replacesTextures)
        this.bindMaterial(r, c.device, c.device.createSampler({ minFilter: 'linear', magFilter: 'linear' }));
      if (r.extension) {
        retire(r.device, r.extension.uniform);
        r.extension = undefined;
      }
      d.frame = frame;
      const v = r.values;
      v.set(d.block);
      this.nodeRows(r, node.matrix, v);
      v[97] = sign;
      return d;
    }
    const compact =
      !!(p.extension ?? m.extension)?.replacesPhysical || (!m.extendedFrame && !m.physical && !m.ext?.[0]);
    const floatCount = compact ? 100 : m.extended ? 272 : 220;
    if (r.values.length !== floatCount || r.replacesTextures !== !!m.shading?.replacesTextures)
      this.bindMaterial(r, c.device, c.device.createSampler({ minFilter: 'linear', magFilter: 'linear' }));
    const v = r.values;
    this.nodeRows(r, node.matrix, v);
    v.set(m.base, 76);
    v.set(m.factors, 80);
    if (!m.maps[2] && !m.extendedFrame) v[82] = 0;
    v.set(m.emission, 84);
    v.set(m.settings, 88);
    const side = sideOf(m),
      flag = sideFlag(side);
    v[90] = topology ? 1 : flag;
    // coordsA/coordsB.x name each base map's slot; uv() reads that slot's KHR_texture_transform row, which carries its UV set.
    for (let i = 0; i < 5; i++) v[92 + i] = compact ? (m.maps[i] ? textureCoordinates(m.maps[i]!).texCoord : 0) : i;
    v[97] = sign;
    if (!compact) {
      v.set(m.ext!, 100);
      v[103] = m.dispersion ?? 0;
      v.set(m.uvt!, 104);
    }
    if (!compact && m.physical) {
      const offset = m.extended ? 248 : 208;
      v.set(m.physical, offset);
      if (!m.maps[7] && !m.shading?.replacesTextures) v[offset + 2] = 0;
    }
    // Physical rows follow 26 UV rows (36 for extended materials); factor-only materials (five maps) use the same layout.
    // The transmission tint (margoTint) in spare Frame lanes coordsB.zw and ext.z; zero for every other material.
    if (!compact && m.tint) {
      const lanes = surfaceTint(m) ? m.attenuation! : m.tint;
      v[98] = lanes[0];
      v[99] = lanes[1];
      v[102] = lanes[2];
    }
    const source = p.extension ?? m.extension,
      // A normal map on UV1 or with a UV transform (glTF maps), or constructed material maps whose normal-slot affine
      // rows are not the identity, take the tangent frame from the UV derivatives.
      tangent =
        !compact &&
        !!(m.maps[2]
          ? textureCoordinates(m.maps[2]).texCoord === 1 || textureCoordinates(m.maps[2]).transform
          : m.extendedFrame &&
            (v[123] > 0.5 ||
              v[120] !== 1 ||
              v[121] !== 0 ||
              v[122] !== 0 ||
              v[124] !== 0 ||
              v[125] !== 1 ||
              v[126] !== 0)),
      structure = structureFlags(
        m.settings[0],
        v[90],
        tangent,
        !compact && !!m.tint,
        !!m.physical,
        !!m.physical && m.maps.length > 5,
        !!shading?.texturedTint,
        !!shading?.replacesTextures,
      ),
      revision = shading?.shaderRevision,
      // A compact record with no hook has no revision: `plainShape` names all that composes its shader instead. Instances
      // stay out: their mirrored state and layout change the pipeline with no change to the record.
      plain = compact && !inst && !shading && !source && !m.renderState && !m.attenuation ? plainShape(m, v, wireframe) : -1;
    // The same shader and pipeline as `d` from an earlier frame (draw-memo.ts): the shading hook reports the same
    // revision or a plain record the same shape, nothing else that composes the shader changed, and no lighting effect
    // or transparency hook patches it. Only the rows (above) and group 2's bindings are read again.
    if (
      d &&
      (compact ? plain >= 0 && d.plain === plain : revision !== undefined && d.revision === revision) &&
      d.shading === shading &&
      d.renderState === m.renderState &&
      d.structure === structure &&
      d.floatCount === floatCount &&
      d.compact === compact &&
      !source &&
      !m.extended &&
      !frame.lighting.length &&
      !through &&
      !capture &&
      (!build || d.pipeline !== undefined)
    ) {
      if (compact) r.coordinates = undefined;
      if (r.extension) {
        retire(r.device, r.extension.uniform);
        r.extension = undefined;
      }
      d.frame = frame;
      d.replacesTextures = r.replacesTextures!;
      // A pipeline from an earlier frame makes even a batch-only request complete: the draw that follows (a mesh of
      // its own, or a batch of one) needs no second derivation.
      const full = d.pipeline !== undefined;
      d.complete = full;
      d.version = Number.NaN;
      if (full) {
        const before = d.effect;
        d.effect = d.effectBindings
          ? this.effectGroup(d, d.pipeline, c, scratch, shading, false, undefined)
          : undefined;
        d.tintEffect = tintGroup(d, d.tint, d.mappedTint, d.effect, c.device);
        if (!inst && (!d.group || d.effect !== before)) d.group = drawGroup(draws, d);
        // Read again once `bindings()` ran: an upload it made (a map that just loaded) leaves the record steady.
        d.version = shading?.version;
      } else d.group = undefined;
      d.block.set(v);
      return d;
    }
    // Physical materials listing only the five core maps (materials built in code) draw the factor-only variant;
    // transmission draws its transmissive form, extended materials the shader of decoders.materials.
    const x = this.asset.hooks.materials || undefined,
      physical = compact
        ? pbrShader
        : m.physical
          ? m.maps.length > 5
            ? physicalShader()
            : factorPhysicalShader()
          : extendedPBRShader;
    let code =
        !compact && m.extended
          ? x!.shader(planOf(m, x!))
          : !compact && m.tint
            ? transmissiveShader(physical)
            : physical,
      entry =
        mode === 'beauty' || transmission
          ? 'fragment'
          : mode === 'gbuffer'
            ? 'gbuffer'
            : through
              ? 'transparent'
              : capture
                ? 'capture'
                : 'ambientFragment',
      lit = mode === 'beauty' || through || capture;
    // Every pipeline sets the face and alpha tests as constants (face, mask below), so plain opaque and blended
    // materials compile without a discard and keep early depth testing. The compact path had lost
    // this outside instancing and MASK in the consolidation (8f710eb3).
    if (compact) code = compactTests(code);
    if (compact) {
      r.coordinates = coordinateExtension(m.maps, source, r.coordinates);
      code = coordinateShader(code, r.coordinates, !!m.maps[2] && v[94] === 1);
    } else if (tangent) code = code.replace('if(abs(i.tangent.w)<0.5)', 'if(true)');
    const extension = compact ? (r.coordinates?.extension ?? source) : source;
    if (extension) {
      r.extension = prepareMaterialExtension(c.device, extension, r.extension);
      code = materialExtensionShader(code, extension);
    } else if (r.extension) {
      retire(r.device, r.extension.uniform);
      r.extension = undefined;
    }
    if (!build) {
      // A draw that may join an instanced batch needs only what decides its batch; the batch derives the rest. GPU
      // objects of an earlier full derivation stay for reuse.
      const transmit = !compact && !!m.tint,
        state = mode === 'beauty' ? m.renderState : undefined,
        out: DrawDerivation = d ?? ({} as DrawDerivation);
      out.frame = frame;
      out.source = p.extension;
      out.instances = inst;
      out.topology = topology;
      out.sign = sign;
      out.compact = compact;
      out.floatCount = floatCount;
      out.replacesTextures = r.replacesTextures!;
      out.extension = extension;
      out.complete = false;
      // Derived without composing the shader: a later frame cannot keep the pipeline on what this derivation saw.
      out.structure = undefined;
      out.plain = -1;
      out.version = Number.NaN;
      out.group = undefined;
      out.blend = m.settings[0] === 2 || transmit;
      out.tinted = transmit && state?.blend === undefined;
      out.state = state;
      if (out.block?.length !== v.length) out.block = new Float32Array(v.length);
      out.block.set(v);
      return out;
    }
    const lighting = extension?.lighting !== false;
    if (shading || (mode !== 'gbuffer' && lighting && this.lighting.size)) {
      scratch.code = code;
      scratch.ambient = false;
      if (shading) patchDrawLighting.call(scratch, shading);
      const surface = scratch.code;
      // Effects with `pbr` hooks compose at gltf-pro's hook points; others (materials, LOD baking) still patch the text.
      if (mode !== 'gbuffer' && lighting) this.lighting.forEach(patchDrawLighting, scratch);
      if (shading?.lit) scratch.code = shading.lit(scratch.code);
      const patched = scratch.code,
        ambient = scratch.ambient;
      // An `ambient` hook (environment IBL) is what SSAO's ambient replay returns from the lit fragment, `_=color` keeping every
      // lighting binding in the layout. Unlit materials have no ambient.
      if (lit) code = patched;
      else if (mode === 'ambient' && ambient) {
        let replay = this.replays.get(patched);
        if (replay === undefined) {
          if (this.replays.size >= 64) this.replays.clear();
          this.replays.set(
            patched,
            (replay = patched.replace(
              'return vec4f(color,',
              compact
                ? `_=color;return vec4f(${coatedAmbient(extension, 'margoAmbient')},`
                : `_=color;return vec4f(select(${coatedAmbient(extension, 'margoAmbient')},vec3f(0),f.ext.x>0.5),`,
            )),
          );
        }
        code = replay;
        entry = 'fragment';
        lit = true;
      } else code = surface;
    }
    if (extension?.ambient || extension?.coat) code = materialExtensionAmbientShader(code, extension);
    if (transmission) code = transmissionPBR(code, oit!.declarations(2));
    else if (through) code = transparentPBR(code, oit!.declarations(2));
    else if (capture) code = capturePBR(code, hook!.declarations(code));
    // Instancing patches the vertex stage last, so text-patching effects (shader NodeMaterial vertex nodes) keep their anchors.
    if (inst) code = inst.shader(code);
    if (side === 'back' && !topology) code = backSideShader(code);
    if (m.shading?.texturedTint) code = texturedTintPBR(code);
    else if (surfaceTint(m)) code = surfaceTintPBR(code);
    if (mode === 'occlusion') {
      const rewritten = occlusionShader(code);
      // An appended occlusion fragment builds the plain surface: give it the extension's edits and bindings too.
      code = extension ? materialExtensionSurface(rewritten.code, extension) : rewritten.code;
      entry = rewritten.entry;
    }
    if (section) code = sectionShader(code, 0, 2);
    // Camera, light and target rows come from the shared view block (view-uniform.ts).
    code = viewShader(code);
    // An instanced batch sets the model rows to identity: a shader that reads them itself (beyond the instanced vertex
    // stage) needs each mesh's own draw.
    let modelFree = modelFreeCode.get(code);
    if (modelFree === undefined) {
      if (modelFreeCode.size >= 256) modelFreeCode.clear();
      modelFree = !/\bf\.(model|normalMatrix)\b/.test(code.replaceAll('let margoI=f.model*', ''));
      modelFreeCode.set(code, modelFree);
    }
    // A rows batch's instances each read their own uniform block (draw-batch.ts), patched into the finished shader
    // (after the model-row check, which reads its `f.` reads); a shader the patch cannot take draws per mesh.
    if (inst instanceof BatchKind && inst.rows) {
      const rows = rowsShader(code, rowsPerBinding(floatCount));
      if (rows) code = rows;
      else modelFree = false;
    }
    // Keep the shader's original front-facing convention, including mirrored transforms.
    // Mirrored instances flip winding per instance: no culling, the shader's face test discards back faces instead.
    const face = +(!topology && !!inst?.mirrored && flag !== 1),
      cull: GPUCullMode =
        !wireframe && flag !== 1 && !face ? (v[97] > 0 === (side === 'front') ? 'back' : 'front') : 'none';
    const state: PBRRenderState | undefined = mode === 'beauty' ? m.renderState : undefined;
    if (state) validateRenderState(state, c.descriptor.depthStencil!.format);
    // Shader text enters the key as a small id: the code strings are cached objects, so the lookup hashes them once.
    // Discard only where it can happen: back faces are culled by the pipeline and only MASK materials alpha-test.
    const mask = +(m.settings[0] === 1);
    let id = draws.codes.get(code);
    if (id === undefined) {
      if (draws.codes.size >= 256) draws.codes.clear();
      draws.codes.set(code, (id = draws.codeCount++));
    }
    const transmit = !compact && !!m.tint,
      blend = m.settings[0] === 2 || transmit,
      tinted = transmit && (mode === 'beauty' || mode === 'ambient') && state?.blend === undefined,
      stateKey = renderStateKey(state) + (external?.depthCompare ?? '') + (extension ? ':extension' : ''),
      samples = c.descriptor.multisample?.count,
      depthFormat = c.descriptor.depthStencil!.format;
    const key =
      mode +
      ':' +
      c.format +
      ':' +
      blend +
      transmit +
      ':' +
      cull +
      ':' +
      samples +
      ':' +
      depthFormat +
      ':' +
      entry +
      ':' +
      id +
      ':' +
      mask +
      stateKey +
      (inst ? ':i' + face + ':' + objectId(inst.layout) : '') +
      (topology ? ':' + topology : '') +
      (through || capture ? ':o' + objectId((through ? oit! : hook!).targets) : '') +
      (tinted && (shading?.texturedTint || surfaceTint(m)) ? ':t' : '');
    let pipeline = draws.pipelines.get(key);
    // A draw that may join an instanced batch derives without building its own pipeline or calling the lighting
    // bindings: the batch draws with its instanced variant (see `build`).
    if (!pipeline && build) {
      checkDrawLimits(c.device, code, m, transmission, this.lighting);
      const inputs = vertexInputs(code),
        module = c.device.createShaderModule({ code: inputs.code }),
        format = mode === 'beauty' ? c.format : 'rgba16float';
      const descriptor: GPURenderPipelineDescriptor = {
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: 80,
              attributes: inputs.locations.map((location) => ({
                shaderLocation: location,
                offset: location * 16,
                format: 'float32x4' as const,
              })),
            },
            ...(inst ? [inst.layout] : []),
          ],
        },
        fragment: {
          module,
          entryPoint: entry,
          constants: { margoFaceTest: face, margoAlphaTest: mask },
          targets:
            through || capture
              ? ((through ? oit! : hook!).targets as GPUColorTargetState[])
              : mode === 'occlusion'
                ? [
                    { format },
                    {
                      format,
                      blend: blend
                        ? {
                            color: transmit
                              ? { srcFactor: 'one', dstFactor: 'one' }
                              : { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                          }
                        : undefined,
                    },
                  ]
                : [
                    {
                      format,
                      ...(state?.colorWrite === false ? { writeMask: 0 } : {}),
                      blend:
                        state?.blend !== undefined
                          ? (state.blend ?? undefined)
                          : blend && mode !== 'gbuffer'
                            ? {
                                color: transmit
                                  ? { srcFactor: 'one', dstFactor: 'one' }
                                  : { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                              }
                            : undefined,
                    },
                  ],
        },
        multisample: c.descriptor.multisample,
        primitive: topology ? { topology } : { topology: 'triangle-list', cullMode: cull },
        depthStencil: {
          ...pipelineDepthState(
            state,
            !topology,
            external?.depthCompare === 'less' || external?.depthCompare === 'less-equal',
          ),
          format: c.descriptor.depthStencil!.format,
          depthWriteEnabled: state?.depthWrite ?? ((mode === 'beauty' || capture) && !blend),
          depthCompare:
            external?.depthCompare ??
            state?.depthCompare ??
            (mode === 'beauty' || through || capture ? 'greater-equal' : 'equal'),
        },
      };
      const view = code.includes('margoView.'),
        hold = (name: string, made: GPURenderPipeline) => {
          if (draws.pipelines.size >= 4096) draws.pipelines.clear();
          draws.pipelines.set(name, made);
          if (view) viewPipelines.add(made);
          return made;
        },
        // Off the frame (`compile`): a draw that reached this key first keeps its own pipeline.
        later = (name: string, wanted: GPURenderPipelineDescriptor) => {
          if (!scratch.compiling!.has(name))
            scratch.compiling!.set(
              name,
              c.device.createRenderPipelineAsync(wanted).then((made) => {
                if (!draws.pipelines.has(name)) hold(name, made);
              }),
            );
        };
      if (scratch.compiling) later(key, descriptor);
      else pipeline = hold(key, c.device.createRenderPipeline(descriptor));
      // Transmission's first draw: what is behind times the tint (no blend constant, see below).
      if (tinted) {
        const wanted: GPURenderPipelineDescriptor = {
          ...descriptor,
          // The tint only reads depth and stencil; the lit draw performs each requested write once.
          depthStencil: {
            ...descriptor.depthStencil!,
            depthWriteEnabled: false,
            ...(state && depthFormat.includes('stencil') ? { stencilWriteMask: 0 } : {}),
          },
          fragment: {
            module,
            entryPoint: 'margoTint',
            constants:
              m.shading?.texturedTint || surfaceTint(m) ? { margoFaceTest: face, margoAlphaTest: mask } : undefined,
            targets: [
              {
                format,
                ...(state?.colorWrite === false ? { writeMask: 0 } : {}),
                blend: {
                  color: { srcFactor: 'zero', dstFactor: 'src' },
                  alpha: { srcFactor: 'zero', dstFactor: 'one' },
                },
              },
            ],
          },
        };
        if (scratch.compiling) later(key + ':tint', wanted);
        else hold(key + ':tint', c.device.createRenderPipeline(wanted));
      }
    }
    if (scratch.compiling) return undefined!;
    const effectBindings = !!shading || (lit && ((lighting && this.lighting.size > 0) || through));
    const effect =
      effectBindings && build
        ? this.effectGroup(d, pipeline!, c, scratch, shading, lit && lighting, through ? oit : undefined)
        : undefined;
    const tint = tinted && build ? draws.pipelines.get(key + ':tint')! : undefined,
      mappedTint = !!shading?.texturedTint || surfaceTint(m),
      tintEffect = tintGroup(d, tint, mappedTint, effect, c.device);
    // The draw group is kept while the pipeline and group 2 are (`effectGroup` keeps the group object while its entries stay).
    const group =
      build && !inst ? (d?.group && d.pipeline === pipeline && d.effect === effect ? d.group : undefined) : undefined;
    const out: DrawDerivation = d ?? ({} as DrawDerivation);
    out.revision = revision;
    out.plain = plain;
    // The same conditions as keeping the pipeline (above): group 2 then holds only the shading hook's bindings. Read
    // again after `bindings()` ran, as in the kept path.
    out.version =
      build && !compact && !source && !m.extended && !frame.lighting.length && !through && !capture
        ? shading?.version
        : Number.NaN;
    out.shading = shading;
    out.renderState = m.renderState;
    out.structure = structure;
    out.frame = frame;
    out.source = p.extension;
    out.instances = inst;
    out.topology = topology;
    out.sign = sign;
    out.compact = compact;
    out.floatCount = floatCount;
    out.replacesTextures = r.replacesTextures!;
    out.extension = extension;
    out.pipeline = pipeline!;
    out.complete = build;
    out.tint = tint;
    out.tinted = tinted;
    out.blend = blend;
    out.state = state;
    out.effectBindings = effectBindings;
    out.effect = effect;
    out.tintEffect = tintEffect;
    out.mappedTint = mappedTint;
    out.modelFree = modelFree;
    out.tintable = tintableCode(code);
    out.group = build && !inst ? (group ?? drawGroup(draws, out)) : undefined;
    if (out.block?.length !== v.length) out.block = new Float32Array(v.length);
    out.block.set(v);
    return out;
  }
  /**
   * Writes node matrix `a` (rows 16-31) and its normal matrix, the inverse transpose (rows 32-47), into `v`. The rows
   * are kept on `r` and reused while the matrix stays the same: most meshes do not move between frames.
   */
  private nodeRows(r: DrawResource, a: ArrayLike<number>, v: Float32Array): void {
    const cache = (r.nodeCache ??= new Float32Array(32).fill(Number.NaN));
    let same = true;
    for (let i = 0; same && i < 16; i++) same = cache[i] === Math.fround(a[i]);
    if (!same) {
      if (!invertMatrixStable(a, this.inverse, this.workspace)) singular();
      for (let i = 0; i < 16; i++) {
        cache[i] = a[i];
        cache[16 + i] = this.inverse[(i % 4) * 4 + Math.floor(i / 4)];
      }
    }
    v.set(cache, 16);
  }
  /**
   * Group 2 of a draw of `pipeline`: the entries of the material's shading hook, then (`lit`) the model's lighting
   * effects, then (`through`) the transparency hook, gathered now. `d`'s group is kept when they are the same.
   */
  private effectGroup(
    d: DrawDerivation | undefined,
    pipeline: GPURenderPipeline,
    c: Context,
    scratch: DrawScratch,
    shading: PBRMaterialShading | undefined,
    lit: boolean,
    through: { bindings(): readonly GPUBindGroupEntry[] } | undefined,
  ): DrawDerivation['effect'] {
    const entries = scratch.entries,
      effects = scratch.effects;
    let entryCount = 0;
    scratch.effectCount = 0;
    if (shading) snapshotDrawLighting.call(scratch, shading);
    if (lit) this.lighting.forEach(snapshotDrawLighting, scratch);
    effects.length = scratch.effectCount;
    for (let i = 0; i < effects.length; i++) {
      const bindings = effects[i].bindings();
      for (let j = 0; j < bindings.length; j++) entries[entryCount++] = bindings[j];
    }
    if (through) {
      const bindings = through.bindings();
      for (let j = 0; j < bindings.length; j++) entries[entryCount++] = bindings[j];
    }
    entries.length = entryCount;
    let cached = d?.effect;
    let changed = !cached || d!.pipeline !== pipeline || entries.length !== cached.entries.length;
    for (let i = 0; !changed && i < entries.length; i++) {
      const entry = entries[i];
      const previous = cached!.entries[i],
        resource = entry.resource,
        old = previous.resource;
      changed =
        entry.binding !== previous.binding ||
        !(
          resource === old ||
          ('buffer' in resource &&
            'buffer' in old &&
            resource.buffer === old.buffer &&
            resource.offset === old.offset &&
            resource.size === old.size)
        );
    }
    if (changed) {
      const snapshot = entries.map(({ binding, resource }) => ({
        binding,
        resource:
          'buffer' in resource ? { buffer: resource.buffer, offset: resource.offset, size: resource.size } : resource,
      }));
      const group = pipelineGroup(c.device, pipeline, 2, snapshot);
      cached = { entries: snapshot, group };
    }
    return cached;
  }
  /** Isolated GPU resources for stereo eyes or another caller-owned WebGPU device. */
  createRenderer(device: GPUDevice): PBRDeviceRenderer {
    if (this.disposed || this.engine.disposed)
      throw margoError('disposed', 'PBRModel is disposed; load the model again');
    // GPU texture views supplied by callers cannot cross devices. Fail explicitly
    // rather than drawing a bind pose or silently omitting an extended surface.
    for (const primitive of [...this.primitives, ...this.pointsAndLines]) {
      if (primitive.material.shading && device !== this.engine.gpu)
        throw margoError('unsupported', 'Cross-device PBR rendering requires recreating local material shading');
      if ((primitive.extension ?? primitive.material.extension)?.textures?.length)
        throw margoError(
          'unsupported',
          'Cross-device PBR rendering requires recreating caller-owned material extension textures',
        );
    }
    const replica = Object.create(PBRModel.prototype) as PBRModel;
    Object.assign(replica, {
      name: this.name + ':device:' + modelId++,
      root: this.root,
      nodes: this.nodes,
      primitives: this.primitives.map((primitive) => ({
        ...primitive,
        instances: undefined,
        deformed: undefined,
        deformedOffset: undefined,
      })),
      asset: this.asset,
      images: this.images,
      disposed: false,
      created: [],
      resources: [],
      textures: [],
      inverse: new Float32Array(16),
      workspace: new Float64Array(52),
      engine: this.engine,
      cleanupCallbacks: new Set(),
      lighting: new Set(),
      lightingList: noLighting,
      gpuRevision: 0,
      gpuCache: new Map(),
      replays: new Map(),
      pointsAndLines: this.pointsAndLines.map((primitive) => ({
        ...primitive,
        instances: undefined,
        deformed: undefined,
      })),
      lights: this.lights,
      cameras: this.cameras,
      variants: this.variants,
      materials: this.materials,
      defaults: new Map(),
    });
    let deformation: PBRDeformationRenderer | undefined,
      factory = this.createDeformationRenderer;
    const projections = new Map<PBRInstances, PBRInstances>(),
      used = new Set<PBRInstances>();
    let mipSampler: GPUSampler | undefined;
    const synchronize = (sources: PBRPrimitive[], copies: PBRPrimitive[], offset: number) => {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i],
          copy = copies[i];
        if (source.material.shading && device !== this.engine.gpu)
          throw margoError('unsupported', 'Cross-device PBR rendering requires recreating local material shading');
        if ((source.extension ?? source.material.extension)?.textures?.length)
          throw margoError(
            'unsupported',
            'Cross-device PBR rendering requires recreating caller-owned material extension textures',
          );
        copy.extension = source.extension;
        if (copy.material !== source.material) {
          const previous = copy.material,
            resource = replica.resources[offset + i];
          copy.material = source.material;
          try {
            if (resource)
              replica.bindMaterial(
                resource,
                device,
                (mipSampler ??= device.createSampler({ minFilter: 'linear', magFilter: 'linear' })),
              );
          } catch (error) {
            copy.material = previous;
            throw error;
          }
        }
        copy.weights = source.weights;
        if (source.instances) {
          let projection = projections.get(source.instances);
          if (!projection) projections.set(source.instances, (projection = source.instances.createProjection()));
          copy.instances = projection;
          used.add(source.instances);
        } else copy.instances = undefined;
      }
    };
    const synchronizePrimitives = () => {
      used.clear();
      synchronize(this.primitives, replica.primitives, 0);
      synchronize(this.pointsAndLines, replica.pointsAndLines, this.primitives.length);
      for (const [source, projection] of projections)
        if (!used.has(source)) {
          projection.dispose();
          projections.delete(source);
        }
    };
    const release = () => {
      if (replica.disposed) return;
      replica.disposed = true;
      const cleanup = new Cleanup();
      cleanup
        .run(() => deformation?.dispose())
        .run(() => replica.releaseGPU())
        .run(() => {
          for (let i = replica.created.length - 1; i >= 0; i--) replica.created[i].dispose();
        });
      for (const projection of projections.values()) cleanup.run(() => projection.dispose());
      projections.clear();
      cleanup.finish();
    };
    try {
      synchronizePrimitives();
      replica.setup(this.engine, device);
      if (factory) deformation = factory(replica, device);
      else if (this.primitives.some((primitive) => primitive.deformed))
        throw margoError(
          'unsupported',
          'Cross-device deformed PBR rendering requires an isolated deformation renderer',
        );
      return deviceRenderer(
        device,
        (context) => {
          synchronizePrimitives();
          if (factory !== this.createDeformationRenderer || (factory && !deformation)) {
            deformation?.dispose();
            deformation = undefined;
            const next = this.createDeformationRenderer;
            factory = undefined;
            if (next) deformation = next(replica, device);
            factory = next;
          }
          if (!factory && this.primitives.some((primitive) => primitive.deformed))
            throw margoError(
              'unsupported',
              'Cross-device deformed PBR rendering requires an isolated deformation renderer',
            );
          deformation?.prepare(context);
        },
        (context, pass, view) =>
          replica.draw(context, 'beauty', context.color, context.depth, 'all', {
            pass,
            view,
            depthCompare: 'less-equal',
          }),
        release,
        (callback) => this.onDispose(callback),
      );
    } catch (error) {
      release();
      throw error;
    }
  }
  /** World-space visible point and spot lights for `clustered.setLights()`. Hidden ancestors hide their lights. Directional lights are left to engine lighting; an unset range ends where intensity/dÃ‚Â² reaches 1/256. */
  clusteredLights(): GLTFClusteredLight[] {
    this.engine.store.tick(false);
    return this.lights
      .filter((l) => l.type !== 'directional' && nodeVisible(this.engine, l.node))
      .map((l) => {
        const m = l.node.matrix,
          light: GLTFClusteredLight = {
            position: [m[12], m[13], m[14]],
            range: l.range ?? (Math.sqrt(l.intensity * 256) || 1),
            color: l.color as [number, number, number],
            intensity: l.intensity,
          };
        if (l.type === 'spot')
          Object.assign(light, {
            direction: [-m[8], -m[9], -m[10]],
            outerAngle: Math.min(l.outerConeAngle!, Math.PI / 2 - 1e-4),
            innerAngle: Math.min(l.innerConeAngle!, Math.PI / 2 - 1e-4),
          });
        return light;
      });
  }
  /** Every node whose glTF `extras` is an object, in node order, with its current world matrix: markers and spawn points placed in Blender. Mesh and material extras stay in `asset.doc.meshes[i].extras` and `asset.doc.materials[i].extras`. */
  extras(): GLTFNodeExtras[] {
    this.engine.store.tick(false);
    const out: GLTFNodeExtras[] = [];
    (this.asset.doc.nodes ?? []).forEach((def, i) => {
      const e = def.extras;
      if (e && typeof e === 'object' && !Array.isArray(e))
        out.push({
          node: this.nodes[i],
          nodeIndex: i,
          name: this.nodes[i].name,
          extras: e as Record<string, unknown>,
          matrix: this.nodes[i].matrix.slice(),
        });
    });
    return out;
  }
  onDispose(callback: () => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('Expected cleanup callback');
    if (this.disposed) {
      callback();
      return () => {};
    }
    this.cleanupCallbacks.add(callback);
    return () => this.cleanupCallbacks.delete(callback);
  }
  private releaseGPU(): void {
    this.gpuRevision++;
    const cleanup = new Cleanup(),
      buffers = new Map<{ destroy(): void }, GPUDevice>(),
      counted = new Map<GPUBuffer, GPUDevice>(),
      device = this.resources[0]?.device ?? this.engine.gpu;
    for (const r of this.resources) {
      if (r.batchStates)
        for (const list of r.batchStates.values())
          for (const state of list) {
            buffers.set(state.uniform, r.device);
            if (state.instances.buffer) buffers.set(state.instances.buffer, r.device);
          }
      r.batchStates = undefined;
      if (r.rowStates)
        for (const list of r.rowStates.values())
          for (const state of list) {
            if (state.rows.buffer) buffers.set(state.rows.buffer, r.device);
            if (state.instances.buffer) buffers.set(state.instances.buffer, r.device);
          }
      r.rowStates = undefined;
      for (const b of [r.wireframe?.index, r.uniform, r.extension?.uniform, r.volume]) if (b) buffers.set(b, r.device);
      for (const b of [r.vertex, r.index]) if (b) counted.set(b, r.device);
    }
    for (const [b, owner] of buffers) cleanup.run(() => retire(owner, b));
    // Each of this model's vertex and index buffers once, however many of its primitives draw from it.
    for (const [b, owner] of counted) cleanup.run(() => dropBuffer(owner, b));
    if (device) for (const t of this.textures) cleanup.run(() => dropTexture(device, t));
    for (const p of [...this.primitives, ...this.pointsAndLines]) {
      p.buffers = undefined;
      cleanup.run(() => p.instances?.dispose());
    }
    this.resources = [];
    this.textures = [];
    this.gpuCache.clear();
    cleanup.finish();
  }
  onDeviceRestored(engine: Engine): void {
    this.releaseGPU();
    for (const p of this.primitives) p.deformed = p.deformedOffset = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cleanup = new Cleanup();
    for (const node of this.created) {
      clearMeshSource(node);
      Reflect.deleteProperty(node, cpuSource);
    }
    this.lighting.clear();
    this.lightingList = noLighting;
    cleanup.run(() => this.engine.removePlugin(this.name)).run(() => this.engine.frameGraph.removeOwner(this.name));
    for (const callback of this.cleanupCallbacks) cleanup.run(callback);
    this.cleanupCallbacks.clear();
    cleanup.run(() => this.releaseGPU());
    for (let i = this.created.length - 1; i >= 0; i--) cleanup.run(() => this.created[i].dispose());
    cleanup.run(() => closeImages(this.images));
    cleanup.finish();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  /** @deprecated Use dispose(); kept as an alias until 1.0. */
  destroy(): void {
    this.dispose();
  }
}
const lookupShadowGetter = Reflect.get(Object.prototype, '__lookupGetter__') as (
  this: object,
  key: string,
) => (() => unknown) | undefined;
function capturePublicShadowGetter(model: typeof PBRModel): () => unknown {
  return Object.getOwnPropertyDescriptor(model.prototype, 'shadowPrimitives')!.get!;
}
const publicShadowGetter = /* @__PURE__ */ capturePublicShadowGetter(PBRModel);
/** Synchronous parse of in-memory JSON/GLB with decoded `images`; `decoders` takes only the synchronous `instancing` reader and the `materials` shaders; `maxNodes` as for loadGLTF. */
export function parseGLTF(
  instance: EngineKernel,
  input: string | object | ArrayBuffer | ArrayBufferView,
  buffers: Array<ArrayBuffer | ArrayBufferView> = [],
  images: readonly GLTFImage[] = [],
  decoders: Pick<GLTFDecoderHooks, 'instancing' | 'materials'> = {},
  { maxNodes }: Pick<AssetOptions, 'maxNodes'> = {},
): PBRModel {
  const { doc, binary } = container(input),
    model = new PBRModel(instance, new GLTFAsset(doc, buffers, binary, decoders, undefined, maxNodes), images);
  try {
    engineRuntime(instance).use(model);
    return model;
  } catch (error) {
    model.dispose();
    throw error;
  }
}
/** A static scene whose geometry is already packed (as @margoengine/blender's .margo); `maxNodes` as for loadGLTF. */
export function parsePreparedPBR(
  instance: EngineKernel,
  doc: GLTFAsset['doc'],
  geometry: readonly (readonly PreparedGeometry[])[],
  images: readonly GLTFImage[] = [],
  { maxNodes }: Pick<AssetOptions, 'maxNodes'> = {},
): PBRModel {
  checkDocument(doc);
  if (
    doc.buffers?.length ||
    doc.skins?.length ||
    doc.animations?.length ||
    doc.nodes?.some((n) => n.skin !== undefined) ||
    !Array.isArray(geometry) ||
    geometry.length !== doc.meshes?.length
  )
    throw new TypeError('Prepared PBR requires a static scene');
  const model = new PBRModel(instance, new GLTFAsset(doc, [], undefined, {}, undefined, maxNodes), images, geometry);
  try {
    engineRuntime(instance).use(model);
    return model;
  } catch (error) {
    model.dispose();
    throw error;
  }
}
/**
 * Fetches a glTF or GLB over HTTP(S), decodes it and attaches it to the engine as a PBRModel. Aborts with `options.signal`. @throws TypeError or RangeError when the file is malformed or over a limit.
 */
export async function loadGLTF(
  instance: EngineKernel,
  url: string | URL,
  options: GLTFLoadOptions = {},
): Promise<PBRModel> {
  return attach(
    instance,
    await loadAsset(
      url,
      {
        ...options,
        decoders: {
          ...options.decoders,
          ...(options.draco ? { draco: options.draco } : {}),
          ...(options.ktx2 ? { ktx2: options.ktx2 } : {}),
        },
      },
      undefined,
      { device: engineRuntime(instance).gpu ?? undefined, ktx2: options.ktx2 },
    ),
    options.signal,
  );
}
/**
 * Async in-memory JSON/GLB parsing, including Draco, meshopt and KTX2. With no third argument (or an options object),
 * decodes embedded images and resolves external URIs against the page. The positional buffers/images overload uses
 * supplied ordinary bitmaps; an undefined buffers argument keeps that overload when images or later options are passed.
 */
export async function parseGLTFAsync(
  instance: EngineKernel,
  input: string | object | ArrayBuffer | ArrayBufferView,
  buffersOrOptions?: Array<ArrayBuffer | ArrayBufferView> | (AssetOptions & CompressionOptions),
  images: readonly GLTFImage[] = [],
  options: GLTFLoadOptions = {},
): Promise<PBRModel> {
  if (buffersOrOptions === undefined) buffersOrOptions = arguments.length < 4 ? {} : [];
  if (!Array.isArray(buffersOrOptions)) {
    const config = buffersOrOptions;
    return attach(
      instance,
      await loadAsset(
        undefined,
        {
          ...config,
          decoders: {
            ...config.decoders,
            ...(config.draco ? { draco: config.draco } : {}),
            ...(config.ktx2 ? { ktx2: config.ktx2 } : {}),
          },
        },
        input,
        { device: engineRuntime(instance).gpu ?? undefined, ktx2: config.ktx2 },
      ),
      config.signal,
    );
  }
  options.signal?.throwIfAborted();
  const { doc, binary } = container(input, downloadLimit(options.maxDownloadBytes)),
    asset = new GLTFAsset(
      doc,
      buffersOrOptions ?? [],
      binary,
      await withMaterials(doc, options.decoders),
      options.maxDownloadBytes,
      options.maxNodes,
    );
  // The Draco module (and its decoder) loads only for files that use KHR_draco_mesh_compression.
  if (hasDraco(asset))
    await (await import('./compression.js')).decompressPrimitives(asset, {
      ...options,
      draco: options.draco ?? options.decoders?.draco,
    });
  else options.signal?.throwIfAborted();
  images = await decodeKTX2Images(asset, images ?? [], {
    ...options,
    ktx2: options.ktx2 ?? options.decoders?.ktx2,
    device: engineRuntime(instance).gpu ?? undefined,
  });
  return attach(instance, { asset, images: images as GLTFImage[] }, options.signal);
}
const importedSun = new WeakMap<
  Engine,
  {
    owner: WeakRef<PBRModel>;
    baseline: Float32Array;
    applied: Float32Array;
  }
>();
const sunState = (engine: Engine): Float32Array =>
  Float32Array.from([...engine.lighting.direction, ...engine.lighting.radiance.subarray(0, 3)]);
/**
 * Applies a model's KHR_lights_punctual lights in one call. The first visible directional light becomes the engine's light
 * (`engine.lighting`: direction toward the light, its colour, and its lux x `exposure` as the strength; core's default
 * strength is 3 and core has one directional light, so further ones are ignored). Point and spot lights go to `clustered`
 * (@margoengine/clustered, candela x `exposure`), which then lights the model; without it they are ignored. Lights are
 * placed where their nodes are now: after moving the model, call `clustered.setLights(model.clusteredLights())` (or this
 * again for the sun). Reapply after changing light visibility. If this model owns the last imported sun and none of its
 * directional lights remain visible, restores the lighting from before imported suns were applied, unless the caller
 * changed it afterward. The most recently applied model owns the sun; no other model is selected automatically.
 * Call once per clustered instance; returns the remover from `clustered.add` (a no-op without one).
 */
export function applyGLTFLights(
  model: PBRModel,
  { clustered, exposure = 1 }: { clustered?: GLTFLightReceiver; exposure?: number } = {},
): () => void {
  if (!Number.isFinite(exposure) || exposure < 0)
    throw new RangeError('applyGLTFLights: exposure must be a finite number >= 0');
  const engine = model['engine'],
    sun = model.lights.find((l) => l.type === 'directional' && nodeVisible(engine, l.node));
  const previous = importedSun.get(engine),
    current = sunState(engine),
    unchanged = previous?.applied.every((value, index) => value === current[index]);
  if (sun) {
    engine.store.tick(false);
    const m = sun.node.matrix,
      length = Math.hypot(m[8], m[9], m[10]) || 1;
    engine.lighting.direction.set([m[8] / length, m[9] / length, m[10] / length, sun.intensity * exposure]);
    engine.lighting.radiance.set(sun.color);
    importedSun.set(engine, {
      owner: new WeakRef(model),
      baseline: unchanged ? previous!.baseline : current,
      applied: sunState(engine),
    });
  } else if (previous?.owner.deref() === model) {
    if (unchanged) {
      engine.lighting.direction.set(previous.baseline.subarray(0, 4));
      engine.lighting.radiance.set(previous.baseline.subarray(4));
    }
    importedSun.delete(engine);
  }
  if (!clustered) return () => {};
  const lights = model.clusteredLights();
  for (const light of lights) light.intensity *= exposure;
  clustered.setLights(lights);
  return clustered.add(model);
}
const orthographic = new WeakSet<object>();
/**
 * Views through one of the model's glTF cameras (`model.cameras[camera]`, default the first) with the engine camera:
 * position, view direction and up from the camera node's world matrix now. Perspective: `yfov` and `znear`, `zfar` when
 * set (else the camera keeps its `far`), with the canvas aspect. Orthographic: `ymag`, `znear` and `zfar` through
 * `camera.project`, the width following the canvas aspect; a later perspective camera removes that projection. The target
 * is 1 unit ahead, so orbit controls turn the view around that point (call their `saveState()` afterwards).
 */
export function viewGLTFCamera(model: PBRModel, camera: number | GLTFCamera = 0): void {
  const def = typeof camera === 'number' ? model.cameras[camera] : camera;
  if (!def)
    throw new RangeError(
      `viewGLTFCamera: the model has no glTF camera ${camera}; pass an index below the camera count`,
    );
  const engine = model['engine'],
    view = engine.camera;
  engine.store.tick(false);
  const m = def.node.matrix,
    z = Math.hypot(m[8], m[9], m[10]) || 1,
    y = Math.hypot(m[4], m[5], m[6]) || 1;
  view.position = [m[12], m[13], m[14]];
  view.target = [m[12] - m[8] / z, m[13] - m[9] / z, m[14] - m[10] / z];
  view.up = [m[4] / y, m[5] / y, m[6] / y];
  if (def.type === 'perspective') {
    const p = def.perspective!;
    view.fov = (p.yfov * 180) / Math.PI;
    view.near = p.znear;
    if (p.zfar !== undefined) view.far = p.zfar;
    if (view.project && orthographic.has(view.project)) view.project = undefined;
  } else {
    const { ymag, znear: near, zfar: far } = def.orthographic!,
      depth = far - near;
    view.near = near;
    view.far = far;
    // Column-major; WebGPU depth is reversed (near 1, far 0) like core's perspective.
    view.project = (out, aspect, webgpu) => {
      out[0] = 1 / (Math.abs(ymag) * aspect);
      out[5] = 1 / Math.abs(ymag);
      out[10] = webgpu ? 1 / depth : -2 / depth;
      out[14] = webgpu ? far / depth : -(far + near) / depth;
      out[15] = 1;
    };
    orthographic.add(view.project);
  }
}
function attach(
  instance: EngineKernel,
  { asset, images }: { asset: GLTFAsset; images: GLTFImage[] },
  signal?: AbortSignal,
): PBRModel {
  let model: PBRModel | undefined;
  try {
    signal?.throwIfAborted();
    model = new PBRModel(instance, asset, images);
    engineRuntime(instance).use(model);
    return model;
  } catch (error) {
    if (model) model.dispose();
    else closeImages(images);
    throw error;
  }
}
