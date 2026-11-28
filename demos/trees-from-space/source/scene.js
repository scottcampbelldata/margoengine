import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { autoEngine } from '@margoengine/webgl2-compat/auto';
import { RawMesh, RawShaderMaterial, RawShaders } from '@margoengine/shader/raw';
import { barriers } from './growth.js';

const colorShader = `
struct Out {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) paint: vec3f,
  @location(2) birth: f32,
}
@vertex fn vertex(a: Attributes) -> Out {
  return Out(camera.viewProjection * vec4f(a.position,1), a.normal, a.paint, a.birth);
}
@fragment fn fragment(i: Out, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  if (i.birth > uniforms.clock) { discard; }
  let n = normalize(i.normal);
  let key = abs(dot(n, vec3f(-.44,.68,.59)));
  let fill = abs(dot(n, vec3f(.73,.08,.68)));
  let lambert = .58 + .35*key + .08*fill;
  let colored = i.paint*lambert + vec3f(.029,.043,.026)*(1.0-key);
  return vec4f(colored,1);
}`;


const chamberShader = `
struct Out { @builtin(position) clip:vec4f, @location(0) uv:vec2f, }
@vertex fn vertex(a:Attributes) -> Out {
  return Out(vec4f(a.position,.00001,1.0), a.position*.5+.5);
}
@fragment fn fragment(i:Out) -> @location(0) vec4f {
  let p=i.uv;
  let pool = exp(-3.15*dot((p-vec2f(.50,.61))*vec2f(1.62,1.03),(p-vec2f(.50,.61))*vec2f(1.62,1.03)));
  let split = smoothstep(.420,.490,p.y);
  let bed = mix(vec3f(.102,.088,.080),vec3f(.204,.152,.109),pool*.68);
  let air = mix(vec3f(.068,.108,.095),vec3f(.19,.279,.208),pool*.90);
  let finish = mix(bed,air,split);
  return vec4f(finish,1);
}`;

const faceCount=88;
const ellipse=(x,z,n,r,y) => {
  const a=n*Math.PI*2/faceCount;
  const detail=1+.018*Math.cos(5*a+.2)+.012*Math.sin(9*a-.7);
  return [x*r*detail*Math.cos(a), y+.014*Math.sin(a*8+.5), z*r*detail*Math.sin(a)];
};
function surface(rx,rz,inner,y0,y1,deck) {
  const p=[], n=[], ix=[];
  function tri(a,b,c) {
    const u=b.map((v,i)=>v-a[i]),v=c.map((w,i)=>w-a[i]);
    const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const d=Math.hypot(...cross),start=p.length/3;
    p.push(...a,...b,...c);
    for(let j=0;j<3;j++) n.push(...cross.map(v=>v/d));
    ix.push(start,start+1,start+2);
  }
  for(let i=0;i<faceCount;i++) {
    const a=ellipse(rx,rz,i,inner,y1),b=ellipse(rx,rz,i+1,inner,y1);
    const c=ellipse(rx,rz,i,1,y0),d=ellipse(rx,rz,i+1,1,y0);
    tri(c,a,b);tri(c,b,d);
    if(deck) tri([0,y1,0],b,a);
  }
  return new Geometry(p,n,ix);
}

function chamferBlock([width,height,depth]) {
  const bevel=.048,h=height*.5, u=width*.5, v=depth*.5;
  const rings=[[-h,bevel],[-h+bevel,0],[h-bevel,0],[h,bevel]].map(([y,inset])=>{
    const x=u-inset,z=v-inset,c=bevel*.72;
    return [[-x+c,y,-z],[x-c,y,-z],[x,y,-z+c],[x,y,z-c],
      [x-c,y,z],[-x+c,y,z],[-x,y,z-c],[-x,y,-z+c]];
  });
  const positions=[],normals=[],indices=[];
  function face(points) {
    const [a,b,c]=points;
    const u=b.map((v,i)=>v-a[i]),v=c.map((q,i)=>q-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const len=Math.hypot(...n),start=positions.length/3;
    for(const point of points) {positions.push(...point);normals.push(...n.map(v=>v/len));}
    for(let i=1;i<points.length-1;i++)indices.push(start,start+i,start+i+1);
  }
  for(let r=1;r<rings.length;r++) for(let i=0;i<8;i++) {
    const j=(i+1)%8;
    face([rings[r-1][i],rings[r][i],rings[r][j],rings[r-1][j]]);
  }
  face(rings[0]);
  face([...rings.at(-1)].reverse());
  return new Geometry(positions,normals,indices);
}

function buildChamber(engine) {
  function shape(geometry,color,position=[0,0,0],roughness=.62,metalness=0) {
    return engine.createMesh().setGeometry(geometry).setPosition(position)
      .setMaterial(new PbrMaterial({color,roughness,metalness,doubleSided:true}));
  }
  function cuboid(size,color,position,r,m) {
    return shape(box(...size),color,position,r,m);
  }
  const rim = '#b39059', metal='#574a37';
  const stand=[];
  for(const x of [-2.76,2.76]) {
    cuboid([.035,5.75,.047],metal,[x,.54,-.83],.33,.36);
    for(let n=-5;n<=8;n++) {
      cuboid([n%2===0?.11:.056,.012,.038],rim,[x-(x>0?.083:-.083),n*.34,-.82],.50,.18);
    }
  }
  cuboid([5.55,.032,.042],metal,[0,-2.49,-.85],.45,.34);
  cuboid([5.55,.027,.043],metal,[0,3.42,-.85],.45,.34);
  // Hand-dressed organic soil slice, with a rolled brass lower edge on the support tray.
  shape(surface(2.45,1.17,.994,-.216,-.175,false),'#795738');
  shape(surface(2.48,1.19,.985,-.176,-.138,false),'#bea071',[0,0,0],.32,.30);
  shape(surface(2.48,1.19,.988,-.140,-.089,false),'#675344');
  shape(surface(2.43,1.16,.995,-.09,-.046,true),'#716342');
  shape(surface(2.35,1.10,.992,-.050,-.016,true),'#766342',[0,0,0],.93);
  const stones=[
    [-1.77,-.016,.43,.22],[-1.94,-.015,.20,.18],[-.94,-.011,.79,.11],[1.56,-.013,.51,.19],
    [1.82,-.010,.47,.13],[1.66,-.011,-.55,.23],[-1.43,-.018,-.43,.17],[.70,-.020,.63,.12],
    [2.0,-.02,.19,.24],[-.46,-.020,.79,.15],[-2.22,-.020,-.04,.16],
  ];
  for(const [x,y,z,width] of stones) {
    const mesh=surface(width,width*.63,.63,-.013,width*.29,true);
    shape(mesh,Math.abs(x)>1.5?'#8f7b53':'#665c3e',[x,y,z],.9);
  }
  // Hardware supporting the inserted plates sits behind (or alongside) the growth volume.
  stand.push(cuboid([.049,2.23,.048],rim,[-2.36,1.035,-.53],.35,.36));
  stand.push(cuboid([.88,.038,.048],rim,[-1.96,1.762,-.53],.35,.36));
  stand.push(cuboid([.048,.048,.66],rim,[-1.53,1.765,-.48],.35,.36));
  stand.push(cuboid([.06,.053,.74],rim,[.56,-1.072,-.88],.41,.29));
  stand.push(cuboid([.055,.046,.73],rim,[-.56,-1.072,-.88],.41,.29));

  function insert(kind,color) {
    const {min,max}=barriers[kind];
    const dims=max.map((value,i)=>value-min[i]);
    const middle=max.map((value,i)=>(value+min[i])*.5);
    stand.push(shape(chamferBlock(dims),color,middle,.55,.02));

  }
  insert('crown','#8e7258');
  insert('roots','#ba7e5c');
  for(const mesh of stand) mesh.visible=false;
  return stand;
}

export async function openSpecimen(canvas,initial,force,signal) {
  let engine,raw,material,backdrop,art=[],stands=[],error,closed=false;
  const close=()=>{
    if(closed)return;
    closed=true;
    raw?.dispose();
    for(const mesh of art)mesh.dispose();
    material?.dispose();
    backdrop?.dispose();
    engine?.dispose();
  };
  signal.addEventListener('abort',close,{once:true});
  const legacy=force||!navigator.gpu;
  const install=async()=>(await import('./compatibility.js')).installCompatibility(force,signal);
  const project=(out,aspect,webgpu)=>{
    const span=Math.max(6.85,5.93/aspect);
    const near=engine.camera.near,far=engine.camera.far,depth=far-near;
    out[0]=2/(span*aspect);
    out[5]=2/span;
    out[10]=webgpu?1/depth:-2/depth;
    out[14]=webgpu?far/depth:-(far+near)/depth;
    out[15]=1;
  };
  async function frame(progress,check=false) {
    signal.throwIfAborted();
    const ratio=Math.min(devicePixelRatio,2,1400/Math.max(1,canvas.clientWidth));
    const width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    material.uniforms.clock.value=progress;
    engine.render({delta:0});
    if(check) {
      await raw.ready();
      signal.throwIfAborted();
      if(error)throw error;
      engine.render({delta:0});
    }
    await engine.gpu.queue.onSubmittedWorkDone();
    signal.throwIfAborted();
    if(error)throw error;
  }
  async function setModel(model,active,progress,initial=false) {
    const next=[model.upper,model.lower,model.canopy].map(({positions,normals,colors,births})=>
      raw.add(new RawMesh({material,attributes:{
        position:{type:'vec3f',data:positions},normal:{type:'vec3f',data:normals},
        paint:{type:'vec3f',data:colors},birth:{type:'f32',data:births},
      }})));
    for(const mesh of art)mesh.dispose();
    art=next;
    for(const mesh of stands)mesh.visible=active;
    await frame(progress,initial);
  }
  if(legacy)await install();
  try {
    engine=await autoEngine(canvas,async target=>{
      if(!target.gpu) {
        const cause=new Error('The specimen requires WebGPU or the full Margo WebGL2 compatibility layer.');
        cause.code='unsupported';
        throw cause;
      }
      engine=target;
      canvas=target.canvas;
      engine.onError=cause=>{error=cause;};
      error=undefined;
      art=[];
      engine.camera.project=project;
      engine.scene.background='#263630';
      engine.lighting.direction.set([-.51,.71,.48,2.28]);
      engine.lighting.radiance.set([1,.87,.71,.58]);
      engine.lighting.ambient.set([.63,.69,.61]);
      raw=RawShaders.attach(engine);
      backdrop=new RawShaderMaterial({vertexShader:chamberShader,cull:'none',depthWrite:false});
      backdrop.onError=cause=>{error=cause;};
      raw.add(new RawMesh({material:backdrop,attributes:{
        position:{type:'vec2f',data:new Float32Array([-1,-1,3,-1,-1,3])},
      }}));
      stands=buildChamber(engine);
      material=new RawShaderMaterial({vertexShader:colorShader,uniforms:{clock:{value:1}},cull:'none'});
      material.onError=cause=>{error=cause;};
      performance.mark('margo-device-open');
      await setModel(await initial,false,1,true);
    },{
      backend:legacy?'webgpu':undefined,loadCompat:async()=>({install}),signal,
      exactSize:true,antialias:true,capacity:160,startupTimeout:11000,
      camera:{position:[1.8,2.11,11],target:[0,.52,0],near:.8,far:40},
    });
  } catch(cause) {
    close();
    throw cause;
  }
  return {
    setModel,frame,close,
    setAngle(side) {
      engine.camera.position=side?[8.7,2.55,7.5]:[1.8,2.11,11];
    },
    backend:engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'webgl2':'webgpu',
  };
}
