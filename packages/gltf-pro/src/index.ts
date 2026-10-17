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
import { viewMatrix } from '../../shared/view.js';
import { Cleanup } from '../../shared/cleanup.js';
import type { PBRSource } from '../../shared/pbr-source.js';
import { setMeshSource, clearMeshSource, type MeshSource } from '../../shared/mesh-source.js';
import { shadowPrimitivesInto } from '../../shared/shadow-source.js';
import {
  GLTFAsset,
  container,
  loadAsset,
  closeImages,
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
  type ExtendedPlan,
  type PBRLighting,
  type PBRTransparency,
  type PBRCapture,
  type PBRTransmission,
} from './shader.js';
import { lightPBR } from '../../shared/pbr-hooks.js';
export type { PBRLighting, PBRTransparency, PBRCapture, PBRTransmission, ExtendedPlan } from './shader.js';
import { createKTX2Texture, getBytesPerRow, type TranscodedKTX2Result } from '@margoengine/decoders';
import { mipShader } from './mip.js';
import {
  prepareMaterialExtension,
  materialExtensionShader,
  materialExtensionAmbientShader,
  bindMaterialExtension,
  type MaterialExtension,
  type MaterialExtensionResource,
} from './material-extension.js';
import { decompressPrimitives, type GLTFLoadOptions as CompressionOptions } from './compression.js';
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
export { GLTFAsset } from './asset.js';
export type { GLTFDocument } from './asset.js';
export type { GLTFImage, KTX2Image } from './asset.js';
export { textureCoordinates } from './texture-coordinates.js';
import type { TextureTransform } from './texture-coordinates.js';
export type { TextureTransform } from './texture-coordinates.js';

export type { MaterialExtension, MaterialExtensionTexture } from './material-extension.js';
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
export type GLTFLoadOptions = Omit<AssetOptions, 'buffers'> & CompressionOptions;
const srgbMaps = [0, 4, 9, 12, 17],
  normalMaps = [2, 7],
  blended = (m: PBRMaterial) => m.settings[0] === 2 || (!!m.tint && !m.extension?.replacesPhysical);
// An extended material's binding plan, by material object (progressive loading swaps in copies with fewer maps).
const plans = new WeakMap<object, ExtendedPlan>();
const planOf = (m: PBRMaterial, x: GLTFExtendedMaterials): ExtendedPlan => {
  let plan = plans.get(m);
  if (!plan) plans.set(m, (plan = x.plan(m.maps, m.extended!)));
  return plan;
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
  transmits = (m: PBRMaterial) => !!m.tint && !m.renderState && !m.extension?.replacesPhysical;
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
export interface PBRPickingGeometry {
  node: Mesh;
  vertices: Float32Array;
  indices: Uint32Array;
  doubleSided: boolean;
  side?: MaterialSide;
  matrix: Float32Array;
}
const opaquePasses = new WeakMap<Context, Set<PBRModel>>();
// A symbol keeps separately bundled optional consumers interoperable without
// importing the loader or attaching a second drawable core Geometry.
const cpuSource = Symbol.for('margoengine.pbr-source.v1');
export type MaterialSide = 'front' | 'back' | 'double';
const sideOf = (m: PBRMaterial): MaterialSide =>
  m.side ?? (m.settings[2] === 2 ? 'back' : m.settings[2] >= 0.5 ? 'double' : 'front');
const sideFlag = (side: MaterialSide): number => (side === 'double' ? 1 : side === 'back' ? 2 : 0);
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
  volume?: number[];
  renderState?: PBRRenderState;
  extension?: MaterialExtension;
  /** Per-material surface shader and bindings, composed before model-wide lighting effects. */
  shading?: PBRMaterialShading;
  /** Use the retained UV-transform frame layout for constructed optional materials. */
  extendedFrame?: boolean;
}
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
  deformed?: GPUBuffer;
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
export function validatePreparedGeometry(data: PreparedGeometry): void {
  const { vertices, indices } = data,
    count = vertices?.length / 20;
  if (
    !(vertices instanceof Float32Array) ||
    !(indices instanceof Uint32Array) ||
    !Number.isInteger(count) ||
    count < 3 ||
    count > 1_000_000 ||
    !indices.length ||
    indices.length % 3
  )
    throw new RangeError('Invalid prepared PBR geometry');
  for (let i = 0; i < indices.length; i++)
    if (indices[i] >= count) throw new RangeError('Invalid prepared PBR geometry');
  for (let i = 0; i < vertices.length; i++)
    if (!Number.isFinite(vertices[i])) throw new RangeError('Non-finite prepared PBR vertex');
  for (let i = 0; i < vertices.length; i += 20) {
    const sign = vertices[i + 11];
    if (
      vertices[i + 3] !== 1 ||
      vertices[i + 7] !== 0 ||
      Math.abs(Math.hypot(vertices[i + 4], vertices[i + 5], vertices[i + 6]) - 1) > 1e-3 ||
      (sign !== 0 && sign !== -1 && sign !== 1)
    )
      throw new RangeError('Invalid prepared PBR normal/tangent');
    if (vertices[i + 11] && Math.abs(Math.hypot(vertices[i + 8], vertices[i + 9], vertices[i + 10]) - 1) > 1e-3)
      throw new RangeError('Invalid prepared PBR tangent');
    for (let c = 16; c < 20; c++)
      if (vertices[i + c] < 0 || vertices[i + c] > 1) throw new RangeError('Invalid prepared PBR color');
  }
}
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
  if (!m) throw new TypeError('Missing prepared PBR material');
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
  uniform: GPUBuffer;
  volume?: GPUBuffer;
  /** Float32 copy of `material.volume`, reused so a transmission draw does not allocate. */
  volumeData?: Float32Array;
  /** Buffer that `volumeData` was last written to. A new buffer uploads again. */
  volumeWritten?: GPUBuffer;
  values: Float32Array;
  groups: Map<GPURenderPipeline, GPUBindGroup[]>;
  sectionBuffer?: GPUBuffer;
  views: GPUTextureView[];
  samplers: GPUSampler[];
  replacesTextures?: boolean;
  extension?: MaterialExtensionResource;
  coordinates?: CoordinateExtension;
  pipelineHistories?: Map<string, DrawPipelineState[]>;
  /** Set on a static part while its material batch can replace it. */
  mergedInto?: DrawResource;
  /** Set on the one resource that draws a material batch. */
  batch?: StaticBatch;
}
interface ShadowCasterRecord {
  primitive: PBRPrimitive;
  node: Mesh;
  vertex: GPUBuffer;
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
  dynamic: boolean;
}
// Keep the original triangle buffer for queries and exports. Duplicate shared
// edges deliberately: transparent triangle wireframes blend each edge twice.
function wireframeIndices(r: DrawResource): DrawResource['wireframe'] {
  const p = r.primitive,
    flag = p.material.wireframe;
  if (flag !== undefined && typeof flag !== 'boolean')
    throw new TypeError('PBR material wireframe must be a boolean; set wireframe to true or false');
  if (!flag || p.topology) return;
  if (r.wireframe) return r.wireframe;
  const size = p.indices.byteLength * 2;
  if (size > r.device.limits.maxBufferSize)
    throw new RangeError('PBR wireframe buffer exceeds the device limit; split the geometry into smaller meshes');
  const indices = new Uint32Array(p.indices.length * 2);
  for (let i = 0, j = 0; i < p.indices.length; i += 3) {
    const a = p.indices[i],
      b = p.indices[i + 1],
      c = p.indices[i + 2];
    indices[j++] = a;
    indices[j++] = b;
    indices[j++] = b;
    indices[j++] = c;
    indices[j++] = c;
    indices[j++] = a;
  }
  const index = r.device.createBuffer({ size, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  try {
    r.device.queue.writeBuffer(index, 0, indices);
  } catch (error) {
    index.destroy();
    throw error;
  }
  return (r.wireframe = { index, count: indices.length });
}
function fillShadow(r: DrawResource, value: ShadowCasterRecord): void {
  const p = r.primitive,
    m = p.material,
    wireframe = wireframeIndices(r),
    coordinates = m.maps[0] ? textureCoordinates(m.maps[0]) : undefined;
  value.primitive = p;
  value.node = p.node;
  value.vertex = p.deformed ?? r.vertex;
  value.index = wireframe?.index ?? r.index;
  value.count = wireframe?.count ?? p.indices.length;
  if (wireframe) value.topology = 'line-list';
  else delete value.topology;
  value.stride = 80;
  value.alphaTexture = r.views[0];
  value.alphaSampler = r.samplers[0];
  value.alpha = m.base[3];
  value.cutoff = m.settings[0] === 1 ? m.settings[1] : 0;
  value.texCoord = m.maps[0] ? textureCoordinates(m.maps[0]).texCoord : 0;
  if (m.maps[0]?.extensions?.KHR_texture_transform) value.alphaTransform = coordinates?.transform;
  else delete value.alphaTransform;
  value.instances = p.instances;
  value.dynamic =
    !r.batch &&
    (p.definition.attributes?.JOINTS_0 !== undefined ||
      !!p.definition.targets?.length ||
      !!p.instances ||
      !!p.deformed);
}
// Remember the complete existing pipeline key per draw mode. The shader and
// every mutable state field are still read each draw, but unchanged materials
// need not build the same chain of temporary strings for every primitive.
interface DrawPipelineState {
  format: GPUTextureFormat;
  blend: boolean;
  transmit: boolean;
  cull: GPUCullMode;
  samples: number | undefined;
  depth: GPUTextureFormat;
  entry: string;
  code: number;
  mask: number;
  state: string;
  instanced: boolean;
  face: number;
  topology: GPUPrimitiveTopology | undefined;
  key: string;
  pipeline: GPURenderPipeline;
}
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
function createDrawGroups(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  r: DrawResource,
  m: PBRMaterial,
  transmission: boolean,
  hooks: GLTFExtendedMaterials | undefined,
  section?: GPUBuffer,
): GPUBindGroup[] {
  return [
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: r.uniform } },
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
    }),
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(1),
      entries: r.views.flatMap((view, i) => {
        const binding = i < 5 || !m.extended ? i * 2 : 10 + planOf(m, hooks!).slots[i] * 2;
        return view && (!(r.primitive.extension ?? m.extension)?.replacesPhysical || i < 5)
          ? [
              { binding, resource: view },
              { binding: binding + 1, resource: r.samplers[i] },
            ]
          : [];
      }),
    }),
  ];
}
interface DrawScratch {
  context?: Context;
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
function createDrawScratch(color: GPUTextureView, depth: GPUTextureView): DrawScratch {
  const attachment: GPURenderPassColorAttachment = { view: color, loadOp: 'load', storeOp: 'store' };
  const depthAttachment: GPURenderPassDepthStencilAttachment = {
    view: depth,
    depthLoadOp: 'load',
    depthStoreOp: 'store',
  };
  const scratch: DrawScratch = {
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
      const blendA = blended(a.primitive.material),
        blendB = blended(b.primitive.material);
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
  if (!target) throw new TypeError('Unsupported KTX2 texture format ' + image.format);
  const format = (base + (srgb ? '-srgb' : '')) as GPUTextureFormat;
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    !image.mipmaps.length ||
    image.mipmaps.length > Math.floor(Math.log2(Math.max(image.width, image.height))) + 1
  )
    throw new RangeError('Invalid compressed image dimensions');
  const block = target === 'rgba8' ? 1 : 4;
  const mipmaps = image.mipmaps.map((m, level) => {
    const width = Math.max(1, image.width >> level),
      height = Math.max(1, image.height >> level),
      byteLength = getBytesPerRow(format, width) * Math.ceil(height / block);
    if (m.width !== width || m.height !== height || !(m.data instanceof Uint8Array) || m.data.byteLength !== byteLength)
      throw new RangeError('Invalid compressed image mip');
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
    throw new TypeError('Invalid glTF ' + label);
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
  if (!['OPAQUE', 'MASK', 'BLEND'].includes(alpha)) throw new TypeError('Invalid glTF alpha mode');
  if (def.doubleSided !== undefined && typeof def.doubleSided !== 'boolean')
    throw new TypeError('Invalid glTF doubleSided');
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
      if (!['front', 'back', 'double'].includes(value)) throw new TypeError('Invalid material side');
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
    tint: transmission ? base.slice(0, 3).map((v, i) => v * transmission * attenuation[i] ** depth) : undefined,
    // Transmission hook only: thickness (mesh space) and transmittance per world unit, attenuationColor^(1/attenuationDistance).
    volume: transmission ? [thickness, ...attenuation.map((c) => c ** (1 / distance))] : undefined,
  };
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
  let g = packed.get(p) ?? packs.get(p);
  if (!g) packs.set(p, (g = packPrimitive(asset, p)));
  const { vertices, indices } = g;
  const m = fit(
    asset,
    p,
    p.material === undefined ? material() : materials[integer(p.material, 'material')],
    !!g.topology,
  );
  const targets = p.targets ?? [];
  if (!Array.isArray(targets)) throw new TypeError('Invalid morph targets');
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
  if (!m) throw new TypeError('Missing glTF material');
  const a = p.attributes ?? {};
  for (const map of m.maps)
    if (map) {
      const set = integer(map.texCoord ?? 0, 'texture coordinate');
      if (set > 1 || a[set === 0 ? 'TEXCOORD_0' : 'TEXCOORD_1'] === undefined)
        throw new Error('Material requires available TEXCOORD_0 or TEXCOORD_1');
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
      throw new TypeError('Invalid glTF affine matrix');
    const scale = [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])];
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    scale[0] *= Math.sign(det);
    if (scale.some((v) => v === 0)) throw new RangeError('Singular glTF matrix');
    const r = Array.from({ length: 9 }, (_, i) => m[Math.floor(i / 3) * 4 + (i % 3)] / scale[Math.floor(i / 3)]);
    for (const [a, b] of [
      [0, 3],
      [0, 6],
      [3, 6],
    ])
      if (Math.abs(r[a] * r[b] + r[a + 1] * r[b + 1] + r[a + 2] * r[b + 2]) > 1e-5)
        throw new Error('Sheared matrices are unsupported');
    const trace = r[0] + r[4] + r[8];
    let q: number[];
    if (trace > 0) {
      const s = 2 * Math.sqrt(trace + 1);
      q = [(r[5] - r[7]) / s, (r[6] - r[2]) / s, (r[1] - r[3]) / s, s / 4];
    } else {
      const k = r[0] > r[4] && r[0] > r[8] ? 0 : r[4] > r[8] ? 1 : 2,
        s = 2 * Math.sqrt(1 + r[k * 4] - r[((k + 1) % 3) * 4] - r[((k + 2) % 3) * 4]);
      q = [0, 0, 0, 0];
      q[k] = s / 4;
      const a = (k + 1) % 3,
        b = (k + 2) % 3;
      q[a] = (r[a * 3 + k] + r[k * 3 + a]) / s;
      q[b] = (r[b * 3 + k] + r[k * 3 + b]) / s;
      q[3] = (r[a * 3 + b] - r[b * 3 + a]) / s;
    }
    node
      .setPosition([m[12], m[13], m[14]])
      .setScale(scale as [number, number, number])
      .setQuaternion(q);
  } else
    node
      .setPosition((def.translation ?? [0, 0, 0]) as [number, number, number])
      .setScale((def.scale ?? [1, 1, 1]) as [number, number, number])
      .setQuaternion(def.rotation ?? [0, 0, 0, 1]);
}
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
  private pipelines = new Map<string, GPURenderPipeline>();
  private readonly gpuCache = new Map<unknown, GPUBuffer | GPUTexture | GPURenderPipeline>();
  private readonly inverse = new Float32Array(16);
  private readonly workspace = new Float64Array(52);
  private readonly view = new Float32Array(16);
  /** Material batches baked once. Device restore uploads them again and keeps the same nodes. */
  private staticBatches?: StaticBatch[];
  private relative?: Float32Array;
  private engine: Engine;
  private readonly cleanupCallbacks = new Set<() => void>();
  private readonly lighting = new Set<LightingEffect>();
  private readonly codes = new Map<string, number>();
  private codeCount = 0;
  private readonly replays = new Map<string, string>();
  private readonly lightingGroups = new Map<GPURenderPipeline, { entries: GPUBindGroupEntry[]; group: GPUBindGroup }>();
  private gpuRevision = 0;
  private readonly drawScratch: DrawScratch[] = [];
  private drawDepth = 0;
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
      materials = (this.materials = (doc.materials ?? []).map((def) => material(def, asset.hooks.materials)));
    const variants = doc.extensions?.KHR_materials_variants?.variants ?? [];
    if (!Array.isArray(variants) || variants.some((v) => typeof v?.name !== 'string'))
      throw new TypeError('Invalid glTF material variants');
    this.variants = variants.map((v) => v.name);
    defs.forEach((def, id) => {
      if (!def || (def.children !== undefined && !Array.isArray(def.children)))
        throw new TypeError('Invalid glTF node');
      for (const child of def.children ?? []) {
        const c = integer(child, 'child');
        if (c >= defs.length || parents[c] !== -1 || c === id) throw new Error('Invalid glTF hierarchy');
        parents[c] = id;
      }
    });
    for (let i = 0; i < defs.length; i++) {
      let depth = 0;
      for (let p = i; p !== -1; p = parents[p])
        if (++depth > 62) throw new Error('glTF hierarchy cycle or depth limit');
    }
    const roots = doc.scenes
      ? (entry(doc.scenes, doc.scene ?? 0, 'scene').nodes ?? [])
      : defs.map((_: unknown, i: number) => i).filter((i: number) => parents[i] === -1);
    if (
      !Array.isArray(roots) ||
      new Set(roots).size !== roots.length ||
      roots.some((i) => parents[integer(i, 'scene root')] !== -1)
    )
      throw new TypeError('Invalid scene roots');
    const active = new Set<number>(),
      visit = (id: number) => {
        entry(defs, id, 'node');
        active.add(id);
        for (const c of defs[id].children ?? []) visit(c);
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
        transform(node, defs[i]);
      }
      for (let i = 0; i < defs.length; i++)
        this.nodes[i].setParent(parents[i] < 0 ? this.root : this.nodes[parents[i]]);
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
            throw new TypeError('Invalid glTF light');
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
            throw new TypeError('Invalid glTF camera');
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
        throw new Error(
          'Required glTF extensions are unsupported: EXT_mesh_gpu_instancing (pass decoders.instancing from @margoengine/gltf-pro/instancing)',
        );
      for (const i of active)
        if (defs[i].mesh !== undefined) {
          const mesh = entry(doc.meshes, defs[i].mesh, 'mesh');
          if (!Array.isArray(mesh.primitives) || !mesh.primitives.length) throw new TypeError('Missing primitives');
          if (prepared && prepared[defs[i].mesh]?.length !== mesh.primitives.length)
            throw new TypeError('Missing prepared PBR primitives');
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
      if (!this.primitives.length && !this.pointsAndLines.length) throw new Error('glTF contains no renderable meshes');
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
    if (this.disposed) throw new Error('PBRModel is disposed');
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
    if (!Number.isFinite(out[0])) throw new Error('No geometry');
    return out;
  }
  /** Borrowed GPU buffers, preserving one record per primitive and current deformation. */
  get raw() {
    return this.pickingPrimitives.filter((p) => this.engine.meshes.get(p.node.id) === p.node);
  }
  private bufferUpload(device: GPUDevice): (data: Float32Array | Uint32Array, usage: number) => GPUBuffer {
    const cache = this.gpuCache;
    return (data, usage) => {
      const existing = cache.get(data) as GPUBuffer | undefined;
      if (existing) return existing;
      if (data.byteLength > device.limits.maxBufferSize) throw new RangeError('PBR buffer exceeds device limit');
      const b = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      try {
        device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
      } catch (e) {
        b.destroy();
        throw e;
      }
      cache.set(data, b);
      return b;
    };
  }
  setup(engine: Engine, device = engine.gpu): void {
    if (engine !== this.engine || this.disposed) throw new Error('PBRModel belongs to another engine or is disposed');
    if (!device) throw new Error('PBRModel requires WebGPU');
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
      r.vertex = upload(p.vertices, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
      r.index = upload(p.indices, GPUBufferUsage.INDEX);
      p.buffers = { vertex: r.vertex, index: r.index };
      this.bindMaterial(r, device, mipSampler);
    }
    this.installBatches(device, mipSampler, upload);
  }
  /** Bakes static same-material triangles once the asset's geometry and instances are final. */
  private commitStaticBatches(): void {
    const host = this.asset as GLTFAsset & { [deferStaticBatches]?: StaticBatchDeferral };
    delete host[deferStaticBatches];
    if (this.disposed || this.staticBatches !== undefined) return;
    const device = this.engine.gpu;
    if (!device) throw new Error('PBRModel requires WebGPU');
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
      this.engine.store.tick(false);
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
  /** True while every baked part still has the captured root-relative pose, material, and visibility. */
  private pose(batch: StaticBatch): boolean {
    this.relative ??= new Float32Array(16);
    if (!invertMatrixStable(this.root.matrix, this.inverse, this.workspace)) return false;
    const relative = this.relative,
      store = this.engine.store;
    for (let i = 0; i < batch.parts.length; i++) {
      const part = batch.parts[i],
        primitive = part.primitive;
      if (
        primitive.material !== batch.material ||
        primitive.deformed ||
        primitive.instances ||
        primitive.topology ||
        primitive.vertices !== part.vertices ||
        primitive.indices !== part.indices
      )
        return false;
      for (let id = primitive.node.id; id !== -1; id = store.parents[id]) if (store.hidden[id]) return false;
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
      if (r.batch || r.primitive.node !== node || r.primitive.material.settings[0] === 2 || r.primitive.topology)
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
      r.uniform?.destroy();
      r.values = new Float32Array(floats);
      r.uniform = device.createBuffer({ size: floats * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    r.views = [];
    r.samplers = [];
    r.groups.clear();
    r.replacesTextures = !!m.shading?.replacesTextures;
    if (r.replacesTextures) return;
    for (let i = 0; i < m.maps.length; i++) {
      if (!ownSlot(m, i, this.asset.hooks.materials)) {
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
      if (def && !image) throw new TypeError('Missing decoded glTF image');
      const compressed = image && 'ktx2' in image ? image.ktx2 : image && 'mipmaps' in image ? image : undefined,
        format = compressed
          ? ((compressed.format.replace(/-srgb$/, '') + (srgbMaps.includes(i) ? '-srgb' : '')) as GPUTextureFormat)
          : srgbMaps.includes(i)
            ? 'rgba8unorm-srgb'
            : 'rgba8unorm',
        size = image ? [image.width, image.height] : [1, 1];
      if (size.some((n) => n > device.limits.maxTextureDimension2D)) throw new RangeError('Image exceeds device limit');
      const key = image ? source + ':' + format : 'default:' + i;
      let texture = cache.get(key) as GPUTexture | undefined;
      if (!texture && compressed) {
        texture = uploadCompressedImage(device, compressed, srgbMaps.includes(i));
        this.textures.push(texture);
        cache.set(key, texture);
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
        this.textures.push(texture);
        cache.set(key, texture);
        // Transcoded mips upload as-is: rgba8 rows, or 16-byte 4x4 blocks (BC7, ASTC 4x4, ETC2 RGBA8).
        if (image) device.queue.copyExternalImageToTexture({ source: image as ImageBitmap }, { texture }, size);
        else
          device.queue.writeTexture(
            { texture },
            new Uint8Array(normalMaps.includes(i) ? [128, 128, 255, 255] : [255, 255, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1],
          );
        if (levels > 1 && !compressed) {
          let pipeline = cache.get(format) as GPURenderPipeline | undefined;
          if (!pipeline) {
            const module = device.createShaderModule({ code: mipShader });
            pipeline = device.createRenderPipeline({
              layout: 'auto',
              vertex: { module, entryPoint: 'vertex' },
              fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
            });
            cache.set(format, pipeline);
          }
          const encoder = device.createCommandEncoder();
          for (let level = 1; level < levels; level++) {
            const group = device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [
                { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
                { binding: 1, resource: mipSampler },
              ],
            });
            const pass = encoder.beginRenderPass({
              colorAttachments: [
                {
                  view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
                  loadOp: 'clear',
                  storeOp: 'store',
                  clearValue: { r: 0, g: 0, b: 0, a: 0 },
                },
              ],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.draw(3);
            pass.end();
          }
          device.queue.submit([encoder.finish()]);
        }
      }
      r.views.push(texture.createView());
      const s = def?.sampler === undefined ? {} : entry(this.asset.doc.samplers, def.sampler, 'sampler');
      const wrap = (v: unknown) => {
        if (v === undefined || v === 10497) return 'repeat';
        if (v === 33071) return 'clamp-to-edge';
        if (v === 33648) return 'mirror-repeat';
        throw new TypeError('Invalid texture wrapping');
      };
      if (
        (s.magFilter !== undefined && ![9728, 9729].includes(s.magFilter)) ||
        (s.minFilter !== undefined && ![9728, 9729, 9984, 9985, 9986, 9987].includes(s.minFilter!))
      )
        throw new TypeError('Invalid texture filter');
      r.samplers.push(
        device.createSampler({
          addressModeU: wrap(s.wrapS),
          addressModeV: wrap(s.wrapT),
          magFilter: s.magFilter === 9728 ? 'nearest' : 'linear',
          minFilter: [9728, 9984, 9986].includes(s.minFilter!) ? 'nearest' : 'linear',
          mipmapFilter: [9984, 9985].includes(s.minFilter!) ? 'nearest' : 'linear',
          lodMaxClamp: [9728, 9729].includes(s.minFilter!) ? 0 : 32,
        }),
      );
    }
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: 1,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c, 'beauty', c.color, c.depth);
      },
    });
  }
  /** Borrow a decoded image for optional material packages; the model owns its lifetime. */
  image(index: number): Exclude<GLTFImage, undefined> {
    if (this.disposed) throw new Error('PBRModel is disposed');
    const image = this.images[integer(index, 'image')];
    if (!image) throw new TypeError('Missing decoded glTF image');
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
      throw new TypeError('Invalid PBR lighting effect');
    if (effect.owner && effect.owner !== this.engine) throw new Error('PBR lighting belongs to another engine');
    this.lighting.add(effect);
    return () => this.lighting.delete(effect);
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
      throw new TypeError('Invalid PBR transparency hook');
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
      throw new TypeError('Invalid PBR capture hook');
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
      throw new TypeError('Invalid PBR transmission hook');
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
      throw new RangeError(`selectVariant: the model has no material variant ${variant}`);
    // Every material is resolved (and validated) before any primitive changes.
    const changes: [PBRPrimitive, PBRMaterial][] = [];
    for (const p of [...this.primitives, ...this.pointsAndLines]) {
      const mappings = p.definition.extensions?.KHR_materials_variants?.mappings;
      if (mappings === undefined) continue;
      if (!Array.isArray(mappings)) throw new TypeError('Invalid glTF material variant mappings');
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
  /** Borrowed current draw buffers; picking never substitutes bind-pose geometry. */
  get pickingPrimitives() {
    if (this.disposed) return [];
    return this.resources
      .filter((r) => !r.batch)
      .map((r) => ({
        primitive: r.primitive,
        node: r.primitive.node,
        vertex: r.primitive.deformed ?? r.vertex,
        index: r.index,
        count: r.primitive.indices.length,
        stride: 80 as const,
        alphaTexture: r.views[0],
        alphaSampler: r.samplers[0],
        alpha: r.primitive.material.base[3],
        cutoff:
          r.primitive.material.settings[0] === 1
            ? r.primitive.material.settings[1]
            : r.primitive.material.settings[0] === 2
              ? 0.001
              : 0,
        side: sideOf(r.primitive.material),
        doubleSided: sideOf(r.primitive.material) === 'double',
        texCoord: (r.primitive.material.maps[0] ? textureCoordinates(r.primitive.material.maps[0]).texCoord : 0) as
          | 0
          | 1,
        ...(r.primitive.material.maps[0]?.extensions?.KHR_texture_transform
          ? { alphaTransform: textureCoordinates(r.primitive.material.maps[0]).transform }
          : {}),
      }));
  }
  /** Explicit CPU-query snapshot. Only deformed geometry incurs GPU readback. */
  async readPickingGeometry(): Promise<readonly PBRPickingGeometry[]> {
    const device = this.engine.gpu,
      revision = this.gpuRevision;
    if (this.disposed || this.engine.disposed || !device) return [];
    this.engine.store.tick(false);
    const records = this.resources
      .filter((resource) => !resource.batch)
      .map((resource) => ({
        resource,
        primitive: resource.primitive,
        deformed: resource.primitive.deformed,
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
              throw new RangeError('Picking snapshot exceeds device buffer limit');
            record.read = device.createBuffer({
              label: 'PBR picking snapshot',
              size,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            encoder.copyBufferToBuffer(record.deformed, 0, record.read, 0, size);
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
        records.some((record) => record.primitive.deformed !== record.deformed)
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
        }));
    } catch (error) {
      if (
        this.disposed ||
        this.engine.disposed ||
        this.engine.gpu !== device ||
        revision !== this.gpuRevision ||
        records.some((record) => record.primitive.deformed !== record.deformed)
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
      if (p.material.settings[0] === 2 || p.topology) continue;
      if (r.batch ? !shown(r.batch) : !!(r.mergedInto?.batch && shown(r.mergedInto.batch))) continue;
      fillShadow(r, (out[count] ??= {} as ShadowCasterRecord));
      count++;
    }
    out.length = count;
    return true;
  }
  /** `transparent` draws only the BLEND primitives a transparency hook took over (`setTransparency`), into its pass; `transmission`
   * those a transmission hook took over (`setTransmission`); `capture` the opaque and MASK ones into the capture hook's pass
   * (`setCapture`); for these `color`/`depth` are unused. */
  draw(
    c: Context,
    mode: 'beauty' | 'gbuffer' | 'ambient' | 'transparent' | 'transmission' | 'capture' | 'occlusion',
    color: GPUTextureView,
    depth: GPUTextureView,
    phase: 'all' | 'opaque' | 'blend' = 'all',
    external?: { pass: GPURenderPassEncoder; view: ArrayLike<number>; depthCompare: GPUCompareFunction },
  ): void {
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
    if (external) this.view.set(external.view);
    else viewMatrix(this.view, c.camera);
    const scratch = (this.drawScratch[this.drawDepth] ??= createDrawScratch(color, depth));
    this.drawDepth++;
    scratch.context = c;
    let pass: GPURenderPassEncoder | undefined = external?.pass,
      shared: GPURenderPassEncoder | undefined;
    try {
      let resources = this.resources;
      if (!through && !capture) {
        resources = scratch.resources;
        const source = this.resources;
        let sort = false;
        for (let i = 0; i < source.length; i++) {
          resources[i] = source[i];
          sort ||= blended(source[i].primitive.material);
        }
        resources.length = source.length;
        // Sorting an all-opaque list only returns the original stable order.
        // Preserve a snapshot for hooks while avoiding V8's sort workspace.
        // Distances are filled once; the comparator used to call hypot twice per pair.
        if (sort) {
          const position = c.camera.position,
            distances = scratch.blendDistance;
          distances.clear();
          for (let i = 0; i < resources.length; i++) {
            const resource = resources[i];
            if (!blended(resource.primitive.material)) continue;
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
      liveBatches.clear();
      const batchLive = (batch: StaticBatch) => {
        let value = liveBatches.get(batch);
        if (value === undefined)
          liveBatches.set(
            batch,
            (value = (mode !== 'beauty' || !asymmetricStencilFaces(batch.material.renderState)) && this.pose(batch)),
          );
        return value;
      };
      for (let resourceIndex = 0; resourceIndex < resources.length; resourceIndex++) {
        const r = resources[resourceIndex];
        if (r.batch ? !batchLive(r.batch) : !!(r.mergedInto?.batch && batchLive(r.mergedInto.batch))) continue;
        const p = r.primitive,
          m = p.material,
          node = p.node,
          inst = p.instances;
        if (
          p.topology
            ? mode !== 'beauty'
            : through
              ? !(transmission ? transmits(m) : separable(m))
              : capture
                ? blended(m) || m.ext![0]
                : mode === 'beauty' && ((oit && separable(m)) || (!!this.transmission && transmits(m)))
        )
          continue;
        if (phase !== 'all' && blended(m) !== (phase === 'blend')) continue;
        node.check();
        let visible = true;
        for (let id = node.id; id !== -1; id = this.engine.store.parents[id])
          if (this.engine.store.hidden[id]) visible = false;
        if (!visible || (inst && !inst.count)) continue;
        const wireframe = wireframeIndices(r),
          topology = p.topology ?? (wireframe ? 'line-list' : undefined),
          index = wireframe?.index ?? r.index,
          count = wireframe?.count ?? p.indices.length;
        const instances = inst?.upload(c.device);
        const compact =
          !!(p.extension ?? m.extension)?.replacesPhysical || (!m.extendedFrame && !m.physical && !m.ext?.[0]);
        const floatCount = compact ? 100 : m.extended ? 272 : 220;
        if (r.values.length !== floatCount || r.replacesTextures !== !!m.shading?.replacesTextures)
          this.bindMaterial(r, c.device, c.device.createSampler({ minFilter: 'linear', magFilter: 'linear' }));
        const v = r.values;
        v.set(c.camera.matrix);
        v.set(node.matrix, 16);
        if (!invertMatrixStable(node.matrix, this.inverse, this.workspace)) throw new Error('Singular PBR transform');
        for (let i = 0; i < 16; i++) v[32 + i] = this.inverse[(i % 4) * 4 + Math.floor(i / 4)];
        v.set(this.view, 48);
        v.set(c.camera.position, 64);
        v.set(this.engine.lighting.direction, 68);
        v.set(this.engine.lighting.radiance, 72);
        v.set(m.base, 76);
        v.set(m.factors, 80);
        if (!m.maps[2] && !m.extendedFrame) v[82] = 0;
        v.set(m.emission, 84);
        v.set(m.settings, 88);
        const side = sideOf(m),
          flag = sideFlag(side);
        v[90] = topology ? 1 : flag;
        v[91] = +(c.format === 'rgba16float');
        // coordsA/coordsB.x name each base map's slot; uv() reads that slot's KHR_texture_transform row, which carries its UV set.
        for (let i = 0; i < 5; i++) v[92 + i] = compact ? (m.maps[i] ? textureCoordinates(m.maps[i]!).texCoord : 0) : i;
        const a = node.matrix;
        v[97] = Math.sign(
          a[0] * (a[5] * a[10] - a[6] * a[9]) -
            a[4] * (a[1] * a[10] - a[2] * a[9]) +
            a[8] * (a[1] * a[6] - a[2] * a[5]),
        );
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
          v[98] = m.tint[0];
          v[99] = m.tint[1];
          v[102] = m.tint[2];
        }
        c.device.queue.writeBuffer(r.uniform, 0, v as Float32Array<ArrayBuffer>);
        // Physical materials listing only the five core maps (materials built in code) draw the factor-only variant;
        // transmission draws its transmissive form, extended materials the shader of decoders.materials.
        const x = this.asset.hooks.materials,
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
        const specialized = !compact || !!inst || m.settings[0] === 1;
        if (compact && specialized)
          code =
            'override margoFaceTest:bool=true;\noverride margoAlphaTest:bool=true;\n' +
            code
              .replace('if(!facing&&f.settings.z<0.5)', 'if(margoFaceTest&&!facing&&f.settings.z<0.5)')
              .replace(
                'if(f.settings.x>0.5&&f.settings.x<1.5&&s.base.a<f.settings.y)',
                'if(margoAlphaTest&&f.settings.x>0.5&&f.settings.x<1.5&&s.base.a<f.settings.y)',
              );
        const source = p.extension ?? m.extension;
        if (compact) {
          r.coordinates = coordinateExtension(m.maps, source, r.coordinates);
          code = coordinateShader(code, r.coordinates, !!m.maps[2] && v[94] === 1);
        } else if (
          m.maps[2]
            ? textureCoordinates(m.maps[2]).texCoord === 1 || textureCoordinates(m.maps[2]).transform
            : m.extendedFrame &&
              // Constructed material maps use the retained normal-slot affine rows, not glTF texture definitions.
              (v[123] > 0.5 ||
                v[120] !== 1 ||
                v[121] !== 0 ||
                v[122] !== 0 ||
                v[124] !== 0 ||
                v[125] !== 1 ||
                v[126] !== 0)
        )
          code = code.replace('if(abs(i.tangent.w)<0.5)', 'if(true)');
        const extension = compact ? (r.coordinates?.extension ?? source) : source;
        if (extension) {
          r.extension = prepareMaterialExtension(c.device, extension, r.extension);
          code = materialExtensionShader(code, extension);
        } else if (r.extension) {
          r.extension.uniform?.destroy();
          r.extension = undefined;
        }
        const lighting = extension?.lighting !== false,
          shading = m.shading;
        if (shading || (mode !== 'gbuffer' && lighting && this.lighting.size)) {
          scratch.code = code;
          scratch.ambient = false;
          if (shading) patchDrawLighting.call(scratch, shading);
          const surface = scratch.code;
          // Effects with `pbr` hooks compose at gltf-pro's hook points; others (materials, LOD baking) still patch the text.
          if (mode !== 'gbuffer' && lighting) this.lighting.forEach(patchDrawLighting, scratch);
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
                    ? '_=color;return vec4f(margoAmbient,'
                    : '_=color;return vec4f(select(margoAmbient,vec3f(0),f.ext.x>0.5),',
                )),
              );
            }
            code = replay;
            entry = 'fragment';
            lit = true;
          } else code = surface;
        }
        if (extension?.ambient) code = materialExtensionAmbientShader(code, extension);
        if (transmission) code = transmissionPBR(code, oit!.declarations(2));
        else if (through) code = transparentPBR(code, oit!.declarations(2));
        else if (capture) code = capturePBR(code, hook!.declarations(code));
        // Instancing patches the vertex stage last, so text-patching effects (shader NodeMaterial vertex nodes) keep their anchors.
        if (inst) code = inst.shader(code);
        if (side === 'back' && !topology) code = backSideShader(code);
        if (m.shading?.texturedTint) code = texturedTintPBR(code);
        if (mode === 'occlusion') {
          const rewritten = occlusionShader(code);
          code = rewritten.code;
          entry = rewritten.entry;
        }
        if (section) code = sectionShader(code, 0, 2);
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
        let id = this.codes.get(code);
        if (id === undefined) {
          if (this.codes.size >= 256) this.codes.clear();
          this.codes.set(code, (id = this.codeCount++));
        }
        const transmit = !compact && !!m.tint,
          blend = m.settings[0] === 2 || transmit,
          tinted = transmit && (mode === 'beauty' || mode === 'ambient') && state?.blend === undefined,
          stateKey = renderStateKey(state) + (external?.depthCompare ?? '') + (extension ? ':extension' : ''),
          samples = c.descriptor.multisample?.count,
          depthFormat = c.descriptor.depthStencil!.format;
        const states = r.pipelineHistories?.get(mode);
        let previous: DrawPipelineState | undefined;
        if (states)
          for (let i = 0; i < states.length; i++) {
            const value = states[i];
            if (
              value.format === c.format &&
              value.blend === blend &&
              value.transmit === transmit &&
              value.cull === cull &&
              value.samples === samples &&
              value.depth === depthFormat &&
              value.entry === entry &&
              value.code === id &&
              value.mask === mask &&
              value.state === stateKey &&
              value.instanced === !!inst &&
              value.face === face &&
              value.topology === topology
            ) {
              previous = value;
              // A main view and a probe can alternate the same mode every frame.
              // Retain both records instead of replacing the state and key twice.
              for (let j = i; j > 0; j--) states[j] = states[j - 1];
              states[0] = value;
              break;
            }
          }
        const samePipeline = previous !== undefined;
        const key = samePipeline
          ? previous!.key
          : mode +
            ':' +
            c.format +
            ':' +
            blend +
            transmit +
            ':' +
            cull +
            ':' +
            c.descriptor.multisample?.count +
            ':' +
            c.descriptor.depthStencil!.format +
            ':' +
            entry +
            ':' +
            id +
            ':' +
            mask +
            stateKey +
            (inst ? ':i' + face : '') +
            (topology ? ':' + topology : '');
        let pipeline = samePipeline ? previous!.pipeline : this.pipelines.get(key);
        if (!pipeline) {
          checkDrawLimits(c.device, code, m, transmission, this.lighting);
          const module = c.device.createShaderModule({ code }),
            format = mode === 'beauty' ? c.format : 'rgba16float';
          const descriptor: GPURenderPipelineDescriptor = {
            layout: 'auto',
            vertex: {
              module,
              entryPoint: 'vertex',
              buffers: [
                {
                  arrayStride: 80,
                  attributes: Array.from({ length: 5 }, (_, i) => ({
                    shaderLocation: i,
                    offset: i * 16,
                    format: 'float32x4' as const,
                  })),
                },
                ...(inst ? [inst.layout] : []),
              ],
            },
            fragment: {
              module,
              entryPoint: entry,
              constants: specialized ? { margoFaceTest: face, margoAlphaTest: mask } : undefined,
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
          pipeline = c.device.createRenderPipeline(descriptor);
          this.pipelines.set(key, pipeline);
          // Transmission's first draw: what is behind times the tint (no blend constant, see below).
          if (tinted)
            this.pipelines.set(
              key + ':tint',
              c.device.createRenderPipeline({
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
                    specialized && m.shading?.texturedTint ? { margoFaceTest: face, margoAlphaTest: mask } : undefined,
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
              }),
            );
        }
        if (!samePipeline) {
          const values = states ?? [];
          if (!states) (r.pipelineHistories ??= new Map()).set(mode, values);
          // Keep invalidation bounded even when callers animate material state.
          if (values.length < 32) values.length++;
          for (let i = values.length - 1; i > 0; i--) values[i] = values[i - 1];
          values[0] = {
            format: c.format,
            blend,
            transmit,
            cull,
            samples,
            depth: depthFormat,
            entry,
            code: id,
            mask,
            state: stateKey,
            instanced: !!inst,
            face,
            topology,
            key,
            pipeline,
          };
        }
        if (r.sectionBuffer !== section) {
          r.groups.clear();
          r.sectionBuffer = section;
        }
        let groups = r.groups.get(pipeline);
        if (!groups) {
          groups = createDrawGroups(c.device, pipeline, r, m, transmission, x, section);
          r.groups.set(pipeline, groups);
        }
        let target: GPURenderPassEncoder;
        if (through || capture) target = shared ??= (through ? oit! : hook!).begin();
        else {
          // Retain transparent pass boundaries so attachment-store rounding stays unchanged.
          if (!external && blend && mode !== 'gbuffer') {
            if (!external) pass?.end();
            pass = undefined;
          }
          if (!pass) {
            scratch.color.view = color;
            scratch.depth.view = depth;
            const stencil = c.descriptor.depthStencil!.format.includes('stencil');
            scratch.depth.stencilLoadOp = stencil ? 'load' : undefined;
            scratch.depth.stencilStoreOp = stencil ? 'store' : undefined;
            pass = c.encoder.beginRenderPass(scratch.descriptor);
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
        let effectGroup: GPUBindGroup | undefined;
        const effectBindings = !!shading || (lit && ((lighting && this.lighting.size > 0) || through));
        if (effectBindings) {
          const entries = scratch.entries,
            effects = scratch.effects;
          let entryCount = 0;
          scratch.effectCount = 0;
          if (shading) snapshotDrawLighting.call(scratch, shading);
          if (lit && lighting) this.lighting.forEach(snapshotDrawLighting, scratch);
          effects.length = scratch.effectCount;
          for (let i = 0; i < effects.length; i++) {
            const bindings = effects[i].bindings();
            for (let j = 0; j < bindings.length; j++) entries[entryCount++] = bindings[j];
          }
          if (through) {
            const bindings = oit!.bindings();
            for (let j = 0; j < bindings.length; j++) entries[entryCount++] = bindings[j];
          }
          entries.length = entryCount;
          let cached = this.lightingGroups.get(pipeline);
          let changed = !cached || entries.length !== cached.entries.length;
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
                'buffer' in resource
                  ? { buffer: resource.buffer, offset: resource.offset, size: resource.size }
                  : resource,
            }));
            const group = c.device.createBindGroup({ layout: pipeline.getBindGroupLayout(2), entries: snapshot });
            cached = { entries: snapshot, group };
            this.lightingGroups.set(pipeline, cached);
          }
          effectGroup = cached!.group;
        }
        // Transmission first multiplies the background, then adds the lit surface.
        if (tinted) {
          const tint = this.pipelines.get(key + ':tint')!,
            mappedTint = !!shading?.texturedTint;
          let tintGroups = r.groups.get(tint);
          if (!tintGroups) {
            tintGroups = mappedTint
              ? createDrawGroups(c.device, tint, r, m, false, x, section)
              : [
                  c.device.createBindGroup({
                    layout: tint.getBindGroupLayout(0),
                    entries: [
                      { binding: 0, resource: { buffer: r.uniform } },
                      ...(section ? [{ binding: 2, resource: { buffer: section } }] : []),
                    ],
                  }),
                ];
            r.groups.set(tint, tintGroups);
          }
          target.setPipeline(tint);
          target.setBindGroup(0, tintGroups[0]);
          if (mappedTint) {
            target.setBindGroup(1, tintGroups[1]);
            if (effectBindings) {
              const snapshot = this.lightingGroups.get(pipeline)!.entries;
              let cached = this.lightingGroups.get(tint);
              if (!cached || cached.entries !== snapshot) {
                cached = {
                  entries: snapshot,
                  group: c.device.createBindGroup({ layout: tint.getBindGroupLayout(2), entries: snapshot }),
                };
                this.lightingGroups.set(tint, cached);
              }
              target.setBindGroup(2, cached.group);
            }
            if (extension) bindMaterialExtension(c.device, target, tint, r.extension!, effectBindings);
          }
          target.setVertexBuffer(0, p.deformed ?? r.vertex);
          if (instances) target.setVertexBuffer(1, instances);
          target.setIndexBuffer(index, 'uint32');
          applyStencilReference(target, state);
          if (inst) target.drawIndexed(count, inst.count);
          else target.drawIndexed(count);
        }
        target.setPipeline(pipeline);
        target.setBindGroup(0, groups[0]);
        target.setBindGroup(1, groups[1]);
        if (effectGroup) target.setBindGroup(2, effectGroup);
        if (extension) bindMaterialExtension(c.device, target, pipeline, r.extension!, effectBindings);
        target.setVertexBuffer(0, p.deformed ?? r.vertex);
        if (instances) target.setVertexBuffer(1, instances);
        target.setIndexBuffer(index, 'uint32');
        // A preceding material may have changed the reference on this shared pass.
        applyStencilReference(target, state);
        if (inst) target.drawIndexed(count, inst.count);
        else target.drawIndexed(count);
        if (!external && blend && mode !== 'gbuffer' && !through && !capture) {
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
      throw error;
    } finally {
      this.drawDepth--;
      scratch.context = undefined;
      scratch.code = '';
      // Release callback-owned references while retaining array capacity.
      for (let i = 0; i < scratch.effects.length; i++) scratch.effects[i] = undefined!;
      for (let i = 0; i < scratch.entries.length; i++) scratch.entries[i] = undefined!;
      scratch.color.view = scratch.depth.view = undefined!;
      scratch.liveBatches.clear();
      scratch.blendDistance.clear();
    }
    if (!external) pass?.end();
  }
  /** Isolated GPU resources for stereo eyes or another caller-owned WebGPU device. */
  createRenderer(device: GPUDevice): PBRDeviceRenderer {
    if (this.disposed || this.engine.disposed) throw new Error('PBRModel is disposed');
    // GPU texture views supplied by callers cannot cross devices. Fail explicitly
    // rather than drawing a bind pose or silently omitting an extended surface.
    for (const primitive of [...this.primitives, ...this.pointsAndLines]) {
      if (primitive.material.shading && device !== this.engine.gpu)
        throw new Error('Cross-device PBR rendering requires recreating local material shading');
      if ((primitive.extension ?? primitive.material.extension)?.textures?.length)
        throw new Error('Cross-device PBR rendering requires recreating caller-owned material extension textures');
    }
    const replica = Object.create(PBRModel.prototype) as PBRModel;
    Object.assign(replica, {
      name: this.name + ':device:' + modelId++,
      root: this.root,
      nodes: this.nodes,
      primitives: this.primitives.map((primitive) => ({ ...primitive, instances: undefined, deformed: undefined })),
      asset: this.asset,
      images: this.images,
      disposed: false,
      created: [],
      resources: [],
      textures: [],
      pipelines: new Map(),
      inverse: new Float32Array(16),
      workspace: new Float64Array(52),
      view: new Float32Array(16),
      engine: this.engine,
      cleanupCallbacks: new Set(),
      lighting: new Set(),
      lightingGroups: new Map(),
      gpuRevision: 0,
      gpuCache: new Map(),
      drawScratch: [],
      drawDepth: 0,
      codes: new Map(),
      codeCount: 0,
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
          throw new Error('Cross-device PBR rendering requires recreating local material shading');
        if ((source.extension ?? source.material.extension)?.textures?.length)
          throw new Error('Cross-device PBR rendering requires recreating caller-owned material extension textures');
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
        throw new Error('Cross-device deformed PBR rendering requires an isolated deformation renderer');
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
            throw new Error('Cross-device deformed PBR rendering requires an isolated deformation renderer');
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
  /** World-space point and spot lights for `clustered.setLights()`. Directional lights are left to engine lighting; an unset range ends where intensity/d² reaches 1/256. */
  clusteredLights(): GLTFClusteredLight[] {
    this.engine.store.tick(false);
    return this.lights
      .filter((l) => l.type !== 'directional')
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
      buffers = new Set<GPUBuffer>();
    for (const r of this.resources)
      for (const b of [r.vertex, r.index, r.wireframe?.index, r.uniform, r.extension?.uniform, r.volume])
        if (b) buffers.add(b);
    for (const b of buffers) cleanup.run(() => b.destroy());
    for (const t of this.textures) cleanup.run(() => t.destroy());
    for (const p of [...this.primitives, ...this.pointsAndLines]) {
      p.buffers = undefined;
      cleanup.run(() => p.instances?.dispose());
    }
    this.resources = [];
    this.textures = [];
    this.pipelines.clear();
    this.gpuCache.clear();
    this.lightingGroups.clear();
    this.drawScratch.length = 0;
    cleanup.finish();
  }
  onDeviceRestored(engine: Engine): void {
    this.releaseGPU();
    for (const p of this.primitives) p.deformed = undefined;
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
/** Like parseGLTF for in-memory JSON/GLB, but async so Draco, meshopt and KTX2 decoders can run; also decodes embedded images. External URIs resolve against the page. */
export async function parseGLTFAsync(
  instance: EngineKernel,
  input: string | object | ArrayBuffer | ArrayBufferView,
  buffersOrOptions: Array<ArrayBuffer | ArrayBufferView> | (AssetOptions & CompressionOptions) = [],
  images: readonly GLTFImage[] = [],
  options: GLTFLoadOptions = {},
): Promise<PBRModel> {
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
    asset = new GLTFAsset(doc, buffersOrOptions, binary, options.decoders, options.maxDownloadBytes, options.maxNodes);
  await decompressPrimitives(asset, { ...options, draco: options.draco ?? options.decoders?.draco });
  images = await decodeKTX2Images(asset, images, {
    ...options,
    ktx2: options.ktx2 ?? options.decoders?.ktx2,
    device: engineRuntime(instance).gpu ?? undefined,
  });
  return attach(instance, { asset, images: images as GLTFImage[] }, options.signal);
}
/**
 * Applies a model's KHR_lights_punctual lights in one call. The first directional light becomes the engine's light
 * (`engine.lighting`: direction toward the light, its colour, and its lux x `exposure` as the strength; core's default
 * strength is 3 and core has one directional light, so further ones are ignored). Point and spot lights go to `clustered`
 * (@margoengine/clustered, candela x `exposure`), which then lights the model; without it they are ignored. Lights are
 * placed where their nodes are now: after moving the model, call `clustered.setLights(model.clusteredLights())` (or this
 * again for the sun). Call once per clustered instance; returns the remover from `clustered.add` (a no-op without one).
 */
export function applyGLTFLights(
  model: PBRModel,
  { clustered, exposure = 1 }: { clustered?: GLTFLightReceiver; exposure?: number } = {},
): () => void {
  if (!Number.isFinite(exposure) || exposure < 0)
    throw new RangeError('applyGLTFLights: exposure must be a finite number >= 0');
  const engine = model['engine'],
    sun = model.lights.find((l) => l.type === 'directional');
  if (sun) {
    engine.store.tick(false);
    const m = sun.node.matrix,
      length = Math.hypot(m[8], m[9], m[10]) || 1;
    engine.lighting.direction.set([m[8] / length, m[9] / length, m[10] / length, sun.intensity * exposure]);
    engine.lighting.radiance.set(sun.color);
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
  if (!def) throw new RangeError(`viewGLTFCamera: the model has no glTF camera ${camera}`);
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
