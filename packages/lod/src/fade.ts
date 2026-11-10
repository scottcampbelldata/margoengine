// Dithered cross-fade between levels: for `duration` seconds both levels draw, each pixel from exactly one of them by a
// fixed noise threshold, so a level switch dissolves instead of popping. Core meshes read the threshold from a buffer
// indexed by mesh id (a patch of core's shader; the id already travels in the instance data); gltf-pro models and
// materials meshes read it from a lighting effect's uniform. Dither: interleaved gradient noise (Jimenez 2014).
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { Geometry, type EngineKernel, type Mesh } from '@margoengine/core';
import { meshRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import type { PBRModel } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import type { LOD, LODObject, LODSystem } from './index.js';
declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };

/** Options of {@link LODFade}. */
export interface LODFadeOptions {
  /** Seconds a switch takes, above 0. Default 0.25. */
  duration?: number;
}
/** Where a level's fade value goes. `value` is the threshold: above 0 keeps pixels below it, below 0 keeps those at or past it. */
interface Fader {
  set(value: number): void;
  end(): void;
}
interface Active {
  lod: LOD;
  time: number;
  /** Shows the outgoing level for the last time: hides it and restores what the fade changed. */
  finish(): void;
  set(value: number): void;
}

const dither = 'fract(52.9829189*fract(dot(floor(lod_at),vec2f(0.06711056,0.00583715))))';
/** Pixel `lod_at` survives a fade value `lod_f`: zero keeps everything. */
export const fadeTest = `fn lod_fade_keep(lod_at:vec2f,lod_f:f32)->bool {let d=${dither};if(lod_f>0.0){return d<lod_f;}return lod_f==0.0||d>=-lod_f;}`;

/**
 * The same test on the CPU, for tests and tools: whether pixel (x, y) draws at fade value `value`. A value and its
 * negative keep complementary pixels, so two levels at `t` and `-t` cover every pixel exactly once.
 */
export function fadeKeeps(x: number, y: number, value: number): boolean {
  const fract = (v: number) => v - Math.floor(v),
    d = fract(52.9829189 * fract(Math.floor(x) * 0.06711056 + Math.floor(y) * 0.00583715));
  return value === 0 || (value > 0 ? d < value : d >= -value);
}
/** Binding of the fade values in core's group 0, clear of the numbers other packages take from 1 upward. */
const BINDING = 95;
/** core's mesh shader with the fade: the mesh id, flat to the fragment, picks a value tested before anything is lit. */
export function coreFadeShader(code: string): string {
  if (!code.includes('@location(3) material:vec4f') || code.includes('var<storage,read> lod_fades:')) return code;
  const withId = code.includes('lod_id:u32')
    ? code
    : code
        .replace(
          '@location(3) material:vec4f }',
          '@location(3) material:vec4f,@location(14) @interpolate(flat) lod_id:u32 }',
        )
        .replace('o.color=i.color.rgb;', 'o.color=i.color.rgb;o.lod_id=u32(i.factors.w);');
  return withId.replace(
    /@fragment fn fragment\(i:Output,@builtin\(front_facing\) front:bool\)->@location\(0\) vec4f \{/,
    (head) =>
      `@group(0) @binding(${BINDING}) var<storage,read> lod_fades:array<f32>;\n${fadeTest}\n${head}\nif(!lod_fade_keep(i.clip.xy,lod_fades[i.lod_id])){discard;}`,
  );
}
/** gltf-pro's shader with the fade, on every entry that shades a surface, read from the uniform at `group` binding 97. */
export function modelFadeShader(code: string, group: number): string {
  return `@group(${group}) @binding(97) var<uniform> lod_fade:vec4f;\n${fadeTest}\n${code.replaceAll(
    'let s=surface(i,front);',
    'if(!lod_fade_keep(i.clip.xy,lod_fade.x)){discard;}let s=surface(i,front);',
  )}`;
}

const target = (o: Mesh | { readonly root: Mesh }) => ('root' in o ? o.root : o);
const owner = (o: LODObject): PBRModel | undefined => {
  const model = (o as { model?: PBRModel } | null)?.model ?? (o as unknown as PBRModel | null);
  return typeof model?.addLighting === 'function' ? model : undefined;
};

/**
 * Cross-fades the levels of a `LODSystem`: mesh, model, materials mesh and Geometry levels dissolve into each other, or
 * into nothing for a `null` level. A switch to or from an Imposter stays instant, as does everything on WebGL2.
 * @throws RangeError for a `duration` that is not above 0; MargoError `'state'` when the system is on no engine.
 */
export class LODFade implements EnginePlugin {
  readonly name: string;
  duration: number;
  private engine?: Engine;
  private readonly fades = new Map<LOD, Active>();
  private readonly effects = new Map<PBRModel, { buffer?: GPUBuffer; data: Float32Array; remove(): void }>();
  private readonly ghosts: Mesh[] = [];
  private readonly shaders = new Map<string, string>();
  /** Per mesh id, what core's shader reads. */
  private values = new Float32Array(0);
  private readonly touched = new Set<number>();
  private buffer?: GPUBuffer;
  private detach?: () => void;
  /** Same as `engine.use(new LODFade(system, options))`; returns the LODFade. */
  static attach(engine: EngineKernel, system: LODSystem, options?: LODFadeOptions): LODFade {
    const value = new LODFade(system, options);
    engine.use(value);
    return value;
  }
  constructor(
    readonly system: LODSystem,
    { duration = 0.25 }: LODFadeOptions = {},
  ) {
    if (!(duration > 0 && duration < Infinity)) throw new RangeError('LODFade needs a duration above 0; pass seconds');
    this.duration = duration;
    this.name = 'lod-fade:' + system.name;
  }
  setup(engine: Engine): void {
    requireWebGPU(engine, 'LODFade');
    if (this.detach) throw new MargoError('state', 'LODFade is in use; make one per engine');
    this.engine = engine;
    this.detach = this.system.setTransition((lod, from, to) => this.begin(lod, from, to));
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -1,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        let code = this.shaders.get(c.shader);
        if (!code) {
          if (this.shaders.size >= 64) this.shaders.clear();
          this.shaders.set(c.shader, (code = coreFadeShader(c.shader)));
        }
        if (code === c.shader) return;
        c.shader = code;
        c.bindings.push({ binding: BINDING, resource: { buffer: this.upload(c.device) } });
      },
    });
  }
  /** The core values on the GPU, sized to the store: only the meshes that changed are written. */
  private upload(device: GPUDevice): GPUBuffer {
    const size = this.engine!.store.capacity;
    if (this.values.length < size) {
      const values = new Float32Array(size);
      values.set(this.values);
      this.values = values;
    }
    if (!this.buffer || this.buffer.size < size * 4) {
      this.buffer?.destroy();
      this.buffer = device.createBuffer({ size: size * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(this.buffer, 0, this.values);
      this.touched.clear();
    }
    for (const id of this.touched) device.queue.writeBuffer(this.buffer, id * 4, this.values, id, 1);
    this.touched.clear();
    return this.buffer;
  }
  /** Objects fading now. */
  get active(): number {
    return this.fades.size;
  }
  onPreUpdate(delta = 0): void {
    for (const fade of this.fades.values()) {
      fade.time += delta;
      const t = fade.time / this.duration;
      if (t >= 1) {
        fade.finish();
        this.fades.delete(fade.lod);
      } else fade.set(Math.max(t, 1e-3));
    }
  }
  /**
   * Adds the fade to `lod`'s model levels now, so their shaders change here rather than on the first switch, which
   * compiles their pipelines mid-flight.
   */
  prepare(lod: LOD): void {
    for (const { object } of lod.levels) {
      const model = object && owner(object);
      if (model) this.effect(model);
    }
  }
  /** Ends every fade now, on its new level. */
  finish(): void {
    for (const fade of this.fades.values()) fade.finish();
    this.fades.clear();
  }
  private effect(model: PBRModel): (value: number) => void {
    let entry = this.effects.get(model);
    if (!entry) {
      const made: { buffer?: GPUBuffer; data: Float32Array; remove(): void } = {
        data: new Float32Array(4),
        remove: () => {},
      };
      made.remove = model.addLighting({
        owner: this.engine,
        shader: modelFadeShader,
        bindings: () => {
          const device = this.engine!.gpu!;
          if (!made.buffer) {
            made.buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            device.queue.writeBuffer(made.buffer, 0, made.data);
          }
          return [{ binding: 97, resource: { buffer: made.buffer } }];
        },
      });
      model.onDispose(() => this.effects.delete(model));
      this.effects.set(model, (entry = made));
    }
    const held = entry;
    return (value) => {
      held.data[0] = value;
      if (held.buffer) this.engine!.gpu!.queue.writeBuffer(held.buffer, 0, held.data);
    };
  }
  /** Fades a core mesh through its slot in the values. */
  private coreFader(mesh: Mesh): Fader {
    const { id } = meshRuntime(mesh),
      set = (value: number) => {
        if (id >= this.values.length) {
          const values = new Float32Array(this.engine!.store.capacity);
          values.set(this.values);
          this.values = values;
        }
        this.values[id] = value;
        this.touched.add(id);
      };
    return { set, end: () => set(0) };
  }
  private fader(object: LODObject): Fader | undefined {
    if (!object || object instanceof Geometry) return undefined;
    const model = owner(object);
    if (model) {
      const set = this.effect(model);
      return { set, end: () => set(0) };
    }
    return this.coreFader(target(object as Mesh));
  }
  /** Prepares a switch; false leaves it to the system (instant). */
  private begin(lod: LOD, from: number, to: number): boolean {
    const e = this.engine;
    if (!e?.gpu || e.backend !== 'webgpu') return false;
    this.fades.get(lod)?.finish();
    this.fades.delete(lod);
    const a = lod.levels[from].object,
      b = lod.levels[to].object;
    if (!this.fadeable(a) || !this.fadeable(b) || (a === null && b === null)) return false;
    const anchor = lod.anchor,
      steps: Fader[] = [],
      leaving: (() => void)[] = [];
    let outgoing: Fader | undefined, incoming: Fader | undefined;
    if (a instanceof Geometry) {
      // The anchor takes the new geometry or none; a ghost at the same place keeps drawing the old one.
      const ghost = this.ghosts.pop() ?? e.createMesh();
      ghost.setParent(anchor).setGeometry(a).setMaterial(anchor.material);
      ghost.visible = true;
      outgoing = this.coreFader(ghost);
      leaving.push(() => {
        ghost.visible = false;
        ghost.setGeometry(null);
        ghost.setParent(null);
        this.ghosts.push(ghost);
      });
    } else if (a) {
      outgoing = this.fader(a);
      leaving.push(() => {
        if (this.alive(a)) target(a as Mesh).visible = false;
      });
    }
    if (b instanceof Geometry) {
      anchor.setGeometry(b);
      incoming = this.coreFader(anchor);
    } else {
      if (a instanceof Geometry) anchor.setGeometry(null);
      if (b) {
        incoming = this.fader(b);
        target(b as Mesh).visible = true;
      }
    }
    for (const fader of [outgoing, incoming]) if (fader) steps.push(fader);
    const fade: Active = {
      lod,
      time: 0,
      set(value) {
        outgoing?.set(-value);
        incoming?.set(value);
      },
      finish() {
        for (const step of steps) step.end();
        for (const leave of leaving) leave();
      },
    };
    fade.set(1e-3);
    this.fades.set(lod, fade);
    return true;
  }
  /** False for a level disposed during its fade. */
  private alive(object: LODObject): boolean {
    const model = owner(object);
    if (model) return !model.disposed;
    const mesh = meshRuntime(target(object as Mesh));
    return this.engine?.meshes.get(mesh.id) === mesh;
  }
  private fadeable(object: LODObject): boolean {
    return (
      object === null ||
      object instanceof Geometry ||
      !!owner(object) ||
      typeof (target(object as Mesh) as Partial<Mesh>).setGeometry === 'function'
    );
  }
  onDeviceRestored(): void {
    for (const entry of this.effects.values()) entry.buffer = undefined;
    this.buffer = undefined;
  }
  dispose(): void {
    this.finish();
    this.detach?.();
    this.detach = undefined;
    for (const entry of this.effects.values()) {
      entry.remove();
      entry.buffer?.destroy();
    }
    this.effects.clear();
    this.buffer?.destroy();
    this.buffer = undefined;
    for (const ghost of this.ghosts) ghost.dispose();
    this.ghosts.length = 0;
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
