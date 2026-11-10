import {sheenBrdfWGSL,sheenAlbedoWGSL} from '../../shared/sheen.js';
import {iridescenceWgsl} from '../../shared/iridescence.js';
// Optional-only material state. Sampling and evaluation share complete mixture
// densities; rejected geometric-hemisphere directions keep their null probability.
export const PBR_LOBES=/* wgsl */ `
${sheenBrdfWGSL('pbrSheenBRDF')}
${sheenAlbedoWGSL('pbrSheenAlbedo')}
${iridescenceWgsl}
struct PBRLayer {coat:f32,coatAlpha:f32,coatN:vec3f,sheen:vec3f,sheenR:f32,specRGB:vec3f,specWeight:f32,film:vec3f,viewF:vec3f}
// Only the current surface owns this invocation's layer. Emitter queries use
// pbrEmitterRadiance and preserve it while the current BSDF is being evaluated.
var<private> pbrLayer:PBRLayer;
fn pbrPeak(v:vec3f)->f32 {return max(v.x,max(v.y,v.z));}
fn pbrCoatWeight(m:Mat,wo:vec3f)->f32 {
 return pbrLayer.coat*schlick1(.04,clamp(abs(dot(pbrLayer.coatN,wo)),0.0,1.0));
}
fn pbrEmitted(m:Mat,wo:vec3f)->vec3f {
 if(m.pbr==0u){return m.emission;}return m.emission*(1.0-pbrCoatWeight(m,wo));
}
fn pbrFresnel(m:Mat,cosine:f32)->vec3f {
 let dielectric=pbrLayer.specWeight*schlick3(min(.04*pbrLayer.specRGB,vec3f(1.0)),cosine);
 let plain=mix(dielectric,schlick3(m.metalColor,cosine),m.metal);
 if(pbrLayer.film.x<=0.0||pbrLayer.film.z<=0.0){return plain;}
 let base=mix(min(.04*pbrLayer.specRGB,vec3f(1.0))*pbrLayer.specWeight,m.metalColor,m.metal);
 return mix(plain,clamp(margoIridescence(base,cosine,pbrLayer.film.z,pbrLayer.film.y),vec3f(0.0),vec3f(1.0)),pbrLayer.film.x);
}
fn pbrPrepareView(m:Mat,n:vec3f,wo:vec3f) {
 pbrLayer.viewF=pbrFresnel(m,clamp(dot(n,wo),0.0,1.0));
}
fn pbrBasePick(m:Mat)->f32 {
 return clamp(mix(pbrPeak(pbrLayer.viewF),1.0,m.metal),0.0,1.0);
}
fn pbrBaseEval(m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {
 var e:Eval;let ci=dot(n,wi);let co=dot(n,wo);if(ci<=0.0||co<=0.0){return e;}
 let half=normalize(wo+wi);let vh=clamp(dot(wo,half),0.0,1.0);let fr=pbrFresnel(m,vh);
 let pick=pbrBasePick(m);e.pdf=(1.0-pick)*ci*INV_PI;
 if((mask&1u)!=0u){e.f=(1.0-m.metal)*(1.0-pbrPeak(fr))*m.color*ci*INV_PI;}
 if((m.flags&SMOOTH)==0u){
  let a2=m.alpha*m.alpha;let d=ggxD(a2,max(dot(n,half),0.0));let lo=lambdaG(a2,co);
  e.pdf+=pick*d/(4.0*co*(1.0+lo));
  if((mask&2u)!=0u){
   e.f+=fr*d/(4.0*co*(1.0+lo+lambdaG(a2,ci)));
   if(m.metal>0.0&&(f.config.z&NO_COMPENSATION)==0u){
    let rough=sqrt(m.alpha);let ea=tableEavg(rough);let q=clamp(1.0-tableE(co,rough),0.0,1.0);
    let fa=m.metalColor+(1.0-m.metalColor)/21.0;
    e.f+=m.metal*fa*fa*ea/(1.0-fa*(1.0-ea))*q*(1.0-tableE(ci,rough))/(PI*max(1.0-ea,1e-4))*ci;
   }
  }
 }
 return e;
}
fn pbrMixture(m:Mat,n:vec3f,wo:vec3f)->vec3f {
 let coat=pbrCoatWeight(m,wo);
 let sheen=clamp(pbrPeak(pbrLayer.sheen)*pbrSheenAlbedo(max(dot(n,wo),0.0),pbrLayer.sheenR),0.0,1.0);
 return vec3f((1.0-coat)*(1.0-sheen),(1.0-coat)*sheen,coat);
}
fn pbrLayerEvalPrepared(m:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {
 let weights=pbrMixture(m,n,wo);let ci=dot(n,wi);let co=dot(n,wo);let half=normalize(wo+wi);
 var e=pbrBaseEval(m,n,wo,wi,mask);e.pdf*=weights.x;
 let coat=pbrCoatWeight(m,wo);var sheenScale=1.0;
 if(ci>0.0&&co>0.0){
  let peak=pbrPeak(pbrLayer.sheen);sheenScale=min(1.0-peak*pbrSheenAlbedo(co,pbrLayer.sheenR),1.0-peak*pbrSheenAlbedo(ci,pbrLayer.sheenR));
  if((mask&2u)!=0u){e.f=e.f*sheenScale+pbrLayer.sheen*pbrSheenBRDF(pbrLayer.sheenR,ci,co,max(dot(n,half),0.0))*ci;}else{e.f*=sheenScale;}
  e.pdf+=weights.y/(2.0*PI);
 }
 e.f*=1.0-coat;
 let cc=dot(pbrLayer.coatN,wo);let cl=dot(pbrLayer.coatN,wi);
 if(cc>0.0&&cl>0.0&&pbrLayer.coatAlpha>0.0){
  let a2=pbrLayer.coatAlpha*pbrLayer.coatAlpha;let d=ggxD(a2,max(dot(pbrLayer.coatN,half),0.0));let lo=lambdaG(a2,cc);
  e.pdf+=weights.z*d/(4.0*cc*(1.0+lo));
  if((mask&2u)!=0u){e.f+=vec3f(coat*d/(4.0*cc*(1.0+lo+lambdaG(a2,cl))));}
 }
 return e;
}
fn pbrLayerEval(input:Mat,n:vec3f,wo:vec3f,wi:vec3f,mask:u32)->Eval {
 pbrPrepareView(input,n,wo);return pbrLayerEvalPrepared(input,n,wo,wi,mask);
}
fn pbrLayerSamplePrepared(m:Mat,n:vec3f,wo:vec3f)->Bounce {
 var s:Bounce;let weights=pbrMixture(m,n,wo);let pick=rand();
 if(pick<weights.z){
  s.lobe=1u;var normal=pbrLayer.coatN;
  if(pbrLayer.coatAlpha>0.0){normal=vndf(wo,pbrLayer.coatAlpha,pbrLayer.coatN);}else{s.lobe=2u;}
  s.wi=reflect(-wo,normal);if(dot(s.wi,pbrLayer.coatN)<=0.0||dot(wo,pbrLayer.coatN)<=0.0){return s;}
  if(s.lobe==2u){s.w=vec3f(1.0);s.ok=true;return s;}
 }else if(pick<weights.z+weights.y){
  let z=rand();let phi=TAU*rand();let radius=sqrt(max(0.0,1.0-z*z));s.wi=basis(n)*vec3f(radius*cos(phi),radius*sin(phi),z);s.lobe=1u;
 }else{
  let spec=pbrBasePick(m);
  if(rand()<spec){
   s.lobe=1u;var normal=n;
   if((m.flags&SMOOTH)==0u){normal=vndf(wo,m.alpha,n);}else{s.lobe=2u;}
   s.wi=reflect(-wo,normal);if(dot(s.wi,n)<=0.0){return s;}
   if(s.lobe==2u){
    let peak=pbrPeak(pbrLayer.sheen);let scale=min(1.0-peak*pbrSheenAlbedo(dot(n,wo),pbrLayer.sheenR),1.0-peak*pbrSheenAlbedo(dot(n,s.wi),pbrLayer.sheenR));
    s.w=pbrLayer.viewF*scale*(1.0-weights.z)/max(weights.x*spec,1e-20);s.ok=true;return s;
   }
  }else{s.wi=cosineDir(n);s.lobe=0u;}
 }
 let e=pbrLayerEvalPrepared(m,n,wo,s.wi,3u);if(e.pdf<=0.0){return s;}s.w=e.f/e.pdf;s.pdf=e.pdf;s.ok=true;return s;
}
fn pbrLayerSample(input:Mat,n:vec3f,wo:vec3f)->Bounce {
 pbrPrepareView(input,n,wo);return pbrLayerSamplePrepared(input,n,wo);
}
`;
