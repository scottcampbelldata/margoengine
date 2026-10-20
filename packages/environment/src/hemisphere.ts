// Hemisphere and ambient light (three.js HemisphereLight and AmbientLight), a ShaderEffect like Fog: sky colour above,
// ground colour below, mixed by the surface normal's height, times an intensity. It takes the place of the built-in
// ambient: core's flat `lighting.ambient` x `lighting.radiance[3]` on core meshes and terrain, and gltf-pro's fixed
// sky gradient (its hemisphere ambient, clearcoat and sheen defaults and a light probe's fallback, through gltf-pro's
// `sky` lighting hook) on models, materials meshes and VAT crowds. Where image-based light (EnvironmentLighting, an
// environment behind LightProbes, sky ambient) replaces the built-in ambient, the hemisphere adds to it, as three.js adds
// a HemisphereLight to scene.environment; LightProbes without an environment use it outside their volumes.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { ShaderEffect, type PBRHooks } from './lighting.js';
import { linearColor, type ColorInput } from './color.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/** Binding of the hemisphere uniform in core's group 0 and gltf-pro's group 2. */
export const HEMISPHERE_BINDING = 144;
/** The core-shader term the hemisphere writes (`n`: the shaded normal); LightProbes and SSAO recognise it. */
export const HEMISPHERE_TERM = 'margoSkyLight(n)';

/** Options of {@link HemisphereLight}. */
export interface HemisphereLightOptions {
  /** Light from above (normal +y): hex is sRGB, `[r, g, b]` linear. Default '#ffffff'. */
  sky?: ColorInput;
  /** Light from below (normal -y). Default the sky colour (a uniform ambient light). */
  ground?: ColorInput;
  /** Multiplies both colours (default 1): a surface of albedo `a` facing up reflects `a x sky x intensity`. */
  intensity?: number;
  /** Plugin and pass name. Default 'environment:hemisphere'. */
  name?: string;
}
const wgsl = (group: number) => `struct MargoSkyLight {sky:vec4f, ground:vec4f}
@group(${group}) @binding(${HEMISPHERE_BINDING}) var<uniform> margoSkyLightData:MargoSkyLight;
fn margoSkyLight(n:vec3f)->vec3f {return mix(margoSkyLightData.ground.rgb,margoSkyLightData.sky.rgb,clamp(n.y*0.5+0.5,0.0,1.0));}
`;
// Core's ambient term (core meshes; terrain's has no colour; sky's absolute colour in its place) and the same once an
// IBL-style effect zeroed it.
const builtIn = /\*frame\.radiance\.w(?:\*frame\.ambient\.rgb)?|\*skyAmbient\.rgb/g,
  zeroed = /(i\.color\*\(1\.0-i\.material\.y\)|base)\*0\.0(?:\*frame\.ambient\.rgb)?/;

/**
 * Hemisphere light (three.js `HemisphereLight`): ambient light of `sky` colour from above and `ground` colour from below,
 * blended by `0.5 + 0.5 n.y` and scaled by `intensity`. `engine.use(light)` lights core meshes and terrain and owns the
 * GPU uniform; `light.add(model)` adds gltf-pro models, materials meshes and VAT crowds. It replaces the built-in
 * ambient (core's `lighting.ambient` x `radiance[3]`, gltf-pro's fixed sky gradient); with EnvironmentLighting, an
 * environment behind LightProbes or sky ambient it adds to their light; LightProbes without an environment use it
 * outside their volumes. Colours and intensity are live (a uniform write, no recompile). One per engine.
 */
export class HemisphereLight extends ShaderEffect {
  private buffer?: GPUBuffer;
  private gpu?: GPUDevice;
  private entry?: GPUBindGroupEntry[];
  private skyValue: ColorInput = '#ffffff';
  private groundValue?: ColorInput;
  private strength = 1;
  private dirty = true;
  /** linear sky rgb x intensity, then ground. */
  private readonly values = new Float32Array(8);
  /** Same as `engine.use(new HemisphereLight(...))`; returns the light. */
  static attach(engine: EngineKernel, options?: HemisphereLightOptions): HemisphereLight {
    const value = new HemisphereLight(options);
    engine.use(value);
    return value;
  }
  constructor(options: HemisphereLightOptions = {}) {
    super(options.name ?? 'environment:hemisphere');
    this.skyValue = options.sky ?? '#ffffff';
    this.groundValue = options.ground;
    this.intensity = options.intensity ?? 1;
  }
  /** Light from above. */
  get sky(): ColorInput {
    return this.skyValue;
  }
  set sky(value: ColorInput) {
    linearColor(value);
    this.skyValue = value;
    this.update();
  }
  /** Light from below; undefined: the sky colour. */
  get ground(): ColorInput | undefined {
    return this.groundValue;
  }
  set ground(value: ColorInput | undefined) {
    if (value !== undefined) linearColor(value);
    this.groundValue = value;
    this.update();
  }
  /** Multiplies both colours. */
  get intensity(): number {
    return this.strength;
  }
  set intensity(value: number) {
    if (typeof value !== 'number' || !Number.isFinite(Math.fround(value)) || value < 0)
      throw new RangeError('Hemisphere light intensity must be a finite number of 0 or more');
    this.strength = value;
    this.update();
  }
  private update(): void {
    const sky = linearColor(this.skyValue),
      ground = linearColor(this.groundValue ?? this.skyValue);
    for (let k = 0; k < 3; k++) {
      this.values[k] = sky[k] * this.strength;
      this.values[4 + k] = ground[k] * this.strength;
    }
    this.dirty = true;
  }
  protected get device(): GPUDevice | undefined {
    return this.gpu;
  }
  protected entries(): GPUBindGroupEntry[] {
    if (this.dirty) {
      this.gpu!.queue.writeBuffer(this.buffer!, 0, this.values);
      this.dirty = false;
    }
    return this.entry!;
  }
  protected patch(source: string, group: number): string {
    if (source.includes('fn margoSkyLight('))
      throw new MargoError(
        'attached',
        `${this.name}: a hemisphere light already lights this shader; use one per engine`,
      );
    // The built-in ambient wherever it is (the frame's ambient term, or a light probe's fallback copy of it); else, when an
    // IBL-style effect zeroed it, the hemisphere joins its light.
    let code = source.replace(builtIn, `*${HEMISPHERE_TERM}`);
    if (code === source) code = source.replace(zeroed, `$1*${HEMISPHERE_TERM}`);
    return code === source ? source : wgsl(group) + code;
  }
  protected hooks(group: number): PBRHooks {
    return { declarations: wgsl(group), sky: 'margoSkyLight(n)' };
  }
  override setup(engine: EngineKernel): void {
    super.setup(engine);
    const device = engineRuntime(engine).gpu;
    if (!device) throw new MargoError('unsupported', 'HemisphereLight requires the WebGPU backend');
    this.release();
    this.allocate(device);
  }
  onDeviceRestored(engine: EngineKernel): void {
    const device = engineRuntime(engine).gpu;
    this.release();
    if (device && !this.disposed) this.allocate(device);
  }
  private allocate(device: GPUDevice): void {
    this.buffer = device.createBuffer({
      label: 'hemisphere light',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.entry = [{ binding: HEMISPHERE_BINDING, resource: { buffer: this.buffer } }];
    this.gpu = device;
    this.dirty = true;
  }
  private release(): void {
    this.buffer?.destroy();
    this.buffer = this.gpu = this.entry = undefined;
  }
  override dispose(): void {
    super.dispose();
    this.release();
  }
}

/** Options of {@link AmbientLight}. */
export interface AmbientLightOptions {
  /** The light's colour: hex is sRGB, `[r, g, b]` linear. Default '#ffffff'. */
  color?: ColorInput;
  /** Multiplies the colour (default 1). */
  intensity?: number;
  /** Plugin and pass name. Default 'environment:ambient'. */
  name?: string;
}
/**
 * Ambient light (three.js `AmbientLight`): the same light from every direction, a {@link HemisphereLight} whose sky and
 * ground are one colour. A surface of albedo `a` reflects `a x color x intensity`.
 */
export class AmbientLight extends HemisphereLight {
  /** Same as `engine.use(new AmbientLight(...))`; returns the light. */
  static override attach(engine: EngineKernel, options?: AmbientLightOptions): AmbientLight {
    const value = new AmbientLight(options);
    engine.use(value);
    return value;
  }
  constructor(options: AmbientLightOptions = {}) {
    super({ sky: options.color, intensity: options.intensity, name: options.name ?? 'environment:ambient' });
  }
  /** The light's colour (both the sky and the ground). */
  get color(): ColorInput {
    return this.sky;
  }
  set color(value: ColorInput) {
    this.sky = value;
    this.ground = undefined;
  }
}
