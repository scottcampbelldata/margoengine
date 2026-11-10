// Coverage-preserving mip chains for alpha-tested (glTF MASK) base colour textures, built on the GPU in queue order so
// the first frame already samples them. Method: Castano, "Computing Alpha Mipmaps" (2010), as Margo's voxel
// `mipChain` (packages/voxel/src/textures.ts) and Scott's native engine apply it: each level is an area filter of the
// level above (every source texel weighted by its overlap, so odd edges are covered), colour averaged in linear light
// weighted by alpha (transparent texels lend no colour to leaf edges; an all-transparent block keeps its plain
// average), and the stored alpha scaled so the share of texels passing the material's cutoff stays the share of level
// 0. The scale is the nearest achievable one found by bisection on 0 to 4096 (64 candidates per round, 7 rounds), and
// the unscaled alpha and colour feed the next level, so corrections never compound.
import { generateMipmaps } from './mipmaps.js';

const ROUNDS = 7,
  KEY = 'alpha-coverage';

// In the shader: `code` is the stored byte of alpha a scaled by s, rounded half up as the CPU form of the method; `mul`
// is a 32 x 32 -> 64-bit product as (high, low), so shares compare exactly (c / n < goal / total); `count` counts each
// texel at the first candidate it passes (coverage only grows with the scale); `update` keeps the nearer end, the upper
// on a tie; `write` keeps the average alpha when level 0 holds one alpha everywhere (nothing to keep).
const shader = /* wgsl */ `
struct Params {srcW:u32,srcH:u32,dstW:u32,dstH:u32,rowWords:u32,fromTexture:u32,keep:u32,srgb:u32,total:u32,p0:u32,p1:u32,p2:u32}
struct Control {goal:atomic<u32>,low:atomic<u32>,high:atomic<u32>,p0:u32,lo:f32,hi:f32,clo:u32,chi:u32,scale:f32,p1:u32,p2:u32,p3:u32,hist:array<atomic<u32>,65>}
@group(0) @binding(0) var<uniform> p:Params;
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var<storage,read> stateIn:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> stateOut:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> ctl:Control;
@group(0) @binding(5) var<storage,read_write> bytes:array<u32>;
var<workgroup> wa:array<atomic<u32>,65>;
var<workgroup> wb:array<atomic<u32>,3>;
fn code(a:f32,s:f32)->u32 {return u32(floor(255.0*clamp(a*s,0.0,1.0)+0.5));}
fn candidate(lo:f32,hi:f32,j:u32)->f32 {return lo+(hi-lo)*(f32(j)/64.0);}
fn mul(a:u32,b:u32)->vec2u {
  let ll=(a&0xffffu)*(b&0xffffu);let lh=(a&0xffffu)*(b>>16u);let hl=(a>>16u)*(b&0xffffu);
  let mid=(ll>>16u)+(lh&0xffffu)+(hl&0xffffu);
  return vec2u((a>>16u)*(b>>16u)+(lh>>16u)+(hl>>16u)+(mid>>16u),(ll&0xffffu)|(mid<<16u));
}
fn less(a:vec2u,b:vec2u)->bool {return a.x<b.x||(a.x==b.x&&a.y<b.y);}
fn gap(a:vec2u,b:vec2u)->vec2u {
  if(less(a,b)){return vec2u(b.x-a.x-select(0u,1u,b.y<a.y),b.y-a.y);}
  return vec2u(a.x-b.x-select(0u,1u,a.y<b.y),a.y-b.y);
}
@compute @workgroup_size(8,8) fn targetCount(@builtin(global_invocation_id) g:vec3u,@builtin(local_invocation_index) l:u32) {
  if(l==0u){atomicStore(&wb[1],255u);}
  workgroupBarrier();
  if(g.x<p.srcW&&g.y<p.srcH){
    let c=u32(floor(textureLoad(source,g.xy,0).a*255.0+0.5));
    if(c>=p.keep){atomicAdd(&wb[0],1u);}
    atomicMin(&wb[1],c);atomicMax(&wb[2],c);
  }
  workgroupBarrier();
  if(l==0u){atomicAdd(&ctl.goal,atomicLoad(&wb[0]));atomicMin(&ctl.low,atomicLoad(&wb[1]));atomicMax(&ctl.high,atomicLoad(&wb[2]));}
}
@compute @workgroup_size(8,8) fn reduce(@builtin(global_invocation_id) g:vec3u) {
  if(g.x>=p.dstW||g.y>=p.dstH){return;}
  let x0=f32(g.x*p.srcW)/f32(p.dstW);let x1=f32((g.x+1u)*p.srcW)/f32(p.dstW);
  let y0=f32(g.y*p.srcH)/f32(p.dstH);let y1=f32((g.y+1u)*p.srcH)/f32(p.dstH);
  let ex=min(p.srcW,((g.x+1u)*p.srcW+p.dstW-1u)/p.dstW);let ey=min(p.srcH,((g.y+1u)*p.srcH+p.dstH-1u)/p.dstH);
  var sa=0.0;var sc=vec3f(0.0);var pc=vec3f(0.0);
  for(var y=g.y*p.srcH/p.dstH;y<ey;y++){
    let wy=min(y1,f32(y+1u))-max(y0,f32(y));
    for(var x=g.x*p.srcW/p.dstW;x<ex;x++){
      let w=(min(x1,f32(x+1u))-max(x0,f32(x)))*wy;
      var t:vec4f;
      if(p.fromTexture==1u){t=textureLoad(source,vec2u(x,y),0);}else{t=stateIn[y*p.srcW+x];}
      sa+=w*t.a;sc+=(w*t.a)*t.rgb;pc+=w*t.rgb;
    }
  }
  let area=(x1-x0)*(y1-y0);
  stateOut[g.y*p.dstW+g.x]=vec4f(select(pc/area,sc/sa,sa>0.0),sa/area);
}
@compute @workgroup_size(1) fn begin() {ctl.lo=0.0;ctl.hi=4096.0;}
@compute @workgroup_size(8,8) fn count(@builtin(global_invocation_id) g:vec3u,@builtin(local_invocation_index) l:u32) {
  let lo=ctl.lo;let hi=ctl.hi;
  if(g.x<p.dstW&&g.y<p.dstH){
    let a=stateOut[g.y*p.dstW+g.x].a;
    if(code(a,candidate(lo,hi,64u))>=p.keep){
      var b=0u;var e=64u;
      loop{if(b>=e){break;}let m=(b+e)/2u;if(code(a,candidate(lo,hi,m))>=p.keep){e=m;}else{b=m+1u;}}
      atomicAdd(&wa[e],1u);
    }
  }
  workgroupBarrier();
  let v=atomicLoad(&wa[l]);if(v>0u){atomicAdd(&ctl.hist[l],v);}
  if(l==0u){let u=atomicLoad(&wa[64]);if(u>0u){atomicAdd(&ctl.hist[64],u);}}
}
@compute @workgroup_size(1) fn update() {
  let t=mul(atomicLoad(&ctl.goal),p.dstW*p.dstH);
  var c:array<u32,65>;var run=0u;
  for(var j=0u;j<65u;j++){run+=atomicLoad(&ctl.hist[j]);c[j]=run;atomicStore(&ctl.hist[j],0u);}
  var j=0u;
  loop{if(j>64u){break;}if(!less(mul(c[j],p.total),t)){break;}j++;}
  let lo=ctl.lo;let hi=ctl.hi;
  if(j==0u){ctl.hi=lo;ctl.clo=c[0];ctl.chi=c[0];}
  else if(j>64u){ctl.lo=hi;ctl.clo=c[64];ctl.chi=c[64];}
  else{ctl.lo=candidate(lo,hi,j-1u);ctl.hi=candidate(lo,hi,j);ctl.clo=c[j-1u];ctl.chi=c[j];}
  ctl.scale=select(ctl.hi,ctl.lo,less(gap(mul(ctl.clo,p.total),t),gap(mul(ctl.chi,p.total),t)));
}
@compute @workgroup_size(8,8) fn write(@builtin(global_invocation_id) g:vec3u) {
  if(g.x>=p.dstW||g.y>=p.dstH){return;}
  let t=stateOut[g.y*p.dstW+g.x];
  let s=select(ctl.scale,1.0,atomicLoad(&ctl.low)==atomicLoad(&ctl.high));
  var c=clamp(t.rgb,vec3f(0.0),vec3f(1.0));
  if(p.srgb==1u){c=select(1.055*pow(c,vec3f(1.0/2.4))-0.055,c*12.92,c<=vec3f(0.0031308));}
  let b=vec3u(floor(c*255.0+0.5));
  bytes[g.y*p.rowWords+g.x]=b.x|(b.y<<8u)|(b.z<<16u)|(code(t.a,s)<<24u);
}
`;

/**
 * The smallest stored alpha byte a shader keeps as `byte / 255 * factor >= cutoff` (float32), or 0 when the test
 * keeps every byte (cutoff 0 or below) or none, so no coverage needs keeping.
 */
export function maskKeepByte(cutoff, factor) {
  const f = Math.fround;
  if (!(f(0) * f(factor) < f(cutoff))) return 0;
  for (let b = 1; b < 256; b++) if (f(f(b / 255) * f(factor)) >= f(cutoff)) return b;
  return 0;
}

function pipelines(device, cache) {
  let made = cache.get(KEY);
  if (made) return made;
  const storage = (type) => ({ visibility: 4, buffer: { type } }),
    layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
        { binding: 1, visibility: 4, texture: { sampleType: 'float' } },
        { binding: 2, ...storage('read-only-storage') },
        { binding: 3, ...storage('storage') },
        { binding: 4, ...storage('storage') },
        { binding: 5, ...storage('storage') },
      ],
    }),
    module = device.createShaderModule({ code: shader }),
    pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    make = (entryPoint) =>
      device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
  made = { layout };
  for (const name of ['targetCount', 'reduce', 'begin', 'count', 'update', 'write']) made[name] = make(name);
  cache.set(KEY, made);
  return made;
}

/**
 * Fills mip levels 1 to `levels - 1` of a 2D `rgba8unorm` or `rgba8unorm-srgb` texture from level 0 so that an alpha
 * test `alpha * factor >= cutoff` keeps the same share of texels at every level as at level 0 (the nearest share a
 * level's texels allow), with alpha-weighted linear colour. Where the test cannot drop coverage (cutoff 0, or a cutoff
 * above `factor`), for another format, or when level 1's float state would not fit one storage buffer, it fills the
 * levels as `generateMipmaps` does. `cache` keeps the pipelines per device, as for `generateMipmaps`. The texture
 * needs TEXTURE_BINDING, COPY_DST and RENDER_ATTACHMENT usage.
 */
export function generateMaskMipmaps(device, texture, levels, cache, cutoff, factor, sampler) {
  if (levels < 2) return;
  const keep = maskKeepByte(cutoff, factor),
    { format, width, height } = texture,
    w1 = Math.max(1, width >> 1),
    h1 = Math.max(1, height >> 1),
    stateBytes = w1 * h1 * 16;
  if (
    !keep ||
    (format !== 'rgba8unorm' && format !== 'rgba8unorm-srgb') ||
    stateBytes > device.limits.maxStorageBufferBindingSize ||
    stateBytes > device.limits.maxBufferSize
  )
    return generateMipmaps(device, texture, levels, cache, sampler);
  const made = pipelines(device, cache),
    dims = [[width, height]];
  for (let k = 1; k < levels; k++) dims.push(dims[k - 1].map((n) => Math.max(1, n >> 1)));
  const rowWords = (w) => Math.ceil((w * 4) / 256) * 64;
  let outBytes = 4,
    evenBytes = 16;
  for (let k = 1; k < levels; k++) {
    outBytes = Math.max(outBytes, rowWords(dims[k][0]) * 4 * dims[k][1]);
    if (k % 2 === 0) evenBytes = Math.max(evenBytes, dims[k][0] * dims[k][1] * 16);
  }
  const buffer = (size, usage) => device.createBuffer({ size, usage }),
    params = buffer(256 * levels, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
    states = [buffer(evenBytes, GPUBufferUsage.STORAGE), buffer(stateBytes, GPUBufferUsage.STORAGE)],
    control = buffer(48 + 65 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
    out = buffer(outBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
    values = new Uint32Array(64 * levels),
    srgb = format.endsWith('-srgb') ? 1 : 0;
  for (let k = 0; k < levels; k++) {
    const [srcW, srcH] = dims[Math.max(0, k - 1)],
      [dstW, dstH] = dims[k];
    values.set([srcW, srcH, dstW, dstH, rowWords(dstW), k === 1 ? 1 : 0, keep, srgb, width * height], k * 64);
  }
  device.queue.writeBuffer(params, 0, values);
  // Slot 0 counts level 0 against itself; `low` starts at the top byte for atomicMin.
  device.queue.writeBuffer(control, 0, new Uint32Array([0, 255, 0]));
  const view = texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
    group = (k) =>
      device.createBindGroup({
        layout: made.layout,
        entries: [
          { binding: 0, resource: { buffer: params, offset: k * 256, size: 48 } },
          { binding: 1, resource: view },
          { binding: 2, resource: { buffer: states[(k + 1) % 2] } },
          { binding: 3, resource: { buffer: states[k % 2] } },
          { binding: 4, resource: { buffer: control } },
          { binding: 5, resource: { buffer: out } },
        ],
      }),
    groups = (n) => [Math.ceil(n[0] / 8), Math.ceil(n[1] / 8)];
  const encoder = device.createCommandEncoder();
  let pass = encoder.beginComputePass();
  pass.setBindGroup(0, group(0));
  pass.setPipeline(made.targetCount);
  pass.dispatchWorkgroups(...groups(dims[0]));
  pass.end();
  for (let k = 1; k < levels; k++) {
    pass = encoder.beginComputePass();
    pass.setBindGroup(0, group(k));
    pass.setPipeline(made.reduce);
    pass.dispatchWorkgroups(...groups(dims[k]));
    pass.setPipeline(made.begin);
    pass.dispatchWorkgroups(1);
    for (let r = 0; r < ROUNDS; r++) {
      pass.setPipeline(made.count);
      pass.dispatchWorkgroups(...groups(dims[k]));
      pass.setPipeline(made.update);
      pass.dispatchWorkgroups(1);
    }
    pass.setPipeline(made.write);
    pass.dispatchWorkgroups(...groups(dims[k]));
    pass.end();
    encoder.copyBufferToTexture(
      { buffer: out, bytesPerRow: rowWords(dims[k][0]) * 4 },
      { texture, mipLevel: k },
      dims[k],
    );
  }
  device.queue.submit([encoder.finish()]);
  for (const b of [params, ...states, control, out]) b.destroy();
}
