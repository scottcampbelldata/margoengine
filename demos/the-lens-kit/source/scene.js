import {PostStack} from '@margoengine/post/stack';
import {LensFlare} from '@margoengine/post/lens-flare';
import {Anamorphic} from '@margoengine/post/anamorphic';
import {Lens} from '@margoengine/post/lens';
import {Tonemap} from '@margoengine/tonemap';
import {mainLight,preparePier} from './pier.js';

export {preparePier};

const looks={
  clear:{description:'The reference view shows the lights with the lens effects off.',setting:'Reference image'},
  flare:{description:'Reflected light forms a halo and ghosts along the line from the lamp through the centre.',setting:'Depth-tested lamp flare'},
  streak:{description:'Bright points stretch into horizontal blue streaks, a familiar effect of anamorphic glass.',setting:'Blue streaks · 4 spread passes'},
  vintage:{description:'Barrel distortion bends straight edges. Red and blue separate near the corners, and bright lights reveal dust.',setting:'Barrel + colour fringing'},
};
const degree=Math.PI/180;

export async function show({engine,pier,canvas,status,notice,size,signal,fail}){
  const buttons=[...document.querySelectorAll('[data-look]')], pan=document.querySelector('#pan');
  const bearing=document.querySelector('#bearing'), description=document.querySelector('#explanation');
  const setting=document.querySelector('#setting'), renderer=document.querySelector('#renderer');
  const compatibility=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  canvas.dataset.renderer=compatibility?'compatibility':'webgpu';
  renderer.textContent=compatibility?'Margo WebGL2':'Margo WebGPU';

  engine.scene.background='#4d617e';
  engine.lighting.direction.set([.26,.40,.879,12.1]);
  engine.lighting.radiance.set([.99,.93,.86,.57]);
  engine.lighting.ambient.set([.44,.68,.96]);
  for(const {name,geometry,material} of pier){
    const mesh=engine.createMesh().setGeometry(geometry).setMaterial(material);
    mesh.name=name;
  }

  const tonemap=new Tonemap({curve:'agx',exposure:-1.67,vignette:.23,chromaticAberration:0});
  const stack=PostStack.attach(engine,[tonemap]);
  const effects={
    flare:()=>new LensFlare({position:()=>mainLight,intensity:1.05,color:[1,.81,.57],occlusionRadius:14}),
    streak:()=>new Anamorphic({threshold:1.24,intensity:4.20,tint:[.13,.37,1],passes:4}),
    vintage:()=>new Lens({distortion:.38,dirtIntensity:.28,threshold:1.15}),
  };
  const mounted={};
  let look='clear',angle=+pan.value,shown,revision=0,first=false,pending=0;

  function draw(){
    if (shown!==look){
      for(const [name,effect] of Object.entries(mounted))effect.enabled=name===look;
      if(look!=='clear'&&!mounted[look]){
        const effect=effects[look]();
        stack.addEffect(effect,0);
        mounted[look]=effect;
      }
      tonemap.options.chromaticAberration=look==='vintage'?.92:0;
      shown=look;
    }
    const narrow=canvas.clientWidth<690;
    const base=(narrow?-.105:-.067)+angle*degree;
    engine.camera.position=[.79,1.56,7.43];
    engine.camera.target=[.79+14*Math.sin(base),1.46,7.43-14*Math.cos(base)];
    engine.camera.fov=narrow?52:38;
    engine.render(0);
  }

  async function update(mark){
    const serial=++revision;
    draw();
    await engine.gpu.queue.onSubmittedWorkDone();
    if(serial!==revision||signal.aborted)return;
    for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.look===look));
    bearing.value=(angle<0?'−':'')+Math.abs(angle)+'°';
    description.textContent=looks[look].description;
    setting.textContent=looks[look].setting;
    Object.assign(canvas.dataset,{look,pan:String(angle),revision:String(serial)});
    if(mark&&!first){
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      if(!first&&!signal.aborted){
        first=true;
        performance.mark('lens-change-applied');
      }
    }
  }
  function request(){
    cancelAnimationFrame(pending);
    pending=requestAnimationFrame(()=>update(true).catch(fail));
  }

  for(const button of buttons)button.addEventListener('click',()=>{
    if(look===button.dataset.look)return;
    look=button.dataset.look;
    request();
  },{signal});
  pan.addEventListener('input',()=>{angle=+pan.value;request();},{signal});
  const observer=new ResizeObserver(()=>{
    if(!size())return;
    try{draw();}catch(reason){fail(reason);}
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{observer.disconnect();cancelAnimationFrame(pending);},{once:true});

  await update(false);
  if(status.ready()){
    notice.hidden=true;
    for(const control of [...buttons,pan])control.disabled=false;
    performance.mark('lens-frame-ready');
  }
}
