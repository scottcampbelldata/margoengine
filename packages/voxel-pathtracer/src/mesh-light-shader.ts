import {MargoError} from '@margoengine/math/errors';
const LIGHTS=/* wgsl */ `
var<private> meshLightRecord:u32;
var<private> meshLightBary:vec2f;
fn meshLights()->u32 {
 let g=scene[2];if(g==0u||scene[g+1u]!=0u||scene[g+12u]==0u){return 0u;}return g+scene[g+12u];
}
fn meshProposalCount()->u32 {let header=meshLights();if(header==0u){return 5u;}return scene[header+4u];}
fn meshEmitterRadiance(h:Hit,p:vec3f,wo:vec3f)->vec3f {return material(h.value).emission;}
fn meshEmitterWeight(h:Hit,d:vec3f,lastPdf:f32)->f32 {
 if(lastPdf<=0.0||h.mesh==0u){return 1.0;}
 let lookup=scene[h.mesh+30u];if(lookup==0u){return 1.0;}
 let ordinal=(h.tri-h.meshHead-scene[h.meshHead+1u])/16u;
 let relative=scene[scene[2]+lookup+ordinal];if(relative==0u){return 1.0;}
 let r=scene[2]+relative;let pmf=fl(r+20u);if(pmf<=0.0){return 1.0;}
 let cosine=abs(dot(vec3f(fl(r+12u),fl(r+13u),fl(r+14u)),d));
 if(cosine<=0.0){return 1.0;}
 return power2(lastPdf,pmf/fl(r+7u)*h.t*h.t/cosine);
}
fn sampleMeshEmitter()->LightPoint {
 var result:LightPoint;let header=meshLights();if(header==0u||scene[header]==0u){return result;}
 let records=scene[2]+scene[header+1u];var lo=0u;var hi=scene[header]-1u;let pick=rand();
 while(lo<hi){let mid=(lo+hi)/2u;if(fl(records+mid*24u+3u)<=pick){lo=mid+1u;}else{hi=mid;}}
 let r=records+lo*24u;meshLightRecord=r;let root=sqrt(rand());let v=rand();let bary=vec2f(root*(1.0-v),root*v);
 meshLightBary=bary;result.p=vec3f(fl(r),fl(r+1u),fl(r+2u))*(1.0-root)+vec3f(fl(r+4u),fl(r+5u),fl(r+6u))*bary.x+vec3f(fl(r+8u),fl(r+9u),fl(r+10u))*bary.y;
 result.n=vec3f(fl(r+12u),fl(r+13u),fl(r+14u));result.twoSided=scene[r+15u]!=0u;result.pdfA=fl(r+20u)/fl(r+7u);
 // Resolve PBR textures/cutout after the light point and outgoing direction are known.
 return result;
}
fn meshSampleRadiance(p:vec3f,wo:vec3f,record:u32,bary:vec2f)->vec3f {
 var h:Hit;h.inst=TRIANGLE;h.tri=scene[2]+scene[record+16u];h.meshHead=scene[2]+scene[record+17u];h.mesh=scene[2]+scene[record+18u];h.value=scene[record+19u];h.bary=bary;h.sgn=select(-1.0,1.0,dot(triangleNormal(h),wo)>=0.0);
 return meshEmitterRadiance(h,p,wo);
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
export function meshLightingSource(input:string):string {
 let source=input;
 const edit=(from:string,to:string)=>{if(!source.includes(from))throw new MargoError('state','Mesh light kernel mismatch; rebuild: https://margoengine.com/errors#voxel-pathtracer');source=source.replace(from,to);};
 edit('fn direct(',LIGHTS+'\nfn direct(');
 edit('q<5u','q<meshProposalCount()');
 edit('} else if(q<3u){','} else if(q<3u||q==5u){');
 edit('if(q==1u){ls=sampleEmitter();}else{ls=sampleArea();}',
      'if(q==1u){ls=sampleEmitter();}else if(q==2u){ls=sampleArea();}else{ls=sampleMeshEmitter();}');
 edit('radiance=ls.radiance;lp=ls.pdfA*d2/cl;',`radiance=ls.radiance;lp=ls.pdfA*d2/cl;
   if(q==5u){
    // The sampled face identity and barycentrics are private invocation state.
    radiance=meshSampleRadiance(ls.p,-wi,meshLightRecord,meshLightBary);
    dist=max(0.0,dist-max(1e-5,max(max(abs(ls.p.x),abs(ls.p.y)),abs(ls.p.z))*9.53674316e-7));
   }`);
 edit('  } else {\n   if((*w).total==0.0)',`  } else if(q==6u){
   if(!air){continue;}let spot=sampleMeshSpot(o);if(spot.dist<=0.0||!any(spot.radiance>vec3f(0.0))){continue;}
   wi=spot.wi;dist=spot.dist;radiance=spot.radiance;
  } else {
   if((*w).total==0.0)`);
 edit('if(h.inst==TRIANGLE){return 1.0;}','if(h.inst==TRIANGLE){return meshEmitterWeight(h,d,lastPdf);}');
 return source;
}
