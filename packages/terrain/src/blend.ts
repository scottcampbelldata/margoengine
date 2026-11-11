/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
} from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Terrain } from './index.js';
import { noiseCode, openMeshBlock } from './mesh-patch.js';
import type { TerrainVirtualTexture } from './rvt.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

/** How a mesh fades into the ground under it. Invalid values throw RangeError. */
export interface TerrainBlendOptions {
  /** Height above the ground, in world units, over which the mesh fades into the ground, above 0. Default 0.5. */
  height?: number;
  /**
   * How much value noise moves the fade's top and bottom, as a share of `height`, 0 to 1: at 1 the line wanders by up
   * to half of `height` up and down, so it never reads as a ruled line. Default 0.5.
   */
  noise?: number;
  /** How far the mesh's shading normal turns to the ground's where it is faded, 0 to 1. Default 1. */
  normal?: number;
}
const DEFAULTS = { height: 0.5, noise: 0.5, normal: 1 };
let serial = 0;
const num = (value: number) => {
  const text = String(Math.fround(value));
  return /[.e]/.test(text) ? text : text + '.0';
};

function settings(options: TerrainBlendOptions | undefined, base: Required<TerrainBlendOptions>) {
  if (options !== undefined && (options === null || typeof options !== 'object'))
    throw new RangeError('Terrain blend options must be an object');
  const height = options?.height ?? base.height,
    noise = options?.noise ?? base.noise,
    normal = options?.normal ?? base.normal;
  if (
    typeof height !== 'number' ||
    !(height > 0) ||
    !Number.isFinite(Math.fround(height)) ||
    typeof noise !== 'number' ||
    !(noise >= 0 && noise <= 1) ||
    typeof normal !== 'number' ||
    !(normal >= 0 && normal <= 1)
  )
    throw new RangeError(
      'Invalid terrain blend options; height must be finite and above 0, noise and normal between 0 and 1.',
    );
  return { height, noise, normal };
}

/**
 * Mesh to terrain blending: where a mesh on core's standard material (a rock, a cliff, a wall) meets the terrain, its
 * lowest `height` fades into the ground under it, colour from the terrain's virtual texture, shading normal from the
 * heightmap, roughness the terrain's, so no hard seam line shows where the two surfaces cross.
 */
export class TerrainBlend implements EnginePlugin {
  readonly name = 'terrain:blend:' + ++serial;
  private engine?: Engine;
  private disposed = false;
  private readonly defaults: Required<TerrainBlendOptions>;
  private readonly rows = new Map<Mesh, { id: number; height: number; noise: number; normal: number }>();
  private dirty = true;
  private buffer?: GPUBuffer;
  private capacity = 0;
  private source = '';
  private shader = '';
  private binding = 40;
  private heights?: GPUTexture;
  private cache?: GPUTexture;
  private entries: GPUBindGroupEntry[] = [];
  constructor(
    readonly terrain: Terrain,
    readonly virtualTexture: TerrainVirtualTexture,
    options: TerrainBlendOptions = {},
  ) {
    if (
      !terrain ||
      typeof terrain.options !== 'object' ||
      !virtualTexture ||
      typeof virtualTexture.entries !== 'function'
    )
      throw new TypeError('TerrainBlend needs a Terrain and its TerrainVirtualTexture');
    this.defaults = settings(options, DEFAULTS);
  }
  /** Blends meshes into `terrain`, reading the ground's colour from `virtualTexture` (attach both first). */
  static attach(
    engine: EngineKernel,
    terrain: Terrain,
    virtualTexture: TerrainVirtualTexture,
    options: TerrainBlendOptions = {},
  ): TerrainBlend {
    const blend = new TerrainBlend(terrain, virtualTexture, options);
    engineRuntime(engine).use(blend);
    return blend;
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Terrain blending requires WebGPU and a live module; attach a new TerrainBlend to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    if (this.virtualTexture.owner !== engine || this.virtualTexture.disposed)
      throw new MargoError(
        'attached',
        'Terrain blending reads a terrain virtual texture attached to the same engine; attach TerrainVirtualTexture first',
      );
    this.engine = engine;
  }
  /**
   * Fades `mesh` into the ground (its own `options` over the attachment's). Adding it again changes its settings.
   * The mesh must belong to this engine and draw with core's standard material.
   */
  add(mesh: Mesh, options?: TerrainBlendOptions): this {
    if (this.disposed) throw new MargoError('disposed', 'This TerrainBlend is disposed; attach a new one');
    const runtime = meshRuntime(mesh);
    runtime.check();
    if (this.engine && runtime.engine !== this.engine)
      throw new MargoError('attached', "The mesh belongs to another engine; blend meshes of the terrain's engine");
    this.rows.set(mesh, { id: runtime.id, ...settings(options, this.defaults) });
    this.dirty = true;
    return this;
  }
  /** Stops blending `mesh`; false when it was not blended. */
  remove(mesh: Mesh): boolean {
    const removed = this.rows.delete(mesh);
    if (removed) this.dirty = true;
    return removed;
  }
  /** Whether `mesh` is blended. */
  has(mesh: Mesh): boolean {
    return this.rows.has(mesh);
  }
  /**
   * The WGSL added to core's shader. Per pixel of a blended mesh: the ground height under it, bilinear in the
   * heightmap as the terrain's vertex shader reads it; how far above it the pixel is, moved by value noise; the fade
   * `1 - smoothstep(0, height, above)`, times the virtual texture's coverage. The colour is the virtual texture's at the
   * ground point under the pixel, read at the pixel's own footprint (its world width from the position's screen
   * derivatives, taken once at the top of the block where control flow is uniform); the normal is the heightmap's
   * central differences, as the terrain's vertex normal.
   */
  private code(binding: number): string {
    // With a floating origin the mesh positions are local: the heightmap's corner and offset come from the virtual
    // texture's frame (`map`, the terrain's origin and height offset less the shift) instead of constants, and the
    // noise reads world XZ less the terrain's anchor (local plus the frame's `anchor`), so a rebase leaves it in place.
    const o = this.terrain.options,
      floating = !!o.floatingOrigin,
      x = floating ? 'terrainVirtual.map.x' : num(o.origin?.[0] ?? 0),
      z = floating ? 'terrainVirtual.map.y' : num(o.origin?.[1] ?? 0),
      w = num(o.size[0]),
      d = num(o.size[1]),
      scale = num(o.heightScale ?? 100),
      offset = floating ? 'terrainVirtual.map.z' : num(o.heightOffset ?? 0);
    return `
@group(0) @binding(${binding}) var terrainBlendHeights:texture_2d<f32>;
@group(0) @binding(${binding + 1}) var<storage,read> terrainBlendMeshes:array<vec4f>;
${this.virtualTexture.declarations(0, binding + 2)}
struct TerrainBlendGround {color:vec3f,normal:vec3f,weight:f32}
fn terrainBlendHeight(position:vec2f)->f32 {
 let dimensions=vec2i(textureDimensions(terrainBlendHeights));let uv=clamp((position-vec2f(${x},${z}))/vec2f(${w},${d}),vec2f(0),vec2f(1));let pixel=uv*vec2f(dimensions-vec2i(1));let lo=vec2i(floor(pixel));let hi=min(lo+vec2i(1),dimensions-vec2i(1));let t=fract(pixel);
 let a=mix(textureLoad(terrainBlendHeights,lo,0).r,textureLoad(terrainBlendHeights,vec2i(hi.x,lo.y),0).r,t.x);let b=mix(textureLoad(terrainBlendHeights,vec2i(lo.x,hi.y),0).r,textureLoad(terrainBlendHeights,hi,0).r,t.x);
 return mix(a,b,t.y)*${scale}+${offset};
}
fn terrainBlendSettings(id:f32)->vec4f {
 let k=u32(max(id-1.0,0.0));if(k>=arrayLength(&terrainBlendMeshes)){return vec4f(0);}return terrainBlendMeshes[k];
}
fn terrainBlendGround(p:vec3f,s:vec4f,footprint:f32)->TerrainBlendGround {
 var g:TerrainBlendGround;g.weight=0.0;
 if(any(p.xz<vec2f(${x},${z}))||any(p.xz>vec2f(${x},${z})+vec2f(${w},${d}))){return g;}
 let h=terrainBlendHeight(p.xz);
 let jitter=(terrainNoise(${floating ? '(p.xz+terrainVirtual.anchor.xy)' : 'p.xz'}*(2.0/s.x)).x-0.5)*s.y*s.x;
 let fade=1.0-smoothstep(0.0,s.x,p.y-h+jitter);
 if(fade<=0.0){return g;}
 let ground=terrainVirtualColor(vec3f(p.x,h,p.z),footprint);
 let step=vec2f(${w},${d})/max(vec2f(textureDimensions(terrainBlendHeights))-1.0,vec2f(1));
 g.normal=normalize(vec3f((terrainBlendHeight(p.xz-vec2f(step.x,0))-terrainBlendHeight(p.xz+vec2f(step.x,0)))/(2*step.x),1,(terrainBlendHeight(p.xz-vec2f(0,step.y))-terrainBlendHeight(p.xz+vec2f(0,step.y)))/(2*step.y)));
 g.color=ground.rgb;g.weight=fade*ground.a;return g;
}
`;
  }
  /** Core's standard shader with the blend: the declarations above it, the per-mesh fade at the top of the block. */
  private patch(source: string, binding: number): string {
    const opened = openMeshBlock(source);
    // Silent like the other optional core patches: other shaders draw their meshes as they were.
    if (!opened) return source;
    const { code, at } = opened,
      rough = num(this.terrain.options.roughness ?? 0.9);
    return (
      (code.includes('fn terrainNoise(') ? '' : noiseCode) +
      this.code(binding) +
      code.slice(0, at) +
      'let terrainBlendFootprint=max(length(dpdx(i.position)),length(dpdy(i.position)));' +
      `{let s=terrainBlendSettings(i.terrainId);if(s.x>0.0){let g=terrainBlendGround(i.position,s,terrainBlendFootprint);if(g.weight>0.0){i.color=mix(i.color,g.color,g.weight);i.material.x=mix(i.material.x,${rough},g.weight);i.material.y*=1.0-g.weight;n=normalize(mix(n,g.normal,g.weight*s.z));}}}` +
      code.slice(at)
    );
  }
  /** Writes the per-mesh rows (height, noise, normal, 0 by mesh id; height 0 is not blended), growing the buffer. */
  private upload(device: GPUDevice): void {
    let top = 0;
    for (const row of this.rows.values()) top = Math.max(top, row.id + 1);
    if (!this.buffer || top > this.capacity) {
      this.buffer?.destroy();
      this.capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(top, 1))));
      this.buffer = device.createBuffer({
        size: this.capacity * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.cache = undefined;
    }
    const values = new Float32Array(this.capacity * 4);
    for (const row of this.rows.values()) values.set([Math.fround(row.height), row.noise, row.normal, 0], row.id * 4);
    device.queue.writeBuffer(this.buffer, 0, values);
    this.dirty = false;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -1,
      execute: (c) => {
        if (c.backend !== 'webgpu' || !this.engine) return;
        const heights = this.terrain.heightmap,
          cache = this.virtualTexture.texture;
        // Before the terrain and its virtual texture have their textures (or after either is disposed) meshes draw as
        // they are.
        if (!heights || !cache || this.virtualTexture.disposed || this.rows.size === 0) return;
        for (const mesh of this.rows.keys())
          if (meshRuntime(mesh).engine !== this.engine) {
            this.rows.delete(mesh);
            this.dirty = true;
          }
        if (this.dirty) this.upload(c.device);
        if (this.source !== c.shader) {
          this.source = c.shader;
          const taken = new Set(c.bindings.map((entry) => entry.binding));
          for (const m of c.shader.matchAll(/@group\(0\) @binding\((\d+)\)/g)) taken.add(Number(m[1]));
          let binding = 40;
          while ([0, 1, 2, 3, 4].some((k) => taken.has(binding + k))) binding++;
          this.binding = binding;
          this.cache = undefined;
          this.shader = this.patch(c.shader, binding);
        }
        if (this.shader === this.source) return;
        // Stable views: the scene's bind group is rebuilt only when a texture or the buffer is replaced.
        if (this.heights !== heights || this.cache !== cache || this.entries[0]?.binding !== this.binding) {
          this.heights = heights;
          this.cache = cache;
          this.entries = [
            { binding: this.binding, resource: heights.createView() },
            { binding: this.binding + 1, resource: { buffer: this.buffer! } },
            ...this.virtualTexture.entries(this.binding + 2),
          ];
        }
        c.bindings.push(...this.entries);
        c.shader = this.shader;
      },
    });
  }
  onDeviceRestored(engine: Engine): void {
    this.buffer?.destroy();
    this.buffer = this.heights = this.cache = undefined;
    this.capacity = 0;
    this.entries = [];
    this.dirty = true;
    this.engine = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.buffer?.destroy();
    this.buffer = this.heights = this.cache = undefined;
    this.entries = [];
    this.rows.clear();
    const engine = this.engine;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
