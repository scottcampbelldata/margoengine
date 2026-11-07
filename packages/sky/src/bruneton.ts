import { group, compute, dispatch } from '../../shared/gpu.js';
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
// Single scattering (32 steps), then three more orders: Bruneton & Neyret 2008 sec. 4. The factor 20.0 on the single
// scattering is a Margo exposure scale (sky brightness in sky units), not from Bruneton & Neyret.
const single =
  atmosphere +
  `
@group(0) @binding(1) var transmission:texture_2d<f32>;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var total:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(128,256))){return;}let c=coordinates(id.xy);let basis=directions(c);let w=basis[0];let sun=basis[1];let nu=dot(w,sun);
 let step=boundary(c.x,c.y)/32.0;var throughput=vec3f(1);var result=vec3f(0);
 for(var i=0u;i<32u;i++){let p=vec3f(0,c.x,0)+w*((f32(i)+0.5)*step);let r=length(p);let rho=densities(r);let absorb=exp(-extinction(r)*step);
  result+=throughput*sqrt(absorb)*trans(transmission,r,dot(p/r,sun))*(BETA_R*rho.x*phaseR(nu)+vec3f(mie()*rho.y*phaseM(nu)))*step*20.0;throughput*=absorb;
 }textureStore(output,vec2i(id.xy),vec4f(result,1));textureStore(total,vec2i(id.xy),vec4f(result,1));
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
/**
 * Bruneton day model: four scattering orders precomputed into a coarse table (about 1.3 MB of GPU memory), rebuilt
 * when turbidity or the ground albedo changes. With a ground albedo above 0 (`groundAlbedo` on the sky's options) the
 * light the ground reflects is scattered back into the sky, which brightens it most near the horizon: three more
 * passes and a little more work per rebuild, 528 bytes more memory. At 0, the default, the passes are the ones without it.
 */
export const bruneton: NonNullable<SkyFeatures['bruneton']> = {
  phase,
  tail,
  create(d, u, transmission, owned): SkyTables {
    // Ping-pong: textures 0/1 hold the current order, 2/3 the running total, 4 the scattering density.
    const t = Array.from({ length: 5 }, () => {
        const texture = d.createTexture({
          size: [128, 256],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        owned.push(texture);
        return texture;
      }).map((t) => t.createView()),
      [p1, p2, p3, p4] = [single, density, multiple, add].map((s) => compute(d, s)),
      groups = [group(d, p1, [u, transmission, t[0], t[2]])];
    for (let order = 0; order < 3; order++) {
      const previous = order % 2,
        next = 1 - previous;
      groups.push(
        group(d, p2, [u, t[previous], t[4]]),
        group(d, p3, [u, t[4], t[next]]),
        group(d, p4, [t[2 + previous], t[next], t[2 + next]]),
      );
    }
    // The ground passes are built the first time an albedo above 0 is asked for: per order, the irradiance pass and
    // its group, then the density pass with the ground term and its group.
    let ground: { buffer: GPUBuffer; passes: [GPUComputePipeline, GPUBindGroup, GPUComputePipeline, GPUBindGroup][] };
    const albedo = new Float32Array(4),
      reflect = () => {
        const buffer = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        owned.push(buffer);
        const texture = d.createTexture({
          size: [64, 1],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
        owned.push(texture);
        const e = texture.createView(),
          direct = compute(d, irradiance, 'direct'),
          indirect = compute(d, irradiance, 'indirect'),
          p = compute(d, groundDensity),
          bind = (pipeline: GPUComputePipeline, entries: [number, GPUTextureView][]) =>
            d.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: entries.map(([binding, resource]) => ({ binding, resource })),
            });
        // Order 0 lights the ground with the direct sun; orders 1 and 2 with the order held in t[next] before the
        // multiple-scattering pass overwrites it (single scattering, then the second order).
        ground = {
          buffer,
          passes: [0, 1, 2].map((order) => {
            const previous = order % 2,
              next = 1 - previous;
            return [
              order ? indirect : direct,
              order
                ? bind(indirect, [
                    [2, t[next]],
                    [3, e],
                  ])
                : bind(direct, [
                    [1, transmission],
                    [3, e],
                  ]),
              p,
              group(d, p, [u, t[previous], t[4], transmission, e, { buffer }]),
            ];
          }),
        };
      };
    return {
      view: t[3],
      run(c, reflectance) {
        const on = !!reflectance && (reflectance[0] > 0 || reflectance[1] > 0 || reflectance[2] > 0);
        if (on) {
          if (!ground) reflect();
          albedo.set(reflectance);
          c.device.queue.writeBuffer(ground.buffer, 0, albedo);
        }
        dispatch(c, p1, groups[0], 16, 32);
        for (let i = 0; i < 3; i++) {
          if (on) {
            const [e, eGroup, p, pGroup] = ground.passes[i];
            dispatch(c, e, eGroup, 1);
            dispatch(c, p, pGroup, 16, 32);
          } else dispatch(c, p2, groups[1 + i * 3], 16, 32);
          dispatch(c, p3, groups[2 + i * 3], 16, 32);
          dispatch(c, p4, groups[3 + i * 3], 16, 32);
        }
      },
    };
  },
};
