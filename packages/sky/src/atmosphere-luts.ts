import { finiteVector } from '@margoengine/math/validate';
import type { Vec3 } from '@margoengine/math';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { STORAGE_BINDING: number; TEXTURE_BINDING: number };
/**
 * A planet's atmosphere for the Hillaire 2020 model, in kilometres: scattering and absorption per kilometre at the
 * ground, exponential scale heights, and an ozone layer as a tent (Bruneton 2017). Every field is optional; the
 * defaults are Earth's, Hillaire 2020 Table 1.
 */
export interface AtmosphereParameters {
  /** Planet radius, km. Default 6360. */
  bottomRadius?: number;
  /** Radius where the atmosphere ends, km. Default 6460. */
  topRadius?: number;
  /** Rayleigh scattering per km at the ground, RGB. Default [0.005802, 0.013558, 0.0331]. */
  rayleigh?: Vec3;
  /** Rayleigh scale height, km. Default 8. */
  rayleighHeight?: number;
  /** Mie scattering per km at the ground: one number (grey, as Earth's haze) or RGB (coloured dust). Default 0.003996. */
  mie?: number | Vec3;
  /** Mie absorption per km at the ground: one number or RGB. Default 0.00444. */
  mieAbsorption?: number | Vec3;
  /** Mie scale height, km. Default 1.2. */
  mieHeight?: number;
  /** Mie phase asymmetry (Cornette-Shanks), -0.99 to 0.99. Default 0.8. */
  mieG?: number;
  /** Ozone absorption per km at the layer's peak, RGB. Default [0.00065, 0.001881, 0.000085]. */
  ozone?: Vec3;
  /** Altitude of the ozone peak, km. Default 25. */
  ozoneCenter?: number;
  /** Half width of the ozone tent, km. Default 15. */
  ozoneWidth?: number;
  /** Ground albedo, RGB, which bounces light back into the air. Default [0.3, 0.3, 0.3]. */
  groundAlbedo?: Vec3;
}
const earth = {
  bottomRadius: 6360,
  topRadius: 6460,
  rayleigh: [0.005802, 0.013558, 0.0331] as Vec3,
  rayleighHeight: 8,
  mie: 0.003996,
  mieAbsorption: 0.00444,
  mieHeight: 1.2,
  mieG: 0.8,
  ozone: [0.00065, 0.001881, 0.000085] as Vec3,
  ozoneCenter: 25,
  ozoneWidth: 15,
  groundAlbedo: [0.3, 0.3, 0.3] as Vec3,
};
/** Earth's atmosphere, Hillaire 2020 Table 1 (ozone and albedo as there, from Bruneton 2017). */
export const EARTH_ATMOSPHERE: Readonly<Required<AtmosphereParameters>> = Object.freeze(earth);
/**
 * Checks an atmosphere and returns it with every default filled in.
 * @throws RangeError naming the field when a value is out of range.
 */
export function atmosphereParameters(p: AtmosphereParameters = {}): Required<AtmosphereParameters> {
  const a = { ...earth, ...p };
  for (const key of ['rayleigh', 'ozone', 'groundAlbedo'] as const) {
    finiteVector(a[key], 3, `Atmosphere ${key}`);
    if (a[key].some((v) => v < 0)) throw new RangeError(`Invalid atmosphere ${key}; use values of 0 or more`);
  }
  const positive = (key: keyof typeof earth, low = 0) => {
    const v = a[key] as number;
    if (!(Number.isFinite(v) && v >= low))
      throw new RangeError(`Invalid atmosphere ${key}; use a finite number of ${low} or more`);
  };
  for (const key of ['mie', 'mieAbsorption'] as const) {
    const v = a[key];
    if (typeof v === 'number') positive(key);
    else {
      finiteVector(v, 3, `Atmosphere ${key}`);
      if (v.some((x) => x < 0)) throw new RangeError(`Invalid atmosphere ${key}; use values of 0 or more`);
    }
  }
  positive('ozoneCenter');
  for (const key of ['rayleighHeight', 'mieHeight', 'ozoneWidth'] as const) positive(key, 1e-3);
  positive('bottomRadius', 1);
  if (!(a.topRadius > a.bottomRadius && a.topRadius <= a.bottomRadius * 2))
    throw new RangeError('Invalid atmosphere topRadius; use a radius above bottomRadius and at most twice it');
  if (!(Math.abs(a.mieG) < 0.99)) throw new RangeError('Invalid atmosphere mieG; use a number between -0.99 and 0.99');
  return a;
}
// Uniform layout (vec4s after the matrix): rayleigh rgb + height, mie scattering/absorption/height/g, ozone rgb +
// centre, albedo rgb + ozone half width, radii bottom/top + sun illuminance + display flag, sun xyz + exposure scale,
// eye xyz (km from the planet centre) + km per world unit, view: aerial reach km, slices, 0, 0; then Mie scattering
// rgb and Mie absorption rgb (each times the Mie scale), which the medium reads: mie.x and mie.y hold their green.
// Distance along unit d from o (km from the centre) to the sphere of radius r: the far root from inside, the near one
// from outside, -1 when missed. The constant is (|o| - r)(|o| + r), which keeps a camera a metre up exact in f32.
// Transmittance table mapping (Bruneton 2017 sec. 2.3): x_mu over the distance to the top, x_r over the horizon length.
/**
 * WGSL shared by every pass of the model: the uniform, the medium, intersections, phase functions and the
 * transmittance table's mapping. Kilometres throughout. Sources: Hillaire 2020, "A Scalable and Production Ready Sky
 * and Atmosphere Rendering Technique", EGSR; Bruneton 2017, "Precomputed Atmospheric Scattering: a New Implementation"
 * (table mappings, ozone tent); Cornette and Shanks 1992 (Mie phase).
 */
export const atmosphereCommon = /* wgsl */ `
struct Atmosphere {inverse:mat4x4f,rayleigh:vec4f,mie:vec4f,ozone:vec4f,ground:vec4f,radii:vec4f,sun:vec4f,eye:vec4f,view:vec4f,mieScattering:vec4f,mieAbsorption:vec4f}
const PI=3.14159265;
fn atmosphereExtinction(a:Atmosphere,h:f32)->vec3f {
 let r=exp(-h/a.rayleigh.w);let m=exp(-h/a.mie.z);let o=max(0.0,1.0-abs(h-a.ozone.w)/a.ground.w);
 return a.rayleigh.rgb*r+(a.mieScattering.rgb+a.mieAbsorption.rgb)*m+a.ozone.rgb*o;
}
fn atmosphereRayleigh(a:Atmosphere,h:f32)->vec3f {return a.rayleigh.rgb*exp(-h/a.rayleigh.w);}
fn atmosphereMie(a:Atmosphere,h:f32)->vec3f {return a.mieScattering.rgb*exp(-h/a.mie.z);}
fn rayleighPhase(nu:f32)->f32 {return 3.0/(16.0*PI)*(1.0+nu*nu);}
fn miePhase(nu:f32,g:f32)->f32 {return 3.0/(8.0*PI)*(1.0-g*g)*(1.0+nu*nu)/((2.0+g*g)*pow(max(1.0+g*g-2.0*g*nu,1e-4),1.5));}
fn sphereHit(o:vec3f,d:vec3f,r:f32)->f32 {
 let l=length(o);let b=dot(o,d);let c=(l-r)*(l+r);let disc=b*b-c;if(disc<0.0){return -1.0;}
 let s=sqrt(disc);if(c<=0.0){return -b+s;}let near=-b-s;return select(-1.0,near,near>=0.0);
}
fn transmittanceUV(a:Atmosphere,r:f32,mu:f32)->vec2f {
 let b=a.radii.x;let t=a.radii.y;let H=sqrt((t-b)*(t+b));let rho=sqrt(max((r-b)*(r+b),0.0));
 let d=max(0.0,-r*mu+sqrt(max(r*r*(mu*mu-1.0)+t*t,0.0)));let dmin=t-r;let dmax=rho+H;
 let x=vec2f((d-dmin)/max(dmax-dmin,1e-6),rho/H);return 0.5/vec2f(256.0,64.0)+x*(1.0-1.0/vec2f(256.0,64.0));
}
fn transmittanceRMu(a:Atmosphere,uv:vec2f)->vec2f {
 let x=(uv-0.5/vec2f(256.0,64.0))/(1.0-1.0/vec2f(256.0,64.0));let b=a.radii.x;let t=a.radii.y;let H=sqrt((t-b)*(t+b));
 let rho=H*x.y;let r=sqrt(rho*rho+b*b);let dmin=t-r;let dmax=rho+H;let d=dmin+x.x*(dmax-dmin);
 let mu=select(clamp((H*H-rho*rho-d*d)/(2.0*r*d),-1.0,1.0),1.0,d<=0.0);return vec2f(r,mu);
}
`;
// Transmittance to the top of the atmosphere, 256 x 64, 40 steps (Hillaire 2020 sec. 5.1).
const transmittance = /* wgsl */ `${atmosphereCommon}
@group(0) @binding(0) var<uniform> atmosphere:Atmosphere;
@group(0) @binding(1) var table:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(256,64))){return;}let a=atmosphere;let rm=transmittanceRMu(a,(vec2f(id.xy)+0.5)/vec2f(256.0,64.0));
 let o=vec3f(0,rm.x,0);let d=vec3f(sqrt(max(1.0-rm.y*rm.y,0.0)),rm.y,0);let reach=max(sphereHit(o,d,a.radii.y),0.0);
 var depth=vec3f(0);let dt=reach/40.0;
 for(var i=0;i<40;i++){let p=o+d*((f32(i)+0.5)*dt);depth+=atmosphereExtinction(a,length(p)-a.radii.x)*dt;}
 textureStore(table,vec2i(id.xy),vec4f(exp(-depth),1));
}
`;
// Light from the sun reaching a point at radius r with sun cosine mu: none where the planet hides the sun.
// In-scattered light and transmittance along d from o over length t, n steps (Hillaire 2020 eq. 1, 10, 11): single
// scattering toward the sun plus the multiple scattering table, each step integrated analytically (Hillaire 2016).
/** WGSL reading the transmittance table (bound as `transmittanceTable` with `lutSampler`) and the multiple scattering one. */
export const atmosphereLookups = /* wgsl */ `
fn transmittanceToTop(a:Atmosphere,r:f32,mu:f32)->vec3f {return textureSampleLevel(transmittanceTable,lutSampler,transmittanceUV(a,r,mu),0.0).rgb;}
fn sunTransmittance(a:Atmosphere,p:vec3f)->vec3f {
 let r=length(p);let up=p/r;let mu=dot(up,a.sun.xyz);
 if(sphereHit(p,a.sun.xyz,a.radii.x*0.99999)>=0.0&&mu<0.0){return vec3f(0);}return transmittanceToTop(a,r,mu);
}
fn multipleScattering(a:Atmosphere,r:f32,mu:f32)->vec3f {
 let uv=vec2f(mu*0.5+0.5,clamp((r-a.radii.x)/(a.radii.y-a.radii.x),0.0,1.0));
 return textureSampleLevel(multipleTable,lutSampler,0.5/32.0+uv*(31.0/32.0),0.0).rgb;
}
fn integrateScattering(a:Atmosphere,o:vec3f,d:vec3f,t:f32,n:u32,throughputIn:vec3f)->array<vec3f,2> {
 let nu=dot(d,a.sun.xyz);let pr=rayleighPhase(nu);let pm=miePhase(nu,a.mie.w);let dt=t/f32(n);
 var light=vec3f(0);var throughput=throughputIn;
 for(var i=0u;i<n;i++){
  let p=o+d*((f32(i)+0.5)*dt);let r=length(p);let h=r-a.radii.x;let up=p/r;
  let sr=atmosphereRayleigh(a,h);let sm=atmosphereMie(a,h);let ext=atmosphereExtinction(a,h);
  let source=(sr*pr+sm*pm)*sunTransmittance(a,p)+(sr+sm)*multipleScattering(a,r,dot(up,a.sun.xyz));
  let step=exp(-ext*dt);light+=throughput*source*(1.0-step)/max(ext,vec3f(1e-7));throughput*=step;
 }
 return array<vec3f,2>(light*a.radii.z,throughput);
}
`;
// Multiple scattering (Hillaire 2020 sec. 5.5.2): from each altitude and sun angle, 64 directions on the sphere, 20
// steps each, give the second order L2 and the transfer f_ms; Psi = L2 / (1 - f_ms) sums the geometric series of
// higher orders. The ground reflects with its albedo (Lambert). One workgroup of 64 per texel.
// Direction k of an 8 x 8 grid, uniform over the sphere in (phi, cos theta).
const multiple = /* wgsl */ `${atmosphereCommon}
@group(0) @binding(0) var<uniform> atmosphere:Atmosphere;
@group(0) @binding(1) var transmittanceTable:texture_2d<f32>;
@group(0) @binding(2) var lutSampler:sampler;
@group(0) @binding(3) var table:texture_storage_2d<rgba16float,write>;
fn transmittanceToTop(a:Atmosphere,r:f32,mu:f32)->vec3f {return textureSampleLevel(transmittanceTable,lutSampler,transmittanceUV(a,r,mu),0.0).rgb;}
var<workgroup> sums:array<vec3f,128>;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) texel:vec3u,@builtin(local_invocation_index) k:u32){
 let a=atmosphere;let mus=(f32(texel.x)+0.5)/32.0*2.0-1.0;let r=a.radii.x+(f32(texel.y)+0.5)/32.0*(a.radii.y-a.radii.x);
 let sun=vec3f(sqrt(max(1.0-mus*mus,0.0)),mus,0);let o=vec3f(0,r,0);
 let cosTheta=1.0-2.0*(f32(k/8u)+0.5)/8.0;let phi=2.0*PI*(f32(k%8u)+0.5)/8.0;let s=sqrt(max(1.0-cosTheta*cosTheta,0.0));
 let d=vec3f(s*cos(phi),cosTheta,s*sin(phi));
 let ground=sphereHit(o,d,a.radii.x);let t=select(sphereHit(o,d,a.radii.y),ground,ground>=0.0);let dt=max(t,0.0)/20.0;
 var throughput=vec3f(1);var l2=vec3f(0);var fms=vec3f(0);
 for(var i=0;i<20;i++){
  let p=o+d*((f32(i)+0.5)*dt);let pr=length(p);let h=pr-a.radii.x;
  let scatter=atmosphereRayleigh(a,h)+atmosphereMie(a,h);let ext=atmosphereExtinction(a,h);
  let shadow=select(1.0,0.0,sphereHit(p,sun,a.radii.x*0.99999)>=0.0&&dot(p,sun)<0.0);
  let step=exp(-ext*dt);let integral=throughput*(1.0-step)/max(ext,vec3f(1e-7));
  l2+=integral*scatter*transmittanceToTop(a,pr,dot(p/pr,sun))*shadow/(4.0*PI);fms+=integral*scatter;throughput*=step;
 }
 if(ground>=0.0){let p=o+d*ground;let n=normalize(p);l2+=throughput*transmittanceToTop(a,length(p),dot(n,sun))*max(dot(n,sun),0.0)*a.ground.rgb/PI;}
 sums[k]=l2;sums[64u+k]=fms;workgroupBarrier();
 for(var w=32u;w>0u;w=w>>1u){if(k<w){sums[k]+=sums[k+w];sums[64u+k]+=sums[64u+k+w];}workgroupBarrier();}
 if(k==0u){let L=sums[0]/64.0;let f=sums[64]/64.0;textureStore(table,vec2i(texel.xy),vec4f(L/(1.0-f),1));}
}
`;
/**
 * The two tables that stay until the atmosphere changes: transmittance (256 x 64) and multiple scattering (32 x 32),
 * plus the uniform every pass reads, the kilometre view of {@link atmosphereCommon}'s `Atmosphere`. Internal to the
 * sky's Hillaire entries.
 */
export class AtmosphereTables {
  readonly uniform: GPUBuffer;
  readonly transmittance: GPUTexture;
  readonly multiple: GPUTexture;
  readonly sampler: GPUSampler;
  /** The uniform's values: write the view fields, then {@link AtmosphereTables.upload}. */
  readonly values = new Float32Array(56);
  private key = '';
  private pipelines?: [GPUComputePipeline, GPUComputePipeline];
  constructor(private readonly device: GPUDevice) {
    const table = (width: number, height: number) =>
      device.createTexture({
        size: [width, height],
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.uniform = device.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.transmittance = table(256, 64);
    this.multiple = table(32, 32);
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }
  /** Writes the medium fields of the uniform for `a`, with Mie scattering times `mieScale`. */
  medium(a: Required<AtmosphereParameters>, mieScale: number): void {
    const v = this.values;
    v.set(a.rayleigh, 16);
    v[19] = a.rayleighHeight;
    const rgb = (x: number | Vec3, c: number) => (typeof x === 'number' ? x : x[c]) * mieScale;
    v[20] = rgb(a.mie, 1);
    v[21] = rgb(a.mieAbsorption, 1);
    for (let c = 0; c < 3; c++) {
      v[48 + c] = rgb(a.mie, c);
      v[52 + c] = rgb(a.mieAbsorption, c);
    }
    v[22] = a.mieHeight;
    v[23] = a.mieG;
    v.set(a.ozone, 24);
    v[27] = a.ozoneCenter;
    v.set(a.groundAlbedo, 28);
    v[31] = a.ozoneWidth;
    v[32] = a.bottomRadius;
    v[33] = a.topRadius;
  }
  /** Uploads the uniform and, when the medium changed since the last call, recomputes both tables on `encoder`. */
  upload(encoder: GPUCommandEncoder): void {
    const d = this.device;
    d.queue.writeBuffer(this.uniform, 0, this.values as Float32Array<ArrayBuffer>);
    const key = Array.from(this.values.subarray(16, 34)).join() + ':' + Array.from(this.values.subarray(48, 55)).join();
    if (key === this.key) return;
    this.key = key;
    const [t, m] = (this.pipelines ??= [
      d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code: transmittance }), entryPoint: 'main' },
      }),
      d.createComputePipeline({
        layout: 'auto',
        compute: { module: d.createShaderModule({ code: multiple }), entryPoint: 'main' },
      }),
    ]);
    let pass = encoder.beginComputePass();
    pass.setPipeline(t);
    pass.setBindGroup(
      0,
      d.createBindGroup({
        layout: t.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.transmittance.createView() },
        ],
      }),
    );
    pass.dispatchWorkgroups(32, 8);
    pass.end();
    pass = encoder.beginComputePass();
    pass.setPipeline(m);
    pass.setBindGroup(
      0,
      d.createBindGroup({
        layout: m.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          { binding: 1, resource: this.transmittance.createView() },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: this.multiple.createView() },
        ],
      }),
    );
    pass.dispatchWorkgroups(32, 32);
    pass.end();
  }
  /** Frees the tables and the uniform. */
  dispose(): void {
    this.uniform.destroy();
    this.transmittance.destroy();
    this.multiple.destroy();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
