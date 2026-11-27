import{i as e,n as t,t as n}from"./matrix4-C0CUW6df.js";import{n as r,r as i}from"./gallery-BZXMxGla.js";function a(){let r=i(),a=r.reduce((e,t)=>e+t.geometry.vertices.length/6,0),o=r.reduce((e,t)=>e+t.geometry.indices.length,0),s=new Float32Array(a*3),c=new Uint32Array(o),l=new Float32Array(o/3*8),u=new n,d=new t,f=([e,t,n])=>({x:e,y:t,z:n}),p=0,m=0;for(let e of r){let{geometry:t,appearance:n}=e;d.setFromEuler({...f(e.rotation),order:`XYZ`});let r=u.compose(f(e.position),d,f(e.scale)).elements,i=t.vertices,a=p/3;for(let e=0;e<i.length;e+=6){let t=i[e],n=i[e+1],a=i[e+2];s[p++]=r[0]*t+r[4]*n+r[8]*a+r[12],s[p++]=r[1]*t+r[5]*n+r[9]*a+r[13],s[p++]=r[2]*t+r[6]*n+r[10]*a+r[14]}let{color:o,roughness:h,metalness:g}=n.optical,_=t.indices;for(let e=0;e<_.length;e+=3){let t=(a+_[e])*3,n=(a+_[e+1])*3,r=(a+_[e+2])*3,i=s[n]-s[t],u=s[n+1]-s[t+1],d=s[n+2]-s[t+2],f=s[r]-s[t],p=s[r+1]-s[t+1],v=s[r+2]-s[t+2],y=m/3*8;l[y]=u*v-d*p,l[y+1]=d*f-i*v,l[y+2]=i*p-u*f,l[y+3]=h,l[y+4]=o[0],l[y+5]=o[1],l[y+6]=o[2],l[y+7]=g,c[m++]=a+_[e],c[m++]=a+_[e+1],c[m++]=a+_[e+2]}}let h=e(s,3,c),g=new Uint32Array(h.nodes),_=new Float32Array(h.nodes),v=new ArrayBuffer(g.length*4),y=new Uint32Array(v),b=new Float32Array(v),x=g.length/8;function S(e,t){let n=e*8,r=!!(g[n+7]&2147483648);if(b.set(_.subarray(n,n+3),n),y[n+3]=t,b.set(_.subarray(n+3,n+6),n+4),r){let r=g[n+6];S(e+1,r),S(r,t)}else{let e=g[n+6],t=g[n+7];if(e>16777215||t>255)throw RangeError(`Mirror BVH leaf does not fit its compact record.`);y[n+7]=e<<8|t}}S(0,x);let C=new Float32Array(h.triangles.length*20);for(let e=0;e<h.triangles.length;e++){let t=e*20,n=h.index[e*3]*3,r=h.index[e*3+1]*3,i=h.index[e*3+2]*3;for(let e=0;e<3;e++){let a=s[n+e];C[t+e]=a,C[t+4+e]=s[r+e]-a,C[t+8+e]=s[i+e]-a}let a=h.triangles[e]*8;C.set(l.subarray(a,a+8),t+12)}return{nodes:v,triangles:C,instances:r.length}}var o=`
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
`;function s(e){let t,i,a,s,c,l,u,d,f=new n,p=new Float32Array(40);function m(){i?.destroy(),a?.destroy(),s?.destroy(),i=a=s=c=l=u=void 0}function h(n){t=n.gpu;let l=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST;i=t.createBuffer({size:e.nodes.byteLength,usage:l}),a=t.createBuffer({size:e.triangles.byteLength,usage:l}),t.queue.writeBuffer(i,0,e.nodes),t.queue.writeBuffer(a,0,e.triangles),s=t.createBuffer({size:p.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),p[19]=e.nodes.byteLength/32,p.set(r.color,32),p.set(r.bounds,36);let u=t.createShaderModule({code:o}),f={layout:`auto`,vertex:{module:u,entryPoint:`vertex`},fragment:{module:u,entryPoint:`fragment`,targets:[{format:`rgba8unorm`,blend:{color:{operation:`add`,srcFactor:`src-alpha`,dstFactor:`one-minus-src-alpha`},alpha:{operation:`add`,srcFactor:`one`,dstFactor:`one-minus-src-alpha`}}}]}},m=t;d=t.createRenderPipelineAsync(f).then(e=>{t===m&&s&&(c=e),performance.mark(`mirror-ray-pipeline-ready`)})}return{name:`planar-specular-rays`,setup:h,get ready(){return d},onDeviceRestored(e){m(),h(e),d.catch(t=>e.onError(t))},dispose:m,registerPasses(e){e.add({name:`trace-visible-mirror`,order:2,execute(e){let n=e.view?.target?.depth;if(!n)throw Error(`The mirror needs sampleable scene depth.`);if(!c)return;n!==u&&(l=t.createBindGroup({layout:c.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:s}},{binding:1,resource:n.createView({aspect:`depth-only`})},{binding:2,resource:{buffer:i}},{binding:3,resource:{buffer:a}}]}),u=n),f.fromArray(e.camera.matrix).invert().toArray(p),p.set(e.camera.position,16),p.set(r.sun,20),p.set(r.radiance,24),p.set(r.ambient,28),t.queue.writeBuffer(s,0,p);let o=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:`load`,storeOp:`store`}]});o.setPipeline(c),o.setBindGroup(0,l),o.draw(3),o.end()}})}}}export{s as localMirror,a as prepareMirror};