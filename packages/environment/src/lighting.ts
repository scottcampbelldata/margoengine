// Scene-wide shading by WGSL string patching from outside core: image-based lighting from an Environment
// (scene.environment) and distance/height fog (scene.fog). Each effect is an engine plugin that patches core's
// mesh shader through PassContext.shader and a glTF-pro LightingEffect (`applyTo(model)`), so opaque and
// blended glTF primitives are lit and fogged in their own shader.
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime, type FrameGraph} from '@margoengine/core/extension';
import type {Environment} from './environment.js';
import {IBL_WGSL, iblBindGroupEntries} from './ibl.js';
import {srgbColor, srgbToLinear, type ColorInput} from './color.js';

declare const GPUBufferUsage: {UNIFORM: number; COPY_DST: number};

/** What the effects patch: core's mesh shader (group 0) or anything with glTF-pro's `addLighting` hook (group 2). */
export interface LightingTarget {addLighting(effect: {shader(source: string, group: number): string; bindings(): GPUBindGroupEntry[]}): () => void}

/** First binding of the IBL resources (five) and the fog uniform, in core's group 0 and glTF-pro's group 2. */
export const IBL_BINDING = 20, FOG_BINDING = 25;

abstract class ShaderEffect {
  readonly name: string;
  disposed = false;
  protected engine?: EngineKernel;
  private readonly models = new Map<LightingTarget, () => void>();
  private readonly shaders = new Map<number, Map<string, string>>();
  constructor(name: string) {this.name = name;}
  /** Device the bindings live on, or null while they cannot be used. */
  protected abstract get device(): GPUDevice | null | undefined;
  protected abstract entries(): GPUBindGroupEntry[];
  /** Declarations plus the patched source, or `source` itself when no known anchor matches. */
  protected abstract patch(source: string, group: number): string;

  /** Bind group entries for the patched shader; empty (and the shader unpatched) while not ready or disposed. */
  bindings(): GPUBindGroupEntry[] {return this.disposed || !this.device ? [] : this.entries();}
  /** `source` patched for bind group `group`; unchanged while `bindings()` is empty. Throws on an unknown shader. */
  shader(source: string, group: number): string {
    if (!this.bindings().length) return source;
    let cache = this.shaders.get(group), code = cache?.get(source);
    if (code === undefined) {
      code = this.patch(source, group);
      if (code === source) throw new Error(`${this.name} requires the standard core or glTF-pro PBR shader`);
      if (!cache) this.shaders.set(group, cache = new Map());
      if (cache.size >= 64) cache.clear();
      cache.set(source, code);
    }
    return code;
  }
  /** Adds the effect to a glTF-pro model. Returns a remover; `dispose()` removes it from every model. */
  applyTo(model: LightingTarget): () => void {
    if (this.disposed) throw new Error(`${this.name} is disposed`);
    let release = this.models.get(model);
    if (!release) {
      const remove = model.addLighting(this);
      release = () => {if (this.models.get(model) === release) {this.models.delete(model); remove();}};
      this.models.set(model, release);
    }
    return release;
  }
  setup(engine: EngineKernel): void {
    if (this.disposed) throw new Error(`${this.name} is disposed`);
    if (engine.backend === 'webgl2') throw new Error(`${this.name} requires the WebGPU backend`);
    this.engine = engine;
  }
  /** Patches core's mesh shader just before the main pass, after shadows, sky, clustered and capture passes. */
  registerPasses(graph: FrameGraph): void {
    graph.add({name: this.name, order: -1, execute: c => {
      if (c.backend !== 'webgpu' || this.disposed || this.device !== c.device) return;
      c.shader = this.shader(c.shader, 0); c.bindings.push(...this.entries());
    }});
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of [...this.models.values()]) release();
    this.shaders.clear(); this.engine?.removePlugin(this.name); this.engine = undefined;
  }
}

const iblCall = (n: string, v: string, base: string, metal: string, roughness: string) =>
  `iblShade(iblSpecular,iblSampler,iblBrdf,iblSh,iblParams,${n},${v},${base},${metal},${roughness})`;

export interface EnvironmentLightingOptions {
  /** Plugin and pass name. Default 'environment:lighting'. */
  name?: string;
}

/**
 * Lights core meshes (`engine.use(lighting)`) and glTF-pro models (`lighting.applyTo(model)`) with an Environment:
 * split-sum specular from the prefiltered cube plus SH irradiance, scaled by `environment.intensity` (Three.js
 * `scene.environment`). It replaces the constant ambient term (core's `lighting.radiance[3]`, glTF-pro's hemisphere
 * ambient); direct lights, shadows and clustered lights still add on top. glTF occlusion maps scale the IBL term.
 */
export class EnvironmentLighting extends ShaderEffect {
  private cached?: GPUBindGroupEntry[];
  private version = -1;
  constructor(readonly environment: Environment, options: EnvironmentLightingOptions = {}) {super(options.name ?? 'environment:lighting');}
  protected get device(): GPUDevice | null {return this.environment.disposed ? null : this.environment.device;}
  protected entries(): GPUBindGroupEntry[] {
    if (!this.cached || this.version !== this.environment.version) {this.cached = iblBindGroupEntries(this.environment, IBL_BINDING); this.version = this.environment.version;}
    return this.cached;
  }
  protected patch(source: string, group: number): string {
    let code = source;
    const ambient = source.replace(/fn ambient\(s:Surface\)->vec3f \{[^}]*\}/, 'fn ambient(s:Surface)->vec3f {return vec3f(0);}');
    const lit = ambient.replace('+s.emissive;', `+s.emissive+${iblCall('s.n', 'v', 's.base.rgb', 's.metal', 's.roughness')}*s.occlusion;`);
    if (ambient !== source && lit !== ambient) code = lit;
    else code = source.replace(/let linear=([^;]+);/, (_, terms: string) => `let linear=${terms.replace('frame.radiance.w', '0.0')}+${iblCall('n', 'v', 'i.color', 'i.material.y', 'i.material.x')};`);
    if (code === source) return source;
    const b = (offset: number) => `@group(${group}) @binding(${IBL_BINDING + offset})`;
    return `${b(0)} var iblSpecular:texture_cube<f32>;\n${b(1)} var iblSampler:sampler;\n${b(2)} var iblBrdf:texture_2d<f32>;\n${b(3)} var<uniform> iblSh:array<vec4f,9>;\n${b(4)} var<uniform> iblParams:vec4f;\n${IBL_WGSL}\n${code}`;
  }
  setup(engine: EngineKernel): void {super.setup(engine); this.restore(engine);}
  onDeviceRestored(engine: EngineKernel): void {this.restore(engine);}
  private restore(engine: EngineKernel): void {
    const device = engineRuntime(engine).gpu, environment = this.environment;
    if (device && environment.device !== device && !environment.disposed) environment.restore(device).catch(error => engine.onError(error));
  }
}

export interface FogOptions {
  /** Fog color; fully fogged pixels show exactly this color on the canvas. Default '#ffffff'. */
  color?: ColorInput;
  /** Linear fog start and end distance from the camera (Three.js Fog). Defaults 1 and 1000. */
  near?: number;
  far?: number;
  /** Above 0 selects exponential-squared fog `1 - exp(-(density * distance)^2)` (Three.js FogExp2). Default 0. */
  density?: number;
  /** Height fog: fog thins by `exp(-heightFalloff * (y - height))` above world height `height`. Default 0 (off). */
  heightFalloff?: number;
  /** World height below which fog is at full strength. Default 0. */
  height?: number;
  /** Plugin and pass name. Default 'fog'. */
  name?: string;
}

const finite = (value: number, label: string, min = -Infinity): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new RangeError(`Invalid fog ${label}`);
  return value;
};
const fogWgsl = (group: number) => `struct MargoFog {color:vec4f, params:vec4f}
@group(${group}) @binding(${FOG_BINDING}) var<uniform> margoFog:MargoFog;
fn fogAmount(p:vec3f,eye:vec3f)->f32 {
  let d=distance(p,eye);let q=margoFog.params;
  let amount=select(clamp((d-q.x)/max(q.y-q.x,1e-6),0.0,1.0),1.0-exp(-q.z*q.z*d*d),q.z>0.0);
  return amount*exp(-q.w*max(p.y-margoFog.color.w,0.0));
}
`;

/**
 * Scene-wide distance and height fog computed in the mesh shaders, so it also covers blended (transparent) glTF-pro
 * primitives, unlike sky's depth-based post fog. `engine.use(fog)` fogs core meshes and is required (it owns the
 * GPU uniform); `fog.applyTo(model)` adds glTF-pro models. The mix happens after tone mapping on the canvas and in
 * linear radiance on HDR targets, so a ColorBackground with the same color matches at full fog. The background
 * itself, particles and other packages' custom shaders are not fogged.
 */
export class Fog extends ShaderEffect {
  private buffer?: GPUBuffer;
  private gpu?: GPUDevice;
  private entry?: GPUBindGroupEntry[];
  private colorValue: ColorInput = '#ffffff';
  private dirty = true;
  /** linear color.rgb, height, near, far, density, heightFalloff */
  private readonly values = new Float32Array(8);
  constructor(options: FogOptions = {}) {
    super(options.name ?? 'fog');
    this.color = options.color ?? '#ffffff';
    this.near = options.near ?? 1; this.far = options.far ?? 1000; this.density = options.density ?? 0;
    this.heightFalloff = options.heightFalloff ?? 0; this.height = options.height ?? 0;
  }
  get color(): ColorInput {return this.colorValue;}
  set color(value: ColorInput) {const c = srgbColor(value); for (let i = 0; i < 3; i++) this.values[i] = srgbToLinear(c[i]); this.colorValue = value; this.dirty = true;}
  get height(): number {return this.values[3];}
  set height(value: number) {this.values[3] = finite(value, 'height'); this.dirty = true;}
  get near(): number {return this.values[4];}
  set near(value: number) {this.values[4] = finite(value, 'near', 0); this.dirty = true;}
  get far(): number {return this.values[5];}
  set far(value: number) {this.values[5] = finite(value, 'far', 0); this.dirty = true;}
  get density(): number {return this.values[6];}
  set density(value: number) {this.values[6] = finite(value, 'density', 0); this.dirty = true;}
  get heightFalloff(): number {return this.values[7];}
  set heightFalloff(value: number) {this.values[7] = finite(value, 'heightFalloff', 0); this.dirty = true;}

  protected get device(): GPUDevice | undefined {return this.gpu;}
  protected entries(): GPUBindGroupEntry[] {
    if (this.dirty) {this.gpu!.queue.writeBuffer(this.buffer!, 0, this.values); this.dirty = false;}
    return this.entry!;
  }
  protected patch(source: string, group: number): string {
    const mix = (value: string, eye: string) => `mix(${value},margoFog.color.rgb,fogAmount(i.position,${eye}))`;
    let code = source.replace('if(f.settings.w<0.5) {color=aces(max(color,vec3f(0))/0.6);', `color=${mix('select(color,aces(max(color,vec3f(0))/0.6),f.settings.w<0.5)', 'f.eye.xyz')};if(f.settings.w<0.5) {`);
    if (code === source) code = source.replace('let mapped=linear/(1.0+linear);', `let mapped=${mix('linear/(1.0+linear)', 'frame.eye.xyz')};`);
    if (code === source) code = source.replace('return vec4f(linear,1);', `return vec4f(${mix('linear', 'frame.eye.xyz')},1);`);
    return code === source ? source : fogWgsl(group) + code;
  }
  setup(engine: EngineKernel): void {
    super.setup(engine);
    const device = engineRuntime(engine).gpu;
    if (!device) throw new Error('Fog requires the WebGPU backend');
    this.release(); this.allocate(device);
  }
  onDeviceRestored(engine: EngineKernel): void {const device = engineRuntime(engine).gpu; this.release(); if (device && !this.disposed) this.allocate(device);}
  private allocate(device: GPUDevice): void {
    this.buffer = device.createBuffer({label: 'fog', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    this.entry = [{binding: FOG_BINDING, resource: {buffer: this.buffer}}]; this.gpu = device; this.dirty = true;
  }
  private release(): void {this.buffer?.destroy(); this.buffer = this.gpu = this.entry = undefined;}
  dispose(): void {super.dispose(); this.release();}
}
