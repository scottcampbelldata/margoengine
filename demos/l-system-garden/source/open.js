import {openBench} from '@margoengine/studio/bench';
import {demoStatus} from 'margo-demo-status';
import {cameraFor,glasshouse} from './art.js';
import {generate,specimens} from './grammar.js';

const by=id=>document.getElementById(id);
const canvas=by('scene'),viewport=by('viewport'),loading=by('loading'),error=by('error');
const status=demoStatus(viewport,loading,error);
const controller=new AbortController(),{signal}=controller;
const controls=['grow','generation','preset','axiom','rules','angle','reset'];
let close,resized=()=>{};
function fail(reason){
  if(signal.aborted||status.failed)return;
  for(const id of controls)by(id).disabled=true;
  loading.hidden=true;error.hidden=false;
  status.error(reason);
}
// The bench sizes the backbuffer the same way (device pixels up to 1.8, at most 1330 wide), so the first camera fits it.
const {width,height}=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,1.8,1330/Math.max(1,width));
const opening=openBench(canvas,{
  exhibit:viewport,signal,pixelRatio:1.8,maxWidth:1330,startupTimeout:8500,compat:{minimumTier:'half-float'},
  camera:cameraFor(Math.round(width*ratio)||1,Math.round(height*ratio)||1),
  // The sun's shadow covers the plinth and the tallest plant it can grow.
  background:'#554754',backdrop:false,environment:false,shadows:{bounds:{min:[-.9,-.02,-.9],max:[.9,1.3,.9]}},
  light:{direction:[-.6,.78,.2],intensity:3.7,color:[1,.909,.752],ambient:.58,ambientColor:[.84,.96,1.08]},
  // The glasshouse bed's soft contact shadow, baked once: the plinth and glazing never move.
  contact:{position:[0,.004,0],size:[1.34,1.25],height:.36,opacity:.78,blur:.022,resolution:256,static:true,
    color:[.014,.009,.012],toneMapped:true},
  onError:fail,onResize:()=>resized(),
}).then(bench=>{
  performance.mark('engine-ready');
  return bench;
});
opening.catch(fail);
const first={...specimens.lantern,generation:4};
const prepared=Promise.resolve().then(()=>({room:glasshouse(),initial:generate(first)}));
Promise.all([import('./scene.js'),prepared]).then(([{mount},{room,initial}])=>{
  close=mount({opening,canvas,viewport,loading,status,controls,signal,fail,onResize:hook=>{resized=hook;},first,room,initial});
}).catch(fail);
addEventListener('pagehide',event=>{
  if(event.persisted)return;
  controller.abort();
  close?.();
});
