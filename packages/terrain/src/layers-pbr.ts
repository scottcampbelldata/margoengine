/// <reference lib="esnext.disposable" preserve="true" />
// Full PBR layer materials for `Terrain` (entry `@margoengine/terrain/layers-pbr`): each layer's own normal map,
// ambient occlusion, roughness and height, sampled triplanar like its colour, patched into the terrain's lit shader as
// a lighting effect (bind group 1). Normals: each projection's tangent-space normal becomes the gradient of a height
// over that projection's plane, the three are blended by the triplanar weights as a volume gradient and turned into a
// surface gradient that tilts the normal (Mikkelsen, "Surface Gradient-Based Bump Mapping Framework", JCGT 9(3), 2020,
// sections 2 and 5, after Mikkelsen 2010). Layers blend by height where their weights overlap, the higher surface
// winning (Mishkinis, "Advanced Terrain Texture Splatting", 2013), in one pass: each weight is scaled by
// 2^(k (height - 1)) and the sum normalised. AO scales the sun-independent ambient term only. Our own code from those
// descriptions.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Terrain, TerrainLighting } from './index.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number };

/** One layer's material settings, in the order of `TerrainOptions.layers`. Every field has a default. */
export interface TerrainLayerMaterial {
  /** How strongly the normal map tilts the shading normal, 0 to 2. Default 1 (as authored). */
  normal?: number;
  /** How much of the map's ambient occlusion applies, 0 to 1. Default 1. */
  occlusion?: number;
  /** Multiplies the map's roughness, 0 to 2 (the result is clamped to 0.02 to 1). Default 1. */
  roughness?: number;
}
/** The textures `TerrainMaterialOptions.textures` returns; the materials own and destroy them. */
export interface TerrainMaterialTextures {
  /**
   * Tangent-space normal maps, one array layer per terrain layer, XYZ encoded 0..1 with +Y up (the OpenGL convention,
   * Poly Haven's `nor_gl`): `rgba8unorm` or `rgba16float`, the size of the layers' colour texture.
   */
  normals: GPUTexture;
  /**
   * Surface maps, one array layer per terrain layer: R ambient occlusion, G roughness (glTF's ORM order; Poly Haven's
   * `arm`), B unused, A height 0..1 (Poly Haven's `disp`): `rgba8unorm` or `rgba16float`.
   */
  surface: GPUTexture;
}
/** Settings of {@link TerrainMaterials.attach}. Invalid values throw RangeError. */
export interface TerrainMaterialOptions {
  /** Creates the textures, at attachment and again after device restoration (recreate them from retained data). */
  textures: (device: GPUDevice) => TerrainMaterialTextures;
  /** One entry per terrain layer, or fewer (the rest take the defaults). Default: all defaults. */
  layers?: readonly TerrainLayerMaterial[];
  /**
   * Height blending where layers' weights overlap, 0 to 1: 0 crossfades by weight as the terrain does; 1 lets the
   * higher surface win almost outright (weights scaled by 2^(8 (height - 1))). Default 0.5.
   */
  heightBlend?: number;
}

// Terrain lighting group bindings 90 to 92: clear of shadows (1 to 31, effects from 40, four each) and clustered (4 to 30).
const BINDING = 90;
let nextId = 0;
/**
 * Full PBR layer materials for a `Terrain`: per layer normal, ambient occlusion, roughness and height maps, triplanar
 * like the layer colours, with height blending between layers. `TerrainMaterials.attach(engine, terrain, options)`;
 * WebGPU only. Works with painted weights, `bump` and `macro`, shadows and clustered lights (they read its normal and
 * roughness); SSR's capture keeps the terrain's own normal and roughness.
 * @throws RangeError when an option is out of range.
 * @throws TypeError when the textures have the wrong dimension, format, usage or layer count.
 * @throws MargoError `'unsupported'` when the terrain's shader lacks the lines it patches, `'disposed'` after dispose.
 */
export class TerrainMaterials implements EnginePlugin, TerrainLighting {
  readonly name = 'terrain-materials:' + nextId++;
  disposed = false;
  owner?: Engine;
  private device?: GPUDevice;
  private textures?: TerrainMaterialTextures;
  private rules?: GPUBuffer;
  private entries: GPUBindGroupEntry[] = [];
  private remove?: () => void;
  private readonly cache = new Map<string, string>();

  private constructor(
    private readonly terrain: Terrain,
    readonly options: TerrainMaterialOptions,
  ) {
    const count = terrain?.options?.layers?.length;
    if (!count || typeof options?.textures !== 'function')
      throw new TypeError('Invalid terrain materials; pass a Terrain and options with a textures factory');
    const blend = options.heightBlend ?? 0.5,
      layers = options.layers ?? [];
    if (
      !(blend >= 0 && blend <= 1) ||
      !Array.isArray(layers) ||
      layers.length > count ||
      !layers.every(
        (l) =>
          (l.normal ?? 1) >= 0 &&
          (l.normal ?? 1) <= 2 &&
          (l.occlusion ?? 1) >= 0 &&
          (l.occlusion ?? 1) <= 1 &&
          (l.roughness ?? 1) >= 0 &&
          (l.roughness ?? 1) <= 2,
      )
    )
      throw new RangeError(
        'Invalid terrain materials; give heightBlend 0..1 and at most one entry per terrain layer with normal 0..2, occlusion 0..1 and roughness 0..2.',
      );
  }

  /** Attaches materials to `terrain`, which must already be attached to `engine`. Returns them; `dispose()` removes them. */
  static attach(engine: EngineKernel, terrain: Terrain, options: TerrainMaterialOptions): TerrainMaterials {
    const materials = new TerrainMaterials(terrain, options);
    engineRuntime(engine).use(materials);
    return materials;
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Terrain materials require WebGPU and a live module; attach new TerrainMaterials to a WebGPU engine',
      );
    this.owner = engine;
    this.device = engine.gpu;
    const t = (this.textures = this.options.textures(this.device)),
      count = this.terrain.options.layers.length;
    for (const texture of [t?.normals, t?.surface])
      if (
        !texture ||
        texture.dimension !== '2d' ||
        !(texture.usage & GPUTextureUsage.TEXTURE_BINDING) ||
        texture.sampleCount !== 1 ||
        texture.depthOrArrayLayers !== count ||
        !['rgba8unorm', 'rgba16float'].includes(texture.format)
      )
        throw new TypeError(
          `Invalid terrain material textures; return normals and surface as rgba8unorm or rgba16float 2D arrays with ${count} layers, one per terrain layer`,
        );
    const data = new Float32Array(64),
      k = 8 * (this.options.heightBlend ?? 0.5);
    for (let i = 0; i < count; i++) {
      const l = this.options.layers?.[i] ?? {};
      data.set([l.normal ?? 1, l.occlusion ?? 1, l.roughness ?? 1, k], i * 4);
    }
    this.rules = this.device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.rules, 0, data);
    this.entries = [
      { binding: BINDING, resource: t.normals.createView({ dimension: '2d-array' }) },
      { binding: BINDING + 1, resource: t.surface.createView({ dimension: '2d-array' }) },
      { binding: BINDING + 2, resource: { buffer: this.rules } },
    ];
    this.remove ??= this.terrain.addLighting(this);
  }

  /** The group-1 entries the patched shader reads. */
  bindings(): GPUBindGroupEntry[] {
    return this.entries;
  }

  /** The terrain's lit shader with the layer materials patched in (bindings in `group`). */
  shader(source: string, group: number): string {
    const key = group + source;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const head = '@fragment fn fragment(i:Output)->@location(0) vec4f {',
      plain = 'let n=normalize(i.normal);let base=terrainColor(i.position,n);',
      bumped = 'let n=terrainBump(i.position,terrainN);',
      rules = 'let weight=smoothstep(',
      painted = 'let weight=packed[layer/4u][layer%4u];if(weight<=0.0){continue;}',
      ambient = '+base*frame.radiance.w';
    const parts = [head, ambient, 'total+=weight;'];
    if (
      parts.some((p) => source.split(p).length !== 2) ||
      source.includes(plain) === source.includes(bumped) ||
      source.includes(rules) === source.includes(painted)
    )
      throw new MargoError(
        'unsupported',
        "Terrain materials need the terrain's own lit shader; attach them before any effect that replaces it",
      );
    const resolve = 'i.material.x=terrainPbrRoughness(i.material.x);';
    let code =
      materialFunctions(group) +
      source
        .replace(head, 'fn terrainPbrShade(terrainIn:Output)->vec4f {var i=terrainIn;')
        .replace(
          plain,
          `let terrainN0=normalize(i.normal);let base=terrainColor(i.position,terrainN0);let n=terrainPbrNormal(terrainN0);${resolve}`,
        )
        .replace(bumped, `let n=terrainPbrNormal(terrainBump(i.position,terrainN));${resolve}`)
        .replace(rules, 'let weight=terrainPbrHeight(position,projection,dx,dy,layer)*smoothstep(')
        .replace(
          painted,
          'let painted=packed[layer/4u][layer%4u];if(painted<=0.0){continue;}let weight=painted*terrainPbrHeight(position,projection,dx,dy,layer);',
        )
        .replace('total+=weight;', 'total+=weight;terrainPbrLayer(position,projection,dx,dy,layer,weight);')
        .replace(ambient, ambient + '*terrainPbrOcclusion()');
    code += `\n${head}return terrainPbrShade(i);}\n`;
    if (this.cache.size >= 16) this.cache.clear();
    this.cache.set(key, code);
    return code;
  }

  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }

  private release(): void {
    this.textures?.normals.destroy();
    this.textures?.surface.destroy();
    this.rules?.destroy();
    this.textures = this.rules = undefined;
    this.entries = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.remove?.();
    this.remove = undefined;
    this.owner?.removePlugin(this.name);
    this.release();
    this.cache.clear();
    this.owner = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/**
 * One map's three triplanar samples, named so terrain's lighting layout sees the texture read through its filtering
 * sampler (a texture passed as a parameter reads as unfilterable there).
 */
const tri = (texture: string, name: string): string => /* wgsl */ `
fn ${name}(p:vec3f,q:vec3f,dx:vec3f,dy:vec3f,s:f32,layer:u32)->array<vec4f,3> {
  var r=array<vec4f,3>(vec4f(0),vec4f(0),vec4f(0));
  if(q.x>0.0){r[0]=textureSampleGrad(${texture},terrainSampler,p.zy,i32(layer),dx.zy*s,dy.zy*s);}
  if(q.y>0.0){r[1]=textureSampleGrad(${texture},terrainSampler,p.xz,i32(layer),dx.xz*s,dy.xz*s);}
  if(q.z>0.0){r[2]=textureSampleGrad(${texture},terrainSampler,p.xy,i32(layer),dx.xy*s,dy.xy*s);}
  return r;
}`;
/**
 * The WGSL the patch adds: the bindings, the per-layer rules (normal strength, occlusion amount, roughness scale,
 * height-blend exponent) and the private sums the layer loop fills.
 */
const materialFunctions = (group: number): string => /* wgsl */ `
@group(${group}) @binding(${BINDING}) var terrainPbrNormals:texture_2d_array<f32>;
@group(${group}) @binding(${BINDING + 1}) var terrainPbrSurfaces:texture_2d_array<f32>;
@group(${group}) @binding(${BINDING + 2}) var<uniform> terrainPbrRules:array<vec4f,16>;
var<private> terrainPbrGradient:vec4f;var<private> terrainPbrSurface:vec3f;var<private> terrainPbrLast:vec4f;
${tri('terrainPbrNormals', 'terrainPbrTriN')}${tri('terrainPbrSurfaces', 'terrainPbrTriS')}
fn terrainPbrHeight(position:vec3f,projection:vec3f,dx:vec3f,dy:vec3f,layer:u32)->f32 {
  let s=layerRules[layer].params.x;let t=terrainPbrTriS(position*s,projection,dx,dy,s,layer);
  terrainPbrLast=t[0]*projection.x+t[1]*projection.y+t[2]*projection.z;
  return exp2(terrainPbrRules[layer].w*(terrainPbrLast.a-1.0));
}
fn terrainPbrLayer(position:vec3f,projection:vec3f,dx:vec3f,dy:vec3f,layer:u32,weight:f32) {
  if(weight<=0.0){return;}
  let r=terrainPbrRules[layer];let s=layerRules[layer].params.x;
  let t=terrainPbrTriN(position*s,projection,dx,dy,s,layer);
  // Each projection's normal as the slope of a height over its plane, (du, dv) in world axes: x samples (z, y), y
  // samples (x, z), z samples (x, y). +Y up in the map is -v in WebGPU's texture rows.
  var g=vec3f(0);
  if(projection.x>0.0){let m=t[0].xyz*2.0-1.0;let d=vec2f(-m.x,m.y)/max(m.z,0.05);g+=projection.x*vec3f(0.0,d.y,d.x);}
  if(projection.y>0.0){let m=t[1].xyz*2.0-1.0;let d=vec2f(-m.x,m.y)/max(m.z,0.05);g+=projection.y*vec3f(d.x,0.0,d.y);}
  if(projection.z>0.0){let m=t[2].xyz*2.0-1.0;let d=vec2f(-m.x,m.y)/max(m.z,0.05);g+=projection.z*vec3f(d.x,d.y,0.0);}
  terrainPbrGradient+=vec4f(g*r.x*weight,weight);
  terrainPbrSurface+=vec3f(mix(1.0,terrainPbrLast.r,r.y),terrainPbrLast.g*r.z,0.0)*weight;
}
fn terrainPbrNormal(n:vec3f)->vec3f {
  if(terrainPbrGradient.w<=0.00001){return n;}
  let g=terrainPbrGradient.xyz/terrainPbrGradient.w;let surface=g-dot(g,n)*n;let tilted=n-surface;
  return select(n,normalize(tilted),dot(tilted,tilted)>0.0);
}
fn terrainPbrRoughness(fallback:f32)->f32 {
  if(terrainPbrGradient.w<=0.00001){return fallback;}
  return clamp(terrainPbrSurface.y/terrainPbrGradient.w,0.02,1.0);
}
fn terrainPbrOcclusion()->f32 {
  if(terrainPbrGradient.w<=0.00001){return 1.0;}
  return terrainPbrSurface.x/terrainPbrGradient.w;
}
`;
