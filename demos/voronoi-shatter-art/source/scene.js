import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { Timeline, easeSmoothstep } from '@margoengine/tween';

const sculptureShader=`
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) base: vec3f,
  @location(2) point: vec3f,
  @location(3) features: vec2f,
}
fn rotate(v:vec3f, axis:vec3f, angle:f32)->vec3f {
  let s=sin(angle); let c=cos(angle);
  return v*c + cross(axis,v)*s + axis*dot(axis,v)*(1.0-c);
}
@vertex fn vertex(a:Attributes)->Out {
  let amount=uniforms.amount;
  let seed=a.features.y;
  let axis=normalize(vec3f(.63*cos(seed*2.71),.75,.92*sin(seed*5.62)));
  let roll=amount*(.18+.14*sin(seed*3.9))*(cos(seed*3.17));
  let point=a.center + rotate(a.position-a.center,axis,roll) + (amount*a.motion);
  return Out(camera.viewProjection*vec4f(point,1),rotate(a.normal,axis,roll),a.position,point,a.features);
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let n=normalize(i.normal);
  let view=normalize(camera.position-i.point);
  let reflectDir=reflect(-view,n);
  let facing=max(dot(n,view),0.0);
  let rim=pow(1.0-facing,2.4);
  let warm=max(dot(n,vec3f(-.47,.71,.53)),0);
  let sky=max(dot(n,vec3f(.61,.15,.778)),0);
  let topLight=pow(max(dot(reflectDir,vec3f(-.47,.71,.53)),0),10.0);
  let sideLight=pow(max(dot(reflectDir,vec3f(.61,.15,.778)),0),24.0);
  let rimLight=pow(max(dot(reflectDir,vec3f(.526,.69,-.496)),0),12.0);
  let shade=.48+.39*warm+.17*sky;
  let r=i.base;
  let ripples=sin(7.6*r.x+4.0*r.y+5.6*r.z + .81*sin(9.4*r.y-3.2*r.x));
  let pigment=smoothstep(-.85,.93,r.y*.63-r.x*.45+r.z*.56+ripples*.22);
  let cobalt=vec3f(.134,.216,.518);
  let violet=vec3f(.582,.316,.541);
  let turquoise=vec3f(.279,.735,.746);
  var stone=mix(cobalt,violet,smoothstep(.06,.56,pigment));
  stone=mix(stone,turquoise,smoothstep(.50,1.0,pigment));
  let speckle=.0038*sin(390.0*r.x+365.0*r.y)*sin(271.0*r.z-495.0*r.y);
  var glaze=stone*shade + vec3f(.290,.231,.172)*topLight + vec3f(.095,.220,.244)*sideLight;
  glaze+=vec3f(.224,.132,.245)*rim*(.28+.45*sky)+vec3f(.153,.121,.090)*rimLight+speckle;
  if(i.features.x>.5) {
    let layers=.5+.5*sin(68.0*r.z+52.0*r.x+7.0*r.y+.92*sin(14.0*r.y-8.0*r.x));
    let pits=.5+.5*sin(129.0*r.x+180.0*r.z)*sin(168.0*r.y+224.0*r.x);
    let clay=vec3f(.794,.545,.319)+vec3f(.087,.093,.083)*layers-vec3f(.042,.053,.050)*pits;
    let cap=clay*(.40+.45*warm+.24*sky)+vec3f(.108,.066,.035)*topLight + vec3f(.089,.066,.063)*rim;
    return vec4f(cap,1);
  }
  return vec4f(glaze,1);
}`;

const backdropShader=`
struct Out { @builtin(position) clip:vec4f, @location(0) uv:vec2f, }
@vertex fn vertex(a:Attributes)->Out {
  return Out(vec4f(a.position,.00001,1),a.position*.5+.5);
}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let p=i.uv;
  let shape=(p-vec2f(.49,.58))*vec2f(1.56,1.0);
  let light=exp(-4.14*dot(shape,shape));
  let rose=(p-vec2f(.31,.51))*vec2f(1.29,1.45);
  let falloff=exp(-5.15*dot(rose,rose));
  let hall=mix(vec3f(.098,.086,.139),vec3f(.245,.220,.296),light*.87);
  let shadow=exp(-14.0*((p.x-.52)*(p.x-.52)+4.0*(p.y-.045)*(p.y-.045)));
  let floor=vec3f(.21,.178,.204)-vec3f(.072,.067,.083)*shadow;
  let carpet=smoothstep(.123,.233,p.y);
  let glass=vec3f(.045,.012,.023)*falloff;
  return vec4f(mix(floor,hall+glass,carpet),1);
}`;

function plinthGeometry(radius,stretch,y,tiers) {
  const p=[],n=[],i=[];
  const P=(d,a,b)=>[d*radius*Math.cos(a),y+b,d*radius*stretch*Math.sin(a)];
  function emit(...face) {
    const [a,b,c]=face;
    const u=b.map((v,j)=>v-a[j]),v=c.map((w,j)=>w-a[j]);
    const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const length=Math.hypot(...cross),start=p.length/3;
    for(const point of face){p.push(...point);n.push(...cross.map(v=>v/length));}
    for(let j=1;j<face.length-1;j++)i.push(start,start+j,start+j+1);
  }
  for(let b=0;b<96;b++) {
    const a=b*Math.PI/48,c=(b+1)*Math.PI/48;
    for(let edge=1;edge<tiers.length;edge++) {
      const [r0,h0]=tiers[edge-1],[r1,h1]=tiers[edge];
      emit(P(r0,a,h0),P(r1,a,h1),P(r1,c,h1),P(r0,c,h0));
    }
    const [r0,h0]=tiers[0],[r1,h1]=tiers.at(-1);
    emit([0,y+h0,0],P(r0,a,h0),P(r0,c,h0));
    emit([0,y+h1,0],P(r1,c,h1),P(r1,a,h1));
  }
  return new Geometry(p,n,i);
}
function furnish(engine) {
  const model=(geometry,color,roughness,metalness=0,position=[0,0,0])=>engine.createMesh()
    .setGeometry(geometry).setMaterial(new PbrMaterial({color,roughness,metalness,doubleSided:false})).setPosition(position);
  model(plinthGeometry(2.54,.66,-3.10,[[.960,-.21],[1,-.139],[1,.016],[.978,.040]]),'#55505d',.68);
  model(plinthGeometry(2.486,.662,-3.10,[[.998,.041],[1,.051],[1,.070],[.998,.078]]),'#a78a6f',.35,.40);
  model(plinthGeometry(2.478,.662,-3.10,[[.998,.079],[1,.081],[1,.106],[.974,.138]]),'#635a6e',.63);
  model(box(.51,.084,.012),'#b49a7d',.39,.35,[.04,-3.146,1.673]);
}

export async function openGallery(canvas,prepared,start,force,signal) {
  const position={value:0};
  const tween=new Timeline().to(position,'value',1,{duration:1,easing:easeSmoothstep});
  let engine,raw,model,background,stats,error,initialTravel,closed=false;
  const close=()=>{
    if(closed)return;
    closed=true;
    raw?.dispose();
    model?.dispose();
    background?.dispose();
    engine?.dispose();
  };
  signal.addEventListener('abort',close,{once:true});
  const legacy=force||!navigator.gpu;
  const install=async()=>(await import('./compatibility.js')).installCompatibility(force,signal);
  const project=(out,aspect,webgpu)=>{
    const span=Math.max(7.42,6.85/aspect),near=engine.camera.near,far=engine.camera.far,range=far-near;
    out[0]=2/(span*aspect);out[5]=2/span;
    out[10]=webgpu?1/range:-2/range;
    out[14]=webgpu?far/range:-(far+near)/range;
    out[15]=1;
  };
  async function render(q,compile=false) {
    signal.throwIfAborted();
    const ratio=Math.min(devicePixelRatio,2,1440/Math.max(1,canvas.clientWidth));
    const width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    tween.seek(q);
    model.uniforms.amount.value=position.value;
    engine.render({delta:0});
    if(compile) {
      await raw.ready();
      signal.throwIfAborted();
      if(error)throw error;
      engine.render({delta:0});
    }
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
    if(error)throw error;
    return position.value*stats.maxOffset;
  }
  if(legacy)await install();
  try {
    engine=await autoEngine(canvas,async target=>{
      if(!target.gpu) {
        const cause=new Error('The sculpture requires WebGPU or the full Margo WebGL2 compatibility layer.');
        cause.code='unsupported';throw cause;
      }
      engine=target;
      canvas=target.canvas;
      engine.onError=cause=>{error=cause;};
      error=undefined;
      engine.camera.project=project;
      engine.scene.background='#32283b';
      engine.lighting.direction.set([-.45,.80,.39,2.1]);
      engine.lighting.radiance.set([1,.84,.75,.7]);
      engine.lighting.ambient.set([.51,.59,.69]);
      raw=RawShaders.attach(engine);
      furnish(engine);
      const fault=cause=>{error=cause;};
      background=new RawShaderMaterial({vertexShader:backdropShader,cull:'none',depthWrite:false});
      background.onError=fault;
      raw.add(new RawMesh({material:background,attributes:{
        position:{type:'vec2f',data:new Float32Array([-1,-1,3,-1,-1,3])},
      }}));
      performance.mark('margo-device-open');
      const piece=await prepared;
      stats=piece.stats;
      const {positions,normals,centers,features,translation}=piece.shape;
      model=new RawShaderMaterial({vertexShader:sculptureShader,uniforms:{amount:{value:0}},cull:'back'});
      model.onError=fault;
      raw.add(new RawMesh({material:model,attributes:{
        position:{type:'vec3f',data:positions},normal:{type:'vec3f',data:normals},
        center:{type:'vec3f',data:centers},features:{type:'vec2f',data:features},motion:{type:'vec3f',data:translation},
      }}));
      initialTravel=await render(start,true);
    },{
      backend:legacy?'webgpu':undefined,loadCompat:async()=>({install}),signal,
      exactSize:true,antialias:true,capacity:20,startupTimeout:11000,
      camera:{position:[3.1,1.75,11.6],target:[0,-.22,0],near:.8,far:50},
    });
  } catch(cause) {
    close();throw cause;
  }
  return {render,stats,close,initialTravel,backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu'};
}
