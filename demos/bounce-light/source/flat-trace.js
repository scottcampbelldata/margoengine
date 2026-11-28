import {buildBVH} from '@margoengine/bvh';
import {SSGI} from '@margoengine/post/ssgi';

export function flattenRoom(room){
  const vertices=room.reduce((n,{geometry})=>n+geometry.vertices.length/6,0);
  const indices=room.reduce((n,{geometry})=>n+geometry.indices.length,0);
  const positions=new Float32Array(vertices*3),corners=new Uint32Array(indices);
  const faces=new Uint32Array(indices/3),surfaces=new Float32Array(room.length*8);
  let v=0,i=0;
  room.forEach(({geometry,surface},id)=>{
    const origin=v/3,values=geometry.vertices;
    for(let at=0;at<values.length;at+=6){
      positions[v++]=values[at];
      positions[v++]=values[at+1];
      positions[v++]=values[at+2];
    }
    for(let a=0;a<geometry.indices.length;a+=3){
      faces[i/3]=id;
      corners[i++]=origin+geometry.indices[a];
      corners[i++]=origin+geometry.indices[a+1];
      corners[i++]=origin+geometry.indices[a+2];
    }
    surfaces.set([...surface.color,surface.roughness,...(surface.emissive??[0,0,0]),surface.metalness],8*id);
  });
  const mesh=buildBVH(positions,3,corners,{maxLeafTriangles:6});
  const words=new Uint32Array(mesh.nodes),bounds=new Float32Array(mesh.nodes);
  const nodes=new ArrayBuffer(mesh.nodes.byteLength),out=new Uint32Array(nodes),xyz=new Float32Array(nodes);
  const count=words.length/8;
  function weave(node,escape){
    const at=node*8;
    xyz.set(bounds.subarray(at,at+3),at);
    out[at+3]=escape;
    xyz.set(bounds.subarray(at+3,at+6),at+4);
    if(words[at+7]>>>31){
      const right=words[at+6];
      weave(node+1,right);
      weave(right,escape);
      return;
    }
    const first=words[at+6],size=words[at+7];
    if(first>0xffffff||size>255)throw new Error('The room BVH leaf exceeds the packed triangle range.');
    out[at+7]=(first<<8)|size;
  }
  weave(0,count);
  const tris=new Float32Array(mesh.triangles.length*12);
  for(let n=0;n<mesh.triangles.length;n++){
    const a=mesh.index[n*3]*3,b=mesh.index[n*3+1]*3,c=mesh.index[n*3+2]*3,p=n*12;
    for(let j=0;j<3;j++){
      const q=positions[a+j];
      tris[p+j]=q;
      tris[p+4+j]=positions[b+j]-q;
      tris[p+8+j]=positions[c+j]-q;
    }
    tris[p+3]=faces[mesh.triangles[n]];
    tris[p+7]=mesh.triangles[n];
  }
  return {count,nodes:new Uint8Array(nodes),tris,surfaces,triangles:mesh.triangles.length};
}

const world=`struct FlatNode { lower:vec3f, escape:u32, upper:vec3f, leaf:u32 }
struct FlatTriangle { origin:vec4f, edgeU:vec4f, edgeV:vec4f }
struct FlatSurface { diffuse:vec4f, emission:vec4f }
struct FlatLighting { ray:vec4f, energy:vec4f, fill:vec4f }
@group(1) @binding(0) var<storage,read> flatNodes:array<FlatNode>;
@group(1) @binding(1) var<storage,read> flatTriangles:array<FlatTriangle>;
@group(1) @binding(2) var<storage,read> flatSurface:array<FlatSurface>;
@group(1) @binding(3) var<uniform> flatLight:FlatLighting;

fn flatBox(n:FlatNode,o:vec3f,inv:vec3f,stop:f32)->bool{
  let a=(n.lower-o)*inv;
  let b=(n.upper-o)*inv;
  let lo=min(a,b);
  let hi=max(a,b);
  return max(max(max(lo.x,lo.y),lo.z),0.0)<=min(min(min(hi.x,hi.y),hi.z),stop);
}

fn flatIntersect(t:FlatTriangle,o:vec3f,r:vec3f)->f32{
  let p=cross(r,t.edgeV.xyz);
  let denominator=dot(t.edgeU.xyz,p);
  if(abs(denominator)<1e-9){return -1.0;}
  let offset=o-t.origin.xyz;
  let w=dot(offset,p)/denominator;
  if(w<0.0||w>1.0){return -1.0;}
  let q=cross(offset,t.edgeU.xyz);
  let u=dot(r,q)/denominator;
  if(u<0.0||u+w>1.0){return -1.0;}
  return dot(t.edgeV.xyz,q)/denominator;
}

struct FlatHit { distance:f32, face:u32 }
const flatMiss=0xffffffffu;
fn flatTrace(o:vec3f,r:vec3f,far:f32)->FlatHit{
  let inv=select(vec3f(1.0),vec3f(-1.0),r<vec3f(0.0))/max(abs(r),vec3f(1e-7));
  var node=0u;
  var best=FlatHit(far,flatMiss);
  let count=arrayLength(&flatNodes);
  while(node<count){
    let box=flatNodes[node];
    if(!flatBox(box,o,inv,best.distance)){node=box.escape;continue;}
    if(box.leaf==0u){node++;continue;}
    let first=box.leaf>>8u;
    let end=first+(box.leaf&255u);
    for(var i=first;i<end;i++){
      let tri=flatTriangles[i];
      let t=flatIntersect(tri,o,r);
      if(t<0.0||t>best.distance){continue;}
      if(t<best.distance||best.face==flatMiss||tri.edgeU.w<flatTriangles[best.face].edgeU.w){
        best=FlatHit(t,i);
      }
    }
    node=box.escape;
  }
  return best;
}

fn flatIncoming(hit:FlatHit,point:vec3f,r:vec3f)->vec3f{
  let tri=flatTriangles[hit.face];
  let pigment=flatSurface[u32(tri.origin.w)];
  let n0=normalize(cross(tri.edgeU.xyz,tri.edgeV.xyz));
  let v=-r;
  let n=select(n0,-n0,dot(n0,v)<0.0);
  let l=flatLight.ray.xyz;
  let nl=max(0.0,dot(n,l));
  let albedo=pigment.diffuse.rgb*(1.0-pigment.emission.w);
  var key=flatLight.ray.w;
  if(nl>0.0&&flatTrace(point+n*0.012,l,32.0).face!=flatMiss){key=0.0;}
  let h=(v+l)/max(length(v+l),.0001);
  let nv=max(dot(n,v),0.0001);
  let vh=max(dot(v,h),0.0);
  let nh=max(dot(n,h),0.0);
  let a=pigment.diffuse.w*pigment.diffuse.w;
  let aa=a*a;
  let d=aa/(3.14159265*pow(max(dot(cross(n,h),cross(n,h)),step(nh,0.0))+aa*nh*nh,2.0));
  let g=2.0*nl*nv/max(nl*sqrt(aa+(1.0-aa)*nv*nv)+nv*sqrt(aa+(1.0-aa)*nl*nl),1e-7);
  let grazing=pow(1.0-vh,5.0);
  let f0=mix(vec3f(.04),pigment.diffuse.rgb,pigment.emission.w);
  let fresnel=f0+(1.0-f0)*grazing;
  let direct=albedo*.96*(1.0-grazing)/3.14159265+fresnel*d*g/max(4.0*nl*nv,.0001);
  return max(vec3f(0.0),albedo*flatLight.fill.rgb*flatLight.energy.w+pigment.emission.rgb+direct*nl*key*flatLight.energy.rgb);
}
`;

function patch(code){
  const miss='if(h.w<0.0){continue;}';
  if(!code.includes(miss))throw new Error('The public SSGI trace contract changed for this engine revision.');
  return world+code.replace(miss,`if(h.w<0.0){
    let hit=flatTrace(start,r,u.b.x);
    if(hit.face!=flatMiss){
      let weight=1.0-smoothstep(.8*u.b.x,u.b.x,hit.distance);
      sum+=vec4f(flatIncoming(hit,start+r*hit.distance,r)*weight,weight);
    }
    continue;
  }`);
}

function uploaded(device,data,usage){
  const buffer=device.createBuffer({size:data.byteLength,usage});
  device.queue.writeBuffer(buffer,0,data);
  return buffer;
}

export class FlatRoomGI extends SSGI {
  constructor(options,room,engine){
    super(options);
    this.traceRoom=room;
    this.hostEngine=engine;
    this.activeTrace=false;
    this.storage=[];
    this.lightingValues=new Float32Array(12);
    this.groups=new WeakMap();
    this.traced={
      active:()=>this.activeTrace,
      prepare:context=>this.prepareFlat(context.device),
      trace:patch,
      group:(device,pipeline)=>{
        let binding=this.groups.get(pipeline);
        if(!binding){
          binding=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:this.storage.map((buffer,binding)=>({binding,resource:{buffer}}))});
          this.groups.set(pipeline,binding);
        }
        return binding;
      },
    };
  }
  prepareFlat(device){
    if(this.flatDevice!==device){
      this.releaseFlat();
      this.flatDevice=device;
      const {nodes,tris,surfaces}=this.traceRoom,flag=GPUBufferUsage.COPY_DST|GPUBufferUsage.STORAGE;
      this.storage.push(uploaded(device,nodes,flag),uploaded(device,tris,flag),uploaded(device,surfaces,flag));
      this.storage.push(device.createBuffer({size:48,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.UNIFORM}));
    }
    const light=this.hostEngine.lighting,len=Math.hypot(...light.direction.subarray(0,3));
    this.lightingValues.set([
      light.direction[0]/len,light.direction[1]/len,light.direction[2]/len,light.direction[3],
      ...light.radiance,...light.ambient,0,
    ]);
    device.queue.writeBuffer(this.storage[3],0,this.lightingValues);
  }
  releaseFlat(){
    for(const buffer of this.storage)buffer.destroy();
    this.storage=[];
    this.groups=new WeakMap();
  }
  onDeviceRestored(engine){
    this.releaseFlat();
    this.flatDevice=undefined;
    super.onDeviceRestored(engine);
  }
  dispose(){
    this.releaseFlat();
    super.dispose();
  }
}
