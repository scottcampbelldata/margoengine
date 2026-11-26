import { MargoError } from '@margoengine/math/errors';
const LIGHTS = /* wgsl */ `
// The shadow-ray stop of a moving or deforming light point, relative to its largest coordinate (8 Float32 ulps at 1;
// a still point keeps 1: limits, "moving mesh emitters").
const MESH_LIGHT_SLACK=7.62939453e-6;
fn meshLights()->u32 {
 let g=scene[2];if(g==0u||scene[g+1u]!=0u||scene[g+12u]==0u){return 0u;}return g+scene[g+12u];
}
fn meshProposalCount()->u32 {let header=meshLights();if(header==0u){return 5u;}return scene[header+4u];}
fn meshEmitterRadiance(h:Hit,p:vec3f,wo:vec3f)->vec3f {return material(h.value).emission;}
// World area of a hit's face at the path's time: 0.5 |L^T c| / |det L| for model rows L and object cross product c
// (the cofactor identity, so no second inverse). Moving or deforming records only; a still record stores its area.
fn meshArea(lx:Xform,p0:vec3f,p1:vec3f,p2:vec3f)->f32 {
 let c=cross(p1-p0,p2-p0);let w=c.x*lx.r0.xyz+c.y*lx.r1.xyz+c.z*lx.r2.xyz;
 return 0.5*length(w)/abs(dot(lx.r0.xyz,cross(lx.r1.xyz,lx.r2.xyz)));
}
fn meshEmitterWeight(h:Hit,d:vec3f,lastPdf:f32)->f32 {
 if(lastPdf<=0.0||h.mesh==0u){return 1.0;}
 let lookup=scene[h.mesh+30u];if(lookup==0u){return 1.0;}
 let ordinal=(h.tri-h.meshHead-scene[h.meshHead+1u])/16u;
 let relative=scene[scene[2]+lookup+ordinal];if(relative==0u){return 1.0;}
 let r=scene[2]+relative;let pmf=fl(r+20u);if(pmf<=0.0){return 1.0;}
 if(meshMotion(h.mesh)!=0u||meshDeforms(h)){
  // The face at the hit's time, as sampleMeshEmitter takes it: the same area and normal, so the two weights sum to 1.
  let area=meshArea(meshModel(h),meshVertex(h,0u),meshVertex(h,1u),meshVertex(h,2u));if(!(area>1e-30)){return 1.0;}
  let moved=abs(dot(triangleNormal(h),d));if(moved<=0.0){return 1.0;}
  return power2(lastPdf,pmf/area*h.t*h.t/moved);
 }
 let cosine=abs(dot(vec3f(fl(r+12u),fl(r+13u),fl(r+14u)),d));
 if(cosine<=0.0){return 1.0;}
 return power2(lastPdf,pmf/fl(r+7u)*h.t*h.t/cosine);
}
// A point on an emissive face, at the path's own time (one time per path, Cook, Porter and Carpenter 1984), and its
// emitted radiance toward o. A still record (and every record at the close time) reads its stored close-pose corners;
// a moving or deforming one takes its blended object corners through the instance's transform at that time.
fn sampleMeshEmitter(o:vec3f)->LightPoint {
 var result:LightPoint;let header=meshLights();if(header==0u||scene[header]==0u){return result;}
 let records=scene[2]+scene[header+1u];var lo=0u;var hi=scene[header]-1u;let pick=rand();
 while(lo<hi){let mid=(lo+hi)/2u;if(fl(records+mid*24u+3u)<=pick){lo=mid+1u;}else{hi=mid;}}
 let r=records+lo*24u;let root=sqrt(rand());let v=rand();let bary=vec2f(root*(1.0-v),root*v);
 var h:Hit;h.inst=TRIANGLE;h.tri=scene[2]+scene[r+16u];h.meshHead=scene[2]+scene[r+17u];h.mesh=scene[2]+scene[r+18u];h.value=scene[r+19u];h.bary=bary;
 if(meshMotion(h.mesh)==0u&&!meshDeforms(h)){
  if(fl(r+7u)<=0.0){return result;}
  result.p=vec3f(fl(r),fl(r+1u),fl(r+2u))*(1.0-root)+vec3f(fl(r+4u),fl(r+5u),fl(r+6u))*bary.x+vec3f(fl(r+8u),fl(r+9u),fl(r+10u))*bary.y;
  result.n=vec3f(fl(r+12u),fl(r+13u),fl(r+14u));result.twoSided=scene[r+15u]!=0u;result.pdfA=fl(r+20u)/fl(r+7u);
 } else {
  // meshClosest's model transform at this time, kept on the face as a hit keeps it (Hit.ml), and meshBlas's normal rule.
  let lx=meshLocal(h.mesh);h.ml=lx;
  let p0=meshVertex(h,0u);let p1=meshVertex(h,1u);let p2=meshVertex(h,2u);
  let c=cross(p1-p0,p2-p0);h.ng=meshCorner(h.tri+12u);if(meshDeforms(h)&&dot(c,c)>1e-30){h.ng=normalize(c);}
  let area=meshArea(lx,p0,p1,p2);if(!(area>1e-30)){return result;}
  var world=meshX(h.mesh);if(meshMotion(h.mesh)!=0u){world=invertX(lx);}
  result.p=xpoint(world,p0*(1.0-root)+p1*bary.x+p2*bary.y);result.n=triangleNormal(h);
  result.twoSided=scene[r+15u]!=0u;result.pdfA=fl(r+20u)/area;result.moving=true;
 }
 // Emitted radiance once the outgoing direction is known, for a point that faces o (or a two-sided face) only.
 let d=result.p-o;let wi=d/sqrt(dot(d,d));
 if(result.twoSided||-dot(result.n,wi)>0.0){
  let wo=-wi;h.sgn=select(-1.0,1.0,dot(triangleNormal(h),wo)>=0.0);result.radiance=meshEmitterRadiance(h,result.p,wo);
 }
 return result;
}
fn iesInterval(at:u32,count:u32,angle:f32)->vec2f {
 if(count==1u){return vec2f(0.0);}
 var lo=0u;var hi=count-1u;
 while(lo+1u<hi){let mid=(lo+hi)/2u;if(fl(at+mid)<=angle){lo=mid;}else{hi=mid;}}
 return vec2f(f32(lo),clamp((angle-fl(at+lo))/(fl(at+lo+1u)-fl(at+lo)),0.0,1.0));
}
fn iesCandela(r:u32,d:vec3f)->f32 {
 let relative=scene[r+20u];if(relative==0u){return 1.0;}
 let at=scene[2]+relative;let nv=scene[r+21u];let nh=scene[r+22u];let horizontal=at+nv;let table=horizontal+nh;
 let polar=acos(clamp(dot(d,vec3f(fl(r+4u),fl(r+5u),fl(r+6u))),-1.0,1.0))*180.0/PI;
 if(polar<fl(at)||polar>fl(at+nv-1u)){return 0.0;}
 let x=dot(d,vec3f(fl(r+8u),fl(r+9u),fl(r+10u)));let y=dot(d,vec3f(fl(r+12u),fl(r+13u),fl(r+14u)));
 var azimuth=0.0;if(x!=0.0||y!=0.0){azimuth=atan2(y,x)*180.0/PI;}
 azimuth=azimuth-floor(azimuth/360.0)*360.0;
 let end=fl(horizontal+nh-1u);
 if(end<=180.0&&azimuth>180.0){azimuth=360.0-azimuth;}
 if(end<=90.0&&azimuth>90.0){azimuth=180.0-azimuth;}
 let vertical=iesInterval(at,nv,polar);let plane=iesInterval(horizontal,nh,azimuth);
 let v0=u32(vertical.x);let v1=min(v0+1u,nv-1u);let h0=u32(plane.x);let h1=min(h0+1u,nh-1u);
 let a=mix(fl(table+h0*nv+v0),fl(table+h0*nv+v1),vertical.y);
 let b=mix(fl(table+h1*nv+v0),fl(table+h1*nv+v1),vertical.y);
 return mix(a,b,plane.y)*fl(r+23u);
}
struct MeshSpotSample {wi:vec3f,dist:f32,radiance:vec3f}
fn sampleMeshSpot(o:vec3f)->MeshSpotSample {
 var result:MeshSpotSample;let header=meshLights();if(header==0u||scene[header+2u]==0u){return result;}
 let count=scene[header+2u];let chosen=min(u32(rand()*f32(count)),count-1u);let r=scene[2]+scene[header+3u]+chosen*32u;
 let v=vec3f(fl(r),fl(r+1u),fl(r+2u))-o;let d2=dot(v,v);if(d2<=0.0){return result;}
 result.dist=sqrt(d2);result.wi=v/result.dist;
 let cosine=dot(-result.wi,vec3f(fl(r+4u),fl(r+5u),fl(r+6u)));
 let cone=clamp((cosine-fl(r+11u))/(fl(r+7u)-fl(r+11u)),0.0,1.0);
 var falloff=cone*cone;let range=fl(r+15u);if(range>0.0){let ratio=result.dist/range;falloff*=pow(max(1.0-ratio*ratio*ratio*ratio,0.0),2.0);}
 result.radiance=vec3f(fl(r+16u),fl(r+17u),fl(r+18u))*iesCandela(r,-result.wi)*falloff*f32(count)/d2;
 return result;
}
`;
/** Light proposals and their reciprocal path-hit PDFs specialize only the mesh entry. */
export function meshLightingSource(input: string): string {
  let source = input;
  const edit = (from: string, to: string) => {
    if (!source.includes(from))
      throw new MargoError(
        'state',
        'Mesh light kernel mismatch; rebuild: https://margoengine.com/errors#voxel-pathtracer',
      );
    source = source.replace(from, to);
  };
  edit('fn direct(', LIGHTS + '\nfn direct(');
  edit('q<5u', 'q<meshProposalCount()');
  edit('} else if(q<3u){', '} else if(q<3u||q==5u){');
  // Only kind 1's text is left out of the anchor: the resampled feature replaces it, in either order.
  edit('}else{ls=sampleArea();}', '}else if(q==2u){ls=sampleArea();}else{ls=sampleMeshEmitter(o);}');
  edit(
    'radiance=ls.radiance;lp=ls.pdfA*d2/cl;',
    `radiance=ls.radiance;lp=ls.pdfA*d2/cl;
   if(q==5u){
    // sampleMeshEmitter resolved the emitted radiance. A moving point comes through a Float32 invertX while the hit
    // it must not see is found in object space, so its shadow ray stops further short (Wachter and Binder 2019).
    dist=max(0.0,dist-max(1e-5,max(max(abs(ls.p.x),abs(ls.p.y)),abs(ls.p.z))*select(9.53674316e-7,MESH_LIGHT_SLACK,ls.moving)));
   }`,
  );
  edit('twoSided:bool}', 'twoSided:bool,moving:bool}');
  edit(
    '  } else {\n   if((*w).total==0.0)',
    `  } else if(q==6u){
   if(!air){continue;}let spot=sampleMeshSpot(o);if(spot.dist<=0.0||!any(spot.radiance>vec3f(0.0))){continue;}
   wi=spot.wi;dist=spot.dist;radiance=spot.radiance;
  } else {
   if((*w).total==0.0)`,
  );
  edit('if(h.inst==TRIANGLE){return 1.0;}', 'if(h.inst==TRIANGLE){return meshEmitterWeight(h,d,lastPdf);}');
  return source;
}
