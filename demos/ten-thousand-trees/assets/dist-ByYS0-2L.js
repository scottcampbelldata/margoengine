import{D as e,E as t,M as n,O as r,T as i,j as a}from"./index-OO1e78gK.js";import{r as o,t as s}from"./errors-D8rc8kzg-DREbrEsS.js";import{t as c}from"./surface-effects-B8wNNEcQ-BIsK3E9V.js";import{_ as l,a as u,c as d,d as f,f as p,g as m,h,i as g,l as _,m as v,n as y,p as b,r as x,s as S,t as C,u as w}from"./query-state-bmQwt1Q1-N7FwNYnI.js";function T(e){return!!e&&typeof e==`object`&&`equirectTexture`in e}function E(e){return typeof e==`function`?e():e?.equirectTexture}function D(e,t,n,r=n+1,i=1){let a=e&&typeof e!=`function`?e:void 0,o=a?.rotation??0,s=a?.radianceScale??1;if(!Number.isFinite(o)||!Number.isFinite(s)||s<=0||s>34028234663852886e22)throw RangeError(`Water sky needs a finite rotation and a positive finite radiance scale`);t[n]=a?.25+o/(2*Math.PI)%1:0,t[r]=a?s:i}var O=`
fn seaSkyUv(ray:vec3f,turn:f32)->vec2f {
  var u=0.5;
  if(dot(ray.xz,ray.xz)>1e-12){u+=atan2(ray.z,ray.x)*0.1591549431;}
  return vec2f(u+turn,acos(clamp(ray.y,-1.0,1.0))*0.3183098862);
}`,k=`fn pbrNeutral(input:vec3f)->vec3f {let x=min(input.r,min(input.g,input.b));let offset=select(0.04,x-6.25*x*x,x<0.08);var v=input-offset;let peak=max(v.r,max(v.g,v.b));if(peak<0.76){return v;}let newPeak=1.0-0.24*0.24/(peak+0.24-0.76);v*=newPeak/peak;return mix(v,vec3f(newPeak),1.0-1.0/(0.15*(peak-newPeak)+1.0));}
fn toDisplay(c:vec3f)->vec3f {let x=pbrNeutral(max(c,vec3f(0)));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
`,A=(e,t,n=`nh`,r=`a2`)=>`(max(dot(cross(${e},${t}),cross(${e},${t})),step(${n},0.0))+${r}*${n}*${n})`;function j(e,t,n){let r=Math.hypot(n[0],n[1],n[2]);e[t]=n[0]/r,e[t+1]=n[1]/r,e[t+2]=n[2]/r,e[t+3]=n[3]}var M=e=>typeof e==`string`&&e.endsWith(`float`),N=9.81,P=8;function F(e){return L(`windSpeed`,e,0,100),Math.min(1,384e-8*e**3.41)}function I(e=P){return R(e),e===1?[Math.sqrt(3e3)]:Array.from({length:e},(t,n)=>2*750**(n/(e-1)))}function L(e,t,n,r){if(typeof t!=`number`||!Number.isFinite(t)||t<n||t>r)throw o(`unsupported`,`Invalid sea ${e}; use a number from ${n} to ${r}`,`ocean`)}function R(e){if(!Number.isInteger(e)||e<1||e>P)throw o(`unsupported`,`Invalid sea trains; use an integer from 1 to 8`,`ocean`)}function z(e,t){let n=e<=t?.07:.09,r=Math.exp(-((e-t)**2)/(2*n*n*t*t));return e**-5*Math.exp(-1.25*(t/e)**4)*3.3**r}var B=[1,.3];function V(e,t={}){let{fetch:n=1e5,direction:r=B,trains:i=P,seed:a=0}=t;L(`windSpeed`,e,0,100),L(`fetch`,n,1,1e7),L(`seed`,a,-1e9,1e9),R(i);let s=Math.hypot(r[0],r[1]);if(r.length!==2||!Number.isFinite(s)||!s)throw o(`unsupported`,`Invalid sea direction; use a nonzero [x, z]`,`ocean`);let c=I(i),l=e===0,u=e*e,d=l?0:.0016*Math.sqrt(N*n/u)*u/N,f=l?0:.22*u/N,p=Math.min(d,f),m=l?1:N/e*3.5*(N*n/u)**-.33,h=l?1:.13*N/e,g=Math.max(m,h),_=[],v=i===1?750:750**(1/(i-1)),y=c.map(e=>{if(l)return 0;let t=e/Math.sqrt(v),n=e*Math.sqrt(v),r=e=>Math.sqrt(N/(2*Math.PI*e)),i=r(n),a=r(t),o=0;for(let e=0;e<200;e++){let t=i*(a/i)**((e+.5)/200);o+=z(t,g)*t*Math.log(a/i)/200}return o}),b=y.reduce((e,t)=>e+t,0),x=l?0:N/(2*Math.PI*g*g),S=(p/4)**2,C=[r[0]/s,r[1]/s],w=Math.atan2(C[1],C[0]),T=c.map((e,t)=>t).reverse(),E=c.reduce((e,t,n)=>!l&&Math.abs(Math.log(t/x))<Math.abs(Math.log(c[e]/x))?n:e,0),D=1;for(let e of T){let t=c[e],n=2*Math.PI/t,r=b>0?Math.sqrt(2*S*y[e]/b):0,o=l?0:Math.abs(Math.log2(t/x)),s=w+(e===E?0:Math.min(75,12*(1+o))*(Math.PI/180)*D),u=r*n*i,d=u>0?Math.min(.6,.95/u):.6;e!==E&&(D=-D),_.push({direction:[Math.cos(s),Math.sin(s)],amplitude:r,wavelength:t,steepness:d,phase:((e+1)*2.399963229728653+a)%(2*Math.PI)})}return{windSpeed:e,significantHeight:p,peakPeriod:l?0:1/g,peakWavelength:x,fullyDeveloped:!l&&(m<=h||d>=f),whitecapCoverage:l?0:F(e),waves:_}}var ee=(e,t=`1.0.0`,n=import.meta.url)=>r(e,t,n),te=e=>e*9+5,ne=1/45,re=Math.round(40/(3*ne)),ie=`

var<private> surfShift:f32;

fn surfClock(n:u32)->vec2f {let at=n*9u+3u;if(arrayLength(&connected)<=at+1u){return vec2f(0);}return vec2f(bitcast<f32>(connected[at]),bitcast<f32>(connected[at+1u]));}

const SURF_GAMMA=0.78;

const SURF_SWASH=vec2f(0.35,0.9);

fn surfK(k0:f32,d:f32)->f32 {return k0/pow(tanh(min(pow(k0*max(d,0.01),0.75),10.0)),0.6666667);}

fn surfShoal(k0:f32,d:f32)->f32 {let k=surfK(k0,d);let kh=min(k*max(d,0.01),10.0);return sqrt(0.5*k/((0.5+kh/sinh(2.0*kh))*k0));}



fn surfFieldK()->f32 {var k=1e9;var top=0.0;for(var j=0u;j<u32(frame.settings.w);j++){if(frame.waves[j].wave.z>top){top=frame.waves[j].wave.z;k=frame.waves[j].wave.w*0.84;}}return k;}
fn surfReady(n:u32)->bool {let flag=n*9u+1u;return frame.flow.w>0.5&&arrayLength(&connected)>flag+1u&&connected[flag]==1u;}
struct SurfField {source:vec2f,tau:f32,weight:f32}

fn surfField(xz:vec2f,size:vec2i)->SurfField {
 let n=u32(size.x*size.y);if(!surfReady(n)){return SurfField(xz,0.0,0.0);}
 let uv=(xz-frame.coast.xy)/frame.coast.zw;
 let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let lo=vec2i(floor(pixel));let hi=min(lo+1,size-1);let t=fract(pixel);
 let weights=vec4f((1.0-t.x)*(1.0-t.y),t.x*(1.0-t.y),(1.0-t.x)*t.y,t.x*t.y);
 let cells=array<vec2i,4>(lo,vec2i(hi.x,lo.y),vec2i(lo.x,hi.y),hi);
 var source=vec2f(0);var tau=0.0;var total=0.0;
 for(var c=0;c<4;c++){
  let i=n+1u+u32(cells[c].y*size.x+cells[c].x)*4u;let time=bitcast<f32>(connected[i+2u]);
  if(time<1e29){source+=weights[c]*vec2f(bitcast<f32>(connected[i]),bitcast<f32>(connected[i+1u]));tau+=weights[c]*time;total+=weights[c];}
 }
 if(total<1e-4){return SurfField(xz,0.0,0.0);}
 return SurfField(source/total,tau/total,total);
}


fn surfPcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn surfHash(p:vec2i)->f32 {return f32(surfPcg(bitcast<u32>(p.x)+surfPcg(bitcast<u32>(p.y))))*4.656612875e-10-1.0;}
fn surfNoise(p:vec2f)->f32 {
 let i=vec2i(floor(p));let f=fract(p);let u=f*f*(3.0-2.0*f);
 return mix(mix(surfHash(i),surfHash(i+vec2i(1,0)),u.x),mix(surfHash(i+vec2i(0,1)),surfHash(i+vec2i(1,1)),u.x),u.y);
}


const SURF_CREST=0.45;const SURF_SWING=0.3;
struct SurfProfile {value:f32,slope:f32}

fn surfProfile(phase:f32,r:f32,phi:f32)->SurfProfile {
 let t=3.14159265-phase;let s=sqrt(1.0-r*r);let lift=r*sin(phi)/(1.0+s);let d=1.0-r*cos(t+phi);
 return SurfProfile(s*(sin(t)+lift)/d,-s*(cos(t)*d-(sin(t)+lift)*r*sin(t+phi))/(d*d));
}

fn surfFoamAt(phase:f32,r:f32,phi:f32)->vec2f {
 let s=sqrt(1.0-r*r);let lift=r*sin(phi)/(1.0+s);

 let p=1.0-lift*r*sin(phi);let q=lift*r*cos(phi);let base=atan2(q,p);let a=acos(clamp(r*cos(phi)/max(length(vec2f(p,q)),1e-6),-1.0,1.0));
 let t1=a-base;let t2=-a-base;let v1=(sin(t1)+lift)/(1.0-r*cos(t1+phi));let v2=(sin(t2)+lift)/(1.0-r*cos(t2+phi));
 let crest=3.14159265-select(t2,t1,v1>=v2);let trough=3.14159265-select(t1,t2,v1>=v2);
 let behind=phase-crest-6.2831853*floor((phase-crest+3.14159265)/6.2831853);
 let front=max(0.3,(trough-crest)-6.2831853*floor((trough-crest)/6.2831853));
 let roller=smoothstep(-0.6,-0.1,behind)*(1.0-smoothstep(0.35*front,0.9*front,behind));
 return vec2f(roller,select(0.0,exp(behind*0.7),behind<0.0));
}










fn surfBreakingShare(beta:f32)->f32 {
 if(beta>=1.0){return 1.0;}if(beta<0.2){return 0.0;}
 let b2=beta*beta;var q=max(exp(-1.0/b2),select(0.0,(2.0*beta-1.0)*(2.0*beta-1.0),beta>0.5));
 for(var i=0;i<4;i++){q=min(1.0,q-(1.0-q+b2*log(q))/(b2/q-1.0));}
 return q;
}
struct SurfPart {gradient:vec2f,phase:f32,amplitude:f32,steepness:f32,swell:f32}
struct Surf {offset:vec3f,dx:vec3f,dz:vec3f,crest:f32,breaking:f32,foam:vec2f,stir:f32,heading:vec2f,zone:f32}






fn surfSample(xz:vec2f,sampleWidth:f32,depth:f32,field:SurfField,foam:bool)->Surf {
 let kField=surfFieldK();let d=max(depth,0.02);
 var parts:array<SurfPart,24>;var count=0u;

 var envelope=vec2f(0);var gCos=vec2f(0);var gSin=vec2f(0);var weight=0.0;var k=0.0;var omega=0.0;var energy=0.0;
 var lead=0.0;var leadPhase=0.0;var deepMean=vec2f(0);var deepTotal=0.0;
 for(var j=0u;j<u32(frame.settings.w);j++){
  let w=frame.waves[j];
  for(var c=0u;c<3u;c++){
   let component=swellComponent(c);let k0=w.wave.w*component.y;let kl=surfK(k0,d);let ks=surfShoal(k0,d);
   let deep=swellAt(w,xz,c,sampleWidth,frame.settings.x+surfShift);let a=w.wave.z*component.z*min(w.shape.w,swellFilter(kl,sampleWidth));
   if(k0<=kField*2.5){

    let s=swellAt(w,field.source,c,sampleWidth,frame.settings.x+surfShift-field.tau);let travel=xz-field.source;
    let u=select(deep.direction,travel*inverseSqrt(max(dot(travel,travel),1e-12)),dot(travel,travel)>1e-6);
    let along=deep.gradient-u*dot(deep.gradient,u);let g=along+u*sqrt(max(kl*kl-dot(along,along),0.0));
    parts[count]=SurfPart(g,s.phase,a*ks,w.shape.x,1.0);
    envelope+=a*ks*vec2f(cos(s.phase),sin(s.phase));gCos+=a*ks*g*cos(s.phase);gSin+=a*ks*g*sin(s.phase);
    weight+=a*ks;k+=a*ks*kl;omega+=a*ks*sqrt(9.81*k0);energy+=a*ks*a*ks;deepMean+=w.wave.z*component.z*deep.direction;deepTotal+=w.wave.z*component.z;
    if(w.wave.z*component.z>lead){lead=w.wave.z*component.z;leadPhase=s.phase;}
   } else {parts[count]=SurfPart(deep.gradient,deep.phase,a*min(ks,1.0),w.shape.x,0.0);energy+=a*min(ks,1.0)*a*min(ks,1.0);}
   count++;
  }
 }
 let size=length(envelope);let high=2.0*size;let saturate=min(1.0,SURF_GAMMA*d/max(high,1e-4));
 let breaking=smoothstep(0.8,1.05,high/(SURF_GAMMA*d));
 var result=Surf(vec3f(0),vec3f(0),vec3f(0),0.0,breaking,vec2f(0),0.0,vec2f(0),surfBreakingShare(2.0*sqrt(energy)/(SURF_GAMMA*d)));
 if(size>1e-5){

  let phase=atan2(envelope.y,envelope.x);let turn=(gCos*envelope.x+gSin*envelope.y)/(size*size);
  let grow=-(envelope.x*gSin-envelope.y*gCos)/size;
  k/=weight;let kd=k*d;let ursell=max(0.375*high*saturate*k/(kd*kd*kd),1e-6);
  let big=0.857/(1.0+exp((-0.471-log(ursell)*0.4342945)/0.297));let psi=-1.5707963+1.5707963*tanh(min(0.815/pow(ursell,0.672),10.0));
  let b=big*sqrt(2.0/(9.0+2.0*big*big));let r=2.0*b/(1.0+b*b);let phi=-1.5707963-psi;
  let profile=surfProfile(phase,r,phi);let slope=saturate*(grow*profile.value+size*profile.slope*turn);
  result.offset.y=saturate*size*profile.value;result.dx.y=slope.x;result.dz.y=slope.y;
  result.crest=smoothstep(0.75,0.98,sin(phase))*smoothstep(0.14,0.32,size*saturate*k);result.heading=turn/max(length(turn),1e-6);
  if(foam&&breaking>0.0){

















   let mean=length(deepMean);let across=select(vec2f(0,1),vec2f(-deepMean.y,deepMean.x)/mean,mean>1e-6);
   let spread=sqrt(max(2.0*(1.0-mean/max(deepTotal,1e-6)),0.0));
   let crest=SURF_CREST*6.2831853/(k*max(spread,0.12));let cycle=leadPhase*0.15915494;let sAlong=dot(xz,across);
   let swing=surfNoise(vec2f(sAlong/crest,cycle))*0.7+surfNoise(vec2f(sAlong*2.7/crest+17.0,cycle*1.9+5.0))*0.3;
   let toe=surfNoise(vec2f(sAlong*4.0/crest+41.0,cycle*1.3+11.0))*0.75+surfNoise(vec2f(sAlong*10.0/crest+7.0,cycle*2.3+3.0))*0.25;
   let onset=smoothstep(0.8,1.05,(high/(SURF_GAMMA*d))*(1.0+SURF_SWING*swing));
   let density=mix(0.3,1.0,smoothstep(-0.45,0.35,swing));
   result.foam=surfFoamAt(phase+0.4*toe,r,phi)*onset*density;
  }




  result.stir=smoothstep(0.1,0.6,size*saturate*(omega/weight)/sinh(min(kd,10.0)));
 }
 for(var i=0u;i<count;i++){
  let part=parts[i];var a=part.amplitude;
  if(part.swell>0.5){a*=saturate;} else {a*=min(1.0,SURF_GAMMA*d/max(2.0*a,1e-4))*(1.0-0.8*breaking);}
  let kc=length(part.gradient);let dir=part.gradient/max(kc,1e-6);

  let q=min(part.steepness*0.9,0.9/(f32(count)*max(a*kc,1e-6)));let s=sin(part.phase);let c=cos(part.phase);
  result.offset+=vec3f(q*a*dir.x*c,0.0,q*a*dir.y*c);
  var derivative=vec3f(-q*a*dir.x*s,0.0,-q*a*dir.y*s);
  if(part.swell<0.5){
   result.offset.y+=a*s;derivative.y=a*c;
   result.crest=max(result.crest,smoothstep(0.75,0.98,s)*smoothstep(0.14,0.32,a*kc));
  }
  result.dx+=derivative*part.gradient.x;result.dz+=derivative*part.gradient.y;
 }
 return result;
}









fn surfSea(xz:vec2f,ground:f32,size:vec2i,sampleWidth:f32)->vec4f {
 var h=frame.settings.y;
 for(var j=0u;j<u32(frame.settings.w);j++){for(var c=0u;c<3u;c++){let s=swellAt(frame.waves[j],xz,c,sampleWidth,frame.settings.x+surfShift);h+=s.amplitude*sin(s.phase);}}
 let depth=frame.settings.y-ground;
 if(surfReady(u32(size.x*size.y))){
  let field=surfField(xz,size);var flux=vec2f(0);
  if(field.weight>0.0){
   let s=surfSample(xz,sampleWidth,depth,field,false);h=mix(h,frame.settings.y+s.offset.y,field.weight);
   flux=s.heading*s.offset.y*sqrt(9.81*max(h-ground,0.01))*field.weight;
  }
  return vec4f(h,smoothstep(SURF_SWASH.x,SURF_SWASH.y,depth),flux);
 }
 return vec4f(h,smoothstep(0.65,2.4,depth),0.0,0.0);
}
`,ae=(e,t)=>e+`
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var<storage,read_write> cells:array<${t?`atomic<u32>`:`u32`}>;
fn word(i:u32)->u32 {return ${t?`atomicLoad(&cells[i])`:`cells[i]`};}
fn put(i:u32,v:u32){${t?`atomicStore(&cells[i],v);`:`cells[i]=v;`}}
fn cellCount()->u32 {let s=textureDimensions(terrain);return s.x*s.y;}
fn fieldK()->f32 {var k=1e9;var top=0.0;for(var j=0u;j<u32(frame.settings.w);j++){if(frame.waves[j].wave.z>top){top=frame.waves[j].wave.z;k=frame.waves[j].wave.w*0.84;}}return k;}
fn waveK(k0:f32,d:f32)->f32 {return k0/pow(tanh(min(pow(k0*max(d,0.01),0.75),10.0)),0.6666667);}
fn depthAt(p:vec2i)->f32 {return frame.settings.y-textureLoad(terrain,p,0).r;}
fn root(p:vec2i)->u32 {return word(u32(p.y)*textureDimensions(terrain).x+u32(p.x)+1u);}

fn passable(p:vec2i)->bool {let r=root(p);return r==0u||(r==0xffffffffu&&depthAt(p)>-1.5);}

fn slowness(p:vec2i)->f32 {let k=fieldK();return waveK(k,max(depthAt(p),0.05))/sqrt(9.81*k);}
fn centre(p:vec2i)->vec2f {return frame.coast.xy+(vec2f(p)+0.5)*frame.flow.yz;}
fn store(base:u32,source:vec2f,tau:f32){put(base,bitcast<u32>(source.x));put(base+1u,bitcast<u32>(source.y));put(base+2u,bitcast<u32>(tau));}
fn load(base:u32)->vec3f {return vec3f(bitcast<f32>(word(base)),bitcast<f32>(word(base+1u)),bitcast<f32>(word(base+2u)));}
fn edge(p:vec2i)->bool {let s=vec2i(textureDimensions(terrain));return p.x==0||p.y==0||p.x==s.x-1||p.y==s.y-1;}
${t?`@compute @workgroup_size(8,8) fn deepest(@builtin(global_invocation_id) id:vec3u){
 let s=textureDimensions(terrain);if(any(id.xy>=s)){return;}let p=vec2i(id.xy);
 if(edge(p)&&root(p)==0u&&depthAt(p)>0.0){atomicMax(&cells[cellCount()*9u+2u],bitcast<u32>(depthAt(p)));}
}`:`@compute @workgroup_size(8,8) fn seed(@builtin(global_invocation_id) id:vec3u){
 let s=textureDimensions(terrain);if(any(id.xy>=s)){return;}let p=vec2i(id.xy);let n=cellCount();
 let d=depthAt(p);let deepest=bitcast<f32>(word(n*9u+2u));
 let source=root(p)==0u&&(d>=3.14159265/fieldK()||(edge(p)&&d>=0.7*deepest));
 store(n+1u+(id.y*s.x+id.x)*4u,centre(p),select(1e30,0.0,source));
 if(all(id.xy==vec2u(0))){put(n*9u+1u,1u);}
}
fn relax(id:vec3u,fromField:u32,toField:u32){
 let s=textureDimensions(terrain);if(any(id.xy>=s)){return;}let p=vec2i(id.xy);let i=id.y*s.x+id.x;
 var best=load(fromField+i*4u);
 if(passable(p)&&best.z>0.0){
  let own=slowness(p);
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
   let q=p+vec2i(x,y);if((x==0&&y==0)||any(q<vec2i(0))||any(q>=vec2i(s))||!passable(q)){continue;}
   let other=load(fromField+(u32(q.y)*s.x+u32(q.x))*4u);if(other.z>=1e29){continue;}
   let time=other.z+length(vec2f(f32(x),f32(y))*frame.flow.yz)*0.5*(own+slowness(q));
   if(time<best.z){best=vec3f(other.xy,time);}
  }}
 }
 store(toField+i*4u,best.xy,best.z);
}


@compute @workgroup_size(1) fn spinStart(){let at=cellCount()*9u+3u;put(at,bitcast<u32>(f32(-${40 .toFixed(1)})));put(at+1u,bitcast<u32>(f32(${ne})));}
@compute @workgroup_size(1) fn spinTick(){let at=cellCount()*9u+3u;put(at,bitcast<u32>(bitcast<f32>(word(at))+3.0*bitcast<f32>(word(at+1u))));}
@compute @workgroup_size(1) fn spinEnd(){let at=cellCount()*9u+3u;put(at,0u);put(at+1u,0u);}
@compute @workgroup_size(8,8) fn forward(@builtin(global_invocation_id) id:vec3u){let n=cellCount();relax(id,n+1u,n*5u+1u);}
@compute @workgroup_size(8,8) fn backward(@builtin(global_invocation_id) id:vec3u){let n=cellCount();relax(id,n*5u+1u,n+1u);}`}
`,oe=class{constructor(e,t,n,r,i){let a=e.createShaderModule({code:ae(i,!0)}),o=e.createShaderModule({code:ae(i,!1)});this.pipelines=[`deepest`,`seed`,`forward`,`backward`,`spinStart`,`spinTick`,`spinEnd`].map(t=>e.createComputePipeline({layout:`auto`,compute:{module:t===`deepest`?a:o,entryPoint:t}})),this.groups=this.pipelines.map((i,a)=>a<4?w(e,i,[{buffer:t},n.createView(),{buffer:r}]):e.createBindGroup({layout:i.getBindGroupLayout(0),entries:[{binding:1,resource:n.createView()},{binding:2,resource:{buffer:r}}]}))}clock(e,t){e.setPipeline(this.pipelines[4+t]),e.setBindGroup(0,this.groups[4+t]),e.dispatchWorkgroups(1)}build(e,t,n){let r=Math.ceil(t/8),i=Math.ceil(n/8),a=t+n+1&-2;for(let t=0;t<2+a;t++){let n=e(r*i),a=t<2?t:2+(t&1);n.setPipeline(this.pipelines[a]),n.setBindGroup(0,this.groups[a]),n.dispatchWorkgroups(r,i)}}},se={waves:ie,words:te,spinFrames:re,build:(e,t,n,r,i)=>new oe(e,t,n,r,i)},ce=()=>({colorAttachments:[{view:void 0,loadOp:`load`,storeOp:`store`}],depthStencilAttachment:{view:void 0,depthReadOnly:!0,stencilReadOnly:!0}}),le=(e,t)=>`
struct MargoFog {color:vec4f,params:vec4f,eye:vec4f}
@group(${e}) @binding(${t}) var<uniform> margoFog:MargoFog;
fn fogAmount(p:vec3f)->f32 {
  let d=distance(p,margoFog.eye.xyz);let q=margoFog.params;
  let amount=select(clamp((d-q.x)/max(q.y-q.x,1e-6),0.0,1.0),1.0-exp(-q.z*q.z*d*d),q.z>0.0);
  return amount*exp(-q.w*max(p.y-margoFog.color.w,0.0));
}
`,H=(e,t,n,r)=>{let i=e===void 0?t:e;if(typeof i!=`number`||!Number.isFinite(i)||i<r)throw RangeError(`Fog ${n} is ${String(i)}; pass a finite number${r===0?`, 0 or more`:``}`);return i};function ue(e){if(e!==null&&(typeof e!=`object`||Array.isArray(e)))throw TypeError(`Fog must be an object with Fog fields; pass an environment Fog, such an object or null`);return e&&U(e,[0,0,0],new Float32Array(12)),e}function U(n,r,i,a=!1){let o=n.enabled??!0;if(typeof o!=`boolean`)throw TypeError(`Fog enabled is ${String(o)}; pass true or false`);let s=H(n.height,0,`height`,-1/0),c=H(n.near,1,`near`,0),l=H(n.far,1e3,`far`,0),u=H(n.density,0,`density`,0),d=H(n.heightFalloff,0,`heightFalloff`,0);if(t(n.color??`#ffffff`,i,0),a)for(let t=0;t<3;t++)i[t]=e(i[t]);i[3]=s,i[4]=c,i[5]=l,i[6]=u,i[7]=d,o||(i.fill(0,0,8),i[4]=i[5]=34028234663852886e22),i[8]=r[0],i[9]=r[1],i[10]=r[2],i[11]=0}var W=`struct Particle {position:vec4f,velocity:vec4f}
fn random(value:u32)->f32 {var x=value;x=(x^(x>>16u))*2246822519u;x=(x^(x>>13u))*3266489917u;return f32(x^(x>>16u))/4294967295.0;}`,de=_+u+W+`
@group(0) @binding(1) var coast:texture_2d<f32>;
@group(0) @binding(2) var flux:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> droplets:array<Particle>;
@group(0) @binding(4) var<storage,read> connected:array<u32>;
fn impact(pixel:vec2i,size:vec2i,water:vec4f)->vec3f {
 let sea=water.x>=0.5&&connected[u32(pixel.y*size.x+pixel.x)+1u]==0u;
 if(!sea&&water.x<0.05){return vec3f(0);}
 var n=vec2f(0);
 for(var o=0u;o<8u;o++){
  let dir=vec2f(cos(f32(o)*0.78539816),sin(f32(o)*0.78539816));
  for(var r=1;r<=2;r++){let q=clamp(pixel+vec2i(round(dir*f32(r))),vec2i(0),size-1);if(textureLoad(coast,q,0).y>water.x+water.y+0.3){n+=dir/f32(r);}}
 }
 if(dot(n,n)<0.01){return vec3f(0);}
 n=normalize(n);
 let xz=frame.coast.xy+(vec2f(pixel)+0.5)/vec2f(size)*frame.coast.zw;var drive=0.0;
 if(sea){
  for(var j=0u;j<u32(frame.settings.w);j++){
   for(var c=0u;c<3u;c++){let s=swell(frame.waves[j],xz,c,length(frame.flow.yz));drive+=s.amplitude*sqrt(9.81*max(0.0,dot(s.gradient,s.direction)))*sin(s.phase)*dot(s.direction,n);}
  }
 }
 let out=clamp(pixel-vec2i(round(n)),vec2i(0),size-1);let behind=textureLoad(coast,out,0).x;let q=textureLoad(flux,out,0);
 if(behind>0.05){drive=max(drive,dot(vec2f(q.y-q.x,q.w-q.z)/behind,n));}
 return vec3f(n,max(0.0,drive));
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let index=id.x;if(index>=arrayLength(&droplets)){return;}
 let size=vec2i(textureDimensions(coast));let dt=min(0.05,frame.cameraData.z);var p=droplets[index];
 p.position.w-=dt;
 if(p.position.w>0){
  p.velocity.y-=9.81*dt;p.position=vec4f(p.position.xyz+p.velocity.xyz*dt,p.position.w);
  let uv=(p.position.xz-frame.coast.xy)/frame.coast.zw;let pixel=clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1);
  let water=textureLoad(coast,pixel,0);if(p.position.y<water.x+water.y){p.position.w=0;}
 }else{
  let clock=u32(frame.settings.x*60.0);let caps=frame.grid.z;let seed=index*73856093u+clock*19349663u;
  for(var i=0u;i<4u;i++){
   let key=seed+i*83492791u;let pixel=vec2i(vec2f(random(key),random(key+1u))*vec2f(size-1));let water=textureLoad(coast,pixel,0);
   if(water.x>0.01&&water.w>0.08&&random(key+2u)<min(0.9,dt*45.0*water.w*(1.0+3.0*caps))){
    let q=textureLoad(flux,pixel,0);let velocity=clamp(vec2f(q.y-q.x,q.w-q.z)/max(0.04,water.x),vec2f(-4),vec2f(4));
    let xz=frame.coast.xy+(vec2f(pixel)+vec2f(random(key+3u),random(key+4u)))/vec2f(size)*frame.coast.zw;
    p.position=vec4f(xz.x,water.x+water.y+0.03,xz.y,0.4+random(key+5u)*0.5);
    p.velocity=vec4f(velocity.x*0.4+(random(key+6u)-0.5)*0.6,(1.3+random(key+7u)*2.2)*(1.0+1.5*caps),velocity.y*0.4+(random(key+8u)-0.5)*0.6,random(key+9u));break;
   }
   let hit=impact(pixel,size,water);
   if(hit.z>0.4&&random(key+10u)<min(0.9,dt*70.0*(hit.z-0.4)*(1.0+2.0*caps))){
    let cell=frame.coast.zw/vec2f(size);let side=vec2f(-hit.y,hit.x)*(random(key+3u)-0.5);
    let xz=frame.coast.xy+(vec2f(pixel)+0.5+hit.xy*0.4+side)*cell;
    p.position=vec4f(xz.x,water.x+water.y+0.1,xz.y,0.8+random(key+5u)*0.9);
    let up=min(16.0,hit.z*(4.0+3.0*random(key+7u))+1.0);let back=-hit.xy*(0.5+random(key+6u)*1.5)+vec2f(-hit.y,hit.x)*(random(key+8u)-0.5)*1.5;
    p.velocity=vec4f(back.x,up,back.y,2.0+random(key+9u));break;
   }
  }
 }droplets[index]=p;
}`,fe=_+W+`
@group(0) @binding(1) var<storage,read> droplets:array<Particle>;
@group(0) @binding(2) var surface:texture_depth_2d;
@group(0) @binding(3) var environment:texture_2d<f32>;
@group(0) @binding(4) var skySampler:sampler;
${O}
struct Output {@builtin(position) clip:vec4f,@location(0) uv:vec4f,@location(1) alpha:f32,@location(2) sky:vec3f}
fn sprayNoise(p:vec2f)->f32 {
 let c=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);let k=bitcast<vec2u>(vec2i(c));
 let a=k.x*73856093u;let b=a+73856093u;let c0=k.y*19349663u;let c1=c0+19349663u;
 let h=vec4f(random(a^c0),random(b^c0),random(a^c1),random(b^c1));
 return mix(mix(h.x,h.y,u.x),mix(h.z,h.w,u.x),u.y);
}
fn spraySky()->vec3f {
 var sum=vec3f(0);
 for(var k=0u;k<8u;k++){
  let a=f32(k)*0.78539816;let up=select(0.5,0.8660254,(k&1u)==1u);let side=sqrt(1.0-up*up);let r=vec3f(cos(a)*side,up,sin(a)*side);
  if(frame.color.w>0.5){sum+=textureSampleLevel(environment,skySampler,seaSkyUv(r,hdrSkyTurn()),0.0).rgb*select(1.0,hdrSkyScale(),hdrSkyScale()>0.0);}
  else{sum+=mix(vec3f(0.18,0.27,0.32),vec3f(0.035,0.10,0.20),sqrt(r.y))*frame.radiance.rgb*(0.015+min(1.0,frame.sun.w*0.15));}
 }
 return sum*0.125;
}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) index:u32)->Output {
 let p=droplets[index];if(p.position.w<=0){return Output(vec4f(-2,-2,0,1),vec4f(0,0,0,1),0,vec3f(0));}
 let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));let corner=corners[v];
 let right=normalize(vec3f(frame.camera[0].x,frame.camera[1].x,frame.camera[2].x));let up=normalize(vec3f(frame.camera[0].y,frame.camera[1].y,frame.camera[2].y));
 var size=(0.018+p.velocity.w*0.025)*(1.0+p.position.w*0.2)*(1.0+2.5*frame.grid.z);var alpha=min(1.0,p.position.w*5.0);
 if(p.velocity.w>=2.0){size=(0.08+0.14*(p.velocity.w-2.0))*(1.0+frame.grid.z)*(1.6-0.5*min(1.0,p.position.w));alpha=2.0+min(1.0,p.position.w*2.0)*0.4;}
 let motion=vec2f(dot(p.velocity.xyz,right),dot(p.velocity.xyz,up));let speed=length(motion);
 let along=select(vec2f(0,1),motion/max(speed,1e-4),speed>1e-3);let stretch=min(4.0,1.0+speed*0.033/size);
 let world=p.position.xyz+((right*along.x+up*along.y)*corner.y*stretch+(up*along.x-right*along.y)*corner.x)*size;
 let uv=vec4f(corner,fract(f32(index)*0.6180340),stretch);
 return Output(frame.camera*vec4f(world,1),uv,alpha,spraySky());
}
fn linear(d:f32)->f32{return frame.cameraData.x*frame.cameraData.y/(frame.cameraData.x+d*(frame.cameraData.y-frame.cameraData.x));}
@fragment fn fragment(i:Output)->@location(0) vec4f {
 let radius=dot(i.uv.xy,i.uv.xy);if(radius>1){discard;}
 let gap=max(0.0,linear(textureLoad(surface,vec2i(i.clip.xy),0))-linear(i.clip.z));
 let clump=i.alpha>=2.0;let falloff=(1.0-radius)*(1.0-radius);
 let p=i.uv.xy*1.7+vec2f(i.uv.z*37.0,i.uv.z*91.0);let n=sprayNoise(p)*0.6+sprayNoise(p*2.9+3.1)*0.4;
 let specks=smoothstep(0.78,0.92,sprayNoise(i.uv.xy*6.0+vec2f(i.uv.z*53.0,i.uv.z*17.0)));
 let shape=falloff*select(smoothstep(0.3,0.7,n),0.3*smoothstep(0.35,0.8,n)+0.7*specks,clump);
 let alpha=shape*select(i.alpha,i.alpha-2.0,clump)*min(1.0,gap*12.0)*0.65/sqrt(i.uv.w);
 let color=vec3f(0.78,0.84,0.85)*(frame.eye.w+i.sky+frame.radiance.rgb*min(1.0,frame.sun.w));
 return vec4f(color*alpha,alpha);
}`,pe=[[`@location(2) sky:vec3f}`,`@location(2) sky:vec3f,@location(3) world:vec3f}`],[`return Output(vec4f(-2,-2,0,1),vec4f(0,0,0,1),0,vec3f(0));`,`return Output(vec4f(-2,-2,0,1),vec4f(0,0,0,1),0,vec3f(0),vec3f(0));`],[`return Output(frame.camera*vec4f(world,1),uv,alpha,spraySky());`,`return Output(frame.camera*vec4f(world,1),uv,alpha,spraySky(),world);`],[`return vec4f(color*alpha,alpha);`,`let fogColor=select(select(margoFog.color.rgb*12.92,1.055*pow(margoFog.color.rgb,vec3f(1.0/2.4))-0.055,margoFog.color.rgb>=vec3f(0.0031308)),margoFog.color.rgb,frame.cameraData.w>0.5);return vec4f(mix(color,fogColor,fogAmount(i.world))*alpha,alpha);`]];function me(){let e=fe;for(let[t,n]of pe){if(e.split(t).length!==2)throw s(`unsupported`,`Water spray fog needs the spray shader it was written for; update its fog edits`);e=e.replace(t,n)}return e+le(0,5)}var he=class{constructor(e,t,n,r=4096){this.uniform=t,this.coast=n,this.count=r,this.simulationGroups=[],this.descriptor={},this.presentation=ce(),this.color=this.presentation.colorAttachments[0],this.depth=this.presentation.depthStencilAttachment,this.renders=[],this.renderGroups=[],this.format=``,this.depthFormat=``,this.buffer=e.createBuffer({size:r*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});try{this.simulation=f(e,de);for(let r=0;r<2;r++)this.simulationGroups.push(w(e,this.simulation,[{buffer:t},n.views[r],n.fluxes[r].createView(),{buffer:this.buffer},{buffer:n.connected}]))}catch(e){throw this.buffer.destroy(),e}}step(e){let t=e.beginComputePass(this.descriptor);t.setPipeline(this.simulation),t.setBindGroup(0,this.simulationGroups[this.coast.current]),t.dispatchWorkgroups(this.count/64),t.end()}draw(e,t,n,r,i,a){let o=e.format+`:`+t.sampleCount+(a?`:fog`:``);if(this.format!==o||this.depthFormat!==t.format){let n=a?me():fe,r=t.sampleCount;this.renders=b(e.device,r).map(i=>{let a=n.replace(`surface:texture_depth_2d`,`surface:texture_depth_multisampled_2d`),o=r===1?n:i===null?a.replace(`fragment(i:Output)`,`fragment(i:Output,@builtin(sample_index) sample:u32)`).replace(`textureLoad(surface,vec2i(i.clip.xy),0)`,`textureLoad(surface,vec2i(i.clip.xy),i32(sample))`):a.replace(`textureLoad(surface,vec2i(i.clip.xy),0)`,`textureLoad(surface,vec2i(i.clip.xy),${i})`),s=e.device.createShaderModule({code:o});return e.device.createRenderPipeline({layout:`auto`,vertex:{module:s,entryPoint:`vertex`},fragment:{module:s,entryPoint:`fragment`,targets:[{format:e.format,blend:{color:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`},alpha:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`}}}]},depthStencil:{format:t.format,depthWriteEnabled:!1,depthCompare:`greater-equal`},multisample:i===null?{count:r}:{count:r,mask:1<<i}})}),this.format=o,this.depthFormat=t.format,this.sampled=void 0}let s=r??(this.blank??=e.device.createTexture({size:[1,1],format:`rgba16float`,usage:GPUTextureUsage.TEXTURE_BINDING}));if(this.sampled!==t||this.sampledFog!==a||this.sampledSky!==s){let n=t.createView({aspect:`depth-only`});this.renderGroups=this.renders.map(t=>w(e.device,t,[{buffer:this.uniform},{buffer:this.buffer},n,s.createView(),i,...a?[{buffer:a}]:[]])),this.sampled=t,this.sampledFog=a,this.sampledSky=s}this.color.view=e.color,this.depth.view=n;let c=e.encoder.beginRenderPass(this.presentation);h(c,e);for(let e=0;e<this.renders.length;e++)c.setPipeline(this.renders[e]),c.setBindGroup(0,this.renderGroups[e]),c.draw(6,this.count);c.end()}dispose(){this.buffer.destroy(),this.blank?.destroy()}},ge=.78,_e=[[1,.4],[.84,.35],[1.18,.25]],ve=(e,t)=>e/Math.tanh((e*Math.max(t,.01))**.75)**(2/3),ye=(e,t)=>{let n=ve(e,t),r=Math.min(n*Math.max(t,.01),10);return Math.sqrt(.5*n/((.5+r/Math.sinh(2*r))*e))};function be(e){let t=1/0,n=0;for(let r of e){if(!(Number.isFinite(r.amplitude)&&r.amplitude>=0)||!(Number.isFinite(r.wavenumber)&&r.wavenumber>0))throw RangeError(`Breaker waves need a finite amplitude of 0 or more and a wavenumber above 0`);r.amplitude>n&&(n=r.amplitude,t=r.wavenumber*.84)}if(t===1/0)return 0;let r=[];for(let n of e)if(n.amplitude>0)for(let[e,i]of _e)n.wavenumber*e<=t*2.5&&r.push([n.wavenumber*e,n.amplitude*i]);let i=e=>{let t=0;for(let[n,i]of r)t+=(i*ye(n,e))**2;return 2*Math.sqrt(t)-ge*e},a=Math.max(1,Math.PI/t);for(;i(a)>=0;)a*=2;let o=a;for(;o>.001&&i(o)<0;)o/=1.25;if(i(o)<0)return 0;let s=o,c=o*1.25;for(;c-s>.001;){let e=.5*(s+c);i(e)>=0?s=e:c=e}return .5*(s+c)}function xe(e,t,n,r){let{data:i,width:a,height:o}=e,s=n[0]/a,c=n[1]/o,l=[],u=(e,t)=>i[t*a+e]-r,d=(e,n,r,i,a,o)=>{let l=r/(r-o);return[t[0]+(e+l*(i-e)+.5)*s,t[1]+(n+l*(a-n)+.5)*c]};for(let e=0;e+1<o;e++)for(let t=0;t+1<a;t++){let n=u(t,e),r=u(t+1,e),i=u(t+1,e+1),a=u(t,e+1),o=[];n<0!=r<0&&o.push(d(t,e,n,t+1,e,r)),r<0!=i<0&&o.push(d(t+1,e,r,t+1,e+1,i)),a<0!=i<0&&o.push(d(t,e+1,a,t+1,e+1,i)),n<0!=a<0&&o.push(d(t,e,n,t,e+1,a)),o.length===2?l.push([o[0],o[1]]):o.length===4&&((n+r+i+a)/4>=0==n>=0?l.push([o[0],o[1]],[o[2],o[3]]):l.push([o[0],o[3]],[o[1],o[2]]))}return l}var Se=Symbol.for(`margoengine.optional.surface-depth`);function Ce(e,t){e[Se]={encoder:e.encoder,view:e.view,texture:t}}var we=Symbol.for(`margoengine.optional.reactive-mask`);function Te(e,t){let n=e[we];n&&n.encoder===e.encoder&&n.view===e.view?n.textures.includes(t)||n.textures.push(t):e[we]={encoder:e.encoder,view:e.view,textures:[t]}}var Ee=Symbol.for(`margoengine.temporal-camera-source`),De=e=>e[Ee]??e,Oe=8192,G=144,K=216,ke=217,Ae=218,q=220,J=880,je=e=>{let t=60;for(let n=1;n<e;n*=2)t*=2;return t},Y=[.26,.994,1.65,2.07,2.4,2.77,2.93,3.11,3.33,3.59,4.2],X=[.126,.806,1.41,1.79,2.06,2.36,2.45,2.54,2.61,2.63,2.8],Me=.025,Ne=3,Pe=.003,Fe=2.6,Ie=[[.4,1],[.35,.84],[.25,1.18]],Le=[[Math.cos(0),Math.sin(0),1,1,.4,0],[Math.cos(-.64),Math.sin(-.64),.84,Math.sqrt(.84),.35,2.17],[Math.cos(.81),Math.sin(.81),1.18,Math.sqrt(1.18),.25,4.91]];function Z(e,t){let n=Math.max(0,Math.min(1,(6.2831853/(e*1.114)/Math.max(1e-4,t)-2)*.5));return n*n*(3-2*n)}function Re(e){if(e>.5)return-Re(1-e);let t=Math.sqrt(-2*Math.log(e));return t-(2.515517+t*(.802853+t*.010328))/(1+t*(1.432788+t*(.189269+t*.001308)))}var ze=6,Q=e=>typeof e==`number`?{speed:e}:e,Be=e=>{let t=Q(e);return V(t.speed,{fetch:t.fetch,direction:t.direction})},Ve=_+u+ie+`
const HORIZON=false;
const STILL=false;
const COAST_SURF=true;

const SHORE_FOAM=0.35;


const FOAM_ALBEDO=vec3f(0.84,0.86,0.87);
const FOAM_DEPTH=8.0;
const FOAM_OPEN=0.95;
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var history:texture_2d<f32>;
@group(0) @binding(3) var coast:texture_2d<f32>;
@group(0) @binding(4) var environment:texture_2d<f32>;
@group(0) @binding(5) var skySampler:sampler;
@group(0) @binding(6) var opaque:texture_2d<f32>;
@group(0) @binding(7) var<storage,read> connected:array<u32>;
fn inCoast(xz:vec2f)->bool {let uv=(xz-frame.coast.xy)/frame.coast.zw;return frame.flow.w>0.5&&all(uv>=vec2f(0))&&all(uv<=vec2f(1));}

fn coastBlend(xz:vec2f)->vec3f {
 let distances=vec4f(xz-frame.coast.xy,frame.coast.xy+frame.coast.zw-xz);
 let mask=vec4u(u32(frame.sea.y))&vec4u(1u,2u,4u,8u);
 let edges=select(vec4f(1e20),distances,mask!=vec4u(0u));
 let distance=min(min(edges.x,edges.y),min(edges.z,edges.w));
 let width=min(max(4.0,4.0*max(frame.flow.y,frame.flow.z)),min(frame.coast.z,frame.coast.w)*0.25);let t=clamp(distance/width,0.0,1.0);let slope=6.0*t*(1.0-t)/width;
 var gradient=vec2f(0);if(distance==edges.x){gradient.x=slope;}else if(distance==edges.y){gradient.y=slope;}else if(distance==edges.z){gradient.x=-slope;}else{gradient.y=-slope;}
 return vec3f(gradient,t*t*(3.0-2.0*t));
}
struct CoastalSample {water:vec4f,normal:vec3f,surface:f32,blend:vec3f,ocean:f32,edge:f32,wet:f32}
fn coastal(xz:vec2f)->CoastalSample {
 let size=vec2i(textureDimensions(coast));let uv=(xz-frame.coast.xy)/frame.coast.zw;
 let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let lo=vec2i(floor(pixel));let hi=min(lo+1,size-1);let t=fract(pixel);
 let a=textureLoad(coast,lo,0);let b=textureLoad(coast,vec2i(hi.x,lo.y),0);let c=textureLoad(coast,vec2i(lo.x,hi.y),0);let d=textureLoad(coast,hi,0);
 let standing=vec4f(a.x,b.x,c.x,d.x);var levels=vec4f(a.x+a.y,b.x+b.y,c.x+c.y,d.x+d.y);var has=standing;var signed=standing;


 if(STILL){let fill=vec4f(a.w,b.w,c.w,d.w);levels=select(fill,levels,standing>vec4f(0.003));has=select(standing,vec4f(1),fill>vec4f(-1e29));signed=select(select(vec4f(-1),fill-vec4f(a.y,b.y,c.y,d.y),fill>vec4f(-1e29)),standing,standing>vec4f(0.003));}
 let weights=vec4f((1.0-t.x)*(1.0-t.y),t.x*(1.0-t.y),(1.0-t.x)*t.y,t.x*t.y)*step(vec4f(0.003),has);
 let total=dot(weights,vec4f(1));let surface=select(frame.settings.y,dot(weights,levels)/max(0.0001,total),total>0.0001);




 if(!STILL){signed=select(select(vec4f(-1),vec4f(surface)-vec4f(a.y,b.y,c.y,d.y),total>0.0001),standing,standing>vec4f(0.003))-vec4f(0.003);}
 let h=select(vec4f(surface),levels,has>vec4f(0.003));
 let dx=mix(h.y-h.x,h.w-h.z,t.y)/max(0.0001,frame.flow.y);let dz=mix(h.z-h.x,h.w-h.y,t.x)/max(0.0001,frame.flow.z);
 let depths=max(vec4f(0),vec4f(frame.settings.y)-vec4f(a.y,b.y,c.y,d.y));
 let indices=vec4u(u32(lo.y*size.x+lo.x),u32(lo.y*size.x+hi.x),u32(hi.y*size.x+lo.x),u32(hi.y*size.x+hi.x))+1u;

 let band=select(vec2f(0.65,2.4),SURF_SWASH,surfReady(u32(size.x*size.y)));
 let sea=smoothstep(vec4f(band.x),vec4f(band.y),depths)*vec4f(select(0.0,1.0,connected[indices.x]==0u),select(0.0,1.0,connected[indices.y]==0u),select(0.0,1.0,connected[indices.z]==0u),select(0.0,1.0,connected[indices.w]==0u));
 let ocean=mix(mix(sea.x,sea.y,t.x),mix(sea.z,sea.w,t.x),t.y);let gradient=vec2f(mix(sea.y-sea.x,sea.w-sea.z,t.y)/frame.flow.y,mix(sea.z-sea.x,sea.w-sea.y,t.x)/frame.flow.z);let edge=coastBlend(xz);
 let blend=vec3f(edge.xy*(1.0-ocean)-edge.z*gradient,edge.z*(1.0-ocean));
 return CoastalSample(mix(mix(a,b,t.x),mix(c,d,t.x),t.y),normalize(vec3f(-dx,1,-dz)),surface,blend,ocean,mix(mix(signed.x,signed.y,t.x),mix(signed.z,signed.w,t.x),t.y),total);
}










fn coastalReach(xz:vec2f,reach:f32)->vec2f {
 let size=vec2i(textureDimensions(coast));let cell=frame.coast.zw/vec2f(size);

 let far=reach+length(cell);let centre=vec2i(floor((xz-frame.coast.xy)/cell));let r=min(vec2i(ceil(vec2f(far)/cell)),vec2i(8));
 var best=1e30;var level=frame.settings.y;
 for(var z=-r.y;z<=r.y;z++){
  for(var x=-r.x;x<=r.x;x++){
   let p=centre+vec2i(x,z);if(any(p<vec2i(0))||any(p>=size)){continue;}
   let texel=textureLoad(coast,p,0);let away=length(frame.coast.xy+(vec2f(p)+0.5)*cell-xz);
   if(texel.x>0.003&&away<=far&&away<best){best=away;level=texel.x+texel.y;}
  }
 }
 return vec2f(level,select(0.0,1.0,best<1e29));
}
struct SurfHere {surf:Surf,weight:f32}

fn surfHere(xz:vec2f,sampleWidth:f32,foam:bool)->SurfHere {
 let size=vec2i(textureDimensions(coast));let field=surfField(xz,size);
 if(STILL||field.weight<=0.0){return SurfHere(Surf(vec3f(0),vec3f(0),vec3f(0),0.0,0.0,vec2f(0),0.0,vec2f(0),0.0),0.0);}
 let uv=(xz-frame.coast.xy)/frame.coast.zw;let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let lo=vec2i(floor(pixel));let hi=min(lo+1,size-1);let t=fract(pixel);
 let ground=mix(mix(textureLoad(coast,lo,0).y,textureLoad(coast,vec2i(hi.x,lo.y),0).y,t.x),mix(textureLoad(coast,vec2i(lo.x,hi.y),0).y,textureLoad(coast,hi,0).y,t.x),t.y);
 return SurfHere(surfSample(xz,sampleWidth,frame.settings.y-ground,field,foam),field.weight*coastBlend(xz).z);
}







fn farSample(i:u32)->f32 {return frame.far[2u+i/4u][i%4u];}
fn farSea(xz:vec2f)->f32 {
 let on=frame.far[1];if(on.w<0.5){return 0.0;}
 let lo=frame.coast.xy;let hi=lo+frame.coast.zw;let sides=frame.far[0];
 let beyond=vec4f(lo.x-xz.x,xz.x-hi.x,lo.y-xz.y,xz.y-hi.y);
 let r=max(0.0,max(max(beyond.x*sides.x,beyond.y*sides.y),max(beyond.z*sides.z,beyond.w*sides.w)));
 let count=u32(on.y);let s=clamp(r/max(on.x,0.001),0.0,1.0)*f32(count-1u);let i=min(u32(floor(s)),count-1u);let j=min(i+1u,count-1u);
 let incoming=mix(farSample(i),farSample(j),s-f32(i));
 let m=max(max(beyond.x,beyond.y),max(beyond.z,beyond.w));
 let nearest=select(select(select(sides.w,sides.z,beyond.z==m),sides.y,beyond.y==m),sides.x,beyond.x==m);
 if(nearest<0.5||frame.flow.w<0.5){return incoming;}
 let size=vec2i(textureDimensions(coast));let uv=(clamp(xz,lo,hi)-lo)/frame.coast.zw;
 let pixel=clamp(uv*vec2f(size)-0.5,vec2f(0),vec2f(size-1));let a0=vec2i(floor(pixel));let a1=min(a0+1,size-1);let t=fract(pixel);
 let a=textureLoad(coast,a0,0);let b=textureLoad(coast,vec2i(a1.x,a0.y),0);let c=textureLoad(coast,vec2i(a0.x,a1.y),0);let d=textureLoad(coast,a1,0);
 let w=vec4f((1.0-t.x)*(1.0-t.y),t.x*(1.0-t.y),(1.0-t.x)*t.y,t.x*t.y);let depth=vec4f(a.x,b.x,c.x,d.x);
 let wet=w*smoothstep(vec4f(0.0),vec4f(0.5),depth);let total=dot(wet,vec4f(1));
 if(total<0.0001){return incoming;}
 let level=dot(wet,depth+vec4f(a.y,b.y,c.y,d.y))/total;
 return incoming+(level-frame.settings.y)*min(1.0,total/dot(w,vec4f(1)))/sqrt(1.0+r/max(on.z,1.0));
}
struct Surface {position:vec3f,normal:vec3f,crest:f32}
fn surface(xz:vec2f,sampleWidth:f32)->Surface {
 let far=farSea(xz);var p=vec3f(xz.x,frame.settings.y+far,xz.y);var tangent=vec3f(1,0,0);var binormal=vec3f(0,0,1);var crest=0.0;

 if(frame.far[1].w>0.5){tangent.y=(farSea(xz+vec2f(0.5,0))-far)*2.0;binormal.y=(farSea(xz+vec2f(0,0.5))-far)*2.0;}
 for(var j=0u;j<u32(frame.settings.w);j++){
  let w=frame.waves[j];
  for(var component=0u;component<3u;component++){
   let wave=swell(w,xz,component,sampleWidth);let d=wave.direction;let a=wave.amplitude;

   let q=w.shape.x*0.9;let s=sin(wave.phase);let c=cos(wave.phase);
   p+=vec3f(q*a*d.x*c,a*s,q*a*d.y*c);
   let derivative=vec3f(-q*a*d.x*s,a*c,-q*a*d.y*s);
   tangent+=derivative*wave.gradient.x;binormal+=derivative*wave.gradient.y;
   crest=max(crest,smoothstep(0.75,0.98,s)*smoothstep(0.14,0.32,a*length(wave.gradient)));
  }
 }



 for(var n=0u;n<u32(frame.sea.x);n++){
  let w=frame.seaWaves[n];let theta=w.x*xz.x+w.y*xz.y+w.w;let r=theta-6.2831853*round(theta*0.15915494);
  let a=w.z*swellFilter(length(w.xy),sampleWidth);let s=sin(r);
  p.y+=a*cos(r);tangent.y-=a*w.x*s;binormal.y-=a*w.y*s;
 }
 if(inCoast(xz)){
  if(COAST_SURF){




   let e=0.01;let steps=array<vec2f,3>(vec2f(0),vec2f(e,0),vec2f(0,e));
   var weights:array<f32,3>;var shifted:array<vec3f,3>;var offset=vec3f(0);var surfCrest=0.0;
   for(var k=0u;k<3u;k++){
    let here=surfHere(xz+steps[k],sampleWidth,false);weights[k]=here.weight;shifted[k]=here.surf.offset*here.weight;
    if(k==0u){if(here.weight<=0.0){break;}offset=here.surf.offset;surfCrest=here.surf.crest;}
   }
   let w=weights[0];
   if(w>0.0){
    let base=vec3f(xz.x,frame.settings.y,xz.y);
    let wx=(weights[1]-w)/e;let wz=(weights[2]-w)/e;let ax=(shifted[1]-shifted[0])/e;let az=(shifted[2]-shifted[0])/e;
    tangent=tangent*(1.0-w)+vec3f(w,0,0)+(base-p)*wx+ax;binormal=binormal*(1.0-w)+vec3f(0,0,w)+(base-p)*wz+az;
    p=mix(p,base+offset,w);crest=mix(crest,surfCrest,w);
   }
  }
  let v=coastal(xz);let blend=v.blend;var level=v.surface;if(!STILL&&v.wet<=0.0001){level=coastalReach(xz,sampleWidth).x;}
  let shore=vec3f(xz.x,level,xz.y);let delta=shore-p;
  tangent=mix(tangent,vec3f(1,-v.normal.x/max(0.0001,v.normal.y),0),blend.z)+delta*blend.x;
  binormal=mix(binormal,vec3f(0,-v.normal.z/max(0.0001,v.normal.y),1),blend.z)+delta*blend.y;
  p=mix(p,shore,blend.z);
 }
 return Surface(p,normalize(cross(binormal,tangent)),crest);
}
struct Output {@builtin(position) clip:vec4f,@location(0) normal:vec3f,@location(1) world:vec3f,@location(2) crest:f32,@location(3) xz:vec2f}

@vertex fn vertex(@location(0) grid:vec2f,@location(1) sampleWidth:f32)->Output {
 var xz=grid;if(HORIZON){xz+=frame.grid.xy;}
 let v=surface(xz,sampleWidth);var clip=frame.camera*vec4f(v.position,1);if(HORIZON){clip.z=max(clip.z,0.000001*clip.w);}return Output(clip,v.normal,v.position,v.crest,xz);
}
fn linear(d:f32)->f32 {return frame.cameraData.x*frame.cameraData.y/(frame.cameraData.x+d*(frame.cameraData.y-frame.cameraData.x));}
fn refractionPixel(clip:vec4f)->vec2i {
 if(clip.w<=0.000001||any(abs(clip.xy)>=vec2f(clip.w))){return vec2i(-1);}
 let p=vec2i(frame.viewport.xy+(clip.xy/clip.w*vec2f(0.5,-0.5)+0.5)*frame.viewport.zw);
 if(any(p>=vec2i(frame.viewport.xy+frame.viewport.zw))){return vec2i(-1);}
 return p;
}


fn refractedScene(a:vec4f,b:vec4f,initial:f32)->vec4f {
 var p=refractionPixel(a+b*initial);
 for(var step=0;step<5;step++){
  if(p.x<0){break;}
  let d=textureLoad(depth,p,0);let denominator=b.z-d*b.w;
  if(d<=0.0||abs(denominator)<0.00000001){break;}
  let distance=(d*a.w-a.z)/denominator;
  if(distance<=0.0||distance>50.0){break;}
  let next=refractionPixel(a+b*distance);
  if(all(next==p)){return vec4f(textureLoad(opaque,p,0).rgb,distance);}
  p=next;
 }
 return vec4f(0,0,0,-1);
}
fn refractionBehind(clip:vec4f,p:vec2i)->bool {
 if(p.x<0){return false;}
 return textureLoad(depth,p,0)>clip.z/clip.w;
}

fn refractionBisect(a:vec4f,b:vec4f,lower:f32,upper:f32)->vec4f {
 var lo=lower;var hi=upper;
 for(var j=0;j<10;j++){
  let t=(lo+hi)*0.5;let at=a+b*t;
  if(refractionBehind(at,refractionPixel(at))){hi=t;}else{lo=t;}
 }

 let hit=refractedScene(a,b,hi);
 if(hit.w>=lower&&hit.w<=upper){return hit;}





 let at=a+b*hi;let q=refractionPixel(at);
 if(q.x>=0){let ray=linear(at.z/at.w);if(abs(linear(textureLoad(depth,q,0))-ray)<=max(0.05,0.02*ray)){return vec4f(textureLoad(opaque,q,0).rgb,hi);}}
 return vec4f(0,0,0,-1);
}
fn refractionCrossing(a:vec4f,b:vec4f)->vec4f {
 var lower=0.0;var upper=0.08;var wasBehind=false;
 for(var step=0;step<8;step++){
  let clip=a+b*upper;let p=refractionPixel(clip);


  var bisect=false;var last=false;var span=vec2f(0);var behind=false;
  if(p.x<0){





   if(wasBehind){break;}
   var lo=lower;var hi=upper;
   for(var j=0;j<10;j++){let t=(lo+hi)*0.5;if(refractionPixel(a+b*t).x<0){hi=t;}else{lo=t;}}
   let at=a+b*lo;let q=refractionPixel(at);
   if(q.x<0){break;}
   if(!refractionBehind(at,q)){
    if(textureLoad(depth,q,0)>0.0){return vec4f(textureLoad(opaque,q,0).rgb,lo);}
    break;
   }

   bisect=true;last=true;span=vec2f(lower,lo);
  }else{
   behind=refractionBehind(clip,p);
   if(behind&&!wasBehind){bisect=true;span=vec2f(lower,upper);}
  }
  if(bisect){
   let hit=refractionBisect(a,b,span.x,span.y);
   if(last||hit.w>=0.0){return hit;}
  }
  if(upper>=50.0){break;}
  wasBehind=behind;lower=upper;upper=min(50.0,upper*2.8);
 }
 return vec4f(0,0,0,-1);
}



fn ripplePcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn rippleGradient(cell:vec2i)->vec2f {
 let c=bitcast<vec2u>(cell);let angle=f32(ripplePcg(c.x+ripplePcg(c.y))>>8u)*3.7450703e-7;return vec2f(cos(angle),sin(angle));
}



fn noise(p:vec2f)->vec3f {
 let base=floor(p);let cell=vec2i(base);let f=p-base;
 let g00=rippleGradient(cell);let g10=rippleGradient(cell+vec2i(1,0));let g01=rippleGradient(cell+vec2i(0,1));let g11=rippleGradient(cell+vec2i(1,1));
 let r00=dot(g00,f);let r10=dot(g10,f-vec2f(1,0));let r01=dot(g01,f-vec2f(0,1));let r11=dot(g11,f-vec2f(1,1));
 let q=f*f*f*(10.0+f*(6.0*f-15.0));let dq=30.0*f*f*(1.0-f)*(1.0-f);
 let low=mix(r00,r10,q.x);let high=mix(r01,r11,q.x);
 let dlow=mix(g00,g10,q.x)+vec2f(dq.x*(r10-r00),0.0);let dhigh=mix(g01,g11,q.x)+vec2f(dq.x*(r11-r01),0.0);
 return vec3f(mix(low,high,q.y),mix(dlow,dhigh,q.y)+vec2f(0.0,dq.y*(high-low)));
}





struct NoiseLayer {basis:mat2x2f,scale:vec2f,at:vec2f,detail:f32}
fn rippleAt(xz:vec2f,turn:vec2f,scale:vec2f,drift:vec2f,offset:vec2f,pixelX:vec2f,pixelY:vec2f)->NoiseLayer {
 let w=frame.waves[0].wave.xy;let along=vec2f(w.x*turn.x-w.y*turn.y,w.x*turn.y+w.y*turn.x);let across=vec2f(-along.y,along.x);
 let basis=mat2x2f(along,across);let local=transpose(basis);
 let width=max(length((local*pixelX)*scale),length((local*pixelY)*scale));
 let detail=1.0-smoothstep(0.25,1.0,width);
 return NoiseLayer(basis,scale,(local*xz)*scale+frame.settings.x*drift+offset,detail);
}
fn rippleSlope(o:NoiseLayer,noise:vec2f)->vec2f {
 if(o.detail<=0.0){return vec2f(0);}
 let n=noise*o.scale;
 return (o.basis*n)*o.detail;
}

fn shortWaveSlope(p:vec2f,pixelX:vec2f,pixelY:vec2f,k:vec2f,height:f32,warp:vec3f)->vec2f {
 let gradient=k+warp.yz;
 let width=max(abs(dot(gradient,pixelX)),abs(dot(gradient,pixelY)));
 let keep=1.0-smoothstep(0.9,3.14159265,width);
 let phase=dot(k,p)-sqrt(9.81*length(k))*frame.settings.x+warp.x;
 return gradient*(height*cos(phase)*keep);
}







var<private> resolvedShort:f32;
fn shortWind(chop:f32)->f32 {let u=16.0*chop;return u*sqrt((0.8+0.065*u)*1e-3);}
fn shortSaturation(k:f32,friction:f32)->f32 {
 let c=sqrt(9.81/k+7.4e-5*k);let m=0.01*(1.0+select(1.0,3.0,friction>0.23)*log(max(friction,1e-4)/0.23));
 let r=k/370.0-1.0;return 0.5*max(m,0.0)*(0.23/c)*exp(-0.25*r*r);
}



fn shortOctaveAt(xz:vec2f,turn:vec2f,k:f32,offset:vec2f,pixelX:vec2f,pixelY:vec2f)->NoiseLayer {
 let w=frame.waves[0].wave.xy;let along=vec2f(w.x*turn.x-w.y*turn.y,w.x*turn.y+w.y*turn.x);let across=vec2f(-along.y,along.x);
 let basis=mat2x2f(along,across);let local=transpose(basis);

 let s=k/3.77;let scale=vec2f(s,0.55*s);
 let width=max(length((local*pixelX)*scale),length((local*pixelY)*scale));
 let detail=1.0-smoothstep(0.25,1.0,width);
 let c=sqrt(9.81/k+7.4e-5*k);
 return NoiseLayer(basis,scale,(local*xz)*scale+frame.settings.x*vec2f(-c,0.12*c)*scale+offset,detail);
}
fn shortOctaveSlope(o:NoiseLayer,k:f32,friction:f32,noise:vec2f)->vec3f {
 if(o.detail<=0.0){return vec3f(0);}
 let variance=shortSaturation(k,friction)*0.6931472;

 let s=k/3.77;let h=sqrt(variance/1.3025)/(0.62*s);
 let n=noise*o.scale;
 return vec3f((o.basis*n)*(h*o.detail),variance*o.detail*o.detail);
}
















fn waterLoops(n:u32)->u32 {return n+u32(frame.sea.z);}
fn fresnel(cosine:f32)->f32 {return 0.02+0.98*pow(1.0-clamp(cosine,0.0,1.0),5.0);}
fn landNearby(xz:vec2f)->f32 {
 let size=vec2f(textureDimensions(coast));var land=0.0;
 for(var r=1;r<=3;r++){
  for(var a=0;a<6;a++){
   let angle=f32(a)*1.0471976+f32(r)*0.52;let p=xz+vec2f(cos(angle),sin(angle))*f32(r)*1.2*frame.settings.z;
   let uv=(p-frame.coast.xy)/frame.coast.zw;
   if(all(uv>=vec2f(0))&&all(uv<vec2f(1))&&textureLoad(coast,vec2i(uv*size),0).y>frame.settings.y-0.3){land+=1.0/f32(r);}
  }
 }
 return land/11.0;
}
fn whitecap(xz:vec2f,footprint:f32)->f32 {
 let amount=frame.grid.z;if(amount<=0.0){return 0.0;}
 var crest=0.0;
 for(var j=0u;j<u32(frame.settings.w);j++){
  for(var c=0u;c<3u;c++){let s=swell(frame.waves[j],xz,c,max(footprint*2.0,0.05));crest+=s.amplitude*length(s.gradient)*sin(s.phase-0.4);}
 }
 let w=frame.waves[0].wave.xy;let q=vec2f(dot(xz,w),dot(xz,vec2f(-w.y,w.x)));let t=frame.settings.x;
 let detail=1.0-smoothstep(0.3,1.5,footprint);
 let at=array<vec2f,6>(q*vec2f(0.32,0.7)+vec2f(-t*0.35,0),q*vec2f(1.3,2.9)+vec2f(-t*0.8,5.1),q*vec2f(0.75,1.3)+vec2f(-t*0.6,2.3),
  q*vec2f(2.1,2.7)+vec2f(-t*0.9,7.7),q*vec2f(0.16,2.2)+vec2f(-t*0.45,3.7),q*vec2f(0.06,1.4)+vec2f(-t*0.5,0));
 var layers:array<f32,6>;
 for(var k=0u;k<waterLoops(6u);k++){layers[k]=noise(at[k]).x;}
 let patches=layers[0]+layers[1]*0.5*detail;
 let threshold=select(mix(0.42,0.16,amount),frame.foam.x,frame.foam.x>0.0);
 let over=crest+patches*0.08-threshold;let core=smoothstep(-0.02,0.07,over);
 let bubbles=layers[2]+layers[3]*0.5;
 let streak=layers[4];
 let broken=smoothstep(-0.55,0.3,bubbles*0.8+streak*0.7+core*0.8-0.3);
 let caps=core*mix(0.85+0.15*core,broken*(0.55+0.45*core),detail);
 let streaks=amount*amount*smoothstep(0.25,0.55,layers[5])*0.25*detail;
 return clamp(caps+streaks,0.0,1.0);
}



fn seaGlint(n:vec3f,v:vec3f,l:vec3f,rough:f32)->f32 {
 let nl=clamp(dot(n,l),0.0,1.0);let nv=clamp(dot(n,v),0.001,1.0);
 let h=(v+l)/max(0.0001,length(v+l));let nh=clamp(dot(n,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
 let alpha=rough*rough;let a2=alpha*alpha+max(0.0,frame.foam.y-${Fe}*resolvedShort);let denominator=${A(`n`,`h`)};let d=a2/(3.14159265*denominator*denominator);let k=(rough+1.0)*(rough+1.0)*0.125;
 let g=nv/(nv*(1.0-k)+k)*nl/max(0.001,nl*(1.0-k)+k);
 return d*g*fresnel(vh)/max(0.004,4.0*nv);
}
fn directionalGlint(light:Light,n:vec3f,v:vec3f,rough:f32)->vec3f {
 if(light.direction.w<=0.0){return vec3f(0);}
 return light.radiance.rgb*light.direction.w*seaGlint(n,v,light.direction.xyz,rough);
}


${O}
fn skyTap(direction:vec3f,horizon:f32,turn:f32)->vec3f {
 let d=normalize(vec3f(direction.x,max(horizon,direction.y),direction.z));
 return textureSampleLevel(environment,skySampler,seaSkyUv(d,turn),0.0).rgb;
}
fn skyLobe(direction:vec3f,rough:f32,horizon:f32,turn:f32)->vec3f {
 let r=normalize(vec3f(direction.x,max(max(1e-6,horizon),direction.y),direction.z));
 let across=normalize(cross(select(vec3f(0,1,0),vec3f(1,0,0),r.y>0.999),r));
 let up=cross(r,across);
 let width=rough*rough*1.41421356;
 let at=array<vec3f,5>(r,r+across*width,r-across*width,r+up*width,r-up*width);
 var taps:array<vec3f,5>;
 for(var k=0u;k<waterLoops(5u);k++){taps[k]=skyTap(at[k],horizon,turn);}
 return taps[0]*0.5+(taps[1]+taps[2]+taps[3]+taps[4])*0.125;
}
fn reflectionRay(r:vec3f)->vec3f {return normalize(vec3f(r.x,max(0.02,r.y),r.z));}
fn incidentSky(direction:vec3f,rough:f32)->vec3f {
 if(frame.color.w>0.5&&hdrSkyScale()>0.0){return skyLobe(direction,rough,0.0,hdrSkyTurn())*hdrSkyScale();}
 let r=reflectionRay(direction);
 if(frame.color.w>0.5){let uv=seaSkyUv(r,0.0);let spread=vec2f(rough*0.035,0);return textureSampleLevel(environment,skySampler,uv,0).rgb*0.5+(textureSampleLevel(environment,skySampler,uv-spread,0).rgb+textureSampleLevel(environment,skySampler,uv+spread,0).rgb)*0.25;}
 return mix(vec3f(0.18,0.27,0.32),vec3f(0.035,0.10,0.20),sqrt(max(0.0,r.y)))*frame.radiance.rgb*(0.015+min(1.0,frame.sun.w*0.15));
}




fn skyAmbient()->f32 {
 let at=array<vec3f,2>(vec3f(0.866,0.5,0),vec3f(0.5,0.866,0));
 var sky:array<vec3f,2>;
 for(var k=0u;k<waterLoops(2u);k++){sky[k]=incidentSky(at[k],0.4);}
 let a=sky[0];let b=sky[1];
 return clamp(dot((a+b)*0.5,vec3f(0.2126,0.7152,0.0722))/0.02,0.0,1.0);
}
fn foamSky()->vec3f {
 var sum=vec3f(0);
 for(var k=0u;k<8u;k++){let a=f32(k)*0.78539816;let up=select(0.5,0.8660254,(k&1u)==1u);let side=sqrt(1.0-up*up);sum+=incidentSky(vec3f(cos(a)*side,up,sin(a)*side),0.4);}
 return sum*0.125;
}
fn foamLight(deep:vec3f,n:vec3f,xz:vec2f,amount:f32,footprint:f32,fine:f32,sky:vec3f,sun:vec3f,toward:vec3f)->vec3f {
 let t=frame.settings.x;
 let at=array<vec2f,2>(xz*1.9+vec2f(t*0.07,-t*0.05),xz*4.7+vec2f(-t*0.11,3.3));
 var layers:array<vec3f,2>;
 for(var k=0u;k<waterLoops(2u);k++){layers[k]=noise(at[k]);}
 let a=layers[0];let b=layers[1];
 let detail=(1.0-smoothstep(0.15,0.6,footprint))*min(1.0,amount*1.5);
 let slope=(a.yz*(1.9*0.08)+b.yz*(4.7*0.03*fine))*detail;
 let lump=normalize(n-vec3f(slope.x,0.0,slope.y));
 let seen=mix(FOAM_OPEN,clamp(FOAM_OPEN+(a.x*0.6+b.x*0.4*fine)*0.45,0.75,1.0),detail);
 let layer=exp(-FOAM_DEPTH*amount);let albedo=deep*(1.0-layer)/(vec3f(1.0)-deep*deep*layer);
 return albedo*(sky*(0.5+0.5*lump.y)*seen+sun*max(dot(lump,toward),0.0)/3.14159265);
}

fn hdrDiffuse()->vec3f {
 var sum=vec3f(0);
 for(var k=0u;k<8u;k++){
  let up=sqrt(select(0.25,0.75,(k&1u)==1u));let side=sqrt(1.0-up*up);let a=f32(k)*0.78539816;
  sum+=skyTap(vec3f(cos(a)*side,up,sin(a)*side),0.0,hdrSkyTurn());
 }
 return sum*(0.125*hdrSkyScale());
}
fn skyColorBase(direction:vec3f,rough:f32)->vec3f {
 if(frame.color.w>0.5&&hdrSkyScale()<=0.0){return skyLobe(direction,rough,0.02,0.0);}
 return incidentSky(direction,rough);
}
fn skyColor(direction:vec3f,rough:f32)->vec3f {return skyColorBase(direction,rough);}
struct Result {@location(0) color:vec4f,@location(1) foam:vec4f,@location(2) reactive:vec4f}
${k}
@fragment fn fragment(i:Output)->Result{
 let pixel=vec2i(i.clip.xy);let waterDistance=linear(i.clip.z);let sceneDepth=textureLoad(depth,pixel,0);
 var gap=50.0;if(sceneDepth>0){gap=max(0.0,linear(sceneDepth)-waterDistance)*abs(frame.eye.y-i.world.y)/max(0.0001,waterDistance);}
 var movement=i.crest;let isCoast=inCoast(i.xz);var refraction=1.0;var dry=false;var river=false;var open=1.0;
 if(frame.flow.w>0.5){
  let sample=coastal(i.xz);let v=sample.water;refraction=coastBlend(i.xz).z;

  let outside=max(max(frame.coast.xy-i.xz,i.xz-frame.coast.xy-frame.coast.zw),vec2f(0));let bed=max(0.0,i.world.y-v.y)+length(outside)*0.35;
  gap=mix(gap,min(gap,bed),select(sample.ocean,1.0,isCoast));
  if(isCoast){dry=sample.edge<=0.0;gap=mix(gap,v.x,sample.blend.z);movement=mix(movement,v.z,sample.blend.z);river=STILL&&v.y>frame.settings.y;open=1.0-sample.blend.z;}
 }
 let pixelX=dpdx(i.world.xz);let pixelY=dpdy(i.world.xz);
 let footprint=max(length(pixelX),length(pixelY));

 let contactRadius=max(0.03,frame.settings.z);
 let edge=clamp(fwidth(min(gap,contactRadius))*1.5,0.015,contactRadius*0.5);
 let normalWidth=length(fwidth(i.normal));
 let grainDetail=1.0-smoothstep(0.25,1.0,footprint*2.4);var grain=0.5;

 if(grainDetail>0){grain=0.5+noise(i.world.xz*2.4+vec2f(frame.settings.x*0.22,0)).x*grainDetail;}






 var surfing=0.0;var surfZone=0.0;var surfFoam=0.0;var murk=0.0;
 if(COAST_SURF&&isCoast&&!river){
  let here=surfHere(i.xz,footprint,true);surfing=here.weight*here.surf.breaking;surfZone=here.weight*here.surf.zone;
  if(surfing>0.0){
   let q=i.world.xz;let t=frame.settings.x;
   let at=array<vec2f,4>(q*0.21+vec2f(t*0.03,0.0),q*0.63+vec2f(3.1,-t*0.05),q*0.9+vec2f(-t*0.04,7.3),q*2.3+vec2f(1.7,t*0.06));
   var layers:array<f32,4>;
   for(var k=0u;k<waterLoops(4u);k++){layers[k]=noise(at[k]).x;}
   let patches=layers[0]+layers[1]*0.5;
   let web=1.0-abs(layers[2]+layers[3]*0.45*grainDetail);
   let roller=here.surf.foam.x*smoothstep(-0.3,0.15,patches+here.surf.foam.x*0.45-0.2)*mix(0.6,1.0,smoothstep(0.35,0.8,web));
   let trail=here.surf.foam.y*smoothstep(-0.3,0.3,patches+here.surf.foam.y*0.3)*mix(0.25,1.0,smoothstep(0.62,0.9,web))*0.9;
   surfFoam=max(roller,trail)*here.weight;
  }
  murk=here.weight*max(here.surf.breaking,here.surf.stir);
 }
 let shore=(1.0-smoothstep(0.0,max(frame.settings.z*0.5,edge*2.0),max(0.0,gap+(grain-0.5)*0.08)))*(1.0-smoothstep(0.0,0.3,surfZone));
 let pattern=mix(mix(0.45,1.0,frame.foam.z),1.0,grain);let caps=frame.grid.z;
 let fresh=clamp((select(shore,0.0,river)*SHORE_FOAM+movement*(0.9+0.9*caps))*pattern,0.0,1.0);
 var foam=max(fresh,surfFoam);if(frame.flow.w<0.5){foam=max(foam,textureLoad(history,pixel,0).r*exp(-frame.cameraData.z*3.0)*shore);}
 if(caps>0.0&&!river){
  var lines=0.0;

  if(isCoast){let near=landNearby(i.world.xz);lines=smoothstep(0.04,0.3,near+(grain-0.5)*0.25+0.08*sin(frame.settings.x*1.3-near*9.0))*mix(0.55,1.0,grain)*(1.0-smoothstep(0.0,0.3,surfZone));}
  foam=max(foam,max(whitecap(i.world.xz,footprint)*open,lines*caps));
 }
 var shown=foam;if(frame.foam.z>0.0){shown=pow(foam,1.0-0.4*frame.foam.z);}
 var ripple=vec3f(0);

 if(footprint<13.334){


 let p=i.world.xz;
 let ripples=array<NoiseLayer,5>(rippleAt(p,vec2f(0.98200,0.18886),vec2f(0.22,0.16),vec2f(-0.09,0.03),vec2f(0),pixelX,pixelY),
  rippleAt(p,vec2f(0.93233,-0.36162),vec2f(0.57,0.42),vec2f(-0.17,-0.06),vec2f(3.17,9.23),pixelX,pixelY),
  rippleAt(p,vec2f(0.86281,0.50553),vec2f(1.8,0.65),vec2f(-0.5,0.12),vec2f(0),pixelX,pixelY),
  rippleAt(p,vec2f(0.75836,-0.65183),vec2f(3.4,1.9),vec2f(-0.7,0.2),vec2f(7.13,3.71),pixelX,pixelY),
  rippleAt(p,vec2f(0.99619,-0.08716),vec2f(0.11,0.075),vec2f(-0.3,0.05),vec2f(1.9,6.4),pixelX,pixelY));
 var rippleNoise:array<vec2f,5>;
 for(var k=0u;k<waterLoops(5u);k++){rippleNoise[k]=vec2f(0);if(ripples[k].detail>0.0){rippleNoise[k]=noise(ripples[k].at).yz;}}
 let slope=rippleSlope(ripples[0],rippleNoise[0])*0.186
  +rippleSlope(ripples[1],rippleNoise[1])*0.062
  +rippleSlope(ripples[2],rippleNoise[2])*0.0112
  +rippleSlope(ripples[3],rippleNoise[3])*0.0037;
 let chop=frame.grid.w;
 let windSea=rippleSlope(ripples[4],rippleNoise[4])*0.5;
 let w=frame.waves[0].wave.xy;let basis=mat2x2f(w,vec2f(-w.y,w.x));let local=transpose(basis);let q=local*p;

 var shortWaves=vec2f(0);var gain=1.0;
 if(chop>0.0){
  let scale=vec3f(1.0,0.041,0.073);
  let windPatch=noise(q*scale.yz-vec2f(frame.settings.x*0.095,0))*scale;
  let gust=smoothstep(-0.48,0.48,windPatch.x);
  gain=mix(1.0,mix(0.4,1.6,gust),sqrt(chop));
  let dx=local*pixelX;let dy=local*pixelY;
  let a=shortWaveSlope(q,dx,dy,vec2f(1.48,0.81),0.060,windPatch*4.1);
  let b=shortWaveSlope(q,dx,dy,vec2f(1.63,-2.21),0.029,vec3f(2.1,0,0)-windPatch*3.4);
  shortWaves=(basis*(a+b))*(chop*gain*(1.0-smoothstep(7.0,13.333334,footprint)));
 }
 var capillary=vec2f(0);
 if(chop>0.0&&footprint<0.16){
  let u=shortWind(chop);
  let octaves=array<NoiseLayer,5>(shortOctaveAt(p,vec2f(0.99255,0.12187),25.0,vec2f(0.37,5.1),pixelX,pixelY),
   shortOctaveAt(p,vec2f(0.95630,-0.29237),48.0,vec2f(8.3,1.9),pixelX,pixelY),
   shortOctaveAt(p,vec2f(0.89879,0.43837),92.0,vec2f(2.6,7.7),pixelX,pixelY),
   shortOctaveAt(p,vec2f(0.78801,-0.61566),177.0,vec2f(6.1,3.3),pixelX,pixelY),
   shortOctaveAt(p,vec2f(0.68200,0.73135),340.0,vec2f(4.4,9.6),pixelX,pixelY));
  var n:array<vec2f,5>;
  for(var k=0u;k<waterLoops(5u);k++){n[k]=vec2f(0);if(octaves[k].detail>0.0){n[k]=noise(octaves[k].at).yz;}}
  let o=shortOctaveSlope(octaves[0],25.0,u,n[0])+shortOctaveSlope(octaves[1],48.0,u,n[1])
   +shortOctaveSlope(octaves[2],92.0,u,n[2])+shortOctaveSlope(octaves[3],177.0,u,n[3])
   +shortOctaveSlope(octaves[4],340.0,u,n[4]);
  capillary=o.xy;resolvedShort=o.z*gain*gain;
 }
 let agitated=(slope*(1.0+3.0*chop)+windSea*chop)*gain+shortWaves+capillary*gain;
 ripple=vec3f(-agitated.x,0,-agitated.y)*(1.0-shown);
 }
 let n=normalize(i.normal+ripple);


 let normalDx=dpdx(n);let normalDy=dpdy(n);
 let variance=(dot(normalDx,normalDx)+dot(normalDy,normalDy))/12.0;

 if(dry){discard;}
 let v=normalize(frame.eye.xyz-i.world);let nv=clamp(dot(n,v),0.001,1.0);


 var optical=min(50.0,gap/max(0.15,abs(v.y)));var opticalGap=gap;
 let hdr=hdrSkyScale()>0.0;
 var irradiance=vec3f(0);
 var ambient=frame.eye.w;
 if(hdr){irradiance=hdrDiffuse();ambient*=clamp(dot(irradiance,vec3f(0.2126,0.7152,0.0722))/0.02,0.0,1.0);}
 else{ambient*=skyAmbient();}

 let diffuse=select(vec3f(ambient),irradiance*(frame.eye.w/0.18),hdr);
 var bottom=vec3f(0.28,0.25,0.17)*(diffuse+frame.radiance.rgb*frame.sun.w*0.12);
 if(frame.radiance.w>0.5&&refraction>0.0){
  let bent=refract(-v,n,0.75187970);
  let a=frame.camera*vec4f(i.world,1);let b=frame.camera*vec4f(bent,0);
  var hit=refractedScene(a,b,min(50.0,gap/max(0.05,-bent.y)));
  if(hit.w<0.0){hit=refractionCrossing(a,b);}
  if(hit.w>0.0){
   bottom=mix(bottom,hit.rgb,refraction);
   optical=mix(optical,hit.w,refraction);opticalGap=mix(gap,max(0.0,-bent.y*hit.w),refraction);
  }else if(frame.flow.w<0.5){

   optical=50.0;opticalGap=50.0;
  }
 }
 let transmission=exp(-(vec3f(0.38,0.10,0.045)+vec3f(1.4,1.3,1.5)*murk)*optical);
 let nl=clamp(dot(n,frame.sun.xyz),0.0,1.0);
 let baseRough=clamp(max(frame.foam.w,0.12+normalWidth*0.6+footprint*0.025),frame.foam.w,max(0.4,frame.foam.w));
 let alpha=baseRough*baseRough;
 let rough=min(sqrt(sqrt(alpha*alpha+2.0*variance)),max(0.55,frame.foam.w));


 let reflectedY=reflect(-v,n).y;
 let skyVisible=1.0-0.34*smoothstep(0.0,0.18+1.41421356*rough*rough,-reflectedY);
 let reflection=fresnel(nv)*mix(1.0,skyVisible,open);
 let glint=directionalGlint(frame.lights[0],n,v,rough)+directionalGlint(frame.lights[1],n,v,rough);

 var shade=1.0;if(foam>0.002||max(glint.x,max(glint.y,glint.z))>0.002){shade=waterShadow(i.world);}
 let shallowBand=select(0.0,1.0-smoothstep(0.0,frame.shallow.w,opticalGap),frame.shallow.w>0.0);
 let bodyLight=diffuse+frame.radiance.rgb*nl*frame.sun.w*0.12;
 let body=bottom*transmission+frame.color.rgb*(vec3f(1)-transmission)*bodyLight+(frame.shallow.rgb-frame.color.rgb)*shallowBand*(vec3f(1)-transmission)*bodyLight;



 let foamAlbedo=FOAM_ALBEDO;
 var foamColor=vec3f(0);
 if(shown>0.002){
  var skyLight=vec3f(ambient);if(hdr){skyLight=max(irradiance,skyLight);}else{skyLight=max(foamSky(),skyLight);}
  foamColor=foamLight(foamAlbedo,n,i.world.xz,shown,footprint,grainDetail,skyLight,frame.radiance.rgb*frame.sun.w*shade,frame.sun.xyz);
 }
 var color=mix(body,skyColor(reflect(-v,n),rough),reflection)+glint*shade;
 color=mix(color,foamColor,shown);
 if(frame.cameraData.w<0.5){color=toDisplay(color);}



 var travel=0.6;
 for(var j=0u;j<u32(frame.settings.w);j++){travel=max(travel,sqrt(9.81/max(frame.waves[j].wave.w,1e-4)));}
 let reactive=smoothstep(0.25,1.0,travel*frame.cameraData.z/max(footprint,1e-6));
 return Result(vec4f(color,1),vec4f(foam,0,0,1),vec4f(reactive,0,0,1));
}`,He=`@fragment fn fragment(i:Output)->Result{`,Ue=/var color=mix\(body,skyColor\(reflect\(-v,n\),rough\),reflection\)\+glint\*shade;[\s\S]*return Result\(vec4f\(color,1\),vec4f\(foam,0,0,1\),vec4f\(reactive,0,0,1\)\);/;function We(e){let t=`let v=surface(xz,sampleWidth);var clip=frame.camera*vec4f(v.position,1);if(HORIZON){clip.z=max(clip.z,0.000001*clip.w);}return Output(clip,v.normal,v.position,v.crest,xz);`,n=`if(dry){discard;}`;if(!e.includes(t)||!e.includes(n))throw s(`unsupported`,`Water horizon depth needs the unclipped surface and dry-fragment anchors; update its shader edit`);return e.replace(t,`if(sampleWidth<0.0){
        let p=vec3f(xz.x,frame.settings.y,xz.y);let clip=frame.camera*vec4f(p,1);
        return Output(vec4f(clip.xy,0.0,clip.w),vec3f(0,1,0),p,0.0,xz);
       }
       let v=surface(xz,sampleWidth);
       return Output(frame.camera*vec4f(v.position,1),v.normal,v.position,v.crest,xz);`).replace(n,`if(i.clip.z==0.0&&(frame.camera*vec4f(i.world,1)).z>0.0){discard;}\n ${n}`)}var Ge=/struct MargoSSR \{\s*@location\(0\) specular:vec4f,\s*@location\(1\) weight:vec4f,\s*@location\(2\) normal:vec4f\s*\}/;function Ke(e,t){let n=Ge.test(t)?`let keep=reflection*(1.0-shown);_=body;_=glint*shade;return MargoSSR(vec4f(skyColor(reflect(-v,n),rough)*keep,rough),vec4f(vec3f(keep),1),vec4f(n*0.5+0.5,1));`:`_=body;_=glint*shade;_=reflection;${t.includes(`var<private> margoPosition`)?`margoPosition=i.world;`:``}return margoSSR(n,v,mix(frame.color.rgb,foamColor,shown),0.0,rough);`,r=e.replace(He,`@fragment fn fragment(i:Output)->MargoSSR{`).replace(Ue,n);if(!r.includes(`->MargoSSR{`)||!/return (MargoSSR|margoSSR)\(/.test(r))throw s(`unsupported`,`Water capture needs the water fragment; its shader changed`);return t+r}var qe=`if(frame.cameraData.w<0.5){color=toDisplay(color);}`,Je=`let fogA=fogAmount(i.world);if(frame.cameraData.w<0.5){let mapped=mix(pbrNeutral(max(color,vec3f(0))),margoFog.color.rgb,fogA);color=select(mapped*12.92,1.055*pow(mapped,vec3f(1.0/2.4))-0.055,mapped>=vec3f(0.0031308));}else{color=mix(color,margoFog.color.rgb,fogA);}`;function Ye(e){if(e.split(qe).length!==2)throw s(`unsupported`,`Water fog needs the water fragment it was written for; update its fog edit`);return e.replace(qe,Je)+le(0,8)}var Xe=`
fn waterShadow(p:vec3f)->f32 {return 1.0;}`,Ze=`
fn waterShadow(p:vec3f)->f32 {return shadowVisibility(p,vec3f(0,1,0));}`,Qe=`
@group(0) @binding(0) var sceneDepth:texture_depth_2d;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {return textureLoad(sceneDepth,vec2i(p.xy),0);}
`,$e=0;function $(e,t){if(typeof e!=`number`||!(e>=0&&e<=1))throw o(`unsupported`,`Invalid water ${t}; use a number from 0 to 1`,`ocean`);return e}var et=1e7,tt=class e{coreRequirement=n(`1.0.0`,import.meta.url);constructor(e={}){this.options=e,this.attachment={view:void 0,loadOp:`load`,storeOp:`store`},this.foamAttachment={view:void 0,loadOp:`clear`,storeOp:`store`,clearValue:{r:0,g:0,b:0,a:0}},this.depthAttachment={view:void 0,depthLoadOp:`load`,depthStoreOp:`store`,stencilReadOnly:!0},this.reactiveAttachment={view:void 0,loadOp:`clear`,storeOp:`store`,clearValue:{r:0,g:0,b:0,a:0}},this.presentation={colorAttachments:[this.attachment,this.foamAttachment,this.reactiveAttachment],depthStencilAttachment:this.depthAttachment},this.copiedDepth={view:void 0,depthClearValue:0,depthLoadOp:`clear`,depthStoreOp:`store`,stencilReadOnly:!0},this.depthPresentation={colorAttachments:[],depthStencilAttachment:this.copiedDepth},this.copyBuilt=-1,this.colorSource={texture:void 0},this.colorTarget={texture:void 0},this.colorSize={width:1,height:1,depthOrArrayLayers:1},this.views=new p(()=>({foam:[],foamViews:[],current:0,groups:[],resources:[],drawn:0,built:-1,captureGroups:new Map}),e=>{for(let t of e.foam)t.destroy();e.reactive?.destroy(),e===this.drawnView&&(this.drawnView=void 0)}),this.built=0,this.shaderCode=``,this.effectBindings=[],this.vertexBindings=[],this.captures=new Map,this.disposers=new Set,this.name=`water:`+ ++$e,this.count=0,this.format=``,this.seconds=0,this.values=new Float32Array(3804),this.flowTicks=0,this.seaRows=this.values.subarray(220),this.fogSource=null,this.fogData=new Float32Array(12),this.waveHeights=new Float32Array(8),this.maxWaveHeight=0,this.foamFollowsWind=!1,this.disposed=!1,this.cpuSeaTime=NaN,this.cpuSeaCount=0;let{size:t=[100,100],segments:n=128,height:r=0,color:i=[.01,.18,.25],foamDistance:a=1,waves:s=Be(e.wind??ze).waves}=e;if(!e.waves){let t=Q(e.wind??ze);this.windSea={speed:t.speed,fetch:t.fetch,direction:t.direction}}if(t.length!==2||t.some(e=>!Number.isFinite(Math.fround(e))||e<=0||e>1e5)||!Number.isInteger(n)||n<1||n>512||!Number.isFinite(Math.fround(r))||!Number.isFinite(a)||a<=0||a>100||i.length!==3||i.some(e=>!Number.isFinite(e)||e<0||e>1)||s.length<1||s.length>8||e.depth!==void 0&&typeof e.depth!=`function`)throw o(`unsupported`,`Invalid water options; use size and segments above 0, finite color and height, 1 to 8 waves and a depth function`,`ocean`);if(e.sea!==void 0&&typeof e.sea?.waveComponents!=`function`)throw o(`unsupported`,`Water sea needs waveComponents(t, out); pass a SpectralSea from @margoengine/physics/sea`,`ocean`);if(this.values.set([0,r,a,e.sea?0:s.length],20),this.values[Ae]=0,this.values.set(i,24),this.values[135]=.12,this.values.set([0,.28,.3],136),this.values.set([.6,.8,0,3,1,.9,.75,0],104),this.setWhitecaps(e.whitecaps??0).setChop(e.chop??0),this.foamFollowsWind=e.whitecaps===void 0&&!!this.windSea,e.reflection!==void 0&&typeof e.reflection!=`function`||e.reflectionEnvironment!==void 0&&!T(e.reflectionEnvironment))throw o(`unsupported`,`Invalid water optics; pass a Sky texture callback as reflection or an HDR Environment as reflectionEnvironment`,`ocean`);if(e.sceneColor!==void 0&&typeof e.sceneColor!=`function`||e.spray!==void 0&&typeof e.spray!=`boolean`||e.spray&&!e.terrain||e.sprayCount!==void 0&&(!Number.isInteger(e.sprayCount)||e.sprayCount<64||e.sprayCount>65536||e.sprayCount%64!=0)||e.horizon!==void 0&&typeof e.horizon!=`boolean`)throw o(`unsupported`,`Invalid water optics or spray options; sceneColor takes a function and horizon takes a boolean, spray needs options.terrain, and sprayCount is a multiple of 64 from 64 to 65536`,`ocean`);if(e.shadows!==void 0&&(typeof e.shadows?.pbr!=`function`||typeof e.shadows?.bindings!=`function`))throw o(`unsupported`,`Water shadows need pbr() and bindings(); pass a Shadows from @margoengine/shadows`,`ocean`);if(e.fill!==void 0&&(typeof e.fill!=`function`||!e.terrain)||e.still!==void 0&&(typeof e.still!=`boolean`||!e.terrain||e.spray))throw o(`unsupported`,`Invalid water fill or still; fill takes a function, still a boolean, both need options.terrain and still does not take spray`,`ocean`);this.validateLights(),this.horizon=e.horizon??!1,this.cell=[t[0]/n,t[1]/n],this.sampleWidth=Math.hypot(this.cell[0],this.cell[1]),this.values[98]=this.values[99]=1;let l=e.terrain;if(l){if(typeof l.heightmap!=`function`||l.origin.length!==2||l.origin.some(e=>!Number.isFinite(Math.fround(e)))||l.size.length!==2||l.size.some(e=>!Number.isFinite(Math.fround(e))||e<=0||e>1e5)||l.heights!==void 0&&(typeof l.heights!=`object`||l.heights===null||!Number.isInteger(l.heights.width)||!Number.isInteger(l.heights.height)||l.heights.width<2||l.heights.height<2||l.heights.width>Oe||l.heights.height>Oe||l.heights.data?.length!==l.heights.width*l.heights.height))throw o(`unsupported`,`Invalid water terrain; pass a heightmap function, a finite origin [x, z], a size [x, z] from 0 to 100000 and heights of width x height values (2 to 8192 a side)`,`ocean`);this.values.set(l.origin,96),this.values.set(l.size,98),this.values[103]=1}let u=Math.hypot(t[0]/n,t[1]/n);for(let e=0;e<s.length;e++){let t=s[e],n=Math.hypot(...t.direction),r=t.steepness??.5;if(t.direction.length!==2||t.direction.some(e=>!Number.isFinite(e))||!n||!Number.isFinite(t.amplitude)||t.amplitude<0||t.amplitude>100||!Number.isFinite(t.wavelength)||t.wavelength<=0||t.wavelength>1e5||!Number.isFinite(r)||r<0||r>1||!Number.isFinite(t.phase??0))throw o(`unsupported`,`Invalid Gerstner wave; use a non-zero [x, z] direction, amplitude 0-100, wavelength above 0 up to 100000, steepness 0-1`,`ocean`);let i=2*Math.PI/t.wavelength;if(r*t.amplitude*i>1/s.length)throw o(`failed`,`Wave steepness would fold the surface; lower the amplitude or steepness, or lengthen the wavelength`,`geometry`);let a=Math.max(0,Math.min(1,(t.wavelength/u-2)/2));this.values.set([t.direction[0]/n,t.direction[1]/n,t.amplitude,i,r,Math.sqrt(9.81*i),t.phase??0,a*a*(3-2*a)],32+e*8),this.waveHeights[e]=t.amplitude,this.maxWaveHeight=Math.max(this.maxWaveHeight,t.amplitude)}this.followWind();let d=(n+1)**2,f=n**2*6;this.positions=new Float32Array((d+(this.horizon?4:0))*3),this.triangles=new Uint32Array(f+(this.horizon?6:0));let m=Math.max(0,Math.floor(n*.875)-n/2),h=n/2-m-1,_=(this.horizon&&h>0?t:[]).map(e=>{let t=e/n,r=(e/2+1e4-m*t)/t,i=e=>e*(e**h-1)/(e-1),a=1,o=2;for(;i(o)<r;)o*=2;for(let e=0;e<200;e++){let e=(a+o)/2;i(e)<r?a=e:o=e}return o}),v=(e,r)=>{let i=e/n-.5,a=Math.abs(e-n/2);if(!this.horizon||a<=m)return i*t[r];if(a>=n/2)return Math.sign(i)*et;let o=t[r]/n,s=_[r];return Math.sign(i)*(m*o+o*s*(s**(a-m)-1)/(s-1))},y=(e,t)=>Math.max(v(Math.min(n,e+1),t)-v(e,t),v(e,t)-v(Math.max(0,e-1),t));for(let e=0;e<=n;e++)for(let t=0;t<=n;t++){let r=(e*(n+1)+t)*3;if(this.positions[r]=v(t,0),this.positions[r+1]=v(e,1),this.positions[r+2]=Math.hypot(y(t,0),y(e,1)),t<n&&e<n){let i=r/3,a=i+n+1;this.triangles.set([i,a,i+1,i+1,a,a+1],(e*n+t)*6)}}if(this.horizon){let e=et;this.positions.set([-1e7,-1e7,-1,e,-1e7,-1,-1e7,e,-1,e,e,-1],d*3),this.triangles.set([d,d+2,d+1,d+1,d+2,d+3],f)}this.count=this.triangles.length,g.set(this,()=>this.disposed||!this.engine?.gpu||!this.uniform||!this.drawnView?.groups.length?void 0:{kind:`water`,device:this.engine.gpu,token:this.uniform,values:this.values,time:this.values[20],shader:this.shaderCode.slice(0,this.shaderCode.indexOf(`struct Output`)),segments:n,positions:this.positions,resources:this.drawnView.resources[this.drawnView.drawn],coast:this.coastal,extraBindings:this.vertexBindings,extraVelocity:(c.get(this)??[]).map(e=>e.velocity).filter(e=>!!e),still:this.shaderCode.includes(`const STILL=true;`)})}static attach(t,r={}){a(t,n(`1.0.0`,import.meta.url));let i=new e(r);return ee(t).use(i),i}get reactiveTexture(){return this.drawnView?.reactive}get coastalDepthTexture(){return this.coastal?.states[this.coastal.current]}get depthTexture(){return this.surfaceDepth}get fog(){return this.fogSource}setFog(e){return this.fogSource=ue(e),this}setWhitecaps(e){return e===null?(this.values[130]=this.values[132]=0,this.foamFollowsWind=!!this.windSea,this.followWind(),this):(this.values[130]=$(e,`whitecaps`),this.values[132]=0,this.foamFollowsWind=!1,this)}get wind(){let e=this.windSea;return e&&{speed:e.speed,fetch:e.fetch,direction:e.direction&&[e.direction[0],e.direction[1]]}}setColor(e){if(e.length!==3||e.some(e=>!Number.isFinite(e)||e<0||e>1))throw o(`unsupported`,`Invalid water color; use three numbers from 0 to 1`,`ocean`);return this.values.set(e,24),this}setSeaLevel(e){if(this.disposed)throw new i(`disposed`,`Water disposed; create a new Water`);if(typeof e!=`number`||!Number.isFinite(Math.fround(e))||Math.abs(e)>1e5)throw o(`unsupported`,`Invalid water sea level; use a finite world Y from -100000 to 100000`,`ocean`);return this.values[21]=e,this}setFarField(e){let t=this.values;if(e===null)return t.fill(0,G,216),this;let n=e?.profile,r=n?.length??0;if(!e||typeof e!=`object`||r<2||r>64)throw o(`unsupported`,`Invalid water far field; use { sides, profile, range } with 2 to 64 samples`,`ocean`);for(let e=0;e<r;e++)if(!Number.isFinite(n[e])||Math.abs(n[e])>1e5)throw o(`unsupported`,`Invalid water far field profile; use finite metres from -100000 to 100000`,`ocean`);let i=(e,t,n)=>{let r=e??n;if(!Number.isFinite(r)||r<=0||r>1e7)throw o(`unsupported`,`Invalid water far field ${t}; use metres above 0 and up to 10000000`,`ocean`);return r},a=this.options.terrain,s=i(e.range,`range`,1),c=i(e.spread,`spread`,a?Math.max(a.size[0],a.size[1]):1),l=e.sides??{};t.set([+!!l.west,+!!l.east,+!!l.south,+!!l.north,s,r,c,1],G);for(let e=0;e<64;e++)t[152+e]=n[Math.min(e,r-1)];return this}get seaLevel(){return this.values[21]}setGlitterRoughness(e){if(!Number.isFinite(e)||e<.02||e>.6)throw o(`unsupported`,`Invalid water glitterRoughness; use a number from 0.02 to 0.6`,`ocean`);return this.values[135]=e,this}setFoamSoftness(e){return this.values[134]=$(e,`foamSoftness`),this}setShallow(e,t){if(e.length!==3||e.some(e=>!Number.isFinite(e)||e<0||e>1)||!Number.isFinite(t)||t<0||t>100)throw o(`unsupported`,`Invalid water shallow band; use a colour of three numbers from 0 to 1 and a depth from 0 to 100`,`ocean`);return this.values.set(e,136),this.values[139]=t,this}setFoamDistance(e){if(!Number.isFinite(e)||e<=0||e>100)throw o(`unsupported`,`Invalid water foamDistance; use a number above 0 and up to 100`,`ocean`);return this.values[22]=e,this}setChop(e){return this.values[131]=$(e,`chop`),this}breakerLine(){let e=this.options.terrain;if(!e?.heights)return[];let t=[];for(let e=0;e<this.values[23];e++)t.push({amplitude:this.values[34+e*8],wavenumber:this.values[35+e*8]});let n=be(t),r=this.values[21]-n,i=this.breakers;if(i&&i.level===r&&i.data===e.heights.data)return i.lines;let a=n>0?xe(e.heights,e.origin,e.size,r):[];return this.breakers={level:r,data:e.heights.data,lines:a},a}setWind(e){if(this.disposed)throw new i(`disposed`,`Water disposed; create a new Water`);if(!this.windSea)throw o(`unsupported`,`setWind needs a Water without options.waves; the trains you passed stay as they are`,`ocean`);let t=Q(e),n=this.windSea;this.windSea={speed:t.speed,fetch:t.fetch??n.fetch,direction:t.direction??n.direction};let r=Be(this.windSea);return this.maxWaveHeight=0,r.waves.forEach((e,t)=>{let n=32+t*8,r=Math.hypot(e.direction[0],e.direction[1]);this.values[n]=e.direction[0]/r,this.values[n+1]=e.direction[1]/r,this.values[n+2]=e.amplitude,this.values[n+4]=e.steepness??.5,this.waveHeights[t]=e.amplitude,this.maxWaveHeight=Math.max(this.maxWaveHeight,e.amplitude)}),this.followWind(),this}tickFlow(e,t,n,r=480){let i=this.coastal,a=i.substeps,s=je(a),c=n.ticks(s);if(!Number.isSafeInteger(c)||c<0)throw o(`unsupported`,`A Water clock gives whole ticks from 0; got ${c}. Pass a FilmClock`,`ocean`);if(!i.isSetUp){let t=this.tickSlice??=new Float32Array(q);for(let e=0;e<q;e++)t[e]=this.values[e];t[20]=this.flowTicks/s,t[100]=a/(3*s),t[30]=1/s,e.queue.writeBuffer(this.uniform,0,t),i.ready(),e.queue.writeBuffer(this.uniform,0,this.values,0,q)}let l=Math.min(r,c-this.flowTicks);if(!(l>0))return 0;this.ring??=e.createBuffer({size:481*J,usage:GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});let u=this.ringData??=new Float32Array(481*q),d=this.values;for(let e=0;e<=l;e++){let t=e*q;for(let e=0;e<q;e++)u[t+e]=d[e];if(e===l)break;u[t+20]=(this.flowTicks+e)/s,u[t+100]=a/(3*s),u[t+30]=1/s}e.queue.writeBuffer(this.ring,0,u,0,(l+1)*q),i.writeSources();for(let e=0;e<l;e++)t.copyBufferToBuffer(this.ring,e*J,this.uniform,0,J),i.tick(t),this.spray?.step(t);return t.copyBufferToBuffer(this.ring,l*J,this.uniform,0,J),this.flowTicks+=l,l}async settle(){let e=this.options.clock;if(!e)throw new i(`state`,`Water.settle needs a film clock; pass options.clock (a FilmClock).`);let t=this.engine?.gpu;if(this.coastal instanceof S&&this.uniform&&t){for(;;){let n=t.createCommandEncoder(),r=this.tickFlow(t,n,e);if(t.queue.submit([n.finish()]),r<480)break}await t.queue.onSubmittedWorkDone()}}writeSea(e){let t=e.waveComponents(this.seconds,this.seaRows);if(!Number.isInteger(t)||t<0||t>896)throw o(`unsupported`,`Water draws 0 to 896 sea waves; the sea gave ${t}. Give the wave spectrum fewer frequencies or directions`,`ocean`);this.values[K]=t}followWind(){if(!this.windSea)return;let e=0;for(let t=0;t<this.values[23];t++){let n=32+t*8,r=this.values[n+2]*this.values[n+3]*this.values[n+7];for(let[t,n]of Ie)e+=.56*(r*t*n)**2}if(this.values[133]=Fe*Math.max(0,.003+.00512*this.windSea.speed-e-Pe),!this.foamFollowsWind)return;let t=F(this.windSea.speed);if(this.windSea.speed<Ne||t<=0){this.values[130]=this.values[132]=0;return}let n=Me*Me+e,r=Re(Math.min(.9,t)),i=r-(Y[0]-X[0]);if(r>=Y[Y.length-1])i=r-(Y[Y.length-1]-X[X.length-1]);else if(r>Y[0]){for(let e=1;e<Y.length;e++)if(r<=Y[e]){let t=(r-Y[e-1])/(Y[e]-Y[e-1]);i=X[e-1]+t*(X[e]-X[e-1]);break}}this.values[130]=Math.min(1,t/.25),this.values[132]=Math.max(1e-4,Math.sqrt(n)*i)}setWaveHeight(e){if(e===null&&(e=this.maxWaveHeight),this.disposed)throw new i(`disposed`,`Water disposed; create a new Water`);if(!Number.isFinite(e)||e<0||e>100||!this.maxWaveHeight&&e>0)throw o(`unsupported`,`Invalid water wave height; use 0 to 100 meters, and a wave train with an amplitude above 0 to scale`,`ocean`);for(let t=0;t<this.values[23];t++){let n=32+t*8,r=this.maxWaveHeight?e*this.waveHeights[t]/this.maxWaveHeight:0;if(this.values[n+4]*r*this.values[n+3]>1/this.values[23])throw o(`failed`,`Wave steepness would fold the surface; lower the amplitude or steepness, or lengthen the wavelength`,`geometry`)}for(let t=0;t<this.values[23];t++)this.values[34+t*8]=this.maxWaveHeight?e*this.waveHeights[t]/this.maxWaveHeight:0;return this.followWind(),this}setup(e){if(this.disposed||!e.gpu)throw new i(this.disposed?`disposed`:`unsupported`,`Water requires WebGPU; attach a new Water to a WebGPU engine; see https://margoengine.com/errors#webgpu`);this.engine=e,this.options.depth||(this.shared??=v(e)),this.source=this.options.depth??this.shared.texture,this.uniform=e.gpu.createBuffer({size:this.values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.skySampler=e.gpu.createSampler({addressModeU:`repeat`,addressModeV:`clamp-to-edge`,minFilter:`linear`,magFilter:`linear`}),this.vertices=e.gpu.createBuffer({size:this.positions.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),e.gpu.queue.writeBuffer(this.vertices,0,this.positions),this.indices=e.gpu.createBuffer({size:this.triangles.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST}),e.gpu.queue.writeBuffer(this.indices,0,this.triangles)}registerPasses(e){e.add({name:this.name+`:draw`,order:4,execute:e=>{e.backend===`webgpu`&&this.drawSurface(e)}})}validateLights(){let e=this.options.lights;if(e!==void 0){if(!Array.isArray(e)||e.length>2)throw o(`unsupported`,`Water accepts up to two directional lights; pass options.lights with at most two entries`,`ocean`);for(let t of e){if(!t||t.direction?.length!==4||t.radiance?.length!==3)throw o(`unsupported`,`Invalid water light; use a finite direction [x, y, z, w >= 0] that is not zero and a finite radiance [r, g, b] of 0 or more`,`ocean`);for(let e=0;e<4;e++)if(!Number.isFinite(Math.fround(t.direction[e]))||e<3&&(!Number.isFinite(Math.fround(t.radiance[e]))||t.radiance[e]<0))throw o(`unsupported`,`Invalid water light; use a finite direction [x, y, z, w >= 0] that is not zero and a finite radiance [r, g, b] of 0 or more`,`ocean`);if(t.direction[3]<0||!Math.hypot(Math.fround(t.direction[0]),Math.fround(t.direction[1]),Math.fround(t.direction[2])))throw o(`unsupported`,`Invalid water light; use a finite direction [x, y, z, w >= 0] that is not zero and a finite radiance [r, g, b] of 0 or more`,`ocean`)}}}fillCells(e){let{fill:t,still:n,terrain:r}=this.options;if(!t&&!n)return;let{width:i,height:a}=e,o=new Float32Array(i*a).fill(d);if(t)for(let e=0;e<a;e++)for(let n=0;n<i;n++){let s=t(r.origin[0]+(n+.5)*r.size[0]/i,r.origin[1]+(e+.5)*r.size[1]/a);s!==void 0&&Number.isFinite(s)&&(o[e*i+n]=s)}return o}drawSurface(e){m(e);let t=e.descriptor.multisample?.count??1,n=this.source();if(!n||n.width!==e.width||n.height!==e.height||!n.format.startsWith(`depth`)||!(n.usage&GPUTextureUsage.TEXTURE_BINDING))throw new i(`state`,`Water needs viewport-sized sampleable scene depth; return one from options.depth`);let r=this.options.reflectionEnvironment??this.options.reflection,a=E(r);if(r&&(!a||a.dimension!==`2d`||a.sampleCount!==1||a.depthOrArrayLayers>1||a.format!==`rgba16float`||!(a.usage&GPUTextureUsage.TEXTURE_BINDING)))throw new i(`state`,`Water reflection needs a sampleable rgba16float sky texture from Sky or Environment`);this.reflected!==a&&(this.reflected=a,this.built++),this.values[27]=+!!a;let o=this.options.sceneColor?.();if(this.values[111]=+!!o,this.options.sceneColor){if(!o||o.dimension!==`2d`||o.sampleCount!==1||o.depthOrArrayLayers>1||o.width!==e.width||o.height!==e.height||o.format!==`rgba16float`||o.format!==e.format||!(o.usage&GPUTextureUsage.COPY_SRC))throw new i(`state`,`Water scene color needs a viewport-sized copyable HDR color texture; return an rgba16float one from options.sceneColor`);let n=l(e);t===4&&n?.samples===4&&o===n.resolvedColor&&o.usage&GPUTextureUsage.TEXTURE_BINDING?((this.colorSource.texture!==o||!this.capturedView||this.captured)&&(this.captured?.destroy(),this.captured=void 0,this.capturedView=o.createView(),this.built++),this.colorSource.texture=o):((this.captured?.width!==e.width||this.captured?.height!==e.height||this.captured?.format!==e.format)&&(this.captured?.destroy(),this.captured=e.device.createTexture({size:[e.width,e.height],format:e.format,usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING}),this.capturedView=this.captured.createView(),this.colorTarget.texture=this.captured,this.colorSize.width=e.width,this.colorSize.height=e.height,this.built++),this.colorSource.texture=o,e.encoder.copyTextureToTexture(this.colorSource,this.colorTarget,this.colorSize))}if(this.surfaceDepth?.width!==e.width||this.surfaceDepth?.height!==e.height||this.surfaceDepth?.format!==n.format||this.surfaceDepth?.sampleCount!==t){let r=this.surfaceDepth?.format!==n.format||this.surfaceDepth?.sampleCount!==t;if(this.surfaceDepth?.destroy(),this.surfaceDepth=e.device.createTexture({size:[e.width,e.height],format:n.format,sampleCount:t,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.surfaceView=this.surfaceDepth.createView(),this.copiedDepth.view=this.surfaceView,this.built++,r){let r=e.device.createShaderModule({code:Qe});this.copyPipeline=e.device.createRenderPipeline({layout:`auto`,vertex:{module:r,entryPoint:`vertex`},fragment:{module:r,entryPoint:`fragment`,targets:[]},depthStencil:{format:n.format,depthWriteEnabled:!0,depthCompare:`always`},multisample:{count:t}}),this.format=``}}if((t===4&&(this.foamMSAA?.width!==e.width||this.foamMSAA.height!==e.height||!this.foamMSAAView)||t===1&&this.foamMSAA)&&(this.foamMSAA?.destroy(),this.foamMSAA=void 0,this.foamMSAAView=void 0,this.reactiveMSAA?.destroy(),this.reactiveMSAA=void 0,this.reactiveMSAAView=void 0,t===4)){let t=()=>e.device.createTexture({size:[e.width,e.height],format:`r8unorm`,sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT});this.foamMSAA=t(),this.foamMSAAView=this.foamMSAA.createView(),this.reactiveMSAA=t(),this.reactiveMSAAView=this.reactiveMSAA.createView()}let s=this.view=this.drawnView=this.views.get(e);if(s.foam[0]?.width!==e.width||s.foam[0]?.height!==e.height){for(let e of s.foam)e.destroy();s.foam=[];for(let t=0;t<2;t++)s.foam.push(e.device.createTexture({size:[e.width,e.height],format:`r8unorm`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT}));s.foamViews=s.foam.map(e=>e.createView()),s.reactive?.destroy(),s.reactive=e.device.createTexture({size:[e.width,e.height],format:`r8unorm`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT}),s.reactiveView=s.reactive.createView(),s.built=-1,s.current=0}let u=this.options.shadows,d=this.fogSource;d&&(U(d,e.camera.position,this.fogData),this.fogBuffer??=e.device.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),e.device.queue.writeBuffer(this.fogBuffer,0,this.fogData));let f=c.get(this)??[],p=[],g=[],_=9;for(let t of f)for(let n of t.prepare(e)){let e={binding:_++,resource:n};p.push(e),t.vertex&&g.push(e)}(p.length!==this.effectBindings.length||p.some((e,t)=>e.resource!==this.effectBindings[t].resource))&&this.built++,this.effectBindings=p,this.vertexBindings=g;let v=f.map(e=>e.key).join(`,`),b=y.get(this),w=x.get(this),T=!!this.options.terrain&&!this.options.still&&!b&&!w,O=`${v}:${e.format}:${t}:${n.format}:${!!u}${d?`:fog`:``}${T?`:surf`:``}`;if(this.format!==O){let r=Ve.replace(`const HORIZON=false;`,`const HORIZON=${this.horizon};`).replace(`const STILL=false;`,`const STILL=${!!this.options.still};`).replace(`const COAST_SURF=true;`,`const COAST_SURF=${T};`)+(u?`
`+u.pbr(1).declarations+Ze:Xe);this.horizon&&(r=We(r));let i=9;for(let e of f)r=e.shader(r,i),i+=e.count;this.shaderCode=d?Ye(r):r;let a=e.device.createShaderModule({code:this.shaderCode});this.pipeline=e.device.createRenderPipeline({layout:`auto`,vertex:{module:a,entryPoint:`vertex`,buffers:[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:`float32x2`},{shaderLocation:1,offset:8,format:`float32`}]}]},fragment:{module:a,entryPoint:`fragment`,targets:[{format:e.format},{format:`r8unorm`},{format:`r8unorm`}]},primitive:{cullMode:`none`},depthStencil:{format:n.format,depthCompare:`greater-equal`,depthWriteEnabled:!0},multisample:{count:t}}),this.format=O,this.built++,this.shadowEntries=void 0}if(this.values.set(e.camera.matrix),this.values.set(e.camera.position,16),this.horizon){let[t,n]=this.cell;this.values[128]=Math.round(e.camera.position[0]/t)*t,this.values[129]=Math.round(e.camera.position[2]/n)*n}this.values[20]=this.seconds,this.options.sea&&this.writeSea(this.options.sea),this.values[28]=e.camera.near,this.values[29]=e.camera.far,this.values[30]=e.delta,this.values[31]=+M(e.format),this.values.set(e.view?.viewport??[0,0,e.width,e.height],140);let k=this.engine.lighting;if(this.values[19]=k?.radiance[3]??.15,k&&(j(this.values,104,k.direction),this.values[108]=k.radiance[0],this.values[109]=k.radiance[1],this.values[110]=k.radiance[2]),this.validateLights(),this.values.fill(0,112,128),this.options.lights)for(let e=0;e<this.options.lights.length;e++){let t=this.options.lights[e],n=Math.hypot(t.direction[0],t.direction[1],t.direction[2]);for(let r=0;r<3;r++)this.values[112+e*8+r]=t.direction[r]/n;this.values[115+e*8]=t.direction[3],this.values.set(t.radiance,116+e*8)}else this.values.copyWithin(112,104,108),this.values.copyWithin(116,108,111);if(this.options.clock&&this.coastal instanceof S&&this.options.clock.ticks(je(this.coastal.substeps))<this.flowTicks&&(this.coastalSource=void 0),this.options.terrain){let t=this.options.terrain.heightmap();if(!t||t.dimension!==`2d`||t.sampleCount!==1||t.depthOrArrayLayers>1||t.width<2||t.height<2||t.format!==`r32float`||!(t.usage&GPUTextureUsage.TEXTURE_BINDING))throw new i(`state`,`Water terrain needs a sampleable 2D r32float heightmap of at least 2 cells per side; return one from options.terrain.heightmap`);let n=t.width*t.height,r=(w||b||this.options.still?n+1:se.words(n))*4,a=Math.min(e.device.limits.maxStorageBufferBindingSize,e.device.limits.maxBufferSize);if(r>a)throw new i(`state`,`Water terrain of ${t.width} x ${t.height} cells needs ${r} B in one storage binding, over this device's ${a} B; use larger cells`);(!this.coastalSource||this.coastal?.terrain!==t||this.coastalSource[0]!==b||this.coastalSource[1]!==w)&&(this.spray?.dispose(),this.spray=void 0,this.coastal?.dispose(),this.coastal=void 0,this.flowTicks=0,this.coastal=w?w({device:e.device,uniform:this.uniform,terrain:t,fill:this.fillCells(t)}):new S(e.device,this.uniform,t,this.fillCells(t),this.options.still,b,se),this.coastalSource=[b,w],this.options.spray&&(this.spray=new he(e.device,this.uniform,this.coastal,this.options.sprayCount??4096)),this.values[101]=this.values[98]/t.width,this.values[102]=this.values[99]/t.height,this.built++),this.values[100]=Math.min(Math.max(e.delta,0),1/15)/3}this.values[ke]=this.coastal?.seaBlendEdges??15,D(r,this.values,119,127,0),e.device.queue.writeBuffer(this.uniform,0,this.values,0,220+4*this.values[K]),this.options.clock&&this.coastal instanceof S?this.tickFlow(e.device,e.encoder,this.options.clock):(this.coastal?.step(e.encoder),this.spray?.step(e.encoder)),this.bindDepth(e,s,n);let A=u?.bindings();A&&this.shadowEntries!==A&&(this.shadowGroup=e.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(1),entries:A}),this.shadowEntries=A);let N=l(e);if(N&&t===4)N.copyDepth(e.encoder,this.surfaceView,4,this.surfaceDepth.format);else{let t=e.encoder.beginRenderPass(this.depthPresentation);t.setPipeline(this.copyPipeline),t.setBindGroup(0,this.copyGroup),h(t,e),t.draw(3),t.end()}s.drawn=s.current*(this.coastal?2:1)+(this.coastal?.current??0);let P=!1,F=C.get(this);if(F)for(let t of F)P=!!t.draw(e)||P;P&&this.captured&&this.colorSource.texture===N?.resolvedColor&&e.encoder.copyTextureToTexture(this.colorSource,this.colorTarget,this.colorSize);let I=s.groups[s.drawn];s.current=1-s.current,this.attachment.view=e.color,this.foamAttachment.view=t===4?this.foamMSAAView:s.foamViews[s.current],this.foamAttachment.resolveTarget=t===4?s.foamViews[s.current]:void 0,this.foamAttachment.storeOp=t===4?`discard`:`store`,this.reactiveAttachment.view=t===4?this.reactiveMSAAView:s.reactiveView,this.reactiveAttachment.resolveTarget=t===4?s.reactiveView:void 0,this.reactiveAttachment.storeOp=t===4?`discard`:`store`,this.depthAttachment.view=this.surfaceView;let L=e.encoder.beginRenderPass(this.presentation);h(L,e),L.setPipeline(this.pipeline),L.setBindGroup(0,I),A&&L.setBindGroup(1,this.shadowGroup),L.setVertexBuffer(0,this.vertices),L.setIndexBuffer(this.indices,`uint32`),L.drawIndexed(this.count),L.end(),Ce(e,this.surfaceDepth),Te(e,s.reactive),this.spray?.draw(e,this.surfaceDepth,this.surfaceView,a,this.skySampler,d?this.fogBuffer:void 0)}setCapture(e){if(this.disposed||!e||typeof e.declarations!=`function`||typeof e.begin!=`function`||!Array.isArray(e.targets))throw o(`unsupported`,`Invalid water capture hook; pass an object with a targets array and the callbacks it documents`,`ocean`);return this.capture=e,()=>{this.capture===e&&(this.capture=void 0)}}bindDepth(e,t,n){if(this.sampledDepth!==n&&(this.sampledDepth=n,this.built++),this.copyBuilt!==this.built&&(this.depthView=n.createView({aspect:`depth-only`}),this.copyGroup=w(e.device,this.copyPipeline,[this.depthView]),this.copyBuilt=this.built),t.built!==this.built){t.groups=[],t.resources=[],t.captureGroups.clear();for(let n=0;n<2;n++)for(let r=0;r<(this.coastal?2:1);r++){let i=[{buffer:this.uniform},this.depthView,t.foamViews[n],this.coastal?.views[r]??t.foamViews[n],this.reflected?.createView()??t.foamViews[n],this.skySampler,this.capturedView??t.foamViews[n],{buffer:this.coastal?.connected??this.uniform}];this.fogSource&&i.push({buffer:this.fogBuffer}),t.groups.push(e.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[...i.map((e,t)=>({binding:t,resource:e})),...this.effectBindings]})),t.resources.push(i)}t.built=this.built}}onDispose(e){if(typeof e!=`function`)throw o(`unsupported`,`Water onDispose needs a function; pass the callback to run on dispose`,`ocean`);return this.disposers.add(e),()=>this.disposers.delete(e)}draw(e,t,n,r){let i=this.capture,a=this.view??this.drawnView;if(t!==`capture`||!i||this.disposed||!a?.groups.length||!this.shaderCode)return;let o=this.source();o&&o!==this.sampledDepth&&this.bindDepth(e,a,o);let s=this.options.shadows,c=i.declarations(this.shaderCode),l=i.targets.map(e=>e.format).join(`,`)+`:`+e.descriptor.multisample?.count+`:`+e.descriptor.depthStencil.format+`\0`+c+`\0`+this.shaderCode,u=this.captures.get(l);if(!u){let t=e.device.createShaderModule({code:Ke(this.shaderCode,c)}),n=e.device.createRenderPipeline({layout:`auto`,vertex:{module:t,entryPoint:`vertex`,buffers:[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:`float32x2`},{shaderLocation:1,offset:8,format:`float32`}]}]},fragment:{module:t,entryPoint:`fragment`,targets:i.targets},primitive:{cullMode:`none`},depthStencil:{format:e.descriptor.depthStencil.format,depthCompare:`greater-equal`,depthWriteEnabled:!0},multisample:e.descriptor.multisample});if(this.captures.size>=8){this.captures.clear();for(let e of this.views.values())e.captureGroups.clear()}this.captures.set(l,u={pipeline:n})}let d=u.pipeline,f=De(e.camera),p=this.captureValues??=new Float32Array(this.values.length);if(p.set(this.values),p.set(f.matrix),p.set(f.position,16),this.horizon){let[e,t]=this.cell;p[128]=Math.round(f.position[0]/e)*e,p[129]=Math.round(f.position[2]/t)*t}if(p[20]=this.seconds,p[28]=f.near,p[29]=f.far,this.captureUniform?.size!==this.uniform.size){this.captureUniform?.destroy(),this.captureUniform=e.device.createBuffer({size:this.uniform.size,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});for(let e of this.views.values())e.captureGroups.clear()}e.device.queue.writeBuffer(this.captureUniform,0,p,0,220+4*p[K]);let m=a.captureGroups.get(d);m||a.captureGroups.set(d,m=a.resources.map(t=>e.device.createBindGroup({layout:d.getBindGroupLayout(0),entries:[...t.slice(0,8).map((e,t)=>({binding:t,resource:t===0?{buffer:this.captureUniform}:e})),...this.effectBindings]})));let h=s?.bindings();h&&u.shadowEntries!==h&&(u.shadowEntries=h,u.shadow=e.device.createBindGroup({layout:d.getBindGroupLayout(1),entries:h}));let g=i.begin();g.setPipeline(d),g.setBindGroup(0,m[a.drawn]),h&&g.setBindGroup(1,u.shadow),g.setVertexBuffer(0,this.vertices),g.setIndexBuffer(this.indices,`uint32`),g.drawIndexed(this.count)}release(){this.captures.clear();for(let e of this.views.values())e.captureGroups.clear();this.shaderCode=``,this.foamMSAA?.destroy(),this.foamMSAA=void 0,this.foamMSAAView=void 0,this.reactiveMSAA?.destroy(),this.reactiveMSAA=void 0,this.reactiveMSAAView=void 0,this.shared?.release(),this.shared=void 0,this.spray?.dispose(),this.spray=void 0,this.coastal?.dispose(),this.coastal=void 0,this.coastalSource=void 0,this.surfaceDepth?.destroy(),this.surfaceDepth=void 0,this.surfaceView=void 0,this.copyPipeline=void 0,this.copyGroup=this.depthView=void 0,this.captured?.destroy(),this.captured=void 0,this.capturedView=void 0,this.reflected=void 0,this.skySampler=void 0,this.uniform?.destroy(),this.captureUniform?.destroy(),this.captureUniform=void 0,this.vertices?.destroy(),this.indices?.destroy(),this.fogBuffer?.destroy(),this.fogBuffer=void 0,this.ring?.destroy(),this.ring=void 0,this.views.clear(),this.view=this.drawnView=void 0,this.built++,this.shadowGroup=this.shadowEntries=void 0,this.sampledDepth=void 0,this.uniform=this.vertices=this.indices=void 0,this.pipeline=void 0,this.format=``}onDeviceRestored(e){let t=this.shared;this.shared=void 0,this.release(),this.shared=t,this.setup(e)}get time(){return this.seconds}resetTime(){this.seconds=0,this.views.clear(),this.view=void 0,this.coastalSource=void 0,this.flowTicks=0}advanceTime(e){this.options.clock?this.seconds=this.options.clock.time:e>0&&(this.seconds+=e)}setTime(e){if(!Number.isFinite(e)||e<0||e>1e9)throw o(`unsupported`,`Invalid water time; pass seconds from 0 to 1e9`,`ocean`);return this.seconds=e,this}farIncoming(e,t){let n=this.values;if(n[151]<.5)return 0;let r=n[96],i=n[97],a=r+n[98],o=i+n[99],s=Math.max(0,(r-e)*n[G],(e-a)*n[145],(i-t)*n[146],(t-o)*n[147]),c=n[149],l=Math.max(0,Math.min(1,s/Math.max(n[148],.001)))*(c-1),u=Math.min(Math.floor(l),c-1),d=Math.min(u+1,c-1),f=n[152+u];return f+(n[152+d]-f)*(l-u)}syncCpuSea(e){let t=this.options.sea;if(this.cpuSeaTime===e)return;let n=this.cpuSeaWaves??=new Float32Array(3584),r=this.cpuSeaNext??=new Float32Array(3584),i=this.cpuSeaRates??=new Float32Array(896),a=t.waveComponents(e,n);if(!Number.isInteger(a)||a<0||a>896)throw o(`unsupported`,`Water draws 0 to 896 sea waves; the sea gave ${a}. Give the wave spectrum fewer frequencies or directions`,`ocean`);let s=.001,c=t.waveComponents(e+s,r),l=2*Math.PI;for(let e=0;e<a;e++)if(e<c){let t=r[e*4+3]-n[e*4+3];t-=l*Math.round(t/l),i[e]=t/s}else i[e]=-Math.sqrt(9.81*Math.hypot(n[e*4],n[e*4+1]));this.cpuSeaCount=a,this.cpuSeaTime=e}sample(e,t,n){if(this.disposed)throw new i(`disposed`,`Water disposed; create a new Water`);if(typeof e!=`number`||typeof t!=`number`||!Number.isFinite(e)||!Number.isFinite(t))throw o(`unsupported`,`Invalid water sample coordinates; pass finite world XZ metres`,`ocean`);let r=n??this.seconds;if(typeof r!=`number`||!Number.isFinite(r)||r<0||r>1e9)throw o(`unsupported`,`Invalid water sample time; pass finite seconds from 0 to 1e9`,`ocean`);let a=this.values,s=a[23],c=this.sampleWidth,l=e,u=t;if(s>0)for(let n=0;n<6;n++){let n=l,i=u,o=1,d=0,f=0,p=1;for(let e=0;e<s;e++){let t=32+e*8,s=a[t],m=a[t+1],h=a[t+2],g=a[t+3],_=a[t+4]*.9,v=a[t+5],y=a[t+6],b=a[t+7];if(h!==0&&_!==0)for(let e=0;e<3;e++){let t=Le[e],a=s*t[0]-m*t[1],x=s*t[1]+m*t[0],S=-x,C=a,w=g*t[2],T=v*t[3],E=h*t[4]*Math.min(b,Z(w,c));if(E===0)continue;let D=w*.35*(S*l+C*u)-T*r*.12+y+t[5],O=Math.cos(D),k=w*(a+S*.49*O),A=w*(x+C*.49*O),j=w*(a*l+x*u)-T*r+y+t[5]+1.4*Math.sin(D),M=Math.sin(j),N=Math.cos(j);n+=_*E*a*N,i+=_*E*x*N;let P=-_*E*a*M,F=-_*E*x*M;o+=P*k,d+=F*k,f+=P*A,p+=F*A}}let m=n-e,h=i-t;if(m*m+h*h<=1e-16)break;let g=o*p-f*d;if(Math.abs(g)<1e-9)break;l-=(p*m-f*h)/g,u-=(-d*m+o*h)/g}let d=this.farIncoming(l,u),f=a[21]+d,p=1,m=0,h=0,g=0,_=0,v=1,y=0,b=0,x=0;a[151]>.5&&(m=(this.farIncoming(l+.5,u)-d)*2,_=(this.farIncoming(l,u+.5)-d)*2);for(let e=0;e<s;e++){let t=32+e*8,n=a[t],i=a[t+1],o=a[t+2],s=a[t+3],d=a[t+4]*.9,S=a[t+5],C=a[t+6],w=a[t+7];if(o!==0)for(let e=0;e<3;e++){let t=Le[e],a=n*t[0]-i*t[1],T=n*t[1]+i*t[0],E=-T,D=a,O=s*t[2],k=S*t[3],A=o*t[4]*Math.min(w,Z(O,c));if(A===0)continue;let j=O*.35*(E*l+D*u)-k*r*.12+C+t[5],M=Math.cos(j),N=O*(a+E*.49*M),P=O*(T+D*.49*M),F=O*(a*l+T*u)-k*r+C+t[5]+1.4*Math.sin(j),I=Math.sin(F),L=Math.cos(F);f+=A*I;let R=-d*A*a*I,z=A*L,B=-d*A*T*I;p+=R*N,m+=z*N,h+=B*N,g+=R*P,_+=z*P,v+=B*P;let V=-k*(1+.168*M);y+=-d*a*I*A*V,b+=L*A*V,x+=-d*T*I*A*V}}if(this.options.sea){this.syncCpuSea(r);let e=this.cpuSeaWaves,t=this.cpuSeaRates;for(let n=0;n<this.cpuSeaCount;n++){let r=n*4,i=e[r],a=e[r+1],o=e[r+2],s=e[r+3],d=o*Z(Math.hypot(i,a),c);if(d===0)continue;let p=i*l+a*u+s,h=Math.sin(p);f+=d*Math.cos(p),m-=d*i*h,_-=d*a*h,b-=d*h*t[n]}}let S=_*h-v*m,C=v*p-g*h,w=g*m-_*p,T=Math.hypot(S,C,w);return{height:f,normal:T>0?[S/T,C/T,w/T]:[0,1,0],velocity:[y,b,x],time:r}}sampleHeight(e,t,n){return this.sample(e,t,n).height}onPreUpdate(e){this.advanceTime(e),e>0&&(this.views.prune(),this.view=void 0)}dispose(){if(this.disposed)return;this.disposed=!0,this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.cpuSeaWaves=this.cpuSeaNext=this.cpuSeaRates=void 0,this.cpuSeaTime=NaN,this.cpuSeaCount=0,this.capture=void 0,this.engine=void 0;let e=[...this.disposers];this.disposers.clear();for(let t of e)t()}[Symbol.dispose??Symbol()](){this.dispose()}};export{tt as Water};