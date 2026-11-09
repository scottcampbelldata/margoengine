import { MargoError } from '@margoengine/math/errors';

// Clean room from Woop/Benthin/Wald's ray-space shear (JCGT 2013),
// binary BVH traversal and the existing Margo BSDF/volume integrator.
const GEOMETRY = /* wgsl */ `
const TRIANGLE=0xfffffffcu;
fn triangleBase(h:Hit)->u32 {let b=scene[2];return b+scene[b+1u]+h.tri*16u;}
fn triangleNormal(h:Hit)->vec3f {let b=triangleBase(h);return vec3f(fl(b+12u),fl(b+13u),fl(b+14u));}
fn hitNormal(h:Hit)->vec3f {
 if(h.inst==TRIANGLE){return h.sgn*triangleNormal(h);}
 return h.sgn*normalize(rowOf(localX(h.inst),h.axis));
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
fn triangleHit(b:u32,o:vec3f,d:vec3f,tMax:f32)->f32 {
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
 if((min(min(u,w),q)<0.0)&&(max(max(u,w),q)>0.0)){return -1.0;}
 let det=u+w+q;if(det==0.0){return -1.0;}
 let t=(u*a[kz]+q*v[kz]+w*c[kz])*sz/det;
 if(t>0.0&&t<tMax){return t;}return -1.0;
}
fn meshClosest(o:vec3f,d:vec3f,medium:u32,mInst:u32,h:ptr<function,Hit>){
 let head=scene[2];if(head==0u){return;}
 let count=scene[head];let triangles=head+scene[head+1u];
 var node=0u;
 loop{
  if(node>=count){break;}
  let b=head+4u+node*8u;
  if(!meshBox(b,o,d,(*h).t)){node=scene[b+3u];continue;}
  let leaf=scene[b+7u];node++;
  if(leaf==0u){continue;}
  let tb=triangles+(leaf-1u)*16u;let t=triangleHit(tb,o,d,(*h).t);
  if(t<=0.0){continue;}
  let n=vec3f(fl(tb+12u),fl(tb+13u),fl(tb+14u));let back=dot(n,d)>0.0;
  (*h).t=t;(*h).inst=TRIANGLE;(*h).tri=leaf-1u;(*h).axis=0u;(*h).cell=vec3i(0);
  (*h).sgn=select(1.0,-1.0,back);
  (*h).value=select(scene[tb+3u],0u,back&&mInst==TRIANGLE&&medium==scene[tb+3u]);
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
  edit('sgn:f32,cell:vec3i}', 'sgn:f32,cell:vec3i,tri:u32}');
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
  edit('if(scene[0]==0u||h.inst>=AREA)', 'if(scene[0]==0u||h.inst>=TRIANGLE)');
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
  edit('let wn=h.sgn*normalize(rowOf(localX(h.inst),h.axis));', 'let wn=hitNormal(h);');
  edit('let woff=h.sgn*EPS*colOf(worldX(h.inst),h.axis);', 'let woff=hitOffset(h,wp);');
  edit('if(h.inst!=GROUND){n=rowOf(localX(h.inst),h.axis);}', 'if(h.inst!=GROUND){n=hitNormal(h);}');
  edit(
    'let lx=localX(h.inst);\n    n=h.sgn*normalize(rowOf(lx,h.axis));\n    off=h.sgn*EPS*colOf(worldX(h.inst),h.axis);',
    'n=hitNormal(h);\n    off=hitOffset(h,p);',
  );
  edit('n=normalize(h.sgn*rowOf(localX(h.inst),h.axis));m=material(h.value);', 'n=hitNormal(h);m=material(h.value);');
  edit(
    'else if(h.inst!=NONE){v=f32(h.inst+1u)*256.0+f32(h.value&255u);}',
    'else if(h.inst==TRIANGLE){v=-f32(h.tri+4u);}else if(h.inst!=NONE){v=f32(h.inst+1u)*256.0+f32(h.value&255u);}',
  );
  return source;
}
