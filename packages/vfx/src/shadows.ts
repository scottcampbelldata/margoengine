import type { VFXExtension, VFXParticleLight, VFXShadows, VFXState } from './base.js';

declare const GPUBufferUsage: {
  UNIFORM: number;
  COPY_DST: number;
  COPY_SRC: number;
  STORAGE: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/**
 * Particles cast sun shadows and the first live ones emit light.
 *
 * Shadows: each live particle is a sphere impostor in the directional shadow map (Akenine-Moller, Haines and
 * Hoffman, Real-Time Rendering, 4th ed., 2018, billboard impostors). Under the cascade's orthographic matrix the
 * front of a sphere is centerZ - sqrt(r^2 - x^2 - y^2) (elementary geometry). Reeves, "Particle Systems", SIGGRAPH
 * 1983, draws particles as their own primitives. The map's receiver bias stays in the shadow pass; this writes
 * geometric depth.
 *
 * Lights: the first `count` live slots, in slot order, become point lights. The order is an inclusive workgroup
 * scan (Blelloch, "Prefix Sums and Their Applications", CMU-CS-90-190, 1990; Harris, Sengupta and Owens, "Parallel
 * Prefix Sum (Scan) with CUDA", GPU Gems 3, ch. 39, 2007). `decay` is 2 so a clustered list uses the windowed
 * inverse-square term (Karis, "Real Shading in Unreal Engine 4", 2013). No other engine's source was read.
 */
export const MAX_PARTICLE_LIGHTS = 64;

const LIGHT_FLOATS = (1 + MAX_PARTICLE_LIGHTS * 2) * 4;
const LIGHT_BYTES = LIGHT_FLOATS * 4;

const packShader = /* wgsl */ `
struct ParticleShadows {capacity:u32,limit:u32,range:f32,intensity:f32}
@group(0) @binding(0) var<uniform> particleShadows:ParticleShadows;
@group(0) @binding(1) var<storage,read> particles:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> groups:array<u32>;
@group(0) @binding(3) var<storage,read_write> lights:array<vec4f>;
var<workgroup> scratch:array<u32,256>;
fn prefix(l:u32,v:u32)->u32 {
  scratch[l]=v;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var a=0u;if(l>=o){a=scratch[l-o];}workgroupBarrier();scratch[l]+=a;workgroupBarrier();}
  return scratch[l];
}
fn live(i:u32)->u32 {
  if(i>=particleShadows.capacity){return 0u;}
  return select(0u,1u,particles[i*2u].w>0.0);
}
@compute @workgroup_size(256) fn count(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) l:u32,@builtin(workgroup_id) w:vec3u){
  let n=prefix(l,live(id.x));
  if(l==255u){groups[w.x]=n;}
}
@compute @workgroup_size(1) fn offsets(){
  let n=(particleShadows.capacity+255u)/256u;
  var sum=0u;
  for(var g=0u;g<n;g++){let c=groups[g];groups[g]=sum;sum+=c;}
  lights[0]=vec4f(f32(min(sum,particleShadows.limit)),particleShadows.range,particleShadows.intensity,0.0);
}
@compute @workgroup_size(256) fn pack(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) l:u32,@builtin(workgroup_id) w:vec3u){
  let on=live(id.x);
  let incl=prefix(l,on);
  if(on==1u){
    let rank=groups[w.x]+incl-1u;
    if(rank<particleShadows.limit){
      let at=id.x*2u;
      let p=particles[at];
      let color=particles[particleShadows.capacity*2u+at];
      let base=1u+rank*2u;
      lights[base]=vec4f(p.xyz,particleShadows.range);
      lights[base+1u]=vec4f(color.rgb,particleShadows.intensity);
    }
  }
}
`;

const depthShader = /* wgsl */ `
@group(0) @binding(0) var<uniform> shadowMatrix:mat4x4f;
@group(0) @binding(1) var<storage,read> particles:array<vec4f>;
const corners=array<vec2f,6>(vec2f(-1.0,-1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0),vec2f(-1.0,-1.0),vec2f(1.0,1.0),vec2f(-1.0,1.0));
struct ShadowVary {@builtin(position) clip:vec4f,@location(0) local:vec2f,@location(1) centerZ:f32,@location(2) depthRadius:f32}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) slot:u32)->ShadowVary {
  var o:ShadowVary;
  let pos=particles[slot*2u];
  let radius=particles[slot*2u+1u].w*0.5;
  let dead=pos.w<=0.0||!(radius>0.0);
  let clip=shadowMatrix*vec4f(pos.xyz,1.0);
  let sx=length(vec3f(shadowMatrix[0].x,shadowMatrix[1].x,shadowMatrix[2].x));
  let sy=length(vec3f(shadowMatrix[0].y,shadowMatrix[1].y,shadowMatrix[2].y));
  let sz=length(vec3f(shadowMatrix[0].z,shadowMatrix[1].z,shadowMatrix[2].z));
  let local=corners[v];
  o.clip=select(vec4f(clip.xy+local*vec2f(radius*sx,radius*sy)*clip.w,clip.z,clip.w),vec4f(0.0,0.0,0.0,1.0),dead);
  o.local=local;
  o.centerZ=select(clip.z/max(abs(clip.w),1e-20),0.0,dead);
  o.depthRadius=radius*sz;
  return o;
}
@fragment fn fragment(i:ShadowVary)->@builtin(frag_depth) f32 {
  let d=dot(i.local,i.local);
  if(d>1.0){discard;}
  return clamp(i.centerZ-sqrt(max(0.0,1.0-d))*i.depthRadius,0.0,1.0);
}
`;

function finite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The `shadows` feature: particles cast sphere shadows into `cast` (`Shadows` from `@margoengine/shadows`) and the
 * first live slots emit point lights into `into` (`Clustered` from `@margoengine/clustered`). Pass it as `{shadows}`
 * to `VFX` from `@margoengine/vfx/base`; the root `VFX` has it. `count`, `range` and `intensity` are read every frame.
 * `cast` and `into` are fixed at attach. The feature sets `buffer` to the light list (header, then up to 64 lights).
 * `into` sees that list about two frames later, because the read-back waits for the frame to finish.
 */
export const shadows: VFXExtension<VFXShadows> = {
  validate(value) {
    if (!value || typeof value !== 'object')
      throw new TypeError('VFX shadows must be an object; pass {cast, into} or {}');
    const count = value.count ?? 8;
    if (!Number.isInteger(count) || count < 0 || count > MAX_PARTICLE_LIGHTS)
      throw new RangeError('VFX shadows count must be a whole number from 0 to 64; pass e.g. 8');
    const range = value.range ?? 4;
    if (!finite(range) || range <= 0)
      throw new RangeError('VFX shadows range must be a finite distance above 0; pass e.g. 4');
    const intensity = value.intensity ?? 1;
    if (!finite(intensity) || intensity < 0)
      throw new RangeError('VFX shadows intensity must be a finite number of 0 or more; pass e.g. 1');
    if (value.cast !== undefined && (typeof value.cast !== 'object' || typeof value.cast.add !== 'function'))
      throw new TypeError('VFX shadows cast must have add(); pass Shadows from @margoengine/shadows');
    if (value.into !== undefined && (typeof value.into !== 'object' || typeof value.into.setLights !== 'function'))
      throw new TypeError('VFX shadows into must have setLights(); pass Clustered from @margoengine/clustered');
  },
  create(state: VFXState, value, owned) {
    const { device, capacity } = state;
    const uniform = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const groups = device.createBuffer({
      size: Math.ceil(capacity / 256) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const lights = device.createBuffer({
      size: LIGHT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    owned.push(uniform, groups, lights);
    value.buffer = lights;
    const bytes = new ArrayBuffer(16);
    const ints = new Uint32Array(bytes);
    const floats = new Float32Array(bytes);
    const module = device.createShaderModule({ code: packShader });
    const entries = [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: state.particles } },
      { binding: 2, resource: { buffer: groups } },
      { binding: 3, resource: { buffer: lights } },
    ];
    // `layout: 'auto'` keeps only the bindings an entry point reads or writes, so each pipeline gets those entries.
    const pipeline = (entryPoint: string, used: number[]) => {
      const made = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
      const group = device.createBindGroup({
        layout: made.getBindGroupLayout(0),
        entries: entries.filter((entry) => used.includes(entry.binding)),
      });
      return { made, group };
    };
    const count = pipeline('count', [0, 1, 2]);
    const offsets = pipeline('offsets', [0, 2, 3]);
    const packed = pipeline('pack', [0, 1, 2, 3]);
    const cast = value.cast;
    const into = value.into;
    const groupsPer = Math.ceil(capacity / 256);
    let staging: GPUBuffer | undefined;
    let copied = false;
    let mapping = false;
    let pending: Float32Array | null = null;
    let removed = false;
    let unbind: (() => void) | undefined;
    const matrices: GPUBuffer[] = [];
    const depthGroups: GPUBindGroup[] = [];
    let depthPipeline: GPURenderPipeline | undefined;
    if (cast) {
      const depthModule = device.createShaderModule({ code: depthShader });
      depthPipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: depthModule, entryPoint: 'vertex' },
        fragment: { module: depthModule, entryPoint: 'fragment', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
      });
      for (let i = 0; i < 4; i++) {
        const matrix = device.createBuffer({
          size: 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        owned.push(matrix);
        matrices.push(matrix);
        depthGroups.push(
          device.createBindGroup({
            layout: depthPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: matrix } },
              { binding: 1, resource: { buffer: state.particles } },
            ],
          }),
        );
      }
    }
    const depthPass = depthPipeline;
    const source: { disposed: boolean; drawShadow(ctx: ShadowDraw): void } = {
      disposed: false,
      drawShadow(ctx) {
        const cascade = ctx.cascade;
        if (!depthPass || !Number.isInteger(cascade) || cascade < 0 || cascade > 3)
          throw new RangeError('VFX shadows cascade must be 0 to 3');
        device.queue.writeBuffer(matrices[cascade]!, 0, ctx.matrix as Float32Array);
        ctx.pass.setPipeline(depthPass);
        ctx.pass.setBindGroup(0, depthGroups[cascade]!);
        ctx.pass.draw(6, capacity);
        state.stats.drawCalls++;
      },
    };
    if (cast) unbind = cast.add(source, { static: false });
    const drop = () => {
      if (removed) return;
      removed = true;
      source.disposed = true;
      unbind?.();
    };
    const publish = (data: Float32Array) => {
      const n = Math.min(MAX_PARTICLE_LIGHTS, Math.max(0, Math.round(data[0] ?? 0)));
      const list: VFXParticleLight[] = [];
      for (let i = 0; i < n; i++) {
        const o = 4 + i * 8;
        list.push({
          position: [data[o]!, data[o + 1]!, data[o + 2]!],
          range: data[o + 3]!,
          color: [data[o + 4]!, data[o + 5]!, data[o + 6]!],
          intensity: data[o + 7]!,
          decay: 2,
        });
      }
      into!.setLights(list);
    };
    return {
      write(c) {
        if (state.options.shadows !== value)
          throw new TypeError(
            'VFX shadows is fixed at attach; change count, range and intensity in place or attach a new VFX',
          );
        if (value.cast !== cast || value.into !== into)
          throw new TypeError(
            'VFX shadows cast and into are fixed at attach; change count, range and intensity in place',
          );
        value.buffer = lights;
        ints[0] = capacity;
        ints[1] = value.count ?? 8;
        floats[2] = value.range ?? 4;
        floats[3] = value.intensity ?? 1;
        c.device.queue.writeBuffer(uniform, 0, floats);
        if (into && staging && copied && !mapping) {
          mapping = true;
          void staging.mapAsync(GPUMapMode.READ).then(() => {
            const copy = new Float32Array(staging!.getMappedRange().slice(0));
            staging!.unmap();
            mapping = false;
            copied = false;
            pending = copy;
          });
        }
        if (pending && into) {
          const data = pending;
          pending = null;
          publish(data);
        }
      },
      run(pass) {
        pass.setPipeline(count.made);
        pass.setBindGroup(0, count.group);
        pass.dispatchWorkgroups(groupsPer);
        pass.setPipeline(offsets.made);
        pass.setBindGroup(0, offsets.group);
        pass.dispatchWorkgroups(1);
        pass.setPipeline(packed.made);
        pass.setBindGroup(0, packed.group);
        pass.dispatchWorkgroups(groupsPer);
      },
      draw(c) {
        if (!into) return;
        if (mapping || copied) return;
        staging ??= c.device.createBuffer({
          size: LIGHT_BYTES,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        if (!owned.includes(staging)) owned.push(staging);
        c.encoder.copyBufferToBuffer(lights, 0, staging, 0, LIGHT_BYTES);
        copied = true;
      },
      dispose: drop,
    };
  },
};

interface ShadowDraw {
  pass: GPURenderPassEncoder;
  matrix: ArrayLike<number>;
  cascade: number;
}
