/// <reference lib="esnext.disposable" preserve="true" />
// Near displacement for `Terrain` (entry `@margoengine/terrain/displace`): parallax occlusion mapping of the layer
// height maps `TerrainMaterials` (`@margoengine/terrain/layers-pbr`) binds, close to the camera, so pebbles, cracks and
// drifts show depth, hide each other and shadow themselves. Each fragment within reach walks its view ray down
// through the relief under the surface (a linear search, fewer steps when the surface faces the eye, then a secant
// step between the last two samples: Tatarchuk 2006, "Dynamic Parallax Occlusion Mapping with Approximate Soft
// Shadows", I3D; the search after Policarpo, Oliveira and Comba 2005, "Real-Time Relief Mapping on Arbitrary Polygonal
// Surfaces", I3D), and the terrain then shades the point it hit: its layer colours, normals, roughness and shadows all
// read there. The lateral step is capped at grazing angles (offset limiting, Welsh 2004, "Parallax Mapping with Offset
// Limiting"). Self-shadowing traces a ray from the hit toward the sun through a maximum mipmap of each layer's height
// map (each texel the highest relief over a square of the map: Tevs, Ihrke and Seidel 2008, "Maximum Mipmaps for Fast,
// Accurate, and Scalable Dynamic Height Field Rendering", I3D): it passes over every square whose highest point stays
// under the ray and descends only where one may not, so no ridge is stepped over, and at single texels it tests the
// blended relief itself. The sun's light fades over a small angle either side of the relief's horizon (soft edges).
// The relief height is the layers' height maps (alpha of their surface maps) blended by the terrain's weights with the
// materials' height blend, top projection only. Our own code from those descriptions.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Terrain, TerrainLighting } from './index.js';
import type { TerrainMaterials } from './layers-pbr.js';

/** One layer's relief. */
export interface TerrainLayerRelief {
  /** World depth from the height map's 1 (top) to its 0, 0 to 1. Default the displacement's `depth`. */
  depth?: number;
}
/** Settings of {@link TerrainDisplacement.attach}, fixed at attachment. Invalid values throw RangeError. */
export interface TerrainDisplacementOptions {
  /** World depth of every layer's relief, 0 to 1. Default 0.05 (5 cm). */
  depth?: number;
  /** Per layer depths, in the order of `TerrainOptions.layers` (fewer: the rest take `depth`). */
  layers?: readonly TerrainLayerRelief[];
  /** World distance from the camera within which the relief shows, fading out over its last quarter, above 0. Default 30. */
  distance?: number;
  /** Most search steps a fragment takes (a quarter of them facing the surface), 4 to 64. Default 24. */
  steps?: number;
  /**
   * Whether the relief shadows itself from the sun. Needs square, power-of-two surface maps; adds a maximum mipmap of
   * them (4 bytes per texel per layer, plus a third for its smaller levels). Default true.
   */
  shadows?: boolean;
}

// Terrain lighting group bindings 97 and 98, after layer materials (90 to 92) and the virtual texture (94 to 96).
const BINDING = 97,
  // Most steps of one shadow ray through the maximum mipmap (one square passed over, descended into or tested); a ray
  // that has not left the relief by then counts the rest as lit.
  SHADOW_STEPS = 160,
  // Half the angle, in radians, over which the sun's light fades at the relief's horizon (about 1.1 degrees).
  SOFT = 0.02;
const entry = '@fragment fn fragment(i:Output)->@location(0) vec4f {return terrainPbrShade(i);}',
  gradients = 'let dx=dpdx(position);let dy=dpdy(position);',
  direct = 'let direct=(';
/**
 * The shadow ray through the maximum mipmap. Positions are in the texel corner grid of the reference layer (the active
 * layer with the finest texels: cell i spans its texel centres i and i + 1), offset from the ray's start; heights are
 * relief heights, 0 to 1. `terrainDisplaceBound` gives the highest relief over a region from every active layer's own
 * levels (a layer at another scale covers the region with at most 2 by 2 cells of the first level as coarse as it).
 */
const shadowFunctions = /* wgsl */ `
@group(GROUP) @binding(${BINDING + 1}) var terrainDisplaceMax:texture_2d_array<f32>;
var<private> terrainDisplaceO:array<vec2f,16>;
fn terrainDisplaceRelief(xz:vec2f)->f32 {
  var sum=0.0;var total=0.0;
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    let w=terrainDisplaceW[layer];if(w<=0.0){continue;}
    let a=textureSampleLevel(terrainPbrSurfaces,terrainSampler,xz*layerRules[layer].params.x,i32(layer),0.0).a;
    let b=w*exp2(terrainPbrRules[layer].w*(a-1.0));sum+=b*a;total+=b;
  }
  return sum/max(total,0.00001);
}
fn terrainDisplaceBound(lo:vec2f,hi:vec2f,reference:f32,top:i32)->f32 {
  var m=0.0;
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    if(terrainDisplaceW[layer]<=0.0){continue;}
    let r=layerRules[layer].params.x/reference;let a=terrainDisplaceO[layer]+lo*r+0.001;let b=terrainDisplaceO[layer]+hi*r-0.001;
    let level=clamp(i32(ceil(log2(max(max(b.x-a.x,b.y-a.y),1.0)))),0,top);
    let c=exp2(f32(level));let n=vec2i(textureDimensions(terrainDisplaceMax,level));
    let c0=vec2i(floor(a/c));let c1=vec2i(floor(b/c));
    for(var y=c0.y;y<=c1.y;y++){for(var x=c0.x;x<=c1.x;x++){
      m=max(m,textureLoad(terrainDisplaceMax,((vec2i(x,y)%n)+n)%n,i32(layer),level).r);
    }}
  }
  return m;
}
fn terrainDisplaceSun(p:vec3f,normal:vec3f,depth:f32)->f32 {
  let l=frame.light.xyz;let up=dot(l,normal);let t=l-normal*up;let run=length(t.xz);
  if(up<=0.0||run<0.0001){return 1.0;}
  let dir=t.xz/run;let side=f32(textureDimensions(terrainDisplaceMax).x);let top=i32(textureNumLevels(terrainDisplaceMax))-1;
  var reference=0.0;var first=0u;var root=0.0;
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    if(terrainDisplaceW[layer]<=0.0){continue;}
    let s=layerRules[layer].params.x;if(s>reference){reference=s;first=layer;}
    terrainDisplaceO[layer]=fract(p.xz*s)*side-0.5;
    root=max(root,textureLoad(terrainDisplaceMax,vec2i(0),i32(layer),top).r);
  }
  if(reference<=0.0){return 1.0;}
  // Per texel of the reference layer: the ray's rise, and the clearance that lights fully, in relief heights.
  let k=reference*side;let rise=up/run/(depth*k);let margin=${SOFT}/(depth*k);let o=terrainDisplaceO[first];
  let h0=terrainDisplaceRelief(p.xz);
  var level=0;var tau=0.0;var lowest=${SOFT};
  for(var i=0;i<${SHADOW_STEPS};i++){
    let ray=h0+rise*tau;if(ray>=root){break;}
    let w=o+dir*tau;let c=exp2(f32(level));let cell=floor((w+dir*0.001)/c)*c;
    let across=select((select(cell,cell+c,dir>vec2f(0.0))-w)/dir,vec2f(1e9),abs(dir)<vec2f(0.000001));
    let exit=tau+max(min(across.x,across.y),0.001);
    if(ray-terrainDisplaceBound(cell-o,cell+c-o,reference,top)>=margin*exit){tau=exit;level=min(level+1,top);continue;}
    if(level>0){level--;continue;}
    for(var j=1;j<=2;j++){
      let at=mix(tau,exit,0.5*f32(j));
      if(at>=0.25){lowest=min(lowest,(h0+rise*at-terrainDisplaceRelief(p.xz+dir*(at/k)))*depth*k/at);}
    }
    if(lowest<=-${SOFT}){break;}
    tau=exit;
  }
  return smoothstep(-${SOFT},${SOFT},lowest);
}`;
/**
 * The relief functions: `terrainDisplaceWeights` takes the layer weights at the fragment (painted, or the height and
 * slope rules as the terrain computes them), `terrainDisplaceHeight` the blended relief height (0 to 1) at a world XZ,
 * `terrainDisplace` the point the view ray hits, and `terrainDisplaceSun` the sun's share there.
 * Settings: `terrainDisplaceRules[layer].x` the layer's depth; `terrainDisplaceRules[16]` (distance, steps, shadows).
 */
const functions = (group: number, painted: number, shadows: boolean): string => /* wgsl */ `
@group(${group}) @binding(${BINDING}) var<uniform> terrainDisplaceRules:array<vec4f,17>;
var<private> terrainDisplaced:bool;var<private> terrainDisplaceDx:vec3f;var<private> terrainDisplaceDy:vec3f;
var<private> terrainDisplaceShadow:f32=1.0;var<private> terrainDisplaceW:array<f32,16>;
fn terrainDisplaceWeights(position:vec3f,normal:vec3f)->f32 {
  var total=0.0;var depth=0.0;let count=u32(frame.heights.z);${
    painted
      ? `
  let d=vec2f(textureDimensions(terrainWeights0));let uv=clamp((position.xz-frame.map.xy)/frame.map.zw,vec2f(0.5)/d,vec2f(1)-vec2f(0.5)/d);
  let packed=array<vec4f,4>(${[0, 1, 2, 3].map((i) => (i < painted ? `textureSampleLevel(terrainWeights${i},terrainSampler,uv,0)` : 'vec4f(0)')).join(',')});
  for(var layer=0u;layer<count;layer++){let w=packed[layer/4u][layer%4u];terrainDisplaceW[layer]=w;total+=w;depth+=w*terrainDisplaceRules[layer].x;}`
      : `
  let slope=1-clamp(normal.y,0.0,1.0);
  for(var layer=0u;layer<count;layer++){
    let rule=layerRules[layer];let hs=rule.heightSlope;let h=rule.params.y;let s=rule.params.z;
    let w=smoothstep(hs.x-h,hs.x+h,position.y)*(1-smoothstep(hs.y-h,hs.y+h,position.y))*smoothstep(hs.z-s,hs.z+s,slope)*(1-smoothstep(hs.w-s,hs.w+s,slope));
    terrainDisplaceW[layer]=w;total+=w;depth+=w*terrainDisplaceRules[layer].x;
  }`
  }
  if(total<=0.00001){for(var layer=0u;layer<count;layer++){terrainDisplaceW[layer]=0.0;}terrainDisplaceW[0]=1.0;return terrainDisplaceRules[0].x;}
  return depth/total;
}
fn terrainDisplaceHeight(xz:vec2f)->f32 {
  var sum=0.0;var total=0.0;
  for(var layer=0u;layer<u32(frame.heights.z);layer++){
    let w=terrainDisplaceW[layer];if(w<=0.0){continue;}
    let s=layerRules[layer].params.x;
    let a=textureSampleGrad(terrainPbrSurfaces,terrainSampler,xz*s,i32(layer),terrainDisplaceDx.xz*s,terrainDisplaceDy.xz*s).a;
    let b=w*exp2(terrainPbrRules[layer].w*(a-1.0));sum+=b*a;total+=b;
  }
  return sum/max(total,0.00001);
}${shadows ? shadowFunctions.replace('GROUP', String(group)) : ''}
fn terrainDisplace(position:vec3f,normal:vec3f)->vec3f {
  terrainDisplaceDx=dpdx(position);terrainDisplaceDy=dpdy(position);
  let settings=terrainDisplaceRules[16];let v=frame.eye.xyz-position;let far=length(v);
  if(far>=settings.x||normal.y<0.55){return position;}
  let depth=terrainDisplaceWeights(position,normal)*(1.0-smoothstep(0.75*settings.x,settings.x,far))*smoothstep(0.55,0.85,normal.y);
  if(depth<=0.0){return position;}
  let e=v/far;let facing=max(dot(e,normal),0.2);let ray=-e/facing;
  let steps=max(round(mix(settings.y,settings.y*0.25,facing)),2.0);let dd=depth/steps;
  var d0=0.0;var f0=-depth*(1.0-terrainDisplaceHeight(position.xz));var d1=0.0;var f1=f0;
  for(var k=1.0;k<=steps;k+=1.0){
    d1=dd*k;f1=d1-depth*(1.0-terrainDisplaceHeight((position+ray*d1).xz));
    if(f1>=0.0){break;}
    d0=d1;f0=f1;
  }
  var hit=d1;if(f1>=0.0&&f1>f0){hit=d0+(d1-d0)*(-f0)/(f1-f0);}
  let p=position+ray*hit;terrainDisplaced=true;${shadows ? 'terrainDisplaceShadow=terrainDisplaceSun(p,normal,depth);' : ''}
  return p;
}`;
/** Builds one level of the maximum mipmap: level 0 from the surface maps' height (alpha), the rest from the level below. */
const maximaSource = (first: boolean): string => /* wgsl */ `
@group(0) @binding(0) var relief:texture_2d_array<f32>;
@group(0) @binding(1) var maxima:texture_storage_2d_array<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let n=textureDimensions(maxima);if(id.x>=n.x||id.y>=n.y){return;}
  let m=vec2i(textureDimensions(relief));var h=0.0;
  for(var y=0;y<2;y++){for(var x=0;x<2;x++){
    h=max(h,textureLoad(relief,(vec2i(id.xy)*${first ? 1 : 2}+vec2i(x,y))%m,i32(id.z),0).${first ? 'a' : 'r'});
  }}
  textureStore(maxima,vec2i(id.xy),i32(id.z),vec4f(h));
}`;

let nextId = 0;
/**
 * Near displacement (parallax occlusion) of a terrain's layer height maps, for a terrain with `TerrainMaterials`:
 * `TerrainDisplacement.attach(engine, terrain, materials, options)` after `TerrainMaterials.attach`; WebGPU only.
 * Ground within `distance` of the camera and no steeper than about 57 degrees shows its relief's depth, occlusion and
 * self-shadow; the outline of the ground against the sky stays the clipmap's (no real geometry moves).
 * @throws RangeError when an option is out of range.
 * @throws MargoError `'unsupported'` when the terrain's shader has no layer materials, or shadows meet surface maps
 * that are not square and a power of two; `'disposed'` after dispose.
 */
export class TerrainDisplacement implements EnginePlugin, TerrainLighting {
  readonly name = 'terrain-displace:' + nextId++;
  disposed = false;
  owner?: Engine;
  #rules?: GPUBuffer;
  #maxima?: GPUTexture;
  #entries: GPUBindGroupEntry[] = [];
  #remove?: () => void;
  readonly #cache = new Map<string, string>();

  private constructor(
    private readonly terrain: Terrain,
    private readonly materials: TerrainMaterials,
    readonly options: TerrainDisplacementOptions,
  ) {
    const count = terrain?.options?.layers?.length;
    if (!count || typeof terrain.addLighting !== 'function')
      throw new TypeError('Invalid terrain displacement; pass a Terrain');
    if (typeof materials?.bindings !== 'function' || !('surface' in materials))
      throw new TypeError('Invalid terrain displacement; pass the TerrainMaterials attached to the terrain');
    const o = options ?? {},
      layers = o.layers ?? [],
      inRange = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1;
    if (
      !inRange(o.depth ?? 0.05) ||
      !Array.isArray(layers) ||
      layers.length > count ||
      !layers.every((l) => inRange(l?.depth ?? 0)) ||
      !((o.distance ?? 30) > 0 && Number.isFinite(o.distance ?? 30)) ||
      !Number.isInteger(o.steps ?? 24) ||
      (o.steps ?? 24) < 4 ||
      (o.steps ?? 24) > 64 ||
      typeof (o.shadows ?? true) !== 'boolean'
    )
      throw new RangeError(
        'Invalid terrain displacement; give depth 0..1, at most one layers entry per terrain layer with depth 0..1, distance above 0, steps 4..64 and shadows true or false.',
      );
  }

  /** Attaches displacement to `terrain`, after its `materials`. `dispose()` removes it. */
  static attach(
    engine: EngineKernel,
    terrain: Terrain,
    materials: TerrainMaterials,
    options: TerrainDisplacementOptions = {},
  ): TerrainDisplacement {
    const displacement = new TerrainDisplacement(terrain, materials, options);
    engineRuntime(engine).use(displacement);
    return displacement;
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Terrain displacement requires WebGPU and a live module; attach a new one to a WebGPU engine',
      );
    this.owner = engine;
    const o = this.options,
      gpu = engine.gpu,
      data = new Float32Array(68);
    for (let i = 0; i < 16; i++) data[i * 4] = o.layers?.[i]?.depth ?? o.depth ?? 0.05;
    data.set([o.distance ?? 30, o.steps ?? 24, +(o.shadows ?? true), 0], 64);
    this.#rules = gpu.createBuffer({ size: data.byteLength, usage: 0x40 | 0x8 });
    gpu.queue.writeBuffer(this.#rules, 0, data);
    this.#entries = [{ binding: BINDING, resource: { buffer: this.#rules } }];
    if (o.shadows ?? true) {
      this.#maxima = this.#buildMaxima(gpu);
      this.#entries.push({ binding: BINDING + 1, resource: this.#maxima.createView({ dimension: '2d-array' }) });
    }
    this.#remove ??= this.terrain.addLighting(this);
  }

  /** The maximum mipmap of the materials' height maps: texel (i, j) of level 0 is the highest of texels i..i+1, j..j+1. */
  #buildMaxima(gpu: GPUDevice): GPUTexture {
    const surface = this.materials.surface,
      side = surface?.width ?? 0;
    if (!surface)
      throw new MargoError(
        'unsupported',
        'Terrain displacement needs live TerrainMaterials; attach TerrainMaterials first',
      );
    if (surface.height !== side || side < 1 || side & (side - 1))
      throw new MargoError(
        'unsupported',
        'Terrain displacement shadows need square, power-of-two surface maps; resize them or pass shadows: false',
      );
    const levels = Math.log2(side) + 1,
      layers = surface.depthOrArrayLayers,
      maxima = gpu.createTexture({
        size: [side, side, layers],
        format: 'r32float',
        mipLevelCount: levels,
        usage: 0x4 | 0x8,
      }),
      pipelines = [true, false].map((first) =>
        gpu.createComputePipeline({
          layout: 'auto',
          compute: { module: gpu.createShaderModule({ code: maximaSource(first) }), entryPoint: 'main' },
        }),
      ),
      encoder = gpu.createCommandEncoder(),
      pass = encoder.beginComputePass();
    for (let level = 0; level < levels; level++) {
      const pipeline = pipelines[level ? 1 : 0],
        groups = Math.ceil((side >> level) / 8);
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        gpu.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: (level ? maxima : surface).createView({
                dimension: '2d-array',
                baseMipLevel: Math.max(level - 1, 0),
                mipLevelCount: 1,
              }),
            },
            {
              binding: 1,
              resource: maxima.createView({ dimension: '2d-array', baseMipLevel: level, mipLevelCount: 1 }),
            },
          ],
        }),
      );
      pass.dispatchWorkgroups(groups, groups, layers);
    }
    pass.end();
    gpu.queue.submit([encoder.finish()]);
    return maxima;
  }

  /** The group-1 entries the patched shader reads. */
  bindings(): GPUBindGroupEntry[] {
    return this.#entries;
  }

  /** The terrain's lit shader (with layer materials) shading the point each near view ray hits (bindings in `group`). */
  shader(source: string, group: number): string {
    const key = group + source,
      cached = this.#cache.get(key);
    if (cached) return cached;
    if (
      !source.includes('terrainPbrSurfaces') ||
      [entry, gradients, direct].some((part) => source.split(part).length !== 2)
    )
      throw new MargoError(
        'unsupported',
        'Terrain displacement needs the terrain lit shader with TerrainMaterials; attach TerrainMaterials first',
      );
    const painted = [...source.matchAll(/var terrainWeights(\d):texture_2d<f32>;/g)].length,
      added = functions(group, painted, this.options.shadows ?? true),
      // A floating origin (originShader's `wrap:vec4f`): the relief repeats on the world phase, as the colours do.
      code =
        (source.includes('wrap:vec4f')
          ? added
              .replace('fract(p.xz*s)', 'fract((p.xz+layerRules[layer].wrap.xz)*s)')
              .replace('xz*s,i32(layer)', '(xz+layerRules[layer].wrap.xz)*s,i32(layer)')
          : added) +
        source
          .replace(
            entry,
            '@fragment fn fragment(i:Output)->@location(0) vec4f {var j=i;j.position=terrainDisplace(i.position,normalize(i.normal));return terrainPbrShade(j);}',
          )
          .replace(
            gradients,
            'var dx=dpdx(position);var dy=dpdy(position);if(terrainDisplaced){dx=terrainDisplaceDx;dy=terrainDisplaceDy;}',
          )
          .replace(direct, 'let direct=terrainDisplaceShadow*(');
    if (this.#cache.size >= 16) this.#cache.clear();
    this.#cache.set(key, code);
    return code;
  }

  onDeviceRestored(engine: Engine): void {
    this.#release();
    this.setup(engine);
  }

  #release(): void {
    this.#rules?.destroy();
    this.#maxima?.destroy();
    this.#rules = this.#maxima = undefined;
    this.#entries = [];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#remove?.();
    this.#remove = undefined;
    this.owner?.sceneOf(this)?.removePlugin(this.name);
    this.#release();
    this.#cache.clear();
    this.owner = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
