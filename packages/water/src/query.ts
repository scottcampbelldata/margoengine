import type { Water } from './index.js';
import type { FFTOcean } from './fft.js';
import { queryStates, type QueryState } from './query-state.js';
import { fault, rangeError } from '../../shared/errors.js';

declare const GPUBufferUsage: {
  UNIFORM: number;
  STORAGE: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

/** One vertical hit on the last captured, finite draw mesh. Units are metres and seconds. */
export interface WaveSample {
  height: number;
  /** Unit macro surface normal; excludes Water's shading-only micro ripples. */
  normal: [number, number, number];
  /** Unit normal of the actual intersected triangle, pointing up. */
  geometricNormal: [number, number, number];
  /** Interpolated surface-particle velocity, not the rate at a fixed world XZ. */
  velocity: [number, number, number];
  /** Rendered time of this snapshot. */
  time: number;
}
type Coast = { data: Float32Array; width: number; height: number; origin: number[]; size: number[]; still: boolean };
const unit = (v: number[]): [number, number, number] => {
  const length = Math.hypot(...v);
  return length ? [v[0] / length, v[1] / length, v[2] / length] : [0, 1, 0];
};
const output = `
@group(1) @binding(0) var<storage,read> coordinates:array<f32>;
@group(1) @binding(1) var<storage,read_write> vertices:array<vec4f>;
@group(1) @binding(2) var flux:texture_2d<f32>;
`;
// Differentiate the same bent phases as swell(), holding parameter-space XZ fixed.
const waterVelocity = `
fn waveVelocity(xz:vec2f,width:f32)->vec3f {
 var velocity=vec3f(0);
 let spectrum=array<vec4f,3>(vec4f(0,1,0.4,0),vec4f(-0.64,0.84,0.35,2.17),vec4f(0.81,1.18,0.25,4.91));
 for(var j=0u;j<u32(frame.settings.w);j++) {let w=frame.waves[j];
  for(var c=0u;c<3u;c++) {let s=swell(w,xz,c,width);let component=spectrum[c];let speed=w.shape.y*sqrt(component.y);
   let bend=w.wave.w*component.y*0.35*dot(vec2f(-s.direction.y,s.direction.x),xz)-speed*frame.settings.x*0.12+w.shape.z+component.w;
   let rate=-speed*(1.0+0.168*cos(bend));let q=w.shape.x*0.9;
   velocity+=vec3f(-q*s.direction.x*sin(s.phase),cos(s.phase),-q*s.direction.y*sin(s.phase))*s.amplitude*rate;
  }
 }return velocity;
}
fn flowVelocity(point:vec2i)->vec3f {
 let size=vec2i(textureDimensions(coast));let p=clamp(point,vec2i(0),size-1);let water=textureLoad(coast,p,0);
 if(water.x<0.003||STILL){return vec3f(0);}
 let q=textureLoad(flux,p,0);var incoming=vec4f(0);
 if(p.x>0){incoming.x=textureLoad(flux,p-vec2i(1,0),0).y;}
 if(p.x<size.x-1){incoming.y=textureLoad(flux,p+vec2i(1,0),0).x;}
 if(p.y>0){incoming.z=textureLoad(flux,p-vec2i(0,1),0).w;}
 if(p.y<size.y-1){incoming.w=textureLoad(flux,p+vec2i(0,1),0).z;}
 let horizontal=vec2f(q.y-q.x+incoming.x-incoming.y,q.w-q.z+incoming.z-incoming.w)/max(0.04,2.0*water.x);
 var vertical=(incoming.x+incoming.y-q.x-q.y)/frame.flow.y+(incoming.z+incoming.w-q.z-q.w)/frame.flow.z;
 let xz=frame.coast.xy+(vec2f(p)+0.5)/vec2f(size)*frame.coast.zw;
 let v=coastal(xz);let slope=-v.normal.xz/max(0.0001,v.normal.y);
 // The sea forcing is the continuous relaxation used by the finite-volume substeps.
 let index=u32(p.y*size.x+p.x)+1u;
 if(connected[index]==0u){
  var seaLevel=frame.settings.y;
  for(var j=0u;j<u32(frame.settings.w);j++){for(var c=0u;c<3u;c++){let s=swell(frame.waves[j],xz,c,length(frame.flow.yz));seaLevel+=s.amplitude*sin(s.phase);}}
  vertical+=(max(0.0,seaLevel-water.y)-water.x)*4.0*smoothstep(0.65,2.4,max(0.0,frame.settings.y-water.y));
 }
 return vec3f(horizontal.x,vertical+dot(horizontal,slope),horizontal.y);
}
fn coastalVelocity(xz:vec2f)->vec3f {
 let size=vec2i(textureDimensions(coast));let p=clamp((xz-frame.coast.xy)/frame.coast.zw*vec2f(size)-0.5,vec2f(0),vec2f(size-1));
 let lo=vec2i(floor(p));let t=fract(p);
 return mix(mix(flowVelocity(lo),flowVelocity(lo+vec2i(1,0)),t.x),mix(flowVelocity(lo+vec2i(0,1)),flowVelocity(lo+vec2i(1,1)),t.x),t.y);
}
`;
function captureShader(state: QueryState): string {
  const count = (state.segments + 1) ** 2;
  if (state.kind === 'water')
    return (
      state.shader +
      output +
      waterVelocity +
      `
@compute @workgroup_size(64) fn capture(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=${count}u){return;}let o=i*3u;var base=vec2f(coordinates[o],coordinates[o+1u]);
 if(HORIZON){base+=frame.grid.xy;}
 let width=coordinates[o+2u];let v=surface(base,width);var velocity=waveVelocity(base,width);
 if(inCoast(base)){velocity=mix(velocity,coastalVelocity(base),coastal(base).blend.z);}
 ${state.extraVelocity?.map((v) => `velocity+=${v};`).join('\n') ?? ''}
 vertices[i*3u]=vec4f(v.position,base.x);vertices[i*3u+1u]=vec4f(v.normal,base.y);vertices[i*3u+2u]=vec4f(velocity,0);
}`
    );
  return (
    state.shader +
    output +
    `
@compute @workgroup_size(64) fn capture(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=${count}u){return;}let cells=u32(frame.grid.z);
 let base=vec2f(f32(i%(cells+1u)),f32(i/(cells+1u)))/f32(cells)*frame.grid.xy-frame.grid.xy*0.5+frame.water.zw;
 let wave=oceanAt(base);var velocity=vec3f(0);
 for(var c=0u;c<CASCADES;c++){velocity+=sampleSurface(base,c,1u).xyz;}
 vertices[i*3u]=vec4f(vec3f(base.x,frame.water.x,base.y)+wave.displacement,base.x);
 vertices[i*3u+1u]=vec4f(wave.normal,base.y);vertices[i*3u+2u]=vec4f(velocity,0);
}`
  );
}
const boundsShader = `
@group(0) @binding(0) var<storage,read> vertices:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> bounds:array<vec4f>;
@group(0) @binding(2) var<uniform> config:vec4u;
fn vertex(p:vec2u)->vec2f {return vertices[(p.y*(config.x+1u)+p.x)*3u].xz;}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(config.x))){return;}
 var low=vec2f(1e30);var high=vec2f(-1e30);
 for(var z=0u;z<2u;z++){for(var x=0u;x<2u;x++){
  if(config.y==0u){let p=vertex(id.xy+vec2u(x,z));low=min(low,p);high=max(high,p);}
  else {let p=id.xy*2u+vec2u(x,z);if(all(p<vec2u(config.y))){let b=bounds[config.w+p.y*config.y+p.x];low=min(low,b.xy);high=max(high,b.zw);}}
 }}
 bounds[config.z+id.y*config.x+id.x]=vec4f(low,high);
}`;

/**
 * CPU queries of an explicit rendered-frame snapshot. capture() is the only GPU/readback step.
 * sample() is synchronous, performs no GPU work, and returns the highest triangle hit, including folded FFT waves.
 */
export class WaveQuery {
  private constructor(
    readonly time: number,
    private readonly segments: number,
    private readonly vertices: Float32Array,
    private readonly bounds: Float32Array,
    private readonly levels: { side: number; offset: number }[],
    private readonly coast?: Coast,
    private readonly fft?: { data: Float32Array; resolution: number; lengths: readonly number[] },
  ) {}
  /** Capture after engine.render(). Concurrent captures are independent; abort, disposal and restoration reject. */
  static async capture(source: Water | FFTOcean, options: { signal?: AbortSignal } = {}): Promise<WaveQuery> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const getter = queryStates.get(source),
      state = getter?.();
    if (!state) throw fault('state', 'Render live Water or FFTOcean before WaveQuery.capture', 'state');
    const { device, segments } = state,
      values = state.values.slice();
    const owned: GPUBuffer[] = [],
      staging: GPUBuffer[] = [];
    const make = (size: number, usage: number, data?: Float32Array | Uint32Array) => {
      const buffer = device.createBuffer({ size, usage });
      owned.push(buffer);
      if (data) device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
      return buffer;
    };
    const abort = () => {
      for (const buffer of staging) buffer.destroy();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // Read the submitted uniform, not authored values changed since the draw. Later queue writes follow this dispatch.
      const uniform = state.token;
      const mesh = make((segments + 1) ** 2 * 48, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const levels: { side: number; offset: number }[] = [];
      let side = segments,
        offset = 0;
      for (;;) {
        levels.push({ side, offset });
        offset += side * side;
        if (side === 1) break;
        side = Math.ceil(side / 2);
      }
      const tree = make(offset * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const module = device.createShaderModule({ code: captureShader(state) });
      const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'capture' } });
      const bindings =
        state.kind === 'water'
          ? [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 3, resource: state.resources![3] },
              { binding: 7, resource: state.resources![7] },
              ...(state.extraBindings ?? []),
            ]
          : [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: { buffer: state.field! } },
            ];
      const first = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: bindings });
      const secondEntries: GPUBindGroupEntry[] = [{ binding: 1, resource: { buffer: mesh } }];
      if (state.kind === 'water') {
        const coords = make(
          state.positions!.byteLength,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          state.positions,
        );
        secondEntries.push(
          { binding: 0, resource: { buffer: coords } },
          {
            binding: 2,
            resource: state.coast?.fluxes[state.coast.current].createView() ?? state.resources![3],
          },
        );
      }
      const second = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: secondEntries });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, first);
      pass.setBindGroup(1, second);
      pass.dispatchWorkgroups(Math.ceil((segments + 1) ** 2 / 64));
      pass.end();
      const boundsModule = device.createShaderModule({ code: boundsShader });
      const boundsPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: boundsModule, entryPoint: 'main' },
      });
      for (let i = 0; i < levels.length; i++) {
        const level = levels[i],
          previous = levels[i - 1];
        const config = make(
          16,
          GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          new Uint32Array([level.side, previous?.side ?? 0, level.offset, previous?.offset ?? 0]),
        );
        const bind = device.createBindGroup({
          layout: boundsPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: mesh } },
            { binding: 1, resource: { buffer: tree } },
            { binding: 2, resource: { buffer: config } },
          ],
        });
        const step = encoder.beginComputePass();
        step.setPipeline(boundsPipeline);
        step.setBindGroup(0, bind);
        step.dispatchWorkgroups(Math.ceil(level.side / 8), Math.ceil(level.side / 8));
        step.end();
      }
      const copy = (buffer: GPUBuffer, size: number) => {
        const dest = make(size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
        staging.push(dest);
        encoder.copyBufferToBuffer(buffer, 0, dest, 0, size);
        return dest;
      };
      const meshCopy = copy(mesh, (segments + 1) ** 2 * 48),
        treeCopy = copy(tree, offset * 16);
      let fieldCopy: GPUBuffer | undefined,
        coastCopy: GPUBuffer | undefined,
        row = 0;
      if (state.field) fieldCopy = copy(state.field, state.resolution! ** 2 * state.lengths!.length * 48);
      const terrain = state.coast?.states[state.coast.current];
      if (terrain) {
        row = Math.ceil((terrain.width * 16) / 256) * 256;
        coastCopy = make(row * terrain.height, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
        staging.push(coastCopy);
        encoder.copyTextureToBuffer({ texture: terrain }, { buffer: coastCopy, bytesPerRow: row }, [
          terrain.width,
          terrain.height,
        ]);
      }
      device.queue.submit([encoder.finish()]);
      await Promise.all(staging.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
      signal?.throwIfAborted();
      if (getter?.()?.token !== state.token)
        throw fault(
          'state',
          'Water disposed or device restored during wave capture; render and capture again',
          'state',
        );
      const floats = (buffer: GPUBuffer) => new Float32Array(buffer.getMappedRange().slice(0));
      let coast: Coast | undefined;
      if (terrain && coastCopy) {
        const padded = floats(coastCopy),
          data = new Float32Array(terrain.width * terrain.height * 4);
        for (let y = 0; y < terrain.height; y++)
          data.set(padded.subarray((y * row) / 4, (y * row) / 4 + terrain.width * 4), y * terrain.width * 4);
        coast = {
          data,
          width: terrain.width,
          height: terrain.height,
          origin: Array.from(values.subarray(96, 98)),
          size: Array.from(values.subarray(98, 100)),
          still: !!state.still,
        };
      }
      return new WaveQuery(
        state.time,
        segments,
        floats(meshCopy),
        floats(treeCopy),
        levels,
        coast,
        fieldCopy ? { data: floats(fieldCopy), resolution: state.resolution!, lengths: state.lengths! } : undefined,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (getter?.()?.token !== state.token)
        throw fault(
          'state',
          'Water disposed or device restored during wave capture; render and capture again',
          'state',
        );
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      for (const buffer of owned) buffer.destroy();
    }
  }
  /** Highest visible water hit at world XZ, or undefined outside the finite surface or on dry ground. */
  sample(x: number, z: number): WaveSample | undefined {
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw rangeError('Wave query XZ must be finite world coordinates', 'geometry');
    let best: WaveSample | undefined;
    const stack = [{ level: this.levels.length - 1, x: 0, z: 0 }];
    while (stack.length) {
      const item = stack.pop()!,
        level = this.levels[item.level],
        o = (level.offset + item.z * level.side + item.x) * 4,
        b = this.bounds;
      if (x < b[o] || z < b[o + 1] || x > b[o + 2] || z > b[o + 3]) continue;
      if (item.level) {
        const side = this.levels[item.level - 1].side;
        for (let j = 0; j < 2; j++)
          for (let i = 0; i < 2; i++)
            if (item.x * 2 + i < side && item.z * 2 + j < side)
              stack.push({ level: item.level - 1, x: item.x * 2 + i, z: item.z * 2 + j });
        continue;
      }
      const a = item.z * (this.segments + 1) + item.x,
        c = a + this.segments + 1;
      for (const ids of [
        [a, c, a + 1],
        [a + 1, c, c + 1],
      ]) {
        const v = this.vertices,
          offsets = ids.map((i) => i * 12);
        const [p, q, r] = offsets,
          px = v[p] - x,
          pz = v[p + 2] - z,
          qx = v[q] - x,
          qz = v[q + 2] - z,
          rx = v[r] - x,
          rz = v[r + 2] - z;
        const weights = [qx * rz - qz * rx, rx * pz - rz * px, px * qz - pz * qx];
        if (weights.some((w) => w < 0) && weights.some((w) => w > 0)) continue;
        const det = weights[0] + weights[1] + weights[2];
        if (det === 0) continue;
        for (let i = 0; i < 3; i++) weights[i] /= det;
        const interpolate = (channel: number) => offsets.reduce((sum, o, i) => sum + v[o + channel] * weights[i], 0);
        const height = interpolate(1);
        if (best && height <= best.height) continue;
        const base = [interpolate(3), interpolate(7)];
        if (this.dry(base[0], base[1])) continue;
        let normal = unit([interpolate(4), interpolate(5), interpolate(6)]);
        if (this.fft) normal = this.fftNormal(base[0], base[1]);
        const ux = v[q] - v[p],
          uy = v[q + 1] - v[p + 1],
          uz = v[q + 2] - v[p + 2],
          vx = v[r] - v[p],
          vy = v[r + 1] - v[p + 1],
          vz = v[r + 2] - v[p + 2];
        let geometricNormal = unit([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
        if (geometricNormal[1] < 0) geometricNormal = geometricNormal.map((n) => -n) as [number, number, number];
        best = {
          height,
          normal,
          geometricNormal,
          velocity: [interpolate(8), interpolate(9), interpolate(10)],
          time: this.time,
        };
      }
    }
    return best;
  }
  /** Convenience height query; undefined on dry ground or outside the draw. */
  heightAt(x: number, z: number): number | undefined {
    return this.sample(x, z)?.height;
  }
  /** Convenience macro-normal query. */
  normalAt(x: number, z: number): [number, number, number] | undefined {
    return this.sample(x, z)?.normal;
  }
  /** Convenience surface-particle velocity query. */
  velocityAt(x: number, z: number): [number, number, number] | undefined {
    return this.sample(x, z)?.velocity;
  }
  private dry(x: number, z: number): boolean {
    const c = this.coast;
    if (!c) return false;
    const u = (x - c.origin[0]) / c.size[0],
      v = (z - c.origin[1]) / c.size[1];
    if (u < 0 || v < 0 || u > 1 || v > 1) return false;
    const px = Math.max(0, Math.min(c.width - 1, u * c.width - 0.5)),
      pz = Math.max(0, Math.min(c.height - 1, v * c.height - 0.5));
    const ix = Math.floor(px),
      iz = Math.floor(pz),
      tx = px - ix,
      tz = pz - iz;
    let depth = 0;
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const o = (Math.min(c.height - 1, iz + j) * c.width + Math.min(c.width - 1, ix + i)) * 4;
        const d = c.data[o],
          fill = c.data[o + 3],
          signed = d > 0.003 ? d : fill > -1e29 ? fill - c.data[o + 1] : -1;
        depth += (c.still ? signed : d) * (i ? tx : 1 - tx) * (j ? tz : 1 - tz);
      }
    return c.still ? depth <= 0 : depth < 0.003;
  }
  private fftNormal(x: number, z: number): [number, number, number] {
    const f = this.fft!,
      n = f.resolution,
      normal = [0, 1, 0];
    for (let c = 0; c < f.lengths.length; c++) {
      const px = (x / f.lengths[c]) * n,
        pz = (z / f.lengths[c]) * n,
        ix = Math.floor(px),
        iz = Math.floor(pz),
        tx = px - ix,
        tz = pz - iz;
      for (let channel = 0; channel < 3; channel++) {
        let value = 0;
        for (let j = 0; j < 2; j++)
          for (let i = 0; i < 2; i++) {
            const a = (((ix + i) % n) + n) % n,
              b = (((iz + j) % n) + n) % n;
            value += f.data[(c * n * n + b * n + a) * 12 + 8 + channel] * (i ? tx : 1 - tx) * (j ? tz : 1 - tz);
          }
        normal[channel] += value - (channel === 1 ? 1 : 0);
      }
    }
    return unit(normal);
  }
}
