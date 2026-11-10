// Optional consumers rasterize the source's submitted geometry, never another simulation.
import { queryStates, type QueryState } from './query-state.js';
import { fault } from '../../shared/errors.js';
import { applyView } from '../../shared/view-rect.js';
import type { PassContext } from '@margoengine/core/extension';
type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number };

export class SurfaceCapture {
  private token?: GPUBuffer;
  private coordinates?: GPUBuffer;
  private pipelines: GPURenderPipeline[] = [];

  draw(c: Context, source: object, uniform: GPUBuffer, targets: GPUTexture[], depths: GPUTexture[]): void {
    const state = queryStates.get(source)?.();
    if (!state || state.device !== c.device)
      throw fault('state', 'Surface capture needs a live Water or FFTOcean rendered on the same device before composition');
    if (this.token !== state.token) this.build(c.device, state);
    const resources =
      state.kind === 'water'
        ? [
            { binding: 0, resource: { buffer: state.token } },
            { binding: 3, resource: state.resources![3] },
            { binding: 7, resource: state.resources![7] },
          ]
        : [
            { binding: 0, resource: { buffer: state.token } },
            { binding: 1, resource: { buffer: state.field! } },
          ];
    for (let i = 0; i < 3; i++) {
      const pipeline = this.pipelines[i];
      const first = c.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: resources });
      const second = c.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          ...(this.coordinates ? [{ binding: 1, resource: { buffer: this.coordinates } }] : []),
        ],
      });
      const pass = c.encoder.beginRenderPass({
        colorAttachments: [
          { view: targets[i].createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
        depthStencilAttachment: {
          view: depths[i].createView(),
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
          depthClearValue: 0,
        },
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, first);
      pass.setBindGroup(1, second);
      if (i === 0) applyView(pass, c);
      pass.draw(state.segments * state.segments * (i === 0 ? 6 : 12));
      pass.end();
    }
  }

  private build(device: GPUDevice, state: QueryState): void {
    this.dispose();
    this.token = state.token;
    if (state.positions) {
      this.coordinates = device.createBuffer({
        size: state.positions.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.coordinates, 0, state.positions as Float32Array<ArrayBuffer>);
    }
    const cells = state.segments;
    const water = state.kind === 'water';
    const code =
      state.shader +
      `
@group(1) @binding(0) var<uniform> capture:array<vec4f,20>;
${water ? '@group(1) @binding(1) var<storage,read> coords:array<f32>;' : ''}
struct CaptureVertex { @builtin(position) clip:vec4f, @location(0) world:vec3f, @location(1) normal:vec3f, @location(2) base:vec2f }
fn evaluate(id:u32)->CaptureVertex {
 let cell=id/6u;let corner=array<vec2u,6>(vec2u(0,0),vec2u(0,1),vec2u(1,0),vec2u(1,0),vec2u(0,1),vec2u(1,1))[id%6u];
 let grid=vec2u(cell%${cells}u,cell/${cells}u)+corner;let index=grid.y*${cells + 1}u+grid.x;
 ${
   water
     ? `var base=vec2f(coords[index*3u],coords[index*3u+1u]);if(HORIZON){base+=frame.grid.xy;}
 let wave=surface(base,coords[index*3u+2u]);let world=wave.position;let normal=wave.normal;`
     : `let base=vec2f(grid)/f32(${cells})*frame.grid.xy-frame.grid.xy*0.5+frame.water.zw;
 let wave=oceanAt(base);let world=vec3f(base.x,frame.water.x,base.y)+wave.displacement;let normal=wave.normal;`
 }
 return CaptureVertex(vec4f(0),world,normal,base);
}
fn dry(base:vec2f)->bool {${water ? 'if(inCoast(base)){let s=coastal(base);return select(s.water.x<0.003,s.edge<=0.0,STILL);} ' : ''}return false;}
// FFT's draw samples the spectral normal at the interpolated base in the fragment stage.
fn stableNormal(normal:vec3f)->vec3f {let scale=max(abs(normal.x),max(abs(normal.y),abs(normal.z)));let n=normal/scale;return n/sqrt(dot(n,n));}
fn captureNormal(base:vec2f,normal:vec3f)->vec3f {return ${water ? 'stableNormal(normal)' : 'oceanAt(base).normal'};}
@vertex fn maskVertex(@builtin(vertex_index) id:u32)->CaptureVertex {
 var v=evaluate(id);v.clip=frame.camera*vec4f(v.world,1);
 // Keep interfaces in front of the eye even inside the camera near plane.
 v.clip.z=v.clip.w*0.5;return v;
}
struct FieldVertex {
 @builtin(position) clip:vec4f,
 @location(0) @interpolate(flat) a:vec4f,@location(1) @interpolate(flat) b:vec4f,@location(2) @interpolate(flat) c:vec4f,
 @location(3) @interpolate(flat) baseY:vec3f,
 @location(4) @interpolate(flat) na:vec3f,@location(5) @interpolate(flat) nb:vec3f,@location(6) @interpolate(flat) nc:vec3f
}
fn rectangle(id:u32,extent:f32,resolution:f32)->FieldVertex {
 let triangle=id/6u*3u;let a=evaluate(triangle);let b=evaluate(triangle+1u);let c=evaluate(triangle+2u);
 let pad=vec2f(2.0*extent/resolution);
 let low=min(a.world.xz,min(b.world.xz,c.world.xz))-pad;let high=max(a.world.xz,max(b.world.xz,c.world.xz))+pad;
 let corner=array<vec2f,6>(vec2f(0,0),vec2f(0,1),vec2f(1,0),vec2f(1,0),vec2f(0,1),vec2f(1,1))[id%6u];
 let clip=vec4f((mix(low,high,corner)-capture[8].xz)/extent*vec2f(1,-1),0.5,1);
 return FieldVertex(clip,vec4f(a.world,a.base.x),vec4f(b.world,b.base.x),vec4f(c.world,c.base.x),vec3f(a.base.y,b.base.y,c.base.y),a.normal,b.normal,c.normal);
}
@vertex fn fieldVertex(@builtin(vertex_index) id:u32)->FieldVertex {return rectangle(id,capture[12].w,capture[18].x);}
@vertex fn probeVertex(@builtin(vertex_index) id:u32)->FieldVertex {return rectangle(id,0.005,1.0);}
struct CaptureResult { @location(0) value:vec4f, @builtin(frag_depth) depth:f32 }
@fragment fn maskFragment(v:CaptureVertex,@builtin(front_facing) front:bool)->CaptureResult {
 if(dry(v.base)){discard;}
 let inverse=mat4x4f(capture[4],capture[5],capture[6],capture[7]);
 let xy=(v.clip.xy-capture[14].xy)/capture[14].zw*vec2f(2,-2)+vec2f(-1,1);
 let near=inverse*vec4f(xy,1,1);let far=inverse*vec4f(xy,0.000001,1);
 let ray=normalize(far.xyz/far.w-near.xyz/near.w);
 let distance=dot(v.world-capture[8].xyz,ray);return CaptureResult(vec4f(captureNormal(v.base,v.normal),select(-distance,distance,front)),1.0/(1.0+max(0.0,distance)));
}
fn fieldSample(v:FieldVertex,xz:vec2f)->CaptureResult {
 let a=v.a.xz-xz;let b=v.b.xz-xz;let c=v.c.xz-xz;
 var weights=vec3f(b.x*c.y-b.y*c.x,c.x*a.y-c.y*a.x,a.x*b.y-a.y*b.x);
 if(any(weights<vec3f(0))&&any(weights>vec3f(0))){discard;}
 let det=weights.x+weights.y+weights.z;if(det==0.0){discard;}weights/=det;
 let base=vec2f(dot(weights,vec3f(v.a.w,v.b.w,v.c.w)),dot(weights,v.baseY));
 if(dry(base)){discard;}
 let height=dot(weights,vec3f(v.a.y,v.b.y,v.c.y));
 let normal=captureNormal(base,v.na*weights.x+v.nb*weights.y+v.nc*weights.z);
 return CaptureResult(vec4f(normal,height),0.5+atan(height-capture[8].y)/3.14159265359);
}
@fragment fn fieldFragment(v:FieldVertex)->CaptureResult {return fieldSample(v,(v.clip.xy/capture[18].x*2.0-1.0)*capture[12].w+capture[8].xz);}
@fragment fn probeFragment(v:FieldVertex)->CaptureResult {return fieldSample(v,capture[8].xz);}
`;
    const module = device.createShaderModule({ code });
    this.pipelines = ['mask', 'field', 'probe'].map((kind) =>
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: kind + 'Vertex' },
        fragment: {
          module,
          entryPoint: kind + 'Fragment',
          targets: [{ format: 'rgba32float' }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthCompare: 'greater', depthWriteEnabled: true },
      }),
    );
  }
  dispose(): void {
    this.coordinates?.destroy();
    this.coordinates = this.token = undefined;
    this.pipelines = [];
  }
}
