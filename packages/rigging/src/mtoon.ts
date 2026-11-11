import { legacyMToon, type LegacyMToon } from './mtoon-legacy.js';
import { generateMipmaps } from '../../shared/mipmaps.js';
import { setMaterialDraw, type MaterialDrawCall } from '@margoengine/gltf-pro/material-draw';
import type { PBRMaterial, PBRMaterialShading, PBRModel, PBRPrimitive, GLTFStreamedImage } from '@margoengine/gltf-pro';
import { PBRDrawRun } from '@margoengine/gltf-pro/model';
import type { Engine, Scene, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { engineRuntime } from '@margoengine/core/extension';
import { fault, rangeError } from '../../shared/errors.js';
import { retire, writeUniform } from '../../shared/frame-resources.js';
import type { VRMExpressions } from './vrm.js';
import { normalizeMToon, type MToonDefinition, type MToonTextureInfo } from './mtoon-data.js';
import { mtoonShader, mtoonLit } from './mtoon-shader.js';
export type { MToonColor, MToonDefinition, MToonTextureInfo } from './mtoon-data.js';

const fields = [
  'shadeMultiplyTexture',
  'shadingShiftTexture',
  'matcapTexture',
  'rimMultiplyTexture',
  'outlineWidthMultiplyTexture',
  'uvAnimationMaskTexture',
] as const;
type Definition = ReturnType<typeof normalizeMToon>;
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** Optional runtime expression input; when omitted, only authored material values apply. */
export interface MToonOptions {
  expressions?: VRMExpressions;
}
interface Resource {
  buffer: GPUBuffer;
  maps: {
    texture?: GPUTexture;
    sampler: GPUSampler;
    view: GPUTextureView;
    fallback?: GPUTextureView;
    readView?: () => GPUTextureView | undefined;
  }[];
}
interface State {
  index: number;
  definition: Definition;
  legacy?: LegacyMToon;
  values: Float32Array;
  resource?: Resource;
  body: PBRMaterialShading;
  outline: PBRMaterialShading;
}
interface Part {
  primitive: PBRPrimitive;
  original: PBRMaterial;
  body: PBRMaterial;
  outline: PBRMaterial;
  state: State;
  authored: { base: number[]; emission: number[]; maps: PBRMaterial['maps'] };
}
let serial = 0;
/** Unity's first transparent queue: MToon blend queues (2500 + 0..9 with depth writes, 3000 - 9..0 without) and plain BLEND (3000). */
const BLEND_QUEUE = 2500;
/**
 * Blended queues of every MToon model drawn in one scene frame, drawn after the models by queue (VRM 1.0 MToon
 * renderQueueOffsetNumber), then in model draw order. A frame graph context is armed between its two passes; a draw
 * outside them (a probe, an imposter, a replica, a direct `model.draw`) keeps drawing every queue inline.
 */
interface QueueFrame {
  readonly drawn: { effect: MToon; queues: number[] }[];
  /** Arm passes that ran for this frame; one running again means an earlier frame stopped before its queue pass. */
  readonly arms: Set<string>;
}
const armed = new WeakMap<Context, QueueFrame>();
const hiddenShader: PBRMaterialShading = {
  shader: (code) => code.replace(/(@fragment fn fragment\([^]*?\{)/, '$1 discard;'),
  bindings: () => [],
  shaderRevision: 0,
};
const hiddenMaterials = new WeakMap<PBRMaterial, PBRMaterial>();
function hide(material: PBRMaterial): PBRMaterial {
  let copy = hiddenMaterials.get(material);
  if (!copy) {
    const source = material.shading;
    const shading: PBRMaterialShading = source
      ? {
          ...source,
          shader: (code, group) =>
            (source.shader?.(code, group) ?? code).replace(/(@fragment fn fragment\([^]*?\{)/, '$1 discard;'),
          lit: source.lit?.bind(source),
          bindings: source.bindings.bind(source),
        }
      : hiddenShader;
    copy = { ...material, shading };
    hiddenMaterials.set(material, copy);
  }
  return copy;
}

/** Authored MToon materials on a loaded model; dispose restores exact material records. */
export class MToon implements EnginePlugin {
  /** Unique scene registration name, assigned at construction. */
  readonly name = 'mtoon:' + serial++;
  /** Validated, independent definitions keyed by original glTF material index. */
  private readonly definitions = new Map<number, Definition>();
  get materials(): ReadonlyMap<number, Readonly<MToonDefinition>> {
    return this.definitions;
  }
  private dead = false;
  /** True after disposal; the borrowed model remains caller-owned. */
  get disposed(): boolean {
    return this.dead;
  }
  private time = 0;
  private engine: Engine;
  private scene: Scene;
  private device?: GPUDevice;
  private context?: Context;
  private mode: MaterialDrawCall['mode'] = 'beauty';
  /** The one blended queue the scene's queue pass is drawing for this model, else undefined. */
  private only?: number;
  private readonly mipPipelines = new Map<unknown, unknown>();
  private readonly states: State[] = [];
  private readonly parts: Part[] = [];
  private unsubscribe?: () => void;
  private removeDraw?: () => void;
  constructor(
    readonly model: PBRModel,
    readonly options: MToonOptions = {},
  ) {
    if (!model || model.disposed) throw fault('disposed', 'MToon needs a live loaded PBRModel; load the avatar again');
    const engine = engineRuntime(model.root.engine),
      owner = engine.sceneOf(model);
    if (!owner) throw fault('state', 'MToon needs a registered model; load it into a scene first');
    this.engine = engine;
    this.scene = owner;
    const definitions = model.asset.doc.materials ?? [];
    const extensions = model.asset.doc.extensions as Record<string, unknown> | undefined;
    const legacy = (
      (extensions?.VRM ?? (extensions?.VRMC_vrm as { extras?: { vrm0?: unknown } } | undefined)?.extras?.vrm0) as
        | { materialProperties?: import('./vrm0.js').VRM0Material[] }
        | undefined
    )?.materialProperties;

    for (let index = 0; index < definitions.length; index++) {
      const converted = legacy?.[index] ? legacyMToon(legacy[index]) : undefined;
      const ext = (definitions[index].extensions?.VRMC_materials_mtoon ?? converted?.definition) as
        | MToonDefinition
        | undefined;
      if (!ext) continue;
      const definition = normalizeMToon(ext),
        state = {} as State;
      const alpha = definitions[index].alphaMode ?? 'OPAQUE',
        offset = definition.renderQueueOffsetNumber;
      if (
        !converted &&
        ((alpha !== 'BLEND' && offset !== 0) ||
          (alpha === 'BLEND' && (definition.transparentWithZWrite ? offset < 0 : offset > 0)))
      )
        throw rangeError(
          'MToon renderQueueOffsetNumber must be zero for opaque/mask, nonnegative for depth-writing blend, and nonpositive for ordinary blend',
          'material',
        );
      Object.assign(state, { index, definition, legacy: converted, values: new Float32Array(104) });
      const maps = [
        ...fields.map((field) => definition[field]),
        converted?.baseTexture,
        converted?.normalTexture,
        converted?.emissionTexture,
      ];
      for (const map of maps) {
        if (!map) continue;
        const texture = model.asset.doc.textures?.[map.index];
        if (!texture) throw rangeError('MToon map names a missing texture; correct the material index', 'material');
        const sampler = texture.sampler === undefined ? {} : model.asset.doc.samplers?.[texture.sampler];
        if (
          !sampler ||
          (sampler.magFilter !== undefined && ![9728, 9729].includes(sampler.magFilter)) ||
          (sampler.minFilter !== undefined && ![9728, 9729, 9984, 9985, 9986, 9987].includes(sampler.minFilter)) ||
          [sampler.wrapS, sampler.wrapT].some((wrap) => wrap !== undefined && ![10497, 33071, 33648].includes(wrap))
        )
          throw rangeError('MToon texture sampler needs valid glTF filter and wrapping constants', 'material');
      }
      const hook = (outline: boolean): PBRMaterialShading => ({
        shader: (code, group) => mtoonShader(code, group, outline),
        lit: (code) => mtoonLit(code, outline),
        bindings: () => this.bindings(state, outline),
        shaderRevision: +outline,
      });
      state.body = hook(false);
      state.outline = hook(true);
      this.states.push(state);
      this.definitions.set(index, definition);
    }
    // Validate the entire attachment before changing a material.
    for (const primitive of model.primitives) {
      const state = this.states.find((s) => s.index === primitive.definition.material);
      if (!state) continue;
      const original = primitive.material;
      if (original.shading)
        throw fault(
          'attached',
          'MToon material already has a shader; dispose the prior material adapter first',
          'state',
        );
      const {
        physical: _p,
        extended: _e,
        extension: _x,
        tint: _t,
        volume: _v,
        attenuation: _a,
        dispersion: _d,
        ...base
      } = original;
      const body = {
        ...base,
        maps: base.maps.slice(0, 5),
        extendedFrame: true,
        ext: [0, 0, 0, 0],
        vertexAlpha: false,
        shading: state.body,
        renderState: {
          ...original.renderState,
          depthWrite: original.settings[0] !== 2 || state.definition.transparentWithZWrite,
        },
      };
      if (state.legacy) {
        body.settings = body.settings.slice();
        body.settings[0] = state.legacy.mode;
        body.settings[1] = state.legacy.cutoff;
        body.base = state.legacy.base.slice();
        body.emission = state.legacy.emission.slice();
        body.maps = body.maps.slice();
        body.maps[0] = state.legacy.baseTexture;
        body.maps[2] = state.legacy.normalTexture;
        body.maps[3] = state.legacy.emissionTexture;
        body.side = state.legacy.side;
        body.renderState.depthWrite = state.legacy.mode !== 2 || state.definition.transparentWithZWrite;
      }
      body.uvt = this.coreUV(body.maps);
      body.factors = body.factors.slice();
      if (state.legacy) body.factors[2] = state.legacy.normalScale;
      if (!body.maps[2]) body.factors[2] = 0;
      const outline = {
        ...body,
        settings: body.settings.slice(),
        side: 'back' as const,
        shading: state.outline,
        renderState: { ...body.renderState, depthWrite: false },
      };
      outline.settings[2] = 0;
      this.parts.push({
        primitive,
        original,
        state,
        body,
        outline,
        authored: { base: body.base.slice(), emission: body.emission.slice(), maps: structuredClone(body.maps) },
      });
    }
    this.device = engine.gpu ?? undefined;
    if (!this.device) throw fault('unsupported', 'MToon needs a WebGPU or compatibility device');
    this.removeDraw = setMaterialDraw(model, (call) => this.draw(call));
    for (const part of this.parts) part.primitive.material = part.body;
    this.unsubscribe = model.onDispose(() => this.dispose());
  }
  /** Attach to the scene that owns the model. */
  static attach(model: PBRModel, options: MToonOptions = {}): MToon {
    const effect = new MToon(model, options);
    try {
      effect.scene.use(effect);
    } catch (error) {
      effect.dispose();
      throw error;
    }
    return effect;
  }
  setup(engine: Engine): void {
    if (engine !== this.engine || this.disposed)
      throw fault('attached', 'MToon belongs to another scene; attach a new instance to its model', 'state');
    if (!engine.gpu)
      throw fault('unsupported', 'MToon needs WebGPU or the WebGL2 compatibility device; select a GPU backend');
    this.device = engine.gpu ?? undefined;
  }
  /**
   * Models with blended MToon or BLEND materials draw their blended queues after every model, sorted by queue across
   * models. Opaque and mask avatars register nothing, so their frames keep the models' render pass run unchanged.
   */
  registerPasses(graph: FrameGraph): void {
    if (
      !this.parts.some((p) => this.queue(p.state) >= BLEND_QUEUE) &&
      !this.model.primitives.some((p) => p.material.settings[0] === 2)
    )
      return;
    // Every MToon registers the pair under its own name (passes leave with their plugin); the first of each pair to
    // run that frame does the work and the later ones find it done.
    graph.add({
      name: this.name + ':arm',
      order: 0.99,
      joins: true,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        let frame = armed.get(c);
        if (!frame || frame.arms.has(this.name)) armed.set(c, (frame = { drawn: [], arms: new Set() }));
        frame.arms.add(this.name);
      },
    });
    graph.add({
      name: this.name + ':queues',
      order: 1.2,
      joins: true,
      execute: (c) => {
        if (c.backend === 'webgpu') MToon.drawQueues(c);
      },
    });
  }
  /** Draws the armed frame's blended MToon queues in ascending queue order, each queue in model draw order. */
  private static drawQueues(c: Context): void {
    const frame = armed.get(c);
    if (!frame) return;
    armed.delete(c);
    const drawn = frame.drawn;
    if (!drawn.length) return;
    const queues = [...new Set(drawn.flatMap((d) => d.queues))].sort((a, b) => a - b),
      run = new PBRDrawRun();
    try {
      for (const queue of queues)
        for (const d of drawn) if (d.queues.includes(queue)) d.effect.drawQueue(c, queue, run);
    } finally {
      run.end();
    }
  }
  /** Draws this model's blended primitives of one queue (scene queue pass). */
  private drawQueue(c: Context, queue: number, run: PBRDrawRun): void {
    if (this.disposed) return;
    this.only = queue;
    try {
      this.model.draw(c, 'beauty', c.color, c.depth, 'blend', undefined, run);
    } finally {
      this.only = undefined;
    }
  }
  onPreUpdate(delta: number): void {
    this.time += delta;
    this.applyExpressions();
  }
  private draw(call: MaterialDrawCall): void {
    const old = this.context,
      oldMode = this.mode;
    this.context = call.context;
    this.mode = call.mode;
    try {
      this.drawLayers(call);
    } finally {
      this.context = old;
      this.mode = oldMode;
    }
  }
  private drawLayers(call: MaterialDrawCall): void {
    const { model } = call;
    if (this.disposed) {
      call.draw();
      return;
    }
    this.applyExpressions();
    if (call.mode !== 'beauty') {
      call.draw();
      return;
    }
    const parts = model.primitives.flatMap((primitive) => {
      const original = this.parts.find((part) => primitive.material === part.body);
      return original ? [{ ...original, primitive }] : [];
    });
    if (!parts.length) {
      call.draw();
      return;
    }
    const ordinary = model.primitives.filter((p) => !parts.some((part) => part.primitive === p));
    const ordinaryQueue = (p: PBRPrimitive) =>
      p.material.settings[0] === 2 ? 3000 : p.material.settings[0] === 1 ? 2450 : 2000;
    let groups = [...new Set([...parts.map((p) => this.queue(p.state)), ...ordinary.map(ordinaryQueue)])].sort(
      (a, b) => a - b,
    );
    const frame = call.phase === 'all' ? armed.get(call.context as Context) : undefined;
    if (call.phase === 'blend' && this.only !== undefined) groups = groups.includes(this.only) ? [this.only] : [];
    else if (frame) {
      // Inside a scene frame: opaque and mask queues now, the blended ones in the queue pass after every model.
      const later = groups.filter((q) => q >= BLEND_QUEUE);
      if (later.length) frame.drawn.push({ effect: this, queues: later });
      groups = groups.filter((q) => q < BLEND_QUEUE);
    }
    for (const queue of groups) {
      const selected = parts.filter((p) => this.queue(p.state) === queue),
        standard = ordinary.filter((p) => ordinaryQueue(p) === queue);
      const saved = model.primitives.map((p) => p.material);
      try {
        for (const p of model.primitives) p.material = hide(p.material);
        for (const part of selected) part.primitive.material = part.body;
        for (const p of standard) p.material = saved[model.primitives.indexOf(p)];
        call.draw();
        if (
          selected.some(
            (p) => p.state.definition.outlineWidthMode !== 'none' && p.state.definition.outlineWidthFactor > 0,
          )
        ) {
          for (const p of standard) p.material = hide(p.material);
          for (const part of selected) {
            for (const key of ['base', 'emission', 'maps', 'uvt', 'factors'] as const)
              Object.assign(part.outline, { [key]: part.body[key] });
            part.primitive.material = part.outline;
          }
          call.draw();
        }
      } finally {
        model.primitives.forEach((p, i) => {
          p.material = saved[i];
        });
      }
    }
  }
  private applyExpressions(): void {
    const evaluated = this.options.expressions?.evaluate();
    if (!evaluated) return;
    for (const part of this.parts) {
      const { body, authored, state } = part;
      for (const [type, key] of [
        ['color', 'base'],
        ['emissionColor', 'emission'],
      ] as const) {
        const base = authored[key],
          next = base.slice();
        for (const bind of evaluated.colors)
          if (bind.material === state.index && bind.type === type)
            for (const weight of bind.parts)
              for (let k = 0; k < next.length; k++) next[k] += (weight.target[k] - base[k]) * weight.value;
        body[key] = next;
      }
      body.maps = authored.maps.map((map) => {
        if (!map) return map;
        const copy = structuredClone(map),
          base = copy.extensions?.KHR_texture_transform ?? {},
          scale = [...(base.scale ?? [1, 1])],
          offset = [...(base.offset ?? [0, 0])];
        for (const bind of evaluated.transforms)
          if (bind.material === state.index)
            for (const weight of bind.parts)
              for (let k = 0; k < 2; k++) {
                scale[k] += (weight.scale[k] - (base.scale?.[k] ?? 1)) * weight.value;
                offset[k] += (weight.offset[k] - (base.offset?.[k] ?? 0)) * weight.value;
              }
        copy.extensions = {
          ...copy.extensions,
          KHR_texture_transform: { ...base, scale: [scale[0], scale[1]], offset: [offset[0], offset[1]] },
        };
        return copy;
      });
      body.uvt = this.coreUV(body.maps);
    }
  }
  private coreUV(maps: PBRMaterial['maps']): number[] {
    return maps.flatMap((map) => {
      const t = map?.extensions?.KHR_texture_transform ?? {},
        angle = t.rotation ?? 0,
        c = Math.cos(angle),
        s = Math.sin(angle),
        scale = t.scale ?? [1, 1],
        offset = t.offset ?? [0, 0];
      return [
        c * scale[0],
        s * scale[1],
        offset[0],
        t.texCoord ?? map?.texCoord ?? 0,
        -s * scale[0],
        c * scale[1],
        offset[1],
        0,
      ];
    });
  }
  private queue(s: State): number {
    if (s.legacy) return s.legacy.queue;
    const mode = this.parts.find((p) => p.state === s)!.original.settings[0];
    return mode === 2
      ? (s.definition.transparentWithZWrite ? 2500 : 3000) + s.definition.renderQueueOffsetNumber
      : mode === 1
        ? 2450
        : 2000;
  }
  private bindings(state: State, outline = false): GPUBindGroupEntry[] {
    if (this.disposed) throw fault('disposed', 'MToon is disposed; attach a new instance');
    const device = this.device!;
    const resource = (state.resource ??= this.resources(state, device)),
      v = state.values,
      d = state.definition;
    v.set([
      ...d.shadeColorFactor,
      0,
      ...d.parametricRimColorFactor,
      0,
      ...d.matcapFactor,
      0,
      ...d.outlineColorFactor,
      0,
    ]);
    v.set(
      [
        d.shadingShiftFactor,
        d.shadingToonyFactor,
        d.giEqualizationFactor,
        d.parametricRimFresnelPowerFactor,
        d.parametricRimLiftFactor,
        d.rimLightingMixFactor,
        d.outlineLightingMixFactor,
        this.time,
        d.uvAnimationScrollXSpeedFactor,
        d.uvAnimationScrollYSpeedFactor,
        d.uvAnimationRotationSpeedFactor,
        d.outlineWidthFactor,
      ],
      16,
    );
    const viewport = this.context!.view?.viewport;
    v[29] = viewport ? viewport[2] / viewport[3] : this.context!.width / this.context!.height;
    v[28] = ['none', 'worldCoordinates', 'screenCoordinates'].indexOf(d.outlineWidthMode);
    const evaluated = this.options.expressions?.evaluate();
    const colors = { shadeColor: 0, rimColor: 1, matcapColor: 2, outlineColor: 3 } as const;
    for (const bind of evaluated?.colors ?? []) {
      if (bind.material !== state.index || !(bind.type in colors)) continue;
      const start = colors[bind.type as keyof typeof colors] * 4;
      for (let k = 0; k < 3; k++) {
        const base = v[start + k];
        for (const part of bind.parts) v[start + k] += (part.target[k] - base) * part.value;
      }
    }
    const moves = evaluated?.transforms.find((t) => t.material === state.index)?.parts ?? [];
    for (let k = 0; k < fields.length; k++) this.transform(v, 8 + k * 3, d[fields[k]], moves);
    for (const map of resource.maps) if (map.readView) map.view = map.readView() ?? map.fallback!;
    const binding = writeUniform(
      device,
      resource.buffer,
      v as Float32Array<ArrayBuffer>,
      this.context!.view ?? this.context!,
    );
    return [
      { binding: 180, resource: binding ?? { buffer: resource.buffer } },
      ...resource.maps.flatMap((m, i) =>
        (i === 4 && !outline) || (['gbuffer', 'capture', 'occlusion'].includes(this.mode) && [2, 3].includes(i))
          ? []
          : [
              { binding: 181 + i * 2, resource: m.view },
              { binding: 182 + i * 2, resource: m.sampler },
            ],
      ),
    ];
  }
  private transform(
    v: Float32Array,
    row: number,
    map: MToonTextureInfo | undefined,
    moves: readonly { scale: readonly number[]; offset: readonly number[]; value: number }[],
  ): void {
    const t = map?.extensions?.KHR_texture_transform,
      offset = [...(t?.offset ?? [0, 0])],
      scale = [...(t?.scale ?? [1, 1])],
      angle = t?.rotation ?? 0,
      c = Math.cos(angle),
      s = Math.sin(angle);
    for (let k = 0; k < 2; k++) {
      const baseOffset = offset[k],
        baseScale = scale[k];
      for (const move of moves) {
        offset[k] += (move.offset[k] - baseOffset) * move.value;
        scale[k] += (move.scale[k] - baseScale) * move.value;
      }
    }
    v.set(
      [
        c * scale[0],
        s * scale[1],
        offset[0],
        t?.texCoord ?? map?.texCoord ?? 0,
        -s * scale[0],
        c * scale[1],
        offset[1],
        0,
        map?.scale ?? 1,
        +!!map,
        0,
        0,
      ],
      row * 4,
    );
  }
  private resources(state: State, device: GPUDevice): Resource {
    const maps: Resource['maps'] = [],
      owned: GPUTexture[] = [];
    try {
      for (let i = 0; i < fields.length; i++) {
        const map = state.definition[fields[i]];
        let texture: GPUTexture;
        let sampler: GPUSampler;
        if (map) {
          const def = this.model.asset.doc.textures![map.index];
          const source = [
            ...(['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'] as const).map(
              (k) => def.extensions?.[k]?.source,
            ),
            def.source,
          ].find((index) => typeof index === 'number' && this.model.image(index, true));
          if (source === undefined)
            throw fault(
              'unsupported',
              'MToon texture needs a decoded source image; load the avatar with its texture decoder',
            );
          const image = this.model.image(source),
            srgb = [0, 2, 3].includes(i);
          if ('streamed' in image) {
            const fallback = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
            device.queue.writeTexture(
              { texture: fallback },
              new Uint8Array(i === 1 ? [0, 0, 0, 255] : [255, 255, 255, 255]),
              { bytesPerRow: 4 },
              [1, 1],
            );
            texture = fallback;
          } else if ('ktx2' in image || 'mipmaps' in image) texture = this.model.uploadImage(source, device, srgb);
          else {
            const levels = Math.floor(Math.log2(Math.max(image.width, image.height))) + 1;
            texture = device.createTexture({
              size: [image.width, image.height],
              mipLevelCount: levels,
              format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
              usage: 22,
            });
            try {
              if ('data' in image)
                device.queue.writeTexture({ texture }, image.data, { bytesPerRow: image.width * 4 }, [
                  image.width,
                  image.height,
                ]);
              else device.queue.copyExternalImageToTexture({ source: image }, { texture }, [image.width, image.height]);
              generateMipmaps(device, texture, levels, this.mipPipelines);
            } catch (error) {
              texture.destroy();
              throw error;
            }
          }
          owned.push(texture);
          const s = def.sampler === undefined ? {} : this.model.asset.doc.samplers![def.sampler];
          const wrap = (n: number | undefined) =>
            n === 33071 ? ('clamp-to-edge' as const) : n === 33648 ? ('mirror-repeat' as const) : ('repeat' as const);
          sampler = device.createSampler({
            addressModeU: wrap(s.wrapS),
            addressModeV: wrap(s.wrapT),
            magFilter: s.magFilter === 9728 ? 'nearest' : 'linear',
            minFilter: [9728, 9984, 9986].includes(s.minFilter ?? 9729) ? 'nearest' : 'linear',
            mipmapFilter: [9984, 9985].includes(s.minFilter ?? 9987) ? 'nearest' : 'linear',
            lodMaxClamp: [9728, 9729].includes(s.minFilter ?? 9987) ? 0 : 32,
          });
        } else {
          texture = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 6 });
          device.queue.writeTexture(
            { texture },
            new Uint8Array(i === 1 ? [0, 0, 0, 255] : [255, 255, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1],
          );
          owned.push(texture);
          sampler = device.createSampler();
        }
        const image = map
          ? (() => {
              const def = this.model.asset.doc.textures![map.index];
              const source = [
                ...(['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif'] as const).map(
                  (k) => def.extensions?.[k]?.source,
                ),
                def.source,
              ].find((index) => typeof index === 'number' && this.model.image(index, true));
              return source === undefined ? undefined : this.model.image(source);
            })()
          : undefined;
        const fallback = texture.createView();
        maps.push({
          texture,
          sampler,
          view: fallback,
          ...(image && 'streamed' in image
            ? { fallback, readView: () => (image as GLTFStreamedImage).view(device, [0, 2, 3].includes(i)) }
            : {}),
        });
      }
      return { buffer: device.createBuffer({ size: 416, usage: 72 }), maps };
    } catch (error) {
      for (const texture of owned) texture.destroy();
      throw error;
    }
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.mipPipelines.clear();
    this.device = engine.gpu ?? undefined;
  }
  private release(): void {
    for (const state of this.states) {
      if (state.resource) {
        retire(this.device!, state.resource.buffer);
        for (const m of state.resource.maps) retire(this.device!, m.texture);
      }
      state.resource = undefined;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.dead = true;
    this.removeDraw?.();
    this.removeDraw = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.engine.sceneOf(this)?.removePlugin(this.name);
    for (const p of this.parts) if (p.primitive.material === p.body) p.primitive.material = p.original;
    this.release();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
