import type { PassContext } from '@margoengine/core/extension';
import { compute, group } from '../../shared/gpu.js';
import { overlayPass } from '../../shared/pass.js';
import { oceanWaves, waterFrame, type CoastalFlow } from './coastal.js';
import { fogWgsl } from '../../shared/fog.js';
import { margoError } from '../../shared/errors.js';
import { perSample } from '../../shared/msaa.js';
declare const GPUBufferUsage: { STORAGE: number; COPY_SRC: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** Droplets in the fixed GPU pool. */
const POOL = 4096;
// random(): the xxHash32 avalanche finaliser (Y. Collet, xxHash specification): primes 2246822519 = 0x85EBCA77 and
// 3266489917 = 0xC2B2AE3D with shifts 16 / 13 / 16.
const particles = `struct Particle {position:vec4f,velocity:vec4f}
fn random(value:u32)->f32 {var x=value;x=(x^(x>>16u))*2246822519u;x=(x^(x>>13u))*3266489917u;return f32(x^(x>>16u))/4294967295.0;}`;
// Seed primes 73856093, 19349663 and 83492791: Teschner et al. 2003, "Optimized Spatial Hashing for Collision Detection
// of Deformable Objects". Ballistics under g = 9.81; spawn rates and droplet sizes 0.018 / 0.025 are Margo's.
// Impact spray (impact()): where open sea (connected 0) meets a wall, ground above the water's surface within two cells,
// the swell's crest drives its water at the wall and the wall throws it up. The drive is the swell's horizontal orbital
// velocity into the wall, the sum over its components of a omega sin(phase) (d . n), with the deep-water dispersion
// omega = sqrt(g k) (linear wave theory: the surface water moves with the crest at a omega); n points from the water to
// the wall. Above 0.4 m/s a crest throws clumps of spray, launched up the wall at 4 to 7 times the drive (the jet up
// a wall runs several times faster than the water hitting it: Peregrine 2003, "Water-wave impact on walls", Annual
// Review of Fluid Mechanics 35) and back off it; clumps are 0.08 to 0.35 m across and grow as they rise and thin, many of
// them, each a thin mist holding a speckle of fine drops, so a burst reads as a cloud of spray and no clump as a white
// ball.
// Rates, thresholds and clump sizes are Margo tuning.
// impact() returns the wall's direction from open water at the pixel (xy, unit) and the swell's drive into it in m/s (z),
// z 0 when there is no wall. A droplet's velocity.w of 2 to 3 marks an impact clump (and sets its size); a breaker
// droplet keeps 0 to 1. In the render shader an impact clump's alpha carries 2 more, which the fragment reads as the
// soft puff's mark.
const simulate =
  waterFrame +
  oceanWaves +
  particles +
  `
@group(0) @binding(1) var coast:texture_2d<f32>;
@group(0) @binding(2) var flux:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> droplets:array<Particle>;
@group(0) @binding(4) var<storage,read> connected:array<u32>;
fn impact(pixel:vec2i,size:vec2i,water:vec4f)->vec3f {
 if(water.x<0.5||connected[u32(pixel.y*size.x+pixel.x)+1u]!=0u){return vec3f(0);}
 var n=vec2f(0);
 for(var o=0u;o<8u;o++){
  let dir=vec2f(cos(f32(o)*0.78539816),sin(f32(o)*0.78539816));
  for(var r=1;r<=2;r++){let q=clamp(pixel+vec2i(round(dir*f32(r))),vec2i(0),size-1);if(textureLoad(coast,q,0).y>water.x+water.y+0.3){n+=dir/f32(r);}}
 }
 if(dot(n,n)<0.01){return vec3f(0);}
 n=normalize(n);
 let xz=frame.coast.xy+(vec2f(pixel)+0.5)/vec2f(size)*frame.coast.zw;var drive=0.0;
 for(var j=0u;j<u32(frame.settings.w);j++){
  for(var c=0u;c<3u;c++){let s=swell(frame.waves[j],xz,c,length(frame.flow.yz));drive+=s.amplitude*sqrt(9.81*max(0.0,dot(s.gradient,s.direction)))*sin(s.phase)*dot(s.direction,n);}
 }
 return vec3f(n,max(0.0,drive));
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let index=id.x;if(index>=${POOL}u){return;}
 let size=vec2i(textureDimensions(coast));let dt=min(0.05,frame.cameraData.z);var p=droplets[index];
 p.position.w-=dt;
 if(p.position.w>0){
  p.velocity.y-=9.81*dt;p.position=vec4f(p.position.xyz+p.velocity.xyz*dt,p.position.w);
  let uv=(p.position.xz-frame.coast.xy)/frame.coast.zw;let pixel=clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1);
  let water=textureLoad(coast,pixel,0);if(p.position.y<water.x+water.y){p.position.w=0;}
 }else{
  let clock=u32(frame.settings.x*60.0);let caps=frame.grid.z;let seed=index*73856093u+clock*19349663u;
  for(var i=0u;i<4u;i++){
   let key=seed+i*83492791u;let pixel=vec2i(vec2f(random(key),random(key+1u))*vec2f(size-1));let water=textureLoad(coast,pixel,0);
   if(water.x>0.01&&water.x<1.8+4.0*caps&&water.w>0.08&&random(key+2u)<min(0.9,dt*45.0*water.w*(1.0+3.0*caps))){
    let q=textureLoad(flux,pixel,0);let velocity=clamp(vec2f(q.y-q.x,q.w-q.z)/max(0.04,water.x),vec2f(-4),vec2f(4));
    let xz=frame.coast.xy+(vec2f(pixel)+vec2f(random(key+3u),random(key+4u)))/vec2f(size)*frame.coast.zw;
    p.position=vec4f(xz.x,water.x+water.y+0.03,xz.y,0.4+random(key+5u)*0.5);
    p.velocity=vec4f(velocity.x*0.4+(random(key+6u)-0.5)*0.6,(1.3+random(key+7u)*2.2)*(1.0+1.5*caps),velocity.y*0.4+(random(key+8u)-0.5)*0.6,random(key+9u));break;
   }
   let hit=impact(pixel,size,water);
   if(hit.z>0.4&&random(key+10u)<min(0.9,dt*70.0*(hit.z-0.4)*(1.0+2.0*caps))){
    let cell=frame.coast.zw/vec2f(size);let side=vec2f(-hit.y,hit.x)*(random(key+3u)-0.5);
    let xz=frame.coast.xy+(vec2f(pixel)+0.5+hit.xy*0.4+side)*cell;
    p.position=vec4f(xz.x,water.x+water.y+0.1,xz.y,0.8+random(key+5u)*0.9);
    let up=min(16.0,hit.z*(4.0+3.0*random(key+7u))+1.0);let back=-hit.xy*(0.5+random(key+6u)*1.5)+vec2f(-hit.y,hit.x)*(random(key+8u)-0.5)*1.5;
    p.velocity=vec4f(back.x,up,back.y,2.0+random(key+9u));break;
   }
  }
 }droplets[index]=p;
}`;
const render =
  waterFrame +
  particles +
  `
@group(0) @binding(1) var<storage,read> droplets:array<Particle>;
@group(0) @binding(2) var surface:texture_depth_2d;
@group(0) @binding(3) var environment:texture_2d<f32>;
@group(0) @binding(4) var skySampler:sampler;
struct Output {@builtin(position) clip:vec4f,@location(0) uv:vec4f,@location(1) alpha:f32,@location(2) sky:vec3f}
fn sprayNoise(p:vec2f)->f32 {
 let c=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);let k=bitcast<vec2u>(vec2i(c));
 let a=k.x*73856093u;let b=a+73856093u;let c0=k.y*19349663u;let c1=c0+19349663u;
 let h=vec4f(random(a^c0),random(b^c0),random(a^c1),random(b^c1));
 return mix(mix(h.x,h.y,u.x),mix(h.z,h.w,u.x),u.y);
}
fn spraySky()->vec3f {
 var sum=vec3f(0);
 for(var k=0u;k<8u;k++){
  let a=f32(k)*0.78539816;let up=select(0.5,0.8660254,(k&1u)==1u);let side=sqrt(1.0-up*up);let r=vec3f(cos(a)*side,up,sin(a)*side);
  if(frame.color.w>0.5){sum+=textureSampleLevel(environment,skySampler,vec2f(atan2(r.z,r.x)/6.2831853+0.5,acos(r.y)/3.14159265),0.0).rgb;}
  else{sum+=mix(vec3f(0.18,0.27,0.32),vec3f(0.035,0.10,0.20),sqrt(r.y))*frame.radiance.rgb*(0.015+min(1.0,frame.sun.w*0.15));}
 }
 return sum*0.125;
}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) index:u32)->Output {
 let p=droplets[index];if(p.position.w<=0){return Output(vec4f(-2,-2,0,1),vec4f(0,0,0,1),0,vec3f(0));}
 let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));let corner=corners[v];
 let right=normalize(vec3f(frame.camera[0].x,frame.camera[1].x,frame.camera[2].x));let up=normalize(vec3f(frame.camera[0].y,frame.camera[1].y,frame.camera[2].y));
 var size=(0.018+p.velocity.w*0.025)*(1.0+p.position.w*0.2)*(1.0+2.5*frame.grid.z);var alpha=min(1.0,p.position.w*5.0);
 if(p.velocity.w>=2.0){size=(0.08+0.14*(p.velocity.w-2.0))*(1.0+frame.grid.z)*(1.6-0.5*min(1.0,p.position.w));alpha=2.0+min(1.0,p.position.w*2.0)*0.4;}
 let motion=vec2f(dot(p.velocity.xyz,right),dot(p.velocity.xyz,up));let speed=length(motion);
 let along=select(vec2f(0,1),motion/max(speed,1e-4),speed>1e-3);let stretch=min(4.0,1.0+speed*0.033/size);
 let world=p.position.xyz+((right*along.x+up*along.y)*corner.y*stretch+(up*along.x-right*along.y)*corner.x)*size;
 let uv=vec4f(corner,fract(f32(index)*0.6180340),stretch);
 return Output(frame.camera*vec4f(world,1),uv,alpha,spraySky());
}
fn linear(d:f32)->f32{return frame.cameraData.x*frame.cameraData.y/(frame.cameraData.x+d*(frame.cameraData.y-frame.cameraData.x));}
@fragment fn fragment(i:Output)->@location(0) vec4f {
 let radius=dot(i.uv.xy,i.uv.xy);if(radius>1){discard;}
 let gap=max(0.0,linear(textureLoad(surface,vec2i(i.clip.xy),0))-linear(i.clip.z));
 let clump=i.alpha>=2.0;let falloff=(1.0-radius)*(1.0-radius);
 let p=i.uv.xy*1.7+vec2f(i.uv.z*37.0,i.uv.z*91.0);let n=sprayNoise(p)*0.6+sprayNoise(p*2.9+3.1)*0.4;
 let specks=smoothstep(0.78,0.92,sprayNoise(i.uv.xy*6.0+vec2f(i.uv.z*53.0,i.uv.z*17.0)));
 let shape=falloff*select(smoothstep(0.3,0.7,n),0.3*smoothstep(0.35,0.8,n)+0.7*specks,clump);
 let alpha=shape*select(i.alpha,i.alpha-2.0,clump)*min(1.0,gap*12.0)*0.65/sqrt(i.uv.w);
 let color=vec3f(0.78,0.84,0.85)*(frame.eye.w+i.sky+frame.radiance.rgb*min(1.0,frame.sun.w));
 return vec4f(color*alpha,alpha);
}`;
// Scene fog (Water.setFog), uniform at binding 5: droplets blend over the water like the surface's own colour and are
// written as they are, so they fade toward the fog colour in the target's terms (sRGB-encoded on an 8-bit target).
const fogEdits: Array<[string, string]> = [
  ['@location(2) sky:vec3f}', '@location(2) sky:vec3f,@location(3) world:vec3f}'],
  [
    'return Output(vec4f(-2,-2,0,1),vec4f(0,0,0,1),0,vec3f(0));',
    'return Output(vec4f(-2,-2,0,1),vec4f(0,0,0,1),0,vec3f(0),vec3f(0));',
  ],
  [
    'return Output(frame.camera*vec4f(world,1),uv,alpha,spraySky());',
    'return Output(frame.camera*vec4f(world,1),uv,alpha,spraySky(),world);',
  ],
  [
    'return vec4f(color*alpha,alpha);',
    'let fogColor=select(select(margoFog.color.rgb*12.92,1.055*pow(margoFog.color.rgb,vec3f(1.0/2.4))-0.055,margoFog.color.rgb>=vec3f(0.0031308)),margoFog.color.rgb,frame.cameraData.w>0.5);return vec4f(mix(color,fogColor,fogAmount(i.world))*alpha,alpha);',
  ],
];
function foggedRender(): string {
  let code = render;
  for (const [from, to] of fogEdits) {
    if (code.split(from).length !== 2)
      throw margoError(
        'unsupported',
        'Water spray fog needs the spray shader it was written for; update its fog edits',
      );
    code = code.replace(from, to);
  }
  return code + fogWgsl(0, 5);
}

/** Fixed GPU pool, born where shallow flow is actively breaking and where swell crests hit walls. */
export class Spray {
  readonly buffer: GPUBuffer;
  private readonly simulation: GPUComputePipeline;
  private readonly simulationGroups: GPUBindGroup[] = [];
  private readonly descriptor: GPUComputePassDescriptor = {};
  private readonly presentation = overlayPass();
  private readonly color = this.presentation.colorAttachments[0];
  private readonly depth = this.presentation.depthStencilAttachment;
  private renders: GPURenderPipeline[] = [];
  private renderGroups: GPUBindGroup[] = [];
  private format = '';
  private depthFormat = '';
  private sampled?: GPUTexture;
  private sampledFog?: GPUBuffer;
  private sampledSky?: GPUTexture;
  // Bound in place of a sky map when the water has none (frame.color.w is then 0 and the shader never reads it).
  private blank?: GPUTexture;
  constructor(
    device: GPUDevice,
    private readonly uniform: GPUBuffer,
    private readonly coast: CoastalFlow,
  ) {
    this.buffer = device.createBuffer({ size: POOL * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    try {
      this.simulation = compute(device, simulate);
      for (let i = 0; i < 2; i++)
        this.simulationGroups.push(
          group(device, this.simulation, [
            { buffer: uniform },
            coast.views[i],
            coast.fluxes[i].createView(),
            { buffer: this.buffer },
            { buffer: coast.connected },
          ]),
        );
    } catch (error) {
      this.buffer.destroy();
      throw error;
    }
  }
  step(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass(this.descriptor);
    pass.setPipeline(this.simulation);
    pass.setBindGroup(0, this.simulationGroups[this.coast.current]);
    pass.dispatchWorkgroups(POOL / 64);
    pass.end();
  }
  /** Draws the droplets over the water; `fog` is Water's fog uniform while it has a fog. */
  draw(
    c: Context,
    surface: GPUTexture,
    view: GPUTextureView,
    sky: GPUTexture | undefined,
    sampler: GPUSampler,
    fog?: GPUBuffer,
  ): void {
    const key = c.format + ':' + surface.sampleCount + (fog ? ':fog' : '');
    if (this.format !== key || this.depthFormat !== surface.format) {
      const source = fog ? foggedRender() : render,
        count = surface.sampleCount;
      // Per sample at 4x: one draw reading sample_index, or at the compatibility level, which has none, one masked
      // draw per sample.
      this.renders = perSample(c.device, count).map((sample) => {
        const multisampled = source.replace('surface:texture_depth_2d', 'surface:texture_depth_multisampled_2d'),
          code =
            count === 1
              ? source
              : sample !== null
                ? multisampled.replace(
                    'textureLoad(surface,vec2i(i.clip.xy),0)',
                    `textureLoad(surface,vec2i(i.clip.xy),${sample})`,
                  )
                : multisampled
                    .replace('fragment(i:Output)', 'fragment(i:Output,@builtin(sample_index) sample:u32)')
                    .replace(
                      'textureLoad(surface,vec2i(i.clip.xy),0)',
                      'textureLoad(surface,vec2i(i.clip.xy),i32(sample))',
                    );
        const module = c.device.createShaderModule({ code });
        return c.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: {
            module,
            entryPoint: 'fragment',
            targets: [
              {
                format: c.format,
                blend: {
                  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                },
              },
            ],
          },
          depthStencil: { format: surface.format, depthWriteEnabled: false, depthCompare: 'greater-equal' },
          multisample: sample === null ? { count } : { count, mask: 1 << sample },
        });
      });
      this.format = key;
      this.depthFormat = surface.format;
      this.sampled = undefined;
    }
    const environment =
      sky ??
      (this.blank ??= c.device.createTexture({
        size: [1, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING,
      }));
    if (this.sampled !== surface || this.sampledFog !== fog || this.sampledSky !== environment) {
      const view = surface.createView({ aspect: 'depth-only' });
      this.renderGroups = this.renders.map((pipeline) =>
        group(c.device, pipeline, [
          { buffer: this.uniform },
          { buffer: this.buffer },
          view,
          environment.createView(),
          sampler,
          ...(fog ? [{ buffer: fog }] : []),
        ]),
      );
      this.sampled = surface;
      this.sampledFog = fog;
      this.sampledSky = environment;
    }
    this.color.view = c.color;
    this.depth.view = view;
    const pass = c.encoder.beginRenderPass(this.presentation);
    for (let i = 0; i < this.renders.length; i++) {
      pass.setPipeline(this.renders[i]);
      pass.setBindGroup(0, this.renderGroups[i]);
      pass.draw(6, POOL);
    }
    pass.end();
  }
  dispose(): void {
    this.buffer.destroy();
    this.blank?.destroy();
  }
}
