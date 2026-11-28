import {FogVolumes} from '@margoengine/environment/fog-volumes';
import {VolumetricFog} from '@margoengine/environment/volumetric';
import {Shadows} from '@margoengine/shadows';
import {Tonemap} from '@margoengine/tonemap';

const local=[
  {shape:'box',min:[-12,-.65,-31],max:[.75,4.9,-6.5],density:.09,edge:1.75,color:[.63,.74,.74],noise:.54,noiseScale:3.1},
  {shape:'sphere',center:[2.91,1.80,-13.99],radius:4.67,density:.077,edge:1.67,color:[.72,.78,.68],noise:.43,noiseScale:3.7},
  {shape:'box',min:[-8,-.82,-51],max:[16,4.8,-22],density:.064,edge:2.8,color:[.73,.80,.71],noise:.38,noiseScale:6.3},
  {shape:'sphere',center:[-.83,-.05,-2.46],radius:3.12,density:.044,edge:1.68,color:[.70,.80,.72],noise:.40,noiseScale:3.3},
];
const grid=[92,56,40];

export async function show({engine,forest,canvas,status,notice,size,signal,fail}){
  const density=document.querySelector('#density'), phase=document.querySelector('#phase');
  const amount=document.querySelector('#amount'), asymmetry=document.querySelector('#asymmetry');
  const medium=document.querySelector('#medium'), renderer=document.querySelector('#renderer');
  const compatibility=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  canvas.dataset.renderer=compatibility?'compatibility':'webgpu';
  renderer.textContent=compatibility?'Margo WebGL2':'Margo WebGPU';

  engine.scene.background='#80958e';
  engine.lighting.direction.set([-.498,.332,-.801,7.14]);
  engine.lighting.radiance.set([1,.77,.46,.955]);
  engine.lighting.ambient.set([.49,.72,.81]);
  Tonemap.attach(engine,{curve:'agx',exposure:-.25});
  const shadows=Shadows.attach(engine,{resolution:1024,cascades:1,filter:'pcf',jitter:false,
    bounds:{min:[-24,-.70,-45],max:[24,22,13]}});
  let triangles=0;
  for(const {name,caster,geometry,material} of forest){
    const mesh=engine.createMesh().setGeometry(geometry).setMaterial(material);
    mesh.name=name;
    if(caster)shadows.add(mesh,{static:true});
    triangles+=geometry.indices.length/3;
  }

  const volumes=new FogVolumes(local.map(volume=>({...volume})));
  const fog=VolumetricFog.attach(engine,{density:.0105,heightFalloff:.285,height:.35,
    range:56,grid,temporal:0,anisotropy:+phase.value/100,
    color:[.86,.92,.84],ambient:[.051,.079,.095],shadows,volumes});
  signal.addEventListener('abort',()=>{
    fog.options.volumes=undefined;
    volumes.dispose();
  },{once:true});
  canvas.dataset.geometryTriangles=String(triangles);

  let revision=0,first=false,pending=0;
  function draw(){
    const narrow=canvas.clientWidth<690;
    engine.camera.fov=narrow?55:43;
    engine.camera.target=narrow?[-.49,3.04,-15.9]:[-.86,2.82,-15.9];
    const strength=+density.value/100;
    for(const [index,volume] of volumes.volumes.entries())volume.density=local[index].density*strength;
    fog.options.anisotropy=+phase.value/100;
    engine.render(0);
  }

  async function update(mark){
    const serial=++revision;
    draw();
    await engine.gpu.queue.onSubmittedWorkDone();
    if(serial!==revision||signal.aborted)return;
    const mist=+density.value,g=+phase.value/100;
    amount.value=mist+'%';
    asymmetry.value=g.toFixed(2);
    density.setAttribute('aria-valuetext',mist+' percent');
    phase.setAttribute('aria-valuetext',g.toFixed(2));
    medium.textContent=(local[0].density*mist*.01).toFixed(3)+' m⁻¹ peak single-volume extinction';
    Object.assign(canvas.dataset,{density:String(mist),phase:String(g),revision:String(serial)});
    if(mark&&!first){
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      if(!first&&!signal.aborted){
        first=true;
        performance.mark('fog-change-applied');
      }
    }
  }

  function request(){
    cancelAnimationFrame(pending);
    pending=requestAnimationFrame(()=>update(true).catch(fail));
  }
  for(const control of [density,phase])control.addEventListener('input',request,{signal});
  const observer=new ResizeObserver(()=>{
    if(!size())return;
    try{draw();}catch(reason){fail(reason);}
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{observer.disconnect();cancelAnimationFrame(pending);},{once:true});

  performance.mark('fog-scene-built');
  await update(false);
  const texture=fog.texture;
  if(!texture)throw new Error('The fog volume did not render.');
  canvas.dataset.froxels=[texture.width,texture.height,texture.depthOrArrayLayers].join('x');
  if(status.ready()){
    notice.hidden=true;
    density.disabled=phase.disabled=false;
    performance.mark('fog-frame-ready');
  }
}
