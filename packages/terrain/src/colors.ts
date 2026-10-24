/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import {
  engineRuntime,
  meshRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
} from '@margoengine/core/extension';
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; COPY_SRC: number };

type Range = readonly [number, number];
/** Height/slope material bands for {@link TerrainColors}. Colors are linear RGB in 0..1; ranges increase. */
export interface TerrainColorOptions {
  /** Beach color below `shore`. */
  sand: Vec3;
  /** Low and high meadow colors, blended over `meadowHeight`. */
  meadow: readonly [Vec3, Vec3];
  /** Rock color above `stoneHeight` and on steep slopes. */
  stone: Vec3;
  /** World heights over which sand gives way to meadow and stone. */
  shore: Range;
  /** World heights over which the low meadow color gives way to the high one. */
  meadowHeight: Range;
  /** World heights over which meadow gives way to stone. */
  stoneHeight: Range;
  /** Surface normal Y (0 vertical, 1 flat) over which steep stone gives way to meadow. */
  stoneNormal: Range;
  /** World heights over which the wet band dries. */
  wetHeight: Range;
  /** Albedo multiplier of fully wet ground, 0..1. Wet ground is also up to 40% smoother. */
  wetDarkening: number;
  /** Brightness variation, 0..1 (default 0): two scales of smooth noise darken colors by up to twice this. */
  variation?: number;
  /**
   * Per-pixel material detail, 0..1 (default 1). Noise moves each band border by up to 30% of its range; sand, meadow
   * and stone blend by procedural height maps, so sand settles between grass tufts and grass between rock bumps; steep
   * stone gets triplanar strata with a small normal perturbation. Fine detail fades out between 20 and 60 m from the
   * camera. 0 removes all of it from the shader.
   */
  detail?: number;
  /** Moving wet band from a borrowed water-depth texture (red channel, meters) over world XZ `origin`/`size`. */
  wetness?: { texture: () => GPUTexture | undefined; origin: Range; size: Range };
}
let serial = 0;

// Core's fragment computes its shading normal on this line (tests/shader-contracts). Terrain colors open a block after
// it whose `i` and `n` are per-pixel copies and close it with the fragment, so every later lighting patch (shadows,
// clustered, IBL, SSAO, SSR, scatter) keeps its text and shades the terrain's own albedo, roughness and normal.
const normalLine = 'let n=normalize(i.normal)*select(-1.0,1.0,facing);';
const block = 'let terrainSource=i;let terrainNormal=n;{var i=terrainSource;var n=terrainNormal;';
const surfaceStruct = 'struct TerrainSurface {color:vec3f,normal:vec3f,rough:f32}\n';
// Value noise on an integer lattice hashed with lowbias32 (C. Wellons, "Prospecting for Hash Functions"), returned with
// its analytic derivatives (value 0..1, d/dx, d/dy). It is not periodic, so no pattern repeats and no tile needs hiding.
const noiseCode = `
fn terrainHash(seed:u32)->u32 {
 var h=seed;h^=h>>16u;h*=0x7feb352du;h^=h>>15u;h*=0x846ca68bu;h^=h>>16u;return h;
}
// Corner values: terrainHash nested over the cell (y, then x plus that result), top 24 bits as 0..1. They are blended
// along x, then y, with the cubic fade s(t) = 3t^2 - 2t^3; by the product rule each blend's slope along its own axis is
// s'(t) = 6t(1-t) times the difference of what it blends, and the y blend carries the x blends' slopes along.
fn terrainNoise(p:vec2f)->vec3f {
 let base=floor(p);let c=bitcast<vec2u>(vec2i(base));let t=p-base;
 let row0=terrainHash(c.y);let row1=terrainHash(c.y+1u);
 let v00=f32(terrainHash(c.x+row0)>>8u)*5.9604645e-8;let v10=f32(terrainHash(c.x+1u+row0)>>8u)*5.9604645e-8;
 let v01=f32(terrainHash(c.x+row1)>>8u)*5.9604645e-8;let v11=f32(terrainHash(c.x+1u+row1)>>8u)*5.9604645e-8;
 let s=t*t*(3.0-2.0*t);let ds=6.0*t*(1.0-t);
 let low=mix(v00,v10,s.x);let high=mix(v01,v11,s.x);
 let slopeX=ds.x*mix(v10-v00,v11-v01,s.y);
 return vec3f(mix(low,high,s.y),slopeX,ds.y*(high-low));
}
`;
// Height-based blending (A. Mishkinis, "Advanced Terrain Texture Splatting", 2013): near a transition the higher surface
// wins within a 0.2 depth. Material heights stay in 0..0.5, so a material at weight 0 never shows through.
const blendCode = `
fn terrainBlend(t:f32,ha:f32,hb:f32)->f32 {
 let a=ha+1.0-t;let b=hb+t;let m=max(a,b)-0.2;let x=max(a-m,0.0);let y=max(b-m,0.0);return y/(x+y);
}
`;
/** The first @location a struct does not use: patches that add varyings to a shared struct must not collide. */
const freeLocation = (struct: string): number =>
  Math.max(-1, ...[...struct.matchAll(/@location\((\d+)\)/g)].map((m) => Number(m[1]))) + 1;
const num = (value: number) => String(Math.round(value * 1e6) / 1e6);

/** Height/slope colors on one ordinary mesh, shaded per pixel inside the scene's PBR and shadow shader. */
export class TerrainColors implements EnginePlugin {
  readonly name = 'terrain:colors:' + ++serial;
  private engine?: Engine;
  private source = '';
  private shader = '';
  private disposed = false;
  private readonly surfaceCode: string;
  private readonly wetCode: string;
  private readonly wetness?: TerrainColorOptions['wetness'];
  private dry?: GPUTexture;
  private dryEntry?: GPUBindGroupEntry;
  private wet?: GPUTexture;
  private wetEntry?: GPUBindGroupEntry;
  private wetBinding = 40;
  private readonly wetSource: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly wetTarget: GPUTexelCopyTextureInfo = { texture: undefined! };
  private readonly wetSize: GPUExtent3DDict = { width: 1, height: 1 };
  constructor(
    private readonly mesh: Mesh,
    options: TerrainColorOptions,
  ) {
    if (options.meadow.length !== 2) throw new RangeError('Expected two meadow colors');
    for (const color of [options.sand, ...options.meadow, options.stone])
      if (color.length !== 3 || color.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
        throw new RangeError('Invalid terrain color');
    for (const range of [
      options.shore,
      options.meadowHeight,
      options.stoneHeight,
      options.stoneNormal,
      options.wetHeight,
    ])
      if (range.length !== 2 || !range.every((v) => Number.isFinite(Math.fround(v))) || range[0] >= range[1])
        throw new RangeError('Invalid terrain color range');
    if (
      options.stoneNormal[0] < 0 ||
      options.stoneNormal[1] > 1 ||
      !Number.isFinite(options.wetDarkening) ||
      options.wetDarkening < 0 ||
      options.wetDarkening > 1 ||
      !Number.isFinite(options.variation ?? 0) ||
      (options.variation ?? 0) < 0 ||
      (options.variation ?? 0) > 1
    )
      throw new RangeError('Invalid terrain wetness or variation');
    const detail = options.detail ?? 1;
    if (typeof detail !== 'number' || !(detail >= 0 && detail <= 1))
      throw new RangeError('Terrain detail must be a number in 0..1');
    const wetness = options.wetness;
    if (
      wetness !== undefined &&
      (!wetness ||
        typeof wetness.texture !== 'function' ||
        !Array.isArray(wetness.origin) ||
        !Array.isArray(wetness.size) ||
        wetness.origin.length !== 2 ||
        wetness.size.length !== 2 ||
        !wetness.origin.every((v) => Number.isFinite(Math.fround(v))) ||
        !wetness.size.every((v) => Number.isFinite(Math.fround(v)) && v > 0))
    )
      throw new RangeError('Invalid terrain wetness map');
    this.wetness = wetness;
    const rgb = (color: Vec3) => `vec3f(${color.join(',')})`;
    const variation = options.variation ?? 0,
      dark = options.wetDarkening;
    // Noise moves a band's border by up to 30% of its range at the 14 m scale, so borders wander like real ones.
    const band = (range: Range, at: string) =>
        `smoothstep(${range.join(',')},${at}${detail ? `+large*${num(0.6 * detail * (range[1] - range[0]))}` : ''})`,
      blend = (t: string, heights: string) =>
        detail === 1 ? `terrainBlend(${t},${heights})` : `mix(${t},terrainBlend(${t},${heights}),${detail})`;
    // Per pixel: bands follow the interpolated height and normal, not the triangles. Noise has a 14 m and a 1.1 m
    // octave (turned 52 degrees so the lattices do not align); the fine one fades out by 60 m, before it can alias.
    // Detail: grass tufts (fine noise), sand in their hollows and rock bumps are the height maps of the blend. Rock is
    // triplanar where stone shows: anisotropic noise on the two vertical projections reads as horizontal strata, so
    // cliffs never stretch a top-down pattern; its analytic gradient tilts the normal (surface-gradient bump mapping).
    this.surfaceCode = `
fn terrainSurface(p:vec3f,n:vec3f)->TerrainSurface {
 var s:TerrainSurface;let h=p.y;${
   variation || detail
     ? `let fade=1.0-smoothstep(20.0,60.0,distance(frame.eye.xyz,p));
 let large=terrainNoise(p.xz*0.07).x-0.5;var fine=0.0;
 if(fade>0.0){fine=(terrainNoise(mat2x2f(0.61566,0.78801,-0.78801,0.61566)*p.xz*0.9).x-0.5)*fade;}`
     : ''
 }
 let meadow=mix(${rgb(options.meadow[0])},${rgb(options.meadow[1])},${band(options.meadowHeight, 'h')});
 let shore=${band(options.shore, 'h')};
 let steep=max(${band(options.stoneHeight, 'h')},1.0-${band(options.stoneNormal, 'n.y')});${
   detail
     ? `
 var rock=large;var grad=vec3f(0.0);
 if(steep>0.004&&fade>0.0){
  let a=n*n;var w=a*a;w/=w.x+w.y+w.z;
  let zy=terrainNoise(vec2f(p.z*0.35,p.y*1.4)+vec2f(17.0,0.0));let xz=terrainNoise(p.xz*0.6);let xy=terrainNoise(vec2f(p.x*0.35,p.y*1.4)+vec2f(0.0,29.0));
  rock=mix(large,w.x*zy.x+w.y*xz.x+w.z*xy.x-0.5,fade);
  grad=fade*(w.x*vec3f(0.0,zy.z*1.4,zy.y*0.35)+w.y*vec3f(xz.y*0.6,0.0,xz.z*0.6)+w.z*vec3f(xy.y*0.35,xy.z*1.4,0.0));
 }
 let grass=0.275+0.35*fine;let stoneT=${blend('steep', 'grass,0.25+0.5*rock')};
 let sandT=${blend('shore', '0.15-0.3*fine,mix(grass,0.25+0.5*rock,stoneT)')};`
     : `
 let stoneT=steep;let sandT=shore;`
 }
 let wet=${wetness ? 'terrainWet(p)' : `mix(${dark},1.0,smoothstep(${options.wetHeight.join(',')},h))`};
 s.color=mix(${rgb(options.sand)}${detail ? `*(1.0+${num(0.2 * detail)}*fine)` : ''},mix(meadow,${rgb(options.stone)}${detail ? `*(1.0+${num(0.6 * detail)}*rock)` : ''},stoneT),sandT)*wet${variation ? `*(${num(1 - variation)}+${num(2 * variation)}*(0.65*large+0.35*fine))` : ''};
 s.normal=${detail ? `normalize(n-(grad-n*dot(n,grad))*(${num(0.15 * detail)}*stoneT*sandT))` : 'n'};
 s.rough=${dark < 1 ? `0.6+${num(0.4 / (1 - dark))}*(wet-${dark})` : '1.0'};return s;
}
`;
    this.wetCode = wetness
      ? `
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
 return 1.0-${1 - options.wetDarkening}*beach*smoothstep(0.001,0.025,depth);
}
`
      : '';
  }
  static attach(engine: EngineKernel, mesh: Mesh, options: TerrainColorOptions): TerrainColors {
    const colors = new TerrainColors(mesh, options);
    engineRuntime(engine).use(colors);
    return colors;
  }
  setup(engine: Engine): void {
    const mesh = meshRuntime(this.mesh);
    mesh.check();
    if (this.engine || this.disposed || mesh.engine !== engine)
      throw new MargoError(
        'attached',
        "Terrain color mesh belongs to another engine or is already attached; attach one TerrainColors per mesh, to the mesh's engine",
      );
    this.engine = engine;
    if (this.wetness) {
      if (!engine.gpu) throw new MargoError('unsupported', 'Terrain wetness requires WebGPU; use a WebGPU engine');
      this.dry = engine.gpu.createTexture({
        size: [1, 1],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      engine.gpu.queue.writeTexture({ texture: this.dry }, new Float32Array(1), { bytesPerRow: 4 }, [1, 1]);
      this.dryEntry = { binding: 9, resource: this.dry.createView() };
    }
  }
  /** Adds the mesh-ID varying once, then this mesh's surface call inside the shared per-pixel block. */
  private patch(source: string, id: number): string {
    let code = source;
    if (!code.includes('terrainId:f32'))
      code = code
        .replace(/struct Output \{[^}]+\}/, (output) =>
          output.replace('}', `,@location(${freeLocation(output)}) @interpolate(flat) terrainId:f32 }`),
        )
        .replace('o.color=i.color.rgb;', 'o.terrainId=i.factors.w+1.0;o.color=i.color.rgb;');
    // Silent like the other optional core patches: without the standard shader the mesh keeps its material color.
    if (!code.includes('terrainId:f32') || !code.includes('o.terrainId=')) return source;
    let at = code.indexOf(block);
    if (at < 0) {
      at = code.indexOf(normalLine);
      if (at < 0) return source;
      at += normalLine.length;
      let end = at;
      for (let depth = 1; end < code.length; end++)
        if (code[end] === '{') depth++;
        else if (code[end] === '}' && --depth === 0) break;
      code = code.slice(0, at) + block + code.slice(at, end) + '}' + code.slice(end);
    }
    at += block.length;
    const suffix = '_' + id;
    const own = (this.wetCode.replace('@binding(9)', `@binding(${this.wetBinding})`) + this.surfaceCode).replace(
      /terrainSurface|terrainWater|terrainWet/g,
      (name) => name + suffix,
    );
    return (
      (code.includes('struct TerrainSurface ') ? '' : surfaceStruct) +
      (this.surfaceCode.includes('terrainNoise(') && !code.includes('fn terrainNoise(') ? noiseCode : '') +
      (this.surfaceCode.includes('terrainBlend(') && !code.includes('fn terrainBlend(') ? blendCode : '') +
      own +
      code.slice(0, at) +
      `if(i.terrainId==${id + 1}.0){let s=terrainSurface${suffix}(i.position,n);i.color=s.color;i.material.x*=s.rough;n=s.normal;}` +
      code.slice(at)
    );
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -1,
      execute: (c) => {
        if (c.backend !== 'webgpu') return;
        const mesh = meshRuntime(this.mesh);
        mesh.check();
        if (this.source !== c.shader) {
          this.source = c.shader;
          if (this.wetness) {
            this.wetBinding = 40;
            while (c.bindings.some((entry) => entry.binding === this.wetBinding)) this.wetBinding++;
          }
          this.shader = this.patch(c.shader, mesh.id);
        }
        if (this.wetness) {
          const texture = this.wetness.texture();
          if (texture !== undefined) {
            if (
              !texture ||
              texture.dimension !== '2d' ||
              texture.sampleCount !== 1 ||
              texture.depthOrArrayLayers > 1 ||
              !['r32float', 'rgba32float', 'rgba16float'].includes(texture.format) ||
              !(texture.usage & GPUTextureUsage.COPY_SRC)
            )
              throw new TypeError('Terrain wetness needs a copyable water-depth texture');
            // A stable view avoids rebuilding scene/vegetation bindings as flow ping-pongs.
            if (
              this.wet?.width !== texture.width ||
              this.wet?.height !== texture.height ||
              this.wet?.format !== texture.format
            ) {
              this.wet?.destroy();
              this.wet = c.device.createTexture({
                size: [texture.width, texture.height],
                format: texture.format,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
              });
              this.wetEntry = { binding: 9, resource: this.wet.createView() };
              this.wetTarget.texture = this.wet;
              this.wetSize.width = texture.width;
              this.wetSize.height = texture.height;
            }
            this.wetSource.texture = texture;
            c.encoder.copyTextureToTexture(this.wetSource, this.wetTarget, this.wetSize);
          }
          const entry = texture ? this.wetEntry! : this.dryEntry!;
          entry.binding = this.wetBinding;
          c.bindings.push(entry);
        }
        c.shader = this.shader;
      },
    });
  }
  onDeviceRestored(engine: Engine): void {
    this.dry?.destroy();
    this.wet?.destroy();
    this.dry = this.wet = undefined;
    this.dryEntry = this.wetEntry = undefined;
    this.wetSource.texture = this.wetTarget.texture = undefined!;
    this.engine = undefined;
    this.setup(engine);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dry?.destroy();
    this.wet?.destroy();
    this.dry = this.wet = undefined;
    this.dryEntry = this.wetEntry = undefined;
    this.wetSource.texture = this.wetTarget.texture = undefined!;
    const engine = this.engine;
    this.engine = undefined;
    engine?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
