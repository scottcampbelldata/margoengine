/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Terrain, TerrainLighting } from './index.js';

/** World-space controls for directional shadows and the projected sky-view factor of a heightfield. */
export interface TerrainReliefLightingOptions {
  /** Direction toward the light (Y up). Default [-0.6, 0.45, -0.65], or the engine light for the terrain plugin. */
  direction?: readonly [number, number, number];
  /** Horizontal search radius in world units. Default a quarter of the shorter side. */
  radius?: number;
  /** Sky-view azimuth samples, 4 to 32. Default 12. */
  rays?: number;
  /** Maximum samples on a ray, 8 to 256. Default 48. */
  steps?: number;
  /** Angular half-width of the sun's soft horizon, in degrees, above zero and up to 10. Default 0.75. */
  softness?: number;
  /** World units per input texel value, finite. Default 1 or the Terrain's height scale. */
  heightScale?: number;
  /**
   * The terrain plugin rebakes by itself in the first frame after the engine light has turned more than half a degree
   * from the baked sun (without a `direction` option) or after `refresh()`. Default false: call `rebake()`.
   */
  follow?: boolean;
}

const TEXTURE_BINDING = 0x04;
const STORAGE_BINDING = 0x08;
const COPY_SRC = 0x01;
const UNIFORM = 0x40;
// Terrain lighting's binding 112 and its following slots are used by ground change.
const MAP = 120;
const SAMPLER = 121;
const formats = new Set<GPUTextureFormat>(['r32float', 'rgba16float', 'rgba8unorm']);

function dimensions(heightmap: GPUTexture, size: readonly [number, number], options: TerrainReliefLightingOptions) {
  if (
    !heightmap ||
    heightmap.dimension !== '2d' ||
    heightmap.depthOrArrayLayers !== 1 ||
    heightmap.sampleCount !== 1 ||
    heightmap.width < 2 ||
    heightmap.height < 2 ||
    !(heightmap.usage & TEXTURE_BINDING) ||
    !formats.has(heightmap.format)
  )
    throw new TypeError(
      'Terrain relief needs a sampled r32float, rgba16float or rgba8unorm 2D heightmap at least 2×2.',
    );
  const finitePositive = (v: number) => Number.isFinite(Math.fround(v)) && Math.fround(v) > 0;
  if (size.length !== 2 || !size.every(finitePositive))
    throw new RangeError('Terrain relief size needs two positive finite world lengths.');
  const direction = options.direction ?? [-0.6, 0.45, -0.65];
  const line = Math.hypot(...direction);
  const radius = options.radius ?? Math.min(...size) / 4;
  const rays = options.rays ?? 12;
  const steps = options.steps ?? 48;
  const softness = options.softness ?? 0.75;
  const scale = options.heightScale ?? 1;
  if (
    direction.length !== 3 ||
    !finitePositive(line) ||
    !finitePositive(radius) ||
    !Number.isInteger(rays) ||
    rays < 4 ||
    rays > 32 ||
    !Number.isInteger(steps) ||
    steps < 8 ||
    steps > 256 ||
    !finitePositive(softness) ||
    softness > 10 ||
    !Number.isFinite(Math.fround(scale))
  )
    throw new RangeError(
      'Terrain relief needs a nonzero direction, positive radius, 4–32 rays, 8–256 steps, softness in (0, 10] degrees and a finite heightScale.',
    );
  return new Float32Array([
    ...size,
    radius,
    scale,
    direction[0] / line,
    direction[1] / line,
    direction[2] / line,
    (softness * Math.PI) / 180,
    rays,
    steps,
    0,
    0,
  ]);
}

// A heightfield horizon, following Max (1988) and Stewart (1998). A bounded, denser-near quadrature replaces
// exhaustive skyline search. The projected uniform-sky irradiance above a horizon of slope h is 1/(1+h*h).
// See Zakšek, Oštir and Kokalj (2011) for a terrain sky-view visualization built from azimuth samples.
const bakeSource = /* wgsl */ `
struct ReliefBake { map:vec4f, light:vec4f, limits:vec4f }
@group(0) @binding(0) var reliefHeight:texture_2d<f32>;
@group(0) @binding(1) var reliefOut:texture_storage_2d<rgba16float,write>;
@group(0) @binding(2) var<uniform> bake:ReliefBake;
fn heightAt(p:vec2f, edge:vec2i)->f32 {
  let lo=vec2i(floor(p));let hi=min(lo+1,edge);let w=fract(p);
  let a=textureLoad(reliefHeight,lo,0).r;
  let b=textureLoad(reliefHeight,vec2i(hi.x,lo.y),0).r;
  let c=textureLoad(reliefHeight,vec2i(lo.x,hi.y),0).r;
  let d=textureLoad(reliefHeight,hi,0).r;
  return mix(mix(a,b,w.x),mix(c,d,w.x),w.y);
}
fn horizon(p:vec2f, direction:vec2f, edge:vec2i, spacing:vec2f, originHeight:f32)->f32 {
  let motion=direction/spacing;
  let stride=1.0/max(abs(motion.x),abs(motion.y));
  let count=u32(bake.limits.y);
  let fine=min(1.0,bake.map.z/(f32(count)*stride))*stride;
  let tail=max(0.0,bake.map.z-f32(count)*fine);
  var slope=0.0;
  for(var k=1u;k<=count;k++){
    let f=f32(k)/f32(count);
    let distance=f32(k)*fine+tail*f*f;
    let sample=p+distance*motion;
    if(any(sample<vec2f(0.0))||any(sample>vec2f(edge))){break;}
    let rise=(heightAt(sample,edge)-originHeight)*bake.map.w;
    slope=max(slope,rise/distance);
  }
  return slope;
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let size=textureDimensions(reliefHeight);
  if(any(id.xy>=size)){return;}
  let ij=vec2i(id.xy);
  let p=vec2f(ij);let edge=vec2i(size)-1;
  let spacing=bake.map.xy/vec2f(edge);
  let start=textureLoad(reliefHeight,ij,0).r;
  let rays=u32(bake.limits.x);
  var sky=0.0;
  for(var i=0u;i<rays;i++){
    let azimuth=6.28318530718*f32(i)/f32(rays);
    let h=horizon(p,vec2f(cos(azimuth),sin(azimuth)),edge,spacing,start);
    sky+=1.0/(1.0+h*h);
  }
  let sun=bake.light.xyz;
  let run=length(sun.xz);let elevation=atan2(sun.y,run);
  var lip=0.0;
  if(run>0.000001&&elevation> -bake.light.w){
    lip=atan(horizon(p,sun.xz/run,edge,spacing,start));
  }
  let direct=smoothstep(lip-bake.light.w,lip+bake.light.w,elevation);
  textureStore(reliefOut,ij,vec4f(direct,sky/f32(rays),0.0,1.0));
}`;

const pipelines = new WeakMap<GPUDevice, GPUBindGroupLayout>();
const compute = new WeakMap<GPUDevice, GPUComputePipeline>();

/**
 * Enqueues a WebGPU terrain lighting bake from an existing sampled height texture.
 * R is direct-light visibility, G is projected diffuse sky visibility. Both are 0–1, with texels at the original
 * height sample positions. The caller owns the returned rgba16float texture and must destroy it when finished.
 */
export function bakeTerrainReliefLighting(
  device: GPUDevice,
  heightmap: GPUTexture,
  size: readonly [number, number],
  options: TerrainReliefLightingOptions = {},
): GPUTexture {
  const settings = dimensions(heightmap, size, options);
  let pipeline = compute.get(device);
  let layout = pipelines.get(device);
  if (!pipeline || !layout) {
    layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: 4, storageTexture: { format: 'rgba16float', access: 'write-only' } },
        { binding: 2, visibility: 4, buffer: { type: 'uniform' } },
      ],
    });
    pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ code: bakeSource }), entryPoint: 'main' },
    });
    pipelines.set(device, layout);
    compute.set(device, pipeline);
  }
  const texture = device.createTexture({
    label: 'Terrain relief light',
    size: [heightmap.width, heightmap.height],
    format: 'rgba16float',
    usage: TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC,
  });
  const buffer = device.createBuffer({ size: settings.byteLength, usage: UNIFORM, mappedAtCreation: true });
  try {
    new Float32Array(buffer.getMappedRange()).set(settings);
    buffer.unmap();
    const bind = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: heightmap.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1 }) },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: { buffer } },
      ],
    });
    const commands = device.createCommandEncoder();
    const pass = commands.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(heightmap.width / 8), Math.ceil(heightmap.height / 8));
    pass.end();
    device.queue.submit([commands.finish()]);
  } catch (error) {
    texture.destroy();
    buffer.destroy();
    throw error;
  }
  const release = () => buffer.destroy();
  void device.queue.onSubmittedWorkDone().then(release, release);
  return texture;
}

const reliefCoordinates = /* wgsl */ `
fn terrainReliefUv(uv:vec2f,size:vec2f)->vec2f{
  return (clamp(uv,vec2f(0),vec2f(1))*(size-1.0)+0.5)/size;
}`;
/** WGSL for sampling the bake at a corner-aligned heightfield uv, with one bilinear fetch. */
export const terrainReliefLightingWGSL = /* wgsl */ `
${reliefCoordinates}
fn terrainReliefLight(map:texture_2d<f32>, mapSampler:sampler, uv:vec2f)->vec2f{
  let uvMap=terrainReliefUv(uv,vec2f(textureDimensions(map)));
  return textureSampleLevel(map,mapSampler,uvMap,0.0).rg;
}`;

let nextId = 0;
/** Adds geometric sun and sky shading to a clipmap Terrain, including terrain outside the camera view. */
export class TerrainReliefLighting implements EnginePlugin, TerrainLighting, Disposable {
  readonly name = 'terrain-relief-lighting:' + nextId++;
  owner?: Engine;
  disposed = false;
  #texture?: GPUTexture;
  #sampler?: GPUSampler;
  #options: TerrainReliefLightingOptions;
  #remove?: () => void;
  #entries: GPUBindGroupEntry[] = [];
  readonly #shaders = new Map<string, string>();
  /** The unit sun of the last bake, and whether the heights changed since. */
  #sun: readonly number[] = [0, 1, 0];
  #stale = false;

  constructor(
    private readonly terrain: Terrain,
    options: TerrainReliefLightingOptions = {},
  ) {
    if (!terrain || typeof terrain.addLighting !== 'function')
      throw new TypeError('Terrain relief lighting needs a live clipmap Terrain.');
    this.#options = this.#snapshot(options);
  }

  /** Attach after Terrain and before disposal of its heightmap. Works with layer and local relief materials. */
  static attach(
    engine: EngineKernel,
    terrain: Terrain,
    options: TerrainReliefLightingOptions = {},
  ): TerrainReliefLighting {
    const effect = new TerrainReliefLighting(terrain, options);
    engineRuntime(engine).use(effect);
    return effect;
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Terrain relief lighting needs a live WebGPU engine.',
      );
    const sampler = engine.gpu.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const texture = this.#bake(engine, this.#options);
    try {
      this.owner = engine;
      this.#remove ??= this.terrain.addLighting(this);
    } catch (error) {
      this.owner = undefined;
      texture.destroy();
      throw error;
    }
    this.#sampler = sampler;
    this.#apply(texture);
  }

  #snapshot(options: TerrainReliefLightingOptions): TerrainReliefLightingOptions {
    return { ...options, direction: options.direction ? [...options.direction] : undefined };
  }

  #bake(engine: Engine, options: TerrainReliefLightingOptions): GPUTexture {
    if (!this.terrain.heightmap)
      throw new MargoError('state', 'Attach the clipmap Terrain before its relief lighting.');
    const { direction } = engine.lighting;
    const sun = options.direction ?? ([direction[0], direction[1], direction[2]] as const),
      baked = bakeTerrainReliefLighting(engine.gpu!, this.terrain.heightmap, this.terrain.options.size, {
        ...options,
        direction: sun,
        heightScale: options.heightScale ?? this.terrain.options.heightScale ?? 100,
      }),
      length = Math.hypot(...sun);
    this.#sun = sun.map((v) => v / length); // float division: view only
    this.#stale = false;
    return baked;
  }

  /** With `follow`, marks the heights as changed: the next frame rebakes once, however many edits there were. */
  refresh(): void {
    this.#stale = true;
  }

  /** Whether the light has turned more than half a degree from the baked sun. */
  #turned(): boolean {
    const d = this.owner!.lighting.direction,
      length = Math.hypot(d[0], d[1], d[2]);
    if (this.#options.direction || !(length > 0)) return false;
    return (d[0] * this.#sun[0] + d[1] * this.#sun[1] + d[2] * this.#sun[2]) / length < Math.cos(Math.PI / 360);
  }

  #apply(texture: GPUTexture): void {
    const previous = this.#texture;
    this.#texture = texture;
    this.#entries = [
      { binding: MAP, resource: texture.createView() },
      { binding: SAMPLER, resource: this.#sampler! },
    ];
    if (previous) {
      const release = () => previous.destroy();
      void this.owner!.gpu!.queue.onSubmittedWorkDone().then(release, release);
    }
  }

  /** Rebuild after height edits or a sun change. Options are merged with the last successful settings. */
  rebake(options: TerrainReliefLightingOptions = {}): void {
    if (this.disposed || !this.owner)
      throw new MargoError(
        this.disposed ? 'disposed' : 'state',
        'Attach live Terrain relief lighting before rebaking.',
      );
    const next = this.#snapshot({ ...this.#options, ...options });
    this.#apply(this.#bake(this.owner, next));
    this.#options = next;
  }

  shader(source: string, group: number): string {
    const key = group + source;
    const previous = this.#shaders.get(key);
    if (previous) return previous;
    const direct = /let direct=[^;]+;/g;
    const sky = '+base*frame.radiance.w*frame.ambient.rgb';
    if ([...source.matchAll(direct)].length !== 1 || source.split(sky).length !== 2)
      throw new MargoError(
        'unsupported',
        'Terrain relief lighting needs the terrain lit shader and its sun and sky terms.',
      );
    const code =
      /* wgsl */ `
@group(${group}) @binding(${MAP}) var terrainReliefMap:texture_2d<f32>;
@group(${group}) @binding(${SAMPLER}) var terrainReliefSampler:sampler;
${reliefCoordinates}
fn terrainReliefApplied(uv:vec2f)->vec2f{
  let uvMap=terrainReliefUv(uv,vec2f(textureDimensions(terrainReliefMap)));
  return textureSampleLevel(terrainReliefMap,terrainReliefSampler,uvMap,0.0).rg;
}
` +
      source
        .replace(
          direct,
          (term) =>
            'let terrainLight=terrainReliefApplied((i.position.xz-frame.map.xy)/frame.map.zw);' +
            term.slice(0, -1) +
            '*terrainLight.x;',
        )
        .replace(sky, sky + '*terrainLight.y');
    if (this.#shaders.size >= 16) this.#shaders.clear();
    this.#shaders.set(key, code);
    return code;
  }

  bindings(): GPUBindGroupEntry[] {
    if (this.#options.follow && this.owner && this.#texture && (this.#stale || this.#turned()))
      this.#apply(this.#bake(this.owner, this.#options));
    return this.#entries;
  }

  onDeviceRestored(engine: Engine): void {
    this.#texture?.destroy();
    this.#texture = undefined;
    this.setup(engine);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#remove?.();
    this.#remove = undefined;
    this.owner?.sceneOf(this)?.removePlugin(this.name);
    this.#texture?.destroy();
    this.#texture = undefined;
    this.#sampler = undefined;
    this.#entries = [];
    this.#shaders.clear();
    this.owner = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
