import {createMesh} from '@margoengine/materials';
import {NodeEditor} from '@margoengine/shader/editor';
import {createGraphMaterial} from '@margoengine/shader/graph';
import {initialGraph,initialLayout} from './foundation.js';
import {cameraFor} from './art.js';
import {prepareReflector} from './reflection.js';

const by=id=>document.getElementById(id);
const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
const phoneLayout=()=>matchMedia('(max-width:960px)').matches;
const editorSkin=`
:host{--bg:#2b2b25;--grid:#414038;--panel:#36362d;--ink:#f0e8d6;--muted:#c0b3a0;--line:#695f4e;--accent:#edc68a;
  --bad:#f5a292;--ok:#b1cb9d;--f32:#9ebdc5;--vec3f:#dfbb7f;color-scheme:dark}
.toolbar{min-height:45px;padding:5px 7px;gap:5px}
button{min-height:30px}
.toolbar .status{font-size:11px}
.node{border-radius:3px}
.head{border-radius:3px 3px 0 0;background:#3d3c31}
.head .type{color:#b5c0ba}
.socket{width:15px;height:15px;min-height:0;transform:translate(-1.5px,-1.5px)}
.palette li{min-height:38px}
.toolbar button[title="Show the generated WGSL"]{display:none}
@media(max-width:960px){
  .toolbar button{min-height:35px;padding:4px 7px;font-size:11px}
  .toolbar .status{max-width:100%;width:100%;margin:0}
  .socket{width:20px;height:20px;transform:translate(-4px,-4px)}
}
`;

function lighting(engine){
  engine.scene.background='#3e392f';
  engine.lighting.direction.set([-.25,.59,.78,3.8]);
  engine.lighting.radiance.set([1.0,.89,.76,.71]);
  engine.lighting.ambient.set([.91,.96,1.08]);
}

export function mount({opening,art,canvas,viewport,loading,page,signal,fail,resize}){
  const graphHost=by('graph'),out=by('wgsl'),note=by('preview-note'),slider=by('roughness'),value=by('roughness-value');
  const finish=by('finish'),restore=by('restore'),turn=by('turn');
  let engine,editor,vessel,sample,material,reflector,observer,graphRequest,roughness,raf=0,version=0,angle=0,clock=0;
  let spinning=false,working=false,dirty=false,changing=false,layoutIsPhone=phoneLayout();

  function installGraph(graph){
    const f=graph.fallback;
    const next=createGraphMaterial(graph,{
      color:f.color,roughness:f.roughness,metalness:f.metalness,opacity:f.opacity,emissive:f.emissive,
      transparent:!!graph.outputs.opacity||f.opacity<1,side:'double',envMap:reflector.of,envMapIntensity:.94,
    });
    if(material){
      vessel.material=next;
      sample.material=next;
      material.dispose();
    }else{
      vessel=createMesh(engine,art.vessel,next);
      vessel.root.name='SM_WaveVessel';
      vessel.root.setPosition([-.31,.244,.026]);
      sample=createMesh(engine,art.sample,next);
      sample.root.name='SM_CurvedGlazeSample';
      sample.root.setPosition([.438,.235,.115]);
    }
    material=next;
    out.textContent=next.fragmentCode || '// The active surface uses the material’s constant values.';
    const finishNode=graph.nodes.find(node=>node.op==='float'&&node.id===graph.outputs.roughness);
    roughness=finishNode?.id;
    slider.disabled=!finishNode;
    if(finishNode){
      slider.value=String(clamp(finishNode.value,.045,1));
      value.value=Number(finishNode.value).toFixed(2);
    }else{
      value.value='From the graph';
    }
    version++;
  }
  function camera(){
    const pose=cameraFor(canvas.width,canvas.height,angle);
    engine.camera.position=pose.position;
    engine.camera.target=pose.target;
    engine.camera.fov=pose.fov;
  }
  function schedule(){
    if(!signal.aborted&&!page.failed&&!working&&!raf)raf=requestAnimationFrame(draw);
  }
  async function draw(time){
    raf=0;
    if(signal.aborted||page.failed)return;
    working=true;
    try{
      const request=graphRequest;
      graphRequest=undefined;
      if(request)installGraph(request);
      const elapsed=clock?Math.max(.007,Math.min(.055,(time-clock)/1000)):1/60;
      clock=time;
      if(spinning)angle+=elapsed*.267;
      camera();
      engine.render({delta:elapsed});
      const publish=dirty||!!request||changing;
      dirty=false;
      changing=false;
      if(publish){
        await engine.gpu.queue.onSubmittedWorkDone();
        await new Promise(resolve=>requestAnimationFrame(resolve));
        signal.throwIfAborted();
        viewport.dataset.version=String(version);
        viewport.dataset.angle=angle.toFixed(3);
        if(request){
          viewport.dataset.roughness=roughness?value.value:'graph';
          performance.mark('material-frame');
          if(!performance.getEntriesByName('first-control-frame').length)performance.mark('first-control-frame');
        }
      }
      if(spinning)viewport.dataset.angle=angle.toFixed(3);
    }catch(reason){fail(reason);}
    finally{
      working=false;
      if(graphRequest||spinning||dirty||changing)schedule();
    }
  }
  async function run(){
    reflector=prepareReflector(art.reflections);
    editor=new NodeEditor(graphHost,{
      graph:initialGraph(),layout:initialLayout(layoutIsPhone),signal,
      presentation:{title:'Ceramic material output'},
    });
    const style=document.createElement('style');
    style.textContent=editorSkin;
    editor.element.shadowRoot.append(style);
    editor.fit();
    engine=await opening;signal.throwIfAborted();
    lighting(engine);
    for(const {name,geometry,material:surface} of art.room){
      engine.createMesh().setGeometry(geometry).setMaterial(surface).name='SM_Studio_'+name;
    }
    installGraph(editor.graph);
    camera();
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    signal.throwIfAborted();
    performance.mark('studio-frame');
    viewport.dataset.version=String(version);
    viewport.dataset.roughness=value.value;
    viewport.dataset.angle=angle.toFixed(3);
    viewport.dataset.graphValid='true';
    let first=true;
    editor.onGraph(graph=>{
      if(first){first=false;return;}
      graphRequest=graph;
      schedule();
    });
    editor.onChange(status=>{
      viewport.dataset.graphValid=String(status.ok);
      note.textContent=status.ok?'':'Preview holds the last valid material.';
    });
    slider.addEventListener('input',()=>{value.value=Number(slider.value).toFixed(2);},{signal});
    slider.addEventListener('change',()=>{
      if(!roughness)return;
      performance.mark('finish-control-request');
      editor.model.setValue(roughness,Number(slider.value));
    },{signal});
    restore.addEventListener('click',()=>{
      editor.load(initialGraph(),initialLayout(layoutIsPhone));
      editor.fit();
    },{signal});
    turn.addEventListener('click',()=>{
      spinning=!spinning;
      turn.textContent=spinning?'Pause orbit':'Orbit preview';
      turn.setAttribute('aria-pressed',String(spinning));
      clock=0;
      changing=true;
      schedule();
    },{signal});
    observer=new ResizeObserver(()=>{
      if(resize()){dirty=true;schedule();}
      const next=phoneLayout();
      if(next!==layoutIsPhone){layoutIsPhone=next;editor.fit();}
    });
    observer.observe(canvas);
    if(page.ready()){
      graphHost.inert=false;
      finish.disabled=false;restore.disabled=false;turn.disabled=false;loading.hidden=true;
    }
  }
  run().catch(fail);
  return ()=>{
    observer?.disconnect();
    if(raf)cancelAnimationFrame(raf);
    editor?.dispose();
    reflector?.dispose();
  };
}
