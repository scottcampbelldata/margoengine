// Narrow band for ParticleLiquid after F. Oliveira, A. Paiva, Narrow-Band Screen-Space Fluid Rendering, Computer
// Graphics Forum 41(6) 2022, https://doi.org/10.1111/cgf.14510 (Algorithm 1, the Layered Neighborhood Method, and the
// volume restoration of section 4.2): particles go into a voxel grid of size 2h; full voxels with an empty neighbour
// (26-adjacency) or on the grid border are layer 1; a full voxel next to a layer-1 voxel holding at most n_min = 8
// particles is layer 2; only particles of layers 1 and 2 are drawn into the depth buffer. The thickness is restored
// from the full voxels: each splats a sphere holding its particles' volume at their centroid. All render passes.
import { fault } from '../../shared/errors.js';
import { liquidBlock as block, spriteShader } from './liquid-shaders.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; MAP_READ: number };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_SRC: number };
declare const GPUMapMode: { READ: number };

/** Band parameters: atlas side A, fluid side P, count N, source size; voxel 2h, radius, n_min. */
const params = `
struct Band {a:vec4u,f:vec4f}
`;
// The grid: origin and voxel size, then dims and slices per atlas row (floats), from the 1x1 grid pass.
const grid = (first: number) => `
@group(0) @binding(${first}) var gridPlace:texture_2d<f32>;
@group(0) @binding(${first + 1}) var gridShape:texture_2d<f32>;
fn place()->vec4f {return textureLoad(gridPlace,vec2i(0),0);}
fn shape()->vec4u {return vec4u(textureLoad(gridShape,vec2i(0),0));}
fn voxelOf(p:vec3f)->vec3i {let g=place();return vec3i(floor((p-g.xyz)/g.w));}
fn inside(v:vec3i,s:vec4u)->bool {return all(v>=vec3i(0))&&all(vec3u(v)<s.xyz);}
fn texelOf(v:vec3i,s:vec4u)->vec2i {
 let q=vec3u(v);return vec2i(i32(q.x+s.x*(q.z%s.w)),i32(q.y+s.y*(q.z/s.w)));
}
// The voxel an atlas texel holds, or -1 outside the grid.
fn voxelAt(t:vec2u,s:vec4u)->vec3i {
 if(s.x==0u||s.w==0u){return vec3i(-1);}
 let col=t.x/s.x;let z=(t.y/s.y)*s.w+col;
 if(col>=s.w||z>=s.z){return vec3i(-1);}
 return vec3i(vec3u(t.x%s.x,t.y%s.y,z));
}
`;
const screen = `
struct Screen {@builtin(position) position:vec4f}
@vertex fn vertex(@builtin(vertex_index) index:u32)->Screen {
 return Screen(vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index],0,1));
}
struct Range {@location(0) low:vec4f,@location(1) high:vec4f}
`;

/** Bounds, first level: each texel takes the min and max of four particles. */
export const boundsShader = `${block}${params}
@group(0) @binding(1) var<storage,read> points:array<f32>;
@group(0) @binding(2) var<uniform> b:Band;
${screen}
@fragment fn fragment(@builtin(position) at:vec4f)->Range {
 let t=vec2u(at.xy)*2u;var lo=vec3f(3.0e38);var hi=vec3f(-3.0e38);
 for(var n=0u;n<4u;n++){
  let q=t+vec2u(n&1u,n>>1u);let i=q.y*b.a.y+q.x;
  if(q.x>=b.a.y||i>=b.a.z){continue;}
  let o=u32(u.particles.y)+i*u32(u.particles.x);let p=vec3f(points[o],points[o+1u],points[o+2u]);
  if(abs(p.x)+abs(p.y)+abs(p.z)<3.0e38){lo=min(lo,p);hi=max(hi,p);}
 }
 return Range(vec4f(lo,0),vec4f(hi,0));
}
`;
/** Bounds, later levels: 2 x 2 of the previous level (size b.a.w). */
export const reduceShader = `${params}
@group(0) @binding(0) var<uniform> b:Band;
@group(0) @binding(1) var lows:texture_2d<f32>;
@group(0) @binding(2) var highs:texture_2d<f32>;
${screen}
@fragment fn fragment(@builtin(position) at:vec4f)->Range {
 let t=vec2u(at.xy)*2u;var lo=vec3f(3.0e38);var hi=vec3f(-3.0e38);
 for(var n=0u;n<4u;n++){
  let q=t+vec2u(n&1u,n>>1u);if(any(q>=vec2u(b.a.w))){continue;}
  lo=min(lo,textureLoad(lows,vec2i(q),0).xyz);hi=max(hi,textureLoad(highs,vec2i(q),0).xyz);
 }
 return Range(vec4f(lo,0),vec4f(hi,0));
}
`;
/**
 * The grid: voxel 2h, coarsened by 1.25 until the bounds fit the A x A atlas. It starts 0.75 voxel below the lowest
 * particle, so a lattice of spacing v / 2 or v / 3 never lies on a voxel face.
 */
export const gridShader = `${params}
@group(0) @binding(0) var<uniform> b:Band;
@group(0) @binding(1) var lows:texture_2d<f32>;
@group(0) @binding(2) var highs:texture_2d<f32>;
${screen}
@fragment fn fragment()->Range {
 let lo=textureLoad(lows,vec2i(0),0).xyz;let hi=textureLoad(highs,vec2i(0),0).xyz;
 if(any(lo>hi)){return Range(vec4f(0,0,0,1),vec4f(0));}
 let a=f32(b.a.x);var v=b.f.x;var d=vec3f(0);var row=0.0;
 for(var n=0;n<64;n++){
  d=floor((hi-lo)/v)+2.0;row=floor(a/d.x);
  if(d.x<=a&&row>=1.0&&ceil(d.z/row)*d.y<=a){break;}
  v*=1.25;
 }
 return Range(vec4f(lo-vec3f(0.75*v),v),vec4f(d,row));
}
`;
/** Counts and centroids: one point per particle, additive (sum of in-voxel offsets, count). */
export const countShader = `${block}${params}
@group(0) @binding(1) var<storage,read> points:array<f32>;
@group(0) @binding(2) var<uniform> b:Band;
${grid(3)}
struct Point {@builtin(position) clip:vec4f,@location(0) offset:vec3f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Point {
 var o:Point;o.clip=vec4f(2,2,2,1);o.offset=vec3f(0);
 let k=u32(u.particles.y)+i*u32(u.particles.x);let p=vec3f(points[k],points[k+1u],points[k+2u]);
 let s=shape();let v=voxelOf(p);if(!(abs(p.x)+abs(p.y)+abs(p.z)<3.0e38)||!inside(v,s)){return o;}
 let t=vec2f(texelOf(v,s))+0.5;let a=f32(b.a.x);let g=place();
 o.offset=(p-g.xyz)/g.w-vec3f(v);o.clip=vec4f(t.x/a*2.0-1.0,1.0-t.y/a*2.0,0.5,1);return o;
}
@fragment fn fragment(i:Point)->@location(0) vec4f {return vec4f(i.offset,1);}
`;
/** Algorithm 1, layer 1 (`second` false) or layer 2 (`second` true, reading layer 1). */
export const labelShader = (second: boolean) => `${params}
@group(0) @binding(0) var<uniform> b:Band;
@group(0) @binding(1) var counts:texture_2d<f32>;
${grid(2)}
${second ? '@group(0) @binding(4) var first:texture_2d<u32>;' : ''}
${screen}
fn occupancy(v:vec3i,s:vec4u)->f32 {return floor(textureLoad(counts,texelOf(v,s),0).w+0.5);}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4u {
 let s=shape();let v=voxelAt(vec2u(at.xy),s);if(v.x<0||occupancy(v,s)<1.0){return vec4u(0);}
 ${
   second
     ? `if(textureLoad(first,vec2i(at.xy),0).x==1u){return vec4u(1);}
 for(var n=0;n<27;n++){
  let w=v+vec3i(n%3-1,(n/3)%3-1,n/9-1);if(n==13||!inside(w,s)){continue;}
  if(textureLoad(first,texelOf(w,s),0).x==1u&&occupancy(w,s)<=b.f.z){return vec4u(2);}
 }
 return vec4u(0);`
     : `for(var n=0;n<27;n++){
  let w=v+vec3i(n%3-1,(n/3)%3-1,n/9-1);if(n==13){continue;}
  if(!inside(w,s)||occupancy(w,s)<1.0){return vec4u(1);}
 }
 return vec4u(0);`
 }
}
`;

const anchor = 'var out:Sprite;out.center=c;out.world=c;out.clip=vec4f(2,2,2,1);';
/** The liquid's depth sprites, with particles outside the band culled in the vertex stage. */
export const bandSpriteShader = (() => {
  if (!spriteShader.includes(anchor)) throw fault('state', 'ParticleLiquid narrow band: the sprite shader lost its anchor; update the anchor in liquid-band.ts to match');
  return `${spriteShader.replace(anchor, `${anchor}if(!banded(c)){return out;}`)}${params}
${grid(3)}
@group(0) @binding(5) var labels:texture_2d<u32>;
fn banded(c:vec3f)->bool {let s=shape();let v=voxelOf(c);return inside(v,s)&&textureLoad(labels,texelOf(v,s),0).x!=0u;}
`;
})();

/** Volume restoration: a sphere of the voxel's particle volume, radius r cbrt(n), at its centroid, chord added. */
export const voxelShader = `${block}${params}
@group(0) @binding(1) var counts:texture_2d<f32>;
@group(0) @binding(2) var<uniform> b:Band;
${grid(3)}
@group(0) @binding(5) var scene:texture_depth_2d;
struct Ball {@builtin(position) clip:vec4f,@location(0) world:vec3f,@location(1) @interpolate(flat) center:vec4f}
@vertex fn vertex(@builtin(vertex_index) k:u32,@builtin(instance_index) i:u32)->Ball {
 var o:Ball;o.clip=vec4f(2,2,2,1);o.world=vec3f(0);o.center=vec4f(0);
 let s=shape();let t=vec2u(i%b.a.x,i/b.a.x);let v=voxelAt(t,s);if(v.x<0){return o;}
 let sum=textureLoad(counts,vec2i(t),0);let n=floor(sum.w+0.5);if(n<1.0){return o;}
 let g=place();let c=g.xyz+(vec3f(v)+sum.xyz/n)*g.w;let r=b.f.y*pow(n,1.0/3.0);
 let to=c-u.eye.xyz;let d=length(to);if(!(d>r*1.0001)){return o;}
 let m=to/d;let a=select(vec3f(0,1,0),vec3f(1,0,0),abs(m.y)>0.9);let x=normalize(cross(a,m));let y=cross(m,x);
 let size=r*d/sqrt(d*d-r*r);
 let q=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1))[k];
 let w=c+(x*q.x+y*q.y)*size;o.world=w;o.center=vec4f(c,r);o.clip=u.viewProj*vec4f(w,1);return o;
}
@fragment fn fragment(i:Ball)->@location(0) vec4f {
 let dir=normalize(i.world-u.eye.xyz);let oc=i.center.xyz-u.eye.xyz;let along=dot(oc,dir);let m=oc-dir*along;
 let h=i.center.w*i.center.w-dot(m,m);if(h<0.0){discard;}let e=sqrt(h);
 let full=vec4f(i.clip.xy/u.zenith.w,i.clip.zw);let z=textureLoad(scene,vec2i(full.xy),0);
 var far=along+e;if(z>0.0){far=min(far,dot(unproject(ndc(full.xy),z)-u.eye.xyz,dir));}
 let near=max(along-e,0.0);if(along+e<0.0||far<=near){discard;}
 return vec4f((far-near)*u.particles.w,0,0,1);
}
`;

/** The band a ParticleLiquid owns: grid, counts and labels, rebuilt on update(). */
export class NarrowBand {
  private uniform: GPUBuffer;
  private steps: GPUBuffer[] = [];
  private readonly ints = new Uint32Array(8);
  private readonly floats = new Float32Array(this.ints.buffer);
  private readonly pipelines: Record<string, GPURenderPipeline>;
  /** low 0, high 0, low 1, high 1, grid place, grid shape, counts, first layer, labels. */
  private textures: GPUTexture[] = [];
  private groups: Record<string, GPUBindGroup[]> = {};
  private bound: unknown[] = [];
  private side = 0;
  /** Atlas side: A x A voxels at most. */
  atlas = 0;
  passes = 0;
  groupsMade = 0;
  bytes = 0;

  constructor(
    private readonly device: GPUDevice,
    depthPipeline: (code: string) => GPURenderPipeline,
    thicknessPipeline: (code: string) => GPURenderPipeline,
  ) {
    this.uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const add = { srcFactor: 'one', dstFactor: 'one', operation: 'add' } as const;
    const make = (code: string, formats: GPUTextureFormat[], points = false) => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: formats.map((format) => (points ? { format, blend: { color: add, alpha: add } } : { format })),
        },
        primitive: { topology: points ? 'point-list' : 'triangle-list' },
      });
    };
    const pair: GPUTextureFormat[] = ['rgba32float', 'rgba32float'];
    this.pipelines = {
      bounds: make(boundsShader, pair),
      reduce: make(reduceShader, pair),
      grid: make(gridShader, pair),
      count: make(countShader, ['rgba16float'], true),
      first: make(labelShader(false), ['r32uint']),
      second: make(labelShader(true), ['r32uint']),
      depth: depthPipeline(bandSpriteShader),
      thickness: thicknessPipeline(voxelShader),
    };
  }

  private allocate(count: number): void {
    const side = 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count))))));
    if (side === this.side) return;
    for (const t of this.textures) t.destroy();
    for (const s of this.steps) s.destroy();
    const d = this.device,
      usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    const make = (format: GPUTextureFormat, w: number) => d.createTexture({ size: [w, w], format, usage });
    const half = Math.max(1, side / 2),
      atlas = Math.max(64, side);
    this.textures = [
      make('rgba32float', half),
      make('rgba32float', half),
      make('rgba32float', half),
      make('rgba32float', half),
      make('rgba32float', 1),
      make('rgba32float', 1),
      make('rgba16float', atlas),
      make('r32uint', atlas),
      make('r32uint', atlas),
    ];
    // One reduce step per halving of the first level, each with the size it reads.
    this.steps = [];
    this.stepSizes = [];
    for (let s = half; s > 1; s = Math.ceil(s / 2)) {
      const b = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.steps.push(b);
      this.stepSizes.push(s);
    }
    this.side = side;
    this.atlas = atlas;
    this.bound = [];
  }
  private stepSizes: number[] = [];

  /** Records the band passes when `due`; afterwards the depth and thickness draws below use the result. */
  record(
    c: { device: GPUDevice; encoder: GPUCommandEncoder },
    count: number,
    voxel: number,
    radius: number,
    main: GPUBuffer,
    positions: GPUBuffer,
    sceneDepth: GPUTexture,
    due: boolean,
  ): void {
    this.passes = this.groupsMade = this.bytes = 0;
    this.allocate(count);
    const i = this.ints,
      f = this.floats;
    i.set([this.atlas, this.side, count, 0], 0);
    f.set([voxel, radius, 8, 0], 4);
    if (due) {
      const q = this.device.queue;
      q.writeBuffer(this.uniform, 0, i);
      this.bytes += 32;
      this.steps.forEach((s, n) => {
        i[3] = this.stepSizes[n]!;
        q.writeBuffer(s, 0, i);
        this.bytes += 32;
      });
    }
    const key = [main, positions, sceneDepth, this.textures[0]];
    if (key.some((k, n) => k !== this.bound[n])) {
      this.bound = key;
      this.build(main, positions, sceneDepth);
    }
    if (!due || count === 0) return;
    const t = this.textures,
      g = this.groups;
    const run = (pipeline: GPURenderPipeline, group: GPUBindGroup, targets: GPUTexture[], size: number, points = 0) => {
      const pass = c.encoder.beginRenderPass({
        colorAttachments: targets.map((texture) => ({
          view: texture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        })),
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.setViewport(0, 0, size, size, 0, 1);
      pass.setScissorRect(0, 0, size, size);
      pass.draw(points || 3);
      pass.end();
      this.passes++;
    };
    const half = Math.max(1, this.side / 2);
    run(this.pipelines.bounds!, g.bounds![0]!, [t[0]!, t[1]!], half);
    let from = 0;
    this.stepSizes.forEach((s, n) => {
      const next = Math.ceil(s / 2);
      run(this.pipelines.reduce!, g.reduce![2 * n + from]!, [t[2 - 2 * from]!, t[3 - 2 * from]!], next);
      from = 1 - from;
    });
    run(this.pipelines.grid!, g.grid![from]!, [t[4]!, t[5]!], 1);
    run(this.pipelines.count!, g.count![0]!, [t[6]!], this.atlas, count);
    run(this.pipelines.first!, g.first![0]!, [t[7]!], this.atlas);
    run(this.pipelines.second!, g.second![0]!, [t[8]!], this.atlas);
  }

  private build(main: GPUBuffer, positions: GPUBuffer, sceneDepth: GPUTexture): void {
    const d = this.device,
      p = this.pipelines,
      t = this.textures,
      view = (n: number) => t[n]!.createView();
    const bind = (pipeline: GPURenderPipeline, entries: Record<number, GPUBindingResource>) => {
      this.groupsMade++;
      return d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: Object.entries(entries).map(([binding, resource]) => ({ binding: +binding, resource })),
      });
    };
    const m = { buffer: main },
      u = { buffer: this.uniform },
      points = { buffer: positions },
      depth = sceneDepth.createView({ aspect: 'depth-only' });
    this.groups = {
      bounds: [bind(p.bounds!, { 0: m, 1: points, 2: u })],
      // Step n reads pair `from` (0 or 1): groups 2n (from 0) and 2n + 1 (from 1).
      reduce: this.steps.flatMap((s) =>
        [0, 1].map((from) => bind(p.reduce!, { 0: { buffer: s }, 1: view(2 * from), 2: view(2 * from + 1) })),
      ),
      grid: [0, 1].map((from) => bind(p.grid!, { 0: u, 1: view(2 * from), 2: view(2 * from + 1) })),
      count: [bind(p.count!, { 0: m, 1: points, 2: u, 3: view(4), 4: view(5) })],
      // Auto layouts keep only the bindings a shader uses: layer 1 reads no uniform and neither layer reads the origin.
      first: [bind(p.first!, { 1: view(6), 3: view(5) })],
      second: [bind(p.second!, { 0: u, 1: view(6), 3: view(5), 4: view(7) })],
      depth: [bind(p.depth!, { 0: m, 1: points, 2: depth, 3: view(4), 4: view(5), 5: view(8) })],
      thickness: [bind(p.thickness!, { 0: m, 1: view(6), 2: u, 3: view(4), 4: view(5), 5: depth })],
    };
  }

  /** Draws the band's depth sprites into an open pass. */
  drawDepth(pass: GPURenderPassEncoder, count: number): void {
    pass.setPipeline(this.pipelines.depth!);
    pass.setBindGroup(0, this.groups.depth![0]!);
    pass.draw(6, count);
  }

  /** Draws the voxel thickness into an open pass. */
  drawThickness(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipelines.thickness!);
    pass.setBindGroup(0, this.groups.thickness![0]!);
    pass.draw(6, this.atlas * this.atlas);
  }

  /** The band's grid and particle counts, read back. */
  async read(signal?: AbortSignal) {
    const d = this.device,
      a = this.atlas;
    const items = [
      { texture: this.textures[4]!, w: 1, bytes: 16 },
      { texture: this.textures[5]!, w: 1, bytes: 16 },
      { texture: this.textures[6]!, w: a, bytes: 8 },
      { texture: this.textures[8]!, w: a, bytes: 4 },
    ].map((x) => {
      const row = Math.ceil((x.w * x.bytes) / 256) * 256;
      return {
        ...x,
        row,
        buffer: d.createBuffer({ size: row * x.w, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      };
    });
    const encoder = d.createCommandEncoder();
    for (const x of items)
      encoder.copyTextureToBuffer({ texture: x.texture }, { buffer: x.buffer, bytesPerRow: x.row }, [x.w, x.w]);
    d.queue.submit([encoder.finish()]);
    try {
      await Promise.all(items.map((x) => x.buffer.mapAsync(GPUMapMode.READ)));
      signal?.throwIfAborted();
      const place = [...new Float32Array(items[0]!.buffer.getMappedRange(), 0, 4)];
      const shape = [...new Float32Array(items[1]!.buffer.getMappedRange(), 0, 4)];
      const half = new Uint16Array(items[2]!.buffer.getMappedRange());
      const label = new Uint32Array(items[3]!.buffer.getMappedRange());
      const out = {
        origin: place.slice(0, 3),
        voxel: place[3]!,
        dims: shape.slice(0, 3),
        perRow: shape[3]!,
        voxels: 0,
        layer1: 0,
        layer2: 0,
        particles: 0,
        band: 0,
      };
      for (let y = 0; y < a; y++)
        for (let x = 0; x < a; x++) {
          const n = Math.round(f16(half[y * (items[2]!.row / 2) + x * 4 + 3]!));
          if (!n) continue;
          const l = label[y * (items[3]!.row / 4) + x]!;
          out.voxels++;
          out.particles += n;
          if (l) out.band += n;
          if (l === 1) out.layer1++;
          if (l === 2) out.layer2++;
        }
      return out;
    } finally {
      for (const x of items) x.buffer.destroy();
    }
  }

  destroy(): void {
    for (const t of this.textures) t.destroy();
    for (const b of [...this.steps, this.uniform]) b.destroy();
    this.textures = [];
    this.bound = [];
  }
}

/** IEEE half to number. */
const f16 = (h: number) => {
  const e = (h >> 10) & 31,
    m = h & 1023;
  return (e ? (1 + m / 1024) * 2 ** (e - 15) : (m / 1024) * 2 ** -14) * (h >> 15 ? -1 : 1);
};
