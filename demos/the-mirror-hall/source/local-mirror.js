import {buildBVH} from '@margoengine/bvh';
import {Matrix4} from '@margoengine/math/matrix4';
import {Quaternion} from '@margoengine/math/quaternion';
import {opticalItems,mirrorPlane} from './gallery.js';

export function prepareMirror(){
  const items=opticalItems();
  const vertexCount=items.reduce((size,item)=>size+item.geometry.vertices.length/6,0);
  const indexCount=items.reduce((size,item)=>size+item.geometry.indices.length,0);
  const positions=new Float32Array(vertexCount*3),indices=new Uint32Array(indexCount);
  const surfaces=new Float32Array(indexCount/3*8);
  const matrix=new Matrix4(),rotation=new Quaternion();
  const vector=([x,y,z])=>({x,y,z});
  let vertex=0,offset=0;
  for(const item of items){
    const {geometry,appearance}=item;
    rotation.setFromEuler({...vector(item.rotation),order:'XYZ'});
    const m=matrix.compose(vector(item.position),rotation,vector(item.scale)).elements;
    const verts=geometry.vertices,start=vertex/3;
    for(let i=0;i<verts.length;i+=6){
      const x=verts[i],y=verts[i+1],z=verts[i+2];
      positions[vertex++]=m[0]*x+m[4]*y+m[8]*z+m[12];
      positions[vertex++]=m[1]*x+m[5]*y+m[9]*z+m[13];
      positions[vertex++]=m[2]*x+m[6]*y+m[10]*z+m[14];
    }
    const {color,roughness,metalness}=appearance.optical;
    const g=geometry.indices;
    for(let i=0;i<g.length;i+=3){
      const a=(start+g[i])*3,b=(start+g[i+1])*3,c=(start+g[i+2])*3;
      const ux=positions[b]-positions[a],uy=positions[b+1]-positions[a+1],uz=positions[b+2]-positions[a+2];
      const vx=positions[c]-positions[a],vy=positions[c+1]-positions[a+1],vz=positions[c+2]-positions[a+2];
      const at=offset/3*8;
      surfaces[at]=uy*vz-uz*vy;
      surfaces[at+1]=uz*vx-ux*vz;
      surfaces[at+2]=ux*vy-uy*vx;
      surfaces[at+3]=roughness;
      surfaces[at+4]=color[0];surfaces[at+5]=color[1];surfaces[at+6]=color[2];surfaces[at+7]=metalness;
      indices[offset++]=start+g[i];
      indices[offset++]=start+g[i+1];
      indices[offset++]=start+g[i+2];
    }
  }
  const source=buildBVH(positions,3,indices);
  const words=new Uint32Array(source.nodes),bounds=new Float32Array(source.nodes);
  const nodes=new ArrayBuffer(words.length*4);
  const nodeWords=new Uint32Array(nodes),nodeBounds=new Float32Array(nodes);
  const count=words.length/8;
  function thread(node,escape){
    const i=node*8, internal=(words[i+7]&0x80000000)!==0;
    nodeBounds.set(bounds.subarray(i,i+3),i);
    nodeWords[i+3]=escape;
    nodeBounds.set(bounds.subarray(i+3,i+6),i+4);
    if(internal){
      const right=words[i+6];
      thread(node+1,right);
      thread(right,escape);
    }else{
      const first=words[i+6],size=words[i+7];
      if(first>0x00ffffff||size>255)throw new RangeError('Mirror BVH leaf does not fit its compact record.');
      nodeWords[i+7]=(first<<8)|size;
    }
  }
  thread(0,count);
  const triangles=new Float32Array(source.triangles.length*20);
  for(let i=0;i<source.triangles.length;i++){
    const out=i*20,a=source.index[i*3]*3,b=source.index[i*3+1]*3,c=source.index[i*3+2]*3;
    for(let axis=0;axis<3;axis++){
      const first=positions[a+axis];
      triangles[out+axis]=first;
      triangles[out+4+axis]=positions[b+axis]-first;
      triangles[out+8+axis]=positions[c+axis]-first;
    }
    const face=source.triangles[i]*8;
    triangles.set(surfaces.subarray(face,face+8),out+12);
  }
  return {nodes,triangles,instances:items.length};
}

const shader=/* wgsl */`
struct View {
  inverse:mat4x4f,
  eye:vec4f,
  sun:vec4f,
  radiance:vec4f,
  ambient:vec4f,
  mirrorColour:vec4f,
  bounds:vec4f
}
struct Node { low:vec3f, escape:u32, high:vec3f, leaf:u32 }
struct Triangle {
  origin:vec4f,
  edgeA:vec4f,
  edgeB:vec4f,
  normalRoughness:vec4f,
  colorMetalness:vec4f,
}
struct Hit { distance:f32, triangle:u32 }
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var<storage,read> nodes:array<Node>;
@group(0) @binding(3) var<storage,read> triangles:array<Triangle>;

fn triangleDistance(index:u32,origin:vec3f,direction:vec3f,limit:f32)->f32 {
  let t=triangles[index];
  let p=cross(direction,t.edgeB.xyz);
  let determinant=dot(t.edgeA.xyz,p);
  if(abs(determinant)<0.00000001){return limit;}
  let towardsOrigin=origin-t.origin.xyz;
  let q=cross(towardsOrigin,t.edgeA.xyz);
  let bary=vec2f(dot(towardsOrigin,p),dot(direction,q))/determinant;
  if(min(bary.x,bary.y)<0.0||bary.x+bary.y>1.0){return limit;}
  let distance=dot(t.edgeB.xyz,q)/determinant;
  return select(limit,distance,distance>0.0&&distance<limit);
}

// Depth-first skip links remove the per-ray stack. Every accepted leaf can
// lower the nearest distance, and nodes beyond that distance are skipped.
fn nearest(origin:vec3f,direction:vec3f)->Hit {
  let parallel=abs(direction)<vec3f(0.00000001);
  let inverse=1.0/select(direction,vec3f(1),parallel);
  let count=u32(view.eye.w);
  var result=Hit(21.0,0xffffffffu);
  var index=0u;
  loop {
    if(index>=count){break;}
    let node=nodes[index];
    let first=(node.low-origin)*inverse;
    let second=(node.high-origin)*inverse;
    let enter=select(min(first,second),vec3f(-1e9),parallel);
    let leave=select(max(first,second),vec3f(1e9),parallel);
    let outside=any(select(vec3<bool>(false),origin<node.low,parallel))
      ||any(select(vec3<bool>(false),origin>node.high,parallel));
    let far=min(leave.x,min(leave.y,leave.z));
    let near=max(enter.x,max(enter.y,enter.z));
    if(outside||max(near,0.0)>min(far,result.distance)){
      index=node.escape;
      continue;
    }
    if(node.leaf==0u){
      index+=1u;
      continue;
    }
    let firstTriangle=node.leaf>>8u;
    let end=firstTriangle+(node.leaf&255u);
    for(var item=firstTriangle;item<end;item+=1u){
      let distance=triangleDistance(item,origin,direction,result.distance);
      if(distance<result.distance){result=Hit(distance,item);}
    }
    index=node.escape;
  }
  return result;
}

@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let x=f32((i<<1u)&2u);
  let y=f32(i&2u);
  return vec4f(2.0*x-1.0,1.0-2.0*y,0.0,1.0);
}

fn radiance(face:Triangle,v:vec3f)->vec3f {
  let gn=normalize(face.normalRoughness.xyz);
  let n=select(-gn,gn,dot(gn,v)>=0.0);
  let l=view.sun.xyz;
  let h=normalize(l+v);
  let nv=max(dot(n,v),0.0001);
  let nl=max(dot(n,l),0.0);
  let nh=max(dot(n,h),0.0);
  let vh=max(dot(v,h),0.0);
  let fc=face.colorMetalness.rgb;
  let metal=face.colorMetalness.a;
  let rough=face.normalRoughness.a;
  let a2=rough*rough*rough*rough;
  let crossNH=cross(n,h);
  let q=max(dot(crossNH,crossNH),step(nh,0.0))+a2*nh*nh;
  let distribution=a2/(3.14159265*q*q);
  let smith=0.5/max(nl*sqrt(a2+(1.0-a2)*nv*nv)+nv*sqrt(a2+(1.0-a2)*nl*nl),0.00001);
  let glancing=1.0-vh;
  let fifth=glancing*glancing*glancing*glancing*glancing;
  let specular=mix(mix(vec3f(0.04),fc,metal),vec3f(1),fifth);
  let diffuse=fc*(1.0-metal)*(1.0-fifth)*(0.96/3.14159265);
  return (diffuse+distribution*smith*specular)*nl*view.radiance.rgb*view.sun.w
      +fc*(1.0-metal)*view.radiance.w*view.ambient.rgb;
}

fn display(colour:vec3f)->vec3f {
  let x=min(colour.r,min(colour.g,colour.b));
  let toe=select(0.04,x-x*x/0.16,x<=0.08);
  var neutral=colour-toe;
  let peak=max(neutral.r,max(neutral.g,neutral.b));
  if(peak>0.76){
    let upper=1.0-0.0576/(peak-0.52);
    let keep=1.0/(1.0+0.15*(peak-upper));
    neutral=mix(vec3f(upper),neutral*(upper/peak),keep);
  }
  return select(neutral*12.92,1.055*pow(neutral,vec3f(1.0/2.4))-0.055,neutral>=vec3f(0.0031308));
}

@fragment fn fragment(@builtin(position) pixel:vec4f)->@location(0) vec4f {
  let samplePixel=vec2i(pixel.xy);
  let depthValue=textureLoad(depth,samplePixel,0);
  if(depthValue<=0.0){discard;}
  let uv=pixel.xy/vec2f(textureDimensions(depth));
  let at=view.inverse*vec4f(2.0*uv.x-1.0,1.0-2.0*uv.y,depthValue,1.0);
  let floorPoint=at.xyz/at.w;
  if(abs(floorPoint.y-view.bounds.x)>0.0022 || abs(floorPoint.x)>view.bounds.y ||
      floorPoint.z<view.bounds.z || floorPoint.z>view.bounds.w){discard;}
  let incident=normalize(floorPoint-view.eye.xyz);
  let ray=vec3f(incident.x,-incident.y,incident.z);
  let start=vec3f(floorPoint.x,view.bounds.x+0.013,floorPoint.z);
  let hit=nearest(start,ray);
  if(hit.triangle==0xffffffffu){discard;}
  let g=1.0-clamp(ray.y,0.0,1.0);
  let fresnel=mix(view.mirrorColour.rgb,vec3f(1),g*g*g*g*g);
  let reflected=display(radiance(triangles[hit.triangle],-ray)*fresnel);
  return vec4f(reflected,1.0-smoothstep(16.8,21.0,hit.distance));
}
`;

export function localMirror(model){
  let device,nodes,triangles,uniform,pipeline,group,lastDepth,ready;
  const matrix=new Matrix4(),data=new Float32Array(40);
  function release(){
    nodes?.destroy();
    triangles?.destroy();
    uniform?.destroy();
    nodes=triangles=uniform=pipeline=group=lastDepth=undefined;
  }
  function setup(engine){
    device=engine.gpu;
    const storage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST;
    nodes=device.createBuffer({size:model.nodes.byteLength,usage:storage});
    triangles=device.createBuffer({size:model.triangles.byteLength,usage:storage});
    device.queue.writeBuffer(nodes,0,model.nodes);
    device.queue.writeBuffer(triangles,0,model.triangles);
    uniform=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    data[19]=model.nodes.byteLength/32;
    data.set(mirrorPlane.color,32);
    data.set(mirrorPlane.bounds,36);
    const source=device.createShaderModule({code:shader});
    const blend={color:{operation:'add',srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},
      alpha:{operation:'add',srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
    const descriptor={
      layout:'auto',vertex:{module:source,entryPoint:'vertex'},
      fragment:{module:source,entryPoint:'fragment',targets:[{format:'rgba8unorm',blend}]},
    };
    const current=device;
    ready=device.createRenderPipelineAsync(descriptor).then(result=>{
      if(device===current&&uniform)pipeline=result;
      performance.mark('mirror-ray-pipeline-ready');
    });
  }
  return {
    name:'planar-specular-rays',
    setup,
    get ready(){return ready;},
    onDeviceRestored(engine){
      release();
      setup(engine);
      ready.catch(error=>engine.onError(error));
    },
    dispose:release,
    registerPasses(graph){
      graph.add({
        name:'trace-visible-mirror',
        order:2,
        execute(context){
          const depth=context.view?.target?.depth;
          if(!depth)throw new Error('The mirror needs sampleable scene depth.');
          if(!pipeline)return;
          if(depth!==lastDepth){
            group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
              {binding:0,resource:{buffer:uniform}},{binding:1,resource:depth.createView({aspect:'depth-only'})},
              {binding:2,resource:{buffer:nodes}},{binding:3,resource:{buffer:triangles}},
            ]});
            lastDepth=depth;
          }
          matrix.fromArray(context.camera.matrix).invert().toArray(data);
          data.set(context.camera.position,16);
          data.set(mirrorPlane.sun,20);
          data.set(mirrorPlane.radiance,24);
          data.set(mirrorPlane.ambient,28);
          device.queue.writeBuffer(uniform,0,data);
          const pass=context.encoder.beginRenderPass({colorAttachments:[{
            view:context.color,loadOp:'load',storeOp:'store',
          }]});
          pass.setPipeline(pipeline);
          pass.setBindGroup(0,group);
          pass.draw(3);
          pass.end();
        },
      });
    },
  };
}
