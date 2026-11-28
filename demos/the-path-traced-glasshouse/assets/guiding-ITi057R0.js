import{o as e,s as t}from"./scene-CDweMbTu.js";function n(e){if(typeof e!=`number`)throw TypeError(`GuidedVoxelPathTracer guideStrength must be a number`);if(!Number.isFinite(e)||e<0||e>.95)throw RangeError(`GuidedVoxelPathTracer guideStrength must be finite and between 0 and 0.95`);return e}function r(e={}){t(e,`causticGuiding`);let r=n(e.guideStrength===void 0?.5:e.guideStrength);return Object.freeze({id:`guiding`,source:e=>i(e,r)})}function i(t,n){if(n===0)return t;let r=[[`let e=evalAt(kind,m,n,wo,wi,lobes);`,`var e=evalAt(kind,m,n,wo,wi,lobes);if(kind==0u&&air&&guideable(m)){e.pdf=guidePdf(o,n,wi);}`],[`let s=sampleSurface(m,n,wo,etaI);`,`let s=guidedSurface(m,n,wo,etaI,p+off,inAir);`],[`var medium=0u;var mInst=NONE;`,`var guideRoulette=1.0;var medium=0u;var mInst=NONE;`],[`
  thr*=s.w;
  if(s.transmit){`,`
  if(inAir&&guideable(m)&&guideCount()>0u){guideRoulette=clamp(guideRoulette*s.pdf/max(dot(n,s.wi)*INV_PI,1e-20),1e-20,1e20);}
  thr*=s.w;
  if(s.transmit){`]];if(r.some(([e])=>!t.includes(e)))throw new e(`state`,`Caustic guiding kernel does not match this tracer; rebuild the package, see https://margoengine.com/errors#voxel-pathtracer`);let i=t;for(let[e,t]of r)i=i.replace(e,t);i=i.replaceAll(`roulette(&thr,bounces)`,`guidedRoulette(&thr,bounces,guideRoulette)`);let a=`
fn guidedRoulette(thr:ptr<function,vec3f>,bounces:u32,guideScale:f32)->bool {
 if(bounces<3u){return true;}
 let q=clamp(max(max((*thr).x,(*thr).y),(*thr).z)*guideScale,0.05,1.0);
 if(rand()>=q){return false;}*thr/=q;return true;
}
fn guideable(m:Mat)->bool {return m.glass==0.0&&m.metal==0.0&&m.spec==0.0;}
fn guideCount()->u32 {return scene[scene[1]+1u];}
struct GuideBox {size:vec3f,origin:vec3f,local:Xform,world:Xform,area:vec3f,side:vec3f,total:f32,inside:bool}
fn guideFace(g:GuideBox,axis:u32,sign:f32)->bool {
 if(!g.inside){return g.side[axis]==sign;}
 return select(g.origin[axis]>0.0,g.origin[axis]<g.size[axis],sign>0.0);
}
fn guideBox(o:vec3f,k:u32)->GuideBox {
 let inst=scene[scene[scene[1]]+2u*k];
 let mb=f.scene.x+scene[f.scene.y+inst*INSTANCE+36u]*MODEL;
 var g:GuideBox;
 g.size=vec3f(f32(scene[mb]),f32(scene[mb+1u]),f32(scene[mb+2u]));
 let x=instX(inst);g.world=x.world;g.local=x.local;
 let u=colOf(g.world,0u);let v=colOf(g.world,1u);let w=colOf(g.world,2u);
 g.area=vec3f(length(cross(v,w))*g.size.y*g.size.z,length(cross(w,u))*g.size.z*g.size.x,length(cross(u,v))*g.size.x*g.size.y);
 let p=xpoint(g.local,o);
 g.origin=p;
 g.side=select(select(vec3f(0.0),vec3f(1.0),p>g.size),vec3f(-1.0),p<vec3f(0.0));
 g.inside=all(g.side==vec3f(0.0));
 for(var face=0u;face<6u;face++){
  let axis=face>>1u;let sign=select(-1.0,1.0,(face&1u)!=0u);
  if(guideFace(g,axis,sign)){g.total+=g.area[axis];}
 }
 return g;
}
fn boxPdf(o:vec3f,wi:vec3f,g:GuideBox)->f32 {
 let p=xpoint(g.local,o);let d=xdir(g.local,wi);
 var near=-INF;var far=INF;var na=0u;var fa=0u;
 for(var a=0u;a<3u;a++){
  if(abs(d[a])<1e-20){if(p[a]<0.0||p[a]>g.size[a]){return 0.0;}continue;}
  let t0=-p[a]/d[a];let t1=(g.size[a]-p[a])/d[a];
  let lo=min(t0,t1);let hi=max(t0,t1);
  if(lo>near){near=lo;na=a;}if(hi<far){far=hi;fa=a;}
 }
 if(far<=max(near,0.0)){return 0.0;}
 let t=select(near,far,g.inside);let axis=select(na,fa,g.inside);
 let cosine=abs(dot(normalize(rowOf(g.local,axis)),wi));
 if(t<=0.0||cosine<=0.0){return 0.0;}
 return t*t/(g.total*cosine);
}
fn guidePdf(o:vec3f,n:vec3f,wi:vec3f)->f32 {
 let count=guideCount();let base=max(dot(n,wi),0.0)*INV_PI;
 if(count==0u){return base;}
 var pdf=0.0;
 for(var k=0u;k<count;k++){pdf+=boxPdf(o,wi,guideBox(o,k))/f32(count);}
 return ${(1-n).toPrecision(9)}*base+${n.toPrecision(9)}*pdf;
}
fn guidedSurface(m:Mat,n:vec3f,wo:vec3f,etaI:f32,o:vec3f,air:bool)->Bounce {
 let count=guideCount();
 if(!air||!guideable(m)||count==0u){return sampleSurface(m,n,wo,etaI);}
 var s:Bounce;
 let guided=rand()<${n.toPrecision(9)};
 var k=0u;
 if(guided){k=min(u32(rand()*f32(count)),count-1u);}else{s.wi=cosineDir(n);}
 var pdf=0.0;
 for(var j=select(1u,0u,guided);j<=count;j++){
  let g=guideBox(o,select(j-1u,k,j==0u));
  if(j>0u){pdf+=boxPdf(o,s.wi,g)/f32(count);continue;}
  var pick=rand()*g.total;var selected=0u;var open=true;
  for(var face=0u;face<6u;face++){
   let axis=face>>1u;let sign=select(-1.0,1.0,(face&1u)!=0u);
   if(open&&guideFace(g,axis,sign)){pick-=g.area[axis];selected=face;open=pick>0.0;}
  }
  let axis=selected>>1u;var p=vec3f(0.0);
  p[axis]=select(0.0,g.size[axis],(selected&1u)!=0u);
  p[(axis+1u)%3u]=rand()*g.size[(axis+1u)%3u];
  p[(axis+2u)%3u]=rand()*g.size[(axis+2u)%3u];
  let v=xpoint(g.world,p)-o;
  if(dot(v,v)==0.0){return s;}
  s.wi=normalize(v);
 }
 s.pdf=${(1-n).toPrecision(9)}*(max(dot(n,s.wi),0.0)*INV_PI)+${n.toPrecision(9)}*pdf;
 if(s.pdf<=0.0||dot(n,s.wi)<=0.0){return s;}
 let e=evalSurface(m,n,wo,s.wi);
 s.w=e.f/s.pdf;s.ok=true;
 return s;
}
`;return i.replace(`@compute @workgroup_size(8,8) fn trace`,a+`
@compute @workgroup_size(8,8) fn trace`)}export{r as causticGuiding};