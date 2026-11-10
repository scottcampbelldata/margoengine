import { MargoError } from '@margoengine/math/errors';

// Clean room from Woop/Benthin/Wald's ray-space shear (JCGT 2013),
// binary BVH traversal and the existing Margo BSDF/volume integrator.
const GEOMETRY = /* wgsl */ `
const TRIANGLE=0xfffffffcu;
var<private> meshGeometric:vec3f;
fn triangleBase(h:Hit)->u32 {return h.tri;}
fn meshX(b:u32)->Xform {return Xform(vec4f(fl(b),fl(b+1u),fl(b+2u),fl(b+3u)),vec4f(fl(b+4u),fl(b+5u),fl(b+6u),fl(b+7u)),vec4f(fl(b+8u),fl(b+9u),fl(b+10u),fl(b+11u)));}
fn meshWorldNormal(h:Hit,n:vec3f)->vec3f {
 if(h.mesh==0u){return n;}let lx=meshX(h.mesh+12u);
 return normalize(n.x*lx.r0.xyz+n.y*lx.r1.xyz+n.z*lx.r2.xyz);
}
fn triangleNormal(h:Hit)->vec3f {let b=triangleBase(h);return meshWorldNormal(h,vec3f(fl(b+12u),fl(b+13u),fl(b+14u)));}
fn triangleShadingNormal(h:Hit)->vec3f {
 let ng=triangleNormal(h);let a=scene[triangleBase(h)+7u];if(a==0u){return h.sgn*ng;}
 let b=h.meshHead+a;if((scene[b+15u]&1u)==0u){return h.sgn*ng;}
 let n0=vec3f(fl(b),fl(b+1u),fl(b+2u));
 let n1=vec3f(fl(b+4u),fl(b+5u),fl(b+6u));
 let n2=vec3f(fl(b+8u),fl(b+9u),fl(b+10u));
 let v=n0*(1.0-h.bary.x-h.bary.y)+n1*h.bary.x+n2*h.bary.y;
 if(dot(v,v)<=1e-20){return h.sgn*ng;}
 let n=meshWorldNormal(h,normalize(v));return h.sgn*select(n,-n,dot(n,ng)<0.0);
}
fn meshTexel(h:Hit)->vec4f {
 let table=scene[0];let a=scene[triangleBase(h)+7u];
 if(table==0u||a==0u){return vec4f(1.0);}
 let b=h.meshHead+a;if((scene[b+15u]&2u)==0u){return vec4f(1.0);}
 let slot=u32(mat(h.value*MV+6u).x);if(slot==0u){return vec4f(1.0);}
 let uv0=vec2f(fl(b+3u),fl(b+7u));let uv1=vec2f(fl(b+11u),fl(b+12u));let uv2=vec2f(fl(b+13u),fl(b+14u));
 let uv=fract(uv0*(1.0-h.bary.x-h.bary.y)+uv1*h.bary.x+uv2*h.bary.y);
 let t=table+4u*(slot-1u);let w=scene[t+1u];let ht=scene[t+2u];
 let c=unpack4x8unorm(scene[scene[t]+min(u32(uv.y*f32(ht)),ht-1u)*w+min(u32(uv.x*f32(w)),w-1u)]);
 return vec4f(select(c.rgb/12.92,pow((c.rgb+0.055)/1.055,vec3f(2.4)),c.rgb>vec3f(0.04045)),c.a);
}
fn hitNormal(h:Hit)->vec3f {
 if(h.inst==TRIANGLE){return h.sgn*triangleNormal(h);}
 return h.sgn*normalize(rowOf(localX(h.inst),h.axis));
}
fn shadingNormal(h:Hit)->vec3f {
 if(h.inst==TRIANGLE){return triangleShadingNormal(h);}return hitNormal(h);
}
fn hitOffset(h:Hit,p:vec3f)->vec3f {
 if(h.inst==TRIANGLE){return hitNormal(h)*max(1e-5,max(max(abs(p.x),abs(p.y)),abs(p.z))*9.53674316e-7);}
 return h.sgn*EPS*colOf(worldX(h.inst),h.axis);
}
// Exact zero directions stay parallel. Division also handles nonzero directions
// whose reciprocal would overflow. Outward-rounded node bounds plus arithmetic
// slack keep a flat surface or a shared edge in the candidate set.
fn meshBox(b:u32,o:vec3f,d:vec3f,tMax:f32)->bool {
 var lo=0.0;var hi=tMax;
 for(var a=0u;a<3u;a++){
  let mn=fl(b+a);let mx=fl(b+4u+a);
  if(d[a]==0.0){if(o[a]<mn||o[a]>mx){return false;}}
  else{let t0=(mn-o[a])/d[a];let t1=(mx-o[a])/d[a];
   let near=min(t0,t1);let far=max(t0,t1);
   lo=max(lo,near-abs(near)*2e-6);hi=min(hi,far+abs(far)*2e-6);
   if(lo>hi){return false;}
  }
 }
 return true;
}
// Exact 24x24-bit significand product, packed as low/high, exponent+300, sign.
// Integer arithmetic prevents the shader optimizer from contracting away a
// floating-point error correction. Only uncertain edge predicates use it.
fn meshProduct(x:f32,y:f32)->vec4u {
 let a=bitcast<u32>(x);let b=bitcast<u32>(y);
 let ea=(a>>23u)&255u;let eb=(b>>23u)&255u;
 let ma=(a&0x7fffffu)|select(0u,0x800000u,ea>0u);
 let mb=(b&0x7fffffu)|select(0u,0x800000u,eb>0u);
 let low=(ma&65535u)*(mb&65535u);
 let middle=(ma>>16u)*(mb&65535u)+(mb>>16u)*(ma&65535u)+(low>>16u);
 let high=(ma>>16u)*(mb>>16u)+(middle>>16u);
 return vec4u((middle<<16u)|(low&65535u),high,max(ea,1u)+max(eb,1u),(a^b)>>31u);
}
fn meshShift(v:vec2u,s:u32)->vec2u {
 if(s==0u){return v;}return vec2u(v.x<<s,(v.y<<s)|(v.x>>(32u-s)));
}
// The fast determinant is accepted only outside its product/subtraction error
// interval (a conservative gamma(3) bound). The fallback subtracts both exact
// 48-bit products before rounding once. It changes no geometric edge tolerance.
fn meshEdge(a:vec2f,b:vec2f)->f32 {
 let p=a.x*b.y;let q=a.y*b.x;let e=p-q;
 if(abs(e)>1e-6*(abs(p)+abs(q))){return e;}
 let x=meshProduct(a.x,b.y);let y=meshProduct(a.y,b.x);
 if(x.w!=y.w){return e;}
 let base=min(x.z,y.z);let sx=x.z-base;let sy=y.z-base;
 // Near cancellation of nonzero 24-bit significands needs at most two
 // alignment bits. Larger gaps cannot change the fast predicate's sign.
 if(max(sx,sy)>16u){return e;}
 var left=meshShift(x.xy,sx);var right=meshShift(y.xy,sy);
 let less=left.y<right.y||(left.y==right.y&&left.x<right.x);
 if(less){let t=left;left=right;right=t;}
 let lo=left.x-right.x;let hi=left.y-right.y-select(0u,1u,left.x<right.x);
 let value=ldexp(f32(hi)*4294967296.0+f32(lo),i32(base)-300);
 return select(value,-value,(x.w!=0u)!=less);
}
fn triangleHit(b:u32,o:vec3f,d:vec3f,tMax:f32)->vec3f {
 var kz=0u;if(abs(d.y)>abs(d.x)){kz=1u;}if(abs(d.z)>abs(d[kz])){kz=2u;}
 var kx=(kz+1u)%3u;var ky=(kx+1u)%3u;
 if(d[kz]<0.0){let t=kx;kx=ky;ky=t;}
 let sx=d[kx]/d[kz];let sy=d[ky]/d[kz];let sz=1.0/d[kz];
 let a=vec3f(fl(b),fl(b+1u),fl(b+2u))-o;
 let c=vec3f(fl(b+8u),fl(b+9u),fl(b+10u))-o;
 let v=vec3f(fl(b+4u),fl(b+5u),fl(b+6u))-o;
 let ax=a[kx]-sx*a[kz];let ay=a[ky]-sy*a[kz];
 let bx=v[kx]-sx*v[kz];let by=v[ky]-sy*v[kz];
 let cx=c[kx]-sx*c[kz];let cy=c[ky]-sy*c[kz];
 let u=meshEdge(vec2f(cx,cy),vec2f(bx,by));let w=meshEdge(vec2f(bx,by),vec2f(ax,ay));let q=meshEdge(vec2f(ax,ay),vec2f(cx,cy));
 if((min(min(u,w),q)<0.0)&&(max(max(u,w),q)>0.0)){return vec3f(-1.0);}
 let det=u+w+q;if(det==0.0){return vec3f(-1.0);}
 let t=(u*a[kz]+q*v[kz]+w*c[kz])*sz/det;
 if(t>0.0&&t<tMax){return vec3f(t,q/det,w/det);}return vec3f(-1.0);
}
fn meshBlas(head:u32,instance:u32,o:vec3f,d:vec3f,medium:u32,mInst:u32,h:ptr<function,Hit>){
 let count=scene[head];let triangles=head+scene[head+1u];
 var node=0u;
 loop{
  if(node>=count){break;}
  let b=head+4u+node*8u;
  if(!meshBox(b,o,d,(*h).t)){node=scene[b+3u];continue;}
  let leaf=scene[b+7u];node++;
  if(leaf==0u){continue;}
  let tb=triangles+(leaf-1u)*16u;let hit=triangleHit(tb,o,d,(*h).t);let t=hit.x;
  if(t<=0.0){continue;}
  let n=vec3f(fl(tb+12u),fl(tb+13u),fl(tb+14u));let back=dot(n,d)>0.0;
  (*h).t=t;(*h).inst=TRIANGLE;(*h).tri=tb;(*h).meshHead=head;(*h).mesh=instance;(*h).axis=0u;(*h).cell=vec3i(0);
  (*h).sgn=select(1.0,-1.0,back);(*h).bary=hit.yz;
  (*h).value=select(scene[tb+3u],0u,back&&mInst==TRIANGLE&&medium==scene[tb+3u]);
 }
}
fn meshClosest(o:vec3f,d:vec3f,medium:u32,mInst:u32,h:ptr<function,Hit>){
 let head=scene[2];if(head==0u){return;}
 if(scene[head+1u]!=0u){meshBlas(head,0u,o,d,medium,mInst,h);return;}
 let count=scene[head];let records=head+scene[head+5u];var node=0u;
 loop{
  if(node>=count){break;}let b=head+16u+node*8u;
  if(!meshBox(b,o,d,(*h).t)){node=scene[b+3u];continue;}
  let leaf=scene[b+7u];node++;if(leaf==0u){continue;}
  let instance=records+(leaf-1u)*32u;let lx=meshX(instance+12u);
  let lo=vec3f(dot(lx.r0,vec4f(o,1.0)),dot(lx.r1,vec4f(o,1.0)),dot(lx.r2,vec4f(o,1.0)));
  // Do not normalize: the transformed ray must retain the world-space t.
  let ld=vec3f(dot(lx.r0.xyz,d),dot(lx.r1.xyz,d),dot(lx.r2.xyz,d));
  meshBlas(head+scene[instance+24u],instance,lo,ld,medium,mInst,h);
 }
}
fn meshOccludes(o:vec3f,d:vec3f,tMax:f32)->bool {
 var h:Hit;h.t=tMax;h.inst=NONE;meshClosest(o,d,0u,NONE,&h);return h.inst==TRIANGLE;
}
`;

/** Specialize every camera, shadow, preview, feature and secondary path consistently. */
export function meshSource(input: string): string {
  let source = input;
  const edit = (from: string, to: string) => {
    if (!source.includes(from))
      throw new MargoError('state', 'Mesh kernel mismatch; rebuild: https://margoengine.com/errors#voxel-pathtracer');
    source = source.replace(from, to);
  };
  edit('sgn:f32,cell:vec3i}', 'sgn:f32,cell:vec3i,tri:u32,bary:vec2f,mesh:u32,meshHead:u32}');
  edit('fn closest(', GEOMETRY + '\nfn closest(');
  edit('if(f.scene.w==0u){return h;}', 'meshClosest(o,d,medium,mInst,&h);\n if(f.scene.w==0u){return h;}');
  edit(
    'fn shadow(o:vec3f,d:vec3f,tMax:f32)->f32 {',
    'fn shadow(o:vec3f,d:vec3f,tMax:f32)->f32 {\n if(meshOccludes(o,d,tMax)){return 0.0;}',
  );
  edit(
    'fn edgeBand(h:Hit,p:vec3f)->bool {',
    'fn edgeBand(h:Hit,p:vec3f)->bool {\n if(h.inst==TRIANGLE){return false;}',
  );
  edit(
    'fn faceTexel(h:Hit,p:vec3f)->vec4f {',
    'fn faceTexel(h:Hit,p:vec3f)->vec4f {\n if(h.inst==TRIANGLE){return meshTexel(h);}',
  );
  // Until triangle light sampling is installed, a directional RIS proposal must
  // leave triangle emission to path hits, without treating its marker as an instance.
  source = source.replace('if(h.inst>=AREA||h.value==0u)', 'if(h.inst>=TRIANGLE||h.value==0u)');
  edit(
    'fn emitWeight(h:Hit,n:vec3f,d:vec3f,radiance:vec3f,lastPdf:f32)->f32 {',
    'fn emitWeight(h:Hit,n:vec3f,d:vec3f,radiance:vec3f,lastPdf:f32)->f32 {\n if(h.inst==TRIANGLE){return 1.0;}',
  );
  edit('fn prismAt(inst:u32)->bool {return', 'fn prismAt(inst:u32)->bool {if(inst==TRIANGLE){return false;}return');
  edit('fn mirrorAt(inst:u32)->bool {return', 'fn mirrorAt(inst:u32)->bool {if(inst==TRIANGLE){return false;}return');
  // Inside a mesh shell there is no voxel box frame from which to construct
  // inverse Snell candidates. Give these distant-light paths their full path
  // sampling weight. Exterior straight-through walks still have matching MIS.
  edit(
    'let inGlass=medium!=0u&&(material(medium).flags&MEDIA)==0u;',
    'let inGlass=medium!=0u&&(material(medium).flags&MEDIA)==0u;\n if(inGlass&&mInst==TRIANGLE){return;}',
  );
  edit('chainOk=true;chainSet=md.media;', 'chainOk=mInst!=TRIANGLE;chainSet=md.media;');
  edit('chainOk=true;chainSet=inAir;', 'chainOk=mInst!=TRIANGLE;chainSet=inAir;');
  // Reflection and transmission use the geometric surface to classify sides.
  // Rejected directions retain their null probability; never resample to hide it.
  edit(
    'fn evalAt(kind:u32,m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {',
    'fn evalAt(kind:u32,m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {\n if(kind==0u&&dot(meshGeometric,meshGeometric)>0.0&&dot(meshGeometric,wi)<=0.0){return Eval(vec3f(0.0),0.0);}',
  );
  edit(
    '  // Light sampled at a glossy metal',
    '  meshGeometric=vec3f(0.0);if(!scatter&&h.inst==TRIANGLE){meshGeometric=hitNormal(h); }\n  // Light sampled at a glossy metal',
  );
  edit(
    'let s=dielectric(mm.alpha,n,-d,mm.ior,sm);\n     if(!s.ok){break;}',
    'let s=dielectric(mm.alpha,n,-d,mm.ior,sm);\n     if(!s.ok){break;}\n     if(h.inst==TRIANGLE&&select(dot(hitNormal(h),s.wi)<=0.0,dot(hitNormal(h),s.wi)>=0.0,s.transmit)){break;}',
  );
  edit(
    'if(!s.ok){done=true;continue;}',
    'if(!s.ok){done=true;continue;}\n  if(h.inst==TRIANGLE&&select(dot(hitNormal(h),s.wi)<=0.0,dot(hitNormal(h),s.wi)>=0.0,s.transmit)){done=true;continue;}',
  );
  edit('let wn=h.sgn*normalize(rowOf(localX(h.inst),h.axis));', 'let wn=hitNormal(h);');
  edit('let woff=h.sgn*EPS*colOf(worldX(h.inst),h.axis);', 'let woff=hitOffset(h,wp);');
  edit('if(h.inst!=GROUND){n=rowOf(localX(h.inst),h.axis);}', 'if(h.inst!=GROUND){n=hitNormal(h);}');
  edit(
    'let lx=localX(h.inst);\n    n=h.sgn*normalize(rowOf(lx,h.axis));\n    off=h.sgn*EPS*colOf(worldX(h.inst),h.axis);',
    'n=shadingNormal(h);\n    off=hitOffset(h,p);',
  );
  edit(
    'n=normalize(h.sgn*rowOf(localX(h.inst),h.axis));m=material(h.value);',
    'n=shadingNormal(h);m=material(h.value);',
  );
  edit(
    'else if(h.inst!=NONE){v=f32(h.inst+1u)*256.0+f32(h.value&255u);}',
    'else if(h.inst==TRIANGLE){v=-f32(scene[triangleBase(h)+15u]+select(0u,scene[h.mesh+25u],h.mesh!=0u)+4u);}else if(h.inst!=NONE){v=f32(h.inst+1u)*256.0+f32(h.value&255u);}',
  );
  return source;
}
