/// <reference lib="esnext.disposable" preserve="true" />
// Light linking and layers: each clustered point or spot light carries a 32-bit layer mask (default 1, layer 0), and each
// receiver added through LightLayers carries one too (default 1); a light shades a receiver when the two masks share a
// bit. A rim light on layer 1 (mask 2) and a hero added with layers 3 light the hero and leave the set dark, the
// light linking of offline renderers expressed as masks. The light masks live in a storage buffer (binding 154) read by
// a per-light term; the receiver's mask is a constant in its own shader, set before the light loop runs, so a receiver's
// layers cost no per-object data. Core meshes keep layer 0 (mask 1): core has no per-mesh slot for a mask.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Clustered, ClusteredLightTerm, ClusteredLighting, ClusteredReceiver } from './index.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** Options of {@link LightLayers}. */
export interface LightLayerOptions {
  /** The clustered lighting whose point and spot lights get layer masks. */
  lights: Clustered;
}
/** Options of {@link LightLayers.add}. */
export interface LightLayerReceiverOptions {
  /** 32-bit mask of the layers whose lights shade this receiver. Default 1 (layer 0, where every light starts). */
  layers?: number;
  /** As `Clustered.add`: false leaves out local-light shadows. Default true. */
  receiveShadow?: boolean;
}
const MAX_LIGHTS = 1024,
  BINDING = 154,
  // The light loop's call in core-style and gltf-pro shaders (Clustered.shader and Clustered.pbr).
  CALL = /clusterLighting\(i\.clip\.xy,/g;

const sampling = (group: number) => /* wgsl */ `
struct ClusterLayerData {count:vec4u,masks:array<u32>}
@group(${group}) @binding(${BINDING}) var<storage,read> clusterLayerData:ClusterLayerData;
var<private> clusterLayerMask=1u;
fn clusterLayer(index:u32)->f32 {
  let mask=select(1u,clusterLayerData.masks[min(index,max(clusterLayerData.count.x,1u)-1u)],index<clusterLayerData.count.x);
  return select(0.0,1.0,(mask&clusterLayerMask)!=0u);
}
fn clusterLightingLayers(layers:u32,pixel:vec2f,position:vec3f,n:vec3f,eye:vec3f,base:vec3f,roughness:f32,metal:f32,dielectricF0:vec3f,dielectricF90:f32)->vec3f {
  clusterLayerMask=layers;return clusterLighting(pixel,position,n,eye,base,roughness,metal,dielectricF0,dielectricF90);
}
`;
/** A 32-bit layer mask: an integer from 0 to 2^32 - 1. */
function mask(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff)
    throw new RangeError(`${label} must be an integer layer mask from 0 to 2^32 - 1 (bit n is layer n)`);
  return (value as number) >>> 0;
}
/**
 * Light layers for clustered lighting: {@link setLayers} gives the point and spot lights of `Clustered.setLights` their
 * layer masks (index i for light i; default 1), and {@link add} lights a receiver (a gltf-pro model, materials mesh or
 * terrain) with only the lights whose mask shares a bit with its own. Core meshes are on layer 0 (mask 1). Area and
 * directional lights are not layered. Without masks or layered receivers it adds nothing to the shaders or the GPU work.
 * @throws TypeError without the Clustered lights or for an invalid or duplicate receiver; RangeError for a bad mask.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`.
 */
export class LightLayers implements EnginePlugin, ClusteredLightTerm {
  readonly name = 'clustered:layers';
  /** @internal ClusteredLightTerm: the factor in the light loop. */
  readonly term = 'clusterLayer(index)';
  readonly lights: Clustered;
  private engine?: Engine;
  private device?: GPUDevice;
  private buffer?: GPUBuffer;
  private entries: GPUBindGroupEntry[] = [];
  private words = new Uint32Array(4);
  private listValue: readonly (number | null | undefined)[] = Object.freeze([]);
  private readonly receivers = new Map<ClusteredReceiver, { layers: number; remove: () => void }>();
  private dirty = true;
  private disposed = false;
  constructor(options: LightLayerOptions) {
    if (!options?.lights || typeof options.lights.setLights !== 'function')
      throw new TypeError('LightLayers needs the Clustered lights: new LightLayers({ lights })');
    this.lights = options.lights;
  }
  get owner(): Engine | undefined {
    return this.engine;
  }
  static attach(instance: EngineKernel, options: LightLayerOptions): LightLayers {
    const effect = new LightLayers(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  /** The masks last given to `setLayers` (a frozen copy of the list). */
  get list(): readonly (number | null | undefined)[] {
    return this.listValue;
  }
  /**
   * Entry i is the layer mask of the light at index i of `Clustered.setLights` (null or undefined: 1, layer 0); lights
   * past the end are on layer 0. A mask of 0 lights nothing. Validates every entry before changing anything.
   */
  setLayers(masks: readonly (number | null | undefined)[]): this {
    if (this.disposed) throw new MargoError('disposed', 'LightLayers is disposed; create new LightLayers');
    if (!Array.isArray(masks) || masks.length > MAX_LIGHTS)
      throw new RangeError(`Expected an array of at most ${MAX_LIGHTS} light layer masks, one per clustered light`);
    const values = masks.map((value, i) =>
      value === null || value === undefined ? 1 : mask(value, `Light ${i} layers`),
    );
    const words = new Uint32Array(4 + Math.max(values.length, 1));
    words[0] = values.length;
    words.set(values, 4);
    this.words = words;
    this.listValue = Object.freeze([...masks]);
    this.dirty = true;
    this.sync();
    return this;
  }
  /**
   * Lights `receiver` through the Clustered lights with only the lights on its `layers` (a gltf-pro model, materials
   * mesh or terrain; see `Clustered.add`). Returns the remover.
   */
  add(receiver: ClusteredReceiver, { layers = 1, receiveShadow = true }: LightLayerReceiverOptions = {}): () => void {
    if (this.disposed) throw new MargoError('disposed', 'LightLayers is disposed; create new LightLayers');
    if (!receiver || typeof receiver.addLighting !== 'function' || this.receivers.has(receiver))
      throw new TypeError('Invalid or duplicate layered receiver; pass a model or mesh with addLighting once');
    const value = mask(layers, 'Receiver layers'),
      proxy: ClusteredReceiver = { addLighting: (effect) => receiver.addLighting(this.masked(effect, value)) };
    // Clustered drops a receiver that reports disposed; the proxy reports what its receiver does.
    if ('disposed' in receiver)
      Object.defineProperty(proxy, 'disposed', { get: () => (receiver as { disposed?: boolean }).disposed });
    const remove = this.lights.add(proxy, { receiveShadow }),
      entry = {
        layers: value,
        remove: () => {
          if (this.receivers.get(receiver) !== entry) return;
          this.receivers.delete(receiver);
          remove();
          this.sync();
        },
      };
    this.receivers.set(receiver, entry);
    this.sync();
    return entry.remove;
  }
  /** Clustered lighting for a receiver on `layers`: its light loop call sets the mask first while the term is in use. */
  private masked(effect: ClusteredLighting, layers: number): ClusteredLighting {
    const call = `clusterLightingLayers(${layers}u,i.clip.xy,`,
      on = () => this.lights.layers === this,
      memo = new WeakMap<object, object>();
    return {
      get owner() {
        return effect.owner;
      },
      pbr: (group: number) => {
        const hook = effect.pbr(group);
        if (!on()) return hook;
        let out = memo.get(hook) as typeof hook | undefined;
        if (!out) memo.set(hook, (out = { ...hook, light: hook.light.replace(CALL, call) }));
        return out;
      },
      shader: (source: string, group?: number) => {
        const code = effect.shader(source, group);
        return on() ? code.replace(CALL, call) : code;
      },
      bindings: () => effect.bindings(),
    };
  }
  /** @internal ClusteredLightTerm: WGSL defining `clusterLayer` and `clusterLightingLayers`. */
  declarations(group: number): string {
    return sampling(group);
  }
  /** @internal ClusteredLightTerm: binding 154 of the lit shader's group. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.buffer || this.disposed)
      throw new MargoError('state', 'Light layers are not attached; engine.use(layers) first');
    return this.entries;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'LightLayers is disposed; create new LightLayers');
    if (!engine.gpu)
      throw new MargoError(
        'unsupported',
        'LightLayers requires the WebGPU backend; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.device = engine.gpu;
    this.dirty = true;
    this.sync();
  }
  /** Some light is off layer 0 only, or some receiver is not exactly on layer 0: the masks change what is lit. */
  private get needed(): boolean {
    for (let i = 0; i < this.words[0]; i++) if (this.words[4 + i] !== 1) return true;
    for (const [receiver, { layers }] of this.receivers)
      if ((receiver as { disposed?: boolean }).disposed) this.receivers.delete(receiver);
      else if (layers !== 1) return true;
    return false;
  }
  // The buffer and the hook exist only while the masks change what is lit, so unused LightLayers change no GPU call.
  private sync(): void {
    const active = !!this.device && !this.disposed && this.needed;
    if (active && (!this.buffer || this.buffer.size < this.words.byteLength)) {
      this.buffer?.destroy();
      const buffer = (this.buffer = this.device!.createBuffer({
        size: Math.max(256, 2 ** Math.ceil(Math.log2(this.words.byteLength))),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }));
      this.entries = [{ binding: BINDING, resource: { buffer } }];
      this.dirty = true;
    }
    const hook = active ? this : undefined;
    if (this.lights.layers !== hook) this.lights.layers = hook;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -3.5,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.buffer || !this.dirty || this.lights.layers !== this) return;
        c.device.queue.writeBuffer(this.buffer, 0, this.words as Uint32Array<ArrayBuffer>);
        this.dirty = false;
      },
    });
  }
  private release(): void {
    if (this.lights.layers === this) this.lights.layers = undefined;
    this.buffer?.destroy();
    this.buffer = undefined;
    this.entries = [];
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    for (const { remove } of [...this.receivers.values()]) remove();
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
