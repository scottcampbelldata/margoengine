import { MargoError } from '@margoengine/math/errors';
import { PBR_LOBES } from './mesh-pbr-lobes.js';
import { meshSource } from './mesh-shader.js';

const PBR = /* wgsl */ `
fn pbrRecord(h:Hit)->u32 {
 if(h.inst!=TRIANGLE||h.value==0u){return 0u;}
 let head=scene[2];let relative=scene[h.mesh+29u];if(relative==0u){return 0u;}
 let at=head+relative;return select(0u,at,scene[at]!=0u);
}
fn pbrVertex(h:Hit,corner:u32)->u32 {
 let info=scene[2]+scene[h.mesh+28u];let ordinal=scene[triangleBase(h)+15u];
 let index=scene[scene[2]+scene[info]+ordinal*3u+corner];
 return scene[2]+scene[info+1u]+index*16u;
}
fn pbrAttribute(h:Hit,offset:u32)->vec4f {
 let a=pbrVertex(h,0u)+offset;let b=pbrVertex(h,1u)+offset;let c=pbrVertex(h,2u)+offset;
 return vec4f(fl(a),fl(a+1u),fl(a+2u),fl(a+3u))*(1.0-h.bary.x-h.bary.y)
  +vec4f(fl(b),fl(b+1u),fl(b+2u),fl(b+3u))*h.bary.x
  +vec4f(fl(c),fl(c+1u),fl(c+2u),fl(c+3u))*h.bary.y;
}
fn pbrUV(h:Hit,uvSet:u32)->vec2f {
 let uv=pbrAttribute(h,(uvSet/2u)*4u);return select(uv.xy,uv.zw,(uvSet&1u)!=0u);
}
fn pbrAddress(i:i32,n:i32,mode:u32)->u32 {
 if(mode==2u){return u32(clamp(i,0,n-1));}
 var k=((i%n)+n)%n;
 if(mode==1u){let p=((i%(n*2))+n*2)%(n*2);k=select(p,n*2-1-p,p>=n);}
 return u32(k);
}
fn pbrPixel(t:u32,xy:vec2i)->vec4f {
 let x=pbrAddress(xy.x,i32(scene[t]),scene[t+4u]);
 let y=pbrAddress(xy.y,i32(scene[t+1u]),scene[t+5u]);
 return unpack4x8unorm(scene[scene[2]+scene[t+2u]+y*scene[t]+x]);
}
fn pbrWrapUV(u:f32,mode:u32)->f32 {
 if(mode==2u){return clamp(u,0.0,1.0);}
 if(mode==1u){return 1.0-abs(fract(u*0.5)*2.0-1.0);}return fract(u);
}
fn pbrTexture(h:Hit,record:u32,slot:u32,srgb:bool)->vec4f {
 let relative=scene[record+16u+slot];if(relative==0u){return vec4f(1.0);}
 let t=scene[2]+relative;let uv=pbrUV(h,scene[t+3u]);
 let q=vec2f(dot(vec3f(fl(t+8u),fl(t+9u),fl(t+10u)),vec3f(uv,1.0)),
             dot(vec3f(fl(t+11u),fl(t+12u),fl(t+13u)),vec3f(uv,1.0)));
 let wrapped=vec2f(pbrWrapUV(q.x,scene[t+4u]),pbrWrapUV(q.y,scene[t+5u]));
 let p=wrapped*vec2f(f32(scene[t]),f32(scene[t+1u]));var value:vec4f;
 if(scene[t+6u]==0u){value=pbrPixel(t,vec2i(floor(p)));}
 else{
  let x=p-0.5;let a=vec2i(floor(x));let k=fract(x);
  var c0=pbrPixel(t,a);var c1=pbrPixel(t,a+vec2i(1,0));
  var c2=pbrPixel(t,a+vec2i(0,1));var c3=pbrPixel(t,a+vec2i(1,1));
  // Hardware sRGB filtering interpolates decoded values, not encoded bytes.
  if(srgb){
   c0=vec4f(select(c0.rgb/12.92,pow((c0.rgb+0.055)/1.055,vec3f(2.4)),c0.rgb>vec3f(0.04045)),c0.a);
   c1=vec4f(select(c1.rgb/12.92,pow((c1.rgb+0.055)/1.055,vec3f(2.4)),c1.rgb>vec3f(0.04045)),c1.a);
   c2=vec4f(select(c2.rgb/12.92,pow((c2.rgb+0.055)/1.055,vec3f(2.4)),c2.rgb>vec3f(0.04045)),c2.a);
   c3=vec4f(select(c3.rgb/12.92,pow((c3.rgb+0.055)/1.055,vec3f(2.4)),c3.rgb>vec3f(0.04045)),c3.a);
  }
  return mix(mix(c0,c1,k.x),mix(c2,c3,k.x),k.y);
 }
 if(srgb){value=vec4f(select(value.rgb/12.92,pow((value.rgb+0.055)/1.055,vec3f(2.4)),value.rgb>vec3f(0.04045)),value.a);}
 return value;
}
fn pbrVisible(h:Hit,back:bool)->bool {
 let r=pbrRecord(h);if(r==0u){return true;}
 if(back&&scene[r+2u]==0u){return false;}
 if(scene[r+1u]==0u){return true;}
 return fl(r+7u)*pbrAttribute(h,12u).a*pbrTexture(h,r,0u,false).a>=fl(r+15u);
}
fn pbrMaterial(h:Hit,p:vec3f,input:Mat)->Mat {
 let r=pbrRecord(h);var m=input;
 if(r==0u){let tex=faceTexel(h,p).rgb;m.color*=tex;m.metalColor*=tex;return m;}
 let base=vec3f(fl(r+4u),fl(r+5u),fl(r+6u))*pbrTexture(h,r,0u,true).rgb*pbrAttribute(h,12u).rgb;
 let mr=pbrTexture(h,r,1u,false);let rough=fl(r+13u)*mr.g;
 m.pbr=1u;pbrLayer.viewF=vec3f(0.0);
 pbrLayer.coat=fl(r+32u)*pbrTexture(h,r,4u,false).r;let coatRough=fl(r+33u)*pbrTexture(h,r,5u,false).g;pbrLayer.coatAlpha=coatRough*coatRough;
 pbrLayer.coatN=pbrMappedNormal(h,6u,fl(r+34u));
 pbrLayer.sheen=vec3f(fl(r+36u),fl(r+37u),fl(r+38u))*pbrTexture(h,r,7u,true).rgb;pbrLayer.sheenR=fl(r+35u)*pbrTexture(h,r,8u,false).a;
 pbrLayer.specWeight=fl(r+39u)*pbrTexture(h,r,9u,false).a;pbrLayer.specRGB=vec3f(fl(r+40u),fl(r+41u),fl(r+42u))*pbrTexture(h,r,10u,true).rgb;
 let thickness=mix(fl(r+45u),fl(r+46u),pbrTexture(h,r,12u,false).g);
 pbrLayer.film=vec3f(fl(r+43u)*pbrTexture(h,r,11u,false).r,fl(r+44u),thickness);
 m.color=base;m.metalColor=base;m.metal=fl(r+12u)*mr.b;m.glass=0.0;
 m.alpha=max(1e-6,rough*rough);m.spec=1.0;m.f0=0.04;m.ior=1.5;
 m.emission=vec3f(fl(r+8u),fl(r+9u),fl(r+10u))*fl(r+11u)*pbrTexture(h,r,3u,true).rgb;
 m.flags=0u;m.density=0.0;m.scatter=0.0;m.disp=0.0;m.g=0.0;
 if(rough==0.0){m.flags|=SMOOTH;}
 if(any(m.emission>vec3f(0.0))){m.flags|=EMISSIVE;}
 m.seen=vec4f(0.0);return m;
}
fn pbrDirection(h:Hit,v:vec3f)->vec3f {
 let x=meshX(h.mesh);return vec3f(dot(x.r0.xyz,v),dot(x.r1.xyz,v),dot(x.r2.xyz,v));
}
fn pbrMappedNormal(h:Hit,mapSlot:u32,scale:f32)->vec3f {
 let n=triangleShadingNormal(h);let r=pbrRecord(h);
 if(r==0u||scene[r+16u+mapSlot]==0u){return n;}
 var map=pbrTexture(h,r,mapSlot,false).xyz*2.0-1.0;map=vec3f(map.xy*scale,map.z);
 if(dot(map,map)==0.0){return n;}
 let info=scene[2]+scene[h.mesh+28u];var t:vec3f;var hand=1.0;
 if(scene[info+2u]!=0u){
  let tangent=pbrAttribute(h,8u);t=pbrDirection(h,tangent.xyz);hand=tangent.w;
  let x=meshX(h.mesh);hand*=select(1.0,-1.0,dot(cross(x.r0.xyz,x.r1.xyz),x.r2.xyz)<0.0);
 }else{
  let slot=scene[2]+scene[r+16u+mapSlot];let uvSet=scene[slot+3u];
  let a=pbrVertex(h,0u)+(uvSet/2u)*4u;let b=pbrVertex(h,1u)+(uvSet/2u)*4u;let c=pbrVertex(h,2u)+(uvSet/2u)*4u;
  let offset=(uvSet&1u)*2u;let u0=vec2f(fl(a+offset),fl(a+offset+1u));
  let u1=vec2f(fl(b+offset),fl(b+offset+1u))-u0;let u2=vec2f(fl(c+offset),fl(c+offset+1u))-u0;
  let det=u1.x*u2.y-u1.y*u2.x;
  if(det==0.0){return n;}
  let q=triangleBase(h);let p0=vec3f(fl(q),fl(q+1u),fl(q+2u));
  let e1=vec3f(fl(q+4u),fl(q+5u),fl(q+6u))-p0;
  let e2=vec3f(fl(q+8u),fl(q+9u),fl(q+10u))-p0;
  t=pbrDirection(h,(e1*u2.y-e2*u1.y)/det);
  let bitangent=pbrDirection(h,(e2*u1.x-e1*u2.x)/det);
  hand=select(1.0,-1.0,dot(cross(n,t),bitangent)<0.0);
 }
 t-=n*dot(n,t);if(dot(t,t)<1e-20){return n;}t=normalize(t);
 let b=normalize(cross(n,t))*hand;let result=normalize(t*map.x+b*map.y+n*map.z);
 return select(result,-result,dot(result,hitNormal(h))<0.0);
}
fn pbrNormal(h:Hit)->vec3f {let r=pbrRecord(h);return pbrMappedNormal(h,2u,fl(r+14u));}
// Light proposals need visibility, emitted radiance and the coating above it.
// Keep reflection-only textures and the complete BSDF out of this call graph.
fn pbrEmitterRadiance(h:Hit,wo:vec3f)->vec3f {
 let r=pbrRecord(h);if(r==0u){return material(h.value).emission;}
 if(!pbrVisible(h,dot(triangleNormal(h),wo)<0.0)){return vec3f(0.0);}
 let emission=vec3f(fl(r+8u),fl(r+9u),fl(r+10u))*fl(r+11u)*pbrTexture(h,r,3u,true).rgb;
 let coat=fl(r+32u)*pbrTexture(h,r,4u,false).r;
 if(coat==0.0){return emission;}
 let n=pbrMappedNormal(h,6u,fl(r+34u));
 return emission*(1.0-coat*schlick1(.04,clamp(abs(dot(n,wo)),0.0,1.0)));
}
`;

/** Specialize the optional mesh surface without changing root transport. */
export function meshPBRSource(input: string): string {
  let source = meshSource(input);
  const edit = (from: string, to: string) => {
    if (!source.includes(from)) throw new MargoError('state', 'Mesh PBR kernel mismatch; rebuild: https://margoengine.com/errors#voxel-pathtracer');
    source = source.replace(from, to);
  };
  edit('seen:vec4f}', 'seen:vec4f,pbr:u32}');
  edit('mat(id*MV+5u));', 'mat(id*MV+5u),0u);');
  edit('fn evalLobes(m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {', 'fn evalLobes(m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {if(m.pbr!=0u){return pbrLayerEvalPrepared(m,n,wo,wi,mask);}');
  edit('fn sampleSurface(m:Mat,n:vec3f,wo:vec3f,etaI:f32)->Bounce {', 'fn sampleSurface(m:Mat,n:vec3f,wo:vec3f,etaI:f32)->Bounce {if(m.pbr!=0u){return pbrLayerSamplePrepared(m,n,wo);}');
  edit('  // Light sampled at a glossy metal seen from a diffuse vertex', '  if(m.pbr!=0u){pbrPrepareView(m,n,-d);}\n  // Light sampled at a glossy metal seen from a diffuse vertex');
  edit('let e=select(m.emission,m.seen.xyz,', 'let e=select(pbrEmitted(m,-d),m.seen.xyz,');
  edit('c=select(m.emission,m.seen.xyz,', 'c=select(pbrEmitted(m,-ray.d),m.seen.xyz,');
  edit('if(h.inst==TRIANGLE){return triangleShadingNormal(h);}', 'if(h.inst==TRIANGLE){return pbrNormal(h);}');
  edit('  (*h).t=t;(*h).inst=TRIANGLE;',
    '  var candidate:Hit;candidate.inst=TRIANGLE;candidate.value=scene[tb+3u];candidate.tri=tb;candidate.meshHead=head;candidate.mesh=instance;candidate.bary=hit.yz;\n  if(!pbrVisible(candidate,back)){continue;}\n  (*h).t=t;(*h).inst=TRIANGLE;');
  edit('let tex=faceTexel(h,p).rgb;m.color*=tex;m.metalColor*=tex;', 'm=pbrMaterial(h,p,m);');
  edit('let tex=faceTexel(h,p).rgb;m.color*=tex;m.metalColor*=tex;', 'm=pbrMaterial(h,p,m);');
  edit('return material(h.value).emission;', 'return pbrEmitterRadiance(h,wo);');
  edit('fn triangleBase(', PBR_LOBES + PBR + '\nfn triangleBase(');
  return source;
}
