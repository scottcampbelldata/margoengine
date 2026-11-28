import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { parseGLTF } from '@margoengine/gltf';

function quartz() {
  const profile = [[.231,-.042,-1,0],[.239,-.035,-.7,.7],[.239,-.010,0,1],
    [.234,-.002,.7,.7],[.226,0,1,0]];
  const points = [], normals = [], indices = [], sides = 100;
  for (const [radius,y,ny,nr] of profile) for (let i=0;i<sides;i++) {
    const angle = 2*Math.PI*i/sides, x = Math.cos(angle), z = Math.sin(angle);
    points.push(radius*x,y,radius*z);
    normals.push(nr*x,ny,nr*z);
  }
  for(let ring=0;ring<profile.length-1;ring++) for(let i=0;i<sides;i++) {
    const a=ring*sides+i,b=ring*sides+(i+1)%sides;
    indices.push(a,a+sides,b+sides,a,b+sides,b);
  }
  for (const [ring,normal] of [[0,-1],[profile.length-1,1]]) {
    const center=points.length/3;
    points.push(0,profile[ring][1],0);
    normals.push(0,normal,0);
    for(let i=0;i<sides;i++) {
      const a=ring*sides+i,b=ring*sides+(i+1)%sides;
      if(normal>0) indices.push(center,b,a);
      else indices.push(center,a,b);
    }
  }
  return new Geometry(points,normals,indices);
}

export async function open({engine,bytes,fit,status,notice,angle,signal,fail}) {
  const {canvas}=engine;
  const output=document.querySelector('#degrees');
  let frame, shadowTimer, input=false, pending=false;
  engine.onError=fail;
  engine.scene.background='#302720';
  // Large warm softbox at camera left with a cooler studio fill.
  engine.lighting.direction.set([-2.9,5.8,3.6,4.35]);
  engine.lighting.radiance.set([1,.87,.73,.40]);
  engine.lighting.ambient.set([.88,.94,1]);

  const subject=parseGLTF(engine,bytes,[],{maxNodes:20});
  const make=(geometry,color,roughness)=>engine.createMesh().setGeometry(geometry)
    .setMaterial(new PbrMaterial({color,roughness}));
  const base=make(quartz(),'#8c6a55',.54);
  const deck=make(box(9,.05,9),'#5b473e',.86).setPosition([0,-.067,0]);

  function camera() {
    const ratio=canvas.width/canvas.height;
    const spread=Math.max(.145,.160/ratio);
    const distance=spread/Math.tan(17*Math.PI/180);
    const azimuth=28*Math.PI/180;
    engine.camera.target=[0,.063,0];
    engine.camera.position=[distance*.912*Math.sin(azimuth),.063+distance*.41,distance*.912*Math.cos(azimuth)];
  }
  function draw() {
    frame=undefined;
    if (signal.aborted) return;
    const value=Number(angle.value);
    subject.root.rotation.y=(28-value)*Math.PI/180;
    output.value=value+'°';
    angle.setAttribute('aria-valuetext',value+' degrees');
    canvas.dataset.angle=String(value);
    try {
      engine.render({delta:0});
      if(input&&!pending) {
        input=false;
        pending=true;
        engine.gpu.queue.onSubmittedWorkDone().then(()=>{
          if(signal.aborted) return;
          pending=false;
          performance.mark('ar-card-angle-applied');
          if(input) schedule();
        }).catch(fail);
      }
    } catch(reason) { fail(reason); }
  }
  function schedule() { if(frame===undefined&&!signal.aborted) frame=requestAnimationFrame(draw); }

  camera();
  draw();
  await engine.gpu.queue.onSubmittedWorkDone();
  if(signal.aborted) return;
  angle.disabled=false;
  angle.addEventListener('input',()=>{input=true;schedule();},{signal});
  const observer=new ResizeObserver(()=>{if(fit()){camera();schedule();}});
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{
    observer.disconnect();
    clearTimeout(shadowTimer);
    if(frame!==undefined) cancelAnimationFrame(frame);
    subject.dispose();
  },{once:true});
  canvas.dataset.renderer=engine.gpu.adapterInfo?.vendor==='margo-webgl2'?'compatibility':'webgpu';
  if(status.ready()) notice.hidden=true;
  performance.mark('margo-first-usable-frame');

  shadowTimer=setTimeout(async()=>{
    try {
      const {Shadows}=await import('@margoengine/shadows');
      if(signal.aborted) return;
      const shadows=Shadows.attach(engine,{resolution:1024,cascades:1,filter:'soft',samples:10,blockerSamples:6,
        lightSize:.045,bounds:{min:[-.38,-.05,-.35],max:[.38,.25,.35]}});
      shadows.add(deck,{castShadow:false});
      shadows.add(base);
      for(const mesh of subject.meshes) shadows.add(mesh);
      engine.render({delta:0});
      await engine.gpu.queue.onSubmittedWorkDone();
      if(!signal.aborted) canvas.dataset.finish='softbox';
    } catch(reason) {fail(reason);}
  },700);
}
