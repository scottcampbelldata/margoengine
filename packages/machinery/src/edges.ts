import {PbrMaterial,type Engine,type EnginePlugin,type FrameGraph,type PassContext,type Geometry,type Mesh} from '@margoengine/core/extension';
import {edgesGeometry} from '@margoengine/geometry';
import {declaration} from './section-uniform.js';
declare const GPUBufferUsage:{UNIFORM:number;STORAGE:number;COPY_DST:number;INDIRECT:number};
declare const GPUShaderStage:{VERTEX:number;FRAGMENT:number};
type GPUContext=Extract<PassContext,{backend:'webgpu'}>;
const SECTION=/var<uniform> section:Section;/,SECTION_BINDING=/@group\(0\) @binding\((\d+)\) var<uniform> section:Section;/;
// edges[0..3]: the geometry bounding sphere, then index pairs. instances: the core's per-geometry instance buffer (24 floats per slot).
const common=`struct Frame {camera:mat4x4f,viewport:vec4f,color:vec4f,lod:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(2) var<storage,read> edges:array<u32>;
@group(0) @binding(3) var<storage,read> instances:array<vec4f>;
fn model(n:u32)->mat4x4f {return mat4x4f(instances[n*6u],instances[n*6u+1u],instances[n*6u+2u],instances[n*6u+3u]);}
`;
// One thread per visible part: keep parts whose bounding sphere projects to at least lod.x pixels (viewport.w: projection y scale in
// pixels) and append their slot to list; args is the indirect draw [vertices, instances, 0, 0] plus the slot count in args[4].
const cull=common+`@group(0) @binding(5) var<storage,read_write> list:array<u32>;
@group(0) @binding(6) var<storage,read_write> args:array<atomic<u32>,5>;
@compute @workgroup_size(64) fn cull(@builtin(global_invocation_id) id:vec3u) {
 let n=id.x;if(n>=atomicLoad(&args[4])){return;}let m=model(n);let sphere=bitcast<vec4f>(vec4u(edges[0],edges[1],edges[2],edges[3]));let center=frame.camera*(m*vec4f(sphere.xyz,1));
 let scale=max(max(length(m[0].xyz),length(m[1].xyz)),length(m[2].xyz));if(center.w>0&&sphere.w*scale*frame.viewport.w<frame.lod.x*center.w){return;}list[atomicAdd(&args[1],1u)]=n;
}`;
// Six vertices per segment; instance_index walks the culled list. Segments under lod.y pixels on screen (sub-pixel hole rims) are dropped.
const shader=(section:boolean)=>(section?declaration(4):'')+common+`@group(0) @binding(1) var<storage,read> vertices:array<f32>;
@group(0) @binding(5) var<storage,read> list:array<u32>;
struct Output {@builtin(position) clip:vec4f,@location(0) position:vec3f,@location(1) edge:f32}
fn point(v:u32,model:mat4x4f)->vec4f {return model*vec4f(vertices[v*6u],vertices[v*6u+1u],vertices[v*6u+2u],1);}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) i:u32)->Output {
 var o:Output;o.clip=vec4f(2,2,2,1);o.edge=0;let e=v/6u;let k=v%6u;let m=model(list[i]);
 var wa=point(edges[4u+e*2u],m);var wb=point(edges[5u+e*2u],m);var ca=frame.camera*wa;var cb=frame.camera*wb;
 let fa=ca.w-ca.z;let fb=cb.w-cb.z;if(fa<0&&fb<0){return o;}
 if(fa<0){let t=fa/(fa-fb);ca=mix(ca,cb,t);wa=mix(wa,wb,t);}else if(fb<0){let t=fb/(fb-fa);cb=mix(cb,ca,t);wb=mix(wb,wa,t);}
 let half=frame.viewport.xy*0.5;let sa=ca.xy/ca.w*half;let sb=cb.xy/cb.w*half;let d=sb-sa;let length=length(d);if(length<max(frame.lod.y,1e-5)){return o;}let dir=d/length;
 let atB=k==2u||k==4u||k==5u;let side=select(-1.0,1.0,k==1u||k==2u||k==4u);let w=frame.viewport.z+1;
 let c=select(ca,cb,atB);let offset=vec2f(-dir.y,dir.x)*side*w+dir*select(-w,w,atB)*0.5;
 o.clip=vec4f(c.xy+offset/half*c.w,c.z,c.w);o.position=select(wa,wb,atB).xyz;o.edge=side*w;return o;
}
@fragment fn fragment(i:Output)->@location(0) vec4f {
${section?' for(var p=0u;p<u32(section.settings.x);p++){if(dot(section.planes[p].xyz,i.position)+section.planes[p].w<0){discard;}}\n':''} let cover=clamp(frame.viewport.z+0.5-abs(i.edge),0.0,1.0);return vec4f(frame.color.rgb,frame.color.a*cover);
}`;

export interface FeatureEdgeOptions {
  /** Dihedral angle in degrees above which a shared edge is drawn; open (boundary) edges are always drawn. Default 30. */
  angle?:number;
  /** Line width in CSS pixels, constant on screen. Default 1.5. */
  width?:number;
  color?:string|readonly number[];
  /** Hardware depth bias (depth32float units) pulling lines toward the camera so they never z-fight their own faces. Default 256. */
  depthBias?:number;
  /** Parts whose bounding sphere projects to a radius below this many CSS pixels draw no edges, keeping distant overviews clean and cheap. Default 6; 0 draws all. */
  minRadius?:number;
  /** Frame graph order: after the scene (0) and section caps (5). Default 6. */
  order?:number;
}
interface Shape {edges:Uint32Array;segments:number;buffer?:GPUBuffer;list?:GPUBuffer;args?:GPUBuffer;group?:GPUBindGroup;sectionGroup?:GPUBindGroup;cullGroup?:GPUBindGroup;instance?:GPUBuffer;section?:GPUBuffer;meshes:Mesh[];count:number}

/** CAD feature lines: per distinct geometry, dihedral-angle edges built once and drawn instanced with the parts' own core instance data. */
export function featureEdges(geometry:Geometry,angle=30):Uint32Array {
  if(!Number.isFinite(angle)||angle<0||angle>180)throw new RangeError('Invalid feature angle');const v=geometry.vertices,positions=new Float32Array(v.length/2);
  for(let i=0,j=0;i<v.length;i+=6,j+=3){positions[j]=v[i];positions[j+1]=v[i+1];positions[j+2]=v[i+2];}
  return edgesGeometry({positions,normals:positions,uvs:new Float32Array(0),indices:geometry.indices},angle);
}

/**
 * Draws crisp feature/crease edges for every mesh in the engine. Edges are computed once per distinct geometry and drawn with one
 * instanced draw per geometry, reading the transforms, culling and visibility the core already uploaded for that geometry's parts,
 * so exploded views and hidden parts need no extra work. Works with orthographic cameras and clips against SectionPlanes.
 * Call refresh() after replacing meshes without changing the mesh count, or after setGeometry.
 */
export class FeatureEdges implements EnginePlugin {
  readonly name='feature-edges';/** Latest frame. segments and instances count visible parts before the on-screen size test. */
  readonly stats={geometries:0,segments:0,instances:0,drawCalls:0};
  private engine?:Engine;private readonly shapes=new Map<Geometry,Shape>();private size=-1;private uniform?:GPUBuffer;
  private readonly frame=new Float32Array(28);private readonly minRadius:number;private readonly color:Float32Array;private readonly angle:number;private readonly width:number;private readonly bias:number;private readonly order:number;
  private readonly pipelines=new Map<string,GPURenderPipeline>();private cull?:GPUComputePipeline;private readonly drawn:[Shape,GPUBindGroup][]=[];private readonly argsData=new Uint32Array(5);private layouts?:{plain:GPUBindGroupLayout;section:GPUBindGroupLayout};
  private readonly colorAttachment:GPURenderPassColorAttachment={view:undefined!,loadOp:'load',storeOp:'store'};
  private readonly descriptor:GPURenderPassDescriptor={colorAttachments:[this.colorAttachment],depthStencilAttachment:{view:undefined!,depthReadOnly:true,stencilReadOnly:true}};
  constructor({angle=30,width=1.5,color='#14181d',depthBias=256,minRadius=6,order=6}:FeatureEdgeOptions={}){
    if(!Number.isFinite(angle)||angle<0||angle>180||!(width>0&&width<=64)||!Number.isInteger(depthBias)||depthBias<0||!(minRadius>=0&&minRadius<1e6)||!Number.isFinite(order))throw new RangeError('Invalid feature edge options');
    this.angle=angle;this.width=width;this.bias=depthBias;this.order=order;this.minRadius=minRadius;this.color=new PbrMaterial({color}).data.slice(0,4);
  }
  setup(engine:Engine):void {if(!engine.gpu)throw new Error('FeatureEdges requires WebGPU');this.engine=engine;const device=engine.gpu,storage=(binding:number):GPUBindGroupLayoutEntry=>({binding,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}}),entries=[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform' as const}},storage(1),storage(2),storage(3),storage(5)];
    this.layouts={plain:device.createBindGroupLayout({entries}),section:device.createBindGroupLayout({entries:[...entries,{binding:4,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}}]})};this.uniform=device.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const module=device.createShaderModule({code:cull});this.cull=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'cull'}});}
  registerPasses(graph:FrameGraph):void {graph.add({name:'feature-edges:draw',order:this.order,execute:context=>{if(context.backend==='webgpu')this.draw(context);}});}
  /** Re-scan engine meshes; automatic when the mesh count changes. */
  refresh():void {this.size=-1;}
  private scan(engine:Engine):void {
    for(const shape of this.shapes.values())shape.meshes.length=0;
    for(const mesh of engine.meshes.values()){const geometry=mesh.geometry;if(!geometry)continue;let shape=this.shapes.get(geometry);if(!shape){const edges=featureEdges(geometry,this.angle);shape={edges,segments:edges.length/2,meshes:[],count:0};this.shapes.set(geometry,shape);}shape.meshes.push(mesh);}
    for(const [geometry,shape] of this.shapes)if(!shape.meshes.length){this.release(shape);this.shapes.delete(geometry);}
    this.size=engine.meshes.size;this.stats.geometries=this.shapes.size;
  }
  private draw(context:GPUContext):void {
    const engine=this.engine!,device=context.device,stats=this.stats;stats.segments=stats.instances=stats.drawCalls=0;if(device!==engine.gpu)return;
    if(engine.meshes.size!==this.size)this.scan(engine);
    const visible=engine.store.visible,section=SECTION.test(context.shader)?context.bindings.find(b=>b.binding===+SECTION_BINDING.exec(context.shader)![1])?.resource as GPUBufferBinding|undefined:undefined,drawn=this.drawn,args=this.argsData;drawn.length=0;let compute:GPUComputePassEncoder|undefined;
    for(const [geometry,shape] of this.shapes){
      // Same rule as the core's batch collection: a slot per visible mesh with this geometry, in the same order.
      let count=0;const meshes=shape.meshes;for(let i=0;i<meshes.length;i++){const mesh=meshes[i];if(mesh.geometry===geometry&&visible[mesh.id])count++;}
      if(!count||!shape.segments)continue;const buffers=engine.geometryBuffers(geometry)!,instance=buffers.instance;count=Math.min(count,instance.size/96);
      if(!shape.buffer){shape.buffer=device.createBuffer({size:16+shape.edges.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(shape.buffer,0,geometry.bounds as Float32Array<ArrayBuffer>);device.queue.writeBuffer(shape.buffer,16,shape.edges as Uint32Array<ArrayBuffer>);shape.args=device.createBuffer({size:20,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST});}
      if(shape.instance!==instance){shape.instance=instance;shape.list?.destroy();shape.list=device.createBuffer({size:instance.size/24,usage:GPUBufferUsage.STORAGE});shape.group=shape.sectionGroup=shape.cullGroup=undefined;}
      const entries=[{binding:0,resource:{buffer:this.uniform!}},{binding:1,resource:{buffer:buffers.vertex}},{binding:2,resource:{buffer:shape.buffer}},{binding:3,resource:{buffer:instance}},{binding:5,resource:{buffer:shape.list!}}];
      if(section&&shape.section!==section.buffer){shape.section=section.buffer;shape.sectionGroup=undefined;}
      const group=section?shape.sectionGroup??=device.createBindGroup({layout:this.layouts!.section,entries:[...entries,{binding:4,resource:section}]}):shape.group??=device.createBindGroup({layout:this.layouts!.plain,entries});
      shape.cullGroup??=device.createBindGroup({layout:this.cull!.getBindGroupLayout(0),entries:[entries[0],entries[2],entries[3],entries[4],{binding:6,resource:{buffer:shape.args!}}]});
      args[0]=shape.segments*6;args[4]=count;device.queue.writeBuffer(shape.args!,0,args);
      if(!compute){this.upload(context);compute=context.encoder.beginComputePass();compute.setPipeline(this.cull!);}
      compute.setBindGroup(0,shape.cullGroup);compute.dispatchWorkgroups(Math.ceil(count/64));drawn.push([shape,group]);stats.segments+=shape.segments*count;stats.instances+=count;
    }
    if(!compute)return;compute.end();
    this.colorAttachment.view=context.color;this.descriptor.depthStencilAttachment!.view=context.depth;const pass=context.encoder.beginRenderPass(this.descriptor);pass.setPipeline(this.pipeline(context,!!section));
    for(const [shape,group] of drawn){pass.setBindGroup(0,group);pass.drawIndirect(shape.args!,0);stats.drawCalls++;}
    pass.end();drawn.length=0;
  }
  private release(shape:Shape):void {shape.buffer?.destroy();shape.list?.destroy();shape.args?.destroy();shape.buffer=shape.list=shape.args=shape.instance=shape.group=shape.sectionGroup=shape.cullGroup=undefined;}
  private upload(context:GPUContext):void {
    const f=this.frame,canvas=this.engine!.canvas,encode=!context.format.endsWith('-srgb')&&!context.format.includes('float');f.set(context.camera.matrix);f[16]=context.width;f[17]=context.height;const ratio=canvas.clientWidth?context.width/canvas.clientWidth:1,m=context.camera.matrix;f[18]=this.width*ratio/2;f[19]=Math.hypot(m[1],m[5],m[9])*context.height/2;f[24]=this.minRadius*ratio;f[25]=this.minRadius?0.5:0;
    for(let c=0;c<3;c++){const v=Math.min(1,this.color[c]);f[20+c]=encode?(v<=0.0031308?v*12.92:1.055*v**(1/2.4)-0.055):v;}f[23]=this.color[3];context.device.queue.writeBuffer(this.uniform!,0,f);
  }
  private pipeline(context:GPUContext,section:boolean):GPURenderPipeline {
    const depth=context.descriptor.depthStencil!.format,count=context.descriptor.multisample?.count??1,key=`${context.format}|${depth}|${count}|${section}`;let pipeline=this.pipelines.get(key);
    if(!pipeline){const device=context.device,module=device.createShaderModule({code:shader(section)});
      pipeline=device.createRenderPipeline({layout:device.createPipelineLayout({bindGroupLayouts:[section?this.layouts!.section:this.layouts!.plain]}),vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:context.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'}}}]},
        primitive:{topology:'triangle-list',cullMode:'none'},multisample:{count},depthStencil:{format:depth,depthWriteEnabled:false,depthCompare:'greater-equal',depthBias:this.bias,depthBiasSlopeScale:1}});this.pipelines.set(key,pipeline);}
    return pipeline;
  }
  onDeviceRestored(engine:Engine):void {this.dispose();this.setup(engine);}
  dispose():void {for(const shape of this.shapes.values())this.release(shape);this.shapes.clear();this.uniform?.destroy();this.uniform=this.layouts=this.engine=this.cull=undefined;this.pipelines.clear();this.size=-1;}
}
