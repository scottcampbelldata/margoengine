// What a PBR draw derives from its material record, model and target: the shader, the pipeline, the lighting bind
// group and the material rows of the uniform. A draw used to derive all of it again for every primitive every frame
// (shader text edits, a pipeline-state search and every lighting callback per primitive: 10,000 materials meshes
// spent most of their 80 ms of CPU a frame there). The derivation reads only the material record and the draw's
// context, so primitives with the same material record in one `draw()` call, or one `PBRDrawRun`, share it: each
// frame derives it once and the rest reuse it. Across frames the uniform rows and group 2's bindings are read again
// every frame, so every live value and texture edit shows on the next one. The shader and pipeline are kept only when
// the record's shading hook reports an unchanged `shaderRevision`, its structure (`structureFlags`), shading object and
// render state are the same and no lighting effect or transparency hook patches the shader (4,096 materials meshes,
// one material each, composed 4,096 shaders a frame); everything else composes them again each frame, as before.
import type { LightingEffect, PBRRenderState } from './index.js';
import type { PBRInstances } from './instancing.js';
import type { BatchKind, BatchState } from './draw-batch.js';
import type { MaterialExtension } from './material-extension.js';
import type { GLTFExtendedMaterials } from './asset.js';

/** The context every primitive of one draw call shares, compared field by field to share derivations between calls. */
export interface DrawFrame {
  mode: string;
  depthCompare: GPUCompareFunction | undefined;
  format: GPUTextureFormat;
  samples: number | undefined;
  depthFormat: GPUTextureFormat;
  section: GPUBuffer | undefined;
  /** The transparency or transmission hook, the capture hook and the asset's extended-material hooks. */
  oit: object | undefined;
  hook: object | undefined;
  hooks: GLTFExtendedMaterials | undefined;
  /** The model's lighting effects in order. */
  lighting: readonly LightingEffect[];
}

/** A derivation, valid for draws under `frame` (identity: the same call or run); see the file comment. */
export interface DrawDerivation {
  frame: DrawFrame;
  source: MaterialExtension | undefined;
  instances: PBRInstances | BatchKind | undefined;
  topology: GPUPrimitiveTopology | undefined;
  /** Sign of the node matrix determinant: mirrored nodes cull the other face. */
  sign: number;
  /** False when derived for a batch member: no pipeline built and no lighting group (draw-batch.ts). */
  complete: boolean;
  compact: boolean;
  floatCount: number;
  replacesTextures: boolean;
  /** Set when the primitive has a material extension: those draws keep per-resource state and never share. */
  extension: MaterialExtension | undefined;
  pipeline: GPURenderPipeline;
  /** Transmission's tint pipeline (multiplies what is behind) when the draw is tinted. */
  tint: GPURenderPipeline | undefined;
  /** True when the draw first multiplies what is behind by its tint (transmission). */
  tinted: boolean;
  blend: boolean;
  state: PBRRenderState | undefined;
  /** True when group 2 (shading, lighting and transparency bindings) is bound. */
  effectBindings: boolean;
  effect: { entries: GPUBindGroupEntry[]; group: GPUBindGroup } | undefined;
  tintEffect: { entries: GPUBindGroupEntry[]; group: GPUBindGroup } | undefined;
  mappedTint: boolean;
  /** False when the finished shader reads the model rows itself, so instanced batches cannot draw it. */
  modelFree: boolean;
  /** True when the finished shader reads the base colour only as the vertex colour's factor (index.ts `tintableCode`). */
  tintable?: boolean;
  /** @internal The GPU states of this derivation's blended batches, one per batch drawn in a frame (index.ts `drawBatch`). */
  blendStates?: BatchState[];
  /** @internal The batch (draw-batch.ts) this derivation's last draw joined in run `joinedRun`, until that run draws it. */
  joined?: object;
  joinedRun?: object;
  /** The whole uniform as derived; draws copy it and write their own node rows (16-47) and determinant (97). */
  block: Float32Array;
  /**
   * @internal What the shader and pipeline were composed from, beyond the context (`frame`) and the fields above: the
   * record's `shading.shaderRevision`, its shading object and render state, and `structure` (structureFlags). A later
   * frame whose draw finds all of them unchanged keeps `pipeline` and `tint` (see `PBRModel.derive`).
   */
  revision?: number;
  shading?: object;
  renderState?: object;
  structure?: number;
}

/**
 * The record fields beyond the shading hooks that decide a draw's shader text and pipeline, as one number: alpha mode,
 * side flag, the tangent-frame switch, transmission tint, physical rows and their map count, and the shading's
 * texture flags. Two derivations with equal flags (and equal revision, shading, render state and context) compose the
 * same shader and pipeline.
 */
export function structureFlags(
  alphaMode: number,
  side: number,
  tangent: boolean,
  tint: boolean,
  physical: boolean,
  physicalMaps: boolean,
  texturedTint: boolean,
  replacesTextures: boolean,
): number {
  return (
    alphaMode +
    side * 4 +
    +tangent * 16 +
    +tint * 32 +
    +physical * 64 +
    +physicalMaps * 128 +
    +texturedTint * 256 +
    +replacesTextures * 512
  );
}

/** Per device: shader ids, pipelines and derivations by material record, shared by every model on the device. */
export interface DeviceDraws {
  codes: Map<string, number>;
  codeCount: number;
  pipelines: Map<string, GPURenderPipeline>;
  derivations: WeakMap<object, DrawDerivation[]>;
}
const devices = new WeakMap<GPUDevice, DeviceDraws>();
export function deviceDraws(device: GPUDevice): DeviceDraws {
  let state = devices.get(device);
  if (!state)
    devices.set(device, (state = { codes: new Map(), codeCount: 0, pipelines: new Map(), derivations: new WeakMap() }));
  return state;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
/** A small stable number for `value` (pipeline keys name hooks and layouts by it). */
export function objectId(value: object | undefined): number {
  if (!value) return 0;
  let id = ids.get(value);
  if (id === undefined) ids.set(value, (id = nextId++));
  return id;
}

/** True when `a` and `b` describe the same draw context. */
export function sameFrame(a: DrawFrame, b: DrawFrame): boolean {
  if (
    a.mode !== b.mode ||
    a.depthCompare !== b.depthCompare ||
    a.format !== b.format ||
    a.samples !== b.samples ||
    a.depthFormat !== b.depthFormat ||
    a.section !== b.section ||
    a.oit !== b.oit ||
    a.hook !== b.hook ||
    a.hooks !== b.hooks ||
    a.lighting.length !== b.lighting.length
  )
    return false;
  for (let i = 0; i < a.lighting.length; i++) if (a.lighting[i] !== b.lighting[i]) return false;
  return true;
}

/** True when two models' lighting lists hold the same effects in order. */
export function sameLighting(a: readonly LightingEffect[], b: readonly LightingEffect[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Most recent first; bounded so animated contexts (probe faces, resizes) cannot grow a material's list forever. */
export const derivationLimit = 32;
