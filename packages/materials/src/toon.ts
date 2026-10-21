// Toon shading for loaded glTF-pro models: each chosen primitive draws a copy of its material record whose shading hook
// (gltf-pro PBRMaterial.shading) rewrites the lighting as toon-shader.ts does for ToonMaterial. The copy shares the
// glTF material's colours, factors and maps (live edits show), so skinned, morphed and instanced primitives keep their
// deformation and textures; dispose() puts the original records back.
import type { PBRMaterial, PBRMaterialShading, PBRModel, PBRPrimitive } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import { Texture } from './built-material.js';
import { toonLit, toonShader } from './toon-shader.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** `toonModel` options. */
export interface ToonModelOptions {
  /** The ramp, as `ToonMaterial.gradientMap`: its RGB at u = n.l * 0.5 + 0.5; null for `steps` bands. */
  gradientMap?: Texture | null;
  /** Flat bands without a gradientMap, an integer 2 through 256 (default 3). */
  steps?: number;
  /** The primitives to switch, as indices into `model.primitives` or the primitives themselves (default all). */
  primitives?: readonly (number | PBRPrimitive)[];
}
const whites = new WeakMap<GPUDevice, [GPUTextureView, GPUSampler]>();
/**
 * A loaded glTF-pro model (or some of its primitives) drawn with toon shading, made by `toonModel`. `steps` and
 * `gradientMap` are live; `dispose()` restores the model's own materials.
 */
export class ToonModel {
  private toonSteps = 3;
  private toonMap: Texture | null = null;
  /** Each switched primitive's own material and the toon copy it draws. */
  private readonly restore = new Map<PBRPrimitive, [PBRMaterial, PBRMaterial]>();
  private readonly buffers = new WeakMap<GPUDevice, GPUBuffer>();
  private readonly values = new Float32Array(4);
  private unsubscribe?: () => void;
  disposed = false;
  constructor(
    readonly model: PBRModel,
    options: ToonModelOptions = {},
  ) {
    if (!model || model.disposed || !Array.isArray(model.primitives))
      throw new TypeError('toonModel needs a live glTF-pro model; pass the PBRModel loadGLTF or parseGLTF returned');
    if (model.primitives.some((p) => Object.hasOwn(p.material, 'extendedFrame')))
      throw new TypeError('toonModel is for loaded glTF models; give a createMesh mesh a ToonMaterial instead');
    const { steps, gradientMap, primitives } = options ?? {};
    if (steps !== undefined) this.steps = steps;
    if (gradientMap != null) this.gradientMap = gradientMap;
    const chosen = (primitives ?? model.primitives).map((p) => {
      const primitive = typeof p === 'number' ? model.primitives[p] : p;
      if (!primitive || !model.primitives.includes(primitive))
        throw new RangeError(
          `toonModel primitive ${String(p)} is not one of the model's; pass indices into model.primitives`,
        );
      return primitive;
    });
    const shading: PBRMaterialShading = {
      shader: (code, group) => toonShader(code, group),
      lit: (code) => toonLit(code),
      bindings: () => this.bindings(),
    };
    // One toon copy per original material record, shared by the chosen primitives that use it.
    const copies = new Map<PBRMaterial, PBRMaterial>();
    for (const primitive of new Set(chosen)) {
      const original = primitive.material;
      let copy = copies.get(original);
      if (!copy) {
        // The base layer only: physical lobes, transmission and material extensions are left out of the toon copy.
        const {
          physical: _physical,
          extended: _extended,
          tint: _tint,
          volume: _volume,
          dispersion: _dispersion,
          extension: _extension,
          ...base
        } = original;
        copies.set(original, (copy = { ...base, shading }));
      }
      this.restore.set(primitive, [original, copy]);
      primitive.material = copy;
    }
    this.unsubscribe = model.onDispose(() => this.dispose());
  }
  /** Bands without a gradientMap, an integer 2 through 256 (default 3); band k of n is k / (n - 1). Live. */
  get steps(): number {
    return this.toonSteps;
  }
  set steps(v: number) {
    if (typeof v !== 'number') throw new TypeError('ToonModel steps must be a number; set an integer 2 through 256');
    if (!Number.isInteger(v) || v < 2 || v > 256)
      throw new RangeError('ToonModel steps is out of range; set an integer 2 through 256');
    this.toonSteps = v;
  }
  /** The ramp texture, or null for `steps` bands. Live. */
  get gradientMap(): Texture | null {
    return this.toonMap;
  }
  set gradientMap(v: Texture | null) {
    if (v != null && !(v instanceof Texture))
      throw new TypeError('ToonModel gradientMap must be a Texture; pass a Texture or null');
    this.toonMap = v ?? null;
  }
  /** Group-2 entries of the ramp (toon-shader.ts bindings 191-193) on the model's device. */
  private bindings(): GPUBindGroupEntry[] {
    if (this.disposed) throw new MargoError('disposed', 'ToonModel is disposed; call toonModel again');
    const device = this.model.root.engine.gpu;
    if (!device) throw new MargoError('unsupported', 'Toon shading requires WebGPU; use a WebGPU engine');
    let buffer = this.buffers.get(device);
    if (!buffer)
      this.buffers.set(
        device,
        (buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })),
      );
    this.values.set([+!!this.toonMap, this.toonSteps, 0, 0]);
    device.queue.writeBuffer(buffer, 0, this.values);
    const [view, sampler] = this.toonMap?.sampled(device, false, 'gradientMap') ?? white(device);
    return [
      { binding: 191, resource: { buffer } },
      { binding: 192, resource: view },
      { binding: 193, resource: sampler },
    ];
  }
  /** Gives the primitives their own materials back (a later `selectVariant` call has replaced them already). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    for (const [primitive, [original, copy]] of this.restore)
      if (primitive.material === copy) primitive.material = original;
    this.restore.clear();
    const device = this.model.root.engine.gpu;
    if (device) this.buffers.get(device)?.destroy();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
/** Opaque white with a linear sampler, bound while no gradientMap is set. */
function white(device: GPUDevice): [GPUTextureView, GPUSampler] {
  let w = whites.get(device);
  if (!w) {
    const texture = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    whites.set(device, (w = [texture.createView(), device.createSampler()]));
  }
  return w;
}
/**
 * Draws a loaded glTF-pro model (or the `primitives` named) with toon shading, as `ToonMaterial` draws a constructed
 * mesh: Lambert diffuse read through `gradientMap` or `steps` bands, for the sun, clustered lights and shadows, with
 * the model's own colours and maps. Skinned, morphed and instanced primitives keep their deformation. Physical layers
 * (clearcoat, sheen, transmission, iridescence) and material extensions are left out of the toon primitives.
 * `selectVariant` replaces the toon materials; call `toonModel` again after it.
 * @throws TypeError for a disposed or non-glTF-pro model; RangeError for a primitive not in the model or bad `steps`.
 */
export function toonModel(model: PBRModel, options?: ToonModelOptions): ToonModel {
  return new ToonModel(model, options);
}
