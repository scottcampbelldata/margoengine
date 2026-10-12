import type {EngineKernel, Mesh} from '@margoengine/core';
import {engineRuntime, meshRuntime, type Engine, type EnginePlugin, type FrameGraph} from '@margoengine/core/extension';
declare const GPUTextureUsage: {TEXTURE_BINDING: number; COPY_DST: number; COPY_SRC: number};

type Color = readonly [number, number, number];
type Range = readonly [number, number];
export interface TerrainColorOptions {
  sand: Color; meadow: readonly [Color, Color]; stone: Color;
  shore: Range; meadowHeight: Range; stoneHeight: Range; stoneNormal: Range;
  wetHeight: Range; wetDarkening: number; variation?: number;
  wetness?: {texture: () => GPUTexture | undefined; origin: Range; size: Range};
}
let serial = 0;

/** Height/slope colors on one ordinary mesh, preserving the scene's PBR and shadow shader. */
export class TerrainColors implements EnginePlugin {
  readonly name = 'terrain:colors:' + ++serial;
  private engine?: Engine;
  private source = '';
  private shader = '';
  private disposed = false;
  private readonly colorCode: string;
  private readonly wetCode: string;
  private readonly wetness?: TerrainColorOptions['wetness'];
  private dry?: GPUTexture;
  private dryEntry?: GPUBindGroupEntry;
  private wet?: GPUTexture;
  private wetEntry?: GPUBindGroupEntry;
  private readonly wetSource: GPUTexelCopyTextureInfo = {texture: undefined!};
  private readonly wetTarget: GPUTexelCopyTextureInfo = {texture: undefined!};
  private readonly wetSize: GPUExtent3DDict = {width: 1, height: 1};
  constructor(private readonly mesh: Mesh, options: TerrainColorOptions) {
    if (options.meadow.length !== 2) throw new RangeError('Expected two meadow colors');
    for (const color of [options.sand,...options.meadow,options.stone]) if (color.length !== 3 || color.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new RangeError('Invalid terrain color');
    for (const range of [options.shore,options.meadowHeight,options.stoneHeight,options.stoneNormal,options.wetHeight]) if (range.length !== 2 || !range.every(v => Number.isFinite(Math.fround(v))) || range[0] >= range[1]) throw new RangeError('Invalid terrain color range');
    if (options.stoneNormal[0] < 0 || options.stoneNormal[1] > 1 || !Number.isFinite(options.wetDarkening) || options.wetDarkening < 0 || options.wetDarkening > 1 || !Number.isFinite(options.variation ?? 0) || (options.variation ?? 0) < 0 || (options.variation ?? 0) > 1) throw new RangeError('Invalid terrain wetness or variation');
    const wetness = options.wetness;
    if (wetness !== undefined && (!wetness || typeof wetness.texture !== 'function' || !Array.isArray(wetness.origin) || !Array.isArray(wetness.size) || wetness.origin.length !== 2 || wetness.size.length !== 2 || !wetness.origin.every(v => Number.isFinite(Math.fround(v))) || !wetness.size.every(v => Number.isFinite(Math.fround(v)) && v > 0))) throw new RangeError('Invalid terrain wetness map');
    this.wetness = wetness;
    const rgb = (color: Color) => `vec3f(${color.join(',')})`;
    const variation = options.variation ?? 0;
    this.colorCode = `
      let h=p.y;let slope=normalize(o.normal).y;
      let variation=${1-variation}+${variation}*sin(p.x*0.8)*cos(p.z*0.6);
      let meadow=mix(${rgb(options.meadow[0])},${rgb(options.meadow[1])},smoothstep(${options.meadowHeight.join(',')},h));
      let stone=mix(meadow,${rgb(options.stone)},max(smoothstep(${options.stoneHeight.join(',')},h),1.0-smoothstep(${options.stoneNormal.join(',')},slope)));
      let wet=mix(${options.wetDarkening},1.0,smoothstep(${options.wetHeight.join(',')},h));
      o.color=mix(${rgb(options.sand)},stone,smoothstep(${options.shore.join(',')},h))*variation${wetness ? '' : '*wet'};`;
    this.wetCode = wetness ? `
@group(0) @binding(9) var terrainWater:texture_2d<f32>;
fn terrainWet(position:vec3f)->f32 {
 // shortcut: current depth only, use a persistent mask for drying sand after recession.
 if(position.y>=${options.wetHeight[1]}){return 1.0;}
 let uv=(position.xz-vec2f(${wetness.origin.join(',')}))/vec2f(${wetness.size.join(',')});
 if(any(uv<vec2f(0))||any(uv>vec2f(1))){return 1.0;}
 let size=vec2i(textureDimensions(terrainWater));let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let lo=vec2i(floor(pixel));let hi=min(lo+1,size-1);let t=fract(pixel);
 let a=textureLoad(terrainWater,lo,0).r;let b=textureLoad(terrainWater,vec2i(hi.x,lo.y),0).r;let c=textureLoad(terrainWater,vec2i(lo.x,hi.y),0).r;let d=textureLoad(terrainWater,hi,0).r;
 let depth=mix(mix(a,b,t.x),mix(c,d,t.x),t.y);
 let beach=(1.0-smoothstep(${options.wetHeight.join(',')},position.y))*(1.0-smoothstep(${options.shore.join(',')},position.y));
 return 1.0-${1-options.wetDarkening}*beach*smoothstep(0.001,0.025,depth);
}
` : '';
  }
  static attach(engine: EngineKernel, mesh: Mesh, options: TerrainColorOptions): TerrainColors {
    const colors = new TerrainColors(mesh, options); engineRuntime(engine).use(colors); return colors;
  }
  setup(engine: Engine): void {
    const mesh = meshRuntime(this.mesh); mesh.check();
    if (this.engine || this.disposed || mesh.engine !== engine) throw new Error('Terrain color mesh belongs to another engine or is already attached');
    this.engine = engine;
    if (this.wetness) {
      if (!engine.gpu) throw new Error('Terrain wetness requires WebGPU');
      this.dry = engine.gpu.createTexture({size: [1,1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      engine.gpu.queue.writeTexture({texture: this.dry}, new Float32Array(1), {bytesPerRow: 4}, [1,1]);
      this.dryEntry = {binding: 9, resource: this.dry.createView()};
    }
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({name: this.name, order: -1, execute: c => {
      if (c.backend !== 'webgpu') return;
      const mesh = meshRuntime(this.mesh); mesh.check();
      if (this.source !== c.shader) {
        this.source = c.shader;
        this.shader = c.shader.replace('o.color=i.color.rgb;', `o.color=i.color.rgb;if(i.factors.w==${mesh.id}.0){${this.colorCode}}`);
        if (this.wetness) {
          this.shader = this.wetCode + this.shader
            .replace(/struct Output \{[^}]+\}/, output => output.replace('}', ',@location(6) @interpolate(flat) terrainId:f32 }'))
            .replace('o.color=i.color.rgb;', 'o.terrainId=i.factors.w+1.0;o.color=i.color.rgb;')
            .replace(/let linear=([^;]+);/, `var terrainScale=1.0;if(i.terrainId==${mesh.id+1}.0){terrainScale=terrainWet(i.position);}let linear=($1)*terrainScale;`);
        }
      }
      if (this.wetness) {
        const texture = this.wetness.texture();
        if (texture !== undefined) {
          if (!texture || texture.dimension !== '2d' || texture.sampleCount !== 1 || texture.depthOrArrayLayers > 1 || !['r32float','rgba32float','rgba16float'].includes(texture.format) || !(texture.usage&GPUTextureUsage.COPY_SRC)) throw new TypeError('Terrain wetness needs a copyable water-depth texture');
          // A stable view avoids rebuilding scene/vegetation bindings as flow ping-pongs.
          if (this.wet?.width !== texture.width || this.wet?.height !== texture.height || this.wet?.format !== texture.format) {
            this.wet?.destroy();this.wet = c.device.createTexture({size: [texture.width,texture.height], format: texture.format, usage: GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
            this.wetEntry = {binding: 9, resource: this.wet.createView()};this.wetTarget.texture = this.wet;this.wetSize.width = texture.width;this.wetSize.height = texture.height;
          }
          this.wetSource.texture = texture;c.encoder.copyTextureToTexture(this.wetSource,this.wetTarget,this.wetSize);
        }
        c.bindings.push(texture ? this.wetEntry! : this.dryEntry!);
      }
      c.shader = this.shader;
    }});
  }
  onDeviceRestored(engine: Engine): void {this.dry?.destroy();this.wet?.destroy();this.dry=this.wet=undefined;this.dryEntry=this.wetEntry=undefined;this.wetSource.texture=this.wetTarget.texture=undefined!;this.engine=undefined;this.setup(engine);}
  dispose(): void {if (this.disposed) return; this.disposed = true; this.dry?.destroy();this.wet?.destroy();this.dry=this.wet=undefined;this.dryEntry=this.wetEntry=undefined;this.wetSource.texture=this.wetTarget.texture=undefined!;const engine = this.engine; this.engine = undefined; engine?.removePlugin(this.name);}
}
