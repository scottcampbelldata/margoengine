import { group, compute, dispatch } from '../../shared/gpu.js';
import { margoError } from '../../shared/errors.js';
import { head, mid } from './atmosphere.js';
import type { SkyFeatures, SkyTables } from './base.js';
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
// Rayleigh phase 3/(16 pi)(1 + nu^2) and Cornette-Shanks Mie phase with g = 0.8: Bruneton & Neyret 2008 eq. 2-3;
// Hillaire 2020 sec. 3. The coarse 8 x 16 x 32 x 8 table (tail) is Margo's variant of Bruneton & Neyret 2008 sec. 4.
const phase = `fn phaseR(nu:f32)->f32{return 0.0596831037*(1.0+nu*nu);}
fn phaseM(nu:f32)->f32 {let g=0.8;return 0.1193662073*(1.0-g*g)*(1.0+nu*nu)/((2.0+g*g)*pow(max(0.01,1.0+g*g-2.0*g*nu),1.5));}
`;
const tail = `fn coordinates(pixel:vec2u)->vec4f {let nu=f32(pixel.x%8u)/7.0*2.0-1.0;let mus=f32(pixel.x/8u)/15.0*2.0-1.0;let v=f32(pixel.y%32u)/31.0*2.0-1.0;return vec4f(R+100.0*pow(f32(pixel.y/32u)/7.0,2.0)+0.001,v*abs(v),mus,nu);}
fn lookup(t:texture_2d<f32>,r:f32,mu:f32,mus:f32,nu:f32)->vec3f {
 let p=clamp(vec4f((nu+1.0)*3.5,(mus+1.0)*7.5,(sign(mu)*sqrt(abs(mu))+1.0)*15.5,sqrt(clamp((r-R)/100.0,0.0,1.0))*7.0),vec4f(0),vec4f(7,15,31,7));
 let low=vec4i(floor(p));let f=fract(p);var result=vec3f(0);
 for(var i=0u;i<16u;i++){let bits=vec4i(vec4u(i&1u,(i>>1u)&1u,(i>>2u)&1u,(i>>3u)&1u));let q=min(low+bits,vec4i(7,15,31,7));let weight=select(vec4f(1)-f,f,bits==vec4i(1));result+=textureLoad(t,vec2i(q.y*8+q.x,q.w*32+q.z),0).rgb*weight.x*weight.y*weight.z*weight.w;}return result;
}
fn directions(c:vec4f)->mat2x3f{
 let w=vec3f(sqrt(max(0.0,1.0-c.y*c.y)),c.y,0);let sx=clamp((c.w-c.y*c.z)/max(w.x,0.00001),-sqrt(max(0.0,1.0-c.z*c.z)),sqrt(max(0.0,1.0-c.z*c.z)));
 return mat2x3f(w,vec3f(sx,c.z,sqrt(max(0.0,1.0-c.z*c.z-sx*sx))));
}`;
const atmosphere = head + phase + mid + tail;
// Single scattering is kept without its phase functions, Rayleigh and Mie apart, in rows 256 and 512 of the table the
// sky reads, and the phases are applied where it is read: Bruneton & Neyret 2008 sec. 4 store single Mie scattering
// apart for this reason, Elek 2009 keeps the phase functions out of its tables as well, and Hillaire 2020 applies the
// phase per sample when it marches its sky-view table. With the phase baked in, 8 samples of nu cannot hold the Mie
// peak (at g 0.8 it falls about 30 times between nu 1 and 0.714), so the blend drew the glow round the sun as a ramp
// ending in an edge 44 degrees out (KB-SKY-NU-EDGE1). Without it the stored values change slowly with nu and the
// blend between samples is smooth.
// `lookupRow` is `lookup` reading a block of rows further down; `singleIn` is the single scattering seen along a
// direction whose cosine to the sun is nu.
const read = tail.slice(tail.indexOf('fn lookup('), tail.indexOf('fn directions('));
const singleRead =
  read
    .replace('fn lookup(t:texture_2d<f32>,', 'fn lookupRow(t:texture_2d<f32>,row:i32,')
    .replace('q.w*32+q.z', 'row+q.w*32+q.z') +
  `fn singleIn(t:texture_2d<f32>,r:f32,mu:f32,mus:f32,nu:f32)->vec3f {return lookupRow(t,256,r,mu,mus,nu)*phaseR(nu)+lookupRow(t,512,r,mu,mus,nu)*phaseM(nu);}
`;
/** The table pass `code` reading single scattering through `singleIn` where it read `from` through `lookup`. */
function firstOrder(code: string, from: string): string {
  const body = code.slice(atmosphere.length);
  if (!code.startsWith(atmosphere) || !body.includes(from))
    throw margoError('state', `Sky bruneton: a table pass no longer contains ${from}; update firstOrder to match it`);
  return atmosphere + singleRead + body.replace(from, from.replace('lookup(', 'singleIn('));
}
// Single scattering (32 steps), then three more orders: Bruneton & Neyret 2008 sec. 4. The factor 20.0 on the single
// scattering is a Margo exposure scale (sky brightness in sky units), not from Bruneton & Neyret. It writes Rayleigh and
// Mie without their phases to rows 256 and 512 of the output, and clears the running total of the higher orders.
const single =
  atmosphere +
  `
@group(0) @binding(1) var transmission:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var total:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];
 let step=boundary(c.x,c.y)/32.0;var throughput=vec3f(1);var rayleigh=vec3f(0);var haze=vec3f(0);
 for(var i=0u;i<32u;i++){let p=vec3f(0,c.x,0)+w*((f32(i)+0.5)*step);let r=length(p);let rho=densities(r);let absorb=exp(-extinction(r)*step);
  let light=throughput*sqrt(absorb)*trans(transmission,r,dot(p/r,sun))*step*20.0;rayleigh+=light*BETA_R*rho.x;haze+=light*vec3f(mie()*rho.y);throughput*=absorb;
 }let q=vec2i(id.xy);textureStore(output,q+vec2i(0,256),vec4f(rayleigh,1));textureStore(output,q+vec2i(0,512),vec4f(haze,1));textureStore(total,q,vec4f(0,0,0,1));
}`;
// Scattering density over a 32-point golden-angle (Vogel / Fibonacci) sphere, 2.39996323 rad per point.
const density =
  atmosphere +
  `
@group(0) @binding(1) var previous:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];let rho=densities(c.x);var result=vec3f(0);
 for(var i=0u;i<32u;i++){let y=1.0-2.0*(f32(i)+0.5)/32.0;let angle=f32(i)*2.39996323;let radial=sqrt(1.0-y*y);let direction=vec3f(cos(angle)*radial,y,sin(angle)*radial);let nu=dot(w,direction);
  result+=lookup(previous,c.x,y,c.z,dot(direction,sun))*(BETA_R*rho.x*phaseR(nu)+vec3f(mie()*rho.y*phaseM(nu)))*(12.5663706/32.0);
 }textureStore(output,vec2i(id.xy),vec4f(result,1));
}`;
// What the density passes read the order before through.
const densityRead = 'lookup(previous,c.x,y,c.z,dot(direction,sun))';
const multiple =
  atmosphere +
  `
@group(0) @binding(1) var input:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];let step=boundary(c.x,c.y)/32.0;var result=vec3f(0);var throughput=vec3f(1);
 for(var i=0u;i<32u;i++){let p=vec3f(0,c.x,0)+w*((f32(i)+0.5)*step);let r=length(p);let absorb=exp(-extinction(r)*step);
  result+=throughput*sqrt(absorb)*lookup(input,r,dot(p/r,w),dot(p/r,sun),dot(w,sun))*step;throughput*=absorb;
 }textureStore(output,vec2i(id.xy),vec4f(result,1));
}`;
// Ground albedo feedback (Bruneton & Neyret 2008: sec. 2, the light R[L] the ground reflects from its irradiance E;
// sec. 4, per order): the ground is Lambertian, so the radiance it sends up is albedo / pi times the irradiance on
// it. That irradiance, a 64 x 1
// table over the sun's elevation cosine at the ground, is the direct sun (20 sky units, the single scattering's
// scale, times its transmittance and cosine) for the first bounce, then the sky of the order before, gathered over
// the upper hemisphere with a cosine weight (32 golden-angle points of equal solid angle). The scattering density then
// adds, for each of its directions that ends on the ground, that radiance times the transmittance to it: the ratio
// T(ground, up) / T(eye, up) of two top-of-atmosphere transmittances along the same line. As in the paper, the density
// of order n reads the ground lit by order n - 2.
const irradiance =
  atmosphere +
  `
@group(0) @binding(1) var transmission:texture_2d<f32>;
@group(0) @binding(2) var radiance:texture_2d<f32>;
@group(0) @binding(3) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(64) fn direct(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=64u){return;}let mus=f32(id.x)/63.0*2.0-1.0;
 textureStore(output,vec2i(i32(id.x),0),vec4f(20.0*trans(transmission,R+0.001,mus)*max(mus,0.0),1));
}
@compute @workgroup_size(64) fn indirect(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=64u){return;}let mus=f32(id.x)/63.0*2.0-1.0;let sun=vec3f(sqrt(max(0.0,1.0-mus*mus)),mus,0);var result=vec3f(0);
 for(var i=0u;i<32u;i++){let y=(f32(i)+0.5)/32.0;let angle=f32(i)*2.39996323;let radial=sqrt(1.0-y*y);let direction=vec3f(cos(angle)*radial,y,sin(angle)*radial);
  result+=lookup(radiance,R+0.001,y,mus,dot(direction,sun))*y*(6.2831853/32.0);
 }textureStore(output,vec2i(i32(id.x),0),vec4f(result,1));
}`;
const groundDensity =
  atmosphere +
  `
@group(0) @binding(1) var previous:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var transmission:texture_2d<f32>;
@group(0) @binding(4) var irradiance:texture_2d<f32>;
@group(0) @binding(5) var<uniform> albedo:vec4f;
fn groundIrradiance(mus:f32)->vec3f {let x=clamp((mus+1.0)*31.5,0.0,63.0);let i=i32(floor(x));let j=min(i+1,63);
 return mix(textureLoad(irradiance,vec2i(i,0),0).rgb,textureLoad(irradiance,vec2i(j,0),0).rgb,x-floor(x));}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];let rho=densities(c.x);var result=vec3f(0);
 for(var i=0u;i<32u;i++){let y=1.0-2.0*(f32(i)+0.5)/32.0;let angle=f32(i)*2.39996323;let radial=sqrt(1.0-y*y);let direction=vec3f(cos(angle)*radial,y,sin(angle)*radial);let nu=dot(w,direction);
  var light=lookup(previous,c.x,y,c.z,dot(direction,sun));
  if(ground(c.x,y)){let g=vec3f(0,c.x,0)+direction*boundary(c.x,y);let n=normalize(g);
   let path=min(trans(transmission,R,dot(n,-direction))/max(trans(transmission,c.x,-y),vec3f(1e-6)),vec3f(1));
   light+=albedo.rgb*0.3183098862*groundIrradiance(dot(n,sun))*path;}
  result+=light*(BETA_R*rho.x*phaseR(nu)+vec3f(mie()*rho.y*phaseM(nu)))*(12.5663706/32.0);
 }textureStore(output,vec2i(id.xy),vec4f(result,1));
}`;
const add = `
@group(0) @binding(0) var total:texture_2d<f32>;
@group(0) @binding(1) var delta:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){if(any(id.xy>=vec2u(128,256))){return;}let p=vec2i(id.xy);textureStore(output,p,textureLoad(total,p,0)+textureLoad(delta,p,0));}`;
// The sky's read of the tables: the higher orders as stored plus single scattering with its phases at this nu. Its
// Mie phase reads g from frame.clouds.w (a slot the sky's Frame left free; 0.8, or the look's mieAnisotropy), so the
// plain program and the look's program evaluate it from the same uniform: a literal g folded at compile time rounds
// one half-float step away from the uniform's on some compilers (the look check holds them pixel for pixel).
const phaseSky = phase
  .slice(phase.indexOf('fn phaseM('))
  .replace('fn phaseM(', 'fn phaseSky(')
  .replace('let g=0.8;', 'let g=frame.clouds.w;');
const sky =
  singleRead +
  phaseSky +
  `fn brunetonSky(t:texture_2d<f32>,r:f32,mu:f32,mus:f32,nu:f32)->vec3f {return lookup(t,r,mu,mus,nu)+lookupRow(t,256,r,mu,mus,nu)*phaseR(nu)+lookupRow(t,512,r,mu,mus,nu)*phaseSky(nu);}
`;
/**
 * Bruneton day model: four scattering orders precomputed into a coarse table (about 1.8 MB of GPU memory), single
 * scattering kept without its phase functions, which the sky applies per pixel,, rebuilt
 * when turbidity or the ground albedo changes. With a ground albedo above 0 (`groundAlbedo` on the sky's options) the
 * light the ground reflects is scattered back into the sky, which brightens it most near the horizon: three more
 * passes and a little more work per rebuild, 528 bytes more memory. At 0, the default, the passes are the ones without it.
 */
export const bruneton: NonNullable<SkyFeatures['bruneton']> = {
  phase,
  tail,
  sky,
  create(d, uniform, transmission, owned, extend): SkyTables {
    // `extend`: the look's rewrite of the passes (its air read from the uniform), kept for the ground passes built later.
    let code = (wgsl: string) => (extend ? extend(wgsl) : wgsl),
      u = uniform;
    // Ping-pong: textures 0/1 hold the current order, 2/3 the running total of orders 2 to 4, 4 the scattering density.
    // Texture 3, the one the sky reads, also holds single scattering without its phases in rows 256 to 767.
    const t = Array.from({ length: 5 }, (_, i) => {
        const texture = d.createTexture({
          size: [128, i === 3 ? 768 : 256],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        owned.push(texture);
        return texture;
      }).map((t) => t.createView());
    let p1: GPUComputePipeline,
      p2: GPUComputePipeline,
      p2First: GPUComputePipeline,
      p3: GPUComputePipeline,
      p4: GPUComputePipeline;
    const groups: GPUBindGroup[] = [],
      build = () => {
        // The sum pass reads no air.
        [p1, p2, p2First, p3, p4] = [
          code(single),
          code(density),
          code(firstOrder(density, densityRead)),
          code(multiple),
          add,
        ].map((s) => compute(d, s));
        groups.length = 0;
        groups.push(group(d, p1, [u, transmission, t[3], t[2]]));
        // The first density reads single scattering from texture 3 and applies its phases per direction.
        for (let order = 0; order < 3; order++) {
          const previous = order % 2,
            next = 1 - previous;
          groups.push(
            order ? group(d, p2, [u, t[previous], t[4]]) : group(d, p2First, [u, t[3], t[4]]),
            group(d, p3, [u, t[4], t[next]]),
            group(d, p4, [t[2 + previous], t[next], t[2 + next]]),
          );
        }
      };
    build();
    // The ground passes are built the first time an albedo above 0 is asked for: per order, the irradiance pass and
    // its group, then the density pass with the ground term and its group.
    let ground:
      | { buffer: GPUBuffer; passes: [GPUComputePipeline, GPUBindGroup, GPUComputePipeline, GPUBindGroup][] }
      | undefined;
    // The ground's uniform and irradiance texture, made once; its passes are made (again) when first needed.
    let made: { buffer: GPUBuffer; e: GPUTextureView } | undefined;
    const albedo = new Float32Array(4),
      reflect = () => {
        if (!made) {
          const buffer = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          owned.push(buffer);
          const texture = d.createTexture({
            size: [64, 1],
            format: 'rgba16float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
          });
          owned.push(texture);
          made = { buffer, e: texture.createView() };
        }
        const { buffer, e } = made,
          direct = compute(d, code(irradiance), 'direct'),
          indirect = compute(d, code(irradiance), 'indirect'),
          // The first indirect pass applies the phases, and under the look the Mie phase reads its g from the uniform:
          // an auto layout would hold the uniform only then, so this layout is explicit and always holds it.
          // Visibility 4 is GPUShaderStage.COMPUTE (WebGPU sec. 8.1), written as its value so no global is needed.
          firstLayout = d.createBindGroupLayout({
            entries: [
              { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
              { binding: 2, visibility: 4, texture: { sampleType: 'unfilterable-float' } },
              {
                binding: 3,
                visibility: 4,
                storageTexture: { access: 'write-only', format: 'rgba16float' },
              },
            ],
          }),
          indirectFirst = d.createComputePipeline({
            layout: d.createPipelineLayout({ bindGroupLayouts: [firstLayout] }),
            compute: {
              module: d.createShaderModule({ code: code(firstOrder(irradiance, 'lookup(radiance,')) }),
              entryPoint: 'indirect',
            },
          }),
          p = compute(d, code(groundDensity)),
          pFirst = compute(d, code(firstOrder(groundDensity, densityRead))),
          bind = (pipeline: GPUComputePipeline, entries: [number, GPUBindingResource][]) =>
            d.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: entries.map(([binding, resource]) => ({ binding, resource })),
            });
        // Order 0 lights the ground with the direct sun, order 1 with single scattering (texture 3, its phases applied
        // per direction), order 2 with the second order, held in t[1] before the multiple-scattering pass overwrites
        // it. The first density reads single scattering from texture 3 too.
        ground = {
          buffer,
          passes: [
            [
              direct,
              bind(direct, [
                [1, transmission],
                [3, e],
              ]),
              pFirst,
              group(d, pFirst, [u, t[3], t[4], transmission, e, { buffer }]),
            ],
            [
              indirectFirst,
              bind(indirectFirst, [
                [0, u],
                [2, t[3]],
                [3, e],
              ]),
              p,
              group(d, p, [u, t[1], t[4], transmission, e, { buffer }]),
            ],
            [
              indirect,
              bind(indirect, [
                [2, t[1]],
                [3, e],
              ]),
              p,
              group(d, p, [u, t[0], t[4], transmission, e, { buffer }]),
            ],
          ],
        };
      };
    return {
      view: t[3],
      recode(next, binding) {
        code = (wgsl: string) => (next ? next(wgsl) : wgsl);
        u = binding;
        build();
        ground = undefined;
      },
      run(c, reflectance) {
        const on = !!reflectance && (reflectance[0] > 0 || reflectance[1] > 0 || reflectance[2] > 0);
        if (on) {
          if (!ground) reflect();
          albedo.set(reflectance);
          c.device.queue.writeBuffer(ground!.buffer, 0, albedo);
        }
        dispatch(c, p1, groups[0], 16, 32);
        for (let i = 0; i < 3; i++) {
          if (on) {
            const [e, eGroup, p, pGroup] = ground!.passes[i];
            dispatch(c, e, eGroup, 1);
            dispatch(c, p, pGroup, 16, 32);
          } else dispatch(c, i ? p2 : p2First, groups[1 + i * 3], 16, 32);
          dispatch(c, p3, groups[2 + i * 3], 16, 32);
          dispatch(c, p4, groups[3 + i * 3], 16, 32);
        }
      },
    };
  },
};
