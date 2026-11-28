
import {VirtualShadows} from '@margoengine/shadows/virtual';
import {Shadows} from '@margoengine/shadows';
import {distanceShadows} from '@margoengine/shadows/distance';
import {Sky} from '@margoengine/sky/base';
import {preetham} from '@margoengine/sky/preetham';
import {Geometry,PbrMaterial} from '@margoengine/core';
import {bounds,installProps} from './valley.js';

const views=[
  {name:'Platform',eye:[-6.07,11.88,34.7],target:[1.51,15.8,-64],fov:51,
    description:'Watch the shadows of the railings and overhead fixtures break across the platform.'},
  {name:'Viaduct',eye:[-74,81,-470],target:[52,47,-577],fov:52,
    description:'The arch openings keep their shape in shadow as the ridge darkens the land beyond.'},
  {name:'Ridge',eye:[-196,265,-194],target:[61,195,-1550],fov:56,
    description:'Toggle the terrain horizon to see how much of the pass is in the mountains’ shade.'}
];
const sun=[-.941,.226,-.25],reach=740;
const element=id=>document.getElementById(id);
const choices=[...document.querySelectorAll('[data-view]')];
const state=document.body.dataset;
const fmt=new Intl.NumberFormat('en-US');


const AlpineColor = `fn alpineTint(p:vec3f,n:vec3f)->vec3f{
  let grain=sin(p.x*.023-p.z*.037)+.5*cos(p.x*.043+p.z*.005);
  let stratum=sin(p.y*.030+p.x*.012-p.z*.009);
  let slope=1.-abs(n.y);
  let pasture=smoothstep(-.9,.9,grain);
  let stone=smoothstep(100.,295.,p.y+135.*slope+23.*grain);
  let frost=smoothstep(520.,710.,p.y-199.*slope+38.*grain-34.*stratum);
  let meadow=mix(vec3f(.095,.143,.104),vec3f(.168,.204,.122),pasture);
  let bedrock=mix(meadow,vec3f(.253,.239,.205)*(1.+.17*stratum),stone);
  let surface=mix(bedrock,vec3f(.665,.676,.628)*(1.+.052*grain),frost);
  return mix(surface,vec3f(.291,.371,.436),.24*smoothstep(400.,4400.,-p.z));
}`;

function terrainMaterial(engine){
  const badge=[.03125,.0625,.125];
  engine.scene.frameGraph.add({name:'alpine surface',order:-4.7,execute(frame){
    if(frame.backend!=='webgpu')return;
    const at=frame.shader.indexOf('@fragment fn fragment(');
    const start='let nl=clamp(';
    const offset=frame.shader.indexOf(start,at);
    if(offset<0)throw Error('The Alpine surface needs the pinned Margo core fragment hook.');
    const prefix=`var alpineColor=i.color;
if(all(abs(i.color-vec3f(.03125,.0625,.125))<vec3f(.00001))){alpineColor=alpineTint(i.position,n);}
`;
    frame.shader=frame.shader.slice(0,at)+AlpineColor+'\n'+frame.shader.slice(at,offset)+prefix+
      frame.shader.slice(offset).replaceAll('i.color','alpineColor');
  }});
  return new PbrMaterial({color:badge,roughness:.91});
}

export async function install(engine,canvas,signal,knownFallback,payload){
  const translated=knownFallback||engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  state.renderer=translated?'webgl2':'webgpu';
  engine.lighting.direction.set([...sun,3.15]);
  engine.lighting.radiance.set([1,.82,.66,.48]);
  engine.lighting.ambient.set([.57,.72,.88]);
  Sky.attach(engine,{sunDirection:sun,turbidity:2.7,exposure:.69},{preetham});
  const {cols,rows,heights}=payload.field;
  const far=distanceShadows({heights,columns:cols,rows,origin:[bounds.x,bounds.z],
    size:[bounds.width,bounds.length],fade:.26,strength:.91,sunSize:.0093,bias:3.4});
  const shadow=translated
    ? Shadows.attach(engine,{resolution:1024,cascades:4,distance:reach,lambda:.84,filter:"pcf",casterMargin:124,effects:[far]})
    : VirtualShadows.attach(engine,{poolSize:1024,levels:8,distance:reach,budgetPages:40,casterMargin:124,effects:[far],filter:"hard"});
  const {positions,normals,indices}=payload.terrain;
  engine.createMesh().setGeometry(new Geometry(positions,normals,indices)).setMaterial(terrainMaterial(engine));
  for(const mesh of installProps(engine,payload.props))shadow.add(mesh,{static:true});
  let active=0,revision=0,applied=0,busy=false,request,observer,remaining=0,farOn=true;
  const control=element('controls');
  element('method').textContent=translated?'Four cascades':'Virtual shadow map';
  element('page-row').hidden=translated;
  element('reach').textContent=fmt.format(reach)+' m';
  state.method=translated?'cascade':'virtual';state.reach=String(reach);
  function draw(){
    const scale=Math.min(1.75,devicePixelRatio||1);
    const width=Math.max(1,Math.round(canvas.clientWidth*scale)),height=Math.max(1,Math.round(canvas.clientHeight*scale));
    if(canvas.width!==width)canvas.width=width;
    if(canvas.height!==height)canvas.height=height;
    const view=views[active];
    engine.camera.position=view.eye;
    engine.camera.target=view.target;
    engine.camera.fov=canvas.clientWidth<550?view.fov+2:view.fov;
    far.options.strength=farOn?.91:0;
    engine.render({delta:0});
    element('view-name').textContent=view.name;
    if(!translated)element('pages').textContent=fmt.format(shadow.stats.residentPages);
    element('observation').textContent=view.description;
    for(const button of choices)button.setAttribute('aria-pressed',String(+button.dataset.view===active));
    state.view=String(active);state.far=String(farOn);
    if(translated){state.cascades=String(shadow.options.cascades);state.drawn=String(shadow.stats.staticDraws);}
    else{state.pages=String(shadow.stats.residentPages);state.drawn=String(shadow.stats.pagesRendered);state.levels=shadow.stats.levelPages.join(',');}
  }
  function requestFrame(){
    if(request||busy||signal.aborted)return;
    request=requestAnimationFrame(async ()=>{
      request=undefined;
      const frame=revision;
      busy=true;
      try{
        draw();
        remaining=Math.max(0,remaining-1);state.settled=String(!remaining);
        await engine.gpu.queue.onSubmittedWorkDone();
        if(signal.aborted)return;
        if(frame!==applied){
          applied=frame;state.revision=String(frame);
          if(!performance.getEntriesByName('alpine-first-input').length)performance.mark('alpine-first-input');
        }
      }catch(error){engine.onError(error);remaining=0;}
      finally{busy=false;}
      if(remaining||frame!==revision)requestFrame();
    });
  }
  function update(frames){revision++;remaining=frames;requestFrame();}
  performance.mark('alpine-built');
  draw();
  performance.mark('alpine-submit');
  await engine.gpu.queue.onSubmittedWorkDone();
  return {
    connect(){
      state.ready='true';state.revision='0';
      control.disabled=false;
      for(const button of choices)button.addEventListener('click',()=>{
        const next=+button.dataset.view;
        if(active===next)return;
        active=next;update(translated?1:5);
      },{signal});
      const farControl=element('far');
      farControl.addEventListener('change',()=>{farOn=farControl.checked;update(translated?1:3);},{signal});
      observer=new ResizeObserver(()=>{
        const scale=Math.min(1.75,devicePixelRatio||1);
        if(Math.round(canvas.clientWidth*scale)===canvas.width&&Math.round(canvas.clientHeight*scale)===canvas.height)return;
        remaining=Math.max(remaining,3);requestFrame();
      });
      observer.observe(canvas);
    },
    dispose(){cancelAnimationFrame(request);observer?.disconnect();}
  };
}
